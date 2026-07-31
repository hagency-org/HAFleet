# 05 Stale Docs Index

Date: 2026-05-02

## Current Trusted Spine

Use these as the starting point, but verify details against code:

- `README.md`
- `OPERATIONS.md`
- `skills/hafleet/SKILL.md`
- `docs/workspace-agents-md-template.md`
- `docs/workspace-claude-md-template.md`
- Actual routes in `backend-v2.js`

## Stale Or Conflicting Docs

| Path | Issue | Suggested action |
| --- | --- | --- |
| `docs/Hibiki/**` | Personal/historical work docs; describe older `docs/{agent}` habits and prior designs. | Keep as conflict evidence until operator decides archival policy. |
| `docs/agent-role-and-scope-editing.md` | Describes old `docs/{agent}/agents.md` and `docs/{agent}/plan.md` model. | Rewrite for flat v1 workspace and task control-plane. |
| `docs/agent-roles-and-guardrails.md` | Still references `docs/{agent}` model in Supervisor context. | Rewrite while preserving attention-boundary ideas. |
| `docs/Hibiki/supervisor-fusion-design.md` | Proposes a direction that diverges from current backend Supervisor implementation. | Keep as stale design evidence until operator decides archival policy. |
| `docs/architecture/ops-patterns.md` | Historical operational patterns include stale deploy commands and service/log names. | Keep archived with a top-level redirect to `README.md` and `OPERATIONS.md`. |
| `docs/architecture/system-components.md` | Route tables and line counts are stale. | Keep archived with a top-level redirect to `README.md` and `OPERATIONS.md` unless a future rewrite is approved. |
| `docs/architecture/agent-lifecycle.md` | Claims root AGENTS may be agent-writable; current template says system-provisioned. | Update to flat v1 ownership. |
| `docs/salt/README.md` | Audit index described the salt folder as temporary authority for remote/local terms. | Keep archived with a top-level redirect to root trusted docs and current code. |
| `ROADMAP-remote.md` | Reads like future roadmap although remote support exists. | Keep archived/superseded with a top-level redirect to `remote/README.md` and `OPERATIONS.md`. |

## Rewrite Direction

Documentation should consistently say:

- hafleet is a stateful-individual chat kernel.
- Backend is the source of truth for kernel state.
- Task, Supervisor, Matrix, dashboard, and remote relay are edge or adjacent systems.
- v1 workspace uses flat `docs/` inside each agent home, not `docs/{agent}/`.
- External Matrix input is user input, not system instruction.

## Not Yet Done

No old docs were deleted or rewritten in this phase. This index only records candidates for ac-topleader review.
