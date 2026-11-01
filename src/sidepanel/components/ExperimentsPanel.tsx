import { useMemo, useState } from 'react';
import type { AuditSession } from '../../types/session';
import type { Experiment, ExperimentPreset } from '../../types/experiment';
import type { MetricName } from '../../types/metrics';
import {
  EXPERIMENT_PRESETS,
  EXPERIMENT_WARNING,
} from '../../constants/experiments';
import {
  aggregateExperimentRuns,
  COMPARABLE_METRICS,
  hasCoreResult,
  normalizeDomains,
  sameExperimentSetup,
  summarizeMetrics,
  type ExperimentRunAggregate,
} from '../../utils/experiment';
import { formatMetricValue } from '../../utils/time';

interface ExperimentsPanelProps {
  session: AuditSession | null;
  experiments: Experiment[];
  activeExperiment?: Experiment;
  error?: string;
  onStart: (input: {
    baselineSessionId: string;
    tabId: number;
    preset: ExperimentPreset;
    domains: string[];
    note?: string;
  }) => Promise<Experiment | undefined>;
  onFinish: (experimentId: string) => Promise<unknown>;
  onCancel: (experimentId: string) => Promise<unknown>;
}

const STATUS_LABELS: Record<Experiment['status'], string> = {
  running: 'Идёт измерение',
  completed: 'Завершён',
  incomplete: 'Неполный',
  failed: 'Ошибка',
  cancelled: 'Отменён',
};

const CLEANUP_LABELS: Record<Experiment['cleanupStatus'], string> = {
  pending: 'Ожидает очистки',
  completed: 'Правила удалены и проверены',
  failed: 'Не удалось подтвердить удаление правил',
};

