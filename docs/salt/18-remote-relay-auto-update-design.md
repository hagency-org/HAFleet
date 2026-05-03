# Remote Relay Auto-Update Design

Date: 2026-05-03
Owner: salt
Status: design-only; implementation requires ac-topleader/operator approval

## Trigger

The rhodes1 incident was a live instance of the remote install/profile gap:

- Karin could not receive messages because rhodes1 was running an old relay.
- `agentchat update` failed with `Error: /home/shu is not a git repository`.
- The installed `/home/shu/agent-chat` was a standalone remote package, not a git checkout.
- Its helper symlinks pointed to `/home/shu/agent-chat/bin/*`; `agent-update` inferred `/home/shu` as the repo root and failed.

Emergency recovery converted rhodes1 to a `stable` git checkout and reinstalled the remote profile. After recovery:

- `agentchat update --check` worked on rhodes1.
- `agent-chat-push-relay` ran `/home/shu/agent-chat/remote/push-relay.js`.
- `verify-remote --server rhodes1 --agent Karin` passed.
- The backend reported rhodes1 relay version `bd5872b`; Karin was online with MCP present.

This fixed one host but exposed a fleet problem: old remotes can be online, running `unknown-legacy`, and unable to self-update safely.

## Current Fleet Snapshot

Observed from `/api/servers` during this audit:

| Server | State | Version | Agents | Note |
| --- | --- | --- | --- | --- |
| `kamico-MBP` | online | `8aa0dd2` | 4 | local/runtime host |
| `osaka` | online | `unknown-legacy` | 0 | old relay needs triage |
| `rhodes1` | online | `bd5872b` | 1 | recovered to git checkout |
| `USS Intrepid` | online | `unknown-legacy` | 1 | old relay with active agent risk |
| `rhodes2` | offline | `unknown-legacy` | 0 | update requires host reachability first |

This snapshot is operational evidence, not a durable inventory model. The backend can expose server rows, but there is no first-class fleet status command that classifies current, outdated, unknown, offline, and maintenance relays.

## Current Profiles

### Git Checkout Remote

`remote/install-remote.sh` assumes it lives at `<repo>/remote/install-remote.sh`.

It derives:

- `SCRIPT_DIR=<repo>/remote`
- `REPO_ROOT=<repo>`
- env file default `<repo>/remote/.env`
- dependency install cwd `<repo>/remote`
- service `WorkingDirectory=<repo>/remote`
- relay `ExecStart=node <repo>/remote/push-relay.js`

This is the only profile that can currently support loaded-version verification because `lib/push-relay-core.js` reports `git rev-parse --short HEAD` in heartbeats.

### Standalone Remote Package

`scripts/build-remote-package.sh` creates a package with:

- `install-remote.sh`
- `bin/*`
- `push-relay.js`
- `mcp-server.js`
- selected `lib/*`
- service templates
- `remote/package.json`

It intentionally excludes `.git`, `.env`, logs, `node_modules`, and `package-lock.json`.

Current limitations:

- No packaged build version exists, so `verify-remote --expect-version` cannot prove loaded code.
- `agent-update` still requires a git checkout and does not implement standalone self-update.
- The generated package includes `push-relay-autodeploy.service`, but the service expects `scripts/agentchat-remote-autodeploy.sh`; the standalone package does not include that script.
- Remote autodeploy itself requires `REPO_DIR/.git`, so it cannot run in a standalone package.

## Failure Modes

1. Standalone update path resolves the wrong root.

If a package is installed at `/home/shu/agent-chat`, `bin/agent-update` computes:

- `SCRIPT_DIR=/home/shu/agent-chat/bin`
- `BASE_DIR=/home/shu/agent-chat`
- `REPO_DIR=/home/shu`

When no candidate git checkout is found, it exits with `/home/shu is not a git repository`.

2. Standalone package advertises update but cannot self-update.

The help says `agentchat update` updates the current checkout or remote package, but there is no package source URL, version file, atomic unpack, rollback directory, or expected-version heartbeat.

3. Linux standalone install can create a broken autodeploy unit.

The unit points at `<repo>/scripts/agentchat-remote-autodeploy.sh`; standalone packages do not ship `scripts/`. That makes autodeploy look installed while not being executable in that profile.

4. Remote autodeploy can strand a host on a bad reset.

