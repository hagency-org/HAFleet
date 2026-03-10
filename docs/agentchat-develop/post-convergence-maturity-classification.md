# Post-Convergence Maturity Classification

## Scope
This note classifies the current accepted supervisor, subconscious, and control-plane surfaces after the recent convergence work.

It answers only:
- which current surfaces are now `stable`
- which remain `transitional`
- which are `debug-only`
- which explicit structural blockers, if any, still block `master -> stable`
- the minimum correction order that remains before a credible stable merge

It does not cover:
- implementation
- UI expansion
- hook expansion
- generic repository explanation

## Accepted Convergence Baseline
This classification is based only on already accepted work:
- canonical control-plane `task` and `runtimeProfile`
- mirror-boundary design plus manifest-first reader enforcement
- inbox-read gate slice 1
- supervisor lifecycle, runtime-launch, ownership contract, and failure taxonomy
- subconscious authority-boundary convergence
- subconscious operational/debug split and canonical-source cleanup
- accepted upstream-backed subconscious slices:
  - `SessionStart`
  - `UserPromptSubmit`
  - `PreToolUse`
  - `Stop`

The point of this note is not to ask for more features.
It is to decide what the current branch already is.

## Stable Surfaces
These surfaces are now coherent enough to be treated as stable branch contract.

## 1. Canonical control-plane object
Stable:
- canonical `task`
- canonical `runtimeProfile`
- canonical v1 home-owned metadata in `agent.json`

Why:
- writer paths are explicit
- reader precedence is explicit
- supervisor behavior now derives from these objects instead of prompt/UI inference

Important stable interpretation:
- `agent.json` is canonical for v1-owned metadata
- backend row state is stable runtime-serving derivative state
- mirror state does not outrank the manifest

## 2. Supervisor classification and lifecycle
Stable:
- `active`
- `normal_wait`
- `stalled_wait`
- `suspected_eos`
- lifecycle binary: `active` / `idle`
- bounded trailing-heartbeat semantics

Why:
- the state machine is accepted
- the truthfulness corrections are accepted
- classification/lifecycle now remain anchored to canonical task state only

## 3. Supervisor runtime launch for the supported local sibling shape
Stable:
- same-host sibling supervisor runtime
- deterministic tmux session `supervisor-<agent>`
- cwd/home at `<homeDir>/supervisor`
- explicit runtime-profile selection order
- explicit ownership contract for binaries/env/credentials
- explicit runtimeLaunch failure taxonomy

Why:
- lifecycle-driven launch is real
- ownership contract is accepted
- failure taxonomy is now explicit and does not mutate lifecycle truth

Stable interpretation:
- this is the supported deployment shape
- other shapes are not part of the stable promise

## 4. Subconscious authoritative operational surface
Stable:
- authoritative subconscious path is upstream Letta durable state
- default operational detail is upstream-authoritative
- manual guidance is stable fallback/configuration only
- launch/runtime/debug internals are no longer mixed into the default behavior contract

Why:
- the authority boundary is accepted
- operational/debug split is accepted
- canonical-source cleanup is accepted

Stable interpretation:
- stable subconscious intent is upstream-backed
- default detail no longer promises dual-path behavior

## 5. Accepted upstream-backed subconscious lifecycle slices
Stable:
- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `Stop`

Why:
- these slices are real and accepted
- their durable-state truth source is explicit
- they are enough to define the current stable subconscious behavior contract

Important boundary:
- stable does not promise more hook coverage than these accepted slices

## 6. Inbox-read gate enforcement boundary
Stable:
- actionable delivery raises `requiresInboxCheck`
- successful `check_inbox()` cursor advance clears it
- agent outbound is blocked while the gate is pending

Why:
- this is now a real backend/runtime gate, not prompt-only policy text

## Transitional Surfaces
These surfaces are still part of the working branch, but they should be treated as compatibility state, not as the final architectural target.

## 1. V1 compatibility mirror
Transitional:
- `data/agents/<name>/meta.json`

Why:
- it still exists for compatibility and legacy readers
- it is derivative only
- reader enforcement now prevents it from outranking the manifest

Current maturity:
- acceptable compatibility surface
- not canonical
- not a peer authority surface

## 2. Backend row projection for v1-owned fields
Transitional in authorship, stable in serving role:
- backend `data/agents.json` remains the live runtime-serving projection
- for v1-owned fields it is still derivative from `agent.json`

Why this is transitional:
- it is not the home-owned truth source
- it is still part of the duplicate-persistence family

