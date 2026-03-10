# Stable-Merge Readiness Audit

## Scope
This note audits stable-merge readiness for the current supervisor, subconscious, and runtime-profile stack.

It is architecture-first only.

It covers:
- the exact accepted baseline that is now safe
- the remaining structural blockers before `master` can be merged into `stable`
- blocker order by merge risk, not implementation convenience
- the minimal next implementation slice chosen from that blocker list
- explicit non-blockers that should not delay `stable`

It does not cover:
- new feature requests
- UI expansion
- hook expansion
- planner / orchestration expansion
- generic repository explanation

## Exact Accepted Baseline That Is Now Safe
The following baseline is already accepted and can be treated as safe merged behavior, provided the remaining blockers below are addressed or consciously accepted.

### 1. Canonical control-plane model is in place
The shared control-plane object is now the accepted truth source for:
- `task`
- `runtimeProfile`
- v1 manifest-backed agent metadata

For v1 homes, canonical persistence is:
- `agent.json`
- compatibility mirror `data/agents/<name>/meta.json`
- backend row sync

This is the right stable direction because it removes supervisor- and workspace-local shadow truth.

### 2. Minimal supervisor semantics are now real
The accepted supervisor model is no longer prompt- or UI-only.

What is real:
- classification derives from canonical task state only
- lifecycle is binary: `active` or `idle`
- valid `normal_wait` idles supervisor
- unresolved negative states remain active
- no-task idle is coherent and non-contradictory
- runtime existence is now a real projection of lifecycle state

This is stable-worthy because it replaces informal interpretation with a bounded control-plane model.

### 3. Real sibling supervisor runtime exists without introducing a second truth source
A real sibling runtime can now be launched and stopped from lifecycle state.

Accepted properties:
- deterministic tmux session name `supervisor-<agent>`
- launch cwd/home is the sibling `supervisor/` workspace
- sibling workspace remains non-canonical
- route names stayed stable
- runtime-launch truth is exposed through existing supervisor state/detail surfaces

This is safe because runtime existence now matches lifecycle truth without inventing `supervisor/task.json` or a supervisor-local runtime-profile file.

### 4. Runtime-profile precedence is explicit and shared
The accepted launch-selection order is now consistent across primary and supervisor launch paths:
1. `runtimeProfile.supervisor`
2. `runtimeProfile.primary` fallback
3. env/default

This is safe because it prevents silent drift between primary launch, supervisor launch, and route-reported selection.

### 5. Subconscious truthfulness boundary is materially better than the earlier mixed state
The accepted subconscious stack is now split and more truthful in these ways:
- operational vs debug detail is separated
- event ingest trust boundary is enforced
- canonical-source cleanup removed several synthetic/mirror fields from default served detail
- accepted upstream-backed slices now exist for:
  - `SessionStart`
  - `UserPromptSubmit`
  - `PreToolUse`
  - `Stop`
- runtime-connected local transitional path is distinct from the upstream Letta path

This is a meaningful improvement over the earlier ambiguous merged state, but it is not yet enough by itself to declare the whole stack stable-ready.

## Remaining Structural Blockers Before Merging `master` Into `stable`
The blockers below are ordered by merge risk.

## Blocker 1 — Stable still lacks a single convergence-ready subconscious architecture boundary
### Risk level
Highest.

### Why it blocks stable
The current subconscious stack is improved, but it is still intentionally transitional.

Two real paths now coexist:
- upstream Letta-backed path
- local transitional runtime path

That coexistence is acceptable in dev while the architecture is being made truthful, but it is still a merge-risk for stable if the branch is presented as one finished subconscious system.

The structural problem is not that both paths exist.
The problem is that stable still lacks a final convergence rule for which path is authoritative for production intent.

### Concrete risk
Without that convergence rule, stable would absorb:
- an upstream-backed path that is real only for accepted slices, not full end-to-end parity
- a transitional local runtime that is intentionally degraded and not the long-term architecture
- route/detail surfaces that still need to explain which path is authoritative instead of exposing one settled model

That is an architecture risk because stable should not become the place where dual-path subconscious semantics remain permanently normalized.

### Merge consequence
If merged now without an explicit convergence boundary, stable inherits a truthful but still transitional subconscious architecture.
That raises long-tail maintenance risk and makes later cleanup harder because both paths become part of the stable contract.

## Blocker 2 — Stable merge would also freeze the v1 compatibility mirror as an architectural dependency instead of a migration aid
### Risk level
High.

### Why it blocks stable
The current v1 model still relies on both:
- canonical v1 manifest state
- compatibility mirror state under `data/agents/<name>/meta.json`

The mirror is now synchronized more truthfully than before, which is good.
But stable merge is risky if the mirror remains structurally necessary rather than clearly transitional.

### Concrete risk
Several accepted fixes had to repair truth drift between:
- `agent.json`
- compatibility mirror `meta.json`
- backend row state

That means the architecture is still carrying duplicate persistence surfaces even after the control-plane cleanup.

