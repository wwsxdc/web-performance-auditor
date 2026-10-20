import type { ReactNode } from 'react';
import type { CollectorStatus } from '../../types/messages';

interface ErrorViewProps {
  status: CollectorStatus;
  message?: string;
  children?: ReactNode;
}

export function ErrorView({ status, message, children }: ErrorViewProps) {
  const isPermission = status === 'permission-denied';
  const title = isPermission
    ? 'Нет доступа к этой странице'
    : 'Страница не поддерживается';

  const description = message ?? (isPermission
    ? 'Расширение не может выполнять скрипты на этой странице. Попробуйте открыть обычный сайт (http:// или https://).'
    : 'Системные страницы браузера (chrome://, about: и другие) недоступны для аудита производительности.');

  const suggestion = isPermission
    ? 'Убедитесь, что у расширения есть разрешение на доступ к этому сайту в настройках расширений.'
    : 'Откройте любую веб-страницу по адресу http:// или https:// и попробуйте снова.';

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-gray-50">
      <h2 className="text-lg font-bold text-gray-900 mb-2">{title}</h2>
      <p className="text-sm text-gray-600 max-w-sm mb-4">{description}</p>
      <p className="text-xs text-gray-400 max-w-sm">{suggestion}</p>
      {children && <div className="mt-6 w-full max-w-md text-left">{children}</div>}
    </div>
  );
}
