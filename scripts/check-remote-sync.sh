#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIRROR_FILES=(
  "bin/agent-chat-cli"
  "bin/agent-down"
  "bin/agent-ls"
  "bin/agent-send"
  "bin/agent-service"
  "bin/agent-up"
  "bin/agent-update"
  "bin/self-time-reminder"
  "bin/verify-remote"
  "lib/eventsource-mini.js"
)

failures=0

check_mirror_file() {
  local rel="$1"
  local left="$ROOT_DIR/$rel"
  local right="$ROOT_DIR/remote/$rel"

  if [ ! -f "$left" ]; then
    echo "[FAIL] Missing root file: $rel"
    failures=$((failures + 1))
    return
  fi
  if [ ! -f "$right" ]; then
    echo "[FAIL] Missing remote mirror: remote/$rel"
    failures=$((failures + 1))
    return
  fi

  if cmp -s "$left" "$right"; then
    echo "[OK] $rel"
  else
    echo "[FAIL] Drift detected: $rel != remote/$rel"
    failures=$((failures + 1))
  fi
}

check_wrapper_contract() {
  local file="$1"
  local needle="$2"
  if rg -n --fixed-strings "$needle" "$file" >/dev/null 2>&1; then
    echo "[OK] Wrapper contract: $file"
  else
    echo "[FAIL] Wrapper contract missing in $file: $needle"
    failures=$((failures + 1))
  fi
}

echo "Checking mirrored root/remote files..."
for rel in "${MIRROR_FILES[@]}"; do
  check_mirror_file "$rel"
done

echo "Checking wrapper contracts..."
check_wrapper_contract "push-relay.js" "./lib/push-relay-core.js"
check_wrapper_contract "mcp-server.js" "./lib/mcp-server-core.js"
check_wrapper_contract "remote/push-relay.js" "push-relay-core.js"
check_wrapper_contract "remote/mcp-server.js" "mcp-server-core.js"

if [ -x "scripts/build-remote-package.sh" ]; then
  echo "Checking generated remote package snapshot..."
  if ! scripts/build-remote-package.sh --check >/dev/null; then
    echo "[FAIL] Generated remote package is out of date."
    failures=$((failures + 1))
  else
    echo "[OK] Generated remote package snapshot"
  fi
fi

if [ "$failures" -ne 0 ]; then
  echo "Remote sync check failed: $failures issue(s)." >&2
  exit 1
fi

echo "Remote sync check passed."
