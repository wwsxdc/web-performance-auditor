import type { P75Aggregate } from '../types/aggregate';
import { aggregateP75, EXCLUDED_SESSION_STATUSES, type AggregatableSession } from '../utils/p75';
import { getAllSessions, getSessionMetrics } from './storage';

/**
 * Reads the bounded session history and computes p75 from one measured value
 * per session. Live (`active`) sessions are excluded: their metrics are still
 * arriving and would make the aggregate unstable.
 */
export async function getP75Aggregate(): Promise<P75Aggregate> {
  const sessions = await getAllSessions();
  const inputs: AggregatableSession[] = [];
  for (const session of sessions) {
    if (EXCLUDED_SESSION_STATUSES.includes(session.status)) continue;
    inputs.push({
      id: session.id,
      status: session.status,
      metrics: await getSessionMetrics(session.id),
    });
  }
  return aggregateP75(inputs);
}
