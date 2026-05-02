# 01 Kernel

Date: 2026-05-02

## Kernel Components

| Component | Files | Current role |
| --- | --- | --- |
| Backend service | `backend-v2.js` | Central API, JSON state owner, SSE emitter, auth gates, kernel and edge routes. |
| Agent state | `lib/agent-state.js` | Derives runtime/legacy agent state and MCP expectations. |
| Agent home v1 | `lib/agent-home-v1.js`, `scripts/provision-v1-agent-home.js` | V1 home layout, manifest, state/workdir split, project copy/symlink binding. |
| MCP tools | `lib/mcp-server-core.js`, `mcp-server.js` | Agent-facing stdio server exposing `whoami`, `send_message`, `post`, `check_inbox`, `check_group`. |
| Push relay | `lib/push-relay-core.js`, `push-relay.js` | Runtime delivery transport and local tmux activity observer. |
| Stores | `backend-v2.js`, `lib/task-store.js`, `lib/task-graph.js`, `lib/alert-store.js` | JSON-backed state stores. |

## Canonical State

The backend loads these kernel-facing stores from `DATA_DIR`:

- `agents.json`
- `deleted_agents.json`
- `groups.json`
- `messages.json`
- `cursors.json`
- `servers.json`
- `agent_runtime.json`
- `tasks.json`
- `task_graphs.json`
- `alerts.json`
- `supervisor_snapshots.json`

Current risk: stores are not versioned through a shared schema/migration contract, so type drift is handled by ad hoc normalizers.

## Main API Groups

| API family | Kernel role | Boundary note |
| --- | --- | --- |
| `/api/agents*` | Agent identity, record lifecycle, runtime, avatar, groups, tasks. | Mutating calls must authenticate as agent or operator. |
| `/api/messages*` | Message creation, detail, suppression, HTML preview. | Detail reads must not be public. |
| `/api/inbox*` | Per-agent unread state and cursor advancement. | Cursor mutation is memory mutation. |
| `/api/groups*` | Group records, membership, group message reads. | Reads that advance group cursor must authenticate as that agent. |
| `/api/tasks*` | Adjacent task lifecycle. | Should not compete with message truth or agent identity. |
| `/api/task-graphs*` | Adjacent orchestration graph. | Node completion must authenticate against assignee and dispatch. |
| `/api/alerts*` | Adjacent operational ticket state. | Should observe, not redefine, kernel behavior. |
| `/api/stream` | Event stream for transports. | SSE is fan-out, not source of truth. |

## Message Flow

```text
agent
  -> MCP `send_message` / `post`
  -> backend `POST /api/messages`
  -> append message
  -> update counters/visibility
  -> broadcast SSE
  -> push relay / Matrix / dashboard consumers
  -> recipient `check_inbox` or `check_group`
```

Important semantics:

- `check_inbox` can advance the agent inbox cursor.
- `check_group` can advance group-specific cursors.
- Suppression must mean "do not show this message", not merely "do not push right now".

## Kernel Problems Found

The current repair table treats these as highest priority:

- Anonymous group reads can advance another agent's cursor.
- Message detail endpoints are public.
- Agent-token enforcement is fail-open by default.
- Offline group mentions can be hidden forever.
- Task graph results can be spoofed.
- Task truth is split across agent records, task store, and task graph store.

See `audit-findings.md` for file/line evidence and `repair-table.md` for repair order.
