#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-agent-chat-push-relay}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-$HOME/.local/bin}"
AGENT_INSTALL_AUTOSTART="${AGENT_INSTALL_AUTOSTART:-1}"
AGENT_INSTALL_SKIP_VERIFY="${AGENT_INSTALL_SKIP_VERIFY:-0}"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="${SUDO_USER:-$USER}"
OS_NAME="$(uname -s)"
IS_LINUX=false
IS_MAC=false
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LAUNCHD_RUNNER="$SCRIPT_DIR/.push-relay-launchd.sh"
LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-gui/$(id -u)}"
LEGACY_SERVICE_NAME="com.agentchat.push-relay"

case "$OS_NAME" in
  Linux) IS_LINUX=true ;;
  Darwin) IS_MAC=true ;;
  *)
    echo "Unsupported OS: $OS_NAME (expected Linux or macOS)." >&2
    exit 1
    ;;
esac

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

launchd_bootstrap_service() {
  local plist_path="$1"
  local domains=("$LAUNCHD_DOMAIN" "gui/$(id -u)" "user/$(id -u)")
  local tried=""
  local d out rc

  # First clear any existing instance across all candidate domains to avoid
  # duplicate launchd jobs (e.g. one in gui/* and one in user/*).
  for d in "${domains[@]}"; do
    [ -n "$d" ] || continue
    case ":$tried:" in
      *":$d:"*) continue ;;
    esac
    tried="${tried}:$d"
    launchctl bootout "$d/$SERVICE_NAME" >/dev/null 2>&1 || true
  done
  tried=""

  for d in "${domains[@]}"; do
    [ -n "$d" ] || continue
    case ":$tried:" in
      *":$d:"*) continue ;;
    esac
    tried="${tried}:$d"
    out="$(launchctl bootstrap "$d" "$plist_path" 2>&1)" && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
      launchctl enable "$d/$SERVICE_NAME" >/dev/null 2>&1 || true
      launchctl kickstart -k "$d/$SERVICE_NAME" >/dev/null 2>&1 || true
      LAUNCHD_DOMAIN="$d"
      return 0
    fi
  done

  # Older macOS fallback
  launchctl unload "$plist_path" >/dev/null 2>&1 || true
  if launchctl load -w "$plist_path" >/dev/null 2>&1; then
    LAUNCHD_DOMAIN="legacy"
    return 0
  fi

  return 1
}

