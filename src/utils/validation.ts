import type { CollectorStatus, ExtensionMessage, PageToContentMessage } from '../types/messages';
import type { MetricName, MetricSource, MetricStatus } from '../types/metrics';
import type { DiagnosticEventType } from '../types/events';
import type { ExperimentPreset } from '../types/experiment';

const METRIC_NAMES: readonly MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];
const METRIC_SOURCES: readonly MetricSource[] = [
  'web-vitals',
  'performance-api',
  'derived',
];
const METRIC_STATUSES: readonly MetricStatus[] = [
  'pending',
  'measured',
  'unsupported',
  'unavailable',
  'incomplete',
];
const COLLECTOR_STATUSES: readonly CollectorStatus[] = [
  'idle',
  'initializing',
  'collecting',
  'unsupported',
  'permission-denied',
  'error',
];
const EVENT_TYPES: readonly DiagnosticEventType[] = [
  'metric-update',
  'layout-shift',
  'long-task',
  'interaction',
  'spa-navigation',
  'experiment',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isMetricName(value: unknown): value is MetricName {
  return isString(value) && (METRIC_NAMES as readonly string[]).includes(value);
}

export function isMetricStatus(value: unknown): value is MetricStatus {
  return isString(value) && (METRIC_STATUSES as readonly string[]).includes(value);
}

export function isMetricSource(value: unknown): value is MetricSource {
  return isString(value) && (METRIC_SOURCES as readonly string[]).includes(value);
}

export function isCollectorStatus(value: unknown): value is CollectorStatus {
  return isString(value) && (COLLECTOR_STATUSES as readonly string[]).includes(value);
}

export function isEventType(value: unknown): value is DiagnosticEventType {
  return isString(value) && (EVENT_TYPES as readonly string[]).includes(value);
}

export function isExperimentPreset(value: unknown): value is ExperimentPreset {
  return value === 'analytics' || value === 'third-party-domain' || value === 'custom';
}

export function isPageToContentMessage(value: unknown): value is PageToContentMessage {
  if (!isObject(value) || !isString(value.type)) return false;

  switch (value.type) {
    case 'WPA_COLLECTOR_READY':
      return (
        value.payload === undefined ||
        (isObject(value.payload) &&
          (value.payload.capabilities === undefined || Array.isArray(value.payload.capabilities)) &&
          (value.payload.documentToken === undefined || isString(value.payload.documentToken)))
      );

    case 'WPA_COLLECTOR_ERROR':
      return (
        isObject(value.payload) &&
        isString(value.payload.message) &&
        (value.payload.documentToken === undefined || isString(value.payload.documentToken))
      );

    case 'WPA_EVENT': {
      if (!isObject(value.payload)) return false;
      const payload = value.payload;

      return (
        isString(payload.eventId) &&
        (payload.eventType === 'long-task' ||
          payload.eventType === 'interaction' ||
          payload.eventType === 'layout-shift') &&
        isNumber(payload.timestamp) &&
        (payload.duration === undefined || isNumber(payload.duration)) &&
        (payload.details === undefined || isObject(payload.details)) &&
        (payload.documentToken === undefined || isString(payload.documentToken))
      );
    }

    case 'WPA_METRIC': {
      if (!isObject(value.payload)) return false;
      const payload = value.payload;

      return (
        isString(payload.updateId) &&
        isString(payload.metricId) &&
        isMetricName(payload.name) &&
        (payload.value === null || isNumber(payload.value)) &&
        isNumber(payload.delta) &&
        isString(payload.rating) &&
        isNumber(payload.observedAt) &&
        (payload.navigationType === undefined || isString(payload.navigationType)) &&
        (payload.status === undefined || isMetricStatus(payload.status)) &&
        (payload.source === undefined || isMetricSource(payload.source)) &&
        (payload.documentToken === undefined || isString(payload.documentToken)) &&
        (payload.attribution === undefined || isObject(payload.attribution))
      );
    }

    default:
      return false;
  }
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isObject(value) || !isString(value.type)) return false;

  switch (value.type) {
    case 'SESSION_START':
      return isString(value.requestId) && isNumber(value.tabId);

    case 'SESSION_STOP':
      return isString(value.requestId) && isString(value.sessionId);

    case 'INJECT_COLLECTOR':
      return isString(value.requestId) && isNumber(value.tabId);

    case 'GET_STATE':
      return isString(value.requestId);

    case 'EXPERIMENT_LIST':
      return isString(value.requestId);

    case 'EXPERIMENT_START':
      return (
        isString(value.requestId) &&
        isNumber(value.tabId) &&
        isString(value.baselineSessionId) &&
        isExperimentPreset(value.preset) &&
        Array.isArray(value.domains) &&
        value.domains.every((domain) => isString(domain)) &&
        (value.note === undefined || isString(value.note))
      );

    case 'EXPERIMENT_FINISH':
      return isString(value.requestId) && isString(value.experimentId);

    case 'EXPERIMENT_CANCEL':
      return isString(value.requestId) && isString(value.experimentId);

    case 'EXPORT_JSON':
      return isString(value.requestId) && isString(value.sessionId);

    case 'EXPORT_MARKDOWN':
      return (
        isString(value.requestId) &&
        isString(value.sessionId) &&
        (value.experimentId === undefined || isString(value.experimentId))
      );

    case 'COLLECTOR_STATUS':
      return (
        isString(value.requestId) &&
        (value.status === 'ready' || value.status === 'error' || value.status === 'unsupported') &&
        (value.message === undefined || isString(value.message)) &&
        (value.documentToken === undefined || isString(value.documentToken))
      );

    case 'COLLECTOR_STOP':
      return isString(value.requestId);

    case 'HIGHLIGHT_TARGET':
      return (
        isString(value.requestId) &&
        isNumber(value.tabId) &&
        isObject(value.target) &&
        (value.target.color === 'green' ||
          value.target.color === 'red' ||
          value.target.color === 'yellow') &&
        (value.target.targetId === undefined || isString(value.target.targetId)) &&
        (value.target.selector === undefined || isString(value.target.selector)) &&
        (value.target.label === undefined || isString(value.target.label)) &&
        (value.target.metricName === undefined || isMetricName(value.target.metricName))
      );

    case 'CLEAR_HIGHLIGHT':
      return (
        isString(value.requestId) &&
        isNumber(value.tabId) &&
        (value.metricName === undefined || isMetricName(value.metricName))
      );

      case 'OVERLAY_STATUS':
        return (
          isString(value.requestId) &&
          typeof value.available === 'boolean' &&
          (value.targetId === undefined || isString(value.targetId)) &&
          (value.metricName === undefined || isMetricName(value.metricName)) &&
          (value.reason === undefined || isString(value.reason))
        );

    case 'METRIC_UPDATE': {
      if (!isString(value.requestId) || !isString(value.sessionId) || !isObject(value.metric)) {
        return false;
      }
      const metric = value.metric;

      return (
        isMetricName(metric.name) &&
        (metric.value === null || isNumber(metric.value)) &&
        (metric.delta === undefined || isNumber(metric.delta)) &&
        (metric.observedAt === undefined || isNumber(metric.observedAt)) &&
        (metric.id === undefined || isString(metric.id)) &&
        (metric.updateId === undefined || isString(metric.updateId)) &&
        (metric.source === undefined || isMetricSource(metric.source)) &&
        (value.documentToken === undefined || isString(value.documentToken))
      );
    }

    case 'EVENT_UPDATE': {
      if (!isString(value.requestId) || !isString(value.sessionId) || !isObject(value.event)) {
        return false;
      }
      const event = value.event;

      return (
        isEventType(event.type) &&
        isNumber(event.timestamp) &&
        (event.duration === undefined || isNumber(event.duration)) &&
        (event.id === undefined || isString(event.id)) &&
        (event.targetId === undefined || isString(event.targetId)) &&
        (value.documentToken === undefined || isString(value.documentToken))
      );
    }

    case 'STATE_UPDATE':
      return isString(value.requestId) && isObject(value.state);

      case 'CLEAR_HISTORY':
        return isString(value.requestId);

      case 'GET_SETTINGS':
        return isString(value.requestId);

      case 'UPDATE_SETTINGS':
        return isString(value.requestId) && isNumber(value.retentionDays);

      case 'GET_DIAGNOSTICS':
        return isString(value.requestId);

      case 'CLEAR_DIAGNOSTICS':
        return isString(value.requestId);

      case 'TAB_STATUS':
      return (
        isString(value.requestId) &&
        isNumber(value.tabId) &&
        typeof value.accessible === 'boolean' &&
        (value.reason === undefined || isString(value.reason))
      );

    default:
      return false;
  }
}
