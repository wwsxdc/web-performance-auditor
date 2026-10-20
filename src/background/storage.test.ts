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
});
