# FB Ad Library Scraper — Safari (macOS)

Расширение для сбора и разбора объявлений из **Facebook Ad Library** —
для конкурентного анализа. Работает полностью локально (никаких серверов,
никаких внешних зависимостей), под Safari на macOS.

> `src/` — общий код; при правках синхронизировать со второй репой.

## Что умеет

- **Сбор** объявлений со страницы Ad Library: автоскролл + съём DOM
  (основной источник) и перехват ответов FB `/api/graphql` (обогащение).
- **Дедуп и слияние** по `ad_archive_id` в фоновом скрипте.
- **Аналитика**: активные/неактивные, первая/последняя дата, топ по
  долгожительству, частоты доменов/CTA/платформ/медиа/языков, агрегаты
  охвата по ЕС.
- **Экспорт**: JSON, CSV, список URL медиа и **ZIP-архив с реальными файлами
  креативов** (картинки + HD-видео + `ads.json` + `ads.csv` + `manifest.txt`).
- **Устойчивость к лимитам**: консервативные задержки и режим
  «пауза-и-продолжить» при детекте блокировки вместо мгновенной остановки.

## Архитектура

```
manifest.json            Safari MV3 манифест: фон через background.scripts,
                         без декларативного world:"MAIN".
src/
  interceptor.js         MAIN-world: патчит fetch/XHR, шлёт сырой graphql в isolated.
  content-script.js      ISOLATED-world: автоскролл, съём DOM, drill-in, батчи в фон.
  service-worker.js      Фон: дедуп/слияние по ad_archive_id, сводка, storage.local,
                         runtime-регистрация MAIN-world перехватчика.
  popup.html/.js/.css    UI: запуск/стоп, параметры, экспорт.
  lib/
    ext-api.js           Кросс-браузерная обёртка chrome.* / browser.* → промисы.
    graphql-parser.js    Разбор ответов graphql → нормализованная модель.
    dom-scraper.js       Съём карточек из DOM (основной источник).
    drill-in.js          Открытие модалок (полный текст, охват ЕС) + троттлинг.
    analytics.js         computeSummary() — сводная аналитика (чистый JS).
    exporter.js          buildJSON/CSV/collectMediaUrls/buildArchive (+ скачивание).
    zip.js               Минимальный ZIP-энкодер (STORE, без зависимостей).
test/                    Node-тесты (без зависимостей) + фикстуры.
scripts/build.sh         Сборка папки расширения в dist/safari (manifest + src/).
scripts/make-dmg.sh      Готовый .app → .dmg (без подписи, переиспользуется CI).
scripts/package-dmg.sh   Локально: подпись + DMG + нотаризация + staple.
.github/workflows/       build-dmg.yml — авто-сборка DMG по тегу v* (см. docs/).
docs/DMG-RELEASE.md      Полная инструкция по сборке/релизу DMG.
run-tests.sh             Прогон тестов + статические проверки.
```

Safari использует тот же код (`src/`), но другой манифест: фон через
`background.scripts` (не `service_worker`), без декларативного `world:"MAIN"` —
перехватчик регистрируется во время выполнения из фонового скрипта
(`ExtApi.registerMainWorld()`).

Нормализованная модель объявления: `ad_archive_id, ad_status, start_date,
end_date, days_running, headline, body_text, link_url, landing_domain,
cta_text, publisher_platforms[], images[], videos[], cards[], ad_snapshot_url,
page_id, page_name`. Датасет: `{ meta, summary, ads:[...] }`.

## Сборка и установка (Safari, macOS)

> Эти шаги выполняются **только на Mac**. Нужен **Xcode** и сертификаты
> **Apple Developer**. Весь код проверен (Node-тесты + `node --check`), но
> сборка Xcode/запуск в браузере — ручной шаг.

### 1. Собрать папку расширения

Из корня репозитория:

```bash
bash scripts/build.sh
```

Создаст `dist/safari/` (общий `src/` + корневой `manifest.json`).

### 2. Сконвертировать в проект Xcode

```bash
xcrun safari-web-extension-converter dist/safari \
  --app-name "FB Ad Library Scraper" --macos-only
```

