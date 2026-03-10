## Current
Fix the live root-page agent summary path for `agentchat-worker` so the card no longer sticks on `Loading summary...`.
Acceptance criteria:
- live root card for `agentchat-worker` renders a real summary instead of indefinite loading
- root cause is identified and recorded
- any code fix is verified on live browser/API behavior without regressing other agent cards

## Queue
1. Continue durable live backend sweep/tmux fan-out hardening after the P0 recovery.
2. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
3. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
4. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
5. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
6. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
7. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
8. Secure external supervisor event ingest and reducer-based subconscious event flow.
9. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
