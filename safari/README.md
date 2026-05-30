# Safari (macOS) — сборка и запуск

Safari использует тот же код (`../src`), но другой манифест: фон через
`background.scripts` (не `service_worker`), без декларативного `world:"MAIN"` —
перехватчик регистрируется во время выполнения из service-worker
(`ExtApi.registerMainWorld()`).

> Эти шаги выполняются **только на Mac** и здесь не автоматизируются.
> Весь код, включая Safari, написан и проверен (Node-тесты + `node --check`),
> но сборка Xcode/запуск в браузере — ручной шаг.

## 1. Собрать папку расширения

Из корня репозитория:

```bash
bash safari/build.sh
```

Создаст `safari/build/` (общий `src/` + `safari/manifest.json`).

## 2. Сконвертировать в проект Xcode

```bash
xcrun safari-web-extension-converter safari/build \
  --app-name "FB Ad Library Scraper" --macos-only
```

Откроется проект Xcode (только macOS, без iOS).

## 3. Собрать и запустить

1. В Xcode нажмите **Build** (⌘B), затем **Run** (⌘R) — поднимется хост-приложение.
2. Safari → **Настройки** → **Расширения** → включите «FB Ad Library Scraper».
3. Safari → меню **Разработка** → **«Разрешить неподписанные расширения»**.
   ⚠️ Сбрасывается при каждом перезапуске Safari — включайте заново.
   (Если меню «Разработка» нет: Настройки → Дополнения → «Показывать меню
   "Разработка"».)
4. Откройте `https://www.facebook.com/ads/library/` — Safari спросит разрешение
   на доступ к сайту при первом использовании; разрешите «Всегда».

## Особенности Safari

- **MAIN-world / `document_start`.** Декларативный `world:"MAIN"` Safari
  игнорирует, поэтому перехватчик `fetch`/XHR регистрируется программно
  (`scripting.registerContentScripts({ world: "MAIN", runAt: "document_start" })`,
  с фолбэком на `executeScript`). На очень ранней загрузке перехват graphql
  иногда не успевает встать («Preload Top Hit» и т.п.) — следите за этим.
- **DOM-скрейпинг работает в любом случае.** Даже если перехват graphql
  нестабилен, основной сбор идёт из DOM (`dom-scraper.js`), поэтому данные
  собираются и без интерсепта (graphql — обогащение).
- **Скачивание.** Используется `URL.createObjectURL` + `<a download>`
  (`ExtApi.downloadBlob`), без `chrome.downloads` — работает в Safari.
- **Подпись.** Распространение локальное и неподписанное; аккаунт Apple
  Developer не требуется (но «Разрешить неподписанные расширения» — каждый
  запуск Safari).
