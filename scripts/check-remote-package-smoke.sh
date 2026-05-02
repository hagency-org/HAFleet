#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PKG_DIR="$TMP_DIR/remote-package"
bash scripts/build-remote-package.sh --output "$PKG_DIR" >/dev/null

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

echo "Checking generated remote package shape..."
for required in \
  "bin/agentchat" \
  "bin/agent-up" \
  "push-relay.js" \
  "push-relay-autodeploy.service" \
  "mcp-server.js" \
  "lib/push-relay-core.js" \
  "lib/mcp-server-core.js" \
  "lib/blocked-patterns.js" \
  "lib/eventsource-mini.js"
do
  [ -e "$PKG_DIR/$required" ] || fail "missing generated package file: $required"
done
echo "[OK] Required generated package files exist"

bad_paths="$(find "$PKG_DIR" \( -name '.DS_Store' -o -name '.env' -o -name 'package-lock.json' -o -path '*/node_modules/*' -o -path '*/logs/*' \) -print)"
if [ -n "$bad_paths" ]; then
  echo "$bad_paths" >&2
  fail "generated remote package includes runtime or local-only artifacts"
fi
echo "[OK] Generated package excludes runtime artifacts"

echo "Checking generated remote JavaScript syntax..."
while IFS= read -r file; do
  [ -n "$file" ] || continue
  node --check "$file" >/dev/null
done < <(find "$PKG_DIR" -type f -name '*.js' | sort)
echo "[OK] Generated package JavaScript syntax"

echo "Checking generated remote shell syntax..."
while IFS= read -r file; do
  [ -n "$file" ] || continue
  bash -n "$file"
done < <(find "$PKG_DIR/bin" -type f -print | sort; printf '%s\n' "$PKG_DIR/install-remote.sh")
echo "[OK] Generated package shell syntax"

help_output="$("$PKG_DIR/bin/agentchat" --help)"
printf '%s' "$help_output" | grep -q 'Usage: agentchat <command> \[args\]' || fail "generated agentchat help missing usage"
for unsupported in up-v1 project graph resume-id benchmark check-mcp; do
  if printf '%s\n' "$help_output" | grep -Eq "^[[:space:]]*$unsupported([[:space:]]|$)"; then
    fail "generated remote help advertises unsupported command: $unsupported"
  fi
done
echo "[OK] Generated remote help is profile-scoped"

GRAPH_OUT="$TMP_DIR/agentchat-remote-graph.out"
GRAPH_ERR="$TMP_DIR/agentchat-remote-graph.err"
if "$PKG_DIR/bin/agentchat" graph >"$GRAPH_OUT" 2>"$GRAPH_ERR"; then
  fail "generated remote agentchat graph unexpectedly succeeded"
fi
if ! grep -qi 'unknown or unsupported remote command' "$GRAPH_ERR"; then
  cat "$GRAPH_ERR" >&2
  fail "generated remote unsupported command did not fail clearly"
fi
echo "[OK] Generated remote unsupported command fails clearly"

echo "Checking generated remote wrapper resolution..."
if ! AGENTCHAT_WRAPPER_SMOKE=1 node "$PKG_DIR/push-relay.js"; then
  fail "generated push-relay wrapper failed to resolve its core module"
fi
echo "[OK] Generated push-relay wrapper resolves package-local core"
if ! AGENTCHAT_WRAPPER_SMOKE=1 node "$PKG_DIR/mcp-server.js"; then
  fail "generated MCP wrapper failed to resolve its core module"
fi
echo "[OK] Generated MCP wrapper resolves package-local core"

echo "Generated remote package smoke passed."
