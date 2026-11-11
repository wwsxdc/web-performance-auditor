# Firefox-сборка

Расширение собирается из того же исходного кода, что и Chrome-версия. Отличия
сосредоточены в манифесте и в тонком кросс-браузерном слое
[`src/browser/api.ts`](../src/browser/api.ts).

## Сборка

```bash
npm run build:firefox
```

Команда выполняет обычную Chrome-сборку (`tsc --noEmit && vite build`), затем
`scripts/build-firefox.mjs`:

1. копирует `dist/` в `dist-firefox/`;
2. подменяет `manifest.json` на [`manifest.firefox.json`](../manifest.firefox.json);
3. проверяет, что версия совпадает с Chrome-манифестом, background-скрипты и
   HTML-страницы существуют, а Chrome-only поля (`side_panel`,
   `minimum_chrome_version`, разрешение `sidePanel`) не попали в Firefox-пакет.

Скрипт падает с понятной ошибкой, если `dist/` не собран или манифесты
разошлись по версии. В CI этот шаг выполняется после `npm run verify`, а
`dist-firefox/` публикуется как artifact `web-performance-auditor-firefox`.

`npm run package` собирает оба пакета и кладёт в `release/`:

- `web-performance-auditor-<version>.zip` — Chrome;
- `web-performance-auditor-firefox-<version>.zip` — Firefox.

Оба архива воспроизводимы (отсортированные записи, фиксированный mtime) и
сопровождаются `.sha256`. `npm run verify:release` загружает Chrome-zip в
Chrome и структурно проверяет Firefox-zip (версия, `background.scripts`,
`sidebar_action`, наличие файлов).

Точка входа background — `service-worker-loader.js`, который создаёт
`@crxjs/vite-plugin` (beta). Firefox загружает его как ES-модуль через
`background.scripts` + `type: "module"`; если CRXJS перестанет генерировать
этот файл, сборка упадёт на проверке, а не выпустит нерабочий пакет.

## Установка

Временная (для разработки и проверки):

1. `npm run build:firefox`;
2. `about:debugging#/runtime/this-firefox`;
3. «Загрузить временное дополнение»;
4. выбрать `dist-firefox/manifest.json`.

Постоянная установка возможна только после подписи в Mozilla Add-ons: Firefox
не устанавливает неподписанные расширения в обычном профиле. Для подписи
используется `browser_specific_settings.gecko.id`
(`web-performance-auditor@wwsxdc.github.io`).

## Автоматический smoke

```bash
npm run build:firefox
HEADLESS=1 npm run test:e2e:firefox
```

`e2e/firefox.mjs` использует Selenium + geckodriver:

1. устанавливает `dist-firefox/` как временное дополнение через WebDriver;
2. находит UUID в `prefs.js` профиля;
3. открывает панель как настоящую вкладку `moz-extension://<uuid>/...` из
   привилегированного Marionette chrome-контекста (`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`);
4. прогоняет старт аудита, LCP/CLS/INP/FCP/TTFB, атрибуцию, оверлей,
   эксперимент с блокировкой `blocked.test`, очистку DNR, экспорт JSON/Markdown,
   p75 и остановку сессии.

Навигация WebDriver на `moz-extension://` запрещена и в classic, и в BiDi
режиме, поэтому панель открывается через `gBrowser.addTab` с системным
principal. Переменные `WPA_FIREFOX_PATH`, `WPA_GECKODRIVER_PATH` и
`WPA_GECKODRIVER_VERSION` переопределяют бинарники; без них Firefox ищется в
стандартных путях, а geckodriver скачивается в кэш.

В CI job `firefox` устанавливает Firefox, собирает `dist-firefox/` и запускает
этот smoke в headless-режиме.

## Отличия от Chrome

| Chrome | Firefox |
| --- | --- |
| `side_panel` + `chrome.sidePanel` | `sidebar_action` + `browser.sidebarAction` |
| Service worker | Event page (`background.scripts`, `type: "module"`) |
| Клик по иконке открывает Side Panel | Клик по иконке открывает/закрывает боковую панель |
| `chrome.*` | `browser.*` (promise-based); используется ленивый прокси |

`src/browser/api.ts` при каждом обращении выбирает `globalThis.browser` (если
он есть), иначе `globalThis.chrome`. Поэтому один и тот же код работает в
Chrome, Firefox и unit-тестах, где `chrome` подменяется моком. Типы остаются
из `@types/chrome`; импорт называется `extensionApi`, чтобы не затенять
type-namespace `chrome.*`.

Firefox-ветка `configurePrimarySurface()` в `src/background/index.ts`:

- если есть `sidePanel` — используется Side Panel (Chrome);
- иначе, если есть `sidebarAction` — регистрируется `action.onClicked` и
  вызывается `sidebarAction.toggle()` (с fallback на `isOpen()` +
  `open()`/`close()`);
- иначе — popup fallback.

`runtime.onSuspend` в Firefox не используется и вызывается через optional
chaining.

## Требования и разрешения

- Firefox 142+ (`strict_min_version`): нужны MAIN-world инжекция через
  `scripting.executeScript`/`registerContentScripts`, `sidebar_action` в MV3,
  session DNR-правила и `data_collection_permissions` в манифесте.
- Разрешения: `storage`, `activeTab`, `scripting`, `webNavigation`,
  `declarativeNetRequest`, host permissions `http://*/*` и `https://*/*`.
  `tabs` не запрашивается: `tabId` приходит из `webNavigation`/`scripting`,
  а URL доступен через host permissions.
- `sidePanel` в Firefox-манифест не попадает.
- `browser_specific_settings.gecko.data_collection_permissions.required` =
  `["none"]`: расширение не отправляет данные.

## Ограничения

- Автоматический smoke покрывает основные сценарии, но не заменяет ручную
  проверку открытия/закрытия боковой панели кнопкой на панели инструментов и
  журнала диагностики. Полный чек-лист и статус прогонов — в
  [`docs/qa/firefox-matrix.md`](qa/firefox-matrix.md).
- Боковая панель уже Side Panel; на узкой ширине интерфейс переносится по
  правилам адаптивной вёрстки.
- Поведение `declarativeNetRequest` и кэша может отличаться от Chrome, поэтому
  сравнение эксперимента остаётся измерением, а не гарантией.
- Профили Chrome и Firefox независимы: история и настройки не синхронизируются.
- Неподписанный `dist-firefox/` и Firefox-zip загружаются только как временное
  дополнение до подписи Mozilla.
