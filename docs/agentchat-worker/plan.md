## Current
Drive the `v1 compatibility mirror / duplicate persistence boundary` implementation/verification slice so `master -> stable` is blocked only by explicit, current structural gates.
Acceptance criteria:
- accept or correct the narrow implementation/verification slice that constrains remaining mirror-first readers to explicit compatibility-only use
- verify no code path lets `meta.json` outrank or silently repair `agent.json`
- verify backend row state remains derivative for v1-owned fields
- keep scope architecture-first; no hook expansion, no UI expansion, no generic audit sprawl


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
