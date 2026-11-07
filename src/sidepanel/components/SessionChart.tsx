import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AuditSession } from '../../types/session';
import { buildSessionChartData, hasChartData, type SessionChartPoint } from '../../utils/chart';
import { pluralizeRu } from '../../utils/plural';
import { formatMetricValue, formatTimestamp } from '../../utils/time';

interface SessionChartProps {
  session: AuditSession;
}

const LINE_CONFIG = [
  { key: 'LCP', color: '#16a34a', axis: 'ms', unit: 'ms' },
  { key: 'INP', color: '#ca8a04', axis: 'ms', unit: 'ms' },
  { key: 'FCP', color: '#2563eb', axis: 'ms', unit: 'ms' },
  { key: 'TTFB', color: '#7c3aed', axis: 'ms', unit: 'ms' },
  { key: 'CLS', color: '#dc2626', axis: 'score', unit: 'score' },
] as const;

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: number | string;
  payload?: SessionChartPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-[11px] shadow-sm">
      <p className="font-medium text-gray-700">{formatTimestamp(point.observedAt)}</p>
      <div className="mt-1 space-y-0.5">
        {LINE_CONFIG.map((line) => {
          const value = point[line.key];
          if (value === null) return null;
          return (
            <p key={line.key} className="flex items-center justify-between gap-3 text-gray-600">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: line.color }}
                />
                {line.key}
              </span>
              <span className="font-mono text-gray-800">
                {formatMetricValue(value, line.unit)}
              </span>
            </p>
          );
        })}
      </div>
    </div>
  );
}

function formatElapsed(value: number): string {
  // Short sessions get one decimal so adjacent ticks do not collapse into the
  // same rounded second on the narrow side panel.
  return `${value.toFixed(value < 10 ? 1 : 0)} с`;
}

export function SessionChart({ session }: SessionChartProps) {
  const points = buildSessionChartData(
    session.metrics,
    session.startedAt,
    session.navigations,
  );

  if (!hasChartData(points)) {
    return (
      <section className="bg-white rounded-xl border border-gray-200 p-3 mt-4" aria-label="Динамика метрик">
        <h2 className="text-sm font-bold text-gray-900">Динамика метрик</h2>
        <p className="text-xs text-gray-500 mt-1">
          Недостаточно данных для графика. Запустите наблюдение и обновите страницу.
        </p>
      </section>
    );
  }

  const markers = [
    ...session.navigations
      .filter(
        (navigation) =>
          navigation.kind === 'spa' ||
          navigation.startedAt > session.startedAt,
      )
      .map((navigation) => ({
        key: `${navigation.kind}-${navigation.id}`,
        elapsed: Math.max(0, (navigation.startedAt - session.startedAt) / 1000),
        kind: navigation.kind,
      })),
    ...session.events
      .filter((event) => event.type === 'long-task' || event.type === 'experiment')
      .map((event) => ({
        key: `${event.type}-${event.id}`,
        elapsed: Math.max(0, (event.timestamp - session.startedAt) / 1000),
        kind: event.type,
      })),
  ];

  const hasScore = points.some((point) => point.CLS !== null);

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-3 mt-4" aria-label="Динамика метрик">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Динамика метрик</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            LCP и INP — максимум, CLS — накопленный итог, FCP и TTFB — последнее значение.
          </p>
        </div>
      </div>

      <div
        className="mt-2 h-56 w-full"
        role="img"
        aria-label="График изменения метрик по времени. Точные значения доступны в таблице ниже."
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
            <XAxis
              dataKey="elapsed"
              type="number"
              domain={[0, 'auto']}
              tickFormatter={formatElapsed}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              stroke="#d1d5db"
            />
            <YAxis
              yAxisId="ms"
              tick={{ fontSize: 10, fill: '#6b7280' }}
              stroke="#d1d5db"
              width={46}
            />
            {hasScore && (
              <YAxis
                yAxisId="score"
                orientation="right"
                domain={[0, 'auto']}
                tick={{ fontSize: 10, fill: '#6b7280' }}
                stroke="#d1d5db"
                width={40}
                tickFormatter={(value: number) => value.toFixed(2)}
              />
            )}
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 10 }} />

            {markers.map((marker) => (
              <ReferenceLine
                key={marker.key}
                x={marker.elapsed}
                yAxisId="ms"
                ifOverflow="hidden"
                stroke={
                  marker.kind === 'spa'
                    ? '#2563eb'
                    : marker.kind === 'document'
                      ? '#64748b'
                      : marker.kind === 'experiment'
                        ? '#7c3aed'
                        : '#f59e0b'
                }
                strokeDasharray="3 3"
                strokeOpacity={0.6}
                label={
                  marker.kind === 'long-task'
                    ? undefined
                    : {
                        value:
                          marker.kind === 'spa'
                            ? 'SPA'
                            : marker.kind === 'document'
                              ? 'DOC'
                              : 'EXP',
                        position: 'insideTopRight',
                        fill:
                          marker.kind === 'spa'
                            ? '#2563eb'
                            : marker.kind === 'document'
                              ? '#64748b'
                              : '#7c3aed',
                        fontSize: 9,
                      }
                }
              />
            ))}

            {LINE_CONFIG.map((line) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                yAxisId={line.axis}
                stroke={line.color}
                strokeWidth={line.key === 'CLS' ? 1.75 : 2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-1 text-[10px] text-gray-500">
        Пунктир: синий — SPA-переход, серый — документ, оранжевый — Long Task,
        фиолетовый — эксперимент.
      </p>

      <details className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
        <summary className="cursor-pointer text-[11px] font-medium text-gray-600">
          Данные графика ({points.length} {pluralizeRu(points.length, ['точка', 'точки', 'точек'])})
        </summary>
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="w-full border-collapse text-[10px]">
            <caption className="sr-only">
              Точные значения метрик по времени; альтернатива графику.
            </caption>
            <thead>
              <tr className="text-left text-gray-500">
                <th className="sticky top-0 bg-gray-50 py-1 pr-2 font-medium">Время</th>
                {LINE_CONFIG.map((line) => (
                  <th key={line.key} className="sticky top-0 bg-gray-50 py-1 pr-2 font-medium">
                    {line.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={`${point.observedAt}-${index}`} className="border-t border-gray-200">
                  <td className="py-0.5 pr-2 font-mono text-gray-600">
                    {formatElapsed(point.elapsed)}
                  </td>
                  {LINE_CONFIG.map((line) => (
                    <td key={line.key} className="py-0.5 pr-2 font-mono text-gray-700">
                      {point[line.key] === null
                        ? '—'
                        : formatMetricValue(point[line.key], line.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
