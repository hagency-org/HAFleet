# 14 CD Next Decisions

Date: 2026-05-03
Status: decision pack; docs/analysis only.

## Current CD Baseline

The repository now has a source/package verification layer, but the deploy watchers still own the actual mutation and restart path.

Implemented gates:

1. `npm run verify:ci` validates syntax, CLI contracts, remote package shape, remote/local drift, dependency isolation, and kernel/CLI smoke tests.
2. `npm run verify:cd-preflight` validates a candidate checkout, requires a clean tree by default, runs `verify:ci`, and prints the expected post-deploy version check.
3. `agentchat verify-remote --expect-version <short-sha>` can verify heartbeat continuity and loaded remote relay commit after deployment.
4. Remote package smoke now checks both push-relay and MCP wrapper resolution, plus the Linux remote autodeploy service template.

Not implemented yet:

1. stable/live autodeploy does not wait for a green release gate before resetting the deploy checkout.
2. stable/live and remote autodeploy can skip dependency installation on retry after a failed install.
3. remote autodeploy restarts the relay but does not call `verify-remote` afterward.
4. remote autodeploy watches root dependency manifests, while remote provisioning installs dependencies inside `remote/`.
5. macOS remote hosts install launchd for push-relay but no launchd remote autodeploy watcher.

## Environment Split

The current operator topology is useful for CD validation:

- ac-topleader is effectively on the local/stable deployment side and can observe the live stable CD environment.
- salt is effectively on the remote/client side and can observe remote relay, MCP wrapper, loaded commit, heartbeat, and CLI status behavior through agent-chat.

That split should be kept in the CD process. A complete release should require both:

1. local/stable deploy acceptance: the deploy host accepts the target commit only after a release gate;
2. remote/client acceptance: remote relay reports the expected commit and backend-visible runtime state after restart.

## Decision 1: Stable Release Gate

Problem:

`scripts/agentchat-stable-autodeploy.sh` fetches `origin/stable` and resets the live checkout without waiting for the target commit's CI result.

Options:

1. GitHub checks gate: query commit status/check-runs for `origin/stable` and deploy only after the required workflow is green.
2. Staging worktree gate: create or reuse a separate staging checkout for the target commit and run `npm run verify:cd-preflight` there before mutating the live checkout.
3. Operator-only gate: require humans to push to stable only after CI is green, with no deploy-host enforcement.

Recommendation:

Prefer the staging worktree gate first. It uses the project's own gate without requiring a GitHub token on the deploy host, can be tested locally with a fake repository, and keeps stable deploy behavior deterministic. GitHub checks can be added later as an optimization when deploy-host credentials and required check names are settled.

Implementation shape for CD-A:

1. add an opt-in `AGENTCHAT_RELEASE_GATE=none|worktree` setting, defaulting to current behavior until approved for enforcement;
2. before `force_clean_workdir` and the live `git reset --hard`, create or reuse a staging worktree outside the live checkout, preferably below `.git/agentchat-autodeploy/gate-worktree`;
3. checkout the target `remote_ref` in that staging worktree;
4. run the preflight there before mutating the live checkout;
5. if preflight fails, log and retry the next poll without cleaning or resetting the live checkout.

Important branch detail:

The staging worktree should normally check out the target commit detached. The live deploy checkout may already occupy the `stable` branch, and Git worktrees cannot safely check out the same branch in two places. Therefore the script should verify that the target ref came from `origin/$DEPLOY_BRANCH`, then run `npm run verify:cd-preflight` in the detached gate worktree without `--branch stable`. The `--branch stable` form remains useful for a human candidate checkout that is actually on the `stable` branch.

Decision needed:

Approve one release-gate source. Without this decision, any pushed stable commit can still deploy before CI finishes.

## Decision 2: Dependency Retry State

Problem:

Both autodeploy scripts reset to the target commit before dependency installation. If install fails, the retry sees `HEAD` already equal to the target commit and can compute no manifest diff.

Affected files:

- `scripts/agentchat-stable-autodeploy.sh`
- `scripts/agentchat-remote-autodeploy.sh`

Options:

1. Compare dependency manifests against the last successfully deployed commit.
2. Persist an install-needed marker when dependency installation fails and clear it only after a successful install.
3. Always run dependency installation on every retry while `deploy_pending=true`.

Recommendation:

Use last-successful commit as the primary model, with an install-needed marker as a fallback for interrupted runs. This makes retries correct without forcing every restart path to reinstall.

Implementation shape for CD-A:

1. introduce `AGENTCHAT_DEPLOY_STATE_DIR`, defaulting under `.git/agentchat-autodeploy` so `git clean -fd` in the live checkout does not delete deploy state;
2. persist `last-successful-ref` only after dependency installation, service restart, backend health, and service-active checks pass;
3. compute dependency manifest changes from `last-successful-ref` to `new_ref`, not from the current live `HEAD`;
4. if no state file exists, initialize the baseline from the live `HEAD` before the first reset;
5. preserve an install-needed marker when dependency installation fails, so a process restart cannot lose the retry requirement.

Decision needed:

