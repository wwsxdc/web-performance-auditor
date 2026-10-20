import type { JsonReport } from '../types/report';
import type { Experiment } from '../types/experiment';
import type { MetricName } from '../types/metrics';
import { selectMetricForDisplay } from './select-metric';
import { formatMetricValue, formatTimestamp } from './time';

const METRIC_NAMES: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

function formatMs(value: number | undefined): string {
  return formatMetricValue(value ?? null, 'ms');
}

function metricRow(report: JsonReport, name: MetricName): string {
  const metric = selectMetricForDisplay(report.metrics, name);
  if (!metric) {
    return `| ${name} | — | нет данных | — |`;
  }
  return `| ${name} | ${formatMetricValue(metric.value, metric.unit)} | ${metric.rating ?? '—'} | ${metric.attribution?.target?.selector ?? '—'} |`;
}

function issueLines(report: JsonReport): string[] {
  const issues: string[] = [];

  for (const name of METRIC_NAMES) {
    const metric = selectMetricForDisplay(report.metrics, name);
    if (!metric || (metric.rating !== 'needs-improvement' && metric.rating !== 'poor')) {
      continue;
    }

    const target = metric.attribution?.target?.selector;
    const time = formatTimestamp(metric.observedAt);
    issues.push(
      `- **${name}**: ${formatMetricValue(metric.value, metric.unit)} в ${time}` +
        (target ? `, цель \`${target}\`` : ', DOM-цель не определена') +
        ` (${metric.rating === 'poor' ? 'плохо' : 'требует улучшения'}).`,
    );

    if (name === 'LCP' && metric.attribution?.lcp) {
      const phases = metric.attribution.lcp;
      issues.push(
        `  - Фазы: TTFB ${formatMs(phases.timeToFirstByte)}, ` +
          `задержка рендеринга ${formatMs(phases.elementRenderDelay)}.`,
      );
    }

    if (name === 'CLS' && metric.attribution?.cls?.sources?.length) {
      const selectors = metric.attribution.cls.sources
        .map((source) => source.selector)
        .filter((selector): selector is string => Boolean(selector));
      if (selectors.length > 0) {
        issues.push(`  - Источники сдвига: ${selectors.map((selector) => `\`${selector}\``).join(', ')}.`);
      }
    }

    if (name === 'INP' && metric.attribution?.inp) {
      const phases = metric.attribution.inp;
      issues.push(
        `  - Фазы: input delay ${formatMs(phases.inputDelay)}, ` +
          `processing ${formatMs(phases.processingDuration)}, ` +
          `presentation ${formatMs(phases.presentationDelay)}.`,
      );
      if (metric.attribution.longTaskIds?.length) {
        issues.push(
          `  - Пересекающиеся Long Tasks: ${metric.attribution.longTaskIds.map((id) => `\`${id}\``).join(', ')} (совпадение по времени не доказывает причину).`,
        );
      }
    }
  }

  return issues.length > 0 ? issues : ['- Проблемных значений Core Web Vitals в сессии не обнаружено.'];
}

function experimentSection(experiment: Experiment): string[] {
  const lines = [
    '## Эксперимент',
    '',
    `- Статус: **${experiment.status}**`,
    `- Очистка правил: ${experiment.cleanupStatus}`,
    `- Пресет: ${experiment.preset}`,
    `- Заблокированные домены: ${experiment.domains.map((domain) => `\`${domain}\``).join(', ')}`,
    `- Исходная сессия: \`${experiment.baselineSessionId}\``,
    experiment.experimentSessionId
      ? `- Экспериментальная сессия: \`${experiment.experimentSessionId}\``
      : '- Экспериментальная сессия: не создана',
    '',
    '| Показатель | Исходная сессия | Эксперимент | Изменение | Относительное изменение |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  for (const row of experiment.comparison) {
    const absolute =
      row.absolute === null
        ? '—'
        : `${row.absolute > 0 ? '+' : ''}${Number(row.absolute.toFixed(2))}`;
    const relative =
      row.relativePercent === null
        ? '—'
        : `${row.relativePercent > 0 ? '+' : ''}${row.relativePercent.toFixed(1)}%`;
    lines.push(
      `| ${row.name} | ${row.baseline ?? '—'} | ${row.experiment ?? '—'} | ${absolute} | ${relative} |`,
    );
  }

  lines.push(
    '',
    'Прогноз улучшения недоступен: таблица содержит только фактические измерения, а не гарантию результата.',
  );

  if (experiment.limitations.length > 0) {
    lines.push('', 'Ограничения эксперимента:');
    for (const limitation of experiment.limitations) lines.push(`- ${limitation}`);
  }

  return lines;
}

export function generateMarkdownReport(
  report: JsonReport,
  experiment?: Experiment,
): string {
  const started = formatTimestamp(report.session.startedAt);
  const completed = report.session.endedAt
    ? formatTimestamp(report.session.endedAt)
    : 'сессия ещё активна';

  const lines = [
    '# Web Performance Auditor',
    '',
    '## Сводка',
    '',
    `- URL: ${report.session.url}`,
    `- Браузер: ${report.session.browser.name}${report.session.browser.version ? ` ${report.session.browser.version}` : ''}`,
    `- Наблюдение: ${started} — ${completed}`,
    `- Статус сессии: ${report.session.status}`,
    `- Сессия: \`${report.session.id}\``,
    `- Схема: ${report.schemaVersion}, версия отчёта: ${report.reportVersion}`,
    '',
    '## Метрики (факты)',
    '',
    '| Метрика | Значение | Оценка | DOM-цель |',
    '| --- | ---: | --- | --- |',
    ...METRIC_NAMES.map((name) => metricRow(report, name)),
    '',
    'Одиночная локальная сессия не позволяет вычислить репрезентативный p75. Оценки Core Web Vitals даны для измеренных значений, а не для распределения посещений.',
    '',
    '## Обнаруженные проблемы (факты)',
    '',
    ...issueLines(report),
    '',
    '## Ограничения измерения',
    '',
  ];

  if (report.limitations.length > 0) {
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  } else {
    lines.push('- Существенных ограничений не зафиксировано.');
  }

  if (experiment) {
    lines.push('', ...experimentSection(experiment));
  }

  lines.push(
    '',
    '## Рекомендации (не факты)',
    '',
    '- Проверьте выявленные DOM-цели и связанные события в контексте страницы.',
    '- Для LCP сравните фазы загрузки ресурса и задержку рендеринга.',
    '- Для CLS проверьте источники сдвига и стабильность геометрии.',
    '- Для INP проверьте Long Tasks и стоимость обработчиков взаимодействия.',
    '- Повторите измерение в сопоставимых сетевых условиях: кэш, сеть и состояние приложения могут влиять на результат.',
    '',
    '## Предположения',
    '',
    '- Причины проблем не доказаны только по совпадению времени или одному измерению.',
    '- Эксперимент с блокировкой не гарантирует улучшение Core Web Vitals.',
  );

  return lines.join('\n');
}
