# Supervisor Dead Flags Truthfulness Design

## Scope
Design only for the truthfulness issue around exposed but unenforced supervisor flags:
- `activeOnly`
- `skipBlocked`

In scope:
- smallest truthful correction
- decision between enforcement vs removing them from active semantics
- proof strategy
- blast-radius analysis

Out of scope:
- fairness
- done-task logic
- UI redesign
- subconscious or Matrix/bridge work

## Current Problem
`supervisor/config.js` parses:
- `SUPERVISOR_ACTIVE_ONLY`
- `SUPERVISOR_SKIP_BLOCKED`

`supervisor/index.js` exposes both in `getStatus()`.

But candidate selection and evaluation do not actually use either flag.

That means the API/status surface currently advertises active behavior switches that are not real.

## Truthfulness Requirement
There are only two truthful options:
1. enforce the flags in supervisor behavior
2. stop surfacing them as active semantics

Because this batch is scoped as the smallest truthful correction, the design should prefer the option with the smallest blast radius and least policy churn.

## Recommendation
Prefer removing them from active semantics, not enforcing them.

### Why
Enforcing the flags would be broader than it looks:
- `activeOnly` would change candidate eligibility and supervisor coverage policy
- `skipBlocked` would change whether blocked work is even observed, which conflicts with already accepted supervisor semantics where blocked work is a real attention state
- both changes would alter actual runtime behavior and could reopen prior lifecycle/truthfulness work

By contrast, removing them from active semantics is a narrow truthfulness repair:
- stop claiming these flags are meaningful knobs when they are not honored
- preserve current runtime behavior exactly

## Smallest Correction Model
1. Stop exposing `activeOnly` and `skipBlocked` as active supervisor semantics in status/control surfaces.
2. Optionally retain the raw env parsing internally only if needed for backward-compatibility migration, but do not surface them as active behavior.
3. Document clearly that current supervisor selection/evaluation is not governed by these flags.

## Canonical Boundary
The truthfulness repair should happen at the public surface first:
- `getStatus()`
- any control or detail payload that currently reports those values as if they are effective configuration

This is the narrowest place to make the system truthful without changing supervisor runtime behavior.

## Non-Recommended Alternative: Enforce Them
If they were enforced instead:
- `activeOnly` would need a concrete definition against the accepted task/lifecycle model
- `skipBlocked` would need a concrete rule for blocked tasks, even though blocked currently maps to attention-worthy supervisor state
- both would require new proofs and likely reopen previously accepted supervisor semantics

That is not the smallest correction.

## Proof Strategy
A later implementation should prove all of these:

1. Public-surface truthfulness
- supervisor status/control/detail surfaces no longer imply that `activeOnly` and `skipBlocked` are active enforced semantics

2. Behavioral stability
- candidate selection, lifecycle derivation, and warning behavior remain unchanged from the current accepted supervisor behavior

3. No hidden policy drift
- blocked tasks and non-active tasks are still treated exactly as before in supervisor evaluation unless and until a separate explicit policy slice changes that

## Blast-Radius Assessment
Expected implementation blast radius is very small:
- `supervisor/index.js` public status/control shaping
- possibly `supervisor/config.js` if dead parsed fields are removed from the returned config object

Expected non-impacts:
- no candidate-selection changes
- no lifecycle/classification changes
- no state-store changes
- no route renames
- no UI redesign required beyond whatever consumes the existing status payload truthfully

## Resulting Recommendation
The next implementation slice should:
- remove `activeOnly` and `skipBlocked` from exposed active supervisor semantics
- keep runtime behavior unchanged
- treat any future enforcement as a separate policy design/implementation batch, not part of this truthfulness fix
