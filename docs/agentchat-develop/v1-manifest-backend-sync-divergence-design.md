# v1 Manifest / Backend Sync Divergence Design

## Scope
Design only. This note isolates the remaining structural divergence risk between canonical v1 home state and the runtime-serving backend state after the prior mirror-reader and PATCH->POST fallback fixes.

Out of scope:
- UI changes
- hook or subconscious changes
- Matrix / bridge residuals
- implementation

## Current Canonical And Derived Surfaces

### Canonical writer for v1-owned home state
`server.js` `PATCH /api/agents/:name/home-metadata`

Write order today:
1. load canonical v1 manifest with `loadV1Manifest()` -> `resolveV1ManifestForAgent()`
2. write `agent.json` via `writeV1Manifest()`
3. export compatibility mirror via `syncLocalAgentMetaFromManifest()` to `data/agents/<name>/meta.json`
4. best-effort backend row sync via `syncBackendAgentHomeState()` (`PATCH /api/agents/:name`, then `POST /api/agents` on `404`)

Canonical file:
- `<homeDir>/agent.json`

V1-owned fields in scope:
- `agentModelVersion`
- `layoutVersion`
- `agentId`
- `homeDir`
- `workdir`
- `stateDir`
- `subconsciousEnabled`
- `managedProjects`
- `human`
- `task`
- `runtimeProfile`

### Canonical reader for served v1 detail/control-plane in web
`server.js`
- `loadV1Manifest()` / `resolveV1ManifestForAgent()`
- `/api/agents/detail/:name`
- `/api/agents/:name/home-metadata`
- v1 projects/workspace routes

Current precedence for served detail is effectively:
1. backend row for generic runtime fields
2. `meta.json` as fallback
3. v1 `agent.json` overrides for v1-owned fields

That means the served v1 detail route is already mostly manifest-first for v1-owned fields.

### Derived compatibility/runtime-serving surfaces
Compatibility export:
- `data/agents/<name>/meta.json`
- writer: `syncLocalAgentMetaFromManifest()` and `scripts/provision-v1-agent-home.js` `syncLegacyMeta()`

Backend runtime-serving row:
- backend in-memory `agents[agentName]`
- persisted `data/agents.json`
- writers: backend `POST /api/agents`, `PATCH /api/agents/:name`
- sync caller for v1 home metadata writes: `server.js` `syncBackendAgentHomeState()`

Supervisor/runtime consumers that still depend on derived state:
- `backend-v2.js` `/api/agents`, `/api/agents/:name`
- supervisor service reading backend agent rows
- `bin/agent-up` reading `data/agents/<name>/meta.json` for launch defaults and runtime profile

## Remaining Real Divergence Points

### 1. Web write success is decoupled from backend row convergence
`syncBackendAgentHomeState()` is still best-effort and success-opaque.

Current behavior:
- if backend `PATCH` returns `404`, web tries `POST`
- if backend `PATCH` returns any other non-OK status, the function just returns
- if backend `POST` returns non-OK, the function also just returns
- exceptions are swallowed
- caller routes still return `200 ok:true`

Structural effect:
- `agent.json` and `meta.json` can be updated while backend `agents[]` / `data/agents.json` stays stale
- the operator gets a success response even though supervisor/runtime-serving state did not converge

Affected flows:
- `/api/agents/:name/home-metadata`
- v1 project import/remove routes after reprovision/reload
- workspace migration route after reprovision/reload

### 2. PATCH->POST fallback still lacks verified upsert convergence
The prior fix closed the fresh-home `PATCH 404` hole, but the upsert boundary still is not verified.

Residual gaps:
- no check that `POST /api/agents` actually succeeded semantically
- no readback/compare after PATCH or POST
- no returned sync status to the web caller
- no durable marker that backend row is stale vs manifest

Structural effect:
- fresh-home registration can still partially succeed from the web point of view while backend state remains absent or partially normalized differently than the manifest

### 3. Direct provision/reprovision remains an out-of-band writer for derived state
`scripts/provision-v1-agent-home.js` writes:
- canonical `agent.json`
- compatibility `meta.json`

