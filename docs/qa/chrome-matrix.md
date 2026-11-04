# QA-матрица Chrome (P2.2)

Дата: 2026-11-04

## Окружение

| Параметр | Значение |
| --- | --- |
| ОС | Windows 11 |
| Автоматические прогоны | Chrome for Testing 155.0.8059.79 (headless) |
| Сборка | `dist/` из `main`, `v0.1.0` |
| E2E | `HEADLESS=1 npm run test:e2e` — 41/41 PASS |
| Accessibility | `HEADLESS=1 npm run a11y` — 12/12 PASS |
| Release | `npm run package` + `npm run verify:release` — PASS |

Chrome stable 156.0.8078.76 установлен, но начиная с Chrome 137 брендовая
сборка игнорирует `--load-extension`, поэтому автоматизированная матрица
выполняется на Chrome for Testing (тот же Chromium/MV3). Установка
release-артефакта проверяется `verify:release`: zip распаковывается, грузится
как unpacked-расширение, side panel рендерится. Ручная установка zip в
стабильном Chrome через `chrome://extensions` остаётся шагом релиз-процесса
(см. `RELEASE_REPORT.md`).

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
| permission-denied | Ветка `handleSessionStart` → `permission-denied` + `ErrorView`; покрыта code review, автоматического сценария нет (требует отзыва host-permission) | Проверено кодом |
| `chrome://` и PDF | `UNSUPPORTED_START`, `UNSUPPORTED_STATUS`, `UNSUPPORTED_RETRY_VISIBLE` | PASS |
| Эксперимент с DNR и отмена | `EXPERIMENT_START`, `EXPERIMENT_DNR_RULES`, `EXPERIMENT_FINISH`, `DNR_CLEANUP`; отмена — unit-тесты `ExperimentManager` | PASS |
| Service worker restart | Unit-тесты `restores an active session after a service worker restart`, `keeps a restored experiment gate after a service worker restart`, `interrupts a restored session...` | PASS |
| Удаление целевого элемента | `STALE_TARGET`, `REPLACED_TARGET`, `MOVED_TARGET` | PASS |
| Экспорт JSON/Markdown | `EXPORT_JSON`, `EXPORT_MARKDOWN`; проверка отсутствия `token=secret` | PASS |
| Очистка истории | `CLEAR_HISTORY`, `HISTORY_CLEAR_OVERLAYS`, `AFTER_CLEAR` | PASS |
| Установка из артефакта | `npm run verify:release` | PASS |

## Устойчивость UI (P2.1)

| Ситуация | Поведение | Проверка |
| --- | --- | --- |
| Ошибка React-компонента | Error Boundary показывает «Интерфейс столкнулся с ошибкой» и кнопку перезагрузки, панель не белеет | `ErrorBoundary.test.tsx` |
| Ошибка попадает в журнал | `LOG_DIAGNOSTIC` → `logDiagnostic`, только message/component stack, без DOM и URL | unit-тест + code review |
| Service worker остановлен | `restore()` восстанавливает активную сессию/эксперимент; поздние сообщения отбрасываются по токену | unit-тесты restore |
| Потеря соединения с runtime | `sendRuntimeMessage` reject перехватывается, показывается ошибка старта/действия; `GET_STATE` с ошибкой больше не маскируется пустым состоянием | code review |
| permission-denied | `ErrorView` с объяснением и предложением проверить разрешения | code review |
| unsupported page | `ErrorView`, кнопка «Аудит» остаётся доступной | E2E |
| Повреждённая запись IndexedDB | `getState` перехватывает ошибку чтения, отдаёт остальное состояние и текст ошибки | unit-тест `keeps the app state usable...` |
| Несовместимая `schemaVersion` | Записи не читаются и удаляются retention-очисткой | unit-тесты storage |

## Ограничения матрицы

- Нет автоматического сценария permission-denied: Chrome не позволяет
  отозвать обязательный host-permission во время теста. Ветка покрыта
  чтением кода и `ErrorView`.
- Нет ручного screen-reader прогона (NVDA/VoiceOver); labels проверены
  axe-core, keyboard-сценарий автоматизирован.
- PDF-просмотрщик проверен как недоступный URL (`chrome-extension://...`);
  поведение встроенного PDF-viewer зависит от версии Chrome.
