import { useState } from 'react';
import type { DiagnosticEvent, DiagnosticEventType } from '../../types/events';
import type {
  DomTargetSnapshot,
  MetricName,
  MetricRecord,
  MetricStatus,
} from '../../types/metrics';
import type { OverlayStatus } from '../../types/messages';
import { formatMetricValue } from '../../utils/time';

type OverlayColor = 'green' | 'red' | 'yellow';

interface MetricDetailsProps {
  metric: MetricRecord;
  events: DiagnosticEvent[];
  overlayStatus: OverlayStatus | null | undefined;
  overlayEnabled: boolean;
  onHighlight: (
    target: DomTargetSnapshot,
    color: OverlayColor,
    label: string,
    metricName: MetricName,
  ) => void;
  onClearHighlight: (metricName?: MetricName) => void;
}

const STATUS_LABELS: Record<MetricStatus, string> = {
  pending: 'Ожидает измерения',
  measured: 'Измерено',
  unsupported: 'Не поддерживается браузером',
  unavailable: 'Недоступно',
  incomplete: 'Неполные данные',
};

const EVENT_LABELS: Record<DiagnosticEventType, string> = {
  'metric-update': 'Обновление метрики',
  'layout-shift': 'Сдвиг макета',
  'long-task': 'Long Task',
  interaction: 'Взаимодействие',
  'spa-navigation': 'SPA-навигация',
  experiment: 'Действие эксперимента',
};

function reliabilityNote(metric: MetricRecord): string {
  if (metric.status === 'pending') {
    return 'Значение ещё не сформировано; показанное состояние не является измеренным результатом.';
  }
  if (metric.status === 'unsupported') {
    return 'Браузер не предоставляет этот тип записи Performance API.';
  }
  if (metric.status === 'incomplete') {
    return 'Данные неполные: часть фаз или источников недоступна.';
  }
  if (metric.source === 'web-vitals') {
    return 'Стандартное измерение web-vitals для текущей загрузки; одиночная сессия не даёт p75.';
  }
  if (metric.source === 'performance-api') {
    return 'Значение получено из Performance API и может отличаться от полевой оценки web-vitals.';
  }
  return 'Значение содержит производные данные расширения, а не только сырые записи браузера.';
}

const SOURCE_LABELS = {
  'web-vitals': 'web-vitals attribution',
  'performance-api': 'Performance API',
  derived: 'Производные данные',
} as const;

const OVERLAY_COLOR: Record<MetricName, OverlayColor> = {
  LCP: 'green',
  CLS: 'red',
  INP: 'yellow',
  FCP: 'green',
  TTFB: 'green',
};

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : formatMetricValue(value, 'ms');
}

function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : formatMetricValue(value, 'score');
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-gray-500">{label}</span>
      <span className="text-right font-medium text-gray-800 break-words">{value}</span>
    </div>
  );
}

interface TargetCardProps {
  target: DomTargetSnapshot;
  index?: number;
  color: OverlayColor;
  label: string;
  metricName: MetricName;
  overlayStatus: OverlayStatus | null | undefined;
  overlayEnabled: boolean;
  onHighlight: MetricDetailsProps['onHighlight'];
  onClearHighlight: (metricName?: MetricName) => void;
}

