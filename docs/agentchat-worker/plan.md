## Current
Coordinate the next clean execution phase after the live incident wave. Acceptance criteria:
- keep worker in chief-coordinator mode: no direct coding/investigation work by worker
- explicitly track executor availability (`agentchat-develop`, `agentchat-aduit`, `Yato`) and repair lanes when they silently disappear
- resume the accepted field-convergence lane now that Agent Detail task/Internals takeover has been accepted and closed
- add and preserve the `agentchat-worker` 1.0 migration lane so the worker itself can move into a real v1 home/workdir/project model without losing docs/history
- keep active reminders in place so execution does not EOS
- keep the accepted field-convergence implementation narrow: no Matrix, supervisor, subconscious, or broad page redesign work mixed in

## Queue
1. Implement the accepted field-convergence slice: remove `Project Scope` / `Human Notes`; rename `Manual Guidance` to canonical `Guidance`; keep `Owner` first-class and `Identity` one-line and external-facing.
2. Resume `v1 manifest/backend sync divergence` follow-up only if the accepted slice-2 reveals new residuals after rollout; otherwise keep it closed.
3. Rework supervisor toward the original charter after the current parked structural lines: agent-shaped monitoring state machine, bounded convergent states, repeated-state-triggered intervention through agentchat.
4. Continue periodic `agentchat-aduit` follow-up audits and re-triage any new structural findings before assigning code work.
5. Add a standing residual-runtime hygiene lane: periodically audit orphan/probe tmux sessions, half-started agents, stale supervisor runtimes, and other leftover runtime artifacts; route findings back into triage instead of letting them silently accumulate.
6. Continue durable live backend sweep/tmux fan-out hardening only if new evidence reopens the Matrix timeout class.
7. Perform the operator-owned follow-up for the live `bridge-matrix.service` duplicate-owner path (disable/remove it) once root-capable execution is available.
8. If requested, clean up leftover proof/probe tmux sessions and temporary isolated backends created during supervisor/subconscious verification.
9. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
10. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
11. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
12. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
13. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
14. Secure external supervisor event ingest and reducer-based subconscious event flow.
15. Harden external dev web auth behavior so credentials-in-URL cannot blank the page by causing relative `fetch()` to fail; either preserve SSR on refresh failure or document/replace the auth flow.
16. Migrate `agentchat-worker` itself to a 1.0 agent home:
    - create a real v1 home/workdir/project
    - move worker docs into that home
    - use latest `AGENTS.md` / `CLAUDE.md`
    - create `handoff.md`
    - use launcher-based cutover (`agentchat up-v1` / `agent-up-v1`), not raw tmux
    - provide operator-ready down/up commands for the cutover
17. Fix the tmux-sweep pane-target regression introduced by the session-only metadata optimization:
    - preserve exact `tmuxTarget` truth
    - keep `tmux-missing:auto` behavior correct when the configured pane disappears but the session still exists
    - prevent session-first metadata aliasing from poisoning pane pid / workspace / scope-memory attribution

## Blocked (optional)
1. `Yato` is currently absent from both tmux and the dev backend object set; keep the UI lane parked or reassigned until a trustworthy UI executor exists.
