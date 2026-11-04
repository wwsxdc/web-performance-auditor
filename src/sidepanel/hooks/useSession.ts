import { useState, useEffect, useCallback } from 'react';
import type { AppState } from '../../types/messages';
import type { MetricName } from '../../types/metrics';
import { generateId } from '../../utils/id';
import {
  getActiveTab,
  onRuntimeMessage,
  onTabActivated,
  onTabUpdated,
  sendRuntimeMessage,
} from '../api';

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
      const tab = await getActiveTab();
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
    sendRuntimeMessage<{ state?: AppState; error?: string }>({
      type: 'GET_STATE',
      requestId: generateId(),
    })
      .then((response) => {
        setState(response?.state ?? { ...EMPTY_STATE, error: response?.error });
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
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (!changeInfo.url) return;
      setState((prev) => {
        if (!prev) return prev;
        const activeTabId = prev.session?.tabId ?? prev.activeTabId;
        if (
          activeTabId !== undefined &&
          activeTabId !== null &&
          tabId !== activeTabId
        ) {
          return prev;
        }
        return { ...prev, activeTabUrl: changeInfo.url ?? prev.activeTabUrl };
      });
    };

    const removeActivated = onTabActivated(onActivated);
    const removeUpdated = onTabUpdated(onUpdated);

    return () => {
      removeActivated();
      removeUpdated();
    };
  }, [refreshActiveTab]);

  useEffect(
    () =>
      onRuntimeMessage((message) => {
        if (message.type === 'STATE_UPDATE') {
          setState(message.state);
        }
      }),
    [],
  );

  const startSession = useCallback(async () => {
    try {
      const tab = await getActiveTab(true);
      if (!tab?.id) {
        setState((prev) => (prev ? { ...prev, collectorStatus: 'error', error: 'Активная вкладка не найдена' } : prev));
        return;
      }

      const response = await sendRuntimeMessage<StartSessionResponse>({
        type: 'SESSION_START',
        requestId: generateId(),
        tabId: tab.id,
      });

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
      if (tabId === undefined || tabId === null) {
        return { available: false, reason: 'Вкладка не определена' };
      }

      try {
        return await sendRuntimeMessage<{ available?: boolean; reason?: string }>({
          type: 'HIGHLIGHT_TARGET',
          requestId: generateId(),
          tabId,
          target,
        });
      } catch (err) {
        console.error('[WPA UI] Failed to highlight target:', err);
        return { available: false, reason: String(err) };
      }
    },
    [state?.session?.tabId, state?.activeTabId],
  );

  const clearHighlight = useCallback(async (metricName?: MetricName) => {
    const tabId = state?.session?.tabId ?? state?.activeTabId;
    if (tabId === undefined || tabId === null) return;
    try {
      await sendRuntimeMessage({
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
      await sendRuntimeMessage({
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
