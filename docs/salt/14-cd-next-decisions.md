# 14 CD Next Decisions

Date: 2026-05-04
Status: stable watcher, remote dependency scope, and remote post-deploy verification implemented; remaining stable policy, macOS, and remote state decisions still pending.

## Current CD Baseline

The repository now has a source/package verification layer, but the deploy watchers still own the actual mutation and restart path.

Implemented gates:

1. `npm run verify:ci` validates syntax, CLI contracts, remote package shape, remote/local drift, dependency isolation, and kernel/CLI smoke tests.
2. `npm run verify:cd-preflight` validates a candidate checkout, requires a clean tree by default, runs `verify:ci`, and prints the expected post-deploy version check.
3. `tests/verify-cd-preflight.test.js` locks the preflight wrapper contract without touching deploy watchers.
4. `hafleet verify-remote --expect-version <short-sha>` can verify heartbeat continuity and loaded remote relay commit after deployment.
5. Remote package smoke now checks both push-relay and MCP wrapper resolution, plus the Linux remote autodeploy service template.
6. Remote autodeploy calls `verify-remote --expect-version <short-sha>` after relay restart, using deploy-safe samples and optional `VERIFY_AGENT`.

Not implemented yet:

1. stable/live release gate support exists but must be enabled explicitly with `HAFLEET_RELEASE_GATE=worktree` on the deploy host.
2. remote deploy failure state is still mostly in memory; durable state and rollback remain separate decisions.
3. macOS remote hosts install launchd for push-relay but no launchd remote autodeploy watcher.

## Environment Split

The current operator topology is useful for CD validation:

- ac-topleader is effectively on the local/stable deployment side and can observe the live stable CD environment.
- salt is effectively on the remote/client side and can observe remote relay, MCP wrapper, loaded commit, heartbeat, and CLI status behavior through hafleet.

That split should be kept in the CD process. A complete release should require both:

1. local/stable deploy acceptance: the deploy host accepts the target commit only after a release gate;
2. remote/client acceptance: remote relay reports the expected commit and backend-visible runtime state after restart.

## Decision 1: Stable Release Gate

Problem:

`scripts/hafleet-stable-autodeploy.sh` fetches `origin/stable` and resets the live checkout without waiting for the target commit's CI result.

Options:

1. GitHub checks gate: query commit status/check-runs for `origin/stable` and deploy only after the required workflow is green.
2. Staging worktree gate: create or reuse a separate staging checkout for the target commit and run `npm run verify:cd-preflight` there before mutating the live checkout.
3. Operator-only gate: require humans to push to stable only after CI is green, with no deploy-host enforcement.

Recommendation:

Prefer the staging worktree gate first. It uses the project's own gate without requiring a GitHub token on the deploy host, can be tested locally with a fake repository, and keeps stable deploy behavior deterministic. GitHub checks can be added later as an optimization when deploy-host credentials and required check names are settled.

Implemented in CD-A:

1. `HAFLEET_RELEASE_GATE=none|worktree` now exists, defaulting to `none` until the live deploy service opts in;
2. before `force_clean_workdir` and the live `git reset --hard`, `worktree` mode creates a detached staging worktree outside the live checkout under the deploy state dir;
3. the staging worktree checks out the target `remote_ref`;
4. it runs `npm run verify:cd-preflight` from that staged checkout before mutating the live checkout;
5. if preflight fails, the watcher logs and retries the next poll without cleaning or resetting the live checkout.

Important branch detail:

The staging worktree should normally check out the target commit detached. The live deploy checkout may already occupy the `stable` branch, and Git worktrees cannot safely check out the same branch in two places. Therefore the script should verify that the target ref came from `origin/$DEPLOY_BRANCH`, then run `npm run verify:cd-preflight` in the detached gate worktree without `--branch stable`. The `--branch stable` form remains useful for a human candidate checkout that is actually on the `stable` branch.

Operational decision still needed:

After this batch reaches stable, ac-topleader should decide when to set `HAFLEET_RELEASE_GATE=worktree` in the live stable autodeploy environment. Until that is configured, the code path exists and is tested but the live watcher keeps current behavior.

## Decision 2: Dependency Retry State

Problem:

Both autodeploy scripts reset to the target commit before dependency installation. If install fails, the retry sees `HEAD` already equal to the target commit and can compute no manifest diff.

Affected files before CD-A:

- `scripts/hafleet-stable-autodeploy.sh`
- `scripts/hafleet-remote-autodeploy.sh`

Options:

1. Compare dependency manifests against the last successfully deployed commit.
2. Persist an install-needed marker when dependency installation fails and clear it only after a successful install.
3. Always run dependency installation on every retry while `deploy_pending=true`.

Recommendation:

Use last-successful commit as the primary model, with an install-needed marker as a fallback for interrupted runs. This makes retries correct without forcing every restart path to reinstall.

Implemented for stable/live in CD-A:

