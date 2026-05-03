#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${AGENT_CHAT_HOME:-${AGENT_CHAT_ROOT:-$DEFAULT_REPO_DIR}}"
DEPLOY_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-stable}"
POLL_SEC="${AGENTCHAT_POLL_SEC:-60}"
RELAY_SERVICE="${AGENTCHAT_RELAY_SERVICE:-agent-chat-push-relay}"
ONCE="${AGENTCHAT_ONCE:-false}"
GIT_BIN="${AGENTCHAT_GIT_BIN:-git}"
NPM_BIN="${AGENTCHAT_NPM_BIN:-npm}"
SYSTEMCTL_BIN="${AGENTCHAT_SYSTEMCTL_BIN:-systemctl}"
LAUNCHCTL_BIN="${AGENTCHAT_LAUNCHCTL_BIN:-launchctl}"
SUDO_BIN="${AGENTCHAT_SUDO_BIN:-sudo}"
SLEEP_BIN="${AGENTCHAT_SLEEP_BIN:-sleep}"
DEPLOY_STATE_DIR="${AGENTCHAT_DEPLOY_STATE_DIR:-}"
INSTALL_NEEDED_FILE=""

log() {
  printf '[remote-autodeploy] %s\n' "$*"
}

run_git() {
  "$GIT_BIN" -C "$REPO_DIR" "$@"
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

init_deploy_state() {
  if [ -z "$DEPLOY_STATE_DIR" ]; then
    DEPLOY_STATE_DIR="$(run_git rev-parse --absolute-git-dir)/agentchat-remote-autodeploy"
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
  local remote_dir="$REPO_DIR/remote"
  if [ ! -d "$remote_dir" ]; then
    log "ERROR: missing remote runtime directory: $remote_dir"
    return 1
  fi
  if [ "$NPM_BIN" = npm ]; then
    (cd "$remote_dir" && npm install --omit=dev)
  else
    (cd "$remote_dir" && env npm_config_loglevel=error "$NPM_BIN" install --omit=dev)
  fi
}

maybe_install_deps() {
  local old_ref="$1" new_ref="$2" force_install="${3:-false}"
  local changed
  changed="$(run_git diff --name-only "$old_ref" "$new_ref" -- remote/package.json remote/package-lock.json 2>/dev/null || true)"
  if [ -z "$changed" ] && [ "$force_install" != true ]; then
    return 0
  fi

  if [ "$force_install" = true ] && [ -z "$changed" ]; then
    log "Remote dependency install retry marker present; running npm install --omit=dev in remote/"
  else
    log "Remote dependency manifest changed; running npm install --omit=dev in remote/"
  fi
  touch_state_file "$INSTALL_NEEDED_FILE"
  if ! run_npm_install; then
    log "ERROR: npm install failed; skipping restart for this update"
    return 1
  fi
  remove_state_file "$INSTALL_NEEDED_FILE"
  return 0
}

restart_relay() {
  log "Restarting $RELAY_SERVICE..."
  if command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 && "$SYSTEMCTL_BIN" list-units --type=service --all 2>/dev/null | grep -qF "$RELAY_SERVICE"; then
    "$SUDO_BIN" "$SYSTEMCTL_BIN" restart "$RELAY_SERVICE"
  elif command -v "$LAUNCHCTL_BIN" >/dev/null 2>&1; then
    "$LAUNCHCTL_BIN" kickstart -k "gui/$(id -u)/$RELAY_SERVICE" 2>/dev/null \
      || "$LAUNCHCTL_BIN" kickstart -k "user/$(id -u)/$RELAY_SERVICE" 2>/dev/null \
      || { log "WARN: launchctl kickstart failed"; return 1; }
  else
    log "ERROR: no service manager found"
    return 1
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

# Validate startup
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

init_deploy_state
log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"
log "Deploy state dir: $DEPLOY_STATE_DIR"

deploy_pending=false

while true; do
  if ! run_git fetch origin "$DEPLOY_BRANCH" --quiet 2>/dev/null; then
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

  force_install=false
  if has_install_needed; then
    force_install=true
  fi

  if ! maybe_install_deps "$local_ref" "$new_ref" "$force_install"; then
    deploy_pending=true
    sleep_or_exit_once
    continue
  fi

  if restart_relay; then
    log "Deploy succeeded at commit $new_ref"
    deploy_pending=false
  else
    log "ERROR: relay restart failed at commit $new_ref — will retry next poll"
    deploy_pending=true
  fi

  sleep_or_exit_once
done
