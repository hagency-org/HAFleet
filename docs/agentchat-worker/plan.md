## Current
Reset active execution to architecture-first mode: formalize the first-class object model and truth-source boundaries, then drive the next upstream Letta `UserPromptSubmit` cutover under those constraints.
Acceptance criteria:
- `system-architecture-convergence.md` exists as the active architecture contract for dev work
- `agentchat-develop`, `Yato`, and `webdebug` are all re-tasked against that contract
- the accepted Letta baselines remain stable (`SessionStart` notify returns cleanly and `Stop` remains upstream-backed with truthful observability)
- `UserPromptSubmit` proceeds only as a first-class-object cutover, with truthful observability and no false parity claims

## Queue
1. Continue with `PreToolUse` only after `UserPromptSubmit` is accepted and its latency/visibility tradeoffs are understood.
2. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
3. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
4. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
5. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
6. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
7. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
