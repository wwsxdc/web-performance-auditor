export const SCHEMA_VERSION = 2;
export const REPORT_VERSION = 1;
export const EXTENSION_NAME = 'Web Performance Auditor';
export const EXTENSION_VERSION = '0.1.0';

export const STORAGE_LIMITS = {
  maxSessions: 50,
  maxEventsPerSession: 500,
  sessionRetentionDays: 30,
};

export const WPA_MESSAGE_PREFIX = 'WPA_';

export const PAGE_SCRIPT_FILE = 'generated/page-script.js';
export const CONTENT_SCRIPT_FILE = 'generated/content.js';
export const PAGE_COLLECTOR_SCRIPT_ID = 'wpa-page-collector';
