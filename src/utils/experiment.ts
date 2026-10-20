import type { MetricName, MetricRecord } from '../types/metrics';
import type { Experiment, ExperimentComparisonRow, MetricValues } from '../types/experiment';
import { selectMetricForDisplay } from './select-metric';
import { sanitizeUrl } from './url';

export const COMPARABLE_METRICS: MetricName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];
export const CORE_METRICS: MetricName[] = ['LCP', 'INP', 'CLS'];

export function emptyMetricValues(): MetricValues {
  return {
    LCP: null,
    CLS: null,
    INP: null,
    FCP: null,
    TTFB: null,
  };
}

export function summarizeMetrics(metrics: MetricRecord[]): MetricValues {
  const values = emptyMetricValues();
  for (const name of COMPARABLE_METRICS) {
    values[name] = selectMetricForDisplay(metrics, name)?.value ?? null;
  }
  return values;
}

export function compareMetricValues(
  baseline: MetricValues,
  experiment: MetricValues,
): ExperimentComparisonRow[] {
  return COMPARABLE_METRICS.map((name) => {
    const baselineValue = baseline[name];
    const experimentValue = experiment[name];
    const comparable = baselineValue !== null && experimentValue !== null;
    const absolute = comparable ? experimentValue - baselineValue : null;
    const relativePercent =
      comparable && baselineValue !== 0
        ? ((experimentValue - baselineValue) / baselineValue) * 100
        : null;

    return {
      name,
      baseline: baselineValue,
      experiment: experimentValue,
      absolute,
      relativePercent,
    };
  });
}

export function hasCoreResult(values: MetricValues): boolean {
  return CORE_METRICS.some((name) => values[name] !== null);
}

export interface ExperimentRunAggregate {
  name: MetricName;
  runs: number;
  median: number;
  min: number;
  max: number;
}

export function sameExperimentSetup(left: Experiment, right: Experiment): boolean {
  const leftDomains = [...left.domains].sort().join(',');
  const rightDomains = [...right.domains].sort().join(',');
  return (
    left.preset === right.preset &&
    leftDomains === rightDomains &&
    sanitizeUrl(left.url) === sanitizeUrl(right.url)
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Median and observed range of absolute effects across repeated runs (FR-23). */
export function aggregateExperimentRuns(
  experiments: Experiment[],
): ExperimentRunAggregate[] {
  const completed = experiments.filter((experiment) => experiment.status === 'completed');
  if (completed.length < 2) return [];

  return COMPARABLE_METRICS.flatMap((name) => {
    const values = completed
      .map((experiment) => experiment.comparison.find((row) => row.name === name)?.absolute)
      .filter((value): value is number => typeof value === 'number');
    if (values.length < 2) return [];
    return [{
      name,
      runs: values.length,
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
    }];
  });
}

export function normalizeDomains(domains: string[]): string[] {
  const normalized = new Set<string>();

  for (const raw of domains) {
    const domain = raw
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '');

    if (!domain || domain.includes(' ') || /[^a-z0-9.-]/.test(domain)) continue;
    if (!domain.includes('.')) continue;
    normalized.add(domain);
  }

  return [...normalized];
}
