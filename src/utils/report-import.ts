import type {
  AuditSession,
  NavigationRecord,
  SessionStatus,
} from '../types/session';
import type {
  MetricAttribution,
  MetricRecord,
  MetricSource,
  MetricStatus,
} from '../types/metrics';
import type { DiagnosticEvent, DiagnosticEventType } from '../types/events';
import type {
  Experiment,
  ExperimentComparisonRow,
  ExperimentPreset,
  ExperimentStatus,
  MetricValues,
} from '../types/experiment';
import type { JsonReport } from '../types/report';
import { REPORT_VERSION, SCHEMA_VERSION, STORAGE_LIMITS } from '../constants/config';
import { calculateRating } from './rating';
import { generateId } from './id';
import { validateJsonReport } from './report-schema';
import { isAuditableUrl, sanitizeUrl } from './url';

/**
 * Hard limits applied before anything is written. They are deliberately much
 * larger than the storage limits so a normal report is never rejected; only a
 * hostile or corrupted file is.
 */
export const IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxMetrics: 10_000,
  maxEvents: 10_000,
  maxExperiments: 100,
} as const;

const SESSION_STATUSES: readonly SessionStatus[] = [
  'active',
  'completed',
  'interrupted',
  'unsupported',
  'error',
];
const METRIC_STATUSES: readonly MetricStatus[] = [
  'pending',
  'measured',
  'unsupported',
  'unavailable',
  'incomplete',
];
const METRIC_SOURCES: readonly MetricSource[] = ['web-vitals', 'performance-api', 'derived'];
const EVENT_TYPES: readonly DiagnosticEventType[] = [
  'metric-update',
  'layout-shift',
  'long-task',
  'interaction',
  'spa-navigation',
  'experiment',
  'collector-limitation',
];
const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  'running',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
];
const EXPERIMENT_PRESETS: readonly ExperimentPreset[] = [
  'analytics',
  'third-party-domain',
  'custom',
];
const METRIC_NAMES = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'] as const;

export interface ParsedImport {
  report?: JsonReport;
  error?: string;
}

