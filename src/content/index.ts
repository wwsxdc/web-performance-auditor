/**
 * Web Performance Auditor — Content Script (ISOLATED world)
 * Bridges messages between page script (MAIN) and background service worker.
 */

import { isPageMessageWithinSize, isPageToContentMessage } from '../utils/validation';
import { generateId } from '../utils/id';

const WPA_PREFIX = 'WPA_';
const BRIDGE_GLOBAL_KEY = '__WPA_BRIDGE_ACTIVE__';
const OVERLAY_HOST_ID = 'wpa-diagnostic-overlay';

interface HighlightTarget {
  targetId?: string;
  selector?: string;
  color: 'green' | 'red' | 'yellow';
  label?: string;
  metricName?: string;
}

const OVERLAY_COLORS: Record<HighlightTarget['color'], string> = {
  green: '#15803d',
  red: '#b91c1c',
  yellow: '#a16207',
};

interface OverlayRuntime {
  host: HTMLDivElement;
  box: HTMLDivElement;
  label: HTMLDivElement;
  target: Element;
  targetId?: string;
  metricName?: string;
  color: string;
  raf: number;
  unavailableReported: boolean;
  resizeObserver: ResizeObserver | null;
  onScroll: () => void;
  onResize: () => void;
}

// One overlay per diagnostic category (LCP/CLS/INP) so the three highlight
// types can be shown together and toggled independently (FR-12).
const overlays = new Map<string, OverlayRuntime>();
let overlayMutationObserver: MutationObserver | null = null;

function overlayKey(target: HighlightTarget): string {
  return target.metricName ?? target.targetId ?? 'default';
}

function notifyOverlayStatus(
  targetId: string | undefined,
  available: boolean,
  reason?: string,
  metricName?: string,
): void {
  chrome.runtime
    .sendMessage({
      type: 'OVERLAY_STATUS',
      requestId: generateId(),
      targetId,
      metricName,
      available,
      reason,
    })
    .catch(() => {
      // The service worker or panel may be gone.
    });
}

