import { describe, expect, it } from 'vitest';
import { generateMarkdownReport } from './markdown';
import type { JsonReport } from '../types/report';
import type { Experiment } from '../types/experiment';

const report: JsonReport = {
  reportVersion: 1,
  schemaVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  tool: { name: 'Web Performance Auditor', version: '0.1.0' },
  session: {
    id: 'session-1',
    tabId: 7,
    url: 'https://example.com/path',
    startedAt: 1_000,
    endedAt: 10_000,
    status: 'completed',
    browser: { name: 'Chrome', version: '155' },
    navigations: [],
  },
  metrics: [
    {
      id: 'm1',
      sessionId: 'session-1',
      navigationId: 'nav-1',
      name: 'LCP',
      value: 4200,
      unit: 'ms',
      status: 'measured',
      rating: 'poor',
      observedAt: 5_000,
      source: 'web-vitals',
      attribution: {
        source: 'web-vitals',
        derived: [],
        target: {
          targetId: 'target-1',
          selector: '#hero > img',
          tagName: 'img',
          available: true,
          capturedAt: 5_000,
        },
        lcp: { timeToFirstByte: 200, elementRenderDelay: 1200 },
      },
    },
  ],
  attribution: [],
  events: [],
  experiments: [],
  limitations: ['LCP: метрика не была измерена за время сессии'],
  completeness: {
    level: 'partial',
    reasons: ['INP: ожидает измерения'],
    observedSince: 1_000,
  },
};

const experiment: Experiment = {
  id: 'experiment-1',
  schemaVersion: 2,
  baselineSessionId: 'session-1',
  experimentSessionId: 'session-2',
  tabId: 7,
  url: 'https://example.com/path',
  createdAt: 20_000,
  startedAt: 20_000,
  endedAt: 30_000,
  status: 'completed',
  preset: 'analytics',
  domains: ['google-analytics.com'],
  rules: [{ id: 10_000, domains: ['google-analytics.com'] }],
  baselineValues: { LCP: 4200, CLS: 0.2, INP: 300, FCP: null, TTFB: null },
  experimentValues: { LCP: 3000, CLS: 0.1, INP: 200, FCP: null, TTFB: null },
  comparison: [
    { name: 'LCP', baseline: 4200, experiment: 3000, absolute: -1200, relativePercent: -28.57 },
    { name: 'CLS', baseline: 0.2, experiment: 0.1, absolute: -0.1, relativePercent: -50 },
  ],
  limitations: ['Различия могут быть вызваны кэшем.'],
  cleanupVerified: true,
  cleanupStatus: 'completed',
};

describe('generateMarkdownReport', () => {
  it('builds a readable report with facts, issues, limitations and experiment comparison', () => {
    const markdown = generateMarkdownReport(report, experiment);

    expect(markdown).toContain('# Web Performance Auditor');
    expect(markdown).toContain('## Сводка');
    expect(markdown).toContain('https://example.com/path');
    expect(markdown).not.toContain('token=');
    expect(markdown).toContain('#hero > img');
    expect(markdown).toContain('Фазы: TTFB 200 мс');
    expect(markdown).toContain('## Ограничения измерения');
    expect(markdown).toContain('## Полнота данных');
    expect(markdown).toContain('Полнота данных: **Частичная**');
    expect(markdown).toContain('- INP: ожидает измерения');
    expect(markdown).toContain('## Эксперимент');
    expect(markdown).toContain('-28.6%');
    expect(markdown).toContain('Прогноз улучшения недоступен');
    expect(markdown).toContain('## Рекомендации (не факты)');
  });

  it('keeps unavailable metrics as placeholders without inventing numbers', () => {
    const markdown = generateMarkdownReport({
      ...report,
      metrics: [],
      limitations: [],
    });

    expect(markdown).toContain('| LCP | — | нет данных | — |');
    expect(markdown).toContain('- Существенных ограничений не зафиксировано.');
    expect(markdown).not.toContain('## Эксперимент');
  });
});
