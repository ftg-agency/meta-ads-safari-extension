# TASK.md — спецификация (от которой построен проект)

Этот файл — исходная постановка задачи. Проект построен «с нуля» по ней
(существующего кода не было). Статус по пунктам — в конце файла.

## Контекст

Сбор из Chrome упёрся в лимиты/блокировку Ad Library. Официальный Ad Library
API отвергнут: он не отдаёт `ad_delivery_stop_time` и `ad_creative_bodies` для
коммерческих объявлений (теряются долгожительство и тексты офферов), не отдаёт
файлы креативов (только `ad_snapshot_url`) и требует верифицированный токен.
Поэтому скрейпинг остаётся; мы (1) укрепляемся против лимитов, (2) портируем на
Safari, (3) добавляем ZIP-архив креативов.

## Решения (зафиксированы)

- Safari: только macOS (без iOS). Распространение: локально, без подписи.
- Подбор страниц — вне расширения.
- Лимиты: только поведенческие правки (без оффлоада на API).
- ZIP: картинки + HD-видео + `ads.json` + `ads.csv` (+ `manifest.txt`).
- ZIP-энкодер: свой, метод STORE (без сжатия) — медиа уже сжаты, нулевые
  зависимости, работает офлайн под строгим CSP. Без fflate/jszip.

## Workstream A — ZIP-архив креативов

- `src/lib/zip.js` — STORE-энкодер + CRC-32 (0xEDB88320), UTF-8-флаг,
  `self.FBALS_Zip = { createZip }` + `module.exports`.
- `buildArchive(dataset, opts)` в `exporter.js` — лучший URL на ассет, дедуп,
  загрузка байтов (ограниченный параллелизм, try/catch на файл), записи
  `images/NNN-<id>.jpg`, `videos/NNN-<id>.mp4`, `ads.json`, `ads.csv`,
  `manifest.txt`; лимиты `maxFiles`/`maxTotalBytes`; колбэк прогресса.
- popup: кнопка «Скачать архив (ZIP)», включается на `hasData`,
  подтверждение при больших объёмах.

## Workstream B — совместимость с Safari

- `src/lib/ext-api.js` — обёртка `chrome.*`/`browser.*` → промисы; `downloadBlob`
  через `createObjectURL` + `<a download>`; `registerMainWorld()` (Safari —
  runtime-регистрация MAIN-world, Chrome — no-op).
- Замена прямых `chrome.*` на `ExtApi.*` в SW/content/popup/exporter.
- `safari/manifest.json` — `background.scripts` + `persistent:false`, без
  декларативного `world:"MAIN"`.
- `safari/README.md` — шаги `safari-web-extension-converter` и запуска.

## Workstream C — устойчивость к лимитам

- Консервативные дефолты (`drillEu:false`, бо́льшие задержки, выше `idleRounds`).
- Бэкофф-и-резюм вместо мгновенной остановки (эскалация 30с/2м/5м,
  ограниченные попытки), статус «пауза (лимит), повтор через Xс».
- Троттлинг drill-in (бюджет запросов/мин + мин-интервал).
- Подсказка в popup про `view_all_page_id`.

## Verify

Node-тесты (`test/`, без зависимостей) + `run-tests.sh`: zip; buildArchive
(стаб fetch, один отказ); analytics + buildJSON/CSV; ext-api (callback/promise);
`node --check` по `src/**/*.js`; валидация манифестов; отсутствие `chrome.*`
вне `ext-api.js`.

## Не в объёме

iOS, подпись/App Store, официальный API, spend/impressions/таргетинг.
