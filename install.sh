#!/bin/bash
# Agent Chat installer
# Installs: systemd service, agent-send CLI, skills for Claude/Codex
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
USER="$(whoami)"
HOME_DIR="$HOME"

echo "=== Agent Chat Installer ==="
echo "Install dir: $INSTALL_DIR"
echo "User: $USER"
echo ""

# ── 1. Dependencies ──────────────────────────────────────────────────
echo "[1/5] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1

# ── 2. Create logs directory ─────────────────────────────────────────
echo "[2/5] Creating logs directory..."
mkdir -p "$INSTALL_DIR/logs"

# ── 3. Install agent-send CLI ────────────────────────────────────────
echo "[3/5] Installing agent-send to ~/.local/bin..."
mkdir -p "$HOME_DIR/.local/bin"

# Make agent-send portable: replace hardcoded paths
sed "s|/home/shisui/laplace/agent-chat|$INSTALL_DIR|g" \
    "$INSTALL_DIR/bin/agent-send" > "$HOME_DIR/.local/bin/agent-send"
chmod +x "$HOME_DIR/.local/bin/agent-send"

# Ensure ~/.local/bin is in PATH
if ! echo "$PATH" | grep -q "$HOME_DIR/.local/bin"; then
    echo ""
    echo "  NOTE: Add to your shell profile:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
fi

# ── 4. Install skills ───────────────────────────────────────────────
echo "[4/5] Installing agent-message skill..."

# Claude Code skill
CLAUDE_SKILL_DIR="$HOME_DIR/.claude/skills/agent-message"
mkdir -p "$CLAUDE_SKILL_DIR"
ln -sf "$INSTALL_DIR/skills/agent-message/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
echo "  Linked: $CLAUDE_SKILL_DIR/SKILL.md"

# Codex skill (if .codex exists or create it)
CODEX_SKILL_DIR="$HOME_DIR/.codex/skills/agent-message"
mkdir -p "$CODEX_SKILL_DIR"
ln -sf "$INSTALL_DIR/skills/agent-message/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"
echo "  Linked: $CODEX_SKILL_DIR/SKILL.md"

# ── 5. Install systemd service ──────────────────────────────────────
echo "[5/5] Installing systemd service..."

SERVICE_FILE="/etc/systemd/system/agent-chat.service"
sed -e "s|__USER__|$USER|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    "$INSTALL_DIR/agent-chat.service" | sudo tee "$SERVICE_FILE" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable agent-chat
sudo systemctl restart agent-chat

sleep 1
if systemctl is-active --quiet agent-chat; then
    echo ""
    echo "=== Installation complete ==="
    echo "  Service:  systemctl status agent-chat"
    echo "  Web UI:   http://127.0.0.1:8084"
    echo "  CLI:      agent-send <target-pane> <message>"
    echo "  Skill:    agent-message (available in Claude Code & Codex)"
else
    echo ""
    echo "WARNING: Service failed to start. Check: sudo journalctl -u agent-chat -f"
    exit 1
fi
