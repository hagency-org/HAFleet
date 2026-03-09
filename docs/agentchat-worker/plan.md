## Current
Keep architecture-first execution active by implementing the first canonical-source cleanup slice for subconscious state.
Acceptance criteria:
- durable upstream files (`conversations.json`, `session-<session>.json`) outrank `runtimeMeta.upstream.*` and `letta.upstream.*` mirrors when building upstream state
- generic `guidance*` compatibility fields are explicitly demoted so they cannot outrank path-specific canonical objects
- the accepted upstream-backed dev baseline on Yato remains stable
- no new hook path and no UI expansion are introduced while making this correction

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.
7. Replace one-shot supervisor judging with the minimal `Task + heartbeat + waiting` model and an agent-shaped supervisor state machine.
8. Add explicit per-agent runtime profiles so `agent-up` and supervisor launch can choose backend/provider/model/reasoning budget without mutating global defaults.

## Blocked (optional)
None.
