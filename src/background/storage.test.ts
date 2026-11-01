import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditSession } from '../types/session';
import type { Experiment } from '../types/experiment';
import { SCHEMA_VERSION } from '../constants/config';
import {
  cleanOldSessions,
  clearAllData,
  deleteSession,
  getAllExperiments,
  getAllSessions,
  getExperiment,
  getExperimentsForSession,
  getSession,
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

beforeEach(async () => {
  await clearAllData();
});

afterEach(async () => {
  await clearAllData();
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

  it('reclaims unsupported-schema sessions during cleanup even when marked active', async () => {
    const legacySession = {
      ...makeSession('legacy-active', Date.now(), 'active'),
      schemaVersion: SCHEMA_VERSION - 1,
    };
    await putRawRecord('sessions', legacySession);

    const deleted = await cleanOldSessions();

    expect(deleted).toBe(1);
    expect(await getSession('legacy-active')).toBeUndefined();
  });

  it('ignores stored records with an unsupported schema version', async () => {
    const legacySession = { ...makeSession('legacy-session', Date.now()), schemaVersion: SCHEMA_VERSION - 1 };
    const legacyExperiment = {
      ...makeExperiment('legacy-experiment', legacySession.id, 'completed'),
      schemaVersion: SCHEMA_VERSION - 1,
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
