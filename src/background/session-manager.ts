import type { AuditSession } from '../types/session';
import type { MetricRecord, MetricName } from '../types/metrics';
import type { DiagnosticEvent } from '../types/events';
import type { AppState, CollectorStatus, OverlayStatus } from '../types/messages';
import type { JsonReport, ReportAttribution } from '../types/report';
import { generateId } from '../utils/id';
import { calculateRating } from '../utils/rating';
import { isAuditableUrl, sanitizeUrl } from '../utils/url';
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
  STORAGE_LIMITS,
} from '../constants/config';
import { METRIC_THRESHOLDS } from '../constants/thresholds';
import * as storage from './storage';

export const RESTORE_NAVIGATION_GRACE_MS = 2000;

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
    this.lastSessionId = null;

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

    if ((await storage.countEvents(sessionId)) >= STORAGE_LIMITS.maxEventsPerSession) {
      return;
    }

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

    await storage.saveEvent(event);
    this.scheduleBroadcast();
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
      session = (await storage.getSession(visibleSessionId)) ?? null;
    }

    // The panel should show the current URL even before an audit starts.
    if (!this.activeTabUrl) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
      if (typeof chrome.tabs.sendMessage === 'function') {
        const result = chrome.tabs.sendMessage(tabId, { type: 'CLEAR_HIGHLIGHT' });
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
      const event: DiagnosticEvent = {
        id: `${session.id}:${generateId()}`,
        sessionId: session.id,
        navigationId,
        type: 'spa-navigation',
        timestamp: now,
        details: { url: sanitizeUrl(url) },
      };
      if (
        (await storage.countEvents(session.id)) <
        STORAGE_LIMITS.maxEventsPerSession
      ) {
        await storage.saveEvent(event);
      }
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

  async generateReport(sessionId: string): Promise<JsonReport | null> {
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

      const tab = await chrome.tabs.get(pointer.tabId).catch(() => undefined);
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
    await chrome.storage.local.set({ activeSession: pointer });
  }

  private async clearActivePointer(): Promise<void> {
    await chrome.storage.local.remove('activeSession');
  }

  private async readActivePointer(): Promise<ActiveSessionPointer | undefined> {
    const data = await chrome.storage.local.get('activeSession');
    const pointer = data.activeSession as ActiveSessionPointer | undefined;
    if (
      !pointer ||
      typeof pointer.id !== 'string' ||
      typeof pointer.tabId !== 'number' ||
      typeof pointer.url !== 'string' ||
      (pointer.navigationId !== undefined && typeof pointer.navigationId !== 'string') ||
      (pointer.documentToken !== undefined && typeof pointer.documentToken !== 'string') ||
      (pointer.pendingNavigationUrl !== undefined &&
        typeof pointer.pendingNavigationUrl !== 'string') ||
      (pointer.pendingNavigationSince !== undefined &&
        (typeof pointer.pendingNavigationSince !== 'number' ||
          !Number.isFinite(pointer.pendingNavigationSince)))
    ) {
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

    return limitations;
  }

  private async broadcastState(): Promise<void> {
    try {
      const state = await this.getState();
      await chrome.runtime.sendMessage({
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
    const match = ua.match(/Chrome\/(\d+)/);
    return {
      name: 'Chrome',
      version: match?.[1],
    };
  }
}