It fetches, force-cleans, resets to `origin/stable`, installs dependencies conditionally, and restarts. On dependency or restart failure it keeps an in-memory `deploy_pending=true`, but does not roll back or persist enough state across process restart.

5. Dependency scope is wrong for remote runtime.

Installer runs `npm install --omit=dev` under `remote/`; remote autodeploy watches root `package*.json` and installs at repo root. A remote dependency change can deploy code while `remote/node_modules` stays stale.

6. Post-restart verification is missing from remote autodeploy.

Stable/live autodeploy now has preflight gates. Remote autodeploy still declares success after service restart, without checking heartbeat progression, loaded version, server id, or known agent state.

7. `install-remote.sh` is too side-effectful for blind automation.

It installs dependencies, rewrites helper symlinks, installs service units, provisions sudoers, restarts services, rewrites Claude/Codex MCP config, and verifies. Calling it automatically after every code update would need phase-level dry-run and rollback.

8. Legacy MCP state can produce false degraded status after migration.

During rhodes1 recovery, the old MCP process was alive and usable, but it had not written the new `mcp-server.pid` path. The new relay treated Karin as `mcp-missing:auto` until the pidfile was restored.

## Design Position

Recommended near-term policy:

1. Treat git checkout remote installs as the only auto-update/CD target.
2. Treat standalone packages as bootstrap/manual install artifacts until versioned standalone release directories exist.
3. Make standalone `agentchat update` fail clearly with migration guidance instead of resolving parent home directories.
4. Add fleet inventory before fleet mutation.
5. Harden git-checkout remote autodeploy in small batches: durable state, remote dependency scope, post-restart verify, rollback.
6. Do not let autodeploy rerun full `install-remote.sh` until the installer is decomposed into testable phases.

This is conservative because remote relay is a message-delivery sink. A broken update can make agents unreachable, and a partially updated relay can misreport health or inject stale messages.

## Proposed Batches

### RAU-A: Fleet Inventory, No Mutation

Goal:

- Make current/outdated/unknown/offline/maintenance relay status visible.

Shape:

- Add a CLI/API read path that lists servers with:
  - `id`
  - `online`
  - `maintenance`
  - `lastSeen`
  - `agentCount`
  - `sourceIp`
  - `version`
  - `versionStatus` relative to an expected version
  - `versionStale` or equivalent when a version is only last-known

Tests:

- Seed `current`, `outdated`, `unknown-legacy`, `null`, `offline`, and `maintenance` server rows.
- Assert classifications do not collapse unknown/offline/outdated.
- CLI test for operator-readable table and optional JSON output.

Verification:

- targeted API/CLI tests
- `npm run verify:ci`

### RAU-B: Standalone Update Guard

Goal:

- Stop `agentchat update` from failing with misleading parent-directory git errors.

Shape:

- Detect standalone package layout with no `.git`.
- Print a clear message:
  - standalone package self-update is not supported yet;
  - migrate to git checkout for auto-update;
  - preserve `.env`, `data`, and `logs`;
  - run `bash remote/install-remote.sh`;
  - verify with `agentchat verify-remote --expect-version <sha>`.
- Prevent standalone install from enabling a broken autodeploy unit unless the required script/profile exists.

Tests:

- Fake standalone layout invoking `bin/agent-update --check`.
- Generated package smoke for autodeploy service/package contract.

Verification:

- `npm run check:remote-package-smoke`
- `npm run check:remote-sync`
- `npm run verify:ci`

### RAU-C: Git Checkout Migration Runbook

Goal:

- Provide a repeatable manual migration for old servers.

Steps:

1. SSH to host and inspect current install:
   - `command -v agentchat`
   - `readlink -f "$(command -v agentchat)"`
   - `systemctl cat agent-chat-push-relay`
   - `git -C <install> rev-parse --is-inside-work-tree`
2. Backup standalone install.
3. Clone `stable` with host proxy settings if required.
4. Copy `.env`, `data`, `logs`, and optionally `remote/node_modules`.
5. Swap directory or install into a new stable path.
6. Run `VERIFY_AGENT=<known-agent> VERIFY_SAMPLES=2 VERIFY_INTERVAL=16 bash remote/install-remote.sh`.
7. Verify:
   - `agentchat update --check`
   - `agentchat verify-remote --server <host> --agent <known-agent> --expect-version <short-sha>`

