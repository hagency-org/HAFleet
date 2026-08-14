---
kind: proposal
id: LEP-001
title: "Isolate coding agent cognition per Matrix thread"
status: Rejected
liveness: n/a
tags: [sessions, matrix, threads, runtime, isolation]
---

## Context

Thread isolation in agent-chat currently ends at the delivery layer. ADR-007
made replies land in the correct Matrix thread, but one agent still runs one
long-lived coding runtime conversation: messages from every thread, DM, and
room interleave in a single LLM context. Observed failure modes: constraints
stated in one thread leak into another's work, the agent picks a wrong
`reply_to` for its reply, a long task in one thread blocks all others, and
interleaved topics accelerate context-window compaction.

Three reference systems were surveyed for prior art:

- **buzz** (`borrow-proj/buzz`, book ch22 analyses this exact gap): sessions
  are keyed per channel, never per thread; thread identity is handled per
  turn by re-fetching thread history from the event log and injecting an
  explicit reply anchor into each prompt; sessions are rotated (bounded by
  turn count and stop reasons) instead of resumed forever; scheduling is a
  per-conversation FIFO island with cross-conversation parallelism.
- **orca** (`borrow-proj/orca`): one pane per conversation, resumed by the
  provider's real session id learned from runtime hooks (never a
  reconstructed transcript path); idle panes hibernate by default — the
  process is killed and a sleeping record `{session_id, transcript_path,
  resume argv}` is stored, woken lazily on the next message; an input guard
  blocks hibernation while the pane holds unsubmitted draft input; dispatch
  ids fence stale output from a restarted worker.
- **fluent** (`borrow-proj/fluent`): every agent step is a fresh one-shot
  process (`codex exec --ephemeral --ignore-user-config`); context is rebuilt
  from durable artifacts, never from model memory.

Alternatives considered and rejected:

1. **Single-pane restart switching** (our first draft): idle-gated process
   restart with resume per thread key. Rejected as the primary mechanism —
   every cross-thread turn pays a 5–10 s restart, the interactive channel
   confirmation reappears on each relaunch, and "idle" does not prove the
   previous process exited.
2. **Always-live pane per thread**: hard isolation but holds N runtime
   processes with N full contexts; unacceptable resource growth.
3. **Prompt-discipline only for all agents**: cheapest, but mitigation-grade —
   it relies on the model honoring injected structure, which is insufficient
   for work agents that hold write access to project files.

## Decision

Adopt a two-policy design keyed by agent role:

- `conversational` (default; coordinators): keep one session for global
  awareness. Attack contamination at the prompt-assembly layer, buzz-style:
  every thread notification embeds recent thread history plus a hard reply
  anchor, and the outbound path rejects anchor-mismatched replies.
- `per-thread` (work agents): a durable session registry keyed by
  `(room id, thread root)`, orca-style hibernation-first process management:
  each thread gets its own runtime conversation; idle sessions are terminated
  after an input-guard check and woken lazily by recorded resume argv;
  provider session id and transcript path are captured from runtime hooks;
  wakes verify previous process exit; dispatch ids fence stale output;
  per-key FIFO with a bounded number of live sessions per agent.

Phase 2 (separate work, existing roadmap item B6): parallel ephemeral workers
in per-task worktrees, using fluent's ephemeral flags for guaranteed-clean
sessions.

## Consequences

Good, because coordinator agents keep whole-project awareness with zero
process churn while work agents gain hard cognitive isolation per thread.
Good, because steady-state live processes scale with active work, not with
thread count.
Good, because owner-approval semantics are untouched: bindings stay keyed by
`(room, agent)` and hook trust is configuration-scoped.
Bad, because a woken thread whose registry entry was evicted restarts with
rebuilt context and loses in-session nuance.
Bad, because per-thread work agents lose cross-thread awareness by design;
tasks that genuinely span threads must route through a conversational
coordinator.

## Produces: ADR-010

## Outcome

Accepted into ADR-010 and prototyped on `wip/thread-sessions-rewrite`; the
prototype was rejected (window-as-truth-source failure class) and the
direction was re-proposed as LEP-002, which produces ADR-011. The buzz /
orca / fluent survey in this proposal remains the reference analysis; the
fluent-style one-shot pattern this proposal deferred to Phase 2 became the
primary mechanism in LEP-002.
