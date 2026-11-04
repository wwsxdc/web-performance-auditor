import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticLogEntry } from '../../types/diagnostics';
import { generateId } from '../../utils/id';
import { formatTimestamp } from '../../utils/time';
import { sendRuntimeMessage } from '../api';

interface DiagnosticsResponse {
  entries?: DiagnosticLogEntry[];
  error?: string;
}

export function DiagnosticsPanel() {
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await sendRuntimeMessage<DiagnosticsResponse>({
        type: 'GET_DIAGNOSTICS',
        requestId: generateId(),
      });
      setEntries(response?.entries ?? []);
      setStatus(response?.error ?? '');
      setStatusError(Boolean(response?.error));
    } catch (error) {
      setStatus(String(error));
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clear = async () => {
    try {
      await sendRuntimeMessage({
        type: 'CLEAR_DIAGNOSTICS',
        requestId: generateId(),
      });
      setEntries([]);
      setStatus('Журнал очищен');
      setStatusError(false);
    } catch (error) {
      setStatus(String(error));
      setStatusError(true);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-3" aria-labelledby="diagnostics-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="diagnostics-heading" className="text-sm font-semibold text-gray-800">
          Журнал диагностики
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-gray-300 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50"
          >
            Обновить
          </button>
          <button
            type="button"
            onClick={() => void clear()}
            disabled={entries.length === 0}
            className="rounded-md border border-gray-300 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Очистить
          </button>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-gray-500">
        Технические ошибки расширения. Содержимое страницы и поля форм сюда не записываются.
      </p>
      {entries.length === 0 ? (
        <p className="mt-2 text-[11px] text-gray-500">Ошибок нет.</p>
      ) : (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-gray-100 bg-gray-50 p-1.5">
              <div className="flex justify-between gap-2 text-[10px] text-gray-500">
                <span className="font-medium text-gray-700">{entry.scope}</span>
                <span className="font-mono">{formatTimestamp(entry.timestamp)}</span>
              </div>
              <p className="mt-0.5 break-words text-[10px] text-gray-600" title={entry.message}>
                {entry.message}
              </p>
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p
          className={`mt-1.5 text-[10px] ${statusError ? 'text-red-600' : 'text-gray-500'}`}
          role={statusError ? 'alert' : 'status'}
        >
          {status}
        </p>
      )}
    </section>
  );
}
