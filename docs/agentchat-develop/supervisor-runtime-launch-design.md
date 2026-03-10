# Supervisor Runtime-Launch Design

## Scope
This batch is design only for the first real supervisor runtime-launch slice.

It covers only:
- how and when a real sibling supervisor runtime is launched from the accepted supervisor activation/lifecycle state
- how the sibling `supervisor/` workspace is used as cwd/home without becoming a second truth source
- how canonical `runtimeProfile.supervisor` drives framework/provider/model/args for that runtime launch
- how supervisor start / keep-alive / idle / stop decisions map onto the accepted lifecycle state machine
- the minimum proof required for the later implementation slice

Out of scope:
- implementation
- UI expansion
- hook expansion
- planner / queue / orchestration work
- new task sources
- new runtime-profile files under `workdir/` or `supervisor/`

## Current Accepted Baseline
The accepted supervisor model already establishes these truths:
- canonical task state lives only on the primary control-plane object
- supervisor classification derives from the canonical task object and time
- lifecycle is binary: `active` or `idle`
- bounded trailing supervision is an active sub-phase, not a third lifecycle state
- valid `normal_wait` is the main idle handoff
- unresolved negative states (`stalled_wait`, `suspected_eos`) remain lifecycle-`active`
- no-task idle is coherent only when there is no canonical task and no unresolved negative state
- the sibling `supervisor/` workspace exists for supervisor-local docs/context only
- canonical runtime-profile selection order is already accepted:
  1. `runtimeProfile.supervisor`
  2. `runtimeProfile.primary` fallback
  3. env/default

This note defines only how a real launched supervisor runtime should follow those accepted truths.

## First-Class Launch Object
The real supervisor runtime-launch slice should treat the launched supervisor process as a projection of canonical state, not a new state source.

For this slice, the launch-relevant object is:
- `task`
- derived `classification`
- derived `lifecycle`
- selected `runtimeProfile.supervisor` role (or accepted fallback)
- sibling workspace path `../supervisor/`

The launched runtime does not own or originate:
- `task.id`
- `task.status`
- `waiting_reason`
- `waiting_until`
- canonical runtime-profile content

It only consumes them to decide whether it should exist and how it should be started.

## Launch Decision Boundary
A real sibling supervisor runtime should exist only when lifecycle is `active`.

That means launch or keep running when any of the following are true:
1. canonical task is `active` with fresh or trailing-valid supervision state
2. canonical task is `blocked`
3. classification is negative (`stalled_wait` or `suspected_eos`)
4. canonical task is `done` but still inside the bounded completion tail

A real sibling supervisor runtime should be absent or allowed to stop when lifecycle is `idle`.

That means do not launch, or stop after a clean handoff, when either of the following is true:
1. canonical task is valid `normal_wait`
2. canonical task is absent and there is no unresolved negative state
3. canonical task is `done` and the bounded completion tail has elapsed

Important boundary:
- launch is driven by lifecycle, not by raw runtime idle/activity observations alone
- runtime idle/activity can still help derive lifecycle, but must not become an independent launch truth source

## Start / Keep-Alive / Stop Mapping
The minimum launch state machine should stay aligned with the accepted lifecycle model.

### 1. Start
If lifecycle transitions from `idle` to `active`, the system may start a real sibling supervisor runtime.

Allowed causes:
- new active task
- blocked task
- trailing supervision window entered from a recently active task
- negative state surfaced (`stalled_wait` / `suspected_eos`)
- done-tail still active

Start semantics:
- the launched process uses the sibling `supervisor/` workspace as cwd/home
- the process reads canonical task/runtime-profile state from the shared control-plane object, not from local workspace files
- start should be idempotent: if a supervisor runtime is already live for that agent, a second one must not be created

### 2. Keep-Alive
If lifecycle remains `active`, the existing supervisor runtime stays live.

Examples:
- active task continues heartbeating
- trailing supervision window has not expired yet
- negative state remains unresolved
- blocked task still requires attention

Keep-alive semantics:
- do not relaunch just because classification reason text changed
- do not treat the sibling workspace as a new state writer
- do not rewrite canonical runtime profile during keep-alive

### 3. Idle Hold
If lifecycle becomes `idle`, the supervisor runtime no longer has immediate work.

Examples:
- valid `normal_wait`
- no task and no unresolved negative state
- done after bounded tail elapsed

Idle semantics:
- the sibling `supervisor/` workspace still exists as a durable local context
- the runtime may either be absent or stopped cleanly
- idle is not itself an error or a missing-runtime condition

### 4. Stop
A live supervisor runtime may be stopped only after lifecycle resolves to `idle`.

Stop causes:
- valid `normal_wait` established
- done-tail elapsed
- no-task clean idle state
- explicit supervisor global disable control, if that existing control remains in force

