export const SCHEMA_VERSION = 2;
export const REPORT_VERSION = 1;
export const EXTENSION_NAME = 'Web Performance Auditor';
export const EXTENSION_VERSION = '0.1.2';

export const STORAGE_LIMITS = {
  maxSessions: 50,
  maxEventsPerSession: 500,
  maxMetricsPerSession: 1000,
  sessionRetentionDays: 30,
};

// Diagnostic events are buffered in the service worker and written in one
// IndexedDB transaction per batch (NFR 4.1). The timer bounds how long an
// event can stay unwritten if the batch never fills up.
export const EVENT_BATCHING = {
  batchSize: 16,
  flushIntervalMs: 75,
};

export const PAGE_MESSAGE_LIMITS = {
  maxBytes: 64 * 1024,
  maxStringLength: 512,
};

export const WPA_MESSAGE_PREFIX = 'WPA_';

export const PAGE_SCRIPT_FILE = 'generated/page-script.js';
export const CONTENT_SCRIPT_FILE = 'generated/content.js';
export const PAGE_COLLECTOR_SCRIPT_ID = 'wpa-page-collector';
