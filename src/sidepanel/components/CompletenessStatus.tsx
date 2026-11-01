import type { AuditSession } from '../../types/session';
import type { CompletenessLevel } from '../../types/report';
import { calculateCompleteness, COMPLETENESS_LABELS } from '../../utils/completeness';

const LEVEL_CLASSES: Record<CompletenessLevel, string> = {
  full: 'bg-green-100 text-green-900',
  partial: 'bg-amber-100 text-amber-900',
  limited: 'bg-red-100 text-red-900',
};

interface CompletenessStatusProps {
  session: AuditSession;
  /** Overview shows only the badge; the data tab also lists the reasons. */
  compact?: boolean;
}

export function CompletenessStatus({ session, compact = false }: CompletenessStatusProps) {
  const completeness = calculateCompleteness(session.metrics, session.events);

  return (
    <div className="text-xs text-gray-600">
      <div className="flex items-center justify-between gap-2">
        <span>Полнота данных:</span>
        <span
          className={`font-medium px-1.5 py-0.5 rounded ${LEVEL_CLASSES[completeness.level]}`}
        >
          {COMPLETENESS_LABELS[completeness.level]}
        </span>
      </div>
      {!compact && completeness.reasons.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-700">Причины неполноты</summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            {completeness.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            <li>Наблюдение начато: {new Date(session.startedAt).toLocaleString('ru-RU')}</li>
          </ul>
        </details>
      )}
    </div>
  );
}
