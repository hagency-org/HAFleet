#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${AGENT_CHAT_HOME:-${AGENT_CHAT_ROOT:-$DEFAULT_REPO_DIR}}"
DEPLOY_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-stable}"
POLL_SEC="${AGENTCHAT_POLL_SEC:-60}"
RELAY_SERVICE="${AGENTCHAT_RELAY_SERVICE:-agent-chat-push-relay}"

log() {
  printf '[remote-autodeploy] %s\n' "$*"
}

maybe_install_deps() {
  local old_ref="$1" new_ref="$2"
  local changed
  changed="$(git -C "$REPO_DIR" diff --name-only "$old_ref" "$new_ref" -- package.json package-lock.json 2>/dev/null || true)"
  [ -z "$changed" ] && return 0
  log "Dependency manifest changed; running npm install --omit=dev"
  if ! (cd "$REPO_DIR" && npm install --omit=dev); then
    log "ERROR: npm install failed; skipping restart for this update"
    return 1
  fi
}

restart_relay() {
  log "Restarting $RELAY_SERVICE..."
  if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all 2>/dev/null | grep -qF "$RELAY_SERVICE"; then
    sudo systemctl restart "$RELAY_SERVICE"
  elif command -v launchctl >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$RELAY_SERVICE" 2>/dev/null \
      || launchctl kickstart -k "user/$(id -u)/$RELAY_SERVICE" 2>/dev/null \
      || { log "WARN: launchctl kickstart failed"; return 1; }
  else
    log "ERROR: no service manager found"
    return 1
  fi
}

force_clean_workdir() {
  local dirty
  dirty="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    log "WARN: dirty working tree detected (deploy dir should be clean):"
    printf '%s\n' "$dirty" | head -20 | while IFS= read -r line; do log "  $line"; done
    log "Cleaning: git reset --hard + git clean -fd"
    git -C "$REPO_DIR" reset --hard HEAD >/dev/null 2>&1 || true
    git -C "$REPO_DIR" clean -fd >/dev/null 2>&1 || true
  fi
}

# Validate startup
if [ ! -d "$REPO_DIR/.git" ]; then
  log "FATAL: '$REPO_DIR' is not a git repository"
  exit 1
fi
if ! git -C "$REPO_DIR" rev-parse --verify "origin/$DEPLOY_BRANCH" >/dev/null 2>&1; then
  log "FATAL: missing remote branch origin/$DEPLOY_BRANCH"
  exit 1
fi
if ! [[ "$POLL_SEC" =~ ^[0-9]+$ ]] || [ "$POLL_SEC" -lt 5 ]; then
  log "FATAL: invalid AGENTCHAT_POLL_SEC='$POLL_SEC' (must be >= 5)"
  exit 1
fi

log "Watching '$REPO_DIR' branch '$DEPLOY_BRANCH' every ${POLL_SEC}s"

deploy_pending=false

while true; do
  if ! git -C "$REPO_DIR" fetch origin "$DEPLOY_BRANCH" --quiet 2>/dev/null; then
    log "WARN: git fetch failed; retry on next poll"
    sleep "$POLL_SEC"
    continue
  fi

  local_ref="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  remote_ref="$(git -C "$REPO_DIR" rev-parse "origin/$DEPLOY_BRANCH" 2>/dev/null || true)"
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

  if ! git -C "$REPO_DIR" reset --hard "origin/$DEPLOY_BRANCH" >/dev/null 2>&1; then
    log "ERROR: git reset --hard failed; retry on next poll"
    sleep "$POLL_SEC"
    continue
  fi

  new_ref="$(git -C "$REPO_DIR" rev-parse HEAD)"
  log "Reset to $new_ref"

  if ! maybe_install_deps "$local_ref" "$new_ref"; then
    deploy_pending=true
    sleep "$POLL_SEC"
    continue
  fi

  if restart_relay; then
    log "Deploy succeeded at commit $new_ref"
    deploy_pending=false
  else
    log "ERROR: relay restart failed at commit $new_ref — will retry next poll"
    deploy_pending=true
  fi

  sleep "$POLL_SEC"
done
