import { openDB, type IDBPDatabase } from 'idb';
import type { AuditSession, ImportedReportSource, SessionSummary } from '../types/session';
import type { MetricRecord } from '../types/metrics';
import type { DiagnosticEvent } from '../types/events';
import type { Experiment } from '../types/experiment';
import type { ImportBundle } from '../utils/report-import';
import { SCHEMA_VERSION, STORAGE_LIMITS } from '../constants/config';

const DB_NAME = 'wpa-store';
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id' });
          store.createIndex('by-tab', 'tabId');
          store.createIndex('by-date', 'startedAt');
        }
        if (!db.objectStoreNames.contains('metrics')) {
          const store = db.createObjectStore('metrics', { keyPath: 'id' });
          store.createIndex('by-session', 'sessionId');
        }
        if (!db.objectStoreNames.contains('events')) {
          const store = db.createObjectStore('events', { keyPath: 'id' });
          store.createIndex('by-session', 'sessionId');
        }

        // v2: navigation-level indexes and experiment storage.
        if (oldVersion < 2) {
          const metrics = tx.objectStore('metrics');
          if (!metrics.indexNames.contains('by-navigation')) {
            metrics.createIndex('by-navigation', 'navigationId');
          }
          const events = tx.objectStore('events');
          if (!events.indexNames.contains('by-navigation')) {
            events.createIndex('by-navigation', 'navigationId');
          }
        }

        if (!db.objectStoreNames.contains('experiments')) {
          const store = db.createObjectStore('experiments', { keyPath: 'id' });
          store.createIndex('by-baseline-session', 'baselineSessionId');
          store.createIndex('by-experiment-session', 'experimentSessionId');
          store.createIndex('by-date', 'createdAt');
        } else if (oldVersion < 3) {
          // v3: replace the dead `sessionId` index (Experiment has no such
          // field) with real baseline/result session indexes.
          const store = tx.objectStore('experiments');
          if (store.indexNames.contains('by-session')) store.deleteIndex('by-session');
          if (!store.indexNames.contains('by-baseline-session')) {
            store.createIndex('by-baseline-session', 'baselineSessionId');
          }
          if (!store.indexNames.contains('by-experiment-session')) {
            store.createIndex('by-experiment-session', 'experimentSessionId');
          }
        }
      },
    });
  }
  return dbPromise;
}

export interface StoredSession {
  id: string;
  schemaVersion: number;
  origin?: 'imported';
  importedFrom?: ImportedReportSource;
  tabId: number;
  documentId?: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  browser: { name: string; version?: string };
  navigations: Array<{
    id: string;
    sessionId: string;
    url: string;
    kind: 'document' | 'spa';
    startedAt: number;
    endedAt?: number;
    source?: string;
  }>;
  experimentIds: string[];
}

function hasSupportedSchemaVersion(record: { schemaVersion?: unknown }): boolean {
  return record.schemaVersion === SCHEMA_VERSION;
}

export async function saveSession(session: AuditSession): Promise<void> {
  const db = await getDb();
  const { metrics: _metrics, events: _events, ...sessionData } = session;
  await db.put('sessions', { ...sessionData, schemaVersion: SCHEMA_VERSION });
}

export async function saveMetric(metric: MetricRecord): Promise<void> {
  const db = await getDb();
  await db.put('metrics', metric);
}

export async function saveEvent(event: DiagnosticEvent): Promise<void> {
  const db = await getDb();
  await db.put('events', event);
}

// Writes a whole batch in a single readwrite transaction. Event ids are
// namespaced with the session id, so `put` keeps redelivery idempotent.
// Returns the number of records the transaction committed.
export async function saveEvents(events: DiagnosticEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const db = await getDb();
  const tx = db.transaction('events', 'readwrite');
  await Promise.all([...events.map((event) => tx.store.put(event)), tx.done]);
  return events.length;
}

export async function saveExperiment(experiment: Experiment): Promise<void> {
  const db = await getDb();
  await db.put('experiments', experiment);
}

