## Current
Close out supervisor rollout by reducing `SKIPPED` audits (missing role/boundary/current docs) across active agents so focus checks can evaluate real task alignment.
Acceptance criteria:
- Keep supervisor running in live with verified status endpoints and audit page availability.
- Ensure skipped/error states stay neutral (no false consecutive-negative warning escalation).
- Produce actionable docs-coverage report for active agents using `npm run audit:agent-docs -- --active`.

## Queue
1. Coordinate role/boundary/current doc backfill for active agents currently marked `missing-doc-sections`.
2. Add optional mention-target configuration for supervisor warnings (`SUPERVISOR_MATRIX_MENTIONS`) and verify in info-room flow.
3. Add lightweight API/CLI support to clear stale supervisor warning timestamps after logic/schema changes.

## Blocked (optional)
None.
