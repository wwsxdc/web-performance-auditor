import type { P75Aggregate, P75MetricSummary } from '../types/aggregate';
import type { MetricName, MetricRecord } from '../types/metrics';
import type { SessionStatus } from '../types/session';

/** Display/aggregation order: Core Web Vitals first. */
export const P75_METRIC_ORDER: readonly MetricName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

export const EXCLUDED_SESSION_STATUSES: readonly SessionStatus[] = [
  'active',
  'unsupported',
  'error',
];

export interface AggregatableSession {
  id: string;
  status: SessionStatus;
  metrics: readonly MetricRecord[];
}

/**
 * Nearest-rank percentile. For four samples the 75th percentile is the third
 * smallest, matching how field data p75 is usually read (not an interpolated
 * synthetic value). Returns null for an empty sample set.
 */
export function percentile(values: readonly number[], rank: number): number | null {
  if (values.length === 0 || !Number.isFinite(rank) || rank <= 0 || rank > 100) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((rank / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function latestMeasuredValue(metric: MetricRecord): boolean {
  return (
    metric.status === 'measured' &&
    typeof metric.value === 'number' &&
    Number.isFinite(metric.value) &&
    metric.value >= 0
  );
}

/**
 * Aggregates one value per metric per session. Sessions without any measured
 * value still count in `sessions` but not in `sampledSessions`.
 */
export function aggregateP75(
  sessions: readonly AggregatableSession[],
  now = Date.now(),
): P75Aggregate {
  const samples = new Map<MetricName, number[]>();
  // Storage never returns duplicate ids, but a caller may pass the same session
  // twice. Merge their metrics so the newest observedAt still wins and the
  // session is counted once.
  const byId = new Map<string, { status: SessionStatus; metrics: MetricRecord[] }>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    if (existing) {
      existing.metrics.push(...session.metrics);
    } else {
      byId.set(session.id, { status: session.status, metrics: [...session.metrics] });
    }
  }

  let considered = 0;
  let sampledSessions = 0;

  for (const { status, metrics } of byId.values()) {
    if (EXCLUDED_SESSION_STATUSES.includes(status)) continue;
    considered++;

    const latest = new Map<MetricName, MetricRecord>();
    for (const metric of metrics) {
      if (!latestMeasuredValue(metric)) continue;
      const previous = latest.get(metric.name);
      if (!previous || metric.observedAt >= previous.observedAt) {
        latest.set(metric.name, metric);
      }
    }
    if (latest.size === 0) continue;
    sampledSessions++;

    for (const [name, metric] of latest) {
      const values = samples.get(name) ?? [];
      values.push(metric.value as number);
      samples.set(name, values);
    }
  }

  const metrics: P75MetricSummary[] = P75_METRIC_ORDER.map((name) => {
    const values = samples.get(name) ?? [];
    return {
      name,
      p75: percentile(values, 75),
      samples: values.length,
    };
  });

  return {
    sessions: considered,
    sampledSessions,
    generatedAt: now,
    metrics,
  };
}
