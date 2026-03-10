# Minimal Supervisor Waiting And Trailing-Heartbeat Design

## Scope
This batch is design only for the next minimal supervisor implementation slice after runtime-profile and inbox-gate closure.

It covers only:
- canonical `waiting_reason` and `waiting_until` usage on the primary task object
- supervisor trailing-heartbeat behavior after the primary agent goes idle
- derivation of `normal_wait`, `stalled_wait`, and `suspected_eos` from canonical task state plus time
- the minimum proof required for the follow-on implementation slice

Out of scope:
- implementation
- UI expansion
- hook expansion
- planner/task orchestration
- a second task source outside the canonical primary task object

## Current Accepted Baseline
The current accepted supervisor model already has:
- one canonical primary `task` object
- `status = active | waiting | blocked | done`
- `waiting_reason` and `waiting_until` on that canonical object
- configured `heartbeatTtlMs`, `trailingHeartbeatPeriods`, and `trailingWindowMs`
- derived supervisor classifications rather than free-form LLM review

The next slice should refine the waiting/trailing boundary only. It must not broaden the system into a planner or second task model.

## Canonical Waiting Declaration
Waiting remains a declaration on the primary task object only.

Canonical fields:
- `task.status = "waiting"`
- `task.waiting_reason`
- `task.waiting_until`
- `task.updated_at`
- `task.heartbeat_at`

Rules:
1. `waiting_reason` and `waiting_until` are valid only when `task.status = waiting`.
2. `waiting_reason` must be concrete and external-facing enough to explain why the agent is safely paused.
3. `waiting_until` is the owner-declared next check time or expiration time for that safe wait.
4. entering waiting must update both `updated_at` and `heartbeat_at`.
5. renewing waiting without changing the task id must refresh `heartbeat_at` and may refresh `waiting_until`.
6. `active`, `blocked`, and `done` must carry `waiting_reason = null` and `waiting_until = null`.

Why this remains canonical:
- safe waiting is an explicit owner declaration, not a supervisor inference from silence
- the supervisor reads the same primary task object already accepted in earlier slices
- there is still no second waiting source in docs, runtime notes, or supervisor-local files

## Waiting Semantics
The minimal supervisor should treat `waiting_reason` and `waiting_until` as a safe-wait contract, not just descriptive text.

Meaning of a valid waiting declaration:
- the owner has explicitly stated what it is waiting on
- the owner has stated the next time it expects to re-check or resume
- the owner has renewed heartbeat recently enough that the waiting declaration can still be trusted

This implies three distinct states:
1. valid declared waiting
2. expired declared waiting
3. malformed or stale waiting declaration

Only the first is `normal_wait`.

## Trailing-Heartbeat Behavior After Idle
The trailing window exists to bridge the gap between fresh active work and a later explicit safe-wait or terminal state.

Canonical timing inputs:
- `task.heartbeat_at`
- `heartbeatTtlMs`
- `trailingHeartbeatPeriods`
- `trailingWindowMs = heartbeatTtlMs * trailingHeartbeatPeriods`
- primary runtime idle signal (`runtime.activeNow`, `runtime.idleDurationSec`) as an observation only, not a second task source

Rule:
- when the primary agent stops appearing active, the supervisor does not immediately jump to EOS
- instead it keeps a bounded trailing window after the last trusted active heartbeat
- that window exists only to allow one of three canonical outcomes to land:
  - renewed `active` heartbeat
  - explicit `waiting` declaration
  - explicit `done`

During the trailing window:
- a fresh `active` heartbeat restores `active`
- a valid `waiting` declaration switches to `normal_wait`
- a `done` task enters the bounded completion tail already accepted in the earlier slice
- if nothing valid lands by the end of the window, classify `suspected_eos`

Important boundary:
- runtime idle observation can start the supervisor’s attention to the trailing window
- runtime idle observation must not create or mutate task state
- the canonical task object still decides whether the result is safe waiting or EOS suspicion

