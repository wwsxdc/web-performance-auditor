# AMO listing copy

## Common fields

| Field | Value |
| --- | --- |
| Add-on name | Web Performance Auditor |
| Add-on ID | `web-performance-auditor@wwsxdc.github.io` |
| Version | `0.4.1` |
| License | MIT |
| Homepage | https://github.com/wwsxdc/web-performance-auditor |
| Support site | https://github.com/wwsxdc/web-performance-auditor/issues |
| Privacy policy | https://wwsxdc.github.io/web-performance-auditor/privacy.html |
| Category | Developer Tools |
| Tags | performance, core web vitals, lcp, cls, inp, web vitals, devtools |

## English

### Summary

Local Core Web Vitals audit with LCP, CLS, INP, FCP and TTFB attribution, experiments, and JSON/Markdown reports.

### Description

Web Performance Auditor measures Core Web Vitals on any http/https page and keeps every measurement inside your browser profile.

- LCP, CLS, INP, FCP and TTFB collected with `web-vitals`.
- DOM attribution: which element caused LCP, which nodes shifted, and which interaction drove INP.
- Long Tasks and their relationship to INP.
- On-page overlay with color-coded targets.
- Experiments: block analytics, a third-party domain, or a custom domain list for the current tab, then compare the baseline and experiment sessions.
- History, p75 summary, JSON and Markdown export/import.
- No accounts, analytics, telemetry, or remote code. Data stays in IndexedDB and `storage.local`.

The interface is in Russian. The extension requires Firefox 142 or newer and opens in the sidebar.

### What’s new in 0.4.1

- First Mozilla Add-ons release.
- Removed the `tabs` permission; tab access now relies on `webNavigation` and host permissions.
- Added AMO source-build instructions and privacy policy.

## Русский

### Краткое описание

Локальный аудит Core Web Vitals с привязкой LCP, CLS, INP, FCP и TTFB к DOM, экспериментами и отчётами.

### Описание

Web Performance Auditor измеряет Core Web Vitals на любой http/https-странице и хранит все данные только в профиле браузера.

- LCP, CLS, INP, FCP и TTFB собираются через `web-vitals`.
- Привязка к DOM: какой элемент вызвал LCP, какие узлы сдвинулись и какое взаимодействие определило INP.
- Long Tasks и их связь с INP.
- Оверлей на странице с цветовой маркировкой целей.
- Эксперименты: блокировка аналитики, стороннего домена или пользовательского списка доменов для текущей вкладки, затем сравнение исходной и экспериментальной сессий.
- История, p75-сводка, экспорт и импорт JSON/Markdown.
- Без аккаунтов, аналитики, телеметрии и удалённого кода. Данные остаются в IndexedDB и `storage.local`.

Интерфейс на русском языке. Требуется Firefox 142 или новее; панель открывается в боковой панели.

### Что нового в 0.4.1

- Первый релиз в Mozilla Add-ons.
- Убрано разрешение `tabs`: доступ к вкладкам обеспечивают `webNavigation` и host permissions.
- Добавлены инструкции по сборке для AMO и публичная privacy policy.

## Screenshots

| File | Caption EN | Caption RU |
| --- | --- | --- |
| `01-overview.png` | Core Web Vitals with local history and chart | Core Web Vitals, история и график |
| `02-metric-details.png` | LCP/INP attribution and on-page highlight | Привязка LCP/INP и подсветка на странице |
| `03-events.png` | Events, Long Tasks and diagnostics | События, Long Tasks и диагностика |
| `04-experiments.png` | Baseline vs. experiment comparison | Сравнение исходной и экспериментальной сессий |
| `05-data.png` | Export, import and local history | Экспорт, импорт и локальная история |
