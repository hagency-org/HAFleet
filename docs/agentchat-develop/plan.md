## Current
Coordinate rollout and live validation of the supervisor parser/runtime workspace-path fixes.
Acceptance criteria:
- Updated code is merged/deployed in runtime environment.
- `/api/supervisor/agents` no longer marks active agents as `missing-doc-sections` due to parser/workspace-path false negatives.
- Verification evidence is captured and reported.

## Queue
1. Propose next signal-quality hardening tasks (if needed) based on remaining skip/error causes.
