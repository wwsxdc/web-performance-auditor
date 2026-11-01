import type { OverlayCategory } from '../../utils/metric-targets';

export type { OverlayCategory } from '../../utils/metric-targets';

const CATEGORIES: { name: OverlayCategory; label: string; hint: string }[] = [
  { name: 'LCP', label: 'LCP', hint: 'зелёная рамка' },
  { name: 'CLS', label: 'CLS', hint: 'красная рамка' },
  { name: 'INP', label: 'INP', hint: 'жёлтая рамка' },
];

export interface ActiveOverlayState {
  targetId?: string;
  available: boolean;
  reason?: string;
}

interface OverlayControlsProps {
  enabled: Record<OverlayCategory, boolean>;
  active: Partial<Record<OverlayCategory, ActiveOverlayState>>;
  available: Record<OverlayCategory, boolean>;
  onToggle: (category: OverlayCategory, enabled: boolean) => void;
  onClearAll: () => void;
}

function statusLabel(
  enabled: boolean,
  active: ActiveOverlayState | undefined,
  available: boolean,
): string {
  if (!enabled) return 'выключено';
  if (active?.available) return 'показан на странице';
  if (active?.available === false) return 'цель недоступна';
  if (available) return 'включается…';
  return 'ждём цель';
}

export function OverlayControls({
  enabled,
  active,
  available,
  onToggle,
  onClearAll,
}: OverlayControlsProps) {
  return (
    <fieldset className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        Оверлеи на странице
      </legend>
      <p className="text-[10px] text-gray-500">
        Включённые категории подсвечиваются автоматически. Чтобы выбрать другой источник CLS,
        откройте «Детали» → «Подсветить». Внутри cross-origin iframe браузер не даёт
        расширению доступ к DOM, поэтому такая цель не подсвечивается, но диагностика сохраняется.
      </p>
      <div className="mt-2 space-y-1.5">
        {CATEGORIES.map((category) => {
          const state = active[category.name];
          const hasTarget = available[category.name];
          const status = statusLabel(enabled[category.name], state, hasTarget);
          return (
            <label
              key={category.name}
              className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50/70 px-2 py-1.5 text-xs text-gray-700"
              title={state?.reason}
            >
              <input
                type="checkbox"
                checked={enabled[category.name]}
                onChange={(event) => onToggle(category.name, event.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span className="font-semibold">{category.label}</span>
              <span className="text-[10px] text-gray-500">{category.hint}</span>
              <span
                className={`ml-auto text-[10px] ${
                  state?.available === false
                    ? 'text-red-600'
                    : state?.available
                      ? 'text-green-700'
                      : 'text-gray-500'
                }`}
                aria-live="polite"
              >
                {status}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[10px] text-gray-500">
          Выключенная категория не подсвечивается, но диагностика остаётся доступна.
        </p>
        <button
          type="button"
          onClick={onClearAll}
          className="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1"
        >
          Снять все оверлеи
        </button>
      </div>
    </fieldset>
  );
}
