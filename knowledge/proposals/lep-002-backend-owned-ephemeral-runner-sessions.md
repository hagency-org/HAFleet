---
kind: proposal
id: LEP-002
title: "Backend-owned thread sessions with ephemeral runners"
status: Accepted
liveness: n/a
tags: [sessions, matrix, threads, runtime, runner, isolation]
---

## Context

LEP-001 / ADR-010 attacked thread cross-contamination with hibernating
per-thread tmux sessions. The prototype (`wip/thread-sessions-rewrite`,
kill-switched) was rejected: it made the tmux window the source of truth for
topic identity, routing, and isolation, and the window is not controllable.
The observed failure class was uniform — text injection executes in a
post-exit shell, hibernation races draft input, provider resume ids cannot be
captured reliably, ambient config drift silently changes which command a
"resume" runs, and reply targets depend on the model honoring a prompt
anchor. Each symptom had its own patch; all of them shared one root: state
that must be authoritative lived in a process the backend does not own.

LEP-001's survey (buzz / orca / fluent) still stands. This proposal inverts
its weighting: the fluent-style one-shot pattern LEP-001 deferred to Phase 2
becomes the primary mechanism, because it is the only surveyed pattern whose
correctness does not depend on keeping a foreign interactive process alive
and well-behaved.

## Decision

Move session ownership into the backend and demote runtime processes to
disposable workers:

- The backend store is the sole owner of topic sessions, identified by the
  stable tuple `(agent id, room id, scope kind, thread root)`. Identity,
  routing, and isolation derive from backend state, never from a terminal or
  a mutable agent display name.
- Each dispatched message runs in a fresh one-shot headless runner
  (`claude -p`, or an ephemeral Codex App Server thread/turn in a short-lived
  app-server process); its context is rebuilt from durable
  artifacts — persisted thread messages, session summary, task state — and
  its lifetime is one turn. Message content reaches the runner as data
  (stdin/file), never interpolated into a shell command or argv.
- Reply addressing is computed by the backend from the dispatch record; the
  protocol offers the model nothing to fill in, so a wrong `reply_to` is
  unrepresentable rather than merely rejected.
- `check_inbox()` and other MCP reads are scoped to the dispatching session.
- v1 bounds local processes with a host-wide live-runner cap. Writing runners
  additionally serialize on real resource leases: shared workspace mode has
  one writer, while worktree mode permits independent thread worktrees to run
  concurrently. Approval-parked runners count against a finite parked cap.
- State changes inside the router use SQLite transactions. Matrix sends and
  approval consumption remain separate durable systems and cross those
  boundaries through idempotent outbox/inbox records plus restart
  reconciliation; they are not described as one database transaction.

Alternatives considered and rejected:

1. **Keep patching the window model**: each ADR-010 failure had a plausible
   local fix, but every fix re-anchored on the same uncontrollable truth
   source; the class survives any finite patch set.
2. **Always-live pane per thread**: already rejected in LEP-001; resource
   growth per thread, and it inherits the window-as-truth-source class.
3. **Prompt-discipline anchors without process isolation**: the prototype
   demonstrated the failure mode concretely — an anchor is a request to the
   model, not a guarantee, and enforcement degrades to after-the-fact 409s.

## Consequences

Good, because the entire window-dependency failure class (injection,
hibernation races, resume capture, config drift, model-filled reply targets)
is removed by construction, not individually mitigated.
Good, because at-most-once execution and approval parking can be defined as
backend ledger semantics with leases, independent of process behavior.
Bad, because every turn pays a cold start and a context rebuild; rebuild
quality and token cost become first-class product concerns with measurable
targets, not implementation details.
Bad, because octos is not servable by this model — its approval chain is a
long-lived octos-tui → proxy → octos-serve pipeline that conflicts with
disposable runners — and is explicitly out of scope rather than deferred.
Bad, because v1 is local-only; a remote-registered agent is rejected until a
separate authenticated remote-runner protocol is accepted.

## Produces: ADR-011
