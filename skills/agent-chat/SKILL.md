---
name: agent-chat
description: Agent Chat operations handbook — MCP messaging, attachments, CLI admin, lifecycle, and remote verification.
---

# Agent Chat

Practical reference for daily operation of the agent-chat system.

## Core Rule
- When you receive a notification, run `check_inbox()` first.
- For human/operator tasks: finish all required work before replying.
- Use `summary` for short notification text and `full` for complete details.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `whoami()` | Concise identity, agent names, group names |
| `check_inbox(kinds?)` | Read unread DMs + group mentions (advances cursor; non-destructive preview when filtered by kinds) |
| `check_group(group, limit?, unread_limit?, read_all?)` | Group unread/read split view |
| `send_message(to, summary, full, type?, priority?, reply_to?, attachments?, schema?)` | DM agent/human |
| `post(group, summary, full, type?, priority?, mentions?, reply_to?, attachments?, schema?)` | Post to group |

### Message Types
- `request`: needs response
- `inform`: FYI
- `reply`: explicit reply (`reply_to` recommended)

### Priority Levels
- `normal`: queued for idle delivery (default)
- `high`: skip idle gate
- `urgent`: immediate delivery

### Structured Messages
Use `schema` for machine-readable payloads:
```python
send_message(
  to="target",
  summary="task assignment",
  full="details...",
  schema={"kind": "task_request", "payload": {...}}
)
```

### Attachment Sending (DM / Group)
Use `attachments` in `send_message` or `post`:
- item fields: `path` (required), `name` (optional), `mime` (optional), `kind` (`image|file`, optional)
- flow: local file -> backend `/api/media/stage` -> message `attachments[]` path -> Matrix bridge sends real `m.image`/`m.file`

Example:
```python
send_message(
  to="operator",
  summary="design files",
  full="please review",
  attachments=[
    {"path":"/abs/path/screen.png","kind":"image"},
    {"path":"/abs/path/spec.pdf","kind":"file"}
  ]
)
```

If your MCP schema has not refreshed yet, fallback is direct backend API:
1. `POST /api/media/stage`
2. `POST /api/messages` with `attachments`

## CLI Quick Reference

### Agent lifecycle
```bash
agentchat up <name> <path> [claude|codex] [--fresh] [--attach] [--model <model>] [--extra-args "..."]
agentchat up-v1 <name> [claude|codex] [--project <path>] [--project-mode copy|symlink] [--fresh] [--attach]
agentchat down <name> [--kill] [--timeout <sec>]
agentchat ls
agentchat send <target-pane> "<message>"
```

### V1 project management
```bash
agentchat project <agent> add <name> <source-path> [--mode copy|symlink]
agentchat project <agent> remove <name>
agentchat project <agent> list
```

### Task graph orchestration
```bash
agentchat graph create <file.json>
agentchat graph list
agentchat graph show <id>
agentchat graph delete <id>
```

### Admin
```bash
agentchat cli list-agents
agentchat cli status [name]
agentchat cli agent <name>
agentchat cli identity <name> "<text>"
agentchat cli avatar <name> [image|--force]
agentchat cli dm <agent> <human>

agentchat cli create-group <name> [member1 ...]
agentchat cli add-member <group> <m1> [m2 ...]
agentchat cli rm-member <group> <m1> [m2 ...]
agentchat cli list-groups
agentchat cli group <name>
agentchat cli delete-group <name>
```

### Deploy / service
```bash
agentchat update
agentchat update --pause-services
agentchat update --resume-services
agentchat update --restart-services
agentchat update --service-status
agentchat service <pause|resume|restart|status> [--profile local|remote|all]
agentchat verify-remote [--agent <name>]
agentchat audit
agentchat benchmark
agentchat maintain [--dry-run]
agentchat prune-agents [--older-than-days <n>] [--apply]
agentchat sync-skills [--check]
agentchat check-mcp
```

### Reminders
```bash
agentchat reminder <delay_seconds> "<message>"
self-time-reminder <delay_seconds> "<message>"
```

### Stable auto deploy watcher (local live deploy folder)
```bash
sudo cp /path/to/agent-chat/agent-chat-stable-autodeploy.service /etc/systemd/system/agent-chat-stable-autodeploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-chat-stable-autodeploy
systemctl status agent-chat-stable-autodeploy --no-pager
```

## Authentication

### Bearer Token
- Set via `API_TOKEN` env var
- Required for admin routes (task creation, alert management, supervisor control)
- Pass as `Authorization: Bearer <token>`

### Agent Token
- Per-agent token at `<stateDir>/agent-token`
- Required for agent-specific routes (runtime, task transitions, alert transitions for assigned alerts)
- Pass as `X-Agent-Token: <token>` header
- Mode controlled by `AGENTCHAT_AGENT_TOKEN_MODE`: `hard` (enforce), `audit` (log only), `off` (disabled)

## Alert System

Alerts are ingested automatically from system events or manually via `POST /api/system/info` with `alertType`/`dedupeKey`.

**Statuses:** `open` → `acknowledged` → `assigned` → `resolved` (terminal); `suppressed` → `open`/`assigned`

**Auto-resolution:** Recovery events auto-resolve matching alerts:
- `mcp_recovered` → resolves `mcp_missing`
- `server_online` → resolves `server_offline`
- `swap_clear` → resolves `swap_high`
- `agent_recovered` → resolves `agent_blocked`

**Dashboard:** Available at `/alerts` on the web server (port 8084).

## Health Checks
- Backend health: `curl --noproxy '*' http://127.0.0.1:8090/health`
- Web dashboard: `curl --noproxy '*' http://127.0.0.1:8084/`
- Attachment staging: `POST /api/media/stage` (200 expected)
- Bridge must be connected to SSE and online in Matrix.
- Alert stats: `GET /api/alerts/stats` (requires bearer)

## Architecture Snapshot
- `backend-v2.js` (`:8090`): agents/groups/messages/tasks/alerts/cursors + API
- `server.js` (`:8084`): queue + web monitor + alert dashboard
- `bridge-matrix.js`: Matrix <-> backend bridge (ACL-gated bot commands)
- `mcp-server.js`: per-agent MCP entrypoint
- `push-relay.js`: tmux notification delivery daemon
- `lib/alert-store.js`: alert ticket management
- `lib/task-store.js`: task management
- `lib/task-graph.js`: DAG-based task orchestration
- `lib/supervisor-action-engine.js`: LLM-based focus audit with nudge/escalation
