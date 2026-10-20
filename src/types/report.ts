import type { MetricAttribution, MetricName, MetricRecord } from './metrics';
import type { DiagnosticEvent } from './events';
import type { NavigationRecord } from './session';
import type { Experiment } from './experiment';

export interface ReportAttribution {
  metricId: string;
  metricName: MetricName;
  observedAt: number;
  attribution: MetricAttribution;
}

export interface JsonReport {
  reportVersion: number;
  schemaVersion: number;
  generatedAt: string;
  tool: {
    name: string;
    version: string;
  };
  session: {
    id: string;
    tabId: number;
    documentId?: string;
    url: string;
    startedAt: number;
    endedAt?: number;
    status: string;
    browser: { name: string; version?: string };
    navigations: NavigationRecord[];
  };
  metrics: MetricRecord[];
  attribution: ReportAttribution[];
  events: DiagnosticEvent[];
  experiments: Experiment[];
  limitations: string[];
}
