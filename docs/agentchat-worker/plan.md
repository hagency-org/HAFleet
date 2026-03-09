## Current
Design the first real supervisor runtime-launch slice so a sibling supervisor process can be started from canonical lifecycle state without introducing a second truth source.
Acceptance criteria:
- design defines when lifecycle state causes a real sibling supervisor runtime to launch vs remain idle
- design defines how `supervisor/` workspace is used as cwd/home without becoming canonical task/runtimeProfile state
- design defines how canonical `runtimeProfile.supervisor` drives framework/provider/model/args for that launch
- design maps supervisor start/stop/idle decisions onto the accepted lifecycle state machine
- design includes the minimum implementation proof
- no UI expansion, no hook expansion, no orchestration/planning sprawl


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
