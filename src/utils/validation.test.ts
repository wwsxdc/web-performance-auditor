import { describe, expect, it } from 'vitest';
import {
  isCollectorStatus,
  isEventType,
  isExtensionMessage,
  isMetricName,
  isMetricStatus,
  isPageMessageWithinSize,
  isPageToContentMessage,
} from './validation';
import { PAGE_MESSAGE_LIMITS } from '../constants/config';

describe('metric guards', () => {
  it('recognizes supported metric names and statuses', () => {
    expect(isMetricName('LCP')).toBe(true);
    expect(isMetricName('FID')).toBe(false);
    expect(isMetricStatus('measured')).toBe(true);
    expect(isMetricStatus('unknown')).toBe(false);
    expect(isCollectorStatus('permission-denied')).toBe(true);
  });
});

describe('isPageToContentMessage', () => {
  it('accepts a valid metric message', () => {
    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: {
          updateId: 'update-1',
          metricId: 'v3-123',
          name: 'LCP',
          value: 2500,
          delta: 2500,
          rating: 'good',
          observedAt: Date.now(),
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(isPageToContentMessage({ type: 'WPA_METRIC', payload: {} })).toBe(false);
    expect(isPageToContentMessage({ type: 'UNKNOWN' })).toBe(false);
    expect(isPageToContentMessage(null)).toBe(false);
  });

  it('accepts diagnostic events and rejects unsupported event types', () => {
    const event = {
      type: 'WPA_EVENT',
      payload: {
        eventId: 'event-1',
        eventType: 'long-task',
        timestamp: 1200,
        duration: 240,
        details: { containerType: 'window' },
        documentToken: 'doc-1',
      },
    };

    expect(isEventType('long-task')).toBe(true);
    expect(isEventType('unknown')).toBe(false);
    expect(isPageToContentMessage(event)).toBe(true);
    expect(
      isPageToContentMessage({
        ...event,
        payload: { ...event.payload, eventType: 'metric-update', details: { metric: 'LCP' } },
      }),
    ).toBe(true);
    expect(
      isPageToContentMessage({
        ...event,
        payload: { ...event.payload, eventType: 'mystery' },
      }),
    ).toBe(false);
    expect(
      isPageToContentMessage({
        ...event,
        payload: { ...event.payload, timestamp: 'later' },
      }),
    ).toBe(false);
  });

  it('validates metric provenance and document tokens', () => {
    const basePayload = {
      updateId: 'update-1',
      metricId: 'v3-123',
      name: 'LCP',
      value: 2500,
      delta: 2500,
      rating: 'good',
      observedAt: Date.now(),
    };

    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: { ...basePayload, source: 'performance-api', documentToken: 'doc-1' },
      }),
    ).toBe(true);
    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: { ...basePayload, source: 'unknown' },
      }),
    ).toBe(false);
    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: { ...basePayload, documentToken: 42 },
      }),
    ).toBe(false);
    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: { ...basePayload, rating: 'excellent' },
      }),
    ).toBe(false);
    expect(
      isPageToContentMessage({
        type: 'WPA_METRIC',
        payload: {
          ...basePayload,
          documentToken: 'x'.repeat(PAGE_MESSAGE_LIMITS.maxStringLength + 1),
        },
      }),
    ).toBe(false);
  });

  it('rejects oversized page messages', () => {
    const payload = {
      type: 'WPA_EVENT',
      payload: {
        eventId: 'event-1',
        eventType: 'long-task',
        timestamp: 1200,
        details: { value: 'x'.repeat(PAGE_MESSAGE_LIMITS.maxStringLength + 1) },
      },
    };

    expect(isPageMessageWithinSize(payload)).toBe(true);
    expect(
      isPageMessageWithinSize({
        ...payload,
        payload: {
          ...payload.payload,
          details: { value: 'x'.repeat(PAGE_MESSAGE_LIMITS.maxBytes) },
        },
      }),
    ).toBe(false);
    expect(
      isPageMessageWithinSize('Ж'.repeat(PAGE_MESSAGE_LIMITS.maxBytes / 2)),
    ).toBe(false);
  });
});

describe('isExtensionMessage', () => {
  it('accepts session lifecycle messages', () => {
    expect(
      isExtensionMessage({ type: 'SESSION_START', requestId: 'r1', tabId: 12 }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: 'SESSION_STOP', requestId: 'r2', sessionId: 's1' }),
    ).toBe(true);
  });

  it('accepts metric updates with a valid payload', () => {
    expect(
      isExtensionMessage({
        type: 'METRIC_UPDATE',
        requestId: 'r3',
        sessionId: 's1',
        metric: {
          id: 'update-1',
          name: 'CLS',
          value: 0.05,
          observedAt: Date.now(),
        },
      }),
    ).toBe(true);
  });

  it('accepts event, highlight and overlay messages', () => {
    expect(
      isExtensionMessage({
        type: 'EVENT_UPDATE',
        requestId: 'r5',
        sessionId: 's1',
        documentToken: 'doc-1',
        event: { id: 'e1', type: 'long-task', timestamp: 1200, duration: 240 },
      }),
    ).toBe(true);
    expect(
      isExtensionMessage({
        type: 'HIGHLIGHT_TARGET',
        requestId: 'r6',
        tabId: 12,
        target: { metricName: 'INP', color: 'yellow', selector: '#btn' },
      }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: 'CLEAR_HIGHLIGHT', requestId: 'r7', tabId: 12 }),
    ).toBe(true);
    expect(
      isExtensionMessage({
        type: 'OVERLAY_STATUS',
        requestId: 'r8',
        available: true,
        targetId: 'target-1',
      }),
    ).toBe(true);

    expect(
      isExtensionMessage({
        type: 'EVENT_UPDATE',
        requestId: 'r9',
        sessionId: 's1',
        event: { type: 'mystery', timestamp: 1200 },
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        type: 'HIGHLIGHT_TARGET',
        requestId: 'r10',
        tabId: 12,
        target: { color: 'blue' },
      }),
    ).toBe(false);
  });

  it('accepts experiment and markdown export messages', () => {
    expect(isExtensionMessage({ type: 'EXPERIMENT_LIST', requestId: 'e1' })).toBe(true);
    expect(
      isExtensionMessage({
        type: 'EXPERIMENT_START',
        requestId: 'e2',
        tabId: 12,
        baselineSessionId: 's1',
        preset: 'analytics',
        domains: ['google-analytics.com'],
      }),
    ).toBe(true);
    expect(
      isExtensionMessage({
        type: 'EXPERIMENT_START',
        requestId: 'e3',
        tabId: 12,
        baselineSessionId: 's1',
        preset: 'unknown',
        domains: ['google-analytics.com'],
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({ type: 'EXPERIMENT_FINISH', requestId: 'e4', experimentId: 'x1' }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: 'EXPORT_MARKDOWN', requestId: 'e5', sessionId: 's1' }),
    ).toBe(true);
    expect(isExtensionMessage({ type: 'CLEAR_HISTORY', requestId: 'e6' })).toBe(true);
  });

  it('rejects unknown and malformed messages', () => {
    expect(isExtensionMessage({ type: 'NOPE' })).toBe(false);
    expect(isExtensionMessage({ type: 'SESSION_START', requestId: 'r1' })).toBe(false);
    expect(
      isExtensionMessage({
        type: 'METRIC_UPDATE',
        requestId: 'r4',
        sessionId: 's1',
        metric: { name: 'LCP' },
      }),
    ).toBe(false);
  });
});
