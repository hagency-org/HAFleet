#!/usr/bin/env bash
# HAFleet installer for macOS.
#
# install-full.sh is Linux-only: it renders systemd units, which macOS has no
# equivalent for. Before this script, installing on a Mac meant doing it by hand
# — brew, npm install, hand-built .env, then the supervisor. That is now
# scripted, which matters because HAFleet fleets are commonly Mac minis.
#
# Differences from the Linux install, all deliberate:
#   - launchd user agent instead of systemd system units
#   - services/agentchat-services.mjs supervises the processes, not systemd
#   - the Matrix bridge is OFF by default (--with-bridge to include it)
#   - no auto-deploy watcher (Linux only; tracked as CD-003)
#
# Usage:
#   ./install/install-macos.sh
#   ./install/install-macos.sh --dry-run
#   ./install/install-macos.sh --with-bridge --yes
#
# Options:
#   --dry-run          Print every action, change nothing
#   --yes, -y          Do not prompt (requires API_TOKEN in env or .env)
#   --with-bridge      Include the Matrix bridge in the service profile
#   --no-start         Install and configure, but do not start services
#   --skip-brew        Do not install prerequisites; fail if any are missing
#   --skip-mcp         Do not register the MCP server with Claude Code / Codex
#   --bin-dir PATH     Where to link CLI commands (default: ~/.local/bin)
#   --allow-existing-tmux  Proceed even if unrelated tmux sessions are present
#   --deny-existing-tmux   Proceed, but add the existing sessions to
#                          AGENT_CHAT_SESSION_DENYLIST so HAFleet leaves them alone
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
ASSUME_YES=false
WITH_BRIDGE=false
NO_START=false
SKIP_BREW=false
SKIP_MCP=false
ALLOW_EXISTING_TMUX=false
DENY_EXISTING_TMUX=false
EXISTING_TMUX_SESSIONS=""
BIN_DIR="${HOME}/.local/bin"
ENV_FILE="$INSTALL_DIR/.env"
PROFILE_FILE="$INSTALL_DIR/services-macos.json"
SERVICE_NAME="io.hafleet.services"
PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
RUNNER="$INSTALL_DIR/.hafleet-launchd.sh"
LAUNCHD_DOMAIN="gui/$(id -u)"
MIN_NODE_MAJOR=22

log() { printf '[install-macos] %s\n' "$*"; }
die() { printf '[install-macos] ERROR: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[install-macos] [dry-run] %s\n' "$(printf '%q ' "$@")"
    return 0
  fi
  "$@"
}

usage() { sed -n '2,29p' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --with-bridge) WITH_BRIDGE=true; shift ;;
    --no-start) NO_START=true; shift ;;
    --skip-brew) SKIP_BREW=true; shift ;;
    --skip-mcp) SKIP_MCP=true; shift ;;
    --allow-existing-tmux) ALLOW_EXISTING_TMUX=true; shift ;;
    --deny-existing-tmux) DENY_EXISTING_TMUX=true; shift ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# --- Platform ----------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS; on Linux use ./install-full.sh"

log "=== HAFleet macOS installer ==="
log "Install dir: $INSTALL_DIR"
log "Bin dir:     $BIN_DIR"
log "Profile:     $([ "$WITH_BRIDGE" = true ] && echo 'backend, dashboard, relay, bridge' || echo 'backend, dashboard, relay')"

# --- Prerequisites -----------------------------------------------------------
node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null
}

brew_bin() {
  command -v brew 2>/dev/null && return 0
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

check_prereqs() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v tmux >/dev/null 2>&1 || missing+=(tmux)

  local major
  if major="$(node_major)"; then
    if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
      die "node $major is too old; HAFleet needs >= $MIN_NODE_MAJOR (brew upgrade node)"
    fi
    log "node: v$(node -v | tr -d v) (ok)"
  else
    missing+=(node)
  fi

  [ "${#missing[@]}" -eq 0 ] && { log "All prerequisites present."; return 0; }

  log "Missing prerequisites: ${missing[*]}"
  if [ "$SKIP_BREW" = true ]; then
    die "--skip-brew was set; install ${missing[*]} manually and re-run"
  fi

  local brew
  brew="$(brew_bin)" || die "Homebrew not found; install it from https://brew.sh then re-run"
  log "Installing with $brew: ${missing[*]}"
  run "$brew" install "${missing[@]}" || die "brew install failed"

  # brew's prefix may not be on PATH in this shell.
  export PATH="$(dirname "$brew"):$PATH"
  if [ "$DRY_RUN" = false ]; then
    command -v node >/dev/null 2>&1 || die "node still not on PATH after install"
    command -v tmux >/dev/null 2>&1 || die "tmux still not on PATH after install"
  fi
}

