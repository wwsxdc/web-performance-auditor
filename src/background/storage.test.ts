import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditSession } from '../types/session';
import type { DiagnosticEvent } from '../types/events';
import type { Experiment } from '../types/experiment';
import { SCHEMA_VERSION } from '../constants/config';
import {
  cleanOldSessions,
  clearAllData,
  countEvents,
  deleteSession,
  getAllExperiments,
  getAllSessions,
  getExperiment,
  getExperimentsForSession,
  getSession,
  getSessionSummaries,
  saveEvents,
  saveExperiment,
  saveSession,
} from './storage';

function makeSession(
  id: string,
  startedAt: number,
  status: AuditSession['status'] = 'completed',
): AuditSession {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    tabId: 1,
    url: 'https://example.com/',
    startedAt,
    status,
    browser: { name: 'Chrome', version: '155' },
    navigations: [],
    metrics: [],
    events: [],
    experimentIds: [],
  };
}

function makeExperiment(id: string, baselineSessionId: string, status: Experiment['status']): Experiment {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    baselineSessionId,
    tabId: 1,
    url: 'https://example.com/',
    createdAt: Date.now(),
    startedAt: Date.now(),
    status,
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

function putRawRecord(store: 'sessions' | 'experiments', value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wpa-store');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

function getRawRecord(
  store: 'sessions' | 'experiments',
  key: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wpa-store');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, 'readonly');
      const get = tx.objectStore(store).get(key);
      get.onsuccess = () => {
        const value = get.result;
        db.close();
        resolve(value);
      };
      get.onerror = () => {
        db.close();
        reject(get.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  await clearAllData();
});

afterEach(async () => {
  await clearAllData();
});

function makeEvent(sessionId: string, id: string, timestamp: number): DiagnosticEvent {
  return {
    id: `${sessionId}:${id}`,
    sessionId,
    navigationId: 'navigation-1',
    type: 'long-task',
    timestamp,
    duration: 120,
  };
}

describe('event batching', () => {
  it('writes a batch in one transaction and is idempotent for repeated ids', async () => {
    const session = makeSession('batch-session', Date.now(), 'active');
    await saveSession(session);
    const events = [
      makeEvent(session.id, 'e1', 1000),
      makeEvent(session.id, 'e2', 1001),
      makeEvent(session.id, 'e3', 1002),
    ];

    expect(await saveEvents(events)).toBe(3);
    expect(await countEvents(session.id)).toBe(3);

    // Redelivery with the same ids overwrites instead of duplicating.
    expect(await saveEvents([events[0]])).toBe(1);
    expect(await countEvents(session.id)).toBe(3);

    const stored = await getSession(session.id);
    expect(stored?.events.map((event) => event.timestamp)).toEqual([1000, 1001, 1002]);
  });

  it('treats an empty batch as a no-op', async () => {
    expect(await saveEvents([])).toBe(0);
  });
});

describe('storage cleanup', () => {
  it('keeps the active session and sessions used by a running experiment', async () => {
    const now = Date.now();
    const protectedSession = makeSession('protected-baseline', now - 40 * 24 * 60 * 60 * 1000);
    await saveSession(protectedSession);
    await saveExperiment(makeExperiment('running', protectedSession.id, 'running'));

    for (let index = 0; index < 53; index++) {
      await saveSession(makeSession(`finished-${index}`, now - index * 1000));
    }
    await saveSession(makeSession('active', now, 'active'));

    const deleted = await cleanOldSessions();
    const remaining = await getAllSessions();

    expect(deleted).toBe(5);
    expect(remaining).toHaveLength(50);
    expect(remaining.some((session) => session.id === 'active')).toBe(true);
    expect(remaining.some((session) => session.id === protectedSession.id)).toBe(true);
  });

  it('keeps sessions referenced by a completed experiment during retention', async () => {
    const now = Date.now();
    const oldBaseline = makeSession(
      'old-baseline',
      now - 40 * 24 * 60 * 60 * 1000,
    );
    await saveSession(oldBaseline);
    await saveExperiment(makeExperiment('finished-experiment', oldBaseline.id, 'completed'));

    const deleted = await cleanOldSessions();

    expect(deleted).toBe(0);
    expect((await getAllSessions()).some((session) => session.id === oldBaseline.id)).toBe(true);
  });

  it('finds experiments by baseline and result session indexes', async () => {
    const baseline = makeSession('baseline', Date.now());
    const result = makeSession('result', Date.now());
    await saveSession(baseline);
    await saveSession(result);

    const experiment = makeExperiment('experiment', baseline.id, 'completed');
    experiment.experimentSessionId = result.id;
    await saveExperiment(experiment);

    expect((await getExperimentsForSession(baseline.id)).map((item) => item.id)).toEqual([
      'experiment',
    ]);
    expect((await getExperimentsForSession(result.id)).map((item) => item.id)).toEqual([
      'experiment',
    ]);
    expect(await getExperimentsForSession('other')).toEqual([]);
  });

  it('removes experiments that reference a deleted session', async () => {
    const baseline = makeSession('baseline', Date.now());
    const result = makeSession('result', Date.now());
    await saveSession(baseline);
    await saveSession(result);
    await saveExperiment(makeExperiment('experiment', baseline.id, 'completed'));

    await deleteSession(baseline.id);

    expect(await getExperiment('experiment')).toBeUndefined();
    expect(await getAllExperiments()).toHaveLength(0);
    expect(await getAllSessions()).toHaveLength(1);
  });

  it('keeps unknown-schema sessions during cleanup even when marked active', async () => {
    const legacySession = {
      ...makeSession('legacy-active', Date.now(), 'active'),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    await putRawRecord('sessions', legacySession);

    const deleted = await cleanOldSessions();

    // A future schema is unreadable here, but a later (higher-version) build
    // may still understand it, so retention must not destroy it.
    expect(deleted).toBe(0);
    expect(await getSession('legacy-active')).toBeUndefined();
    expect(await getRawRecord('sessions', 'legacy-active')).toMatchObject({
      id: 'legacy-active',
      schemaVersion: SCHEMA_VERSION + 1,
    });
  });

  it('keeps an unknown-schema running experiment and its supported session', async () => {
    const oldStartedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const supported = makeSession('supported', oldStartedAt, 'completed');
    await saveSession(supported);
    await putRawRecord('experiments', {
      ...makeExperiment('legacy-running', supported.id, 'running'),
      schemaVersion: SCHEMA_VERSION + 1,
    });

    const deleted = await cleanOldSessions();

    // The session is past the retention window, but a newer build may still be
    // running this experiment, so deleting its baseline would corrupt it.
    expect(deleted).toBe(0);
    expect(await getAllExperiments()).toHaveLength(0);
    expect((await getAllSessions()).some((session) => session.id === supported.id)).toBe(true);
    expect(await getRawRecord('experiments', 'legacy-running')).toMatchObject({
      id: 'legacy-running',
      schemaVersion: SCHEMA_VERSION + 1,
    });
  });

  it('does not protect an old session of an unknown-schema finished experiment', async () => {
    const oldStartedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const finished = makeSession('finished-session', oldStartedAt, 'completed');
    await saveSession(finished);
    await putRawRecord('experiments', {
      ...makeExperiment('legacy-finished', finished.id, 'completed'),
      schemaVersion: SCHEMA_VERSION + 1,
    });

    const deleted = await cleanOldSessions();

    // Only running experiments hold their sessions: a finished one must not
    // pin history forever just because this build cannot read it.
    expect(deleted).toBe(1);
    expect((await getAllSessions()).some((session) => session.id === finished.id)).toBe(false);
    // deleteSession cascades through the raw index, so no dangling future
    // experiment is left behind.
    expect(await getRawRecord('experiments', 'legacy-finished')).toBeUndefined();
  });

  it('ignores stored records with an unknown schema version', async () => {
    const legacySession = {
      ...makeSession('legacy-session', Date.now()),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    const legacyExperiment = {
      ...makeExperiment('legacy-experiment', legacySession.id, 'completed'),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    await putRawRecord('sessions', legacySession);
    await putRawRecord('experiments', legacyExperiment);

    expect(await getSession('legacy-session')).toBeUndefined();
    expect(await getExperiment('legacy-experiment')).toBeUndefined();
    expect(await getAllSessions()).toEqual([]);
    expect(await getAllExperiments()).toEqual([]);
    expect(await getExperimentsForSession('legacy-session')).toEqual([]);
  });
});

describe('schema migrations', () => {
  function makeV1Session(id: string): Record<string, unknown> {
    return {
      id,
      schemaVersion: 1,
      tabId: 7,
      url: 'https://example.com/legacy?token=secret',
      startedAt: 1_700_000_000_000,
      status: 'interrupted',
      // v1 had a single navigation id instead of the navigation list.
      navigationId: 'legacy-navigation',
      // v1 stored the browser as a plain string.
      browser: 'Chrome',
    };
  }

  it('migrates a v1 session on read and writes the current schema back', async () => {
    await putRawRecord('sessions', makeV1Session('legacy-session'));

    const session = await getSession('legacy-session');

    expect(session?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(session?.navigations).toEqual([
      {
        id: 'legacy-navigation',
        sessionId: 'legacy-session',
        url: 'https://example.com/legacy?token=secret',
        kind: 'document',
        startedAt: 1_700_000_000_000,
      },
    ]);
    expect(session?.browser).toEqual({ name: 'Chrome' });
    expect(session?.experimentIds).toEqual([]);

    // The migration is persisted, not just normalised for this call.
    const raw = await getRawRecord('sessions', 'legacy-session') as { schemaVersion?: number };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migrates v1 sessions in list and summary reads', async () => {
    await putRawRecord('sessions', makeV1Session('legacy-session'));

    const sessions = await getAllSessions();
    const summaries = await getSessionSummaries();

    expect(sessions.map((session) => session.id)).toEqual(['legacy-session']);
    expect(sessions[0]?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(summaries.map((summary) => summary.id)).toEqual(['legacy-session']);
  });

  it('applies retention to a migrated v1 session as a normal completed record', async () => {
    await putRawRecord('sessions', {
      ...makeV1Session('legacy-session'),
      status: 'completed',
      endedAt: 1_700_000_001_000,
      // Older than the default 30-day retention window.
      startedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    });

    const deleted = await cleanOldSessions();
    const raw = (await getRawRecord('sessions', 'legacy-session')) as {
      schemaVersion?: number;
    } | undefined;

    // The migrated record is readable now, so retention applies normally and
    // removes it as an expired completed session (it is not "unsupported").
    expect(deleted).toBe(1);
    expect(raw).toBeUndefined();
  });

  it('keeps a recent v1 session and persists the migrated record', async () => {
    await putRawRecord('sessions', {
      ...makeV1Session('recent-legacy'),
      status: 'completed',
      endedAt: Date.now() - 1000,
      startedAt: Date.now() - 60_000,
    });

    const deleted = await cleanOldSessions();
    const raw = (await getRawRecord('sessions', 'recent-legacy')) as {
      schemaVersion?: number;
      navigations?: unknown[];
    } | undefined;

    expect(deleted).toBe(0);
    expect(raw?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw?.navigations).toHaveLength(1);
    expect((await getSession('recent-legacy'))?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migrates a v1 session that is still active without dropping it', async () => {
    await putRawRecord('sessions', {
      ...makeV1Session('legacy-active'),
      status: 'active',
      startedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    });

    const deleted = await cleanOldSessions();
    const session = await getSession('legacy-active');

    expect(deleted).toBe(0);
    expect(session?.status).toBe('active');
    expect(session?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migrates a v1 experiment with missing lifecycle fields and finds it by session', async () => {
    const v1Experiment: Record<string, unknown> = {
      id: 'legacy-experiment',
      schemaVersion: 1,
      baselineSessionId: 'baseline',
      tabId: 1,
      url: 'https://example.com/',
      createdAt: 1000,
      startedAt: 1200,
      status: 'running',
      preset: 'custom',
      baselineValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: 1200, TTFB: 200 },
      experimentValues: { LCP: 2500 },
      rules: [{ id: 10_000, domains: ['cdn.example.net'] }],
    };
    await putRawRecord('experiments', v1Experiment);

    const experiment = await getExperiment('legacy-experiment');

    expect(experiment?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(experiment?.domains).toEqual([]);
    expect(experiment?.limitations).toEqual([]);
    expect(experiment?.comparison).toEqual([]);
    expect(experiment?.experimentValues).toEqual({
      LCP: 2500,
      CLS: null,
      INP: null,
      FCP: null,
      TTFB: null,
    });
    // A v1 running record still owns rules that must be cleaned up.
    expect(experiment?.cleanupStatus).toBe('pending');
    expect((await getExperimentsForSession('baseline')).map((item) => item.id)).toEqual([
      'legacy-experiment',
    ]);

    const raw = await getRawRecord('experiments', 'legacy-experiment') as {
      schemaVersion?: number;
    };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('does not overwrite a newer current-schema session with a migrated snapshot', async () => {
    await putRawRecord('sessions', {
      ...makeV1Session('race-session'),
      status: 'active',
    });

    await Promise.all([
      getSession('race-session'),
      saveSession({ ...makeSession('race-session', 1_700_000_000_000), status: 'interrupted' }),
    ]);

    const raw = (await getRawRecord('sessions', 'race-session')) as {
      schemaVersion?: number;
      status?: string;
    };
    // Whichever operation lands second must respect the current-schema write;
    // the conditional write-back can never resurrect `active`.
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.status).toBe('interrupted');
  });

  it('does not overwrite a newer current-schema experiment with a migrated snapshot', async () => {
    await putRawRecord('experiments', {
      id: 'race-experiment',
      schemaVersion: 1,
      baselineSessionId: 'baseline',
      tabId: 1,
      url: 'https://example.com/',
      createdAt: 1000,
      startedAt: 1100,
      status: 'running',
      preset: 'custom',
      baselineValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: 1200, TTFB: 200 },
      experimentValues: { LCP: 2500 },
      rules: [],
    });

    await Promise.all([
      getAllExperiments(),
      saveExperiment({
        ...makeExperiment('race-experiment', 'baseline', 'completed'),
        cleanupStatus: 'completed',
        cleanupVerified: true,
      }),
    ]);

    const raw = (await getRawRecord('experiments', 'race-experiment')) as {
      schemaVersion?: number;
      status?: string;
      cleanupStatus?: string;
    };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.status).toBe('completed');
    expect(raw.cleanupStatus).toBe('completed');
  });
});
