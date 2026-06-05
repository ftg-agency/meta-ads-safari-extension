#!/usr/bin/env bash
#
# Собирает самодостаточную папку Safari-расширения в dist/safari:
# корневой manifest.json + общий код из src/. Готовый каталог скармливается
# в xcrun safari-web-extension-converter.
#
# Использование (из корня репозитория):
#   bash scripts/build.sh
# затем:
#   xcrun safari-web-extension-converter dist/safari \
#     --app-name "FB Ad Library Scraper" --macos-only
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/safari"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/src" "$OUT/src"
cp "$ROOT/manifest.json" "$OUT/manifest.json"

echo "Safari-расширение собрано: $OUT"
echo "Дальше:"
echo "  xcrun safari-web-extension-converter \"$OUT\" --app-name \"FB Ad Library Scraper\" --macos-only"
