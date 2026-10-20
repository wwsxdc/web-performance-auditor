import { describe, expect, it } from 'vitest';
import type { MetricRecord } from '../types/metrics';
import type { AuditSession } from '../types/session';
import { latestDocumentNavigationId, metricsForActiveSegment } from './metric-scope';

function metric(id: string, name: MetricRecord['name'], navigationId: string): MetricRecord {
  return {
    id,
    sessionId: 'session-1',
    navigationId,
    name,
    value: 1,
    unit: name === 'CLS' ? 'score' : 'ms',
    status: 'measured',
    rating: 'good',
    observedAt: 1,
    source: 'web-vitals',
  };
}

function session(): AuditSession {
  return {
    id: 'session-1',
    schemaVersion: 2,
    tabId: 1,
    url: 'https://example.com/',
    startedAt: 1,
    status: 'active',
    browser: { name: 'Chrome', version: '155' },
    navigations: [
      { id: 'doc-1', sessionId: 'session-1', url: 'https://example.com/a', kind: 'document', startedAt: 1, source: 'web-navigation' },
      { id: 'spa-1', sessionId: 'session-1', url: 'https://example.com/b', kind: 'spa', startedAt: 2, source: 'web-navigation' },
      { id: 'doc-2', sessionId: 'session-1', url: 'https://example.com/c', kind: 'document', startedAt: 3, source: 'web-navigation' },
      { id: 'spa-2', sessionId: 'session-1', url: 'https://example.com/d', kind: 'spa', startedAt: 4, source: 'web-navigation' },
    ],
    metrics: [
      metric('lcp-old', 'LCP', 'doc-1'),
      metric('cls-old', 'CLS', 'spa-1'),
      metric('lcp-new', 'LCP', 'doc-2'),
      metric('cls-new', 'CLS', 'spa-2'),
    ],
    events: [],
    experimentIds: [],
  };
}

describe('metricsForActiveSegment', () => {
  it('keeps load metrics on the latest document and CLS/INP on the active SPA segment', () => {
    const scoped = metricsForActiveSegment(session(), 'spa-2');
    expect(scoped.map((item) => item.id)).toEqual(['lcp-new', 'cls-new']);
  });

  it('falls back to the latest document CLS/INP after a SPA change with no new value', () => {
    const current = session();
    current.navigations.push({
      id: 'spa-3',
      sessionId: 'session-1',
      url: 'https://example.com/e',
      kind: 'spa',
      startedAt: 5,
      source: 'web-navigation',
    });
    expect(metricsForActiveSegment(current, 'spa-3').map((item) => item.id)).toEqual([
      'lcp-new',
      'cls-new',
    ]);
  });

  it('finds the latest document segment', () => {
    expect(latestDocumentNavigationId(session())).toBe('doc-2');
  });
});
