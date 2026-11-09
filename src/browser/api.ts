/**
 * Cross-browser access to the WebExtensions API.
 *
 * Chromium exposes the `chrome` namespace; Firefox exposes the promise-based
 * `browser` namespace (and a callback-style `chrome` alias). Both are resolved
 * lazily on every property access so tests can install a stub after this module
 * has been imported, and so the page script — which never touches the extension
 * API — pays nothing.
 *
 * Import it as `extensionApi` (not `chrome`) to keep the `chrome.*` type
 * namespace available for annotations such as `chrome.runtime.MessageSender`.
 */
type ExtensionNamespace = typeof chrome;

export interface SidebarActionApi {
  open: () => Promise<void>;
  close: () => Promise<void>;
  toggle?: () => Promise<void>;
  isOpen?: () => Promise<boolean>;
  setPanel?: (details: { panel: string }) => Promise<void>;
}

interface ExtensionScope {
  browser?: ExtensionNamespace;
  chrome?: ExtensionNamespace;
  sidebarAction?: SidebarActionApi;
}

function currentScope(): ExtensionScope & typeof globalThis {
  return globalThis as ExtensionScope & typeof globalThis;
}

function activeNamespace(): ExtensionNamespace {
  const scope = currentScope();
  const namespace = scope.browser ?? scope.chrome;
  if (!namespace) {
    throw new Error('WebExtensions API недоступен в этом контексте');
  }
  return namespace;
}

export const extensionApi: ExtensionNamespace = new Proxy({} as ExtensionNamespace, {
  get(_target, property) {
    return Reflect.get(activeNamespace() as object, property);
  },
  has(_target, property) {
    return Reflect.has(activeNamespace() as object, property);
  },
});

/**
 * Firefox-only sidebar API. Chromium exposes `sidePanel` instead, so callers
 * must feature-detect before using this result.
 */
export function getSidebarAction(): SidebarActionApi | undefined {
  const scope = currentScope();
  const namespace = scope.browser ?? scope.chrome;
  const fromNamespace = namespace
    ? (namespace as ExtensionNamespace & { sidebarAction?: SidebarActionApi }).sidebarAction
    : undefined;
  return fromNamespace ?? scope.sidebarAction;
}

/**
 * Opens or closes the Firefox sidebar. Returns `false` when the browser has no
 * sidebar support so the caller can fall back to another surface.
 */
export async function toggleSidebar(
  sidebar: SidebarActionApi | undefined = getSidebarAction(),
): Promise<boolean> {
  if (!sidebar) return false;
  try {
    if (typeof sidebar.toggle === 'function') {
      await sidebar.toggle();
      return true;
    }
    const isOpen =
      typeof sidebar.isOpen === 'function' ? await sidebar.isOpen() : false;
    await (isOpen ? sidebar.close() : sidebar.open());
    return true;
  } catch (error) {
    console.warn('[WPA] Failed to toggle sidebar:', error);
    return false;
  }
}
