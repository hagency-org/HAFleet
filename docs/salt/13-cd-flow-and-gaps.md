# 13 CD Flow And Gaps

Date: 2026-05-04
Status: CD audit and current decision table.

## Current State

The first gate is now a CI gate, not a complete CD gate.

`npm run verify:ci` proves source-level and package-level contracts before deployment:

1. environment report;
2. patch hygiene with `git diff --check`;
3. JavaScript and shell syntax;
4. root and remote CLI command manifest contract;
5. generated remote package and remote sync checks;
6. dependency isolation;
7. architecture boundary checks;
8. kernel, backend API, CLI, CD preflight, cleanup, remote/dev/stable autodeploy, and package smoke tests.

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

### CD-000 Stable Release Gate Exists But Is Default-Off

Evidence:

- `.github/workflows/ci.yml:3` runs CI on `master` and `stable` pushes.
- `scripts/agentchat-stable-autodeploy.sh:12` defaults `AGENTCHAT_RELEASE_GATE` to `none`.
- `scripts/agentchat-stable-autodeploy.sh:220` supports a `worktree` release gate that prepares a detached target worktree and runs `npm ci`.
- `scripts/agentchat-stable-autodeploy.sh:243` runs `verify:cd-preflight` in that gate before `scripts/agentchat-stable-autodeploy.sh:343` resets the live checkout.

Impact:

A bad commit pushed to `stable` can still deploy on hosts that keep the default `AGENTCHAT_RELEASE_GATE=none`. The worktree gate exists, but CD policy does not yet require it or consume GitHub check-run status.

Fix direction:

Decide and enforce the release gate policy:

- make the worktree gate default-on for deploy hosts or require it in host configuration;
- or query GitHub commit status/check-runs for the target commit and require green.

### CD-001 Remote Autodeploy Has No Post-Deploy Verification

Evidence:

- `scripts/agentchat-remote-autodeploy.sh:102` defines `restart_relay`, and `scripts/agentchat-remote-autodeploy.sh:203` treats that restart success as deploy success.
- `remote/install-remote.sh:361` runs `verify-remote`, but that hard verification is only part of install/update, not the polling autodeploy loop.
- `bin/verify-remote:193` verifies heartbeat continuity and `bin/verify-remote:258` can verify one agent, but `agentchat-remote-autodeploy.sh` never calls it.

Impact:

The remote watcher can report a successful deploy when launchd/systemd accepted a restart but the relay did not reconnect, did not heartbeat, loaded old code, or connected with the wrong server id.

Fix direction:

Add a post-deploy verification step for remote autodeploy:

- run `verify-remote` after restart with deploy-safe samples and interval;
- support an expected commit/version check;
- keep `deploy_pending=true` when verification fails.

### CD-002 Remote Autodeploy Installs Dependencies In The Wrong Tree

Evidence:

- `scripts/agentchat-remote-autodeploy.sh:83` only watches root `package.json` and `package-lock.json`.
- `scripts/agentchat-remote-autodeploy.sh:72` runs `npm install --omit=dev` in `$REPO_DIR`.
- `remote/install-remote.sh:146` installs dependencies after changing into `remote/`.
- `remote/package.json:10` owns the remote runtime dependencies used by `remote/mcp-server.js`.

Impact:

If the remote package dependencies change without a root dependency change, autodeploy can restart a relay/MCP checkout with stale `remote/node_modules`. The install path used by autodeploy does not match the install path used by first-time remote provisioning.

Fix direction:

Remote autodeploy should watch both root and `remote/` dependency manifests, but install remote runtime dependencies in `remote/`. Root install should only happen if the chosen deploy model explicitly runs root services on that host.

### CD-002A Failed Dependency Install Retry State

Status:

Implemented. Stable and remote autodeploy persist an `install-needed` marker before dependency installation and retry install before restart when the marker remains.

Evidence:

- `scripts/agentchat-stable-autodeploy.sh:127` stores deploy state under the checkout's git dir by default.
- `scripts/agentchat-stable-autodeploy.sh:199` touches the install-needed marker before install and `scripts/agentchat-stable-autodeploy.sh:352` uses that marker to force retry from the last successful ref.
- `scripts/agentchat-remote-autodeploy.sh:46` stores remote deploy state and `scripts/agentchat-remote-autodeploy.sh:192` forces install retry when the marker remains.

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

### CD-004 Expected Version Check Is Implemented But Not Used By Remote Autodeploy

Status:

Partially implemented. `verify-remote` can enforce the loaded server version, but `agentchat-remote-autodeploy.sh` still does not call it after restart.

Evidence:

- `lib/push-relay-core.js:45` computes `RELAY_VERSION` from git.
- `lib/push-relay-core.js:482` sends `version` in heartbeat when available.
- `bin/verify-remote:35` exposes `--expect-version <v>`.
- `bin/verify-remote:231` fails when `/api/servers[].version` does not match the expected version.
- `scripts/agentchat-remote-autodeploy.sh:203` still treats relay restart success as deploy success without running `verify-remote`.

Impact:

Operators can manually prove the loaded relay commit, but the remote polling CD loop can still report success when the restarted process fails to heartbeat the expected commit.

Fix direction:

Fold `verify-remote --expect-version <short-sha>` into CD-001 post-deploy verification.

### CD-005 Generated Package Smoke Covers Push Relay And MCP Wrappers

Status:

Implemented.

Evidence:

- `scripts/check-remote-package-smoke.sh:226` starts wrapper resolution smoke.
- `scripts/check-remote-package-smoke.sh:230` checks the generated push-relay wrapper.
- `scripts/check-remote-package-smoke.sh:231` checks the generated MCP wrapper with `AGENTCHAT_WRAPPER_SMOKE=1`.

