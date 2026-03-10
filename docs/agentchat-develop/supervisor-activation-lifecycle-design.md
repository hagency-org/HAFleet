# Supervisor Activation And Lifecycle Design

## Scope
This batch is design only for the next narrow minimal-supervisor slice.

It covers only:
- when the supervisor runtime is considered active vs idle relative to the primary agent
- the bounded trailing supervision window after primary idle using the accepted trailing-heartbeat model
- how the sibling `supervisor/` workspace participates without becoming a second task source
- how canonical `runtimeProfile.supervisor` is selected for launch/lifecycle
- the minimum proof required for the implementation slice

Out of scope:
- implementation
- UI expansion
- hook expansion
- orchestration/planning
- any second canonical task or runtime-profile source

## Current Accepted Baseline
The accepted supervisor model already fixes these pieces:
- canonical task state lives only on the primary control-plane object
- supervisor classifications derive from canonical task state plus time
- valid waiting is a maintained owner declaration, not a supervisor inference
- a sibling `supervisor/` workspace exists for supervisor-local notes only
- `runtimeProfile.supervisor` is the canonical supervisor-launch role when present

This note defines only the supervisor runtime lifecycle around those accepted objects.

## Activation Model
The supervisor runtime is an agent-shaped sibling process relative to one primary agent. It is not a second planner or a second task owner.

For this slice, the lifecycle stays binary:
- `active`
- `idle`

`trailing` is not a third canonical lifecycle state. It is a bounded active sub-phase inside the accepted trailing-heartbeat window.

## When Supervisor Runtime Is Active
The supervisor runtime should be considered `active` when any of the following are true for the primary agent:

1. Canonical task is `active`
- the primary task is live and being heartbeated
- the supervisor remains active because the primary batch is live

2. Canonical task is `blocked`
- blocked is not safe waiting
- the supervisor remains active because attention is still required

3. Supervisor classification is negative
- `stalled_wait`
- `suspected_eos`
- the supervisor remains active because it still has a live attention state to surface or monitor

4. Primary task has just gone idle but is still inside the bounded trailing-heartbeat window
- this is the accepted bridge from active work to a later explicit waiting/done state
- the supervisor remains active during that bounded trailing phase

5. Canonical task is `done` but still inside the bounded completion tail already accepted in the minimal model
- this allows a short closure window before the supervisor stands down

## When Supervisor Runtime Is Idle
The supervisor runtime should be considered `idle` only when supervision no longer has live work to perform.

That is true when any of the following hold:

1. Canonical task is a valid `normal_wait`
- `task.status = waiting`
- valid future `waiting_until`
- fresh waiting heartbeat
- no negative supervisor condition is present

2. Canonical task is `done` and the bounded trailing completion window has elapsed

3. No canonical task exists and there is no unresolved negative supervisor state to monitor

Important boundary:
- `idle` here means the supervisor runtime no longer needs to stay live for immediate supervision work
- it does not mean the sibling workspace disappears or becomes canonical task state

## Bounded Trailing Supervision Window
The supervisor activation lifecycle must reuse the accepted trailing-heartbeat model instead of introducing a new scheduler concept.

Canonical timing inputs:
- `task.heartbeat_at`
- `heartbeatTtlMs`
- `trailingHeartbeatPeriods`
- `trailingWindowMs`
- runtime idle observation from the primary process (`runtime.activeNow`, `runtime.idleDurationSec`) only as a trigger/input to supervision attention

Rule:
- after the primary agent stops appearing active, the supervisor stays `active` through the bounded trailing window
- that trailing window is the only grace period before the lifecycle must converge to one of the canonical outcomes:
  - renewed `active`
  - valid `normal_wait`
  - `done`
  - unresolved negative state (`suspected_eos` / `stalled_wait`)

Lifecycle outcomes after primary idle:
1. primary resumes active heartbeat before trailing expiry
- supervisor remains `active`

2. primary writes valid waiting before trailing expiry
- supervisor may transition to `idle` because supervision is now safely parked in `normal_wait`

3. primary writes `done` before trailing expiry
- supervisor remains `active` only through the bounded completion tail, then becomes `idle`

