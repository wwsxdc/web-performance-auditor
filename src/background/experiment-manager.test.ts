import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditSession } from '../types/session';
import type { Experiment } from '../types/experiment';
import { EXPERIMENT_POINTER_KEY } from '../constants/experiments';
import { SCHEMA_VERSION } from '../constants/config';
import { ExperimentManager } from './experiment-manager';
import { SessionManager } from './session-manager';
import { clearAllData, getExperiment, saveExperiment, saveSession } from './storage';

const localStore = new Map<string, unknown>();
const sessionRules = new Map<number, { id: number }>();

const chromeMock = {
  storage: {
    local: {
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) localStore.set(key, value);
      }),
      get: vi.fn(async (key: string) => ({ [key]: localStore.get(key) })),
      remove: vi.fn(async (key: string) => {
        localStore.delete(key);
      }),
    },
  },
  tabs: {
    get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/' })),
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
  declarativeNetRequest: {
    updateSessionRules: vi.fn(
      async (options: {
        removeRuleIds?: number[];
        addRules?: { id: number }[];
      }) => {
        for (const id of options.removeRuleIds ?? []) sessionRules.delete(id);
        for (const rule of options.addRules ?? []) sessionRules.set(rule.id, rule);
      },
    ),
    getSessionRules: vi.fn(async () => [...sessionRules.values()]),
  },
};

function makeSession(id: string, status: AuditSession['status'] = 'active'): AuditSession {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    tabId: 1,
    url: 'https://example.com/',
    startedAt: Date.now(),
    status,
    browser: { name: 'Chrome', version: '155' },
    navigations: [],
    metrics: [],
    events: [],
    experimentIds: [],
  };
}

function makeRunningExperiment(id: string, baselineSessionId: string): Experiment {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    baselineSessionId,
    tabId: 1,
    url: 'https://example.com/',
    createdAt: Date.now(),
    startedAt: Date.now(),
    status: 'running',
    preset: 'custom',
    domains: ['cdn.example.net'],
    rules: [{ id: 10_000, domains: ['cdn.example.net'] }],
    baselineValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: 1200, TTFB: 200 },
    experimentValues: { LCP: null, CLS: null, INP: null, FCP: null, TTFB: null },
    comparison: [],
    limitations: [],
    cleanupStatus: 'pending',
  };
}

beforeEach(async () => {
  localStore.clear();
  sessionRules.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  await clearAllData();
});

afterEach(async () => {
  await clearAllData();
  vi.clearAllMocks();
});

describe('ExperimentManager cold-start cleanup', () => {
  it('cancels a running experiment via the persisted pointer before restore runs', async () => {
    const baseline = makeSession('baseline');
    await saveSession(baseline);
    const experiment = makeRunningExperiment('experiment', baseline.id);
    await saveExperiment(experiment);
    sessionRules.set(10_000, { id: 10_000 });
    localStore.set(EXPERIMENT_POINTER_KEY, { id: experiment.id, tabId: 1 });

    const manager = new ExperimentManager(new SessionManager());
    const cancelled = await manager.cancelActive();

    expect(cancelled?.id).toBe(experiment.id);
    expect((await getExperiment(experiment.id))?.status).toBe('cancelled');
    expect(sessionRules.size).toBe(0);
    expect(localStore.has(EXPERIMENT_POINTER_KEY)).toBe(false);
  });

  it('keeps a retry pointer when the experiment record is gone but purge fails', async () => {
    sessionRules.set(10_000, { id: 10_000 });
    localStore.set(EXPERIMENT_POINTER_KEY, { id: 'missing', tabId: 1 });
    chromeMock.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      async () => {
        throw new Error('DNR unavailable');
      },
    );

    const manager = new ExperimentManager(new SessionManager());
    await manager.cancelActive();

    expect(localStore.has(EXPERIMENT_POINTER_KEY)).toBe(true);
    expect(sessionRules.size).toBe(1);

    await manager.restore();

    expect(localStore.has(EXPERIMENT_POINTER_KEY)).toBe(false);
    expect(sessionRules.size).toBe(0);
  });

  it('purges only WPA session rules', async () => {
    sessionRules.set(10_000, { id: 10_000 });
    sessionRules.set(10_001, { id: 10_001 });
    sessionRules.set(5, { id: 5 });

    const manager = new ExperimentManager(new SessionManager());
    const verified = await manager.purgeRules();

    expect(verified).toBe(true);
    expect([...sessionRules.keys()]).toEqual([5]);
  });

  it('never marks an experiment completed when rules could not be cleaned up', async () => {
    const baseline = makeSession('baseline', 'completed');
    const result = makeSession('result');
    result.metrics.push({
      id: 'metric-lcp',
      sessionId: result.id,
      navigationId: 'nav',
      name: 'LCP',
      value: 2500,
      unit: 'ms',
      status: 'measured',
      rating: 'good',
      observedAt: Date.now(),
      source: 'web-vitals',
    });
    await saveSession(baseline);
    await saveSession(result);

    const experiment = makeRunningExperiment('experiment', baseline.id);
    experiment.experimentSessionId = result.id;
    await saveExperiment(experiment);
    sessionRules.set(10_000, { id: 10_000 });

    chromeMock.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      async () => {
        throw new Error('DNR unavailable');
      },
    );

    const manager = new ExperimentManager(new SessionManager());
    const finished = await manager.finish(experiment.id);

    // The measurement succeeded, but cleanup did not: 7.7 forbids `completed`.
    expect(finished.status).toBe('failed');
    expect(finished.cleanupStatus).toBe('failed');
    expect(finished.cleanupVerified).toBe(false);
    expect(finished.limitations.join(' ')).toContain('DNR');
  });

  it('keeps the pointer after a failed cleanup and retries it on the next start', async () => {
    const baseline = makeSession('baseline', 'completed');
    const result = makeSession('result');
    await saveSession(baseline);
    await saveSession(result);

    const experiment = makeRunningExperiment('experiment', baseline.id);
    experiment.experimentSessionId = result.id;
    await saveExperiment(experiment);
    sessionRules.set(10_000, { id: 10_000 });
    localStore.set(EXPERIMENT_POINTER_KEY, { id: experiment.id, tabId: 1 });

    chromeMock.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      async () => {
        throw new Error('DNR unavailable');
      },
    );

    const manager = new ExperimentManager(new SessionManager());
    const finished = await manager.finish(experiment.id);

    expect(finished.status).toBe('failed');
    expect(localStore.has(EXPERIMENT_POINTER_KEY)).toBe(true);
    expect(sessionRules.size).toBe(1);

    await manager.restore();

    expect(sessionRules.size).toBe(0);
    expect(localStore.has(EXPERIMENT_POINTER_KEY)).toBe(false);
    expect((await getExperiment(experiment.id))?.cleanupStatus).toBe('completed');
  });
});
