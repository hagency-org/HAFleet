## Current
Close the agent-workspace discipline gap in parallel with the next Letta cutover slice: refine `workspace-claude-md-template.md` into a short high-density contract and prove Yato works from a real project under `workdir/projects/` instead of implicitly working against the main repo.
Acceptance criteria:
- the accepted Letta baselines remain stable (`SessionStart` notify returns cleanly and `Stop` remains upstream-backed with truthful observability)
- `workspace-claude-md-template.md` is rewritten as a short, high-density workspace contract that explicitly teaches project/workdir discipline
- Yato gets a real managed `agent-chat` project under its own `workdir/projects/`
- one concrete validation shows the expected working path is Yato's own project copy/worktree rather than the main repo root

## Queue
1. Continue the next minimal upstream hook cutover after the workspace/project discipline closure is in place (`UserPromptSubmit` vs `PreToolUse`, with `Stop` now accepted).
2. Start benchmark Batch 4 (result UI) once the next Letta hook-cutover slice is stable enough not to churn the dev control-plane.
3. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
4. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
5. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs).
6. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
