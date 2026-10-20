import type { MetricRecord, MetricName } from '../../types/metrics';
import type { CollectorStatus } from '../../types/messages';
import { selectMetricForDisplay } from '../../utils/select-metric';
import { MetricCard } from './MetricCard';

const CWV_NAMES: MetricName[] = ['LCP', 'INP', 'CLS'];
const AUX_NAMES: MetricName[] = ['FCP', 'TTFB'];

interface MetricsGridProps {
  metrics: MetricRecord[];
  collectorStatus: CollectorStatus;
  selectedName: MetricName | null;
  highlightedNames: ReadonlySet<MetricName>;
  highlightableNames: ReadonlySet<MetricName>;
  onSelect: (name: MetricName) => void;
  onQuickHighlight: (name: MetricName) => void;
}

export function MetricsGrid({
  metrics,
  collectorStatus,
  selectedName,
  highlightedNames,
  highlightableNames,
  onSelect,
  onQuickHighlight,
}: MetricsGridProps) {
  const metricFor = (name: MetricName): MetricRecord | undefined =>
    selectMetricForDisplay(metrics, name);

  const isPending = (name: MetricName): boolean => {
    if (collectorStatus === 'initializing') return true;
    return collectorStatus === 'collecting' && !metricFor(name);
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Core Web Vitals
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {CWV_NAMES.map((name) => (
            <MetricCard
              key={name}
              name={name}
              metric={metricFor(name)}
              isPending={isPending(name)}
              isSelected={selectedName === name}
              highlighted={highlightedNames.has(name)}
              canHighlight={highlightableNames.has(name)}
              onSelect={onSelect}
              onHighlight={() => onQuickHighlight(name)}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Дополнительные
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {AUX_NAMES.map((name) => (
            <MetricCard
              key={name}
              name={name}
              metric={metricFor(name)}
              isPending={isPending(name)}
              isSelected={selectedName === name}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
