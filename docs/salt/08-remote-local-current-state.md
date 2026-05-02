# 08 Remote Local Current State

Date: 2026-05-02
Status: design audit, read-only. No runtime code changes in this pass.

## Core Conclusion

The local/remote split is not one clean deployment distinction. It currently mixes four separate concepts:

1. Runtime host: a machine that owns tmux sessions and can observe/inject into them.
2. Deployment profile: central/live/dev/remote process sets.
3. Package shape: root checkout, `remote/` mirror, generated `remote-dist/`.
4. Operator surface: CLI commands and docs that imply what can be done from a host.

Remote is closer to the target architecture than local in one important way: remote mostly behaves like an edge relay that talks to the central backend. Local still has legacy compatibility paths where backend, dashboard, and optional push relay can all participate in runtime observation or delivery.

## Current Topology

### Central Kernel

`backend-v2.js` is the actual kernel:

- owns `agents.json`, `messages.json`, `cursors.json`, `groups.json`, `servers.json`, `agent_runtime.json`;
- stores messages via `POST /api/messages`;
- exposes inbox/cursor APIs such as `GET /api/inbox/:agent`;
- emits `/api/stream` events for transports;
- accepts server heartbeat and runtime observation reports.

The kernel invariant is already clear in practice: backend data is the only durable chat truth. SSE, tmux delivery, Matrix, dashboard, and remote packaging are transports or operator surfaces.

### Agent Interface

`lib/mcp-server-core.js` is the agent-facing kernel adapter:

- determines `AGENT_NAME`;
- calls backend APIs for `send_message`, `post`, `check_inbox`, and `check_group`;
- reads bearer and per-agent auth material from environment and agent state;
- writes `mcp-server.pid` under `AGENTCHAT_AGENT_STATE_DIR` when available.

This part is mostly profile-neutral: local and remote agents both use the same backend API contract.

### Local Runtime Paths

Local currently has multiple overlapping paths:

- Backend local tmux sweep observes sessions and MCP process presence.
- `server.js` has a legacy local queue, local `/api/messages`, local `/api/stream`, and tmux capture/delivery helpers.
- `push-relay` can also run locally and consume backend SSE, but its default `AGENT_CHAT_SERVER` differs from backend/MCP defaults.

This means "local" can mean central backend owner, dashboard host, runtime host, or developer checkout.

### Remote Runtime Paths

Remote is intended to be lighter:

- `push-relay.js` consumes central `/api/stream`, reports heartbeat/runtime, and injects into local tmux.
- `mcp-server.js` connects directly to the central backend.
- `agentchat` helpers manage local tmux agents and verify the central record.
- Remote does not run backend, dashboard, or Matrix bridge.

The model is cleaner, but the package and CLI surface do not consistently match it.

## Split Inventory

| Area | Local Behavior | Remote Behavior | Problem |
| --- | --- | --- | --- |
| Message truth | Backend stores durable messages; `server.js` also has legacy local log APIs. | Backend stores durable messages. | `server.js` still looks like a second message/event surface. |
| Push delivery | Backend can call dashboard queue; local relay may also consume SSE. | Relay consumes SSE and injects tmux. | Delivery path differs by profile and can duplicate concepts. |
| Liveness | Backend local sweep infers tmux/MCP. | Relay heartbeat reports sessions and runtime. | Observation owner differs. |
| `mcpPresent` | Backend can `pgrep` and map panes. | Relay checks pid/process and reports runtime. | Presence source differs. |
| Server id | Backend/MCP default to `local`; relay defaults to hostname. | Remote expects explicit `AGENT_CHAT_SERVER`. | Same env var has inconsistent defaults and meanings. |
| `agent.server` | Empty/`local`/current server id can all mean local. | Heartbeat binds agents to remote server id. | Server is both route key and legacy compatibility marker. |
| `agent.tmux` | Local pane target and online evidence. | Remote pane target and online evidence. | One field carries target, host observation, and compatibility. |
| Auth | Bearer, agent token, and localhost trust overlap. | Relay mainly uses bearer; MCP may use bearer + agent token. | Operator, server, and agent identities are not separated. |
| CLI | Full command surface advertised. | Remote mirror advertises commands not packaged. | Command availability is not profile-aware. |
| Package | Root files are true source. | `remote/` is both authored source and mirror; `remote-dist/` is stale. | Source, mirror, and generated artifact are mixed. |

## Packaging Evidence

Current read-only checks fail:

```text
bash scripts/check-remote-sync.sh
  bin/agentchat != remote/bin/agentchat
  bin/agent-service != remote/bin/agent-service
  bin/agent-up != remote/bin/agent-up
  generated remote package out of date

bash scripts/build-remote-package.sh --check
  remote/bin/agentchat drifted
  remote/bin/agent-service drifted
  remote/bin/agent-up drifted
  remote/lib/push-relay-core.js missing
  remote/lib/mcp-server-core.js drifted
```

`remote/bin/agentchat` advertises commands that the remote package does not contain, including `agent-up-v1`, `agent-project`, `agent-graph`, `agent-benchmark`, `check-mcp`, and `agent-resume-id`. Some included commands also assume git-checkout layout or root `remote/install-remote.sh`, which a standalone generated package does not have.

## Documentation Evidence

The docs mostly describe the right idea, but not a stable operator model:

- `README.md` describes central and remote roles, but still presents broad command tables without profile support boundaries.
- `remote/README.md` says managed remote files are generator controlled, while checks currently fail.
- `ROADMAP-remote.md` still reads like future work and mentions old concepts such as push relay being built into backend.
- `OPERATIONS.md` mixes remote relay maintenance, local stable deploy, agent down, server maintenance, and audit commands without a strict profile matrix.

## Main Risks

### P0: Runtime Truth Drift

When backend sweep, dashboard queue, and push relay can all write or infer runtime state, it becomes unclear which observation is authoritative. This affects `online`, `serverOnline`, `mcpPresent`, activity state, and delivery diagnostics.

### P0: Identity Boundary Drift

`API_TOKEN` currently means backend admin bearer, remote relay credential, and dashboard backend proxy credential. `AGENT_CHAT_SERVER` currently means backend local id, relay id, MCP auto-register id, and dashboard locality check. These overloads make profile behavior hard to reason about and hard to secure.

### P1: Package Drift

Remote package sync currently fails. The remote command surface is not guaranteed to match included files, and generated package path assumptions are not self-contained.

### P1: Operator Misuse

Commands such as `agentchat update`, `agentchat service`, `agent-up`, `agent-down`, `agent-ls`, and `check-mcp` do not clearly state whether they operate on central services, remote relay services, local tmux sessions, or backend registry records.

## Root Cause

The project already has a kernel/edge concept, but runtime host is not a first-class concept. Because of that, local and remote are expressed indirectly through path layout, service names, package directories, env defaults, and CLI fallbacks. A unified design should make runtime host explicit, then treat local and remote as deployment profiles of the same host adapter model.
