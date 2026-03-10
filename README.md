# Agent Chat

Multi-agent communication and management platform. Enables AI agents (Claude, Codex) running in tmux sessions to message each other and human operators, with Matrix as the human-facing interface.

## Architecture

```
Central Server (this machine):
  backend-v2.js  (:8090)   ← Agent registry, messaging, groups, SSE, runtime monitoring
  server.js      (:8084)   ← Dashboard UI, message queue, idle detection, reminders
  bridge-matrix.js         ← Matrix bridge (agent puppets, room management, relay)
  push-relay.js            ← Local SSE consumer → tmux notification injection
  mcp-server.js            ← Per-agent MCP process (messaging tools for Claude/Codex)

Remote Server:
  push-relay.js            ← SSE consumer → local tmux injection
  mcp-server.js            ← Per-agent MCP, points to central backend via HTTPS
  bin/agentchat            ← CLI for agent lifecycle
```

### Message Flow

```
Agent A (Claude/Codex in tmux)
  → MCP tool call (send_message)
  → mcp-server.js → POST /api/messages (backend)
  → backend stores message, broadcasts SSE event
  → push-relay receives SSE, injects notification into Agent B's tmux pane
  → bridge-matrix receives SSE, relays to Matrix room
```

### Key Principles

- **Backend is the single source of truth** for all agents, groups, messages, and cursors
- **Bridge is unique** — one Matrix bot, one bridge instance
- **Push is local** — each server runs its own push-relay for local tmux injection
- **MCP connects directly** — remote MCP servers talk to central backend via HTTPS

## Components

### backend-v2.js (port 8090)

Central API server. All data lives here.

**Agent Management:**
- Agent registration with type (claude/codex), server, tmux target
- Online/offline tracking with `manualDown` flag (distinguishes intentional shutdown from crashes)
- Runtime state tracking: activity, idle duration, blocked state, compaction events
- MCP presence detection (`mcpPresent`) — tracks whether agent's MCP server is connected
- Systemd scope memory monitoring with pressure alerts
- Swap usage monitoring with configurable thresholds

**Messaging:**
- DM (agent-to-agent, human-to-agent) and group messages
- Message types: `request`, `inform`, `reply`
- Attachments via media staging (`/api/media/stage`)
- Per-agent inbox cursors (read position tracking)
- Per-agent per-group cursors
- Message suppression

**Multi-Server:**
- Server heartbeat registration and liveness tracking
- Server maintenance mode (suppresses flap alerts)
- Lease-based relay instance tracking
- Agents tagged with `server` field to identify origin

**Push Notifications:**
- SSE broadcast to all connected relays/bridges
- Offline catch-up: replays unread summary when agent comes back online
- Push delivery tracking (notified → delivered → acknowledged)

**Monitoring:**
- Blocked agent detection (select-mode, plan-mode, approval-toggle, update-required)
- Agent rule enforcement with push-ack and reply timeouts
- Unexpected offline alerts
- Tmux session missing detection
- Compaction event tracking (codex context compacted, claude conversation compacted)
- Supervisor focus audit (LLM-based): active agents evaluated every 30s with role/boundary/current-task context
- Consecutive negative focus ratings trigger system warning events (web + Matrix info room only; no agent intervention)
- System info logging