It does not update the backend row directly.

This is safe only when provisioning is wrapped by a web route that reloads the manifest and then calls `syncBackendAgentHomeState()`.

Residual divergence case:
- direct CLI provision/reprovision updates home files but leaves backend `agents[]` / `data/agents.json` stale until a later explicit sync path runs

### 4. Runtime launch still trusts the compatibility mirror, not the manifest
`bin/agent-up` still loads launch defaults and runtime-profile data from:
- `data/agents/<name>/meta.json`

It only consults `<homeDir>/agent.json` for a narrow subconscious-enabled fallback.

Structural effect:
- even after manifest-first reader enforcement for web detail, a stale `meta.json` can still drive incorrect launch path, model, runtime profile, or workspace selection
- this creates a second effective read authority for runtime launch, even though `agent.json` is supposed to be canonical for v1-owned state

### 5. Supervisor correctness still depends on backend-row freshness
Supervisor classification/lifecycle now uses canonical `task` semantics, but the supervisor service reads those semantics from backend agent rows, not directly from `agent.json`.

Structural effect:
- if manifest write succeeds and backend sync silently fails, the accepted supervisor model can still observe stale `task` / `runtimeProfile` until some later sync repairs the row
- this is a true runtime-serving divergence, not just a display mismatch

## What Is Already Closed
These earlier fixes reduce but do not eliminate the structural boundary:
- v1 served detail is manifest-first for v1-owned fields
- fresh-home sync now attempts `PATCH` then `POST`
- compatibility mirror sync now writes `meta.json` during provision/reprovision and home-metadata changes
- manifest resolution is name-first, not `meta.homeDir` first

Those fixes improved read precedence and first-time registration, but they did not make the derived backend row converge transactionally or observably.

## Smallest Correction Order

### Step 1. Make backend sync result explicit at the canonical writer boundary
At `server.js` `PATCH /api/agents/:name/home-metadata` and the v1 reprovision-backed routes:
- stop treating backend sync as silently successful
- return explicit backend sync status (`synced`, `created`, `failed`, `stale`) alongside the local manifest write result
- log the exact failure mode for non-OK PATCH/POST and transport errors

Why first:
- it closes the current false-success contract without changing reader topology yet
- it gives operators and later code a truthful convergence signal

### Step 2. Add verified backend upsert convergence
For the v1 -> backend sync path:
- perform one canonical upsert flow
- verify final backend row matches the manifest-owned fields after write
- fail loud or mark stale when it does not

Why second:
- Step 1 makes failure visible; Step 2 removes the partial-success hole itself

### Step 3. Demote `meta.json` to a strict launch/export cache, not an independent reader authority
Narrow launch-side correction:
- `bin/agent-up` should prefer `agent.json` for v1-owned fields when a v1 home exists
- `meta.json` should remain only compatibility/export/cache

Why third:
- this removes the remaining runtime-launch second reader authority after the backend upsert boundary is truthful

### Step 4. Decide whether backend row staleness should be blocking or self-healing for supervisor-serving routes
After Steps 1-3, decide the stable rule:
- either backend row freshness is mandatory before returning success from v1 writes
- or backend row may lag briefly, but routes/supervisor must expose an explicit stale-derived-state marker

Why last:
- this is a policy decision once the writer boundary and launch reader boundary are already explicit

## Non-goals For The First Correction Slice
- do not remove `meta.json` yet
- do not move supervisor to read manifests directly
- do not change UI surfaces
- do not mix this with Matrix/bridge timeout work
- do not refactor provisioning beyond the sync boundary

## Minimum Proof Required For Later Implementation
- manifest write succeeds + backend sync fails -> route must no longer claim clean success
- fresh-home path proves real verified backend creation, not just attempted POST fallback
- direct reprovision wrapped by web route proves `agent.json`, `meta.json`, backend row, and supervisor-visible task/runtimeProfile all converge
- `agent-up` launch proof shows v1 launch reads canonical manifest-owned runtime profile even if `meta.json` is stale