Stop boundary:
- stop must not rewrite canonical `task` or `runtimeProfile`
- stop must not delete or mutate the sibling `supervisor/` workspace
- stop must not be treated as clearing a negative condition; only lifecycle resolution may justify stop

## Sibling `supervisor/` Workspace Contract During Launch
The sibling `supervisor/` workspace is the correct cwd/home for the launched supervisor runtime, but it remains coordination-only.

Allowed runtime uses of `supervisor/`:
- cwd/home for the launched process
- supervisor-local `CLAUDE.md`, `AGENTS.md`, `docs/plan.md`, `docs/progress.md`
- supervisor-local temporary notes or logs that do not outrank canonical control-plane state

Forbidden uses of `supervisor/`:
- `task.json`
- `runtime-profile.json`
- shadow `waiting_reason` / `waiting_until`
- launch-decision flags that outrank derived lifecycle
- any file that becomes a second canonical source for whether the supervisor should exist

Truth boundary:
- the sibling workspace is runtime-local context only
- the shared control-plane object remains the only source of primary task/runtime-profile truth

## Canonical Runtime-Profile Selection For Launch
The real runtime-launch slice should keep the already-accepted selection order exactly.

Selection order:
1. `runtimeProfile.supervisor`
2. `runtimeProfile.primary` fallback
3. env/default

Fields consumed for launch:
- `framework`
- `provider`
- `model`
- `reasoning`
- `extraArgs`

Launch implications:
- the selected role determines the actual supervisor runtime invocation shape
- the sibling `supervisor/` workspace may document the selected role, but must not originate or persist it as a second file
- lifecycle changes do not themselves mutate the selected runtime profile

Compatibility boundary:
- fallback to `runtimeProfile.primary` is compatibility only when the supervisor role is absent
- env/default is last resort only when neither canonical role object exists

## Relationship To Existing Supervisor Controls
The existing supervisor route names and stack-global control semantics can stay untouched in the implementation slice.

This launch note does not require:
- route renames
- per-agent supervisor control surfaces
- UI additions

The first launch slice may continue using the existing global supervisor enable/disable control as a top-level gate above lifecycle-driven launch decisions.

Interpretation order should be:
1. global supervisor disabled -> no launch regardless of lifecycle
2. global supervisor enabled + lifecycle `active` -> launch or keep runtime alive
3. global supervisor enabled + lifecycle `idle` -> runtime may remain absent or stop cleanly

## Failure And Truthfulness Boundaries
The implementation slice must keep failure semantics explicit.

If lifecycle says `active` but launch fails:
- lifecycle remains `active`
- the failure is a runtime-launch failure, not a lifecycle rewrite
- canonical task/runtime-profile state must remain unchanged

If lifecycle says `idle` and no runtime exists:
- that is truthful and healthy
- it must not be surfaced as a missing-runtime failure

If launch profile fallback is used:
- the selected source must stay visible (`runtimeProfile.supervisor`, `runtimeProfile.primary-fallback`, or `env/default`)
- the fallback must not be silently persisted back as supervisor-owned canonical data

## Minimum Proof For The Implementation Slice
A later implementation should prove all of the following and no more.

1. Lifecycle-`active` starts a real sibling supervisor runtime
- lifecycle transitions from `idle` to `active`
- exactly one supervisor runtime is started
- runtime uses the sibling `supervisor/` workspace as cwd/home

2. Lifecycle-`active` keep-alive is idempotent
- repeated active sweeps do not spawn a second runtime
- classification/lifecycle updates can continue without relaunch churn

3. Valid `normal_wait` stops or suppresses runtime launch
- lifecycle becomes `idle`
- supervisor runtime is absent or stops cleanly
- no canonical task/runtime-profile data is rewritten during stop

4. Negative state keeps runtime alive
- `stalled_wait` or `suspected_eos` leaves lifecycle `active`
- an already-running supervisor runtime stays live
- the reason remains a negative-state reason, not a stale active-task reason

5. No-task clean idle does not launch
- no canonical task and no unresolved negative state
- lifecycle `idle`
- no supervisor runtime is launched
- no missing-runtime error is emitted

6. Sibling workspace remains non-canonical
- launched runtime uses `../supervisor/` as cwd/home
- no `supervisor/task.json` or supervisor-local runtime-profile file appears
- canonical task/runtime-profile still come from the shared control-plane object

7. Canonical runtime-profile launch selection is stable
- with `runtimeProfile.supervisor`, launch uses that role
- without it, launch falls back to `runtimeProfile.primary`
- without either, launch falls back to env/default
- no local workspace file outranks the canonical control-plane object

## Implementation Boundary
The later implementation slice should stay narrow:
- launch/stop a real sibling supervisor runtime based on accepted lifecycle
- reuse the existing sibling `supervisor/` workspace contract
- reuse the accepted canonical runtime-profile selection order
- avoid new planner, queue, orchestration, UI, or hook behavior

That is the smallest slice that makes supervisor runtime existence truthful without reopening the larger architecture.
