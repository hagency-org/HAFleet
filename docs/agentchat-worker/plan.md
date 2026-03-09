## Current
Implement the next minimal runtime-profile slice: explicit v1 writer surface plus canonical launch-selection closure, without introducing a second truth source.
Acceptance criteria:
- one explicit v1 writer surface exists for `runtimeProfile.primary|supervisor.{framework,provider,model,reasoning,extraArgs}`
- that writer goes through the existing canonical home-metadata path rather than creating a `workdir/runtime-profile.json` or `supervisor/runtime-profile.json`
- primary launch and supervisor launch both read the same canonical runtime-profile object
- launch-selection precedence is explicit and verified:
  - canonical role object
  - legacy compatibility fields only if canonical role object is absent
  - process defaults only if neither exists
- existing route names stay stable
- no UI expansion and no hook expansion in this slice


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
