# HAFleet Operations Runbook

This runbook replaces `agent-doctor` style tooling.  
Use these commands directly during incident response.

Primary CLI is now `hafleet`.  
Legacy commands (`hafleet-update`, `hafleet-audit`, `hafleet-up`, etc.) are deprecated wrappers and still work for compatibility.

## 1) Remote Service Lifecycle

These commands target the remote relay service on the current host:
- `hafleet-push-relay`

They do not stop local agent tmux sessions.

### Update and keep relay paused (maintenance mode)
```bash
hafleet update --pause-services
```

Expected:
- code is updated/reinstalled
- relay stays paused
- backend is reported offline

### Resume relay
```bash
hafleet update --resume-services
```

### Check remote relay service status
```bash
hafleet update --service-status
```

## 1.1) Stable Branch Auto Deploy (Live)

This watcher runs on the local host and polls `origin/stable` every 30s from the live deploy checkout:
- `/path/to/hafleet`

The live deploy checkout is disposable. Do not use it for local edits, scratch files, or manual debugging changes that need to survive deployment. The watcher can discard both tracked and untracked changes in that checkout.

Before merging or pushing a deploy candidate, run the non-destructive CD preflight from the candidate checkout:
```bash
npm run verify:cd-preflight
```

For an explicit stable-branch candidate checkout:
```bash
npm run verify:cd-preflight -- --branch stable
```

When a new commit appears, it will:
1. fetch `origin/stable`
2. compare the current `HEAD` with `origin/stable`
3. if the deploy checkout is dirty, log the first dirty paths and clean it with `git reset --hard HEAD` plus `git clean -fd`
4. reset the deploy checkout to `origin/stable` with `git reset --hard origin/stable`
5. run `npm install --production` only if `package.json` or `package-lock.json` changed
6. restart `hafleet-backend` first and wait for `/api/agents` health
7. restart the remaining services from `HAFLEET_DEPLOY_SERVICES` (defaults: `hafleet`, `hafleet-backend`, `bridge-matrix`)
8. verify all listed services are active

Install/update the service:
```bash
sudo cp /path/to/hafleet/hafleet-stable-autodeploy.service /etc/systemd/system/hafleet-stable-autodeploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now hafleet-stable-autodeploy
```

Check status/logs:
```bash
systemctl status hafleet-stable-autodeploy --no-pager
tail -f /path/to/hafleet/logs/stable-autodeploy.out.log
```