function normalizeExperiment(experiment: Experiment): Experiment {
  // Experiments created before domains were persisted have no array; the
  // setup comparer and the UI both iterate it.
  const normalized: Experiment = Array.isArray(experiment.domains)
    ? experiment
    : { ...experiment, domains: [] };
  const status = normalized.cleanupStatus;
  if (status === 'pending' || status === 'completed' || status === 'failed') {
    return normalized;
  }
  // Records created before cleanupStatus was introduced have no value.
  return {
    ...normalized,
    cleanupStatus: normalized.status === 'running' ? 'pending' : 'completed',
  };
}

export async function getExperiment(experimentId: string): Promise<Experiment | undefined> {
  const db = await getDb();
  const experiment = (await db.get('experiments', experimentId)) as Experiment | undefined;
  return experiment && hasSupportedSchemaVersion(experiment)
    ? normalizeExperiment(experiment)
    : undefined;
}

export async function getAllExperiments(): Promise<Experiment[]> {
  const db = await getDb();
  const experiments = (await db.getAll('experiments')) as Experiment[];
  return experiments
    .filter(hasSupportedSchemaVersion)
    .map(normalizeExperiment)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function getExperimentsForSession(sessionId: string): Promise<Experiment[]> {
  const db = await getDb();
  const asBaseline = await db.getAllFromIndex(
    'experiments',
    'by-baseline-session',
    sessionId,
  ) as Experiment[];
  const asResult = await db.getAllFromIndex(
    'experiments',
    'by-experiment-session',
    sessionId,
  ) as Experiment[];
  const unique = new Map<string, Experiment>();
  for (const experiment of [...asBaseline, ...asResult]) {
    if (!hasSupportedSchemaVersion(experiment)) continue;
    unique.set(experiment.id, normalizeExperiment(experiment));
  }
  return [...unique.values()].sort((left, right) => right.createdAt - left.createdAt);
}

export async function getSession(sessionId: string): Promise<AuditSession | undefined> {
  const db = await getDb();
  const session = await db.get('sessions', sessionId) as StoredSession | undefined;
  if (!session || !hasSupportedSchemaVersion(session)) return undefined;

  const metrics = await db.getAllFromIndex('metrics', 'by-session', sessionId) as MetricRecord[];
  const events = await db.getAllFromIndex('events', 'by-session', sessionId) as DiagnosticEvent[];

  // IndexedDB returns records ordered by primary key, not by time.
  metrics.sort((a, b) => a.observedAt - b.observedAt);
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    ...session,
    status: session.status as AuditSession['status'],
    metrics,
    events,
  } as AuditSession;
}

export async function getSessionMetrics(sessionId: string): Promise<MetricRecord[]> {
  const db = await getDb();
  const metrics = await db.getAllFromIndex('metrics', 'by-session', sessionId) as MetricRecord[];
  metrics.sort((a, b) => a.observedAt - b.observedAt);
  return metrics;
}

export async function countEvents(sessionId: string): Promise<number> {
  const db = await getDb();
  return db.countFromIndex('events', 'by-session', sessionId);
}

export async function countMetrics(sessionId: string): Promise<number> {
  const db = await getDb();
  return db.countFromIndex('metrics', 'by-session', sessionId);
}

export async function getAllSessions(): Promise<StoredSession[]> {
  const db = await getDb();
  const sessions = await db.getAll('sessions') as StoredSession[];
  return sessions.filter(hasSupportedSchemaVersion);
}

export class ImportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportLimitError';
  }
}

export class DuplicateImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateImportError';
  }
}

/**
 * History rows for the side panel. Counts are read per session so the list can
 * show how much data each row holds without loading metrics/events themselves.
 */
