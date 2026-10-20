import { useState, useEffect, useCallback } from 'react';
import type { AppState, ExtensionMessage } from '../../types/messages';
import type { MetricName } from '../../types/metrics';
import { generateId } from '../../utils/id';

interface HighlightRequest {
  targetId?: string;
  selector?: string;
  color: 'green' | 'red' | 'yellow';
  label?: string;
  metricName?: MetricName;
}

interface StartSessionResponse {
  session?: AppState['session'];
  error?: string;
  accessible?: boolean;
}

const EMPTY_STATE: AppState = {
  session: null,
  collectorStatus: 'idle',
  activeTabId: null,
  activeTabUrl: null,
  activeNavigationId: null,
};

export function useSession() {
  const [state, setState] = useState<AppState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshActiveTab = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          activeTabId: tab?.id ?? prev.activeTabId,
          activeTabUrl: tab?.url ?? prev.activeTabUrl,
        };
      });
    } catch {
      // Ignore: the panel still works without tab metadata.
    }
  }, []);

  useEffect(() => {
    chrome.runtime
      .sendMessage({
        type: 'GET_STATE',
        requestId: generateId(),
      })
      .then((response: { state?: AppState }) => {
        setState(response?.state ?? EMPTY_STATE);
        setIsLoading(false);
      })
      .catch(() => {
        setState(EMPTY_STATE);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!isLoading) {
      void refreshActiveTab();
    }
  }, [isLoading, refreshActiveTab]);

  useEffect(() => {
    const onActivated = () => {
      void refreshActiveTab();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (changeInfo.url) {
        setState((prev) => (prev ? { ...prev, activeTabUrl: changeInfo.url ?? prev.activeTabUrl } : prev));
      }
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshActiveTab]);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'STATE_UPDATE') {
        setState(message.state);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const startSession = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setState((prev) => (prev ? { ...prev, collectorStatus: 'error', error: 'Активная вкладка не найдена' } : prev));
        return;
      }

      const response = (await chrome.runtime.sendMessage({
        type: 'SESSION_START',
        requestId: generateId(),
        tabId: tab.id,
      })) as StartSessionResponse | undefined;

      if (response?.error) {
        setState((prev) =>
          prev
            ? { ...prev, error: response.error }
            : { ...EMPTY_STATE, error: response.error },
        );
        return;
      }

      if (response?.session) {
        setState((prev) => {
          const current = prev?.session;
          const nextSession = current?.id === response.session?.id ? current : response.session;
          return prev
            ? { ...prev, session: nextSession ?? null, error: undefined }
            : { ...EMPTY_STATE, session: nextSession ?? null, error: undefined };
        });
      }
    } catch (err) {
      console.error('[WPA UI] Failed to start session:', err);
      setState((prev) =>
        prev
          ? { ...prev, collectorStatus: 'error', error: String(err) }
          : { ...EMPTY_STATE, collectorStatus: 'error', error: String(err) },
      );
    }
  }, []);

  const highlightTarget = useCallback(
    async (target: HighlightRequest) => {
      const tabId = state?.session?.tabId ?? state?.activeTabId;
      if (tabId === undefined) return { available: false, reason: 'Вкладка не определена' };

      try {
        return (await chrome.runtime.sendMessage({
          type: 'HIGHLIGHT_TARGET',
          requestId: generateId(),
          tabId,
          target,
        })) as { available?: boolean; reason?: string } | undefined;
      } catch (err) {
        console.error('[WPA UI] Failed to highlight target:', err);
        return { available: false, reason: String(err) };
      }
    },
    [state?.session?.tabId, state?.activeTabId],
  );

  const clearHighlight = useCallback(async (metricName?: MetricName) => {
    const tabId = state?.session?.tabId ?? state?.activeTabId;
    if (tabId === undefined) return;
    try {
      await chrome.runtime.sendMessage({
        type: 'CLEAR_HIGHLIGHT',
        requestId: generateId(),
        tabId,
        metricName,
      });
    } catch {
      // The page or service worker may be gone.
    }
  }, [state?.session?.tabId, state?.activeTabId]);

  const stopSession = useCallback(async () => {
    if (!state?.session?.id) return;
    await clearHighlight();
    try {
      await chrome.runtime.sendMessage({
        type: 'SESSION_STOP',
        requestId: generateId(),
        sessionId: state.session.id,
      });
    } catch (err) {
      console.error('[WPA UI] Failed to stop session:', err);
    }
  }, [state?.session?.id, clearHighlight]);

  useEffect(() => {
    const onPageHide = () => {
      void clearHighlight();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [clearHighlight]);

  return {
    state,
    startSession,
    stopSession,
    highlightTarget,
    clearHighlight,
    isLoading,
  };
}
