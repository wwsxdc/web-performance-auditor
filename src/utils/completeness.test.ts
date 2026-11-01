import { describe, expect, it } from 'vitest';
import type { DiagnosticEvent } from '../types/events';
import type { MetricName, MetricRecord } from '../types/metrics';
import { calculateCompleteness } from './completeness';

const NAMES: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

function metric(
  name: MetricName,
  overrides: Partial<MetricRecord> = {},
): MetricRecord {
  return {
    id: `metric-${name}`,
    sessionId: 'session',
    navigationId: 'navigation',
    name,
    value: 100,
    unit: 'ms',
    status: 'measured',
    rating: 'good',
    observedAt: 1000,
    source: 'web-vitals',
    ...overrides,
  };
}

function measuredAll(): MetricRecord[] {
  return NAMES.map((name) => metric(name));
}

function limitation(message: string): DiagnosticEvent {
  return {
    id: `event-${message}`,
    sessionId: 'session',
    navigationId: 'navigation',
    type: 'collector-limitation',
    timestamp: 1000,
    details: { message },
  };
}

describe('calculateCompleteness', () => {
  it('reports a full session when every metric is measured', () => {
    expect(calculateCompleteness(measuredAll(), [])).toEqual({ level: 'full', reasons: [] });
  });

  it('reports a partial session while a metric is still pending', () => {
    const metrics = NAMES.map((name) =>
      name === 'INP' ? metric(name, { value: null, status: 'pending' }) : metric(name),
    );

    const result = calculateCompleteness(metrics, []);
    expect(result.level).toBe('partial');
    expect(result.reasons).toContain('INP: ожидает измерения');
  });

  it('reports a partial session for metrics that were never observed', () => {
    const result = calculateCompleteness([metric('LCP')], []);

    expect(result.level).toBe('partial');
    expect(result.reasons).toContain('CLS: метрика не была измерена');
  });

  it('reports a limited session when the API is unsupported', () => {
    const metrics = NAMES.map((name) =>
      name === 'INP' ? metric(name, { value: null, status: 'unsupported' }) : metric(name),
    );

    const result = calculateCompleteness(metrics, []);
    expect(result.level).toBe('limited');
    expect(result.reasons).toContain('INP: не поддерживается данным браузером');
  });

  it('reports a limited session for collector limitation events', () => {
    const result = calculateCompleteness(
      measuredAll(),
      [limitation('LayoutShift: исторические записи недоступны')],
    );

    expect(result.level).toBe('limited');
    expect(result.reasons).toContain('LayoutShift: исторические записи недоступны');
  });

  it('does not repeat the same reason', () => {
    const message = 'LongTask: исторические записи недоступны';
    const result = calculateCompleteness(measuredAll(), [limitation(message), limitation(message)]);

    expect(result.reasons.filter((reason) => reason === message)).toHaveLength(1);
  });
});
