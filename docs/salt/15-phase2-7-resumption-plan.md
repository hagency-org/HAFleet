# 15 Phase 2-7 Resumption Plan

Date: 2026-05-03
Status: active resumption plan; completed batches remain review-gated before merge to stable.

## Baseline

Phase 0 and Phase 1 are complete enough to resume the deferred remote/local roadmap:

1. terms and profile scope are staged in `11-remote-local-phase0-terms.md`;
2. remote package honesty is enforced by `check:cli-contract`, `build:remote:check`, `check:remote-sync`, and `check:remote-package-smoke`;
3. source/package CI is exposed as `npm run verify:ci`;
4. deploy-candidate preflight is exposed as `npm run verify:cd-preflight`;
5. remote loaded-version verification is exposed as `agentchat verify-remote --expect-version <short-sha>`.

The remaining Phase 2-7 work should now use those gates as a required part of each batch, rather than relying on manual confidence.

## Guardrails

Keep these boundaries unless ac-topleader explicitly changes them:

1. work on `master`, never directly on `stable`;
2. do not edit `bin/agent-up` or `remote/bin/agent-up` until Phase 5 is approved;
3. do not change actual deploy/autodeploy behavior unless the specific CD batch is approved;
4. commit and push each completed batch;
5. run `npm run verify:ci` before every push;
6. for deploy-relevant batches, run `npm run verify:cd-preflight` on a clean commit and use `verify-remote --expect-version <short-sha>` after stable deployment.

## Current Phase State

| Phase | Current state | Safe next step | Approval |
| --- | --- | --- | --- |
| Phase 2 runtime observation | Runtime writes now carry backend-derived observation provenance; RLP2-B fixed custom local server ID delivery/liveness and added an opt-in local server record; unknown activity is preserved as `activeNow=null` instead of being shown as idle. Central-local still uses backend tmux sweeps and local-only idle probes. | Continue with richer local-host adapter design only after approval, not default behavior flips. | Required |
| Phase 3 credentials/trust | RLP3-A added diagnostics-only agent-token readiness; RLP3-A2 documented and tested the server credential compatibility boundary. Shared `API_TOKEN`, dashboard proxy, actual server credential enforcement, and Matrix trust remain compatibility surfaces. | Continue with server credential enforcement migration or dashboard boundary after approval; do not flip fail-closed until tokens are provisioned and relay/server credentials are rolled out. | Required |
| Phase 4 paths | Runtime dir guard exists; MCP media cache relocation is implemented in RLP4-A. | Continue with v1 home/runtime resolver hardening after approval. | Required |
| Phase 5 launch | Explicitly frozen because `agent-up` launch work was active. | Keep frozen; only write design/tests until approval clears launch files. | Required |
| Phase 6 CLI/ops profile | Remote command honesty is enforced; RLP6-A made `service`, `update`, `ls`, and `down` help/docs profile-scoped; CLI status/list now report unknown runtime activity without treating it as idle. | Continue with shell resolver consistency after approval. | Required |
| Phase 7 CI/release gates | `verify:ci` and remote package gates are enforced; `audit:deps` is intentionally separate and red; CD-A is still pending. | Add missing focused gates after each repair; handle dependency audit as a dedicated security batch. | Required |

## Phase 2: Runtime Observation

Current evidence:

- `backend-v2.js` owns `/api/servers/heartbeat`, `servers.json`, and `agent_runtime.json`.
- `lib/push-relay-core.js` already reports runtime and heartbeat from remote hosts.
- `server.js` still performs local tmux pane snapshot sweeps for dashboard idle/queue behavior.
- `agent_runtime.json` records activity, MCP state, and the last backend-derived observation write path.

Completed batch RLP2-A: runtime observation provenance.

Scope:

1. add normalized `runtime.observation` fields: `observerSource`, `observerServer`, and `observedAt`;
2. derive the source from backend write paths rather than trusting client-supplied provenance;
3. expose observation provenance in the runtime API response and agent detail;
4. add tests proving runtime reports ignore forged provenance and server heartbeat liveness does not overwrite runtime observation ownership.

Files likely touched:

- `backend-v2.js`
- `tests/api-runtime.test.js`
- possibly `tests/api-server-heartbeat.test.js`

Verification:

- targeted `vitest run tests/api-runtime.test.js tests/api-server-heartbeat.test.js tests/api-provenance.test.js`
- targeted `vitest run tests/push-relay.test.js` if relay report payloads change
- `npm run verify:ci`
- clean `npm run verify:cd-preflight`

Do not do in RLP2-A:

- do not disable backend local sweep by default;
- do not require local central delivery to use push relay;
- do not change launch/provisioning.

Completed batch RLP2-B: custom local server ID and opt-in local server record.

Goal:

