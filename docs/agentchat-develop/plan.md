## Current
Hold for the next explicit `agentchat-worker` scope after the accepted `UserPromptSubmit` convergence repair.
Acceptance criteria:
- Do not start implementation until `agentchat-worker` sends the next explicit work command.
- Keep the accepted baseline explicit: `SessionStart`, `UserPromptSubmit`, and `Stop` are the upstream-backed slices.

## Queue
1. When resumed, continue the next minimal upstream hook cutover without reopening unrelated UI scope.
1. Address architecture-review follow-ups for subconscious event model and security hardening.

## Blocked
1. Supervisor gate is still held/disabled by operator direction, so fresh live-sweep verification cannot run yet.
