## Current
Continue narrowing the still-open live Matrix/backend timeout residual after accepting the duplicate-bridge single-owner lock, with the current target being the exact blocking chain inside live `POST /api/messages`.
Acceptance criteria:
- the single-owner lock implementation is committed and pushed as accepted live code
- the quoted Matrix notice is narrowed beyond `submitHumanMessage() -> POST /api/messages` to the exact blocking function chain inside the live request path
- `agentchat-develop` stays scoped only to the timeout residual until the next exact fix-order decision is ready
- v1/control-plane work remains parked while the live timeout residual is still open

## Queue
1. Resume the v1 manifest/backend sync divergence line after the live Matrix duplicate-bridge incident is contained; use the accepted design note as the canonical starting point.
2. Continue narrowing the live Matrix delivery timeout residual (`Message not delivered: backend unreachable`) without guessing whether it is bridge-, backend-, or network-originated.
3. Perform the operator-owned follow-up for the live `bridge-matrix.service` duplicate-owner path (disable/remove it) once root-capable execution is available.
4. Continue durable live backend sweep/tmux fan-out hardening after the P0 recovery.
5. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
6. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
7. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
8. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
9. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
10. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
11. Secure external supervisor event ingest and reducer-based subconscious event flow.
12. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
