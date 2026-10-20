import { describe, expect, it } from 'vitest';
import { selectMetricForDisplay } from './select-metric';
import type { MetricRecord } from '../types/metrics';

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
    status: 'measured',
    rating: 'good',
    observedAt,
    source: 'web-vitals',
  };
}

describe('selectMetricForDisplay', () => {
  it('keeps the worst LCP, INP and CLS value regardless of arrival order', () => {
    const metrics = [
      metric('INP', 304, 3000),
      metric('INP', 8, 3500),
      metric('LCP', 1200, 1000),
      metric('LCP', 900, 1100),
      metric('CLS', 0.08, 1200),
      metric('CLS', 0.03, 1300),
    ];

    expect(selectMetricForDisplay(metrics, 'INP')?.value).toBe(304);
    expect(selectMetricForDisplay(metrics, 'LCP')?.value).toBe(1200);
    expect(selectMetricForDisplay(metrics, 'CLS')?.value).toBe(0.08);
  });

  it('uses the latest value for document-load metrics and skips unavailable values', () => {
    const metrics = [
      metric('FCP', 900, 1000),
      metric('FCP', 700, 2000),
      metric('TTFB', null, 1500),
      metric('TTFB', 40, 1600),
    ];

    expect(selectMetricForDisplay(metrics, 'FCP')?.value).toBe(700);
    expect(selectMetricForDisplay(metrics, 'TTFB')?.value).toBe(40);
    expect(selectMetricForDisplay(metrics, 'LCP')).toBeUndefined();
  });
});
