import { describe, expect, it } from 'vitest';
import type { MetricRecord } from '../types/metrics';
import { firstTargetForMetric, targetsForMetric } from './metric-targets';

function metric(overrides: Partial<MetricRecord> = {}): MetricRecord {
  return {
    id: 'metric-1',
    sessionId: 'session-1',
    navigationId: 'nav-1',
    name: 'CLS',
    value: 0.2,
    unit: 'score',
    status: 'measured',
    rating: 'needs-improvement',
    observedAt: 1,
    source: 'web-vitals',
    attribution: {
      source: 'web-vitals',
      target: {
        targetId: 'target-1',
        selector: '.hero',
        tagName: 'div',
        capturedAt: 1,
        available: true,
      },
      cls: {
        sources: [
          { targetId: 'target-1', selector: '.hero', capturedAt: 1, available: true },
          { targetId: 'target-2', selector: '.banner', capturedAt: 1, available: true },
        ],
      },
    },
    ...overrides,
  };
}

describe('targetsForMetric', () => {
  it('returns all CLS sources with category colors', () => {
    const targets = targetsForMetric(metric());
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ metricName: 'CLS', color: 'red' });
    expect(firstTargetForMetric(metric())?.target.selector).toBe('.hero');
  });

  it('ignores non-overlay metrics and targets without selectors', () => {
    expect(targetsForMetric(metric({ name: 'FCP' }))).toEqual([]);
    expect(
      firstTargetForMetric(
        metric({
          attribution: {
            source: 'derived',
            target: { targetId: 'target-1', capturedAt: 1, available: true },
          },
        }),
      ),
    ).toBeUndefined();
  });
});
