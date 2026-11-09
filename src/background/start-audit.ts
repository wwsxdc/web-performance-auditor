import type { AuditSession } from '../types/session';
import type { CollectorStatus } from '../types/messages';
import { isAuditableUrl } from '../utils/url';

export interface StartAuditDeps {
  getTab: (tabId: number) => Promise<{ url?: string; pendingUrl?: string }>;
  startSession: (tabId: number, url: string) => Promise<AuditSession>;
  injectCollector: (tabId: number) => Promise<void>;
  endSession: (sessionId: string, status: AuditSession['status']) => Promise<void>;
  setCollectorStatus: (status: CollectorStatus, message?: string) => Promise<void>;
}

export interface StartAuditResult {
  session?: AuditSession;
  error?: string;
  accessible?: boolean;
}

/**
 * Start-use-case extracted from the message router so the permission-denied
 * branch can be tested without a real browser. `deps.getTab` is expected to
 * throw when the extension has no access to the tab.
 */
export async function startAudit(
  tabId: number,
  deps: StartAuditDeps,
): Promise<StartAuditResult> {
  try {
    const tab = await deps.getTab(tabId);
    const url = tab.url ?? tab.pendingUrl;
    const urlCheck = isAuditableUrl(url);

    if (!urlCheck.auditable) {
      await deps.setCollectorStatus('unsupported', urlCheck.reason);
      return { error: urlCheck.reason, accessible: false };
    }

    const session = await deps.startSession(tabId, url!);

    try {
      // The bridge must be listening before the page script can emit metrics.
      await deps.injectCollector(tabId);
    } catch (err) {
      console.error('[WPA BG] Injection failed:', err);
      await deps.endSession(session.id, 'error');
      await deps.setCollectorStatus(
        'permission-denied',
        `Не удалось подключиться к странице: ${String(err)}`,
      );
      return { error: String(err), accessible: false };
    }

    return { session, accessible: true };
  } catch (err) {
    await deps.setCollectorStatus('error', String(err));
    return { error: String(err) };
  }
}
