## Current
Await operator review of the completed `master -> stable` merge, live rollout, and default-off configuration changes.
Acceptance criteria:
- `stable` and live stay on the merged code/runtime-split baseline without rollout regressions
- current live/dev default-off behavior is explicit and understood
- any requested post-merge cleanup is handled deliberately rather than mixed into the rollout


## Queue
1. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.
7. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