function ensureOverlay(key: string): OverlayRuntime {
  const existing = overlays.get(key);
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = `${OVERLAY_HOST_ID}-${key}`;
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed;
      box-sizing: border-box;
      border: 3px solid var(--wpa-color, #16a34a);
      border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25), 0 2px 10px rgba(0, 0, 0, 0.2);
      pointer-events: none;
    }
    .label {
      position: absolute;
      left: -3px;
      top: -23px;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--wpa-color, #16a34a);
      color: #fff;
      font: 600 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
    }
    .label.inside { top: 0; left: 0; }
  `;
  shadow.append(style);

  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  box.append(label);
  shadow.append(box);

  document.documentElement.append(host);

  const runtime: OverlayRuntime = {
    host,
    box,
    label,
    target: document.documentElement,
    targetId: undefined,
    metricName: key === 'LCP' || key === 'CLS' || key === 'INP' ? key : undefined,
    color: OVERLAY_COLORS.green,
    raf: 0,
    unavailableReported: false,
    resizeObserver: null,
    onScroll: () => scheduleOverlayPosition(runtime),
    onResize: () => scheduleOverlayPosition(runtime),
  };
  overlays.set(key, runtime);
  return runtime;
}

function positionOverlay(runtime: OverlayRuntime): void {
  runtime.raf = 0;

  if (!runtime.target.isConnected) {
    runtime.box.style.display = 'none';
    if (!runtime.unavailableReported) {
      runtime.unavailableReported = true;
      notifyOverlayStatus(
        runtime.targetId,
        false,
        'Элемент изменился или больше недоступен',
        runtime.metricName,
      );
    }
    return;
  }

  const rect = runtime.target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    runtime.box.style.display = 'none';
    return;
  }

  runtime.box.style.setProperty('--wpa-color', runtime.color);
  runtime.box.style.left = `${rect.left}px`;
  runtime.box.style.top = `${rect.top}px`;
  runtime.box.style.width = `${rect.width}px`;
  runtime.box.style.height = `${rect.height}px`;
  runtime.box.style.display = 'block';

  const labelAbove = rect.top >= 26;
  runtime.label.classList.toggle('inside', !labelAbove);
  runtime.label.style.top = labelAbove ? '-23px' : '0';
}

function scheduleOverlayPosition(runtime: OverlayRuntime): void {
  if (runtime.raf) return;
  runtime.raf = requestAnimationFrame(() => positionOverlay(runtime));
}

function rebuildOverlayMutationObserver(): void {
  if (overlays.size === 0) {
    overlayMutationObserver?.disconnect();
    overlayMutationObserver = null;
    return;
  }

  if (!overlayMutationObserver) {
    overlayMutationObserver = new MutationObserver(() => {
      for (const runtime of overlays.values()) scheduleOverlayPosition(runtime);
    });
  } else {
    overlayMutationObserver.disconnect();
  }

  for (const runtime of overlays.values()) {
    let node: Node | null = runtime.target.parentNode;
    while (node) {
      overlayMutationObserver.observe(node, { childList: true });
      node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    }
  }
}

function attachOverlayObservers(runtime: OverlayRuntime): void {
  detachOverlayObservers(runtime);
  window.addEventListener('scroll', runtime.onScroll, true);
  window.addEventListener('resize', runtime.onResize);
  if (typeof ResizeObserver !== 'undefined') {
    runtime.resizeObserver = new ResizeObserver(() => scheduleOverlayPosition(runtime));
    runtime.resizeObserver.observe(runtime.target);
  }
  rebuildOverlayMutationObserver();
}

function detachOverlayObservers(runtime: OverlayRuntime): void {
  window.removeEventListener('scroll', runtime.onScroll, true);
  window.removeEventListener('resize', runtime.onResize);
  runtime.resizeObserver?.disconnect();
  runtime.resizeObserver = null;
  if (runtime.raf) {
    cancelAnimationFrame(runtime.raf);
    runtime.raf = 0;
  }
}

function clearOverlay(key: string): void {
  const runtime = overlays.get(key);
  if (!runtime) return;
  detachOverlayObservers(runtime);
  runtime.host.remove();
  overlays.delete(key);
  rebuildOverlayMutationObserver();
}

function clearHighlight(metricName?: string): void {
  if (metricName) {
    clearOverlay(metricName);
    return;
  }
  for (const key of [...overlays.keys()]) clearOverlay(key);
}

function highlightTarget(target: HighlightTarget): boolean {
  const key = overlayKey(target);
  clearOverlay(key);

  let element: Element | null = null;
  if (target.selector) {
    try {
      element = document.querySelector(target.selector);
    } catch {
      element = null;
    }
  }

  if (!element) {
    notifyOverlayStatus(
      target.targetId,
      false,
      'Элемент не найден на странице',
      target.metricName,
    );
    return false;
  }

  const runtime = ensureOverlay(key);
  runtime.target = element;
  runtime.targetId = target.targetId;
  runtime.metricName = target.metricName;
  runtime.color = OVERLAY_COLORS[target.color];
  runtime.unavailableReported = false;
  runtime.label.textContent = target.label || target.metricName || 'WPA';
  attachOverlayObservers(runtime);
  positionOverlay(runtime);
  return true;
}

function getTargetOrigin(): string {
  return window.location.origin === 'null' ? '*' : window.location.origin;
}

function isAlreadyActive(): boolean {
  const target = window as unknown as Record<string, unknown>;
  if (target[BRIDGE_GLOBAL_KEY]) return true;
  target[BRIDGE_GLOBAL_KEY] = true;
  return false;
}

if (!isAlreadyActive()) {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data: unknown = event.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { type?: unknown }).type !== 'string' ||
      !(data as { type: string }).type.startsWith(WPA_PREFIX)
    ) {
      return;
    }

    if (!isPageMessageWithinSize(data)) return;
    if (!isPageToContentMessage(data)) return;

    switch (data.type) {
      case 'WPA_METRIC':
        chrome.runtime
          .sendMessage({
            type: 'METRIC_UPDATE',
            requestId: generateId(),
            sessionId: '', // Background determines it from the sender tab
            documentToken: data.payload.documentToken,
            metric: {
              id: data.payload.updateId,
              metricId: data.payload.metricId,
              name: data.payload.name,
              value: data.payload.value,
              delta: data.payload.delta,
              rating: data.payload.rating,
              navigationType: data.payload.navigationType,
              observedAt: data.payload.observedAt,
              status: data.payload.status,
              attribution: data.payload.attribution,
              source: data.payload.source ?? 'web-vitals',
            },
          })
          .catch((err: Error) => {
            console.warn('[WPA Content] Failed to send metric:', err.message);
          });
        break;

      case 'WPA_EVENT':
        chrome.runtime
          .sendMessage({
            type: 'EVENT_UPDATE',
            requestId: generateId(),
            sessionId: '',
            documentToken: data.payload.documentToken,
            event: {
              id: data.payload.eventId,
              type: data.payload.eventType,
              timestamp: data.payload.timestamp,
              duration: data.payload.duration,
              details: data.payload.details,
            },
          })
          .catch((err: Error) => {
            console.warn('[WPA Content] Failed to send event:', err.message);
          });
        break;

      case 'WPA_COLLECTOR_READY':
        chrome.runtime
          .sendMessage({
            type: 'COLLECTOR_STATUS',
            requestId: generateId(),
            status:
              data.payload?.capabilities?.length === 0
                ? 'unsupported'
                : 'ready',
            documentToken: data.payload?.documentToken,
          })
          .catch((err: Error) => {
            console.warn('[WPA Content] Failed to send collector status:', err.message);
          });
        break;

      case 'WPA_COLLECTOR_ERROR':
        chrome.runtime
          .sendMessage({
            type: 'COLLECTOR_STATUS',
            requestId: generateId(),
            status: 'error',
            message: data.payload.message || 'Unknown error',
            documentToken: data.payload.documentToken,
          })
          .catch((err: Error) => {
            console.warn('[WPA Content] Failed to send error:', err.message);
          });
        break;
    }
  });

  // Background -> page commands. Only allowlisted commands are forwarded.
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (typeof message !== 'object' || message === null) return false;

      switch ((message as { type?: unknown }).type) {
        case 'COLLECTOR_STOP':
          clearHighlight();
          window.postMessage({ type: 'WPA_COLLECTOR_STOP' }, getTargetOrigin());
          sendResponse({ success: true });
          break;

        case 'HIGHLIGHT_TARGET': {
          const target = (message as { target?: HighlightTarget }).target;
          if (!target || typeof target !== 'object') {
            sendResponse({ success: false, available: false, reason: 'Некорректная цель' });
            break;
          }
          const available = highlightTarget(target);
          sendResponse({
            success: true,
            available,
            reason: available ? undefined : 'Элемент не найден на странице',
          });
          break;
        }

        case 'CLEAR_HIGHLIGHT': {
          const metricName = (message as { metricName?: unknown }).metricName;
          clearHighlight(typeof metricName === 'string' ? metricName : undefined);
          sendResponse({ success: true });
          break;
        }

        default:
          break;
      }
      return false;
    },
  );

  console.log('[WPA] Content script loaded');
}