export async function getSessionSummaries(limit = STORAGE_LIMITS.maxSessions): Promise<SessionSummary[]> {
  const db = await getDb();
  const sessions = (await db.getAll('sessions') as StoredSession[])
    .filter(hasSupportedSchemaVersion)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, Math.max(0, limit));
  const experiments = ((await db.getAll('experiments')) as Experiment[]).filter(
    hasSupportedSchemaVersion,
  );
  const experimentCounts = new Map<string, number>();
  for (const experiment of experiments) {
    for (const sessionId of [experiment.baselineSessionId, experiment.experimentSessionId]) {
      if (typeof sessionId !== 'string') continue;
      experimentCounts.set(sessionId, (experimentCounts.get(sessionId) ?? 0) + 1);
    }
  }

  return Promise.all(
    sessions.map(async (session): Promise<SessionSummary> => ({
      id: session.id,
      url: session.url,
      startedAt: session.startedAt,
      ...(typeof session.endedAt === 'number' && Number.isFinite(session.endedAt)
        ? { endedAt: session.endedAt }
        : {}),
      status: session.status as AuditSession['status'],
      metricCount: await db.countFromIndex('metrics', 'by-session', session.id),
      eventCount: await db.countFromIndex('events', 'by-session', session.id),
      experimentCount: experimentCounts.get(session.id) ?? 0,
      ...(session.origin === 'imported' ? { origin: 'imported' as const } : {}),
      ...(session.importedFrom ? { importedFrom: session.importedFrom } : {}),
    })),
  );
}

/** Returns the existing record for this exact exported report, if any. */
export async function findImportedSession(
  sourceSessionId: string,
  generatedAt: string,
): Promise<StoredSession | undefined> {
  const sessions = await getAllSessions();
  return sessions.find(
    (session) =>
      session.importedFrom?.sessionId === sourceSessionId &&
      session.importedFrom?.generatedAt === generatedAt,
  );
}

/**
 * Writes the whole imported report in a single transaction. A failure anywhere
 * rolls the transaction back, so a half-imported session never appears in the
 * history. Existing sessions are never modified: every id is fresh.
 */
export async function importSessionBundle(bundle: ImportBundle): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'metrics', 'events', 'experiments'], 'readwrite');
  const sessionStore = tx.objectStore('sessions');

  // Enforce bounds before any write so the transaction stays empty on rejection.
  if ((await sessionStore.count()) >= STORAGE_LIMITS.maxSessions) {
    throw new ImportLimitError(
      `История заполнена (${STORAGE_LIMITS.maxSessions} сессий). Удалите старые сессии или уменьшите срок хранения.`,
    );
  }

  const source = bundle.session.importedFrom;
  const alreadyImported = ((await sessionStore.getAll()) as StoredSession[]).some(
    (session) =>
      Boolean(source) &&
      session.importedFrom?.sessionId === source?.sessionId &&
      session.importedFrom?.generatedAt === source?.generatedAt,
  );
  if (alreadyImported) {
    throw new DuplicateImportError('Этот отчёт уже импортирован');
  }

  const { metrics: _metrics, events: _events, ...sessionData } = bundle.session;
  await sessionStore.put({ ...sessionData, schemaVersion: SCHEMA_VERSION });

  const metricStore = tx.objectStore('metrics');
  for (const metric of bundle.metrics) {
    await metricStore.put(metric);
  }
  const eventStore = tx.objectStore('events');
  for (const event of bundle.events) {
    await eventStore.put(event);
  }
  const experimentStore = tx.objectStore('experiments');
  for (const experiment of bundle.experiments) {
    await experimentStore.put(experiment);
  }

  await tx.done;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'metrics', 'events', 'experiments'], 'readwrite');
  await tx.objectStore('sessions').delete(sessionId);

  // Experiments reference both a baseline and a result session. Remove any
  // experiment that would otherwise point at the deleted session.
  const experimentStore = tx.objectStore('experiments');
  const asBaseline = await experimentStore
    .index('by-baseline-session')
    .getAll(sessionId) as Experiment[];
  const asResult = await experimentStore
    .index('by-experiment-session')
    .getAll(sessionId) as Experiment[];
  const experimentIds = new Set([...asBaseline, ...asResult].map((experiment) => experiment.id));
  for (const experimentId of experimentIds) {
    await experimentStore.delete(experimentId);
  }

  const metricStore = tx.objectStore('metrics');
  const metricsIndex = metricStore.index('by-session');
  let metricCursor = await metricsIndex.openCursor(sessionId);
  while (metricCursor) {
    await metricCursor.delete();
    metricCursor = await metricCursor.continue();
  }

  const eventStore = tx.objectStore('events');
  const eventsIndex = eventStore.index('by-session');
  let eventCursor = await eventsIndex.openCursor(sessionId);
  while (eventCursor) {
    await eventCursor.delete();
    eventCursor = await eventCursor.continue();
  }

  await tx.done;
}

