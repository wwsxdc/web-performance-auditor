/**
 * Web Performance Auditor — Page Instrumentation Script
 * Runs in MAIN world of the web page.
 * Collects metrics via web-vitals and sends them to content script via postMessage.
 *
 * NO access to chrome.* APIs from here.
 */

import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
} from 'web-vitals/attribution';
import type {
  CLSMetricWithAttribution,
  FCPMetricWithAttribution,
  INPMetricWithAttribution,
  LCPMetricWithAttribution,
  TTFBMetricWithAttribution,
} from 'web-vitals/attribution';
import type { Metric } from 'web-vitals';
import type {
  DomTargetSnapshot,
  MetricAttribution,
  MetricName,
  MetricSource,
} from '../types/metrics';
import { generateId } from '../utils/id';
import { calculateRating } from '../utils/rating';

const WPA_PREFIX = 'WPA_';
const WPA_GLOBAL_KEY = '__WPA_COLLECTOR_ACTIVE__';
const WPA_STOP_TYPE = 'WPA_COLLECTOR_STOP';

interface CollectorHandle {
  /** Re-announces the collector and replays the latest metric values. */
  start: () => void;
  /** Stops forwarding metrics from this document (observers may still run). */
  stop: () => void;
}

interface LatestMetric {
  metric: Metric;
  source: MetricSource;
  attribution?: MetricAttribution;
  /** Stable row id, reused when the bridge is re-injected. */
  updateId: string;
  /** Time of the original observation, not of the replay. */
  observedAt: number;
}

interface LongTaskInfo {
  id: string;
  startTime: number;
  duration: number;
}

/** Identifies this document across bridge re-injections and SPA transitions. */
const DOCUMENT_TOKEN = generateId();

function getTargetOrigin(): string {
  return window.location.origin === 'null' ? '*' : window.location.origin;
}

function sendToExtension(type: string, payload?: Record<string, unknown>): void {
  const message = {
    type: `${WPA_PREFIX}${type}`,
    payload: { ...(payload ?? {}), documentToken: DOCUMENT_TOKEN },
  };
  window.postMessage(message, getTargetOrigin());
}

function sendMetric(
  metric: Metric,
  source: MetricSource,
  updateId = generateId(),
  attribution?: MetricAttribution,
  observedAt = Date.now(),
): void {
  sendToExtension('METRIC', {
    updateId,
    metricId: metric.id,
    name: metric.name,
    value: metric.value,
    delta: metric.delta,
    rating: metric.rating,
    navigationType: metric.navigationType,
    observedAt,
    status: 'measured',
    source,
    attribution,
  });
}

