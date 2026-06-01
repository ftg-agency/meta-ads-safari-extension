#!/usr/bin/env bash
#
# Прогон проверок без внешних зависимостей (только node + системный unzip).
#   bash run-tests.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
fail=0

echo "== node --check (синтаксис) =="
while IFS= read -r f; do
  if node --check "$f"; then :; else echo "  FAIL $f"; fail=1; fi
done < <(find src test -name '*.js' | sort)
echo "  проверено: $(find src test -name '*.js' | wc -l | tr -d ' ') файлов"

echo "== JSON-манифесты =="
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))" \
  && echo "  ok manifest.json" || { echo "  FAIL manifest.json"; fail=1; }
node -e "JSON.parse(require('fs').readFileSync('safari/manifest.json','utf8'))" \
  && echo "  ok safari/manifest.json" || { echo "  FAIL safari/manifest.json"; fail=1; }

echo "== нет прямых chrome.* вне ext-api.js =="
hits="$(grep -rnE 'chrome\.(runtime|storage|tabs|downloads|scripting|action|i18n|windows|webRequest)' src --include='*.js' | grep -v 'src/lib/ext-api.js' || true)"
if [ -n "$hits" ]; then
  echo "  FAIL — найдены обращения:"; echo "$hits"; fail=1
else
  echo "  ok: chrome.* только в ext-api.js"
fi

echo "== Node-тесты =="
for t in test/zip.test.js test/graphql-parser.test.js test/eu-graphql.test.js test/analytics.test.js test/exporter.test.js test/ext-api.test.js; do
  if node "$t"; then :; else echo "  FAIL $t"; fail=1; fi
done

echo "---------------------------------------------"
if [ "$fail" -ne 0 ]; then
  echo "ИТОГ: ЕСТЬ ОШИБКИ"
  exit 1
fi
echo "ИТОГ: ВСЁ ЗЕЛЁНОЕ"
