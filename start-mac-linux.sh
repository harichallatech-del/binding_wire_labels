#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first"; exit 1; }
[ -d node_modules/sql.js ] || npm install --omit=dev --no-audit --no-fund
(sleep 2; open http://127.0.0.1:3001 2>/dev/null || xdg-open http://127.0.0.1:3001 2>/dev/null) &
node server.js
