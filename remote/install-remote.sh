#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-agent-chat-push-relay}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="${SUDO_USER:-$USER}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

echo "[1/6] Checking prerequisites..."
need_cmd node
need_cmd npm
need_cmd tmux
need_cmd systemctl
need_cmd sudo

echo "[2/6] Preparing environment..."
if [ ! -f "$ENV_FILE" ]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE (please fill API_TOKEN and AGENT_CHAT_SERVER)."
fi
mkdir -p "$SCRIPT_DIR/data/agents" "$SCRIPT_DIR/logs" "$INSTALL_BIN_DIR"

echo "[3/6] Installing Node dependencies..."
cd "$SCRIPT_DIR"
npm install --omit=dev

echo "[4/6] Installing helper commands into $INSTALL_BIN_DIR..."
install -m 0755 "$SCRIPT_DIR/bin/agent-up" "$INSTALL_BIN_DIR/agent-up"
install -m 0755 "$SCRIPT_DIR/bin/agent-down" "$INSTALL_BIN_DIR/agent-down"
install -m 0755 "$SCRIPT_DIR/bin/agent-ls" "$INSTALL_BIN_DIR/agent-ls"
install -m 0755 "$SCRIPT_DIR/bin/agent-send" "$INSTALL_BIN_DIR/agent-send"

echo "[5/6] Installing systemd service ${SERVICE_NAME}..."
TMP_UNIT="$(mktemp)"
sed \
  -e "s|__USER__|$SERVICE_USER|g" \
  -e "s|__WORKDIR__|$SCRIPT_DIR|g" \
  -e "s|__ENV_FILE__|$ENV_FILE|g" \
  "$SCRIPT_DIR/push-relay.service" > "$TMP_UNIT"
sudo install -m 0644 "$TMP_UNIT" "$SYSTEMD_UNIT"
rm -f "$TMP_UNIT"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

echo "[6/6] Done. Service status:"
sudo systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'

echo
echo "Next:"
echo "  1) Edit $ENV_FILE and set API_TOKEN + AGENT_CHAT_SERVER"
echo "  2) Restart relay: sudo systemctl restart $SERVICE_NAME"
echo "  3) Start agents: agent-up <name> <path> [claude|codex]"
