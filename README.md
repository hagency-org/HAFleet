# Agent Chat

Multi-agent communication and management platform. Enables AI agents (Claude, Codex) running in tmux sessions to message each other and human operators, with Matrix as the human-facing interface.

## Architecture

```
Central Server (this machine):
  backend-v2.js  (:8090)   ← Agent registry, messaging, groups, tasks, alerts, SSE, runtime monitoring
  server.js      (:8084)   ← Dashboard UI, message queue, idle detection, reminders, alert UI
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

- **Backend is the single source of truth** for all agents, groups, messages, cursors, tasks, and alerts
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
- Deletion tombstones with undelete support

**Messaging:**
- DM (agent-to-agent, human-to-agent) and group messages
- Message types: `request`, `inform`, `reply`
- Priority levels: `normal`, `high`, `urgent` (high/urgent skip idle delivery gate)
- Structured message schemas (`schema.kind`, `schema.payload`)
- Attachments via media staging (`/api/media/stage`)
- Per-agent inbox cursors (read position tracking)
- Per-agent per-group cursors
- Message suppression

**Tasks & Task Graphs:**
- Task store: create, assign, transition (`created` → `accepted` → `in_progress` → `done`; `in_progress` ↔ `blocked`)
- Priorities: `p0`, `p1`, `p2`, `p3`; Granularities: `epic`, `task`, `subtask`
- Task graph orchestration: DAG-based multi-task workflows with node dependencies
- Agent-token auth for task acceptance and execution updates

**Alert Ticket System:**
- Alert store with deduplication by `dedupeKey`
- Severities: `info`, `warning`, `critical`
- Status state machine: `open` → `acknowledged`/`assigned`/`resolved`/`suppressed`; `resolved` is terminal
- Auto-resolution via recovery event mapping (e.g. `mcp_recovered` resolves `mcp_missing`)
- Suppress with expiry (`suppressUntil`), auto-reopen on new occurrence after expiry
- Reopen window (5 min) for recently resolved alerts
- Notes, tags, linked tasks
- 4 ingestion hooks: system events, per-agent blocked aggregation, supervisor actions, API

**Multi-Server:**
- Server heartbeat registration and liveness tracking
- Server maintenance mode (suppresses flap alerts)
- Lease-based relay instance tracking
- Agents tagged with `server` field to identify origin

**Push Notifications:**
- SSE broadcast to all connected relays/bridges
- Offline catch-up: replays unread summary when agent comes back online
- Push delivery tracking (notified → delivered → acknowledged)

**Supervisor (Focus Audit):**
- LLM-based focus evaluation: active agents assessed every 30s with role/boundary/task context
- Supervisor action engine with threshold-based nudge and escalation
- Consecutive negative ratings trigger nudge (to agent) then escalation (to operator)
- Configurable cooldowns and thresholds
- Supervisor snapshot store for per-agent state persistence
- Runtime control: enable/disable, agent allowlist

**Monitoring:**
- Blocked agent detection (select-mode, plan-mode, approval-toggle, update-required)
- Agent rule enforcement with push-ack and reply timeouts
- Unexpected offline alerts with throttling
- Tmux session missing detection with grace period
- Compaction event tracking (codex context compacted, claude conversation compacted)
- System info logging

**Authentication:**
- Bearer token auth (`API_TOKEN`) for admin/operator routes
- Server heartbeat/offline and remote runtime report routes currently use the same `API_TOKEN` compatibility bearer; `AGENTCHAT_SERVER_TOKEN` is a documented future split and is not accepted or enforced yet
- Agent-token auth (`X-Agent-Token` header) for agent-specific routes (runtime, task transitions, alert transitions for assigned alerts)
- Agent-token mode: `hard` and `soft` enforce loaded agent tokens; `audit` logs and allows; other values currently normalize to `audit`
- `/health` reports agent-token readiness and the current server credential compatibility boundary
- Bridge secret (`MATRIX_BRIDGE_SECRET`) for bridge-specific routes
- Subconscious event token for hook ingestion

**API Endpoints:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| GET | `/api/stream` | — | SSE event stream |
| GET | `/msg/:id` | — | Full message HTML page (Matrix link previews) |
| **Servers** ||||
| POST | `/api/servers/heartbeat` | bearer (`API_TOKEN`) | Server heartbeat (relay registration) |
| POST | `/api/servers/:id/offline` | bearer (`API_TOKEN`) | Mark server offline |
| POST | `/api/servers/:id/maintenance` | bearer (`API_TOKEN`) | Toggle operator-owned server maintenance mode |
| GET | `/api/servers` | — | List all servers |
| **Agents** ||||
| POST | `/api/agents` | agent-token | Register/update agent (online) |
| GET | `/api/agents` | — | List all agents |
| GET | `/api/agents/:name` | — | Get single agent |
| PATCH | `/api/agents/:name` | agent-token | Update agent fields (role, identity, manualDown) |
| DELETE | `/api/agents/:name` | bearer | Delete agent record (tombstone) |
| POST | `/api/agents/:name/undelete` | bearer | Undelete agent from tombstone |
| POST | `/api/agents/:name/offline` | agent-token | Mark agent offline (sets manualDown) |
| POST | `/api/agents/:name/runtime` | agent-token | Report agent runtime state |
| POST | `/api/agents/:name/avatar` | agent-token | Set agent avatar (base64 PNG) |
| GET | `/api/agents/:name/groups` | — | List agent's groups with unread counts |
| GET | `/api/agents/:name/tasks` | — | Get agent tasks |
| **Runtime** ||||
| POST | `/api/runtime/compact` | bearer | Report compaction event |
| POST | `/api/runtime/push-delivered` | — | Report push delivery confirmation |
| **Groups** ||||
| POST | `/api/groups` | bridge-secret | Create group |
| GET | `/api/groups` | — | List all groups |
| GET | `/api/groups/:name` | — | Get group details |
| POST | `/api/groups/:name/members` | bridge-secret | Add/remove group members |
| DELETE | `/api/groups/:name` | bridge-secret | Delete group |
| GET | `/api/groups/:name/messages` | — | Get group messages (unread/read split) |
| **DM** ||||
| POST | `/api/dm/ensure` | bearer | Ensure DM channel exists (triggers bridge) |
| **Messages** ||||
| POST | `/api/messages` | agent-token | Send a message |
| GET | `/api/messages/:id` | — | Get single message |
| POST | `/api/messages/:id/suppress` | agent-token | Suppress message for specific agents |
| **Inbox** ||||
| GET | `/api/inbox/:agent` | agent-token | Get inbox (DM + group mentions, advances cursor) |
| GET | `/api/inbox/:agent/unread` | agent-token | Unread count |
| GET | `/api/inbox/:agent/unread-list` | agent-token | Unread message list (doesn't advance cursor) |
| **Media** ||||
| POST | `/api/media/stage` | agent-token | Stage file attachment (base64 upload) |
| GET | `/api/media/fetch` | — | Fetch staged media |
| **System** ||||
| POST | `/api/system/info` | bridge-secret | Log system info event (with optional alertType/dedupeKey/sourceAgent) |
| **Tasks** ||||
| POST | `/api/tasks` | bearer | Create task |
| GET | `/api/tasks` | — | List tasks |
| GET | `/api/tasks/:id` | — | Get task |
| PATCH | `/api/tasks/:id` | bearer | Update task |
| PATCH | `/api/tasks/:id/execution` | agent-token | Update task execution |
| DELETE | `/api/tasks/:id` | bearer | Delete task |
| POST | `/api/tasks/:id/accept` | agent-token | Accept task |
| POST | `/api/tasks/:id/transition` | agent-token | Transition task status |
| **Task Graphs** ||||
| POST | `/api/task-graphs` | bearer | Create task graph |
| GET | `/api/task-graphs` | — | List task graphs |
| GET | `/api/task-graphs/:id` | — | Get task graph |
| DELETE | `/api/task-graphs/:id` | bearer | Delete task graph |
| PATCH | `/api/task-graphs/:id/nodes/:nodeId` | agent-token | Update task graph node |
| **Alerts** ||||
| GET | `/api/alerts` | bearer | List alerts (filters: status, severity, sourceAgent, alertType, assignee) |
| GET | `/api/alerts/stats` | bearer | Alert statistics (by status, severity) |
| GET | `/api/alerts/:id` | bearer | Get single alert |
| POST | `/api/alerts/:id/transition` | bearer/agent-token | Transition alert status |
| POST | `/api/alerts/:id/notes` | bearer | Add note to alert |
| PATCH | `/api/alerts/:id` | bearer | Update alert (tags, linkedTaskId) |
| DELETE | `/api/alerts/:id` | bearer | Delete alert |
| **Supervisor** ||||
| GET | `/api/supervisor/status` | — | Supervisor runtime/config status |
| GET | `/api/supervisor/agents` | — | Supervisor summary for all audited agents |
| GET | `/api/supervisor/agents/:name` | — | Supervisor detail timeline for one agent |
| GET | `/api/supervisor/control` | — | Supervisor runtime control state |
| POST | `/api/supervisor/control` | bearer | Update supervisor control (enabled, allowedAgents) |
| PATCH | `/api/supervisor-state/:target` | agent-token | Update supervisor state |
| POST | `/api/supervisor-state/:target/heartbeat` | agent-token | Supervisor heartbeat |
| **Subconscious** ||||
| POST | `/api/subconscious/events` | token | Ingest Claude subconscious hook events |
| GET | `/api/subconscious/events` | — | List subconscious events |
| GET | `/api/subconscious/events/:name` | — | List events for one agent |
| GET | `/api/subconscious/detail/:name` | — | Subconscious detail for one agent |
| POST | `/api/subconscious/upstream/*` | — | Upstream hook event routes (bootstrap, session-start, user-prompt, pretool, stop) |
| POST | `/api/subconscious/runtime/invoke/:name` | — | Runtime invoke |

### server.js (port 8084)

Dashboard and message queue server.

- **Web Dashboard**: Real-time agent monitoring UI with status, activity, tmux capture
- **Alert Dashboard**: `/alerts` page with alert listing, transitions, and stats
- **Alert Badge**: Real-time alert count in main dashboard header (30s polling + SSE)
- **Message Queue**: Queues notifications for delivery when agent is idle (prevents interrupting active work)
- **Idle Detection**: Monitors tmux session activity timestamps to determine when agents are idle
- **Tmux Capture**: Captures and serves tmux pane content for dashboard display and remote viewing
- **Reminders**: Scheduled reminder system (create/list/delete/fire)
- **Force Send**: Bypass idle wait for immediate delivery (`POST /api/queue/:id/send`)
- **Redirect Rules**: Message routing redirects between agents
- **Remote Tmux**: SSH-based tmux capture for agents on remote servers
- **Supervisor Audit UI**: Secondary per-agent page (`/agents/<name>/audit`) for focus evaluation timeline and doc-source visibility
- **Backend SSE Consumer**: Raw HTTP fetch streaming to forward alert events from backend to dashboard clients

### bridge-matrix.js

Bidirectional bridge between agent-chat and Matrix.

- **Agent Puppet Accounts**: Creates Matrix user `@ac_<agentname>:server` for each agent
- **Room Management**: Creates and manages Matrix rooms for groups and DM conversations
- **Message Relay**: Agent messages appear as the agent's Matrix puppet; human Matrix messages route to agent-chat
- **Avatars**: Auto-generated letter avatars (SVG → PNG via ImageMagick) and custom avatar support
- **SSE Consumer**: Listens to backend SSE stream for real-time message relay
- **State Persistence**: `data/matrix/bridge-state.json` stores tokens, room mappings, avatar URIs
- **Bot Command ACL**: Tiered access control for Matrix bot commands

**Bot Commands:**

| Tier | Command | Description |
|------|---------|-------------|
| 0 (public) | `!help` | Show available commands |
| 1 (operator) | `!status` | System overview |
| 1 | `!agents` | List known agents |
| 1 | `!groups` | List all groups |
| 1 | `!sessions` | Tmux sessions + current process |
| 1 | `!mcp` | MCP status per session |
| 1 | `!bridge` | Bridge internal state |
| 1 | `!agent [name]` | Agent details (auto-detect in DM) |
| 1 | `!group [name]` | Group details (auto-detect in group) |
| 2 (operator) | `!mkgroup <name> <m1> <m2>` | Create group |
| 2 | `!addmember [group] <name>` | Add member to group |
| 2 | `!rmember [group] <name>` | Remove member from group |
| 2 | `!rmgroup [group]` | Delete group + Matrix room |
| 2 | `!joingroup [group]` | Join a group yourself |
| 2 | `!dm <agent>` | Create DM room with agent |
| 2 | `!identity [agent] <text>` | Set agent identity |
| 3 (admin) | `!spy <a1> <a2>` | Join agent DM room to watch |
| 3 | `!agentctl <agent> status\|send\|key` | Full agent control |
| 3 | `!ctl status\|send\|key` | Shorthand (in agent DM context) |

ACL is configured via `MATRIX_OPERATOR_MXIDS` and `MATRIX_ADMIN_MXIDS` env vars.

### mcp-server.js / lib/mcp-server-core.js

MCP (Model Context Protocol) server — runs as a subprocess per agent, providing messaging tools.

**Tools exposed to agents:**

| Tool | Description |
|------|-------------|
| `whoami()` | Returns concise identity info, joined group names, and agent names |
| `send_message(to, summary, full, type?, priority?, reply_to?, attachments?, schema?)` | Send DM to another agent or human |
| `post(group, summary, full, type?, priority?, mentions?, reply_to?, attachments?, schema?)` | Post to a group with optional @mentions |
| `check_inbox(kinds?)` | Read unread DMs and group @mentions (advances cursor; non-destructive preview when filtered by kinds) |
| `check_group(group, limit?, unread_limit?, read_all?)` | Read group messages with unread/read split |

Features:
- Auto-detects agent name from tmux session (or `AGENT_NAME` env var)
- Attachment staging: reads local files, base64-encodes, uploads to backend
- Media localization: downloads remote attachments to local cache for agent access
- Image sanitization via ImageMagick
- Bearer token + agent-token auth for remote connections

### push-relay.js / lib/push-relay-core.js

Notification delivery daemon. One instance per server.

- **SSE Consumer**: Connects to backend `/api/stream`, receives message events
- **Tmux Injection**: Delivers formatted notifications to agent tmux panes via `tmux send-keys`
- **Idle Gate**: Only delivers when agent's tmux session has been idle for threshold (default 15-20s)
- **Priority Override**: High/urgent messages skip idle wait
- **Blocked Detection**: Scans tmux pane content for blocked states (select-mode, approval-toggle, etc.) and reports to backend
- **Compaction Detection**: Detects codex/claude context compaction events and reports
- **Activity Monitoring**: Tracks tmux session activity timestamps, reports idle/active durations
- **MCP Presence**: Scans for running MCP server processes per agent, reports `mcpPresent` status
- **Server Heartbeat**: Periodic heartbeat to backend for server liveness
- **Deduplication**: Tracks delivered message IDs to prevent double-delivery
- **Graceful Shutdown**: Sends offline notice to backend on exit

### lib/ Modules

| Module | Purpose |
|--------|---------|
| `alert-store.js` | Alert ticket management store (factory pattern) |
| `agent-home-v1.js` | V1 agent home provisioning |
| `agent-state.js` | Agent state utilities |
| `benchmark-workflow.js` | Benchmarking workflows |
| `blocked-patterns.js` | Blocked state detection patterns |
| `bot-commands.js` | Matrix bot command handlers + ACL |
| `eventsource-mini.js` | Lightweight SSE client |
| `mcp-server-core.js` | MCP server core logic |
| `notification-router.js` | Notification routing and warning aggregation |
| `push-relay-core.js` | Push relay core logic |
| `runtime-dir-guard.js` | Runtime directory validation |
| `supervisor-action-engine.js` | Supervisor nudge/escalation engine |
| `supervisor-lifecycle-manager.js` | Supervisor lifecycle management |
| `supervisor-provisioning.js` | Supervisor agent provisioning |
| `supervisor-snapshot-store.js` | Supervisor per-agent state snapshots |
| `task-graph.js` | Task graph orchestration (DAG) |
| `task-store.js` | Task store (factory pattern) |
| `upstream-claude-subconscious.js` | Claude subconscious integration |

## CLI Tools

### Primary CLI: `agentchat`

Unified CLI that dispatches to subcommands. Legacy commands (`agent-up`, `agent-down`, etc.) are deprecated wrappers.

```bash
# Agent lifecycle
agentchat up <name> <path> [claude|codex] [--fresh] [--attach] [--allow-shared-workspace] [--model <m>]
agentchat up-v1 <name> [claude|codex] [--project <path>] [--project-mode copy|symlink] [--fresh] [--attach]
agentchat down <name> [--kill] [--timeout <sec>]
agentchat ls

# V1 project management
agentchat project <agent> add <name> <source-path> [--mode copy|symlink]
agentchat project <agent> remove <name>
agentchat project <agent> list

# Task graph orchestration
agentchat graph create <file.json>
agentchat graph list
agentchat graph show <id>
agentchat graph delete <id>

# Messaging
agentchat send [--force] <target-pane> "<message>"

# Reminders
agentchat reminder <delay_seconds> "<message>"

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
agentchat benchmark
agentchat maintain [--dry-run]
agentchat sync-skills [--check]
agentchat prune-agents [--older-than-days <n>] [--apply]
agentchat check-mcp
```

### Additional CLI Tools (bin/)

| Script | Purpose |
|--------|---------|
| `agent-up` | Launch agent in tmux with MCP, register with backend |
| `agent-up-v1` | Provision v1 agent-home layout and launch via `agent-up` |
| `agent-project` | Manage v1 agent project bindings (add/remove/list) |
| `agent-graph` | Task graph CLI (create/list/show/delete) |
| `agent-down` | Graceful agent shutdown (archive session, kill tmux) |
| `agent-ls` | List agents with status from backend |
| `agent-send` | Queue message for tmux delivery (with `--force` for immediate) |
| `agent-chat-cli` | Admin CLI for agents, groups, avatars, identity |
| `agent-audit` | Full audit: mirror consistency, syntax, deps, maintenance |
| `agent-benchmark` | Benchmark workflow foundations |
| `agent-maintain` | Log rotation, stale data pruning |
| `agent-update` | Git pull + reinstall + service management |
| `agent-service` | Systemd service control (pause/resume/restart/status) |
| `agentchat-sync-skills` | Sync skill symlinks into `~/.codex/` and `~/.claude/` |
| `agentchat-prune-agents` | Prune stale offline agent records |
| `scripts/audit-agent-docs.js` | Validate each agent workspace docs (role/boundaries + plan) |
| `scripts/configure-v1-subconscious.js` | Install/merge/remove v1 Claude subconscious hook runtime |
| `agentchat-autostart.sh` | Auto-start agents on boot |
| `scripts/agentchat-stable-autodeploy.sh` | Poll `origin/stable` in live folder and auto-restart services |
| `check-mcp` | Verify MCP server is configured and working |
| `register-agents` | Bulk register agents with backend |
| `self-time-reminder` | Create delayed reminders via backend API |
| `verify-remote` | Verify remote server setup (relay, heartbeat, agents) |

## Data (data/)

| File | Contents |
|------|----------|
| `agents.json` | Agent registry (name, type, server, online, manualDown, etc.) |
| `deleted_agents.json` | Tombstones for deleted agents (supports undelete) |
| `agent_runtime.json` | Runtime state per agent (activity, blocked, push, compaction) |
| `messages.json` | All messages |
| `cursors.json` | Per-agent inbox and group read cursors |
| `groups.json` | Group definitions and membership |
| `servers.json` | Server registry (heartbeat, liveness, maintenance) |
| `tasks.json` | Task store (agent assignments, status transitions) |
| `task_graphs.json` | Task graph orchestration (DAG workflows) |
| `alerts.json` | Alert ticket store (dedup, status, notes) |
| `supervisor_snapshots.json` | Supervisor per-agent consecutive-state snapshots |
| `local_activity_sweep.json` | Local activity sweep state |
| `avatar-characters.json` | Avatar character assignments |
| `server-ssh.json` | SSH config for remote tmux capture |
| `system-info.jsonl` | System info event log |
| `.msg_counter` | Message ID counter |
| `agents/` | Legacy compatibility metadata (`meta.json`, `resume-id`) |
| `matrix/bridge-state.json` | Bridge state (tokens, room maps, avatars) |
| `matrix/media/` | Cached media files from Matrix |
| `message-attachments/` | Staged message attachments |
| `mcp-media-cache/` | Per-agent media cache for MCP |
| `logs/supervisor.jsonl` | Supervisor event timeline log (jsonl) |
| `subconscious-events.jsonl` | Claude subconscious hook event timeline (jsonl) |

## V1 Agent Home

New v1 agents are provisioned under `AGENTCHAT_HOMEDIR` (default: `~/.agentchat`) via `agentchat up-v1`.

```text
$AGENTCHAT_HOMEDIR/
  agents/
    <agent-id>/
      agent.json
      state/
        resume-id
        agent-token
        letta.json
        subconscious/
        history/
        locks/
        tmp/
      workdir/
        CLAUDE.md
        AGENTS.md
        docs/
          plan.md
          progress.md
          projects.md
          agent-knowledge.md
        projects/
        scratch/
        inbox/
        outputs/
        .claude/
```

v1 ownership split:
- `state/` is system-owned runtime state (resume-id, agent-token, locks, subconscious hooks).
- `workdir/` is agent-writable workspace.
- `workdir/projects/` is where project material is materialized for the agent (copy or symlink).
- Agent-token stored at `state/agent-token`, used for authenticating agent API calls.
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

### Live (production)

| Service | Runs | Port |
|---------|------|------|
| `agent-chat.service` | `server.js` (dashboard + queue) | 8084 |
| `agent-chat-v2.service` | `backend-v2.js` (central backend) | 8090 |
| `bridge-matrix.service` | `bridge-matrix.js` (Matrix bridge) | — |
| `agent-chat-stable-autodeploy.service` | Stable branch watcher (`agent-chat-live`, 30s poll) | — |
| `agent-chat-push-relay` | `push-relay.js` (remote only) | — |

Start order: `agent-chat-v2.service` → `agent-chat.service` → `bridge-matrix.service`

### Dev (user services)

| Service | Runs | Port |
|---------|------|------|
| `agent-chat-dev-backend.service` | `backend-v2.js` (dev backend) | 18190 |
| `agent-chat-dev-web.service` | `server.js` (dev dashboard) | 18184 |
| `agent-chat-dev-autodeploy.service` | Dev branch watcher | — |

Dev services are `systemctl --user` managed. Enable with:
```bash
systemctl --user enable --now agent-chat-dev-backend agent-chat-dev-web agent-chat-dev-autodeploy
```

### Stable Branch Auto Deploy (Live)

Deployment model:
- `~/laplace/agent-chat` = development folder
- `~/laplace/agent-chat-live` = production runtime folder
- watcher polls `origin/stable` every 30s from live folder

Install watcher service:

```bash
sudo cp /path/to/agent-chat/agent-chat-stable-autodeploy.service /etc/systemd/system/agent-chat-stable-autodeploy.service
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
AGENT_CHAT_RUNTIME_DIR=/path/to/agent-chat-dev-runtime
AGENTCHAT_SUBCONSCIOUS_EVENT_URL=http://127.0.0.1:8090/api/subconscious/events
AGENT_AUDIT_BACKEND_URL=http://127.0.0.1:8090

# Authentication
API_TOKEN=<bearer token for remote API access>
AGENTCHAT_SERVER_TOKEN=<future server credential; diagnostic only, not accepted yet>
AGENTCHAT_AGENT_TOKEN_MODE=hard        # hard/soft enforce loaded tokens; audit logs only; other values normalize to audit
AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN=<token for subconscious event ingestion>

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
MATRIX_OPERATOR_MXIDS=<comma-separated operator Matrix IDs>
MATRIX_ADMIN_MXIDS=<comma-separated admin Matrix IDs>

# External access
FRP_API_ORIGIN=https://agentchat.example.com

# v1 runtime home
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
SUPERVISOR_WARN_AFTER=2                # consecutive negatives before nudge
SUPERVISOR_ESCALATE_AFTER=3            # consecutive negatives before escalation
SUPERVISOR_WARN_COOLDOWN_MS=300000     # 5 min cooldown between actions
# optional: SUPERVISOR_LLM_ENDPOINT, SUPERVISOR_MATRIX_MENTIONS=operator
# optional startup allowlist: only audit these agents (comma-separated)
SUPERVISOR_AGENT_ALLOWLIST=

# Alert tuning
UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS=120000
AGENT_TMUX_MISSING_ALERT_GRACE_MS=15000
AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS=900000
```

## Parallel Dev Stack (Isolated)

Use split roots:
- Dev code repo: `~/laplace/agent-chat`
- Dev runtime root: `~/laplace/agent-chat-dev-runtime`
- Current live code repo: `~/laplace/agent-chat-live`

```bash
# in ~/laplace/agent-chat
mkdir -p /path/to/agent-chat-dev-runtime/{data,logs}
export AGENT_CHAT_RUNTIME_DIR=/path/to/agent-chat-dev-runtime
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
  -- node /path/to/agent-chat/mcp-server.js

claude mcp add -s user \
  -e AGENT_CHAT_API="http://127.0.0.1:18090" \
  -e AGENT_CHAT_MCP_SERVER_NAME="agentchat-dev" \
  -e API_TOKEN="<token-if-needed>" \
  -- agentchat-dev node /path/to/agent-chat/mcp-server.js
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
- `bin/self-time-reminder` — Self-reminder CLI (standalone binary, skill installed at `~/.claude/skills/self-time-reminder/` and `~/.codex/skills/self-time-reminder/`)

## Documentation

- `OPERATIONS.md` — Operations runbook (incident response, health checks)
- `ROADMAP-remote.md` — Remote server architecture and roadmap
- `docs/v1-agent-home-contract.md` — V1 agent home layout contract
- `docs/agent-roles-and-guardrails.md` — Agent role definitions and guardrails
- `docs/agent-role-and-scope-editing.md` — Practical workflow for editing role/scope/current-task inputs
- `docs/workspace-claude-md-template.md` — Template for agent workspace CLAUDE.md
- `docs/workspace-agents-md-template.md` — Template for agent workspace AGENTS.md
- `docs/workspace-supervisor-claude-template.md` — Template for supervisor CLAUDE.md
- `docs/workspace-supervisor-agents-template.md` — Template for supervisor AGENTS.md
- `docs/workspace-supervisor-agent-agents-template.md` — Template for supervisor-agent AGENTS.md
- `docs/laplace-analysis-and-roadmap.md` — Project analysis and roadmap
- `docs/dependency-security-debt.md` — Dependency security audit notes