1. `HAFLEET_DEPLOY_STATE_DIR` defaults under the absolute git dir at `.git/hafleet-autodeploy`, so `git clean -fd` in the live checkout does not delete deploy state;
2. `last-successful-ref` is written only after dependency installation, backend restart, backend health, dependent restarts, and service-active checks pass;
3. the first deploy initializes `last-successful-ref` from the pre-reset live `HEAD`;
4. failed dependency installation leaves an `install-needed` marker;
5. a retry at the already-reset target commit uses the last successful baseline and reruns dependency installation before restarting services.

Remote status:

Remote autodeploy now preserves the dependency-install-needed retry marker and installs the remote runtime dependency tree. Broader remote deploy state, such as restart/verification failure across watcher restarts, remains a separate RAU-D/R-075 decision.

## Decision 3: Remote Dependency Install Scope

Problem:

`remote/install-remote.sh` installs dependencies from `remote/`; remote autodeploy must keep using the dependency tree that push-relay and MCP wrappers actually run.

Status:

Resolved for the current remote profile. `scripts/hafleet-remote-autodeploy.sh` watches `remote/package.json` and `remote/package-lock.json`, then runs `npm install --omit=dev` inside `remote/`. Root `package*.json` changes still deploy and restart the relay, but they do not trigger a root dependency install.

Options:

1. Remote-only install: watch `remote/package.json` and `remote/package-lock.json`, install inside `remote/`.
2. Root plus remote install: watch both root and remote manifests, installing in each tree only when its manifest changes.
3. Root-only install: keep current behavior.

Recommendation:

Use root plus remote install only if remote hosts actually run root scripts after deploy. For the current remote profile, remote-only install is the safer default because push-relay and MCP wrappers execute the remote runtime tree packaged by `remote/install-remote.sh`.

Remaining boundary:

If remote hosts become root-service hosts later, that should be a separate profile decision. The current remote profile is remote-runtime only.

## Decision 4: Remote Post-Deploy Verification

Problem:

Resolved for the current git-checkout remote profile. `scripts/hafleet-remote-autodeploy.sh` no longer treats service-manager restart success alone as deploy success.

Implemented behavior:

1. After `restart_relay`, run `verify-remote` with `--expect-version "$(git rev-parse --short HEAD)"`.
2. Use deploy-safe defaults: `--samples 2 --interval 16`.
3. Pass `--api`, `--server`, and token from the existing remote `.env` values.
4. Pass `--agent "$VERIFY_AGENT"` only when configured.
5. Keep `deploy_pending=true` when verification fails, then retry on the next poll.

Remaining boundary:

Rollback to the last known good ref and durable restart/verification failure state remain separate operator decisions under RAU-D/R-075 and RAU-G/R-078.

## Decision 5: macOS Remote CD Policy

Problem:

Linux remote install provisions `hafleet-remote-autodeploy` as a systemd service. macOS remote install provisions only the push-relay launchd service.

Options:

1. Document macOS remote hosts as manual-update-only.
2. Add a launchd runner and plist for remote autodeploy.

Recommendation:

If macOS remote hosts are first-class deploy targets, add a launchd watcher. If they are mainly developer/client machines, document manual-update-only and require `hafleet update` plus `verify-remote` for macOS updates.

Decision needed:

Pick one policy. The system should not leave macOS remote CD behavior implicit.

## Decision 6: Full Clone Remote Command Surface

Problem:

`remote/install-remote.sh` can run from a full source clone. In that case it currently prefers the root `bin/` directory when root `bin/hafleet-up` exists, so the installed `hafleet` helper can expose the root command surface instead of the remote-scoped `remote/bin/hafleet` surface. The generated remote package smoke validates the remote-scoped command surface, not this full-clone install path.

Options:

1. Remote profile always links `remote/bin/hafleet`, even from a full clone.
2. Full clone remotes intentionally expose the root command surface and docs/tests say so.
3. Add an explicit install flag, such as `HAFLEET_REMOTE_BIN_PROFILE=root|remote`, and require operators to choose.

Recommendation:

Prefer remote-scoped helpers by default for remote installs. Root command exposure should be an explicit operator choice because it includes commands that are not packaged or meaningful on a remote relay host.

Decision needed:

Decide whether full clone remote installs are remote-profile installs or root-profile installs.

## Decision 7: Remote Dependency Reproducibility

Problem:

`remote/package-lock.json` can exist locally but is ignored by `.gitignore` and excluded from generated packages. That means remote dependency resolution is not pinned by the repository even though a local lock file can make the tree look reproducible.

Options:

1. Track `remote/package-lock.json` and use `npm ci --omit=dev` for remote installs.
2. Keep remote packages lockless, delete stale ignored locks, and document that remote dependency resolution is semver-based.
3. Generate a lock only in release packaging and include it in the generated artifact.

Recommendation:

Prefer a tracked remote lock if remote hosts are production CD targets. If remote packages are intentionally lightweight/developer-oriented, remove stale ignored locks and document lockless installs explicitly.