Approve whether deploy scripts may create a small state file under their existing logs/data area to track last successful deploy and install-needed status.

## Decision 3: Remote Dependency Install Scope

Problem:

`remote/install-remote.sh` installs dependencies from `remote/`, but `scripts/agentchat-remote-autodeploy.sh` only watches root `package*.json` and runs `npm install --omit=dev` from the repository root.

Options:

1. Remote-only install: watch `remote/package.json` and `remote/package-lock.json`, install inside `remote/`.
2. Root plus remote install: watch both root and remote manifests, installing in each tree only when its manifest changes.
3. Root-only install: keep current behavior.

Recommendation:

Use root plus remote install only if remote hosts actually run root scripts after deploy. For the current remote profile, remote-only install is the safer default because push-relay and MCP wrappers execute the remote runtime tree packaged by `remote/install-remote.sh`.

Decision needed:

Decide whether remote hosts are supported as root-service hosts. If not, remote autodeploy should only install the remote runtime dependency tree.

## Decision 4: Remote Post-Deploy Verification

Problem:

`scripts/agentchat-remote-autodeploy.sh` treats service-manager restart success as deploy success. It does not verify backend heartbeat, loaded commit, or a known agent state.

Recommended behavior:

1. After `restart_relay`, run `verify-remote` with `--expect-version "$(git rev-parse --short HEAD)"`.
2. Use deploy-safe defaults: `--samples 2 --interval 16`.
3. Pass `--api`, `--server`, and token from the existing remote `.env` values.
4. Pass `--agent "$VERIFY_AGENT"` only when configured.
5. Keep `deploy_pending=true` when verification fails.

Decision needed:

Approve failure behavior. The conservative first step is retry-pending only; rollback should remain a separate explicit operator decision.

## Decision 5: macOS Remote CD Policy

Problem:

Linux remote install provisions `agent-chat-remote-autodeploy` as a systemd service. macOS remote install provisions only the push-relay launchd service.

Options:

1. Document macOS remote hosts as manual-update-only.
2. Add a launchd runner and plist for remote autodeploy.

Recommendation:

If macOS remote hosts are first-class deploy targets, add a launchd watcher. If they are mainly developer/client machines, document manual-update-only and require `agentchat update` plus `verify-remote` for macOS updates.

Decision needed:

Pick one policy. The system should not leave macOS remote CD behavior implicit.

## Test Strategy

All next-batch code changes should be tested without touching live deployment:

1. Fake git repository tests for release-gate and dependency-retry logic.
2. Script-level dry-run hooks for service restart and `verify-remote` invocation.
3. Generated package smoke for any new remote service/plist files.
4. A manual two-sided acceptance run after stable merge:
   - local/stable side: run the approved preflight and observe autodeploy logs;
   - remote side: run `agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>` and spot-check `agentchat cli status`.

Suggested future test files:

- `tests/stable-autodeploy.test.js`
- `tests/cd-remote-autodeploy.test.js`

Suggested CD-A harness knobs for `scripts/agentchat-stable-autodeploy.sh`:

1. `AGENTCHAT_ONCE=1` to execute one poll/deploy cycle and exit;
2. `AGENTCHAT_SYSTEMCTL_BIN=<path>` or a wrapper function so tests can fake restart and status checks;
3. `AGENTCHAT_NPM_BIN=<path>` or a wrapper function so tests can force install pass/fail;
4. `AGENTCHAT_RELEASE_GATE=none|worktree`;
5. `AGENTCHAT_DEPLOY_STATE_DIR=<tmpdir>`.

Suggested CD-A tests:

1. stable autodeploy does not reset the live checkout when the worktree release gate fails;
2. stable autodeploy resets and restarts only after the worktree release gate passes;
3. stable autodeploy retries dependency install after a failed install without restarting services;
4. stable autodeploy records `last-successful-ref` only after restart and health checks pass.

## Recommended Approval Order

1. Batch CD-A: stable release gate and dependency retry state for `scripts/agentchat-stable-autodeploy.sh` only, with fake-repo tests.
2. Batch CD-B: remote post-deploy `verify-remote` integration and remote dependency install scope, with script-level dry-run tests.
3. Batch CD-C: macOS remote CD policy implementation or manual-update documentation.
4. Batch CD-D: optional GitHub check-runs gate if staging worktree is not enough or if deploy-host GitHub credentials are approved.

The next code batch should not start until CD-A decisions are approved.

## CD-A Proposed Scope

CD-A should intentionally avoid remote/macOS work. Its purpose is to make the stable/live deploy watcher safe enough before copying the same pattern to remote CD.

Edit only:

1. `scripts/agentchat-stable-autodeploy.sh`
2. `tests/stable-autodeploy.test.js`
3. optionally `package.json` if a focused `test:cd` script is useful

Do not edit in CD-A:

1. `scripts/agentchat-remote-autodeploy.sh`
2. macOS launchd plist files
3. remote package smoke, unless stable-CD tests expose a shared package issue
4. `.github/workflows/ci.yml`
5. `bin/agent-up` or `remote/bin/agent-up`
