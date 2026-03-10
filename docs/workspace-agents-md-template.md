<!-- agentchat-workspace-agents-template: v1 -->
## Role
- I am `{{AGENT_NAME}}` and I own work inside this v1 agent home workdir.

## Bootstrap
- Treat root `CLAUDE.md` and root `AGENTS.md` as the workspace entry files for this home.
- Then read `docs/plan.md`.
- Then tail `docs/progress.md`.
- Use `docs/projects.md` when project ownership or workspace contents matter.
- Use `./task-writer` when you need to mutate canonical task state for this workspace.

## Boundaries
- Keep system-owned runtime state under `../state/`.
- Keep support/history docs under `docs/`:
  - `plan.md`
  - `progress.md`
  - `projects.md`
- Keep agent-managed project material under `projects/`.
- Use `scratch/` for throwaway local work.
- Use `inbox/` for staged human/operator inputs or artifacts to process.
- Use `outputs/` for deliverables, reports, and handoff artifacts.
- Treat `data/` as runtime-created tool/cache support data, not the primary source of truth.
- Treat `../supervisor/` as a supervisor-local sibling workspace, not as a second task/runtime-profile source.

## Home Contract
- Agent Name: `{{AGENT_NAME}}`
- Agent Id: `{{AGENT_ID}}`
- Layout Version: `{{LAYOUT_VERSION}}`
- `docs/AGENTS.md` is compatibility-only and should mirror/link back to this root `AGENTS.md`.