4. no valid state arrives by trailing expiry
- supervisor remains `active`, but now because the classification is negative (`suspected_eos`), not because the trailing bridge continues forever

This keeps the boundary explicit:
- trailing window is bounded
- safe waiting must still be declared canonically
- unresolved negative states do not silently idle out

## Sibling `supervisor/` Workspace Participation
The sibling `supervisor/` workspace participates as the local workspace for the supervisor runtime, not as a second source of primary truth.

Allowed roles for `supervisor/`:
- hold supervisor-local `CLAUDE.md`, `AGENTS.md`, `docs/plan.md`, and `docs/progress.md`
- hold supervisor-local notes about activation, warnings, and previous observations
- serve as the cwd/home context if a real supervisor runtime is launched as a sibling process

Not allowed in `supervisor/`:
- second canonical `task` file
- second canonical `runtimeProfile` file
- shadow `waiting_reason` / `waiting_until`
- hidden queue/planner state that outranks the primary task object

Activation implication:
- when supervisor runtime is `idle`, the sibling workspace still exists but its local docs remain informational only
- when supervisor runtime is `active`, the sibling workspace is the correct local workspace for that process, but the process still reads canonical task/runtimeProfile from the shared control-plane object

## Canonical `runtimeProfile.supervisor` Selection
Supervisor launch/lifecycle must continue to read the same canonical object already accepted for runtime-profile handling.

Selection order:
1. canonical `runtimeProfile.supervisor`
2. documented fallback to canonical `runtimeProfile.primary` only when the supervisor role is absent
3. launcher/process defaults only when neither canonical role object exists

Implications for lifecycle:
- activation does not create a new runtime-profile file in `supervisor/`
- waking an idle supervisor uses the same selected canonical supervisor profile
- resuming an already active supervisor does not rewrite canonical runtime-profile state
- the sibling workspace may document the selected profile, but it must not originate it

Role expectations:
- `runtimeProfile.supervisor` is the correct place to choose supervisor-specific framework/provider/model/reasoning/extraArgs
- if absent, inheritance from `runtimeProfile.primary` is a compatibility fallback, not a second profile family

## Minimum Proof For The Implementation Slice
A future implementation should prove all of the following:

1. Active primary task keeps supervisor runtime active
- canonical active task with fresh heartbeat
- supervisor lifecycle reports `active`

2. Valid normal wait idles supervisor runtime
- canonical waiting task with valid future `waiting_until` and fresh waiting heartbeat
- supervisor classification is `normal_wait`
- supervisor lifecycle transitions to `idle`

3. Primary idle enters bounded trailing supervision
- primary runtime goes idle while canonical task was active
- supervisor lifecycle stays `active` during the accepted trailing-heartbeat window
- reason/state makes clear this is trailing supervision, not safe waiting

4. Trailing expiry with no valid waiting/done does not silently idle
- trailing window expires without canonical waiting or done
- supervisor classification becomes negative (`suspected_eos` or `stalled_wait` as appropriate)
- supervisor lifecycle remains `active`

5. Done eventually idles supervisor
- canonical task becomes `done`
- supervisor remains active only through the bounded completion tail
- then lifecycle becomes `idle`

6. Sibling workspace does not become a second truth source
- supervisor runtime may read/run from `supervisor/`
- but canonical task/runtimeProfile continue to come from the shared control-plane object
- no `supervisor/task.json` or supervisor-local runtime-profile file appears

7. Canonical supervisor runtime-profile selection is stable
- with `runtimeProfile.supervisor`, launch/lifecycle uses that role
- without it, fallback uses canonical primary role
- no supervisor-local file or ad-hoc env source outranks the canonical control-plane object

## Implementation Boundary
The later implementation slice should stay narrow:
- add or refine only the supervisor runtime activation/lifecycle logic
- reuse the existing canonical task derivation and waiting/trailing rules
- reuse the existing sibling `supervisor/` workspace contract
- reuse the existing canonical runtime-profile selection rules
- avoid any planner, queue, or orchestration layer

That is the smallest next slice that makes the supervisor truly agent-shaped in lifecycle terms without reopening the larger architecture.
