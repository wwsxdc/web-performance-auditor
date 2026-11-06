import { useCallback, useEffect, useRef, useState } from 'react';
import { generateId } from '../../utils/id';
import { sendRuntimeMessage } from '../api';

interface MarkdownExportButtonProps {
  sessionId: string;
  experimentId?: string;
}

export function MarkdownExportButton({ sessionId, experimentId }: MarkdownExportButtonProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMarkdown(null);
    setCopied(false);
    setError(null);
  }, [experimentId, sessionId]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const fetchMarkdown = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendRuntimeMessage<{ markdown?: string; error?: string }>({
        type: 'EXPORT_MARKDOWN',
        requestId: generateId(),
        sessionId,
        experimentId,
      });
      if (response?.markdown) {
        setMarkdown(response.markdown);
        return response.markdown;
      }
      setError(response?.error ?? 'Не удалось сформировать Markdown-отчёт');
    } catch (error) {
      console.error('[WPA UI] Markdown export failed:', error);
      setError('Не удалось сформировать Markdown-отчёт');
    } finally {
      setBusy(false);
    }
    return null;
  }, [experimentId, sessionId]);

  const handleDownload = useCallback(async () => {
    const content = markdown ?? (await fetchMarkdown());
    if (!content) return;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wpa-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Some Chrome builds abort a download if the blob URL is revoked in the
    // same task as the synthetic click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [fetchMarkdown, markdown]);

  const handlePreview = useCallback(async () => {
    await fetchMarkdown();
  }, [fetchMarkdown]);

  const handleCopy = useCallback(async () => {
    const content = markdown ?? (await fetchMarkdown());
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setError(null);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[WPA UI] Clipboard write failed:', error);
      setError('Не удалось скопировать отчёт в буфер обмена');
    }
  }, [fetchMarkdown, markdown]);

  return (
    <>
      <button
        onClick={handleDownload}
        disabled={busy}
        className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {busy ? 'Экспорт...' : 'Экспорт Markdown'}
      </button>
      <button
        onClick={handlePreview}
        disabled={busy}
        className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Предпросмотр
      </button>

      {error && (
        <p role="alert" className="mt-2 basis-full text-[11px] text-red-700">
          {error}
        </p>
      )}

      {markdown && (
        <div className="mt-2 basis-full">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Предпросмотр Markdown
            </p>
            <button
              onClick={handleCopy}
              className="text-[11px] text-blue-600 hover:underline"
            >
              <span aria-live="polite">{copied ? 'Скопировано' : 'Копировать'}</span>
            </button>
          </div>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-[10px] whitespace-pre-wrap text-gray-700">
            {markdown}
          </pre>
        </div>
      )}
    </>
  );
}
