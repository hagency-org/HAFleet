#!/bin/bash
# hafleet-autostart.sh — Auto-start the hafleet agent on boot
# This script is called by hafleet-agent.service after system services are up.
# It launches hafleet via hafleet-up (resume if resume-id exists, otherwise --fresh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$BASE_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
RUNTIME_DIR="${HAFLEET_RUNTIME_DIR:-$BASE_DIR}"
AGENT_DIR="$RUNTIME_DIR/data/agents/hafleet"
RESUME_FILE="$AGENT_DIR/resume-id"
META_FILE="$AGENT_DIR/meta.json"

resolve_home_dir() {
  if [ -n "${HAFLEET_HOME_DIR:-}" ]; then
    printf '%s\n' "$HAFLEET_HOME_DIR"
    return 0
  fi
  if [ -n "${HOME:-}" ]; then
    printf '%s\n' "$HOME"
    return 0
  fi
  if command -v getent >/dev/null 2>&1; then
    local passwd_home
    passwd_home="$(getent passwd "$(id -un)" | cut -d: -f6)"
    if [ -n "$passwd_home" ]; then
      printf '%s\n' "$passwd_home"
      return 0
    fi
  fi
  printf '%s\n' "$BASE_DIR"
}

export HOME="$(resolve_home_dir)"
export PATH="$HOME/.local/bin:$HOME/.pyenv/bin:$HOME/.pyenv/shims:/usr/local/bin:/usr/bin:/bin:$SCRIPT_DIR"

BACKEND_PORT_RAW="${HAFLEET_BACKEND_PORT:-8090}"
if [[ "$BACKEND_PORT_RAW" =~ ^[0-9]+$ ]] && [ "$BACKEND_PORT_RAW" -gt 0 ]; then
  BACKEND_PORT="$BACKEND_PORT_RAW"
else
  BACKEND_PORT="8090"
fi
BACKEND_URL="${HAFLEET_API:-http://127.0.0.1:$BACKEND_PORT}"

# Wait for backend to be ready (up to 30s)
for i in $(seq 1 30); do
  if curl -s --noproxy '*' -o /dev/null "$BACKEND_URL/api/agents" 2>/dev/null; then
    break
  fi
  sleep 1
done

# Check if hafleet tmux session already exists
if tmux has-session -t hafleet 2>/dev/null; then
  echo "hafleet tmux session already exists, skipping"
  exit 0
fi

# Respect manual-down flag: do not auto-start intentionally stopped agents.
AGENT_JSON="$(curl -s --noproxy '*' "$BACKEND_URL/api/agents/hafleet" 2>/dev/null || true)"
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
    echo "hafleet is marked manualDown=true in backend, skipping autostart"
    exit 0
  fi
fi

# Launch hafleet
if [ -f "$RESUME_FILE" ] && [ -s "$RESUME_FILE" ]; then
  echo "Resuming hafleet with saved resume-id..."
  "$SCRIPT_DIR/hafleet-up" hafleet
else
  echo "No resume-id found, starting fresh hafleet..."
  "$SCRIPT_DIR/hafleet-up" hafleet "$HOME" claude --fresh
fi

# Trigger automated reboot recovery after delay
RECOVERY_DELAY=${RECOVERY_TRIGGER_DELAY_SEC:-25}
(
  sleep "$RECOVERY_DELAY"
  if tmux has-session -t hafleet 2>/dev/null; then
    NOTIFICATION='[NOTIFICATION] From system (auto-reboot-recovery): "Server has rebooted. Run reboot recovery skill: check backend API for manualDown states, resume all previously active local agents. Report results to operator." Reply after ALL WORK is done, using the hafleet MCP tool: send_message(to="operator", summary="your reply", full="detailed reply").'
    tmux send-keys -l -t hafleet:0.0 "$NOTIFICATION"
    sleep 0.3
    tmux send-keys -t hafleet:0.0 C-m
    echo "Recovery trigger injected at $(date)"
  else
    echo "hafleet tmux session not found, skipping recovery trigger"
  fi
) &
echo "Recovery trigger scheduled in ${RECOVERY_DELAY}s (pid=$!)"
