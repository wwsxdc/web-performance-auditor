import { describe, expect, it } from 'vitest';
import type { MetricName } from '../types/metrics';
import { aggregateP75, percentile } from './p75';
import type { AggregatableSession } from './p75';

function metric(
  name: MetricName,
  value: number | null,
  observedAt: number,
  status: 'measured' | 'pending' | 'unavailable' = 'measured',
) {
  return {
    id: `${name}-${observedAt}`,
    sessionId: 'session',
    navigationId: 'navigation',
    name,
    value,
    unit: name === 'CLS' ? ('score' as const) : ('ms' as const),
    status,
    rating: 'good' as const,
    observedAt,
    source: 'web-vitals' as const,
  };
}

function session(
  id: string,
  status: AggregatableSession['status'],
  metrics: AggregatableSession['metrics'],
): AggregatableSession {
  return { id, status, metrics };
}

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([], 75)).toBeNull();
    expect(percentile([100], 75)).toBe(100);
    expect(percentile([4, 1, 3, 2], 75)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2], 75)).toBe(2);
  });

  it('rejects out-of-range ranks', () => {
    expect(percentile([1, 2, 3], 0)).toBeNull();
    expect(percentile([1, 2, 3], 101)).toBeNull();
    expect(percentile([1, 2, 3], Number.NaN)).toBeNull();
  });
});

describe('aggregateP75', () => {
  it('contributes one latest measured value per session and metric', () => {
    const aggregate = aggregateP75(
      [
        session('a', 'completed', [
          metric('LCP', 1000, 1),
          metric('LCP', 4000, 2),
          metric('CLS', 0.05, 2),
        ]),
        session('b', 'completed', [
          metric('LCP', 2000, 1),
          metric('LCP', 1000, 2),
          metric('CLS', 0.2, 2),
        ]),
        session('c', 'interrupted', [
          metric('LCP', 3000, 1),
          metric('CLS', 0.3, 1),
        ]),
        session('d', 'completed', [
          metric('LCP', 5000, 1),
          metric('CLS', 0.4, 1),
        ]),
      ],
      1234,
    );

    expect(aggregate.sessions).toBe(4);
    expect(aggregate.sampledSessions).toBe(4);
    expect(aggregate.generatedAt).toBe(1234);
    expect(aggregate.metrics.map((entry) => entry.name)).toEqual([
      'LCP',
      'INP',
      'CLS',
      'FCP',
      'TTFB',
    ]);
    // LCP per session: 4000, 1000, 3000, 5000 -> nearest-rank p75 = 4000.
    expect(aggregate.metrics.find((entry) => entry.name === 'LCP')).toEqual({
      name: 'LCP',
      p75: 4000,
      samples: 4,
    });
    // CLS per session: 0.05, 0.2, 0.3, 0.4 -> p75 = 0.3.
    expect(aggregate.metrics.find((entry) => entry.name === 'CLS')).toEqual({
      name: 'CLS',
      p75: 0.3,
      samples: 4,
    });
    expect(aggregate.metrics.find((entry) => entry.name === 'INP')).toEqual({
      name: 'INP',
      p75: null,
      samples: 0,
    });
  });

  it('excludes live, unsupported and error sessions', () => {
    const aggregate = aggregateP75([
      session('active', 'active', [metric('LCP', 9999, 1)]),
      session('unsupported', 'unsupported', [metric('LCP', 9999, 1)]),
      session('error', 'error', [metric('LCP', 9999, 1)]),
      session('done', 'completed', [metric('LCP', 1000, 1)]),
    ]);

    expect(aggregate.sessions).toBe(1);
    expect(aggregate.sampledSessions).toBe(1);
    expect(aggregate.metrics.find((entry) => entry.name === 'LCP')).toMatchObject({
      p75: 1000,
      samples: 1,
    });
  });

  it('ignores unmeasured and negative values and merges duplicate sessions', () => {
    const aggregate = aggregateP75([
      session('a', 'completed', [
        metric('LCP', null, 1),
        metric('LCP', -1, 2),
        metric('LCP', 1500, 3, 'pending'),
        metric('LCP', 1200, 4),
      ]),
      session('a', 'completed', [metric('LCP', 8000, 5)]),
    ]);

    // The duplicate is merged into one session and the newest observedAt wins.
    expect(aggregate.sessions).toBe(1);
    expect(aggregate.metrics.find((entry) => entry.name === 'LCP')).toEqual({
      name: 'LCP',
      p75: 8000,
      samples: 1,
    });
  });

  it('counts sessions without measured metrics but does not sample them', () => {
    const aggregate = aggregateP75([
      session('empty', 'completed', []),
      session('pending', 'completed', [metric('LCP', null, 1)]),
    ]);

    expect(aggregate.sessions).toBe(2);
    expect(aggregate.sampledSessions).toBe(0);
    expect(aggregate.metrics.every((entry) => entry.samples === 0)).toBe(true);
  });
});
