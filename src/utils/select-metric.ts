import type { MetricName, MetricRecord } from '../types/metrics';

const LATEST_ONLY: MetricName[] = ['FCP', 'TTFB'];

/**
 * web-vitals may report a provisional INP/LCP before the final value. The UI
 * must show the worst value, not whichever update happened to arrive last.
 */
export function selectMetricForDisplay(
  metrics: MetricRecord[],
  name: MetricName,
): MetricRecord | undefined {
  const matching = metrics
    .filter((metric) => metric.name === name)
    .sort((left, right) => left.observedAt - right.observedAt);

  if (LATEST_ONLY.includes(name)) {
    return matching[matching.length - 1];
  }

  let selected: MetricRecord | undefined;
  for (const metric of matching) {
    if (metric.value === null) continue;
    if (selected === undefined || (selected.value ?? -Infinity) < metric.value) {
      selected = metric;
    }
  }

  return selected ?? matching[matching.length - 1];
}