After deployment, verify the loaded remote relay version when the deployed commit is expected to reach remote hosts:
```bash
hafleet verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

## 2) Verify Backend State

### Server state
```bash
curl -s http://127.0.0.1:8090/api/servers | jq '.[] | {id, online, lastSeen, agentCount, sourceIp}'
```

Fleet version inventory:
```bash
hafleet cli fleet --expect-version <short-sha>
hafleet cli fleet --expect-version <short-sha> --json
curl -s 'http://127.0.0.1:8090/api/servers/fleet?expectVersion=<short-sha>' | jq
```

### Put a noisy remote server into maintenance (force offline + mute heartbeat flaps)
```bash
curl -s -X POST http://127.0.0.1:8090/api/servers/<server_id>/maintenance \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | jq
```

Resume normal heartbeat handling:
```bash
curl -s -X POST http://127.0.0.1:8090/api/servers/<server_id>/maintenance \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | jq
```

### Single agent state
```bash
curl -s http://127.0.0.1:8090/api/agents/<agent_name> | jq '{name, online, server, offlineReason, lastSeen, serverOnline}'
```

## 3) Known macOS Legacy Label Issue

Legacy launchd label:
- `com.hafleet.push-relay`

Current label:
- `hafleet-push-relay`

If pause still shows backend online, check both:
```bash
launchctl list | rg "hafleet-push-relay|com.hafleet.push-relay"
pgrep -af "push-relay\\.js|hafleet-push-relay|com\\.hafleet\\.push-relay"
```

## 4) Offline Delivery Semantics

When a target agent is offline:
- send returns `target_offline`
- message is archived/queued (not real-time delivered)

You can still issue commands, but do not expect immediate reply until relay resumes.

## 5) Inbox Time Fields

`check_inbox()` already includes per-message time fields:
- `ts`: epoch ms
- `at`: ISO timestamp
- `time`: relative string

When an agent comes back online, the catch-up notification now includes:
- offline window (`oldest -> latest`)
- replay list entries with per-message ISO timestamp

## 6) Shutdown Audit Checklist

### Remote relay pause/resume

After pausing the remote relay, verify all three:
1. relay service stopped (`hafleet update --service-status`)
2. no relay process (`pgrep -af "push-relay\\.js"`)
3. backend server row offline (`/api/servers` shows `online=false` for that remote host)

If any of the three fails, treat relay shutdown as incomplete.

### Host-local agent shutdown

`hafleet down <agent>` acts on the tmux session for that agent on the current runtime host. The backend is used for name resolution, active-work guard, and offline marking; it is not a global remote shutdown command.

After downing a host-local agent, verify:
1. no tmux session for the agent (`tmux has-session -t <agent>` fails)
2. backend agent detail shows the expected offline/manual-down state
3. archived pane output and resume hint were captured when the agent type requires it

## 7) Debt Hygiene Commands

### Full one-shot audit
```bash
hafleet audit
```

Checks include:
- root/remote mirror consistency
- shell/js syntax
- dependency security gate (`npm run audit:deps`)
- maintenance dry-run preview

### Rotate logs + prune stale tmp data
```bash
hafleet maintain
```

Preview mode:
```bash
hafleet maintain --dry-run
```

### Sync skill links (~/.codex + ~/.claude)
```bash
hafleet sync-skills
```

Check only:
```bash
hafleet sync-skills --check
```

### Prune stale offline agent records
```bash
hafleet prune-agents --older-than-days 7
hafleet prune-agents --older-than-days 7 --apply
```

## 8) Supervisor Focus Audit Checks

Supervisor status:
```bash
curl -s http://127.0.0.1:8090/api/supervisor/status | jq
```

Supervisor summary:
```bash
curl -s http://127.0.0.1:8090/api/supervisor/agents | jq '.agents[] | {agent,lastStatus,consecutiveNegative,lastJudgedAt,lastWarningAt}'
```

One agent audit timeline:
```bash
curl -s "http://127.0.0.1:8090/api/supervisor/agents/<agent>?limit=60" | jq
```

Validate role/boundary/current docs coverage:
```bash
npm run audit:agent-docs -- --active
```

## 11) Bridge Refuses To Start: "crypto store contains data but has no device identity"

A **permanent** startup failure, not a crash loop that heals. `bridge-matrix.service` is
`Restart=on-failure` with `RestartSec=5`, so systemd retries and then stops trying once
`StartLimitBurst=5` is reached inside `StartLimitIntervalSec=300`.

```
Bridge failed to start: Error: Matrix crypto store at <path> contains data but has no device identity
```

### Why it happens

`holdsKeyMaterial` (`lib/matrix-crypto-store-identity.js`) treats every file except
`bot-sdk.json` as key material — deliberately, because being cautious about an unrecognised
file beats discarding keys a future matrix-bot-sdk version stored under a name the list does
not know. So a store holding only the `bot-sdk.json` placeholder **plus a stray file** —
`.DS_Store` being the realistic one — fails closed even though it holds no keys at all.

Most likely if the store directory was opened in Finder on a Mac during the startup window.
Not a regression: before the placeholder fix this directory bricked too, along with more
besides.

### Check and recover

```bash
# Where the store is: $HAFLEET_RUNTIME_DIR/data/matrix/bot-crypto
#   (RUNTIME_ROOT is HAFLEET_RUNTIME_DIR if set, else the repo root)
ls -la "${HAFLEET_RUNTIME_DIR:-.}/data/matrix/bot-crypto"
```

If the only entries are `bot-sdk.json` and stray files — **no** `matrix-sdk-crypto.sqlite3*` —
the store holds no key material and removing them is safe:

```bash
rm -f "${HAFLEET_RUNTIME_DIR:-.}/data/matrix/bot-crypto/.DS_Store"
# or, equivalently safe in this state:
rm -rf "${HAFLEET_RUNTIME_DIR:-.}/data/matrix/bot-crypto"
```

The next start takes the `empty` path and initialises a fresh store for the access token's
device. Nothing is archived, because there is nothing to archive.

**If `matrix-sdk-crypto.sqlite3` IS present, stop.** That store holds real keys, and the same
error then means a genuine device mismatch the bridge is right to refuse. Do not delete it —
the bridge archives a mismatched store itself on the next start, and the archive is the
rollback path.
