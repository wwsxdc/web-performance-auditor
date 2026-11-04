import type { ExtensionMessage } from '../types/messages';
import { generateId } from '../utils/id';

export function sendRuntimeMessage<T>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Records a UI failure in the diagnostic journal (P2.1). Only the error
 * message and component stack are sent — never page content or URLs.
 */
export async function logUiError(scope: string, error: unknown): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    await chrome.runtime.sendMessage({
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
  const [tab] = await chrome.tabs.query(query);
  return tab;
}

export function onRuntimeMessage(
  listener: (message: ExtensionMessage) => void,
): () => void {
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function onTabActivated(listener: () => void): () => void {
  chrome.tabs.onActivated.addListener(listener);
  return () => chrome.tabs.onActivated.removeListener(listener);
}

export function onTabUpdated(
  listener: (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void,
): () => void {
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}
