## Current
Run the stable-merge readiness audit for supervisor/subconscious/runtime-profile after supervisor runtime-launch acceptance, and cut the next batch only from remaining structural blockers.
Acceptance criteria:
- independently verify the accepted supervisor runtime-launch slice and record the exact accepted boundary
- enumerate remaining structural blockers for merging `master` into `stable` without regressing supervisor or subconscious truthfulness
- assign the next narrow batch to `agentchat-develop` from that blocker list
- keep scope architecture-first; do not reopen UI/hook expansion unless the audit proves it is required


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
