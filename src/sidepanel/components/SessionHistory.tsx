import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '../../types/session';
import { generateId } from '../../utils/id';
import { pluralizeRu } from '../../utils/plural';
import { sendRuntimeMessage } from '../api';

interface SessionHistoryProps {
  /** Bumps whenever an import, selection or deletion must refresh the list. */
  revision: number;
  activeSessionId: string | null;
  hasActiveSession: boolean;
  onSelected?: (sessionId: string) => void;
  onDeleted?: () => void;
}

interface SessionListResponse {
  sessions?: SessionSummary[];
  error?: string;
}

interface ActionResponse {
  success?: boolean;
  error?: string;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Активна',
  completed: 'Завершена',
  interrupted: 'Прервана',
  unsupported: 'Не поддерживается',
  error: 'Ошибка',
};

function formatStartedAt(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU');
}

export function SessionHistory({
  revision,
  activeSessionId,
  hasActiveSession,
  onSelected,
  onDeleted,
}: SessionHistoryProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void sendRuntimeMessage<SessionListResponse>({
      type: 'GET_SESSION_LIST',
      requestId: generateId(),
    })
      .then((response) => {
        if (cancelled) return;
        if (response?.error) {
          setError(response.error);
          return;
        }
        setError(null);
        setSessions(response?.sessions ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(`Не удалось загрузить историю: ${String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const handleSelect = useCallback(
    async (sessionId: string) => {
      setBusyId(sessionId);
      setError(null);
      try {
        const response = await sendRuntimeMessage<ActionResponse>({
          type: 'SELECT_SESSION',
          requestId: generateId(),
          sessionId,
        });
        if (response?.error) {
          setError(response.error);
          return;
        }
        onSelected?.(sessionId);
      } catch (err) {
        setError(`Не удалось открыть сессию: ${String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [onSelected],
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      setBusyId(sessionId);
      setError(null);
      try {
        const response = await sendRuntimeMessage<ActionResponse>({
          type: 'DELETE_SESSION',
          requestId: generateId(),
          sessionId,
        });
        if (response?.error) {
          setError(response.error);
          return;
        }
        setSessions((prev) => prev.filter((session) => session.id !== sessionId));
        setConfirmingId(null);
        onDeleted?.();
      } catch (err) {
        setError(`Не удалось удалить сессию: ${String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [onDeleted],
  );

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-3"
      aria-label="История сессий"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirmingId && !busyId) {
          event.stopPropagation();
          setConfirmingId(null);
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800">История сессий</h2>
        <span className="text-[11px] text-gray-500">Последние {sessions.length || 0}</span>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}

      {loading && sessions.length === 0 && (
        <p className="mt-2 text-xs text-gray-500">Загрузка истории…</p>
      )}

      {!loading && sessions.length === 0 && !error && (
        <p className="mt-2 rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-500">
          Сессий пока нет. Импортируйте отчёт или начните аудит.
        </p>
      )}

      {sessions.length > 0 && (
        <ul className="mt-2 space-y-2">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isBusy = busyId === session.id;
            const confirming = confirmingId === session.id;
            return (
              <li
                key={session.id}
                className={`rounded-lg border p-2 ${
                  isActive ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p
                    className="min-w-0 truncate text-xs font-medium text-gray-800"
                    title={session.url}
                  >
                    {session.url}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {session.origin === 'imported' && (
                      <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                        Импорт
                      </span>
                    )}
                    <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700">
                      {STATUS_LABELS[session.status] ?? session.status}
                    </span>
                  </div>
                </div>

                <p className="mt-0.5 text-[11px] text-gray-600">
                  {formatStartedAt(session.startedAt)}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-600">
                  {session.metricCount}{' '}
                  {pluralizeRu(session.metricCount, ['метрика', 'метрики', 'метрик'])} ·{' '}
                  {session.eventCount}{' '}
                  {pluralizeRu(session.eventCount, ['событие', 'события', 'событий'])}
                  {session.experimentCount > 0 &&
                    ` · ${session.experimentCount} ${pluralizeRu(
                      session.experimentCount,
                      ['эксперимент', 'эксперимента', 'экспериментов'],
                    )}`}
                </p>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleSelect(session.id)}
                    disabled={hasActiveSession || isActive || isBusy}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isActive ? 'Текущая' : 'Открыть'}
                  </button>

                  {confirming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleDelete(session.id)}
                        disabled={isBusy || isActive}
                        className="rounded-lg border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isBusy ? 'Удаление…' : 'Удалить?'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        disabled={isBusy}
                        className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                      >
                        Отмена
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(session.id)}
                      disabled={isActive || isBusy}
                      className="rounded-lg border border-red-200 bg-white px-2 py-1 text-[11px] text-red-700 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Удалить
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
