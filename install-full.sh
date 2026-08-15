#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$USER}}"
DRY_RUN=false
NO_START=false
SKIP_MCP=false
SKIP_NPM=false
SKIP_PREREQ=false
WITH_BRIDGE=false
ALLOW_EXISTING_TMUX=false
DENY_EXISTING_TMUX=false
EXISTING_TMUX_SESSIONS=""
NODE_BIN="${NODE_BIN:-}"

usage() {
  cat <<'USAGE'
Usage: ./install-full.sh [options]

Install the full local Agent Chat stack on Linux:
  - Node dependencies
  - .env bootstrap with required API_TOKEN
  - hafleet-backend, hafleet, and hafleet-push-relay systemd units
  - CLI symlinks in ~/.local/bin
  - Claude/Codex skill links
  - Claude Code and Codex MCP user config when the CLIs are available

Options:
  --dry-run              Print actions without changing files or services
  --no-start             Install files but do not enable/restart services
  --env-file PATH        Use PATH instead of INSTALL_DIR/.env
  --bin-dir PATH         Link CLI commands into PATH instead of ~/.local/bin
  --systemd-dir PATH     Write service units into PATH instead of /etc/systemd/system
  --service-user USER    Render systemd units for USER
  --skip-mcp            Do not configure Claude Code or Codex MCP
  --skip-npm            Do not run npm install
  --skip-prereq-check   Do not check host prerequisites
  --with-bridge         Also install/enable bridge-matrix.service
  --deny-existing-tmux  Install even if unrelated tmux sessions exist, adding them
                        to HAFLEET_SESSION_DENYLIST so HAFleet leaves them alone
  --allow-existing-tmux Install and manage pre-existing tmux sessions anyway
  -h, --help            Show this help

Environment:
  API_TOKEN may provide the token used when creating or fixing .env non-interactively.
USAGE
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

resolve_node_bin() {
  if [ -n "$NODE_BIN" ]; then
    [ -x "$NODE_BIN" ] || die "NODE_BIN is not executable: $NODE_BIN"
    return 0
  fi
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "missing required command: node"
}

is_system_dir() {
  [ "$(cd "$(dirname "$SYSTEMD_DIR")" 2>/dev/null && pwd)/$(basename "$SYSTEMD_DIR")" = "/etc/systemd/system" ]
}

needs_sudo_for_systemd() {
  is_system_dir && [ "$(id -u)" -ne 0 ]
}

system_install() {
  local source="$1"
  local target="$2"
  if needs_sudo_for_systemd; then
    run sudo install -m 0644 "$source" "$target"
  else
    run install -m 0644 "$source" "$target"
  fi
}

systemctl_run() {
  if needs_sudo_for_systemd; then
    run sudo systemctl "$@"
  else
    run systemctl "$@"
  fi
}

render_service() {
  local template="$1"
  local target="$2"
  local tmp
  resolve_node_bin
  tmp="$(mktemp)"
  sed \
    -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$template" > "$tmp"
  system_install "$tmp" "$target"
  rm -f "$tmp"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      --no-start) NO_START=true ;;
      --env-file)
        [ $# -ge 2 ] || die "--env-file requires a path"
        ENV_FILE="$2"; shift
        ;;
      --bin-dir)
        [ $# -ge 2 ] || die "--bin-dir requires a path"
        BIN_DIR="$2"; shift
        ;;
      --systemd-dir)
        [ $# -ge 2 ] || die "--systemd-dir requires a path"
        SYSTEMD_DIR="$2"; shift
        ;;
      --service-user)
        [ $# -ge 2 ] || die "--service-user requires a user"
        SERVICE_USER="$2"; shift
        ;;
      --skip-mcp) SKIP_MCP=true ;;
      --skip-npm) SKIP_NPM=true ;;
      --skip-prereq-check) SKIP_PREREQ=true ;;
      --with-bridge) WITH_BRIDGE=true ;;
      --deny-existing-tmux) DENY_EXISTING_TMUX=true ;;
      --allow-existing-tmux) ALLOW_EXISTING_TMUX=true ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
    shift
  done
}

