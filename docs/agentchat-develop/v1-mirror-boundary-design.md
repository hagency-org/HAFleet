# V1 Compatibility-Mirror Boundary Design

## Scope
This note defines the stable contract for the v1 compatibility mirror / duplicate persistence boundary.

It covers only:
- the current duplicate-persistence surfaces
- canonical writer and reader responsibilities
- strict compatibility-mirror responsibilities
- whether stable should freeze the mirror as a required long-term surface or demote it to compatibility export only

It does not cover:
- implementation
- UI expansion
- hook expansion
- generic repository explanation

## Problem Statement
The current v1 stack carries the same agent-shaped control-plane information across three persistence surfaces:
- canonical v1 manifest `agent.json`
- compatibility mirror `data/agents/<name>/meta.json`
- backend row state (`data/agents.json`)

Recent accepted work made those surfaces more truthful, but the architecture boundary is still not explicit enough for stable.

The stable question is not whether multiple copies exist today.
The stable question is which one is authoritative, which ones are allowed to lag or be regenerated, and which ones must never become peer truth sources.

## Current Accepted Reality
Current accepted behavior is:
- v1 home-owned metadata writes go through `PATCH /api/agents/:name/home-metadata`
- that route writes `agent.json`
- then syncs `meta.json`
- then syncs backend row state
- direct provision/reprovision also syncs the mirror from the manifest

That means the architecture is already leaning in the right direction:
- `agent.json` is the canonical v1 writer target
- the other surfaces are derivative

What is still missing is an explicit stable statement that the derivative surfaces are compatibility/export state only, not co-equal authority.

## Persistence Surfaces
## 1. Canonical v1 manifest
Path:
- `<homeDir>/agent.json`

Purpose:
- home-owned canonical agent control-plane object

Current contents of interest:
- identity/layout metadata
- `subconsciousEnabled`
- `managedProjects`
- `human`
- `task`
- `runtimeProfile`

Stable interpretation:
- this is the canonical persisted v1 truth source

## 2. Compatibility mirror
Path:
- `data/agents/<name>/meta.json`

Purpose today:
- compatibility with older agent discovery/control paths
- runtime-visible mirror for code still reading the legacy data tree
- fallback resolution for agent/workspace metadata where the v1 home is not the direct read path

Stable interpretation:
- this should be treated as a compatibility/export surface only

## 3. Backend row state
Path:
- runtime `data/agents.json`

Purpose:
- live backend registry/state for routes and supervisor consumption
- runtime-visible aggregated view across agent models

Stable interpretation:
- canonical live runtime row state for backend readers
- but for v1 home-owned metadata it is still derivative from the manifest, not peer authority

## Canonical Writer Contract
Stable should freeze the writer model explicitly.

### Canonical writer for v1 metadata
Canonical writer:
- `server.js`
- `PATCH /api/agents/:name/home-metadata`

Canonical persisted target:
- `agent.json`

Writer order:
1. validate and normalize the incoming v1 metadata payload
2. write canonical `agent.json`
3. regenerate/sync compatibility mirror `meta.json`
4. sync backend row state

### Provision/reprovision writer
Canonical writer:
- `scripts/provision-v1-agent-home.js`

Rule:
- provision/reprovision may regenerate the compatibility mirror
- but it must do so from the manifest, not by treating the mirror as input authority

### Non-writers
The following must not become canonical writers for v1 metadata:
- direct edits to `data/agents/<name>/meta.json`
- supervisor-local state
- launcher-local files
- workspace-local docs or config shadows

## Canonical Reader Contract
Stable should also freeze the reader order.

## 1. Home-owned v1 metadata readers
Readers that need v1-owned truth should prefer:
1. `agent.json`
2. regenerated/synced derivative surfaces only if the manifest path is unavailable

Examples:
- v1 control-plane mutations
- existing-home migration logic
- workspace/project contract logic
- any route that intends to report the v1 home’s canonical metadata

## 2. Backend/runtime readers
Readers that need runtime aggregation or live route serving may read:
- backend row state in `data/agents.json`

But stable interpretation must remain:
- backend row state is runtime-serving truth for backend APIs
- for v1 home-owned fields, it is fed from the manifest path and must not outrank the manifest

## 3. Compatibility readers
Legacy or compatibility readers may read:
- `data/agents/<name>/meta.json`

But only under an explicit rule:
- the mirror is a compatibility export, not a canonical source

## Compatibility-Mirror Responsibilities Only
Stable should narrow the mirror’s allowed responsibilities.

Allowed responsibilities:
- compatibility export for legacy readers
- case-insensitive/fallback local discovery
- operational convenience where code still expects the legacy `data/agents/` tree
- bridge surface while old read paths are still present

Not allowed responsibilities:
- canonical write target
- canonical conflict resolver
- source that outranks `agent.json`
- source that silently repairs or rewrites the manifest

## Stable Decision
Stable should not freeze the mirror as a required long-term peer surface.

### Decision
Demote `data/agents/<name>/meta.json` to a strict compatibility export only.

### Why this is the correct stable decision
Freezing the mirror as a required long-term peer surface would institutionalize duplicate persistence as part of the steady-state architecture.

That is the wrong stable direction because:
- the accepted control-plane work already points to `agent.json` as the home-owned canonical state
- recent accepted fixes were specifically about mirror drift, not about proving the mirror deserves co-equal authority
- making the mirror peer-authoritative would permanently normalize the need to reconcile duplicate state instead of minimizing it

Demoting it to compatibility export only gives stable a cleaner contract:
- canonical v1 truth remains in `agent.json`
- backend row state remains the runtime-serving projection
- the mirror exists only to serve still-necessary legacy readers

## Stable Merge Implication
This decision does not require immediate mirror deletion before stable.

What it does require before a credible `master -> stable` merge decision is:
- the architecture must explicitly state that the mirror is derivative only
- the stable blocker is not “mirror exists”
- the stable blocker is “mirror boundary is not explicit enough”

Once that boundary is explicit, stable can tolerate the mirror as transitional compatibility state without pretending it is part of the long-term canonical model.

## What Must Be True If Stable Accepts This Boundary
If this note’s decision is accepted, the stable contract becomes:
- `agent.json` is canonical for v1 home-owned metadata
- `PATCH /api/agents/:name/home-metadata` is the canonical v1 writer
- provision/reprovision may regenerate the mirror only from the manifest
- backend row state is a runtime-serving derivative projection for v1-owned fields
- `meta.json` is a strict compatibility export only
- no code path may let `meta.json` outrank or repair the manifest implicitly

## Remaining Work After This Design
The highest-value follow-on after this design is not UI work.

It is a narrow implementation/verification slice that enforces the declared boundary by:
- auditing remaining mirror-first readers
- constraining them to explicit compatibility-only use
- proving the canonical manifest remains the writer/reader authority for v1-owned fields

That is the shortest path to removing the biggest remaining stable merge ambiguity after subconscious authority convergence.
