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
declare -a shard_pgids=()
declare -a shard_logs=()

terminate_tracked_process() {
  local pid="$1"
  local pgid="$2"
  local signal="$3"
  if [[ -n "$pgid" ]]; then
    if kill -0 -- "-$pgid" >/dev/null 2>&1; then
      kill "-$signal" -- "-$pgid" >/dev/null 2>&1 || true
      return 0
    fi
    return 1
  fi
  [[ -n "$pid" ]] || return 1
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi
  kill "-$signal" "$pid" >/dev/null 2>&1 || true
  return 0
}

cleanup_shard_descendants() {
  local i="$1"
  local needs_kill=0
  if terminate_tracked_process "${shard_pids[$i]:-}" "${shard_pgids[$i]:-}" TERM; then
    needs_kill=1
  fi
  if [[ "$needs_kill" -eq 1 ]]; then
    sleep 0.2
    terminate_tracked_process "${shard_pids[$i]:-}" "${shard_pgids[$i]:-}" KILL || true
  fi
  return 0
}

cleanup_shards() {
  local signal="${1:-TERM}"
  local i
  local needs_kill=0
  for i in "${!shard_pids[@]}"; do
    if terminate_tracked_process "${shard_pids[$i]}" "${shard_pgids[$i]:-}" "$signal"; then
      needs_kill=1
    fi
  done
  if [[ "$needs_kill" -eq 1 ]]; then
    sleep 0.2
  fi
  for i in "${!shard_pids[@]}"; do
    terminate_tracked_process "${shard_pids[$i]}" "${shard_pgids[$i]:-}" KILL || true
    if [[ -n "${shard_pids[$i]:-}" ]]; then
      wait "${shard_pids[$i]}" >/dev/null 2>&1 || true
    fi
  done
  local log_file
  for log_file in "${shard_logs[@]}"; do
    [[ -n "$log_file" ]] && rm -f "$log_file"
  done
  return 0
}
trap cleanup_shards EXIT
trap 'trap - EXIT; cleanup_shards HUP; exit 129' HUP
trap 'trap - EXIT; cleanup_shards INT; exit 130' INT
trap 'trap - EXIT; cleanup_shards TERM; exit 143' TERM

start_shard() {
  local name="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/agent-chat-kernel-tests.XXXXXX")"
  shard_names+=("$name")
  shard_logs+=("$log_file")
  set -m
  (
    set -euo pipefail
    "$vitest_bin" run --no-file-parallelism --maxWorkers=1 "$@"
  ) >"$log_file" 2>&1 &
  local pid="$!"
  set +m
  shard_pids+=("$pid")
  shard_pgids+=("$pid")
}

start_shard "api messaging" \
  tests/api-smoke.test.js \
  tests/api-messages.test.js \
  tests/api-groups.test.js \
  tests/api-agent-token.test.js

start_shard "api runtime" \
  tests/agent-state.test.js \
  tests/agent-state-integration.test.js \
  tests/api-task-graphs.test.js \
  tests/api-server-heartbeat.test.js \
  tests/api-runtime.test.js

start_shard "backend api" \
  tests/api-framework-presets.test.js \
  tests/api-tasks.test.js \
  tests/alert-store.test.js \
  tests/supervisor-snapshot-store.test.js \
  tests/supervisor-action-engine.test.js \
  tests/api-supervisor-v2.test.js \
  tests/api-agents.test.js \
  tests/api-audit.test.js \
  tests/api-provenance.test.js \
  tests/api-tombstone.test.js

start_shard "delivery and dashboard" \
  tests/push-relay.test.js \
  tests/push-relay-lifecycle.test.js \
  tests/sse-adapter.test.js \
  tests/backend-lifecycle.test.js \
  tests/server-delivery.test.js \
  tests/server-dashboard-boundary.test.js

start_shard "contracts and cli" \
  tests/runtime-parity.test.js \
  tests/runtime-dir-guard.test.js \
  tests/agent-home-v1.test.js \
  tests/mcp-media-cache.test.js \
  tests/architecture-boundaries-check.test.js \
  tests/ci-workflow.test.js \
  tests/bot-command-acl.test.js \
  tests/source-of-truth.test.js \
  tests/cli-agent-project.test.js \
  tests/cli-agent-graph.test.js \
  tests/cli-agent-ls.test.js \
  tests/cli-agent-status.test.js \
  tests/cli-fleet.test.js \
  tests/cli-resume-id.test.js \
  tests/supervisor-writer-cli.test.js \
  tests/verify-remote-cli.test.js \
  tests/verify-cd-preflight.test.js \
  tests/verify-ci-timeout.test.js \
  tests/ci-script-cleanup.test.js \
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
  cleanup_shard_descendants "$i"
  rm -f "${shard_logs[$i]}"
  shard_pids[$i]=""
  shard_pgids[$i]=""
  shard_logs[$i]=""
  if [[ "$status" -ne 0 ]]; then
    echo "kernel test shard failed: ${shard_names[$i]} (exit ${status})" >&2
    failed=1
  fi
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
