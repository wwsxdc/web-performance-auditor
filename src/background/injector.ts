import { CONTENT_SCRIPT_FILE, PAGE_SCRIPT_FILE } from '../constants/config';
import { extensionApi } from '../browser/api';

/**
 * Injects the isolated bridge first, then starts the MAIN-world collector.
 * The page collector replays its latest metrics when the bridge is injected
 * after the page has already loaded.
 */
export async function injectCollector(tabId: number): Promise<void> {
  await extensionApi.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE],
  });

  await extensionApi.scripting.executeScript({
    target: { tabId },
    files: [PAGE_SCRIPT_FILE],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });
}
