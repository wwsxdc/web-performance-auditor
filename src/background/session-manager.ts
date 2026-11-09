import type { AuditSession, SessionSummary } from '../types/session';
import type { MetricRecord, MetricName } from '../types/metrics';
import type { DiagnosticEvent } from '../types/events';
import type { AppState, CollectorStatus, OverlayStatus } from '../types/messages';
import type { JsonReport, ReportAttribution } from '../types/report';
import { generateId } from '../utils/id';
import { calculateRating } from '../utils/rating';
import { calculateCompleteness } from '../utils/completeness';
import { isAuditableUrl, sanitizeUrl } from '../utils/url';
import {
  buildImportBundle,
  importSummary,
  validateImportIntegrity,
  type ImportSummary,
} from '../utils/report-import';
import {
  isEventType,
  isMetricName,
  isMetricSource,
  isMetricStatus,
} from '../utils/validation';
import {
  SCHEMA_VERSION,
  REPORT_VERSION,
  EXTENSION_NAME,
  EXTENSION_VERSION,
  EVENT_BATCHING,
  STORAGE_LIMITS,
} from '../constants/config';
import { METRIC_THRESHOLDS } from '../constants/thresholds';
import * as storage from './storage';
import { extensionApi } from '../browser/api';

export const RESTORE_NAVIGATION_GRACE_MS = 2000;

export interface ImportReportResult {
  success?: boolean;
  error?: string;
  sessionId?: string;
  summary?: ImportSummary;
  warnings?: string[];
}

export interface SessionActionResult {
  success?: boolean;
  error?: string;
  sessionId?: string;
}

function consolidateMetricUpdates(metrics: MetricRecord[]): MetricRecord[] {
  const byMetric = new Map<string, MetricRecord>();

  for (const metric of metrics) {
    const key = `${metric.navigationId}:${metric.name}:${metric.metricId ?? metric.id}`;
    const current = byMetric.get(key);
    if (!current) {
      byMetric.set(key, metric);
      continue;
    }

    const currentValue = current.value ?? Number.NEGATIVE_INFINITY;
    const nextValue = metric.value ?? Number.NEGATIVE_INFINITY;
    const useLatest =
      metric.name === 'FCP' || metric.name === 'TTFB'
        ? metric.observedAt >= current.observedAt
        : nextValue >= currentValue;
    if (useLatest) byMetric.set(key, metric);
  }

  return [...byMetric.values()].sort((left, right) => left.observedAt - right.observedAt);
}

function sanitizeMetricForReport(metric: MetricRecord): MetricRecord {
  const resourceUrl = metric.attribution?.lcp?.resourceUrl;
  if (!metric.attribution || !metric.attribution.lcp || !resourceUrl) return metric;
  return {
    ...metric,
    attribution: {
      ...metric.attribution,
      lcp: { ...metric.attribution.lcp, resourceUrl: sanitizeUrl(resourceUrl) },
    },
  };
}

interface ActiveSessionPointer {
  id: string;
  tabId: number;
  url: string;
  navigationId?: string;
  documentToken?: string;
  awaitingDocumentCommit?: boolean;
  pendingNavigationUrl?: string;
  pendingNavigationSince?: number;
}

export class SessionManager {
  private currentSessionId: string | null = null;
  private lastSessionId: string | null = null;
  private activeNavigationId: string | null = null;
  private documentNavigationId: string | null = null;
  private activeDocumentToken: string | null = null;
  private retiredDocumentTokens = new Set<string>();
  private allowDocumentTokenRotation = false;
  private awaitingDocumentCommit = false;
  private pendingNavigationUrl: string | null = null;
  private pendingNavigationSince: number | null = null;
  private pendingNavigationTimer: ReturnType<typeof setTimeout> | null = null;
  private collectorStatus: CollectorStatus = 'idle';
  private activeTabId: number | null = null;
  private activeTabUrl: string | null = null;
  private error: string | undefined = undefined;
  private overlayStatus: OverlayStatus | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastAt = 0;
  private writeChain: Promise<unknown> = Promise.resolve();

  // Diagnostic events are buffered and written in one IndexedDB transaction
  // per batch (NFR 4.1). Only the active session may own the buffer.
  private pendingEvents: DiagnosticEvent[] = [];
  private pendingEventSessionId: string | null = null;
  private eventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private eventCount: {
    sessionId: string;
    persisted: number;
    seen: Set<string>;
  } | null = null;

