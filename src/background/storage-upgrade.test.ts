import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';

const DB_NAME = 'wpa-store';

function openV2(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('by-tab', 'tabId');
      sessions.createIndex('by-date', 'startedAt');

      const metrics = db.createObjectStore('metrics', { keyPath: 'id' });
      metrics.createIndex('by-session', 'sessionId');
      metrics.createIndex('by-navigation', 'navigationId');

      const events = db.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-session', 'sessionId');
      events.createIndex('by-navigation', 'navigationId');

      const experiments = db.createObjectStore('experiments', { keyPath: 'id' });
      experiments.createIndex('by-session', 'sessionId');
      experiments.createIndex('by-date', 'createdAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function makeSession(id: string) {
  return {
    id,
    schemaVersion: 2,
    tabId: 1,
    url: 'https://example.com/',
    startedAt: Date.now(),
    status: 'completed',
    browser: { name: 'Chrome', version: '155' },
    navigations: [],
    experimentIds: [],
  };
}

afterAll(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe('IndexedDB v2 -> v3 upgrade', () => {
  it('migrates the experiments index and keeps old data queryable', async () => {
    const db = await openV2();
    await put(db, 'sessions', makeSession('b1'));
    await put(db, 'sessions', makeSession('r1'));
    await put(db, 'experiments', {
      id: 'exp-1',
      schemaVersion: 2,
      baselineSessionId: 'b1',
      experimentSessionId: 'r1',
      tabId: 1,
      url: 'https://example.com/',
      createdAt: 1,
      startedAt: 1,
      status: 'completed',
      preset: 'custom',
      domains: ['cdn.example.net'],
      rules: [{ id: 10_000, domains: ['cdn.example.net'] }],
      baselineValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: 1200, TTFB: 200 },
      experimentValues: { LCP: null, CLS: null, INP: null, FCP: null, TTFB: null },
      comparison: [],
      limitations: [],
    });
    db.close();

    // Importing storage now opens the same DB at DB_VERSION 3 and runs the
    // migration; the new indexes must resolve against the legacy record.
    const storage = await import('./storage');

    expect((await storage.getExperimentsForSession('b1')).map((item) => item.id)).toEqual([
      'exp-1',
    ]);
    expect((await storage.getExperimentsForSession('r1')).map((item) => item.id)).toEqual([
      'exp-1',
    ]);
    expect(await storage.getAllSessions()).toHaveLength(2);

    await storage.deleteSession('b1');
    expect(await storage.getExperiment('exp-1')).toBeUndefined();
    expect((await storage.getAllSessions()).map((session) => session.id)).toEqual(['r1']);
  });
});
