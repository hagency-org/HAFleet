#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/remote-dist"
DO_CHECK=0
DO_SYNC_REMOTE=0

usage() {
  cat <<USAGE
Usage: scripts/build-remote-package.sh [options]

Options:
  --output <dir>    Output directory (default: remote-dist)
  --check           Validate remote/ matches generated managed files
  --sync-remote     Overwrite managed files under remote/ from generated output
  -h, --help        Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output)
      if [ $# -lt 2 ]; then
        echo "Error: --output requires a directory" >&2
        exit 1
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    --check)
      DO_CHECK=1
      shift
      ;;
    --sync-remote)
      DO_SYNC_REMOTE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$DO_CHECK" -eq 1 ] && [ "$DO_SYNC_REMOTE" -eq 1 ]; then
  echo "Error: --check and --sync-remote cannot be used together" >&2
  exit 1
fi

MANAGED_SPECS=(
  "remote/.env.example:.env.example"
  "remote/README.md:README.md"
  "remote/install-remote.sh:install-remote.sh"
  "remote/push-relay.service:push-relay.service"
  "remote/push-relay.plist:push-relay.plist"
  "remote/package.json:package.json"
  "remote/push-relay.js:push-relay.js"
  "remote/mcp-server.js:mcp-server.js"
  "bin/agent-chat-cli:bin/agent-chat-cli"
  "bin/agent-down:bin/agent-down"
  "bin/agent-ls:bin/agent-ls"
  "bin/agent-send:bin/agent-send"
  "bin/agent-service:bin/agent-service"
  "bin/agent-up:bin/agent-up"
  "bin/agent-update:bin/agent-update"
  "bin/self-time-reminder:bin/self-time-reminder"
  "bin/verify-remote:bin/verify-remote"
  "lib/eventsource-mini.js:lib/eventsource-mini.js"
  "lib/push-relay-core.js:lib/push-relay-core.js"
  "lib/mcp-server-core.js:lib/mcp-server-core.js"
)

copy_manifest() {
  local target_root="$1"
  local spec src_rel dst_rel src dst mode

  rm -rf "$target_root"
  mkdir -p "$target_root"

  for spec in "${MANAGED_SPECS[@]}"; do
    src_rel="${spec%%:*}"
    dst_rel="${spec#*:}"
    src="$ROOT_DIR/$src_rel"
    dst="$target_root/$dst_rel"

    if [ ! -f "$src" ]; then
      echo "Error: missing source file '$src_rel'" >&2
      exit 1
    fi

    mkdir -p "$(dirname "$dst")"
    if [ -x "$src" ]; then
      mode=755
    else
      mode=644
    fi
    install -m "$mode" "$src" "$dst"
  done
}

compare_managed_against_remote() {
  local build_root="$1"
  local spec src_rel dst_rel generated current
  local failures=0

  for spec in "${MANAGED_SPECS[@]}"; do
    src_rel="${spec%%:*}"
    dst_rel="${spec#*:}"
    generated="$build_root/$dst_rel"
    current="$ROOT_DIR/remote/$dst_rel"

    if [ ! -f "$current" ]; then
      echo "[FAIL] remote/$dst_rel missing (source: $src_rel)"
      failures=$((failures + 1))
      continue
    fi

    if cmp -s "$generated" "$current"; then
      echo "[OK] remote/$dst_rel"
    else
      echo "[FAIL] remote/$dst_rel drifted from source $src_rel"
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -ne 0 ]; then
    echo "Managed remote package check failed: $failures file(s) differ." >&2
    return 1
  fi
  return 0
}

sync_remote_from_build() {
  local build_root="$1"
  local spec dst_rel generated remote_path mode

  for spec in "${MANAGED_SPECS[@]}"; do
    dst_rel="${spec#*:}"
    generated="$build_root/$dst_rel"
    remote_path="$ROOT_DIR/remote/$dst_rel"
    mkdir -p "$(dirname "$remote_path")"
    if [ -x "$generated" ]; then
      mode=755
    else
      mode=644
    fi
    install -m "$mode" "$generated" "$remote_path"
    echo "[SYNC] remote/$dst_rel"
  done
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BUILD_DIR="$TMP_DIR/remote-package"
copy_manifest "$BUILD_DIR"

if [ "$DO_CHECK" -eq 1 ]; then
  compare_managed_against_remote "$BUILD_DIR"
  echo "Managed remote package check passed."
  exit 0
fi

if [ "$DO_SYNC_REMOTE" -eq 1 ]; then
  sync_remote_from_build "$BUILD_DIR"
  echo "Managed files synced to remote/."
  exit 0
fi

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
cp -a "$BUILD_DIR"/. "$OUT_DIR"/

echo "Generated remote package at: $OUT_DIR"
