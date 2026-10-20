import { useCallback, useRef, useState } from 'react';
import { generateId } from '../../utils/id';

interface DataCleanupProps {
  onCleared: () => Promise<void> | void;
}

export function DataCleanup({ onCleared }: DataCleanupProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleCancel = useCallback(() => {
    setConfirming(false);
    // The trigger may be unmounted if the panel swapped views; only refocus a
    // button that is still attached to the document.
    requestAnimationFrame(() => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    });
  }, []);

  const handleClear = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CLEAR_HISTORY',
        requestId: generateId(),
      })) as { error?: string; rulesPurged?: boolean } | undefined;
      if (response?.error) {
        setError(response.error);
        return;
      }
      await onCleared();
      if (response?.rulesPurged === false) {
        setError('История очищена, но не удалось подтвердить снятие сетевых правил.');
        return;
      }
      handleCancel();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [onCleared, handleCancel]);

  return (
    <section
      className="bg-white rounded-xl border border-gray-200 p-3 mt-4"
      aria-label="Очистка локальной истории"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming && !busy) {
          event.stopPropagation();
          handleCancel();
        }
      }}
    >
      <h2 className="text-sm font-bold text-gray-900">Локальные данные</h2>
      <p className="mt-1 text-[11px] text-gray-500">
        Сессии, метрики, диагностические события и эксперименты хранятся только в этом браузере.
      </p>

      {error && (
        <p
          className="mt-2 rounded-md bg-red-50 border border-red-200 p-2 text-[11px] text-red-700"
          role="alert"
        >
          {error}
        </p>
      )}

      {confirming ? (
        <div
          className="mt-2 rounded-md border border-red-200 bg-red-50 p-2.5"
          role="alertdialog"
          aria-label="Подтверждение очистки локальной истории"
        >
          <p className="text-[11px] text-red-800">
            Удалить всю локальную историю? Действие необратимо, при необходимости завершите
            текущие измерения и эксперименты.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={busy}
              autoFocus
              className="rounded-md bg-red-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
            >
              {busy ? 'Удаление...' : 'Удалить всё'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy}
              className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        >
          Очистить историю
        </button>
      )}
    </section>
  );
}