# HAFleet registers tmux sessions as agents and the relay delivers by typing into
# their panes, so a host with unrelated sessions can have someone else's work typed
# into. Observed on a fleet host: a fresh install claimed five sessions that had
# been running for eleven days. The macOS installer has warned about this for a
# while; this is the Linux side of the same guard.
check_existing_tmux() {
  command -v tmux >/dev/null 2>&1 || return 0
  local sessions count
  sessions="$(tmux ls 2>/dev/null | cut -d: -f1 || true)"
  [ -n "$sessions" ] || { log "No pre-existing tmux sessions."; return 0; }

  EXISTING_TMUX_SESSIONS="$(printf '%s\n' "$sessions" | paste -sd, - | tr -d ' ')"
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

  if [ ! -t 0 ]; then
    die "existing tmux sessions and no TTY to confirm; pass --deny-existing-tmux to exclude them, or --allow-existing-tmux to accept the risk"
  fi
  printf '[install-full] Continue anyway? [y/N] '
  IFS= read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted" ;; esac
}

# Runs after prepare_env, because it needs ENV_FILE to exist. Merges rather than
# overwriting: an operator may already have a denylist configured.
apply_session_denylist() {
  [ "$DENY_EXISTING_TMUX" = true ] || return 0
  [ -n "$EXISTING_TMUX_SESSIONS" ] || { log "No sessions to deny."; return 0; }
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would set HAFLEET_SESSION_DENYLIST=$EXISTING_TMUX_SESSIONS"
    return 0
  fi
  local existing merged
  existing="$(read_env_value HAFLEET_SESSION_DENYLIST "$ENV_FILE")"
  if [ -n "$existing" ]; then
    merged="$existing,$EXISTING_TMUX_SESSIONS"
  else
    merged="$EXISTING_TMUX_SESSIONS"
  fi
  set_env_value HAFLEET_SESSION_DENYLIST "$merged" "$ENV_FILE"
  log "HAFLEET_SESSION_DENYLIST=$merged"
}

check_prereqs() {
  [ "$(uname -s)" = "Linux" ] || die "install-full.sh currently supports Linux only"
  for cmd in node npm tmux git bash ln; do
    need_cmd "$cmd"
  done
  if is_system_dir; then
    need_cmd systemctl
    [ "$(id -u)" -eq 0 ] || need_cmd sudo
  fi
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 22 ]; then
    die "Node.js 22+ is required; found $(node --version 2>/dev/null || echo unknown)"
  fi
}

api_token_missing() {
  local token="${1:-}"
  [ -z "$token" ] || [ "$token" = "your-api-token-here" ]
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${escaped}|" "$file"
    rm -f "${file}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

prepare_env() {
  local env_dir
  env_dir="$(dirname "$ENV_FILE")"
  run mkdir -p "$env_dir"
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$INSTALL_DIR/.env.example" ] || die "missing .env.example at $INSTALL_DIR/.env.example"
    run cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    log "Created $ENV_FILE from .env.example"
  fi

  if [ "$DRY_RUN" = true ]; then
    return 0
  fi

  local current_token
  current_token="$(read_env_value API_TOKEN "$ENV_FILE")"
  if api_token_missing "$current_token"; then
    local supplied="${API_TOKEN:-}"
    if api_token_missing "$supplied"; then
      if [ -t 0 ]; then
        printf 'Enter API_TOKEN for local services: '
        IFS= read -r supplied
      else
        die "API_TOKEN is required in $ENV_FILE or API_TOKEN env for non-interactive install"
      fi
    fi
    api_token_missing "$supplied" && die "API_TOKEN cannot be empty"
    set_env_value API_TOKEN "$supplied" "$ENV_FILE"
    log "Updated API_TOKEN in $ENV_FILE"
  fi
}

bridge_value_missing() {
  case "${1:-}" in
    ""|changeme|CHANGEME|placeholder|PLACEHOLDER) return 0 ;;
    *) return 1 ;;
  esac
}

