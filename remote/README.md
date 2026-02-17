# Agent Chat Remote Package

This folder is the deployable package for remote servers.

## Included

- `push-relay.js`
- `mcp-server.js`
- `lib/eventsource-mini.js`
- `bin/agent-up`
- `bin/agent-down`
- `bin/agent-ls`
- `bin/agent-send`
- `bin/agent-update`
- `push-relay.service`
- `.env.example`
- `install-remote.sh`

## Quick Start

1. Copy `.env.example` to `.env` and fill values:
   - `AGENT_CHAT_API=https://agentchat.ananthe.party`
   - `API_TOKEN=<backend token>`
   - `AGENT_CHAT_SERVER=<this server id>`
2. Run install:
   - `bash install-remote.sh`
   - Do not run as root. The script uses `sudo` only for systemd.
3. Verify relay:
   - `sudo systemctl status agent-chat-push-relay`
   - `verify-remote`
4. Verify MCP injection:
   - `claude mcp list`
   - `codex mcp list`
   - Both should include `agent-chat` with command `node .../mcp-server.js`
5. Launch remote agents:
   - `agent-up <name> <path> [claude|codex]`
6. Verify agent state after launch:
   - `verify-remote --agent <name>`

## Notes

- In normal `git clone` deployments, `install-remote.sh` uses repo-root `bin/` as the helper source of truth.
  `remote/bin` is only a fallback when root `bin/` is unavailable.
- The script links helpers into `~/.local/bin` (no copy), so path resolution stays consistent.
- Re-running `bash install-remote.sh` is safe and is the recommended way to refresh both service and MCP config after updates.
- `install-remote.sh` now runs hard verification and exits non-zero on failures (service inactive, heartbeat not increasing, auth issues, or agent/server mismatch when `VERIFY_AGENT` is set).

## Standard Deployment Template

Use this sequence for remote rollout and acceptance:

1. `agent-update`
2. `verify-remote`
3. `agent-up <name> <path> [claude|codex]`
4. `verify-remote --agent <name>`

Pass criteria:
- `agent-chat-push-relay` is `active`
- `/api/servers` shows target server `online=true` and `lastSeen` increasing across 3 samples
- `/api/agents/<name>` shows `online=true`, `server=<AGENT_CHAT_SERVER>`, `serverOnline=true`

Any failed step should stop immediately and be reported with raw command output.
