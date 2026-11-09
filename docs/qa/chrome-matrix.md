# QA-матрица Chrome (P2.2)

Дата: 2026-11-09

## Окружение

| Параметр | Значение |
| --- | --- |
| ОС | Windows 11 |
| Автоматические прогоны | Chrome for Testing 155.0.8059.79 (headless) |
| Сборка | `dist/` из `main`, `v0.3.0` |
| E2E | `HEADLESS=1 npm run e2e` — 47/47 PASS |
| Accessibility | `HEADLESS=1 npm run a11y` — 23/23 PASS |
| Performance | `HEADLESS=1 npm run bench` — PASS (+8,5 % TaskDuration, +0,31 МБ heap) |
| Release | `npm run package` + `npm run verify:release` — PASS |

Chrome stable 156.0.8078.76 установлен, но начиная с Chrome 137 брендовая
сборка игнорирует `--load-extension`, поэтому автоматизированная матрица
выполняется на Chrome for Testing (тот же Chromium/MV3). Установка
release-артефакта проверяется `verify:release`: zip распаковывается, грузится
как unpacked-расширение, side panel рендерится. Ручная установка zip в
стабильном Chrome через `chrome://extensions` остаётся шагом релиз-процесса
(см. `docs/releases/v0.3.0.md`).

## Функциональная матрица

| Сценарий | Как проверено | Результат |
| --- | --- | --- |
| Обычная страница | `SESSION_START`, `METRIC_NAMES`, `ATTRIBUTION`, `LONG_TASK_EVENT`, `INP_MEASURED` | PASS |
| SPA `pushState` | `SPA_NAVIGATION`, `SPA_NAVIGATION_EVENT` | PASS |
| SPA `popstate` | `SPA_POPSTATE` | PASS |
| Полная перезагрузка / same-URL reload | `DOCUMENT_NAVIGATION`, `BLOCKED_AFTER_RELOAD`, unit-тесты document token | PASS |
| In-tab navigation без новой сессии | `DOCUMENT_NAVIGATION` + `SPA_*`: сессия остаётся одна, добавляются сегменты | PASS |
| Side Panel API | Все E2E-проверки выполняются в side panel | PASS |
| popup fallback | `AXE popup` в a11y-гейте | PASS |
| permission-denied | `startAudit` + unit-тесты `start-audit.test.ts`: сессия завершается `error`, статус `permission-denied`, ошибка показывается через `ErrorView` | PASS (unit) |
| `chrome://` и PDF | `UNSUPPORTED_START`, `UNSUPPORTED_STATUS`, `UNSUPPORTED_RETRY_VISIBLE` | PASS |
| Эксперимент с DNR и отмена | `EXPERIMENT_START`, `EXPERIMENT_DNR_RULES`, `EXPERIMENT_FINISH`, `DNR_CLEANUP`; отмена — unit-тесты `ExperimentManager` | PASS |
| Импорт JSON | `IMPORT_JSON`: новые id, `origin: "imported"`, переназначение ссылок, `active` → `interrupted`, running-эксперимент → `incomplete` без DNR; unit-тесты `report-import.test.ts`, `import-storage.test.ts` | PASS |
| Повторный импорт | `IMPORT_DUPLICATE`: тот же `session.id` + `generatedAt` отклоняется, история не дублируется | PASS |
| История сессий | `SESSION_LIST_IMPORTED`, `IMPORT_HISTORY_UI`, `SELECT_IMPORTED_SESSION`, `DELETE_IMPORTED_SESSION` | PASS |
| Silent `buffered` | Probe `buffered-probe.test.ts` + событие `collector-limitation` (`buffered-unavailable`) | PASS (unit) |
| Service worker restart | Unit-тесты `restores an active session after a service worker restart`, `keeps a restored experiment gate after a service worker restart`, `interrupts a restored session...` | PASS |
| Удаление целевого элемента | `STALE_TARGET`, `REPLACED_TARGET`, `MOVED_TARGET` | PASS |
| Экспорт JSON/Markdown | `EXPORT_JSON`, `EXPORT_MARKDOWN`; проверка отсутствия `token=secret` | PASS |
| Очистка истории | `CLEAR_HISTORY`, `HISTORY_CLEAR_OVERLAYS`, `AFTER_CLEAR` | PASS |
| Импорт и a11y | `AXE side panel: предпросмотр импорта`, `AXE side panel: импортированная сессия в истории` | PASS |
| Установка из артефакта | `npm run verify:release` | PASS |

## Устойчивость UI (P2.1)

| Ситуация | Поведение | Проверка |
| --- | --- | --- |
| Ошибка React-компонента | Error Boundary показывает «Интерфейс столкнулся с ошибкой» и кнопку перезагрузки, панель не белеет | `ErrorBoundary.test.tsx` |
| Ошибка попадает в журнал | `LOG_DIAGNOSTIC` → `logDiagnostic`, только message/component stack, без DOM и URL | unit-тест + code review |
| Service worker остановлен | `restore()` восстанавливает активную сессию/эксперимент; поздние сообщения отбрасываются по токену | unit-тесты restore |
| Потеря соединения с runtime | `sendRuntimeMessage` reject перехватывается, показывается ошибка старта/действия; `GET_STATE` с ошибкой больше не маскируется пустым состоянием | code review |
| permission-denied | `ErrorView` с объяснением и предложением проверить разрешения | unit-тест `start-audit.test.ts` + code review |
| unsupported page | `ErrorView`, кнопка «Аудит» остаётся доступной | E2E |
| Повреждённая запись IndexedDB | `getState` перехватывает ошибку чтения, отдаёт остальное состояние и текст ошибки | unit-тест `keeps the app state usable...` |
| Старая `schemaVersion` (v1) | Запись мигрирует при чтении и записывается обратно; конкурентная запись не перезаписывается старым снапшотом | unit-тесты `migrations.test.ts`, `storage.test.ts` |
| Неизвестная/будущая `schemaVersion` | Записи не читаются и удаляются retention-очисткой | unit-тесты storage |

## Ограничения матрицы

- Permission-denied проверяется unit-тестом `startAudit`, а не отзывом
  host-permission в живом Chrome: браузер не позволяет отозвать обязательное
  разрешение во время автоматического прогона. UI-ветка дополнительно
  покрыта axe-состоянием «ошибка неподдерживаемой страницы» и code review.
- Нет ручного screen-reader прогона (NVDA/VoiceOver); labels проверены
  axe-core, keyboard-сценарий (фокус по всем вкладкам + стрелки) автоматизирован.
- PDF-просмотрщик проверен как недоступный URL (`chrome-extension://...`);
  поведение встроенного PDF-viewer зависит от версии Chrome.