cleanup_legacy_launchd_service() {
  local legacy_label="$1"
  local legacy_plist="$HOME/Library/LaunchAgents/${legacy_label}.plist"
  local d
  for d in "gui/$(id -u)" "user/$(id -u)"; do
    launchctl bootout "$d/$legacy_label" >/dev/null 2>&1 || true
  done
  launchctl unload "$legacy_plist" >/dev/null 2>&1 || true
  if [ -f "$legacy_plist" ]; then
    rm -f "$legacy_plist" || true
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run this script as root." >&2
  echo "Run as the target user. Linux installs systemd with sudo; macOS installs launchd in the user domain." >&2
  exit 1
fi

echo "[1/9] Checking prerequisites..."
need_cmd node
need_cmd npm
need_cmd tmux
need_cmd ln
need_cmd curl
if [ "$IS_LINUX" = true ]; then
  need_cmd systemctl
  need_cmd sudo
elif [ "$IS_MAC" = true ]; then
  need_cmd launchctl
  need_cmd plutil
fi
NODE_BIN="$(command -v node || true)"

echo "[2/9] Preparing environment..."
if [ ! -f "$ENV_FILE" ]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE (please fill API_TOKEN and AGENT_CHAT_SERVER)."
fi
mkdir -p "$SCRIPT_DIR/data/agents" "$SCRIPT_DIR/logs" "$INSTALL_BIN_DIR"
set -a
if ! source "$ENV_FILE"; then
  set +a
  echo "Error: failed to load $ENV_FILE. Please fix syntax and retry." >&2
  exit 1
fi
set +a

MISSING_ENV=()
[ -n "${AGENT_CHAT_API:-}" ] || MISSING_ENV+=("AGENT_CHAT_API")
[ -n "${AGENT_CHAT_SERVER:-}" ] || MISSING_ENV+=("AGENT_CHAT_SERVER")
if [ "${#MISSING_ENV[@]}" -gt 0 ]; then
  echo "Error: missing required env in $ENV_FILE: ${MISSING_ENV[*]}" >&2
  exit 1
fi
SERVER_ID_TRIMMED="${AGENT_CHAT_SERVER#"${AGENT_CHAT_SERVER%%[![:space:]]*}"}"
SERVER_ID_TRIMMED="${SERVER_ID_TRIMMED%"${SERVER_ID_TRIMMED##*[![:space:]]}"}"
SERVER_ID_LOWER="$(printf '%s' "$SERVER_ID_TRIMMED" | tr '[:upper:]' '[:lower:]')"
if [ "$SERVER_ID_LOWER" = "local" ]; then
  echo "Error: AGENT_CHAT_SERVER must be this remote host's unique server id, not 'local'." >&2
  exit 1
fi
if [ -z "${API_TOKEN:-}" ]; then
  echo "Warning: API_TOKEN is empty. This only works if backend allows unauthenticated requests."
fi

echo "[3/9] Installing Node dependencies..."
cd "$SCRIPT_DIR"
npm install --omit=dev

echo "[4/9] Linking helper commands into $INSTALL_BIN_DIR..."
required_cmds=(agentchat agent-up agent-down agent-ls agent-send agent-update agent-service verify-remote agent-maintain)
optional_cmds=(self-time-reminder agent-chat-cli agent-chat agentchat-prune-agents)
BIN_SOURCE_DIR="$SCRIPT_DIR/bin"
if [ -d "$REPO_ROOT/bin" ] && [ -f "$REPO_ROOT/bin/agent-up" ]; then
  BIN_SOURCE_DIR="$REPO_ROOT/bin"
fi
echo "  Using helper source dir: $BIN_SOURCE_DIR"

for cmd in "${required_cmds[@]}"; do
  src="$BIN_SOURCE_DIR/$cmd"
  if [ ! -f "$src" ]; then
    echo "Missing required helper script: $src" >&2
    exit 1
  fi
  ln -sfn "$src" "$INSTALL_BIN_DIR/$cmd"
done

for cmd in "${optional_cmds[@]}"; do
  src="$BIN_SOURCE_DIR/$cmd"
  if [ -f "$src" ]; then
    ln -sfn "$src" "$INSTALL_BIN_DIR/$cmd"
  else
    echo "  Optional helper not found, skipping: $src"
  fi
done

echo "[5/9] Installing service ${SERVICE_NAME}..."
if [ "$IS_LINUX" = true ]; then
  TMP_UNIT="$(mktemp)"
  trap 'rm -f "$TMP_UNIT"' EXIT
  sed \
    -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__WORKDIR__|$SCRIPT_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    "$SCRIPT_DIR/push-relay.service" > "$TMP_UNIT"
  sudo install -m 0644 "$TMP_UNIT" "$SYSTEMD_UNIT"
  rm -f "$TMP_UNIT"
  trap - EXIT

  # Install remote autodeploy service
  AUTODEPLOY_SERVICE="agent-chat-remote-autodeploy"
  AUTODEPLOY_UNIT="/etc/systemd/system/${AUTODEPLOY_SERVICE}.service"
  AUTODEPLOY_SCRIPT="$REPO_ROOT/scripts/agentchat-remote-autodeploy.sh"
  AUTODEPLOY_INSTALLED=false
  if [ ! -d "$REPO_ROOT/.git" ]; then
    echo "  Skipping ${AUTODEPLOY_SERVICE}: standalone package has no git checkout for autodeploy."
  elif [ ! -x "$AUTODEPLOY_SCRIPT" ]; then
    echo "  Skipping ${AUTODEPLOY_SERVICE}: missing git-checkout updater script: $AUTODEPLOY_SCRIPT"
  elif [ -f "$SCRIPT_DIR/push-relay-autodeploy.service" ]; then
    TMP_AD="$(mktemp)"
    trap 'rm -f "$TMP_AD"' EXIT
    sed \
      -e "s|__USER__|$SERVICE_USER|g" \
      -e "s|__REPODIR__|$REPO_ROOT|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      "$SCRIPT_DIR/push-relay-autodeploy.service" > "$TMP_AD"
    sudo install -m 0644 "$TMP_AD" "$AUTODEPLOY_UNIT"
    rm -f "$TMP_AD"
    trap - EXIT
    echo "  Installed ${AUTODEPLOY_SERVICE} service."

    # Provision sudoers rule so autodeploy (running as agent user) can restart the relay
    SUDOERS_FILE="/etc/sudoers.d/agentchat-autodeploy"
    SYSTEMCTL_BIN="$(command -v systemctl)"
    echo "$SERVICE_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN restart $SERVICE_NAME" \
      | sudo tee "$SUDOERS_FILE" >/dev/null
    sudo chmod 0440 "$SUDOERS_FILE"
    echo "  Provisioned sudoers rule: ${SUDOERS_FILE}"
    AUTODEPLOY_INSTALLED=true
  fi

  sudo systemctl daemon-reload
  if is_truthy "$AGENT_INSTALL_AUTOSTART"; then
    sudo systemctl enable "$SERVICE_NAME"
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
      sudo systemctl restart "$SERVICE_NAME"
      echo "  Restarted ${SERVICE_NAME}."
    else
      sudo systemctl start "$SERVICE_NAME"
      echo "  Started ${SERVICE_NAME}."
    fi
    # Enable + start autodeploy service
    if [ "$AUTODEPLOY_INSTALLED" = true ]; then
      sudo systemctl enable "$AUTODEPLOY_SERVICE"
      sudo systemctl restart "$AUTODEPLOY_SERVICE"
      echo "  Started ${AUTODEPLOY_SERVICE}."
    fi
  else
    echo "  Service autostart disabled for this install run (AGENT_INSTALL_AUTOSTART=$AGENT_INSTALL_AUTOSTART)."
  fi
else
  echo "[5/9] Installing launchd service ${SERVICE_NAME}..."
  # Parity note, stated rather than left silent: the auto-deploy watcher is
  # installed only on Linux (tracked as CD-003). On macOS the relay itself runs
  # under launchd, but updates must be applied by hand.
  echo "  NOTE: macOS does not get the autodeploy watcher; update with:"
  echo "        git -C \"$REPO_ROOT\" pull && ./install-remote.sh"
  echo "        See docs/DEPLOYMENT.md for the supported platform matrix."
  if [ "$SERVICE_NAME" != "$LEGACY_SERVICE_NAME" ]; then
    cleanup_legacy_launchd_service "$LEGACY_SERVICE_NAME"
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$SCRIPT_DIR/logs"
  cat > "$LAUNCHD_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
NODE_BIN="${NODE_BIN}"
if [ -z "\${NODE_BIN:-}" ] || [ ! -x "\$NODE_BIN" ]; then
  for _node in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /opt/homebrew/opt/node/bin/node; do
    if [ -x "\$_node" ]; then
      NODE_BIN="\$_node"
      break
    fi
  done
fi
if [ -z "\${NODE_BIN:-}" ] || [ ! -x "\$NODE_BIN" ]; then
  echo "node binary not found for launchd runner" >&2
  exit 127
fi
if [ -z "\${TMUX_BIN:-}" ]; then
  for _tmux in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux; do
    if [ -x "\$_tmux" ]; then
      export TMUX_BIN="\$_tmux"
      break
    fi
  done
fi
set -a
source "$ENV_FILE"
set +a
cd "$SCRIPT_DIR"
exec "\$NODE_BIN" "$SCRIPT_DIR/push-relay.js"
EOF
  chmod 0755 "$LAUNCHD_RUNNER"

  TMP_PLIST="$(mktemp)"
  trap 'rm -f "$TMP_PLIST"' EXIT
  sed \
    -e "s|__LABEL__|$SERVICE_NAME|g" \
    -e "s|__WORKDIR__|$SCRIPT_DIR|g" \
    -e "s|__RUNNER__|$LAUNCHD_RUNNER|g" \
    -e "s|__LOG_DIR__|$SCRIPT_DIR/logs|g" \
    "$SCRIPT_DIR/push-relay.plist" > "$TMP_PLIST"
  install -m 0644 "$TMP_PLIST" "$LAUNCHD_PLIST"
  rm -f "$TMP_PLIST"
  trap - EXIT

  if ! plutil -lint "$LAUNCHD_PLIST" >/dev/null 2>&1; then
    echo "Error: invalid launchd plist: $LAUNCHD_PLIST" >&2
    plutil -lint "$LAUNCHD_PLIST" >&2 || true
    exit 1
  fi

  if is_truthy "$AGENT_INSTALL_AUTOSTART"; then
    if ! launchd_bootstrap_service "$LAUNCHD_PLIST"; then
      echo "Error: failed to bootstrap launchd service '$SERVICE_NAME'." >&2
      echo "Hint: try manual checks:" >&2
      echo "  plutil -lint \"$LAUNCHD_PLIST\"" >&2
      echo "  launchctl print gui/$(id -u)/$SERVICE_NAME" >&2
      echo "  launchctl print user/$(id -u)/$SERVICE_NAME" >&2
      exit 1
    fi
    echo "  launchd domain: $LAUNCHD_DOMAIN"
  else
    echo "  Service autostart disabled for this install run (AGENT_INSTALL_AUTOSTART=$AGENT_INSTALL_AUTOSTART)."
  fi
fi

MCP_ENV_VARS=()
[ -n "${AGENT_CHAT_API:-}" ] && MCP_ENV_VARS+=("AGENT_CHAT_API=$AGENT_CHAT_API")
[ -n "${API_TOKEN:-}" ] && MCP_ENV_VARS+=("API_TOKEN=$API_TOKEN")
if [ -z "${API_TOKEN:-}" ]; then
  echo "  Warning: API_TOKEN is empty. Remote MCP calls to authenticated backend may fail."
fi

echo "[6/9] Configuring Claude Code MCP server..."
if command -v claude >/dev/null 2>&1; then
  CLAUDECODE= claude mcp remove -s user agent-chat 2>/dev/null || true
  CLAUDECODE= claude mcp remove -s local agent-chat 2>/dev/null || true
  CLAUDECODE= claude mcp remove -s project agent-chat 2>/dev/null || true
  CLAUDE_CMD=(claude mcp add -s user)
  for env_kv in "${MCP_ENV_VARS[@]}"; do
    CLAUDE_CMD+=(-e "$env_kv")
  done
  # Claude CLI parses -e as variadic; use `--` to terminate env args before name.
  CLAUDE_CMD+=(-- agent-chat node "$SCRIPT_DIR/mcp-server.js")
  if CLAUDECODE= "${CLAUDE_CMD[@]}"; then
    echo "  MCP server 'agent-chat' configured for Claude Code."
  else
    echo "Error: failed to configure Claude MCP server 'agent-chat'." >&2
    exit 1
  fi
else
  echo "  Warning: 'claude' CLI not found, skipping MCP configuration."
  echo "  Run manually: claude mcp add -s user -e AGENT_CHAT_API=<url> -e API_TOKEN=<token> -- agent-chat node $SCRIPT_DIR/mcp-server.js"
fi

echo "[7/9] Configuring Codex MCP server..."
if command -v codex >/dev/null 2>&1; then
  codex mcp remove agent-chat 2>/dev/null || true
  CODEX_CMD=(codex mcp add agent-chat)
  for env_kv in "${MCP_ENV_VARS[@]}"; do
    CODEX_CMD+=(--env "$env_kv")
  done
  CODEX_CMD+=(-- node "$SCRIPT_DIR/mcp-server.js")
  if "${CODEX_CMD[@]}"; then
    echo "  MCP server 'agent-chat' configured for Codex."
  else
    echo "Error: failed to configure Codex MCP server 'agent-chat'." >&2
    exit 1
  fi
else
  echo "  Warning: 'codex' CLI not found, skipping MCP configuration."
  echo "  Run manually: codex mcp add agent-chat --env AGENT_CHAT_API=<url> --env API_TOKEN=<token> -- node $SCRIPT_DIR/mcp-server.js"
fi

echo "[8/9] Running deployment verification..."
if is_truthy "$AGENT_INSTALL_SKIP_VERIFY" || ! is_truthy "$AGENT_INSTALL_AUTOSTART"; then
  echo "  Skipping verification (AGENT_INSTALL_SKIP_VERIFY=$AGENT_INSTALL_SKIP_VERIFY, AGENT_INSTALL_AUTOSTART=$AGENT_INSTALL_AUTOSTART)."
else
  VERIFY_ARGS=(
    --api "$AGENT_CHAT_API"
    --server "$AGENT_CHAT_SERVER"
    --samples "${VERIFY_SAMPLES:-3}"
    --interval "${VERIFY_INTERVAL:-15}"
    --service "$SERVICE_NAME"
  )
  if [ -n "${API_TOKEN:-}" ]; then
    VERIFY_ARGS+=(--token "$API_TOKEN")
  fi
  if [ -n "${VERIFY_AGENT:-}" ]; then
    VERIFY_ARGS+=(--agent "$VERIFY_AGENT")
  fi
  "$BIN_SOURCE_DIR/verify-remote" "${VERIFY_ARGS[@]}"
fi

echo "[9/9] Done. Service status:"
if [ "$IS_LINUX" = true ]; then
  sudo systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'
else
  launchctl print "gui/$(id -u)/$SERVICE_NAME" 2>/dev/null | sed -n '1,25p' \
    || launchctl print "user/$(id -u)/$SERVICE_NAME" 2>/dev/null | sed -n '1,25p' \
    || launchctl list | grep -F "$SERVICE_NAME" || true
fi

echo
echo "Next:"
echo "  1) Verify MCP: claude mcp list && codex mcp list"
echo "  2) Start agents: agent-up <name> <path> [claude|codex]"
echo "  3) Verify one agent: verify-remote --agent <name>"
