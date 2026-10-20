import type { MetricName, MetricRecord } from '../types/metrics';
import type { AuditSession } from '../types/session';

const LOAD_METRICS: readonly MetricName[] = ['LCP', 'FCP', 'TTFB'];

export function latestDocumentNavigationId(session: AuditSession): string | undefined {
  for (let index = session.navigations.length - 1; index >= 0; index--) {
    const navigation = session.navigations[index];
    if (navigation.kind === 'document') return navigation.id;
  }
  return undefined;
}

/**
 * Load metrics belong to the current document segment; CLS/INP belong to the
 * active SPA segment. Keeping them scoped prevents an old document's worst
 * value from being shown after a navigation (FR-17).
 */
export function metricsForActiveSegment(
  session: AuditSession,
  activeNavigationId: string | null,
): MetricRecord[] {
  const documentNavigationId = latestDocumentNavigationId(session);
  if (activeNavigationId === null) {
    return session.metrics.filter(
      (metric) =>
        !LOAD_METRICS.includes(metric.name) ||
        documentNavigationId === undefined ||
        metric.navigationId === documentNavigationId,
    );
  }

  const activeNames = new Set(
    session.metrics
      .filter(
        (metric) =>
          !LOAD_METRICS.includes(metric.name) &&
          metric.navigationId === activeNavigationId,
      )
      .map((metric) => metric.name),
  );
  const fallbackNames = new Set(
    (['CLS', 'INP'] as const).filter((name) => !activeNames.has(name)),
  );
  const latestByName = new Map<string, MetricRecord>();
  for (const metric of session.metrics) {
    if (LOAD_METRICS.includes(metric.name)) continue;
    const current = latestByName.get(metric.name);
    if (!current || metric.observedAt >= current.observedAt) {
      latestByName.set(metric.name, metric);
    }
  }

  return session.metrics.filter((metric) => {
    if (LOAD_METRICS.includes(metric.name)) {
      return documentNavigationId === undefined || metric.navigationId === documentNavigationId;
    }
    if (metric.navigationId === activeNavigationId) return true;
    // CLS/INP are cumulative. web-vitals does not re-emit a previous value just
    // because a SPA route changed, so keep the latest observed value until the
    // new segment produces its own update.
    return (
      fallbackNames.has(metric.name as 'CLS' | 'INP') &&
      latestByName.get(metric.name)?.id === metric.id
    );
  });
}
