# Minimal Supervisor Design

## Scope
This batch is design only for the first implementation slice of the minimal supervisor model. The slice is intentionally narrow:
- introduce a first-class `Task` object as supervisor-owned state
- classify supervisor outcomes from declared task state plus heartbeat timing
- make runtime-profile selection explicit for both primary-agent launch and supervisor launch
- preserve the current web/API surface wherever possible

Out of scope for this slice:
- UI redesign or new supervisor panels
- new hook or subconscious work
- free-form audit/review behavior
- multi-task scheduling or planner logic
- changing the current supervisor-control semantics

## Frozen Alignment
The accepted supervisor bible defines two first-class objects:
1. `Task`
2. `Supervisor Agent State`

The first implementation slice should keep that shape exactly. The supervisor should not infer workflow from loosely parsed docs or free-form summaries when a first-class task record can express the state directly.

## First-Class Task Object
The new canonical task record should be minimal:

```json
{
  "id": "string",
  "owner": "string",
  "status": "active | waiting | blocked | done",
  "updated_at": "ISO-8601 timestamp",
  "heartbeat_at": "ISO-8601 timestamp",
  "waiting_reason": "string | null",
  "waiting_until": "ISO-8601 timestamp | null"
}
```

Rules:
- `id` is stable for the active unit of work and changes when a materially new batch starts.
- `owner` is the primary agent name, not the supervisor.
- `updated_at` changes on any task-state mutation.
- `heartbeat_at` changes when the owner explicitly renews the task.
- `waiting_reason` and `waiting_until` are required when `status = waiting`.
- `waiting_reason` and `waiting_until` must be `null` for `active`, `blocked`, and `done`.

Canonical writer for the first slice:
- the agent control-plane state that already owns launch metadata and agent identity should also own the task record for that agent

Canonical readers for the first slice:
- backend supervisor status derivation
- backend per-agent supervisor detail
- supervisor runtime process when deciding whether to stay active, warn, or idle

## Minimal Task States
The state machine stays exactly:
1. `active`
2. `waiting`
3. `blocked`
4. `done`

State meanings:
- `active`: owner is actively pushing the batch forward and is expected to renew heartbeat
- `waiting`: owner is intentionally paused on an external dependency and has declared why and until when
- `blocked`: owner cannot proceed without a concrete external change or decision; this is not safe waiting
- `done`: the scoped batch is complete

Non-goals:
- no `paused`, `review`, `idle`, `drifted`, or other intermediate task states
- `normal_wait`, `stalled_wait`, and `suspected_eos` are supervisor classifications, not task statuses

## Heartbeat and Supervisor Classification
The supervisor should classify from task state plus timing only.

### Heartbeat Modes
There are two heartbeat modes:
1. active heartbeat
2. waiting heartbeat

Rules:
- `active` requires heartbeat renewal within the configured heartbeat TTL
- `waiting` requires both heartbeat renewal and valid `waiting_reason` + `waiting_until`
- `blocked` and `done` do not become safe waiting by silence alone

### Derived Supervisor Outcomes
The first slice should derive only these outcomes:
- `active`
- `normal_wait`
- `stalled_wait`
- `suspected_eos`

Derivation rules:
1. If `task.status = active` and `heartbeat_at` is fresh, classify `active`.
2. If `task.status = active` and heartbeat expires, classify `suspected_eos`.
3. If `task.status = waiting` and `waiting_reason` is present and `waiting_until` is in the future, classify `normal_wait`.
4. If `task.status = waiting` and `waiting_until` has expired, classify `stalled_wait`.
5. If `task.status = waiting` but waiting metadata is missing or invalid, classify `suspected_eos` rather than safe waiting.
6. If `task.status = blocked`, expose `blocked` in task state but supervisor runtime should treat it as work requiring attention, not as safe waiting.
7. If `task.status = done`, the task is terminal and should not keep the supervisor active beyond the trailing window.

## Trailing-Heartbeat Window
The supervisor should remain active for a short bounded trailing window after the owner stops appearing active.

