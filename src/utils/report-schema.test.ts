import { describe, expect, it } from 'vitest';
import type { JsonReport } from '../types/report';
import { validateJsonReport } from './report-schema';

function makeReport(): JsonReport {
  return {
    reportVersion: 1,
    schemaVersion: 2,
    generatedAt: '2026-10-20T00:00:00.000Z',
    tool: { name: 'Web Performance Auditor', version: '0.1.0' },
    session: {
      id: 'session-1',
      tabId: 1,
      url: 'https://example.com/',
      startedAt: 1000,
      status: 'active',
      browser: { name: 'Chrome', version: '155' },
      navigations: [],
    },
    metrics: [],
    attribution: [],
    events: [],
    experiments: [],
    limitations: [],
    completeness: { level: 'full', reasons: [], observedSince: 1000 },
  };
}

describe('validateJsonReport', () => {
  it('accepts a complete report', () => {
    expect(validateJsonReport(makeReport())).toEqual({ valid: true, errors: [] });
  });

  it('rejects a report without top-level attribution', () => {
    const report = makeReport() as Partial<JsonReport>;
    delete report.attribution;
    const result = validateJsonReport(report);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('attribution');
  });

  it('rejects a report without a completeness section', () => {
    const report = makeReport() as Partial<JsonReport>;
    delete report.completeness;
    const result = validateJsonReport(report);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('completeness');
  });

  it('rejects an unknown completeness level', () => {
    const report = makeReport();
    (report.completeness as { level: string }).level = 'unknown';

    const result = validateJsonReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('completeness.level');
  });

  it('rejects null metric values converted to zero and malformed metrics', () => {
    const report = makeReport();
    report.metrics.push({
      id: 'metric-1',
      sessionId: 'session-1',
      navigationId: 'nav-1',
      name: 'FCP',
      value: Number.NaN,
      unit: 'ms',
      status: 'unsupported',
      rating: 'unrated',
      observedAt: 1000,
      source: 'web-vitals',
    });

    const result = validateJsonReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('metrics[0].value');
  });

  it('rejects an experiment without a cleanup status', () => {
    const report = makeReport();
    report.experiments.push({
      id: 'experiment-1',
      schemaVersion: 2,
      baselineSessionId: 'session-1',
      tabId: 1,
      url: 'https://example.com/',
      createdAt: 1000,
      startedAt: 1000,
      status: 'completed',
      preset: 'custom',
      domains: ['cdn.example.net'],
      rules: [],
      baselineValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: 1200, TTFB: 200 },
      experimentValues: { LCP: null, CLS: null, INP: null, FCP: null, TTFB: null },
      comparison: [],
      limitations: [],
    } as never);

    const result = validateJsonReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('cleanupStatus');
  });

  it('rejects a cyclic report instead of recursing forever', () => {
    const report = makeReport() as JsonReport & { self?: unknown };
    report.self = report;

    const result = validateJsonReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('циклическую');
  });

  it('rejects live/non-serializable attribution values', () => {
    const report = makeReport();
    report.attribution.push({
      metricId: 'metric-1',
      metricName: 'LCP',
      observedAt: 1000,
      attribution: { fn: () => undefined } as never,
    });

    const result = validateJsonReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('несериализуемое');
  });
});