Откроется проект Xcode (только macOS, без iOS). Это **отдельный ручной шаг**.

### 3. Собрать и включить

1. В Xcode нажмите **Build** (⌘B), затем **Run** (⌘R) — поднимется хост-приложение.
2. Safari → **Настройки** → **Расширения** → включите «FB Ad Library Scraper».
3. Откройте `https://www.facebook.com/ads/library/` — Safari спросит разрешение
   на доступ к сайту при первом использовании; разрешите «Всегда».

Меньше всего риск блокировки — собирать **одного рекламодателя**:
`…/ads/library/?…&view_all_page_id=<ID>` вместо широкого поиска по ключевым словам.

## Распространение — подписанный нотаризованный DMG

У нас есть аккаунт **Apple Developer**, поэтому раздаём нормальный
подписанный и нотаризованный DMG — без «Разрешить неподписанные расширения».
Для конечного пользователя это: **открыл `.dmg` → перетащил `.app` в Applications
→ запустил → включил расширение в Настройках Safari**.

**Полная инструкция (локально + авто-сборка в CI):
[docs/DMG-RELEASE.md](docs/DMG-RELEASE.md).**

Кратко:

- **Локально** — `bash scripts/package-dmg.sh`: `codesign` (Developer ID
  Application) → DMG (`scripts/make-dmg.sh`) → `xcrun notarytool submit`
  → `xcrun stapler staple` → готовый `dist/*.dmg`. Перед этим нужно один раз
  сконвертировать и собрать `.app` (см. инструкцию).
- **Автоматически** — пуш тега `vX.Y.Z` запускает
  [`.github/workflows/build-dmg.yml`](.github/workflows/build-dmg.yml) на
  macOS-раннере: сборка → подпись Developer ID → нотаризация → DMG
  прикрепляется к GitHub **Release** этого тега. Нужны секреты репозитория
  (см. инструкцию).

## Особенности Safari

- **MAIN-world / `document_start`.** Декларативный `world:"MAIN"` Safari
  игнорирует, поэтому перехватчик `fetch`/XHR регистрируется программно
  (`scripting.registerContentScripts({ world: "MAIN", runAt: "document_start" })`,
  с фолбэком на `executeScript`). На очень ранней загрузке перехват graphql
  иногда не успевает встать — основной сбор всё равно идёт из DOM.
- **DOM-скрейпинг работает в любом случае.** Даже если перехват graphql
  нестабилен, данные собираются из DOM (`dom-scraper.js`); graphql — обогащение.
- **Скачивание.** Используется `URL.createObjectURL` + `<a download>`
  (`ExtApi.downloadBlob`), без `chrome.downloads` — работает в Safari.

## Тесты

```bash
bash run-tests.sh
```

Прогоняет Node-тесты (zip, buildArchive, analytics+CSV/JSON, ext-api),
`node --check` по всем `src/**/*.js`, валидацию `manifest.json` и проверку,
что вне `ext-api.js` нет прямых обращений к `chrome.*`.

## Чего расширение принципиально НЕ делает

- Не использует официальный Ad Library API (он не отдаёт `ad_delivery_stop_time`
  и `ad_creative_bodies` для коммерческих объявлений и не отдаёт файлы креативов).
- Не собирает spend/impressions/таргетинг для обычных коммерческих объявлений —
  Meta их не публикует.
- Никаких серверов, аккаунтов и внешних зависимостей. iOS не поддерживается.

## Про данные охвата ЕС

Охват ЕС (`eu_total_reach`, разбивка по странам/возрасту/полу, таргетинг,
payer/beneficiary) берётся из перехваченного graphql-ответа `ad_details` —
карточка лишь открывается, чтобы спровоцировать запрос, и сразу закрывается
(тяжёлая таблица не рендерится — нет утечек памяти).

Важно: **сумма разбивки не обязана точно совпадать с общим `eu_total_reach`.**
Meta независимо зашумляет/округляет и общий охват, и каждую ячейку (приватность).
На практике расхождение ~1–6% — это нормально, данные достоверные. Не у всех
объявлений есть раздел ЕС (если рекламодатель не таргетил ЕС — поля пустые).
