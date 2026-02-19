# Agent Chat Operations Runbook

This runbook replaces `agent-doctor` style tooling.  
Use these commands directly during incident response.

## 1) Remote Service Lifecycle

### Update and keep relay paused (maintenance mode)
```bash
agent-update --pause-services
```

Expected:
- code is updated/reinstalled
- relay stays paused
- backend is reported offline

### Resume relay
```bash
agent-update --resume-services
```

### Check remote relay service status
```bash
agent-update --service-status
```

## 2) Verify Backend State

### Server state
```bash
curl -s http://127.0.0.1:8090/api/servers | jq '.[] | {id, online, lastSeen, agentCount, sourceIp}'
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
1. service stopped (`agent-update --service-status`)
2. no relay process (`pgrep -af "push-relay\\.js"`)
3. backend offline (`/api/servers` shows `online=false`)

If any of the three fails, treat shutdown as incomplete.