## Derivation Rules
The next implementation slice should make the waiting/trailing derivation explicit and minimal.

### `normal_wait`
Classify `normal_wait` only when all are true:
1. `task.status = waiting`
2. `task.waiting_reason` is present
3. `task.waiting_until` is valid and in the future
4. `task.heartbeat_at` is still within the trusted heartbeat window for the declaration

Reason string should come from the canonical declaration, for example:
- `Waiting on: <waiting_reason>`

### `stalled_wait`
Classify `stalled_wait` when the task explicitly says waiting, but the safe-wait contract has expired.

Minimum rule:
1. `task.status = waiting`
2. `waiting_reason` is present
3. `waiting_until` is valid but `waiting_until <= now`

Optional stronger rule for the implementation slice:
- also use `stalled_wait` when the waiting declaration is still present but the waiting heartbeat has gone stale past the trusted window, because the declaration is no longer actively maintained

Reason string should stay canonical and narrow, for example:
- `Waiting expired: <waiting_reason>`
- `Waiting heartbeat expired: <waiting_reason>`

### `suspected_eos`
Classify `suspected_eos` when the supervisor cannot trust any canonical state as a safe current execution state.

Minimum cases:
1. `task.status = active` but the active heartbeat plus trailing window has elapsed
2. `task.status = waiting` but `waiting_reason` or `waiting_until` is missing/invalid
3. no canonical task object exists
4. a previously active task has gone idle and no valid waiting or done state lands before trailing-window expiry

This keeps `suspected_eos` distinct from `stalled_wait`:
- `stalled_wait` means the owner declared waiting, but that wait expired or went stale
- `suspected_eos` means the supervisor lacks a trustworthy safe current state

## No Second Task Source
This slice must continue to avoid a second task source.

Specifically:
- runtime idle signals are observational inputs only
- supervisor-local state may remember previous classification and trailing deadlines, but it must not replace the primary task object
- docs, pane text, and workspace notes are not canonical waiting state
- the supervisor does not invent `waiting_reason` or `waiting_until`

Supervisor-local persistence is allowed only for:
- previous classification
- warning counters
- trailing deadline bookkeeping

It is not allowed for:
- synthetic task status
- synthetic waiting declarations
- a shadow task history that outranks the primary task object

## Minimum Proof For The Implementation Slice
A future implementation should prove all of the following against the real supervisor derivation path:

1. Valid waiting declaration:
- canonical task written with `status=waiting`, non-empty `waiting_reason`, future `waiting_until`, and fresh heartbeat
- supervisor derives `normal_wait`

2. Expired waiting declaration:
- same task with `waiting_until` moved into the past
- supervisor derives `stalled_wait`

3. Malformed waiting declaration:
- `status=waiting` but missing or invalid `waiting_reason` / `waiting_until`
- supervisor derives `suspected_eos`, not `normal_wait`

4. Trailing active-to-idle bridge:
- task starts `active` with a fresh heartbeat
- primary runtime becomes idle / active heartbeat stops
- within trailing window, supervisor does not immediately mark EOS
- after trailing window with no valid waiting or done, supervisor derives `suspected_eos`

5. Active-to-wait transition inside trailing window:
- task starts `active`
- heartbeat freshness expires but the system remains inside trailing window
- owner writes a valid waiting declaration before trailing expiry
- supervisor converges to `normal_wait` from the same canonical task object

6. No second task source:
- changing runtime idle observation alone must not create `normal_wait`
- only canonical task mutations can establish safe waiting

## Implementation Boundary
The later implementation slice should stay narrow:
- refine the existing supervisor derivation path in `supervisor/index.js`
- keep the canonical task writer model unchanged
- keep current route names stable
- avoid any new planner, queue, or orchestration layer

That is the smallest next slice that meaningfully closes the waiting/trailing ambiguity without reopening the larger supervisor architecture.