export async function cleanOldSessions(
  retentionDays = STORAGE_LIMITS.sessionRetentionDays,
): Promise<number> {
  const db = await getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const sessions = await db.getAllFromIndex('sessions', 'by-date') as StoredSession[];
  const allExperiments = (await db.getAll('experiments')) as Experiment[];
  // Records written by an incompatible schema are unreadable by design; drop
  // them during retention so they can never resurrect a running experiment.
  for (const experiment of allExperiments) {
    if (!hasSupportedSchemaVersion(experiment)) {
      await db.delete('experiments', experiment.id);
    }
  }
  const experiments = allExperiments.filter(hasSupportedSchemaVersion);
  // Protect every session referenced by an experiment (running or completed),
  // otherwise retention would cascade-delete a finished experiment and lose its
  // result. Explicit deletions still cascade through deleteSession().
  const protectedSessionIds = new Set(
    experiments
      .flatMap((experiment) => [experiment.baselineSessionId, experiment.experimentSessionId])
      .filter((id): id is string => typeof id === 'string'),
  );
  // A running experiment must never be disturbed; finished ones only hold the
  // hard maxSessions bound so the stored count stays bounded.
  const runningSessionIds = new Set(
    experiments
      .filter((experiment) => experiment.status === 'running')
      .flatMap((experiment) => [experiment.baselineSessionId, experiment.experimentSessionId])
      .filter((id): id is string => typeof id === 'string'),
  );
  let deleted = 0;

  for (const session of sessions) {
    const supported = hasSupportedSchemaVersion(session);
    if (
      !supported ||
      (session.startedAt < cutoff &&
        session.status !== 'active' &&
        !protectedSessionIds.has(session.id))
    ) {
      await deleteSession(session.id);
      deleted++;
    }
  }

  // Also enforce max sessions limit without deleting the session that is
  // currently being audited.
  const allSessions = await db.getAll('sessions') as StoredSession[];
  let excess = allSessions.length - STORAGE_LIMITS.maxSessions;
  if (excess > 0) {
    const remaining = new Set(allSessions.map((session) => session.id));
    const statusById = new Map(allSessions.map((session) => [session.id, session.status]));
    const supportedById = new Map(
      allSessions.map((session) => [session.id, hasSupportedSchemaVersion(session)]),
    );
    const sorted = [...allSessions].sort((a, b) => a.startedAt - b.startedAt);

    const canDelete = (id: string): boolean =>
      remaining.has(id) &&
      (!supportedById.get(id) ||
        (statusById.get(id) !== 'active' && !runningSessionIds.has(id)));

    for (const session of sorted) {
      if (excess <= 0) break;
      if (!canDelete(session.id)) continue;

      // Evict both sessions of a finished experiment together so no dangling
      // baseline/result pair is left behind.
      const paired = experiments.filter(
        (experiment) =>
          experiment.status !== 'running' &&
          (experiment.baselineSessionId === session.id ||
            experiment.experimentSessionId === session.id),
      );
      const toDelete = new Set<string>([session.id]);
      for (const experiment of paired) {
        toDelete.add(experiment.baselineSessionId);
        if (experiment.experimentSessionId) toDelete.add(experiment.experimentSessionId);
      }

      for (const id of toDelete) {
        if (!canDelete(id)) continue;
        await deleteSession(id);
        remaining.delete(id);
        statusById.delete(id);
        deleted++;
        excess--;
      }
    }
  }

  return deleted;
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'metrics', 'events', 'experiments'], 'readwrite');
  await tx.objectStore('sessions').clear();
  await tx.objectStore('metrics').clear();
  await tx.objectStore('events').clear();
  await tx.objectStore('experiments').clear();
  await tx.done;
}
