import type { Experiment, ExperimentInput } from '../types/experiment';
import type { AuditSession } from '../types/session';
import { EXPERIMENT_POINTER_KEY } from '../constants/experiments';
import { SCHEMA_VERSION } from '../constants/config';
import { generateId } from '../utils/id';
import {
  compareMetricValues,
  emptyMetricValues,
  hasCoreResult,
  normalizeDomains,
  summarizeMetrics,
} from '../utils/experiment';
import * as storage from './storage';
import type { SessionManager } from './session-manager';

interface ExperimentPointer {
  id: string;
  tabId: number;
}

const RULE_ID_BASE = 10_000;

function ruleIds(experiment: Pick<Experiment, 'rules'>): number[] {
  return experiment.rules.map((rule) => rule.id);
}

export class ExperimentManager {
  private activeExperimentId: string | null = null;

  constructor(private readonly sessionManager: SessionManager) {}

  async getExperiments(): Promise<Experiment[]> {
    return storage.getAllExperiments();
  }

  async getActiveExperiment(): Promise<Experiment | undefined> {
    if (!this.activeExperimentId) return undefined;
    return storage.getExperiment(this.activeExperimentId);
  }

  async start(input: ExperimentInput): Promise<{
    experiment: Experiment;
    session: AuditSession;
  }> {
    if (this.activeExperimentId) {
      throw new Error('Сначала завершите текущий эксперимент');
    }

    // A failed cleanup leaves the pointer in place for a retry. Do not let a
    // new experiment overwrite that pointer while old DNR rules may remain.
    const stalePointer = await this.readPointer();
    if (stalePointer) {
      const stale = await storage.getExperiment(stalePointer.id);
      if (stale?.status === 'running') {
        throw new Error('Сначала завершите текущий эксперимент');
      }
      const cleaned = await this.purgeRules();
      if (!cleaned) {
        throw new Error('Не удалось очистить DNR-правила предыдущего эксперимента');
      }
      if (stale && stale.cleanupStatus === 'failed') {
        stale.cleanupVerified = true;
        stale.cleanupStatus = 'completed';
        await storage.saveExperiment(stale);
      }
      await this.clearPointer();
    }

    const baseline = await storage.getSession(input.baselineSessionId);
    if (!baseline) throw new Error('Исходная сессия не найдена');
    if (baseline.status !== 'active') throw new Error('Исходная сессия уже завершена');
    if (baseline.tabId !== input.tabId) throw new Error('Эксперимент должен выполняться на той же вкладке');

    const domains = normalizeDomains(input.domains);
    if (domains.length === 0) throw new Error('Укажите хотя бы один корректный домен');

    const baselineValues = summarizeMetrics(baseline.metrics);
    if (!hasCoreResult(baselineValues)) {
      throw new Error('Недостаточно метрик исходной сессии для сравнения');
    }

    const experiment: Experiment = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      baselineSessionId: baseline.id,
      tabId: baseline.tabId,
      url: baseline.url,
      createdAt: Date.now(),
      startedAt: Date.now(),
      status: 'running',
      preset: input.preset,
      domains,
      rules: domains.map((domain, index) => ({
        id: RULE_ID_BASE + index,
        domains: [domain],
      })),
      note: input.note,
      baselineValues,
      experimentValues: emptyMetricValues(),
      comparison: [],
      limitations: [],
      cleanupStatus: 'pending',
    };

    await storage.saveExperiment(experiment);
    this.activeExperimentId = experiment.id;
    await this.savePointer({ id: experiment.id, tabId: experiment.tabId });

    try {
      await this.applyRules(experiment);
    } catch (error) {
      // The update may have partially applied before it threw; verify cleanup
      // so a broken start never leaves blocking rules behind.
      const cleanupVerified = await this.cleanupRules(experiment);
      experiment.status = 'failed';
      experiment.endedAt = Date.now();
      experiment.cleanupVerified = cleanupVerified;
      experiment.cleanupStatus = cleanupVerified ? 'completed' : 'failed';
      experiment.limitations.push(`Не удалось применить правила блокировки: ${String(error)}`);
      await storage.saveExperiment(experiment);
      if (cleanupVerified) await this.clearPointer();
      this.activeExperimentId = null;
      throw error;
    }

