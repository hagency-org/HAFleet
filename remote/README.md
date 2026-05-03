# Agent Chat Remote Package

This folder is the deployable package for remote servers.
Most files here are managed by root-level generators/sync checks:
- Build output: `bash scripts/build-remote-package.sh`
- Sync managed files into `remote/`: `bash scripts/build-remote-package.sh --sync-remote`
- Validate managed files: `bash scripts/build-remote-package.sh --check`

## Included

- `bin/agentchat`
- `bin/agent-up`
- `bin/agent-down`
- `bin/agent-ls`
- `bin/agent-send`
- `bin/agent-service`
- `bin/agent-update`
- `bin/verify-remote`
- `bin/agent-maintain`
- `bin/agentchat-prune-agents`
- `bin/agent-chat` (deprecated alias)
- `push-relay.js`
- `mcp-server.js`
- `lib/push-relay-core.js`
- `lib/mcp-server-core.js`
- `lib/blocked-patterns.js`
- `lib/eventsource-mini.js`
- `push-relay.service`
- `push-relay-autodeploy.service` (installed only from git-checkout deployments)
- `.env.example`
- `install-remote.sh`

## CLI Migration

- New unified CLI: `agentchat`
- Legacy commands (`agent-up`, `agent-down`, `agent-send`, etc.) are deprecated wrappers that forward to `agentchat` with a warning.
- Remote `agentchat` only advertises commands included in this package. Central checkout commands such as `up-v1`, `project`, `graph`, `resume-id`, `benchmark`, `audit`, `sync-skills`, and `check-mcp` are intentionally not packaged here.

Examples:
- `agentchat up <name> <path> [claude|codex] [--allow-shared-workspace]`
- `agentchat down <name>`
- `agentchat update --pause-services` (git-checkout installs only)
- `agentchat cli fleet --expect-version <short-sha> [--json]`
- `agentchat maintain`
- `agentchat prune-agents --older-than-days 7 --apply`

## Quick Start

1. Copy `.env.example` to `.env` and fill values:
   - `AGENT_CHAT_API=https://agentchat.example.com`
   - `API_TOKEN=<backend token>`
   - `AGENT_CHAT_SERVER=<this server id>`
2. Run install:
   - `bash install-remote.sh`
   - Do not run as root. The script uses `sudo` only for systemd.
3. Verify relay:
   - `sudo systemctl status agent-chat-push-relay`
   - `agentchat verify-remote`
4. Verify MCP injection:
   - `claude mcp list`
   - `codex mcp list`
   - Both should include `agent-chat` with command `node .../mcp-server.js`
5. Launch remote agents:
   - `agentchat up <name> <path> [claude|codex] [--allow-shared-workspace]`
6. Verify agent state after launch:
   - `agentchat verify-remote --agent <name>`

Standalone package note: `agentchat update` does not self-update generated packages because they have no `.git` checkout. Preserve `.env`, `data`, and `logs`, then install from a git checkout with `bash remote/install-remote.sh`.

Git-checkout autodeploy note: after `agent-chat-push-relay` restarts, `agentchat-remote-autodeploy.sh` runs `verify-remote --expect-version <short-sha>` with `VERIFY_SAMPLES=2` and `VERIFY_INTERVAL=16` by default. Configure `AGENT_CHAT_API`, `AGENT_CHAT_SERVER`, `API_TOKEN`, and optional `VERIFY_AGENT` in `.env`; verification failure keeps the deploy pending for the next poll.

## Notes

- The central checkout operations runbook lives outside standalone remote packages. For generated packages, use the Standard Deployment Template below.
- In normal `git clone` deployments, `install-remote.sh` uses repo-root `bin/` as the helper source of truth.
  `remote/bin` is only a fallback when root `bin/` is unavailable.
- `remote/bin/agentchat` is profile-specific, not a byte-for-byte mirror of root `bin/agentchat`.
- `remote/bin/agent-up` is temporarily profile-specific while launch work is active; do not manually sync it to root `bin/agent-up` until that work is approved.
- `remote/push-relay.js` and `remote/mcp-server.js` are thin wrappers. Shared logic lives in:
  - `lib/push-relay-core.js`
  - `lib/mcp-server-core.js`
- The script links helpers into `~/.local/bin` (no copy), so path resolution stays consistent.
- Re-running `bash install-remote.sh` is safe and is the recommended way to refresh both service and MCP config after updates.
- `install-remote.sh` now runs hard verification and exits non-zero on failures (service inactive, heartbeat not increasing, auth issues, or agent/server mismatch when `VERIFY_AGENT` is set).
- Git-checkout remote autodeploy verifies the loaded commit after restart and does not report deploy success when verification fails.

## Standard Deployment Template

Use this sequence for remote rollout and acceptance:

1. `agentchat update`
2. `agentchat verify-remote --expect-version <short-sha>`
3. `agentchat up <name> <path> [claude|codex] [--allow-shared-workspace]`
4. `agentchat verify-remote --agent <name>`

Pass criteria:
- `agent-chat-push-relay` is `active`
- `/api/servers` shows target server `online=true` and `lastSeen` increasing across 3 samples
- `/api/agents/<name>` shows `online=true`, `server=<AGENT_CHAT_SERVER>`, `serverOnline=true`

Any failed step should stop immediately and be reported with raw command output.
