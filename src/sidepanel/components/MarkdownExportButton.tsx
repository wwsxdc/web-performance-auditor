import { useCallback, useEffect, useState } from 'react';
import { generateId } from '../../utils/id';

interface MarkdownExportButtonProps {
  sessionId: string;
  experimentId?: string;
}

export function MarkdownExportButton({ sessionId, experimentId }: MarkdownExportButtonProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMarkdown(null);
    setCopied(false);
  }, [experimentId, sessionId]);

  const fetchMarkdown = useCallback(async () => {
    setBusy(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'EXPORT_MARKDOWN',
        requestId: generateId(),
        sessionId,
        experimentId,
      })) as { markdown?: string } | undefined;
      if (response?.markdown) {
        setMarkdown(response.markdown);
        return response.markdown;
      }
    } catch (error) {
      console.error('[WPA UI] Markdown export failed:', error);
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
    URL.revokeObjectURL(url);
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
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[WPA UI] Clipboard write failed:', error);
    }
  }, [fetchMarkdown, markdown]);

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <button
          onClick={handleDownload}
          disabled={busy}
          className="px-3 py-2 text-sm bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          aria-label="Экспортировать отчёт в Markdown"
        >
          {busy ? 'Экспорт...' : 'Экспорт Markdown'}
        </button>
        <button
          onClick={handlePreview}
          disabled={busy}
          className="px-3 py-2 text-sm bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
        >
          Предпросмотр
        </button>
      </div>

      {markdown && (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Предпросмотр Markdown
            </p>
            <button
              onClick={handleCopy}
              className="text-[11px] text-blue-600 hover:underline"
            >
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-[10px] whitespace-pre-wrap text-gray-700">
            {markdown}
          </pre>
        </div>
      )}
    </div>
  );
}
