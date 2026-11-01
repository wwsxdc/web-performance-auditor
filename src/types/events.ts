export type DiagnosticEventType =
  | 'metric-update'
  | 'layout-shift'
  | 'long-task'
  | 'interaction'
  | 'spa-navigation'
  | 'experiment'
  | 'collector-limitation';

export interface DiagnosticEvent {
  id: string;
  sessionId: string;
  navigationId: string;

  type: DiagnosticEventType;
  timestamp: number;
  duration?: number;

  targetId?: string;
  relatedMetricIds?: string[];

  details?: Record<string, string | number | boolean | null>;
}
