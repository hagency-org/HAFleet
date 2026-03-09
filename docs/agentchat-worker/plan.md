## Current
Implement the first minimal supervisor slice around canonical `Task` state, trailing heartbeat classification, and per-agent runtime-profile reads.
Acceptance criteria:
- add canonical per-agent `Task` storage with exactly:
  - `id`
  - `owner`
  - `status`
  - `updated_at`
  - `heartbeat_at`
  - `waiting_reason`
  - `waiting_until`
- backend supervisor derivation reads that object and classifies only:
  - `active`
  - `normal_wait`
  - `stalled_wait`
  - `suspected_eos`
- trailing-window behavior is explicit and bounded
- per-agent runtime-profile reads exist for both primary launch and supervisor launch, with compatibility fallback to existing `model` / `extraArgs`
- existing supervisor route names and stack-global control semantics stay stable
- no hook expansion and no UI expansion in this slice

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
