#!/usr/bin/env bash
#
# Упаковка Safari-расширения в подписанный нотаризованный DMG для раздачи
# ВНЕ App Store (открыл .dmg → перетащил .app в Applications → запустил →
# включил в Настройках Safari, без «Разрешить неподписанные расширения»).
#
# ВАЖНО:
#   - macOS-only. Нужен Xcode + сертификаты Apple Developer.
#   - Перед этим шагом нужно один раз вручную сконвертировать и собрать .app:
#       bash scripts/build.sh
#       xcrun safari-web-extension-converter dist/safari \
#         --app-name "FB Ad Library Scraper" --macos-only
#       # → собрать в Xcode (Product → Archive / Build), получить готовый .app.
#     Этот ручной шаг описан в README.
#   - codesign выполняется с identity «Developer ID Application» (не App Store).
#   - Нотаризация идёт через keychain-профиль notarytool (создаётся один раз:
#       xcrun notarytool store-credentials "$NOTARY_PROFILE" \
#         --apple-id <you@apple.id> --team-id <TEAM_ID> --password <app-spec-pwd>)
#
set -euo pipefail

# --- настройки (правь под себя) ---------------------------------------------
APP_NAME="FB Ad Library Scraper"        # имя .app (без расширения)
SIGN_IDENTITY="Developer ID Application" # codesign identity (можно полное имя/хеш)
TEAM_ID="XXXXXXXXXX"                     # Apple Developer Team ID
NOTARY_PROFILE="ftg-notary"             # keychain-профиль для notarytool

# Путь к собранному в Xcode .app (переопредели через APP_PATH=... bash …)
APP_PATH="${APP_PATH:-dist/${APP_NAME}.app}"
# ----------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="dist"
DMG_PATH="${OUT_DIR}/${APP_NAME// /-}.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Не найден .app: $APP_PATH" >&2
  echo "Сначала собери .app (см. комментарий вверху скрипта и README)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "== 1/4 codesign (Developer ID, hardened runtime) =="
codesign --force --deep --options runtime --timestamp \
  --sign "$SIGN_IDENTITY" "$APP_PATH"
codesign --verify --strict --verbose=2 "$APP_PATH"

echo "== 2/4 сборка DMG =="
rm -f "$DMG_PATH"
if command -v create-dmg >/dev/null 2>&1; then
  # create-dmg сам делает красивое окно с ярлыком Applications.
  create-dmg \
    --volname "$APP_NAME" \
    --app-drop-link 480 200 \
    "$DMG_PATH" "$APP_PATH"
else
  # Фолбэк без create-dmg: staging + ярлык Applications + hdiutil.
  STAGING="$(mktemp -d)"
  cp -R "$APP_PATH" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" \
    -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGING"
fi

echo "== 3/4 нотаризация DMG (xcrun notarytool) =="
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --team-id "$TEAM_ID" \
  --wait

echo "== 4/4 staple =="
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "Готово: $DMG_PATH (подписан + нотаризован + застейплен)"