# Preflight for --with-bridge. Without this the installer enables and restarts
# bridge-matrix.service against a fresh .env, the bridge fail-closes on a
# missing secret (bridge-matrix.js:2419), and the install still reports success.
prepare_bridge_env() {
  [ "$WITH_BRIDGE" = true ] || return 0
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would validate Matrix bridge configuration in $ENV_FILE"
    return 0
  fi

  # Generatable: this is a shared secret between bridge and backend, not a
  # credential registered anywhere else, so minting one is safe.
  local secret
  secret="$(read_env_value MATRIX_BRIDGE_SECRET "$ENV_FILE")"
  if bridge_value_missing "$secret"; then
    local generated
    if command -v openssl >/dev/null 2>&1; then
      generated="$(openssl rand -hex 32)"
    else
      generated="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    [ -n "$generated" ] || die "failed to generate MATRIX_BRIDGE_SECRET"
    set_env_value MATRIX_BRIDGE_SECRET "$generated" "$ENV_FILE"
    log "Generated MATRIX_BRIDGE_SECRET in $ENV_FILE"
  fi

  # Not generatable: must match an account that already exists on the homeserver.
  local bot_password
  bot_password="$(read_env_value MATRIX_BOT_PASSWORD "$ENV_FILE")"
  if bridge_value_missing "$bot_password"; then
    die "$(printf '%s\n' \
      "--with-bridge requires MATRIX_BOT_PASSWORD in $ENV_FILE." \
      "  The bridge logs in as its bot account on your homeserver; there is" \
      "  nothing to generate. Set MATRIX_HOMESERVER, MATRIX_SERVER_NAME," \
      "  MATRIX_BOT_USERNAME and MATRIX_BOT_PASSWORD, then re-run." \
      "  To install the local stack without Matrix, drop --with-bridge.")"
  fi

  local homeserver
  homeserver="$(read_env_value MATRIX_HOMESERVER "$ENV_FILE")"
  case "$homeserver" in
    ""|*example.com*)
      log "WARNING: MATRIX_HOMESERVER is unset or still the example placeholder ('$homeserver')."
      log "         bridge-matrix.service will start but cannot reach a homeserver."
      ;;
  esac
}

install_dependencies() {
  if [ "$SKIP_NPM" = true ]; then
    log "Skipping npm install"
    return 0
  fi
  (cd "$INSTALL_DIR" && run npm install)
}

link_cli_commands() {
  run mkdir -p "$BIN_DIR"
  local cmd
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    local name target backup
    name="$(basename "$cmd")"
    target="$BIN_DIR/$name"
    if [ "$DRY_RUN" = false ] && [ -e "$target" ] && [ ! -L "$target" ]; then
      backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
      mv "$target" "$backup"
      log "Backed up existing $target to $backup"
    fi
    run ln -sfn "$cmd" "$target"
  done < <(find "$INSTALL_DIR/bin" -maxdepth 1 -type f -perm -111 | sort)

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) log "Note: add $BIN_DIR to PATH if commands are not found in new shells." ;;
  esac
}

link_skill() {
  local target="$1"
  local template="$INSTALL_DIR/skills/hafleet/SKILL.md"
  [ -f "$template" ] || die "missing skill template: $template"
  run mkdir -p "$(dirname "$target")"
  run ln -sfn "$template" "$target"
}

install_skills() {
  link_skill "$HOME/.claude/skills/hafleet/SKILL.md"
  link_skill "$HOME/.codex/skills/hafleet/SKILL.md"
  link_skill "$HOME/.claude/skills/agent-message/SKILL.md"
  link_skill "$HOME/.codex/skills/agent-message/SKILL.md"
}

configure_claude_mcp() {
  if [ "$SKIP_MCP" = true ]; then
    log "Skipping Claude Code MCP configuration"
    return 0
  fi
  if ! command -v claude >/dev/null 2>&1; then
    log "Claude Code CLI not found; skipping MCP configuration."
    log "Run: claude mcp add -s user -e HAFLEET_API=http://127.0.0.1:8090 -e API_TOKEN=<token> -e HAFLEET_HOMEDIR=$HOME/.hafleet -- hafleet node $INSTALL_DIR/mcp-server.js"
    return 0
  fi
  local api_token api_base hafleet_home
  api_token="$(read_env_value API_TOKEN "$ENV_FILE")"
  api_base="$(read_env_value HAFLEET_API "$ENV_FILE")"
  hafleet_home="${HAFLEET_HOMEDIR:-$HOME/.hafleet}"
  [ -n "$api_base" ] || api_base="http://127.0.0.1:8090"
  run claude mcp add -s user \
    -e "HAFLEET_API=$api_base" \
    -e "API_TOKEN=$api_token" \
    -e "HAFLEET_HOMEDIR=$hafleet_home" \
    -e "HAFLEET_MCP_SERVER_NAME=hafleet" \
    -- hafleet node "$INSTALL_DIR/mcp-server.js"
}

