# 04 Data Config Tests

Date: 2026-05-02

## Data Contract

Current implementation:

- Core stores are JSON files under `DATA_DIR`.
- `schemas/` currently covers benchmark data, not production kernel stores.
- Store validation and migration are mostly ad hoc in backend/module code.

Needed contract:

- Every production store should have `schemaVersion`.
- Startup should validate before mutation.
- Migrations should be explicit, tested, and able to run in dry-run/read-only mode.
- Corrupt data handling should be safe for audit/check-only commands.

Priority stores:

- `agents.json`
- `groups.json`
- `messages.json`
- `cursors.json`
- `agent_runtime.json`
- `tasks.json`
- `task_graphs.json`
- `alerts.json`
- `supervisor_snapshots.json`

## Environment Variables

Current issue:

- `.env.example` mixes kernel, edge, ops, Matrix, Supervisor, scope monitor, and launch variables.
- Some documented modes do not map to implemented behavior.

Recommended classification:

| Class | Examples | Rule |
| --- | --- | --- |
| Kernel | backend URL/port, runtime dir, token mode, message limits | Must be documented and tested. |
| Transport | MCP, push relay, Matrix URLs/secrets | Optional, isolated by component. |
| Edge | Supervisor, subconscious, benchmark | Disabled/gated unless explicitly enabled. |
| Ops | systemd, remote, maintenance IDs, audit settings | Kept out of kernel semantics. |

## CI And Verification

Current CI:

- `npm ci`
- syntax checks for selected files
- `npm test`

Gaps:

- Dependency audit is not enforced.
- Remote sync is not enforced.
- Remote package check is not enforced.
- macOS bash 3.2 compatibility is not covered.
- Data migration/read-only mode is not covered.

Commands referenced by audits:

```bash
npm ci
npm test
npm run audit:deps
npm run build:remote:check
npm run check:remote-sync
bash scripts/check-dep-isolation.sh
```

Current reported verification state:

| Command | Reported result |
| --- | --- |
| `bash scripts/check-dep-isolation.sh` | Pass |
| `bash scripts/audit-deps.sh` | Fail |
| `bash scripts/check-remote-sync.sh` | Fail |
| `bash scripts/build-remote-package.sh --check` | Fail |
| `npm test` | Fails until `npm ci` restores missing dev dependencies |

## Test Harness

Known issue:

- `tests/helpers/backend-test-runtime.js` seeds an old supervisor state filename and restores too few environment variables.

Expected helper behavior:

- Always use temporary runtime directories.
- Restore every env var it changes.
- Seed current production filenames.
- Prevent tests from touching real `data/`.
