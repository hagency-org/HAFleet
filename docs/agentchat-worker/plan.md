## Current
Advance upstream Letta execution beyond the accepted SessionStart baseline: choose and implement the next minimal live path cut from local transitional logic into real upstream flow (`UserPromptSubmit`, `PreToolUse`, or `Stop`) without reopening settled UI/workspace/project work.
Acceptance criteria:
- the SessionStart baseline remains stable (`sendMessage:true` still returns cleanly and leaves `notify.status=sent`)
- one exact next hook-path slice is selected and bounded by root cause, not by broad parity claims
- docs reflect that the old `GLM-5 model-unknown` blocker and the successful-send return-path bug are both closed

## Queue
1. Start benchmark Batch 4 (result UI) once the next Letta hook-cutover slice is stable enough not to churn the dev control-plane.
2. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
3. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
4. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs).
5. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
