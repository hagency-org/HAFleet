## Current
Drive the next minimal upstream Letta hook cutover now that workspace/project discipline is closed: pick and land the `UserPromptSubmit` slice before reopening broader UI or benchmark scope.
Acceptance criteria:
- the accepted Letta baselines remain stable (`SessionStart` notify returns cleanly and `Stop` remains upstream-backed with truthful observability)
- `UserPromptSubmit` is cut over in dev as the next real upstream-backed path, with truthful observability and no false parity claims
- Yato workspace/project discipline remains intact while the new hook slice lands

## Queue
1. Continue with `PreToolUse` only after `UserPromptSubmit` is accepted and its latency/visibility tradeoffs are understood.
2. Start benchmark Batch 4 (result UI) once the next Letta hook-cutover slice is stable enough not to churn the dev control-plane.
3. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
4. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
5. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs).
6. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
