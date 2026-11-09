import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTORE_NAVIGATION_GRACE_MS, SessionManager } from './session-manager';
import * as storage from './storage';
import { validateJsonReport } from '../utils/report-schema';
import { makeImportReport } from '../test/report-fixture';
import { EVENT_BATCHING, STORAGE_LIMITS } from '../constants/config';

const localStore = new Map<string, unknown>();

const chromeMock = {
  storage: {
    local: {
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) localStore.set(key, value);
      }),
      get: vi.fn(async (key: string) => ({ [key]: localStore.get(key) })),
      remove: vi.fn(async (key: string) => {
        localStore.delete(key);
      }),
    },
  },
  tabs: {
    get: vi.fn(async (id: number) => {
      const pointer = localStore.get('activeSession') as { url?: string } | undefined;
      return { id, url: pointer?.url ?? 'https://example.com/' };
    }),
    query: vi.fn(async () => []),
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
};

beforeEach(() => {
  localStore.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

afterEach(async () => {
  await storage.clearAllData();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const rawId = (id: string): string => id.slice(id.indexOf(':') + 1);

function putRawSession(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wpa-store');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

describe('SessionManager', () => {
  it.each([
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; rv:159.0) Gecko/20100101 Firefox/159.0',
      name: 'Firefox',
      version: '159.0',
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/159.0.0.0 Safari/537.36 Edg/159.0.0.0',
      name: 'Edge',
      version: '159.0.0.0',
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/159.0.0.0 Safari/537.36 OPR/120.0.0.0',
      name: 'Opera',
      version: '120.0.0.0',
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/159.0.0.0 Safari/537.36',
      name: 'Chrome',
      version: '159.0.0.0',
    },
    { ua: 'Node.js/22', name: 'Unknown', version: undefined },
  ])('labels the session browser as $name', async ({ ua, name, version }) => {
    vi.stubGlobal('navigator', { userAgent: ua });
    const manager = new SessionManager();

    const session = await manager.startSession(1, 'https://example.com/');

    expect(session.browser).toEqual({ name, version });
  });

  it('keeps every metric update and sorts the session by observedAt', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addMetric({ id: 'u1', name: 'LCP', value: 2500, observedAt: 1000 }, 1);
    await manager.addMetric({ id: 'u2', name: 'LCP', value: 3000, observedAt: 2000 }, 1);
    await manager.addMetric({ id: 'u3', name: 'CLS', value: 0.1, observedAt: 1500 }, 1);
    await manager.addMetric(
      { id: 'u4', name: 'INP', value: null, status: 'unsupported', observedAt: 1700 },
      1,
    );

    const report = await manager.generateReport(session.id);

    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['u1', 'u3', 'u4', 'u2']);
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'u2')?.rating).toBe(
      'needs-improvement',
    );
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'u4')?.status).toBe(
      'unsupported',
    );
    expect(report?.limitations.some((item) => item.startsWith('FCP'))).toBe(true);
  });

  it('consolidates repeated callbacks for one metric instance in exports', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addMetric(
      { id: 'u1', metricId: 'lcp-instance', name: 'LCP', value: 2000, observedAt: 1000 },
      1,
    );
    await manager.addMetric(
      { id: 'u2', metricId: 'lcp-instance', name: 'LCP', value: 2500, observedAt: 2000 },
      1,
    );

    const report = await manager.generateReport(session.id);
    const state = await manager.getState();

    expect(report?.metrics).toHaveLength(1);
    expect(report?.metrics[0]?.value).toBe(2500);
    expect(state.session?.metrics).toHaveLength(2);
  });

  it('exports sanitized attribution and a schema-valid report', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(
      1,
      'https://example.com/page?token=secret#fragment',
    );

    await manager.addMetric(
      {
        id: 'm1',
        name: 'LCP',
        value: 2000,
        observedAt: 1000,
        attribution: {
          target: {
            targetId: 'target-1',
            selector: '#hero',
            capturedAt: 1000,
            available: true,
          },
          lcp: {
            timeToFirstByte: 200,
            resourceUrl: 'https://cdn.example.com/hero.js?token=secret',
          },
        },
      },
      1,
    );

    const report = await manager.generateReport(session.id);
    expect(report).not.toBeNull();
    expect(report?.attribution).toHaveLength(1);
    expect(report?.attribution[0]?.metricName).toBe('LCP');
    expect(report?.session.url).toBe('https://example.com/page');
    expect(report?.session.navigations[0]?.url).toBe('https://example.com/page');
    expect(report?.attribution[0]?.attribution.lcp?.resourceUrl).toBe(
      'https://cdn.example.com/hero.js',
    );
    expect(validateJsonReport(report)).toEqual({ valid: true, errors: [] });
  });

  it('keeps the ended session available and ends the previous one on restart', async () => {
    const manager = new SessionManager();
    const first = await manager.startSession(1, 'https://example.com/');
    await manager.addMetric({ id: 'u1', name: 'FCP', value: 1200, observedAt: 1000 }, 1);

    const second = await manager.startSession(1, 'https://example.com/');
    const state = await manager.getState();
    const firstReport = await manager.generateReport(first.id);

    expect(state.session?.id).toBe(second.id);
    expect(firstReport?.session.status).toBe('completed');
    expect(firstReport?.metrics).toHaveLength(1);
  });

  it('ignores metric updates from a different tab', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addMetric({ id: 'u1', name: 'LCP', value: 2500, observedAt: 1000 }, 2);

    const report = await manager.generateReport(session.id);
    expect(report?.metrics).toHaveLength(0);
  });

  it('keeps one session across document navigation and isolates document tokens', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/a');

    await manager.addMetric(
      { id: 'm1', name: 'LCP', value: 1000, observedAt: 1000, source: 'performance-api' },
      1,
      'doc-a',
    );

    const changed = await manager.handleNavigation(1, 'https://example.com/b', 'document');
    expect(changed).toBe(true);

    // A delayed metric from the previous document must not leak into the new one.
    await manager.addMetric({ id: 'm2', name: 'INP', value: 100, observedAt: 1500 }, 1, 'doc-a');
    await manager.addMetric({ id: 'm3', name: 'INP', value: 120, observedAt: 2000 }, 1, 'doc-b');
    await manager.addMetric({ id: 'm4', name: 'LCP', value: 2000, observedAt: 3000 }, 1, 'doc-b');

    const report = await manager.generateReport(session.id);
    expect(report?.session.status).toBe('active');
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['m1', 'm3', 'm4']);
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'm1')?.source).toBe(
      'performance-api',
    );
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'document',
    ]);
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'm4')?.navigationId).toBe(
      report?.session.navigations[1]?.id,
    );
  });

  it('waits for the experiment reload commit and always records its document segment', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/page', {
      awaitDocumentCommit: true,
    });

    await manager.addMetric(
      { id: 'old', name: 'LCP', value: 9000, observedAt: 1000 },
      1,
      'old-document',
    );

    const changed = await manager.handleNavigation(1, 'https://example.com/page', 'document');
    expect(changed).toBe(true);

    await manager.addMetric(
      { id: 'new', name: 'LCP', value: 2000, observedAt: 2000 },
      1,
      'new-document',
    );

    const report = await manager.generateReport(session.id);
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['new']);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'document',
    ]);
  });

  it('keeps a restored experiment gate after a service worker restart', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/page', {
      awaitDocumentCommit: true,
    });

    const restored = new SessionManager();
    await restored.restore();

    await restored.addMetric(
      { id: 'old', name: 'LCP', value: 9000, observedAt: 1000 },
      1,
      'old-document',
    );
    expect((await restored.generateReport(session.id))?.metrics).toHaveLength(0);

    await restored.handleNavigation(1, 'https://example.com/page', 'document');
    await restored.addMetric(
      { id: 'new', name: 'LCP', value: 2000, observedAt: 2000 },
      1,
      'new-document',
    );

    const report = await restored.generateReport(session.id);
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['new']);
  });

  it('namespaces long-task and metric cross-references with the session id', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addMetric(
      {
        id: 'inp',
        name: 'INP',
        value: 200,
        observedAt: 2000,
        attribution: {
          inp: { interactionType: 'keydown' },
          longTaskIds: ['task-1'],
        },
      },
      1,
    );
    await manager.addEvent(
      {
        id: 'task-1',
        type: 'long-task',
        timestamp: 1000,
        duration: 300,
        relatedMetricIds: ['inp'],
      },
      1,
    );

    const report = await manager.generateReport(session.id);
    const metric = report?.metrics.find((item) => rawId(item.id) === 'inp');
    const event = report?.events.find((item) => rawId(item.id) === 'task-1');

    expect(metric?.attribution?.longTaskIds).toEqual([event?.id]);
    expect(event?.relatedMetricIds).toEqual([metric?.id]);
  });

  it('keeps rows from both sessions when collector ids are reused on one page', async () => {
    const manager = new SessionManager();
    const first = await manager.startSession(1, 'https://example.com/');
    await manager.addMetric({ id: 'shared', name: 'LCP', value: 1000, observedAt: 1000 }, 1);
    await manager.addEvent(
      { id: 'shared-event', type: 'long-task', timestamp: 1000, duration: 100 },
      1,
    );

    const second = await manager.startSession(1, 'https://example.com/');
    await manager.addMetric({ id: 'shared', name: 'LCP', value: 2000, observedAt: 2000 }, 1);
    await manager.addEvent(
      { id: 'shared-event', type: 'long-task', timestamp: 2000, duration: 100 },
      1,
    );

    const firstReport = await manager.generateReport(first.id);
    const secondReport = await manager.generateReport(second.id);
    expect(firstReport?.metrics.map((metric) => metric.value)).toEqual([1000]);
    expect(secondReport?.metrics.map((metric) => metric.value)).toEqual([2000]);
    expect(firstReport?.events).toHaveLength(1);
    expect(secondReport?.events).toHaveLength(1);
    expect(firstReport?.metrics[0]?.id).not.toBe(secondReport?.metrics[0]?.id);
  });

  it('stores diagnostic events and rejects stale document tokens', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/a');

    await manager.addEvent(
      { id: 'e1', type: 'long-task', timestamp: 1000, duration: 300 },
      1,
      'doc-a',
    );
    await manager.handleNavigation(1, 'https://example.com/b', 'document');
    await manager.addEvent(
      { id: 'e2', type: 'long-task', timestamp: 1500, duration: 200 },
      1,
      'doc-a',
    );
    await manager.addEvent(
      { id: 'e3', type: 'interaction', timestamp: 2000, duration: 120 },
      1,
      'doc-b',
    );
    await manager.addEvent(
      { id: 'e4', type: 'unknown' as never, timestamp: 2500 },
      1,
      'doc-b',
    );
    await manager.addEvent(
      { id: 'e5', type: 'long-task', timestamp: 3000 },
      2,
      'doc-b',
    );

    const report = await manager.generateReport(session.id);
    expect(report?.events.map((event) => rawId(event.id))).toEqual(['e1', 'e3']);
    expect(report?.events.find((event) => rawId(event.id) === 'e3')?.navigationId).toBe(
      report?.session.navigations[1]?.id,
    );
  });

  it('attaches SPA diagnostic events to the active SPA segment', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/app');
    await manager.handleNavigation(1, 'https://example.com/app/settings', 'spa');

    await manager.addEvent(
      { id: 'e1', type: 'long-task', timestamp: 1000, duration: 300 },
      1,
      'doc-a',
    );

    const report = await manager.generateReport(session.id);
    const spaNavigation = report?.session.navigations.find(
      (navigation) => navigation.kind === 'spa',
    );
    const longTasks = report?.events.filter((event) => event.type === 'long-task') ?? [];
    const spaEvents = report?.events.filter((event) => event.type === 'spa-navigation') ?? [];
    expect(longTasks).toHaveLength(1);
    expect(longTasks[0]?.navigationId).toBe(spaNavigation?.id);
    expect(spaEvents).toHaveLength(1);
    expect(spaEvents[0]?.navigationId).toBe(spaNavigation?.id);
    expect(spaEvents[0]?.details?.url).toBe('https://example.com/app/settings');
    expect(session.navigations[0]?.id).not.toBe(spaNavigation?.id);
  });

  it('restores an active session after a service worker restart', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/');
    await first.addMetric({ id: 'm1', name: 'LCP', value: 1200, observedAt: 1000 }, 1);

    const restored = new SessionManager();
    await restored.restore();

    const state = await restored.getState();
    expect(state.session?.id).toBe(session.id);
    expect(state.session?.status).toBe('active');
    expect(state.collectorStatus).toBe('collecting');
    expect(restored.isActiveForTab(1)).toBe(true);
  });

  it('keeps the app state usable when a stored session cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new SessionManager();
    await manager.startSession(1, 'https://example.com/');
    const read = vi.spyOn(storage, 'getSession').mockRejectedValueOnce(new Error('damaged db'));

    const state = await manager.getState();

    expect(state.session).toBeNull();
    expect(state.error).toContain('Не удалось прочитать');
    read.mockRestore();
    warn.mockRestore();
  });

  it('clears a pointer to a session that no longer exists', async () => {
    localStore.set('activeSession', {
      id: 'deleted-session',
      tabId: 1,
      url: 'https://example.com/',
      navigationId: 'navigation-1',
    });

    const manager = new SessionManager();
    await manager.restore();

    expect(localStore.has('activeSession')).toBe(false);
    expect((await manager.getState()).session).toBeNull();
  });

  it('drops a malformed pointer instead of retrying it on every cold start', async () => {
    localStore.set('activeSession', { id: 'broken-session' });

    const manager = new SessionManager();
    await manager.restore();

    expect(localStore.has('activeSession')).toBe(false);
    expect((await manager.getState()).session).toBeNull();
  });

  it('interrupts a restored session when its tab was closed while the worker slept', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/');
    await first.addMetric({ id: 'm1', name: 'LCP', value: 1200, observedAt: 1000 }, 1);
    chromeMock.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 1'));

    const restored = new SessionManager();
    await restored.restore();

    const report = await restored.generateReport(session.id);
    expect(report?.session.status).toBe('interrupted');
    expect(report?.metrics).toHaveLength(1);
    expect(localStore.has('activeSession')).toBe(false);
    expect(restored.isActiveForTab(1)).toBe(false);
  });

  it('keeps the restored document token and rejects the retired one after rotation', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/');
    await first.addMetric(
      { id: 'm1', name: 'LCP', value: 1200, observedAt: 1000 },
      1,
      'doc-a',
    );

    const restored = new SessionManager();
    await restored.restore();

    // The document that was already open before the restart still owns the
    // restored token.
    await restored.addMetric(
      { id: 'm2', name: 'INP', value: 150, observedAt: 2000 },
      1,
      'doc-a',
    );
    // A reload while the worker was asleep legitimately rotates the token.
    await restored.addMetric(
      { id: 'm3', name: 'INP', value: 180, observedAt: 3000 },
      1,
      'doc-b',
    );
    // Late callbacks from the retired document must never resurface.
    await restored.addMetric(
      { id: 'm4', name: 'INP', value: 999, observedAt: 4000 },
      1,
      'doc-a',
    );
    await restored.addMetric(
      { id: 'm5', name: 'CLS', value: 0.05, observedAt: 5000 },
      1,
      'doc-b',
    );

    const report = await restored.generateReport(session.id);
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual([
      'm1',
      'm2',
      'm3',
      'm5',
    ]);
  });

  it('restores and writes back a session stored under the v1 schema', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/legacy');
    const pointer = localStore.get('activeSession') as {
      navigationId?: string;
      tabId: number;
    };
    await putRawSession({
      id: session.id,
      schemaVersion: 1,
      tabId: 1,
      url: 'https://example.com/legacy',
      startedAt: session.startedAt,
      status: 'active',
      browser: 'Chrome',
      navigationId: pointer.navigationId,
    });

    const restored = new SessionManager();
    await restored.restore();

    const state = await restored.getState();
    expect(state.session?.id).toBe(session.id);
    expect(state.session?.schemaVersion).toBe(2);
    expect(state.session?.status).toBe('active');
    expect(state.session?.navigations.map((navigation) => navigation.id)).toEqual([
      pointer.navigationId,
    ]);

    await restored.addMetric(
      { id: 'm1', name: 'LCP', value: 1200, observedAt: 1000 },
      1,
    );

    const report = await restored.generateReport(session.id);
    expect(report?.metrics).toHaveLength(1);
    expect(report?.metrics[0]?.navigationId).toBe(pointer.navigationId);
  });

  it('applies an SPA navigation queued while restore is still pending', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/app');

    const restored = new SessionManager();
    const restorePromise = restored.restore();
    const navigated = await restored.handleNavigation(
      1,
      'https://example.com/app/settings',
      'spa',
    );
    await restorePromise;

    expect(navigated).toBe(true);
    const report = await restored.generateReport(session.id);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'spa',
    ]);
    expect(report?.events.filter((event) => event.type === 'spa-navigation')).toHaveLength(1);
  });

  it('applies a navigation queued while restore is still pending', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/a');

    const restored = new SessionManager();
    const restorePromise = restored.restore();
    const navigated = await restored.handleNavigation(1, 'https://example.com/b', 'document');
    await restorePromise;

    expect(navigated).toBe(true);
    const report = await restored.generateReport(session.id);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'document',
    ]);
  });

  it('keeps a restored session when the tab URL changed while asleep', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/');
    await first.addEvent(
      { id: 'old-event', type: 'long-task', timestamp: 1000, duration: 50 },
      1,
      'doc-a',
    );
    chromeMock.tabs.get.mockResolvedValueOnce({
      id: 1,
      url: 'https://example.com/other',
    });

    const restored = new SessionManager();
    await restored.restore();

    const state = await restored.getState();
    expect(state.session?.status).toBe('active');
    expect(state.collectorStatus).toBe('initializing');
    expect(restored.isActiveForTab(1)).toBe(true);

    // The segment must come from the queued navigation, not from a URL guess.
    await restored.addMetric({ id: 'stale', name: 'LCP', value: 900, observedAt: 900 }, 1, 'doc-b');
    expect((await restored.generateReport(session.id))?.metrics).toHaveLength(0);

    const navigated = await restored.handleNavigation(
      1,
      'https://example.com/other',
      'document',
    );
    expect(navigated).toBe(true);
    await restored.addMetric({ id: 'new', name: 'LCP', value: 1200, observedAt: 1200 }, 1, 'doc-b');

    const report = await restored.generateReport(session.id);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'document',
    ]);
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['new']);
  });

  it('interrupts a restored session when the URL change never gets a navigation event', async () => {
    const first = new SessionManager();
    const session = await first.startSession(1, 'https://example.com/');
    await first.addEvent(
      { id: 'old-event', type: 'long-task', timestamp: 1000, duration: 50 },
      1,
      'doc-a',
    );
    chromeMock.tabs.get.mockResolvedValueOnce({
      id: 1,
      url: 'https://example.com/other',
    });

    const restored = new SessionManager();
    await restored.restore();
    expect((await restored.getState()).session?.status).toBe('active');

    await new Promise((resolve) =>
      setTimeout(resolve, RESTORE_NAVIGATION_GRACE_MS + 600),
    );

    const report = await restored.generateReport(session.id);
    expect(report?.session.status).toBe('interrupted');
    expect(restored.isActiveForTab(1)).toBe(false);
  });

  it('attributes load-metric updates to the document segment after SPA navigation', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/app');
    const documentNavigationId = session.navigations[0]?.id;
    await manager.handleNavigation(1, 'https://example.com/app/settings', 'spa');
    const spaNavigationId = (await manager.generateReport(session.id))?.session.navigations[1]?.id;

    await manager.addEvent(
      { id: 'lcp-update', type: 'metric-update', timestamp: 2000, details: { metric: 'LCP' } },
      1,
    );
    await manager.addEvent(
      { id: 'cls-update', type: 'metric-update', timestamp: 2001, details: { metric: 'CLS' } },
      1,
    );

    const report = await manager.generateReport(session.id);
    const lcpEvent = report?.events.find((event) => rawId(event.id) === 'lcp-update');
    const clsEvent = report?.events.find((event) => rawId(event.id) === 'cls-update');
    expect(lcpEvent?.navigationId).toBe(documentNavigationId);
    expect(clsEvent?.navigationId).toBe(spaNavigationId);
  });

  it('records a same-URL reload as a new document segment', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/page');

    const changed = await manager.handleNavigation(
      1,
      'https://example.com/page',
      'document',
      'reload',
    );

    expect(changed).toBe(true);
    const report = await manager.generateReport(session.id);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'document',
    ]);
  });

  it('records repeated SPA transitions to the same URL as separate segments', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/app');

    await manager.handleNavigation(1, 'https://example.com/app', 'spa');
    await manager.handleNavigation(1, 'https://example.com/app', 'spa');

    const report = await manager.generateReport(session.id);
    expect(report?.session.navigations.map((navigation) => navigation.kind)).toEqual([
      'document',
      'spa',
      'spa',
    ]);
    expect(report?.events.filter((event) => event.type === 'spa-navigation')).toHaveLength(2);
  });

  it('enforces the per-session metric limit', async () => {
    const originalLimit = STORAGE_LIMITS.maxMetricsPerSession;
    STORAGE_LIMITS.maxMetricsPerSession = 3;
    try {
      const manager = new SessionManager();
      const session = await manager.startSession(1, 'https://example.com/');

      for (let index = 0; index < 5; index++) {
        await manager.addMetric(
          {
            id: `m${index}`,
            name: 'LCP',
            value: 1000 + index,
            observedAt: 1000 + index,
          },
          1,
        );
      }

      const report = await manager.generateReport(session.id);
      expect(report?.metrics).toHaveLength(3);
    } finally {
      STORAGE_LIMITS.maxMetricsPerSession = originalLimit;
    }
  });

  it('keeps processing queued operations after one fails', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    // A function value is not structured-cloneable, so the IDB write rejects.
    await expect(
      manager.addMetric(
        {
          id: 'bad',
          name: 'LCP',
          value: 1000,
          observedAt: 1000,
          attribution: { fn: () => undefined } as never,
        },
        1,
      ),
    ).rejects.toBeDefined();

    await manager.addMetric({ id: 'good', name: 'LCP', value: 2000, observedAt: 2000 }, 1);
    const report = await manager.generateReport(session.id);
    expect(report?.metrics.map((metric) => rawId(metric.id))).toEqual(['good']);
  });

  it('includes collector limitations in exported report limitations', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addEvent(
      {
        id: 'limitation-1',
        type: 'collector-limitation',
        timestamp: 1000,
        details: { message: 'LongTask: исторические записи недоступны' },
      },
      1,
    );

    const report = await manager.generateReport(session.id);
    expect(report?.limitations).toContain('LongTask: исторические записи недоступны');
  });

  it('enforces the per-session diagnostic event limit', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    for (let index = 0; index < 505; index++) {
      await manager.addEvent(
        {
          id: `e${index}`,
          type: 'long-task',
          timestamp: 1000 + index,
          duration: 100,
        },
        1,
      );
    }

    const report = await manager.generateReport(session.id);
    expect(report?.events).toHaveLength(500);
  });

  it('serializes a session replacement against an in-flight metric update', async () => {
    const manager = new SessionManager();
    const first = await manager.startSession(1, 'https://example.com/');

    let replacement: { id: string } | undefined = undefined;
    let replacementPromise: Promise<void> = Promise.resolve();
    chromeMock.storage.local.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) localStore.set(key, value);
      // Queue the replacement without awaiting it: it must wait for the metric
      // write to finish rather than interleave with it.
      replacementPromise = manager.startSession(1, 'https://example.com/').then((session) => {
        replacement = session;
      });
    });

    await manager.addMetric({ id: 'm1', name: 'LCP', value: 1000, observedAt: 1000 }, 1, 'doc-x');
    await replacementPromise;

    expect(replacement).toBeDefined();
    expect((await manager.generateReport(replacement!.id))?.metrics).toHaveLength(0);
    expect((await manager.generateReport(first.id))?.metrics).toHaveLength(1);
  });

  it('serializes a session replacement against an in-flight event update', async () => {
    const manager = new SessionManager();
    const first = await manager.startSession(1, 'https://example.com/');

    let replacement: { id: string } | undefined = undefined;
    let replacementPromise: Promise<void> = Promise.resolve();
    chromeMock.storage.local.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) localStore.set(key, value);
      replacementPromise = manager.startSession(1, 'https://example.com/').then((session) => {
        replacement = session;
      });
    });

    await manager.addEvent(
      { id: 'e1', type: 'long-task', timestamp: 1000, duration: 300 },
      1,
      'doc-x',
    );
    await replacementPromise;

    expect(replacement).toBeDefined();
    expect((await manager.generateReport(replacement!.id))?.events).toHaveLength(0);
    expect((await manager.generateReport(first.id))?.events).toHaveLength(1);
  });

  it('buffers diagnostic events and writes them as one batch', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    for (let index = 0; index < 5; index++) {
      await manager.addEvent(
        { id: `e${index}`, type: 'long-task', timestamp: 1000 + index, duration: 100 },
        1,
      );
    }

    // Below the batch size nothing has hit IndexedDB yet, but the live state
    // already exposes the buffered events.
    expect(await storage.countEvents(session.id)).toBe(0);
    expect((await manager.getState()).session?.events).toHaveLength(5);

    await manager.flushEvents();
    expect(await storage.countEvents(session.id)).toBe(5);
  });

  it('flushes a full batch without an explicit flush call', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    for (let index = 0; index < EVENT_BATCHING.batchSize; index++) {
      await manager.addEvent(
        { id: `e${index}`, type: 'long-task', timestamp: 1000 + index, duration: 100 },
        1,
      );
    }

    expect(await storage.countEvents(session.id)).toBe(EVENT_BATCHING.batchSize);
  });

  it('flushes buffered events on navigation, stop, and reset', async () => {
    const manager = new SessionManager();

    const first = await manager.startSession(1, 'https://example.com/a');
    await manager.addEvent(
      { id: 'e1', type: 'long-task', timestamp: 1000, duration: 100 },
      1,
    );
    await manager.handleNavigation(1, 'https://example.com/b', 'document');
    expect(await storage.countEvents(first.id)).toBe(1);

    await manager.addEvent(
      { id: 'e2', type: 'long-task', timestamp: 2000, duration: 100 },
      1,
    );
    await manager.endSession(first.id, 'completed');
    expect(await storage.countEvents(first.id)).toBe(2);

    const second = await manager.startSession(1, 'https://example.com/c');
    await manager.addEvent(
      { id: 'e3', type: 'long-task', timestamp: 3000, duration: 100 },
      1,
    );
    await manager.reset();
    expect(await storage.countEvents(second.id)).toBe(1);
    expect((await manager.getState()).session).toBeNull();
  });

  it('keeps redelivered event ids idempotent', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    const event = { id: 'e1', type: 'long-task' as const, timestamp: 1000, duration: 100 };
    await manager.addEvent(event, 1);
    await manager.addEvent(event, 1);
    await manager.flushEvents();
    // Redelivery after the write must not create a second row either.
    await manager.addEvent(event, 1);
    await manager.flushEvents();

    expect(await storage.countEvents(session.id)).toBe(1);
    const report = await manager.generateReport(session.id);
    expect(report?.events).toHaveLength(1);
  });

  it('does not let redelivered events consume the session event limit', async () => {
    const originalLimit = STORAGE_LIMITS.maxEventsPerSession;
    STORAGE_LIMITS.maxEventsPerSession = 3;
    try {
      const manager = new SessionManager();
      const session = await manager.startSession(1, 'https://example.com/');

      await manager.addEvent({ id: 'e0', type: 'long-task', timestamp: 1000 }, 1);
      await manager.addEvent({ id: 'e1', type: 'long-task', timestamp: 1001 }, 1);
      for (let index = 0; index < 5; index++) {
        await manager.addEvent({ id: 'e1', type: 'long-task', timestamp: 1001 }, 1);
      }
      await manager.addEvent({ id: 'e2', type: 'long-task', timestamp: 1002 }, 1);
      await manager.addEvent({ id: 'e3', type: 'long-task', timestamp: 1003 }, 1);

      const report = await manager.generateReport(session.id);
      expect(report?.events.map((event) => rawId(event.id))).toEqual(['e0', 'e1', 'e2']);
      expect(await storage.countEvents(session.id)).toBe(3);
    } finally {
      STORAGE_LIMITS.maxEventsPerSession = originalLimit;
    }
  });

  it('persists the rest of a batch when one event cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');

    await manager.addEvent(
      {
        id: 'bad',
        type: 'long-task',
        timestamp: 1000,
        // Functions are not structured-cloneable, so IndexedDB rejects it.
        details: { fn: () => undefined } as never,
      },
      1,
    );
    await manager.addEvent(
      { id: 'good', type: 'long-task', timestamp: 1001, duration: 50 },
      1,
    );
    await manager.flushEvents();

    expect(await storage.countEvents(session.id)).toBe(1);
    const report = await manager.generateReport(session.id);
    expect(report?.events.map((event) => rawId(event.id))).toEqual(['good']);
    warn.mockRestore();
  });

  it('writes far fewer transactions than events for a burst', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/');
    const saveEvents = vi.spyOn(storage, 'saveEvents');
    const saveEvent = vi.spyOn(storage, 'saveEvent');

    for (let index = 0; index < 100; index++) {
      await manager.addEvent(
        { id: `e${index}`, type: 'long-task', timestamp: 1000 + index, duration: 100 },
        1,
      );
    }
    await manager.flushEvents();

    const writes = saveEvents.mock.calls.length + saveEvent.mock.calls.length;
    expect(await storage.countEvents(session.id)).toBe(100);
    expect(writes).toBeLessThan(100);
    expect(writes).toBeLessThanOrEqual(Math.ceil(100 / EVENT_BATCHING.batchSize) + 1);
    saveEvents.mockRestore();
    saveEvent.mockRestore();
  });

  it('records SPA transitions without replacing the document-load metrics', async () => {
    const manager = new SessionManager();
    const session = await manager.startSession(1, 'https://example.com/app');
    const documentNavigationId = session.navigations[0]?.id;

    await manager.handleNavigation(1, 'https://example.com/app/settings', 'spa');
    await manager.addMetric({ id: 'm1', name: 'LCP', value: 1000, observedAt: 1000 }, 1, 'doc-a');
    await manager.addMetric({ id: 'm2', name: 'INP', value: 150, observedAt: 2000 }, 1, 'doc-a');

    const report = await manager.generateReport(session.id);
    const spaNavigation = report?.session.navigations.find(
      (navigation) => navigation.kind === 'spa',
    );

    expect(report?.session.status).toBe('active');
    expect(spaNavigation).toBeDefined();
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'm1')?.navigationId).toBe(
      documentNavigationId,
    );
    expect(report?.metrics.find((metric) => rawId(metric.id) === 'm2')?.navigationId).toBe(
      spaNavigation?.id,
    );
  });
});

