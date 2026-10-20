import { useSession } from '../sidepanel/hooks/useSession';
import type { MetricName, MetricRating } from '../types/metrics';
import { selectMetricForDisplay } from '../utils/select-metric';
import { formatMetricValue } from '../utils/time';
import type { CollectorStatus } from '../types/messages';

const METRIC_NAMES: MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

const STATUS_LABELS: Record<CollectorStatus, string> = {
  idle: 'Наблюдение не запущено',
  initializing: 'Подключение к странице',
  collecting: 'Сбор метрик',
  unsupported: 'Страница не поддерживается',
  'permission-denied': 'Нет доступа к странице',
  error: 'Ошибка сбора',
};

const RATING_LABELS: Record<MetricRating, string> = {
  good: 'хорошо',
  'needs-improvement': 'требует улучшения',
  poor: 'плохо',
  unrated: 'без оценки',
};

const RATING_CLASSES: Record<MetricRating, string> = {
  good: 'text-green-700 bg-green-50 border-green-200',
  'needs-improvement': 'text-amber-700 bg-amber-50 border-amber-200',
  poor: 'text-red-700 bg-red-50 border-red-200',
  unrated: 'text-gray-600 bg-gray-50 border-gray-200',
};

export function PopupApp() {
  const { state, startSession, stopSession, isLoading } = useSession();
  const status = state?.collectorStatus ?? 'idle';
  const session = state?.session;
  const isActive = session?.status === 'active';

  if (isLoading) {
    return <p className="p-4 text-sm text-gray-500">Загрузка...</p>;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-3 text-gray-800">
      <header className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-sm font-bold">Web Performance Auditor</h1>
            <p className="mt-0.5 truncate text-[11px] text-gray-500" title={session?.url ?? state?.activeTabUrl ?? ''}>
              {session?.url ?? state?.activeTabUrl ?? 'URL не определён'}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600">
            {STATUS_LABELS[status]}
          </span>
        </div>

        <div className="mt-2 flex gap-2">
          {isActive ? (
            <button
              type="button"
              onClick={() => void stopSession()}
              className="flex-1 rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-900"
            >
              Остановить наблюдение
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startSession()}
              className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Начать наблюдение
            </button>
          )}
        </div>

        {state?.error && (
          <p className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700" role="alert">
            {state.error}
          </p>
        )}
      </header>

      <section className="mt-3" aria-label="Метрики" aria-live="polite">
        <ul className="grid grid-cols-1 gap-1.5">
          {METRIC_NAMES.map((name) => {
            const metric = session ? selectMetricForDisplay(session.metrics, name) : undefined;
            return (
              <li
                key={name}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5"
              >
                <span className="text-xs font-semibold">{name}</span>
                <span className="font-mono text-xs">
                  {metric ? formatMetricValue(metric.value, metric.unit) : '—'}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    RATING_CLASSES[metric?.rating ?? 'unrated']
                  }`}
                >
                  {RATING_LABELS[metric?.rating ?? 'unrated']}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="mt-3 text-[10px] text-gray-400">
        Это компактный интерфейс для браузеров без Side Panel API. Полные детали, график и
        эксперименты доступны в боковой панели там, где она поддерживается.
      </p>
    </main>
  );
}