  // Serialize session lifecycle mutations (start/end/navigation/reset),
  // metric/event writes, and collector-status updates (they may persist the
  // active pointer). Interleaving awaits would otherwise read stale fields and
  // resurrect or misattribute a session. Only the pure overlay setter and the
  // read-mostly getState (best-effort active-tab hint) stay outside.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(task, task);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async startSession(
    tabId: number,
    url: string,
    options?: { awaitDocumentCommit?: boolean },
  ): Promise<AuditSession> {
    return this.enqueue(() => this.startSessionInternal(tabId, url, options));
  }

  private async startSessionInternal(
    tabId: number,
    url: string,
    options?: { awaitDocumentCommit?: boolean },
  ): Promise<AuditSession> {
    if (this.currentSessionId) {
      await this.endSessionInternal(this.currentSessionId, 'completed');
    }
    await this.flushEventsInternal();
    this.lastSessionId = null;
    this.eventCount = null;

    const sessionId = generateId();
    const navId = generateId();
    const startedAt = Date.now();

    const session: AuditSession = {
      id: sessionId,
      schemaVersion: SCHEMA_VERSION,
      tabId,
      url,
      startedAt,
      status: 'active',
      browser: this.detectBrowser(),
      navigations: [{
        id: navId,
        sessionId,
        url,
        kind: 'document',
        startedAt,
      }],
      metrics: [],
      events: [],
      experimentIds: [],
    };

    this.currentSessionId = sessionId;
    this.activeNavigationId = navId;
    this.documentNavigationId = navId;
    this.activeDocumentToken = null;
    this.retiredDocumentTokens.clear();
    this.allowDocumentTokenRotation = false;
    this.clearPendingNavigation();
    // Experiments start a session immediately before reloading the tab. Until
    // the new document commits, reject metrics from the old document.
    this.awaitingDocumentCommit = options?.awaitDocumentCommit ?? false;
    this.activeTabId = tabId;
    this.activeTabUrl = url;
    this.collectorStatus = 'initializing';
    this.error = undefined;
    this.overlayStatus = null;

    await storage.saveSession(session);
    await this.saveActivePointer({
      id: sessionId,
      tabId,
      url,
      navigationId: navId,
      awaitingDocumentCommit: this.awaitingDocumentCommit,
    });
    await this.broadcastState();

    return session;
  }

  addMetric(
    rawMetric: Partial<MetricRecord>,
    tabId?: number,
    documentToken?: string,
  ): Promise<void> {
    return this.enqueue(() => this.addMetricInternal(rawMetric, tabId, documentToken));
  }

  private async addMetricInternal(
    rawMetric: Partial<MetricRecord>,
    tabId?: number,
    documentToken?: string,
  ): Promise<void> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    if (tabId !== undefined && tabId !== this.activeTabId) return;
    if (this.awaitingDocumentCommit || this.pendingNavigationUrl) return;
    if (!(await this.acceptDocumentToken(documentToken))) return;

    const name = rawMetric.name;
    if (!isMetricName(name)) return;

    const activeNavigationId = this.activeNavigationId;
    const documentNavigationId = this.documentNavigationId;

    if ((await storage.countMetrics(sessionId)) >= STORAGE_LIMITS.maxMetricsPerSession) {
      return;
    }

    const session = await storage.getSession(sessionId);
    if (!session) return;

    const currentNav = session.navigations.find((nav) => nav.id === activeNavigationId)
      ?? session.navigations[session.navigations.length - 1];
    const isLoadMetric = name === 'LCP' || name === 'FCP' || name === 'TTFB';
    const navigationId = isLoadMetric
      ? documentNavigationId ?? currentNav?.id ?? ''
      : activeNavigationId ?? currentNav?.id ?? '';
    const thresholdConfig = METRIC_THRESHOLDS[name];
    const value = rawMetric.value ?? null;
    const status = isMetricStatus(rawMetric.status)
      ? rawMetric.status
      : value !== null
        ? 'measured'
        : 'pending';
    const source = isMetricSource(rawMetric.source) ? rawMetric.source : 'web-vitals';

    // Storage keys are global across sessions; the collector id is only
    // unique within a document. Namespace it so replays in one session can
    // never overwrite rows from another session on the same page.
    const attribution = rawMetric.attribution
      ? {
          ...rawMetric.attribution,
          longTaskIds: rawMetric.attribution.longTaskIds?.map((id) => `${sessionId}:${id}`),
        }
      : undefined;
    const metric: MetricRecord = {
      id: `${sessionId}:${rawMetric.id || generateId()}`,
      sessionId,
      navigationId,
      name,
      value,
      unit: thresholdConfig?.unit || 'ms',
      status,
      rating: calculateRating(name, value),
      observedAt: rawMetric.observedAt ?? Date.now(),
      delta: rawMetric.delta,
      source,
      metricId: rawMetric.metricId,
      navigationType: rawMetric.navigationType,
      attribution,
    };

    // The session may have been reset or replaced while awaiting; never persist
    // a metric into a session that is no longer the active one.
    if (this.currentSessionId !== sessionId) return;

    await storage.saveMetric(metric);
    this.collectorStatus = 'collecting';
    this.scheduleBroadcast();
  }

  addEvent(
    rawEvent: Partial<DiagnosticEvent>,
    tabId?: number,
    documentToken?: string,
  ): Promise<void> {
    return this.enqueue(() => this.addEventInternal(rawEvent, tabId, documentToken));
  }

  private async addEventInternal(
    rawEvent: Partial<DiagnosticEvent>,
    tabId?: number,
    documentToken?: string,
  ): Promise<void> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    if (tabId !== undefined && tabId !== this.activeTabId) return;
    if (this.awaitingDocumentCommit || this.pendingNavigationUrl) return;
    if (!(await this.acceptDocumentToken(documentToken))) return;
    if (!isEventType(rawEvent.type)) return;
    if (typeof rawEvent.timestamp !== 'number') return;

    const metricName = rawEvent.details?.metric;
    const isLoadMetricUpdate =
      rawEvent.type === 'metric-update' &&
      isMetricName(metricName) &&
      (metricName === 'LCP' || metricName === 'FCP' || metricName === 'TTFB');
    const navigationId = isLoadMetricUpdate
      ? this.documentNavigationId ?? this.activeNavigationId ?? ''
      : this.activeNavigationId ?? this.documentNavigationId ?? '';
    if (!navigationId) return;

    const event: DiagnosticEvent = {
      id: `${sessionId}:${rawEvent.id || generateId()}`,
      sessionId,
      navigationId,
      type: rawEvent.type,
      timestamp: rawEvent.timestamp,
      duration: rawEvent.duration,
      targetId: rawEvent.targetId,
      relatedMetricIds: rawEvent.relatedMetricIds?.map((id) => `${sessionId}:${id}`),
      details: rawEvent.details,
    };

    // The session may have been reset or replaced while awaiting; never persist
    // an event into a session that is no longer the active one.
    if (this.currentSessionId !== sessionId) return;

    await this.queueEvent(event);
  }

  // Buffers a validated event and writes it once a batch fills up, the flush
  // timer fires, or a lifecycle operation forces a flush.
  private async queueEvent(event: DiagnosticEvent): Promise<void> {
    const sessionId = event.sessionId;

    // A new session must never inherit another session's buffer.
    if (this.pendingEventSessionId && this.pendingEventSessionId !== sessionId) {
      await this.flushEventsInternal();
    }

    if (!this.eventCount || this.eventCount.sessionId !== sessionId) {
      this.eventCount = {
        sessionId,
        persisted: await storage.countEvents(sessionId),
        seen: new Set(),
      };
    }
    const counter = this.eventCount;

    // Redelivery of an event we already accepted is a no-op: `put` already
    // makes the write idempotent, but it must not consume the session limit.
    if (counter.seen.has(event.id)) {
      const index = this.pendingEvents.findIndex((pending) => pending.id === event.id);
      if (index >= 0) this.pendingEvents[index] = event;
      return;
    }

    if (
      counter.persisted + this.pendingEvents.length >=
      STORAGE_LIMITS.maxEventsPerSession
    ) {
      // Persist the buffer before dropping the overflow.
      await this.flushEventsInternal();
      if (counter.persisted >= STORAGE_LIMITS.maxEventsPerSession) return;
    }

    this.pendingEventSessionId = sessionId;
    this.pendingEvents.push(event);
    counter.seen.add(event.id);

    if (this.pendingEvents.length >= EVENT_BATCHING.batchSize) {
      await this.flushEventsInternal();
      return;
    }

    this.scheduleEventFlush();
    this.scheduleBroadcast();
  }

  flushEvents(): Promise<void> {
    return this.enqueue(() => this.flushEventsInternal());
  }

  private async flushEventsInternal(): Promise<void> {
    this.clearEventFlushTimer();
    const sessionId = this.pendingEventSessionId;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.pendingEventSessionId = null;
    if (!sessionId || events.length === 0) return;

    const counter = this.eventCount?.sessionId === sessionId ? this.eventCount : null;
    let written = 0;
    try {
      written = await storage.saveEvents(events);
    } catch (err) {
      // One non-cloneable payload must not take the whole batch down: retry
      // each record so the rest are still persisted.
      console.warn('[WPA] Failed to write event batch, retrying individually:', err);
      for (const event of events) {
        try {
          await storage.saveEvent(event);
          written++;
        } catch (writeError) {
          // Allow a later redelivery of the dropped event to be retried.
          counter?.seen.delete(event.id);
          console.warn('[WPA] Dropped diagnostic event:', event.id, writeError);
        }
      }
    }

    if (counter) counter.persisted += written;
    if (written > 0) this.scheduleBroadcast();
  }

  private scheduleEventFlush(): void {
    if (this.eventFlushTimer) return;
    this.eventFlushTimer = setTimeout(() => {
      this.eventFlushTimer = null;
      void this.enqueue(() => this.flushEventsInternal()).catch(console.error);
    }, EVENT_BATCHING.flushIntervalMs);
  }

  private clearEventFlushTimer(): void {
    if (!this.eventFlushTimer) return;
    clearTimeout(this.eventFlushTimer);
    this.eventFlushTimer = null;
  }

  setCollectorStatus(
    status: CollectorStatus,
    errorMsg?: string,
    documentToken?: string,
  ): Promise<void> {
    return this.enqueue(() => this.setCollectorStatusInternal(status, errorMsg, documentToken));
  }

  private async setCollectorStatusInternal(
    status: CollectorStatus,
    errorMsg?: string,
    documentToken?: string,
  ): Promise<void> {
    if (this.pendingNavigationUrl) return;
    if (documentToken && !(await this.acceptDocumentToken(documentToken))) return;
    this.collectorStatus = status;
    this.error = errorMsg;
    this.scheduleBroadcast();
  }

  setOverlayStatus(status: OverlayStatus | null): void {
    this.overlayStatus = status;
    this.scheduleBroadcast();
  }

  private async acceptDocumentToken(token?: string): Promise<boolean> {
    if (!token) return true;
    if (this.activeDocumentToken === token) return true;
    if (this.retiredDocumentTokens.has(token)) return false;

    if (this.activeDocumentToken === null) {
      this.activeDocumentToken = token;
      this.allowDocumentTokenRotation = false;
      await this.persistActivePointer();
      return true;
    }

    if (this.allowDocumentTokenRotation) {
      this.retiredDocumentTokens.add(this.activeDocumentToken);
      this.activeDocumentToken = token;
      this.allowDocumentTokenRotation = false;
      await this.persistActivePointer();
      return true;
    }

    return false;
  }

  private async persistActivePointer(): Promise<void> {
    if (!this.currentSessionId || this.activeTabId === null || !this.activeTabUrl) return;
    await this.saveActivePointer({
      id: this.currentSessionId,
      tabId: this.activeTabId,
      url: this.activeTabUrl,
      navigationId: this.activeNavigationId ?? undefined,
      documentToken: this.activeDocumentToken ?? undefined,
      awaitingDocumentCommit: this.awaitingDocumentCommit,
      pendingNavigationUrl: this.pendingNavigationUrl ?? undefined,
      pendingNavigationSince: this.pendingNavigationSince ?? undefined,
    });
  }

  private clearPendingNavigation(): void {
    this.pendingNavigationUrl = null;
    this.pendingNavigationSince = null;
    this.clearPendingNavigationTimer();
  }

  private clearPendingNavigationTimer(): void {
    if (!this.pendingNavigationTimer) return;
    clearTimeout(this.pendingNavigationTimer);
    this.pendingNavigationTimer = null;
  }

  private schedulePendingNavigationTimeout(sessionId: string, deadline: number): void {
    this.clearPendingNavigationTimer();
    const delay = Math.max(500, deadline - Date.now());
    this.pendingNavigationTimer = setTimeout(() => {
      this.pendingNavigationTimer = null;
      void this.enqueue(async () => {
        if (this.currentSessionId !== sessionId || !this.pendingNavigationUrl) return;
        await this.endSessionInternal(sessionId, 'interrupted');
      }).catch(console.error);
    }, delay);
  }

  private scheduleBroadcast(): void {
    const now = Date.now();
    if (now - this.lastBroadcastAt >= 100) {
      this.lastBroadcastAt = now;
      void this.broadcastState();
      return;
    }

    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.lastBroadcastAt = Date.now();
      void this.broadcastState();
    }, 100);
  }

  async getState(): Promise<AppState> {
    let session: AuditSession | null = null;
    const visibleSessionId = this.currentSessionId ?? this.lastSessionId;
    if (visibleSessionId) {
      try {
        session = (await storage.getSession(visibleSessionId)) ?? null;
      } catch (error) {
        // A damaged IndexedDB must not blank the panel: report it and keep the
        // rest of the state usable.
        console.warn('[WPA] Failed to read session state:', error);
        this.error = 'Не удалось прочитать сохранённые данные аудита';
        session = null;
      }
      // Surface buffered events immediately instead of waiting for a flush.
      if (
        session &&
        session.id === this.pendingEventSessionId &&
        this.pendingEvents.length > 0
      ) {
        const stored = new Set(session.events.map((event) => event.id));
        const events = [
          ...session.events,
          ...this.pendingEvents.filter((event) => !stored.has(event.id)),
        ].sort((left, right) => left.timestamp - right.timestamp);
        session = { ...session, events };
      }
    }

    // The panel should show the current URL even before an audit starts.
    if (!this.activeTabUrl) {
      try {
        const [tab] = await extensionApi.tabs.query({ active: true, lastFocusedWindow: true });
        this.activeTabUrl = tab?.url ?? null;
        if (tab?.id !== undefined && this.activeTabId === null) {
          this.activeTabId = tab.id;
        }
      } catch {
        // Ignore: the panel can still work without a URL.
      }
    }

    return {
      session,
      collectorStatus: this.collectorStatus,
      activeTabId: this.activeTabId,
      activeTabUrl: this.activeTabUrl,
      activeNavigationId: this.activeNavigationId,
      overlayStatus: this.overlayStatus,
      error: this.error,
    };
  }

  getSessionById(sessionId: string): Promise<AuditSession | undefined> {
    return storage.getSession(sessionId);
  }

  getSessionList(limit = STORAGE_LIMITS.maxSessions): Promise<SessionSummary[]> {
    return storage.getSessionSummaries(limit);
  }

  /**
   * Imports an exported report as a new, independent history entry. It never
   * overwrites an existing session, never becomes active, and never restores
   * DNR rules. The active audit (if any) is left untouched.
   */
  importReport(report: JsonReport): Promise<ImportReportResult> {
    return this.enqueue(async () => {
      const integrity = validateImportIntegrity(report);
      if (!integrity.valid) {
        return {
          error: `Отчёт не прошёл проверку импорта: ${integrity.errors.slice(0, 3).join('; ')}`,
        };
      }

      if (await storage.findImportedSession(report.session.id, report.generatedAt)) {
        return { error: 'Этот отчёт уже импортирован' };
      }
      if ((await storage.getAllSessions()).length >= STORAGE_LIMITS.maxSessions) {
        return {
          error: `История заполнена (${STORAGE_LIMITS.maxSessions} сессий). Удалите старые сессии или уменьшите срок хранения.`,
        };
      }

      const bundle = buildImportBundle(report);
      try {
        await storage.importSessionBundle(bundle);
      } catch (error) {
        if (
          error instanceof storage.ImportLimitError ||
          error instanceof storage.DuplicateImportError
        ) {
          return { error: error.message };
        }
        throw error;
      }

      // Make the import visible in the overview when no audit is running.
      if (!this.currentSessionId) {
        this.lastSessionId = bundle.session.id;
      }
      await this.broadcastState();

      return {
        success: true,
        sessionId: bundle.session.id,
        summary: importSummary(report, bundle),
        warnings: bundle.warnings,
      };
    });
  }

  /** Shows a stored session in the panel. Refused while an audit is running. */
  selectSession(sessionId: string): Promise<SessionActionResult> {
    return this.enqueue(async () => {
      if (this.currentSessionId) {
        return { error: 'Сначала остановите наблюдение' };
      }
      const session = await storage.getSession(sessionId);
      if (!session) return { error: 'Сессия не найдена' };
      this.lastSessionId = session.id;
      this.error = undefined;
      await this.broadcastState();
      return { success: true, sessionId: session.id };
    });
  }

  /** Deletes a stored session and everything that references it. */
  deleteSession(sessionId: string): Promise<SessionActionResult> {
    return this.enqueue(async () => {
      if (this.currentSessionId === sessionId) {
        return { error: 'Нельзя удалить активную сессию' };
      }
      const session = await storage.getSession(sessionId);
      if (!session) return { error: 'Сессия не найдена' };

      await storage.deleteSession(sessionId);
      if (this.lastSessionId === sessionId) {
        const [next] = await storage.getSessionSummaries(1);
        this.lastSessionId = next?.id ?? null;
      }
      await this.broadcastState();
      return { success: true };
    });
  }

  isActiveForTab(tabId: number): boolean {
    return this.currentSessionId !== null && this.activeTabId === tabId;
  }

  getActiveTabId(): number | null {
    return this.activeTabId;
  }

  getActiveSessionId(): string | null {
    return this.currentSessionId;
  }

  endSessionForTab(
    tabId: number,
    status: AuditSession['status'] = 'completed',
  ): Promise<void> {
    return this.enqueue(() => this.endSessionForTabInternal(tabId, status));
  }

  private async endSessionForTabInternal(
    tabId: number,
    status: AuditSession['status'],
  ): Promise<void> {
    if (this.activeTabId === tabId && this.currentSessionId) {
      await this.endSessionInternal(this.currentSessionId, status);
    }
  }

  endSession(sessionId: string, status: AuditSession['status']): Promise<void> {
    return this.enqueue(() => this.endSessionInternal(sessionId, status));
  }

  private async endSessionInternal(
    sessionId: string,
    status: AuditSession['status'],
  ): Promise<void> {
    // Never end a session with events still buffered in memory.
    await this.flushEventsInternal();
    const wasCurrent = this.currentSessionId === sessionId;
    const session = await storage.getSession(sessionId);
    if (session) {
      session.status = status;
      session.endedAt = Date.now();
      await storage.saveSession(session);
    }
    if (wasCurrent) {
      this.lastSessionId = sessionId;
      this.currentSessionId = null;
      this.activeNavigationId = null;
      this.documentNavigationId = null;
      this.activeDocumentToken = null;
      this.retiredDocumentTokens.clear();
      this.allowDocumentTokenRotation = false;
      this.awaitingDocumentCommit = false;
      this.clearPendingNavigation();
      this.collectorStatus = 'idle';
      this.activeTabId = null;
      this.activeTabUrl = null;
      this.overlayStatus = null;
      this.eventCount = null;
      await this.clearActivePointer();
    }
    await this.broadcastState();
  }

  reset(): Promise<void> {
    return this.enqueue(() => this.resetInternal());
  }

  // Reset and wipe storage inside one queued operation so a concurrent
  // SESSION_START cannot slip a write between them.
  resetAndClearAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.resetInternal();
      await storage.clearAllData();
    });
  }

  private async resetInternal(): Promise<void> {
    await this.flushEventsInternal();
    this.eventCount = null;
    this.currentSessionId = null;
    this.lastSessionId = null;
    this.activeNavigationId = null;
    this.documentNavigationId = null;
    this.activeDocumentToken = null;
    this.retiredDocumentTokens.clear();
    this.allowDocumentTokenRotation = false;
    this.awaitingDocumentCommit = false;
    this.clearPendingNavigation();
    this.collectorStatus = 'idle';
    this.activeTabId = null;
    this.activeTabUrl = null;
    this.overlayStatus = null;
    this.error = undefined;
    await this.clearActivePointer();
    await this.broadcastState();
  }

  handleNavigation(
    tabId: number,
    url: string,
    kind: 'document' | 'spa',
    transitionType?: string,
  ): Promise<boolean> {
    return this.enqueue(() => this.handleNavigationInternal(tabId, url, kind, transitionType));
  }

  private async handleNavigationInternal(
    tabId: number,
    url: string,
    kind: 'document' | 'spa',
    transitionType?: string,
  ): Promise<boolean> {
    if (this.activeTabId !== tabId || !this.currentSessionId) return false;

    // A restored session can wake up on a newer URL. The queued navigation
    // event owns the segment; do not discard the session or the navigation.
    this.clearPendingNavigation();

    const session = await storage.getSession(this.currentSessionId);
    if (!session) return false;

    const last = session.navigations[session.navigations.length - 1];
    const now = Date.now();
    // webNavigation can emit the initial document commit more than once. SPA
    // transitions are real user actions even when they repeat the same URL.
    if (
      kind === 'document' &&
      transitionType !== 'reload' &&
      last &&
      last.url === url &&
      session.navigations.length === 1 &&
      !this.awaitingDocumentCommit
    ) {
      return false;
    }

    // Close the old segment only after its buffered events are on disk.
    await this.flushEventsInternal();

    const previousNavigation = session.navigations.find(
      (navigation) => navigation.id === this.activeNavigationId,
    );
    if (previousNavigation) {
      previousNavigation.endedAt = previousNavigation.endedAt ?? now;
    }

    const navigationId = generateId();
    session.navigations.push({
      id: navigationId,
      sessionId: session.id,
      url,
      kind,
      startedAt: now,
      source: 'web-navigation',
    });
    session.url = url;

    this.activeTabUrl = url;
    this.activeNavigationId = navigationId;

    if (kind === 'spa') {
      // Old-document overlays are not valid after a SPA transition (FR-05).
      this.overlayStatus = null;
      if (typeof extensionApi.tabs.sendMessage === 'function') {
        const result = extensionApi.tabs.sendMessage(tabId, { type: 'CLEAR_HIGHLIGHT' });
        if (result && typeof result.catch === 'function') {
          void result.catch(() => {
            // The bridge may not be injected yet.
          });
        }
      }
    }

    if (kind === 'document') {
      this.documentNavigationId = navigationId;
      if (this.activeDocumentToken) {
        this.retiredDocumentTokens.add(this.activeDocumentToken);
      }
      this.activeDocumentToken = null;
      this.allowDocumentTokenRotation = false;
      this.awaitingDocumentCommit = false;
    }

    await storage.saveSession(session);

    if (kind === 'spa') {
      await this.queueEvent({
        id: `${session.id}:${generateId()}`,
        sessionId: session.id,
        navigationId,
        type: 'spa-navigation',
        timestamp: now,
        details: { url: sanitizeUrl(url) },
      });
    }

    await this.saveActivePointer({
      id: session.id,
      tabId,
      url,
      navigationId,
      documentToken: this.activeDocumentToken ?? undefined,
      awaitingDocumentCommit: this.awaitingDocumentCommit,
    });
    await this.broadcastState();
    return true;
  }

  generateReport(sessionId: string): Promise<JsonReport | null> {
    // The export must include events that are still buffered.
    return this.enqueue(async () => {
      await this.flushEventsInternal();
      return this.generateReportInternal(sessionId);
    });
  }

  private async generateReportInternal(sessionId: string): Promise<JsonReport | null> {
    const session = await storage.getSession(sessionId);
    if (!session) return null;
    const experiments = (await storage.getExperimentsForSession(sessionId)).map(
      (experiment) => ({ ...experiment, url: sanitizeUrl(experiment.url) }),
    );

    // URLs are exported without query/hash so tokens and PII cannot leak.
    const metrics = consolidateMetricUpdates(session.metrics).map(sanitizeMetricForReport);
    const navigations = session.navigations.map((navigation) => ({
      ...navigation,
      url: sanitizeUrl(navigation.url),
    }));
    const events = session.events.map((event) => {
      const containerSrc = event.details?.containerSrc;
      if (typeof containerSrc !== 'string') return event;
      return {
        ...event,
        details: { ...event.details, containerSrc: sanitizeUrl(containerSrc) },
      };
    });
    const attribution: ReportAttribution[] = metrics.reduce<ReportAttribution[]>(
      (entries, metric) => {
        if (metric.attribution) {
          entries.push({
            metricId: metric.id,
            metricName: metric.name,
            observedAt: metric.observedAt,
            attribution: metric.attribution,
          });
        }
        return entries;
      },
      [],
    );

    return {
      reportVersion: REPORT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      tool: {
        name: EXTENSION_NAME,
        version: EXTENSION_VERSION,
      },
      session: {
        id: session.id,
        tabId: session.tabId,
        documentId: session.documentId,
        url: sanitizeUrl(session.url),
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        status: session.status,
        browser: session.browser,
        navigations,
      },
      metrics,
      attribution,
      events,
      experiments,
      limitations: this.collectLimitations(session),
      completeness: {
        ...calculateCompleteness(session.metrics, session.events),
        observedSince: session.startedAt,
      },
    };
  }

  restore(): Promise<void> {
    return this.enqueue(() => this.restoreInternal());
  }

  private async restoreInternal(): Promise<void> {
    try {
      if (this.currentSessionId) return;
      const pointer = await this.readActivePointer();
      if (!pointer) return;

      const session = await storage.getSession(pointer.id);
      if (!session || session.status !== 'active') {
        if (session) this.lastSessionId = session.id;
        await this.clearActivePointer();
        await this.broadcastState();
        return;
      }

      const tab = await extensionApi.tabs.get(pointer.tabId).catch(() => undefined);
      const urlCheck = isAuditableUrl(tab?.url);
      if (!tab || !urlCheck.auditable) {
        session.status = 'interrupted';
        session.endedAt = Date.now();
        await storage.saveSession(session);
        this.lastSessionId = session.id;
        await this.clearActivePointer();
        await this.broadcastState();
        return;
      }

      // A new session may have started while the pointer/tab lookup was in flight.
      if (this.currentSessionId) return;

      const lastNavigation = session.navigations[session.navigations.length - 1];
      const lastDocumentNavigation = [...session.navigations]
        .reverse()
        .find((navigation) => navigation.kind === 'document');
      const pendingNavigationUrl =
        tab.url && tab.url !== pointer.url ? tab.url : null;
      const pendingNavigationSince = pendingNavigationUrl
        ? pointer.pendingNavigationUrl === pendingNavigationUrl &&
          typeof pointer.pendingNavigationSince === 'number'
          ? pointer.pendingNavigationSince
          : Date.now()
        : null;

      this.currentSessionId = session.id;
      this.lastSessionId = session.id;
      this.activeNavigationId = pointer.navigationId ?? lastNavigation?.id ?? null;
      this.documentNavigationId = lastDocumentNavigation?.id ?? this.activeNavigationId;
      this.activeDocumentToken = pointer.documentToken ?? null;
      this.retiredDocumentTokens.clear();
      // The switch may happen between startSession(awaitDocumentCommit) and
      // the reload commit, so the gate must survive an MV3 worker restart.
      this.awaitingDocumentCommit = pointer.awaitingDocumentCommit ?? false;
      // A URL change is applied by the navigation event that woke the worker.
      // Until then, reject metrics so they cannot land in the old segment.
      this.pendingNavigationUrl = pendingNavigationUrl;
      this.pendingNavigationSince = pendingNavigationSince;
      // The document may have been reloaded while the worker was asleep.
      this.allowDocumentTokenRotation = !this.awaitingDocumentCommit && !pendingNavigationUrl;
      this.activeTabId = pointer.tabId;
      this.activeTabUrl = tab.url ?? pointer.url;
      this.collectorStatus = pendingNavigationUrl ? 'initializing' : 'collecting';
      if (pendingNavigationUrl && pendingNavigationSince !== null) {
        await this.saveActivePointer({
          id: session.id,
          tabId: pointer.tabId,
          url: pointer.url,
          navigationId: this.activeNavigationId ?? undefined,
          documentToken: this.activeDocumentToken ?? undefined,
          awaitingDocumentCommit: this.awaitingDocumentCommit,
          pendingNavigationUrl,
          pendingNavigationSince,
        });
        this.schedulePendingNavigationTimeout(
          session.id,
          pendingNavigationSince + RESTORE_NAVIGATION_GRACE_MS,
        );
      }
      await this.broadcastState();
    } catch (err) {
      console.warn('[WPA] Failed to restore session:', err);
    }
  }

  private async saveActivePointer(pointer: ActiveSessionPointer): Promise<void> {
    await extensionApi.storage.local.set({ activeSession: pointer });
  }

  private async clearActivePointer(): Promise<void> {
    await extensionApi.storage.local.remove('activeSession');
  }

  private async readActivePointer(): Promise<ActiveSessionPointer | undefined> {
    const data = await extensionApi.storage.local.get('activeSession');
    const pointer = data.activeSession as ActiveSessionPointer | undefined;
    if (!pointer) return undefined;
    if (
      typeof pointer.id !== 'string' ||
      typeof pointer.tabId !== 'number' ||
      !Number.isFinite(pointer.tabId) ||
      typeof pointer.url !== 'string' ||
      (pointer.navigationId !== undefined && typeof pointer.navigationId !== 'string') ||
      (pointer.documentToken !== undefined && typeof pointer.documentToken !== 'string') ||
      (pointer.pendingNavigationUrl !== undefined &&
        typeof pointer.pendingNavigationUrl !== 'string') ||
      (pointer.pendingNavigationSince !== undefined &&
        (typeof pointer.pendingNavigationSince !== 'number' ||
          !Number.isFinite(pointer.pendingNavigationSince)))
    ) {
      // A damaged pointer would otherwise be re-validated and ignored on every
      // cold start. Dropping it lets the next restore start from a clean slate.
      await this.clearActivePointer();
      return undefined;
    }
    return pointer;
  }

  private collectLimitations(session: AuditSession): string[] {
    const limitations: string[] = [];
    const names: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

    for (const name of names) {
      const metrics = session.metrics.filter((m) => m.name === name);
      const latest = metrics[metrics.length - 1];

      if (!latest || latest.status === 'pending') {
        limitations.push(`${name}: метрика не была измерена за время сессии`);
      } else if (latest.status === 'unsupported') {
        limitations.push(`${name}: не поддерживается данным браузером`);
      }
    }

    if (!session.metrics.some((m) => m.name === 'INP' && m.status === 'measured')) {
      limitations.push('INP требует пользовательского взаимодействия для измерения');
    }

    for (const event of session.events) {
      if (event.type !== 'collector-limitation') continue;
      const message = event.details?.message;
      if (typeof message === 'string' && !limitations.includes(message)) {
        limitations.push(message);
      }
    }

    return limitations;
  }

  private async broadcastState(): Promise<void> {
    try {
      const state = await this.getState();
      await extensionApi.runtime.sendMessage({
        type: 'STATE_UPDATE',
        requestId: generateId(),
        state,
      });
    } catch {
      // Side Panel may be closed - this is normal
    }
  }

  private detectBrowser(): { name: string; version?: string } {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    // Firefox deliberately omits the `Chrome/` token; Edge and Opera include
    // both their own token and a Chrome-compatible one, so check them first.
    const firefox = ua.match(/Firefox\/([\d.]+)/);
    if (firefox) return { name: 'Firefox', version: firefox[1] };

    const edge = ua.match(/Edg\/([\d.]+)/);
    if (edge) return { name: 'Edge', version: edge[1] };

    const opera = ua.match(/OPR\/([\d.]+)/);
    if (opera) return { name: 'Opera', version: opera[1] };

    const chrome = ua.match(/Chrome\/([\d.]+)/);
    if (chrome) return { name: 'Chrome', version: chrome[1] };

    return { name: 'Unknown' };
  }
}
