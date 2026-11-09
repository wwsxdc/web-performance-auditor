import { describe, expect, it, vi } from 'vitest';
import type { AuditSession } from '../types/session';
import type { CollectorStatus } from '../types/messages';
import { SCHEMA_VERSION } from '../constants/config';
import { startAudit } from './start-audit';

function makeSession(id = 'session-1'): AuditSession {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    tabId: 1,
    url: 'https://example.com/',
    startedAt: 1000,
    status: 'active',
    browser: { name: 'Chrome' },
    navigations: [],
    metrics: [],
    events: [],
    experimentIds: [],
  };
}

function makeDeps() {
  const statuses: Array<{ status: CollectorStatus; message?: string }> = [];
  const ended: Array<{ sessionId: string; status: AuditSession['status'] }> = [];
  return {
    statuses,
    ended,
    getTab: vi.fn(async () => ({ url: 'https://example.com/' })),
    startSession: vi.fn(async () => makeSession()),
    injectCollector: vi.fn(async () => undefined),
    endSession: vi.fn(async (sessionId: string, status: AuditSession['status']) => {
      ended.push({ sessionId, status });
    }),
    setCollectorStatus: vi.fn(async (status: CollectorStatus, message?: string) => {
      statuses.push({ status, message });
    }),
  };
}

describe('startAudit', () => {
  it('starts a session and injects the collector', async () => {
    const deps = makeDeps();
    const result = await startAudit(1, deps);

    expect(result.accessible).toBe(true);
    expect(result.session?.id).toBe('session-1');
    expect(deps.startSession).toHaveBeenCalledWith(1, 'https://example.com/');
    expect(deps.injectCollector).toHaveBeenCalledWith(1);
    expect(deps.ended).toEqual([]);
  });

  it('rejects system pages without creating a session', async () => {
    const deps = makeDeps();
    deps.getTab.mockResolvedValueOnce({ url: 'chrome://extensions/' });

    const result = await startAudit(1, deps);

    expect(result.accessible).toBe(false);
    expect(result.error).toContain('Системные страницы');
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.statuses).toEqual([{ status: 'unsupported', message: expect.any(String) }]);
  });

  it('reports permission-denied when injection throws and ends the session with error', async () => {
    const deps = makeDeps();
    deps.injectCollector.mockRejectedValueOnce(new Error('Cannot access contents of the page'));

    const result = await startAudit(1, deps);

    expect(result.accessible).toBe(false);
    expect(result.error).toContain('Cannot access contents');
    expect(deps.ended).toEqual([{ sessionId: 'session-1', status: 'error' }]);
    expect(deps.statuses.at(-1)?.status).toBe('permission-denied');
    expect(deps.statuses.at(-1)?.message).toContain('Не удалось подключиться к странице');
  });

  it('reports a generic error when the tab cannot be read', async () => {
    const deps = makeDeps();
    deps.getTab.mockRejectedValueOnce(new Error('No tab with id: 1'));

    const result = await startAudit(1, deps);

    expect(result.session).toBeUndefined();
    expect(result.error).toContain('No tab with id');
    expect(deps.statuses).toEqual([{ status: 'error', message: 'Error: No tab with id: 1' }]);
    expect(deps.startSession).not.toHaveBeenCalled();
  });
});