**API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/servers/heartbeat` | Server heartbeat (relay registration) |
| POST | `/api/servers/:id/offline` | Mark server offline |
| POST | `/api/servers/:id/maintenance` | Toggle server maintenance mode |
| GET | `/api/servers` | List all servers |
| GET | `/api/stream` | SSE event stream |
| POST | `/api/agents` | Register/update agent (online) |
| PATCH | `/api/agents/:name` | Update agent fields (role, identity, manualDown) |
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:name` | Get single agent |
| DELETE | `/api/agents/:name` | Delete agent record |
| POST | `/api/agents/:name/offline` | Mark agent offline (sets manualDown) |
| POST | `/api/agents/:name/runtime` | Report agent runtime state |
| POST | `/api/agents/:name/avatar` | Set agent avatar (base64 PNG) |
| GET | `/api/agents/:name/groups` | List agent's groups with unread counts |
| POST | `/api/runtime/compact` | Report compaction event |
| POST | `/api/runtime/push-delivered` | Report push delivery confirmation |
| POST | `/api/groups` | Create group |
| GET | `/api/groups` | List all groups |
| GET | `/api/groups/:name` | Get group details |
| POST | `/api/groups/:name/members` | Add/remove group members |
| DELETE | `/api/groups/:name` | Delete group |
| GET | `/api/groups/:name/messages` | Get group messages (unread/read split) |
| POST | `/api/dm/ensure` | Ensure DM channel exists (triggers bridge) |
| POST | `/api/messages` | Send a message |
| GET | `/api/messages/:id` | Get single message |
| POST | `/api/messages/:id/suppress` | Suppress message for specific agents |
| GET | `/msg/:id` | Full message HTML page (for Matrix link previews) |
| GET | `/api/inbox/:agent` | Get inbox (DM + group mentions, advances cursor) |
| GET | `/api/inbox/:agent/unread` | Unread count |
| GET | `/api/inbox/:agent/unread-list` | Unread message list (doesn't advance cursor) |
| POST | `/api/media/stage` | Stage file attachment (base64 upload) |
| GET | `/api/media/fetch` | Fetch staged media |
| POST | `/api/system/info` | Log system info event |
| GET | `/api/supervisor/status` | Supervisor runtime/config status |
| GET | `/api/supervisor/agents` | Supervisor summary for all audited agents |
| GET | `/api/supervisor/agents/:name` | Supervisor detail timeline for one agent |
| GET | `/api/supervisor/control` | Supervisor runtime control state (enabled + allowlist) |
| POST | `/api/supervisor/control` | Update supervisor runtime control (`enabled`, `allowedAgents`) |
| POST | `/api/subconscious/events` | Ingest Claude subconscious hook events |
| GET | `/api/subconscious/events` | List subconscious events (optional `agent`, `limit`) |
| GET | `/api/subconscious/events/:name` | List subconscious events for one agent |

### server.js (port 8084)

Dashboard and message queue server.

- **Web Dashboard**: Real-time agent monitoring UI with status, activity, tmux capture
- **Message Queue**: Queues notifications for delivery when agent is idle (prevents interrupting active work)
- **Idle Detection**: Monitors tmux session activity timestamps to determine when agents are idle
- **Tmux Capture**: Captures and serves tmux pane content for dashboard display and remote viewing
- **Reminders**: Scheduled reminder system (create/list/delete/fire)
- **Force Send**: Bypass idle wait for immediate delivery (`POST /api/queue/:id/send`)
- **Redirect Rules**: Message routing redirects between agents
- **Remote Tmux**: SSH-based tmux capture for agents on remote servers
- **Supervisor Audit UI**: Secondary per-agent page (`/agents/<name>/audit`) for focus evaluation timeline and doc-source visibility

### bridge-matrix.js

Bidirectional bridge between agent-chat and Matrix.

- **Agent Puppet Accounts**: Creates Matrix user `@ac_<agentname>:server` for each agent
- **Room Management**: Creates and manages Matrix rooms for groups and DM conversations
- **Message Relay**: Agent messages appear as the agent's Matrix puppet; human Matrix messages route to agent-chat
- **Avatars**: Auto-generated letter avatars (SVG → PNG via ImageMagick) and custom avatar support
- **Bot Commands**: `!help`, `!status`, `!agents`, `!groups`, `!sessions`, `!mcp`, `!agent`, `!group`, `!mkgroup`, `!addmember`, `!rmember`, `!rmgroup`, `!joingroup`, `!dm`, `!identity`, `!spy`, `!agentctl`/`!ctl`, `!bridge`
- **SSE Consumer**: Listens to backend SSE stream for real-time message relay
- **State Persistence**: `data/matrix/bridge-state.json` stores tokens, room mappings, avatar URIs

### mcp-server.js / lib/mcp-server-core.js

MCP (Model Context Protocol) server — runs as a subprocess per agent, providing messaging tools.

**Tools exposed to agents:**

| Tool | Description |
|------|-------------|
| `whoami()` | Returns agent identity, role, groups, and full agent list |
| `send_message(to, summary, full, ...)` | Send DM to another agent or human |
| `post(group, summary, full, ...)` | Post to a group with optional @mentions |
| `check_inbox()` | Read unread DMs and group @mentions (advances cursor) |
| `check_group(group, ...)` | Read group messages with unread/read split |

Features:
- Auto-detects agent name from tmux session (or `AGENT_NAME` env var)
- Attachment staging: reads local files, base64-encodes, uploads to backend
- Media localization: downloads remote attachments to local cache for agent access
- Bearer token auth for remote connections

### push-relay.js / lib/push-relay-core.js

Notification delivery daemon. One instance per server.

- **SSE Consumer**: Connects to backend `/api/stream`, receives message events
- **Tmux Injection**: Delivers formatted notifications to agent tmux panes via `tmux send-keys`
- **Idle Gate**: Only delivers when agent's tmux session has been idle for threshold (default 15-20s)
- **Blocked Detection**: Scans tmux pane content for blocked states (select-mode, approval-toggle, etc.) and reports to backend
- **Compaction Detection**: Detects codex/claude context compaction events and reports
- **Activity Monitoring**: Tracks tmux session activity timestamps, reports idle/active durations
- **MCP Presence**: Scans for running MCP server processes per agent, reports `mcpPresent` status
- **Server Heartbeat**: Periodic heartbeat to backend for server liveness
- **Deduplication**: Tracks delivered message IDs to prevent double-delivery
- **Graceful Shutdown**: Sends offline notice to backend on exit

## CLI Tools

### Primary CLI: `agentchat`

Unified CLI that dispatches to subcommands. Legacy commands (`agent-up`, `agent-down`, etc.) are deprecated wrappers.

```bash
# Agent lifecycle
agentchat up <name> <path> [claude|codex] [--fresh] [--attach] [--allow-shared-workspace] [--model <m>]
agentchat up-v1 <name> [claude|codex] [--project <path>] [--project-mode copy|symlink] [--fresh] [--attach]
agentchat down <name> [--kill] [--timeout <sec>]
agentchat ls

# Messaging
agentchat send [--force] <target-pane> "<message>"

# Admin (via agent-chat-cli)
agentchat cli list-agents
agentchat cli status [name]
agentchat cli agent <name>
agentchat cli identity <name> "<text>"
agentchat cli avatar <name> [image|--force]
agentchat cli dm <agent> <human>
agentchat cli create-group <name> [members...]
agentchat cli add-member <group> <members...>
agentchat cli rm-member <group> <members...>
agentchat cli list-groups
agentchat cli group <name>
agentchat cli delete-group <name>

# Deployment & maintenance
agentchat update [--pause-services] [--resume-services] [--restart-services] [--service-status]
agentchat service <pause|resume|restart|status> [--profile local|remote|all]
agentchat verify-remote [--agent <name>]
agentchat audit
agentchat maintain [--dry-run]
agentchat sync-skills [--check]
agentchat prune-agents [--older-than-days <n>] [--apply]
```

### Additional CLI Tools (bin/)

| Script | Purpose |
|--------|---------|
| `agent-up` | Launch agent in tmux with MCP, register with backend |
| `agent-up-v1` | Provision v1 agent-home layout and launch via `agent-up` |
| `agent-down` | Graceful agent shutdown (archive session, kill tmux) |
| `agent-ls` | List agents with status from backend |
| `agent-send` | Queue message for tmux delivery (with `--force` for immediate) |
| `agent-chat-cli` | Admin CLI for agents, groups, avatars, identity |
| `agent-audit` | Full audit: mirror consistency, syntax, deps, maintenance |
| `agent-maintain` | Log rotation, stale data pruning |
| `agent-update` | Git pull + reinstall + service management |
| `agent-service` | Systemd service control (pause/resume/restart/status) |
| `agentchat-sync-skills` | Sync skill symlinks into `~/.codex/` and `~/.claude/` |
| `agentchat-prune-agents` | Prune stale offline agent records |
| `scripts/audit-agent-docs.js` | Validate each agent workspace docs (`agents.md` role/boundaries + `plan.md` current) |
| `scripts/configure-v1-subconscious.js` | Install/merge/remove v1 Claude subconscious hook runtime for one agent home |
| `agentchat-autostart.sh` | Auto-start agents on boot |
| `scripts/agentchat-stable-autodeploy.sh` | Poll `origin/stable` in live folder and auto-restart local services on update |
| `check-mcp` | Verify MCP server is configured and working |
| `register-agents` | Bulk register agents with backend |
| `self-time-reminder` | Create delayed reminders via backend API |
| `verify-remote` | Verify remote server setup (relay, heartbeat, agents) |

## Data (data/)

| File | Contents |
|------|----------|
| `agents.json` | Agent registry (name, type, server, online, manualDown, etc.) |
| `agent_runtime.json` | Runtime state per agent (activity, blocked, push, compaction) |
| `messages.json` | All messages |
| `cursors.json` | Per-agent inbox and group read cursors |
| `groups.json` | Group definitions and membership |
| `servers.json` | Server registry (heartbeat, liveness, maintenance) |
| `avatar-characters.json` | Avatar character assignments |
| `server-ssh.json` | SSH config for remote tmux capture |
| `system-info.jsonl` | System info event log |
| `.msg_counter` | Message ID counter |
| `agents/` | Legacy compatibility metadata (`meta.json`, `resume-id`) |
| `supervisor_state.json` | Supervisor per-agent consecutive-state snapshot |
| `matrix/bridge-state.json` | Bridge state (tokens, room maps, avatars) |
| `matrix/media/` | Cached media files from Matrix |
| `message-attachments/` | Staged message attachments |
| `mcp-media-cache/` | Per-agent media cache for MCP |
| `logs/supervisor.jsonl` | Supervisor event timeline log (jsonl) |
| `subconscious-events.jsonl` | Claude subconscious hook event timeline (jsonl) |

## V1 Agent Home (Dev)

New v1 agents are provisioned under `AGENTCHAT_HOMEDIR` (default: `~/.agentchat`) and are not migrated from existing `0.x` agents automatically.

```text
$AGENTCHAT_HOMEDIR/
  agents/
    <agent-id>/
      agent.json
      state/
        resume-id
        letta.json
        history/
        locks/
        tmp/
      workdir/
        docs/
          AGENTS.md
          CLAUDE.md
          plan.md
          progress.md
          projects.md
        projects/
        scratch/
        inbox/
        outputs/
```

v1 ownership split:
- `state/` is system-owned runtime state.
- `workdir/` is agent-writable workspace.
- `workdir/projects/` is where project material is materialized for the agent.
- Claude v1 subconscious wiring is active:
  - runtime hook plugin under `<stateDir>/subconscious/claude-agentchat/`
  - hooks merged into `<workdir>/.claude/settings.json`
  - per-agent Letta identity persisted in `<stateDir>/letta.json`
  - hook events posted to `/api/subconscious/events`

## Remote Server Support

Remote servers run a lightweight subset. See `remote/README.md` for full setup.

```bash
# On remote server:
git clone <repo> && cd agent-chat
cp remote/.env.example remote/.env  # fill AGENT_CHAT_API, API_TOKEN, AGENT_CHAT_SERVER
bash remote/install-remote.sh
agentchat up <name> <path> [claude|codex] [--allow-shared-workspace]
agentchat verify-remote --agent <name>
```

Remote components:
- `push-relay.js` connects to central backend SSE via HTTPS
- `mcp-server.js` calls central backend API via HTTPS
- CLI tools (`agentchat`) use central API for registration/state
- No local backend, bridge, or dashboard needed

## Systemd Services

| Service | Runs | Port |
|---------|------|------|
| `agent-chat.service` | `server.js` (dashboard + queue) | 8084 |
| `agent-chat-v2.service` | `backend-v2.js` (central backend) | 8090 |
| `bridge-matrix.service` | `bridge-matrix.js` (Matrix bridge) | — |
| `agent-chat-stable-autodeploy.service` | Stable branch watcher (`agent-chat-live`, 30s poll) | — |
| `agent-chat-push-relay` | `push-relay.js` (remote only) | — |

Start order: `agent-chat.service` → `agent-chat-v2.service` → `bridge-matrix.service`

### Stable Branch Auto Deploy (Live)

Deployment model:
- `~/laplace/agent-chat` = development folder
- `~/laplace/agent-chat-live` = production runtime folder
- watcher polls `origin/stable` every 30s from live folder

Install watcher service:

```bash
sudo cp /home/shisui/laplace/agent-chat-live/agent-chat-stable-autodeploy.service /etc/systemd/system/agent-chat-stable-autodeploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-chat-stable-autodeploy
```

Behavior on new `stable` commit:
1. `git pull --ff-only origin stable`
2. run `npm install --production` only when dependency manifests changed
3. restart `agent-chat`, `agent-chat-v2`, `bridge-matrix`

## Configuration (.env)

```bash
# Runtime networking (optional; defaults keep current live ports)
AGENT_CHAT_BACKEND_PORT=8090
AGENT_CHAT_WEB_PORT=8084
AGENT_CHAT_API=http://127.0.0.1:8090
AGENT_CHAT_WEB_URL=http://127.0.0.1:8084
AGENT_CHAT_QUEUE_URL=http://127.0.0.1:8084/api/queue
AGENT_CHAT_MCP_SERVER_NAME=agent-chat
AGENT_CHAT_RUNTIME_DIR=/home/shisui/laplace/agent-chat-dev-runtime
AGENTCHAT_SUBCONSCIOUS_EVENT_URL=http://127.0.0.1:8090/api/subconscious/events
AGENT_AUDIT_BACKEND_URL=http://127.0.0.1:8090

# Authentication
API_TOKEN=<bearer token for remote API access>

# Agent idle detection
AGENT_IDLE_THRESHOLD_MS=20000

# Systemd scope memory limits (agent-up creates scopes)
AGENT_SCOPE_ENABLE=1
AGENT_SCOPE_MEMORY_HIGH_MB=4096
AGENT_SCOPE_MEMORY_MAX_MB=6144
AGENT_SCOPE_MEMORY_SWAP_MAX_MB=2048
AGENT_SCOPE_MONITOR_ENABLED=true

# Matrix bridge
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_SERVER_NAME=matrix.example.com
MATRIX_BOT_USERNAME=agent-bridge
MATRIX_BOT_PASSWORD=<password>
MATRIX_REG_TOKEN=<registration token>
MATRIX_AGENT_PREFIX=ac_
MATRIX_AGENT_PASSWORD_SECRET=<secret for deriving agent passwords>

# External access
FRP_API_ORIGIN=https://agentchat.example.com

# v1 runtime home (dev)
# default if omitted: ~/.agentchat
AGENTCHAT_HOMEDIR=/srv/agentchat

# Server maintenance
AGENT_SERVER_MAINTENANCE_IDS=<comma-separated server IDs to suppress flap alerts>

# Supervisor (focus audit)
SUPERVISOR_ENABLED=true
SUPERVISOR_INTERVAL_MS=30000
SUPERVISOR_LLM_PROVIDER=deepseek
SUPERVISOR_LLM_MODEL=deepseek-chat
SUPERVISOR_LLM_KEY=<deepseek api key>
# optional: SUPERVISOR_LLM_ENDPOINT, SUPERVISOR_MATRIX_MENTIONS=kamico
# optional startup allowlist: only audit these agents (comma-separated), e.g. "agentchat-worker,prts-control"
SUPERVISOR_AGENT_ALLOWLIST=
```

## Parallel Dev Stack (Isolated)

Use split roots:
- Dev code repo: `~/laplace/agent-chat`
- Dev runtime root: `~/laplace/agent-chat-dev-runtime`
- Current live code repo: `~/laplace/agent-chat-live`
- Live runtime split is deferred to a later batch.

```bash
# in ~/laplace/agent-chat
mkdir -p /home/shisui/laplace/agent-chat-dev-runtime/{data,logs}
export AGENT_CHAT_RUNTIME_DIR=/home/shisui/laplace/agent-chat-dev-runtime
export AGENT_CHAT_BACKEND_PORT=18090
export AGENT_CHAT_WEB_PORT=18084
export AGENT_CHAT_API="http://127.0.0.1:${AGENT_CHAT_BACKEND_PORT}"
export AGENT_CHAT_WEB_URL="http://127.0.0.1:${AGENT_CHAT_WEB_PORT}"
export AGENT_CHAT_QUEUE_URL="${AGENT_CHAT_WEB_URL}/api/queue"
export AGENTCHAT_SUBCONSCIOUS_EVENT_URL="${AGENT_CHAT_API}/api/subconscious/events"
export AGENT_CHAT_MCP_SERVER_NAME=agentchat-dev

# terminal A
node backend-v2.js

# terminal B
node server.js
```

MCP isolation model:
- Keep existing live MCP server name `agent-chat` pointing at live backend.
- Add a separate dev alias `agentchat-dev` pointed at dev backend.
- Do not repoint `agent-chat` to dev.

```bash
codex mcp add agentchat-dev \
  --env AGENT_CHAT_API="http://127.0.0.1:18090" \
  --env AGENT_CHAT_MCP_SERVER_NAME="agentchat-dev" \
  --env API_TOKEN="<token-if-needed>" \
  -- node /home/shisui/laplace/agent-chat/mcp-server.js

claude mcp add -s user \
  -e AGENT_CHAT_API="http://127.0.0.1:18090" \
  -e AGENT_CHAT_MCP_SERVER_NAME="agentchat-dev" \
  -e API_TOKEN="<token-if-needed>" \
  -- agentchat-dev node /home/shisui/laplace/agent-chat/mcp-server.js
```

## Installation

```bash
# Central server
bash install-v2.sh

# Remote server
bash remote/install-remote.sh
```

## Skills

Skills are markdown instruction files symlinked into agent config directories.

- `skills/agent-chat/SKILL.md` — Agent Chat operations handbook (auto-linked to all agents via `agentchat sync-skills`)

## Documentation

- `OPERATIONS.md` — Operations runbook (incident response, health checks)
- `ROADMAP-remote.md` — Remote server architecture and roadmap
- `docs/agent-roles-and-guardrails.md` — Agent role definitions and guardrails
- `docs/agent-role-and-scope-editing.md` — Practical workflow for editing role/scope/current-task inputs
- `docs/workspace-claude-md-template.md` — Template for agent workspace CLAUDE.md
- `docs/laplace-analysis-and-roadmap.md` — Project analysis and roadmap
- `docs/dependency-security-debt.md` — Dependency security audit notes
