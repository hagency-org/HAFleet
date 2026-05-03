#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${AGENTCHAT_DEPLOY_DIR:?AGENTCHAT_DEPLOY_DIR must be set}"
DEPLOY_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-master}"
POLL_SEC="${AGENTCHAT_POLL_SEC:-30}"
DEPLOY_SERVICES="${AGENTCHAT_DEPLOY_SERVICES:-agent-chat-dev-backend.service agent-chat-dev-web.service}"
ONCE="${AGENTCHAT_ONCE:-false}"
SYSTEMCTL_BIN="${AGENTCHAT_SYSTEMCTL_BIN:-systemctl}"
SLEEP_BIN="${AGENTCHAT_SLEEP_BIN:-sleep}"
NPM_BIN="${AGENTCHAT_NPM_BIN:-npm}"
DEPLOY_STATE_DIR="${AGENTCHAT_DEPLOY_STATE_DIR:-}"
INSTALL_NEEDED_FILE=""
USER_UID="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${USER_UID}}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

log() {
  printf '[dev-autodeploy] %s\n' "$*"
}

run_git() {
  git -C "$REPO_DIR" "$@"
}

run_systemctl() {
  "$SYSTEMCTL_BIN" "$@"
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
  local service
  for service in $DEPLOY_SERVICES; do
    [ -n "$service" ] && printf '%s\n' "$service"
  done
}

restart_services() {
  local service
  local failed=0
  while IFS= read -r service; do
    [ -n "$service" ] || continue
    if ! run_systemctl --user restart "$service"; then
      log "ERROR: failed to restart service '$service'"
      failed=1
    fi
  done < <(service_list)

  while IFS= read -r service; do
    [ -n "$service" ] || continue
    if ! run_systemctl --user is-active --quiet "$service"; then
      log "ERROR: service '$service' is not active after restart"
      failed=1
    fi
  done < <(service_list)

  return "$failed"
}

init_deploy_state() {
  if [ -z "$DEPLOY_STATE_DIR" ]; then
    DEPLOY_STATE_DIR="$(run_git rev-parse --absolute-git-dir)/agentchat-dev-autodeploy"
  fi
  INSTALL_NEEDED_FILE="$DEPLOY_STATE_DIR/install-needed"
}

ensure_deploy_state_dir() {
  mkdir -p "$DEPLOY_STATE_DIR"
}

touch_state_file() {
  local file="$1"
  ensure_deploy_state_dir
  touch "$file"
}

remove_state_file() {
  local file="$1"
  rm -f "$file"
}

has_install_needed() {
  [ -f "$INSTALL_NEEDED_FILE" ]
}

run_npm_install() {
  env npm_config_loglevel=error "$NPM_BIN" --prefix "$REPO_DIR" install --omit=dev
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
    log "Dependency install retry marker present; running npm install --omit=dev"
  else
    log "Dependency manifest changed; running npm install --omit=dev"
  fi
  touch_state_file "$INSTALL_NEEDED_FILE"
  if ! run_npm_install; then
    log "ERROR: npm install failed; skipping service restart for this update"
    return 1
  fi
  remove_state_file "$INSTALL_NEEDED_FILE"
  return 0
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
    log "FATAL: invalid AGENTCHAT_POLL_SEC='$POLL_SEC' (must be >= 5)"
    exit 1
  fi
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

validate_startup
init_deploy_state
log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"
log "Deploy state dir: $DEPLOY_STATE_DIR"

deploy_pending=false

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

  install_needed=false
  if has_install_needed; then
    install_needed=true
  fi

  if [ "$local_ref" = "$remote_ref" ] && [ "$deploy_pending" = false ] && [ "$install_needed" = false ]; then
    sleep_or_exit_once
    continue
  fi

  if [ "$install_needed" = true ] && [ "$local_ref" = "$remote_ref" ]; then
    log "Retrying failed dependency install at $local_ref"
  elif [ "$deploy_pending" = true ] && [ "$local_ref" = "$remote_ref" ]; then
    log "Retrying failed deploy at $local_ref"
  else
    log "Update detected: $local_ref -> $remote_ref"
  fi

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
    force_install=true
  fi

  if ! maybe_install_deps "$install_base_ref" "$new_ref" "$force_install"; then
    deploy_pending=true
    sleep_or_exit_once
    continue
  fi

  if restart_services; then
    log "Deploy succeeded at commit $new_ref"
    deploy_pending=false
  else
    log "ERROR: service restart/health check failed at commit $new_ref — will retry next poll"
    deploy_pending=true
  fi

  sleep_or_exit_once
done
