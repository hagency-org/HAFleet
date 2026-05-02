# 13 CD Flow And Gaps

Date: 2026-05-03
Status: CD audit and decision table.

## Current State

The first gate is now a CI gate, not a complete CD gate.

`npm run verify:ci` proves source-level and package-level contracts before deployment:

1. environment report;
2. JavaScript and shell syntax;
3. root and remote CLI command manifest contract;
4. generated remote package and remote sync checks;
5. dependency isolation;
6. kernel and CLI smoke tests.

That is necessary but not sufficient for CD. A deployed host can still fail after the source gate passes if the service manager loads an old process, remote dependencies are stale, a wrapper resolves a different tree, the remote helper symlink points at the wrong profile, or the backend sees no post-restart heartbeat.

## Runtime Observation

Local CLI observation after the push-relay idle fix showed the useful CD signals:

- `agent-chat-push-relay` was restarted through `agentchat service restart --profile remote`.
- `agentchat verify-remote --no-service --samples 2 --interval 16 --agent salt` passed. A 3 second interval failed because it was below the 15 second heartbeat cadence, which is expected.
- `/api/servers` reported `kamico-MBP` online with `version=f24cb17`.
- `agentchat cli status aoi`, `agentchat cli status nazuna`, and `agentchat cli status yamori` agreed with raw `/api/agents/<name>` runtime fields: inactive panes reported `activeNow=false`.
- `agentchat cli status salt` stayed active while tools were running, which is correct because the active Codex pane content is changing.

This proves the deployed relay can expose a loaded commit through the backend, but the current CD scripts do not enforce that check.

## Findings

### CD-000 Autodeploy Does Not Wait For A Green Release Gate

Evidence:

- `.github/workflows/ci.yml:3` runs CI on `master` and `stable` pushes.
- `scripts/agentchat-stable-autodeploy.sh:144` starts polling and deploying from `origin/stable` independently.
- `scripts/agentchat-stable-autodeploy.sh:171` resets the live checkout to `origin/stable` without first checking GitHub Actions status or running local preflight on the target commit.

Impact:

A bad commit pushed to `stable` can be deployed before GitHub Actions has finished or failed. The CI gate exists, but CD does not consume its result.

Fix direction:

Add a release gate before live reset/restart:

- either query GitHub commit status/check-runs for the target commit and require green;
- or run `verify:ci` in a staging worktree for the target commit before mutating the live checkout.

### CD-001 Remote Autodeploy Has No Post-Deploy Verification

Evidence:

- `scripts/agentchat-remote-autodeploy.sh:113` treats `restart_relay` success as deploy success.
- `remote/install-remote.sh:354` runs `verify-remote`, but that hard verification is only part of install/update, not the polling autodeploy loop.
- `bin/verify-remote:187` verifies heartbeat continuity and `bin/verify-remote:243` can verify one agent, but `agentchat-remote-autodeploy.sh` never calls it.

Impact:

The remote watcher can report a successful deploy when launchd/systemd accepted a restart but the relay did not reconnect, did not heartbeat, loaded old code, or connected with the wrong server id.

Fix direction:

Add a post-deploy verification step for remote autodeploy:

- run `verify-remote` after restart with deploy-safe samples and interval;
- support an expected commit/version check;
- keep `deploy_pending=true` when verification fails.

### CD-002 Remote Autodeploy Installs Dependencies In The Wrong Tree

Evidence:

- `scripts/agentchat-remote-autodeploy.sh:18` only watches root `package.json` and `package-lock.json`.
- `scripts/agentchat-remote-autodeploy.sh:21` runs `npm install --omit=dev` in `$REPO_DIR`.
- `remote/install-remote.sh:146` installs dependencies from inside `remote/`.
- `remote/package.json:10` owns the remote runtime dependencies used by `remote/mcp-server.js`.

Impact:

If the remote package dependencies change without a root dependency change, autodeploy can restart a relay/MCP checkout with stale `remote/node_modules`. The install path used by autodeploy does not match the install path used by first-time remote provisioning.

Fix direction:

Remote autodeploy should watch both root and `remote/` dependency manifests, but install remote runtime dependencies in `remote/`. Root install should only happen if the chosen deploy model explicitly runs root services on that host.

### CD-002A Failed Dependency Installs Can Be Skipped On Retry

Evidence:

- `scripts/agentchat-stable-autodeploy.sh:171` resets the checkout before dependency installation.
- `scripts/agentchat-stable-autodeploy.sh:180` sets `deploy_pending=true` when dependency installation fails.
- The next retry compares the now-current `HEAD` to itself, so `maybe_install_deps` can see an empty diff.
- The same pattern exists in `scripts/agentchat-remote-autodeploy.sh:98` and `scripts/agentchat-remote-autodeploy.sh:107`.

Impact:

