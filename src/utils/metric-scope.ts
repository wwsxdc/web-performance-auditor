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
  const documentIndex = session.navigations.findIndex(
    (navigation) => navigation.id === documentNavigationId,
  );
  const lastNavigation = session.navigations[session.navigations.length - 1];
  const effectiveActiveId = activeNavigationId ?? lastNavigation?.id ?? null;
  const activeIndex = session.navigations.findIndex(
    (navigation) => navigation.id === effectiveActiveId,
  );
  const activeNavigation = activeIndex >= 0 ? session.navigations[activeIndex] : undefined;
  const isSpaActive = activeNavigation?.kind === 'spa';
  const lineageStart = documentIndex >= 0 ? documentIndex : 0;
  const indexById = new Map(
    session.navigations.map((navigation, index) => [navigation.id, index]),
  );

  const fallbackByName = new Map<string, MetricRecord>();
  if (isSpaActive) {
    const activeNames = new Set(
      session.metrics
        .filter((metric) => metric.navigationId === effectiveActiveId)
        .map((metric) => metric.name),
    );
    for (const metric of session.metrics) {
      if (LOAD_METRICS.includes(metric.name)) continue;
      if (metric.name !== 'CLS' && metric.name !== 'INP') continue;
      if (activeNames.has(metric.name)) continue;
      const index = indexById.get(metric.navigationId);
      if (index === undefined || index < lineageStart || index >= activeIndex) continue;
      const current = fallbackByName.get(metric.name);
      if (!current || metric.observedAt >= current.observedAt) {
        fallbackByName.set(metric.name, metric);
      }
    }
  }

  return session.metrics.filter((metric) => {
    if (LOAD_METRICS.includes(metric.name)) {
      return documentNavigationId === undefined || metric.navigationId === documentNavigationId;
    }
    if (metric.navigationId === effectiveActiveId) return true;
    // CLS/INP are cumulative. web-vitals does not re-emit a previous value just
    // because a SPA route changed, so keep the latest value from this document
    // lineage until the new segment produces its own update.
    return (
      isSpaActive &&
      fallbackByName.get(metric.name)?.id === metric.id
    );
  });
}
