# 06 Implementation Plan

Date: 2026-05-02
Status: approved incrementally by ac-topleader; Batch 1 and Batch 2 complete, Batch 3 narrowed to R-009/R-015.

## Approval Gate

No code repair starts until ac-topleader accepts the repair table or adjusts priority.

Active constraints:

- Stay on `master`.
- Do not modify `stable`.
- Do not edit `bin/agent-up`.
- Do not edit `remote/bin/agent-up`.
- Keep launch/remote-agent-up repairs coordinated with the active bash 3.2/tmux launch work.

## Batch 1: Kernel Auth And Memory Boundary

Repairs:

- R-001: group message reads must not anonymously advance another agent cursor.
- R-002: message detail endpoints must not expose full chat memory publicly.
- R-003: managed agent token writes must fail closed outside explicit development/test mode.

Likely files:

- `backend-v2.js`
- `tests/api-groups.test.js`
- `tests/api-messages.test.js`
- `tests/api-agent-token.test.js`
- `tests/helpers/backend-test-runtime.js` only if needed for isolated env setup.

Verification target:

```bash
npm ci
npm test -- tests/api-groups.test.js tests/api-messages.test.js tests/api-agent-token.test.js
```

Risk:

- Existing Matrix/dashboard/public preview paths may rely on anonymous reads. If so, add explicit bearer/operator paths rather than keeping kernel reads public.

## Batch 2: Inbox And Task Trust

Repairs:

- R-004: offline group mentions must remain visible in later inbox reads.
- R-005: task graph node result must be bound to assignee and dispatch context.
- R-006: document or begin migration toward canonical task store.

Likely files:

- `backend-v2.js`
- `lib/task-graph.js`
- `tests/api-messages.test.js`
- `tests/api-task-graphs.test.js`
- `tests/source-of-truth.test.js`

Verification target:

```bash
npm test -- tests/api-messages.test.js tests/api-task-graphs.test.js tests/source-of-truth.test.js
```

Risk:

- Existing task graph workflows may use schema-only completion without `reply_to`; migration may need a compatibility window with warning logs.

## Batch 3: Runtime Delivery Reliability

Repairs:

- R-009: cross-platform MCP presence detection.
- R-015: make `agent-service` compatible with macOS bash 3.2.

Deferred for this pass:

- R-012: move MCP media cache out of project CWD.
- R-013: allow emergency local `agent-down --kill` during backend outage.

Likely files:

- `lib/push-relay-core.js`
- `lib/mcp-server-core.js`
- `bin/agent-down`
- `bin/agent-service`
- related tests.

Verification target:

```bash
npm test -- tests/push-relay.test.js
bash -n bin/agent-down bin/agent-service
```

Risk:

- Manual macOS tmux smoke checks are needed for MCP presence and shell compatibility.

## Batch 4: Edge Gates

Repairs:

- R-017: dashboard auth/local-only gates.
- R-018: Matrix trust/ACL fail-closed for mutating commands.
- R-019: Supervisor lifecycle explicit gate or process split.
- R-023: subconscious upstream/runtime per-agent auth.

Likely files:

- `server.js`
- `bridge-matrix.js`
- `lib/bot-commands.js`
- `backend-v2.js`
- `lib/supervisor-lifecycle-manager.js`
- related tests.

Verification target:

```bash
npm test -- tests/bot-command-acl.test.js tests/room-trust.test.js tests/api-supervisor-v2.test.js tests/bridge-matrix.test.js
```

Risk:

- Operator workflows may currently depend on local unauthenticated dashboard commands. Provide explicit dev/local configuration rather than silent public access.

## Batch 5: Data, Config, CI, Remote

Repairs:

- R-022: remote package sync.
- R-024: dependency security and CI checks.
- R-025: production JSON schemas and migrations.
- R-026: `.env.example` truth cleanup.
- R-027: read-only/check-data mode.
- R-028: test helper cleanup.
- R-030: old docs archive/rewrite.

Likely files:

- `.github/workflows/ci.yml`
- `.env.example`
- `backend-v2.js`
- `lib/*store*.js`
- `schemas/`
- `scripts/build-remote-package.sh`
- `scripts/check-remote-sync.sh`
- docs under `docs/`.

Verification target:

```bash
npm test
npm run audit:deps
npm run build:remote:check
npm run check:remote-sync
```

Risk:

- Remote launch files are under active work. Do not touch remote `agent-up` until ac-topleader/operator clears that work.

## Commit Plan

- One commit per coherent repair batch.
- Include tests with each code repair commit.
- If a batch reveals larger migration risk, stop after tests/docs and report before broad refactor.
