import { useEffect, useState } from 'react';
import { generateId } from '../../utils/id';

interface SettingsResponse {
  settings?: { retentionDays: number };
  error?: string;
  deleted?: number;
  cleanupError?: string;
}

export function SettingsPanel() {
  const [retentionDays, setRetentionDays] = useState('30');
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void chrome.runtime
      .sendMessage({ type: 'GET_SETTINGS', requestId: generateId() })
      .then((response: SettingsResponse | undefined) => {
        if (cancelled) return;
        if (response?.error) {
          setStatus(response.error);
          setStatusError(true);
          return;
        }
        if (!response?.settings) return;
        setRetentionDays(String(response.settings.retentionDays));
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('Не удалось загрузить настройки');
          setStatusError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setStatus('Укажите срок от 1 до 365 дней');
      setStatusError(true);
      return;
    }
    setBusy(true);
    setStatus('');
    setStatusError(false);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        requestId: generateId(),
        retentionDays: days,
      })) as SettingsResponse | undefined;
      if (response?.error) {
        setStatus(response.error);
        setStatusError(true);
      } else {
        const deleted = response?.deleted ?? 0;
        if (response?.cleanupError) {
          setStatus(`Сохранено, но старые сессии не удалены: ${response.cleanupError}`);
          setStatusError(true);
        } else {
          setStatus(
            deleted > 0
              ? `Сохранено. Удалено старых сессий: ${deleted}`
              : 'Сохранено',
          );
        }
        if (response?.settings) {
          setRetentionDays(String(response.settings.retentionDays));
        }
      }
    } catch (error) {
      setStatus(String(error));
      setStatusError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-3" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="text-sm font-semibold text-gray-800">
        Настройки хранения
      </h2>
      <p className="mt-1 text-[11px] text-gray-500">
        Старые сессии удаляются при запуске расширения. Сессии, связанные с экспериментами,
        сохраняются, чтобы не потерять результаты.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <label htmlFor="retention-days" className="flex-1 text-[11px] text-gray-600">
          Срок хранения, дней
          <input
            id="retention-days"
            type="number"
            min={1}
            max={365}
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-800"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
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