Make the central-local runtime host visible through the same `servers.json` liveness model without changing delivery. This can be done by recording a local server row for `AGENT_CHAT_SERVER` and associating local agents with it.

Implementation shape:

1. fixed custom local server delivery by using the shared `isLocalAgentServer()` classifier instead of checking only literal `local`;
2. prevented stale local server rows from running remote-offline cascade against local agents;
3. added opt-in `AGENT_CHAT_RECORD_LOCAL_SERVER=1` to record a central-local server row;
4. kept the local row path separate from `applyServerHeartbeat()`;
5. did not disable local sweep or change default behavior.

Decision needed:

Whether richer local host liveness should eventually be produced by backend self-observation or by a local host adapter process. The roadmap already says local delivery does not need push relay by default in this phase, so backend self-observation remains the smaller compatibility path.

## Phase 3: Credentials And Trust

Current evidence:

- `API_TOKEN` is still used as backend/operator bearer by web proxy, MCP, relay, and CLI tools.
- `/api/servers/heartbeat` requires bearer but not a server-specific credential.
- `/api/agents/:name/runtime` has per-agent token support through `requireAgentToken`, but production fail-closed remains blocked by provisioning/token readiness.
- `server.js` dashboard routes proxy many privileged backend APIs using backend bearer credentials.
- `bridge-matrix.js` defaults `MATRIX_TRUST_MODE` to `audit`.

Completed batch RLP3-A: auth readiness and diagnostics.

Scope:

1. document and test the exact `AGENTCHAT_AGENT_TOKEN_MODE` behavior;
2. add a diagnostics-only `/health` readiness check that reports missing managed agent tokens without flipping production to hard mode;
3. keep current fail-open compatibility for registered agents without loaded token files;
4. keep R-003 fail-closed deferred until tokens are provisioned for existing agents.

Completed batch RLP3-A2: server credential boundary diagnostics.

Scope:

1. expose diagnostics-only server credential boundary under `/health.auth.serverCredential`;
2. document that heartbeat/offline/runtime report currently use `API_TOKEN` compatibility bearer and `AGENTCHAT_SERVER_TOKEN` is not accepted or enforced yet;
3. test that heartbeat/offline/runtime report and operator maintenance still require `API_TOKEN` when configured;
4. keep `API_TOKEN` behavior unchanged and defer relay/server credential migration.

Recommended later batch RLP3-A3: server credential enforcement migration.

Scope:

1. introduce a server/relay credential such as `AGENTCHAT_SERVER_TOKEN` or a per-server token store;
2. add `requireServerCredential(serverId)` for `/api/servers/*` and host-owned runtime report paths;
3. keep `API_TOKEN` accepted only behind an explicit compatibility flag during migration;
4. update relay clients to prefer server credential for heartbeat/runtime/offline after the credential model is approved.

Recommended batch RLP3-B: dashboard boundary.

Scope:

1. add local-only or explicit-auth gate for mutating dashboard proxy routes;
2. protect queue mutation and tmux injection surfaces first;
3. keep read-only local dashboard behavior compatible until operator chooses web auth model.

Recommended batch RLP3-C: Matrix trust default decision.

Scope:

1. decide whether `MATRIX_TRUST_MODE` should default to `enforce` for mutating commands;
2. add tests for empty allowlists and untrusted rooms;
3. preserve audit mode only as explicit compatibility config.

Known test gap:

Local Matrix trust tests can be blocked by the optional native Matrix crypto package on macOS. Keep Matrix dependency behavior under Phase 7/R-029/R-024 rather than hiding it.

Verification:

- targeted API auth tests for the changed surface;
- Matrix tests when Matrix bridge behavior changes;
- `npm run verify:ci`;
- `npm run verify:cd-preflight`.

## Phase 4: Path Normalization

Current evidence:

- `lib/runtime-dir-guard.js` already guards stale runtime roots.
- `lib/mcp-server-core.js` currently sets `MEDIA_FETCH_CACHE_DIR` with `path.resolve('data', 'mcp-media-cache', AGENT_NAME)`, so MCP media cache can land under the caller's current project directory.
- `remote/lib/mcp-server-core.js` mirrors this behavior and must stay synchronized when fixed.

Completed batch RLP4-A: MCP media cache relocation.

Scope:

1. compute MCP media cache under `AGENTCHAT_AGENT_STATE_DIR` when available;
2. otherwise use a stable runtime data dir derived from `AGENT_CHAT_RUNTIME_DIR` or the agentchat home;
3. keep root and remote `lib/mcp-server-core.js` mirrored;
4. add tests that prove media cache no longer writes into arbitrary cwd.

Files likely touched:

- `lib/mcp-server-core.js`
- `remote/lib/mcp-server-core.js`
- `tests` for MCP media/cache path behavior
- possibly `scripts/check-remote-sync.sh` only if mirror rules need an explicit assertion

