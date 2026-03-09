## Current
Define the next minimal supervisor slice: canonical Task writer paths, explicit waiting declarations, sibling `supervisor/` workspace placement, and runtime-profile schema usage after slice-1 acceptance.
Acceptance criteria:
- design note defines the minimal canonical writer paths for `Task` state:
  - who writes `task.id`
  - who refreshes `heartbeat_at`
  - who sets `waiting_reason + waiting_until`
  - who marks `done`
- design note defines how a supervisor workspace lives beside the primary agent workspace (`supervisor/`) without inventing a second hidden state model
- design note fixes the canonical runtime-profile schema and where launchers read it from
- design note keeps existing supervisor route names stable
- no implementation, no hook expansion, no UI expansion in this batch

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
