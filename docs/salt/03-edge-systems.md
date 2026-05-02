# 03 Edge Systems

Date: 2026-05-02

## Dashboard And Queue

Files:

- `server.js`

Role:

- Web dashboard.
- Tmux capture and display.
- Message queue and idle delivery surface.
- Reminder and operator UI.
- Backend SSE consumer for dashboard events.

Boundary:

- Dashboard is an edge/operator surface.
- It may observe backend state and trigger operator actions.
- It must not become a second backend or unauthenticated privileged proxy.

Current risk:

- Dashboard calls backend with `API_TOKEN`. RLP3-B1 gates mutating dashboard `/api/*` surfaces to loopback callers or `AGENT_CHAT_DASHBOARD_TOKEN`, but there is still no full browser login/session model.
- Queue/tmux injection needs stronger caller and target validation if dashboard is ever exposed beyond one trusted local user.

## Task And Task Graph

Files:

- `lib/task-store.js`
- `lib/task-graph.js`
- task routes in `backend-v2.js`
- `scripts/write-v1-agent-task.js`
- `scripts/write-v1-agent-runtime-profile.js`

Boundary:

- Tasks describe commitments and workflow state.
- They should not define agent identity or inbox memory.

Current risk:

- Task state exists in multiple places: agent record fields, task store, and task graph nodes.
- Task graph result hooks need sender/dispatch validation.

## Alerts And Notification Router

Files:

- `lib/alert-store.js`
- `lib/notification-router.js`
- alert routes in `backend-v2.js`

Boundary:

- Alerts are operational tickets derived from kernel/runtime signals.
- They should not hide kernel facts.

Current risk:

- Notification aggregation cooldown can be persisted before flush, making a crash look like a delivered notification.

## Supervisor

Files:

- `lib/supervisor-action-engine.js`
- `lib/supervisor-lifecycle-manager.js`
- `lib/supervisor-provisioning.js`
- `lib/supervisor-snapshot-store.js`
- supervisor routes in `backend-v2.js`
- `scripts/write-supervisor-state.js`
- `scripts/supervisor-parity-check.js`

Boundary:

- Supervisor is an edge attention/audit system.
- Snapshot state can be kernel-facing data.
- Lifecycle and tmux control side effects should not be default backend behavior.

Current risks:

- Backend imports and initializes Supervisor lifecycle behavior.
- Supervisor escalation target is hard-coded.
- Supervisor state CLI wording implies a registration path it does not implement.

## Subconscious

Files:

- `lib/upstream-claude-subconscious.js`
- `subconscious/claude-agentchat/*`
- subconscious routes in `backend-v2.js`

Boundary:

- Subconscious is optional Claude-specific memory/event integration.
- It can enrich agent memory, but must not bypass per-agent write boundaries.

Current risk:

- Event ingest has token/local checks, but upstream/runtime endpoints do not consistently apply equivalent per-agent auth.

## Remote Package

Files:

- `remote/*`
- `remote-dist/*`
- `scripts/build-remote-package.sh`
- `scripts/check-remote-sync.sh`

Boundary:

- Remote package is deployment artifact/support.
- It should be generated or strictly checked from root source.

Current risk:

- Remote sync checks fail, so remote behavior is not reproducibly tied to root code.
