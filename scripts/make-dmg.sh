#!/usr/bin/env bash
#
# Чистая упаковка готового .app в .dmg (без подписи и нотаризации).
# Подпись делается заранее (xcodebuild в CI или codesign в package-dmg.sh),
# нотаризация/staple — после этого скрипта.
#
# Использование:
#   bash scripts/make-dmg.sh "<path/to/App.app>" "<path/to/out.dmg>" ["Имя тома"]
#
set -euo pipefail

APP_PATH="${1:?путь к .app не задан}"
DMG_PATH="${2:?путь к выходному .dmg не задан}"
VOL_NAME="${3:-$(basename "$APP_PATH" .app)}"

if [ ! -d "$APP_PATH" ]; then
  echo "Не найден .app: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$DMG_PATH")"
rm -f "$DMG_PATH"

if command -v create-dmg >/dev/null 2>&1; then
  # create-dmg сам рисует окно с ярлыком Applications.
  create-dmg \
    --volname "$VOL_NAME" \
    --app-drop-link 480 200 \
    "$DMG_PATH" "$APP_PATH"
else
  # Фолбэк без create-dmg: staging + ярлык Applications + hdiutil.
  STAGING="$(mktemp -d)"
  cp -R "$APP_PATH" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING" \
    -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGING"
fi

echo "DMG собран: $DMG_PATH"
