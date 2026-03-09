## Current
Implement the next minimal supervisor slice: explicit primary task-writer path plus sibling `supervisor/` workspace scaffolding, without introducing a second truth source.
Acceptance criteria:
- one explicit primary-agent task-writer path exists for:
  - `task.id`
  - `heartbeat_at`
  - `waiting_reason`
  - `waiting_until`
  - `done`
- the writer updates the existing canonical control-plane state rather than creating a second `task.json`
- sibling `supervisor/` workspace scaffold exists beside the primary workspace with:
  - `supervisor/CLAUDE.md`
  - `supervisor/AGENTS.md`
  - `supervisor/docs/plan.md`
  - `supervisor/docs/progress.md`
- runtime-profile schema usage stays on the accepted string-based role schema:
  - `runtimeProfile.primary|supervisor.{framework,provider,model,reasoning,extraArgs}`
- existing supervisor route names stay stable
- no UI expansion and no hook expansion in this slice

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
