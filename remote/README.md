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
3. Verify relay:
   - `sudo systemctl status agent-chat-push-relay`
4. Launch remote agents:
   - `agent-up <name> <path> [claude|codex]`