Verification:

- targeted MCP cache test;
- `npm run check:remote-sync`;
- `npm run check:remote-package-smoke`;
- `npm run verify:ci`;
- `npm run verify:cd-preflight`.

Risk:

Existing message attachment outputs can contain `LocalPath:` values under the old cache root. Moving the cache can leave stale old cached files, but it should not change durable message truth.

Recommended next Phase 4 batch RLP4-B: v1 home/runtime resolver tests.

Scope:

1. add tests for `lib/agent-home-v1.js` env precedence and absolute normalization;
2. preserve legacy `~/.agentchat` fallback behavior;
3. do not change launch files or provisioning behavior in the same batch.

## Phase 5: Launch Decomposition

Status:

Frozen until ac-topleader explicitly clears launch work.

Do not edit:

- `bin/agent-up`
- `remote/bin/agent-up`

Allowed before approval:

1. read-only launch decomposition notes;
2. test design for quoting/env injection;
3. inventory of shared launcher functions that could be extracted later.

This phase should not block Phase 4 cache cleanup or Phase 6 CLI help/profile cleanup, as long as those batches avoid launch internals.

## Phase 6: CLI And Ops Profile Cleanup

Current evidence:

- Phase 1 made root and remote `agentchat` command surfaces honest.
- `scripts/cli-command-manifest.json` is now the command contract source for root/remote dispatch checks.
- Some commands still need clearer host/backend/profile wording in help and operations docs.

Completed batch RLP6-A: profile-scoped help and docs.

Scope:

1. make `agentchat service`, `agentchat update`, `agent-ls`, and `agent-down` help text explicit about current-host services, remote relay, backend registry context, and local tmux shutdown scope;
2. keep remote command set aligned with `scripts/cli-command-manifest.json`;
3. update `OPERATIONS.md` command scope where needed;
4. add help-scope assertions to `check:cli-contract` and `check:remote-package-smoke`.

Verification:

- `npm run check:cli-contract`;
- `npm run check:remote-sync`;
- `npm run check:remote-package-smoke`;
- `npm run verify:ci`.

Recommended later batch RLP6-B: shell resolver consistency.

Scope:

1. align `agent-ls` home/runtime defaults with `lib/agent-home-v1.js` semantics without touching launch;
2. add shell-level tests with fake `tmux`/`curl` for `agent-down` name resolution and backend-unavailable refusal;
3. avoid changing shutdown behavior in this batch.

## Phase 7: CI And Release Gates

Current state:

- GitHub Actions runs `npm run verify:ci` on `master` and `stable`.
- `verify:ci` includes syntax, CLI contract, remote sync, generated remote package smoke, dependency isolation, and kernel/CLI smoke.
- `npm run audit:deps` remains separate because the current advisory baseline is not fixed.
- CD-A remains pending for stable/live release gate and dependency retry state.

Recommended batch RLP7-A: keep gates attached to each repair.

Policy:

1. every Phase 2-6 code batch must add or update a targeted test;
2. every batch must pass `npm run verify:ci`;
3. every deploy-relevant batch must pass clean `npm run verify:cd-preflight`;
4. after stable deployment, verify the remote side with `agentchat verify-remote --expect-version <short-sha>`;
5. do not make `audit:deps` blocking until R-024 dependency remediation is complete.

Recommended batch RLP7-B: dependency audit repair.

Scope:

1. inspect current `npm run audit:deps` output;
2. decide upgrade vs documented temporary allowlist;
3. add the chosen dependency policy to `verify:ci` only when it is green.

## Recommended Implementation Order

1. RLP4-A MCP media cache relocation. Completed after ac-topleader approval.
2. RLP2-A runtime observation provenance. Completed after ac-topleader approval.
3. RLP6-A profile-scoped help/docs. Completed after ac-topleader approval.
4. RLP3-A auth readiness diagnostics. Completed after ac-topleader approval.
5. CD-A stable release gate and dependency retry, once ac-topleader approves `14-cd-next-decisions.md`.
6. RLP3-B dashboard local-only/auth gate.
7. RLP3-C Matrix trust default.
8. RLP2-B local-host server record.
9. RLP7-B dependency audit remediation.
10. Phase 5 launch decomposition only after the launch freeze is lifted.

## Next Approval Requests

The next low-risk candidates are:

1. RLP2-B local-host server record design;
2. RLP4-B v1 home/runtime resolver contract tests;
3. RLP3-A2 server credential split design/tests;
4. CD-A stable release gate and dependency retry state, once deploy behavior changes are approved.

These should keep avoiding launch, stable, deploy scripts, dashboard auth, Matrix, and default observation behavior unless ac-topleader explicitly approves that narrower batch.
