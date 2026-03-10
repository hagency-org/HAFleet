# Task Writer And Workspace Design

## Scope
This batch is design only for the next minimal supervisor slice.

It covers only:
- canonical writer paths for `task`
- sibling `supervisor/` workspace shape beside the primary agent workspace
- canonical `runtimeProfile` schema usage and launcher read paths
- keeping existing supervisor route names stable

Out of scope:
- implementation
- UI expansion
- hook expansion
- multi-task/planner systems
- route renaming

## Canonical Task Writers
The accepted `task` object is:

```json
{
  "id": "string",
  "owner": "string",
  "status": "active | waiting | blocked | done",
  "updated_at": "ISO-8601",
  "heartbeat_at": "ISO-8601",
  "waiting_reason": "string | null",
  "waiting_until": "ISO-8601 | null"
}
```

The next slice should keep one writer model:
- the primary agent control-plane is the canonical writer
- the supervisor is a canonical reader and classifier only
- the supervisor must not originate or mutate `task` state on behalf of the primary agent

### Who Writes `task.id`
Canonical writer:
- the primary agent-side task writer in the workspace/control-plane path

Rule:
- a new `task.id` is written only when a materially new batch starts
- changing heartbeat or waiting metadata must not rotate `task.id`
- the supervisor never rewrites `task.id`

### Who Refreshes `heartbeat_at`
Canonical writer:
- the primary agent-side task writer

Rule:
- `heartbeat_at` is refreshed by the owner while the batch is still live
- it is refreshed both for active work and declared waiting
- the supervisor only reads it to classify `active`, `normal_wait`, `stalled_wait`, or `suspected_eos`

### Who Sets `waiting_reason` And `waiting_until`
Canonical writer:
- the primary agent-side task writer

Rule:
- only the owner can declare safe waiting
- `waiting_reason` and `waiting_until` are required together when `status = waiting`
- the supervisor must never infer them from silence, docs text, or queue state

### Who Marks `done`
Canonical writer:
- the primary agent-side task writer

Rule:
- `done` is set when the owner has actually closed the scoped batch
- `updated_at` and `heartbeat_at` advance when `done` is written
- the supervisor reads `done` and only applies the bounded trailing window before going idle

## Canonical Writer Paths
Two writer paths should remain canonical, matching the current accepted control-plane split.

### Live Backend-Control Plane
Canonical writer:
- `backend-v2.js`
- `POST /api/agents`
- `PATCH /api/agents/:name`

Canonical persisted state:
- runtime `data/agents.json`

Use:
- remote/local agent registration
- non-v1 or live runtime state updates
- supervisor runtime reads

### V1 Home-Control Plane
Canonical writer:
- `server.js`
- `PATCH /api/agents/:name/home-metadata`

Canonical persisted state:
- v1 manifest `agent.json`

Compatibility mirror:
- `data/agents/<name>/meta.json`

Rule:
- `agent.json` remains the canonical home-owned task/runtimeProfile file
- `meta.json` stays a compatibility mirror and must not outrank `agent.json`
- sync to backend state remains required so supervisor routes read the same task/runtimeProfile values

## Task Writer Inside The Workspace
The next slice should make the task writer explicit in the primary workspace instead of leaving task mutation as an implicit API-only concern.

Minimal design direction:
- the primary workspace gets an explicit task-writing surface under its own root contract
- that writer updates the canonical control-plane object, not a second hidden task file
- workspace docs may describe the active task, but docs are not canonical task state once the writer exists

Recommended minimal shape:
- root workspace entry files continue to bootstrap the agent
- the agent writes task transitions through one local task-writer command/script or one thin agent-owned write path
- that writer calls the existing control-plane route or writes the canonical manifest path that already feeds the route sync

Non-goal:
- do not create a parallel `task.json` in both the primary workspace and supervisor workspace

## Sibling `supervisor/` Workspace Shape
The accepted supervisor bible already fixes the shape: a sibling `supervisor/` directory beside the primary agent workspace.

Minimal workspace contract:
- `supervisor/CLAUDE.md`
- `supervisor/AGENTS.md`
- `supervisor/docs/plan.md`
- `supervisor/docs/progress.md`

Purpose:
- make the supervisor explicit as an agent-shaped state machine
- keep supervisor local notes, warnings, and runtime bootstrap separate from the primary workspace
- avoid ambient/hidden reviewer behavior

### No Second Hidden State Model
To avoid divergence:
- `supervisor/` must not own a second canonical `Task` file
- `supervisor/` must not maintain a second canonical runtime-profile file
- `supervisor/` may keep its own plan/progress about supervisor operations, but primary task truth still lives in the shared control-plane object
- `supervisor/` reads the primary agent's canonical `task` and `runtimeProfile`; it does not shadow them

This preserves one model:
- primary workspace owns task mutations
- supervisor workspace owns supervisor-local process state only

## Canonical `runtimeProfile` Schema Usage
Accepted canonical schema stays string-based per role:

```json
{
  "primary": {
    "framework": "string | null",
    "provider": "string | null",
    "model": "string | null",
    "reasoning": "string | null",
    "extraArgs": "string | null"
  },
  "supervisor": {
    "framework": "string | null",
    "provider": "string | null",
    "model": "string | null",
    "reasoning": "string | null",
    "extraArgs": "string | null"
  }
}
```

Rules:
- `reasoning` is the canonical field name
- `reasoningProfile` is not canonical
- `extraArgs` stays a single string, not an array
- `primary` and `supervisor` are role keys, not multiple unrelated profile families

## Launcher Read Paths
Primary launch reader:
- `bin/agent-up`
- reads `runtimeProfile.primary.framework/model/extraArgs`
- falls back to legacy `type/model/extraArgs` only when `runtimeProfile.primary` is absent

Supervisor launch reader:
- `bin/agent-up` exports supervisor-compatible env from `runtimeProfile.supervisor`
- `supervisor/config.js` reads that supervisor role config from env

Direction for the next slice:
- keep this read path
- make the writer/workspace side responsible for updating the same canonical `runtimeProfile` object
- do not introduce a second supervisor-only runtime-profile file under `supervisor/`

## Stable Route Surface
The next slice should keep the current supervisor route names unchanged:
- `GET /api/supervisor/status`
- `GET /api/supervisor/agents`
- `GET /api/supervisor/agents/:name`
- `GET /api/supervisor/control`
- `POST /api/supervisor/control`

Reason:
- the next slice is about writer ownership and workspace shape, not transport changes
- the control-plane object can improve behind the existing route surface

## Minimal Implementation Boundary After This Design
The smallest useful follow-on implementation should be:
1. add an explicit primary-workspace task writer path
2. make that writer the only owner of task transitions (`id`, heartbeat, waiting, done)
3. introduce the sibling `supervisor/` workspace contract without creating a second task/runtimeProfile truth source
4. keep supervisor routes stable and keep supervisor as a reader/classifier of the existing control-plane object
