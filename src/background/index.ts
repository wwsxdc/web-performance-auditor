import { handleMessage } from './message-router';
import { SessionManager } from './session-manager';
import { ExperimentManager } from './experiment-manager';
import { cleanOldSessions } from './storage';
import { getSettings } from './settings';
import { logDiagnostic } from './diagnostics';
import { injectCollector } from './injector';
import { isAuditableUrl } from '../utils/url';
import { PAGE_COLLECTOR_SCRIPT_ID, PAGE_SCRIPT_FILE } from '../constants/config';
import { extensionApi, getSidebarAction, toggleSidebar } from '../browser/api';

// All listeners registered synchronously at top level (MV3 requirement)
const sessionManager = new SessionManager();
const experimentManager = new ExperimentManager(sessionManager);

// Instrument pages at document_start so FCP/CLS/INP/LCP are observed even when
// the user opens the side panel long after the page has loaded. The bridge
// (content script) is still injected on demand on SESSION_START.
async function ensurePageCollector(): Promise<void> {
  try {
    await extensionApi.scripting.registerContentScripts([{
      id: PAGE_COLLECTOR_SCRIPT_ID,
      js: [PAGE_SCRIPT_FILE],
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
    }]);
  } catch (err) {
    // The script stays registered across service-worker restarts.
      if (!String(err).includes('Duplicate script ID')) {
        console.warn('[WPA] Failed to register page collector:', err);
        void logDiagnostic('register-collector', err);
      }
  }
}

async function reinjectIfActive(tabId: number): Promise<void> {
  if (!sessionManager.isActiveForTab(tabId)) return;
  try {
    await injectCollector(tabId);
  } catch (err) {
    // The document may not be ready yet; DOMContentLoaded/onCompleted retries.
    console.warn('[WPA] Collector re-injection failed:', err);
    void logDiagnostic('reinject-collector', err);
  }
}

// Restoration runs exactly once per service-worker lifetime. It is memoized
// (never reset) so that awaiting it before every message cannot re-run
// experimentManager.restore() and tear down an in-flight experiment.
let restorePromise: Promise<void> | null = null;

function restoreAndReinject(): Promise<void> {
  if (!restorePromise) {
    restorePromise = (async () => {
      // Enqueue the session restore before any retention work so navigation
      // listeners that fire during a cold start are applied to the restored
      // session instead of being dropped against an empty state.
      const restore = sessionManager.restore();
      const settings = await getSettings().catch(() => undefined);
      await cleanOldSessions(settings?.retentionDays).catch(console.error);
      await restore;
      await experimentManager.restore();
      const tabId = sessionManager.getActiveTabId();
      if (tabId !== null) {
        await reinjectIfActive(tabId);
      }
    })().catch(console.error);
  }
  return restorePromise;
}

void ensurePageCollector();

// Primary surface: Side Panel on action click. Firefox has no Side Panel API,
// so the toolbar button toggles the `sidebar_action` declared in the Firefox
// manifest. Builds without either surface keep the popup fallback (FR-16,
// NFR 4.5).
function configurePrimarySurface(): void {
  if (extensionApi.sidePanel?.setPanelBehavior) {
    extensionApi.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(console.error);
    return;
  }

  const sidebar = getSidebarAction();
  if (sidebar) {
    extensionApi.action?.onClicked?.addListener(() => {
      void toggleSidebar(sidebar);
    });
    return;
  }

  if (extensionApi.action?.setPopup) {
    Promise.resolve(
      extensionApi.action.setPopup({ popup: 'src/popup/index.html' }),
    ).catch((error) => {
      console.warn('[WPA] Failed to register popup fallback:', error);
    });
  }
}

configurePrimarySurface();

// Handle all extension messages
extensionApi.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    void (async () => {
      // Restore first so message handling (e.g. CLEAR_HISTORY) never races the
      // cold-start restore and its experiment pointer/session rules.
      await restoreAndReinject().catch(console.error);
      handleMessage(message, sender, sendResponse, sessionManager, experimentManager);
    })();
    return true; // Keep message channel open for async response
  },
);

// Handle tab closure
extensionApi.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await experimentManager.cancelForTab(tabId);
    await sessionManager.endSessionForTab(tabId);
  })().catch(console.error);
});

// Document navigation: keep one audit session and add a document segment.
extensionApi.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  void (async () => {
    const urlCheck = isAuditableUrl(details.url);
    if (!urlCheck.auditable) {
      await sessionManager.endSessionForTab(details.tabId, 'interrupted');
      return;
    }

    await sessionManager.handleNavigation(
      details.tabId,
      details.url,
      'document',
      details.transitionType,
    );
    await reinjectIfActive(details.tabId);
  })().catch(console.error);
});

// SPA (History API and hash) navigations are recorded separately and never
// create synthetic document-load metrics.
extensionApi.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    void sessionManager
      .handleNavigation(details.tabId, details.url, 'spa')
      .catch(console.error);
  }
});

extensionApi.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId === 0) {
    void sessionManager
      .handleNavigation(details.tabId, details.url, 'spa')
      .catch(console.error);
  }
});

// Retry bridge injection if the document was not ready at commit time.
extensionApi.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId === 0) {
    void reinjectIfActive(details.tabId).catch(console.error);
  }
});

extensionApi.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) {
    void reinjectIfActive(details.tabId).catch(console.error);
  }
});

// Restore state after service worker restart
extensionApi.runtime.onStartup.addListener(() => {
  void restoreAndReinject().catch(console.error);
});

// On install: ensure the collector is registered. Retention cleanup is handled
// by the memoized restore path so it never runs twice per service worker.
extensionApi.runtime.onInstalled.addListener(() => {
  console.log('[WPA] Extension installed/updated');
  void ensurePageCollector();
});

// Best effort: persist buffered diagnostic events before the worker is
// suspended. Lifecycle operations (stop, navigation, reset) flush explicitly.
// Firefox event pages do not expose onSuspend; the guard keeps registration
// harmless there.
extensionApi.runtime.onSuspend?.addListener(() => {
  void sessionManager.flushEvents().catch(console.error);
});

// Restore on script evaluation (covers SW restart)
void restoreAndReinject().catch(console.error);
