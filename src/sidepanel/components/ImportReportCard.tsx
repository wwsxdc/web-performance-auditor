import { useCallback, useRef, useState } from 'react';
import type { JsonReport } from '../../types/report';
import {
  IMPORT_LIMITS,
  parseImportPayload,
  summarizeImportReport,
  type ImportPreview,
  type ImportSummary,
} from '../../utils/report-import';
import { generateId } from '../../utils/id';
import { pluralizeRu } from '../../utils/plural';
import { sendRuntimeMessage } from '../api';

interface ImportReportCardProps {
  onImported?: (sessionId: string) => void;
}

interface ImportResponse {
  success?: boolean;
  error?: string;
  sessionId?: string;
  summary?: ImportSummary;
  warnings?: string[];
}

const MAX_FILE_LABEL = `${Math.round(IMPORT_LIMITS.maxBytes / (1024 * 1024))} МБ`;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU');
}

export function ImportReportCard({ onImported }: ImportReportCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [report, setReport] = useState<JsonReport | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setReport(null);
    setPreview(null);
    setFileName(null);
    setResult(null);
    setResultWarnings([]);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (file: File | undefined) => {
    setError(null);
    setResult(null);
    setResultWarnings([]);
    setReport(null);
    setPreview(null);
    setFileName(file?.name ?? null);
    if (!file) return;

    if (file.size > IMPORT_LIMITS.maxBytes) {
      setError(`Файл больше ${MAX_FILE_LABEL} и не может быть импортирован`);
      return;
    }

    setBusy(true);
    try {
      const text = await file.text();
      const parsed = parseImportPayload(text);
      if (parsed.error || !parsed.report) {
        setError(parsed.error ?? 'Не удалось прочитать отчёт');
        return;
      }
      setReport(parsed.report);
      setPreview(summarizeImportReport(parsed.report));
    } catch (err) {
      setError(`Не удалось прочитать файл: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!report || !preview) return;
    if (preview.errors.length > 0) {
      setError(preview.errors[0]);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await sendRuntimeMessage<ImportResponse>({
        type: 'IMPORT_JSON',
        requestId: generateId(),
        report,
      });

      if (response?.error || !response?.sessionId) {
        setError(response?.error ?? 'Не удалось импортировать отчёт');
        return;
      }

      setResult(response.summary ?? null);
      setResultWarnings(response.warnings ?? []);
      setReport(null);
      setPreview(null);
      setFileName(null);
      if (inputRef.current) inputRef.current.value = '';
      onImported?.(response.sessionId);
    } catch (err) {
      setError(`Не удалось импортировать отчёт: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [onImported, preview, report]);

  const canImport = Boolean(report && preview && preview.errors.length === 0 && !busy);

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-3"
      aria-label="Импорт отчёта"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Импорт отчёта</h2>
          <p className="mt-1 text-[11px] text-gray-500">
            Загрузите JSON, созданный кнопкой «Экспорт JSON». Импорт добавляет новую
            сессию и не изменяет существующие.
          </p>
        </div>
        {preview && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-lg border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            disabled={busy}
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="mt-2">
        <label
          htmlFor="wpa-import-file"
          className="block text-xs font-medium text-gray-700"
        >
          Файл отчёта (до {MAX_FILE_LABEL})
        </label>
        <input
          ref={inputRef}
          id="wpa-import-file"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => void handleFile(event.target.files?.[0])}
          className="mt-1 block w-full text-xs text-gray-600 file:mr-2 file:rounded-lg file:border file:border-gray-300 file:bg-white file:px-2 file:py-1 file:text-xs file:text-gray-700 hover:file:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-60"
        />
        {fileName && <p className="mt-1 truncate text-[11px] text-gray-500" title={fileName}>{fileName}</p>}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}

      {preview && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
          <p className="truncate text-xs font-medium text-gray-800" title={preview.url}>
            {preview.url}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            {formatDate(preview.startedAt)} · {preview.browser.name}
            {preview.browser.version ? ` ${preview.browser.version}` : ''} · {preview.toolVersion}
          </p>
          <p className="mt-1 text-[11px] text-gray-600">
            Метрик: {preview.metricCount} · событий: {preview.eventCount} · экспериментов:{' '}
            {preview.experimentCount}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            Сессия будет импортирована как{' '}
            {preview.status === 'interrupted' ? 'прерванная' : 'завершённая'}.
          </p>

          {preview.errors.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-red-700">
              {preview.errors.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
          {preview.warnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-amber-700">
              {preview.warnings.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!canImport}
            className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Импорт…' : 'Импортировать'}
          </button>
        </div>
      )}

      {result && (
        <div
          role="status"
          className="mt-2 rounded-lg border border-green-200 bg-green-50 p-2 text-xs text-green-800"
        >
          <p className="font-medium">
            Импортировано: {result.metricCount}{' '}
            {pluralizeRu(result.metricCount, ['метрика', 'метрики', 'метрик'])},{' '}
            {result.eventCount}{' '}
            {pluralizeRu(result.eventCount, ['событие', 'события', 'событий'])}.
          </p>
          {resultWarnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-green-900">
              {resultWarnings.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
