import type { MetricName } from './metrics';

export type ExperimentPreset = 'analytics' | 'third-party-domain' | 'custom';

export type ExperimentStatus =
  | 'running'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled';

export type MetricValues = Record<MetricName, number | null>;

export type ExperimentCleanupStatus = 'pending' | 'completed' | 'failed';

export interface ExperimentRule {
  id: number;
  domains: string[];
}

export interface ExperimentComparisonRow {
  name: MetricName;
  baseline: number | null;
  experiment: number | null;
  absolute: number | null;
  relativePercent: number | null;
}

export interface Experiment {
  id: string;
  schemaVersion: number;
  baselineSessionId: string;
  experimentSessionId?: string;
  tabId: number;
  url: string;

  createdAt: number;
  startedAt: number;
  endedAt?: number;

  status: ExperimentStatus;
  preset: ExperimentPreset;
  domains: string[];
  rules: ExperimentRule[];
  note?: string;

  baselineValues: MetricValues;
  experimentValues: MetricValues;
  comparison: ExperimentComparisonRow[];
  limitations: string[];
  cleanupVerified?: boolean;
  cleanupStatus: ExperimentCleanupStatus;
}

export interface ExperimentInput {
  baselineSessionId: string;
  tabId: number;
  preset: ExperimentPreset;
  domains: string[];
  note?: string;
}