First-slice rule:
- supervisor stays active for `N` heartbeat periods after the primary agent stops renewing an active heartbeat
- recommended initial value: `N = 5`

Purpose:
- avoid immediately classifying a brief pause as EOS
- allow a valid `waiting` declaration to land before the supervisor stands down
- keep the rule explicit and time-based rather than heuristic

During the trailing window:
1. if a fresh `active` heartbeat arrives, remain `active`
2. if a valid `waiting` declaration arrives, switch to `normal_wait`
3. if the task becomes `done`, allow the supervisor to go idle after the remaining bounded window
4. if no valid state arrives, classify `suspected_eos`

This preserves the accepted distinction:
- silence is not evidence of safe waiting
- safe waiting must be declared by the owner

## Runtime Profile Direction
Runtime selection should become explicit per agent instead of being inherited from shared mutable defaults.

### Required Profile Fields
A runtime profile should capture:
- framework/runtime type
- backend/provider
- model handle
- reasoning budget or cost profile
- optional supervisor-specific overrides

Minimal example:

```json
{
  "primary": {
    "framework": "codex",
    "provider": "openai",
    "model": "gpt-5.3-codex-spark",
    "reasoning": "default"
  },
  "supervisor": {
    "framework": "codex",
    "provider": "openai",
    "model": "gpt-5.3-codex-spark",
    "reasoning": "low"
  }
}
```

### Launch Direction
For the first implementation slice:
- `agent-up` should read a per-agent runtime profile from the agent control-plane state instead of only `model` and `extraArgs`
- supervisor launch should read the same per-agent control-plane record and apply the optional supervisor override if present
- if the supervisor override is absent, it may inherit the primary profile in a documented way

Backward-compatible boundary for the first slice:
- existing `model` and `extraArgs` fields can remain as compatibility inputs until runtime-profile writes are productized
- the new profile should become the preferred canonical source for new launches

## Existing Routes And State That Can Stay Untouched In Slice 1
The first supervisor slice does not require a web-surface expansion. These existing routes can stay in place and keep their current path names:
- `GET /api/supervisor/status`
- `GET /api/supervisor/agents`
- `GET /api/supervisor/agents/:name`
- `GET /api/supervisor/control`
- `POST /api/supervisor/control`
- the matching web proxy routes in `server.js`

These semantics can also stay untouched in slice 1:
- supervisor audit enable/disable remains stack-global, not agent-scoped
- current Agent Detail layout does not need new supervisor UI sections
- existing subconscious routes and state stay unrelated to this batch
- existing worker/progress docs remain informative, but they stop being the primary truth source for supervisor lifecycle classification once `Task` exists

State that should remain compatible rather than be migrated broadly in slice 1:
- current agent launch metadata fields such as `model` and `extraArgs`
- current agent identity/home metadata files
- current supervisor control persistence

## First Implementation Slice Boundary
The smallest useful implementation after this design is:
1. add canonical per-agent `Task` storage in the control-plane state
2. teach backend supervisor derivation to read that task object and classify `active / normal_wait / stalled_wait / suspected_eos`
3. add trailing-window handling in the supervisor runtime
4. add per-agent runtime-profile reads for primary launch and supervisor launch, with compatibility fallback to existing `model` and `extraArgs`
5. keep current routes and UI paths stable

Not part of the first slice:
- creating a generic task-management UI
- multi-task history or queueing
- replacing all legacy launch metadata immediately
- changing hook paths or subconscious detail contracts

## Acceptance Target For Implementation
The implementation slice should be considered complete only if all of these are true:
- the supervisor classification is driven by the first-class `Task` object, not inferred waiting heuristics
- `waiting` requires both `waiting_reason` and `waiting_until`
- trailing-window behavior is explicit and bounded
- runtime-profile selection is read from per-agent control-plane state for both primary and supervisor launch
- existing supervisor API route names remain stable
- current stack-global supervisor control semantics remain explicit
