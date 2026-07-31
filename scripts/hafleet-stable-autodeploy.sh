#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${HAFLEET_LIVE_DIR:-${HAFLEET_LIVE_ROOT:-${HAFLEET_REPO_ROOT:-$DEFAULT_REPO_DIR}}}"
DEPLOY_USER="${HAFLEET_DEPLOY_USER:?HAFLEET_DEPLOY_USER must be set}"
DEPLOY_BRANCH="${HAFLEET_DEPLOY_BRANCH:-stable}"
POLL_SEC="${HAFLEET_POLL_SEC:-30}"
BACKEND_SERVICE="${HAFLEET_BACKEND_SERVICE:-hafleet-backend}"
DEPLOY_SERVICES="${HAFLEET_DEPLOY_SERVICES:-hafleet ${BACKEND_SERVICE} bridge-matrix}"
# Defaults to the gate ON. `none` means any commit reaching the deploy branch is
# checked out and restarted with no test gate; that must be an explicit opt-out,
# not the default. The shipped unit also sets this.
RELEASE_GATE="${HAFLEET_RELEASE_GATE:-worktree}"
RELEASE_GATE_ARGS="${HAFLEET_RELEASE_GATE_ARGS:-}"
ONCE="${HAFLEET_ONCE:-false}"
SYSTEMCTL_BIN="${HAFLEET_SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${HAFLEET_CURL_BIN:-curl}"
SLEEP_BIN="${HAFLEET_SLEEP_BIN:-sleep}"
NPM_BIN="${HAFLEET_NPM_BIN:-npm}"
DEPLOY_STATE_DIR="${HAFLEET_DEPLOY_STATE_DIR:-}"
LAST_SUCCESSFUL_REF_FILE=""
INSTALL_NEEDED_FILE=""
QUARANTINED_REF_FILE=""
DEPLOY_FAILURE_FILE=""

log() {
  printf '[stable-autodeploy] %s\n' "$*"
}