function TargetCard({
  target,
  index,
  color,
  label,
  metricName,
  overlayStatus,
  overlayEnabled,
  onHighlight,
  onClearHighlight,
}: TargetCardProps) {
  const isActive = overlayStatus?.targetId === target.targetId;
  const isMissing = isActive && overlayStatus?.available === false;

  return (
    <div className={`rounded-lg border p-2.5 ${isMissing ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">
            {index === undefined ? 'DOM-цель' : `Источник ${index + 1}`}
          </p>
          <p className="font-mono text-xs text-gray-800 break-all">
            {target.selector ?? 'Селектор недоступен'}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {target.tagName ? `<${target.tagName}>` : 'Тег не определён'}
            {target.rect
              ? ` · ${Math.round(target.rect.width)}×${Math.round(target.rect.height)} px · (${Math.round(target.rect.x)}, ${Math.round(target.rect.y)})`
              : ''}
          </p>
        </div>

        {target.selector && (
          <button
            type="button"
            onClick={() => {
              if (isActive) onClearHighlight(metricName);
              else onHighlight(target, color, label, metricName);
            }}
            disabled={!overlayEnabled && !isActive}
            title={overlayEnabled ? undefined : 'Подсветка этой категории отключена'}
            className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive
                ? 'bg-gray-800 text-white'
                : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-100'
            }`}
          >
            {isActive ? 'Снять' : overlayEnabled ? 'Подсветить' : 'Подсветка отключена'}
          </button>
        )}
      </div>

      {isMissing && (
        <p className="mt-1.5 text-[11px] text-red-700">
          {overlayStatus?.reason ?? 'Элемент изменился или больше недоступен'}
        </p>
      )}
      {target.available === false && !isActive && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          Элемент мог измениться или быть удалён после измерения.
        </p>
      )}
    </div>
  );
}

