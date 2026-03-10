# `audit:agent-docs --active` Copy-Safe Design

## Scope
Design only for the truthfulness issue in `scripts/audit-agent-docs.js` for `--active` mode under managed-copy / v1-home workflows.

In scope:
- active-set construction
- copy-safe/v1-home-safe audit target resolution
- smallest truthful correction
- proof strategy and blast-radius analysis

Out of scope:
- docs parsing rules themselves
- supervisor runtime behavior
- UI/routes
- subconscious or Matrix/bridge work

## Current Problem
In `scripts/audit-agent-docs.js`:
- `collectAllAgentNames()` starts from `data/agents/*`
- `--active` fetches live API rows from `/api/agents`
- but it only intersects the active API names with the names already discovered from `data/agents/*`

That means an active managed-copy / v1-home agent can be silently excluded from the audit if:
- it exists in the live API snapshot
- it has a valid v1 home / manifest / workdir docs
- but it does not yet have the expected compatibility mirror directory under `data/agents/<name>/`

The result can be a false `total=0` or undercounted audit set even though active auditable agents exist.

## Root Cause
The active audit currently treats the legacy compatibility mirror directory as the primary source of candidate identity.

That is not truthful for the current accepted layout because:
- v1 home truth is `agent.json` / v1 manifest
- managed-copy workflows can be auditable through manifest/workdir docs even when the compatibility mirror is absent or incomplete
- `--active` is supposed to audit the current active agent set, not only active agents that also happen to have a mirror directory

## Design Goal
Make `audit:agent-docs --active` truthful for the current accepted managed-copy / v1-home world.

The smallest acceptable outcome is:
- if an agent is active in the live API snapshot and has auditable docs through v1 manifest/workdir or legacy workspace paths, it is included in the active audit candidate set
- `data/agents/*` remains a compatibility source, not the gating identity source for active audits

## Smallest Correction Model
For `--active` mode:
1. Use the live API active set as the canonical candidate-name source.
2. Do not intersect it with `collectAllAgentNames()`.
3. For each active API row, resolve docs using the existing `loadMeta()` / `resolveV1ManifestForAgent()` / `resolveAgentDocsPaths()` chain.
4. Keep non-`--active` mode behavior unchanged unless needed later.

## Canonical Boundary
The canonical source of candidate identity for `--active` should be:
- `/api/agents` active rows

Reasoning:
- `--active` is explicitly a live-scope audit
- the API snapshot already carries the accepted active filters and runtime identity
- docs resolution can then use mirror, manifest, and workspace fallbacks exactly as it already does per agent

`data/agents/*` should remain only:
- a metadata compatibility input for one agent's docs resolution
- not the authoritative list of which active agents exist

## Why This Is The Smallest Fix
It avoids reopening parser behavior or changing docs discovery semantics.

It changes only:
- how the candidate name list is built in `--active` mode

Everything else can stay:
- current docs extraction
- current section checks
- current JSON/table output shape
- current exit behavior

## Non-Recommended Alternative
### Keep `data/agents/*` as the candidate source and try to backfill missing names
Rejected because it preserves the wrong authority boundary and keeps active-audit truth dependent on compatibility mirror presence.

### Change all audit modes to API-first immediately
Rejected for the first slice because only `--active` is under current audit scope and non-active inventory mode may intentionally remain runtime-root based.

## Proof Strategy
A later implementation should prove all of these:

1. Active v1-home without mirror directory
- an active API agent with valid v1 manifest/workdir docs but no `data/agents/<name>/` directory is still included in `--active`

2. Managed-copy active agent
- an active managed-copy/v1-home agent with docs under its copied workdir is audited successfully

3. Legacy mirrored agent still works
- an active legacy/mirrored agent is still included and audited as before

4. Honest zero case
- `total=0` happens only when the live active API set is truly empty or all active agents genuinely lack resolvable docs

5. Non-active mode stability
- plain `audit:agent-docs` behavior remains unchanged

## Blast-Radius Assessment
Expected implementation blast radius is narrow:
- `scripts/audit-agent-docs.js` active candidate-name selection

Expected non-impacts:
- no supervisor behavior changes
- no route changes
- no UI changes
- no docs parser changes
- no subconscious / Matrix effects

## Resulting Recommendation
The next implementation slice should:
- make `--active` candidate identity API-first
- keep mirror/manifest/workspace logic only as per-agent docs resolution inputs
- leave non-`--active` inventory behavior unchanged