Impact:

The previous MCP wrapper drift gap is now covered by the generated package smoke gate.

### CD-005A Remote Autodeploy Service Is In The Generated Package Gate

Status:

Implemented.

Evidence:

- `scripts/build-remote-package.sh:61` includes `remote/push-relay-autodeploy.service` in the generated remote package manifest.
- `scripts/check-remote-package-smoke.sh:91` requires the generated service template.
- `scripts/check-remote-package-smoke.sh:140` checks the autodeploy service contract.

Impact:

The generated package gate now fails if the remote autodeploy service template is missing, stale, or references the wrong script path.

### CD-006 CLI Status Still Had A Misleading Unknown-Idle Path

Evidence:

- `bin/agent-chat-cli:81` builds a tmux snapshot from `#{session_activity}`.
- The fallback is used only when backend runtime metrics do not provide `idleDurationSec`.

Impact:

Normal deployed observation uses backend runtime fields and is currently correct. Before the idle observability repair, remote relay reports with unavailable metrics could be normalized to `activeNow=false`, making CLI diagnostics show idle when the real state was unknown.

Status:

Implemented for the current backend/CLI contract. Backend runtime now preserves `activeNow=null`, and `agentchat cli status` displays unknown instead of idle for that state. RLP idle repair now keeps normal/high push notifications queued while the pane shows interactive busy markers and removes max-hold force delivery for active panes; urgent remains the explicit bypass. The legacy `session_activity` fallback remains only for older backends that omit the activity field entirely.

### CD-007 Operations Runbook Does Not Match Destructive Deploy Behavior

Evidence:

- Before R-040, `OPERATIONS.md` said stable deploy used `git pull --ff-only origin stable`.
- `scripts/agentchat-stable-autodeploy.sh:208` runs a dirty-worktree cleaner.
- `scripts/agentchat-stable-autodeploy.sh:343` resets the live checkout to `origin/stable`.

Impact:

Operators may assume live deploy is non-destructive and preserve local changes, while the actual watcher can discard dirty and untracked files in the deploy checkout.

Status:

Implemented in R-040. The runbook now documents the deploy checkout as disposable, the reset/clean flow, stable preflight, restart order, and post-deploy `verify-remote --expect-version`.

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
| Stable release gate policy | default-off, default-on, or host config enforcement | Require an explicit deploy-host decision; default-off is still a policy gap even though the worktree gate exists. |
| macOS remote CD | manual update only, or launchd autodeploy watcher | Decide explicitly. If macOS is a first-class remote host, add launchd watcher. |
| Known-agent postdeploy check | no agent, configured optional `VERIFY_AGENT`, or mandatory canary agent | Optional `VERIFY_AGENT` first; later promote a canary agent. |
| Dependency install scope | root only, remote only, or both by changed manifests | Remote autodeploy should install `remote/` deps for relay/MCP. Stable/live deploy should install root deps. |
| Autodeploy failure behavior | log-only, retry pending, or rollback | Keep retry pending first. Rollback needs a separate operator decision. |

## Proposed Repair Table

| ID | Priority | Scope | Repair | Verification |
| --- | --- | --- | --- | --- |
| CD-000 | P0 | Stable CD | Decide and enforce stable release-gate policy; the worktree pre-reset gate exists but defaults to `none`. | Deploy-host config check or simulated target commit gate. |
| CD-001 | P0 | Remote CD | Run post-deploy `verify-remote` from remote autodeploy and keep `deploy_pending=true` on failure. | Simulated autodeploy script test plus manual remote run. |
| CD-002 | P0 | Remote deps | Install dependencies in `remote/` when `remote/package*.json` changes. | Script unit/smoke with fake git refs and generated temp repo. |
| CD-002A | Done | CD deps | Dependency-install-needed state persists across retry after failed install. | Implemented with stable/dev/remote autodeploy tests. |
| CD-003 | P1 | macOS CD | Decide and implement launchd autodeploy watcher or document manual-only policy. | macOS launchctl status and `agentchat service status --profile remote`. |
| CD-004 | Done | Loaded commit | `verify-remote --expect-version <sha>` fails on version mismatch; remote autodeploy integration remains under CD-001. | Implemented with `verify-remote` tests and manual remote smoke. |
| CD-005 | Done | Package smoke | Generated package smoke checks MCP wrapper resolution. | `npm run check:remote-package-smoke`. |
| CD-005A | Done | Remote package | Generated package includes and smoke-checks `push-relay-autodeploy.service`. | `npm run build:remote:check` and `npm run check:remote-package-smoke`. |
| CD-006 | Done | CLI diagnostics | Preserve unknown runtime activity instead of displaying idle; keep legacy `session_activity` fallback only for older backends without an activity field. | Implemented with API/CLI/push-relay tests. |
| CD-007 | Done | Ops docs | Update operations runbook to describe destructive deploy checkout behavior. | Implemented; docs reviewed against autodeploy scripts. |

## Immediate Next Batch

The safe preflight slice is implemented: `verify-remote --expect-version`, generated MCP wrapper smoke, non-destructive `verify:cd-preflight`, remote autodeploy service package smoke, and dependency-install retry markers are all present.

The remaining P0/P1 work is:

1. Integrate remote autodeploy post-deploy verification with `verify-remote --expect-version`, and decide whether verification failure keeps retry pending, rolls back, or only alerts.
2. Fix remote dependency install scope so `remote/package*.json` changes install dependencies in `remote/`, not only the checkout root.
3. Decide stable release gate policy: require the existing worktree gate on deploy hosts, query GitHub checks, or explicitly accept default-off risk.
4. Decide macOS remote CD policy: manual update only or add a launchd autodeploy watcher.
