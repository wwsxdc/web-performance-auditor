// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const logUiError = vi.fn(async (..._args: [string, unknown]) => undefined);

vi.mock('../api', () => ({
  logUiError: (scope: string, error: unknown) => logUiError(scope, error),
}));

function Boom(): never {
  throw new Error('component exploded');
}

function Healthy() {
  return <p>interface works</p>;
}

describe('ErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // React reports caught render errors through console.error.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logUiError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });

  it('renders children while nothing throws', () => {
    act(() => {
      root.render(
        <ErrorBoundary scope="sidepanel">
          <Healthy />
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('interface works');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a recoverable fallback and logs the failure instead of crashing', () => {
    act(() => {
      root.render(
        <ErrorBoundary scope="sidepanel">
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Интерфейс столкнулся с ошибкой',
    );
    expect(container.textContent).toContain('Перезагрузить панель');
    expect(logUiError).toHaveBeenCalledTimes(1);
    expect(logUiError.mock.calls[0][0]).toBe('sidepanel');
    expect(String(logUiError.mock.calls[0][1])).toContain('component exploded');
  });
});
