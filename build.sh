#!/usr/bin/env bash
# CurveRunner build script — regenerates the minified production assets.
# Run after editing app.js / style.css:
#
#   npx terser   -> app.min.js
#   npx cleancss -> style.min.css
#
# index.html and sw.js reference the .min files; index.html / sw.js precache them.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v terser >/dev/null 2>&1; then
  echo "Installing terser & clean-css-cli (one time)..."
  npm install --no-save terser clean-css-cli
fi

echo "▸ Minifying app.js -> app.min.js"
./node_modules/.bin/terser app.js -o app.min.js --compress --mangle --format ascii_only=true

echo "▸ Minifying style.css -> style.min.css"
./node_modules/.bin/cleancss -O2 style.css -o style.min.css

echo "▸ Verifying"
node --check app.min.js && echo "  app.min.js  OK" || { echo "  app.min.js  FAILED"; exit 1; }

echo "Done. Committed assets: app.min.js, style.min.css"
