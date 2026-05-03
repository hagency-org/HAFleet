#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERIFY_CI_TIMEOUT_SEC="${AGENTCHAT_VERIFY_CI_TIMEOUT_SEC:-90}"
if [[ "${AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE:-0}" != "1" ]]; then
  if ! [[ "$VERIFY_CI_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [[ "$VERIFY_CI_TIMEOUT_SEC" -le 0 ]]; then
    echo "verify:ci timeout must be a positive integer number of seconds (got: $VERIFY_CI_TIMEOUT_SEC)" >&2
    exit 2
  fi
  timeout_bin="${AGENTCHAT_TIMEOUT_BIN:-}"
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
  AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE=1 "$timeout_bin" --kill-after=5s "${VERIFY_CI_TIMEOUT_SEC}s" bash "$0" "$@"
  status=$?
  set -e
  if [[ "$status" -eq 124 ]]; then
    echo "verify:ci exceeded ${VERIFY_CI_TIMEOUT_SEC}s wall-clock timeout; optimization is needed." >&2
    exit 124
  fi
  exit "$status"
fi
unset AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE

echo "== environment =="
npm run report:ci-env

declare -a step_names=()
declare -a step_pids=()
declare -a step_logs=()

start_step() {
  local name="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/agent-chat-verify-ci.XXXXXX")"
  step_names+=("$name")
  step_logs+=("$log_file")
  (
    set -euo pipefail
    "$@"
  ) >"$log_file" 2>&1 &
  step_pids+=("$!")
}

start_step "syntax" npm run check:syntax
start_step "cli contract" npm run check:cli-contract
start_step "remote package" bash -c 'npm run build:remote:check && npm run check:remote-sync && npm run check:remote-package-smoke'
start_step "dependency boundary" npm run check:dep-isolation
start_step "architecture boundaries" npm run check:architecture-boundaries

failed=0
for i in "${!step_pids[@]}"; do
  echo "== ${step_names[$i]} =="
  set +e
  wait "${step_pids[$i]}"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    cat "${step_logs[$i]}"
    echo "verify:ci step failed: ${step_names[$i]} (exit ${status})" >&2
    failed=1
  else
    cat "${step_logs[$i]}"
  fi
  rm -f "${step_logs[$i]}"
done
if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "== kernel and cli smoke tests =="
npm run test:kernel

echo "CI verification passed."
