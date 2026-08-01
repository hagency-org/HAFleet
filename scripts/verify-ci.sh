#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Raised from 90s: kernel test shards now run at concurrency 1 to avoid a
# memory-pressure flake in the backend test harness (see docs/TESTING.md), which
# takes ~171s instead of ~69s. This is a hang guard, not a performance budget.
VERIFY_CI_TIMEOUT_SEC="${HAFLEET_VERIFY_CI_TIMEOUT_SEC:-300}"
if [[ "${HAFLEET_VERIFY_CI_TIMEOUT_ACTIVE:-0}" != "1" ]]; then
  if ! [[ "$VERIFY_CI_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [[ "$VERIFY_CI_TIMEOUT_SEC" -le 0 ]]; then
    echo "verify:ci timeout must be a positive integer number of seconds (got: $VERIFY_CI_TIMEOUT_SEC)" >&2
    exit 2
  fi
  timeout_bin="${HAFLEET_TIMEOUT_BIN:-}"
  if [[ -z "$timeout_bin" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout_bin="$(command -v timeout)"
    elif command -v gtimeout >/dev/null 2>&1; then
      timeout_bin="$(command -v gtimeout)"
    fi
  fi
  if [[ -z "$timeout_bin" ]]; then
    echo "verify:ci requires GNU timeout/gtimeout to enforce the ${VERIFY_CI_TIMEOUT_SEC}s wall-clock limit" >&2
    exit 127
  fi
  set +e
  HAFLEET_VERIFY_CI_TIMEOUT_ACTIVE=1 "$timeout_bin" --kill-after=5s "${VERIFY_CI_TIMEOUT_SEC}s" bash "$0" "$@"
  status=$?
  set -e
  if [[ "$status" -eq 124 ]]; then
    echo "verify:ci exceeded ${VERIFY_CI_TIMEOUT_SEC}s wall-clock timeout; optimization is needed." >&2
    exit 124
  fi
  exit "$status"
fi
declare -a step_names=()
declare -a step_pids=()
declare -a step_pgids=()
declare -a step_logs=()

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

cleanup_step_descendants() {
  local i="$1"
  local needs_kill=0
  if terminate_tracked_process "${step_pids[$i]:-}" "${step_pgids[$i]:-}" TERM; then
    needs_kill=1
  fi
  if [[ "$needs_kill" -eq 1 ]]; then
    sleep 0.2
    terminate_tracked_process "${step_pids[$i]:-}" "${step_pgids[$i]:-}" KILL || true
  fi
  return 0
}

cleanup_steps() {
  local signal="${1:-TERM}"
  local i
  local needs_kill=0
  for i in "${!step_pids[@]}"; do
    if terminate_tracked_process "${step_pids[$i]}" "${step_pgids[$i]:-}" "$signal"; then
      needs_kill=1
    fi
  done
  if [[ "$needs_kill" -eq 1 ]]; then
    sleep 0.2
  fi
  for i in "${!step_pids[@]}"; do
    terminate_tracked_process "${step_pids[$i]}" "${step_pgids[$i]:-}" KILL || true
    if [[ -n "${step_pids[$i]:-}" ]]; then
      wait "${step_pids[$i]}" >/dev/null 2>&1 || true
    fi
  done
  local log_file
  for log_file in "${step_logs[@]}"; do
    [[ -n "$log_file" ]] && rm -f "$log_file"
  done
  return 0
}
trap cleanup_steps EXIT
trap 'trap - EXIT; cleanup_steps HUP; exit 129' HUP
trap 'trap - EXIT; cleanup_steps INT; exit 130' INT
trap 'trap - EXIT; cleanup_steps TERM; exit 143' TERM

start_step() {
  local name="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/hafleet-verify-ci.XXXXXX")"
  step_names+=("$name")
  step_logs+=("$log_file")
  set -m
  (
    set -euo pipefail
    "$@"
  ) >"$log_file" 2>&1 &
  local pid="$!"
  set +m
  step_pids+=("$pid")
  step_pgids+=("$pid")
}

wait_step() {
  local i="$1"
  echo "== ${step_names[$i]} =="
  set +e
  wait "${step_pids[$i]}"
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    cat "${step_logs[$i]}"
    echo "verify:ci step failed: ${step_names[$i]} (exit ${status})" >&2
  else
    cat "${step_logs[$i]}"
  fi
  cleanup_step_descendants "$i"
  rm -f "${step_logs[$i]}"
  step_pids[$i]=""
  step_pgids[$i]=""
  step_logs[$i]=""
  return "$status"
}

unset HAFLEET_VERIFY_CI_TIMEOUT_ACTIVE

start_step "environment" npm run report:ci-env
if ! wait_step 0; then
  exit 1
fi

static_start_index="${#step_pids[@]}"
start_step "patch hygiene" git diff --check
start_step "syntax" npm run check:syntax
start_step "cli contract" npm run check:cli-contract
start_step "remote package" bash -c 'npm run build:remote:check && npm run check:remote-sync && npm run check:remote-package-smoke'
start_step "dependency boundary" npm run check:dep-isolation
start_step "architecture boundaries" npm run check:architecture-boundaries

failed=0
for ((i = static_start_index; i < ${#step_pids[@]}; i++)); do
  if ! wait_step "$i"; then
    failed=1
  fi
done
if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

kernel_step_index="${#step_pids[@]}"
start_step "kernel and cli smoke tests" npm run test:kernel
if ! wait_step "$kernel_step_index"; then
  exit 1
fi

echo "CI verification passed."
