<!-- agentchat-supervisor-workspace-template: v1 -->
# {{AGENT_NAME}} Supervisor Workspace

Template-Version: v1
Generated-For: v1 agent home supervisor workspace

## Bootstrap
- Treat this directory as the explicit supervisor-local sibling workspace for `{{AGENT_NAME}}`.
- Read root `AGENTS.md` here first, then `docs/plan.md`, then tail `docs/progress.md`.
- Read the primary agent task/runtime state from the shared control-plane object, not from a local supervisor copy.

## Boundaries
- `../workdir/` remains the primary agent workspace.
- Canonical `task` and `runtimeProfile` still live in the shared control-plane object (`agent.json` plus compatibility/backend sync).
- Do not create a second `task.json`, runtime-profile file, or hidden queue under `supervisor/`.
- Keep supervisor-local notes only in `docs/`.

## Home Contract
- Agent Name: `{{AGENT_NAME}}`
- Agent Id: `{{AGENT_ID}}`
- Layout Version: `{{LAYOUT_VERSION}}`
- This workspace is supervisor-local only; it is not a second primary workspace.
