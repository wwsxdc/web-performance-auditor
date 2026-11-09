import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionApi, getSidebarAction, toggleSidebar } from './api';

const scope = globalThis as unknown as {
  chrome?: unknown;
  browser?: unknown;
  sidebarAction?: unknown;
};

afterEach(() => {
  delete scope.chrome;
  delete scope.browser;
  delete scope.sidebarAction;
});

describe('extensionApi', () => {
  it('reads the Chromium namespace when no browser namespace exists', () => {
    scope.chrome = { runtime: { id: 'chromium-id' } };

    expect(extensionApi.runtime.id).toBe('chromium-id');
  });

  it('prefers the promise-based Firefox namespace', () => {
    scope.chrome = { runtime: { id: 'chromium-id' } };
    scope.browser = { runtime: { id: 'firefox-id' } };

    expect(extensionApi.runtime.id).toBe('firefox-id');
  });

  it('resolves the namespace lazily, not at import time', () => {
    expect(scope.chrome).toBeUndefined();
    scope.chrome = { runtime: { id: 'late-id' } };

    expect(extensionApi.runtime.id).toBe('late-id');
  });

  it('reports missing APIs through the namespace object', () => {
    scope.chrome = { runtime: { id: 'chromium-id' } };

    expect(extensionApi.sidePanel).toBeUndefined();
    expect('sidePanel' in extensionApi).toBe(false);
  });

  it('throws a clear error when no namespace is available', () => {
    expect(() => extensionApi.runtime).toThrow('WebExtensions API недоступен');
  });
});

describe('sidebar helpers', () => {
  it('finds the Firefox sidebar API on the browser namespace', () => {
    const sidebarAction = { open: vi.fn(), close: vi.fn() };
    scope.browser = { sidebarAction };

    expect(getSidebarAction()).toBe(sidebarAction);
  });

  it('returns undefined when the browser has no sidebar', () => {
    scope.chrome = { runtime: { id: 'chromium-id' } };

    expect(getSidebarAction()).toBeUndefined();
  });

  it('uses toggle() when available', async () => {
    const toggle = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    await expect(toggleSidebar({ toggle, open, close })).resolves.toBe(true);
    expect(toggle).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('falls back to isOpen() plus open()/close()', async () => {
    const open = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const isOpen = vi.fn(async () => true);

    await expect(toggleSidebar({ open, close, isOpen })).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();

    isOpen.mockResolvedValueOnce(false);
    await expect(toggleSidebar({ open, close, isOpen })).resolves.toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it('returns false when the sidebar is unavailable or throws', async () => {
    expect(await toggleSidebar(undefined)).toBe(false);

    const failing = vi.fn(async () => {
      throw new Error('closed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        toggleSidebar({ toggle: failing, open: vi.fn(), close: vi.fn() }),
      ).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
