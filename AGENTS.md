# AGENTS.md

## What this is

Chrome extension (Manifest V3) — "Web Performance Auditor". Collects Core Web Vitals
(LCP/CLS/INP/FCP/TTFB) via `web-vitals` and attributes them to DOM elements.
Stack: Vite 6 + `@crxjs/vite-plugin` (beta) + React 19 + Tailwind v4 + TypeScript (strict) + `idb`.

Product requirements live in the root `*.txt` file (Russian; the current `ТЗ.txt`
is UTF-8 — check the actual file encoding before reading). Code comments reference
requirement IDs like `FR-01`, `FR-03` that map to that spec.

## Commands

```bash
npm install        # deps are installed locally; package-lock.json is generated
npm run dev        # Vite dev server, STRICT port 5173 (HMR also on 5173)
npm run build      # tsc --noEmit && vite build  -> dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run (unit tests in src/utils)
npm run lint       # eslint src/ (flat config: eslint.config.js)
npm run verify     # typecheck + lint + test + build
```

To run the extension: `npm run build`, then load `dist/` as an unpacked extension
in `chrome://extensions`. During `npm run dev`, CRXJS serves the extension via its
Vite dev server (load the CRXJS unpacked dev extension or point at the dev output).

## Architecture (non-obvious wiring)

Three isolated script contexts — this is the core of the design:

1. **Background service worker** — `src/background/index.ts` (entry declared in
   root `manifest.json`). All listeners MUST be registered synchronously at top
   level (MV3 kills async-registered listeners on SW restart). State is restored
   via `sessionManager.restore()` at both startup and top-level evaluation.
   Message handling is centralized in `src/background/message-router.ts`.
2. **Page script (MAIN world)** — `src/content/page-script.ts`. Runs in the page,
   has **no `chrome.*` access**. Collects metrics with `web-vitals`
   (`reportAllChanges: true`) and sends them via `window.postMessage` with a
   `WPA_`-prefixed `type`. Guards against double injection with a window global.
3. **Content script (ISOLATED world)** — `src/content/index.ts`. Pure bridge:
   `window.postMessage` (WPA_ types) ⇄ `chrome.runtime.sendMessage`.

The page script is registered dynamically at `document_start` via
`chrome.scripting.registerContentScripts` (MAIN world, all http/https pages) so
load-time metrics are captured even if the side panel opens later. The bridge
(`generated/content.js`) is injected **on demand** on `SESSION_START`, after
which `generated/page-script.js` is executed again; its global handle replays
the cached latest metrics through the freshly installed bridge (see
`src/background/injector.ts`). There is no static `content_scripts` entry in
the manifest. The two `generated/*.js` files are esbuild IIFE bundles produced
by the `wpa-injected-scripts` plugin in `vite.config.ts` from
`src/content/page-script.ts` and `src/content/index.ts`; do not edit the
generated files under `public/generated/` by hand.

Each document gets a `documentToken`; the SessionManager rejects late metrics
from a previous document and clears the token on full navigation. Full document
navigations create a new `document` navigation segment and trigger collector
re-injection; SPA/hash transitions create `spa` segments without resetting the
document token. Load metrics (LCP/FCP/TTFB) stay attached to the document
segment, while CLS/INP attach to the active (possibly SPA) segment. The bridge
is also re-injected on `onDOMContentLoaded`/`onCompleted` if the commit-time
injection was too early. IndexedDB schema is v3 (`experiments` store with
`by-baseline-session`/`by-experiment-session` indexes, plus `by-navigation`
indexes); stored-record `SCHEMA_VERSION` (2) is exported from
`src/constants/config.ts`.

UI is the **side panel** React app: `src/sidepanel/index.html` → `index.tsx` →
`App.tsx` (opened by toolbar click via `sidePanel.setPanelBehavior`).

Message and domain types are centralized in `src/types/` (`messages.ts`,
`session.ts`, `metrics.ts`, `report.ts`). Extend types there, not ad hoc.

## Gotchas

- `manifest.json` sits at the repo root and is **imported by `vite.config.ts`**
  and passed to the CRXJS plugin. Edit it there; do not create a second manifest.
- Icons live in `public/icons/` and are referenced in the manifest as
  `icons/icon{16,48,128}.png` (Vite copies the contents of `public/` to `dist/`).
- `tsconfig.json` defines a `@/*` → `./src/*` alias and `vite.config.ts` now has
  a matching `resolve.alias`. Relative imports are still the norm in this repo.
- `tsconfig` has `noUnusedLocals` + `noUnusedParameters` + `strict` — unused
  imports/vars fail `npm run build` (which runs `tsc --noEmit` first).
- ESLint uses flat config (`eslint.config.js`, `typescript-eslint`,
  `eslint-plugin-react-hooks`); `public/generated` is ignored.
- Vitest config is `vitest.config.ts` (node environment, `src/**/*.test.ts`).
  React component tests still need `jsdom` added.
- `@crxjs/vite-plugin` is a `2.0.0-beta` — MV3/CRXJS behavior (HMR, web
  accessible resources, SW reload) can differ from stable Vite plugins.
- Git remote `origin` and GitHub Actions CI are configured; `main` is the default
  branch. Use `npm run verify` as the verification loop.
- On Windows PowerShell, `npm.ps1` may be blocked by execution policy; invoke
  `npm.cmd` instead (and prepend `C:\Program Files\nodejs` to `PATH` if Node is
  not already visible in the shell).

## Git workflow

After a code review returns a positive verdict:

1. Run `npm run verify`; for UI, background, content-script, or E2E changes also
   run the E2E suite.
2. Commit the reviewed changes with a concise message and push to `origin/main`.
   Do not wait for a separate publish prompt.
3. If verification or review finds a problem, fix it and create a new commit;
   never amend or force-push published history.

The reviewer remains read-only. The main agent (or a dedicated publisher) performs
the commit and push after the review passes. Never commit `ТЗ.txt`, `.opencode/`,
`node_modules/`, `dist/`, `public/generated/`, or secrets.
