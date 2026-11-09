import type { JsonReport } from '../types/report';
import { SCHEMA_VERSION } from '../constants/config';

/** A complete EXPORT_JSON-shaped report used by import tests. */
export function makeImportReport(): JsonReport {
  return {
    reportVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-10-20T00:00:00.000Z',
    tool: { name: 'Web Performance Auditor', version: '0.2.0' },
    session: {
      id: 'session-1',
      tabId: 7,
      url: 'https://example.com/page?token=secret#hash',
      startedAt: 1000,
      status: 'active',
      browser: { name: 'Chrome', version: '155' },
      navigations: [
        {
          id: 'nav-1',
          sessionId: 'session-1',
          url: 'https://example.com/page?token=secret',
          kind: 'document',
          startedAt: 1000,
        },
      ],
    },
    metrics: [
      {
        id: 'session-1:m1',
        sessionId: 'session-1',
        navigationId: 'nav-1',
        name: 'LCP',
        value: 2100,
        unit: 'ms',
        status: 'measured',
        rating: 'needs-improvement',
        observedAt: 1200,
        source: 'web-vitals',
        attribution: {
          source: 'web-vitals',
          longTaskIds: ['session-1:lt1'],
        },
      },
    ],
    attribution: [],
    events: [
      {
        id: 'session-1:lt1',
        sessionId: 'session-1',
        navigationId: 'nav-1',
        type: 'long-task',
        timestamp: 1100,
        duration: 120,
        relatedMetricIds: ['session-1:m1'],
        details: { containerType: 'iframe' },
      },
    ],
    experiments: [
      {
        id: 'exp-1',
        schemaVersion: SCHEMA_VERSION,
        baselineSessionId: 'session-1',
        tabId: 7,
        url: 'https://example.com/page?token=secret',
        createdAt: 1000,
        startedAt: 1000,
        status: 'running',
        preset: 'custom',
        domains: ['cdn.example.net'],
        rules: [{ id: 10_000, domains: ['cdn.example.net'] }],
        baselineValues: { LCP: 2100, CLS: 0.1, INP: 200, FCP: 900, TTFB: 120 },
        experimentValues: { LCP: null, CLS: null, INP: null, FCP: null, TTFB: null },
        comparison: [],
        limitations: [],
        cleanupStatus: 'pending',
      },
    ],
    limitations: [],
    completeness: { level: 'partial', reasons: [], observedSince: 1000 },
  };
}
