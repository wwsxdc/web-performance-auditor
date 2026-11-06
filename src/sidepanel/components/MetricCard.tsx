import type { MetricRecord, MetricName } from '../../types/metrics';
import { METRIC_THRESHOLDS } from '../../constants/thresholds';
import { formatMetricValue } from '../../utils/time';

interface MetricCardProps {
  metric: MetricRecord | undefined;
  name: MetricName;
  isPending: boolean;
  isSelected: boolean;
  highlighted?: boolean;
  canHighlight?: boolean;
  onSelect: (name: MetricName) => void;
  onHighlight?: () => void;
}

const RATING_STYLES = {
  good: { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-800', label: 'Хорошо' },
  'needs-improvement': { bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-800', label: 'Требует улучшения' },
  poor: { bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-800', label: 'Плохо' },
  unrated: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600', label: '' },
} as const;

export function MetricCard({
  metric,
  name,
  isPending,
  isSelected,
  highlighted = false,
  canHighlight = false,
  onSelect,
  onHighlight,
}: MetricCardProps) {
  const threshold = METRIC_THRESHOLDS[name];
  const rating = metric?.rating ?? 'unrated';
  const style = RATING_STYLES[rating];

  const displayValue = metric?.value !== undefined && metric.value !== null
    ? formatMetricValue(metric.value, metric.unit)
    : null;

  const isWaiting = isPending || metric?.status === 'pending';
  const isUnsupported = metric?.status === 'unsupported';
  const isUnavailable = metric?.status === 'unavailable' || metric?.status === 'incomplete';
  const hasAttribution = Boolean(metric?.attribution);

  return (
    <div
      className={`relative w-full rounded-xl border-2 transition-all ${style.bg} ${style.border} ${
        isSelected ? 'ring-2 ring-blue-400 ring-offset-1' : 'hover:brightness-[0.98]'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(name)}
        aria-pressed={isSelected}
        className="w-full rounded-xl p-3 pb-9 text-left"
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className={`text-sm font-bold ${style.text}`}>{name}</h3>
          <div className="flex items-center gap-1">
            {hasAttribution && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 font-medium text-blue-700">
                Детали
              </span>
            )}
            {threshold.isCoreWebVital && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/60 font-medium text-gray-500">
                CWV
              </span>
            )}
          </div>
        </div>

        {isWaiting ? (
          <div>
            <p className="text-xl font-mono text-gray-500">—</p>
            <p className="text-xs text-gray-500 mt-0.5">Ожидание…</p>
          </div>
        ) : isUnsupported || isUnavailable ? (
          <div>
            <p className="text-xl font-mono text-gray-500">—</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {isUnsupported
                ? 'Не поддерживается'
                : metric?.status === 'incomplete'
                  ? 'Неполные данные'
                  : 'Недоступно'}
            </p>
          </div>
        ) : displayValue ? (
          <div>
            <p className={`text-xl font-mono font-bold whitespace-nowrap ${style.text}`} aria-live="polite">
              {displayValue}
            </p>
            {style.label && (
              <p className={`text-xs mt-0.5 font-medium ${style.text}`}>
                {style.label}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xl font-mono text-gray-500">—</p>
            <p className="text-xs text-gray-500 mt-0.5">Нет данных</p>
          </div>
        )}

        <p className="text-[10px] mt-1.5 text-gray-500">
          Цель: ≤ {threshold.unit === 'ms' ? `${threshold.good} мс` : threshold.good}
        </p>
      </button>

      {canHighlight && onHighlight && (
        <button
          type="button"
          onClick={onHighlight}
          aria-label={`${highlighted ? 'Скрыть' : 'Подсветить'} ${name} на странице`}
          className={`absolute bottom-2 right-2 rounded-md border px-2 py-1 text-[10px] font-medium ${
            highlighted
              ? 'border-gray-800 bg-gray-800 text-white hover:bg-gray-700'
              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
          }`}
        >
          {highlighted ? 'Скрыть' : 'Подсветить'}
        </button>
      )}
    </div>
  );
}
