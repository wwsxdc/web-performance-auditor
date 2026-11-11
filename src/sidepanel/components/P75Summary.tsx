import { useCallback, useEffect, useState } from 'react';
import type { P75Aggregate } from '../../types/aggregate';
import { METRIC_THRESHOLDS } from '../../constants/thresholds';
import { calculateRating } from '../../utils/rating';
import { formatMetricValue } from '../../utils/time';
import { pluralizeRu } from '../../utils/plural';
import { generateId } from '../../utils/id';
import { sendRuntimeMessage } from '../api';

interface P75SummaryProps {
  /** Bumps when history changed (import, delete, clear, finished session). */
  revision: number;
}

interface AggregateResponse {
  aggregate?: P75Aggregate;
  error?: string;
}

const RATING_LABELS = {
  good: 'Хорошо',
  'needs-improvement': 'Требует улучшения',
  poor: 'Плохо',
  unrated: '',
} as const;

const RATING_CLASSES = {
  good: 'text-green-800',
  'needs-improvement': 'text-yellow-800',
  poor: 'text-red-800',
  unrated: 'text-gray-600',
} as const;

export function P75Summary({ revision }: P75SummaryProps) {
  const [aggregate, setAggregate] = useState<P75Aggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);

  const refresh = useCallback(() => setLocalRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void sendRuntimeMessage<AggregateResponse>({
      type: 'GET_P75_AGGREGATE',
      requestId: generateId(),
    })
      .then((response) => {
        if (cancelled) return;
        if (response?.error) {
          setError(response.error);
          return;
        }
        setError(null);
        setAggregate(response?.aggregate ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(`Не удалось рассчитать p75: ${String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision, localRevision]);

  const sampled = aggregate?.sampledSessions ?? 0;

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-3"
      aria-labelledby="wpa-p75-heading"
      aria-busy={loading}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="wpa-p75-heading" className="text-sm font-semibold text-gray-800">
          p75 по истории
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Расчёт…' : 'Обновить'}
        </button>
      </div>

      <p id="wpa-p75-note" className="mt-1 text-[11px] text-gray-500">
        Одно последнее измеренное значение на сессию. Активные сессии не учитываются.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}

      {!error && loading && !aggregate && (
        <p role="status" className="mt-2 text-xs text-gray-500">
          Расчёт p75…
        </p>
      )}

      {!error && aggregate && sampled === 0 && (
        <p className="mt-2 rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-500">
          Пока нет завершённых сессий с измерениями. Завершите аудит или импортируйте отчёт.
        </p>
      )}

      {!error && aggregate && sampled > 0 && (
        <>
          <p className="mt-1 text-[11px] text-gray-600">
            {sampled} {pluralizeRu(sampled, ['сессия', 'сессии', 'сессий'])} с данными из{' '}
            {aggregate.sessions} {pluralizeRu(aggregate.sessions, ['сессии', 'сессий', 'сессий'])}
          </p>
          <ul className="mt-2 space-y-1" aria-describedby="wpa-p75-note">
            {aggregate.metrics.map((entry) => {
              const threshold = METRIC_THRESHOLDS[entry.name];
              const rating = calculateRating(entry.name, entry.p75);
              return (
                <li
                  key={entry.name}
                  className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2 py-1.5 text-xs"
                >
                  <span className="font-semibold text-gray-800">{entry.name}</span>
                  <span className="font-mono text-gray-800">
                    {formatMetricValue(entry.p75, threshold.unit)}
                  </span>
                  <span className={`text-[11px] font-medium ${RATING_CLASSES[rating]}`}>
                    {entry.p75 === null ? 'нет данных' : RATING_LABELS[rating]}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {entry.samples}{' '}
                    {pluralizeRu(entry.samples, ['сессия', 'сессии', 'сессий'])}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