Decision needed:

Choose whether remote runtime dependencies are pinned by git or intentionally floating within semver ranges.

## Decision 8: Standalone Remote Package Version

Problem:

`verify-remote --expect-version` depends on the relay heartbeat `version`, which currently comes from `git rev-parse --short HEAD`. A generated standalone remote package without `.git` reports no version, so the loaded-commit gate cannot verify standalone deployments.

Options:

1. Treat full git clones as the only supported CD target for `--expect-version`.
2. Inject a build version file or env value into generated remote packages.
3. Accept versionless standalone packages and skip expected-version checks for them.

Recommendation:

If standalone `remote-dist` is a first-class deployment artifact, inject a build version into the package and make relay heartbeat prefer it when `.git` is unavailable. Otherwise document that expected-version verification requires a git checkout.

Decision needed:

Decide whether standalone remote packages are production CD artifacts or only installation/bootstrap artifacts.

## Decision 9: Remote Autodeploy Install Scope Beyond Dependencies

Problem:

Remote autodeploy only resets code, optionally installs dependencies, and restarts relay. It does not rerun `remote/install-remote.sh`, so service unit changes, helper symlink changes, sudoers changes, and MCP config changes can remain unapplied until an operator runs manual update/install.

Options:

1. Autodeploy reruns a safe noninteractive install/update step after code changes.
2. Autodeploy remains code/dependency/restart only, and service/helper changes require explicit operator update.
3. Split install into independently testable subcommands, then allow autodeploy to run only approved idempotent subcommands.

Recommendation:

Keep autodeploy code/dependency/restart only until install side effects are decomposed and tested. Document manual operator steps for service/helper changes in the meantime.

Decision needed:

Decide whether remote CD owns service/helper reconciliation, or only application code plus dependency restart.

## Test Strategy

All next-batch code changes should be tested without touching live deployment:

1. Fake git repository tests for release-gate and dependency-retry logic.
2. Script-level dry-run hooks for service restart and `verify-remote` invocation.
3. Install-path tests for full-clone remote helper profile selection.
4. Dependency reproducibility tests for whichever remote lock policy is selected.
5. Generated package smoke for any new remote service/plist files.
6. A manual two-sided acceptance run after stable merge:
   - local/stable side: run the approved preflight and observe autodeploy logs;
   - remote side: run `hafleet verify-remote --samples 2 --interval 16 --expect-version <short-sha>` and spot-check `hafleet cli status`.

Implemented test files:

- `tests/stable-autodeploy.test.js`
- `tests/remote-install-profile.test.js`
- `tests/remote-autodeploy.test.js`

Suggested CD-A harness knobs for `scripts/hafleet-stable-autodeploy.sh`:

1. `HAFLEET_ONCE=1` to execute one poll/deploy cycle and exit;
2. `HAFLEET_SYSTEMCTL_BIN=<path>` or a wrapper function so tests can fake restart and status checks;
3. `HAFLEET_NPM_BIN=<path>` or a wrapper function so tests can force install pass/fail;
4. `HAFLEET_RELEASE_GATE=none|worktree`;
5. `HAFLEET_DEPLOY_STATE_DIR=<tmpdir>`.

Suggested CD-A tests:

1. stable autodeploy does not reset the live checkout when the worktree release gate fails;
2. stable autodeploy resets and restarts only after the worktree release gate passes;
3. stable autodeploy retries dependency install after a failed install without restarting services;
4. stable autodeploy records `last-successful-ref` only after restart and health checks pass.

## Recommended Approval Order

1. Batch CD-A: stable release gate and dependency retry state for `scripts/hafleet-stable-autodeploy.sh` only, with fake-repo tests. Implemented.
2. Batch CD-B: remote dependency install scope and remote post-deploy `verify-remote` integration are implemented with retry-pending failure behavior.
3. Batch CD-C: macOS remote CD policy implementation or manual-update documentation.
4. Batch CD-D: optional GitHub check-runs gate if staging worktree is not enough or if deploy-host GitHub credentials are approved.

The next remote CD code batch should wait for ac-topleader to choose durable remote deploy state, rollback, or macOS policy.

## CD-A Implemented Scope

CD-A intentionally avoided remote/macOS work. Its purpose was to make the stable/live deploy watcher testable and safe enough before copying the same pattern to remote CD.

Edited only:

1. `scripts/hafleet-stable-autodeploy.sh`
2. `tests/stable-autodeploy.test.js`
3. `package.json` to include `tests/stable-autodeploy.test.js` in `test:kernel`

Do not edit in CD-A:

1. `scripts/hafleet-remote-autodeploy.sh`
2. macOS launchd plist files
3. remote package smoke, unless stable-CD tests expose a shared package issue
4. `.github/workflows/ci.yml`
5. `bin/hafleet-up` or `remote/bin/hafleet-up`
