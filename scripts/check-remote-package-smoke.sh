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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  printf '%s\n' "$haystack" | grep -Fq "$needle" || fail "$label missing expected text: $needle"
}

check_markdown_refs() {
  node --input-type=module - "$PKG_DIR" <<'NODE'
import fs from 'fs';
import path from 'path';

const packageRoot = path.resolve(process.argv[2]);
const failures = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
  }
  return files;
}

function isExternalRef(ref) {
  return (
    ref.startsWith('#') ||
    ref.startsWith('http://') ||
    ref.startsWith('https://') ||
    ref.startsWith('mailto:')
  );
}

function targetFor(file, rawRef) {
  const ref = rawRef.trim().replace(/^<|>$/g, '').split('#')[0];
  if (!ref || isExternalRef(ref) || !/\.md$/i.test(ref)) return null;
  return {
    ref,
    target: path.resolve(path.dirname(file), ref),
  };
}

for (const file of walk(packageRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  const relativeFile = path.relative(packageRoot, file);
  const refs = [];

  for (const match of source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    refs.push(match[1]);
  }
  for (const match of source.matchAll(/`([^`\n]*?\.md(?:#[^`\s]+)?[^`]*)`/g)) {
    refs.push(match[1]);
  }

  for (const rawRef of refs) {
    const resolved = targetFor(file, rawRef);
    if (!resolved) continue;
    if (!resolved.target.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(resolved.target)) {
      failures.push(`${relativeFile}: unresolved generated package markdown reference: ${resolved.ref}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
NODE
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

if [ -d "$ROOT_DIR/remote-dist" ]; then
  if ! diff -qr "$PKG_DIR" "$ROOT_DIR/remote-dist" >/dev/null; then
    fail "existing remote-dist/ is stale; run npm run build:remote to refresh the ignored generated package"
  fi
  echo "[OK] Existing remote-dist matches generated package"
fi

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

echo "Checking generated remote documentation references..."
if ! check_markdown_refs; then
  fail "generated remote package has broken markdown references"
fi
echo "[OK] Generated remote markdown references resolve inside the package"

autodeploy_service="$(cat "$PKG_DIR/push-relay-autodeploy.service")"
assert_contains "$autodeploy_service" "User=__USER__" "generated remote autodeploy service"
assert_contains "$autodeploy_service" "WorkingDirectory=__REPODIR__" "generated remote autodeploy service"
assert_contains "$autodeploy_service" "EnvironmentFile=__ENV_FILE__" "generated remote autodeploy service"
assert_contains "$autodeploy_service" "ExecStart=/usr/bin/env bash __REPODIR__/scripts/agentchat-remote-autodeploy.sh" "generated remote autodeploy service"
echo "[OK] Generated remote autodeploy service contract is stable"

help_output="$("$PKG_DIR/bin/agentchat" --help)"
printf '%s' "$help_output" | grep -q 'Usage: agentchat <command> \[args\]' || fail "generated agentchat help missing usage"
for unsupported in up-v1 project graph resume-id benchmark audit sync-skills check-mcp; do
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

AUDIT_OUT="$TMP_DIR/agentchat-remote-audit.out"
AUDIT_ERR="$TMP_DIR/agentchat-remote-audit.err"
if "$PKG_DIR/bin/agentchat" audit --quiet >"$AUDIT_OUT" 2>"$AUDIT_ERR"; then
  fail "generated remote agentchat audit --quiet unexpectedly succeeded"
fi
if ! grep -qi 'unknown or unsupported remote command' "$AUDIT_ERR"; then
  cat "$AUDIT_ERR" >&2
  fail "generated remote audit command did not fail clearly"
fi
if grep -Eqi 'No such file|not found' "$AUDIT_ERR"; then
  cat "$AUDIT_ERR" >&2
  fail "generated remote audit command leaked missing-file details"
fi

SYNC_SKILLS_OUT="$TMP_DIR/agentchat-remote-sync-skills.out"
SYNC_SKILLS_ERR="$TMP_DIR/agentchat-remote-sync-skills.err"
if "$PKG_DIR/bin/agentchat" sync-skills --check >"$SYNC_SKILLS_OUT" 2>"$SYNC_SKILLS_ERR"; then
  fail "generated remote agentchat sync-skills --check unexpectedly succeeded"
fi
if ! grep -qi 'unknown or unsupported remote command' "$SYNC_SKILLS_ERR"; then
  cat "$SYNC_SKILLS_ERR" >&2
  fail "generated remote sync-skills command did not fail clearly"
fi
if grep -Eqi 'No such file|not found|SKILL.md' "$SYNC_SKILLS_ERR"; then
  cat "$SYNC_SKILLS_ERR" >&2
  fail "generated remote sync-skills command leaked missing-file details"
fi
echo "[OK] Generated remote git-checkout-only commands fail clearly"

echo "Checking generated remote scoped help..."
service_help="$("$PKG_DIR/bin/agentchat" service --help)"
assert_contains "$service_help" "Controls services on the current host only." "generated remote service help"
assert_contains "$service_help" "remote relay service agent-chat-push-relay" "generated remote service help"
update_help="$("$PKG_DIR/bin/agentchat" update --help)"
assert_contains "$update_help" "Updates git-checkout installs on this host." "generated remote update help"
assert_contains "$update_help" "Standalone remote packages cannot self-update" "generated remote update help"
assert_contains "$update_help" "Service flags only control the remote relay service: agent-chat-push-relay." "generated remote update help"
ls_help="$("$PKG_DIR/bin/agentchat" ls --help)"
assert_contains "$ls_help" "Lists tmux sessions on the current runtime host." "generated remote ls help"
assert_contains "$ls_help" "backend-registered agents and v1 manifests visible to this host" "generated remote ls help"
down_help="$("$PKG_DIR/bin/agentchat" down --help)"
assert_contains "$down_help" "Stops a tmux session on the current runtime host only." "generated remote down help"
assert_contains "$down_help" "The backend is used for name resolution" "generated remote down help"
echo "[OK] Generated remote scoped help is explicit"

UPDATE_OUT="$TMP_DIR/agentchat-update-check.out"
UPDATE_ERR="$TMP_DIR/agentchat-update-check.err"
if HOME="$TMP_DIR/home" AGENT_CHAT_HOME= AGENT_CHAT_ROOT= "$PKG_DIR/bin/agentchat" update --check >"$UPDATE_OUT" 2>"$UPDATE_ERR"; then
  fail "generated standalone agentchat update --check unexpectedly succeeded"
fi
assert_contains "$(cat "$UPDATE_ERR")" "standalone remote package cannot self-update" "generated standalone update guard"
assert_contains "$(cat "$UPDATE_ERR")" ".git checkout" "generated standalone update guard"
assert_contains "$(cat "$UPDATE_ERR")" "remote/install-remote.sh" "generated standalone update guard"
if grep -Fq "$TMP_DIR is not a git repository" "$UPDATE_ERR"; then
  cat "$UPDATE_ERR" >&2
  fail "generated standalone update guard returned misleading parent git error"
fi
echo "[OK] Generated standalone update guard fails clearly"

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
