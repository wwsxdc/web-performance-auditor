import type { MetricName, MetricRating } from '../types/metrics';
import { METRIC_THRESHOLDS } from '../constants/thresholds';

export function calculateRating(name: MetricName, value: number | null): MetricRating {
  if (value === null) return 'unrated';

  const config = METRIC_THRESHOLDS[name];
  if (!config) return 'unrated';

  if (value <= config.good) return 'good';
  if (value <= config.poor) return 'needs-improvement';
  return 'poor';
}
