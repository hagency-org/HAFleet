## Current
Implement the minimal supervisor waiting/trailing slice so `normal_wait`, `stalled_wait`, and `suspected_eos` derive truthfully from canonical task state plus bounded trailing-heartbeat behavior.
Acceptance criteria:
- valid waiting declaration derives `normal_wait`
- expired waiting derives `stalled_wait`
- malformed waiting derives `suspected_eos`
- bounded trailing active-to-idle bridge works without inventing safe state
- active-to-wait transition inside trailing window converges to `normal_wait`
- runtime idle alone cannot create `normal_wait`
- no UI expansion, no hook expansion, no planner/task-system sprawl


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
