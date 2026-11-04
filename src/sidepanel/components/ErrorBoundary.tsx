import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logUiError } from '../api';

interface ErrorBoundaryProps {
  children: ReactNode;
  scope: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a rendering failure inside one surface (P2.1). The panel/popup shows a
 * recoverable message instead of a blank page, and the failure is written to
 * the diagnostic journal without any page content.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack contains component names only, not page data.
    const stack = (info.componentStack ?? '').trim().slice(0, 300);
    void logUiError(this.props.scope, stack ? `${error.message} | ${stack}` : error.message);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 p-6 text-center">
        <div role="alert" className="space-y-2">
          <h1 className="text-base font-semibold text-gray-900">
            Интерфейс столкнулся с ошибкой
          </h1>
          <p className="text-sm text-gray-600">
            Записанные данные аудита не потеряны. Перезагрузите панель, чтобы продолжить.
          </p>
          <p className="text-xs text-gray-500">
            Ошибка добавлена в диагностический журнал (вкладка «Данные»).
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Перезагрузить панель
        </button>
      </main>
    );
  }
}
