import type { MetricName, MetricRecord } from '../types/metrics';
import type { DiagnosticEvent } from '../types/events';
import type { CompletenessLevel } from '../types/report';

const CORE_METRICS: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

export interface CompletenessSummary {
  level: CompletenessLevel;
  reasons: string[];
}

export const COMPLETENESS_LABELS: Record<CompletenessLevel, string> = {
  full: 'Полная',
  partial: 'Частичная',
  limited: 'Ограниченная',
};

/**
 * Classifies how complete the collected data is (P1.4).
 *
 * - `limited`: the browser cannot measure a metric or the collector reported
 *   a documented limitation.
 * - `partial`: the session simply has not measured everything yet (e.g. INP
 *   waits for an interaction).
 * - `full`: all five Core Web Vitals are measured and no limitation was hit.
 */
export function calculateCompleteness(
  metrics: MetricRecord[],
  events: DiagnosticEvent[],
): CompletenessSummary {
  const reasons: string[] = [];
  let limited = false;

  for (const name of CORE_METRICS) {
    const latest = [...metrics].reverse().find((metric) => metric.name === name);
    if (!latest) {
      reasons.push(`${name}: метрика не была измерена`);
      continue;
    }

    if (latest.status === 'unsupported') {
      limited = true;
      reasons.push(`${name}: не поддерживается данным браузером`);
      continue;
    }

    if (latest.status === 'pending' || latest.value === null) {
      reasons.push(`${name}: ожидает измерения`);
    }
  }

  for (const event of events) {
    if (event.type !== 'collector-limitation') continue;
    const message = event.details?.message;
    if (typeof message !== 'string' || reasons.includes(message)) continue;
    limited = true;
    reasons.push(message);
  }

  if (limited) return { level: 'limited', reasons };
  if (reasons.length > 0) return { level: 'partial', reasons };
  return { level: 'full', reasons };
}
