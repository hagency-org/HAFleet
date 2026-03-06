## Current
Implement external supervisor event ingest API (`POST /api/supervisor/events`) with authentication, source validation, schema validation, and rate limiting.
Acceptance criteria:
- Endpoint accepts only authenticated/validated payloads.
- Invalid or replayed payloads are rejected with explicit telemetry.
- Accepted events are ready for reducer ingestion without bypassing supervisor state flow.

## Queue
1. Route external subconscious events through the same supervisor reducer/state path as internal scans (no side-channel append-only writes); add dedupe/order guards.
2. Define and implement guidance-to-event contract v1 (`status/domain/pattern/reason/suggestion/negative/source`) with strict parser + malformed payload telemetry.
3. Add per-agent audit switches (default OFF) and global pause/resume controls to contain LLM token cost; keep notifications web+matrix only.
4. Add pilot integration path for subconscious hooks (opt-in agent list) and persist per-agent metadata (`letta.json` / integration status).
5. Close mixed-fleet coverage gap: document and implement behavior for Claude-hook agents, Codex agents, and no-hook fallback collector.
6. Extend web audit secondary page to show source-specific timeline (`supervisor` vs `subconscious`) and latest triage reason per agent.
7. Add privacy/ops guardrails: transcript redaction policy, retry/backoff budget, timeout budget, and failure isolation (subconscious outage must not degrade agent-up path).
8. Run Phase 1 pilot on 1-2 agents with false-positive tracking and warning-threshold validation (3 consecutive negatives -> matrix warning).
9. Prepare Phase 2 migration decision memo: quality/cost comparison against current DeepSeek judge and retirement scope for legacy judge path.

## Blocked (optional)
None.
