#!/usr/bin/env bash
# Upgrade a HAFleet install to a tagged release, reverting automatically if the
# new version does not come up healthy.
#
# The auto-deploy watcher does this continuously for the deploy branch; this is
# the operator-driven equivalent for pinned releases, and it is the supported
# path for hosts that do not run the watcher.
#
# Usage:
#   ./upgrade.sh --to v1.3.0
#   ./upgrade.sh --to v1.3.0 --dry-run
#   ./upgrade.sh --list
#
# Options:
#   --to REF          Tag, branch or commit to upgrade to (required unless --list)
#   --list            Show the current version and available tags, then exit
#   --dry-run         Print the plan without changing anything
#   --no-rollback     Do not revert on failure (leaves the host broken; for debugging)
#   --services "A B"  Services to restart (default: agent-chat-v2 agent-chat agent-chat-push-relay)
#   --skip-gate       Skip the pre-upgrade verify:ci gate
#   --yes             Do not prompt for confirmation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AGENTCHAT_INSTALL_DIR:-$SCRIPT_DIR}"

TARGET_REF=""
DO_LIST=false
DRY_RUN=false
ALLOW_ROLLBACK=true
SKIP_GATE=false
ASSUME_YES=false
SERVICES="${AGENTCHAT_UPGRADE_SERVICES:-agent-chat-v2 agent-chat agent-chat-push-relay}"
BACKEND_SERVICE="${AGENTCHAT_BACKEND_SERVICE:-agent-chat-v2}"
HEALTH_URL="${AGENTCHAT_BACKEND_HEALTH_URL:-http://127.0.0.1:8090/api/agents}"
HEALTH_TIMEOUT="${AGENTCHAT_BACKEND_HEALTH_TIMEOUT:-30}"
SYSTEMCTL_BIN="${AGENTCHAT_SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${AGENTCHAT_CURL_BIN:-curl}"
NPM_BIN="${AGENTCHAT_NPM_BIN:-npm}"

log()  { printf '[upgrade] %s\n' "$*"; }
die()  { printf '[upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[upgrade] [dry-run] %s\n' "$(printf '%q ' "$@")"
    return 0
  fi
  "$@"
}

usage() { sed -n '2,23p' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET_REF="${2:?--to requires a ref}"; shift 2 ;;
    --list) DO_LIST=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-rollback) ALLOW_ROLLBACK=false; shift ;;
    --skip-gate) SKIP_GATE=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --services) SERVICES="${2:?--services requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

cd "$INSTALL_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || die "$INSTALL_DIR is not a git checkout"

current_release() {
  node -e 'process.stdout.write(require("./package.json").version||"unknown")' 2>/dev/null || echo unknown
}

if [ "$DO_LIST" = true ]; then
  log "Current: $(current_release) ($(git rev-parse --short HEAD))"
  log "Fetching tags..."
  git fetch --tags --quiet || log "WARN: fetch failed; showing local tags only"
  log "Available releases:"
  git tag --list 'v*' --sort=-v:refname | head -20 | sed 's/^/  /'
  exit 0
fi

[ -n "$TARGET_REF" ] || die "--to is required (or use --list)"

# --- Preflight ---------------------------------------------------------------
# A dirty tree cannot be restored reliably, so refuse rather than risk losing
# local changes during a revert.
if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty; commit, stash or clean it before upgrading"
fi

SNAPSHOT_REF="$(git rev-parse HEAD)"
SNAPSHOT_SHORT="$(git rev-parse --short HEAD)"

log "Fetching..."
run git fetch --tags --prune origin || die "git fetch failed"

if ! TARGET_SHA="$(git rev-parse --verify "${TARGET_REF}^{commit}" 2>/dev/null)"; then
  die "cannot resolve '$TARGET_REF' (try --list)"
fi

if [ "$TARGET_SHA" = "$SNAPSHOT_REF" ]; then
  log "Already at $TARGET_REF ($SNAPSHOT_SHORT). Nothing to do."
  exit 0
fi

log "Plan:"
log "  from:     $(current_release) ($SNAPSHOT_SHORT)"
log "  to:       $TARGET_REF ($(git rev-parse --short "$TARGET_SHA"))"
log "  services: $SERVICES"
log "  rollback: $([ "$ALLOW_ROLLBACK" = true ] && echo 'automatic on failure' || echo 'DISABLED')"

if [ "$DRY_RUN" = false ] && [ "$ASSUME_YES" = false ]; then
  if [ -t 0 ]; then
    printf '[upgrade] Proceed? [y/N] '
    IFS= read -r reply
    case "$reply" in y|Y|yes|YES) ;; *) die "aborted" ;; esac
  else
    die "refusing to upgrade non-interactively without --yes"
  fi
