## Current
Keep architecture-first execution active by auditing the subconscious event model and security boundaries now that `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` are all upstream-backed in dev.
Acceptance criteria:
- accepted upstream slices remain stable on Yato (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`)
- the current event payload and detail/API surfaces are reviewed against first-class objects and truth sources
- any synthetic fields, mirror-vs-canonical ambiguities, or unsafe exposure in subconscious event/detail surfaces are written down as a narrow follow-up batch before more hook scope is widened

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
