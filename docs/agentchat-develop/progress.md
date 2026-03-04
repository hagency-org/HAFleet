## [2026-03-04 17:30] DONE — bootstrap personal docs for agentchat-develop
Created and populated:
- docs/agentchat-develop/agents.md
- docs/agentchat-develop/plan.md
- docs/agentchat-develop/progress.md

Set role/boundaries for implementation-focused supervisor audit work and initialized Phase 1 current task.

## [2026-03-04 17:36] DONE — reduced false `SKIPPED` causes in supervisor doc coverage chain
Root causes addressed:
- `supervisor/collector.js` treated `## Boundaries` with immediate `###` subheadings as empty sections, creating false `missing-doc-sections`.
- `scripts/audit-agent-docs.js --active` audited `online=true` agents instead of supervisor candidates (`activeNow + tmux + not blocked`), inflating fail counts.
- Runtime records for auto-discovered agents lacked workspace path hints, so supervisor could resolve docs from wrong roots when `meta.json` path was unavailable.

Changes:
- Hardened heading parsing in `supervisor/collector.js` for markdown heading variants and nested subheadings.
- Updated `scripts/audit-agent-docs.js` to mirror supervisor active-candidate filters and to use API `workspacePath` fallback when meta path is missing.
- Extended runtime pipeline (`lib/push-relay-core.js` + `remote/lib/push-relay-core.js` + `backend-v2.js`) to report/store/serialize `workspacePath`.
- Updated `docs/agent-role-and-scope-editing.md` for the new `--active` semantics.

Verification evidence:
- `node --check` passed for `backend-v2.js`, `supervisor/collector.js`, `scripts/audit-agent-docs.js`, `lib/push-relay-core.js`, `remote/lib/push-relay-core.js`.
- `npm run -s audit:agent-docs -- --active --json` => `total=1 pass=1 fail=0`.
- Targeted collector check now reports:
  - `agentchat-worker`: `hasRole=true hasBoundaries=true hasCurrentTask=true`
  - `agentchat-develop`: `hasRole=true hasBoundaries=true hasCurrentTask=true`
  - `prts`: `hasRole=true hasBoundaries=false hasCurrentTask=true` (real missing boundary section).
