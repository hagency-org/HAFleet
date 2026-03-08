## Current
Close Yato project discipline and tighten the stable workspace CLAUDE contract for v1 homes, using existing dev-only project/workspace mechanisms.
Acceptance criteria:
- `docs/workspace-claude-md-template.md` becomes a short, stable workspace contract that clearly teaches real code/project discipline.
- Yato gets a real managed `agent-chat` project under its own `workdir/projects/`, and Yato’s workspace/project docs reflect that truthfully.
- Verification proves Yato’s expected working code path is its own project path, not the main repo root.

## Queue
1. If this batch is accepted, evaluate the next minimal upstream hook-cutover slice after explicit worker direction.
1. If worker later wants deeper project lifecycle closure, add the next truthful managed-project operation beyond import/remove (for example rename or source relink) without over-claiming full project management.
1. Address architecture-review follow-ups for subconscious event model and security hardening.

## Blocked
1. Supervisor gate is still held/disabled by operator direction, so fresh live-sweep verification cannot run yet.
