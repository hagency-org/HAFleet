## Current
Propose next signal-quality hardening tasks (if needed) based on remaining skip/error causes.
Acceptance criteria:
- Remaining `SKIPPED`/`ERROR` causes are grouped by root cause and risk.
- Next tasks are ranked by impact/effort for implementation handoff.
- Recommendations are sent to `agentchat-worker` for prioritization.

## Queue
1. Resolve blocked live-sweep validation once supervisor runtime is re-enabled.

## Blocked
1. Complete fresh `/api/supervisor/agents` live-sweep validation for active agents; currently blocked because runtime reports `SUPERVISOR_ENABLED=false` (no new sweeps/events).
