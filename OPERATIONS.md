# Agent Chat Operations Runbook

This runbook replaces `agent-doctor` style tooling.  
Use these commands directly during incident response.

Primary CLI is now `agentchat`.  
Legacy commands (`agent-update`, `agent-audit`, `agent-up`, etc.) are deprecated wrappers and still work for compatibility.

## 1) Remote Service Lifecycle

### Update and keep relay paused (maintenance mode)
```bash
agentchat update --pause-services
```

Expected:
- code is updated/reinstalled
- relay stays paused
- backend is reported offline

### Resume relay
```bash
agentchat update --resume-services
```

### Check remote relay service status
```bash
agentchat update --service-status
```

## 1.1) Stable Branch Auto Deploy (Live)

This watcher runs on the local host and polls `origin/stable` every 30s from the live deploy checkout:
- `/path/to/agent-chat`

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
6. restart `agent-chat-v2` first and wait for `/api/agents` health
7. restart the remaining services from `AGENTCHAT_DEPLOY_SERVICES` (defaults: `agent-chat`, `agent-chat-v2`, `bridge-matrix`)
8. verify all listed services are active

Install/update the service:
```bash
sudo cp /path/to/agent-chat/agent-chat-stable-autodeploy.service /etc/systemd/system/agent-chat-stable-autodeploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-chat-stable-autodeploy
```

Check status/logs:
```bash
systemctl status agent-chat-stable-autodeploy --no-pager
tail -f /path/to/agent-chat/logs/stable-autodeploy.out.log
```

After deployment, verify the loaded remote relay version when the deployed commit is expected to reach remote hosts:
```bash
agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

## 2) Verify Backend State

### Server state
```bash
curl -s http://127.0.0.1:8090/api/servers | jq '.[] | {id, online, lastSeen, agentCount, sourceIp}'
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
- `com.agentchat.push-relay`

Current label:
- `agent-chat-push-relay`

If pause still shows backend online, check both:
```bash
launchctl list | rg "agent-chat-push-relay|com.agentchat.push-relay"
pgrep -af "push-relay\\.js|agent-chat-push-relay|com\\.agentchat\\.push-relay"
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

After pausing/downing, verify all three:
1. service stopped (`agentchat update --service-status`)
2. no relay process (`pgrep -af "push-relay\\.js"`)
3. backend offline (`/api/servers` shows `online=false`)

If any of the three fails, treat shutdown as incomplete.

## 7) Debt Hygiene Commands

### Full one-shot audit
```bash
agentchat audit
```

Checks include:
- root/remote mirror consistency
- shell/js syntax
- dependency security gate (`npm run audit:deps`)
- maintenance dry-run preview

### Rotate logs + prune stale tmp data
```bash
agentchat maintain
```

Preview mode:
```bash
agentchat maintain --dry-run
```

### Sync skill links (~/.codex + ~/.claude)
```bash
agentchat sync-skills
```

Check only:
```bash
agentchat sync-skills --check
```

### Prune stale offline agent records
```bash
agentchat prune-agents --older-than-days 7
agentchat prune-agents --older-than-days 7 --apply
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
