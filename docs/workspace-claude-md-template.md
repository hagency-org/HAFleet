<!-- agentchat-workspace-template: v1 -->
# {{AGENT_NAME}} Workspace

Template-Version: v1
Generated-For: v1 agent home workspace

## Bootstrap
- Read root `AGENTS.md` first on every resume or new session.
- Then read `docs/plan.md`, then tail `docs/progress.md`.
- Check `docs/projects.md` to know which project you own and where its code lives.

## Where to work

Your CWD is `workdir/`. This is your coordination root, not a codebase.

**Code edits** go in the managed project under `projects/<name>/`. That directory is either a copy or a symlink of a source repo. Know which:
- **copy**: you own this tree. Edit, commit, and test here. Changes do not propagate to the source repo.
- **symlink**: edits here ARE edits to the source repo. Be aware of that when committing.

If the operator asks you to edit the source repo directly (outside your home), do so — but never confuse your `projects/` copy with the source. Run `readlink projects/<name>` or check `docs/projects.md` to know which model applies.

**Do not** create long-lived code, scripts, or project files in the workspace root, `scratch/`, or `docs/`. Those are coordination surfaces, not code trees.

## Directory contract

| Path | Purpose | Agent writes? |
|------|---------|--------------|
| `projects/` | Managed project trees (code, tests, git) | Yes — primary work area |
| `docs/` | `plan.md`, `progress.md`, `projects.md` | Yes — coordination only |
| `scratch/` | Throwaway probes, temp files, one-off scripts | Yes — nothing durable |
| `inbox/` | Operator-staged inputs for processing | Read only |
| `outputs/` | Deliverables, reports, handoff bundles | Yes — write when producing artifacts |
| `data/` | Runtime tool caches (e.g. mcp-media-cache) | Managed by tools, not by agent |
| `.claude/` | Claude settings, subconscious hook config | Managed by system; read for debugging |
| `../state/` | Runtime state: subconscious events, locks, resume-id, letta | System-owned — do not edit |
| Root `AGENTS.md` | Durable role/boundary rules | Yes — append learned rules here |
| Root `CLAUDE.md` | This file (workspace contract) | No — provisioned by system |

## Working rules
- Record durable knowledge in root `AGENTS.md`.
- Record task progress in `docs/progress.md`.
- Verify changes from the path you actually edited, not from a different copy of the same file.
- Root-cause first. Do not hide failures with local placeholders or silent fallbacks.
- Keep changes minimal and scoped to the active task.

## Home Contract
- Agent Name: `{{AGENT_NAME}}`
- Agent Id: `{{AGENT_ID}}`
- Layout Version: `{{LAYOUT_VERSION}}`
- Docs model: flat v1 — `workdir/docs/`, not `docs/{agent}/`.
