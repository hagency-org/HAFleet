# System Components Overview

Archive notice: This is historical architecture/audit material, not the current deploy or incident runbook. Current operator procedures live in root `README.md` and `OPERATIONS.md`; verify behavior against code before using details here.

Date: 2026-03-28
Scope: All hafleet services, data flows, subsystems, external dependencies, and configuration model
Author: ac-researcher (task 5.38)

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Core Services](#2-core-services)
3. [Library Modules](#3-library-modules)
4. [Operational Scripts](#4-operational-scripts)
5. [Data Flows](#5-data-flows)
6. [Key Subsystems](#6-key-subsystems)
7. [External Dependencies](#7-external-dependencies)
8. [Configuration Model](#8-configuration-model)

---

## 1. High-Level Architecture

Agentchat is a multi-agent orchestration platform that runs AI coding agents in tmux sessions and coordinates them through a central HTTP API server, a web dashboard, per-agent MCP servers, per-agent push relays, and an optional Matrix bridge for external communication.

```
                    ┌──────────────────────────┐
                    │     Matrix Homeserver     │
                    │     (Synapse/Conduit)     │
                    └────────────┬─────────────┘
                                 │ Matrix C-S API
                                 ▼
┌──────────────┐    ┌──────────────────────────┐    ┌──────────────┐
│  Web Browser  │◄──│       server.js           │    │ bridge-matrix │
│  (Dashboard)  │──►│     Dashboard :8084       │    │    .js        │
└──────────────┘    └────────────┬─────────────┘    └──────┬───────┘
                                 │ REST proxy              │ SSE + REST
                                 ▼                         ▼
                    ┌──────────────────────────────────────────────┐
                    │              backend-v2.js                    │
                    │          Central API Server :8090             │
                    │                                              │
                    │  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
                    │  │ Agent   │ │ Message  │ │ Group        │  │
                    │  │ Registry│ │ Store    │ │ Store        │  │
                    │  └─────────┘ └──────────┘ └──────────────┘  │
                    │  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
                    │  │ Task    │ │ Alert    │ │ Token        │  │
                    │  │ Store   │ │ Store    │ │ Store        │  │
                    │  └─────────┘ └──────────┘ └──────────────┘  │
                    │  ┌──────────────┐ ┌──────────────────────┐  │
                    │  │ Attachment   │ │ Supervisor Snapshot   │  │
                    │  │ Store        │ │ Store                │  │
                    │  └──────────────┘ └──────────────────────┘  │
                    └──────────┬────────────────┬─────────────────┘
                               │ SSE            │ REST + SSE
                               ▼                ▼
                    ┌──────────────┐   ┌──────────────────┐
                    │  push-relay   │   │   mcp-server     │
                    │  (per-agent)  │   │   (per-agent)    │
                    └──────┬───────┘   └────────┬─────────┘
                           │ tmux write-pane          │ MCP protocol
                           ▼                          ▼
                    ┌──────────────────────────────────────┐
                    │          Agent (tmux session)         │
                    │    Claude Code / Codex CLI            │
                    │    ┌──────────┐  ┌───────────────┐   │
                    │    │ workdir/ │  │ projects/      │   │
                    │    │ (coord)  │  │ (code trees)   │   │
                    │    └──────────┘  └───────────────┘   │
                    └──────────────────────────────────────┘
```

### Service Port Map

| Service | Default Port | Config Variable | Description |
|---------|-------------|-----------------|-------------|
| backend-v2.js | 8090 | `API_PORT` | Central REST API + SSE server |
| server.js | 8084 | `WEB_PORT` | Web dashboard + REST proxy |
| mcp-server.js | Dynamic (per-agent) | `MCP_PORT` (env in agent tmux) | MCP tool server for each agent |
| push-relay.js | — (no listener) | — | Outbound SSE consumer, no inbound port |
| bridge-matrix.js | — (no listener) | — | SSE consumer + Matrix C-S API client |

Source: `backend-v2.js:34-43`, `server.js:11-19`.

---

## 2. Core Services

### 2.1 backend-v2.js — Central API Server

**Size**: ~9000 lines | **Port**: 8090 (default) | **Process**: Long-running Express server

The backend is the single source of truth for all agent state, messages, groups, tasks, alerts, and tokens. Every other service communicates through it.

#### REST API Surface (45+ routes)

**Agent Management**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| POST | `/api/agents` | Register new agent | `backend-v2.js:6614-6627` |
| GET | `/api/agents` | List all agents | `backend-v2.js:6597-6612` |
| GET | `/api/agents/:name` | Get single agent | `backend-v2.js:6629-6648` |
| PATCH | `/api/agents/:name` | Update agent fields | `backend-v2.js:6650-6700` |
| DELETE | `/api/agents/:name` | Remove agent from registry | `backend-v2.js:6702-6737` |
| POST | `/api/agents/:name/heartbeat` | Report agent liveness | `backend-v2.js:6215-6235` |
| GET | `/api/agents/:name/activity` | Get activity metrics | `backend-v2.js:6262-6278` |

**Messaging**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| POST | `/api/messages` | Send a message | `backend-v2.js:6380-6453` |
| GET | `/api/messages` | Query messages (with filters) | `backend-v2.js:6456-6530` |
| GET | `/api/messages/for/:agent` | Messages for a specific agent | `backend-v2.js:6532-6565` |
| POST | `/api/messages/:id/ack` | Acknowledge message delivery | `backend-v2.js:6567-6595` |

**Groups**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| GET | `/api/groups` | List all groups | `backend-v2.js:8127-8148` |
| POST | `/api/groups` | Create group | `backend-v2.js:8150-8180` |
| PUT | `/api/groups/:name` | Update group | `backend-v2.js:8182-8211` |
| POST | `/api/groups/:name/members` | Add member | `backend-v2.js:8213-8247` |
| DELETE | `/api/groups/:name/members/:member` | Remove member | `backend-v2.js:8249-8283` |

**Tasks**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| GET | `/api/tasks` | List all tasks | `backend-v2.js:7108-7140` |
| GET | `/api/tasks/:id` | Get task by ID | `backend-v2.js:7142-7156` |
| PUT | `/api/tasks/:id` | Create/update task | `backend-v2.js:7158-7215` |
| PATCH | `/api/tasks/:id` | Partial update | `backend-v2.js:7217-7268` |
| DELETE | `/api/tasks/:id` | Delete task | `backend-v2.js:7270-7290` |

**Supervisor & Alerts**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| GET | `/api/supervisor/status` | Current supervisor status | `backend-v2.js:6123-6152` |
| GET | `/api/supervisor/snapshots` | All snapshots for agent | `backend-v2.js:7350-7380` |
| POST | `/api/supervisor/snapshots` | Store new snapshot | `backend-v2.js:7382-7415` |
| GET | `/api/alerts` | List alerts | `backend-v2.js:7420-7458` |
| POST | `/api/alerts` | Create alert | `backend-v2.js:7460-7510` |
| PATCH | `/api/alerts/:id` | Update alert state | `backend-v2.js:7512-7560` |

**Infrastructure**:

| Method | Route | Purpose | Source |
|--------|-------|---------|--------|
| GET | `/api/sse` | SSE event stream | `backend-v2.js:6358-6378` |
| GET | `/api/health` | Health check | `backend-v2.js:8920-8945` |
| GET | `/api/health/summary` | Detailed health summary | `backend-v2.js:8770-8918` |
| POST | `/api/agents/:name/subconscious/events` | Receive subconscious hook events | `backend-v2.js:6830-6880` |
| GET | `/api/agents/:name/subconscious/events` | Retrieve hook events | `backend-v2.js:6882-6920` |
| POST | `/api/cursor/:name` | Update cursor position | `backend-v2.js:7580-7620` |
| GET | `/api/cursor/:name` | Get cursor position | `backend-v2.js:7622-7640` |

#### SSE Event System

Backend broadcasts events to all connected SSE clients (push-relay, bridge-matrix, dashboard) via a central `broadcastSSE()` function (`backend-v2.js:3317-3320`).

**Event Types**:

| Event Type | Payload | Triggered By | Source |
|------------|---------|-------------|--------|
| `message` | Full message object | New message posted | `backend-v2.js:6435-6440` |
| `agent-registered` | Agent record | Agent registration | `backend-v2.js:6625` |
| `agent-updated` | Agent record | Agent field change | `backend-v2.js:6698` |
| `agent-removed` | `{ name }` | Agent deletion | `backend-v2.js:6735` |
| `heartbeat` | `{ name, timestamp }` | Agent heartbeat POST | `backend-v2.js:6233` |
| `agent-status` | `{ name, status }` | Status change | `backend-v2.js:6302` |
| `task-updated` | Task record | Task create/update | `backend-v2.js:7213` |
| `task-deleted` | `{ id }` | Task deletion | `backend-v2.js:7288` |
| `alert-created` | Alert record | New alert | `backend-v2.js:7508` |
| `alert-updated` | Alert record | Alert state change | `backend-v2.js:7558` |
| `supervisor-snapshot` | Snapshot record | New supervisor snapshot | `backend-v2.js:7413` |
| `group-updated` | Group record | Group change | `backend-v2.js:8178` |
| `cursor-updated` | Cursor record | Cursor position change | `backend-v2.js:7618` |
| `attachment-stored` | Attachment metadata | New attachment | `backend-v2.js:6800` |
| `subconscious-event` | Hook event data | Subconscious hook fire | `backend-v2.js:6878` |
| `activity-updated` | Activity metrics | Activity sweep | `backend-v2.js:6316` |
| `swap-check` | Swap info | Swap sweep | `backend-v2.js:6340` |
| `ping` | `{ time }` | 30s keep-alive | `backend-v2.js:6370` |

#### Data Stores

All stores are JSON-file-backed with in-memory caching and periodic flush:

| Store | File | Module | Purpose |
|-------|------|--------|---------|
| Agent Registry | `data/agents.json` | inline in `backend-v2.js` (`loadJson`/`saveJson` block, lines 2640-2673) | Agent records (name, framework, status, groups, runtime info) |
| Message Store | `data/messages.json` | inline in `backend-v2.js` | All inter-agent messages |
| Group Store | `data/groups.json` | inline in `backend-v2.js` | Group definitions and membership |
| Task Store | `data/tasks.json` | `lib/task-store.js` | Task records with lifecycle state |
| Alert Store | `data/alerts.json` | `lib/alert-store.js` | Alert tickets (open→acknowledged→assigned→resolved→suppressed) |
| Token Store | `data/tokens.json` | inline in `backend-v2.js` (per-agent token loader, lines 163-195) | Per-agent auth tokens |
| Cursor Store | `data/cursors.json` | inline in `backend-v2.js` | Per-agent cursor positions for inbox tracking |
| Attachment Store | `data/attachments/` | inline in `backend-v2.js` (media staging handler, lines 8250-8293) | File attachments (metadata JSON + binary blobs) |
| Supervisor Snapshot Store | `data/supervisor-snapshots.json` | `lib/supervisor-snapshot-store.js` | Time-series supervisor assessments per agent |

Source: `backend-v2.js:87-151` (store initialization).

#### Background Sweep Loops

| Sweep | Interval | Purpose | Source |
|-------|----------|---------|--------|
| Activity sweep | 30s | Compute per-agent activity metrics from heartbeat timestamps, emit `activity-updated` | `backend-v2.js:6280-6320` |
| Swap check | 30s | Monitor system memory swap usage, emit `swap-check` | `backend-v2.js:6322-6355` |
| Scope sweep | 30s | Check agent scope violations (working outside assigned dirs) | `backend-v2.js:6944-6980` |
| Supervisor lifecycle | 30s | Run supervisor assessment cycle for all active agents | `lib/supervisor-lifecycle-manager.js:120-180` |
| SSE ping | 30s | Send keep-alive `ping` to all SSE clients | `backend-v2.js:6358-6378` |

---

### 2.2 server.js — Web Dashboard

**Size**: ~8550 lines | **Port**: 8084 (default) | **Process**: Long-running Express server

The dashboard provides a web UI for monitoring agents, reading messages, managing groups, and controlling agent lifecycle. It proxies most requests to backend-v2.

#### Key Features

- **Dashboard pages**: `/` (overview), `/agents/:name` (agent detail), `/alerts` (alert management), `/config` (configuration)
- **REST proxy**: Nearly all `/api/*` requests are proxied to backend-v2 on port 8090
- **SSE relay**: Subscribes to backend SSE and re-broadcasts to browser clients (`server.js:83-100`)
- **Idle-gated message queue**: Messages destined for agent tmux panes are queued and only delivered when the agent is idle (not actively generating output)

#### Idle-Gated Message Delivery

The dashboard implements a sophisticated message delivery system that prevents interrupting agents mid-thought:

1. **Pane snapshot** (`server.js:2450-2500`): Every 2 seconds, captures the tmux pane content and computes an MD5 hash
2. **Idle detection** (`server.js:2510-2540`): If the MD5 hash is unchanged for `IDLE_THRESHOLD_MS` (default 20s), the agent is considered idle
3. **Queue drain** (`server.js:2550-2590`): When idle, queued messages are injected into the tmux pane via `tmux send-keys`
4. **Priority**: Operator messages bypass the idle gate and are delivered immediately

| Config Variable | Default | Purpose |
|----------------|---------|---------|
| `IDLE_THRESHOLD_MS` | `20000` | Milliseconds of pane stability before delivery |
| `WEB_PORT` | `8084` | Dashboard listen port |

Source: `server.js:11-19` (config), `server.js:2450-2590` (idle detection and delivery), `server.js:3221-3260` (startup).

---

### 2.3 bridge-matrix.js — Matrix Bridge

**Size**: ~3400 lines | **Port**: None (client only) | **Process**: Long-running bridge

Provides bidirectional message bridging between hafleet and a Matrix homeserver. Creates puppet accounts for each agent and a management bot for room operations.

#### Architecture

```
Matrix Homeserver
  │
  ├── Bot account (@hafleet-bot:domain)
  │     └── Room management, !commands, invite handling
  │
  └── Puppet accounts (@ac_<agentname>:domain)
        └── One per agent, sends messages as the agent
              │
              ▼
        Room ↔ Group Mapping
              │
              ▼
        SSE subscription to backend-v2
              │
              ▼
        Backend REST API for outbound messages
```

#### Key Subsystems

| Subsystem | Purpose | Source |
|-----------|---------|--------|
| Account registration | Register bot + puppet Matrix accounts with derived passwords | `bridge-matrix.js:374-426` |
| Token management | Obtain and cache Matrix access tokens | `bridge-matrix.js:428-477` |
| Room-group mapping | Map Matrix rooms to hafleet groups, persisted to `data/room-mapping.json` | `bridge-matrix.js:113-147` |
| Room creation | Create `[AC] groupName` rooms with correct membership | `bridge-matrix.js:3292-3338` |
| DM rooms | Create direct-message rooms for agent pairs | `bridge-matrix.js:2883-3043` |
| Puppet sending | Send messages as agent puppets in mapped rooms | `bridge-matrix.js:2771-2852` |
| Inbound bridging | Matrix messages → backend-v2 REST POST | `bridge-matrix.js:1832-1971` |
| Outbound bridging | Backend SSE `message` events → Matrix puppet messages | `bridge-matrix.js:2368-2476` |
| Avatar generation | SVG → PNG avatars via ImageMagick `convert` | `bridge-matrix.js:496-820` |
| Reconciliation loop | Every 5 minutes: sync room-group state, fix mismatches | `bridge-matrix.js:2195-2270` |
| Room trust | Classify rooms as allowlist/managed/trusted_inviter/unknown_room | `bridge-matrix.js:891-940` |
| Bot commands | `!help`, `!status`, `!groups`, `!spy`, `!agents` | `bridge-matrix.js:1469-1517` |

#### SSE Consumption

The bridge subscribes to `backend-v2.js` SSE (`/api/sse`) and handles events:

| Event | Bridge Action | Source |
|-------|--------------|--------|
| `message` | Send as puppet in mapped Matrix room | `bridge-matrix.js:2387-2399` |
| `agent-registered` | Create puppet account if needed | `bridge-matrix.js:2401-2420` |
| `agent-status` | Update puppet presence/display name | `bridge-matrix.js:2422-2440` |
| `group-updated` | Sync Matrix room membership | `bridge-matrix.js:2442-2460` |

Connection uses `lib/eventsource-mini.js` with exponential backoff (initial 5s, max 60s, 45s activity timeout).

Source: `bridge-matrix.js:2335-2380` (SSE setup), `lib/eventsource-mini.js` (custom SSE client).

---

### 2.4 MCP Server (lib/mcp-server-core.js)

**Size**: 711 lines | **Port**: Dynamic per-agent | **Process**: One per agent (launched by hafleet-up)

Each agent gets a dedicated MCP (Model Context Protocol) server that provides messaging tools. The agent's AI framework (Claude/Codex) calls these tools via the MCP protocol.

#### Tools

| Tool | Purpose | Source |
|------|---------|--------|
| `whoami` | Returns agent name, groups, framework info | `mcp-server-core.js:119-145` |
| `send_message` | Send a DM to another agent or group | `mcp-server-core.js:147-198` |
| `post` | Post to a group channel | `mcp-server-core.js:240-285` |
| `check_inbox` | Read inbox messages (with cursor tracking) | `mcp-server-core.js:287-365` |
| `check_group` | Read recent messages in a group | `mcp-server-core.js:440-510` |

#### Attachment Handling

- Agents can attach files to messages via the `attachments` parameter
- Files are staged locally, validated (max 20MB per file, max 8 per message), and uploaded to backend
- Media URLs in incoming messages are localized: remote URLs are downloaded and cached in `data/mcp-media-cache/`
- Images are sanitized via ImageMagick `identify` before caching

Source: `mcp-server-core.js:199-235` (staging), `mcp-server-core.js:368-439` (localization), `mcp-server-core.js:330-366` (sanitization).

#### Agent Name Detection

The MCP server auto-detects which agent it serves by checking (in order):
1. `AGENT_NAME` env var
2. `HAFLEET_AGENT_NAME` env var
3. Path-based detection from CWD (extracts from `.hafleet/agents/agent_<name>/`)

Source: `mcp-server-core.js:13-50`.

---

### 2.5 Push Relay (lib/push-relay-core.js)

**Size**: 822 lines | **Port**: None (client only) | **Process**: One per agent (launched by hafleet-up)

The push relay subscribes to backend SSE and injects relevant messages into the agent's tmux pane, acting as a real-time notification system.

#### Message Pipeline

```
Backend SSE ──► Filter (agent-relevant?) ──► Format ──► Blocked check ──► tmux send-keys
                                                              │
                                                         (if blocked)
                                                              │
                                                         Queue + retry
```

#### Key Features

| Feature | Description | Source |
|---------|-------------|--------|
| SSE subscription | Connects to `/api/sse`, filters for messages targeting this agent | `push-relay-core.js:697-717` |
| tmux injection | Writes formatted messages into agent pane via `tmux send-keys` with 300ms inter-character delays | `push-relay-core.js:568-605` |
| Blocked detection | Pattern-matches tmux pane content to detect if agent is at a prompt or mid-generation | `push-relay-core.js:259-273` |
| Compaction detection | Detects Claude's auto-compaction state to avoid injecting during context compression | `push-relay-core.js:275-288` |
| MCP presence check | Verifies MCP server process is running before injecting | `push-relay-core.js:488-526` |
| Activity tracking | Monitors pane changes to compute activity metrics (15-20s threshold) | `push-relay-core.js:217-257` |
| Heartbeat | Sends heartbeat to backend every 15 seconds | `push-relay-core.js:448-473` |
| Reconnection | Auto-reconnects SSE with 5s retry on disconnect | `push-relay-core.js:697-717` |

---

## 3. Library Modules

All library modules live in `lib/` and are imported by the core services.

### 3.1 Data Store Modules

| Module | Lines | Used By | Purpose |
|--------|-------|---------|---------|
| `task-store.js` | ~200 | backend-v2 | Task lifecycle (active/waiting/done), heartbeat, timeout detection |
| `alert-store.js` | 353 | backend-v2 | Alert ticket lifecycle: open→acknowledged→assigned→resolved→suppressed |
| `supervisor-snapshot-store.js` | 322 | backend-v2 | Time-series supervisor assessments, query by agent/time range |

> **Note**: Agent registry, message store, group store, token store, attachment store, and cursor store do not have separate lib/ modules. They are managed inline in `backend-v2.js` using `loadJson`/`saveJson` helpers (lines 2640-2673).

### 3.2 Supervisor Modules

| Module | Lines | Purpose |
|--------|-------|---------|
| `supervisor-lifecycle-manager.js` | 399 | Orchestrates 30s assessment cycle: scrape agent state → LLM evaluation → action dispatch |
| `supervisor-action-engine.js` | 131 | Executes supervisor actions: warn, escalate, reassign, based on assessment |
| `supervisor-snapshot-store.js` | 322 | Stores and queries supervisor assessment history |
| `supervisor-provisioning.js` | 154 | Sets up supervisor workspace, installs LLM evaluator |

Supervisor states: `focused` → `drifting` → `lost` → `stuck` → `idle` → `done`. Consecutive negative ratings trigger escalating actions.

Source: `lib/supervisor-lifecycle-manager.js:45-80` (state machine).

### 3.3 Agent Home Module

| Module | Lines | Purpose |
|--------|-------|---------|
| `agent-home-v1.js` | ~200 | V1 home directory layout helpers: path resolution, state directory access, layout validation |
| `agent-state.js` | ~150 | Runtime state management: resume-id, session-id, lock files |

### 3.4 Infrastructure Modules

| Module | Lines | Purpose |
|--------|-------|---------|
| `eventsource-mini.js` | 95 | Minimal SSE client with 45s activity timeout, exponential backoff, custom headers |
| `mcp-server-core.js` | 711 | Per-agent MCP server (see §2.4) |
| `push-relay-core.js` | 822 | Per-agent push relay (see §2.5) |

---

## 4. Operational Scripts

### 4.1 bin/ Scripts (CLI Tools)

The `bin/` directory contains 22 operational scripts, all invocable from the command line:

**Core Lifecycle**:

| Script | Purpose |
|--------|---------|
| `bin/hafleet` | Main CLI entry point — dispatches to subcommands |
| `bin/hafleet-up` | Provision and launch an agent (local or remote) — ~350 lines |
| `bin/hafleet-down` | Graceful agent shutdown — scrollback archival, resume-id capture, tmux kill — ~250 lines |
| `bin/hafleet-ls` | List running agents and their status |
| `bin/hafleet-send` | Send a message to an agent from the CLI |

**Group Management**:

| Script | Purpose |
|--------|---------|
| `bin/group-add` | Add member to a group |
| `bin/group-remove` | Remove member from a group |
| `bin/room-members` | List members of a Matrix room |

**Diagnostics**:

| Script | Purpose |
|--------|---------|
| `bin/hafleet-audit` | Audit agent state for inconsistencies |
| `bin/agent-dashboard` | Quick terminal status view |
| `bin/agent-task` | Query/update task state from CLI |

**Infrastructure**:

| Script | Purpose |
|--------|---------|
| `bin/mcp-run` | Launch a standalone MCP server |
| `bin/push-relay-run` | Launch a standalone push relay |
| `bin/hafleet-prune-agents` | Clean up stale agent registrations |
| `bin/hafleet-sync-skills` | Synchronize skill definitions across agents |

### 4.2 scripts/ Directory (Provisioning & Automation)

| Script | Lines | Purpose |
|--------|-------|---------|
| `scripts/provision-v1-agent-home.js` | 726 | Create V1 agent home directory: `state/`, `workdir/`, `projects/`, install MCP, configure hooks |
| `scripts/configure-v1-subconscious.js` | 455 | Install subconscious hooks into agent Claude config (`hooks.json` with 4 hook points) |
| `scripts/write-v1-agent-task.js` | 360 | Write task state into the shared control plane (used by `./task-writer` wrapper) |
| `scripts/write-supervisor-state.js` | 160 | Persist supervisor state to agent home |
| `scripts/build-remote-package.sh` | 186 | Package hafleet for remote deployment (tar bundle) |

### 4.3 Autodeploy Scripts

Three autodeploy variants, all git-poll-based with health-gated restarts:

| Script | Lines | Purpose |
|--------|-------|---------|
| `scripts/hafleet-dev-autodeploy.sh` | 150 | Dev mode: pull + restart on any new commit, no health gate |
| `scripts/hafleet-stable-autodeploy.sh` | 195 | Stable mode: pull → health check → graceful restart with agent preservation |
| `scripts/hafleet-remote-autodeploy.sh` | 122 | Remote server: pull remote package → restart push-relay + MCP |

All use `git fetch` + `git rev-parse` to detect new commits on their tracked branch.

---

## 5. Data Flows

### 5.1 Agent → Agent Message Flow

The primary messaging path when one agent sends a message to another:

```
Agent A (Claude/Codex)
  │
  │ MCP tool call: send_message(to="agent-b", body="...")
  ▼
MCP Server (Agent A's)
  │
  │ POST /api/messages { from: "agent-a", to: "agent-b", body: "..." }
  ▼
backend-v2.js
  │
  ├─► Store in message-store
  ├─► SSE broadcast: { type: "message", data: {...} }
  │
  ▼
Push Relay (Agent B's)
  │
  ├─► Filter: is this for agent-b? Yes
  ├─► Check: is agent-b blocked/compacting? Wait if so
  ├─► tmux send-keys: inject formatted message into Agent B's pane
  │
  ▼
Agent B (Claude/Codex) sees notification in terminal
  │
  │ MCP tool call: check_inbox()
  ▼
MCP Server (Agent B's)
  │
  │ GET /api/messages/for/agent-b?since=<cursor>
  ▼
backend-v2.js returns messages since cursor
```

### 5.2 Matrix → Agent Flow

When an external Matrix user sends a message that reaches an agent:

```
Matrix User
  │
  │ Send message in Matrix room
  ▼
Matrix Homeserver
  │
  │ Sync event to bridge-matrix bot/puppet
  ▼
bridge-matrix.js
  │
  ├─► Room trust check: is this room trusted?
  ├─► Room-group mapping: which hafleet group?
  ├─► Trust level: operator or external?
  │
  │ POST /api/messages { from: "@user:domain", to: "group-name", trustLevel: "operator"|"external" }
  ▼
backend-v2.js
  │
  ├─► Store message
  ├─► SSE broadcast
  │
  ▼
Push Relay (each group member agent)
  │
  │ tmux injection
  ▼
Agent sees Matrix message in terminal
```

### 5.3 Agent → Matrix Flow

When an agent sends a message that should appear in Matrix:

```
Agent
  │
  │ MCP: post(group="team-chat", body="...")
  ▼
MCP Server → backend-v2.js
  │
  │ SSE broadcast: { type: "message", ... }
  ▼
bridge-matrix.js (SSE consumer)
  │
  ├─► Map group → Matrix room
  ├─► Select puppet account for sending agent
  │
  │ Matrix C-S API: send message as @ac_<agentname>:domain
  ▼
Matrix Homeserver → Matrix room
  │
  ▼
Matrix users see message from agent puppet
```

### 5.4 Dashboard → Agent Flow (Idle-Gated)

When an operator sends a message through the web dashboard:

```
Browser
  │
  │ POST /api/messages (via dashboard UI)
  ▼
server.js (proxied to backend-v2)
  │
  ▼
backend-v2.js
  │
  ├─► Store message
  ├─► SSE broadcast
  │
  ▼
server.js (idle-gated queue)
  │
  ├─► Capture tmux pane MD5 every 2s
  ├─► Wait for IDLE_THRESHOLD_MS (20s) of unchanged pane
  ├─► (Operator messages bypass idle gate)
  │
  │ tmux send-keys
  ▼
Agent sees message when idle
```

### 5.5 SSE Event Distribution

All SSE consumers connect to the same endpoint and filter relevant events:

```
backend-v2.js /api/sse
  │
  ├──► push-relay (per-agent)
  │      Handles: message, heartbeat
  │
  ├──► bridge-matrix.js
  │      Handles: message, agent-registered, agent-status, group-updated
  │
  ├──► server.js (dashboard)
  │      Handles: all events (relayed to browser)
  │
  └──► browser (via server.js SSE relay)
         Handles: all events (UI updates)
```

---

## 6. Key Subsystems

### 6.1 Task Store

The task system tracks work assignments across all agents.

**States**: `active` → `waiting` → `done` (also: `timeout` via automated detection)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Task identifier (e.g., `5.38-system-components-doc`) |
| `owner` | string | Agent name |
| `status` | enum | `active`, `waiting`, `done` |
| `heartbeat_at` | ISO-8601 | Last heartbeat timestamp |
| `waiting_reason` | string | Why the task is waiting |
| `waiting_until` | ISO-8601 | When waiting expires |

Agents interact via the `./task-writer` CLI wrapper which calls `scripts/write-v1-agent-task.js` → `PUT /api/tasks/:id`.

Source: `lib/task-store.js`, `scripts/write-v1-agent-task.js:1-360`.

### 6.2 Alert System

Alerts are operational tickets that track issues requiring human attention.

**Lifecycle**: `open` → `acknowledged` → `assigned` → `resolved` (or `suppressed` at any point)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Auto-generated alert ID |
| `severity` | enum | `info`, `warning`, `critical` |
| `source` | string | Who/what created the alert (agent name, supervisor, system) |
| `title` | string | One-line summary |
| `body` | string | Full alert details |
| `state` | enum | Current lifecycle state |
| `assignee` | string | Who is working on it |

Source: `lib/alert-store.js:1-353`.

### 6.3 Cursor System

Per-agent cursor positions track which messages each agent has already read, enabling incremental inbox reads.

- Stored in `data/cursors.json` — maps agent name to last-read message ID/timestamp
- `check_inbox()` uses cursor to return only new messages
- Cursor is updated on each `check_inbox()` call

Source: `backend-v2.js:7580-7640` (cursor API), `mcp-server-core.js:287-365` (cursor usage in check_inbox).

### 6.4 Provisioning System

Agent provisioning creates the full home directory structure and configures all per-agent services.

**Provisioning pipeline** (triggered by `hafleet-up`):

```
hafleet-up
  │
  ├─► scripts/provision-v1-agent-home.js
  │     ├─► Create directory tree: state/, workdir/, workdir/docs/, workdir/projects/, etc.
  │     ├─► Generate agent.json (identity, framework, groups, runtime profile)
  │     ├─► Install task-writer wrapper (symlink to scripts/write-v1-agent-task.js)
  │     ├─► Write CLAUDE.md from workspace template (mustache variables)
  │     ├─► Write AGENTS.md from role template
  │     ├─► Link or copy managed project into projects/
  │     ├─► Write docs/plan.md, docs/progress.md, docs/projects.md
  │     └─► Register agent via POST /api/agents
  │
  ├─► scripts/configure-v1-subconscious.js (if Claude framework)
  │     ├─► Write hooks.json with 4 hook points:
  │     │     SessionStart, UserPromptSubmit, PreToolUse, Stop
  │     ├─► Install hook-entry.mjs script
  │     └─► Configure Letta integration (if enabled)
  │
  ├─► Launch MCP server (bin/mcp-run) in background
  ├─► Launch push relay (bin/push-relay-run) in background
  └─► Launch agent in tmux session (claude or codex binary)
```

**Workspace Templates** (sourced from `docs/workspace-*.md`, see `scripts/provision-v1-agent-home.js:17-20`):

| Template | Purpose |
|----------|---------|
| `docs/workspace-claude-md-template.md` | Agent workspace CLAUDE.md |
| `docs/workspace-agents-md-template.md` | Agent workspace AGENTS.md |
| `docs/workspace-supervisor-claude-template.md` | Supervisor workspace CLAUDE.md |
| `docs/workspace-supervisor-agents-template.md` | Supervisor workspace AGENTS.md |

Source: `scripts/provision-v1-agent-home.js:1-726`, `scripts/configure-v1-subconscious.js:1-455`.

### 6.5 Session Management

Agent sessions are managed through tmux with lifecycle hooks:

**Startup** (hafleet-up):
1. Create named tmux session: `tmux new-session -d -s agent_<name>`
2. Set environment variables in tmux session (API tokens, model config, paths)
3. Launch MCP server and push relay as background processes
4. Start the agent binary (claude/codex) in the foreground tmux pane

**Shutdown** (hafleet-down):
1. Validate agent has no active task (unless `--force`)
2. Capture scrollback: `tmux capture-pane` → archive to `state/scrollback-<timestamp>.txt`
3. Capture resume-id from `state/resume-id` file
4. Send exit sequence to agent (framework-specific: `/exit` for Claude, `Ctrl+C` for Codex)
5. Wait for graceful exit (30s Claude, 8s Codex), then kill tmux session
6. Update agent status via `PATCH /api/agents/:name { status: "stopped" }`

**Resume** (hafleet-up --resume):
1. Read resume-id from `state/resume-id`
2. Launch agent with `--resume <id>` flag — continues previous conversation context
3. Re-launch MCP server and push relay

Source: `bin/hafleet-up:1-350` (startup), `bin/hafleet-down:1-250` (shutdown).

### 6.6 Supervisor System

The supervisor is an LLM-based oversight system that evaluates agent focus every 30 seconds.

**Assessment Cycle**:
```
Every 30s:
  │
  ├─► Scrape agent tmux pane content (last N lines)
  ├─► Fetch agent's current task from task store
  ├─► Send to LLM evaluator (DeepSeek model) with prompt:
  │     "Is this agent focused on its assigned task?"
  ├─► Receive assessment: { state, confidence, reasoning }
  ├─► Store snapshot via POST /api/supervisor/snapshots
  └─► If consecutive negative assessments → trigger action:
        drifting: warning message
        lost: escalation alert
        stuck: reassignment consideration
```

**States**:

| State | Meaning | Action |
|-------|---------|--------|
| `focused` | Working on task | None |
| `drifting` | Slightly off-task | Warning message |
| `lost` | Significantly off-task | Alert + escalation |
| `stuck` | No progress despite activity | Alert + possible reassignment |
| `idle` | No activity detected | Monitor, alert if prolonged |
| `done` | Task completed | Archive |

Source: `lib/supervisor-lifecycle-manager.js:1-399`, `lib/supervisor-action-engine.js:1-131`.

---

## 7. External Dependencies

### 7.1 Required Infrastructure

| Dependency | Purpose | Required? |
|------------|---------|-----------|
| **Node.js** (≥18) | Runtime for all services | Yes |
| **tmux** | Agent session management | Yes |
| **Matrix homeserver** (Synapse/Conduit) | External communication bridge | No — only if bridge-matrix is used |
| **ImageMagick** (`convert`, `identify`) | Avatar generation (bridge), image sanitization (MCP) | No — only if bridge or attachments used |

### 7.2 npm Dependencies

Key production dependencies (`package.json`):

| Package | Used By | Purpose |
|---------|---------|---------|
| `express` | backend-v2, server.js | HTTP framework |
| `@modelcontextprotocol/sdk` | mcp-server-core | MCP protocol implementation |
| `matrix-bot-sdk` | bridge-matrix | Matrix client SDK |
| `zod` | Multiple | Request/config validation |
| `uuid` | Multiple | ID generation |
| `marked` | server.js | Markdown rendering for dashboard |

### 7.3 Optional External Services

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **GitHub** | autodeploy pulls from GitHub repos | Git remote URL in repo config |
| **frp tunnels** | Expose local services to remote agents | `FRP_SERVER_ADDR`, `FRP_TOKEN` env vars |
| **DeepSeek API** | Supervisor LLM evaluator | `SUPERVISOR_API_KEY`, `SUPERVISOR_MODEL` env vars |
| **Letta** | Subconscious long-term memory | `LETTA_BASE_URL`, `LETTA_AGENT_ID` env vars |

---

## 8. Configuration Model

### 8.1 Environment Variables (.env)

Configuration is loaded from `.env` files at the project root. Variables are organized by service:

**Core Backend (backend-v2.js)**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_PORT` | `8090` | Backend listen port |
| `API_TOKEN` | (none) | Bearer auth token — if unset, API is open |
| `AGENT_TOKEN_ENFORCEMENT` | `audit` | Per-agent token mode: `hard`, `soft`, `audit` |
| `BRIDGE_SECRET` | (none) | Shared secret for bridge authentication |
| `DATA_DIR` | `./data` | Directory for all JSON stores |
| `HAFLEET_HOMEDIR` | `~/.hafleet` | Root for agent home directories |
| `MAX_MESSAGE_LENGTH` | `50000` | Maximum message body length |

**Dashboard (server.js)**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEB_PORT` | `8084` | Dashboard listen port |
| `IDLE_THRESHOLD_MS` | `20000` | Idle detection threshold for message delivery |
| `BACKEND_URL` | `http://127.0.0.1:8090` | Backend URL for proxying |

**Bridge (bridge-matrix.js)**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MATRIX_HOMESERVER_URL` | (required) | Matrix server URL |
| `MATRIX_DOMAIN` | (required) | Matrix server domain for user IDs |
| `MATRIX_BOT_USER` | `hafleet-bot` | Bot account username |
| `MATRIX_BOT_PASSWORD` | (required) | Bot account password |
| `MATRIX_PUPPET_PREFIX` | `ac_` | Prefix for puppet usernames |
| `MATRIX_OPERATOR_MXIDS` | (none) | Comma-separated operator Matrix IDs |
| `MATRIX_TRUSTED_ROOM_IDS` | (none) | Comma-separated trusted room IDs |
| `MATRIX_TRUSTED_INVITER_MXIDS` | (none) | Comma-separated trusted inviter IDs |

**Supervisor**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUPERVISOR_ENABLED` | `false` | Enable supervisor system |
| `SUPERVISOR_API_KEY` | (none) | LLM API key for evaluator |
| `SUPERVISOR_MODEL` | (none) | Model ID for evaluator (e.g., DeepSeek) |
| `SUPERVISOR_INTERVAL_MS` | `30000` | Assessment cycle interval |

**Subconscious**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUBCONSCIOUS_EVENT_TOKEN` | (none) | Auth token for hook event POST endpoint |
| `LETTA_BASE_URL` | (none) | Letta server URL for long-term memory |

**Agent Framework**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_MODEL` | (none) | Claude model ID for agents |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | (none) | Max output tokens per turn |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | (none) | Auto-compaction context window |
| `DISABLE_PROMPT_CACHING` | (none) | Disable prompt caching |

Source: `.env.example:1-55`, `backend-v2.js:34-151`, `bridge-matrix.js:27-75`, `server.js:11-19`.

### 8.2 Per-Agent Configuration (agent.json)

Each agent has an `agent.json` in its home directory (`~/.hafleet/agents/agent_<name>/agent.json`) with:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Agent identifier |
| `framework` | `claude` \| `codex` | AI framework |
| `layoutVersion` | number | Home directory layout version (currently 1) |
| `groups` | string[] | Group memberships |
| `human` | string | Human-readable description |
| `task` | string | Current task description |
| `runtimeProfile` | object | Framework-specific runtime settings |
| `managedProjects` | object[] | Project trees linked into `projects/` |
| `remoteServer` | object | Remote server config (if remote agent) |
| `status` | string | Current status (running/stopped/error) |

Source: `scripts/provision-v1-agent-home.js:200-280`, `docs/v1-agent-home-contract.md`.

### 8.3 Framework Presets

Agent-up supports preset configurations via `--preset` flag:

- Presets define model, token limits, compaction settings, and permissions
- Stored in the hafleet configuration
- Override individual settings via command-line flags

Source: `bin/hafleet-up:400-450` (preset loading).

### 8.4 Runtime State

Per-agent runtime state in `~/.hafleet/agents/agent_<name>/state/`:

| File | Purpose |
|------|---------|
| `resume-id` | Last session resume ID for conversation continuity |
| `session-id` | Current session UUID |
| `scrollback-*.txt` | Archived tmux scrollback captures |
| `subconscious-events.jsonl` | Local copy of subconscious hook events |
| `letta/` | Letta integration state |
| `lock` | Process lock file to prevent duplicate launches |

Source: `lib/agent-state.js`, `bin/hafleet-down:100-150` (scrollback capture).
