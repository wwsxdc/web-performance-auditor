import { describe, expect, it } from 'vitest';
import {
  aggregateExperimentRuns,
  COMPARABLE_METRICS,
  compareMetricValues,
  emptyMetricValues,
  hasCoreResult,
  normalizeDomains,
  sameExperimentSetup,
  summarizeMetrics,
} from './experiment';
import type { MetricRecord } from '../types/metrics';
import type { Experiment } from '../types/experiment';

function metric(
  name: MetricRecord['name'],
  value: number | null,
  observedAt: number,
): MetricRecord {
  return {
    id: `${name}-${observedAt}`,
    sessionId: 'session-1',
    navigationId: 'navigation-1',
    name,
    value,
    unit: name === 'CLS' ? 'score' : 'ms',
    status: value === null ? 'pending' : 'measured',
    rating: 'good',
    observedAt,
    source: 'web-vitals',
  };
}

describe('normalizeDomains', () => {
  it('normalizes URLs, wildcards and duplicates', () => {
    expect(
      normalizeDomains([
        ' https://Example.com/path ',
        '*.cdn.example.org',
        'example.com',
        'https://example.com:443/',
        'not-a-domain',
        '',
      ]),
    ).toEqual(['example.com', 'cdn.example.org']);
  });
});

function run(
  id: string,
  lcpAbsolute: number,
  overrides: Partial<Experiment> = {},
): Experiment {
  return {
    id,
    schemaVersion: 2,
    baselineSessionId: `baseline-${id}`,
    tabId: 1,
    url: 'https://example.com/page?token=secret',
    createdAt: 1,
    startedAt: 1,
    status: 'completed',
    preset: 'analytics',
    domains: ['example.com'],
    rules: [],
    baselineValues: emptyMetricValues(),
    experimentValues: emptyMetricValues(),
    comparison: COMPARABLE_METRICS.map((name) => ({
      name,
      baseline: null,
      experiment: null,
      absolute: name === 'LCP' ? lcpAbsolute : null,
      relativePercent: null,
    })),
    limitations: [],
    cleanupStatus: 'completed',
    ...overrides,
  };
}

describe('repeated experiment runs', () => {
  it('computes median and observed range across comparable runs', () => {
    const aggregates = aggregateExperimentRuns([run('a', -100), run('b', -300), run('c', -200)]);
    expect(aggregates).toEqual([
      { name: 'LCP', runs: 3, median: -200, min: -300, max: -100 },
    ]);
  });

  it('requires at least two completed comparable runs', () => {
    expect(aggregateExperimentRuns([run('a', -100)])).toEqual([]);
    expect(
      aggregateExperimentRuns([
        run('a', -100),
        run('b', -200, { status: 'failed' }),
      ]),
    ).toEqual([]);
  });

  it('matches setup by preset, canonical URL and normalized domains', () => {
    const base = run('a', -100);
    const same = run('b', -200, {
      url: 'https://example.com/page?other=1',
      domains: ['example.com'],
    });
    expect(sameExperimentSetup(base, same)).toBe(true);
    expect(sameExperimentSetup(base, run('c', -200, { preset: 'custom' }))).toBe(false);
    expect(
      sameExperimentSetup(base, run('d', -200, { domains: ['cdn.example.com', 'example.com'] })),
    ).toBe(false);
    expect(
      sameExperimentSetup(base, run('e', -200, { url: 'https://example.com/other' })),
    ).toBe(false);
  });
});

describe('summarizeMetrics and compareMetricValues', () => {
  it('keeps the worst core value and computes absolute and relative change', () => {
    const baseline = summarizeMetrics([
      metric('LCP', 3000, 1000),
      metric('LCP', 2000, 1100),
      metric('INP', 300, 1200),
      metric('CLS', 0.2, 1300),
    ]);
    const experiment = summarizeMetrics([
      metric('LCP', 1800, 2000),
      metric('INP', 200, 2100),
      metric('CLS', 0.1, 2200),
    ]);

    expect(baseline).toEqual({ LCP: 3000, CLS: 0.2, INP: 300, FCP: null, TTFB: null });
    expect(hasCoreResult(baseline)).toBe(true);
    expect(hasCoreResult(emptyMetricValues())).toBe(false);

    const rows = compareMetricValues(baseline, experiment);
    const lcp = rows.find((row) => row.name === 'LCP');
    expect(lcp).toMatchObject({ baseline: 3000, experiment: 1800, absolute: -1200 });
    expect(lcp?.relativePercent).toBeCloseTo(-40);

    const fcp = rows.find((row) => row.name === 'FCP');
    expect(fcp?.absolute).toBeNull();
    expect(fcp?.relativePercent).toBeNull();
  });
});
