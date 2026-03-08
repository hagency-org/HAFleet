## Current
Finish the upstream SessionStart notify/send cutover after clearing the `GLM-5` model-handle mismatch: normalize Letta model aliases to canonical handles and remove the remaining successful-send return-path hang/latency so `sendMessage:true` completes truthfully over HTTP.
Acceptance criteria:
- current closure loop stays closed (no reopened Yato/webdebug/browser regressions)
- dev uses canonical Letta model config (`zai/glm-5`) rather than regressing the bound agent back to raw alias `GLM-5`
- one real `sendMessage:true` proof both sends successfully and returns cleanly from `/api/subconscious/upstream/session-start/:name` without hanging or timing out

## Queue
1. Start benchmark Batch 4 (result UI) once the next Letta blocker decision is made.
2. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
3. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
4. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs).
5. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
