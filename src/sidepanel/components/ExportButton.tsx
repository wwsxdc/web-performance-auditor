import { useCallback, useState } from 'react';
import { generateId } from '../../utils/id';
import { sendRuntimeMessage } from '../api';

interface ExportButtonProps {
  sessionId: string;
}

export function ExportButton({ sessionId }: ExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const response = await sendRuntimeMessage<{
        report?: unknown;
        error?: string;
      }>({
        type: 'EXPORT_JSON',
        requestId: generateId(),
        sessionId,
      });

      if (response?.error) {
        setError(response.error);
        return;
      }

      if (response?.report) {
        const json = JSON.stringify(response.report, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wpa-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Give Chrome a task to start the download before releasing the blob.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        setError('Сервис-воркер не вернул отчёт');
      }
    } catch (err) {
      console.error('[WPA] Export failed:', err);
      setError(String(err));
    } finally {
      setExporting(false);
    }
  }, [sessionId]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleExport}
        disabled={exporting}
        className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {exporting ? 'Экспорт...' : 'Экспорт JSON'}
      </button>
      {error && (
        <p className="max-w-56 text-right text-[10px] text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