function reportInitError(metric: string, error: unknown): void {
  sendToExtension('COLLECTOR_ERROR', {
    metric,
    message: error instanceof Error ? error.message : String(error),
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function simplifyUrl(value: string): string {
  try {
    const url = new URL(value);
    return truncate(`${url.origin}${url.pathname}`, 240);
  } catch {
    return truncate(value, 240);
  }
}

function escapeSelector(value: string): string {
  try {
    return CSS.escape(value);
  } catch {
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
}

function getSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && parts.length < 5) {
    const id = current.getAttribute('id');
    if (id) {
      parts.unshift(`#${escapeSelector(id)}`);
      break;
    }

    let part = current.tagName.toLowerCase();
    const classes = [...current.classList].slice(0, 2);
    if (classes.length > 0) {
      part += `.${classes.map(escapeSelector).join('.')}`;
    }

    const parent: Element | null = current.parentElement;
    if (parent) {
      const tagName = current.tagName;
      const siblings = [...parent.children].filter((child) => child.tagName === tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(part);
    current = parent;
  }

  return truncate(parts.join(' > '), 300);
}

function roundRect(value: number): number {
  return Math.round(value * 100) / 100;
}

function createTarget(
  element: Element | null | undefined,
  selector?: string,
  fallbackRect?: DOMRectReadOnly,
): DomTargetSnapshot | undefined {
  let resolved: Element | null = element ?? null;
  if (!resolved && selector) {
    try {
      resolved = document.querySelector(selector);
    } catch {
      resolved = null;
    }
  }

  if (!resolved && !selector && !fallbackRect) return undefined;

  const rect = resolved ? resolved.getBoundingClientRect() : fallbackRect;
  return {
    targetId: generateId(),
    selector: selector ? truncate(selector, 300) : resolved ? getSelector(resolved) : undefined,
    tagName: resolved?.tagName.toLowerCase(),
    rect: rect
      ? {
          x: roundRect(rect.x),
          y: roundRect(rect.y),
          width: roundRect(rect.width),
          height: roundRect(rect.height),
        }
      : undefined,
    capturedAt: Date.now(),
    available: Boolean(resolved?.isConnected),
  };
}

function getContentType(
  metric: LCPMetricWithAttribution,
): NonNullable<MetricAttribution['lcp']>['contentType'] {
  const element = metric.attribution.lcpEntry?.element;
  if (metric.attribution.url) {
    return element?.tagName.toLowerCase() === 'video' ? 'video' : 'image';
  }
  return element ? 'text' : 'unknown';
}

function buildLcpAttribution(metric: LCPMetricWithAttribution): MetricAttribution {
  const attribution = metric.attribution;
  const element = attribution.lcpEntry?.element ?? null;
  const target = createTarget(element, attribution.element);
  const lcp: NonNullable<MetricAttribution['lcp']> = {
    timeToFirstByte: attribution.timeToFirstByte,
    elementRenderDelay: attribution.elementRenderDelay,
    elementType: element?.tagName.toLowerCase(),
    contentType: getContentType(metric),
  };

  // Resource phases are only meaningful when the LCP candidate has a resource.
  // Do not turn "not applicable" into a misleading zero.
  if (attribution.url) {
    lcp.resourceLoadDelay = attribution.resourceLoadDelay;
    lcp.resourceLoadDuration = attribution.resourceLoadDuration;
    lcp.resourceUrl = simplifyUrl(attribution.url);
  }

  return {
    source: 'web-vitals',
    derived: target ? ['target.selector', 'target.rect'] : [],
    target,
    lcp,
  };
}

function buildClsAttribution(metric: CLSMetricWithAttribution): MetricAttribution {
  const attribution = metric.attribution;
  const sources: DomTargetSnapshot[] = [];
  const seen = new Set<string>();

  const addSource = (
    source: LayoutShiftAttribution | undefined,
    preferredSelector?: string,
  ): void => {
    if (!source) return;
    const target = createTarget(
      source.node instanceof Element ? source.node : null,
      preferredSelector,
      source.currentRect,
    );
    if (!target) return;

    const key = target.selector ?? `${target.rect?.x}:${target.rect?.y}:${target.capturedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(target);
  };

  const largestEntry = attribution.largestShiftEntry;
  if (largestEntry) {
    for (const source of largestEntry.sources.slice(0, 5)) {
      addSource(
        source,
        source.node === largestEntry.sources[0]?.node
          ? attribution.largestShiftTarget
          : undefined,
      );
    }
  }

  if (sources.length === 0) {
    addSource(attribution.largestShiftSource ?? attribution.largestShiftEntry?.sources[0], attribution.largestShiftTarget);
  }

  return {
    source: 'web-vitals',
    derived: sources.length > 0 ? ['cls.sources.selector', 'cls.sources.rect'] : [],
    target: sources[0],
    cls: {
      sources,
      shiftValue: attribution.largestShiftValue,
      shiftTime: attribution.largestShiftTime,
      loadState: attribution.loadState,
    },
  };
}

function findLongTaskIds(
  startTime: number | undefined,
  endTime: number | undefined,
  longTasks: LongTaskInfo[],
): string[] {
  if (startTime === undefined || endTime === undefined) return [];
  return longTasks
    .filter(
      (task) =>
        task.startTime <= endTime &&
        task.startTime + task.duration >= startTime,
    )
    .slice(-5)
    .map((task) => task.id);
}

function buildInpAttribution(
  metric: INPMetricWithAttribution,
  longTasks: LongTaskInfo[],
): MetricAttribution {
  const attribution = metric.attribution;
  const entries = metric.entries;
  const longestEntry = entries.reduce<PerformanceEventTiming | undefined>(
    (longest, entry) => (!longest || entry.duration > longest.duration ? entry : longest),
    undefined,
  );
  const element = attribution.interactionTargetElement;
  const target = createTarget(
    element instanceof Element ? element : null,
    attribution.interactionTarget,
  );
  const longTaskIds = findLongTaskIds(
    attribution.interactionTime,
    attribution.nextPaintTime,
    longTasks,
  );

  return {
    source: 'web-vitals',
    derived: [
      ...(target ? ['target.selector', 'target.rect'] : []),
      ...(longTaskIds.length > 0 ? ['longTaskIds'] : []),
    ],
    target,
    inp: {
      inputDelay: attribution.inputDelay,
      processingDuration: attribution.processingDuration,
      presentationDelay: attribution.presentationDelay,
      interactionType: attribution.interactionType,
      interactionId: longestEntry?.interactionId || undefined,
      startTime: longestEntry?.startTime,
      duration: longestEntry?.duration,
      nextPaintTime: attribution.nextPaintTime,
      loadState: attribution.loadState,
    },
    longTaskIds: longTaskIds.length > 0 ? longTaskIds : undefined,
  };
}

function buildFcpAttribution(metric: FCPMetricWithAttribution): MetricAttribution {
  return {
    source: 'web-vitals',
    fcp: {
      timeToFirstByte: metric.attribution.timeToFirstByte,
      firstByteToFCP: metric.attribution.firstByteToFCP,
      loadState: metric.attribution.loadState,
    },
  };
}

function buildTtfbAttribution(metric: TTFBMetricWithAttribution): MetricAttribution {
  return {
    source: 'web-vitals',
    ttfb: {
      waitingDuration: metric.attribution.waitingDuration,
      cacheDuration: metric.attribution.cacheDuration,
      dnsDuration: metric.attribution.dnsDuration,
      connectionDuration: metric.attribution.connectionDuration,
      requestDuration: metric.attribution.requestDuration,
    },
  };
}

function getNavigationType(): Metric['navigationType'] {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  switch (entry?.type) {
    case 'reload':
      return 'reload';
    case 'back_forward':
      return 'back-forward';
    case 'prerender':
      return 'prerender';
    default:
      return 'navigate';
  }
}

function createMetric(
  name: MetricName,
  value: number,
  entries: PerformanceEntry[],
): Metric {
  const rating = calculateRating(name, value);
  return {
    name,
    value,
    rating: rating === 'unrated' ? 'good' : rating,
    delta: value,
    id: generateId(),
    entries,
    navigationType: getNavigationType(),
  } as Metric;
}

/**
 * FCP/LCP/CLS observers do not see entries that happened before they were
 * registered. Reconstruct what is available when an audit starts on an
 * already-loaded page (e.g. the extension was just installed).
 */
function computeClsWindow(
  shifts: Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>,
): number {
  let max = 0;
  let current = 0;
  let first = 0;
  let last = 0;

  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    if (current > 0 && shift.startTime - last < 1000 && shift.startTime - first < 5000) {
      current += shift.value;
    } else {
      current = shift.value;
      first = shift.startTime;
    }
    last = shift.startTime;
    if (current > max) max = current;
  }

  return max;
}

/**
 * LCP and layout-shift entries are not reliably readable through
 * `getEntriesByType`; a buffered PerformanceObserver is the only supported way
 * to recover entries that occurred before the collector was registered.
 */
function replayLcpFromBuffer(
  latest: Map<string, LatestMetric>,
  isStopped: () => boolean,
): void {
  try {
    let resolved = false;
    const observer = new PerformanceObserver((list) => {
      if (resolved) return;
      if (isStopped()) {
        observer.disconnect();
        return;
      }
      const entries = list.getEntries();
      const entry = entries[entries.length - 1] as
        | (PerformanceEntry & { element?: Element | null; url?: string; size?: number })
        | undefined;
      // A buffered observer can fire with an empty list before the first
      // candidate is painted; keep waiting instead of giving up (this happens
      // when the collector starts at document_start).
      if (!entry || latest.has('LCP')) {
        if (latest.has('LCP')) observer.disconnect();
        return;
      }
      resolved = true;

      const element = entry.element ?? null;
      const target = createTarget(element);
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      const resourceUrl =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src
          : entry.url ?? undefined;
      const contentType: NonNullable<MetricAttribution['lcp']>['contentType'] = resourceUrl
        ? element?.tagName.toLowerCase() === 'video'
          ? 'video'
          : 'image'
        : element
          ? 'text'
          : 'unknown';

      const lcp: NonNullable<MetricAttribution['lcp']> = {
        timeToFirstByte: navigation?.responseStart,
        elementRenderDelay:
          navigation?.responseStart !== undefined
            ? Math.max(0, entry.startTime - navigation.responseStart)
            : undefined,
        elementType: element?.tagName.toLowerCase(),
        contentType,
      };
      if (resourceUrl) lcp.resourceUrl = simplifyUrl(resourceUrl);

      const attribution: MetricAttribution = {
        source: 'performance-api',
        derived: target ? ['target.selector', 'target.rect'] : [],
        target,
        lcp,
      };
      const metric = createMetric('LCP', entry.startTime, [entry]);
      const updateId = `replay-LCP-${metric.id}`;
      const observedAt = Math.round(performance.timeOrigin + entry.startTime);
      latest.set('LCP', {
        metric,
        source: 'performance-api',
        attribution,
        updateId,
        observedAt,
      });
      sendMetric(metric, 'performance-api', updateId, attribution, observedAt);
      observer.disconnect();
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => observer.disconnect(), 15_000);
  } catch {
    // The entry type may be unsupported; the regular observer still reports.
  }
}

function replayClsFromBuffer(
  latest: Map<string, LatestMetric>,
  isStopped: () => boolean,
): void {
  try {
    const shifts: Array<PerformanceEntry & { value: number; hadRecentInput: boolean }> = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shifts.push(entry as PerformanceEntry & { value: number; hadRecentInput: boolean });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });

    // Buffered entries are delivered asynchronously before the next task.
    setTimeout(() => {
      observer.disconnect();
      if (isStopped() || latest.has('CLS') || shifts.length === 0) return;

      const sources: DomTargetSnapshot[] = [];
      const seen = new Set<string>();
      for (const shift of shifts) {
        const entries = (shift as PerformanceEntry & {
          sources?: Array<{ node?: Node | null; previousRect?: DOMRectReadOnly }>;
        }).sources ?? [];
        for (const source of entries) {
          const target = createTarget(source.node instanceof Element ? source.node : null);
          if (!target) continue;
          const key = target.selector ?? `${target.rect?.x}:${target.rect?.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          sources.push(target);
        }
      }

      const value = computeClsWindow(shifts);
      const attribution: MetricAttribution = {
        source: 'derived',
        cls: {
          sources,
          shiftValue: value,
          shiftTime: shifts[shifts.length - 1]?.startTime,
        },
      };
      const metric = createMetric('CLS', value, shifts);
      const updateId = `replay-CLS-${metric.id}`;
      const lastShift = shifts[shifts.length - 1];
      const observedAt = Math.round(
        performance.timeOrigin + (lastShift?.startTime ?? 0),
      );
      latest.set('CLS', {
        metric,
        source: 'derived',
        attribution,
        updateId,
        observedAt,
      });
      sendMetric(metric, 'derived', updateId, attribution, observedAt);
    }, 100);
  } catch {
    // The entry type may be unsupported; the regular observer still reports.
  }
}

function replayExistingEntries(
  latest: Map<string, LatestMetric>,
  isStopped: () => boolean,
): void {
  try {
    if (!latest.has('FCP')) {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0] as
        | PerformancePaintTiming
        | undefined;
      if (fcp) {
        const metric = createMetric('FCP', fcp.startTime, [fcp]);
        latest.set('FCP', {
          metric,
          source: 'performance-api',
          updateId: `replay-FCP-${metric.id}`,
          observedAt: Math.round(performance.timeOrigin + fcp.startTime),
        });
      }
    }

    if (!latest.has('LCP')) {
      replayLcpFromBuffer(latest, isStopped);
    }

    if (!latest.has('CLS') && document.readyState === 'complete') {
      replayClsFromBuffer(latest, isStopped);
    }

    if (!latest.has('TTFB') && document.readyState === 'complete') {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (nav && nav.responseStart > 0) {
        const metric = createMetric('TTFB', nav.responseStart, [nav]);
        latest.set('TTFB', {
          metric,
          source: 'performance-api',
          updateId: `replay-TTFB-${metric.id}`,
          observedAt: Math.round(performance.timeOrigin + nav.responseStart),
        });
      }
    }
  } catch {
    // Performance APIs can be restricted in some contexts; ignore.
  }
}

