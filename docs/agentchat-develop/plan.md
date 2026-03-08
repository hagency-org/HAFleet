## Current
Implement the next minimal upstream hook cutover by wiring the dev-only `Stop` path through the real upstream transcript/send flow for Yato, with truthful Stop observability in API/detail.
Acceptance criteria:
- One real dev proof shows a `Stop` event using the upstream path and returning a truthful success/failure result.
- Observability records whether upstream Stop send was attempted, whether it succeeded/failed, the exact blocker if any, and any durable transcript/session artifact paths now in use.
- Scope stays minimal: no live changes, no UI redesign, no broader hook cutover claims.

## Queue
1. If Stop cutover lands cleanly, evaluate the next minimal upstream hook-cutover slice after explicit worker direction.
1. If worker later wants deeper project lifecycle closure, add the next truthful managed-project operation beyond import/remove (for example rename or source relink) without over-claiming full project management.
1. Address architecture-review follow-ups for subconscious event model and security hardening.

## Blocked
1. Supervisor gate is still held/disabled by operator direction, so fresh live-sweep verification cannot run yet.