export function MetricDetails({
  metric,
  events,
  overlayStatus,
  overlayEnabled,
  onHighlight,
  onClearHighlight,
}: MetricDetailsProps) {
  const [copied, setCopied] = useState(false);
  const attribution = metric.attribution;
  const color = OVERLAY_COLOR[metric.name];
  const label = `${metric.name} · ${formatMetricValue(metric.value, metric.unit)}`;
  const clsSources = attribution?.cls?.sources ?? [];
  const targets = clsSources.length > 0
    ? clsSources
    : attribution?.target
      ? [attribution.target]
      : [];

  const relatedLongTasks = events.filter(
    (event) =>
      event.type === 'long-task' &&
      (attribution?.longTaskIds ?? []).includes(event.id),
  );
  const relatedEvents = events
    .filter((event) => event.navigationId === metric.navigationId)
    .slice(-10);

  const handleCopyDiagnostics = async () => {
    const diagnostics = {
      capturedAt: new Date().toISOString(),
      metric,
      relatedEvents,
      overlayStatus: overlayStatus ?? null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[WPA UI] Failed to copy diagnostics:', error);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-3 mt-4" aria-label={`Детали ${metric.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Детали {metric.name}</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Источник метрики: {SOURCE_LABELS[metric.source] ?? metric.source}
          </p>
        </div>
        <p className="text-lg font-mono font-bold text-gray-800">
          {formatMetricValue(metric.value, metric.unit)}
        </p>
      </div>

      <div className="mt-2 divide-y divide-gray-100 text-xs">
        <DetailRow
          label="Время измерения"
          value={new Date(metric.observedAt).toLocaleString('ru-RU')}
        />
        <DetailRow label="Статус достоверности" value={STATUS_LABELS[metric.status]} />
      </div>
      <p className="mt-1.5 text-[10px] text-gray-500">{reliabilityNote(metric)}</p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => void handleCopyDiagnostics()}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
        >
          {copied ? 'Скопировано' : 'Скопировать диагностику'}
        </button>
      </div>

      <div className="mt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          DOM-цель
        </h3>
        <div className="mt-1.5 space-y-2">
          {targets.length > 0 ? (
            targets.map((target, index) => (
              <TargetCard
                key={target.targetId}
                target={target}
                index={metric.name === 'CLS' ? index : undefined}
                color={color}
                label={label}
                metricName={metric.name}
                overlayStatus={overlayStatus}
                overlayEnabled={overlayEnabled}
                onHighlight={onHighlight}
                onClearHighlight={onClearHighlight}
              />
            ))
          ) : (
            <p className="text-xs text-gray-500">
              {metric.name === 'CLS'
                ? 'Источники сдвига недоступны. Итоговое значение CLS сохранено.'
                : 'Элемент не определён.'}
            </p>
          )}
        </div>
      </div>

      {attribution?.derived && attribution.derived.length > 0 && (
        <p className="mt-2 text-[10px] text-gray-400">
          Производные поля расширения: {attribution.derived.join(', ')}
        </p>
      )}

      {metric.name === 'LCP' && (
        <div className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Фазы LCP
          </h3>
          {attribution?.lcp ? (
            <div className="mt-1 divide-y divide-gray-100 text-xs">
              <DetailRow label="TTFB" value={formatMs(attribution.lcp.timeToFirstByte)} />
              {attribution.lcp.resourceLoadDelay !== undefined && (
                <DetailRow label="Задержка загрузки ресурса" value={formatMs(attribution.lcp.resourceLoadDelay)} />
              )}
              {attribution.lcp.resourceLoadDuration !== undefined && (
                <DetailRow label="Длительность загрузки ресурса" value={formatMs(attribution.lcp.resourceLoadDuration)} />
              )}
              <DetailRow label="Задержка рендеринга элемента" value={formatMs(attribution.lcp.elementRenderDelay)} />
              {attribution.lcp.elementType && (
                <DetailRow label="Тип элемента" value={attribution.lcp.elementType} />
              )}
              {attribution.lcp.contentType && attribution.lcp.contentType !== 'unknown' && (
                <DetailRow
                  label="Тип контента"
                  value={{
                    image: 'изображение',
                    text: 'текст',
                    video: 'видео',
                    element: 'элемент',
                    unknown: 'неизвестно',
                  }[attribution.lcp.contentType]}
                />
              )}
              {attribution.lcp.resourceUrl && (
                <div className="py-1">
                  <p className="text-gray-500">Ресурс</p>
                  <p className="font-mono text-[11px] text-gray-800 break-all mt-0.5" title={attribution.lcp.resourceUrl}>
                    {attribution.lcp.resourceUrl}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-1">Фазы LCP недоступны.</p>
          )}
        </div>
      )}

      {metric.name === 'CLS' && (
        <div className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Сдвиг
          </h3>
          <div className="mt-1 divide-y divide-gray-100 text-xs">
            <DetailRow label="Наибольший сдвиг" value={formatScore(attribution?.cls?.shiftValue)} />
            <DetailRow label="Время сдвига" value={formatMs(attribution?.cls?.shiftTime)} />
            {attribution?.cls?.loadState && (
              <DetailRow label="Состояние загрузки" value={attribution.cls.loadState} />
            )}
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            Итоговый CLS учитывает сессии сдвигов и исключает сдвиги после недавнего ввода.
          </p>
        </div>
      )}

      {metric.name === 'INP' && (
        <div className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Фазы взаимодействия
          </h3>
          {attribution?.inp ? (
            <div className="mt-1 divide-y divide-gray-100 text-xs">
              <DetailRow label="Input Delay" value={formatMs(attribution.inp.inputDelay)} />
              <DetailRow label="Processing Duration" value={formatMs(attribution.inp.processingDuration)} />
              <DetailRow label="Presentation Delay" value={formatMs(attribution.inp.presentationDelay)} />
              <DetailRow
                label="Тип взаимодействия"
                value={
                  attribution.inp.interactionType === 'pointer'
                    ? 'указатель'
                    : attribution.inp.interactionType === 'keyboard'
                      ? 'клавиатура'
                      : attribution.inp.interactionType ?? '—'
                }
              />
              <DetailRow label="Длительность события" value={formatMs(attribution.inp.duration)} />
              <DetailRow label="Начало события" value={formatMs(attribution.inp.startTime)} />
              <DetailRow label="Следующая отрисовка" value={formatMs(attribution.inp.nextPaintTime)} />
              {attribution.inp.interactionId !== undefined && (
                <DetailRow label="ID взаимодействия" value={String(attribution.inp.interactionId)} />
              )}
              {attribution.inp.loadState && (
                <DetailRow label="Состояние загрузки" value={attribution.inp.loadState} />
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-1">Фазы взаимодействия недоступны.</p>
          )}

          <p className="mt-2 text-[11px] text-gray-500">
            INP отражает наиболее медленное подходящее взаимодействие за период наблюдения, а не среднее время кликов.
          </p>

          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mt-3">
            Long Tasks в интервале
          </h3>
          {relatedLongTasks.length > 0 ? (
            <ul className="mt-1 space-y-1.5">
              {relatedLongTasks.map((event) => (
                <li key={event.id} className="rounded-md bg-amber-50 border border-amber-200 p-2 text-[11px] text-amber-900">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono">{event.id}</span>
                    <span className="font-semibold">{formatMs(event.duration)}</span>
                  </div>
                  <p className="mt-0.5 text-amber-700">
                    {new Date(event.timestamp).toLocaleTimeString('ru-RU')}
                    {typeof event.details?.containerType === 'string' && event.details.containerType
                      ? ` · ${event.details.containerType}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500 mt-1">
              Пересекающиеся Long Tasks не обнаружены.
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-gray-400">
            Совпадение по времени не доказывает, что Long Task вызвала задержку INP.
          </p>
        </div>
      )}

      {metric.name === 'FCP' && (
        <div className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            FCP и загрузка
          </h3>
          <div className="mt-1 divide-y divide-gray-100 text-xs">
            <DetailRow label="TTFB" value={formatMs(attribution?.fcp?.timeToFirstByte)} />
            <DetailRow label="От TTFB до FCP" value={formatMs(attribution?.fcp?.firstByteToFCP)} />
            {attribution?.fcp?.loadState && (
              <DetailRow label="Состояние загрузки" value={attribution.fcp.loadState} />
            )}
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            FCP — время первого отображения контента, а не завершение загрузки страницы.
          </p>
        </div>
      )}

      {metric.name === 'TTFB' && (
        <div className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Сетевые и серверные фазы
          </h3>
          <div className="mt-1 divide-y divide-gray-100 text-xs">
            <DetailRow label="Ожидание" value={formatMs(attribution?.ttfb?.waitingDuration)} />
            <DetailRow label="Кэш" value={formatMs(attribution?.ttfb?.cacheDuration)} />
            <DetailRow label="DNS" value={formatMs(attribution?.ttfb?.dnsDuration)} />
            <DetailRow label="Соединение" value={formatMs(attribution?.ttfb?.connectionDuration)} />
            <DetailRow label="Запрос" value={formatMs(attribution?.ttfb?.requestDuration)} />
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            TTFB включает не только серверное время, но и сетевые задержки, редиректы и особенности получения документа.
          </p>
        </div>
      )}

      <div className="mt-3 border-t border-gray-100 pt-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Связанные события
        </h3>
        {relatedEvents.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {relatedEvents.map((event) => (
              <li
                key={event.id}
                className="rounded-md border border-gray-200 bg-gray-50 p-1.5 text-[11px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-gray-700">{EVENT_LABELS[event.type]}</span>
                  <span className="shrink-0 text-gray-500">
                    {new Date(event.timestamp).toLocaleTimeString('ru-RU')}
                  </span>
                </div>
                <p className="mt-0.5 text-gray-500">
                  {event.duration !== undefined ? `Длительность: ${formatMs(event.duration)}` : 'Без длительности'}
                  {event.targetId ? ` · цель ${event.targetId}` : ''}
                  {typeof event.details?.containerType === 'string' && event.details.containerType
                    ? ` · ${event.details.containerType}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-gray-500">
            Для этого навигационного сегмента связанные события не зафиксированы.
          </p>
        )}
        <p className="mt-1.5 text-[10px] text-gray-400">
          События относятся к тому же навигационному сегменту; совпадение по времени не доказывает причинную связь.
        </p>
      </div>
    </section>
  );
}
