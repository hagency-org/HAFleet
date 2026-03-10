## Current
Freeze the supervisor charter back to the original design intent before any further supervisor implementation: a monitoring agent for the primary agent, not a generic rule-summary engine. Acceptance criteria:
- the durable contract states that supervisor's job is to detect EOS, drift, unfinished work, and guideline violations against the primary agent
- the durable contract states that supervisor emits one convergent state from a bounded state set and uses repeated identical states as the trigger for intervention/escalation
- the durable contract states that intervention is delivered through agentchat (`send_message`, later optional force path), not by inventing a second hidden control channel
- further supervisor implementation is treated as paused until this charter is aligned in worker docs and queued for execution in the right order

## Queue
1. Resume the parked `v1 manifest/backend sync divergence` line after the supervisor charter correction is frozen; use the accepted design note as the canonical starting point.
2. Converge human-maintained agent text fields: remove `Project Scope` / `Human Notes`; rename `Manual Guidance` to canonical `Guidance` as the shared human-authored intent surface for agent/supervisor/subconscious; keep `Owner` as a first-class ownership field and `Identity` as the one-line external-facing agent description while keeping `CLAUDE.md` as workflow/behavior contract.
3. Make Agent Detail expose canonical task visibility/editing and show `AGENTS.md`, `plan.md`, and `progress.md` tails under `Internals`, either through Yato or an explicit replacement executor.
4. Continue durable live backend sweep/tmux fan-out hardening after the P0 recovery if new evidence reopens the Matrix timeout class.
5. Perform the operator-owned follow-up for the live `bridge-matrix.service` duplicate-owner path (disable/remove it) once root-capable execution is available.
6. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
7. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
8. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
9. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
10. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
11. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
12. Secure external supervisor event ingest and reducer-based subconscious event flow.
13. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.

## Blocked (optional)
1. Make Agent Detail expose canonical task editing/visibility and show AGENTS.md / plan.md / progress.md tails under Internals; prefer Yato for the frontend pass if Yato is schedulable, otherwise hand it to agentchat-develop without delaying the live Matrix residual.
