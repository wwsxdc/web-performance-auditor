import { openDB, type IDBPDatabase } from 'idb';
import type { AuditSession, SessionSummary, StoredSession } from '../types/session';
import type { MetricRecord } from '../types/metrics';
import type { DiagnosticEvent } from '../types/events';
import type { Experiment } from '../types/experiment';
import type { ImportBundle } from '../utils/report-import';
import { SCHEMA_VERSION, STORAGE_LIMITS } from '../constants/config';
import {
  inspectStoredExperiment,
  inspectStoredSession,
  migrateStoredExperiment,
  migrateStoredSession,
} from './migrations';

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

function storedId(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const id = (record as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function needsMigration(record: unknown): boolean {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  );
}

type VersionedRecord = { schemaVersion?: unknown };

/**
 * Writes a migrated snapshot only if the stored record is still on an old
 * schema. The check runs inside the same transaction as the write, so a
 * concurrent save (SessionManager/ExperimentManager) either wins before us —
 * making the stored version current and skipping the write — or overwrites the
 * migration afterwards. This keeps an old read from resurrecting stale status.
 */
async function writeMigratedSessions(
  db: IDBPDatabase,
  sessions: StoredSession[],
): Promise<void> {
  if (sessions.length === 0) return;
  const tx = db.transaction('sessions', 'readwrite');
  for (const session of sessions) {
    const current = (await tx.store.get(session.id)) as VersionedRecord | undefined;
    if (current && current.schemaVersion !== SCHEMA_VERSION) {
      await tx.store.put(session);
    }
  }
  await tx.done;
}

async function writeMigratedExperiments(
  db: IDBPDatabase,
  experiments: Experiment[],
): Promise<void> {
  if (experiments.length === 0) return;
  const tx = db.transaction('experiments', 'readwrite');
  for (const experiment of experiments) {
    const current = (await tx.store.get(experiment.id)) as VersionedRecord | undefined;
    if (current && current.schemaVersion !== SCHEMA_VERSION) {
      await tx.store.put(experiment);
    }
  }
  await tx.done;
}

/**
 * Reads one session through the migration registry and writes supported older
 * records back in the current schema. Write-through keeps later list scans from
 * repeating the same work and makes the upgrade observable in storage.
 */
async function readSessionRecord(
  db: IDBPDatabase,
  sessionId: string,
): Promise<StoredSession | undefined> {
  const raw = await db.get('sessions', sessionId);
  const session = migrateStoredSession(raw);
  if (!session) return undefined;
  if (needsMigration(raw)) await writeMigratedSessions(db, [session]);
  return session;
}

async function readAllSessionRecords(db: IDBPDatabase): Promise<StoredSession[]> {
  const raw = (await db.getAll('sessions')) as unknown[];
  const sessions: StoredSession[] = [];
  const migrated: StoredSession[] = [];
  for (const record of raw) {
    const session = migrateStoredSession(record);
    if (!session) continue;
    sessions.push(session);
    if (needsMigration(record)) migrated.push(session);
  }
  await writeMigratedSessions(db, migrated);
  return sessions;
}

async function readExperimentRecord(
  db: IDBPDatabase,
  experimentId: string,
): Promise<Experiment | undefined> {
  const raw = await db.get('experiments', experimentId);
  const experiment = migrateStoredExperiment(raw);
  if (!experiment) return undefined;
  if (needsMigration(raw)) await writeMigratedExperiments(db, [experiment]);
  return experiment;
}

async function readAllExperimentRecords(db: IDBPDatabase): Promise<Experiment[]> {
  const raw = (await db.getAll('experiments')) as unknown[];
  const experiments: Experiment[] = [];
  const migrated: Experiment[] = [];
  for (const record of raw) {
    const experiment = migrateStoredExperiment(record);
    if (!experiment) continue;
    experiments.push(experiment);
    if (needsMigration(record)) migrated.push(experiment);
  }
  await writeMigratedExperiments(db, migrated);
  return experiments;
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

export async function getExperiment(experimentId: string): Promise<Experiment | undefined> {
  const db = await getDb();
  return readExperimentRecord(db, experimentId);
}

export async function getAllExperiments(): Promise<Experiment[]> {
  const db = await getDb();
  const experiments = await readAllExperimentRecords(db);
  return experiments.sort((left, right) => right.createdAt - left.createdAt);
}

export async function getExperimentsForSession(sessionId: string): Promise<Experiment[]> {
  const db = await getDb();
  // Scanning the (bounded) experiment store also finds v1 records whose
  // baseline/result ids were not indexed yet.
  const experiments = await readAllExperimentRecords(db);
  return experiments
    .filter(
      (experiment) =>
        experiment.baselineSessionId === sessionId ||
        experiment.experimentSessionId === sessionId,
    )
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function getSession(sessionId: string): Promise<AuditSession | undefined> {
  const db = await getDb();
  const session = await readSessionRecord(db, sessionId);
  if (!session) return undefined;

  const metrics = await db.getAllFromIndex('metrics', 'by-session', sessionId) as MetricRecord[];
  const events = await db.getAllFromIndex('events', 'by-session', sessionId) as DiagnosticEvent[];

  // IndexedDB returns records ordered by primary key, not by time.
  metrics.sort((a, b) => a.observedAt - b.observedAt);
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    ...session,
    metrics,
    events,
  };
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
  return readAllSessionRecords(db);
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
  const sessions = (await readAllSessionRecords(db))
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, Math.max(0, limit));
  const experiments = await readAllExperimentRecords(db);
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
  let deleted = 0;

  // Migrate supported experiments first. Unknown/future schema records are
  // kept in place: this build cannot read them, but deleting them would make a
  // temporary downgrade destroy data that a newer build still understands.
  // Only structurally malformed records are dropped.
  const experiments: Experiment[] = [];
  // Sessions referenced by a running experiment from a newer schema. Retention
  // cannot migrate that experiment, but deleting its sessions would leave it
  // dangling once the newer build runs again.
  const unreadableRunningSessionIds = new Set<string>();
  for (const record of (await db.getAll('experiments')) as unknown[]) {
    const inspection = inspectStoredExperiment(record);
    if (!inspection.experiment) {
      if (inspection.kind === 'future' || inspection.kind === 'unsupported') {
        const raw = record as Record<string, unknown>;
        if (raw.status === 'running') {
          for (const key of ['baselineSessionId', 'experimentSessionId']) {
            if (typeof raw[key] === 'string') unreadableRunningSessionIds.add(raw[key]);
          }
        }
        continue;
      }
      const id = storedId(record);
      if (id) await db.delete('experiments', id);
      continue;
    }
    experiments.push(inspection.experiment);
    if (needsMigration(record)) await writeMigratedExperiments(db, [inspection.experiment]);
  }

  const sessions: StoredSession[] = [];
  for (const record of (await db.getAllFromIndex('sessions', 'by-date')) as unknown[]) {
    const inspection = inspectStoredSession(record);
    if (!inspection.session) {
      // Keep unknown/future records; only drop records that cannot be a
      // session at all under any known or future schema.
      if (inspection.kind === 'future' || inspection.kind === 'unsupported') continue;
      const id = storedId(record);
      if (id) {
        await deleteSession(id);
        deleted++;
      }
      continue;
    }
    const session = inspection.session;
    sessions.push(session);
    // SessionManager.restore() runs concurrently with startup retention. The
    // conditional write inside the helper lets its fresher record win.
    if (needsMigration(record)) await writeMigratedSessions(db, [session]);
  }

  // Protect every session referenced by an experiment (running or completed),
  // otherwise retention would cascade-delete a finished experiment and lose its
  // result. Explicit deletions still cascade through deleteSession().
  const protectedSessionIds = new Set(
    experiments
      .flatMap((experiment) => [experiment.baselineSessionId, experiment.experimentSessionId])
      .filter((id): id is string => typeof id === 'string'),
  );
  // Unreadable running experiments cannot be migrated, but their sessions must
  // survive age-based retention as well; otherwise the newer build would find a
  // running experiment without its baseline/result.
  for (const id of unreadableRunningSessionIds) protectedSessionIds.add(id);
  // A running experiment must never be disturbed; finished ones only hold the
  // hard maxSessions bound so the stored count stays bounded.
  const runningSessionIds = new Set(
    experiments
      .filter((experiment) => experiment.status === 'running')
      .flatMap((experiment) => [experiment.baselineSessionId, experiment.experimentSessionId])
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const id of unreadableRunningSessionIds) runningSessionIds.add(id);

  for (const session of sessions) {
    if (
      session.startedAt < cutoff &&
      session.status !== 'active' &&
      !protectedSessionIds.has(session.id)
    ) {
      await deleteSession(session.id);
      deleted++;
    }
  }

  // Enforce the max sessions bound without deleting the session that is
  // currently being audited. The raw count also includes unreadable
  // future/unsupported records: those cannot be evicted, so the bound can only
  // be approximate while such records exist, but readable history is still
  // trimmed to leave room for them.
  const allSessions = await readAllSessionRecords(db);
  const storedSessionCount = await db.count('sessions');
  let excess = storedSessionCount - STORAGE_LIMITS.maxSessions;
  if (excess > 0) {
    const remaining = new Set(allSessions.map((session) => session.id));
    const statusById = new Map(allSessions.map((session) => [session.id, session.status]));
    const sorted = [...allSessions].sort((a, b) => a.startedAt - b.startedAt);

    const canDelete = (id: string): boolean =>
      remaining.has(id) &&
      statusById.get(id) !== 'active' &&
      !runningSessionIds.has(id);

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
