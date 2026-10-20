import { useMemo, useState } from 'react';
import type { DiagnosticEvent, DiagnosticEventType } from '../../types/events';
import { formatDuration, formatTimestamp } from '../../utils/time';
import { groupLongTasks, type LongTaskGroup } from '../../utils/long-task-groups';

type EventFilter = 'all' | DiagnosticEventType;

const FILTERS: { value: EventFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'long-task', label: 'Long Tasks' },
  { value: 'layout-shift', label: 'Сдвиги' },
  { value: 'interaction', label: 'INP' },
  { value: 'spa-navigation', label: 'SPA' },
  { value: 'experiment', label: 'Эксперименты' },
];

const TYPE_LABELS: Record<DiagnosticEventType, string> = {
  'metric-update': 'Метрика',
  'layout-shift': 'Сдвиг',
  'long-task': 'Long Task',
  interaction: 'Взаимодействие',
  'spa-navigation': 'SPA-переход',
  experiment: 'Эксперимент',
};

const DETAIL_LABELS: Record<string, string> = {
  name: 'Метрика',
  value: 'Значение',
  shift: 'Сдвиг',
  containerName: 'Контейнер',
  selector: 'Селектор',
  interactionType: 'Тип',
  from: 'Откуда',
  to: 'Куда',
  source: 'Источник',
  experimentId: 'Эксперимент',
};

function detailEntries(event: DiagnosticEvent): [string, string][] {
  return Object.entries(event.details ?? {})
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => [DETAIL_LABELS[key] ?? key, String(value)]);
}

interface EventsPanelProps {
  events: DiagnosticEvent[];
}

type EventItem =
  | { kind: 'group'; group: LongTaskGroup }
  | { kind: 'event'; event: DiagnosticEvent };

function groupDetails(group: LongTaskGroup): string {
  const containers = new Set(
    group.events
      .map((event) => event.details?.containerName)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  return containers.size > 0 ? Array.from(containers).join(', ') : 'без контейнера';
}

export function EventsPanel({ events }: EventsPanelProps) {
  const [filter, setFilter] = useState<EventFilter>('all');

  const items = useMemo<EventItem[]>(() => {
    const longGroups = filter === 'all' || filter === 'long-task'
      ? groupLongTasks(events)
      : [];
    const regular = events.filter((event) => {
      if (event.type === 'long-task' && longGroups.length > 0) return false;
      return filter === 'all' || event.type === filter;
    });

    const merged: EventItem[] = [
      ...longGroups.map<EventItem>((group) => ({ kind: 'group', group })),
      ...regular.map<EventItem>((event) => ({ kind: 'event', event })),
    ];

    return merged.sort((left, right) => {
      const leftTime = left.kind === 'group' ? left.group.startedAt : left.event.timestamp;
      const rightTime = right.kind === 'group' ? right.group.startedAt : right.event.timestamp;
      return rightTime - leftTime;
    });
  }, [events, filter]);

  return (
    <section aria-labelledby="events-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="events-heading" className="text-sm font-semibold text-gray-800">
          События диагностики
        </h2>
        <span className="text-[11px] text-gray-400">{events.length}</span>
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        Long Tasks объединяются в серии, если идут подряд с паузой до 1 секунды.
      </p>

      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Фильтр событий">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
            className={`rounded-full border px-2 py-1 text-[10px] font-medium ${
              filter === option.value
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-xs text-gray-500">
          Событий пока нет. Они появятся по мере взаимодействия со страницей.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => {
            if (item.kind === 'group') {
              const { group } = item;
              return (
                <li key={group.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
                  <details>
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
                          Long Task ×{group.count}
                        </span>
                        <span className="font-mono text-xs font-semibold text-amber-900">
                          {formatDuration(group.totalDuration)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-amber-900/80">
                        {formatTimestamp(group.startedAt)}–{formatTimestamp(group.endedAt)} · {groupDetails(group)}
                      </p>
                    </summary>
                    <ul className="mt-2 space-y-1 border-t border-amber-200 pt-2">
                      {group.events.map((event) => (
                        <li key={event.id} className="flex justify-between gap-2 text-[10px] text-gray-600">
                          <span>{formatTimestamp(event.timestamp)}</span>
                          <span className="truncate">{event.details?.containerName ?? '—'}</span>
                          <span className="font-mono">{formatDuration(event.duration ?? 0)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            }

            const { event } = item;
            const details = detailEntries(event);
            return (
              <li key={event.id} className="rounded-lg border border-gray-200 bg-white p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700">
                    {TYPE_LABELS[event.type]}
                  </span>
                  <span className="font-mono text-[10px] text-gray-500">
                    {formatTimestamp(event.timestamp)}
                  </span>
                </div>
                {(event.duration !== undefined || details.length > 0) && (
                  <div className="mt-1.5 space-y-0.5">
                    {event.duration !== undefined && (
                      <p className="text-[11px] text-gray-600">
                        Длительность: <span className="font-mono">{formatDuration(event.duration)}</span>
                      </p>
                    )}
                    {details.map(([label, value]) => (
                      <p key={label} className="truncate text-[10px] text-gray-500" title={value}>
                        {label}: {value}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