    let launchedSessionId: string | undefined;

    try {
      // Stop the old document before the session is replaced. Even if this
      // message is lost, `awaitDocumentCommit` rejects its metrics until the
      // experiment reload commits.
      await chrome.tabs
        .sendMessage(baseline.tabId, {
          type: 'COLLECTOR_STOP',
          requestId: generateId(),
        })
        .catch(() => undefined);
      await chrome.tabs
        .sendMessage(baseline.tabId, {
          type: 'CLEAR_HIGHLIGHT',
          requestId: generateId(),
        })
        .catch(() => undefined);
      this.sessionManager.setOverlayStatus(null);

      await this.sessionManager.endSession(baseline.id, 'completed');
      const session = await this.sessionManager.startSession(
        baseline.tabId,
        baseline.url,
        { awaitDocumentCommit: true },
      );

      launchedSessionId = session.id;
      experiment.experimentSessionId = session.id;
      session.experimentIds.push(experiment.id);
      await storage.saveSession(session);
      await storage.saveExperiment(experiment);

      // Do not inject into the old document: its cached metrics would be
      // replayed into the new experiment session. The navigation listener
      // injects the bridge into the freshly reloaded document instead.
      await chrome.tabs.reload(baseline.tabId);

      return { experiment, session };
    } catch (error) {
      // startSession sets currentSessionId before its persistence awaits, so
      // fall back to it when startSession itself failed.
      const sessionIdToEnd =
        launchedSessionId ?? this.sessionManager.getActiveSessionId() ?? undefined;
      if (sessionIdToEnd) {
        // Without a committed reload the session gate can never open.
        await this.sessionManager.endSession(sessionIdToEnd, 'error').catch(console.error);
      }
      const cleanupVerified = await this.cleanupRules(experiment);
      experiment.status = 'failed';
      experiment.endedAt = Date.now();
      experiment.cleanupVerified = cleanupVerified;
      experiment.cleanupStatus = cleanupVerified ? 'completed' : 'failed';
      experiment.limitations.push(`Эксперимент не запущен: ${String(error)}`);
      await storage.saveExperiment(experiment);
      if (cleanupVerified) await this.clearPointer();
      this.activeExperimentId = null;
      throw error;
    }
  }

  async finish(experimentId: string): Promise<Experiment> {
    const experiment = await storage.getExperiment(experimentId);
    if (!experiment) throw new Error('Эксперимент не найден');
    if (experiment.status !== 'running') return experiment;

    const session = experiment.experimentSessionId
      ? await storage.getSession(experiment.experimentSessionId)
      : undefined;
    const experimentValues = summarizeMetrics(session?.metrics ?? []);

    experiment.experimentValues = experimentValues;
    experiment.comparison = compareMetricValues(experiment.baselineValues, experimentValues);
    experiment.endedAt = Date.now();

    const cleanupVerified = await this.cleanupRules(experiment);
    experiment.cleanupVerified = cleanupVerified;
    experiment.cleanupStatus = cleanupVerified ? 'completed' : 'failed';

    const hasResult = hasCoreResult(experimentValues);
    if (!cleanupVerified) {
      // 7.7: `completed` must never be assigned when the rules could not be
      // removed, even if the measurement itself succeeded.
      experiment.status = 'failed';
      experiment.limitations.push(
        'Не удалось подтвердить удаление временных DNR-правил: эксперимент помечен как failed',
      );
    } else {
      experiment.status = hasResult ? 'completed' : 'incomplete';
    }
    if (!hasResult) {
      experiment.limitations.push('В экспериментальной сессии не измерено ни одной Core Web Vital');
    }
    experiment.limitations.push(
      'Различия могут быть вызваны кэшем, сетью, порядком запросов и состоянием приложения.',
    );

    await storage.saveExperiment(experiment);

    if (experiment.experimentSessionId) {
      await this.sessionManager.endSession(experiment.experimentSessionId, 'completed');
    }
    await chrome.tabs
      .sendMessage(experiment.tabId, {
        type: 'COLLECTOR_STOP',
        requestId: generateId(),
      })
      .catch(() => {
        // The tab may already be closed.
      });
    await chrome.tabs
      .sendMessage(experiment.tabId, {
        type: 'CLEAR_HIGHLIGHT',
        requestId: generateId(),
      })
      .catch(() => undefined);
    this.sessionManager.setOverlayStatus(null);

    // Keep the pointer when cleanup is unverified so restore()/the next SW
    // start can retry removing the session rules.
    if (cleanupVerified) {
      await this.clearPointer();
    }
    this.activeExperimentId = null;
    return experiment;
  }

  async cancel(experimentId: string): Promise<Experiment> {
    const experiment = await storage.getExperiment(experimentId);
    if (!experiment) throw new Error('Эксперимент не найден');
    if (experiment.status !== 'running') return experiment;

    const cleanupVerified = await this.cleanupRules(experiment);
    experiment.status = cleanupVerified ? 'cancelled' : 'failed';
    experiment.endedAt = Date.now();
    experiment.cleanupVerified = cleanupVerified;
    experiment.cleanupStatus = cleanupVerified ? 'completed' : 'failed';
    if (!cleanupVerified) {
      experiment.limitations.push('Не удалось подтвердить удаление временных DNR-правил');
    }
    await storage.saveExperiment(experiment);

    if (experiment.experimentSessionId) {
      await this.sessionManager.endSession(experiment.experimentSessionId, 'interrupted');
    }
    await chrome.tabs
      .sendMessage(experiment.tabId, {
        type: 'COLLECTOR_STOP',
        requestId: generateId(),
      })
      .catch(() => {
        // The tab may already be closed.
      });
    await chrome.tabs
      .sendMessage(experiment.tabId, {
        type: 'CLEAR_HIGHLIGHT',
        requestId: generateId(),
      })
      .catch(() => undefined);
    this.sessionManager.setOverlayStatus(null);

    if (this.activeExperimentId === experiment.id) {
      this.activeExperimentId = null;
      if (cleanupVerified) await this.clearPointer();
    }
    return experiment;
  }

  async cancelActive(): Promise<Experiment | undefined> {
    if (this.activeExperimentId) {
      return this.cancel(this.activeExperimentId);
    }
    // The in-memory id can be empty on a cold service worker before restore()
    // has run, so fall back to the persisted pointer.
    const pointer = await this.readPointer();
    if (!pointer) return undefined;
    const experiment = await storage.getExperiment(pointer.id);
    if (!experiment) {
      // The record may already be gone after CLEAR_HISTORY; keep the pointer
      // for restore() unless the leftover rules are actually removed.
      const purged = await this.purgeRules();
      if (purged) await this.clearPointer();
      return undefined;
    }
    if (experiment.status !== 'running') {
      if (experiment.cleanupStatus === 'failed') {
        const cleanupVerified = await this.cleanupRules(experiment);
        if (!cleanupVerified) {
          await storage.saveExperiment(experiment);
          return undefined;
        }
        experiment.cleanupVerified = true;
        experiment.cleanupStatus = 'completed';
        await storage.saveExperiment(experiment);
      }
      await this.clearPointer();
      return undefined;
    }
    this.activeExperimentId = experiment.id;
    return this.cancel(experiment.id);
  }

  async purgeRules(): Promise<boolean> {
    try {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const ids = rules.filter((rule) => rule.id >= RULE_ID_BASE).map((rule) => rule.id);
      if (ids.length > 0) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
      }
      const remaining = await chrome.declarativeNetRequest.getSessionRules();
      return !remaining.some((rule) => rule.id >= RULE_ID_BASE);
    } catch (error) {
      console.error('[WPA] Failed to purge DNR rules:', error);
      return false;
    }
  }

  async finishForSession(sessionId: string): Promise<Experiment | undefined> {
    const active = await this.getActiveExperiment();
    if (!active || active.status !== 'running') return undefined;
    if (active.experimentSessionId !== sessionId) return undefined;
    return this.finish(active.id);
  }

  async cancelForTab(tabId: number): Promise<Experiment | undefined> {
    const active = await this.getActiveExperiment();
    if (!active || active.status !== 'running' || active.tabId !== tabId) return undefined;
    return this.cancel(active.id);
  }

  async restore(): Promise<void> {
    const pointer = await this.readPointer();
    if (!pointer) return;

    const experiment = await storage.getExperiment(pointer.id);
    if (!experiment) {
      // CLEAR_HISTORY may have deleted the record before a failed purge.
      // Keep the pointer until the leftover rules are gone.
      const purged = await this.purgeRules();
      if (purged) await this.clearPointer();
      this.activeExperimentId = null;
      return;
    }
    if (experiment.status !== 'running') {
      if (experiment.cleanupStatus === 'failed') {
        // A previous finish/cancel/start failure left rules behind. Retry on
        // every SW start until removal is verified.
        const cleanupVerified = await this.cleanupRules(experiment);
        if (!cleanupVerified) {
          await storage.saveExperiment(experiment);
          this.activeExperimentId = null;
          return;
        }
        experiment.cleanupVerified = true;
        experiment.cleanupStatus = 'completed';
        await storage.saveExperiment(experiment);
      }
      await this.clearPointer();
      this.activeExperimentId = null;
      return;
    }

    this.activeExperimentId = experiment.id;

    const session = experiment.experimentSessionId
      ? await storage.getSession(experiment.experimentSessionId)
      : undefined;
    if (!session || session.status !== 'active') {
      await this.finish(experiment.id).catch(console.error);
      return;
    }

    try {
      await this.applyRules(experiment);
    } catch (error) {
      const cleanupVerified = await this.cleanupRules(experiment);
      experiment.status = 'failed';
      experiment.endedAt = Date.now();
      experiment.cleanupVerified = cleanupVerified;
      experiment.cleanupStatus = cleanupVerified ? 'completed' : 'failed';
      experiment.limitations.push(`Не удалось восстановить правила эксперимента: ${String(error)}`);
      await storage.saveExperiment(experiment);
      if (cleanupVerified) await this.clearPointer();
      this.activeExperimentId = null;
    }
  }

  private async applyRules(experiment: Experiment): Promise<void> {
    const ids = ruleIds(experiment);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ids,
      addRules: experiment.rules.map((rule) => ({
        id: rule.id,
        priority: 1_000,
        action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
        condition: {
          requestDomains: rule.domains,
          tabIds: [experiment.tabId],
        },
      })),
    });
  }

  private async cleanupRules(experiment: Experiment): Promise<boolean> {
    const ids = ruleIds(experiment);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return !rules.some((rule) => ids.includes(rule.id));
    } catch (error) {
      experiment.limitations.push(`Очистка DNR-правил завершилась ошибкой: ${String(error)}`);
      return false;
    }
  }

  private async readPointer(): Promise<ExperimentPointer | undefined> {
    const stored = await chrome.storage.local.get(EXPERIMENT_POINTER_KEY);
    return stored[EXPERIMENT_POINTER_KEY] as ExperimentPointer | undefined;
  }

  private async savePointer(pointer: ExperimentPointer): Promise<void> {
    await chrome.storage.local.set({ [EXPERIMENT_POINTER_KEY]: pointer });
  }

  private async clearPointer(): Promise<void> {
    await chrome.storage.local.remove(EXPERIMENT_POINTER_KEY);
  }
}
