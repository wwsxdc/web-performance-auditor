import type { MetricRating } from '../../types/metrics';

interface StatusBadgeProps {
  rating: MetricRating;
  className?: string;
}

const BADGE_STYLES: Record<MetricRating, { bg: string; text: string; label: string }> = {
  good: { bg: 'bg-green-100', text: 'text-green-800', label: 'Хорошо' },
  'needs-improvement': { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Средне' },
  poor: { bg: 'bg-red-100', text: 'text-red-800', label: 'Плохо' },
  unrated: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Н/Д' },
};

export function StatusBadge({ rating, className = '' }: StatusBadgeProps) {
  const style = BADGE_STYLES[rating];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text} ${className}`}
    >
      {style.label}
    </span>
  );
}