This should be a runbook first, not an automatic fleet rewrite.

### RAU-D: Remote Autodeploy Durable State

Goal:

- Make remote autodeploy restart-safe before adding more behavior.

State should live outside cleaned worktree and include:

- `lastSuccessfulRef`
- `targetRef`
- `attemptRef`
- `phase`
- `installNeeded`
- `restartNeeded`
- `verifyNeeded`
- `lastFailure`
- timestamps

Tests:

- Fake repo update succeeds and writes last successful ref.
- Dependency failure persists pending state across script restart.
- Restart failure persists pending state across script restart.

Verification:

- new `tests/cd-remote-autodeploy.test.js`
- `npm run verify:ci`

### RAU-E: Remote Dependency Scope

Goal:

- Make autodeploy install the dependency tree actually used by remote relay.

Shape:

- Watch `remote/package*.json`.
- Install under `remote/`.
- Keep lockfile policy decision explicit:
  - tracked lock plus `npm ci --omit=dev`, or
  - intentionally lockless `npm install --omit=dev`.

Tests:

- Fake repo changes `remote/package.json` and asserts install cwd is `remote/`.
- Root-only package changes do not trigger remote dependency install unless root runtime is intentionally part of the profile.

### RAU-F: Post-Restart Verification

Goal:

- Remote autodeploy success must mean the loaded runtime reports the expected version.

Shape:

- After restart, run:
  - `agentchat verify-remote --samples 2 --interval 16 --expect-version "$(git rev-parse --short HEAD)"`
- Include `--agent <name>` only when configured.
- Keep deploy pending on verification failure.

Tests:

- Fake `verify-remote` success clears pending.
- Fake `verify-remote` failure keeps pending and records reason.

### RAU-G: Rollback

Goal:

- Failed deploy after reset can restore the previous known-good ref.

Shape:

- If install/restart/verify fails after reset:
  - reset to `lastSuccessfulRef`;
  - reinstall remote dependencies for that ref when needed;
  - restart relay;
  - verify previous version.

Tests:

- Fake repo deploy to bad ref fails verify; script returns to previous ref and verifies it.
- Rollback failure leaves explicit pending/degraded state.

### RAU-H: Installer Decomposition

Goal:

- Make `install-remote.sh` safe to call from automation only after its side effects are separable.

Shape:

- Split or hook phases:
  - prerequisites
  - dependency install
  - helper symlink reconcile
  - service unit reconcile
  - sudoers reconcile
  - MCP config reconcile
  - restart
  - verify
- Add dry-run/injected command tests.

This is required before auto-update can own service/helper/MCP reconciliation.

## Operator Decisions

Decision 1: Are git checkout installs the only supported auto-update/CD target for now?

Recommended: yes. Use standalone packages only for bootstrap/manual install until versioned package releases exist.

Decision 2: Should standalone `agentchat update` fail with migration guidance immediately?

Recommended: yes. This is a safe operator-experience fix and prevents rhodes1-style misleading errors.

Decision 3: Should fleet inventory be implemented before any more remote mutation?

Recommended: yes. We need to see old online relays before trying to update them.

Decision 4: Should remote autodeploy own only code/deps/restart, or also service/helper/MCP reconciliation?

Recommended: code/deps/restart first. Defer service/helper/MCP reconciliation until installer decomposition exists.

Decision 5: What dependency policy should remote use?

Recommended: choose tracked `remote/package-lock.json` plus `npm ci --omit=dev` if remote packages are production runtime; otherwise explicitly document lockless installs.

Decision 6: Should empty `API_TOKEN` be a hard failure for remote install/autodeploy?

Recommended: hard failure for authenticated production remotes.

Decision 7: Are macOS remote hosts manual-update-only or first-class autodeploy targets?

Recommended: manual-update-only until launchd autodeploy has a separate test plan.

## Immediate Next Recommendation

Ask ac-topleader/operator to approve RAU-A and RAU-B first:

- RAU-A is read/diagnostic only and gives operators fleet visibility.
- RAU-B prevents more misleading update failures and keeps unsupported standalone self-update from pretending to work.

Do not start RAU-D through RAU-H until RAU-A makes fleet state visible and the operator confirms git checkout as the auto-update profile.
