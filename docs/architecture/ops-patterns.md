# Agentchat Operational Patterns

Archive notice: This is historical architecture/audit material, not the current deploy or incident runbook. Current operator procedures live in root `README.md` and `OPERATIONS.md`; verify behavior against code before using details here.

Date: 2026-03-28
Scope: autodeploy, monitoring, subconscious, remote servers, operational runbooks
Author: ac-researcher (task 5.39)

---

## Table of Contents

1. [Autodeploy System](#1-autodeploy-system)
2. [Monitoring & Observability](#2-monitoring--observability)
3. [Subconscious System](#3-subconscious-system)
4. [Remote Server Management](#4-remote-server-management)
5. [Operational Runbooks](#5-operational-runbooks)

---

## 1. Autodeploy System

### Overview

Three git-poll-based autodeploy scripts manage continuous deployment across environments. Each polls its branch on a fixed interval, detects new commits, and restarts services.

```
                    Git Repository
                    ┌──────────┐
          master ───┤          ├─── stable
                    └──────────┘
                       │              │
                       ▼              ▼
              ┌────────────────┐  ┌────────────────┐
              │  Dev Autodeploy│  │Stable Autodeploy│
              │  (30s poll)    │  │  (30s poll)     │
              │  systemctl     │  │  run_as_deploy  │
              │  --user        │  │  health-gated   │
              └────────────────┘  └────────────────┘
                                        │
                                        ▼
                                  ┌────────────────┐
                                  │Remote Autodeploy│
                                  │  (60s poll)     │
                                  │  push-relay only│
                                  └────────────────┘
```

### Branch-to-Environment Mapping

| Branch | Environment | Script | Services |
|--------|-------------|--------|----------|
| `master` | Dev (`hafleet/`) | `hafleet-dev-autodeploy.sh` | backend-v2, bridge-matrix, server |
| `stable` | Production (`hafleet-live/`) | `hafleet-stable-autodeploy.sh` | backend-v2, bridge-matrix, server |
| `stable` | Remote servers | `hafleet-remote-autodeploy.sh` | push-relay only |

### Dev Autodeploy

**File**: `scripts/hafleet-dev-autodeploy.sh`

**Behavior**:
- Polls `master` branch every 30 seconds
- Runs as the current user via `systemctl --user`
- No health gate — restarts services immediately after pull
- Uses `force_clean_workdir` to ensure clean state before pull

**Service restart** (lines 27-47):
```
restart_services():
  systemctl restart hafleet-backend
  wait_for_backend (30s health gate)
  systemctl restart hafleet
  systemctl restart bridge-matrix
```

**Deploy cycle** (lines 96-146):
1. `git fetch origin master`
2. Compare `HEAD` vs `origin/master`
3. If different or `deploy_pending=true`:
   - `force_clean_workdir`
   - `git pull --ff-only origin master`
   - `maybe_install_deps` (runs `npm install` if `package.json` changed)
   - `restart_services`
4. If npm install or restart fails, set `deploy_pending=true` for next cycle

### Stable Autodeploy

**File**: `scripts/hafleet-stable-autodeploy.sh`

**Behavior**:
- Polls `stable` branch every 30 seconds
- Runs as root, executes service commands via `run_as_deploy_user` (lines 17-25)
- Health-gated: waits for backend to become healthy before restarting dependent services
- Sequential restart order ensures backend is ready before bridge/server restart

**Health gate** — `wait_for_backend` (lines 41-53):
```
wait_for_backend():
  for i in 1..30:
    curl -s http://localhost:8090/api/agents → success → return
    sleep 1
  timeout after 30 seconds
```

**Service restart order** (lines 55-93):
1. Restart `hafleet-backend` (backend)
2. `wait_for_backend` (30s timeout)
3. Restart remaining services (`hafleet`, `bridge-matrix`)

**Systemd unit**: `hafleet-stable-autodeploy.service`
- Runs as root
- Logs to `/path/to/hafleet-live/logs/`

### Remote Autodeploy

**File**: `scripts/hafleet-remote-autodeploy.sh`

**Behavior**:
- Polls `stable` branch every 60 seconds (longer interval for remote)
- Restarts push-relay only (lines 27-39)
- Cross-platform: handles both Linux (systemd) and macOS (launchctl)
- Deployed via `remote/install-remote.sh`

**Systemd unit template**: `remote/push-relay-autodeploy.service`
- Template with `__USER__`, `__REPODIR__`, `__ENV_FILE__` placeholders
- Filled in by `install-remote.sh` during provisioning

### force_clean_workdir

**Purpose**: Ensures a clean working directory before `git pull` to prevent merge conflicts from local modifications.

**Implementation** (dev autodeploy lines 81-91):
```bash
force_clean_workdir():
  git reset --hard HEAD
  git clean -fd
```

- `git reset --hard HEAD` — discards all staged and unstaged changes
- `git clean -fd` — removes untracked files and directories
- Runs before every deploy pull to guarantee a clean state
- Safe because deploy directories should never have local modifications

### deploy_pending Retry

**Purpose**: Ensures failed deploys are retried on the next poll cycle.

**Behavior** (dev autodeploy lines 96, 112-146):
- `deploy_pending` is a boolean flag, initially `false`
- Set to `true` if `npm install` or `restart_services` fails
- On next poll cycle, if `deploy_pending=true`, deploy is attempted even if no new commits
- Reset to `false` on successful deploy
- Prevents a transient failure (e.g. npm registry timeout) from blocking all future deploys

---

## 2. Monitoring & Observability

### Architecture Overview

```
┌──────────────┐   heartbeat    ┌──────────────┐
│  Agent (tmux)│ ──────────────►│  backend-v2  │
└──────────────┘   POST /api/   │              │
                   heartbeat    │  ┌─────────┐ │   SSE events
┌──────────────┐                │  │ Alert   │ │ ──────────────► push-relay
│  Supervisor  │ ──assess──────►│  │ Store   │ │ ──────────────► bridge-matrix
│  (lifecycle  │   POST /api/   │  └─────────┘ │ ──────────────► dashboard
│   manager)   │   supervisor/  │  ┌─────────┐ │
└──────────────┘   snapshot     │  │Snapshot │ │
                                │  │ Store   │ │
                                │  └─────────┘ │
                                └──────────────┘
```

### Alert System

**File**: `lib/alert-store.js` (353 lines)

#### Lifecycle

```
  open ──► acknowledged ──► assigned ──► resolved
   │            │              │            │
   │            │              │            └──► (7-day TTL, then purged)
   │            │              │
   └────────────┴──────────────┴──► suppressed
```

**Valid state transitions** (`alert-store.js:8-14`):

| From | To |
|------|----|
| `open` | `acknowledged`, `resolved`, `suppressed` |
| `acknowledged` | `assigned`, `resolved`, `suppressed` |
| `assigned` | `resolved`, `suppressed` |
| `resolved` | `open` (re-open) |
| `suppressed` | `open` (re-open) |

#### Severities and Sources

**Severities**: `info`, `warning`, `critical`

**Sources** (`alert-store.js`):

| Source | Emitter | Examples |
|--------|---------|----------|
| `backend` | backend-v2.js | Heartbeat stale, registration errors |
| `bridge` | bridge-matrix.js | Room reconciliation failures, sync errors |
| `supervisor` | supervisor-action-engine.js | Agent drifting/lost/stuck, escalation |
| `system` | Various | Service health, disk space, general operational |

#### Deduplication

**Key**: `dedupeKey` field — alerts with the same `dedupeKey` are considered duplicates.

**Behavior** (`alert-store.js:89-114`):
- If an alert with the same `dedupeKey` already exists in `open` or `acknowledged` state, the new alert is dropped
- Increments `duplicateCount` on the existing alert
- Updates `lastSeenAt` timestamp

#### Auto-Resolution

**Recovery map** (`alert-store.js:17-22`):

| Alert Pattern | Recovery Event |
|---------------|---------------|
| `agent-stale:*` | `agent-heartbeat:*` |
| `bridge-sync-error` | `bridge-sync-ok` |
| `supervisor-escalation:*` | `supervisor-resolution:*` |

**Process** (`alert-store.js:181-217`):
1. When a recovery event is ingested, `autoResolve()` is called
2. Finds all open/acknowledged alerts matching the recovery pattern
3. Transitions them to `resolved` state
4. Sets `resolvedAt` timestamp and `resolvedBy: 'auto-recovery'`

#### Limits

| Constant | Value | Location |
|----------|-------|----------|
| Max active alerts | 1000 | `alert-store.js:24` |
| Resolved TTL | 7 days | `alert-store.js:26` |
| Max duplicate count | Unlimited | (counter increments) |

#### Query Interface

`listAlerts(filters)` (`alert-store.js:223-248`):
- Filter by: `state`, `severity`, `source`, `agentName`
- Sort by: `createdAt` (descending, newest first)
- Pagination: `offset`, `limit`

### Supervisor System

Three components work together to monitor agent focus and take corrective action.

#### Component 1: Snapshot Store

**File**: `lib/supervisor-snapshot-store.js` (322 lines)

**Purpose**: Maintains per-target assessment state and a ring buffer of historical events.

**Assessment states** (`supervisor-snapshot-store.js:3`):

| State | Classification | Meaning |
|-------|---------------|---------|
| `focused` | positive | Agent is on-task |
| `drifting` | negative | Agent is slightly off-task |
| `lost` | negative | Agent is significantly off-task |
| `stuck` | negative | Agent is blocked, not making progress |
| `idle` | neutral | Agent has no active work |
| `done` | positive | Agent has completed its task |

**State-to-classification mapping** (`supervisor-snapshot-store.js:15-22`):
```
positive: focused, done
negative: drifting, lost, stuck
neutral:  idle
```

**Snapshot fields** (`supervisor-snapshot-store.js:115-136`):
- `targetAgent`: Agent being assessed
- `state`: Current assessment state
- `confidence`: 0.0-1.0 confidence score
- `reasoning`: LLM-generated assessment rationale
- `consecutiveNegative`: Count of sequential negative assessments
- `lastAssessedAt`: Timestamp of last assessment
- `leaseExpiresAt`: Supervisor lease expiration

**Ring buffer**: Last 5000 events retained in memory (`supervisor-snapshot-store.js:7`).

**Lease management** (`supervisor-snapshot-store.js:180-195`):
- Supervisor acquires a lease on a target agent
- Lease has a TTL (120s, see heartbeat section)
- Prevents multiple supervisors from acting on the same agent

**Kill switch** (`supervisor-snapshot-store.js:56-57, 235-243`):
- Global disable flag for supervisor system
- When active, all assessments and actions are suppressed

#### Component 2: Action Engine

**File**: `lib/supervisor-action-engine.js` (131 lines)

**Purpose**: Evaluates assessment results and decides when to nudge or escalate.

**Thresholds** (`supervisor-action-engine.js:3-5`):

| Action | Threshold | Description |
|--------|-----------|-------------|
| Nudge | 2 consecutive negative | Send gentle reminder to agent |
| Escalation | 3 consecutive negative | Alert operator, stronger intervention |
| Cooldown | 5 minutes | Minimum time between actions on same target |

**Nudge logic** (`supervisor-action-engine.js:20-69`):
1. Check `consecutiveNegative >= 2`
2. Check cooldown period has elapsed (5 min since last action)
3. Send nudge message to agent via messaging system
4. Record nudge in snapshot store

**Escalation logic** (`supervisor-action-engine.js:72-123`):
1. Check `consecutiveNegative >= 3`
2. Check cooldown period has elapsed
3. Create alert via alert store (severity: `warning` or `critical`)
4. Notify operator via configured channels
5. Record escalation in snapshot store

#### Component 3: Lifecycle Manager

**File**: `lib/supervisor-lifecycle-manager.js` (399 lines)

**Purpose**: Manages when supervisors wake, sleep, and assess targets.

**Timing constants** (`supervisor-lifecycle-manager.js:11-12`):

| Constant | Value | Purpose |
|----------|-------|---------|
| Assessment interval | 30s | Time between assessments of each target |
| Trailing window | 6 min | How long supervisor stays active after target goes idle (`line 229`) |

**Wake-on-main model**:
- Supervisor activates when it detects an active tmux session for a target agent
- Uses tmux session detection to determine if an agent is running
- Deactivates after the trailing window (6 min) expires with no activity

**Framework support** (`supervisor-lifecycle-manager.js:175-188`):
- Supports `claude` and `codex` frameworks
- Framework-specific detection of active sessions

**Auto-bootstrap** (`supervisor-lifecycle-manager.js:76-90`):
- After agent startup, waits 20-30 seconds before first assessment
- Allows agent time to initialize before being assessed

**Runtime checks** (`supervisor-lifecycle-manager.js:298-328`):
- Validates target agent exists and is registered
- Checks supervisor lease validity
- Verifies kill switch is not active

### Heartbeat & TTL Model

```
Agent ──(every ~60s)──► POST /api/heartbeat ──► backend stores timestamp
                                                  │
                                              TTL check (90s)
                                                  │
                                          stale if now - lastHeartbeat > 90s
```

| Component | TTL | Interval | Location |
|-----------|-----|----------|----------|
| Agent heartbeat | 90s | ~60s | `backend-v2.js:61` (`HEARTBEAT_TTL_MS`) |
| Supervisor lease | 120s | Per-assessment | `backend-v2.js:6109-6121` |
| Server heartbeat | 45s | ~30s | `backend-v2.js:6215-6253` |
| Push-relay heartbeat | — | 15s | `push-relay-core.js:28` (`HEARTBEAT_INTERVAL_MS`) |
| Supervisor trailing window | 6 min | — | `supervisor-lifecycle-manager.js:229` |
| Server liveness refresh | — | Periodic | `backend-v2.js:4767-4794` |

**Staleness detection**:
- Backend checks `lastHeartbeat` timestamp on each status query
- Agent marked stale when `Date.now() - lastHeartbeat > HEARTBEAT_TTL_MS`
- Stale agents shown with warning indicator on dashboard
- Alert raised via alert store with `dedupeKey: 'agent-stale:<agentName>'`

### Log Locations

| Service | Log Method | Location |
|---------|-----------|----------|
| backend-v2 (dev) | systemd journal | `journalctl --user -u hafleet-dev-backend` |
| backend-v2 (stable) | systemd journal + file | `journalctl -u hafleet-backend`, `hafleet-live/logs/` |
| bridge-matrix | systemd journal | `journalctl -u bridge-matrix` |
| server (dev) | systemd journal | `journalctl --user -u hafleet-dev-web` |
| server (stable) | systemd journal | `journalctl -u hafleet` |
| push-relay | systemd journal | `journalctl -u push-relay` |
| push-relay (remote) | systemd journal | `journalctl -u push-relay-autodeploy` on remote host |
| autodeploy (dev) | systemd journal | `journalctl --user -u hafleet-dev-autodeploy` |
| autodeploy (stable) | file | `hafleet-live/logs/autodeploy.log` |
| subconscious events | JSONL file | `data/subconscious-events.jsonl` |
| supervisor snapshots | In-memory + API | `GET /api/supervisor/snapshots` |

### SSE Event Types

Backend broadcasts events to all connected SSE clients (`backend-v2.js:6358-6363`).

| Event Type | Payload | Consumers |
|------------|---------|-----------|
| `message` | Message object | push-relay, bridge-matrix, dashboard |
| `heartbeat` | Agent name, timestamp | dashboard |
| `agent-status` | Agent name, status | push-relay, dashboard |
| `supervisor-snapshot` | Snapshot object | dashboard |
| `alert` | Alert object | dashboard |
| `subconscious-event` | Event object | dashboard |

---

## 3. Subconscious System

### Overview

The subconscious system is a Claude Code hooks-based observability and guidance layer. It captures agent execution events, persists them as JSONL logs, and optionally provides LLM-generated runtime guidance.

```
Claude Code Session
  │
  ├─ SessionStart ─────┐
  ├─ UserPromptSubmit ──┤
  ├─ PreToolUse ────────┤    hook-entry.mjs
  └─ Stop ─────────────►├──────────────────►  Backend API
                        │                     POST /api/subconscious/events
                        │                          │
                        │   ┌──────────────────────┤
                        │   │                      ▼
                        │   │              JSONL Persistence
                        │   │         data/subconscious-events.jsonl
                        │   │                      │
                        │   │                      ▼
                        │   │              SSE Broadcast
                        │   │         (dashboard, push-relay)
                        │   │
                        ▼   │
                   LLM Guidance (optional)
                   ┌─────────────────┐
                   │ Local Runtime   │  deepseek / qwen / openai
                   │ OR              │
                   │ Upstream Letta  │  external memory system
                   └─────────────────┘
```

### Hook Points

**Configuration file**: `subconscious/claude-hafleet/hooks/hooks.json`

| Hook | Trigger | Timeout | Data Captured |
|------|---------|---------|---------------|
| `SessionStart` | New Claude Code session begins | 10s | Session ID, agent name, home dir (`hooks.json:3-13`) |
| `UserPromptSubmit` | User submits a prompt | 10s | Session ID, prompt text, sequence number (`hooks.json:14-24`) |
| `PreToolUse` | Before any tool execution | 10s | Session ID, tool name, parameters (`hooks.json:25-35`) |
| `Stop` | Session ends (completion/error) | 15s | Session ID, stop reason, transcript (`hooks.json:36-46`) |

**Entry script**: `subconscious/claude-hafleet/scripts/hook-entry.mjs`

Each hook invokes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-entry.mjs" <HookType>
```

### Event Flow

1. **Hook fires** — Claude Code invokes `hook-entry.mjs` with hook type
2. **Context resolution** (`hook-entry.mjs:94-101`) — reads env vars:
   - `CLAUDE_SESSION_ID`, `HAFLEET_AGENT_NAME` or `CLAUDE_AGENT_NAME`
   - `HAFLEET_HOMEDIR` or `CLAUDE_AGENT_HOME`
3. **State resolution** (`hook-entry.mjs:103-163`) — loads `state/letta.json` to determine mode
4. **Optional LLM guidance** — if local runtime mode enabled:
   - Calls `POST /api/subconscious/runtime/invoke/:name` (`hook-entry.mjs:226-269`)
   - LLM generates contextual guidance
5. **Optional upstream sync** — if upstream mode enabled:
   - Calls appropriate upstream endpoint (`hook-entry.mjs:335-472`)
6. **Event posted** — `POST /api/subconscious/events` on backend
7. **Backend processing** (`backend-v2.js:843-903`) — `buildSubconsciousEvent()` normalizes fields
8. **Authorization check** (`backend-v2.js:2402-2423`) — validates loopback or token
9. **JSONL persistence** (`backend-v2.js:936-945`) — appended to `data/subconscious-events.jsonl`
10. **SSE broadcast** — event pushed to all connected clients

### JSONL Storage

**Path**: `data/subconscious-events.jsonl` (defined at `backend-v2.js:2686`)

**Format**: One JSON object per line (newline-delimited).

**Event fields** (`backend-v2.js:843-903`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v4 | Unique event identifier |
| `timestamp` | ISO 8601 | Event time |
| `agentName` | string | Registered agent name |
| `sessionId` | string | Claude session identifier |
| `hookType` | enum | `SessionStart` \| `UserPromptSubmit` \| `PreToolUse` \| `Stop` |
| `source` | string | Always `'claude-subconscious-v1'` |
| `guidancePresent` | boolean | Whether guidance was generated |
| `guidanceSource` | string | `'runtime-invoke'` \| `'upstream-pretool'` \| `'manual'` \| null |
| `guidancePreview` | string | First 200 chars of guidance text |
| `promptPreview` | string | First 200 chars of user prompt |
| `lettaAgentId` | string | Deterministic Letta agent ID |
| `upstreamStatus` | string | `'enabled'` \| `'disabled'` \| `'error'` |

**Retention**: No automatic rotation. In-memory cache of last 1000 events in `recentSubconsciousEvents` array. Manual cleanup required.

### Operating Modes

**Mode selection**: Controlled by `state/letta.json` fields `provider` and `mode`.

| Mode | provider | mode | LLM | Memory | External Dependency |
|------|----------|------|-----|--------|---------------------|
| Local Runtime | `"local"` | `"runtime"` | DeepSeek/Qwen/OpenAI | `state/subconscious/memory.json` | LLM API key |
| Upstream Letta | `"upstream"` | `"upstream"` | Letta backend | Letta server | Letta API + `claude-subconscious` repo |

### LLM Provider Configuration

**Environment variables** (read by `configure-v1-subconscious.js:172-199`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBCONSCIOUS_LLM_PROVIDER` | `deepseek` | `deepseek` \| `qwen` \| `openai` |
| `SUBCONSCIOUS_LLM_MODEL` | `deepseek-chat` | Model identifier |
| `SUBCONSCIOUS_LLM_ENDPOINT` | `https://api.deepseek.com` | API base URL |
| `SUBCONSCIOUS_LLM_KEY_ENV` | `DEEPSEEK_API_KEY` | Env var name containing the API key |
| `SUBCONSCIOUS_LLM_TEMPERATURE` | `0.7` | Sampling temperature |

**Runtime config stored at**: `<agentHome>/state/subconscious/runtime.json`

### Configuration Schemas

#### letta.json

**Location**: `<agentHome>/state/letta.json`
**Writer**: `scripts/configure-v1-subconscious.js:201-238` (bootstrap), `PATCH /api/agents/:name/subconscious-guidance` (runtime)

```json
{
  "provider": "local",
  "mode": "runtime",
  "agentId": "claude-hafleet-<agentName>",
  "resolutionSource": "deterministic",
  "guidance": {
    "type": "manual",
    "text": "Focus guidance text",
    "updatedAt": "ISO-8601"
  },
  "lastInvocation": { "timestamp": "...", "guidanceGenerated": true },
  "lastRuntimeGuidance": { "text": "...", "generatedAt": "..." }
}
```

#### runtime.json

**Location**: `<agentHome>/state/subconscious/runtime.json`
**Writer**: `scripts/configure-v1-subconscious.js:172-199`

```json
{
  "enabled": true,
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "endpoint": "https://api.deepseek.com",
    "keyEnv": "DEEPSEEK_API_KEY",
    "temperature": 0.7
  },
  "hooks": {
    "installed": true,
    "hookFile": ".claude/hooks/hooks.json",
    "entryScript": "<repoRoot>/subconscious/claude-hafleet/scripts/hook-entry.mjs"
  },
  "endpoints": {
    "eventUrl": "http://localhost:8090/api/subconscious/events",
    "invokeUrl": "http://localhost:8090/api/subconscious/runtime/invoke"
  }
}
```

### Provisioning

**Script**: `scripts/configure-v1-subconscious.js`
**Usage**: `node scripts/configure-v1-subconscious.js <agentName>`

**Creates**:
```
<agentHome>/
├── state/
│   ├── letta.json
│   └── subconscious/
│       ├── runtime.json
│       ├── memory.json         (created on first runtime invoke)
│       ├── conversations.json  (created on first event sync)
│       └── upstream-home/      (for Letta integration)
└── .claude/
    ├── settings.json           (updated with hooks reference)
    └── hooks/
        └── hooks.json
```

### Subconscious API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/subconscious/events` | Event ingestion |
| `GET` | `/api/subconscious/events` | List all events |
| `GET` | `/api/subconscious/events/:name` | List events for agent |
| `POST` | `/api/subconscious/runtime/invoke/:name` | Invoke runtime guidance |
| `POST` | `/api/subconscious/upstream/session-start/:name` | Start upstream session |
| `POST` | `/api/subconscious/upstream/user-prompt/:name` | Sync user prompt |
| `POST` | `/api/subconscious/upstream/pretool/:name` | Sync pre-tool use |
| `POST` | `/api/subconscious/upstream/stop/:name` | Sync stop event |
| `PATCH` | `/api/agents/:name/subconscious-guidance` | Update manual guidance |

### Event Authorization

**Function**: `authorizeSubconsciousEventIngest(req, agentName)` (`backend-v2.js:2402-2423`)

| Mode | Condition | Config |
|------|-----------|--------|
| Local-only (default) | `req.ip === '127.0.0.1'` | No config needed |
| Token mode | `Authorization: Bearer <token>` matches `SUBCONSCIOUS_EVENT_TOKEN` | Set `SUBCONSCIOUS_EVENT_TOKEN` env var |

---

## 4. Remote Server Management

### Architecture

Remote agents run on separate servers and communicate with the central backend via HTTPS. The push-relay acts as the communication bridge, consuming SSE events and injecting messages into the agent's tmux session.

```
┌────────────────────────────────┐        HTTPS         ┌──────────────────────┐
│        Remote Server           │◄─────────────────────│   Central Backend    │
│                                │                      │   (backend-v2 :8090) │
│  ┌──────────┐  ┌────────────┐  │   SSE subscribe      │                      │
│  │  Agent   │  │ Push-Relay │──┼──────────────────────►│   /api/stream │
│  │  (tmux)  │◄─┤            │  │                      │                      │
│  └──────────┘  │  heartbeat │──┼──POST /api/heartbeat─►│                      │
│                │  messages   │──┼──POST /api/messages──►│                      │
│                └────────────┘  │                      │                      │
│  ┌──────────────────────────┐  │                      │                      │
│  │ Remote Autodeploy        │  │   git pull stable    │                      │
│  │ (60s poll, push-relay)   │  │                      │                      │
│  └──────────────────────────┘  │                      │                      │
└────────────────────────────────┘                      └──────────────────────┘
```

**Note**: Research found no frp or tuwunel tunnel infrastructure in the codebase. Remote agents connect directly to the central backend via HTTPS. The backend must be accessible from the remote server's network.

### Push-Relay Protocol

**File**: `lib/push-relay-core.js` (822 lines)

The push-relay is the core communication component for remote agents.

#### Connection

**SSE subscription** (`push-relay-core.js:697-717`):
- Connects to `GET /api/stream` on the central backend
- Sends `Authorization: Bearer <API_TOKEN>` header
- Receives server-sent events for messages, heartbeats, agent status

#### Heartbeat

**Interval**: 15 seconds (`push-relay-core.js:28`, `HEARTBEAT_INTERVAL_MS=15000`)

**Behavior** (`push-relay-core.js:448-473`):
1. Every 15s, POST to `/api/heartbeat` with agent name and timestamp
2. Backend updates `lastHeartbeat` for the agent
3. If heartbeat fails, push-relay logs error but continues (does not disconnect)

#### Reconnection

**Delay**: 5 seconds (`push-relay-core.js:26`, `RECONNECT_MS=5000`)

**Behavior**:
- On SSE disconnect, waits 5 seconds then reconnects
- Automatic retry with no backoff (constant 5s delay)
- Logs reconnection attempts

#### Message Handling

**Function**: `handleMessage()` (`push-relay-core.js:668-695`)

1. Receives message event from SSE stream
2. Filters for messages targeted at this agent
3. Injects message into agent's tmux session via `tmux send-keys`

#### Activity Metrics

**Function**: `computeActivityMetrics()` (`push-relay-core.js:217-257`)

- Tracks message rates, idle periods, blocked detection
- Remote idle threshold: 20 seconds (`push-relay-core.js:35`, `IDLE_THRESHOLD_MS=20000`)
- Detects compaction (agent stuck processing same content)

### Remote Provisioning

**Script**: `remote/install-remote.sh` (388 lines)

**Usage**: Run on the remote server to set up push-relay and autodeploy.

**Steps**:

1. **Prerequisites check** (lines 106-119):
   - Node.js installed
   - npm installed
   - tmux installed
   - Git repo cloned

2. **Environment setup** (lines 122-144):
   - Creates `.env` file with:
     - `API_TOKEN` — bearer token for backend API
     - `HAFLEET_BACKEND_URL` — central backend URL (e.g. `https://host:8090`)
     - `HAFLEET_AGENT_NAME` — agent name for this remote instance

3. **Dependencies** (lines 146-148):
   - Runs `npm install` in the cloned repo

4. **Helper linking** (lines 150-175):
   - Links `bin/` scripts to PATH for operational convenience

5. **Platform-specific service setup**:
   - **Linux** (lines 177-233): Creates systemd service units from templates
     - `push-relay.service` — runs push-relay
     - `push-relay-autodeploy.service` — polls stable branch
   - **macOS** (lines 234-303): Creates launchd plist files
     - Equivalent services via `launchctl`

6. **MCP configuration** (lines 306-352):
   - Configures MCP server for the agent
   - Sets up tool bindings

7. **Verification** (lines 354-372):
   - Starts services
   - Validates push-relay connects to backend
   - Confirms heartbeat is received

### Network Requirements

| Direction | Protocol | Port | Purpose |
|-----------|----------|------|---------|
| Remote → Central | HTTPS | 8090 | API calls (heartbeat, messages) |
| Remote → Central | HTTPS | 8090 | SSE subscription (`/api/stream`) |
| Central → Remote | None | — | No inbound connections required |

**Key point**: The push-relay initiates all connections. The remote server needs outbound HTTPS access to the central backend only. No inbound ports need to be opened on the remote server.

---

## 5. Operational Runbooks

### 5.1 Deploy Flow

#### Dev Deploy (automatic)

The dev autodeploy service handles this automatically. To trigger manually:

```bash
# Check autodeploy status
systemctl --user status hafleet-dev-autodeploy

# View recent deploy logs
journalctl --user -u hafleet-dev-autodeploy --since "1 hour ago"

# Manual deploy (if autodeploy is stopped)
cd ~/laplace/hafleet
git pull --ff-only origin master
npm install
systemctl --user restart hafleet-dev-backend
systemctl --user restart hafleet-dev-web
```

#### Stable Deploy (automatic, health-gated)

```bash
# Check stable autodeploy status
systemctl status hafleet-stable-autodeploy

# View deploy logs
tail -f ~/laplace/hafleet-live/logs/autodeploy.log

# Manual stable deploy
cd ~/laplace/hafleet-live
git pull --ff-only origin stable
npm install
systemctl restart hafleet-backend
# Wait for backend health
for i in $(seq 1 30); do
  curl -sf http://localhost:8090/api/agents && break
  sleep 1
done
systemctl restart bridge-matrix
systemctl restart hafleet
```

### 5.2 Agent Restart

#### Graceful Shutdown

```bash
# Check agent activity first
bin/hafleet-ls                          # List running agents
bin/hafleet-audit <agentName>           # Check recent activity

# Graceful shutdown (archives scrollback, captures resume-id)
bin/hafleet-down <agentName>
```

**`hafleet-down` sequence** (`bin/hafleet-down`, 600 lines):

1. **Safety checks** (lines 257-319):
   - Validates agent exists and is running
   - Checks for active tmux session
   - Warns if agent has recent activity (last 5 minutes)

2. **Backend notification** (lines 224-256):
   - POST to mark agent as offline in backend
   - Updates agent status in registry

3. **Archive & resume** (lines 456-506):
   - Captures tmux scrollback to archive file
   - Saves `resume-id` to `state/resume-id` for later `hafleet-up --resume`
   - Preserves conversation state

4. **Exit sequence** (lines 518-543):
   - Kills tmux session
   - Cleans up PID files
   - Final status update to backend

#### Startup / Resume

```bash
# Fresh start
bin/hafleet-up <agentName>

# Resume from previous session
bin/hafleet-up <agentName> --resume
```

**Resume** reads `state/resume-id` to continue the previous conversation.

### 5.3 Merge-to-Stable Checklist

Based on `docs/hafleet-develop/stable-merge-readiness-audit.md` (246 lines) and `docs/hafleet-develop/stable-merge-execution-hygiene-plan.md` (175 lines).

#### Pre-Merge Blockers (must all pass)

1. **All agents idle or stopped** — no active work in progress
2. **No pending deploys** — `deploy_pending` is false on all autodeploy instances
3. **Bridge sync healthy** — no outstanding reconciliation errors
4. **Alert store clear** — no open critical alerts

#### 6-Point Sanity Pass

1. **Diff review** — `git diff master..stable` is empty or understood
2. **Test pass** — any automated tests pass on master
3. **Env var audit** — no new env vars required that aren't set in stable
4. **Service compatibility** — no breaking API changes between master and stable
5. **Data migration** — no schema changes requiring migration scripts
6. **Rollback plan** — know the last stable commit hash to revert to

#### Merge Sequence

```bash
# 1. Stop all agents
bin/hafleet-down --all

# 2. Switch to stable branch
cd ~/laplace/hafleet-live
git checkout stable

# 3. Merge master into stable
git merge origin/master --ff-only

# 4. Push stable
git push origin stable

# 5. Autodeploy picks up the change automatically
# Monitor: tail -f logs/autodeploy.log

# 6. Verify health
curl -sf http://localhost:8090/api/agents
```

#### Post-Merge Obligations

- Monitor autodeploy logs for 5 minutes
- Verify all services restarted cleanly
- Check dashboard for agent connectivity
- Restart agents as needed with `bin/hafleet-up`

### 5.4 Trust Mode Flip

**Configuration**: `HAFLEET_AGENT_TOKEN_MODE` environment variable

**Enforcement logic**: `backend-v2.js:163-220`

| Mode | Behavior | Use Case |
|------|----------|----------|
| `hard` | Enforce per-agent tokens; reject invalid with 403 | Production |
| `audit` | Log invalid tokens but allow requests through | Migration / debugging |
| `off` | No per-agent token enforcement | Development |

#### Changing Trust Mode

```bash
# 1. Update environment
export HAFLEET_AGENT_TOKEN_MODE=hard   # or: audit, off

# 2. Restart backend to pick up new mode
systemctl --user restart hafleet-dev-backend   # dev
# or
systemctl restart hafleet-backend                   # stable

# 3. Verify mode is active
curl -s http://localhost:8090/api/health | grep tokenMode
```

**Caution**: Switching from `off` → `hard` will immediately reject any agent without a valid token. Ensure all agents have tokens provisioned before flipping to `hard`. Use `audit` mode first to identify agents that would fail.

**Token provisioning**: Tokens are generated per-agent at registration time and stored in `data/tokens.json` (managed inline in `backend-v2.js`). Agents receive their token during provisioning and include it as `X-Agent-Token` header on API calls.

### 5.5 Orphan Room Cleanup

**Status**: Not automated in the codebase. Requires manual intervention via Matrix admin API.

**What creates orphan rooms**:
- Agent deprovisioned but Matrix room not deleted
- Bridge reconciliation skips rooms it doesn't recognize
- Failed room creation leaves partial state

**Manual cleanup procedure**:

```bash
# 1. List all managed rooms from backend
curl -s http://localhost:8090/api/groups | jq '.[].matrixRoomId'

# 2. List all rooms from Matrix (requires admin access)
# Use Matrix Synapse admin API:
curl -s -H "Authorization: Bearer <admin_token>" \
  "https://matrix.server/_synapse/admin/v1/rooms?limit=100" | jq '.rooms[].room_id'

# 3. Compare lists — rooms in Matrix but not in backend are orphans

# 4. For each orphan room, delete via admin API:
curl -X DELETE -H "Authorization: Bearer <admin_token>" \
  "https://matrix.server/_synapse/admin/v2/rooms/<room_id>" \
  -d '{"purge": true}'
```

**Bridge reconciliation** (`bridge-matrix.js:2200-2270`) handles room name mismatches but does not delete orphan rooms.

### 5.6 bin/ Script Catalog

| Script | Purpose |
|--------|---------|
| `bin/hafleet-up` | Start or resume an agent (tmux session, MCP, push-relay) |
| `bin/hafleet-down` | Graceful agent shutdown (archive, resume-id capture) |
| `bin/hafleet-ls` | List running agents with status |
| `bin/hafleet-send` | Send a message to an agent |
| `bin/hafleet-audit` | Check agent activity and recent messages |
| `bin/agent-dashboard` | Open the web dashboard |
| `bin/agent-task` | Manage agent tasks (create, update, list) |
| `bin/group-add` | Add member to a group |
| `bin/group-remove` | Remove member from a group |
| `bin/room-members` | List members of a Matrix room |
| `bin/mcp-run` | Run the MCP server for an agent |
| `bin/push-relay-run` | Run push-relay for an agent |

### 5.7 Service Management Quick Reference

```bash
# ─── Dev environment (systemctl --user) ───
systemctl --user status hafleet-dev-backend
systemctl --user status hafleet-dev-web
systemctl --user status hafleet-dev-autodeploy

systemctl --user restart hafleet-dev-backend
systemctl --user restart hafleet-dev-web

# ─── Stable environment (systemctl as root) ───
systemctl status hafleet-backend
systemctl status bridge-matrix
systemctl status hafleet
systemctl status hafleet-stable-autodeploy

# ─── Health checks ───
curl -s http://localhost:8090/api/agents          # Backend API
curl -s http://localhost:8090/api/health          # Health summary
curl -s http://localhost:8084/                     # Dashboard

# ─── Logs ───
journalctl --user -u hafleet-dev-backend -f    # Dev backend logs
journalctl --user -u hafleet-dev-web -f         # Dev web/dashboard logs
tail -f ~/laplace/hafleet-live/logs/*.log       # Stable logs
```