run_as_deploy_user() {
  if [ "$(id -un)" = "$DEPLOY_USER" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$DEPLOY_USER" -- "$@"
  else
    runuser -u "$DEPLOY_USER" -- "$@"
  fi
}

run_git() {
  run_as_deploy_user git -C "$REPO_DIR" "$@"
}

run_systemctl() {
  # This watcher runs unprivileged (see hafleet-stable-autodeploy.service).
  # Restarts escalate through the narrow /etc/sudoers.d/hafleet-autodeploy
  # rule. Root needs no escalation, and an explicitly overridden SYSTEMCTL_BIN
  # (tests, custom harnesses) is always invoked directly.
  if [ "$(id -u)" = "0" ] \
    || [ -n "${HAFLEET_SYSTEMCTL_BIN:-}" ] \
    || ! command -v sudo >/dev/null 2>&1; then
    "$SYSTEMCTL_BIN" "$@"
  else
    sudo -n "$SYSTEMCTL_BIN" "$@"
  fi
}

run_sleep() {
  "$SLEEP_BIN" "$@"
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

sleep_or_exit_once() {
  if is_true "$ONCE"; then
    exit 0
  fi
  run_sleep "$POLL_SEC"
}

service_list() {
  local s
  for s in $DEPLOY_SERVICES; do
    [ -n "$s" ] && printf '%s\n' "$s"
  done
}

BACKEND_HEALTH_URL="${HAFLEET_BACKEND_HEALTH_URL:-http://127.0.0.1:8090/api/agents}"
BACKEND_HEALTH_TIMEOUT="${HAFLEET_BACKEND_HEALTH_TIMEOUT:-30}"

wait_for_backend() {
  local i
  log "Waiting up to ${BACKEND_HEALTH_TIMEOUT}s for backend health..."
  for i in $(seq "$BACKEND_HEALTH_TIMEOUT"); do
    if "$CURL_BIN" -sf "$BACKEND_HEALTH_URL" >/dev/null 2>&1; then
      log "Backend healthy after ${i}s"
      return 0
    fi
    run_sleep 1
  done
  log "ERROR: backend not healthy after ${BACKEND_HEALTH_TIMEOUT}s"
  return 1
}

restart_services() {
  local failed=0

  # 1. Restart backend first
  log "Restarting backend ($BACKEND_SERVICE)..."
  if ! run_systemctl restart "$BACKEND_SERVICE"; then
    log "ERROR: failed to restart backend '$BACKEND_SERVICE'"
    return 1
  fi

  # 2. Wait for backend to be healthy before restarting dependents
  if ! wait_for_backend; then
    log "ERROR: backend health gate failed; skipping dependent restarts"
    return 1
  fi

  # 3. Restart remaining services sequentially (skip backend)
  local s
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    [ "$s" = "$BACKEND_SERVICE" ] && continue
    log "Restarting $s..."
    if ! run_systemctl restart "$s"; then
      log "ERROR: failed to restart service '$s'"
      failed=1
    fi
  done < <(service_list)

  # 4. Verify all services are active
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    if ! run_systemctl is-active --quiet "$s"; then
      log "ERROR: service '$s' is not active after restart"
      failed=1
    fi
  done < <(service_list)

  return "$failed"
}

init_deploy_state() {
  if [ -z "$DEPLOY_STATE_DIR" ]; then
    DEPLOY_STATE_DIR="$(run_git rev-parse --absolute-git-dir)/hafleet-autodeploy"
  fi
  LAST_SUCCESSFUL_REF_FILE="$DEPLOY_STATE_DIR/last-successful-ref"
  INSTALL_NEEDED_FILE="$DEPLOY_STATE_DIR/install-needed"
  QUARANTINED_REF_FILE="$DEPLOY_STATE_DIR/quarantined-ref"
  DEPLOY_FAILURE_FILE="$DEPLOY_STATE_DIR/last-failure"
}

ensure_deploy_state_dir() {
  run_as_deploy_user mkdir -p "$DEPLOY_STATE_DIR"
}

write_state_file() {
  local file="$1"
  local value="$2"
  ensure_deploy_state_dir
  run_as_deploy_user bash -c 'printf "%s\n" "$1" > "$2"' _ "$value" "$file"
}

touch_state_file() {
  local file="$1"
  ensure_deploy_state_dir
  run_as_deploy_user touch "$file"
}

remove_state_file() {
  local file="$1"
  run_as_deploy_user rm -f "$file"
}

read_last_successful_ref() {
  if [ -s "$LAST_SUCCESSFUL_REF_FILE" ]; then
    head -n 1 "$LAST_SUCCESSFUL_REF_FILE"
  fi
}

initialize_success_state() {
  local baseline_ref="$1"
  if [ -n "$baseline_ref" ] && [ ! -s "$LAST_SUCCESSFUL_REF_FILE" ]; then
    write_state_file "$LAST_SUCCESSFUL_REF_FILE" "$baseline_ref"
  fi
}

mark_deploy_success() {
  local successful_ref="$1"
  write_state_file "$LAST_SUCCESSFUL_REF_FILE" "$successful_ref"
  remove_state_file "$INSTALL_NEEDED_FILE"
}

has_install_needed() {
  [ -f "$INSTALL_NEEDED_FILE" ]
}

# --- Quarantine ---------------------------------------------------------------
# A ref whose deploy failed its health gate is quarantined so the watcher stops
# re-deploying it. Previously a failed deploy only set deploy_pending=true, and
# because origin/<branch> had not moved, the same bad commit was retried every
# poll interval forever.

read_quarantined_ref() {
  if [ -s "$QUARANTINED_REF_FILE" ]; then
    head -n 1 "$QUARANTINED_REF_FILE"
  fi
}

quarantine_ref() {
  write_state_file "$QUARANTINED_REF_FILE" "$1"
}

clear_quarantine() {
  remove_state_file "$QUARANTINED_REF_FILE"
  remove_state_file "$DEPLOY_FAILURE_FILE"
}

record_failure() {
  local failed_ref="$1"
  local stage="$2"
  local rollback_state="$3"
  write_state_file "$DEPLOY_FAILURE_FILE" \
    "$(printf '{"ref":"%s","stage":"%s","rollback":"%s","at":"%s"}' \
      "$failed_ref" "$stage" "$rollback_state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
}

# Best-effort operator alert. Never fatal: a deploy failure must not be masked by
# an alerting failure. Requires both env vars, so it is opt-in.
emit_alert() {
  local summary="$1"
  [ -n "${HAFLEET_ALERT_URL:-}" ] || return 0
  [ -n "${HAFLEET_ALERT_TOKEN:-}" ] || return 0
  "$CURL_BIN" -sf -m 10 -X POST "$HAFLEET_ALERT_URL" \
    -H "Authorization: Bearer $HAFLEET_ALERT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"kind":"deploy_failure","severity":"critical","summary":"%s"}' "$summary")" \
    >/dev/null 2>&1 || log "WARN: alert POST failed (continuing)"
}

# --- Rollback -----------------------------------------------------------------
# Reset the live checkout back to the last ref that passed its health gate,
# reinstall dependencies for it, and restart. Returns non-zero if the rollback
# itself could not be completed, which is an operator-intervention situation.
rollback_to_last_successful() {
  local failed_ref="$1"
  local target
  target="$(read_last_successful_ref || true)"

  if [ -z "$target" ]; then
    log "ERROR: no last-successful ref recorded; cannot roll back from $failed_ref"
    return 1
  fi
  if [ "$target" = "$failed_ref" ]; then
    log "ERROR: last-successful ref is the failed ref ($failed_ref); nothing to roll back to"
    return 1
  fi

  log "Rolling back from $failed_ref to last successful ref $target"
  if ! run_git reset --hard "$target" >/dev/null 2>&1; then
    log "FATAL: rollback reset to $target failed; live checkout may be inconsistent"
    return 1
  fi

  # Dependencies may differ between the failed ref and the known-good one, so
  # force a reinstall rather than trusting the manifest-diff shortcut.
  if ! maybe_install_deps "$failed_ref" "$target" true; then
    log "FATAL: dependency install failed while rolling back to $target"
    return 1
  fi

  if restart_services; then
    log "Rollback to $target succeeded; services healthy"
    return 0
  fi

  log "FATAL: rolled back to $target but services are still unhealthy"
  return 1
}

run_npm_install() {
  run_as_deploy_user env npm_config_loglevel=error "$NPM_BIN" --prefix "$REPO_DIR" install --production
}

maybe_install_deps() {
  local old_ref="$1"
  local new_ref="$2"
  local force_install="${3:-false}"
  local changed
  changed="$(run_git diff --name-only "$old_ref" "$new_ref" -- package.json package-lock.json 2>/dev/null || true)"
  if [ -z "$changed" ] && [ "$force_install" != true ]; then
    return 0
  fi

  if [ "$force_install" = true ] && [ -z "$changed" ]; then
    log "Dependency install retry marker present; running npm install --production"
  else
    log "Dependency manifest changed; running npm install --production"
  fi
  touch_state_file "$INSTALL_NEEDED_FILE"
  if ! run_npm_install; then
    log "ERROR: npm install failed; skipping service restart for this update"
    return 1
  fi
  remove_state_file "$INSTALL_NEEDED_FILE"
  return 0
}

force_clean_workdir() {
  local dirty
  dirty="$(run_git status --porcelain 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    log "WARN: dirty working tree detected (deploy dir should be clean):"
    printf '%s\n' "$dirty" | head -20 | while IFS= read -r line; do log "  $line"; done
    log "Cleaning: git reset --hard + git clean -fd"
    run_git reset --hard HEAD >/dev/null 2>&1 || true
    run_git clean -fd >/dev/null 2>&1 || true
  fi
}

run_release_gate() {
  local target_ref="$1"
  local gate_worktree

  case "$RELEASE_GATE" in
    none|"")
      return 0
      ;;
    worktree)
      ensure_deploy_state_dir
      gate_worktree="$DEPLOY_STATE_DIR/release-gate-worktree"
      log "Running worktree release gate for $target_ref"
      run_git worktree remove --force "$gate_worktree" >/dev/null 2>&1 || run_as_deploy_user rm -rf "$gate_worktree"
      run_git worktree prune >/dev/null 2>&1 || true
      if ! run_git worktree add --detach --force "$gate_worktree" "$target_ref" >/dev/null 2>&1; then
        log "ERROR: failed to prepare release gate worktree"
        return 1
      fi
      if ! run_as_deploy_user env npm_config_loglevel=error "$NPM_BIN" --prefix "$gate_worktree" ci; then
        log "ERROR: release gate dependency install failed for $target_ref; live checkout was not reset"
        return 1
      fi
      if [ -n "$RELEASE_GATE_ARGS" ]; then
        if run_as_deploy_user env npm_config_loglevel=error "$NPM_BIN" --prefix "$gate_worktree" run verify:cd-preflight -- $RELEASE_GATE_ARGS; then
          log "Release gate passed for $target_ref"
          return 0
        fi
      else
        if run_as_deploy_user env npm_config_loglevel=error "$NPM_BIN" --prefix "$gate_worktree" run verify:cd-preflight; then
          log "Release gate passed for $target_ref"
          return 0
        fi
      fi
      log "ERROR: release gate failed for $target_ref; live checkout was not reset"
      return 1
      ;;
    *)
      log "FATAL: unsupported HAFLEET_RELEASE_GATE='$RELEASE_GATE'"
      exit 1
      ;;
  esac
}

