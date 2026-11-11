# QA-матрица Firefox (v0.4.0)

Дата: 2026-11-11

## Окружение

| Параметр | Значение |
| --- | --- |
| ОС | Windows 11 |
| Firefox | 159.0.1 |
| Сборка | `dist-firefox/` из `main`, `v0.4.0` |
| Сборка пакета | `npm run build:firefox` — PASS |
| Валидация | `npm run lint:firefox` — 0 ошибок, 2 предупреждения |
| Автоматический smoke | `HEADLESS=1 npm run test:e2e:firefox` — 16/16 PASS |
| Установка | Selenium `installWebExtension(..., { permanent: false })` |

## Автоматический smoke

`e2e/firefox.mjs` (Selenium + geckodriver) устанавливает временное дополнение и
открывает `moz-extension://<uuid>/src/sidepanel/index.html` через
привилегированный Marionette chrome-контекст.

| Проверка | Результат |
| --- | --- |
| Установка аддона и совпадение id | PASS |
| UUID из `prefs.js` | PASS |
| Панель рендерится с `browser.*` | PASS |
| Поиск целевой вкладки | PASS |
| `SESSION_START` | PASS |
| LCP/CLS/INP/FCP/TTFB | PASS |
| LCP attribution | PASS |
| `HIGHLIGHT_TARGET` и shadow-DOM оверлей | PASS |
| `EXPERIMENT_START` | PASS |
| Блокировка `blocked.test` после reload | PASS |
| Метрики experiment-сессии | PASS |
| `EXPERIMENT_FINISH` и очистка DNR | PASS |
| Экспорт Markdown | PASS |
| Экспорт JSON | PASS |
| p75 по истории | PASS |
| `SESSION_STOP` | PASS |

## Структура пакета

| Проверка | Результат |
| --- | --- |
| Версия `manifest.firefox.json` совпадает с Chrome-манифестом | PASS |
| `background.scripts` содержит существующий `service-worker-loader.js` | PASS |
| `background.type` = `module` | PASS |
| `sidebar_action.default_panel` существует (`src/sidepanel/index.html`) | PASS |
| Иконки 16/48/128 присутствуют | PASS |
| Chrome-only поля (`side_panel`, `minimum_chrome_version`, разрешение `sidePanel`) отсутствуют | PASS |
| `browser_specific_settings.gecko.id` и `strict_min_version` заданы | PASS |
| `web-ext lint` | 0 ошибок |
| Воспроизводимый `web-performance-auditor-firefox-<version>.zip` + `.sha256` | PASS |

`web-ext lint` выдаёт два предупреждения `UNSAFE_VAR_ASSIGNMENT` на
`innerHTML` во внутренностях React-бандла. Они не относятся к коду расширения
и не блокируют установку.

## Ручная проверка перед публикацией

- [ ] открытие/закрытие боковой панели кнопкой на панели инструментов;
- [ ] журнал диагностики и настройки хранения;
- [ ] импорт JSON в Firefox;
- [ ] визуальная проверка на узкой ширине боковой панели.

## Ограничения

- Firefox устанавливает неподписанные расширения только как временные
  дополнения; постоянная установка требует подписи Mozilla.
- `declarativeNetRequest` и кэширование в Firefox могут вести себя иначе, чем в
  Chrome; сравнение эксперимента остаётся измерением, а не гарантией.
- Профили Chrome и Firefox независимы: история и настройки не синхронизируются.
