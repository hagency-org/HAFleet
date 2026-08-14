---
kind: decision
id: ADR-010
title: "Two session policies: conversational anchor vs hibernating per-thread sessions"
status: Superseded
liveness: auto
tags: [sessions, matrix, threads, runtime, scheduler, hibernation]
---

## Context

One agent runs one long-lived coding runtime conversation, so concurrent
Matrix threads share a single LLM context and cross-contaminate. Delivery-side
thread routing already exists (ADR-007); the cognition side has no isolation.
LEP-001 surveyed buzz, orca, and fluent for prior art and rejected single-pane
restart switching, always-live pane-per-thread, and prompt-discipline-only as
universal answers.

## Decision

Each agent declares `session_policy: conversational | per-thread`, defaulting
to `conversational`.

`conversational`: exactly one runtime session. Thread notifications embed the
thread's recent history and a hard reply anchor naming the backend message id;
the outbound path rejects a reply whose `reply_to` resolves to a different
thread than its anchor.

`per-thread`: a durable registry maps `(room id, thread root event id)` to
`{tmux window, provider session id, transcript path, state, dispatch id}`.
Session id and transcript path are captured from the runtime's own session
hooks and never reconstructed. Idle sessions hibernate — the process is
terminated only after an input guard confirms no unsubmitted draft input, and
the next message wakes the entry via a fixed per-runtime resume argv table
with a sanitized session id. A wake or switch requires a verified exit of the
previous process. Deliveries carry a dispatch id; stale-dispatch replies are
fenced. Per-key delivery is FIFO; live sessions per agent are bounded, and the
registry is LRU-bounded with an explicit rebuilt-context notice on eviction.

Hibernation, wake, and switching do not alter owner-approval bindings and do
not trigger a new Codex hook trust confirmation.

`per-thread` initially covers the runtimes with a provider resume argv
(`claude`, `codex`). Octos agents keep the `conversational` policy — anchor
and thread-context injection are prompt-assembly mechanisms and apply to any
runtime — and a `per-thread` declaration on an octos agent is rejected as a
visible validation error until per-thread support for the managed octos
proxy chain (client-chosen `--session` resume, exit verification across its
three-process tree) is designed.

## Alternatives Considered

- **Single-pane restart switching**: idle-gated process restart with resume
  per thread key. Rejected as the primary mechanism: every cross-thread turn
  pays a 5–10 s relaunch, the interactive channel confirmation reappears on
  each restart, and an idle heartbeat does not prove the previous process
  exited.
- **Always-live pane per thread**: hard isolation, but holds one runtime
  process and one full context per thread; resource use grows with thread
  count instead of active work.
- **Prompt-discipline only for all agents**: zero process management, but
  mitigation-grade — it relies on the model honoring injected structure,
  which is insufficient for agents holding write access to project files.

## Consequences

Good, because work threads stop leaking constraints and reply targets into
each other while coordinators keep global awareness.
Good, because resource use follows active work rather than thread count.
Good, because every failure path is fail-closed and visible in the
originating thread rather than silent.
Bad, because evicted threads resume with rebuilt context.
Bad, because installing session capture changes the Codex hook digest, so
rollout costs a one-time TTY trust re-confirmation per Codex agent (steady
state is unaffected).
Bad, because conversational sessions adopt buzz's anchor and per-turn context
rebuild but not its bounded session rotation: a long-lived coordinator
context still grows and compacts over time (rotation deferred — it would
discard the coordinator's global memory).
Bad, because per-thread agents cannot see sibling threads; cross-thread work
must go through a conversational coordinator.

## Source Trace

- proposal: LEP-001
- knowledge/requirements/req-thread-scoped-agent-sessions.md
- specs/task-thread-scoped-agent-sessions.spec.md

## Superseded by: ADR-011

The per-thread half of this decision was prototyped
(`wip/thread-sessions-rewrite`, kill-switched) and rejected. The prototype
falsified the core premise: it made the tmux window the source of truth for
topic identity, routing, and isolation, but the window is not controllable —
it exits, drops back to a shell that executes injected text, races
hibernation sweeps against draft input, loses provider resume-id capture,
and silently changes launch behavior when ambient config drifts. Every
observed failure traced back to that single dependency rather than to any
individual mechanism. ADR-011 moves session ownership into the backend and
demotes runtime processes to disposable, per-dispatch workers.
