import { describe, expect, it } from 'vitest';
import { buildSessionChartData, hasChartData } from './chart';
import type { MetricRecord } from '../types/metrics';
import type { NavigationRecord } from '../types/session';

const sessionId = 'session-1';
const navigationId = 'navigation-1';

function metric(
  name: MetricRecord['name'],
  value: number | null,
  observedAt: number,
): MetricRecord {
  return {
    id: `${name}-${observedAt}`,
    sessionId,
    navigationId,
    name,
    value,
    unit: name === 'CLS' ? 'score' : 'ms',
    status: 'measured',
    rating: 'good',
    observedAt,
    source: 'web-vitals',
  };
}

describe('buildSessionChartData', () => {
  it('keeps cumulative metrics monotonic and converts timestamps to elapsed seconds', () => {
    const points = buildSessionChartData(
      [
        metric('LCP', 1000, 2000),
        metric('CLS', 0.04, 2500),
        metric('INP', 120, 3000),
        metric('LCP', 1800, 3500),
        metric('CLS', 0.09, 4000),
        metric('INP', 90, 4500),
      ],
      1000,
    );

    expect(points.map((point) => point.elapsed)).toEqual([1, 1.5, 2, 2.5, 3, 3.5]);
    expect(points.map((point) => point.LCP)).toEqual([1000, 1000, 1000, 1800, 1800, 1800]);
    expect(points.map((point) => point.CLS)).toEqual([null, 0.04, 0.04, 0.04, 0.09, 0.09]);
    expect(points.map((point) => point.INP)).toEqual([null, null, 120, 120, 120, 120]);
  });

  it('inserts a gap and resets cumulative values across document navigations', () => {
    const navigations: NavigationRecord[] = [
      {
        id: 'doc-a',
        sessionId,
        url: 'https://example.com/a',
        kind: 'document',
        startedAt: 1000,
      },
      {
        id: 'spa-a',
        sessionId,
        url: 'https://example.com/a/settings',
        kind: 'spa',
        startedAt: 2500,
      },
      {
        id: 'doc-b',
        sessionId,
        url: 'https://example.com/b',
        kind: 'document',
        startedAt: 4000,
      },
    ];

    const first = { ...metric('LCP', 3000, 2000), navigationId: 'doc-a' };
    const spa = { ...metric('INP', 300, 3000), navigationId: 'spa-a' };
    const second = { ...metric('LCP', 1200, 5000), navigationId: 'doc-b' };
    const points = buildSessionChartData([first, spa, second], 1000, navigations);

    expect(points.map((point) => point.LCP)).toEqual([3000, 3000, null, 1200]);
    expect(points.map((point) => point.INP)).toEqual([null, 300, null, null]);
  });

  it('ignores unavailable metrics and handles an empty session', () => {
    const points = buildSessionChartData(
      [metric('FCP', null, 1000), metric('TTFB', 40, 1200), metric('FCP', 800, 1400)],
      1000,
    );

    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ FCP: 800, TTFB: 40 });
    expect(hasChartData(points)).toBe(true);
    expect(hasChartData(buildSessionChartData([], 1000))).toBe(false);
  });
});
