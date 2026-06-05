#!/usr/bin/env bash
#
# ЛОКАЛЬНАЯ упаковка Safari-расширения в подписанный нотаризованный DMG
# для раздачи ВНЕ App Store (открыл .dmg → перетащил .app в Applications →
# запустил → включил в Настройках Safari, без «Разрешить неподписанные»).
#
# В CI этот шаг делает .github/workflows/build-dmg.yml — здесь то же самое
# для ручной сборки на своём Mac.
#
# ВАЖНО:
#   - macOS-only. Нужен Xcode + сертификат «Developer ID Application».
#   - Перед этим шагом нужно один раз вручную сконвертировать и собрать .app:
#       bash scripts/build.sh
#       xcrun safari-web-extension-converter dist/safari \
#         --app-name "FB Ad Library Scraper" --macos-only
#       # → собрать в Xcode (Product → Archive → Distribute → Developer ID,
#       #   либо xcodebuild) и получить готовый подписанный .app.
#     Этот ручной шаг описан в docs/DMG-RELEASE.md.
#   - Нотаризация по умолчанию через keychain-профиль notarytool (создаётся раз):
#       xcrun notarytool store-credentials "$NOTARY_PROFILE" \
#         --apple-id <you@apple.id> --team-id <TEAM_ID> --password <app-spec-pwd>
#     Либо задай APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD в окружении.
#
set -euo pipefail

# --- настройки (правь под себя) ---------------------------------------------
APP_NAME="FB Ad Library Scraper"         # имя .app (без расширения)
SIGN_IDENTITY="Developer ID Application" # codesign identity (можно полное имя/хеш)
TEAM_ID="${APPLE_TEAM_ID:-XXXXXXXXXX}"   # Apple Developer Team ID
NOTARY_PROFILE="${NOTARY_PROFILE:-ftg-notary}" # keychain-профиль для notarytool

# Путь к собранному в Xcode .app (переопредели через APP_PATH=... bash …)
APP_PATH="${APP_PATH:-dist/${APP_NAME}.app}"
# ----------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DMG_PATH="dist/${APP_NAME// /-}.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Не найден .app: $APP_PATH" >&2
  echo "Сначала собери .app (см. docs/DMG-RELEASE.md)." >&2
  exit 1
fi

echo "== 1/4 codesign (Developer ID, hardened runtime) =="
codesign --force --deep --options runtime --timestamp \
  --sign "$SIGN_IDENTITY" "$APP_PATH"
codesign --verify --strict --verbose=2 "$APP_PATH"

echo "== 2/4 сборка DMG =="
bash scripts/make-dmg.sh "$APP_PATH" "$DMG_PATH" "$APP_NAME"

echo "== 3/4 нотаризация DMG (xcrun notarytool) =="
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$TEAM_ID" \
    --wait
else
  xcrun notarytool submit "$DMG_PATH" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait
fi

echo "== 4/4 staple =="
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "Готово: $DMG_PATH (подписан + нотаризован + застейплен)"
