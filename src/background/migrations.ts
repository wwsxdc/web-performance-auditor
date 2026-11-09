import type {
  ImportedReportSource,
  NavigationRecord,
  SessionStatus,
  StoredSession,
} from '../types/session';
import type {
  Experiment,
  ExperimentCleanupStatus,
  ExperimentComparisonRow,
  ExperimentPreset,
  ExperimentRule,
  ExperimentStatus,
  MetricValues,
} from '../types/experiment';
import type { MetricName } from '../types/metrics';
import { SCHEMA_VERSION } from '../constants/config';
import { isMetricName } from '../utils/validation';

type RawRecord = Record<string, unknown>;

type RecordMigration = (record: RawRecord) => RawRecord;

const SESSION_STATUSES: readonly SessionStatus[] = [
  'active',
  'completed',
  'interrupted',
  'unsupported',
  'error',
];

const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  'running',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
];

const CLEANUP_STATUSES: readonly ExperimentCleanupStatus[] = [
  'pending',
  'completed',
  'failed',
];

const EXPERIMENT_PRESETS: readonly ExperimentPreset[] = [
  'analytics',
  'third-party-domain',
  'custom',
];

const METRIC_NAMES: readonly MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

/**
 * Migration chain for persisted sessions. The key is the version being
 * migrated FROM; each step returns a record for the next version. Adding a new
 * `SCHEMA_VERSION` without a step intentionally makes older records
 * unsupported instead of silently accepting a shape nobody has verified.
 */
const SESSION_MIGRATIONS: Record<number, RecordMigration> = {
  1: (record) => ({ ...record }),
};

/** Same contract as SESSION_MIGRATIONS, for experiments. */
const EXPERIMENT_MIGRATIONS: Record<number, RecordMigration> = {
  1: (record) => ({ ...record }),
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return typeof value === 'string' && (EXPERIMENT_STATUSES as readonly string[]).includes(value);
}

function isCleanupStatus(value: unknown): value is ExperimentCleanupStatus {
  return typeof value === 'string' && (CLEANUP_STATUSES as readonly string[]).includes(value);
}

function isExperimentPreset(value: unknown): value is ExperimentPreset {
  return typeof value === 'string' && (EXPERIMENT_PRESETS as readonly string[]).includes(value);
}

function migrateChain(
  record: RawRecord,
  fromVersion: number,
  migrations: Record<number, RecordMigration>,
): RawRecord | null {
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > SCHEMA_VERSION) {
    return null;
  }

  let working = { ...record };
  for (let version = fromVersion; version < SCHEMA_VERSION; version++) {
    const migrate = migrations[version];
    if (!migrate) return null;
    working = migrate(working);
    working.schemaVersion = version + 1;
  }
  return working;
}

function normalizeBrowser(value: unknown): { name: string; version?: string } {
  if (typeof value === 'string') {
    return { name: asString(value) ?? 'Unknown' };
  }
  if (!isRecord(value)) return { name: 'Unknown' };
  const name = asString(value.name) ?? 'Unknown';
  const version = asString(value.version);
  return version ? { name, version } : { name };
}

function normalizeImportedFrom(value: unknown): ImportedReportSource | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = asString(value.sessionId);
  const generatedAt = asString(value.generatedAt);
  const toolVersion = asString(value.toolVersion);
  if (!sessionId || !generatedAt || !toolVersion) return undefined;
  return { sessionId, generatedAt, toolVersion };
}

function normalizeNavigation(
  value: unknown,
  fallbackSessionId: string,
): NavigationRecord | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const url = asString(value.url);
  const startedAt = asFiniteNumber(value.startedAt);
  if (!id || !url || startedAt === undefined) return null;

  const endedAt = asFiniteNumber(value.endedAt);
  const source = value.source;
  const normalized: NavigationRecord = {
    id,
    sessionId: asString(value.sessionId) ?? fallbackSessionId,
    url,
    kind: value.kind === 'spa' ? 'spa' : 'document',
    startedAt,
  };
  if (endedAt !== undefined) normalized.endedAt = endedAt;
  if (
    source === 'navigation-api' ||
    source === 'history' ||
    source === 'web-navigation'
  ) {
    normalized.source = source;
  }
  return normalized;
}

function normalizeNavigations(
  value: unknown,
  sessionId: string,
  url: string,
  startedAt: number,
  legacyNavigationId: unknown,
): NavigationRecord[] {
  const navigations = Array.isArray(value)
    ? value
        .map((entry) => normalizeNavigation(entry, sessionId))
        .filter((entry): entry is NavigationRecord => entry !== null)
    : [];
  if (navigations.length > 0) return navigations;

  // v1 stored a single navigation id on the session header. Reconstruct the
  // document segment instead of dropping load metrics that point at it.
  return [{
    id: asString(legacyNavigationId) ?? `${sessionId}-nav-1`,
    sessionId,
    url,
    kind: 'document',
    startedAt,
  }];
}

/**
 * Accepts a stored session record from any supported schema version and
 * returns a current-schema header. Records from an unknown/future version, or
 * records missing identity fields, are rejected (`null`) so callers can fall
 * back to ignoring/dropping them.
 */
