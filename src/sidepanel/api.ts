import type { ExtensionMessage } from '../types/messages';
import { generateId } from '../utils/id';
import { extensionApi } from '../browser/api';

export function sendRuntimeMessage<T>(message: ExtensionMessage): Promise<T> {
  return extensionApi.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Records a UI failure in the diagnostic journal (P2.1). Only the error
 * message and component stack are sent — never page content or URLs.
 */
export async function logUiError(scope: string, error: unknown): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    await extensionApi.runtime.sendMessage({
      type: 'LOG_DIAGNOSTIC',
      requestId: generateId(),
      scope,
      message: raw.slice(0, 500),
    });
  } catch {
    // The journal must never break the interface it reports on.
  }
}

export async function getActiveTab(currentWindow = false): Promise<chrome.tabs.Tab | undefined> {
  const query: chrome.tabs.QueryInfo = currentWindow
    ? { active: true, currentWindow: true }
    : { active: true, lastFocusedWindow: true };
  const [tab] = await extensionApi.tabs.query(query);
  return tab;
}

export function onRuntimeMessage(
  listener: (message: ExtensionMessage) => void,
): () => void {
  extensionApi.runtime.onMessage.addListener(listener);
  return () => extensionApi.runtime.onMessage.removeListener(listener);
}

export function onTabActivated(listener: () => void): () => void {
  extensionApi.tabs.onActivated.addListener(listener);
  return () => extensionApi.tabs.onActivated.removeListener(listener);
}

export function onTabUpdated(
  listener: (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void,
): () => void {
  extensionApi.tabs.onUpdated.addListener(listener);
  return () => extensionApi.tabs.onUpdated.removeListener(listener);
}
