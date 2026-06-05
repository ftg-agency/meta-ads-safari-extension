# Сборка и релиз DMG (Safari extension)

Полная инструкция: как получить **подписанный, нотаризованный DMG** с
расширением, и как настроить, чтобы при пуше тега `vX.Y.Z` на GitHub
автоматически собирался новый DMG и прикреплялся к Release.

Конечный пользователь получает: открыл `.dmg` → перетащил `.app` в
**Applications** → запустил → включил расширение в **Настройках Safari**.
Никаких «Разрешить неподписанные расширения».

---

## 0. Что и почему

Safari-расширение нельзя собрать «просто из JS». Apple требует обернуть его в
нативное приложение-хост:

```
src/ + manifest.json
   └─ scripts/build.sh ──────────► dist/safari/            (папка веб-расширения)
        └─ safari-web-extension-converter ──► проект Xcode  (нативная обёртка)
             └─ xcodebuild (Release, Developer ID) ──► .app (подписан)
                  └─ make-dmg.sh ──► .dmg
                       └─ notarytool submit + stapler staple ──► готовый DMG
```

Всё это **macOS-only** и требует Xcode. Поэтому CI крутится на `macos-14`
раннере GitHub Actions.

Требования к аккаунту Apple:
- членство в **Apple Developer Program** (99 $/год);
- сертификат **Developer ID Application** (для распространения вне App Store);
- **app-specific password** для нотаризации.

---

## 1. Одноразовая подготовка

### 1.1. Сертификат «Developer ID Application»

Если его ещё нет:

