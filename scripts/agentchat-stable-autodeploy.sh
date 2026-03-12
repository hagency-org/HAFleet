#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${AGENTCHAT_LIVE_DIR:-${AGENT_CHAT_LIVE_ROOT:-${AGENT_CHAT_ROOT:-$DEFAULT_REPO_DIR}}}"
DEPLOY_USER="${AGENTCHAT_DEPLOY_USER:-shisui}"
DEPLOY_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-stable}"
POLL_SEC="${AGENTCHAT_POLL_SEC:-30}"
DEPLOY_SERVICES="${AGENTCHAT_DEPLOY_SERVICES:-agent-chat agent-chat-v2 bridge-matrix}"

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

service_list() {
  local s
  for s in $DEPLOY_SERVICES; do
    [ -n "$s" ] && printf '%s\n' "$s"
  done
}

BACKEND_SERVICE="${AGENTCHAT_BACKEND_SERVICE:-agent-chat-v2}"
BACKEND_HEALTH_URL="${AGENTCHAT_BACKEND_HEALTH_URL:-http://127.0.0.1:8090/api/agents}"
BACKEND_HEALTH_TIMEOUT="${AGENTCHAT_BACKEND_HEALTH_TIMEOUT:-30}"

wait_for_backend() {
  local i
  log "Waiting up to ${BACKEND_HEALTH_TIMEOUT}s for backend health..."
  for i in $(seq "$BACKEND_HEALTH_TIMEOUT"); do
    if curl -sf "$BACKEND_HEALTH_URL" >/dev/null 2>&1; then
      log "Backend healthy after ${i}s"
      return 0
    fi
    sleep 1
  done
  log "ERROR: backend not healthy after ${BACKEND_HEALTH_TIMEOUT}s"
  return 1
}

restart_services() {
  local failed=0

  # 1. Restart backend first
  log "Restarting backend ($BACKEND_SERVICE)..."
  if ! systemctl restart "$BACKEND_SERVICE"; then
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
    if ! systemctl restart "$s"; then
      log "ERROR: failed to restart service '$s'"
      failed=1
    fi
  done < <(service_list)

  # 4. Verify all services are active
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    if ! systemctl is-active --quiet "$s"; then
      log "ERROR: service '$s' is not active after restart"
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

  log "Dependency manifest changed; running npm install --production"
  if ! run_as_deploy_user env npm_config_loglevel=error bash -lc "cd \"$REPO_DIR\" && npm install --production"; then
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

validate_startup
log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"

while true; do
  if ! run_git fetch origin "$DEPLOY_BRANCH" --quiet; then
    log "WARN: git fetch failed; retry on next poll"
    sleep "$POLL_SEC"
    continue
  fi

  if ! run_git checkout -q "$DEPLOY_BRANCH"; then
    log "WARN: cannot checkout '$DEPLOY_BRANCH'; retry on next poll"
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
  if [ "$local_ref" = "$remote_ref" ]; then
    sleep "$POLL_SEC"
    continue
  fi

  dirty="$(run_git status --porcelain)"
  if [ -n "$dirty" ]; then
    log "WARN: working tree is dirty; skip deploy this round"
    sleep "$POLL_SEC"
    continue
  fi

  log "Update detected: $local_ref -> $remote_ref"
  if ! run_git pull --ff-only origin "$DEPLOY_BRANCH"; then
    log "ERROR: git pull failed; skip this round"
    sleep "$POLL_SEC"
    continue
  fi

  new_ref="$(run_git rev-parse HEAD)"
  if ! maybe_install_deps "$local_ref" "$new_ref"; then
    sleep "$POLL_SEC"
    continue
  fi

  if restart_services; then
    log "Deploy succeeded at commit $new_ref"
  else
    log "ERROR: service restart/health check failed at commit $new_ref"
  fi

  sleep "$POLL_SEC"
done