export function migrateStoredSession(record: unknown): StoredSession | null {
  if (!isRecord(record)) return null;
  const fromVersion = asFiniteNumber(record.schemaVersion);
  if (fromVersion === undefined) return null;

  const migrated = migrateChain(record, fromVersion, SESSION_MIGRATIONS);
  if (!migrated) return null;

  const id = asString(migrated.id);
  const tabId = asFiniteNumber(migrated.tabId);
  const url = asString(migrated.url);
  const startedAt = asFiniteNumber(migrated.startedAt);
  if (!id || tabId === undefined || !url || startedAt === undefined) return null;

  const status = isSessionStatus(migrated.status)
    ? migrated.status
    : // v1 had no explicit lifecycle guarantee; a missing end timestamp means
      // the session was interrupted rather than completed.
      fromVersion < SCHEMA_VERSION
      ? (asFiniteNumber(migrated.endedAt) !== undefined ? 'completed' : 'interrupted')
      : null;
  if (!status) return null;

  const endedAt = asFiniteNumber(migrated.endedAt);
  const documentId = asString(migrated.documentId);
  const importedFrom = normalizeImportedFrom(migrated.importedFrom);

  const session: StoredSession = {
    id,
    schemaVersion: SCHEMA_VERSION,
    tabId,
    url,
    startedAt,
    status,
    browser: normalizeBrowser(migrated.browser),
    navigations: normalizeNavigations(
      migrated.navigations,
      id,
      url,
      startedAt,
      migrated.navigationId,
    ),
    experimentIds: asStringArray(migrated.experimentIds),
  };
  if (migrated.origin === 'imported') session.origin = 'imported';
  if (importedFrom) session.importedFrom = importedFrom;
  if (endedAt !== undefined) session.endedAt = endedAt;
  if (documentId) session.documentId = documentId;
  return session;
}

function normalizeMetricValues(value: unknown): MetricValues {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(
    METRIC_NAMES.map((name) => [name, asFiniteNumber(record[name]) ?? null]),
  ) as MetricValues;
}

function normalizeRules(value: unknown): ExperimentRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ExperimentRule[] => {
    if (!isRecord(entry)) return [];
    const id = asFiniteNumber(entry.id);
    if (id === undefined) return [];
    return [{ id, domains: asStringArray(entry.domains) }];
  });
}

function normalizeComparison(value: unknown): ExperimentComparisonRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ExperimentComparisonRow[] => {
    if (!isRecord(entry) || !isMetricName(entry.name)) return [];
    return [{
      name: entry.name,
      baseline: asFiniteNumber(entry.baseline) ?? null,
      experiment: asFiniteNumber(entry.experiment) ?? null,
      absolute: asFiniteNumber(entry.absolute) ?? null,
      relativePercent: asFiniteNumber(entry.relativePercent) ?? null,
    }];
  });
}

function normalizeCleanupStatus(
  value: unknown,
  status: ExperimentStatus,
): ExperimentCleanupStatus {
  if (isCleanupStatus(value)) return value;
  // Records created before cleanupStatus existed: a running experiment still
  // owns rules that must be cleaned, everything else is already settled.
  return status === 'running' ? 'pending' : 'completed';
}

/**
 * Accepts a stored experiment from any supported schema version and returns a
 * current-schema record. Missing lifecycle/array fields are filled with safe
 * defaults, matching the read-time normalisation that predated migrations.
 */
export function migrateStoredExperiment(record: unknown): Experiment | null {
  if (!isRecord(record)) return null;
  const fromVersion = asFiniteNumber(record.schemaVersion);
  if (fromVersion === undefined) return null;

  const migrated = migrateChain(record, fromVersion, EXPERIMENT_MIGRATIONS);
  if (!migrated) return null;

  const id = asString(migrated.id);
  const baselineSessionId = asString(migrated.baselineSessionId);
  const tabId = asFiniteNumber(migrated.tabId);
  const url = asString(migrated.url);
  const createdAt = asFiniteNumber(migrated.createdAt);
  const startedAt = asFiniteNumber(migrated.startedAt);
  if (
    !id ||
    !baselineSessionId ||
    tabId === undefined ||
    !url ||
    createdAt === undefined ||
    startedAt === undefined
  ) {
    return null;
  }

  const status = isExperimentStatus(migrated.status)
    ? migrated.status
    : fromVersion < SCHEMA_VERSION
      ? 'incomplete'
      : null;
  if (!status) return null;

  const endedAt = asFiniteNumber(migrated.endedAt);
  const experimentSessionId = asString(migrated.experimentSessionId);
  const note = asString(migrated.note);

  const experiment: Experiment = {
    id,
    schemaVersion: SCHEMA_VERSION,
    baselineSessionId,
    tabId,
    url,
    createdAt,
    startedAt,
    status,
    preset: isExperimentPreset(migrated.preset) ? migrated.preset : 'custom',
    domains: asStringArray(migrated.domains),
    rules: normalizeRules(migrated.rules),
    baselineValues: normalizeMetricValues(migrated.baselineValues),
    experimentValues: normalizeMetricValues(migrated.experimentValues),
    comparison: normalizeComparison(migrated.comparison),
    limitations: asStringArray(migrated.limitations),
    cleanupStatus: normalizeCleanupStatus(migrated.cleanupStatus, status),
  };
  if (experimentSessionId) experiment.experimentSessionId = experimentSessionId;
  if (endedAt !== undefined) experiment.endedAt = endedAt;
  if (note) experiment.note = note;
  if (typeof migrated.cleanupVerified === 'boolean') {
    experiment.cleanupVerified = migrated.cleanupVerified;
  }
  return experiment;
}
