#!/bin/bash
# Agent Chat v2 installer
# Installs: backend-v2 systemd service, MCP server config
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
USER="$(whoami)"

echo "=== Agent Chat v2 Installer ==="
echo "Install dir: $INSTALL_DIR"
echo ""

# ── 1. Dependencies ──────────────────────────────────────────────────
echo "[1/4] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1

# ── 2. Create data directory ─────────────────────────────────────────
echo "[2/4] Creating data directory..."
mkdir -p "$INSTALL_DIR/data"

# ── 3. Install register-agents ───────────────────────────────────────
echo "[3/4] Making register-agents executable..."
chmod +x "$INSTALL_DIR/bin/register-agents"

# ── 4. Install systemd service ───────────────────────────────────────
echo "[4/4] Installing systemd service..."

SERVICE_FILE="/etc/systemd/system/agent-chat-v2.service"
sed -e "s|__USER__|$USER|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    "$INSTALL_DIR/agent-chat-v2.service" | sudo tee "$SERVICE_FILE" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable agent-chat-v2
sudo systemctl restart agent-chat-v2

sleep 1
if systemctl is-active --quiet agent-chat-v2; then
    echo ""
    echo "=== Installation complete ==="
    echo "  Service:  systemctl status agent-chat-v2"
    echo "  API:      http://127.0.0.1:8090"
    echo "  Register: bash bin/register-agents"
    echo ""
    echo "  To configure MCP for an agent, add to its project .mcp.json:"
    echo "    {"
    echo "      \"mcpServers\": {"
    echo "        \"agent-chat\": {"
    echo "          \"command\": \"node\","
    echo "          \"args\": [\"$INSTALL_DIR/mcp-server.js\"],"
    echo "          \"env\": { \"AGENT_NAME\": \"<agent-name>\" }"
    echo "        }"
    echo "      }"
    echo "    }"
else
    echo ""
    echo "WARNING: Service failed to start. Check: sudo journalctl -u agent-chat-v2 -f"
    exit 1
fi