1. Xcode → **Settings → Accounts** → выбери команду → **Manage Certificates…**
   → **+** → **Developer ID Application**.
   (Или вручную на https://developer.apple.com/account/resources/certificates.)
2. Проверь, что он в связке ключей:
   ```bash
   security find-identity -v -p codesigning
   # должна быть строка: "Developer ID Application: <Name> (TEAMID)"
   ```

### 1.2. Узнать Team ID

```bash
# из identity выше — в скобках. Либо:
# https://developer.apple.com/account → Membership details → Team ID (10 символов)
```

### 1.3. App-specific password (для нотаризации)

1. https://account.apple.com → **Sign-In and Security → App-Specific Passwords**
   → **+** → назови, например, `notarytool-ci`.
2. Скопируй пароль вида `abcd-efgh-ijkl-mnop` — он показывается один раз.

### 1.4. Reverse-DNS bundle identifier

Выбери стабильный идентификатор, например `agency.ftg.fb-ad-library-scraper`.
Он прописан в `.github/workflows/build-dmg.yml` (env `APP_BUNDLE_ID`) и в
команде конвертера. **Поменяй на свой и больше не меняй** (иначе для юзеров это
будет «другое» приложение).

---

## 2. Локальная сборка DMG (на своём Mac)

Удобно для проверки до того, как доверять CI.

```bash
# 1. Папка веб-расширения
bash scripts/build.sh                       # → dist/safari/

# 2. Конвертация в проект Xcode (ОДИН раз; дальше можно переоткрывать)
xcrun safari-web-extension-converter dist/safari \
  --app-name "FB Ad Library Scraper" \
  --bundle-identifier "agency.ftg.fb-ad-library-scraper" \
  --macos-only

# 3. В Xcode: выбрать схему → Product → Archive →
#    Distribute App → Developer ID → Export.
#    Положить полученный .app в dist/, например dist/FB Ad Library Scraper.app

# 4. Подпись + DMG + нотаризация + staple одним скриптом:
export APPLE_ID="you@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="XXXXXXXXXX"
bash scripts/package-dmg.sh                 # → dist/FB-Ad-Library-Scraper.dmg
```

`package-dmg.sh` сам подпишет `.app` (Developer ID + hardened runtime),
соберёт DMG (`make-dmg.sh`), отправит на нотаризацию и застейплит результат.
Альтернатива app-specific паролю — keychain-профиль notarytool (см. комментарии
вверху скрипта).

Проверка готового DMG (как увидит Gatekeeper у юзера):
```bash
spctl -a -t open --context context:primary-signature -v "dist/FB-Ad-Library-Scraper.dmg"
xcrun stapler validate "dist/FB-Ad-Library-Scraper.dmg"
```

---

## 3. Авто-сборка DMG в GitHub Actions

Workflow: [`.github/workflows/build-dmg.yml`](../.github/workflows/build-dmg.yml).

**Триггеры:**
- push тега вида `v1.2.3` → собирает DMG и **прикрепляет к GitHub Release** этого тега;
- ручной запуск (**Actions → Build Safari DMG → Run workflow**) → DMG как
  artifact прогона (без Release).

### 3.1. Завести секреты репозитория

**Settings → Secrets and variables → Actions → New repository secret.**
Нужны пять секретов:

| Секрет | Что это |
|---|---|
| `MACOS_CERT_P12_BASE64` | сертификат Developer ID Application + приватный ключ в `.p12`, закодированный base64 (см. ниже) |
| `MACOS_CERT_PASSWORD` | пароль, которым защищён `.p12` при экспорте |
| `APPLE_ID` | твой Apple ID (email) |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password из шага 1.3 |
| `APPLE_TEAM_ID` | Team ID (10 символов) из шага 1.2 |

Экспорт сертификата в `.p12` и кодирование в base64:

1. **Keychain Access** → найти «Developer ID Application: …» → раскрыть стрелку,
   выделить **и сертификат, и приватный ключ** → ПКМ → **Export 2 items…** →
   формат **Personal Information Exchange (.p12)** → задать пароль
   (он пойдёт в `MACOS_CERT_PASSWORD`).
2. Перекодировать в одну строку base64:
   ```bash
   base64 -i Certificates.p12 | pbcopy   # содержимое теперь в буфере → вставить в секрет
   ```

### 3.2. Проверить bundle id

В `.github/workflows/build-dmg.yml` env `APP_BUNDLE_ID` должен совпадать с тем,
что используешь локально. Поменяй при необходимости и закоммить.

### 3.3. Выпустить релиз

```bash
# обнови версию в manifest.json (например "version": "1.1.0"), закоммить, затем:
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions:
1. поднимет macOS-раннер, импортирует сертификат во временный keychain;
2. `scripts/build.sh` → конвертер → `xcodebuild` (Release, Developer ID,
   hardened runtime) → подписанный `.app`;
3. `make-dmg.sh` → DMG → `notarytool submit --wait` → `stapler staple`;
4. создаст/обновит **Release** для тега `v1.1.0` и приложит DMG.

Готовый DMG — на странице **Releases**. Нотаризация занимает несколько минут;
весь прогон обычно 10–20 мин.

---

## 4. Траблшутинг

- **`Developer ID Application identity не найдена`** — в `.p12` не попал
  приватный ключ. Экспортируй из Keychain именно пару (сертификат + ключ).
- **`xcodebuild`: схема не найдена / не та** — workflow берёт первую схему
  проекта. Если конвертер создал несколько, открой проект и проверь имя; при
  необходимости захардкодь схему в шаге `xcodebuild`.
- **Нотаризация `Invalid`** — посмотри лог:
  ```bash
  xcrun notarytool log <submission-id> \
    --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```
  Частые причины: не включён hardened runtime, отсутствует secure timestamp,
  неподписанный вложенный `.appex`. Workflow это всё включает — но если правил
  настройки проекта вручную, проверь.
- **Gatekeeper всё равно ругается** — убедись, что `stapler staple` отработал
  по DMG и что `.app` внутри подписан именно **Developer ID Application**
  (не Apple Development / не App Store).
- **`macos-14` дорого/медленно** — поэтому триггер на тег, а не на каждый push.

---

## 5. Где что лежит

| Файл | Роль |
|---|---|
| `scripts/build.sh` | `src/` + `manifest.json` → `dist/safari/` |
| `scripts/make-dmg.sh` | готовый `.app` → `.dmg` (без подписи) |
| `scripts/package-dmg.sh` | локальный полный пайплайн: подпись → DMG → нотаризация → staple |
| `.github/workflows/build-dmg.yml` | то же самое в CI по тегу `v*` |
