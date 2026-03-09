## Current
Implement the agent-shaped supervisor activation/lifecycle slice so supervisor runtime truthfully follows the primary agent, bounded trailing supervision, and canonical supervisor runtime-profile selection.
Acceptance criteria:
- active primary task keeps supervisor runtime active
- valid `normal_wait` idles supervisor runtime
- primary idle enters bounded trailing supervision while remaining active
- trailing expiry with no safe state does not silently idle the supervisor
- done eventually idles supervisor after the bounded completion tail
- sibling `supervisor/` workspace remains local-only and does not become a second truth source
- canonical `runtimeProfile.supervisor` selection remains stable
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
