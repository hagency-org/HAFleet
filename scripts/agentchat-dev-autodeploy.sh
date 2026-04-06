#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${AGENTCHAT_DEPLOY_DIR:-/home/shisui/laplace/agent-chat-dev}"
DEPLOY_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-master}"
POLL_SEC="${AGENTCHAT_POLL_SEC:-30}"
DEPLOY_SERVICES="${AGENTCHAT_DEPLOY_SERVICES:-agent-chat-dev-backend.service agent-chat-dev-web.service}"
USER_UID="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${USER_UID}}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

log() {
  printf '[dev-autodeploy] %s\n' "$*"
}

run_git() {
  git -C "$REPO_DIR" "$@"
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
    if ! systemctl --user restart "$service"; then
      log "ERROR: failed to restart service '$service'"
      failed=1
    fi
  done < <(service_list)

  while IFS= read -r service; do
    [ -n "$service" ] || continue
    if ! systemctl --user is-active --quiet "$service"; then
      log "ERROR: service '$service' is not active after restart"
      failed=1
    fi
  done < <(service_list)

  return "$failed"
}

maybe_install_deps() {
  local old_ref="$1"
  local new_ref="$2"
  local changed
  changed="$(run_git diff --name-only "$old_ref" "$new_ref" -- package.json package-lock.json 2>/dev/null || true)"
  if [ -z "$changed" ]; then
    return 0
  fi

  log "Dependency manifest changed; running npm install --omit=dev"
  if ! env npm_config_loglevel=error bash -lc "cd \"$REPO_DIR\" && npm install --omit=dev"; then
    log "ERROR: npm install failed; skipping service restart for this update"
    return 1
  fi
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
log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"

deploy_pending=false

while true; do
  if ! run_git fetch origin "$DEPLOY_BRANCH" --quiet; then
    log "WARN: git fetch failed; retry on next poll"
    sleep "$POLL_SEC"
    continue
  fi

  local_ref="$(run_git rev-parse HEAD 2>/dev/null || true)"
  remote_ref="$(run_git rev-parse "origin/$DEPLOY_BRANCH" 2>/dev/null || true)"
  if [ -z "$local_ref" ] || [ -z "$remote_ref" ]; then
    log "WARN: cannot resolve refs (local='$local_ref', remote='$remote_ref')"
    sleep "$POLL_SEC"
    continue
  fi
  if [ "$local_ref" = "$remote_ref" ] && [ "$deploy_pending" = false ]; then
    sleep "$POLL_SEC"
    continue
  fi

  if [ "$deploy_pending" = true ] && [ "$local_ref" = "$remote_ref" ]; then
    log "Retrying failed deploy at $local_ref"
  else
    log "Update detected: $local_ref -> $remote_ref"
  fi

  force_clean_workdir

  if ! run_git reset --hard "origin/$DEPLOY_BRANCH" >/dev/null 2>&1; then
    log "ERROR: git reset --hard failed; retry on next poll"
    sleep "$POLL_SEC"
    continue
  fi

  new_ref="$(run_git rev-parse HEAD)"
  log "Reset to $new_ref"

  if ! maybe_install_deps "$local_ref" "$new_ref"; then
    deploy_pending=true
    sleep "$POLL_SEC"
    continue
  fi

  if restart_services; then
    log "Deploy succeeded at commit $new_ref"
    deploy_pending=false
  else
    log "ERROR: service restart/health check failed at commit $new_ref — will retry next poll"
    deploy_pending=true
  fi

  sleep "$POLL_SEC"
done
