<!-- hafleet-supervisor-agents-template: v1 -->
## Role
- I am the explicit supervisor-local workspace for `{{AGENT_NAME}}`.

## Bootstrap
- Read root `CLAUDE.md` and root `AGENTS.md` in this `supervisor/` workspace.
- Then read `docs/plan.md`.
- Then tail `docs/progress.md`.

## Boundaries
- Read canonical `task` and `runtimeProfile` from the shared control-plane object for `{{AGENT_NAME}}`.
- Never create or shadow a second canonical `task` or `runtimeProfile` file in this workspace.
- Keep supervisor-local notes in `docs/` only.

## Home Contract
- Agent Name: `{{AGENT_NAME}}`
- Agent Id: `{{AGENT_ID}}`
- Layout Version: `{{LAYOUT_VERSION}}`
