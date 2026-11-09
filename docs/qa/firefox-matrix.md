# QA-матрица Firefox (v0.3.0)

Дата: 2026-11-09

## Окружение

| Параметр | Значение |
| --- | --- |
| ОС | Windows 11 |
| Firefox | 159.0.1 |
| Сборка | `dist-firefox/` из `main`, `v0.3.0` |
| Сборка пакета | `npm run build:firefox` — PASS |
| Валидация | `web-ext lint --source-dir dist-firefox` — 0 ошибок, 2 предупреждения |
| Установка | `web-ext run` — временное дополнение установлено |

## Что проверено автоматически

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
| Загрузка как temporary add-on | PASS |

`web-ext lint` выдаёт два предупреждения `UNSAFE_VAR_ASSIGNMENT` на
`innerHTML` во внутренностях React-бандла. Они не относятся к коду расширения
и не блокируют установку.

## Что требует ручной проверки

Полный runtime smoke в Firefox автоматически не выполнялся: E2E-набор построен
на Puppeteer и Chrome. Перед публикацией в Mozilla Add-ons нужно вручную
проверить:

- [ ] старт аудита и появление метрик LCP/CLS/INP/FCP/TTFB;
- [ ] оверлей и подсветку DOM-цели;
- [ ] SPA- и документные сегменты навигации;
- [ ] эксперимент с DNR-правилами и очистку правил после завершения;
- [ ] экспорт JSON/Markdown и импорт JSON;
- [ ] открытие/закрытие боковой панели кнопкой на панели инструментов;
- [ ] журнал диагностики и настройки хранения.

Результаты ручного прогона стоит дополнять в этот файл.

## Ограничения

- Firefox устанавливает неподписанные расширения только как временные
  дополнения; постоянная установка требует подписи Mozilla.
- `declarativeNetRequest` и кэширование в Firefox могут вести себя иначе, чем в
  Chrome; сравнение эксперимента остаётся измерением, а не гарантией.
- Профили Chrome и Firefox независимы: история и настройки не синхронизируются.
