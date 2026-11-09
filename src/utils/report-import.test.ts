import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, STORAGE_LIMITS } from '../constants/config';
import { makeImportReport } from '../test/report-fixture';
import {
  buildImportBundle,
  isSameImportedReport,
  parseImportPayload,
  summarizeImportReport,
  validateImportIntegrity,
} from './report-import';


describe('parseImportPayload', () => {
  it('accepts a report produced by EXPORT_JSON', () => {
    const result = parseImportPayload(JSON.stringify(makeImportReport()));
    expect(result.error).toBeUndefined();
    expect(result.report?.session.id).toBe('session-1');
  });

  it('rejects malformed JSON and non-report values', () => {
    expect(parseImportPayload('{oops')?.error).toContain('корректным JSON');
    expect(parseImportPayload('{"hello":"world"}')?.error).toContain('Некорректный отчёт');
    expect(parseImportPayload(42)?.error).toContain('текста JSON');
  });

  it('rejects a report larger than the byte limit', () => {
    const result = parseImportPayload('{"padding":"xxxxxxxxxx"}', { maxBytes: 10 });
    expect(result.error).toContain('больше');
  });

  it('rejects a newer report or schema version', () => {
    const newerReport = { ...makeImportReport(), reportVersion: 2 };
    expect(parseImportPayload(JSON.stringify(newerReport)).error).toContain('Версия отчёта');

    const newerSchema = { ...makeImportReport(), schemaVersion: SCHEMA_VERSION + 1 };
    expect(parseImportPayload(JSON.stringify(newerSchema)).error).toContain('Версия схемы');
  });
});

describe('validateImportIntegrity', () => {
  it('accepts an export and warns about active status', () => {
    const result = validateImportIntegrity(makeImportReport());
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('прерванная');
  });

  it('rejects non-http URLs', () => {
    const report = makeImportReport();
    report.session.url = 'javascript:alert(1)';
    const result = validateImportIntegrity(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('URL сессии');
  });

  it('rejects reports over the hard count limits', () => {
    const report = makeImportReport();
    report.metrics = Array.from({ length: 10_001 }, (_, index) => ({
      ...makeImportReport().metrics[0],
      id: `session-1:m${index}`,
    }));
    const result = validateImportIntegrity(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Слишком много метрик');
  });

  it('warns about dangling navigation references instead of failing', () => {
    const report = makeImportReport();
    report.metrics[0].navigationId = 'missing-nav';
    const result = validateImportIntegrity(report);
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('отсутствующую навигацию');
  });
});

describe('buildImportBundle', () => {
  it('creates independent ids and remaps every reference', () => {
    const bundle = buildImportBundle(makeImportReport());

    expect(bundle.session.id).toMatch(/^imp-/);
    expect(bundle.session.origin).toBe('imported');
    expect(bundle.session.importedFrom).toEqual({
      sessionId: 'session-1',
      generatedAt: '2026-10-20T00:00:00.000Z',
      toolVersion: '0.2.0',
    });
    expect(bundle.session.url).toBe('https://example.com/page');
    expect(bundle.session.status).toBe('interrupted');
    expect(bundle.session.navigations[0].url).toBe('https://example.com/page');
    expect(bundle.session.navigations[0].id).not.toBe('nav-1');

    const metric = bundle.metrics[0];
    const event = bundle.events[0];
    expect(metric.id).not.toBe('session-1:m1');
    expect(metric.sessionId).toBe(bundle.session.id);
    expect(metric.navigationId).toBe(bundle.session.navigations[0].id);
    expect(metric.attribution?.longTaskIds).toEqual([event.id]);
    expect(event.id).not.toBe('session-1:lt1');
    expect(event.sessionId).toBe(bundle.session.id);
    expect(event.relatedMetricIds).toEqual([metric.id]);
  });

  it('never reuses the source id, so an import cannot overwrite history', () => {
    const first = buildImportBundle(makeImportReport());
    const second = buildImportBundle(makeImportReport());
    expect(first.session.id).not.toBe(second.session.id);
    expect(first.metrics[0].id).not.toBe(second.metrics[0].id);
  });

  it('turns a running experiment into safe completed history without DNR rules', () => {
    const bundle = buildImportBundle(makeImportReport());
    const experiment = bundle.experiments[0];

    expect(experiment.baselineSessionId).toBe(bundle.session.id);
    expect(experiment.status).toBe('incomplete');
    expect(experiment.cleanupStatus).toBe('completed');
    expect(experiment.rules).toEqual([]);
    expect(experiment.limitations.join(' ')).toContain('правила блокировки не применялись');
    expect(bundle.session.experimentIds).toEqual([experiment.id]);
  });

  it('drops an experiment whose baseline session is missing from the report', () => {
    const report = makeImportReport();
    report.experiments[0].baselineSessionId = 'other-session';
    const bundle = buildImportBundle(report);
    expect(bundle.experiments).toEqual([]);
    expect(bundle.warnings.join(' ')).toContain('исходная сессия отсутствует');
  });

  it('truncates records to the storage limits with a warning', () => {
    const report = makeImportReport();
    report.metrics = Array.from(
      { length: STORAGE_LIMITS.maxMetricsPerSession + 1 },
      (_, index) => ({
        ...makeImportReport().metrics[0],
        id: `session-1:m${index}`,
        observedAt: 1000 + index,
      }),
    );
    report.events = Array.from(
      { length: STORAGE_LIMITS.maxEventsPerSession + 1 },
      (_, index) => ({
        ...makeImportReport().events[0],
        id: `session-1:e${index}`,
        timestamp: 1000 + index,
      }),
    );

    const bundle = buildImportBundle(report);
    expect(bundle.metrics).toHaveLength(STORAGE_LIMITS.maxMetricsPerSession);
    expect(bundle.events).toHaveLength(STORAGE_LIMITS.maxEventsPerSession);
    expect(bundle.warnings.join(' ')).toContain(
      `Сохранено ${STORAGE_LIMITS.maxMetricsPerSession} из ${STORAGE_LIMITS.maxMetricsPerSession + 1}`,
    );
    expect(bundle.warnings.join(' ')).toContain(
      `Сохранено ${STORAGE_LIMITS.maxEventsPerSession} из ${STORAGE_LIMITS.maxEventsPerSession + 1}`,
    );
  });
});

describe('summarizeImportReport', () => {
  it('reports what the user is about to import', () => {
    const preview = summarizeImportReport(makeImportReport());
    expect(preview.url).toBe('https://example.com/page');
    expect(preview.metricCount).toBe(1);
    expect(preview.eventCount).toBe(1);
    expect(preview.experimentCount).toBe(1);
    expect(preview.status).toBe('interrupted');
    expect(preview.toolVersion).toBe('0.2.0');
  });
});

describe('isSameImportedReport', () => {
  it('matches the source session and generation time', () => {
    const report = makeImportReport();
    const bundle = buildImportBundle(report);
    expect(isSameImportedReport(bundle.session, report)).toBe(true);
    expect(
      isSameImportedReport(bundle.session, { ...report, generatedAt: '2026-10-21T00:00:00.000Z' }),
    ).toBe(false);
  });
});
