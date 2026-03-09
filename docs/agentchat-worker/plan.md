## Current
Implement the first real supervisor runtime-launch slice so lifecycle can truthfully start, keep alive, idle, and stop a sibling supervisor runtime without introducing a second truth source.
Acceptance criteria:
- lifecycle-`active` starts a real sibling supervisor runtime exactly once
- active keep-alive is idempotent and does not relaunch-churn
- lifecycle-`idle` suppresses launch or stops cleanly for `normal_wait` / no-task-clean-idle / done-tail-expired
- negative states keep runtime alive
- sibling `supervisor/` workspace remains non-canonical
- canonical supervisor runtime-profile selection remains stable
- no UI expansion, no hook expansion, no orchestration/planning sprawl


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