fi

# --- Helpers -----------------------------------------------------------------
wait_for_backend() {
  local i
  log "Waiting up to ${HEALTH_TIMEOUT}s for backend health..."
  for i in $(seq "$HEALTH_TIMEOUT"); do
    if "$CURL_BIN" -sf "$HEALTH_URL" >/dev/null 2>&1; then
      log "Backend healthy after ${i}s"
      return 0
    fi
    sleep 1
  done
  log "ERROR: backend not healthy after ${HEALTH_TIMEOUT}s"
  return 1
}

systemctl_run() {
  if [ "$(id -u)" = "0" ] || [ -n "${AGENTCHAT_SYSTEMCTL_BIN:-}" ] || ! command -v sudo >/dev/null 2>&1; then
    "$SYSTEMCTL_BIN" "$@"
  else
    sudo "$SYSTEMCTL_BIN" "$@"
  fi
}

restart_and_verify() {
  local failed=0 s
  log "Restarting backend ($BACKEND_SERVICE)..."
  systemctl_run restart "$BACKEND_SERVICE" || { log "ERROR: backend restart failed"; return 1; }
  wait_for_backend || return 1
  for s in $SERVICES; do
    [ "$s" = "$BACKEND_SERVICE" ] && continue
    log "Restarting $s..."
    systemctl_run restart "$s" || { log "ERROR: restart failed: $s"; failed=1; }
  done
  for s in $SERVICES; do
    systemctl_run is-active --quiet "$s" || { log "ERROR: not active: $s"; failed=1; }
  done
  return "$failed"
}

apply_ref() {
  local ref="$1"
  run git -c advice.detachedHead=false checkout --force "$ref" || return 1
  # --production keeps devDependencies out of a deployed host.
  run "$NPM_BIN" --prefix "$INSTALL_DIR" install --production || return 1
  return 0
}

rollback() {
  log ""
  log "=== ROLLING BACK to $SNAPSHOT_SHORT ==="
  if ! apply_ref "$SNAPSHOT_REF"; then
    log "FATAL: could not restore $SNAPSHOT_SHORT. Host is in an inconsistent state."
    log "       Recover manually:  git checkout --force $SNAPSHOT_REF && npm install --production"
    return 1
  fi
  if restart_and_verify; then
    log "Rollback to $SNAPSHOT_SHORT succeeded; services healthy."
    return 0
  fi
  log "FATAL: restored $SNAPSHOT_SHORT but services are still unhealthy."
  return 1
}

# --- Gate --------------------------------------------------------------------
if [ "$SKIP_GATE" = false ]; then
  log "Running pre-upgrade gate on the target ref..."
  # Gate the candidate, not the current checkout: build it in a throwaway
  # worktree so a failing target never touches the live tree.
  GATE_DIR="$(mktemp -d)"
  trap 'rm -rf "$GATE_DIR"; git worktree prune >/dev/null 2>&1 || true' EXIT
  if [ "$DRY_RUN" = false ]; then
    git worktree add --detach --force "$GATE_DIR/tree" "$TARGET_SHA" >/dev/null 2>&1 \
      || die "could not create gate worktree"
    ( cd "$GATE_DIR/tree" \
      && "$NPM_BIN" ci --loglevel=error >/dev/null \
      && "$NPM_BIN" run verify:ci ) \
      || die "target ref $TARGET_REF failed verify:ci; live checkout untouched"
    git worktree remove --force "$GATE_DIR/tree" >/dev/null 2>&1 || true
    log "Gate passed."
  else
    log "[dry-run] would gate $TARGET_REF in a throwaway worktree"
  fi
fi

# --- Apply -------------------------------------------------------------------
log ""
log "=== UPGRADING to $TARGET_REF ==="
if ! apply_ref "$TARGET_SHA"; then
  log "ERROR: failed to apply $TARGET_REF"
  [ "$ALLOW_ROLLBACK" = true ] && { rollback || exit 2; exit 1; }
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  log "[dry-run] would restart and health-gate: $SERVICES"
  log "[dry-run] complete; nothing was changed."
  exit 0
fi

if restart_and_verify; then
  log ""
  log "Upgrade complete: $(current_release) ($(git rev-parse --short HEAD))"
  exit 0
fi

log "ERROR: $TARGET_REF did not come up healthy."
if [ "$ALLOW_ROLLBACK" = false ]; then
  log "--no-rollback was set; leaving the host on the failed version."
  exit 1
fi
rollback || exit 2
log "Upgrade aborted; host is back on $SNAPSHOT_SHORT."
exit 1
