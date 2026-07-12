#!/bin/sh
set -eu

runtime_root=${AGENT_CHAT_RUNTIME_DIR:-/var/lib/agent-chat}
lock_dir="$runtime_root/data/services-local"
mkdir -p "$lock_dir"

exec 9>"$lock_dir/bridge-container.lock"
if ! flock --nonblock 9; then
  echo '[agentchat-services] bridge container ownership is already held' >&2
  exit 1
fi

node services/prepare-bridge-container.mjs
exec node bridge-matrix.js
