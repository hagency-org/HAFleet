#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SUDOERS_DIR="${SUDOERS_DIR:-/etc/sudoers.d}"
YES=false
DRY_RUN=false
SKIP_MCP=false
PURGE_AGENTCHAT_HOME=false
PURGE_DATA=false

usage() {
  cat <<'USAGE'
Usage: ./uninstall.sh [options]

Remove local Agent Chat install artifacts safely. Runtime data is preserved unless
explicit purge flags are provided and confirmed.

Options:
  --dry-run                 Print actions without changing files or services
  --yes                     Do not ask for the top-level confirmation
  --install-dir PATH        Treat PATH as the Agent Chat checkout
  --bin-dir PATH            Remove CLI links from PATH instead of ~/.local/bin
  --systemd-dir PATH        Remove service units from PATH instead of /etc/systemd/system
  --sudoers-dir PATH        Remove sudoers rule from PATH instead of /etc/sudoers.d
  --skip-mcp               Do not call the Claude Code MCP remover
  --purge-agentchat-home   Also remove ~/.agentchat after separate confirmation
  --purge-data             Also remove INSTALL_DIR/data after separate confirmation
  -h, --help               Show this help
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

confirm() {
  local prompt="$1"
  if [ "$YES" = true ]; then
    return 0
  fi
  printf '%s [y/N] ' "$prompt"
  local reply
  IFS= read -r reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

is_system_dir() {
  [ "$(cd "$(dirname "$SYSTEMD_DIR")" 2>/dev/null && pwd)/$(basename "$SYSTEMD_DIR")" = "/etc/systemd/system" ]
}

needs_sudo_for_systemd() {
  is_system_dir && [ "$(id -u)" -ne 0 ]
}

systemctl_run() {
  if needs_sudo_for_systemd; then
    run sudo systemctl "$@"
  else
    run systemctl "$@"
  fi
}

remove_file() {
  local file="$1"
  [ -e "$file" ] || [ -L "$file" ] || return 0
  local privileged_path=false
  case "$file" in
    "$SYSTEMD_DIR"/*|"$SUDOERS_DIR"/*) privileged_path=true ;;
  esac
  if needs_sudo_for_systemd && [ "$privileged_path" = true ]; then
    run sudo rm -f "$file"
  else
    run rm -f "$file"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      --yes) YES=true ;;
      --install-dir)
        [ $# -ge 2 ] || die "--install-dir requires a path"
        INSTALL_DIR="$2"; shift
        ;;
      --bin-dir)
        [ $# -ge 2 ] || die "--bin-dir requires a path"
        BIN_DIR="$2"; shift
        ;;
      --systemd-dir)
        [ $# -ge 2 ] || die "--systemd-dir requires a path"
        SYSTEMD_DIR="$2"; shift
        ;;
      --sudoers-dir)
        [ $# -ge 2 ] || die "--sudoers-dir requires a path"
        SUDOERS_DIR="$2"; shift
        ;;
      --skip-mcp) SKIP_MCP=true ;;
      --purge-agentchat-home) PURGE_AGENTCHAT_HOME=true ;;
      --purge-data) PURGE_DATA=true ;;
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

stop_services() {
  local services=(
    agent-chat-push-relay.service
    agent-chat-remote-autodeploy.service
    agent-chat-stable-autodeploy.service
    bridge-matrix.service
    agent-chat.service
    agent-chat-v2.service
  )
  if [ "$DRY_RUN" = true ] || ! is_system_dir; then
    log "Skipping systemctl stop/disable outside real systemd dir."
  else
    local service
    for service in "${services[@]}"; do
      systemctl_run disable --now "$service" >/dev/null 2>&1 || true
    done
    systemctl_run daemon-reload
  fi

  local service
  for service in "${services[@]}"; do
    remove_file "$SYSTEMD_DIR/$service"
  done
}

remove_cli_links() {
  [ -d "$INSTALL_DIR/bin" ] || return 0
  local src name target resolved
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    name="$(basename "$src")"
    target="$BIN_DIR/$name"
    [ -L "$target" ] || continue
    resolved="$(readlink -f "$target" 2>/dev/null || true)"
    case "$resolved" in
      "$INSTALL_DIR"/bin/*) run rm -f "$target" ;;
      *) log "Preserving $target; it does not point into $INSTALL_DIR/bin" ;;
    esac
  done < <(find "$INSTALL_DIR/bin" -maxdepth 1 -type f -perm /111 | sort)
}

remove_skill_dir_if_owned() {
  local dir="$1"
  local skill="$dir/SKILL.md"
  if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
    return 0
  fi
  if [ -L "$skill" ]; then
    local resolved
    resolved="$(readlink -f "$skill" 2>/dev/null || true)"
    case "$resolved" in
      "$INSTALL_DIR"/skills/*) run rm -rf "$dir"; return 0 ;;
    esac
  fi
  case "$dir" in
    *"/agent-message") run rm -rf "$dir" ;;
    *) log "Preserving non-owned skill directory: $dir" ;;
  esac
}

remove_skills() {
  remove_skill_dir_if_owned "$HOME/.claude/skills/agent-message"
  remove_skill_dir_if_owned "$HOME/.codex/skills/agent-message"
  remove_skill_dir_if_owned "$HOME/.claude/skills/agent-chat"
  remove_skill_dir_if_owned "$HOME/.codex/skills/agent-chat"
}

remove_sudoers() {
  remove_file "$SUDOERS_DIR/agentchat-autodeploy"
}

remove_claude_mcp() {
  if [ "$SKIP_MCP" = true ]; then
    log "Skipping Claude Code MCP removal"
    return 0
  fi
  if command -v claude >/dev/null 2>&1; then
    run claude mcp remove -s user agent-chat || true
  else
    log "Claude Code CLI not found; skipping MCP removal."
  fi
}

purge_optional_data() {
  if [ "$PURGE_AGENTCHAT_HOME" = true ]; then
    if confirm "Remove user data directory $HOME/.agentchat?"; then
      run rm -rf "$HOME/.agentchat"
    else
      log "Preserved $HOME/.agentchat"
    fi
  fi
  if [ "$PURGE_DATA" = true ]; then
    if confirm "Remove runtime data directory $INSTALL_DIR/data?"; then
      run rm -rf "$INSTALL_DIR/data"
    else
      log "Preserved $INSTALL_DIR/data"
    fi
  fi
}

main() {
  parse_args "$@"
  log "=== Agent Chat uninstaller ==="
  log "Install dir: $INSTALL_DIR"
  log "Bin dir:     $BIN_DIR"
  log "Systemd:     $SYSTEMD_DIR"
  if [ "$DRY_RUN" = false ]; then
    confirm "Stop services and remove Agent Chat install artifacts?" || die "uninstall canceled"
  fi
  stop_services
  remove_cli_links
  remove_skills
  remove_sudoers
  remove_claude_mcp
  purge_optional_data
  log "Uninstall complete. .env, data, and ~/.agentchat are preserved unless purge flags were confirmed."
}

main "$@"
