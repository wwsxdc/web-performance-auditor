import type { MetricName } from './metrics';

/** One metric row in the cross-session p75 aggregate. */
export interface P75MetricSummary {
  name: MetricName;
  /** 75th percentile of one value per finished session, or null. */
  p75: number | null;
  /** Number of sessions that contributed a measured value. */
  samples: number;
}

/**
 * p75 across stored sessions. Each session contributes at most one value per
 * metric (its latest measured update), so repeated `web-vitals` callbacks do
 * not count as independent page loads.
 */
export interface P75Aggregate {
  /** Non-active sessions that are not `unsupported`/`error`. */
  sessions: number;
  /** Sessions that had at least one measured metric. */
  sampledSessions: number;
  generatedAt: number;
  metrics: P75MetricSummary[];
}
