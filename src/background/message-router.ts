import type { ExtensionMessage } from '../types/messages';
import type { SessionManager } from './session-manager';
import type { ExperimentManager } from './experiment-manager';
import { isAuditableUrl } from '../utils/url';
import { isExtensionMessage } from '../utils/validation';
import { generateId } from '../utils/id';
import { generateMarkdownReport } from '../utils/markdown';
import { validateJsonReport } from '../utils/report-schema';
import { injectCollector } from './injector';
import { getSettings, updateRetentionDays } from './settings';
import { cleanOldSessions } from './storage';
import { clearDiagnostics, getDiagnostics, logDiagnostic } from './diagnostics';

export function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
  sessionManager: SessionManager,
  experimentManager: ExperimentManager,
): void {
  if (!isExtensionMessage(message)) {
    sendResponse({ error: 'Invalid message format' });
    return;
  }

  // Messages from content scripts and extension pages must belong to us.
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'Unauthorized sender' });
    return;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'SESSION_START':
          await handleSessionStart(message, sessionManager, sendResponse);
          break;

        case 'SESSION_STOP': {
          // 5.4: a session id is not proof of authority; only the session that
          // is currently being audited may be stopped from the panel.
          if (message.sessionId !== sessionManager.getActiveSessionId()) {
            sendResponse({ error: 'Сессия не является активной' });
            break;
          }
          const experiment = await experimentManager.finishForSession(message.sessionId);
          if (!experiment) {
            const session = await sessionManager.getSessionById(message.sessionId);
            await sessionManager.endSession(message.sessionId, 'completed');
            if (session) {
              await chrome.tabs
                .sendMessage(session.tabId, {
                  type: 'COLLECTOR_STOP',
                  requestId: generateId(),
                })
                .catch(() => {
                  // The tab may already be closed; stopping the session is enough.
                });
            }
          }
          sendResponse({ success: true, experiment });
          break;
        }

        case 'METRIC_UPDATE': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ error: 'Metric update must come from a tab' });
            break;
          }
          await sessionManager.addMetric(message.metric, tabId, message.documentToken);
          sendResponse({ success: true });
          break;
        }

        case 'EVENT_UPDATE': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ error: 'Event update must come from a tab' });
            break;
          }
          await sessionManager.addEvent(message.event, tabId, message.documentToken);
          sendResponse({ success: true });
          break;
        }

        case 'HIGHLIGHT_TARGET': {
          if (
            message.tabId !== sessionManager.getActiveTabId() ||
            sessionManager.getActiveSessionId() === null
          ) {
            sessionManager.setOverlayStatus(null);
            sendResponse({
              success: false,
              available: false,
              reason: 'Нет активной сессии для этой вкладки',
            });
            break;
          }
          try {
            const response = await chrome.tabs.sendMessage(message.tabId, message) as
              | { available?: boolean; reason?: string }
              | undefined;
            const available = response?.available === true;
            sessionManager.setOverlayStatus({
              targetId: message.target.targetId,
              available,
              reason: available ? undefined : response?.reason ?? 'Элемент не найден',
            });
            sendResponse({ success: available, available, reason: response?.reason });
          } catch (err) {
            sessionManager.setOverlayStatus({
              targetId: message.target.targetId,
              available: false,
              reason: 'Не удалось связаться со страницей',
            });
            sendResponse({ success: false, available: false, reason: String(err) });
          }
          break;
        }

        case 'CLEAR_HIGHLIGHT': {
          if (
            message.tabId !== sessionManager.getActiveTabId() ||
            sessionManager.getActiveSessionId() === null
          ) {
            sendResponse({ error: 'Нет активной сессии для этой вкладки' });
            break;
          }
          await chrome.tabs
            .sendMessage(message.tabId, {
              type: 'CLEAR_HIGHLIGHT',
              metricName: message.metricName,
            })
            .catch(() => {
              // The tab may already be gone.
            });
          // A per-category clear must not leave the card stuck in the active
          // state; the status slot is intentionally coarse.
          sessionManager.setOverlayStatus(null);
          sendResponse({ success: true });
          break;
        }

        case 'OVERLAY_STATUS':
          // Only the content script of the audited tab may report overlay state.
          if (sender.tab?.id === undefined || sender.tab.id !== sessionManager.getActiveTabId()) {
            sendResponse({ error: 'Unauthorized tab' });
            break;
          }
          sessionManager.setOverlayStatus({
            targetId: message.targetId,
            metricName: message.metricName,
            available: message.available,
            reason: message.reason,
          });
          sendResponse({ success: true });
          break;

        case 'COLLECTOR_STATUS':
          if (
            sender.tab?.id === undefined ||
            sender.tab.id !== sessionManager.getActiveTabId() ||
            sessionManager.getActiveSessionId() === null
          ) {
            sendResponse({ error: 'Unauthorized tab' });
            break;
          }
          await sessionManager.setCollectorStatus(
            message.status === 'ready'
              ? 'collecting'
              : message.status === 'error'
                ? 'error'
                : 'unsupported',
            message.message,
            message.documentToken,
          );
          if (message.status === 'error') {
            void logDiagnostic('collector', message.message ?? 'Collector error');
          }
          sendResponse({ success: true });
          break;

        case 'GET_STATE': {
          const state = await sessionManager.getState();
          sendResponse({ state });
          break;
        }

        case 'EXPERIMENT_LIST': {
          const experiments = await experimentManager.getExperiments();
          sendResponse({ experiments });
          break;
        }

        case 'EXPERIMENT_START': {
          if (
            message.tabId !== sessionManager.getActiveTabId() ||
            message.baselineSessionId !== sessionManager.getActiveSessionId()
          ) {
            sendResponse({ error: 'Эксперимент должен относиться к активной сессии' });
            break;
          }
          const result = await experimentManager.start({
            baselineSessionId: message.baselineSessionId,
            tabId: message.tabId,
            preset: message.preset,
            domains: message.domains,
            note: message.note,
          });
          sendResponse(result);
          break;
        }

        case 'EXPERIMENT_FINISH': {
          const experiment = await experimentManager.finish(message.experimentId);
          sendResponse({ experiment });
          break;
        }

        case 'EXPERIMENT_CANCEL': {
          const experiment = await experimentManager.cancel(message.experimentId);
          sendResponse({ experiment });
          break;
        }

        case 'EXPORT_JSON': {
          const report = await sessionManager.generateReport(message.sessionId);
          if (!report) {
            sendResponse({ error: 'Сессия не найдена' });
            break;
          }
          const validation = validateJsonReport(report);
          if (!validation.valid) {
            console.error('[WPA BG] Invalid JSON report:', validation.errors);
            sendResponse({
              error: `Отчёт не прошёл проверку схемы: ${validation.errors[0] ?? 'неизвестная ошибка'}`,
            });
            break;
          }
          sendResponse({ report });
          break;
        }

        case 'EXPORT_MARKDOWN': {
          const report = await sessionManager.generateReport(message.sessionId);
          if (!report) {
            sendResponse({ error: 'Сессия не найдена' });
            break;
          }
          const experiments = await experimentManager.getExperiments();
          const experiment = message.experimentId
            ? experiments.find((item) => item.id === message.experimentId)
            : experiments.find(
                (item) =>
                  item.baselineSessionId === message.sessionId ||
                  item.experimentSessionId === message.sessionId,
              );
          sendResponse({ markdown: generateMarkdownReport(report, experiment) });
          break;
        }

        case 'GET_SETTINGS': {
          sendResponse({ settings: await getSettings() });
          break;
        }

        case 'GET_DIAGNOSTICS': {
          sendResponse({ entries: await getDiagnostics() });
          break;
        }

        case 'CLEAR_DIAGNOSTICS': {
          await clearDiagnostics();
          sendResponse({ success: true });
          break;
        }

        case 'LOG_DIAGNOSTIC': {
          await logDiagnostic(message.scope.slice(0, 40), message.message);
          sendResponse({ success: true });
          break;
        }

        case 'UPDATE_SETTINGS': {
          const settings = await updateRetentionDays(message.retentionDays);
          let deleted = 0;
          let cleanupError: string | undefined;
          try {
            deleted = await cleanOldSessions(settings.retentionDays);
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : String(error);
            await logDiagnostic('cleanup', `Не удалось применить срок хранения: ${cleanupError}`).catch(
              () => undefined,
            );
          }
          sendResponse({ success: true, settings, deleted, cleanupError });
          break;
        }

        case 'CLEAR_HISTORY': {
          await experimentManager.cancelActive();
          const activeSessionId = sessionManager.getActiveSessionId();
          const activeSession = activeSessionId
            ? await sessionManager.getSessionById(activeSessionId)
            : undefined;
          if (activeSession) {
            await chrome.tabs
              .sendMessage(activeSession.tabId, {
                type: 'COLLECTOR_STOP',
                requestId: generateId(),
              })
              .catch(() => {
                // The tab may already be closed.
              });
          }
          // Reset and clear inside one queued operation so queued metric/event
          // writes are discarded and no start can interleave (no orphan records).
          await sessionManager.resetAndClearAll();
          // Defensive: drop any WPA session rules that survived a cold-start race
          // so no tab is left blocking requests after the history is gone.
          const rulesPurged = await experimentManager.purgeRules();
          await clearDiagnostics();
          sendResponse({ success: true, rulesPurged });
          break;
        }

        case 'INJECT_COLLECTOR':
          try {
            await injectCollector(message.tabId);
            sendResponse({ success: true });
          } catch (err) {
            sendResponse({ error: String(err) });
          }
          break;

        case 'TAB_STATUS':
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[WPA BG] Error handling message:', message.type, err);
      void logDiagnostic(message.type, err);
      sendResponse({ error: String(err) });
    }
  })();
}

async function handleSessionStart(
  message: Extract<ExtensionMessage, { type: 'SESSION_START' }>,
  sessionManager: SessionManager,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const tab = await chrome.tabs.get(message.tabId);
    const url = tab.url ?? tab.pendingUrl;
    const urlCheck = isAuditableUrl(url);

    if (!urlCheck.auditable) {
      await sessionManager.setCollectorStatus('unsupported', urlCheck.reason);
      sendResponse({ error: urlCheck.reason, accessible: false });
      return;
    }

    const session = await sessionManager.startSession(message.tabId, url!);

    try {
      // The bridge must be listening before the page script can emit metrics.
      await injectCollector(message.tabId);
    } catch (err) {
      console.error('[WPA BG] Injection failed:', err);
      await sessionManager.endSession(session.id, 'error');
      await sessionManager.setCollectorStatus(
        'permission-denied',
        `Не удалось подключиться к странице: ${String(err)}`,
      );
      sendResponse({ error: String(err), accessible: false });
      return;
    }

    sendResponse({ session, accessible: true });
  } catch (err) {
    await sessionManager.setCollectorStatus('error', String(err));
    sendResponse({ error: String(err) });
  }
}
