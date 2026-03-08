## Current
Hold for the next explicit `agentchat-worker` resume command on the UserPromptSubmit upstream cutover slice.
Acceptance criteria:
- Do not start implementation until `agentchat-worker` sends the explicit resume/work command.
- Keep the next scoped target explicit: minimal upstream hook cutover for `UserPromptSubmit`.

## Queue
1. When resumed, implement the minimal truthful upstream `UserPromptSubmit` cutover slice without reopening unrelated workspace/template scope.
1. If worker later wants deeper project lifecycle closure, add the next truthful managed-project operation beyond import/remove (for example rename or source relink) without over-claiming full project management.
1. Address architecture-review follow-ups for subconscious event model and security hardening.

## Blocked
1. Supervisor gate is still held/disabled by operator direction, so fresh live-sweep verification cannot run yet.
