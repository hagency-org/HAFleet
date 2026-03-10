# Subconscious Authority-Boundary Convergence Design

## Scope
This note defines the final stable authority boundary for subconscious behavior.

It covers only:
- the authoritative objects for stable subconscious behavior
- which path is canonical for stable intent
- which remaining routes and fields are compatibility-only, debug-only, or removable from the stable-facing surface
- what must change in default detail/state derivation so stable stops presenting dual-path semantics as a settled contract
- the minimal next implementation slice to enforce that authority boundary

Out of scope:
- implementation
- hook expansion
- UI expansion
- generic repository explanation

## Accepted Current Baseline
Current accepted state is:
- upstream-backed slices are real for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop`
- local transitional runtime is still present and truthfully exposed as separate runtime/config state
- default detail is now operational-only and debug surfaces are partly split out
- canonical-source cleanup has already moved several upstream/session fields away from mirror-first derivation
- stable-merge audit already identified the missing final authority rule as the top blocker

This note resolves that missing rule.

## Stable Authority Rule
Stable should not present the upstream Letta path and the local transitional runtime as equal peer subconscious contracts.

### Final rule
For stable subconscious intent, the canonical path is the upstream Letta path.

The local transitional runtime is not a second canonical intent engine.
It remains only:
- a compatibility surface while convergence is completed
- a local diagnostic/runtime surface
- an optional manual-guidance fallback/configuration surface

### Implication
Default stable-facing operational detail must answer:
- is the stable subconscious path configured?
- is the stable subconscious conversation/session path established?
- what is the latest authoritative upstream-backed subconscious state?

It must not answer that question by mixing in local transitional runtime state as if it were co-authoritative behavior.

### Consequence for stable semantics
If upstream Letta is not configured or not established, stable should report:
- subconscious unconfigured
- subconscious degraded
- subconscious unavailable

It should not silently promote the local transitional runtime into the stable authoritative intent path.

## Canonical Objects For Stable Subconscious Behavior
Stable subconscious behavior should be governed by a narrow set of first-class objects.

## 1. Stable subconscious binding object
Purpose:
- the agent-level binding to the authoritative subconscious path

Canonical writer:
- v1 subconscious configuration / explicit binding writes into `state/letta.json`

Canonical reader:
- backend subconscious state resolution

Canonical file:
- `<stateDir>/letta.json`

Stable-authoritative fields:
- bound Letta agent identity
- stable path enablement/binding mode
- any explicit manual-guidance fallback configuration

Not authoritative for stable behavior:
- route-local mirror status labels
- local runtime invocation summaries

## 2. Upstream session object
Purpose:
- whether the stable subconscious path is actually established for the current session

Canonical writer:
- upstream-backed `SessionStart`

Canonical readers:
- durable upstream state readers only

Canonical files:
- `<stateDir>/subconscious/upstream-home/.letta/claude/conversations.json`
- `<stateDir>/subconscious/upstream-home/.letta/claude/session-<session>.json`

Stable-authoritative fields:
- `sessionId`
- `conversationId`
- durable session progress state

Presentation-only summaries derived from those fields:
- operational `session.status`
- operational `conversation.established`

## 3. Upstream conversation-progress object
Purpose:
- the authoritative subconscious behavior already exercised through accepted slices

Canonical writers:
- upstream `UserPromptSubmit`
- upstream `PreToolUse`
- upstream `Stop`

Canonical readers:
- durable upstream files plus bound agent identity

Canonical fields:
- last durable processed index
- last durable seen message id
- last durable block values
- durable conversation/session mapping

Stable-authoritative behavior summaries derived from those fields:
- latest authoritative prompt-send progress
- latest authoritative assistant-delta/block-delta state
- latest authoritative stop/transcript progress

## 4. Manual-guidance fallback object
Purpose:
- explicit human-supplied fallback input while stable authority converges or when upstream path is not fully available

Canonical writer:
- `PATCH /api/agents/:name/subconscious-guidance`

Canonical reader:
- `state/letta.json`

Stable meaning:
- this is configuration/fallback input, not the primary stable subconscious engine
- it may be shown as fallback availability or manual override configuration
- it must not be reported as equivalent to the authoritative upstream Letta behavior path

## Canonical Path Decision For Stable Intent
The required worker question is: which path is canonical for stable intent?

### Decision
Use an explicit split by purpose.

- Canonical stable intent path: upstream Letta
- Canonical stable fallback/config path: manual guidance in `state/letta.json`
- Local transitional runtime: compatibility/debug only

### Why this split is the correct stable rule
It avoids the two bad alternatives:

1. `upstream Letta` and `local transitional runtime` both canonical
- rejected because it preserves dual-path semantics as a stable contract

2. local transitional runtime canonical for stable intent
- rejected because it makes the intentionally transitional path the long-term contract and demotes the already accepted upstream-backed slices

The chosen split keeps one stable intent engine while still preserving a bounded fallback surface.

## What Governs Default Operational Detail In Stable
Default operational detail should be derived only from the canonical stable objects above.

That means default detail should prioritize:
1. stable binding state from `state/letta.json`
2. durable upstream session/conversation state
3. durable upstream progress state for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop`
4. explicit manual-guidance fallback configuration state

