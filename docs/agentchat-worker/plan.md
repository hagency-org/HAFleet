## Current
Await operator go-ahead for `master -> stable` execution now that the accepted architecture baseline, maturity classification, and merge-execution hygiene plan are all in place.
Acceptance criteria:
- the accepted merge-execution hygiene plan is recorded as the final pre-merge plan
- no unproven new blocker is reopened without route/proof-level evidence
- once operator gives the merge go-ahead, execute the stable merge using the accepted hygiene sequence only


## Queue
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
- `master -> stable` merge execution — awaiting explicit operator go-ahead now that no structural blocker remains.