# --- tmux safety -------------------------------------------------------------
# HAFleet discovers tmux sessions and registers them as agents; the push relay
# then delivers by typing into those panes with `tmux send-keys`. On a machine
# that already has unrelated tmux sessions, that means HAFleet can type into
# someone else's work. Observed for real: a fresh install claimed five
# pre-existing sessions on a fleet host.
check_existing_tmux() {
  command -v tmux >/dev/null 2>&1 || return 0
  local sessions
  sessions="$(tmux ls 2>/dev/null | cut -d: -f1 || true)"
  [ -n "$sessions" ] || { log "No pre-existing tmux sessions."; return 0; }
  # Kept for apply_session_denylist, which runs after .env exists.
  EXISTING_TMUX_SESSIONS="$(printf '%s\n' "$sessions" | paste -sd, - | tr -d ' ')"

  local count
  count="$(printf '%s\n' "$sessions" | grep -c . | tr -d ' ')"
  log ""
  log "WARNING: $count existing tmux session(s) on this host:"
  printf '%s\n' "$sessions" | sed 's/^/           /'
  log ""
  log "  HAFleet registers tmux sessions as agents, and the push relay delivers"
  log "  messages by typing into their panes. These sessions would become"
  log "  addressable, and anything sent to them would be typed into whatever is"
  log "  running there."
  log ""
  log "  Either stop or rename them first, pass --deny-existing-tmux to have"
  log "  HAFleet ignore exactly these sessions, or pass --allow-existing-tmux to"
  log "  accept the risk and manage them."
  log ""

  if [ "$DENY_EXISTING_TMUX" = true ]; then
    log "--deny-existing-tmux set; these sessions will be excluded by policy."
    return 0
  fi
  [ "$ALLOW_EXISTING_TMUX" = true ] && { log "--allow-existing-tmux set; continuing."; return 0; }
  [ "$DRY_RUN" = true ] && { log "[dry-run] would prompt for confirmation here"; return 0; }

  if [ "$ASSUME_YES" = true ]; then
    die "refusing to continue with existing tmux sessions under --yes; pass --deny-existing-tmux to exclude them, or --allow-existing-tmux to accept the risk"
  fi
  if [ ! -t 0 ]; then
    die "existing tmux sessions and no TTY to confirm; pass --deny-existing-tmux to exclude them, or --allow-existing-tmux to accept the risk"
  fi
  printf '[install-macos] Continue anyway? [y/N] '
  IFS= read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted" ;; esac
}

# --- Environment -------------------------------------------------------------
read_env_value() {
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

set_env_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  else
    cat "$ENV_FILE" > "$tmp" 2>/dev/null || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

placeholder() {
  case "${1:-}" in
    ""|your-api-token-here|changeme|CHANGEME) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$INSTALL_DIR/.env.example" ] || die "missing .env.example"
    run cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    run chmod 0600 "$ENV_FILE"
    log "Created .env from .env.example"
  fi
  [ "$DRY_RUN" = true ] && return 0

  local token
  token="$(read_env_value API_TOKEN)"
  if placeholder "$token"; then
    local supplied="${API_TOKEN:-}"
    if placeholder "$supplied"; then
      if [ -t 0 ] && [ "$ASSUME_YES" = false ]; then
        printf '[install-macos] Enter API_TOKEN (blank to generate): '
        IFS= read -r supplied
      fi
      placeholder "$supplied" && {
        supplied="$(openssl rand -hex 24)"
        log "Generated a random API_TOKEN"
      }
    fi
    set_env_value API_TOKEN "$supplied"
    log "Set API_TOKEN in .env"
  else
    log "API_TOKEN already configured."
  fi

  if [ "$WITH_BRIDGE" = true ]; then
    # Same reasoning as install-full.sh: the shared secret can be minted, the
    # bot password cannot — it authenticates against a real homeserver account.
    local secret bot
    secret="$(read_env_value MATRIX_BRIDGE_SECRET)"
    if placeholder "$secret"; then
      set_env_value MATRIX_BRIDGE_SECRET "$(openssl rand -hex 32)"
      log "Generated MATRIX_BRIDGE_SECRET"
    fi
    bot="$(read_env_value MATRIX_BOT_PASSWORD)"
    if placeholder "$bot"; then
      die "$(printf '%s\n' \
        "--with-bridge needs MATRIX_BOT_PASSWORD in .env." \
        "  The bridge logs in as its bot account on your homeserver; there is" \
        "  nothing to generate. Set MATRIX_HOMESERVER, MATRIX_SERVER_NAME," \
        "  MATRIX_BOT_USERNAME and MATRIX_BOT_PASSWORD, then re-run." \
        "  Or drop --with-bridge to install without Matrix.")"
    fi
  fi
}

