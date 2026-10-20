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

export interface AuditSession {
  id: string;
  schemaVersion: number;

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