configure_codex_mcp() {
  if [ "$SKIP_MCP" = true ]; then
    log "Skipping Codex MCP configuration"
    return 0
  fi
  if ! command -v codex >/dev/null 2>&1; then
    log "Codex CLI not found; skipping MCP configuration."
    log "Run: codex mcp add hafleet --env HAFLEET_API=http://127.0.0.1:8090 --env API_TOKEN=<token> --env HAFLEET_HOMEDIR=$HOME/.hafleet -- node $INSTALL_DIR/mcp-server.js"
    return 0
  fi
  local api_token api_base hafleet_home
  api_token="$(read_env_value API_TOKEN "$ENV_FILE")"
  api_base="$(read_env_value HAFLEET_API "$ENV_FILE")"
  hafleet_home="${HAFLEET_HOMEDIR:-$HOME/.hafleet}"
  [ -n "$api_base" ] || api_base="http://127.0.0.1:8090"
  run codex mcp remove hafleet >/dev/null 2>&1 || true
  run codex mcp add hafleet \
    --env "HAFLEET_API=$api_base" \
    --env "API_TOKEN=$api_token" \
    --env "HAFLEET_HOMEDIR=$hafleet_home" \
    --env "HAFLEET_MCP_SERVER_NAME=hafleet" \
    -- node "$INSTALL_DIR/mcp-server.js"
}

install_services() {
  run mkdir -p "$SYSTEMD_DIR"
  local services=(
    "hafleet-backend.service"
    "hafleet-push-relay.service"
  )
  if [ "$WITH_BRIDGE" = true ]; then
    services+=("bridge-matrix.service")
  fi

  local service
  for service in "${services[@]}"; do
    [ -f "$INSTALL_DIR/$service" ] || die "missing service template: $INSTALL_DIR/$service"
    render_service "$INSTALL_DIR/$service" "$SYSTEMD_DIR/$service"
    log "Installed $service"
  done

  if [ "$DRY_RUN" = true ] || ! is_system_dir; then
    return 0
  fi

  systemctl_run daemon-reload
  if [ "$NO_START" = true ]; then
    log "Installed service files; --no-start skipped enable/restart."
    return 0
  fi

  systemctl_run enable hafleet-backend.service hafleet-push-relay.service
  systemctl_run restart hafleet-backend.service
  systemctl_run restart hafleet-push-relay.service
  if [ "$WITH_BRIDGE" = true ]; then
    systemctl_run enable bridge-matrix.service
    systemctl_run restart bridge-matrix.service
  fi
}

verify_installation() {
  [ "$DRY_RUN" = false ] || return 0
  [ -x "$BIN_DIR/hafleet" ] || die "hafleet command was not linked into $BIN_DIR"
  [ -f "$SYSTEMD_DIR/hafleet-backend.service" ] || die "hafleet-backend.service was not installed"
  [ -f "$SYSTEMD_DIR/hafleet-push-relay.service" ] || die "hafleet-push-relay.service was not installed"

  if [ "$WITH_BRIDGE" = true ]; then
    [ -f "$SYSTEMD_DIR/bridge-matrix.service" ] || die "bridge-matrix.service was not installed"
  fi

  if is_system_dir && [ "$NO_START" = false ]; then
    systemctl_run is-active --quiet hafleet-backend.service
    systemctl_run is-active --quiet hafleet-push-relay.service
    # Previously unchecked, so a bridge that fail-closed on startup still let
    # the installer print "Installation complete."
    if [ "$WITH_BRIDGE" = true ]; then
      systemctl_run is-active --quiet bridge-matrix.service \
        || die "bridge-matrix.service was enabled but is not active; check: journalctl -u bridge-matrix -n 50"
    fi
  fi
}

main() {
  parse_args "$@"
  log "=== Agent Chat full installer ==="
  log "Install dir: $INSTALL_DIR"
  log "Env file:    $ENV_FILE"
  log "Bin dir:    $BIN_DIR"
  log "Systemd:    $SYSTEMD_DIR"
  log "User:       $SERVICE_USER"
  [ "$SKIP_PREREQ" = true ] || check_prereqs
  check_existing_tmux
  prepare_env
  apply_session_denylist
  prepare_bridge_env
  install_dependencies
  link_cli_commands
  install_skills
  install_services
  configure_claude_mcp
  configure_codex_mcp
  verify_installation
  log "Installation complete."
}

main "$@"