function getCapabilities(): string[] {
  if (typeof PerformanceObserver === 'undefined') return [];
  return [...(PerformanceObserver.supportedEntryTypes ?? [])];
}

function sendUnsupported(name: MetricName): void {
  sendToExtension('METRIC', {
    updateId: `unsupported-${name}`,
    metricId: `unsupported-${name}`,
    name,
    value: null,
    delta: 0,
    rating: 'unrated',
    observedAt: Date.now(),
    status: 'unsupported',
    source: 'derived',
  });
}

function reportUnsupportedMetrics(): void {
  const supported = getCapabilities();

  const requiredTypes: Array<{ name: MetricName; entryType: string }> = [
    { name: 'LCP', entryType: 'largest-contentful-paint' },
    { name: 'CLS', entryType: 'layout-shift' },
    { name: 'INP', entryType: 'event' },
    { name: 'FCP', entryType: 'paint' },
    { name: 'TTFB', entryType: 'navigation' },
  ];

  for (const { name, entryType } of requiredTypes) {
    if (!supported.includes(entryType)) sendUnsupported(name);
  }
}

function initCollector(): CollectorHandle {
  const latest = new Map<string, LatestMetric>();
  const longTasks: LongTaskInfo[] = [];
  const seenLongTaskIds = new Set<string>();
  let longTaskObserver: PerformanceObserver | null = null;
  let longTaskObserverEverStarted = false;
  let layoutShiftObserver: PerformanceObserver | null = null;
  let layoutShiftObserverEverStarted = false;
  let interactionObserver: PerformanceObserver | null = null;
  let interactionObserverEverStarted = false;
  let stopped = false;

  const capabilities = getCapabilities();
  const longTaskSupported = capabilities.includes('longtask');

  const sendEvent = (payload: Record<string, unknown>): void => {
    recentEvents.push(payload);
    if (recentEvents.length > 100) recentEvents.shift();
    sendToExtension('EVENT', payload);
  };
  const layoutShiftSupported = capabilities.includes('layout-shift');
  const interactionSupported = capabilities.includes('event');

  const seenLayoutShiftIds = new Set<string>();
  const seenInteractionIds = new Set<number>();
  const interactionTimers = new Set<number>();
  const collectorLimitations = new Set<string>();
  const recentEvents: Array<Record<string, unknown>> = [];
  const pendingInteractions = new Map<
    number,
    {
      interactionId: number;
      timestamp: number;
      duration: number;
      name: string;
      selector: string | null;
      tagName: string | null;
    }
  >();

  const collectorLimitationEvent = (collector: string): Record<string, unknown> => ({
    eventId: `limitation-${DOCUMENT_TOKEN.slice(0, 8)}-${collector}`,
    eventType: 'collector-limitation',
    timestamp: Date.now(),
    details: {
      collector,
      message: `${collector}: исторические записи недоступны, сбор начат с момента подключения`,
    },
  });

  const reportCollectorLimitation = (collector: string): void => {
    collectorLimitations.add(collector);
    sendEvent(collectorLimitationEvent(collector));
  };

  const startLongTaskObserver = (buffered: boolean): void => {
    if (!longTaskSupported || longTaskObserver) return;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const id = `longtask-${DOCUMENT_TOKEN.slice(0, 8)}-${Math.round(entry.startTime * 1000)}-${Math.round(entry.duration * 1000)}`;
          if (seenLongTaskIds.has(id)) continue;
          seenLongTaskIds.add(id);

          longTasks.push({ id, startTime: entry.startTime, duration: entry.duration });
          if (longTasks.length > 200) longTasks.shift();

          if (!stopped) {
            const taskAttribution = (
              entry as PerformanceEntry & {
                attribution?: Array<{
                  containerType?: string;
                  containerName?: string;
                  containerSrc?: string;
                  containerId?: string;
                }>;
              }
            ).attribution?.[0];

            sendEvent({
              eventId: id,
              eventType: 'long-task',
              timestamp: Math.round(performance.timeOrigin + entry.startTime),
              duration: entry.duration,
              details: {
                name: entry.name,
                startTime: entry.startTime,
                containerType: taskAttribution?.containerType ?? null,
                containerName: taskAttribution?.containerName ?? null,
                containerSrc: taskAttribution?.containerSrc ?? null,
                containerId: taskAttribution?.containerId ?? null,
              },
            });
          }
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered });
      longTaskObserverEverStarted = true;
    } catch (error) {
      longTaskObserver = null;
      if (buffered) {
        reportCollectorLimitation('LongTask');
        startLongTaskObserver(false);
        return;
      }
      reportInitError('LongTask', error);
    }
  };

  const emitInteraction = (interactionId: number): void => {
    const interaction = pendingInteractions.get(interactionId);
    if (!interaction) return;
    pendingInteractions.delete(interactionId);
    if (stopped) return;

    sendEvent({
      eventId: `interaction-${DOCUMENT_TOKEN.slice(0, 8)}-${interactionId}`,
      eventType: 'interaction',
      timestamp: interaction.timestamp,
      duration: interaction.duration,
      details: {
        interactionType: interaction.name,
        selector: interaction.selector,
        tagName: interaction.tagName,
      },
    });
  };

  const startLayoutShiftObserver = (buffered: boolean): void => {
    if (!layoutShiftSupported || layoutShiftObserver) return;
    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{ node?: Node | null }>;
          };
          if (stopped || shift.hadRecentInput || !shift.value) continue;
          const id = `layout-shift-${DOCUMENT_TOKEN.slice(0, 8)}-${Math.round(shift.startTime * 1000)}`;
          if (seenLayoutShiftIds.has(id)) continue;
          seenLayoutShiftIds.add(id);

          const sources = shift.sources ?? [];
          const firstNode = sources[0]?.node;
          const target = createTarget(firstNode instanceof Element ? firstNode : null);
          sendEvent({
            eventId: id,
            eventType: 'layout-shift',
            timestamp: Math.round(performance.timeOrigin + shift.startTime),
            details: {
              value: shift.value,
              hadRecentInput: shift.hadRecentInput,
              sourcesCount: sources.length,
              selector: target?.selector ?? null,
            },
          });
        }
      });
      layoutShiftObserver.observe({ type: 'layout-shift', buffered });
      layoutShiftObserverEverStarted = true;
    } catch (error) {
      layoutShiftObserver = null;
      if (buffered) {
        reportCollectorLimitation('LayoutShift');
        startLayoutShiftObserver(false);
        return;
      }
      reportInitError('LayoutShift', error);
    }
  };

  const startInteractionObserver = (buffered: boolean): void => {
    if (!interactionSupported || interactionObserver) return;
    try {
      interactionObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEventTiming;
          if (stopped || !event.interactionId) continue;
          const existing = pendingInteractions.get(event.interactionId);
          const target = event.target instanceof Element ? event.target : null;
          const selector = existing?.selector ?? (target ? getSelector(target) : null);
          pendingInteractions.set(event.interactionId, {
            interactionId: event.interactionId,
            timestamp: existing?.timestamp ?? Math.round(performance.timeOrigin + event.startTime),
            duration: Math.max(existing?.duration ?? 0, event.duration),
            name: existing?.name ?? event.name,
            selector,
            tagName: existing?.tagName ?? target?.tagName.toLowerCase() ?? null,
          });

          if (!seenInteractionIds.has(event.interactionId)) {
            seenInteractionIds.add(event.interactionId);
            const timer = window.setTimeout(() => {
              interactionTimers.delete(timer);
              emitInteraction(event.interactionId);
            }, 120);
            interactionTimers.add(timer);
          }
        }
      });
      interactionObserver.observe({
        type: 'event',
        buffered,
        durationThreshold: 40,
      } as PerformanceObserverInit);
      interactionObserverEverStarted = true;
    } catch (error) {
      interactionObserver = null;
      if (buffered) {
        reportCollectorLimitation('Interaction');
        startInteractionObserver(false);
        return;
      }
      reportInitError('Interaction', error);
    }
  };

  const stopCustomObservers = (): void => {
    layoutShiftObserver?.disconnect();
    layoutShiftObserver = null;
    interactionObserver?.disconnect();
    interactionObserver = null;
    for (const timer of interactionTimers) window.clearTimeout(timer);
    interactionTimers.clear();
    pendingInteractions.clear();
  };

  const handleMetric = (metric: Metric, attribution?: MetricAttribution): void => {
    if (stopped) return;
    const updateId = generateId();
    const observedAt = Date.now();
    const previous = latest.get(metric.name);
    latest.set(metric.name, {
      metric,
      source: 'web-vitals',
      attribution,
      updateId,
      observedAt,
    });
    if (previous) {
      sendToExtension('EVENT', {
        eventId: generateId(),
        eventType: 'metric-update',
        timestamp: observedAt,
        details: {
          metric: metric.name,
          metricId: metric.id,
          value: metric.value,
          delta: metric.delta,
          rating: metric.rating,
        },
      });
    }
    sendMetric(metric, 'web-vitals', updateId, attribution, observedAt);
  };

  const registerMetric = (name: string, register: () => void): void => {
    try {
      register();
    } catch (error) {
      reportInitError(name, error);
    }
  };

  registerMetric('LCP', () => onLCP(
    (metric) => handleMetric(metric, buildLcpAttribution(metric)),
    { reportAllChanges: true },
  ));
  registerMetric('CLS', () => onCLS(
    (metric) => handleMetric(metric, buildClsAttribution(metric)),
    { reportAllChanges: true },
  ));
  registerMetric('INP', () => onINP(
    (metric) => handleMetric(metric, buildInpAttribution(metric, longTasks)),
    { reportAllChanges: true },
  ));
  registerMetric('FCP', () => onFCP(
    (metric) => handleMetric(metric, buildFcpAttribution(metric)),
    { reportAllChanges: true },
  ));
  registerMetric('TTFB', () => onTTFB(
    (metric) => handleMetric(metric, buildTtfbAttribution(metric)),
  ));

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === WPA_STOP_TYPE) {
      stopped = true;
      longTaskObserver?.disconnect();
      longTaskObserver = null;
      stopCustomObservers();
      longTasks.length = 0;
      recentEvents.length = 0;
    }
  });

  return {
    start(): void {
      // A new audit may start on a document that is already loaded. Replay
      // what web-vitals has observed so far (FCP/TTFB never fire twice).
      stopped = false;
      reportUnsupportedMetrics();
      replayExistingEntries(latest, () => stopped);
      startLongTaskObserver(!longTaskObserverEverStarted);
      startLayoutShiftObserver(!layoutShiftObserverEverStarted);
      startInteractionObserver(!interactionObserverEverStarted);
      // Events observed before the bridge was injected are replayed with their
      // stable ids; the background upserts by id, so re-injection is idempotent.
      const recentEventIds = new Set(recentEvents.map((event) => event.eventId));
      for (const event of recentEvents) {
        sendToExtension('EVENT', event);
      }
      for (const collector of collectorLimitations) {
        const event = collectorLimitationEvent(collector);
        if (!recentEventIds.has(event.eventId)) sendToExtension('EVENT', event);
      }
      for (const { metric, source, attribution, updateId, observedAt } of latest.values()) {
        // Reuse the row id and original timestamp: bridge re-injection must
        // update the metric instead of adding a duplicate row.
        sendMetric(metric, source, updateId, attribution, observedAt);
      }
      sendToExtension('COLLECTOR_READY', { capabilities: getCapabilities() });
    },
    stop(): void {
      stopped = true;
      longTaskObserver?.disconnect();
      longTaskObserver = null;
      stopCustomObservers();
      longTasks.length = 0;
      recentEvents.length = 0;
    },
  };
}

const windowWithCollector = window as unknown as Record<string, unknown>;
let collector = windowWithCollector[WPA_GLOBAL_KEY] as CollectorHandle | undefined;

if (!collector || typeof collector.start !== 'function') {
  collector = initCollector();
  windowWithCollector[WPA_GLOBAL_KEY] = collector;
}

collector.start();