export interface ImportIntegrity {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ImportPreview {
  sourceSessionId: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  browser: { name: string; version?: string };
  generatedAt: string;
  toolVersion: string;
  metricCount: number;
  eventCount: number;
  experimentCount: number;
  errors: string[];
  warnings: string[];
}

export interface ImportBundle {
  session: AuditSession;
  metrics: MetricRecord[];
  events: DiagnosticEvent[];
  experiments: Experiment[];
  warnings: string[];
}

export interface ImportSummary {
  sourceSessionId: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  browser: { name: string; version?: string };
  generatedAt: string;
  toolVersion: string;
  metricCount: number;
  eventCount: number;
  experimentCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Deep-copies only JSON-compatible values and drops prototype keys. The input
 * already came from JSON.parse, but the explicit copy keeps imported records
 * free of anything the report schema did not describe.
 */
function cloneJson<T>(value: T, depth = 0): T | undefined {
  if (depth > 12) return undefined;
  if (value === null) return value;
  const kind = typeof value;
  if (kind === 'string') return (value as string).slice(0, 2048) as T;
  if (kind === 'number') return (Number.isFinite(value as unknown as number) ? value : undefined) as T | undefined;
  if (kind === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((item) => cloneJson(item, depth + 1))
      .filter((item): item is NonNullable<typeof item> => item !== undefined) as T;
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (key.length > 120) continue;
      const cloned = cloneJson(nested, depth + 1);
      if (cloned !== undefined) copy[key] = cloned;
    }
    return copy as T;
  }
  return undefined;
}

function sanitizeDetails(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 64) continue;
    if (entry === null || typeof entry === 'boolean') {
      details[key] = entry;
    } else if (isFiniteNumber(entry)) {
      details[key] = entry;
    } else if (typeof entry === 'string') {
      details[key] = entry.slice(0, 512);
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function sanitizeMetricValues(value: unknown): MetricValues {
  const record = isRecord(value) ? value : {};
  const values = {} as MetricValues;
  for (const name of METRIC_NAMES) {
    const entry = record[name];
    values[name] = isFiniteNumber(entry) ? entry : null;
  }
  return values;
}

function sanitizeComparison(value: unknown): ExperimentComparisonRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ExperimentComparisonRow[] = [];
  for (const entry of value.slice(0, METRIC_NAMES.length)) {
    if (!isRecord(entry)) continue;
    const name = oneOf(entry.name, METRIC_NAMES);
    if (!name) continue;
    const numberOrNull = (input: unknown): number | null =>
      isFiniteNumber(input) ? input : null;
    rows.push({
      name,
      baseline: numberOrNull(entry.baseline),
      experiment: numberOrNull(entry.experiment),
      absolute: numberOrNull(entry.absolute),
      relativePercent: numberOrNull(entry.relativePercent),
    });
  }
  return rows;
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function safeSessionStatus(value: unknown): SessionStatus {
  const status = oneOf(value, SESSION_STATUSES);
  // Imported data must never look live.
  if (!status || status === 'active') return 'interrupted';
  return status;
}

function sanitizeMetricStatus(value: unknown, hasValue: boolean): MetricStatus {
  return oneOf(value, METRIC_STATUSES) ?? (hasValue ? 'measured' : 'pending');
}

function sanitizeMetricSource(value: unknown): MetricSource {
  return oneOf(value, METRIC_SOURCES) ?? 'derived';
}

function sanitizeEventType(value: unknown): DiagnosticEventType | undefined {
  return oneOf(value, EVENT_TYPES);
}

export interface ParseImportOptions {
  maxBytes?: number;
}

/**
 * Parses the file selected by the user. The report format is the one produced
 * by EXPORT_JSON: newer major versions are rejected instead of guessed.
 */
export function parseImportPayload(
  text: unknown,
  options: ParseImportOptions = {},
): ParsedImport {
  if (typeof text !== 'string') {
    return { error: 'Файл не содержит текста JSON' };
  }
  const maxBytes = options.maxBytes ?? IMPORT_LIMITS.maxBytes;
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    return {
      error: `Файл больше ${Math.round(maxBytes / (1024 * 1024))} МБ и не может быть импортирован`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Файл не является корректным JSON' };
  }

  const validation = validateJsonReport(parsed);
  if (!validation.valid) {
    return {
      error: `Некорректный отчёт: ${validation.errors.slice(0, 3).join('; ')}`,
    };
  }

  const report = parsed as JsonReport;
  if (report.reportVersion > REPORT_VERSION) {
    return {
      error: `Версия отчёта ${report.reportVersion} новее поддерживаемой ${REPORT_VERSION}`,
    };
  }
  if (report.schemaVersion < 1 || report.schemaVersion > SCHEMA_VERSION) {
    return {
      error: `Версия схемы ${report.schemaVersion} не поддерживается (ожидается 1–${SCHEMA_VERSION})`,
    };
  }

  return { report };
}

/**
 * Structural checks that go beyond validateJsonReport: version support, URL
 * safety, hard caps and references that would produce dangling records.
 * Recoverable issues become warnings; they never abort the import.
 */
export function validateImportIntegrity(report: JsonReport): ImportIntegrity {
  const errors: string[] = [];
  const warnings: string[] = [];

  const validation = validateJsonReport(report);
  if (!validation.valid) errors.push(...validation.errors);

  if (report.reportVersion > REPORT_VERSION) {
    errors.push(`Версия отчёта ${report.reportVersion} новее поддерживаемой ${REPORT_VERSION}`);
  }
  if (report.schemaVersion < 1 || report.schemaVersion > SCHEMA_VERSION) {
    errors.push(`Версия схемы ${report.schemaVersion} не поддерживается`);
  }

  const urlCheck = isAuditableUrl(report.session?.url);
  if (!urlCheck.auditable) {
    errors.push(`URL сессии не может быть импортирован: ${urlCheck.reason ?? 'некорректный URL'}`);
  }

  if (report.metrics.length > IMPORT_LIMITS.maxMetrics) {
    errors.push(`Слишком много метрик: ${report.metrics.length} (максимум ${IMPORT_LIMITS.maxMetrics})`);
  }
  if (report.events.length > IMPORT_LIMITS.maxEvents) {
    errors.push(`Слишком много событий: ${report.events.length} (максимум ${IMPORT_LIMITS.maxEvents})`);
  }
  if (report.experiments.length > IMPORT_LIMITS.maxExperiments) {
    errors.push(
      `Слишком много экспериментов: ${report.experiments.length} (максимум ${IMPORT_LIMITS.maxExperiments})`,
    );
  }

  const navigationIds = new Set<string>();
  for (const navigation of report.session.navigations) {
    if (navigationIds.has(navigation.id)) {
      warnings.push(`Навигация с повторяющимся id ${navigation.id} будет пропущена`);
      continue;
    }
    navigationIds.add(navigation.id);
    if (!isAuditableUrl(navigation.url).auditable) {
      warnings.push(`Навигация ${sanitizeUrl(navigation.url)} не может быть импортирована`);
    }
  }

  if (navigationIds.size === 0) {
    warnings.push('В отчёте нет навигаций; будет создан один сегмент документа');
  }

  let unknownNavigationRefs = 0;
  for (const metric of report.metrics) {
    if (!navigationIds.has(metric.navigationId)) unknownNavigationRefs++;
  }
  for (const event of report.events) {
    if (!navigationIds.has(event.navigationId)) unknownNavigationRefs++;
  }
  if (unknownNavigationRefs > 0) {
    warnings.push(
      `${unknownNavigationRefs} записей ссылаются на отсутствующую навигацию; они будут привязаны к первому сегменту`,
    );
  }

  const metricIds = new Set<string>();
  for (const metric of report.metrics) {
    if (metricIds.has(metric.id)) {
      warnings.push(`Метрика с повторяющимся id ${metric.id} будет импортирована отдельной записью`);
    }
    metricIds.add(metric.id);
  }

  const eventIds = new Set<string>();
  for (const event of report.events) {
    if (eventIds.has(event.id)) {
      warnings.push(`Событие с повторяющимся id ${event.id} будет импортировано отдельной записью`);
    }
    eventIds.add(event.id);
  }

  for (const experiment of report.experiments) {
    if (experiment.baselineSessionId !== report.session.id) {
      warnings.push(
        `Эксперимент ${experiment.id} пропущен: его исходная сессия отсутствует в отчёте`,
      );
    }
  }

  if (report.session.status === 'active') {
    warnings.push('Активная сессия будет импортирована как прерванная');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function summarizeImportReport(report: JsonReport): ImportPreview {
  const integrity = validateImportIntegrity(report);
  return {
    sourceSessionId: report.session.id,
    url: sanitizeUrl(report.session.url),
    startedAt: report.session.startedAt,
    endedAt: report.session.endedAt,
    status: safeSessionStatus(report.session.status),
    browser: {
      name: report.session.browser.name,
      version: report.session.browser.version,
    },
    generatedAt: report.generatedAt,
    toolVersion: report.tool.version,
    metricCount: report.metrics.length,
    eventCount: report.events.length,
    experimentCount: report.experiments.length,
    errors: integrity.errors,
    warnings: integrity.warnings,
  };
}

/**
 * Builds independent records with fresh ids. Nothing from the imported file is
 * written under its original key, so an import can never overwrite a session
 * that already exists in the profile.
 */
export function buildImportBundle(report: JsonReport): ImportBundle {
  const integrity = validateImportIntegrity(report);
  if (!integrity.valid) {
    throw new Error(`Отчёт не прошёл проверку импорта: ${integrity.errors.join('; ')}`);
  }

  const warnings = [...integrity.warnings];
  const prefix = `imp-${generateId()}`;
  const sessionId = `${prefix}-s`;

  const navigationMap = new Map<string, string>();
  const navigations: NavigationRecord[] = [];
  for (const navigation of report.session.navigations) {
    if (navigationMap.has(navigation.id)) continue;
    if (!isAuditableUrl(navigation.url).auditable) continue;
    const id = `${prefix}-n${navigations.length}`;
    navigationMap.set(navigation.id, id);
    navigations.push({
      id,
      sessionId,
      url: sanitizeUrl(navigation.url),
      kind: navigation.kind === 'spa' ? 'spa' : 'document',
      startedAt: finiteOr(navigation.startedAt, report.session.startedAt),
      ...(isFiniteNumber(navigation.endedAt) ? { endedAt: navigation.endedAt } : {}),
      ...(navigation.source === 'navigation-api' ||
      navigation.source === 'history' ||
      navigation.source === 'web-navigation'
        ? { source: navigation.source }
        : {}),
    });
  }

  if (navigations.length === 0) {
    navigations.push({
      id: `${prefix}-n0`,
      sessionId,
      url: sanitizeUrl(report.session.url),
      kind: 'document',
      startedAt: finiteOr(report.session.startedAt, Date.now()),
    });
  }
  const fallbackNavigationId = navigations[0].id;

  const sortedMetrics = [...report.metrics].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  if (sortedMetrics.length > STORAGE_LIMITS.maxMetricsPerSession) {
    warnings.push(
      `Сохранено ${STORAGE_LIMITS.maxMetricsPerSession} из ${sortedMetrics.length} метрик: превышен лимит хранения`,
    );
  }
  const selectedMetrics = sortedMetrics.slice(0, STORAGE_LIMITS.maxMetricsPerSession);

  const sortedEvents = [...report.events].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  if (sortedEvents.length > STORAGE_LIMITS.maxEventsPerSession) {
    warnings.push(
      `Сохранено ${STORAGE_LIMITS.maxEventsPerSession} из ${sortedEvents.length} событий: превышен лимит хранения`,
    );
  }
  const selectedEvents = sortedEvents.slice(0, STORAGE_LIMITS.maxEventsPerSession);

  const metricAssignments = selectedMetrics.map((metric, index) => ({
    metric,
    id: `${prefix}-m${index}`,
  }));
  const eventAssignments = selectedEvents.map((event, index) => ({
    event,
    id: `${prefix}-e${index}`,
  }));

  const metricIdMap = new Map<string, string>();
  for (const assignment of metricAssignments) {
    if (!metricIdMap.has(assignment.metric.id)) {
      metricIdMap.set(assignment.metric.id, assignment.id);
    }
  }
  const eventIdMap = new Map<string, string>();
  for (const assignment of eventAssignments) {
    if (!eventIdMap.has(assignment.event.id)) {
      eventIdMap.set(assignment.event.id, assignment.id);
    }
  }

  const remapIdList = (
    ids: string[] | undefined,
    map: Map<string, string>,
  ): string[] | undefined => {
    if (!Array.isArray(ids)) return undefined;
    const remapped = ids
      .map((id) => map.get(id))
      .filter((id): id is string => typeof id === 'string');
    return remapped.length > 0 ? remapped : undefined;
  };

  const metrics: MetricRecord[] = metricAssignments.map(({ metric, id }) => {
    const attribution = cloneJson(metric.attribution) as MetricAttribution | undefined;
    if (attribution) {
      const longTaskIds = remapIdList(attribution.longTaskIds, eventIdMap);
      if (longTaskIds) attribution.longTaskIds = longTaskIds;
      else delete attribution.longTaskIds;
    }
    const value = isFiniteNumber(metric.value) ? metric.value : null;
    return {
      id,
      sessionId,
      navigationId: navigationMap.get(metric.navigationId) ?? fallbackNavigationId,
      name: metric.name,
      value,
      unit: metric.unit === 'score' ? 'score' : 'ms',
      status: sanitizeMetricStatus(metric.status, value !== null),
      rating: calculateRating(metric.name, value),
      observedAt: finiteOr(metric.observedAt, Date.now()),
      ...(isFiniteNumber(metric.delta) ? { delta: metric.delta } : {}),
      source: sanitizeMetricSource(metric.source),
      ...(typeof metric.metricId === 'string'
        ? { metricId: metric.metricId.slice(0, 200) }
        : {}),
      ...(typeof metric.navigationType === 'string'
        ? { navigationType: metric.navigationType.slice(0, 80) }
        : {}),
      ...(attribution ? { attribution } : {}),
    };
  });

  const events: DiagnosticEvent[] = eventAssignments.flatMap(({ event, id }) => {
    const type = sanitizeEventType(event.type);
    if (!type) {
      warnings.push(`Событие ${event.id} пропущено: неизвестный тип`);
      return [];
    }
    const relatedMetricIds = remapIdList(event.relatedMetricIds, metricIdMap);
    const details = sanitizeDetails(event.details);
    return [{
      id,
      sessionId,
      navigationId: navigationMap.get(event.navigationId) ?? fallbackNavigationId,
      type,
      timestamp: finiteOr(event.timestamp, Date.now()),
      ...(isFiniteNumber(event.duration) ? { duration: event.duration } : {}),
      ...(typeof event.targetId === 'string' ? { targetId: event.targetId.slice(0, 200) } : {}),
      ...(relatedMetricIds ? { relatedMetricIds } : {}),
      ...(details ? { details } : {}),
    }];
  });

  const experiments: Experiment[] = [];
  for (const experiment of report.experiments) {
    if (experiments.length >= IMPORT_LIMITS.maxExperiments) break;
    if (experiment.baselineSessionId !== report.session.id) continue;

    const status = oneOf(experiment.status, EXPERIMENT_STATUSES) ?? 'incomplete';
    const experimentSessionId =
      experiment.experimentSessionId === report.session.id ? sessionId : undefined;
    if (experiment.experimentSessionId && !experimentSessionId) {
      warnings.push(
        `Эксперимент ${experiment.id}: сессия результата отсутствует в отчёте и не будет связана`,
      );
    }

    const hadRunningStatus = status === 'running';
    if (hadRunningStatus) {
      warnings.push(`Эксперимент ${experiment.id} импортирован как незавершённый`);
    }

    experiments.push({
      id: `${prefix}-x${experiments.length}`,
      schemaVersion: SCHEMA_VERSION,
      baselineSessionId: sessionId,
      ...(experimentSessionId ? { experimentSessionId } : {}),
      tabId: finiteOr(experiment.tabId, report.session.tabId),
      url: sanitizeUrl(experiment.url),
      createdAt: finiteOr(experiment.createdAt, report.session.startedAt),
      startedAt: finiteOr(experiment.startedAt, report.session.startedAt),
      endedAt: isFiniteNumber(experiment.endedAt)
        ? experiment.endedAt
        : hadRunningStatus
          ? Date.now()
          : undefined,
      status: hadRunningStatus ? 'incomplete' : status,
      preset: oneOf(experiment.preset, EXPERIMENT_PRESETS) ?? 'custom',
      domains: sanitizeStringArray(experiment.domains, 20, 253),
      // DNR rules are never recreated for imported history.
      rules: [],
      ...(typeof experiment.note === 'string'
        ? { note: experiment.note.slice(0, 500) }
        : {}),
      baselineValues: sanitizeMetricValues(experiment.baselineValues),
      experimentValues: sanitizeMetricValues(experiment.experimentValues),
      comparison: sanitizeComparison(experiment.comparison),
      limitations: [
        ...sanitizeStringArray(experiment.limitations, 20, 512),
        'Импорт: правила блокировки не применялись',
      ],
      cleanupStatus: 'completed',
    });
  }

  const session: AuditSession = {
    id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    origin: 'imported',
    importedFrom: {
      sessionId: report.session.id,
      generatedAt: report.generatedAt,
      toolVersion: report.tool.version,
    },
    tabId: finiteOr(report.session.tabId, -1),
    ...(typeof report.session.documentId === 'string'
      ? { documentId: report.session.documentId.slice(0, 200) }
      : {}),
    url: sanitizeUrl(report.session.url),
    startedAt: finiteOr(report.session.startedAt, Date.now()),
    endedAt: isFiniteNumber(report.session.endedAt)
      ? report.session.endedAt
      : Date.now(),
    status: safeSessionStatus(report.session.status),
    browser: {
      name: report.session.browser.name,
      ...(typeof report.session.browser.version === 'string'
        ? { version: report.session.browser.version }
        : {}),
    },
    navigations,
    metrics,
    events,
    experimentIds: experiments.map((experiment) => experiment.id),
  };

  return { session, metrics, events, experiments, warnings };
}

/** True when this exact report (session id + generation time) is already stored. */
export function isSameImportedReport(
  session: Pick<AuditSession, 'importedFrom'>,
  report: Pick<JsonReport, 'session' | 'generatedAt'>,
): boolean {
  return (
    session.importedFrom?.sessionId === report.session.id &&
    session.importedFrom?.generatedAt === report.generatedAt
  );
}

export function importSummary(
  report: JsonReport,
  bundle: ImportBundle,
): ImportSummary {
  return {
    sourceSessionId: report.session.id,
    url: bundle.session.url,
    startedAt: bundle.session.startedAt,
    endedAt: bundle.session.endedAt,
    status: bundle.session.status,
    browser: bundle.session.browser,
    generatedAt: report.generatedAt,
    toolVersion: report.tool.version,
    metricCount: bundle.metrics.length,
    eventCount: bundle.events.length,
    experimentCount: bundle.experiments.length,
  };
}