validate_startup() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "FATAL: '$REPO_DIR' is not a git repository"
    exit 1
  fi
  if ! run_git rev-parse --verify "origin/$DEPLOY_BRANCH" >/dev/null 2>&1; then
    log "FATAL: missing remote branch origin/$DEPLOY_BRANCH"
    exit 1
  fi
  if ! [[ "$POLL_SEC" =~ ^[0-9]+$ ]] || [ "$POLL_SEC" -lt 5 ]; then
    log "FATAL: invalid HAFLEET_POLL_SEC='$POLL_SEC' (must be >= 5)"
    exit 1
  fi
  case "$RELEASE_GATE" in
    none|worktree|"") ;;
    *)
      log "FATAL: invalid HAFLEET_RELEASE_GATE='$RELEASE_GATE' (expected none or worktree)"
      exit 1
      ;;
  esac
}

validate_startup
init_deploy_state
log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"
log "Deploy state dir: $DEPLOY_STATE_DIR"
if [ "$RELEASE_GATE" != none ] && [ -n "$RELEASE_GATE" ]; then
  log "Release gate: $RELEASE_GATE"
fi

deploy_pending=false
quarantine_logged=""

while true; do
  if ! run_git fetch origin "$DEPLOY_BRANCH" --quiet; then
    log "WARN: git fetch failed; retry on next poll"
    sleep_or_exit_once
    continue
  fi

  local_ref="$(run_git rev-parse HEAD 2>/dev/null || true)"
  remote_ref="$(run_git rev-parse "origin/$DEPLOY_BRANCH" 2>/dev/null || true)"
  if [ -z "$local_ref" ] || [ -z "$remote_ref" ]; then
    log "WARN: cannot resolve refs (local='$local_ref', remote='$remote_ref')"
    sleep_or_exit_once
    continue
  fi

  # A ref that failed its health gate is quarantined and must not be retried.
  # Clear the quarantine as soon as the branch moves on, so a fix can deploy.
  quarantined_ref="$(read_quarantined_ref || true)"
  if [ -n "$quarantined_ref" ] && [ "$quarantined_ref" != "$remote_ref" ]; then
    log "Deploy branch moved past quarantined ref $quarantined_ref; clearing quarantine"
    clear_quarantine
    quarantined_ref=""
    quarantine_logged=""
  fi
  if [ -n "$quarantined_ref" ] && [ "$quarantined_ref" = "$remote_ref" ]; then
    if [ "$quarantine_logged" != "$quarantined_ref" ]; then
      log "HOLDING: $remote_ref failed its health gate and was rolled back."
      log "         Waiting for a new commit on '$DEPLOY_BRANCH'; this ref will not be retried."
      log "         Failure detail: $DEPLOY_FAILURE_FILE"
      quarantine_logged="$quarantined_ref"
    fi
    sleep_or_exit_once
    continue
  fi

  last_successful_ref="$(read_last_successful_ref || true)"
  install_needed=false
  deploy_incomplete=false
  if has_install_needed; then
    install_needed=true
  fi
  if [ -n "$last_successful_ref" ] && [ "$last_successful_ref" != "$remote_ref" ] && [ "$local_ref" = "$remote_ref" ]; then
    deploy_incomplete=true
  fi

  if [ "$local_ref" = "$remote_ref" ] && [ "$deploy_pending" = false ] && [ "$install_needed" = false ] && [ "$deploy_incomplete" = false ]; then
    sleep_or_exit_once
    continue
  fi

  if [ "$install_needed" = true ] && [ "$local_ref" = "$remote_ref" ]; then
    log "Retrying failed dependency install at $local_ref"
  elif [ "$deploy_incomplete" = true ]; then
    log "Retrying incomplete deploy at $local_ref (last successful $last_successful_ref)"
  elif [ "$deploy_pending" = true ] && [ "$local_ref" = "$remote_ref" ]; then
    log "Retrying failed deploy at $local_ref"
  else
    log "Update detected: $local_ref -> $remote_ref"
  fi

  if ! run_release_gate "$remote_ref"; then
    sleep_or_exit_once
    continue
  fi

  initialize_success_state "$local_ref"
  force_clean_workdir

  if ! run_git reset --hard "origin/$DEPLOY_BRANCH" >/dev/null 2>&1; then
    log "ERROR: git reset --hard failed; retry on next poll"
    sleep_or_exit_once
    continue
  fi

  new_ref="$(run_git rev-parse HEAD)"
  log "Reset to $new_ref"

  install_base_ref="$local_ref"
  force_install=false
  if has_install_needed; then
    install_base_ref="$(read_last_successful_ref || true)"
    [ -n "$install_base_ref" ] || install_base_ref="$local_ref"
    force_install=true
  fi

  if ! maybe_install_deps "$install_base_ref" "$new_ref" "$force_install"; then
    deploy_pending=true
    sleep_or_exit_once
    continue
  fi

  if restart_services; then
    log "Deploy succeeded at commit $new_ref"
    mark_deploy_success "$new_ref"
    clear_quarantine
    deploy_pending=false
  else
    # Health-gate failure is not retryable: the branch has not moved, so
    # retrying re-deploys the same bad commit. Quarantine it and go back to the
    # last ref that was known healthy.
    log "ERROR: service restart/health check failed at commit $new_ref"
    quarantine_ref "$new_ref"
    if rollback_to_last_successful "$new_ref"; then
      record_failure "$new_ref" "health_gate" "succeeded"
      emit_alert "Deploy of $new_ref failed its health gate; rolled back to $(read_last_successful_ref || echo unknown)"
    else
      record_failure "$new_ref" "health_gate" "failed"
      emit_alert "Deploy of $new_ref failed and rollback also failed; manual intervention required"
      log "FATAL: rollback did not restore a healthy state. Manual intervention required."
    fi
    # Not pending: the ref is quarantined, so we wait for a new commit rather
    # than looping on this one.
    deploy_pending=false
  fi

  sleep_or_exit_once
done
