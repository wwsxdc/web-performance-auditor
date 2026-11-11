import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../constants/config';
import {
  inspectStoredExperiment,
  inspectStoredSession,
  migrateStoredExperiment,
  migrateStoredSession,
} from './migrations';

describe('migration classification', () => {
  it('separates readable, future, unsupported and malformed sessions', () => {
    const current = {
      id: 'current',
      schemaVersion: SCHEMA_VERSION,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
      status: 'completed',
    };

    expect(inspectStoredSession(current)).toMatchObject({
      kind: 'current',
      version: SCHEMA_VERSION,
      session: { id: 'current' },
    });
    expect(inspectStoredSession({ ...current, schemaVersion: 1 }).kind).toBe('migrated');

    const future = inspectStoredSession({ ...current, schemaVersion: SCHEMA_VERSION + 1 });
    expect(future).toMatchObject({ kind: 'future', version: SCHEMA_VERSION + 1 });
    expect(future.session).toBeUndefined();

    const unsupported = inspectStoredSession({ ...current, schemaVersion: 0 });
    expect(unsupported).toMatchObject({ kind: 'unsupported', version: 0 });
    expect(unsupported.session).toBeUndefined();

    expect(inspectStoredSession({ ...current, schemaVersion: '2' }).kind).toBe('invalid');
    expect(inspectStoredSession({ schemaVersion: SCHEMA_VERSION }).kind).toBe('invalid');
    expect(inspectStoredSession(null).kind).toBe('invalid');
  });

  it('classifies experiments with the same policy', () => {
    const experiment = {
      id: 'experiment',
      schemaVersion: SCHEMA_VERSION,
      baselineSessionId: 'baseline',
      tabId: 1,
      url: 'https://example.com/',
      createdAt: 1000,
      startedAt: 1100,
      status: 'completed',
      preset: 'custom',
      cleanupStatus: 'completed',
    };

    expect(inspectStoredExperiment(experiment).kind).toBe('current');
    expect(inspectStoredExperiment({ ...experiment, schemaVersion: 1 }).kind).toBe('migrated');
    expect(inspectStoredExperiment({ ...experiment, schemaVersion: SCHEMA_VERSION + 1 }).kind).toBe(
      'future',
    );
    expect(inspectStoredExperiment({ ...experiment, schemaVersion: 0 }).kind).toBe('unsupported');
    expect(
      inspectStoredExperiment({ ...experiment, baselineSessionId: undefined }).kind,
    ).toBe('invalid');
  });
});

