#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATE_STAMP="$(date +%Y-%m-%d)"
CURRENT_VERSION="$(
  sed -nE 's/^const COMMIT_VERSION = "(V[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+)";$/\1/p' script.js | head -n1
)"

if [[ -n "${1:-}" ]]; then
  NEXT_VERSION="$1"
else
  if [[ "$CURRENT_VERSION" =~ ^V${DATE_STAMP}-([0-9]+)$ ]]; then
    NEXT_INDEX="$((BASH_REMATCH[1] + 1))"
  else
    NEXT_INDEX=1
  fi
  NEXT_VERSION="V${DATE_STAMP}-${NEXT_INDEX}"
fi

perl -0pi -e 's|style\.css\?v=[^"]+|style.css?v='"$NEXT_VERSION"'|g' index.html
perl -0pi -e 's|script\.js\?v=[^"]+|script.js?v='"$NEXT_VERSION"'|g' index.html
perl -0pi -e 's|const COMMIT_VERSION = "[^"]+";|const COMMIT_VERSION = "'"$NEXT_VERSION"'";|g' script.js

echo "Version updated to ${NEXT_VERSION}"
