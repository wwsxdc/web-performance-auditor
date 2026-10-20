import type {
  MetricAttribution,
  MetricName,
  MetricRecord,
  MetricSource,
  MetricStatus,
} from './metrics';
import type { AuditSession } from './session';
import type { DiagnosticEvent } from './events';
import type { ExperimentPreset } from './experiment';

// Page Script -> Content Script (via window.postMessage)
export type PageToContentMessage =
  | {
      type: 'WPA_METRIC';
      payload: {
        /** Unique id of this update; used for idempotent persistence. */
        updateId: string;
        /** Stable web-vitals metric id. */
        metricId: string;
        name: string;
        value: number | null;
        delta: number;
        rating: string;
        navigationType?: string;
        observedAt: number;
        status?: MetricStatus;
        source?: MetricSource;
        attribution?: MetricAttribution;
        /** Identifies the document that produced this metric. */
        documentToken?: string;
      };
    }
  | {
      type: 'WPA_COLLECTOR_READY';
      payload?: { capabilities?: string[]; documentToken?: string };
    }
  | {
      type: 'WPA_COLLECTOR_ERROR';
      payload: { message: string; metric?: string; documentToken?: string };
    }
  | {
      type: 'WPA_EVENT';
      payload: {
        eventId: string;
        eventType: 'long-task' | 'interaction' | 'layout-shift';
        timestamp: number;
        duration?: number;
        details?: Record<string, string | number | boolean | null>;
        documentToken?: string;
      };
    };

// Extension internal messages (CS <-> BG <-> SP)
export type ExtensionMessage =
  | { type: 'SESSION_START'; requestId: string; tabId: number }
  | { type: 'SESSION_STOP'; requestId: string; sessionId: string }
  | {
      type: 'METRIC_UPDATE';
      requestId: string;
      sessionId: string;
      metric: Partial<MetricRecord>;
      documentToken?: string;
    }
  | {
      type: 'EVENT_UPDATE';
      requestId: string;
      sessionId: string;
      event: Partial<DiagnosticEvent>;
      documentToken?: string;
    }
  | { type: 'INJECT_COLLECTOR'; requestId: string; tabId: number }
  | {
      type: 'COLLECTOR_STATUS';
      requestId: string;
      status: 'ready' | 'error' | 'unsupported';
      message?: string;
      documentToken?: string;
    }
  | { type: 'COLLECTOR_STOP'; requestId: string }
  | {
      type: 'HIGHLIGHT_TARGET';
      requestId: string;
      tabId: number;
      target: {
        targetId?: string;
        selector?: string;
        color: 'green' | 'red' | 'yellow';
        label?: string;
        metricName?: MetricName;
      };
    }
  | {
      type: 'CLEAR_HIGHLIGHT';
      requestId: string;
      tabId: number;
      /** Clear only this diagnostic category; omit to close all overlays. */
      metricName?: MetricName;
    }
  | {
      type: 'OVERLAY_STATUS';
      requestId: string;
      targetId?: string;
      metricName?: MetricName;
      available: boolean;
      reason?: string;
    }
  | { type: 'GET_STATE'; requestId: string }
  | { type: 'STATE_UPDATE'; requestId: string; state: AppState }
  | { type: 'EXPERIMENT_LIST'; requestId: string }
  | {
      type: 'EXPERIMENT_START';
      requestId: string;
      tabId: number;
      baselineSessionId: string;
      preset: ExperimentPreset;
      domains: string[];
      note?: string;
    }
  | { type: 'EXPERIMENT_FINISH'; requestId: string; experimentId: string }
  | { type: 'EXPERIMENT_CANCEL'; requestId: string; experimentId: string }
  | { type: 'EXPORT_JSON'; requestId: string; sessionId: string }
  | { type: 'EXPORT_MARKDOWN'; requestId: string; sessionId: string; experimentId?: string }
  | { type: 'CLEAR_HISTORY'; requestId: string }
  | { type: 'GET_SETTINGS'; requestId: string }
  | { type: 'UPDATE_SETTINGS'; requestId: string; retentionDays: number }
  | { type: 'GET_DIAGNOSTICS'; requestId: string }
  | { type: 'CLEAR_DIAGNOSTICS'; requestId: string }
  | { type: 'TAB_STATUS'; requestId: string; tabId: number; accessible: boolean; reason?: string };

export type CollectorStatus = 'idle' | 'initializing' | 'collecting' | 'unsupported' | 'permission-denied' | 'error';

export interface OverlayStatus {
  targetId?: string;
  metricName?: MetricName;
  available: boolean;
  reason?: string;
}

export interface AppState {
  session: AuditSession | null;
  collectorStatus: CollectorStatus;
  activeTabId: number | null;
  activeTabUrl: string | null;
  /** Navigation segment that receives CLS/INP and interaction events. */
  activeNavigationId: string | null;
  overlayStatus?: OverlayStatus | null;
  error?: string;
}
