import type { CollectorStatus } from '../../types/messages';

interface HeaderProps {
  url: string | null | undefined;
  status: CollectorStatus;
  sessionStartedAt: number | undefined;
  onStart: () => void;
  onStop: () => void;
}

const STATUS_LABELS: Record<CollectorStatus, string> = {
  idle: 'Не подключено',
  initializing: 'Подключение…',
  collecting: 'Наблюдение',
  unsupported: 'Не поддерживается',
  'permission-denied': 'Нет разрешений',
  error: 'Ошибка',
};

const STATUS_DOT_COLORS: Record<CollectorStatus, string> = {
  idle: 'bg-gray-300',
  initializing: 'bg-yellow-400 animate-pulse',
  collecting: 'bg-green-500 animate-pulse',
  unsupported: 'bg-red-400',
  'permission-denied': 'bg-red-400',
  error: 'bg-red-500',
};

export function Header({ url, status, sessionStartedAt, onStart, onStop }: HeaderProps) {
  const isActive = status === 'collecting' || status === 'initializing';
  const startTime = sessionStartedAt
    ? new Date(sessionStartedAt).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  return (
    <header className="bg-white rounded-xl shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold text-gray-900">WPA</h1>
          <p
            className="text-xs text-gray-500 truncate mt-0.5"
            title={url ?? ''}
          >
            {url ?? 'Нет активной вкладки'}
          </p>
        </div>

        <button
          onClick={isActive ? onStop : onStart}
          className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            isActive
              ? 'bg-red-100 text-red-700 hover:bg-red-200 focus:ring-red-500'
              : 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
          }`}
        >
          {isActive ? 'Стоп' : 'Аудит'}
        </button>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT_COLORS[status]}`}
          aria-hidden="true"
        />
        <span className="text-xs text-gray-600" role="status" aria-live="polite">
          {STATUS_LABELS[status]}
          {startTime && ` · с ${startTime}`}
        </span>
      </div>
    </header>
  );
}
