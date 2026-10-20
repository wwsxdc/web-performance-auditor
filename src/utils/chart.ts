import type { MetricName, MetricRecord } from '../types/metrics';
import type { NavigationRecord } from '../types/session';

export interface SessionChartPoint {
  observedAt: number;
  elapsed: number;
  LCP: number | null;
  CLS: number | null;
  INP: number | null;
  FCP: number | null;
  TTFB: number | null;
}

const CHART_NAMES: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

function emptyValues(): Record<MetricName, number | null> {
  return {
    LCP: null,
    CLS: null,
    INP: null,
    FCP: null,
    TTFB: null,
  };
}

function documentSegment(navigationId: string | undefined, navigations: NavigationRecord[]): string | undefined {
  if (!navigationId || navigations.length === 0) return undefined;

  let activeDocumentId: string | undefined;
  for (const navigation of navigations) {
    if (navigation.kind === 'document') activeDocumentId = navigation.id;
    if (navigation.id === navigationId) return activeDocumentId;
  }

  return activeDocumentId;
}

export function buildSessionChartData(
  metrics: MetricRecord[],
  startedAt: number,
  navigations: NavigationRecord[] = [],
): SessionChartPoint[] {
  const current = emptyValues();
  const points: SessionChartPoint[] = [];
  let currentSegment: string | undefined;

  const sorted = [...metrics]
    .filter((metric) => metric.value !== null && Number.isFinite(metric.value))
    .sort((left, right) => left.observedAt - right.observedAt);

  for (const metric of sorted) {
    const value = metric.value;
    if (value === null) continue;

    const segment = documentSegment(metric.navigationId, navigations);
    if (segment !== undefined && currentSegment !== undefined && segment !== currentSegment) {
      // A document boundary resets cumulative metrics and inserts a gap so
      // Recharts does not draw a continuous line across incompatible documents.
      Object.assign(current, emptyValues());
      points.push({
        observedAt: metric.observedAt,
        elapsed: Math.max(0, (metric.observedAt - startedAt) / 1000),
        ...emptyValues(),
      });
    }
    currentSegment = segment ?? currentSegment;

    if (metric.name === 'CLS') {
      // CLS is cumulative: reportAllChanges may deliver partial values, so the
      // chart must show the largest cumulative score seen so far.
      current.CLS = Math.max(current.CLS ?? 0, value);
    } else if (metric.name === 'LCP' || metric.name === 'INP') {
      // LCP and INP only grow during a document and must not dip on updates.
      current[metric.name] = Math.max(current[metric.name] ?? 0, value);
    } else {
      current[metric.name] = value;
    }

    points.push({
      observedAt: metric.observedAt,
      elapsed: Math.max(0, (metric.observedAt - startedAt) / 1000),
      ...current,
    });
  }

  return points;
}

export function hasChartData(points: SessionChartPoint[]): boolean {
  return points.some((point) => CHART_NAMES.some((name) => point[name] !== null));
}