After an `npm install` failure, the next retry can restart services without installing dependencies that were required by the already-reset commit.

Fix direction:

Persist the dependency-install-needed state across retry, or compute dependency changes against the last successfully deployed commit rather than current `HEAD`.

### CD-003 macOS Remote Hosts Do Not Get An Autodeploy Watcher

Evidence:

- `remote/install-remote.sh:190` installs `agent-chat-remote-autodeploy` only in the Linux/systemd branch.
- `remote/push-relay-autodeploy.service:11` exists only as a systemd unit template.
- `remote/push-relay.plist:9` defines only the push-relay launchd service, not the remote autodeploy watcher.

Impact:

macOS remote hosts can run push-relay, but they do not get the polling CD watcher from `install-remote.sh`. They rely on manual `agentchat update` or operator restarts, so remote/local CD behavior diverges.

Fix direction:

Operator decision required:

- either declare macOS remote hosts manual-update only;
- or add a launchd plist/runner for `agentchat-remote-autodeploy.sh`.

### CD-004 Loaded Commit Is Observable But Not Enforced

Evidence:

- `lib/push-relay-core.js:45` computes `RELAY_VERSION` from git.
- `lib/push-relay-core.js:482` sends `version` in heartbeat when available.
- `bin/verify-remote:187` checks server online and heartbeat monotonicity, but does not compare `version` to an expected commit.

Impact:

CD can observe the loaded relay commit, but no gate fails when a service restart leaves old code running.

Fix direction:

Add `verify-remote --expect-version <short-sha>` or a separate CD check that compares `/api/servers[].version` to `git rev-parse --short HEAD`.

### CD-005 Generated Package Smoke Covers Push Relay Wrapper But Not MCP Wrapper

Evidence:

- `scripts/check-remote-package-smoke.sh:74` starts wrapper resolution smoke.
- `scripts/check-remote-package-smoke.sh:75` only runs `push-relay.js`.
- `remote/mcp-server.js` has its own wrapper/core resolution path.

Impact:

A broken generated MCP wrapper can pass the current package smoke while remote MCP injection fails after deployment.

Fix direction:

Extend generated package smoke to check `mcp-server.js` wrapper resolution with a safe wrapper-smoke mode.

### CD-005A Remote Autodeploy Service Is Not In The Generated Package Gate

Evidence:

- `scripts/build-remote-package.sh:56` defines the generated remote package manifest.
- `remote/push-relay-autodeploy.service:11` is the Linux remote autodeploy service entrypoint.
- `scripts/check-remote-package-smoke.sh:19` checks required generated package files, but does not require or inspect the autodeploy service template.

Impact:

Remote package checks can pass while the service template that runs remote CD is missing, stale, or references the wrong script path.

Fix direction:

Include `remote/push-relay-autodeploy.service` in generated package management and smoke-check its placeholders and `ExecStart` target.

### CD-006 CLI Status Still Has A session_activity Diagnostic Fallback

Evidence:

- `bin/agent-chat-cli:81` builds a tmux snapshot from `#{session_activity}`.
- The fallback is used only when backend runtime metrics do not provide `idleDurationSec`.

Impact:

Normal deployed observation uses backend runtime fields and is currently correct. If runtime metrics are missing, CLI diagnostics can fall back to the old session-wide idle signal and show misleading active/idle state.

Fix direction:

Replace the diagnostic fallback with pane-content snapshot semantics or label it as a weak fallback. This is lower priority than CD-001 through CD-004.

### CD-007 Operations Runbook Does Not Match Destructive Deploy Behavior

Evidence:

- `OPERATIONS.md:37` says stable deploy uses `git pull --ff-only origin stable`.
- `scripts/agentchat-stable-autodeploy.sh:112` runs a dirty-worktree cleaner.
- `scripts/agentchat-stable-autodeploy.sh:171` resets the live checkout to `origin/stable`.

Impact:

Operators may assume live deploy is non-destructive and preserve local changes, while the actual watcher can discard dirty and untracked files in the deploy checkout.

Fix direction:

Update the runbook after the CD policy is approved. The deploy checkout should be explicitly documented as disposable and never used for local edits.

## Proposed CD Gate Model

### Stage A: Source Preflight

Runs before merge or before a deploy watcher accepts a commit:

- `npm run verify:ci`;
- `npm run verify:cd-preflight` on the candidate deploy checkout;
- `npm run audit:deps` once R-024 dependency debt is fixed;
- generated package smoke for both push-relay and MCP wrappers.

This stage is safe on any checkout and has no service side effects.

For live/stable CD, this stage must be consumed before mutating the live checkout. A GitHub Actions run that starts after `stable` push is not enough unless the watcher waits for the target commit's checks to pass.

### Stage B: Remote Package Preflight

Runs on the target host before restart:

