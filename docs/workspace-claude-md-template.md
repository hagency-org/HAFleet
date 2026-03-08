<!-- agentchat-workspace-template: v1 -->
# {{AGENT_NAME}} Workspace

Template-Version: v1
Generated-For: v1 agent home workspace

This file is the maintained Claude workspace instruction set for this agent home.
Provisioning renders it from `docs/workspace-claude-md-template.md`.

## Bootstrap
- Read root `AGENTS.md` first on every resume or new session.
- Then read `docs/plan.md`.
- Then tail `docs/progress.md`.
- Use `docs/projects.md` when project ownership or workspace contents matter.

## Workspace Layout
- `AGENTS.md`
  - Root workspace entry file for role/boundary/bootstrap rules in this home.
- `docs/`
  - Support/history docs for this home.
  - Main files: `plan.md`, `progress.md`, `projects.md`.
  - `docs/CLAUDE.md` and `docs/AGENTS.md` are compatibility mirrors/links back to the root entry files.
- `projects/`
  - Agent-owned project checkouts or copied material managed through provisioning.
- `scratch/`
  - Throwaway local work, notes, or intermediate files.
- `inbox/`
  - Human/operator-provided inputs, staged requests, or artifacts to process.
- `outputs/`
  - Deliverables, reports, generated bundles, or handoff artifacts.
- `data/`
  - Runtime-created workspace-local caches or tool artifacts such as media cache.
  - Treat as system/tool-managed support data, not the primary source of truth.
- `../state/`
  - System-owned runtime state for this home.
  - Avoid manual edits unless the task explicitly requires it.

## Working Rules
- Root-cause first. Do not hide failures with local placeholders or silent fallbacks.
- Verify changes with commands, logs, API checks, or file inspection before marking work done.
- Keep changes minimal and scoped to the active task.
- Record durable knowledge in root `AGENTS.md`.
- Record task progress only in `docs/progress.md`.

## Home Contract
- Agent Name: `{{AGENT_NAME}}`
- Agent Id: `{{AGENT_ID}}`
- Layout Version: `{{LAYOUT_VERSION}}`
- This workspace uses the flat v1 home docs model: `workdir/docs/`, not `docs/{agent}/`.