describe('migrateStoredSession', () => {
  it('upgrades a v1 header with a single navigation id into the current schema', () => {
    const session = migrateStoredSession({
      id: 'legacy',
      schemaVersion: 1,
      tabId: 4,
      url: 'https://example.com/legacy',
      startedAt: 1000,
      status: 'completed',
      browser: 'Chrome',
      navigationId: 'navigation-1',
      experimentIds: ['experiment-1', 'experiment-1'],
    });

    expect(session).toEqual({
      id: 'legacy',
      schemaVersion: SCHEMA_VERSION,
      tabId: 4,
      url: 'https://example.com/legacy',
      startedAt: 1000,
      status: 'completed',
      browser: { name: 'Chrome' },
      navigations: [{
        id: 'navigation-1',
        sessionId: 'legacy',
        url: 'https://example.com/legacy',
        kind: 'document',
        startedAt: 1000,
      }],
      experimentIds: ['experiment-1'],
    });
  });

  it('treats a v1 record without a status as interrupted when it never ended', () => {
    const session = migrateStoredSession({
      id: 'legacy',
      schemaVersion: 1,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
    });

    expect(session?.status).toBe('interrupted');
    expect(session?.browser).toEqual({ name: 'Unknown' });
  });

  it('repairs a missing navigation list at the current version', () => {
    const session = migrateStoredSession({
      id: 'current',
      schemaVersion: SCHEMA_VERSION,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 2000,
      status: 'active',
      browser: { name: 'Chrome', version: '155' },
    });

    expect(session?.navigations).toEqual([{
      id: 'current-nav-1',
      sessionId: 'current',
      url: 'https://example.com/',
      kind: 'document',
      startedAt: 2000,
    }]);
  });

  it('drops malformed navigation entries but keeps the valid ones', () => {
    const session = migrateStoredSession({
      id: 'current',
      schemaVersion: SCHEMA_VERSION,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 2000,
      status: 'active',
      browser: { name: 'Chrome' },
      navigations: [
        { id: 'nav-1', url: 'https://example.com/a', kind: 'document', startedAt: 1000 },
        { id: 'missing-url', kind: 'spa', startedAt: 1500 },
        { id: 'nav-2', url: 'https://example.com/b', kind: 'spa', startedAt: 2000, source: 'history' },
      ],
    });

    expect(session?.navigations.map((navigation) => navigation.id)).toEqual(['nav-1', 'nav-2']);
    expect(session?.navigations[1]?.source).toBe('history');
  });

  it('rejects unknown/future versions and records without identity', () => {
    expect(migrateStoredSession({ schemaVersion: 1 })).toBeNull();
    expect(migrateStoredSession({
      id: 'future',
      schemaVersion: SCHEMA_VERSION + 1,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
      status: 'active',
    })).toBeNull();
    expect(migrateStoredSession({
      id: 'bad-status',
      schemaVersion: SCHEMA_VERSION,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
      status: 'unknown',
    })).toBeNull();
  });

  it('keeps imported provenance only when it is complete', () => {
    const base = {
      id: 'imported',
      schemaVersion: 1,
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
      status: 'interrupted',
    };

    expect(migrateStoredSession({
      ...base,
      origin: 'imported',
      importedFrom: {
        sessionId: 'source',
        generatedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: '0.2.0',
      },
    })?.importedFrom).toEqual({
      sessionId: 'source',
      generatedAt: '2026-01-01T00:00:00.000Z',
      toolVersion: '0.2.0',
    });

    expect(migrateStoredSession({
      ...base,
      origin: 'imported',
      importedFrom: { sessionId: 'source' },
    })?.importedFrom).toBeUndefined();
  });
});

describe('migrateStoredExperiment', () => {
  const v1 = {
    id: 'legacy-experiment',
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
    rules: [
      { id: 10_000, domains: ['cdn.example.net', 'cdn.example.net'] },
      { id: 'broken', domains: [] },
    ],
  };

  it('fills missing v1 lifecycle/array fields and derives cleanup state', () => {
    const experiment = migrateStoredExperiment(v1);

    expect(experiment?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(experiment?.domains).toEqual([]);
    expect(experiment?.rules).toEqual([
      { id: 10_000, domains: ['cdn.example.net'] },
    ]);
    expect(experiment?.experimentValues).toEqual({
      LCP: 2500,
      CLS: null,
      INP: null,
      FCP: null,
      TTFB: null,
    });
    expect(experiment?.comparison).toEqual([]);
    expect(experiment?.limitations).toEqual([]);
    expect(experiment?.cleanupStatus).toBe('pending');
  });

  it('defaults a finished v1 experiment to completed cleanup', () => {
    const experiment = migrateStoredExperiment({
      ...v1,
      status: 'completed',
      cleanupStatus: 'not-a-value',
    });

    expect(experiment?.cleanupStatus).toBe('completed');
  });

  it('keeps only well-formed comparison rows', () => {
    const experiment = migrateStoredExperiment({
      ...v1,
      comparison: [
        {
          name: 'LCP',
          baseline: 3000,
          experiment: 2500,
          absolute: -500,
          relativePercent: -16.7,
        },
        { name: 'FID', baseline: 100, experiment: 90 },
        { name: 'CLS', baseline: 'bad' },
      ],
    });

    expect(experiment?.comparison).toEqual([
      {
        name: 'LCP',
        baseline: 3000,
        experiment: 2500,
        absolute: -500,
        relativePercent: -16.7,
      },
      {
        name: 'CLS',
        baseline: null,
        experiment: null,
        absolute: null,
        relativePercent: null,
      },
    ]);
  });

  it('rejects unknown versions, missing required fields and invalid status', () => {
    expect(migrateStoredExperiment({ ...v1, schemaVersion: SCHEMA_VERSION + 1 })).toBeNull();
    expect(migrateStoredExperiment({ ...v1, baselineSessionId: undefined })).toBeNull();
    expect(migrateStoredExperiment({
      ...v1,
      schemaVersion: SCHEMA_VERSION,
      status: 'unknown',
    })).toBeNull();
  });
});
