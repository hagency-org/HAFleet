## Current
Coordinate recovery after the worker wrongly disrupted live agent/runtime state during incident handling. Acceptance criteria:
- the worker treats direct live shutdown/kill actions as forbidden unless the operator explicitly orders a maintenance-window stop
- the live web incident and stale-supervisor/public-surface truthfulness lines are delegated to execution agents, not handled by worker-side runtime intervention
- `v1 sync slice-2` remains parked but tracked while the live recovery/truthfulness lane is active
- active reminders remain in place so recovery and follow-up do not EOS

## Queue
1. Resume `v1 manifest/backend sync divergence` slice-2 implementation after the live web incident is triaged and narrowed again.
2. Converge human-maintained agent text fields through staged design/execution: remove `Project Scope` / `Human Notes`; rename `Manual Guidance` to canonical `Guidance`; keep `Owner` first-class and `Identity` one-line and external-facing.
3. Keep the accepted Agent Detail task/Internals takeover design parked behind `v1 sync slice-2`; after that, implement canonical task visibility/editing plus `AGENTS.md`/`plan.md`/`progress.md` tails under `Internals`.
4. Rework supervisor toward the original charter after the current parked structural lines: agent-shaped monitoring state machine, bounded convergent states, repeated-state-triggered intervention through agentchat.
5. Continue periodic `agentchat-aduit` follow-up audits and re-triage any new structural findings before assigning code work.
6. Add a standing residual-runtime hygiene lane: periodically audit orphan/probe tmux sessions, half-started agents, stale supervisor runtimes, and other leftover runtime artifacts; route findings back into triage instead of letting them silently accumulate.
7. Continue durable live backend sweep/tmux fan-out hardening only if new evidence reopens the Matrix timeout class.
8. Perform the operator-owned follow-up for the live `bridge-matrix.service` duplicate-owner path (disable/remove it) once root-capable execution is available.
9. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
10. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
11. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
12. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
13. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
14. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
15. Secure external supervisor event ingest and reducer-based subconscious event flow.
16. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
1. Make Agent Detail expose canonical task editing/visibility and show AGENTS.md / plan.md / progress.md tails under Internals; this lane is now assigned to agentchat-develop because Yato is currently blocked at an interactive prompt.
