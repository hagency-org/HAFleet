# RuntimeProfile Writer And Launch-Selection Design

## Scope
This batch is design only for the next minimal supervisor slice.

It covers only:
- the single canonical writer path for `runtimeProfile`
- how primary launch and sibling supervisor launch both read the same canonical object
- compatibility fallback from legacy launch fields
- keeping existing route names stable

Out of scope:
- implementation
- UI expansion
- hook expansion
- new supervisor routes
- a second runtime-profile file in `workdir/` or `supervisor/`

## Canonical Object
The accepted runtime-profile object stays:

```json
{
  "primary": {
    "framework": "string | null",
    "provider": "string | null",
    "model": "string | null",
    "reasoning": "string | null",
    "extraArgs": "string | null"
  },
  "supervisor": {
    "framework": "string | null",
    "provider": "string | null",
    "model": "string | null",
    "reasoning": "string | null",
    "extraArgs": "string | null"
  }
}
```

Rules:
- `primary` and `supervisor` are the only canonical role keys in this slice.
- `reasoning` is canonical; `reasoningProfile` is not.
- `extraArgs` stays a single string field.
- `runtimeProfile` remains a peer of `task` in the same agent control-plane object.

## Single Canonical Writer Model
There should be one writer model, not one file per launcher.

Rule:
- the primary control-plane writer is the only canonical writer for `runtimeProfile`
- primary launch and supervisor launch are both canonical readers
- the sibling `supervisor/` workspace must not write or shadow a second runtime-profile file

This mirrors the accepted task-state model:
- writer lives in the primary/control-plane path
- launchers consume the same persisted object
- supervisor-local docs stay local only

## Canonical Writer Paths
The writer split should stay aligned with the already accepted control-plane split.

### Live Backend-Control Plane
Canonical writer:
- `backend-v2.js`
- `POST /api/agents`
- `PATCH /api/agents/:name`

Canonical persisted state:
- runtime `data/agents.json`

Use:
- live/local runtime agent registration
- non-v1 agent updates
- supervisor runtime reads

### V1 Home-Control Plane
Canonical writer:
- `server.js`
- `PATCH /api/agents/:name/home-metadata`

Canonical persisted state:
- v1 manifest `agent.json`

Compatibility mirrors:
- runtime `data/agents/<name>/meta.json`
- backend `data/agents.json` via sync

Rule:
- `agent.json` remains the canonical v1 runtime-profile file
- mirrors exist only for compatibility/runtime visibility
- no second runtime-profile file should appear under `workdir/` or `supervisor/`

## Explicit Writer Surface
The design goal is to make runtime-profile mutation explicit without creating a second truth source.

Minimal direction:
- any future agent/operator-facing runtime-profile writer must be a thin surface over the existing canonical writer path
- for v1 homes, that means the future writer should call `PATCH /api/agents/:name/home-metadata`
- for live/non-v1 runtime state, the writer remains `POST/PATCH /api/agents`

Non-goals:
- no `workdir/runtime-profile.json`
- no `supervisor/runtime-profile.json`
- no launcher-owned writeback file
- no direct launcher mutation of the canonical object during startup

## Primary Launch Read Path
Primary launch reader stays:
- `bin/agent-up`

Canonical read behavior:
1. read `runtimeProfile.primary`
2. use `framework` to choose the primary runtime (`claude` vs `codex`)
3. use `model` and `extraArgs` for primary launch selection
4. carry `provider` and `reasoning` as canonical profile data even if the current primary launcher does not execute every field directly yet
5. fall back to legacy `type/model/extraArgs` only when `runtimeProfile.primary` is absent

Why this stays correct:
- launch selection comes from one persisted object
- legacy fields remain compatibility inputs, not a second first-class model
- primary launch does not need a private per-launch config file

## Supervisor Launch Read Path
Supervisor launch readers stay:
- `bin/agent-up` when exporting agent-scoped supervisor env
- `supervisor/config.js` when loading the supervisor runtime config

Canonical read behavior:
1. read `runtimeProfile.supervisor`
2. export/derive supervisor launch env from that role object only
3. `supervisor/config.js` reads the same role object through `AGENTCHAT_RUNTIME_PROFILE_SUPERVISOR_JSON`
4. compatibility env (`SUPERVISOR_LLM_PROVIDER`, `SUPERVISOR_LLM_MODEL`, `AGENTCHAT_SUPERVISOR_REASONING_PROFILE`, `AGENTCHAT_SUPERVISOR_FRAMEWORK`, `AGENTCHAT_SUPERVISOR_EXTRA_ARGS`) remain transport for the same object, not a second truth source

Rule:
- the sibling `supervisor/` workspace may observe or document the chosen profile, but it must not originate a separate supervisor-only runtime-profile file

## Launch-Selection Closure
The remaining ambiguity to close is not object shape, but selection precedence.

Accepted precedence:
1. canonical `runtimeProfile.<role>`
2. compatibility fallback from legacy launch fields only when the canonical role object is absent
3. process defaults only when neither canonical nor compatibility fields exist

Implications:
- `runtimeProfile.primary.framework` outranks legacy `type`
- `runtimeProfile.primary.model` outranks legacy `model`
- `runtimeProfile.primary.extraArgs` outranks legacy `extraArgs`
- `runtimeProfile.supervisor.*` outranks generic supervisor env defaults
- launcher defaults remain defaults, not stored agent choices

## No Second Truth Source In `supervisor/`
The sibling supervisor workspace is explicit, but it is not a second config plane.

Rules:
- `supervisor/` may keep local plan/progress notes about supervision
- `supervisor/` must not keep canonical runtime-profile state
- `supervisor/` must read the primary agent's existing canonical `runtimeProfile`
- supervisor-local overrides, if ever introduced later, must still write back to the same canonical control-plane object rather than a local supervisor file

## Stable Route Surface
This slice should keep route names stable.

No route rename is needed for the design:
- `POST /api/agents`
- `PATCH /api/agents/:name`
- `PATCH /api/agents/:name/home-metadata`
- existing supervisor routes remain unchanged:
  - `GET /api/supervisor/status`
  - `GET /api/supervisor/agents`
  - `GET /api/supervisor/agents/:name`
  - `GET /api/supervisor/control`
  - `POST /api/supervisor/control`

## Minimal Follow-On Implementation Boundary
The smallest useful implementation after this design should be:
1. add one explicit runtime-profile writer surface for v1 homes that calls the existing canonical home-metadata writer
2. keep `runtimeProfile` stored only in the existing control-plane object
3. keep `bin/agent-up` and `supervisor/config.js` as readers of that same object
4. preserve the current route names and compatibility fallback rules

This closes the runtime-profile writer question without turning launch selection into a second config system.
