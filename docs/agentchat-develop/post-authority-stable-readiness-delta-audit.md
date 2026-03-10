# Post-Authority Stable-Readiness Delta Audit

## Scope
This note updates the earlier stable-merge readiness audit after the subconscious authority-boundary correction was accepted.

It covers only:
- what changed in the stable-readiness picture after authority convergence
- which structural blockers still remain before `master -> stable`
- which prior concerns are now downgraded to non-blockers
- the minimum next architecture slice with the highest merge-risk reduction

It does not cover:
- code changes
- UI expansion
- hook expansion
- generic repository explanation

## Delta Since The Earlier Stable-Readiness Audit
The earlier audit identified the missing subconscious authority rule as the highest-risk blocker.

That blocker is now closed.

Accepted current state now includes:
- one authoritative stable subconscious behavior path
  - `authority.path = upstream-letta`
- manual guidance reduced to fallback/configuration on the default surface
- local runtime, memory, and conversation reduced to transitional summary-only objects on the default surface
- richer local runtime and manual text preserved only in debug or writable settings surfaces

This materially changes the merge picture:
- the biggest stable semantic ambiguity is gone
- stable no longer needs to freeze dual-path subconscious behavior as a peer contract
- the remaining blockers are now outside the core subconscious authority boundary

## Structural Blockers Still Preventing `master -> stable`
The blockers below are ordered by stable merge risk after authority convergence.

## Blocker 1 — The v1 compatibility mirror is still structurally necessary rather than clearly optional
### Why it still blocks stable
Canonical control-plane truth is improved, but stable still depends on duplicate persistence surfaces:
- `agent.json`
- `data/agents/<name>/meta.json`
- backend row state

The mirror is synchronized better than before, but several accepted fixes in this cycle were specifically about keeping the mirror from drifting behind the canonical manifest.

That means the architecture still treats duplicate persistence as part of the working system, not just as a compatibility bridge with sharply limited responsibility.

### Stable risk
If `master` merges now, stable inherits a duplicated persistence model that still needs active repair logic to stay truthful.

That is a structural merge risk because stable should not normalize “mirror plus canonical plus backend row” as the steady-state contract unless that duplication is explicitly accepted long-term.

### What would close it
A narrow architecture slice that makes the mirror boundary explicit:
- either the mirror is reduced to a strict compatibility export with no architectural authority
- or stable explicitly documents the mirror as a required long-term surface and freezes the sync contract accordingly

## Blocker 2 — Supervisor runtime launch has code truth but still lacks a final stable operational ownership contract
### Why it still blocks stable
The supervisor runtime-launch model is real and lifecycle-driven.
That is no longer the issue.

The remaining problem is operational ownership:
- who guarantees the runtime client binaries on stable hosts
- who owns the required env and model/provider credentials
- how launch failure is surfaced operationally without being confused with task-state failure
- what the supported production-like deployment contract actually is

The code now handles `PATH` propagation and lifecycle/runtime reconciliation correctly, but stable still lacks the final operational statement that turns those mechanics into a supported production contract.

### Stable risk
Without that contract, stable would absorb a real runtime-launch layer whose host assumptions remain partly implicit.

That is a merge risk because runtime existence could still fail for host/env reasons that are outside the canonical task/lifecycle model, while operators may interpret the result as a supervisor semantics problem.

### What would close it
A design-first stable operations contract that freezes:
- binary ownership
- env ownership
- launch-failure reporting semantics
- the supported deployment shape for sibling supervisor runtimes

## Blocker 3 — The accepted stack is now truthful, but stable still lacks one final post-convergence merge decision on maturity skew
### Why it still blocks stable
Authority convergence removed the biggest ambiguity, but the three audited stacks are still not at exactly the same maturity level:
- supervisor control-plane and lifecycle/runtime launch are close to stable shape
- runtime-profile writing/precedence is close to stable shape
- subconscious is now architecturally truthful, but still intentionally exposes transitional compatibility surfaces

That maturity skew is not a bug.
It is an architecture/release decision.

Stable still needs one explicit decision:
- is the current transitional remainder acceptable as a stable-compatible compatibility surface
- or does stable require one more reduction pass before merge

### Stable risk
Without that explicit decision, `master -> stable` would still imply a stronger convergence level than the system has formally declared.

### What would close it
A short post-authority decision slice that classifies the remaining transitional surfaces into:
- acceptable stable compatibility
- stable blockers
- future cleanup only

## Non-Blockers After Authority Convergence
These items should not delay `master -> stable` by themselves.

## 1. Additional subconscious hook cutovers
Authority convergence closed the main stable semantic gap.
More hook coverage may still be useful, but stable readiness is no longer blocked by adding more cutovers for their own sake.

## 2. More subconscious UI work
The current blocking concerns are structural and operational.
Additional UI polish does not materially change stable merge risk.

## 3. More runtime-profile convenience surfaces
The canonical writer and launch precedence are already accepted.
Extra ergonomics are not merge blockers unless they create a new truth source.

## 4. Benchmark or proof-harness cleanup
The benchmark/proof infrastructure can continue evolving, but it is not part of the stable architectural blocker set.

## 5. Existing-home ergonomics beyond the accepted migration path
The accepted migration/control-plane path is sufficient for merge-risk evaluation.
Extra ergonomics are not structural blockers.

## Closed From The Earlier Audit
The following earlier blocker is now closed and should not be carried forward as open:
- missing final subconscious authority boundary between upstream Letta and the local transitional runtime

That concern is resolved by the accepted authority-boundary convergence work.

## Updated Merge Recommendation
Do not merge `master` into `stable` yet.

Reason:
- the biggest subconscious semantic blocker is now closed
- but stable still lacks final closure on duplicate persistence boundary, supervisor runtime operational ownership, and post-convergence maturity classification

## Recommended Immediate Follow-On
The next narrow architecture slice with the highest merge-risk reduction is:
- define the stable contract for the v1 compatibility mirror and duplicate persistence boundary

Why this next:
- the biggest semantic blocker is already closed
- the mirror boundary is now the clearest remaining structural ambiguity in what stable would institutionalize
