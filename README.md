# FB Ad Library Scraper

Расширение для сбора и разбора объявлений из **Facebook Ad Library** —
для конкурентного анализа. Работает полностью локально (никаких серверов,
никаких внешних зависимостей), под Chrome (MV3) и Safari (macOS).

## Что умеет

- **Сбор** объявлений со страницы Ad Library: автоскролл + съём DOM
  (основной источник) и перехват ответов FB `/api/graphql` (обогащение).
- **Дедуп и слияние** по `ad_archive_id` в service-worker.
- **Аналитика**: активные/неактивные, первая/последняя дата, топ по
  долгожительству, частоты доменов/CTA/платформ/медиа/языков, агрегаты
  охвата по ЕС.
- **Экспорт**: JSON, CSV, список URL медиа и **ZIP-архив с реальными файлами
  креативов** (картинки + HD-видео + `ads.json` + `ads.csv` + `manifest.txt`).
- **Устойчивость к лимитам**: консервативные задержки и режим
  «пауза-и-продолжить» при детекте блокировки вместо мгновенной остановки.

## Архитектура

```
manifest.json            Chrome MV3 манифест (корень).
safari/                  Safari-оверлей: свой manifest + build.sh + README.
src/
  interceptor.js         MAIN-world: патчит fetch/XHR, шлёт сырой graphql в isolated.
  content-script.js      ISOLATED-world: автоскролл, съём DOM, drill-in, батчи в SW.
  service-worker.js      Фон: дедуп/слияние по ad_archive_id, сводка, storage.local.
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
run-tests.sh             Прогон тестов + статические проверки.
```

Нормализованная модель объявления: `ad_archive_id, ad_status, start_date,
end_date, days_running, headline, body_text, link_url, landing_domain,
cta_text, publisher_platforms[], images[], videos[], cards[], ad_snapshot_url,
page_id, page_name`. Датасет: `{ meta, summary, ads:[...] }`.

## Установка — Chrome

1. `chrome://extensions` → включить **Режим разработчика**.
2. **Загрузить распакованное расширение** → выбрать корень репозитория.
3. Открыть `https://www.facebook.com/ads/library/…`, нажать на иконку → **Старт**.

Меньше всего риск блокировки — собирать **одного рекламодателя**:
`…/ads/library/?…&view_all_page_id=<ID>` вместо широкого поиска по ключевым словам.

## Установка — Safari (macOS)

См. [safari/README.md](safari/README.md). Кратко: `bash safari/build.sh` →
`xcrun safari-web-extension-converter safari/build …` → Build в Xcode →
включить расширение → «Разрешить неподписанные расширения».

## Тесты

```bash
bash run-tests.sh
```

Прогоняет Node-тесты (zip, buildArchive, analytics+CSV/JSON, ext-api),
`node --check` по всем `src/**/*.js`, валидацию обоих манифестов и проверку,
что вне `ext-api.js` нет прямых обращений к `chrome.*`.

## Чего расширение принципиально НЕ делает

- Не использует официальный Ad Library API (он не отдаёт `ad_delivery_stop_time`
  и `ad_creative_bodies` для коммерческих объявлений и не отдаёт файлы креативов).
- Не собирает spend/impressions/таргетинг для обычных коммерческих объявлений —
  Meta их не публикует.
- Никаких серверов, аккаунтов и внешних зависимостей.
