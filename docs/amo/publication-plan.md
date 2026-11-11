# План публикации в Mozilla Add-ons

Дата: 2026-11-11  
Целевая версия: `0.4.1`  
Статус: подготовка к первой подаче

## Решения

- AMO-аккаунт создан, 2FA включена.
- Листинг двуязычный: английский и русский.
- Privacy policy публикуется через GitHub Pages из каталога `site/`.
- Скриншоты собираются автоматически из реальной сборки и утверждаются до подачи.
- Первая версия в AMO — `0.4.1` (в `0.4.0` остаётся GitHub-релизом).

## Фазы

### 0. Базовая линия

- [x] `npm run verify`
- [x] Chrome E2E (48/48)
- [x] Firefox smoke (16/16)
- [x] `web-ext lint` (0 ошибок, 2 предупреждения `UNSAFE_VAR_ASSIGNMENT`)
- [x] Воспроизводимые zip и SHA-256

### 1. Манифест и разрешения

- [x] Убрано разрешение `tabs`: `tabId` приходит из `webNavigation`/`scripting`,
      URL доступен через host permissions. Chrome E2E и Firefox smoke проходят.
- [x] `data_collection_permissions.required` = `["none"]`.
- [x] `browser_specific_settings.gecko.id` зафиксирован:
      `web-performance-auditor@wwsxdc.github.io`.
- [x] Chrome-only поля не попадают в Firefox-манифест (проверяет
      `scripts/build-firefox.mjs`).
- [ ] Подтвердить `strict_min_version: 142.0` на чистом профиле Firefox 142.

### 2. Листинг

- [x] Тексты EN/RU: `docs/amo/listing.md`.
- [ ] Скриншоты 1280×800: `docs/amo/screenshots/`.
- [ ] Утвердить скриншоты и тексты.

### 3. Privacy policy и данные

- [x] Публичная страница: `site/privacy.html` (EN + RU).
- [ ] Включить GitHub Pages и проверить URL
      `https://wwsxdc.github.io/web-performance-auditor/privacy.html`.
- [ ] В AMO указать data collection: none.

### 4. Source-code submission

- [x] `scripts/package-source.mjs` — source zip без `node_modules`, `dist`,
      `release`, `public/generated` и внутренних документов.
- [x] `docs/amo/build-instructions.md` — инструкции для ревьюера на английском.
- [ ] Проверить сборку из source zip на чистой машине/CI.

### 5. Preflight

- [ ] `npm run verify`
- [ ] `npm run test:e2e:firefox`
- [ ] `npm run lint:firefox`
- [ ] `npm run package`
- [ ] `npm run verify:release`
- [ ] `npm run package:source`
- [ ] Опционально: unlisted-подпись и установка XPI в стабильный Firefox.

### 6. Подача

- [ ] Загрузить Firefox zip в Dev Hub.
- [ ] Выбрать listed on AMO.
- [ ] Заполнить листинг, privacy policy, обоснование разрешений.
- [ ] Приложить source zip и build instructions.
- [ ] Добавить notes to reviewer: `docs/amo/reviewer-notes.md`.
- [ ] Ответить на замечания ревьюера.

### 7. После публикации

- [ ] Добавить AMO-ссылку и бейдж в `README.md`.
- [ ] Обновить `docs/firefox.md` постоянной установкой.
- [ ] Зафиксировать URL листинга и версию.
- [ ] Для обновлений: bump версии, changelog, verify, zip, source zip, Dev Hub.

## Риски

| Риск | Митигация |
| --- | --- |
| Широкие host permissions | Обоснование в reviewer notes и privacy policy |
| 2 предупреждения `innerHTML` | Пояснение: React internals, пользовательский HTML не исполняется |
| Ревью source-сборки | EN-инструкции, lockfile, проверка с чистого клона |
| CRXJS beta | Сравнение manifest и списка файлов, а не байтов |
| Задержка ревью | Подача заранее, без привязки к дате |

## Критерии готовности к подаче

- [ ] Все проверки и E2E зелёные.
- [ ] Скриншоты и тексты утверждены.
- [ ] Privacy policy доступна по публичному URL.
- [ ] Source zip собирается в рабочий `dist-firefox/`.
- [ ] Версия `0.4.1` совпадает в `package.json`, `manifest.json`,
      `manifest.firefox.json`.