- confirm branch and commit: `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD`;
- `npm run build:remote:check`;
- `npm run check:remote-sync`;
- `npm run check:remote-package-smoke`;
- if dependency manifests changed, install dependencies in the runtime tree that the service actually uses.

This stage is safe except for dependency installation. It still does not restart services.

### Stage C: Deploy

Runs only in the deploy environment:

- clean deploy worktree;
- reset to `origin/<deploy-branch>`;
- install changed dependencies;
- restart services in the correct order.

For the remote profile, the deploy service is `agent-chat-push-relay`.

### Stage D: Post-Deploy Verification

Runs after service restart:

- `agentchat service status --profile remote`;
- `agentchat verify-remote --samples 2 --interval 16`;
- compare backend `/api/servers[].version` to the expected short commit;
- when a known agent is configured, run `agentchat verify-remote --agent <name>`;
- run `agentchat cli status <agent>` or `agentchat cli status` as a human-readable diagnostic smoke.

This is the missing CD layer that would have made the idle/relay deployment state immediately visible.

## Decisions Needed

| Decision | Options | Recommendation |
| --- | --- | --- |
| Release gate source | wait for GitHub Actions checks, or run preflight in a staging worktree | Prefer staging worktree if GitHub API/token is not guaranteed on deploy hosts; otherwise require green check-runs. |
| macOS remote CD | manual update only, or launchd autodeploy watcher | Decide explicitly. If macOS is a first-class remote host, add launchd watcher. |
| Expected version check | add `verify-remote --expect-version`, or separate script | Add it to `verify-remote`; that keeps the operator command simple. |
| Known-agent postdeploy check | no agent, configured optional `VERIFY_AGENT`, or mandatory canary agent | Optional `VERIFY_AGENT` first; later promote a canary agent. |
| Dependency install scope | root only, remote only, or both by changed manifests | Remote autodeploy should install `remote/` deps for relay/MCP. Stable/live deploy should install root deps. |
| Dependency retry state | recompute from current `HEAD`, persist install-needed marker, or compare against last successful deploy | Compare against last successful deploy; fallback to a persisted install-needed marker. |
| Autodeploy failure behavior | log-only, retry pending, or rollback | Keep retry pending first. Rollback needs a separate operator decision. |

## Proposed Repair Table

| ID | Priority | Scope | Repair | Verification |
| --- | --- | --- | --- | --- |
| CD-000 | P0 | Stable CD | Add a pre-reset release gate so stable/live deploy waits for green CI or runs `verify:ci` in a staging worktree. | Simulated target commit gate plus deploy-host dry run. |
| CD-001 | P0 | Remote CD | Run post-deploy `verify-remote` from remote autodeploy and keep `deploy_pending=true` on failure. | Simulated autodeploy script test plus manual remote run. |
| CD-002 | P0 | Remote deps | Install dependencies in `remote/` when `remote/package*.json` changes. | Script unit/smoke with fake git refs and generated temp repo. |
| CD-002A | P0 | CD deps | Preserve dependency-install-needed state across retry after failed install. | Fake deploy repo test where first install fails and second retry must install before restart. |
| CD-003 | P1 | Loaded commit | Add expected version check to `verify-remote`. | `verify-remote --expect-version <sha>` pass/fail tests and real remote smoke. |
| CD-004 | P1 | Package smoke | Add MCP wrapper resolution smoke. | `npm run check:remote-package-smoke`. |
| CD-005 | P1 | macOS CD | Decide and implement launchd autodeploy watcher or document manual-only policy. | macOS launchctl status and `agentchat service status --profile remote`. |
| CD-005A | P1 | Remote package | Include and smoke-check `push-relay-autodeploy.service` in the generated remote package. | `npm run build:remote:check` and `npm run check:remote-package-smoke`. |
| CD-006 | P2 | CLI diagnostics | Remove or label `session_activity` fallback in `agent-chat-cli`. | CLI status tests with missing backend runtime metrics. |
| CD-007 | P2 | Ops docs | Update operations runbook to describe destructive deploy checkout behavior. | Docs review against autodeploy scripts. |

## Immediate Next Batch

The first safe preflight slice is now implemented for items 1, 2, and 4:

1. Add `verify-remote --expect-version`.
2. Extend generated remote package smoke to include MCP wrapper resolution.
3. Add a non-destructive `scripts/verify-cd-preflight.sh` that composes existing source/package checks and prints the expected commit.
4. Include `push-relay-autodeploy.service` in remote package smoke.
5. Update remote autodeploy design to call post-deploy verification, but only implement restart-loop behavior after operator approves exact remote failure policy.

Remaining item from this list is the remote autodeploy post-deploy integration. The release-gate and dependency-retry repairs should be the next P0 batch after ac-topleader confirms whether deploy hosts should use GitHub status checks or a staging worktree preflight.
