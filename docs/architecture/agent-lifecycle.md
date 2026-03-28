# Agent Lifecycle Architecture

> **Scope**: End-to-end agent lifecycle — types, provisioning, session management, supervisor oversight, task system, home directory layout, subconscious hooks, and key files.
> **Primary sources**: `bin/agent-up`, `bin/agent-down`, `scripts/provision-v1-agent-home.js`, `lib/agent-state.js`, `lib/supervisor-lifecycle-manager.js`, `lib/task-store.js`, `backend-v2.js`.

---

## Table of Contents

1. [Agent Types](#1-agent-types)
2. [Provisioning](#2-provisioning)
3. [Session Lifecycle](#3-session-lifecycle)
4. [Supervisor Lifecycle](#4-supervisor-lifecycle)
5. [Task System](#5-task-system)
6. [Agent Home Directory](#6-agent-home-directory)
7. [Subconscious / Hooks](#7-subconscious--hooks)
8. [Key Files](#8-key-files)

---

## 1. Agent Types

Agentchat supports two agent frameworks: **claude** (Anthropic Claude Code) and **codex** (OpenAI Codex CLI). The framework is set via `--framework` flag on `agent-up` or the `framework` field in `agent.json`.

### 1.1 Framework Comparison

| Property | `claude` | `codex` |
|----------|----------|---------|
| Launch binary | `claude` | `codex` |
| MCP integration | Built-in MCP server support | MCP via `-c mcp_servers.*` flags |
| Permission model | `--dangerously-skip-permissions` | `--yolo` (full auto-approve) |
| Resume mechanism | `--resume <resume-id>` | `codex resume <resume-id>` |
| New session | `--session-id <uuid>` | `-C <agent-path>` |
| Exit sequence | `/exit` + Enter + 3×Ctrl+C | 2×Ctrl+C |
| Shutdown timeout | 30s | 8s |
| Resume-ID required on shutdown | Yes — agent-down refuses without it | No |
| CLAUDE.md / AGENTS.md | Read automatically | Read automatically (as AGENTS.md) |
| Context management | Env vars (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) | `config.toml` or `-c` flags |
| Subconscious hooks | Supported via `hooks.json` | Not supported |

Source: `bin/agent-up:552-575` (framework detection), `bin/agent-up:1641-1654` (Claude launch), `bin/agent-up:1659-1694` (Codex launch).

### 1.2 Claude Launch

```bash
claude --resume "$RESUME_ID" \
       --dangerously-skip-permissions
# OR for new sessions:
claude --session-id "$SESSION_ID" \
       --dangerously-skip-permissions
```

Key env vars injected: `ANTHROPIC_MODEL`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_PROMPT_CACHING`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`.

Source: `bin/agent-up:1641-1654`, `bin/agent-up:1564-1609` (env prefix construction).

### 1.3 Codex Launch

```bash
codex resume "$RESUME_ID"
# OR for new sessions:
codex --yolo -C "$AGENT_PATH" \
      -c mcp_servers.agentchat.type=sse \
      -c "mcp_servers.agentchat.url=$MCP_SSE_URL" \
      -c "mcp_servers.agentchat.headers.Authorization=Bearer $AGENT_TOKEN"
```

MCP is configured via `-c` flags rather than a built-in mechanism. The `--yolo` flag enables full auto-approve mode.

Source: `bin/agent-up:1659-1694`, `bin/agent-up:1502-1530` (Codex MCP flag construction).

### 1.4 Framework Validation

Backend validates framework on agent registration — only `claude` and `codex` are accepted.

Source: `backend-v2.js:6690-6693`.

---

## 2. Provisioning

### 2.1 Overview

```
API request (POST /api/agents)
  │
  ▼
backend-v2.js validates + registers agent
  │
  ▼
provision-v1-agent-home.js creates directory tree
  │
  ▼
agent-up launches tmux session + framework binary
  │
  ▼
Agent online (heartbeat begins)
```

### 2.2 Home Directory Creation

`scripts/provision-v1-agent-home.js` builds the V1 agent home layout:

```
~/.agentchat/agents/<agent_id>/
├── agent.json              # Agent manifest
├── state/                  # System-owned runtime state
│   ├── locks/              # Coordination locks
│   ├── history/            # Scrollback archives
│   ├── agent-token         # 64-char hex auth token
│   ├── resume-id           # Last session resume ID
│   ├── letta.json          # Letta integration config (if subconscious enabled)
│   └── subconscious-events.jsonl  # Hook event log
├── workdir/                # Agent's working directory (CWD)
│   ├── CLAUDE.md           # Rendered from template
│   ├── docs/               # plan.md, progress.md, projects.md
│   │   ├── plan.md
│   │   ├── progress.md
│   │   └── projects.md
│   ├── projects/           # Managed project trees
│   ├── scratch/            # Throwaway temp files
│   ├── inbox/              # Operator-staged inputs
│   ├── outputs/            # Deliverables
│   └── data/               # Tool caches
├── supervisor/             # Supervisor sibling workspace
│   └── workdir/
│       └── docs/
└── .claude/                # Claude settings, hook config
    └── settings.json
```

Source: `scripts/provision-v1-agent-home.js:619-635` (directory creation), `docs/v1-agent-home-contract.md:19-51` (layout spec).

### 2.3 Managed Projects

Each agent can have managed projects — code trees linked into `workdir/projects/<name>/`. Two modes:

| Mode | Mechanism | Agent edits affect source? |
|------|-----------|---------------------------|
| **copy** | `fs.cpSync(source, dest, { recursive: true })` | No — isolated copy |
| **symlink** | `fs.symlinkSync(source, dest)` | Yes — edits propagate |

Source: `scripts/provision-v1-agent-home.js:404-427`.

### 2.4 Template Rendering

CLAUDE.md is rendered from `docs/workspace-claude-md-template.md` with placeholder substitution:

| Placeholder | Value |
|-------------|-------|
| `{{AGENT_NAME}}` | Agent's display name |
| `{{AGENT_ID}}` | Agent's system ID (`agent_<name>`) |
| `{{LAYOUT_VERSION}}` | Always `1` for V1 layout |

Source: `scripts/provision-v1-agent-home.js:208-278`, `docs/workspace-claude-md-template.md`.

### 2.5 Agent Token

A 64-character hex token is generated at provisioning time and written to `state/agent-token`. This token authenticates the agent's MCP requests to the backend via `X-Agent-Token` header.

Source: `scripts/provision-v1-agent-home.js` (token generation), `backend-v2.js:197-212` (`checkAgentToken()`/`requireAgentToken()` — token validation).

---

## 3. Session Lifecycle

### 3.1 State Machine

Agents progress through a state machine defined in `lib/agent-state.js:4-10`:

```
              tmux_detected
  offline ──────────────────► starting
                                 │
                          ┌──────┴──────┐
                          │             │
                    mcp_confirmed   grace_timer (30s)
                          │             │
                          ▼             ▼
                       online       degraded
                          │             │
                          │      mcp_confirmed
                          │         │
                          │         ▼
                          │      online
                          │
                    manual_down_requested
                          │
                          ▼
                     manual_down
```

**States**:

| State | Meaning |
|-------|---------|
| `offline` | No tmux session detected |
| `starting` | Tmux session exists, MCP not yet confirmed |
| `online` | Tmux session exists AND MCP confirmed (agent fully operational) |
| `degraded` | Tmux exists but MCP not confirmed after 30s grace period |
| `manual_down` | Operator explicitly shut down the agent |

Source: `lib/agent-state.js:4-10` (states), `lib/agent-state.js:17-60` (transitions), `lib/agent-state.js:98-108` (grace period).

### 3.2 Launch Sequence (agent-up)

```
1. Parse args (--name, --framework, --resume, --remote, etc.)
2. Validate agent exists in registry
3. Resolve or create tmux session name: agent-<name>
4. Set up managed project links/copies
5. Render CLAUDE.md from template
6. Build env var prefix (API tokens, model config, etc.)
7. Build framework-specific launch command
8. Create tmux session and send launch command
9. Backend detects tmux → state: starting
10. MCP confirms → state: online
```

Source: `bin/agent-up` (~1700 lines total).

### 3.3 Idle Detection

Idle detection uses **content-based tmux pane hashing**:

1. Backend periodically captures tmux pane content via `tmux capture-pane`
2. Hashes the content and compares with previous hash
3. If hash unchanged for `AGENT_IDLE_THRESHOLD_MS`, agent is marked idle

The idle threshold is configurable via the `AGENT_IDLE_THRESHOLD_MS` environment variable.

Source: `backend-v2.js` (idle detection loop), `server.js` (dashboard idle display).

### 3.4 Resume / Restart

**Resume** reattaches to a previous session using a stored resume ID:

- **Claude**: `claude --resume <resume-id>` — resumes the exact conversation with full context
- **Codex**: `codex resume <resume-id>` — resumes previous session

Resume ID is stored at `state/resume-id` and captured during shutdown.

**Validation** (`bin/agent-up:1260-1295`):
- If `--resume` is passed, agent-up reads `state/resume-id`
- If the file doesn't exist or is empty, falls back to new session
- For Claude, a missing resume-id is a warning; for Codex, it's acceptable

### 3.5 Shutdown (agent-down)

```
1. Validate agent is registered
2. Check activity status (refuse if agent appears active, unless --force)
3. Send framework-specific exit sequence:
   - Claude: /exit + Enter + 3×Ctrl+C (30s timeout)
   - Codex: 2×Ctrl+C (8s timeout)
4. Archive scrollback to state/history/<timestamp>.log
5. Capture resume-id from state/resume-id
6. Kill tmux session
7. Update agent state → manual_down
```

**Activity check** (`bin/agent-down:257-319`): Before shutdown, agent-down queries whether the agent is actively working. If the agent appears busy, shutdown is refused unless `--force` is passed.

**Resume-ID capture** (`bin/agent-down:480-506`): For Claude agents, agent-down checks `state/resume-id` and warns if missing — this means the session cannot be resumed later.

Source: `bin/agent-down:518-543` (exit signals), `bin/agent-down:473-478` (scrollback archival), `bin/agent-down:562-599` (shutdown sequence).

---

## 4. Supervisor Lifecycle

### 4.1 Overview

Supervisors are special agents that monitor other agents. Each supervisor is paired with a **target agent** and follows a **wake-on-main** model: the supervisor launches when its target is active and shuts down after a trailing window when the target goes idle.

### 4.2 Wake-on-Main Model

```
Target agent goes active
         │
         ▼
Supervisor launches (if not already running)
         │
         ▼
Supervisor runs assessment cycles (every 30s via deepseek)
         │
         ▼
Target agent goes idle
         │
         ▼
Trailing window starts: 3 × 120s TTL = 360s
         │
         ▼
If target still idle after 360s → supervisor shuts down
If target resumes → trailing window resets
```

Source: `lib/supervisor-lifecycle-manager.js:267-294` (wake logic), `lib/supervisor-lifecycle-manager.js:227-229` (trailing window: 3 × 120s).

### 4.3 Supervisor Launch

When launching a supervisor, the lifecycle manager:

1. Constructs env prefix with supervisor-specific config
2. Builds framework launch command (same as regular agents)
3. Creates tmux session `supervisor-<target-name>`
4. Sends auto-accept permission dialog keys (Down+Enter) at 5s and 10s
5. Injects initial prompt at 20s and 30s: `"Read your AGENTS.md and begin your assessment cycle now."`

Source: `lib/supervisor-lifecycle-manager.js:159-189` (launch command), `lib/supervisor-lifecycle-manager.js:54-74` (auto-accept), `lib/supervisor-lifecycle-manager.js:76-91` (prompt injection).

### 4.4 Orphan Cleanup

The lifecycle manager periodically scans for orphaned supervisor tmux sessions — sessions named `supervisor-*` whose target agent no longer exists or is no longer registered. Orphans are killed automatically.

Source: `lib/supervisor-lifecycle-manager.js:378-392`.

### 4.5 Supervisor Action Engine

When a supervisor detects issues (agent drifting, stuck, or lost), the action engine dispatches interventions:

- **Nudge**: Send a message to the agent
- **Escalate**: Alert the operator
- **Cooldown**: Prevent action spam with minimum intervals between interventions

Source: `lib/supervisor-action-engine.js` (131 lines), `lib/alert-store.js` (353 lines — alert ticket lifecycle: open → acknowledged → assigned → resolved → suppressed).

---

## 5. Task System

### 5.1 Task States

```
created ──► accepted ──► in_progress ──► done
                              │
                              ▼
                           blocked ──► in_progress (unblocked)
```

Defined in `lib/task-store.js:3-4`. Valid transitions (`lib/task-store.js:8-13`):

| From | To |
|------|----|
| `created` | `accepted` |
| `accepted` | `in_progress` |
| `in_progress` | `blocked`, `done` |
| `blocked` | `in_progress` |

### 5.2 Task Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique task identifier (e.g., `5.37`) |
| `title` | string | Short task description |
| `description` | string | Full task specification |
| `status` | enum | One of: created, accepted, in_progress, blocked, done |
| `priority` | string | Priority level (P1, P2, P3) |
| `granularity` | string | Task granularity hint |
| `assignee` | string | Agent name |
| `heartbeat_at` | ISO-8601 | Last heartbeat timestamp |
| `waiting_reason` | string | Why the agent is blocked (required for blocked state) |
| `waiting_until` | ISO-8601 | When the block is expected to resolve |

Source: `lib/task-store.js:83-103`.

### 5.3 Heartbeat

Agents send periodic heartbeats to signal they are actively working. The backend considers an agent's task **stale** if no heartbeat arrives within **90 seconds**.

```
HEARTBEAT_TTL_MS = 90000  // backend-v2.js:61
```

The dashboard and supervisor use heartbeat staleness to detect stuck or idle agents.

### 5.4 task-writer CLI

Each agent home provisions a `./task-writer` wrapper that posts task state updates to the backend API.

| Command | Effect |
|---------|--------|
| `./task-writer start --id <task-id>` | Begin a new task batch (sets status to `in_progress`) |
| `./task-writer heartbeat` | Send heartbeat for current task |
| `./task-writer wait --reason "<reason>" --until <ISO-8601>` | Declare blocked state with expected resolution time |
| `./task-writer resume` | Resume active work (transition blocked → in_progress) |
| `./task-writer done` | Mark current task batch as done |
| `./task-writer fail` | Report task failure |

Implementation: `scripts/write-v1-agent-task.js:76-89` (command parsing), `scripts/write-v1-agent-task.js:330-336` (API post to `/api/agents/:name`).

Task graph integration: When a task belongs to a task graph, `fail` also reports to `/api/task-graphs/:graphId/nodes/:nodeId` (`scripts/write-v1-agent-task.js:293-320`).

### 5.5 Wait / Blocked Semantics

When an agent enters blocked state, it must provide:
- `waiting_reason`: Human-readable explanation of the block
- `waiting_until`: ISO-8601 timestamp for expected resolution

The supervisor and dashboard use these fields to decide whether intervention is needed vs. the agent is safely waiting (e.g., waiting for a dependency agent to finish).

Source: `lib/task-store.js:220-226` (validation).

---

## 6. Agent Home Directory

### 6.1 V1 Layout

The V1 agent home is the standard layout for all agents. Root: `~/.agentchat/agents/<agent_id>/`.

```
<agent_id>/
├── agent.json                 # Manifest (identity, config, task)
├── AGENTS.md                  # Durable role/boundary rules
│
├── state/                     # System-owned — agent must not edit
│   ├── agent-token            # 64-char hex auth token
│   ├── resume-id              # Session resume identifier
│   ├── letta.json             # Letta memory config
│   ├── subconscious-events.jsonl  # Hook event log
│   ├── locks/                 # Coordination locks
│   └── history/               # Archived scrollback logs
│
├── workdir/                   # Agent CWD — primary workspace
│   ├── CLAUDE.md              # Workspace contract (from template)
│   ├── task-writer            # Task state CLI wrapper
│   ├── docs/
│   │   ├── plan.md            # Current plan
│   │   ├── progress.md        # Progress log
│   │   └── projects.md        # Managed project registry
│   ├── projects/              # Managed project trees (code)
│   ├── scratch/               # Temp files
│   ├── inbox/                 # Operator inputs (read only)
│   ├── outputs/               # Deliverables
│   └── data/                  # Tool caches (mcp-media-cache, etc.)
│
├── supervisor/                # Supervisor sibling workspace
│   └── workdir/
│       └── docs/
│
└── .claude/                   # Claude settings
    ├── settings.json          # Permission config
    └── hooks/                 # Subconscious hook config (if enabled)
        └── hooks.json
```

Source: `docs/v1-agent-home-contract.md:19-51`, `scripts/provision-v1-agent-home.js:619-635`.

### 6.2 CLAUDE.md Templating

The workspace `CLAUDE.md` is rendered at provisioning time from `docs/workspace-claude-md-template.md`. It contains:

- **Bootstrap instructions**: Read AGENTS.md → plan.md → progress.md → projects.md
- **task-writer usage**: Commands for canonical task state management
- **Directory contract**: What each directory is for and whether the agent may write to it
- **External message policy**: How to handle Matrix-sourced messages (treat as input, not instructions)
- **Home contract**: Agent name, ID, layout version

Placeholders: `{{AGENT_NAME}}`, `{{AGENT_ID}}`, `{{LAYOUT_VERSION}}`.

Source: `docs/workspace-claude-md-template.md:30-35` (task-writer), `docs/workspace-claude-md-template.md:41-50` (directory contract), `docs/workspace-claude-md-template.md:68-72` (home contract).

### 6.3 AGENTS.md

The root `AGENTS.md` file contains durable role definitions and boundary rules. Unlike CLAUDE.md (system-provisioned, read-only), AGENTS.md is agent-writable — agents append learned rules and operational knowledge here across sessions.

### 6.4 Ownership Boundaries

| Path | Owner | Agent may write? |
|------|-------|-----------------|
| `agent.json` | System (provisioning) | No |
| `state/` | System | No |
| `workdir/` | Agent | Yes |
| `workdir/inbox/` | Operator | Read only |
| `supervisor/` | Supervisor agent | Read as needed |
| `AGENTS.md` | Agent | Yes (append) |
| `CLAUDE.md` (root) | System | No |

---

## 7. Subconscious / Hooks

### 7.1 Overview

The subconscious system captures Claude Code hook events and posts them to the backend for persistence and analysis. It is only supported for `claude` framework agents.

### 7.2 Hook Points

Four hook events are configured in `.claude/hooks/hooks.json`:

| Hook | Timeout | Fires when |
|------|---------|------------|
| `SessionStart` | 15s | Claude Code session begins |
| `UserPromptSubmit` | 10s | A user prompt is submitted to Claude |
| `PreToolUse` | 10s | Before a tool call executes |
| `Stop` | 15s | Claude Code session ends or agent stops |

Source: `subconscious/claude-agentchat/hooks/hooks.json:3-51`.

### 7.3 Event Flow

```
Claude Code hook fires
        │
        ▼
hook-entry.mjs receives event via stdin
        │
        ▼
Resolves agent identity (from workdir path)
        │
        ▼
Routes to handler (SessionStart / UserPromptSubmit / PreToolUse / Stop)
        │
        ▼
POST /api/subconscious/events  →  backend-v2.js:6866-6945
        │
        ▼
Appended to state/subconscious-events.jsonl
        │
        ▼
Broadcast via SSE to subscribers
```

Source: `subconscious/claude-agentchat/scripts/hook-entry.mjs:500-596` (main entry), `backend-v2.js:6866-6945` (event ingestion).

### 7.4 Handler Details

**SessionStart** (`hook-entry.mjs`): Captures session initialization, logs session metadata.

**UserPromptSubmit** (`hook-entry.mjs:335-404`): Captures the submitted prompt content. Used by supervisors to understand what agents are working on.

**PreToolUse** (`hook-entry.mjs:406-472`): Captures tool name and parameters before execution. Useful for auditing file edits, bash commands, etc.

**Stop** (`hook-entry.mjs:271-333`): Captures session end. Triggers cleanup and final state snapshot.

### 7.5 Letta Integration

The subconscious supports optional Letta memory integration:

- Agent ID is deterministic: `agent_{workdir_basename}_claude_agentchat`
- Configuration stored in `state/letta.json`
- Memory is persisted across sessions via the Letta API

Source: `hook-entry.mjs:103-163` (Letta ID resolution).

### 7.6 Event Storage

Events are stored in two places:
1. **Local**: `state/subconscious-events.jsonl` — append-only JSONL file per agent
2. **Backend**: In-memory store with SSE broadcast to subscribers (dashboard, supervisor)

---

## 8. Key Files

### 8.1 agent.json Manifest

The agent manifest at `<agent_home>/agent.json` is the single source of truth for agent identity and configuration.

```json
{
  "id": "agent_ac-researcher",
  "name": "ac-researcher",
  "type": "agent",
  "layoutVersion": 1,
  "framework": "claude",
  "managedProjects": [
    {
      "name": "agentchat",
      "source": "/home/shisui/laplace/agent-chat",
      "mode": "symlink"
    }
  ],
  "task": {
    "id": "5.37",
    "title": "Agent lifecycle documentation",
    "status": "in_progress"
  },
  "runtimeProfile": {
    "model": "claude-opus-4-6",
    "contextWindow": 200000
  },
  "human": "shisui"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | System identifier (`agent_<name>`) |
| `name` | string | Display name |
| `type` | string | Always `"agent"` |
| `layoutVersion` | number | Always `1` for V1 layout |
| `framework` | string | `"claude"` or `"codex"` |
| `managedProjects` | array | List of `{ name, source, mode }` entries |
| `task` | object | Current task state (id, title, status, heartbeat_at, etc.) |
| `runtimeProfile` | object | Model config (model, contextWindow, etc.) |
| `human` | string | Operator username |

Source: `scripts/provision-v1-agent-home.js:671-690` (creation), `lib/agent-home-v1.js:184-216` (normalizeManifest), `docs/v1-agent-home-contract.md:63-117` (schema).

### 8.2 state/ Directory Contents

| File | Purpose | Written by |
|------|---------|------------|
| `agent-token` | 64-char hex token for X-Agent-Token auth | Provisioning |
| `resume-id` | Last session's resume identifier | agent-down (capture) / framework (write) |
| `letta.json` | Letta memory integration config | Provisioning (if subconscious enabled) |
| `subconscious-events.jsonl` | Append-only hook event log | hook-entry.mjs |
| `locks/` | Coordination lock files | System |
| `history/` | Archived tmux scrollback logs | agent-down |

### 8.3 resume-id

The resume ID enables session continuity across agent restarts.

**Write**: The framework binary writes its session/resume ID to a known location. For Claude, this is captured from the session state.

**Read**: `agent-up --resume` reads `state/resume-id` and passes it to the framework's resume flag.

**Capture on shutdown**: `agent-down` reads the resume-id before killing the tmux session and preserves it in `state/resume-id` for future restarts.

**Claude requirement**: agent-down warns (and by default refuses) if a Claude agent's resume-id cannot be captured — without it, the conversation context is permanently lost.

Source: `bin/agent-up:1260-1295` (resume validation), `bin/agent-down:480-506` (resume-id capture).

### 8.4 Scrollback Archives

On shutdown, agent-down captures the full tmux pane scrollback and archives it to `state/history/<timestamp>.log`. This provides a forensic record of the agent's terminal session.

Source: `bin/agent-down:473-478`.

---

## Appendix: Environment Variables

Key environment variables injected by agent-up at launch time:

| Variable | Framework | Purpose |
|----------|-----------|---------|
| `ANTHROPIC_MODEL` | claude | Model selection |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | claude | Max output tokens per response |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | claude | Context window for compaction (tokens) |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | claude | Compaction trigger percentage |
| `DISABLE_PROMPT_CACHING` | claude | Disable prompt caching |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | claude | Disable Anthropic-specific beta headers |
| `AGENT_IDLE_THRESHOLD_MS` | both | Idle detection threshold in milliseconds |
| `AGENTCHAT_BACKEND_URL` | both | Backend API endpoint |
| `AGENTCHAT_AGENT_NAME` | both | Agent's registered name |
| `AGENTCHAT_AGENT_TOKEN` | both | Per-agent auth token |

Source: `bin/agent-up:1564-1609`.
