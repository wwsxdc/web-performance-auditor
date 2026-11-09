import type { MetricRecord } from './metrics';
import type { DiagnosticEvent } from './events';

export interface NavigationRecord {
  id: string;
  sessionId: string;
  url: string;
  kind: 'document' | 'spa';
  startedAt: number;
  endedAt?: number;
  source?: 'navigation-api' | 'history' | 'web-navigation';
}

export type SessionStatus =
  | 'active'
  | 'completed'
  | 'interrupted'
  | 'unsupported'
  | 'error';

/**
 * Provenance of a report imported from a previously exported JSON file.
 * Imported records are read-only history: they never become a live session and
 * never create DNR rules.
 */
export interface ImportedReportSource {
  sessionId: string;
  generatedAt: string;
  toolVersion: string;
}

export interface AuditSession {
  id: string;
  schemaVersion: number;

  /** Set only for sessions created by importing an exported report. */
  origin?: 'imported';
  importedFrom?: ImportedReportSource;

  tabId: number;
  documentId?: string;
  url: string;

  startedAt: number;
  endedAt?: number;

  status: SessionStatus;

  browser: {
    name: string;
    version?: string;
  };

  navigations: NavigationRecord[];
  metrics: MetricRecord[];
  events: DiagnosticEvent[];

  experimentIds: string[];
}

/** Lightweight history row; metrics/events are loaded only on selection. */
export interface SessionSummary {
  id: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  metricCount: number;
  eventCount: number;
  experimentCount: number;
  origin?: 'imported';
  importedFrom?: ImportedReportSource;
}
