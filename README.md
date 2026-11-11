# Web Performance Auditor

Расширение Chrome и Firefox (Manifest V3) для локального аудита Core Web Vitals.
Собирает LCP, CLS, INP, FCP и TTFB через `web-vitals`, связывает метрики с
DOM-целями, показывает динамику, позволяет запускать эксперименты с блокировкой
сторонних ресурсов и формирует JSON- и Markdown-отчёты.

Данные не отправляются на сервер: вся история хранится локально в IndexedDB и
`chrome.storage.local` (`browser.storage.local` в Firefox) текущего браузера.

## Возможности

- Метрики Core Web Vitals и дополнительные показатели (FCP, TTFB).
- Attribution: DOM-цель для LCP, источники сдвигов CLS, фазы INP.
- Long Tasks и связь INP с пересекающимися по времени Long Tasks.
- Подсветка DOM-цели оверлеем в Shadow DOM с цветами по типу метрики;
  включённые категории (LCP/CLS/INP) подсвечиваются автоматически и независимо,
  а на карточке есть быстрая кнопка «Подсветить/Скрыть».
- Разделы панели: «Обзор», «События», «Эксперименты», «Данные».
- График динамики с разрывами на документных навигациях и маркерами SPA, Long Tasks
  и экспериментов; для доступности есть таблица точных значений.
- Детали метрики: время измерения, статус достоверности, связанные события и
  копирование диагностики в буфер обмена.
- Лента событий с фильтрами; соседние Long Tasks группируются по времени и источнику.
- Эксперименты: блокировка аналитики, стороннего домена или пользовательского
  списка доменов для текущей вкладки.
- Сравнение исходной и экспериментальной сессий, ограничения эксперимента;
  повторные прогоны показывают медиану и наблюдавшийся диапазон изменения.
- Экспорт сессии в JSON и Markdown.
- Импорт ранее экспортированного JSON и история сессий: импорт создаёт
  независимую запись, не перезаписывает существующие и не запускает
  наблюдение; историю можно открывать и удалять.
- Настройка срока хранения сессий, журнал технических ошибок и очистка истории.
- Один и тот же интерфейс открывается в Side Panel (Chrome) или в боковой
  панели `sidebar_action` (Firefox); fallback-попап остаётся для сборок без
  обоих API.

## Разрешения

| Разрешение | Зачем нужно |
| --- | --- |
| `sidePanel` | Открывать основной интерфейс аудита в Side Panel (только Chrome; Firefox использует `sidebar_action`). |
| `storage` | Хранить настройки и указатель активной сессии в `chrome.storage.local`. |
| `activeTab`, `scripting` | Инжектировать мост и MAIN-world коллектор в текущую вкладку по действию пользователя. |
| `webNavigation` | Делить аудит на документные и SPA-сегменты, повторно инжектировать мост после навигации. |
| `declarativeNetRequest` | Создавать session-scoped правила блокировки для эксперимента. |
| `host_permissions` `http://*/*`, `https://*/*` | Запускать коллектор на обычных страницах; системные страницы (`chrome://`, `chrome-extension://` и т.п.) не аудируются. |

Разрешение `tabs` намеренно не запрашивается: `tabId` приходит из
`webNavigation`/`scripting`, а URL доступен через host permissions.

