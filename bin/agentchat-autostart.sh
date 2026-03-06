#!/bin/bash
# agentchat-autostart.sh — Auto-start the agentchat agent on boot
# This script is called by agentchat-agent.service after system services are up.
# It launches agentchat via agent-up (resume if resume-id exists, otherwise --fresh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/../data/agents/agentchat"
RESUME_FILE="$AGENT_DIR/resume-id"
META_FILE="$AGENT_DIR/meta.json"

export HOME="/home/shisui"
export PATH="$HOME/.local/bin:$HOME/.pyenv/bin:$HOME/.pyenv/shims:/usr/local/bin:/usr/bin:/bin:$SCRIPT_DIR"

# Wait for backend to be ready (up to 30s)
for i in $(seq 1 30); do
  if curl -s --noproxy '*' -o /dev/null "http://localhost:8090/api/agents" 2>/dev/null; then
    break
  fi
  sleep 1
done

# Check if agentchat tmux session already exists
if tmux has-session -t agentchat 2>/dev/null; then
  echo "agentchat tmux session already exists, skipping"
  exit 0
fi

# Respect manual-down flag: do not auto-start intentionally stopped agents.
AGENT_JSON="$(curl -s --noproxy '*' "http://localhost:8090/api/agents/agentchat" 2>/dev/null || true)"
if [ -n "$AGENT_JSON" ]; then
  IS_MANUAL_DOWN="$(AGENT_JSON="$AGENT_JSON" python3 - <<'PY' 2>/dev/null || echo "0"
import json
import os

raw = os.environ.get("AGENT_JSON", "")
try:
    obj = json.loads(raw)
except Exception:
    print("0")
    raise SystemExit(0)

if isinstance(obj, dict) and not obj.get("error") and obj.get("manualDown") is True:
    print("1")
else:
    print("0")
PY
)"
  if [ "$IS_MANUAL_DOWN" = "1" ]; then
    echo "agentchat is marked manualDown=true in backend, skipping autostart"
    exit 0
  fi
fi

# Launch agentchat
if [ -f "$RESUME_FILE" ] && [ -s "$RESUME_FILE" ]; then
  echo "Resuming agentchat with saved resume-id..."
  "$SCRIPT_DIR/agent-up" agentchat
else
  echo "No resume-id found, starting fresh agentchat..."
  "$SCRIPT_DIR/agent-up" agentchat "$HOME" claude --fresh
fi

# Trigger automated reboot recovery after delay
RECOVERY_DELAY=${RECOVERY_TRIGGER_DELAY_SEC:-25}
(
  sleep "$RECOVERY_DELAY"
  if tmux has-session -t agentchat 2>/dev/null; then
    NOTIFICATION='[NOTIFICATION] From system (auto-reboot-recovery): "Server has rebooted. Run reboot recovery skill: check backend API for manualDown states, resume all previously active local agents. Report results to kamico." Reply after ALL WORK is done, using the agent-chat MCP tool: send_message(to="kamico", summary="your reply", full="detailed reply").'
    tmux send-keys -l -t agentchat:0.0 "$NOTIFICATION"
    sleep 0.3
    tmux send-keys -t agentchat:0.0 C-m
    echo "Recovery trigger injected at $(date)"
  else
    echo "agentchat tmux session not found, skipping recovery trigger"
  fi
) &
echo "Recovery trigger scheduled in ${RECOVERY_DELAY}s (pid=$!)"
