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