Приватность: расширение не отправляет данные и не использует аналитику.
Политика конфиденциальности —
[wwsxdc.github.io/web-performance-auditor/privacy.html](https://wwsxdc.github.io/web-performance-auditor/privacy.html).

## Требования

- Google Chrome 116 или новее (используются Side Panel и
  `chrome.declarativeNetRequest`).
- Firefox 142 или новее (MV3 event page, `sidebar_action`, MAIN-world injection,
  session DNR-правила и `data_collection_permissions`).
- Node.js 22 (см. `.nvmrc`) и npm. Поддерживаются также 20.19+, 22.13+ и 24+.

## Установка

Chrome/Chromium:

```bash
npm install
npm run build
```

Затем откройте `chrome://extensions`, включите «Режим разработчика» и загрузите
распакованное расширение из папки `dist/`.

Firefox:

```bash
npm run build:firefox
```

Откройте `about:debugging#/runtime/this-firefox` → «Загрузить временное
дополнение» → выберите `dist-firefox/manifest.json`. Для постоянной установки
пакет нужно подписать в Mozilla Add-ons; подробности и ограничения —
[`docs/firefox.md`](docs/firefox.md).

Иконка на панели инструментов открывает Side Panel в Chrome или боковую панель
в Firefox, в которой ведётся аудит.

## Разработка

```bash
npm run dev        # Vite dev server, порт 5173 (HMR)
npm run build      # tsc --noEmit + vite build -> dist/ (Chrome)
npm run build:firefox  # build + dist-firefox/ с Firefox-манифестом
npm run lint:firefox   # web-ext lint для dist-firefox/
npm run typecheck  # проверка типов
npm test           # unit-тесты (vitest)
npm run lint       # ESLint
npm run verify     # typecheck + lint + test + build
npm run e2e        # E2E по уже собранному dist/
npm run test:e2e   # build + E2E
npm run test:e2e:firefox  # build:firefox + Selenium smoke в Firefox
npm run a11y       # axe-core + keyboard-гейт по собранному dist/
npm run test:a11y  # build + a11y
npm run bench      # benchmark накладных расходов коллектора
npm run bench:collector  # build + benchmark
npm run package    # build:firefox + воспроизводимые Chrome/Firefox zip + SHA-256
npm run package:source   # source zip для ревью Mozilla Add-ons
npm run verify:release   # загрузить Chrome zip и проверить структуру Firefox/source zip
```

Release-артефакты собираются из `dist/` и `dist-firefox/` с фиксированным mtime,
поэтому повторная сборка даёт тот же SHA-256.

## CI

GitHub Actions (`.github/workflows/ci.yml`) запускает `npm run verify`, E2E,
accessibility-гейт, performance-бюджет, Firefox smoke и release-проверку на
Ubuntu при push, pull request и ручном запуске. Artifacts:
`web-performance-auditor-dist`, `web-performance-auditor-firefox` и
`web-performance-auditor-release` (оба zip + SHA-256). Release-job зависит от
зелёных `e2e`, `perf` и `firefox`.

Исходники инжектируемых скриптов лежат в `src/content/`. Файлы в
`public/generated/` и `dist/` собираются автоматически (`wpa-injected-scripts`
в `vite.config.ts`) — редактировать их вручную не нужно.

### E2E

`e2e/e2e.mjs` запускает Chrome с распакованным `dist/`, поднимает локальный
fixture-сервер и проверяет 48 сценариев: сбор всех пяти метрик, отсутствие
фиктивного INP до взаимодействия, attribution, Long Tasks, детали метрики,
мультиоверлеи, устаревшие/заменённые/перемещённые DOM-цели, авторизацию
сообщений, документные и SPA-навигации, DNR эксперимента, очистку правил,
Markdown/JSON, импорт отчёта, отказ от повторного импорта, историю сессий
(список, открытие, удаление), p75 по истории и очистку истории. Повторные
callback одной метрики сохраняются как обновления, а в экспорт попадает по одной
актуальной записи на метрику/сегмент.

```bash
npm run test:e2e
HEADLESS=1 npm run test:e2e   # headless-режим
```

Если Chrome не найден автоматически, задайте `WPA_CHROME_PATH`. Сначала
выбирается Chrome for Testing: обычная сборка Chrome игнорирует
`--load-extension`. Для сценария блокировки используется домен `blocked.test`,
который резолвится в `127.0.0.1` через `--host-resolver-rules`.

### Firefox smoke

`e2e/firefox.mjs` использует Selenium + geckodriver: устанавливает
`dist-firefox/` как временное дополнение, открывает панель как вкладку
`moz-extension://<uuid>/…` из привилегированного Marionette chrome-контекста и
проверяет 16 сценариев (аудит, метрики, атрибуция, оверлей, эксперимент с
блокировкой, очистка DNR, экспорт JSON/Markdown, p75, остановка сессии).

```bash
npm run test:e2e:firefox
HEADLESS=1 npm run test:e2e:firefox   # CI
```

### Accessibility

`e2e/a11y.mjs` прогоняет axe-core по двадцати трём состояниям Side Panel и
popup: пустые вкладки, ошибка неподдерживаемой страницы, сессия на всех
вкладках, предпросмотр импорта, импортированная сессия в истории, inline-
подтверждение удаления, ошибки импорта и настроек, сохранённые настройки,
журнал диагностики с записями и сравнение эксперимента. Дополнительно
проверяется keyboard-путь: фокус по `Tab` во всех четырёх вкладках, видимое
кольцо фокуса и переключение вкладок стрелками (`ArrowLeft`/`ArrowRight`,
`Home`/`End`). Сборка падает только на нарушениях `serious`/`critical`; текущий
результат — 0 нарушений во всех состояниях.

```bash
npm run test:a11y
HEADLESS=1 npm run test:a11y
```

### Производительность коллектора

`npm run bench:collector` (`e2e/perf.mjs`) сравнивает fixture-страницу с
расширением и без него по CDP-счётчикам `TaskDuration`, `ScriptDuration`,
`LayoutCount`, `JSHeapUsedSize` и `loadEventEnd`. Бюджет: рост `TaskDuration`
не более 5 % (или 25 мс), рост heap не более 1,5 МБ. Методика, зафиксированный
результат и решение по разделению page script описаны в
[`docs/performance/collector-overhead.md`](docs/performance/collector-overhead.md).

## Как пользоваться

1. Откройте обычную страницу `http://` или `https://` и откройте Side Panel.
2. Нажмите «Старт». Расширение запустит сессию наблюдения за текущей вкладкой.
3. Взаимодействуйте со страницей, чтобы получить реалистичный INP.
4. Подсветка LCP/CLS/INP включается автоматически, когда появляется цель.
   Чекбоксы в блоке «Оверлеи на странице» показывают состояние и позволяют
   отключить категорию; «Снять все оверлеи» очищает страницу. Для выбора другого
   источника CLS откройте карточку → «Детали» → «Подсветить».
5. В деталях доступны время измерения, статус достоверности, связанные события
   и кнопка «Скопировать диагностику».
6. Вкладка «События» показывает Long Tasks, сдвиги, взаимодействия и переходы;
   вкладка «Данные» — импорт отчёта, историю сессий, срок хранения, журнал
   ошибок и очистку истории.
7. Нажмите «Стоп», чтобы завершить измерение и сделать отчёт.
8. Экспортируйте JSON или Markdown, импортируйте ранее сохранённый JSON либо
   очистите локальную историю. Импорт добавляет новую сессию с пометкой
   «Импорт» и не изменяет существующие записи.

Аудит недоступен на системных страницах (`chrome://`, `chrome-extension://` и
т.п.). Сессия продолжается при SPA-переходах и при полных навигациях создаёт
отдельный документный сегмент.

## Эксперименты

Перед запуском эксперимента убедитесь, что в исходной сессии собрано достаточно
метрик (LCP, CLS или INP). Выберите пресет, проверьте список потенциально
затрагиваемых доменов и подтвердите перезагрузку страницы.

- Правила блокировки создаются через `chrome.declarativeNetRequest` как
  session-scoped rules и действуют только для текущей вкладки.
- После завершения или отмены эксперимента правила удаляются, результат очистки
  проверяется. Если удаление не удалось подтвердить, эксперимент получает
  статус `failed` и `cleanupStatus: "failed"`, а не `completed`.
- Перед экспериментальной перезагрузкой коллектор не инжектируется в старый
  документ, поэтому метрики предыдущей страницы не попадают в новую сессию.
- Блокировка JavaScript может сломать страницу. Результаты сравнения являются
  измеренными значениями, а не гарантией улучшения.

## Отчёты

- JSON: версионированный формат (`reportVersion`, `schemaVersion`) с вложенной
  сессией, метриками, отдельным массивом `attribution`, событиями,
  экспериментами, ограничениями измерения и блоком `completeness`
  (полнота данных: `full` / `partial` / `limited`, причины и время начала
  наблюдения). Перед экспортом структура проверяется на обязательные поля и
  сериализуемость.
- Markdown: структурированный отчёт для GitHub/GitLab Issues; явно разделяет
  факты, рекомендации и предположения, содержит раздел «Полнота данных».
  Query-параметры URL удаляются.
- Импорт принимает JSON, созданный кнопкой «Экспорт JSON», и пишет отчёт в
  историю одной транзакцией: создаются новые id, ссылки между сессией,
  метриками, событиями и экспериментами переназначаются, импортированные
  сессии не становятся активными, а DNR-правила не восстанавливаются.
  Повторный импорт того же отчёта (`session.id` + `generatedAt`), переполнение
  истории (50 сессий), небезопасный URL и жёсткие пределы (10 000 метрик,
  10 000 событий, 100 экспериментов) отклоняются. Записи сверх лимитов
  хранения (1000 метрик / 500 событий) усекаются с предупреждением.

Пример структуры JSON (сокращённые идентификаторы, полный отчёт содержит все
поля типов `MetricRecord`/`Experiment`):

```json
{
  "reportVersion": 1,
  "schemaVersion": 2,
  "generatedAt": "2026-10-20T06:30:00.000Z",
  "tool": { "name": "Web Performance Auditor", "version": "0.4.0" },
  "session": {
    "id": "102e9441-…",
    "tabId": 42,
    "url": "https://example.com/",
    "startedAt": 1792466000000,
    "endedAt": 1792466123456,
    "status": "completed",
    "browser": { "name": "Chrome", "version": "155" },
    "navigations": [
      {
        "id": "nav-1",
        "sessionId": "102e9441-…",
        "url": "https://example.com/",
        "kind": "document",
        "startedAt": 1792466000000
      }
    ]
  },
  "metrics": [
    {
      "id": "metric-1",
      "sessionId": "102e9441-…",
      "navigationId": "nav-1",
      "name": "LCP",
      "value": 296,
      "unit": "ms",
      "status": "measured",
      "rating": "good",
      "observedAt": 1792466000123,
      "delta": 296,
      "source": "web-vitals",
      "navigationType": "navigate"
    }
  ],
  "attribution": [
    {
      "metricId": "metric-1",
      "metricName": "LCP",
      "observedAt": 1792466000123,
      "attribution": {
        "source": "web-vitals",
        "target": { "selector": "#hero", "tagName": "h1" }
      }
    }
  ],
  "events": [],
  "experiments": [],
  "limitations": [],
  "completeness": {
    "level": "partial",
    "reasons": ["INP: ожидает измерения"],
    "observedSince": 1792466000000
  }
}
```

Пример фрагмента Markdown:

```markdown
## Метрики (факты)

| Показатель | Значение | Оценка |
| ---------- | -------- | ------ |
| LCP        | 296 мс   | good   |
| INP        | 312 мс   | needs-improvement |
```

## Хранение и приватность

- Настройки и указатель активной сессии — `chrome.storage.local`.
- Сессии, метрики, события и эксперименты — IndexedDB (`wpa-store`).
- Хранится ограниченное число сессий (`maxSessions: 50`), старые записи
  удаляются по возрасту (`sessionRetentionDays: 30`), число событий и метрик
  на сессию ограничено (`maxEventsPerSession: 500`,
  `maxMetricsPerSession: 1000`). Диагностические события пишутся пакетами,
  а не отдельной транзакцией на запись.
- Поддерживаемые старые записи (`schemaVersion` 1) мигрируют при чтении и
  записываются обратно в текущую схему. Неизвестные/будущие версии не читаются
  и удаляются при retention-очистке; реестр миграций и политика версий описаны
  в [`docs/storage.md`](docs/storage.md).
- Модель безопасности, отсутствие сетевых отправок и остаточные риски —
  [`SECURITY.md`](SECURITY.md) и
  [`docs/security/privacy-review.md`](docs/security/privacy-review.md).
- Результаты QA-матрицы Chrome — [`docs/qa/chrome-matrix.md`](docs/qa/chrome-matrix.md);
  история изменений — [`CHANGELOG.md`](CHANGELOG.md).
- Сообщения из MAIN-world ограничены по размеру (`PAGE_MESSAGE_LIMITS`:
  64 КБ на сообщение, 512 символов на строковое поле) и принимаются только
  из того же окна и origin.
- Текст страницы и значения полей ввода не сохраняются: только селекторы,
  теги и геометрия DOM-целей.
- Очистить историю можно в Side Panel.

## Ограничения

- Нет сбора поля (RUM). p75 считается только по локальной истории сессий
  (не более 50) и не заменяет field-данные CrUX.
- Оценки Core Web Vitals относятся к измеренным значениям, а не к
  распределению посещений.
- Не используются Lighthouse или PageSpeed Insights.
- Firefox-версия распространяется как `dist-firefox/` и отдельный
  неподписанный zip в релизе; для постоянной установки требуется подпись
  Mozilla. Side Panel заменён на `sidebar_action`, поэтому кнопка на панели
  инструментов открывает/закрывает боковую панель.
- Cross-origin iframe не инспектируются.

## Архитектура

Три изолированных контекста:

```text
┌──────────────────── page: MAIN world ────────────────────┐
│ page-script.ts: web-vitals, PerformanceObserver,          │
│ Long Tasks, replay буферизованных LCP/CLS                 │
│            window.postMessage({ type: "WPA_*" })          │
└───────────────────────────┬───────────────────────────────┘
                            │
┌──────────────── content script: ISOLATED world ───────────┐
│ index.ts: мост WPA_* ⇄ chrome.runtime.sendMessage,        │
│ Shadow DOM оверлеи (один host на категорию)               │
└───────────────────────────┬───────────────────────────────┘
                            │ runtime messages
┌──────────────── background service worker ────────────────┐
│ message-router, SessionManager, ExperimentManager,        │
│ DNR session rules, IndexedDB `wpa-store`, storage.local   │
└───────────────┬───────────────────────────┬───────────────┘
                │ runtime messages          │ scripting.executeScript
   Side Panel (React) / Popup fallback      мост + page-script
```

1. Background service worker / event page (`src/background/`) — состояние
   сессии, маршрутизация сообщений, инжекция коллектора, DNR и эксперименты.
   Все слушатели регистрируются синхронно на верхнем уровне (требование MV3).
   Доступ к `chrome.*`/`browser.*` идёт через ленивый прокси
   `src/browser/api.ts`: Chromium отдаёт `chrome`, Firefox — promise-based
   `browser`.
2. Page script (`src/content/page-script.ts`, MAIN world) — `web-vitals`,
   Long Tasks и отправка метрик через `window.postMessage`; не имеет доступа к
   `chrome.*`.
3. Content script (`src/content/index.ts`, ISOLATED world) — мост между
   страницей и расширением, оверлей и `chrome.*`.

Коллектор регистрируется динамически на `document_start` для `http/https`,
поэтому метрики загрузки собираются даже до открытия Side Panel. Мост
инжектируется по требованию при старте сессии; page-script при повторном
запуске проигрывает накопленные метрики через свежий мост. UI — React в
`src/sidepanel/` (fallback — `src/popup/`). Типы сообщений и доменных сущностей
вынесены в `src/types/`.

## Лицензия

MIT. См. [LICENSE](LICENSE).
