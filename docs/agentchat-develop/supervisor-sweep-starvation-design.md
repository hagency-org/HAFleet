# Supervisor Sweep Starvation Design

## Scope
Design only for the supervisor sweep starvation / fairness finding in `supervisor/index.js`.

In scope:
- candidate selection fairness under `SUPERVISOR_MAX_AGENTS_PER_SWEEP`
- smallest rotation model that prevents permanent starvation
- proof strategy
- blast-radius analysis

Out of scope:
- lifecycle/classification changes
- warning/negative-streak changes
- supervisor UI or route changes
- subconscious or Matrix/bridge work

## Current Problem
`resolveCandidates()` currently:
1. collects all candidate agents
2. sorts them alphabetically by `agent.name`
3. returns `rows.slice(0, maxAgentsPerSweep)`

That means once the eligible candidate set is larger than `SUPERVISOR_MAX_AGENTS_PER_SWEEP`, later names can be excluded forever if the candidate set remains saturated.

## Structural Risk
This is a structural correctness issue in supervision coverage, not just a performance issue.

Blast radius:
- a subset of agents can receive zero supervisor observation indefinitely
- stale task/lifecycle state can persist for starved agents
- accepted supervisor guarantees become name-order dependent

What it does not affect:
- canonical `task` or `runtimeProfile` writes
- accepted lifecycle derivation logic itself
- route names or control-plane schema

## Design Goal
Preserve all accepted supervisor semantics while making the sweep cap fair.

The smallest acceptable outcome is:
- no eligible agent can be permanently excluded solely because of lexical name ordering
- the sweep cap remains enforced
- the current per-agent observation logic is unchanged once a candidate is selected

## Smallest Fairness Model
Use stable sorted order plus a persistent round-robin cursor.

### Model
1. Continue building the candidate set exactly as today.
2. Continue sorting candidates by `agent.name` for deterministic base order.
3. Persist one sweep cursor in supervisor state, for example:
   - `selectionCursor`
   - or `lastSweepOffset`
4. On each sweep:
   - start selection at the cursor offset in the sorted list
   - take up to `maxAgentsPerSweep`
   - wrap around at the end of the list
5. Advance the cursor by the number of candidates actually considered for that sweep.

### Why this is the smallest safe model
- no new policy tiering
- no priority weights
- no extra control-plane objects
- no change to candidate eligibility rules
- deterministic and easy to reason about in proofs

## Canonical State Boundary
The fairness state should live with supervisor runtime state, not in agent metadata.

Recommended location:
- persisted in `supervisor_state.json` alongside other supervisor-local bookkeeping

Reasoning:
- fairness cursor is a supervisor scheduling concern, not agent truth
- it must survive process restart to avoid restart-reset starvation bias
- it must not become part of the agent control-plane contract

## Selection Rules
Given sorted candidate list `rows` and cap `limit`:
- if `rows.length <= limit`, return all rows and reset or normalize cursor to `0`
- if `rows.length > limit`, return the wrapped window starting from `cursor % rows.length`
- after the sweep, next cursor becomes `(cursor + returnedCount) % rows.length`

## Non-Goals
This design intentionally does not add:
- urgency-based prioritization
- special treatment for active vs waiting vs done
- separate local vs remote quotas
- warning-based escalation priority

Those would change supervision policy rather than just removing starvation.

## Interaction With Accepted Semantics
This design preserves:
- current supervisor control-plane schema
- current lifecycle derivation
- current event format
- current route names
- current `SUPERVISOR_MAX_AGENTS_PER_SWEEP` meaning as a hard cap

Only candidate selection order changes.

## Proof Strategy
A later implementation should prove all of these:

1. No-cap case
- if candidate count is below or equal to the cap, every sweep still evaluates all candidates

2. Saturated fairness case
- with more candidates than the cap, repeated sweeps cover the full candidate set instead of always selecting the first lexical block

3. Wraparound case
- cursor near the tail wraps cleanly to the start and still returns exactly `limit` rows

4. Restart persistence case
- after saving/restoring supervisor state, the next sweep resumes from the persisted cursor instead of restarting from lexical head every time

5. Eligibility-change case
- if the candidate set shrinks or grows between sweeps, cursor normalization still yields valid selection without skipping or crashing

6. No semantic regression case
- selected candidates still produce the same observation/lifecycle results they would have before; only selection order changes

## Blast-Radius Assessment
Expected blast radius of a later implementation is narrow:
- `supervisor/index.js` candidate selection
- `supervisor/state.js` persisted local scheduler state

Expected non-impacts:
- no backend route contract changes
- no frontend changes
- no hook/subconscious changes
- no agent-home/schema changes

## Rejected Alternatives
### Random shuffle each sweep
Rejected because it is harder to reason about, harder to prove deterministically, and makes debugging/event correlation worse.

### Priority tiers before fairness
Rejected for the first slice because it changes supervisor policy and broadens scope beyond removing starvation.

### In-memory-only cursor
Rejected because supervisor restarts would reintroduce lexical-head bias and could still starve later agents under repeated restarts.

## Resulting Recommendation
The next implementation slice should:
- add a persisted supervisor-local round-robin selection cursor
- keep deterministic alphabetical base order
- rotate the capped candidate window each sweep
- leave observation, lifecycle, warning, and route surfaces unchanged
