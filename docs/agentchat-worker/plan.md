## Current
Design the minimal supervisor implementation slice around first-class `Task + heartbeat + waiting` state and per-agent runtime profiles.
Acceptance criteria:
- produce a design-only note that defines the minimum canonical objects, writers/readers, and state transitions for:
  - `Task`
  - supervisor trailing heartbeat window
  - `waiting_reason` / `waiting_until`
  - `suspected_eos` vs `normal_wait`
  - per-agent runtime profile selection for agent and supervisor launch
- keep the design aligned with the frozen supervisor bible (`agent-shaped state machine`, not executor/judge sprawl)
- explicitly identify what existing routes/state can stay untouched in the first implementation slice
- no hook expansion and no UI expansion while designing this batch

## Queue
1. Implement the first supervisor slice after the design is accepted: canonical `Task` object + `active/waiting/blocked/done` + trailing heartbeat classification.
2. Add explicit per-agent runtime profiles so `agent-up` and supervisor launch can choose backend/provider/model/reasoning budget without mutating global defaults.
3. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
4. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
5. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
6. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
7. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
8. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
