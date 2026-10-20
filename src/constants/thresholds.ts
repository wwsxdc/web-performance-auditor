import type { MetricName } from '../types/metrics';

export interface ThresholdConfig {
  good: number;
  poor: number;
  unit: 'ms' | 'score';
  isCoreWebVital: boolean;
}

export const METRIC_THRESHOLDS: Record<MetricName, ThresholdConfig> = {
  LCP:  { good: 2500, poor: 4000, unit: 'ms',    isCoreWebVital: true },
  INP:  { good: 200,  poor: 500,  unit: 'ms',    isCoreWebVital: true },
  CLS:  { good: 0.1,  poor: 0.25, unit: 'score', isCoreWebVital: true },
  FCP:  { good: 1800, poor: 3000, unit: 'ms',    isCoreWebVital: false },
  TTFB: { good: 800,  poor: 1800, unit: 'ms',    isCoreWebVital: false },
};
