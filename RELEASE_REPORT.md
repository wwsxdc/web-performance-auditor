# Web Performance Auditor — отчёт о готовности v0.1.0

Дата: 2026-11-04  
Репозиторий: `https://github.com/wwsxdc/web-performance-auditor`  
Ветка: `main`  
Версия: `0.1.0`

## 1. Краткий итог

Расширение готово к выпуску `v0.1.0`: закрыты P0, P1 и P2, CI зелёный
(verify + E2E + a11y + release), release-артефакт воспроизводим, проверен
SHA-256 и установка из zip. Данные не покидают профиль браузера, известные
ограничения перечислены ниже и не являются P0/P1-дефектами.

## 2. Что сделано

### 2.1. Функциональность и надёжность

- Сбор LCP/CLS/INP/FCP/TTFB с атрибуцией к DOM и диагностическими событиями.
- Документные и SPA-сегменты (pushState/popstate); load-метрики привязаны к
  документу, CLS/INP — к активному сегменту.
- Повторные callback одной метрики консолидируются в экспорте.
- Пакетная запись событий: одна транзакция IndexedDB на пакет, flush на
  stop/navigation/reset/лимит/ошибку; повторная доставка идемпотентна.
- FR-14: структурный якорь цели обнаруживает удаление, замену и перемещение;
  новый узел не подсвечивается автоматически.
- Статус полноты сессии (`full`/`partial`/`limited`) с причинами и временем
  начала наблюдения в UI, JSON и Markdown.
- Storage policy: несовместимые `schemaVersion` не читаются и удаляются при
  retention-очистке; restore не оставляет указатель на удалённую сессию.
- Error Boundary для Side Panel и popup; ошибка компонента не роняет панель и
  попадает в журнал без содержимого страницы.
- Восстановление после перезапуска service worker, grace-таймер навигации,
  проверка полномочий сессии/подсветки/экспериментов.

### 2.2. Качество и безопасность

- 124 unit-теста (включая storage, навигацию, batching, полноту, Error
  Boundary).
- E2E 41/41: метрики, атрибуция, INP, оверлеи, FR-14, навигации, DNR,
  экспорт, очистка истории, отсутствие утечки токена.
- Accessibility-гейт: axe-core по 10 состояниям + keyboard-проверки по всем
  четырём вкладкам, 15/15, 0 serious/critical; контраст, landmarks, accessible
  names исправлены.
- Performance-бенчмарк: TaskDuration +4,9…5,8 % (8–10 мс), heap +0,26…0,35 МБ,
  long tasks 1 → 1; решение по page script зафиксировано.
- Security/privacy review: нет сетевых отправок, `eval`/dynamic code,
  `innerHTML`; границы сообщений и лимиты проверены; `npm audit --omit=dev` —
  0 уязвимостей.
- DNR-правила ограничены вкладкой и доменами, удаление верифицируется.

### 2.3. Release-процесс

- `npm run package` собирает zip из `dist/` с фиксированным mtime и пишет
  SHA-256; повторная сборка из чистого checkout даёт тот же checksum.
- `npm run verify:release` распаковывает zip, загружает расширение в Chrome и
  проверяет рендер Side Panel.
- CI: `verify` → `e2e` (E2E + axe) → `release` (zip + install check +
  artifact).
- Добавлены `CHANGELOG.md`, `SECURITY.md`, QA-матрица, privacy review,
  release notes.

## 3. Проверки

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS, 124 теста |
| `npm run build` | PASS |
| `HEADLESS=1 npm run test:e2e` | PASS, 41/41 |
| `HEADLESS=1 npm run a11y` | PASS, 15/15, 0 serious/critical |
| `npm run bench:collector` | PASS, бюджет соблюдён |
| `npm audit --omit=dev` | 0 уязвимостей |
| `npm run package` | PASS, SHA-256 `b65c8485…b44f8894` |
| Сборка из чистого checkout | PASS, SHA-256 совпадает |
| `npm run verify:release` | PASS |
| CI `41856007621` (`f3bdc09`) | PASS: verify, e2e, release |

## 4. Release-артефакты

- Тег: `v0.1.0`
- GitHub Release: `https://github.com/wwsxdc/web-performance-auditor/releases/tag/v0.1.0`
- Архив: `web-performance-auditor-0.1.0.zip` (258010 байт)
- Checksum: `web-performance-auditor-0.1.0.zip.sha256`
- SHA-256: `b65c84850cc1cab4b7cdd833bcf75cab25cfce8ec55b1f5c036b079bb44f8894`

## 5. Известные ограничения

- Только Chrome/Chromium; Firefox-адаптера и отдельного манифеста нет.
- Импорт ранее экспортированного JSON не реализован.
- Автоматической миграции IndexedDB v1 → v2 нет (осознанно для первого
  релиза); несовместимые записи игнорируются и удаляются.
- Если браузер молча принимает `buffered: true`, но не отдаёт исторические
  записи, ограничение не фиксируется.
- Permission-denied проверен кодом, но не автоматизирован (Chrome не
  позволяет отозвать обязательный host-permission в тесте).
- Ручной screen-reader прогон (NVDA/VoiceOver) не выполнялся; labels и
  keyboard-путь покрыты axe и E2E.
- Автоматизированная QA-матрица выполняется на Chrome for Testing 155;
  брендовая сборка Chrome 137+ игнорирует `--load-extension`. Установка zip
  проверена `verify:release` и описана в release notes.

## 6. Оценка готовности

| Область | Статус |
| --- | --- |
| Пользовательские сценарии | Готово |
| P0/P1/P2 | Готово |
| Unit/E2E/a11y/perf | Готово |
| Security/privacy | Готово |
| Release-артефакт | Готово, воспроизводим |
| CI | Зелёный |
| Публикация | Выполнена |

Итоговая оценка: **production-ready, `v0.1.0` выпущен.**