Why it is still acceptable:
- the serving role is explicit
- the peer-authority ambiguity has been reduced

## 3. Local subconscious runtime, memory, and conversation journal
Transitional:
- local runtime invoke path
- local episodic memory/journal surfaces
- local conversation journal surfaces

Why:
- the authority rule now demotes them to compatibility/debug only
- they are still real and useful operationally
- they are not the stable behavior contract

## 4. Manual guidance as fallback/configuration
Transitional in role, not in legitimacy:
- it is still a real supported fallback/config surface
- it is no longer the primary subconscious behavior engine

Why this matters:
- it should remain available
- but stable should not describe it as equal to the authoritative upstream path

## Debug-Only Surfaces
These surfaces are intentionally kept out of the stable operational contract and should be treated as privileged debugging/inspection only.

## 1. Privileged subconscious detail
Debug-only:
- backend `GET /api/subconscious/detail/:name?debug=1`
- raw path/file pointers
- transcript pointers
- local runtime internals
- route-run timestamps/counters
- debug previews and text bodies

## 2. Local transitional runtime internals
Debug-only:
- provider/model/invoke internals for the local compatibility runtime
- low-level memory retrieval internals
- local journal reconstruction data

## 3. Raw supervisor host/runtime failure detail beyond the operational taxonomy
Debug-only in depth, while the taxonomy itself is stable:
- low-level host error strings
- detailed launch-path troubleshooting evidence
- proof-harness artifacts

Stable surface keeps:
- `runtimeLaunch.status`
- `runtimeLaunch.failureType`
- selected operational metadata

But deeper troubleshooting belongs in debug/log surfaces, not in the stable branch promise.

## Structural Blockers Before `master -> stable`
## Decision
No explicit structural blocker remains, provided stable accepts the maturity split above as the contract.

### Why this is now true
The earlier blockers were:
- missing subconscious authority boundary
- ambiguous v1 mirror boundary
- missing supervisor runtime ownership/failure contract
- unresolved maturity skew decision

Those are now closed or reclassified as follows:

1. Subconscious authority boundary
- closed by accepted authority-boundary convergence

2. Supervisor runtime ownership/failure ambiguity
- closed by accepted ownership design and failure-taxonomy slice

3. Maturity skew
- closed by this note if accepted, because the skew is now classified instead of left implicit

4. V1 compatibility mirror
- no longer a blocker if stable explicitly accepts it as transitional compatibility-only state rather than a peer authority surface

The mirror still exists, but the blocking ambiguity was not “mirror exists.”
It was “mirror authority is not explicit.”
The accepted design plus manifest-first enforcement remove that ambiguity enough for a stable contract.

## Merge Recommendation
`master -> stable` is now credible.

Meaning:
- stable can honestly present the current branch as a converged control-plane + supervisor system
- subconscious can honestly be presented as upstream-authoritative with bounded transitional compatibility surfaces
- stable should not over-promise that transitional/debug surfaces are the long-term architecture

## Minimum Correction Order Before Stable Merge
There is no mandatory architecture correction slice left before merge.

The minimum remaining order is release/contract hygiene:

1. Accept this maturity classification as the stable contract
- stable must explicitly freeze which surfaces are stable vs transitional vs debug-only

2. Do one final merge-readiness confirmation pass against this classification
- confirm no route/UI/default surface still accidentally promotes transitional or debug-only state into the stable contract

3. Merge without reopening closed architecture
- do not expand hooks, UI, or supervisor features as part of the merge decision

## Minimum Follow-On Order After Stable Merge
After merge, the cleanup order should be:

1. reduce or retire the v1 compatibility mirror further if legacy readers can be removed
2. shrink transitional local subconscious runtime exposure further if it no longer serves compatibility value
3. keep privileged debug surfaces explicit and bounded

These are cleanup priorities, not pre-merge blockers.

## Bottom Line
Current maturity after the accepted convergence work is:
- `stable`: canonical control-plane, supervisor lifecycle/runtime-launch contract, runtime failure taxonomy, authoritative subconscious operational path, accepted upstream-backed subconscious slices, inbox-read gate
- `transitional`: v1 compatibility mirror, backend row as derivative for v1-owned fields, local subconscious runtime/memory/journal surfaces, manual-guidance fallback role
- `debug-only`: privileged subconscious detail internals, raw path/timing/debug artifacts, deep host/runtime troubleshooting detail

If this classification is accepted, the remaining work is no longer structural merge gating.
It is bounded cleanup after a stable merge, not before one.
