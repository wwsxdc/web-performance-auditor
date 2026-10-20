import type { DomTargetSnapshot, MetricName, MetricRecord } from '../types/metrics';
import { formatMetricValue } from './time';

export type OverlayCategory = 'LCP' | 'CLS' | 'INP';
export type OverlayColor = 'green' | 'red' | 'yellow';

export const OVERLAY_CATEGORIES: readonly OverlayCategory[] = ['LCP', 'CLS', 'INP'];

export const OVERLAY_COLOR: Record<OverlayCategory, OverlayColor> = {
  LCP: 'green',
  CLS: 'red',
  INP: 'yellow',
};

export interface HighlightTargetSpec {
  target: DomTargetSnapshot;
  color: OverlayColor;
  label: string;
  metricName: OverlayCategory;
}

export function isOverlayCategory(name: MetricName): name is OverlayCategory {
  return name === 'LCP' || name === 'CLS' || name === 'INP';
}

export function targetsForMetric(
  metric: MetricRecord | undefined,
): HighlightTargetSpec[] {
  if (!metric || !isOverlayCategory(metric.name)) return [];

  const metricName = metric.name;
  const attribution = metric.attribution;
  const clsSources = attribution?.cls?.sources ?? [];
  const targets = clsSources.length > 0
    ? clsSources
    : attribution?.target
      ? [attribution.target]
      : [];

  return targets
    .filter((target) => Boolean(target.selector))
    .map((target) => ({
      target,
      color: OVERLAY_COLOR[metricName],
      label: `${metricName} · ${formatMetricValue(metric.value, metric.unit)}`,
      metricName,
    }));
}

export function firstTargetForMetric(
  metric: MetricRecord | undefined,
): HighlightTargetSpec | undefined {
  return targetsForMetric(metric)[0];
}