Default operational detail should not present local runtime invocation state as a co-equal behavior path.

### Default operational contract should answer
- is the authoritative subconscious path bound?
- is the authoritative conversation/session established?
- what is the latest durable upstream-backed progress state?
- is a manual fallback configured?
- is the system degraded because only transitional local runtime remains?

### Default operational contract should not answer by default
- local runtime provider/model/invoke details as if they define stable behavior
- local episodic-memory retrieval state as if it were the authoritative subconscious memory layer
- path-specific debug artifacts
- generic `guidance*` compatibility fields that blur upstream behavior, runtime output, and manual fallback

## Compatibility-Only Surfaces
The following should remain compatibility-only, not authoritative for stable behavior.

### 1. Top-level synthetic `stage`
Keep only as a temporary compatibility summary if needed.
It must not define stable policy or stable subconscious truth.

### 2. Generic `guidance*` compatibility fields
These may remain temporarily for compatibility, but they are not stable canonical objects.
They conflate:
- upstream Letta-derived deltas
- local runtime guidance
- manual fallback guidance

### 3. Local runtime invocation summaries in default detail
Fields that summarize local runtime invocation success, provider/model, memory retrieval, or local journal activity should no longer frame the stable subconscious contract.
If retained, they should be clearly compatibility/transitional only.

## Debug-Only Surfaces
The following should be debug-only for stable-facing semantics.

### 1. Local transitional runtime internals
Examples:
- local runtime provider/model config internals
- local invoke path details
- local journal internals
- local memory retrieval internals

### 2. Raw path/file reconstruction data
Examples:
- absolute filesystem paths
- transcript files
- sync-state files
- upstream-home internal file pointers

### 3. Route-run timing and delta metadata
Examples:
- `checkedAt`
- `attemptedAt`
- `messageSentAt`
- `injectedAt`
- route-run counters and before/after baselines

## Remove Or Demote From Stable-Facing Default Surface
The following should stop looking like part of the stable subconscious contract.

### 1. Dual-path top-level framing
Default operational detail should no longer present:
- `upstream Letta path`
- `local runtime path`

as two equal first-class runtime subsystems.

Instead it should present:
- authoritative subconscious path status
- fallback/degraded/transitional status only when needed

### 2. Local runtime memory as authoritative subconscious memory
Local transitional memory store may remain real for dev compatibility, but it should not appear as the stable subconscious memory contract.

### 3. Generic merged guidance summaries
Any summary that merges upstream Letta injection, local runtime output, and manual fallback into one stable object should be demoted or removed.

## Required Default Derivation Changes
Stable authority convergence requires changes in how default subconscious detail is derived.

## 1. Default detail must derive from authoritative upstream objects first and exclusively for behavior status
For stable-facing operational status:
- use upstream durable files plus bound agent identity
- derive conversation/session/progress summaries from those objects only
- treat missing upstream authority as degraded/unconfigured, not as permission to promote local runtime into equal authority

## 2. Local runtime must move under transitional/fallback reporting, not core behavior reporting
If local runtime is still exposed in stable at all, it should be framed only as:
- transitional runtime present
- fallback runtime present
- debug/runtime diagnostics present

Not as:
- co-equal subconscious path
- authoritative behavior engine

## 3. Manual guidance must be framed as fallback/configuration, not equal behavior engine
Manual guidance should remain visible only as:
- configured fallback
- operator override / fallback input

It should not be used to imply that the stable subconscious path is functioning normally when upstream authority is absent.

## 4. Default operational detail should collapse to one authoritative summary object
The stable-facing surface should converge around one object family such as:
- authoritative binding
- authoritative session state
- authoritative conversation/progress state
- fallback/degraded state

The stable-facing contract should stop using two independent path families as equal headline sections.

## Minimal Next Implementation Slice
The smallest next slice that enforces this authority boundary is:
- rewrite default subconscious operational detail derivation so that stable behavior status is upstream-authoritative only
- demote local transitional runtime fields to compatibility/debug classification
- relabel manual guidance as fallback/configuration only
- keep existing upstream-backed hooks and route names unchanged

### Concretely, that slice should do only this
1. choose upstream Letta durable state as the only canonical source for stable behavior summaries
2. change default detail/state builders so local runtime no longer appears as a co-authoritative path
3. move remaining local-runtime behavior summaries behind transitional/debug labeling
4. keep compatibility fields only where required, but explicitly mark them as non-authoritative

### What that slice should not do
- no new hook cutovers
- no UI expansion
- no new planner/orchestration behavior
- no new routes required unless absolutely necessary for clean separation

## Stable Acceptance Target After The Next Slice
The authority-boundary convergence slice should be considered successful when all of the following are true:
- default stable-facing subconscious detail has one authoritative behavior path
- that path is upstream Letta-backed durable state
- local transitional runtime is no longer shown as a peer authoritative contract
- manual guidance is shown only as fallback/configuration
- compatibility/debug surfaces remain available but cannot be mistaken for stable authoritative behavior

That is the minimum architecture change required before stable can truthfully present subconscious behavior as a settled contract instead of a dual-path transitional one.