# --- Service profile ---------------------------------------------------------
# The profile loader requires it to live inside the repo and be named
# services-local. The bridge is optional (src/service-profile.mjs).
write_profile() {
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would write $PROFILE_FILE"
    return 0
  fi
  WITH_BRIDGE="$WITH_BRIDGE" node -e '
    const fs = require("fs");
    const base = JSON.parse(fs.readFileSync("services/services-local.json", "utf8"));
    const withBridge = process.env.WITH_BRIDGE === "true";
    if (!withBridge) base.services = base.services.filter((s) => s.name !== "bridge");
    fs.writeFileSync(process.argv[1], `${JSON.stringify(base, null, 2)}\n`);
    console.log("[install-macos] Profile services: " + base.services.map((s) => s.name).join(", "));
  ' "$PROFILE_FILE"
}

install_dependencies() {
  ( cd "$INSTALL_DIR" && run npm install --no-audit --no-fund ) || die "npm install failed"
}

link_cli_commands() {
  run mkdir -p "$BIN_DIR"
  local source target name
  for source in "$INSTALL_DIR"/bin/*; do
    [ -f "$source" ] && [ -x "$source" ] || continue
    name="$(basename "$source")"
    target="$BIN_DIR/$name"
    if [ -e "$target" ] && [ ! -L "$target" ]; then
      log "Skipping $name: $target exists and is not a symlink"
      continue
    fi
    run ln -snf "$source" "$target"
  done
  log "Linked CLI commands into $BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) log "NOTE: $BIN_DIR is not on PATH; add it to your shell profile." ;;
  esac
}

# --- launchd -----------------------------------------------------------------
# launchd runs a small wrapper rather than node directly: it must source .env
# (the supervisor deliberately does not auto-load it) and put brew's prefix on
# PATH, since launchd jobs start with a minimal environment.
write_launchd() {
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would write $RUNNER and $PLIST"
    return 0
  fi

  cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
# Generated by install/install-macos.sh — do not edit; re-run the installer.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
cd "$INSTALL_DIR"
set -a; . "$ENV_FILE"; set +a
export AGENT_CHAT_RUNTIME_DIR="$INSTALL_DIR"
exec node services/agentchat-services.mjs run --profile "$PROFILE_FILE" --runtime "$INSTALL_DIR"
EOF
  chmod 0755 "$RUNNER"

  mkdir -p "$HOME/Library/LaunchAgents" "$INSTALL_DIR/logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${RUNNER}</string></array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/logs/launchd.err.log</string>
</dict>
</plist>
EOF
  log "Wrote launchd agent $PLIST"
}

start_launchd() {
  [ "$DRY_RUN" = false ] || { log "[dry-run] would bootstrap $SERVICE_NAME"; return 0; }
  # Clear any prior instance in either domain to avoid duplicate jobs.
  for domain in "$LAUNCHD_DOMAIN" "user/$(id -u)"; do
    launchctl bootout "$domain/$SERVICE_NAME" >/dev/null 2>&1 || true
  done
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST" 2>/dev/null \
    || launchctl load -w "$PLIST" 2>/dev/null \
    || die "could not load $SERVICE_NAME; check $PLIST"
  launchctl kickstart -k "$LAUNCHD_DOMAIN/$SERVICE_NAME" >/dev/null 2>&1 || true
  log "Loaded $SERVICE_NAME"
}

# --- MCP ---------------------------------------------------------------------
configure_mcp() {
  [ "$SKIP_MCP" = false ] || { log "Skipping MCP registration."; return 0; }
  local token
  token="$(read_env_value API_TOKEN 2>/dev/null || true)"

  if command -v claude >/dev/null 2>&1; then
    run claude mcp remove agent-chat >/dev/null 2>&1 || true
    run claude mcp add -s user \
      -e "AGENT_CHAT_API=http://127.0.0.1:8090" \
      -e "API_TOKEN=$token" \
      -e "AGENTCHAT_HOMEDIR=$HOME/.agentchat" \
      -- agent-chat node "$INSTALL_DIR/mcp-server.js" >/dev/null 2>&1 \
      && log "Registered MCP with Claude Code" \
      || log "NOTE: claude mcp add failed; register manually."
  else
    log "claude CLI not found; skipping Claude MCP registration."
  fi

  if command -v codex >/dev/null 2>&1; then
    run codex mcp remove agent-chat >/dev/null 2>&1 || true
    run codex mcp add agent-chat \
      --env "AGENT_CHAT_API=http://127.0.0.1:8090" \
      --env "API_TOKEN=$token" \
      --env "AGENTCHAT_HOMEDIR=$HOME/.agentchat" \
      -- node "$INSTALL_DIR/mcp-server.js" >/dev/null 2>&1 \
      && log "Registered MCP with Codex" \
      || log "NOTE: codex mcp add failed; register manually."
  else
    log "codex CLI not found; skipping Codex MCP registration."
  fi
}

# --- Verify ------------------------------------------------------------------
verify() {
  [ "$DRY_RUN" = false ] || return 0
  [ -f "$PROFILE_FILE" ] || die "service profile was not written"
  [ -x "$BIN_DIR/agentchat" ] || die "agentchat was not linked into $BIN_DIR"
  [ "$NO_START" = false ] || { log "--no-start set; skipping health checks."; return 0; }

  local port i ok=false
  port="$(read_env_value AGENT_CHAT_BACKEND_PORT)"; port="${port:-8090}"
  log "Waiting for the backend on 127.0.0.1:$port ..."
  for i in $(seq 40); do
    if curl -sf --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ok=true; break
    fi
    sleep 1
  done
  if [ "$ok" != true ]; then
    log "Backend did not become healthy. Diagnose with:"
    log "  tail -50 $INSTALL_DIR/data/services-local/logs/backend.log"
    log "  (launchd.err.log only carries the supervisor's own output, usually empty)"
    log "  node services/agentchat-services.mjs doctor --profile $PROFILE_FILE"
    die "verification failed"
  fi
  log "Backend healthy."

  local web
  web="$(read_env_value AGENT_CHAT_WEB_PORT)"; web="${web:-8084}"
  curl -sf --noproxy '*' "http://127.0.0.1:${web}/" >/dev/null 2>&1 \
    && log "Dashboard healthy at http://127.0.0.1:${web}" \
    || log "NOTE: dashboard not answering on ${web} yet."
}

# Writes the sessions found by check_existing_tmux into the session policy, so a
# host with unrelated work can be installed onto without HAFleet claiming it.
# Runs after prepare_env because it needs .env to exist.
apply_session_denylist() {
  [ "$DENY_EXISTING_TMUX" = true ] || return 0
  [ -n "$EXISTING_TMUX_SESSIONS" ] || { log "No sessions to deny."; return 0; }
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would set AGENT_CHAT_SESSION_DENYLIST=$EXISTING_TMUX_SESSIONS"
    return 0
  fi
  local existing merged
  existing="$(read_env_value AGENT_CHAT_SESSION_DENYLIST)"
  if [ -n "$existing" ]; then
    merged="$existing,$EXISTING_TMUX_SESSIONS"
  else
    merged="$EXISTING_TMUX_SESSIONS"
  fi
  set_env_value AGENT_CHAT_SESSION_DENYLIST "$merged"
  log "AGENT_CHAT_SESSION_DENYLIST=$merged"
}

main() {
  check_prereqs
  check_existing_tmux
  prepare_env
  apply_session_denylist
  install_dependencies
  write_profile
  link_cli_commands
  write_launchd
  [ "$NO_START" = true ] && log "--no-start: not starting services." || start_launchd
  configure_mcp
  verify
  log ""
  log "Installation complete."
  log "  status:  node services/agentchat-services.mjs status --profile $PROFILE_FILE"
  log "  doctor:  node services/agentchat-services.mjs doctor  --profile $PROFILE_FILE"
  log "  stop:    launchctl bootout $LAUNCHD_DOMAIN/$SERVICE_NAME"
  log "  logs:    $INSTALL_DIR/data/services-local/logs/<service>.log"
  log "           each service writes its own; launchd.err.log holds only the supervisor"
}

main "$@"
