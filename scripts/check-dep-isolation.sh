#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

CODE_PATHS=(
  bridge-matrix.js
  backend-v2.js
  mcp-server.js
  push-relay.js
  lib
  remote/lib
  bin
  remote/bin
  scripts
)

grep_code_paths() {
  local pattern="$1"
  find "${CODE_PATHS[@]}" -type f ! -path "scripts/check-dep-isolation.sh" -print0 2>/dev/null \
    | while IFS= read -r -d '' file; do
        grep -HnE -I -- "$pattern" "$file" 2>/dev/null || true
      done
}

echo "Checking dependency isolation boundary..."

imports="$(grep_code_paths "from 'matrix-bot-sdk'|require\(['\"]matrix-bot-sdk['\"]\)")"
if [ -z "$imports" ]; then
  echo "[FAIL] no matrix-bot-sdk import found in runtime code"
  failures=$((failures + 1))
else
  import_count="$(printf '%s\n' "$imports" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$import_count" -ne 1 ]; then
    echo "[FAIL] matrix-bot-sdk import appears $import_count times (expected 1)"
    printf '%s\n' "$imports"
    failures=$((failures + 1))
  elif ! printf '%s\n' "$imports" | grep -qE '^bridge-matrix\.js:'; then
    echo "[FAIL] matrix-bot-sdk import must be isolated to bridge-matrix.js"
    printf '%s\n' "$imports"
    failures=$((failures + 1))
  else
    echo "[OK] matrix-bot-sdk runtime import isolated to bridge-matrix.js"
  fi
fi

request_refs="$(grep_code_paths "from ['\"]request['\"]|require\(['\"]request['\"]\)|from ['\"]request-promise['\"]|require\(['\"]request-promise['\"]\)")"
if [ -n "$request_refs" ]; then
  echo "[FAIL] direct request/request-promise usage found in project code"
  printf '%s\n' "$request_refs"
  failures=$((failures + 1))
else
  echo "[OK] no direct request/request-promise imports in project code"
fi

sdk_refs="$(grep -HnE "matrix-bot-sdk" package.json package-lock.json 2>/dev/null || true)"
if [ -z "$sdk_refs" ]; then
  echo "[FAIL] matrix-bot-sdk package reference missing; dependency baseline changed unexpectedly"
  failures=$((failures + 1))
else
  echo "[OK] matrix-bot-sdk package reference found in manifests"
fi

if [ "$failures" -ne 0 ]; then
  echo "Dependency isolation check failed: $failures issue(s)." >&2
  exit 1
fi

echo "Dependency isolation check passed."
