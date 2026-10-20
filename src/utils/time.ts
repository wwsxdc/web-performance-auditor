export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

export function formatMetricValue(value: number | null, unit: 'ms' | 'score'): string {
  if (value === null) return '—';
  if (unit === 'score') return value.toFixed(3);
  if (value < 1000) return `${Math.round(value)} мс`;
  return `${(value / 1000).toFixed(2)} с`;
}
