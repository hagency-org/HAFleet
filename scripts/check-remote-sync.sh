#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIRROR_FILES=(
  "bin/hafleet-prune-agents"
  "bin/hafleet-legacy"
  "bin/hafleet-cli"
  "bin/hafleet-down"
  "bin/hafleet-ls"
  "bin/hafleet-maintain"
  "bin/hafleet-send"
  "bin/hafleet-service"
  "bin/hafleet-update"
  "bin/self-time-reminder"
  "bin/verify-remote"
  "lib/blocked-patterns.js"
  "lib/agent-launch-policy.js"
  "lib/eventsource-mini.js"
  "lib/pane-activity.js"
  "lib/server-identity.js"
  "lib/push-relay-core.js"
  "lib/mcp-server-core.js"
  "lib/runtime-approval-client.js"
  "lib/codex-hook-trust.js"
  "lib/codex-project-trust.js"
  "lib/codex-permission-hook.js"
  "scripts/validate-agent-launch-extra-args.js"
  "scripts/resolve-agent-sandbox-roots.js"
)

PROFILE_SPECIFIC_FILES=(
  "bin/hafleet:remote profile-specific command surface"
  "bin/hafleet-up:remote profile-specific launcher with shared permission baseline"
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

check_profile_specific_file() {
  local spec="$1"
  local rel="${spec%%:*}"
  local reason="${spec#*:}"
  local left="$ROOT_DIR/$rel"
  local right="$ROOT_DIR/remote/$rel"

  if [ ! -f "$left" ]; then
    echo "[FAIL] Missing root file for profile-specific check: $rel"
    failures=$((failures + 1))
    return
  fi
  if [ ! -f "$right" ]; then
    echo "[FAIL] Missing remote profile file: remote/$rel"
    failures=$((failures + 1))
    return
  fi

  echo "[OK] Profile-specific remote file: remote/$rel ($reason)"
}

check_agentchat_dispatch_targets() {
  local file="$1"
  local label="$2"
  local bin_dir target target_path targets
  bin_dir="$(dirname "$file")"

  if [ ! -f "$file" ]; then
    echo "[FAIL] Missing hafleet CLI for dispatch check: $file"
    failures=$((failures + 1))
    return
  fi

  targets="$(sed -n 's/.*dispatch "\([^"]*\)".*/\1/p' "$file" | sort -u)"
  if [ -z "$targets" ]; then
    echo "[FAIL] No dispatch targets found in $file"
    failures=$((failures + 1))
    return
  fi

  while IFS= read -r target; do
    [ -n "$target" ] || continue
    target_path="$bin_dir/$target"
    if [ -x "$target_path" ]; then
      echo "[OK] Dispatch target ($label): $target"
    else
      echo "[FAIL] Missing or non-executable dispatch target ($label): $target_path"
      failures=$((failures + 1))
    fi
  done <<< "$targets"
}

check_file_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fn -- "$needle" "$file" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

check_wrapper_contract() {
  local file="$1"
  local mode="$2"
  local core="$3"

  if [ ! -f "$file" ]; then
    echo "[FAIL] Wrapper contract missing file: $file"
    failures=$((failures + 1))
    return
  fi

  case "$mode" in
    root)
      if check_file_contains "$file" "import('./lib/$core')"; then
        echo "[OK] Wrapper contract: $file"
      else
        echo "[FAIL] Wrapper contract missing in $file: package-local import ./lib/$core"
        failures=$((failures + 1))
      fi
      ;;
    remote)
      if check_file_contains "$file" "path.join(baseDir, 'lib', '$core')" \
        && check_file_contains "$file" "path.join(baseDir, '..', 'lib', '$core')" \
        && check_file_contains "$file" "pathToFileURL(path.resolve(corePath)).href"; then
        echo "[OK] Wrapper contract: $file"
      else
        echo "[FAIL] Wrapper contract missing in $file: package-local/repo-root dynamic core resolution for $core"
        failures=$((failures + 1))
      fi
      ;;
    *)
      echo "[FAIL] Unknown wrapper contract mode '$mode' for $file"
      failures=$((failures + 1))
      ;;
  esac
}

echo "Checking mirrored root/remote files..."
for rel in "${MIRROR_FILES[@]}"; do
  check_mirror_file "$rel"
done

echo "Checking profile-specific remote files..."
for spec in "${PROFILE_SPECIFIC_FILES[@]}"; do
  check_profile_specific_file "$spec"
done

echo "Checking hafleet dispatch targets..."
check_agentchat_dispatch_targets "bin/hafleet" "root"
check_agentchat_dispatch_targets "remote/bin/hafleet" "remote"

echo "Checking wrapper contracts..."
check_wrapper_contract "push-relay.js" "root" "push-relay-core.js"
check_wrapper_contract "mcp-server.js" "root" "mcp-server-core.js"
check_wrapper_contract "remote/push-relay.js" "remote" "push-relay-core.js"
check_wrapper_contract "remote/mcp-server.js" "remote" "mcp-server-core.js"

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
