import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTORE_NAVIGATION_GRACE_MS, SessionManager } from './session-manager';
import * as storage from './storage';
import { validateJsonReport } from '../utils/report-schema';
import { STORAGE_LIMITS } from '../constants/config';

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
  vi.clearAllMocks();
});

const rawId = (id: string): string => id.slice(id.indexOf(':') + 1);

describe('SessionManager', () => {
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
