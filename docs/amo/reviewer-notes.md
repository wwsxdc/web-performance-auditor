# Notes to AMO reviewer

## What the add-on does

Web Performance Auditor measures Core Web Vitals (LCP, CLS, INP, FCP, TTFB) on
the current http/https page, attributes each metric to DOM elements, and lets
the user run a local network-blocking experiment. Everything is computed in the
browser. There is no server, account, analytics, telemetry, or remote code.

## How to test

1. Install the add-on.
2. Open any http/https page, for example `https://example.com`.
3. Click the toolbar icon. The sidebar opens.
4. Press **Аудит** (Start audit) in the header.
5. Interact with the page (click, scroll) and wait a few seconds.
6. The overview shows LCP, CLS, INP, FCP and TTFB. Click a metric card to see
   attribution details.
7. Open **События** (Events) for Long Tasks and diagnostics.
8. Open **Эксперименты** (Experiments), start an experiment for a domain, and
   compare the baseline and experiment sessions.
9. Open **Данные** (Data) for JSON/Markdown export, import, history, retention
   settings, and history cleanup.

UI labels: Аудит = Start audit, Стоп = Stop, Обзор = Overview, События = Events,
Эксперименты = Experiments, Данные = Data.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Settings and the active session pointer in `storage.local`. |
| `activeTab` | Start an audit on the tab the user explicitly activates. |
| `scripting` | Register the MAIN-world collector and inject the bridge on demand. |
| `webNavigation` | Split a session into document and SPA segments and re-inject the bridge after navigation. |
| `declarativeNetRequest` | Session-scoped blocking rules for experiments only. |
| `host_permissions` `http://*/*`, `https://*/*` | Run the collector early on ordinary pages so LCP/FCP/TTFB are not missed. System pages (`chrome://`, `about:`, `file://`) are rejected by `isAuditableUrl`. |

`tabs` is intentionally **not** requested. The background receives `tabId` from
`webNavigation` and `scripting` events, and URL access is covered by the host
permissions.

## Data handling

- No `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` in `src/`.
- No remote scripts, fonts, or `web_accessible_resources`.
- URLs are sanitized to `origin + pathname`; query strings and hashes are
  dropped before storage.
- History is capped (50 sessions, 500 events and 1000 metrics per session) and
  expires after 30 days by default (user-configurable).
- The user can delete all local data from **Данные** → **Очистить историю**.

## Source build

The add-on is written in TypeScript and built with Vite, React, and CRXJS. The
submitted package is minified, so a source package and build instructions are
included. Exact steps:

```bash
npm ci
npm run build:firefox
```

The result is `dist-firefox/`. The reviewer can compare
`dist-firefox/manifest.json` and the file list with the submitted zip.

`public/generated/page-script.js` and `public/generated/content.js` are generated
during the build by the `wpa-injected-scripts` Vite plugin from
`src/content/page-script.ts` and `src/content/index.ts`. They are not committed.

## Known linter warnings

`web-ext lint` reports two `UNSAFE_VAR_ASSIGNMENT` warnings coming from the
minified React DOM bundle (`innerHTML` assignments inside React internals). The
add-on does not insert user-controlled HTML and does not use `eval` or
`new Function`.
