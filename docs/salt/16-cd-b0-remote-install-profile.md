# 16 CD-B0 Remote Install Profile

Date: 2026-05-03
Status: safe non-deploy decision-support contract.

## Scope

This batch does not change remote install, remote autodeploy, service manager, launchd, helper symlink, or dependency behavior.

It freezes the current facts behind the remaining remote CD decisions so later implementation cannot accidentally treat them as already covered by `verify:ci` or `verify:cd-preflight`.

## Current Facts

| ID | Area | Current fact | Decision needed |
| --- | --- | --- | --- |
| R-047 | Remote install helper profile | Current full-clone installs link helpers from root `bin/` when it exists. Generated remote package checks validate `remote/bin/agentchat`, but full-clone install can expose the root command surface. | Decide whether full-clone remote installs are always remote-profile, root-profile, or explicitly selectable. |
| R-048 | Remote dependency reproducibility | Remote runtime dependencies are currently lockless from git/CD perspective. `remote/package-lock.json` can exist locally, but it is ignored by `.gitignore` and excluded from generated packages. | Decide tracked lock plus `npm ci --omit=dev`, explicitly lockless semver installs, or generated release lock. |
| R-049 | Standalone remote package version | Standalone `remote-dist` packages currently have no packaged version file. Relay heartbeat `version` comes from `git rev-parse --short HEAD`, so `verify-remote --expect-version` is meaningful for git checkout deployments but not standalone packages without `.git`. | Decide whether standalone packages are production CD artifacts. If yes, inject a build version and make the relay prefer it when `.git` is unavailable. |
| R-050 | Remote CD install reconciliation | Remote autodeploy remains code/dependency/restart only and does not rerun `remote/install-remote.sh`. Service units, helper symlinks, sudoers rules, launchd plists, and MCP config can require manual install/update. | Decide whether remote CD owns service/helper reconciliation, or whether operators must run install/update for those changes. |

## Static Gate

`tests/remote-install-profile.test.js` asserts these facts and their decision documents together:

1. full-clone helper source selection remains visible;
2. remote package lock behavior remains explicit and not silently enforced;
3. standalone package version limitations remain documented;
4. remote autodeploy install-scope limitations remain documented.

These tests intentionally do not approve a behavior. When a decision is made, the implementation batch should update both the code and these decision-support tests.

## Next Safe Step

The next safe CD-B0 work item is a pure install-path test harness around `remote/install-remote.sh` only if ac-topleader approves adding default-off dry-run hooks. Without those hooks, executing the installer in tests would touch real service managers, helper symlinks, MCP config, and package install state.
