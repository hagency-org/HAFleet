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
NODE_BIN="${NODE_BIN:-}"

usage() {
  cat <<'USAGE'
Usage: ./install-full.sh [options]

Install the full local Agent Chat stack on Linux:
  - Node dependencies
  - .env bootstrap with required API_TOKEN
  - agent-chat-v2, agent-chat, and agent-chat-push-relay systemd units
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
  local template="$INSTALL_DIR/skills/agent-chat/SKILL.md"
  [ -f "$template" ] || die "missing skill template: $template"
  run mkdir -p "$(dirname "$target")"
  run ln -sfn "$template" "$target"
}

install_skills() {
  link_skill "$HOME/.claude/skills/agent-chat/SKILL.md"
  link_skill "$HOME/.codex/skills/agent-chat/SKILL.md"
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
    log "Run: claude mcp add -s user -e AGENT_CHAT_API=http://127.0.0.1:8090 -e API_TOKEN=<token> -e AGENTCHAT_HOMEDIR=$HOME/.agentchat -- agent-chat node $INSTALL_DIR/mcp-server.js"
    return 0
  fi
  local api_token api_base agentchat_home
  api_token="$(read_env_value API_TOKEN "$ENV_FILE")"
  api_base="$(read_env_value AGENT_CHAT_API "$ENV_FILE")"
  agentchat_home="${AGENTCHAT_HOMEDIR:-$HOME/.agentchat}"
  [ -n "$api_base" ] || api_base="http://127.0.0.1:8090"
  run claude mcp add -s user \
    -e "AGENT_CHAT_API=$api_base" \
    -e "API_TOKEN=$api_token" \
    -e "AGENTCHAT_HOMEDIR=$agentchat_home" \
    -e "AGENT_CHAT_MCP_SERVER_NAME=agent-chat" \
    -- agent-chat node "$INSTALL_DIR/mcp-server.js"
}

configure_codex_mcp() {
  if [ "$SKIP_MCP" = true ]; then
    log "Skipping Codex MCP configuration"
    return 0
  fi
  if ! command -v codex >/dev/null 2>&1; then
    log "Codex CLI not found; skipping MCP configuration."
    log "Run: codex mcp add agent-chat --env AGENT_CHAT_API=http://127.0.0.1:8090 --env API_TOKEN=<token> --env AGENTCHAT_HOMEDIR=$HOME/.agentchat -- node $INSTALL_DIR/mcp-server.js"
    return 0
  fi
  local api_token api_base agentchat_home
  api_token="$(read_env_value API_TOKEN "$ENV_FILE")"
  api_base="$(read_env_value AGENT_CHAT_API "$ENV_FILE")"
  agentchat_home="${AGENTCHAT_HOMEDIR:-$HOME/.agentchat}"
  [ -n "$api_base" ] || api_base="http://127.0.0.1:8090"
  run codex mcp remove agent-chat >/dev/null 2>&1 || true
  run codex mcp add agent-chat \
    --env "AGENT_CHAT_API=$api_base" \
    --env "API_TOKEN=$api_token" \
    --env "AGENTCHAT_HOMEDIR=$agentchat_home" \
    --env "AGENT_CHAT_MCP_SERVER_NAME=agent-chat" \
    -- node "$INSTALL_DIR/mcp-server.js"
}

install_services() {
  run mkdir -p "$SYSTEMD_DIR"
  local services=(
    "agent-chat-v2.service"
    "agent-chat.service"
    "agent-chat-push-relay.service"
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

  systemctl_run enable agent-chat-v2.service agent-chat.service agent-chat-push-relay.service
  systemctl_run restart agent-chat-v2.service
  systemctl_run restart agent-chat.service
  systemctl_run restart agent-chat-push-relay.service
  if [ "$WITH_BRIDGE" = true ]; then
    systemctl_run enable bridge-matrix.service
    systemctl_run restart bridge-matrix.service
  fi
}

verify_installation() {
  [ "$DRY_RUN" = false ] || return 0
  [ -x "$BIN_DIR/agentchat" ] || die "agentchat command was not linked into $BIN_DIR"
  [ -f "$SYSTEMD_DIR/agent-chat-v2.service" ] || die "agent-chat-v2.service was not installed"
  [ -f "$SYSTEMD_DIR/agent-chat.service" ] || die "agent-chat.service was not installed"
  [ -f "$SYSTEMD_DIR/agent-chat-push-relay.service" ] || die "agent-chat-push-relay.service was not installed"

  if is_system_dir && [ "$NO_START" = false ]; then
    systemctl_run is-active --quiet agent-chat-v2.service
    systemctl_run is-active --quiet agent-chat.service
    systemctl_run is-active --quiet agent-chat-push-relay.service
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
  prepare_env
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
