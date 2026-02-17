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
4. Verify MCP injection:
   - `claude mcp list`
   - `codex mcp list`
   - Both should include `agent-chat` with command `node .../mcp-server.js`
5. Launch remote agents:
   - `agent-up <name> <path> [claude|codex]`

## Notes

- `install-remote.sh` now links helper commands from `~/.local/bin` to this deploy directory.
  This keeps `.env`, `data/agents`, and `mcp-server.js` paths consistent for `agent-up/down/update`.
- Re-running `bash install-remote.sh` is safe and is the recommended way to refresh both service and MCP config after updates.
