## Current
Await explicit operator go-ahead for `master -> stable` now that the default-off change has landed and the accepted structural blockers are closed.
Acceptance criteria:
- merge authorization is explicit rather than inferred
- merge execution follows the accepted hygiene sequence
- any current-runtime overrides that should remain on/off are decided deliberately before branch movement


## Queue
1. If requested before merge, flip explicit dev/runtime env so currently running dev agents also start with `supervisor=off` / `subconscious=off`, rather than only changing fresh-agent defaults.
1. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
2. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
3. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
4. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
5. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
6. Secure external supervisor event ingest and reducer-based subconscious event flow.
7. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
- `master -> stable` merge execution — awaiting explicit operator go-ahead now that no structural blocker remains.