### Merge consequence
If `master` merges into `stable` before the mirror boundary is explicitly minimized, stable will institutionalize duplicate persistence as a normal steady-state requirement rather than a compatibility bridge.

## Blocker 3 — Supervisor runtime existence is now real, but the stable branch still lacks a clear production contract for launch-failure handling and environment ownership
### Risk level
Medium-high.

### Why it blocks stable
The accepted runtime-launch slice proves the lifecycle-driven launch model works.
But it was proven in controlled fresh-home environments with stubbed binaries and explicit env.

The architecture is still missing one final stable-grade statement of ownership for:
- who supplies the required runtime client binaries and env on production-like hosts
- how launch failures are surfaced operationally without looking like lifecycle failure
- what the supported deployment contract is for supervisor runtimes outside dev proof harnesses

### Concrete risk
A recent proof-found bug already showed the class of issue:
- pane exists
- client binary is missing from tmux server environment
- runtime truth diverges unless launch env is explicit

The code fix addressed `PATH` propagation, but the stable merge risk is broader than `PATH` itself. It is that supervisor runtime launch still depends on host/runtime assumptions that are not yet frozen as a stable operational contract.

### Merge consequence
Merging before that contract is explicit would make stable responsible for a process-launch layer whose operational ownership is still partly implicit.

## Blocker 4 — Stable still carries a mixed maturity level across the three stacks being audited
### Risk level
Medium.

### Why it blocks stable
The three audited stacks are not all at the same maturity level:
- supervisor control-plane and runtime-launch architecture are now relatively converged
- runtime-profile selection/writing is relatively converged
- subconscious remains truthful but transitional

The structural blocker is not a single bug. It is cross-stack maturity skew.

### Concrete risk
A `master` -> `stable` merge would present the combined result as one coherent stable surface, while in reality:
- supervisor is already close to stable shape
- runtime-profile handling is close to stable shape
- subconscious is still on a truthfulness-first migration path

### Merge consequence
That skew can create false confidence and blur which remaining work is architectural gating versus later cleanup.

## Minimal Next Implementation Slice Chosen From The Blocker List
### Chosen slice
Define and implement the final subconscious authority boundary for stable.

### Why this is the next slice
This directly addresses the highest-risk blocker.

It is the smallest slice that reduces stable merge risk the most, because it decides what stable is actually promising about subconscious behavior.

### What this slice should do
The slice should not add new hooks or UI.
It should do only this:
- choose the stable authority rule between upstream Letta path and local transitional runtime
- make route/detail state reflect that authority rule explicitly
- demote the non-authoritative path to a clearly transitional or debug-only role
- prevent stable from presenting both paths as equal first-class runtime contracts

### Why this is smaller and higher-value than other possible slices
It is higher value than more compatibility cleanup or more launch polish because:
- compatibility mirror cleanup does not resolve the biggest stable semantic ambiguity
- more supervisor launch work does not resolve the biggest cross-stack convergence gap
- subconscious authority convergence is the main architecture boundary that still decides whether stable represents a settled system or a truthful transitional one

## Explicit Non-Blockers That Should NOT Delay Stable
These items may still deserve follow-up work, but they should not by themselves delay stable once the blockers above are resolved.

### 1. Additional supervisor UI work
The current request boundaries explicitly avoided UI expansion.
Supervisor stable-readiness is not blocked on richer UI if the existing routes and runtime truth are already sound.

### 2. Additional hook-path cutovers beyond the accepted upstream slices
More subconscious hook coverage may be valuable, but stable-readiness is blocked by architectural authority/convergence, not by expanding the hook list for its own sake.

### 3. Extra runtime-profile convenience surfaces
The core precedence and writer model are already accepted.
More helper scripts or UI surfaces are not merge blockers if they do not affect canonical truth.

### 4. Generic cleanup of dev-only proof harnesses
Fresh-home proof harnesses and stubbed binaries were sufficient to validate the accepted runtime-launch slice.
Cleaning those harnesses up is not itself a stable blocker.

### 5. Additional legacy-home ergonomics
Existing-home migration and compatibility behavior may still gain polish, but once the architectural duplicate-truth boundary is clearly constrained, extra ergonomics should not gate stable.

## Merge Recommendation
Do not merge `master` into `stable` yet.

Reason:
- supervisor and runtime-profile architecture are now close to stable shape
- subconscious is much more truthful than before
- but the combined stack still lacks one final stable authority boundary for subconscious behavior, and stable would otherwise freeze a transitional dual-path model

## Recommended Immediate Follow-On
One narrow next implementation slice:
- subconscious authority-boundary convergence for stable

After that slice, re-run a second stable-readiness audit focused only on whether:
- the subconscious authority rule is explicit and enforced
- compatibility mirror dependency is still structurally necessary or merely transitional
- supervisor runtime launch has an explicit supported deployment contract

That is the shortest path to a credible `master` -> `stable` merge decision.