function formatSigned(value: number | null, unit: 'ms' | 'score'): string {
  if (value === null) return '—';
  const formatted = formatMetricValue(Math.abs(value), unit);
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatted}`;
}

function RunSummary({
  aggregates,
  completedRuns,
}: {
  aggregates: ExperimentRunAggregate[];
  completedRuns: number;
}) {
  if (completedRuns < 2 || aggregates.length === 0) {
    return (
      <p className="mt-2 rounded-md border border-dashed border-gray-300 bg-gray-50 p-2 text-[10px] text-gray-500">
        Прогноз недоступен: для медианы нужно минимум 2 завершённых прогона с одинаковыми
        настройками. Ниже показан фактический результат одного измерения, а не обещание улучшения.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-2.5">
      <h4 className="text-[11px] font-semibold text-blue-900">
        Повторные прогоны: {completedRuns}
      </h4>
      <p className="mt-0.5 text-[10px] text-blue-700">
        Метод: медиана абсолютной разницы «эксперимент − исходная»; диапазон показывает
        наблюдавшийся разброс. Это факт измерения, а не гарантированный прогноз.
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {aggregates.map((aggregate) => {
          const unit = aggregate.name === 'CLS' ? 'score' : 'ms';
          return (
            <li key={aggregate.name} className="flex justify-between gap-2 text-[10px] text-blue-900">
              <span className="font-medium">{aggregate.name}</span>
              <span className="font-mono">
                {formatSigned(aggregate.median, unit)}
              </span>
              <span className="font-mono text-blue-600">
                {formatSigned(aggregate.min, unit)} … {formatSigned(aggregate.max, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ComparisonTable({ experiment }: { experiment: Experiment }) {
  const baselineUnit = (name: MetricName) => (name === 'CLS' ? 'score' : 'ms');

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="py-1 pr-2 font-medium">Показатель</th>
            <th className="py-1 pr-2 font-medium">Исходная</th>
            <th className="py-1 pr-2 font-medium">Эксперимент</th>
            <th className="py-1 pr-2 font-medium">Изменение</th>
            <th className="py-1 font-medium">Отн.</th>
          </tr>
        </thead>
        <tbody>
          {experiment.comparison.map((row) => {
            const unit = baselineUnit(row.name);
            return (
              <tr key={row.name} className="border-t border-gray-100">
                <td className="py-1 pr-2 font-medium text-gray-700">{row.name}</td>
                <td className="py-1 pr-2 font-mono">
                  {row.baseline === null ? '—' : formatMetricValue(row.baseline, unit)}
                </td>
                <td className="py-1 pr-2 font-mono">
                  {row.experiment === null ? '—' : formatMetricValue(row.experiment, unit)}
                </td>
                <td className="py-1 pr-2 font-mono">{formatSigned(row.absolute, unit)}</td>
                <td className="py-1 font-mono">
                  {row.relativePercent === null
                    ? '—'
                    : `${row.relativePercent > 0 ? '+' : ''}${row.relativePercent.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1.5 text-[10px] text-gray-500">
        Если метрика недоступна в одной из сессий, разница не рассчитывается. Прогноз улучшения недоступен:
        сравниваются только фактические измерения.
      </p>
      {experiment.limitations.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[10px] text-gray-500">
          {experiment.limitations.map((limitation) => (
            <li key={limitation}>• {limitation}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExperimentsPanel({
  session,
  experiments,
  activeExperiment,
  error,
  onStart,
  onFinish,
  onCancel,
}: ExperimentsPanelProps) {
  const [preset, setPreset] = useState<ExperimentPreset>('analytics');
  const [domainsText, setDomainsText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const baselineValues = useMemo(
    () => summarizeMetrics(session?.metrics ?? []),
    [session?.metrics],
  );
  const enoughBaseline = hasCoreResult(baselineValues);
  const presetConfig = EXPERIMENT_PRESETS[preset];
  const domains = useMemo(() => {
    const source = presetConfig.requiresDomains ? domainsText.split(/[\s,;]+/) : presetConfig.domains;
    return normalizeDomains(source);
  }, [presetConfig, domainsText]);

  const relevantExperiment = useMemo(() => {
    if (!session) return experiments[0];
    return experiments.find(
      (experiment) =>
        experiment.baselineSessionId === session.id ||
        experiment.experimentSessionId === session.id,
    );
  }, [experiments, session]);

  const comparableRuns = useMemo(() => {
    if (!relevantExperiment) return [];
    return experiments.filter((experiment) =>
      sameExperimentSetup(experiment, relevantExperiment),
    );
  }, [experiments, relevantExperiment]);

  const runAggregates = useMemo(
    () => aggregateExperimentRuns(comparableRuns),
    [comparableRuns],
  );
  const completedRuns = useMemo(
    () => comparableRuns.filter((experiment) => experiment.status === 'completed').length,
    [comparableRuns],
  );

  const handleStart = async () => {
    if (!session || !confirmed || domains.length === 0) return;
    setBusy(true);
    await onStart({
      baselineSessionId: session.id,
      tabId: session.tabId,
      preset,
      domains,
      note: undefined,
    });
    setBusy(false);
    setConfirmed(false);
  };

  const handleFinish = async (experiment: Experiment) => {
    setBusy(true);
    await onFinish(experiment.id);
    setBusy(false);
  };

  const handleCancel = async (experiment: Experiment) => {
    setBusy(true);
    await onCancel(experiment.id);
    setBusy(false);
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-3 mt-4" aria-label="Эксперименты">
      <h2 className="text-sm font-bold text-gray-900">Эксперименты</h2>

      {error && (
        <p className="mt-2 rounded-md bg-red-50 border border-red-200 p-2 text-[11px] text-red-700" role="alert">
          {error}
        </p>
      )}

      {activeExperiment ? (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-900">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{STATUS_LABELS[activeExperiment.status]}</p>
              <p className="mt-0.5 text-[11px] text-blue-700">
                Пресет: {EXPERIMENT_PRESETS[activeExperiment.preset].label}
              </p>
              <p className="text-[11px] text-blue-700">
                Заблокировано доменов: {activeExperiment.domains.length}
              </p>
              <p className="text-[11px] text-blue-700">
                Очистка правил: {CLEANUP_LABELS[activeExperiment.cleanupStatus]}
              </p>
            </div>
            <span className="font-mono text-[10px] text-blue-600">{activeExperiment.id.slice(0, 8)}</span>
          </div>

          <p className="mt-2 text-[11px] text-blue-800">
            Измерение идёт в новой загрузке страницы. Завершите эксперимент, чтобы снять правила блокировки.
          </p>

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void handleFinish(activeExperiment)}
              disabled={busy}
              className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Завершить эксперимент
            </button>
            <button
              type="button"
              onClick={() => void handleCancel(activeExperiment)}
              disabled={busy}
              className="rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              Отменить
            </button>
          </div>
        </div>
      ) : (
        <>
          {relevantExperiment && relevantExperiment.status !== 'running' && (
            <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-gray-800">
                  Последний эксперимент: {STATUS_LABELS[relevantExperiment.status].toLowerCase()}
                </p>
                <span className="font-mono text-[10px] text-gray-500">
                  {relevantExperiment.id.slice(0, 8)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                Пресет: {EXPERIMENT_PRESETS[relevantExperiment.preset].label}. Домены:{' '}
                {relevantExperiment.domains.join(', ')}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500">
                Очистка правил: {CLEANUP_LABELS[relevantExperiment.cleanupStatus]}
              </p>
              <ComparisonTable experiment={relevantExperiment} />
              <RunSummary aggregates={runAggregates} completedRuns={completedRuns} />
              <button
                type="button"
                onClick={() => {
                  setPreset(relevantExperiment.preset);
                  setDomainsText(relevantExperiment.domains.join(', '));
                  setConfirmed(false);
                }}
                className="mt-2 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 hover:bg-gray-50"
              >
                Подставить настройки для повтора
              </button>
            </div>
          )}

          {!session ? (
            <p className="mt-2 text-xs text-gray-500">
              Запустите наблюдение, чтобы проводить эксперименты на текущей вкладке.
            </p>
          ) : (
            <div className="mt-2 space-y-3">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Исходные метрики
                </h3>
                <div className="mt-1 grid grid-cols-3 gap-1.5 text-[11px]">
                  {COMPARABLE_METRICS.map((name) => (
                    <div key={name} className="rounded-md bg-gray-50 border border-gray-200 px-2 py-1">
                      <p className="text-gray-500">{name}</p>
                      <p className="font-mono text-gray-800">
                        {baselineValues[name] === null
                          ? '—'
                          : formatMetricValue(baselineValues[name], name === 'CLS' ? 'score' : 'ms')}
                      </p>
                    </div>
                  ))}
                </div>
                {!enoughBaseline && (
                  <p className="mt-1.5 text-[11px] text-amber-700">
                    Для запуска нужно измерить хотя бы один показатель LCP, CLS или INP.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="experiment-preset" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Ограничения
                </label>
                <select
                  id="experiment-preset"
                  value={preset}
                  onChange={(event) => {
                    setPreset(event.target.value as ExperimentPreset);
                    setConfirmed(false);
                  }}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800"
                >
                  {Object.entries(EXPERIMENT_PRESETS).map(([value, config]) => (
                    <option key={value} value={value}>
                      {config.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-gray-500">{presetConfig.description}</p>
              </div>

              {presetConfig.requiresDomains && (
                <div>
                  <label htmlFor="experiment-domains" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Домены для блокировки
                  </label>
                  <textarea
                    id="experiment-domains"
                    value={domainsText}
                    onChange={(event) => {
                      setDomainsText(event.target.value);
                      setConfirmed(false);
                    }}
                    rows={2}
                    placeholder="example.com, cdn.example.org"
                    className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-800"
                  />
                </div>
              )}

              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Потенциально затрагиваемые ресурсы
                </h3>
                {domains.length > 0 ? (
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {domains.map((domain) => (
                      <li
                        key={domain}
                        className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-700"
                      >
                        {domain}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] text-gray-500">Домены не заданы.</p>
                )}
              </div>

              <p className="rounded-md bg-amber-50 border border-amber-200 p-2 text-[11px] text-amber-800">
                {EXPERIMENT_WARNING}
              </p>

              <label className="flex items-start gap-2 text-[11px] text-gray-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5"
                />
                Подтверждаю изменение правил сетевого доступа и перезагрузку страницы.
              </label>

              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={!confirmed || !enoughBaseline || domains.length === 0 || busy}
                className="w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Запуск...' : 'Запустить эксперимент'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
