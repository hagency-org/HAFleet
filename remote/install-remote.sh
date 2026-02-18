#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-agent-chat-push-relay}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="${SUDO_USER:-$USER}"
OS_NAME="$(uname -s)"
IS_LINUX=false
IS_MAC=false
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LAUNCHD_RUNNER="$SCRIPT_DIR/.push-relay-launchd.sh"

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
fi

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
if [ -z "${API_TOKEN:-}" ]; then
  echo "Warning: API_TOKEN is empty. This only works if backend allows unauthenticated requests."
fi

echo "[3/9] Installing Node dependencies..."
cd "$SCRIPT_DIR"
npm install --omit=dev

echo "[4/9] Linking helper commands into $INSTALL_BIN_DIR..."
required_cmds=(agent-up agent-down agent-ls agent-send agent-update verify-remote)
optional_cmds=(self-time-reminder agent-chat-cli)
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
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
else
  echo "[5/9] Installing launchd service ${SERVICE_NAME}..."
  mkdir -p "$HOME/Library/LaunchAgents" "$SCRIPT_DIR/logs"
  cat > "$LAUNCHD_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
source "$ENV_FILE"
set +a
cd "$SCRIPT_DIR"
exec /usr/bin/env node "$SCRIPT_DIR/push-relay.js"
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

  launchctl bootout "user/$(id -u)" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "user/$(id -u)" "$LAUNCHD_PLIST"
  launchctl enable "user/$(id -u)/$SERVICE_NAME" >/dev/null 2>&1 || true
  launchctl kickstart -k "user/$(id -u)/$SERVICE_NAME"
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

echo "[9/9] Done. Service status:"
if [ "$IS_LINUX" = true ]; then
  sudo systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'
else
  launchctl print "user/$(id -u)/$SERVICE_NAME" | sed -n '1,25p'
fi

echo
echo "Next:"
echo "  1) Verify MCP: claude mcp list && codex mcp list"
echo "  2) Start agents: agent-up <name> <path> [claude|codex]"
echo "  3) Verify one agent: verify-remote --agent <name>"
