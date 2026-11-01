import { useEffect, useState } from 'react';
import type { AuditSession } from '../../types/session';
import { CompletenessStatus } from './CompletenessStatus';

interface SessionInfoProps {
  session: AuditSession;
}

export function SessionInfo({ session }: SessionInfoProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (session.endedAt) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [session.endedAt]);

  const startTime = new Date(session.startedAt).toLocaleTimeString('ru-RU');
  const duration = session.endedAt
    ? Math.round((session.endedAt - session.startedAt) / 1000)
    : Math.round((Date.now() - session.startedAt) / 1000);
  const measuredMetrics = new Set(
    session.metrics.filter((metric) => metric.status === 'measured').map((metric) => metric.name),
  ).size;
  const statusLabels: Record<AuditSession['status'], string> = {
    active: 'Активна',
    completed: 'Завершена',
    interrupted: 'Прервана',
    unsupported: 'Не поддерживается',
    error: 'Ошибка',
  };

  const formatDuration = (s: number): string => {
    if (s < 60) return `${s} сек`;
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min} мин ${sec} сек`;
  };

  return (
    <div className="bg-white rounded-lg p-3 shadow-sm text-xs text-gray-600">
      <div className="flex justify-between">
        <span>Статус:</span>
        <span className="font-medium text-gray-800">{statusLabels[session.status]}</span>
      </div>
      <div className="flex justify-between mt-1">
        <span>Начало сессии:</span>
        <span className="font-medium text-gray-800">{startTime}</span>
      </div>
      <div className="flex justify-between mt-1">
        <span>Длительность:</span>
        <span className="font-medium text-gray-800">{formatDuration(duration)}</span>
      </div>
      <div className="flex justify-between mt-1">
        <span>Метрик измерено:</span>
        <span className="font-medium text-gray-800">{measuredMetrics} / 5</span>
      </div>
      <div className="mt-1">
        <CompletenessStatus session={session} />
      </div>
      <div className="flex justify-between mt-1">
        <span>Обновлений метрик:</span>
        <span className="font-medium text-gray-800">{session.metrics.length}</span>
      </div>
      <div className="flex justify-between mt-1">
        <span>Браузер:</span>
        <span className="font-medium text-gray-800">
          {session.browser.name} {session.browser.version ?? ''}
        </span>
      </div>
    </div>
  );
}
