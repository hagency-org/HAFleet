#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

vitest_bin="${AGENTCHAT_VITEST_BIN:-}"
if [[ -z "$vitest_bin" ]]; then
  if command -v vitest >/dev/null 2>&1; then
    vitest_bin="$(command -v vitest)"
  elif [[ -x "$ROOT_DIR/node_modules/.bin/vitest" ]]; then
    vitest_bin="$ROOT_DIR/node_modules/.bin/vitest"
  else
    echo "kernel tests require vitest on PATH or at node_modules/.bin/vitest" >&2
    exit 127
  fi
fi

declare -a shard_names=()
declare -a shard_pids=()
declare -a shard_logs=()

start_shard() {
  local name="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/agent-chat-kernel-tests.XXXXXX")"
  shard_names+=("$name")
  shard_logs+=("$log_file")
  (
    set -euo pipefail
    "$vitest_bin" run --no-file-parallelism --maxWorkers=1 "$@"
  ) >"$log_file" 2>&1 &
  shard_pids+=("$!")
}

start_shard "api messaging" \
  tests/api-smoke.test.js \
  tests/api-messages.test.js \
  tests/api-groups.test.js \
  tests/api-agent-token.test.js

start_shard "api runtime" \
  tests/api-task-graphs.test.js \
  tests/api-server-heartbeat.test.js

start_shard "delivery and dashboard" \
  tests/push-relay.test.js \
  tests/push-relay-lifecycle.test.js \
  tests/backend-lifecycle.test.js \
  tests/server-delivery.test.js \
  tests/server-dashboard-boundary.test.js

start_shard "contracts and cli" \
  tests/runtime-parity.test.js \
  tests/runtime-dir-guard.test.js \
  tests/agent-home-v1.test.js \
  tests/mcp-media-cache.test.js \
  tests/architecture-boundaries-check.test.js \
  tests/source-of-truth.test.js \
  tests/cli-agent-project.test.js \
  tests/cli-agent-graph.test.js \
  tests/cli-agent-ls.test.js \
  tests/cli-agent-status.test.js \
  tests/cli-fleet.test.js \
  tests/cli-resume-id.test.js \
  tests/verify-remote-cli.test.js \
  tests/verify-cd-preflight.test.js \
  tests/verify-ci-timeout.test.js \
  tests/remote-install-profile.test.js \
  tests/remote-autodeploy.test.js \
  tests/dev-autodeploy.test.js \
  tests/stable-autodeploy.test.js

failed=0
for i in "${!shard_pids[@]}"; do
  echo "== kernel shard: ${shard_names[$i]} =="
  set +e
  wait "${shard_pids[$i]}"
  status=$?
  set -e
  cat "${shard_logs[$i]}"
  rm -f "${shard_logs[$i]}"
  if [[ "$status" -ne 0 ]]; then
    echo "kernel test shard failed: ${shard_names[$i]} (exit ${status})" >&2
    failed=1
  fi
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