describe('SessionManager import and history', () => {
  it('imports an exported report and shows it while idle', async () => {
    const manager = new SessionManager();
    const result = await manager.importReport(makeImportReport());

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.summary?.metricCount).toBe(1);
    expect(result.warnings?.join(' ')).toContain('прерванная');

    const state = await manager.getState();
    expect(state.session?.id).toBe(result.sessionId);
    expect(state.session?.origin).toBe('imported');
    expect(state.session?.metrics).toHaveLength(1);
    expect(state.session?.events).toHaveLength(1);

    const list = await manager.getSessionList();
    expect(list.some((summary) => summary.id === result.sessionId)).toBe(true);
  });

  it('rejects the same report twice without duplicating history', async () => {
    const manager = new SessionManager();
    await manager.importReport(makeImportReport());
    const second = await manager.importReport(makeImportReport());

    expect(second.error).toContain('уже импортирован');
    expect(await manager.getSessionList()).toHaveLength(1);
  });

  it('rejects a report with an unsafe URL and writes nothing', async () => {
    const manager = new SessionManager();
    const report = makeImportReport();
    report.session.url = 'javascript:alert(1)';

    const result = await manager.importReport(report);

    expect(result.error).toContain('URL сессии');
    expect(await manager.getSessionList()).toEqual([]);
  });

  it('keeps the active audit untouched while importing', async () => {
    const manager = new SessionManager();
    const active = await manager.startSession(1, 'https://example.com/');
    const result = await manager.importReport(makeImportReport());

    expect(result.success).toBe(true);
    const state = await manager.getState();
    expect(state.session?.id).toBe(active.id);
    expect(state.session?.status).toBe('active');
    expect((await manager.getSessionList()).map((summary) => summary.id)).toContain(
      result.sessionId,
    );
  });

  it('refuses to select another session while an audit is running', async () => {
    const manager = new SessionManager();
    await manager.startSession(1, 'https://example.com/');
    const imported = await manager.importReport(makeImportReport());
    const selected = await manager.selectSession(imported.sessionId!);

    expect(selected.error).toContain('остановите наблюдение');
  });

  it('selects an imported session after the audit stops', async () => {
    const manager = new SessionManager();
    const active = await manager.startSession(1, 'https://example.com/');
    const imported = await manager.importReport(makeImportReport());
    await manager.endSession(active.id, 'completed');

    const selected = await manager.selectSession(imported.sessionId!);

    expect(selected.success).toBe(true);
    expect((await manager.getState()).session?.id).toBe(imported.sessionId);
  });

  it('deletes an imported session and exposes the next newest one', async () => {
    const manager = new SessionManager();
    const older = await manager.startSession(1, 'https://example.com/');
    await manager.endSession(older.id, 'completed');
    const imported = await manager.importReport(makeImportReport());

    const deleted = await manager.deleteSession(imported.sessionId!);

    expect(deleted.success).toBe(true);
    expect((await manager.getSessionList()).map((summary) => summary.id)).toEqual([older.id]);
    // The older session becomes the visible fallback after the deletion.
    const state = await manager.getState();
    expect(state.session?.id).toBe(older.id);
  });

  it('refuses to delete the active session', async () => {
    const manager = new SessionManager();
    const active = await manager.startSession(1, 'https://example.com/');

    const result = await manager.deleteSession(active.id);

    expect(result.error).toContain('активную');
    expect(await manager.getSessionById(active.id)).toBeDefined();
  });
});
