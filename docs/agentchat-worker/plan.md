## Current
Design the next minimal supervisor/runtime-profile slice: explicit canonical runtime-profile writer path plus launch-selection closure, without adding a second truth source.
Acceptance criteria:
- one canonical writer path is defined for `runtimeProfile.primary|supervisor.{framework,provider,model,reasoning,extraArgs}`
- the writer updates the existing shared control-plane object rather than introducing a second runtime-profile file
- primary launch and supervisor launch both read the same canonical runtime-profile object
- the design explains how agent and sibling `supervisor/` workspace use the same profile without diverging
- no UI expansion, no hook expansion, no planner/task-system expansion in this slice

## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
