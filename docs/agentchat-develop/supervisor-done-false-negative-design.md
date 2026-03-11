# Supervisor Done-Task False Negative Design

## Scope
Design only for the supervisor `done`-task false negative / negative-streak accumulation issue.

In scope:
- completed-task behavior after the bounded trailing window
- alignment between classification, lifecycle, and negative-streak accounting
- smallest correction that prevents completed work from accumulating unresolved negative debt once lifecycle is idle
- proof strategy and blast-radius analysis

Out of scope:
- sweep fairness changes
- dead-flag enforcement
- UI/routes
- subconscious or Matrix/bridge work

## Current Problem
Today the relevant flow is:
- `deriveObservation()` can set `classification = 'suspected_eos'` for `task.status === 'done'` after the bounded trailing window elapses
- `deriveLifecycle()` returns `state = 'idle'` for the same finished task once that trailing window has elapsed
- `SupervisorStateStore.applyJudgment()` increments negative streaks from `judgment.status` alone via `isNegative(status)`

That creates a contradiction:
- lifecycle says supervision is finished and idle
- status still says unresolved negative supervision state
- negative debt and warnings can continue to build on completed work

## Root Cause
The system currently uses one status axis for two different meanings:
- whether the task is unfinished and needs supervision attention
- whether the last heartbeat/waiting declaration was imperfect

For completed tasks after the accepted trailing window, those meanings must separate. Once lifecycle is legitimately idle because the task is done, the supervisor should not keep emitting unresolved-negative semantics for that same completion state.

## Design Goal
Preserve the accepted lifecycle model and trailing-window behavior, while making completed work stop accumulating negative supervisor debt once lifecycle has transitioned to idle.

The smallest acceptable outcome is:
- finished tasks remain `active` during the bounded completion tail
- after that tail, they no longer count as unresolved negative supervision state
- negative streaks and warnings do not continue to accumulate for an already-idle completed task

## Smallest Correction Model
Introduce a terminal non-negative classification for completed work after the trailing window.

Recommended classification:
- `done`

### Resulting behavior
- `task.status === 'done'` and trailing window still active:
  - classification remains `active`
  - lifecycle remains `active`
- `task.status === 'done'` and trailing window elapsed:
  - classification becomes `done`
  - lifecycle remains `idle`
  - negative streak accounting treats `done` as non-negative

## Why This Is Smaller Than Other Options
This is smaller than modifying warning logic or state-store special cases because:
- the contradiction starts in observation derivation
- `classification` is the canonical supervisor summary surfaced elsewhere
- a non-negative terminal classification keeps lifecycle, status, and state-store accounting aligned without adding ad hoc exceptions in later layers

## Canonical Boundary
The correction should begin in `deriveObservation()`.

Reasoning:
- `deriveObservation()` already owns the mapping from canonical task state into supervisor classification
- `deriveLifecycle()` should continue consuming that classification plus task state, not override accounting defects later
- `SupervisorStateStore.applyJudgment()` should stay generic and continue treating only explicitly negative classifications as negative

## Preserved Semantics
This design preserves:
- accepted trailing completion window
- accepted lifecycle rules
- accepted route names
- current task control-plane schema
- current fairness slice

Only the post-trailing classification for finished work changes.

## Event / API Surface Impact
This is a narrow semantic change, not a route-shape expansion.

Expected surface effect:
- supervisor event/status payloads may now show `classification = done` for completed work after the trailing window

That is acceptable because it is a truthful terminal state and does not require new route fields.

## Proof Strategy
A later implementation should prove all of these:

1. Done inside trailing window
- `task.status = done` inside the bounded tail remains `classification = active`, `lifecycle = active`

2. Done after trailing window
- `task.status = done` after the bounded tail becomes `classification = done`, `lifecycle = idle`

3. Negative streak stop
- once classification becomes `done`, `applyJudgment()` does not increase `consecutiveNegative`

4. Warning suppression for completed idle work
- completed idle work does not continue generating unresolved warning debt

5. No regression for real negative states
- `stalled_wait` and `suspected_eos` still behave exactly as before for unfinished work

6. No regression for active/waiting lifecycle rules
- active, normal_wait, blocked, and no-task paths remain unchanged

## Blast-Radius Assessment
Expected implementation blast radius is narrow:
- `supervisor/index.js` classification derivation
- possibly no change needed in `supervisor/state.js` beyond existing generic `isNegative()` behavior if `done` is simply non-negative

Expected non-impacts:
- no fairness cursor changes
- no control-plane schema changes
- no route renames
- no UI changes required for correctness
- no subconscious / Matrix impact

## Rejected Alternatives
### Keep `suspected_eos` but special-case done in `applyJudgment()`
Rejected because it leaves the public classification/lifecycle contradiction in place and hides the fix inside bookkeeping.

### Keep `suspected_eos` and special-case warning emission only
Rejected because negative debt would still be semantically wrong in stored state even if warnings were suppressed.

### Extend lifecycle rules only
Rejected because lifecycle is already truthful here; the mismatch is the classification, not the idle decision.

## Resulting Recommendation
The next implementation slice should:
- change the post-trailing completed-task classification from `suspected_eos` to a terminal non-negative `done`
- leave lifecycle derivation unchanged except to consume the now-aligned classification
- rely on existing `isNegative()` semantics so completed idle work naturally stops building negative streaks
