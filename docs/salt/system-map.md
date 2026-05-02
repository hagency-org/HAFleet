# System Map

Date: 2026-05-02

## Repository Shape

Top-level implementation:

| Path | Role |
| --- | --- |
| `backend-v2.js` | Central REST API, SSE stream, JSON-backed kernel state, tasks, alerts, runtime monitoring, Supervisor and subconscious routes. |
| `server.js` | Web dashboard, tmux capture, queue/idle delivery surface, reminders, operator UI. |
| `lib/` | Shared modules for MCP, push relay, agent state, task graph, alerts, Supervisor, subconscious, and runtime guards. |
| `bin/` | Local CLI wrappers for agent lifecycle, messaging, graph/task utilities, service operations, and audits. |
| `remote/` | Remote deployment subset and mirrored binaries/libraries. |
| `bridge-matrix.js` | Optional Matrix bridge and agent puppet integration. |
| `scripts/` | Build, audit, provisioning, task/supervisor helper scripts. |
| `tests/` | Vitest API, unit, CLI, runtime, Matrix, Supervisor, and parity tests. |
| `docs/architecture/` | Older architecture documents that remain useful but need verification against current code. |

Current size indicators from `wc -l`:

| File or area | Lines |
| --- | ---: |
| `backend-v2.js` | 9046 |
| `server.js` | 8872 |
| `bridge-matrix.js` | 3387 |
| `lib/` JS modules | 6801 |
| `bin/` scripts | 6314 |
| `scripts/` | 5043 |
| `tests/` | 7537 |

## Runtime Components

```text
Agent CLI / Claude / Codex
  -> MCP stdio server (`lib/mcp-server-core.js`)
  -> backend API (`backend-v2.js`)
  -> JSON stores under runtime `data/`
  -> SSE stream
  -> push relay / Matrix bridge / dashboard
```

## Kernel Data Stores

`backend-v2.js` loads JSON-backed state under `DATA_DIR`, currently rooted at `AGENT_CHAT_RUNTIME_DIR` or the repository root. Key stores include:

| Store | Current file |
| --- | --- |
| Agents | `data/agents.json` |
| Deleted-agent tombstones | `data/deleted_agents.json` |
| Groups | `data/groups.json` |
| Messages | `data/messages.json` |
| Cursors | `data/cursors.json` |
| Servers | `data/servers.json` |
| Agent runtime | `data/agent_runtime.json` |
| Tasks | `data/tasks.json` |
| Task graphs | `data/task_graphs.json` |
| Alerts | `data/alerts.json` |
| Supervisor snapshots | `data/supervisor_snapshots.json` |

## Main Flows

### Agent Sends DM

1. Agent calls `send_message` through MCP.
2. MCP server posts to `POST /api/messages`.
3. Backend validates sender token mode, stores message, updates counters, broadcasts SSE.
4. Push relay and optional Matrix bridge consume SSE.
5. Recipient reads through `check_inbox`, which advances cursor unless filtered preview mode is used.

### Agent Posts Group Message

1. Agent calls MCP `post`.
2. Backend resolves group membership and mentions.
3. Backend stores message and emits SSE.
4. Group members receive unread/mention state according to cursor and mention rules.

### Local Delivery

1. Push relay connects to backend `/api/stream`.
2. Relay tracks local tmux sessions and activity.
3. Normal-priority notifications wait for idle state; high/urgent bypass the idle gate.
4. Relay injects notifications into tmux and reports runtime/push state back to backend.

### Optional Matrix Delivery

1. Matrix bridge consumes the same backend stream.
2. It maps agents/groups/DMs to Matrix rooms and puppet accounts.
3. Matrix user messages become backend messages, subject to trust and command ACL rules.

## Source Of Truth Rule

The backend JSON stores are the intended source of truth for kernel facts. MCP, push relay, Matrix, dashboard, and CLI should be clients or transports. Any place that duplicates message, cursor, identity, or group truth is a structural risk.
