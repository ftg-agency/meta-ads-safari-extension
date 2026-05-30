#!/usr/bin/env bash
#
# Собирает самодостаточную папку Safari-расширения в safari/build:
# общий код из ../src + safari/manifest.json. Единый источник правды — корневой
# src/, поэтому Safari-манифест держится отдельным «оверлеем».
#
# Использование (из корня репозитория):
#   bash safari/build.sh
# затем:
#   xcrun safari-web-extension-converter safari/build \
#     --app-name "FB Ad Library Scraper" --macos-only
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/safari/build"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/src" "$OUT/src"
cp "$ROOT/safari/manifest.json" "$OUT/manifest.json"

echo "Safari-расширение собрано: $OUT"
echo "Дальше:"
echo "  xcrun safari-web-extension-converter \"$OUT\" --app-name \"FB Ad Library Scraper\" --macos-only"
