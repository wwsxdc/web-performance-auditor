import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from './message-router';
import type { ExperimentManager } from './experiment-manager';
import type { SessionManager } from './session-manager';

function createManagers(activeTabId: number | null, activeSessionId: string | null) {
  const sessionManager = {
    getActiveTabId: vi.fn(() => activeTabId),
    getActiveSessionId: vi.fn(() => activeSessionId),
  } as unknown as SessionManager;
  const experimentManager = {
    start: vi.fn(async () => ({ experiment: { id: 'experiment-1' } })),
  } as unknown as ExperimentManager;
  return { sessionManager, experimentManager };
}

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'extension-id' },
  };
});

describe('handleMessage', () => {
  it('rejects messages from another extension', () => {
    const sendResponse = vi.fn();
    const { sessionManager, experimentManager } = createManagers(1, 'session-1');

    handleMessage(
      { type: 'EXPERIMENT_LIST', requestId: 'request-1' },
      { id: 'other-extension' } as chrome.runtime.MessageSender,
      sendResponse,
      sessionManager,
      experimentManager,
    );

    expect(sendResponse).toHaveBeenCalledWith({ error: 'Unauthorized sender' });
  });

  it('rejects an experiment that is not tied to the active session', async () => {
    const sendResponse = vi.fn();
    const { sessionManager, experimentManager } = createManagers(1, 'session-1');

    handleMessage(
      {
        type: 'EXPERIMENT_START',
        requestId: 'request-2',
        tabId: 2,
        baselineSessionId: 'session-1',
        preset: 'analytics',
        domains: ['google-analytics.com'],
      },
      { id: 'extension-id' } as chrome.runtime.MessageSender,
      sendResponse,
      sessionManager,
      experimentManager,
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({
      error: 'Эксперимент должен относиться к активной сессии',
    });
    expect(experimentManager.start).not.toHaveBeenCalled();
  });

  it('starts an experiment for the active tab and session', async () => {
    const sendResponse = vi.fn();
    const { sessionManager, experimentManager } = createManagers(1, 'session-1');

    handleMessage(
      {
        type: 'EXPERIMENT_START',
        requestId: 'request-3',
        tabId: 1,
        baselineSessionId: 'session-1',
        preset: 'analytics',
        domains: ['google-analytics.com'],
      },
      { id: 'extension-id' } as chrome.runtime.MessageSender,
      sendResponse,
      sessionManager,
      experimentManager,
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(experimentManager.start).toHaveBeenCalledWith({
      baselineSessionId: 'session-1',
      tabId: 1,
      preset: 'analytics',
      domains: ['google-analytics.com'],
      note: undefined,
    });
    expect(sendResponse).toHaveBeenCalledWith({
      experiment: { id: 'experiment-1' },
    });
  });
});
