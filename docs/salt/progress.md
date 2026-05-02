# salt Progress

## 2026-05-02

- Reported start of work to ac-topleader before touching the audit.
- Confirmed identity as `salt` through agent-chat MCP.
- Read `AGENTS.md`; in this repository it is a symlink to the v1 workspace template.
- Chose `docs/salt/` as the personal documentation folder, matching the existing `docs/Hibiki/` convention and the user's request.
- Started five read-only subagents for parallel system audit.
- Created initial documentation skeleton for system map, kernel boundaries, findings, repair table, subagent briefs, and progress.
- Received ac-topleader guidance: stay on `master`, do not modify `stable`, keep this phase to docs/audit only, and do not edit `bin/agent-up` or `remote/bin/agent-up` because separate launch work is active there.
- Integrated all five subagent reports into the draft audit findings and repair table.
- Added multi-file system documentation: principles, kernel, runtime/transports, edge systems, data/config/tests, and stale-doc archive index.
- Added approval-gated implementation plan split into kernel, inbox/task, runtime, edge, and data/config/CI batches.
- ac-topleader approved Batch 1 R-001/R-002 and deferred R-003. Implemented group/message read access controls with regression tests.
- Completed Batch 2. Implemented R-004 offline mention inbox visibility, R-005 task graph assignee plus dispatch reply validation, and added R-006 task-truth design doc.
- Completed Batch 3 approved scope R-009/R-015. Added cross-platform MCP pid command detection with `ps` fallback and test hooks, replaced `agent-service` associative-array dedupe with Bash 3.2-compatible ordered array logic.
- Verified Batch 3 with syntax checks, `tests/push-relay.test.js`, the Batch 1/2 API regression set, and read-only `/bin/bash bin/agent-service status` smoke checks.
- Fixed a `server-delivery` test isolation issue found during full-suite verification; `tests/server-delivery.test.js` now passes independently.
- Full `npm test` is still blocked only by missing Matrix native optional package `@matrix-org/matrix-sdk-crypto-nodejs-darwin-arm64` in the local `npm ci --ignore-scripts` install; non-Matrix suites report 347 passing tests and 21 skipped Matrix tests before import failure.
