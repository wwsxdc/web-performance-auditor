import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditSession } from '../types/session';
import { SCHEMA_VERSION, STORAGE_LIMITS } from '../constants/config';
import { buildImportBundle } from '../utils/report-import';
import { makeImportReport } from '../test/report-fixture';
import {
  DuplicateImportError,
  ImportLimitError,
  clearAllData,
  countEvents,
  countMetrics,
  deleteSession,
  findImportedSession,
  getAllSessions,
  getExperiment,
  getSession,
  getSessionSummaries,
  importSessionBundle,
  saveSession,
} from './storage';

function makeSession(id: string, startedAt: number): AuditSession {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    tabId: 1,
    url: 'https://example.com/',
    startedAt,
    status: 'completed',
    browser: { name: 'Chrome', version: '155' },
    navigations: [],
    metrics: [],
    events: [],
    experimentIds: [],
  };
}

beforeEach(async () => {
  await clearAllData();
});

afterEach(async () => {
  await clearAllData();
});

describe('importSessionBundle', () => {
  it('writes session, metrics, events and experiments in one transaction', async () => {
    const report = makeImportReport();
    const bundle = buildImportBundle(report);

    await importSessionBundle(bundle);

    const session = await getSession(bundle.session.id);
    expect(session?.origin).toBe('imported');
    expect(session?.importedFrom?.sessionId).toBe('session-1');
    expect(session?.metrics).toHaveLength(1);
    expect(session?.events).toHaveLength(1);
    expect(session?.events[0].relatedMetricIds).toEqual([session?.metrics[0].id]);
    expect(await getExperiment(bundle.experiments[0].id)).toMatchObject({
      baselineSessionId: bundle.session.id,
      status: 'incomplete',
      cleanupStatus: 'completed',
    });
    expect(await countMetrics(bundle.session.id)).toBe(1);
    expect(await countEvents(bundle.session.id)).toBe(1);
  });

  it('rejects the same exported report twice', async () => {
    const report = makeImportReport();
    await importSessionBundle(buildImportBundle(report));

    await expect(importSessionBundle(buildImportBundle(report))).rejects.toBeInstanceOf(
      DuplicateImportError,
    );
    expect(await getAllSessions()).toHaveLength(1);
  });

  it('rejects an import when the history is already full', async () => {
    for (let index = 0; index < STORAGE_LIMITS.maxSessions; index++) {
      await saveSession(makeSession(`session-${index}`, 1000 + index));
    }

    await expect(importSessionBundle(buildImportBundle(makeImportReport()))).rejects.toBeInstanceOf(
      ImportLimitError,
    );
    expect(await getAllSessions()).toHaveLength(STORAGE_LIMITS.maxSessions);
  });

  it('cascades deletion through imported metrics, events and experiments', async () => {
    const bundle = buildImportBundle(makeImportReport());
    await importSessionBundle(bundle);

    await deleteSession(bundle.session.id);

    expect(await getSession(bundle.session.id)).toBeUndefined();
    expect(await countMetrics(bundle.session.id)).toBe(0);
    expect(await countEvents(bundle.session.id)).toBe(0);
    expect(await getExperiment(bundle.experiments[0].id)).toBeUndefined();
  });
});

describe('history helpers', () => {
  it('finds an already imported source report', async () => {
    const report = makeImportReport();
    const bundle = buildImportBundle(report);
    await importSessionBundle(bundle);

    expect(await findImportedSession('session-1', report.generatedAt)).toBeDefined();
    expect(await findImportedSession('session-1', 'other-date')).toBeUndefined();
  });

  it('returns summaries sorted by newest start with counts and import badge', async () => {
    const old = makeSession('old', 1000);
    await saveSession(old);
    const bundle = buildImportBundle(makeImportReport());
    await importSessionBundle(bundle);

    const summaries = await getSessionSummaries();
    expect(summaries.map((summary) => summary.id)).toEqual([bundle.session.id, 'old']);
    expect(summaries[0]).toMatchObject({
      origin: 'imported',
      metricCount: 1,
      eventCount: 1,
      experimentCount: 1,
    });
    expect(summaries[1].origin).toBeUndefined();
  });

  it('honours the summary limit', async () => {
    for (let index = 0; index < 5; index++) {
      await saveSession(makeSession(`session-${index}`, 1000 + index));
    }
    expect(await getSessionSummaries(2)).toHaveLength(2);
  });
});
