# System Architecture Convergence

Date: 2026-03-09
Owner: `agentchat-worker`
Scope: `agent-chat` dev architecture steering

## Goal
Reduce the system to a small set of real objects, real state boundaries, and real workflows. Stop shipping display-first concepts or local substitutes that do not correspond to durable system behavior.

## First-Class Objects

These are the objects the system is allowed to speak about directly in APIs, UI, and operational docs:

1. `Agent`
   - identity, online/offline, runtime type, server, tmux/session linkage

2. `Agent Home`
   - `homeDir`, `workdir`, `stateDir`, `agent.json`, layout version

3. `Managed Project`
   - materialized project under `workdir/projects/<name>`
   - source mode: `copy` or `symlink`
   - lifecycle: import, list, untrack, delete

4. `Supervisor Evaluation`
   - evaluation status, reason, timestamps, event history, negative streak

5. `Subconscious Runtime`
   - local transitional runtime configuration and invocation state
   - must never be conflated with upstream Letta objects

6. `Upstream Letta Agent`
   - bound remote Letta agent identity and model binding

7. `Upstream Letta Conversation`
   - session-to-conversation lifecycle, notify/send state, transcript sync state

8. `Delivery Item`
   - unread messages, queue items, delivery status

9. `Benchmark Run / Trial`
   - profile version, task/run state, artifacts, result bundle

10. `Task`
   - assigned unit of work with owner, state, heartbeat, and waiting metadata

11. `Supervisor Agent State`
   - the narrow supervisory state machine that evaluates task heartbeat over time
   - not a generic free-form reviewer agent

Anything else is either:
- derived summary
- compatibility mirror
- debug surface
- or a bad concept that should not become product language

## Truth Sources

Each surface must point back to a single source of truth.

1. `Agent`
   - runtime/backend registry

2. `Agent Home`
   - `homes/agents/<id>/agent.json`

3. `Legacy compatibility mirror`
   - `data/agents/<name>/meta.json`
   - mirror only; never outranks `agent.json`

4. `Managed Project`
   - `agent.json.managedProjects`
   - concrete filesystem under `workdir/projects/`

5. `Supervisor`
   - supervisor state/evaluation/event store

6. `Subconscious local transitional runtime`
   - `state/subconscious/runtime.json`
   - related event stream

7. `Upstream Letta`
   - `state/letta.json`
   - upstream durable home/session/conversation files
   - remote Letta API objects

8. `Workspace contract`
   - `docs/workspace-claude-md-template.md`
   - rendered into root `workdir/CLAUDE.md`

## Forbidden Patterns

These are now architecture violations:

1. UI-only concepts that do not map to a first-class object
   - examples: generic “signal”, generic “runtime config”, synthetic health prose that looks authoritative

2. Transition layers presented as mature systems
   - especially local subconscious substitutes presented as if they were Letta parity

3. Compatibility mirrors outranking canonical state
   - `meta.json` must mirror `agent.json`, not compete with it

4. Agent work happening outside the declared managed project path without explicit operator instruction

5. Feature work that adds names and panels before the object model is stable

## Environment Model

The system must explicitly distinguish:

1. `live`
2. `dev`
3. `benchmark`
4. `ephemeral`

This is not display polish. It is a required part of the object model. Agent lists and detail pages must stop making one dev agent look like multiple agents across surfaces.

## Current Transitional Truth

1. `SessionStart` and `Stop` are real upstream-backed paths in dev.
2. `UserPromptSubmit` and `PreToolUse` are still transitional/local.
3. Yato now has a real managed `agent-chat` project under its own home and should be treated as working there, not in the main repo root.
4. The local subconscious runtime still exists as a transitional path and must be shown as such, not as “the subconscious backend”.

## Priority Order

1. Finish the real upstream hook path incrementally
   - next slice: `UserPromptSubmit`
   - then `PreToolUse`

2. Rebuild web around first-class objects and environment grouping
   - not more prose or synthetic summary layers

3. Finish benchmark and config control-plane only after the object model is stable enough not to fork product language again

4. Rebuild supervisor around a minimal task/heartbeat model instead of one-shot LLM judging

## Supervisor Bible

The supervisor should be an `agent-shaped state machine`, not a free-form audit bot.

### Minimal Object Model

Supervisor work should only depend on two first-class objects:

1. `Task`
   - `id`
   - `owner`
   - `status`
   - `updated_at`
   - `heartbeat_at`
   - `waiting_reason` (nullable)
   - `waiting_until` (nullable)

2. `Supervisor Agent State`
   - the supervisor's own running/idle/active state
   - its tracked timing relationship to the primary task owner

### Minimal Task States

Keep task state small:

1. `active`
2. `waiting`
3. `blocked`
4. `done`

### Heartbeat Rule

There are only two meaningful heartbeat modes:

1. `active heartbeat`
   - the owner is still pushing the task forward

2. `waiting heartbeat`
   - the owner is not stalled, but is explicitly waiting on something
   - must include:
     - `waiting_reason`
     - `waiting_until`

### EOS vs Waiting

Supervisor must not guess the difference from silence alone.

The rule is:

1. If a task is `active` and heartbeat expires, mark `suspected_eos`.
2. If a task is `waiting` and `waiting_until` has not expired, mark `normal_wait`.
3. If a task is `waiting` and `waiting_until` expires, mark `stalled_wait`.
4. If a task has no valid waiting metadata, do not treat silence as safe waiting.

That means normal waiting is not inferred. It must be declared by the task owner.

### Supervisor Runtime Behavior

Supervisor should follow the primary agent with a narrow timing rule:

1. When the primary agent is active, supervisor is active.
2. When the primary agent goes idle, supervisor stays active for a short trailing window (for example 5 heartbeat periods) to decide whether the task is in valid waiting or has drifted/EOSed.
3. If all trailing checks show no work and no valid waiting declaration, supervisor marks `suspected_eos`.
4. If a valid waiting declaration exists, supervisor stays in `normal_wait` until timeout.
5. After a bounded trailing window with no further action required, supervisor may go idle.

### Model Strategy

Supervisor can run on an agent framework (`codex` / `claudecode`) with a cheap long-context backend, but its role must stay narrow:

1. maintain task heartbeat state
2. classify `active / waiting / stalled / suspected_eos`
3. emit correction signals or human warnings when required

It must not drift into a second executor or a general reviewer agent.

## Agent Allocation

1. `agentchat-develop`
   - backend and control-plane implementation
   - must justify every new field/panel in terms of first-class objects and truth sources

2. `Yato`
   - front-end implementation only after object boundaries are clear
   - no display-first concepts, no fake maturity signals

3. `webdebug`
   - browser verification and UI/UX critique
   - must audit not only bugs, but also conceptual truthfulness and object clarity

## Review Standard

Future acceptance is two-stage:

1. Architecture review
   - Should this object exist?
   - Is the truth source clear?
   - Is this transitional or canonical?

2. Implementation review
   - Does the code work?
   - Is the runtime proof real?
   - Are there regressions?
