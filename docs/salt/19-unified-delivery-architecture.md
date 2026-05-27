# 19 Unified Delivery Architecture

Date: 2026-05-28
Status: design proposal. Immediate runtime hardening from the same audit batch landed separately from this long-term architecture proposal.

## Decision Context

The current system has two delivery implementations for the same user-visible side effect:

- local dashboard queue in `server.js`, with durable `logs/queue.json`, local pane snapshots, and `/api/runtime/push-delivered` ack;
- push relay in `lib/push-relay-core.js`, with SSE input, in-memory hold/dedupe state, local tmux injection, and delivery-event logging.

This split is the root cause behind remote/local drift: local and remote have different ack, stale-read, idle, retry, crash, and tmux-injection semantics. The target architecture is one delivery contract and one transport worker path. "Local" and "remote" should differ only by deployment profile and host identity, not by delivery behavior.

## Goals

- Backend owns the only durable delivery queue.
- Push relay is a pure runtime-host transport worker: claim -> idle gate -> unread check -> inject -> ack.
- Central-local and remote hosts use the same relay code path.
- `server.js` exits delivery ownership and remains dashboard/API proxy/manual UI.
- Backend owns delivery state transitions, retry limits, lease expiry, ack handling, stale suppression, and inbox gate/runtime mutation.
- The agent inbox remains the recovery truth. Direct tmux injection is a notification side effect, not message truth.

## Non-Goals

- Do not redesign message, group, or cursor semantics beyond the delivery queue boundary.
- Do not remove reminders or redirects in this design; decide their delivery ownership explicitly.
- Do not require exactly-once transport. Implement effective exactly-once visible notification through durable claim, idempotency keys, stale checks, and ack state.
- Do not make backend perform tmux operations. Tmux access stays on the runtime host.

## Target Architecture

```text
                         backend kernel
        messages / cursors / agents / servers / runtime / alerts
                              |
                              |
                  durable delivery_queue store
             tasks, leases, attempts, ack, dead letters
                              |
                SSE wakeups + poll/claim API fallback
                              |
        ------------------------------------------------
        |                                              |
  push-relay runtime host: central-local          push-relay runtime host: remote-X
  same worker code                                same worker code
  local tmux + MCP agents                         local tmux + MCP agents
        |                                              |
        ------------ inject local tmux only ------------
```

`server.js` may display queue state and issue manual administrative operations through backend APIs, but it does not store or process delivery tasks.

## Delivery Contract

The backend creates one delivery task for each target agent that should receive a visible notification. A task is not a message; it is a request to notify a target about backend-owned inbox state.

Required visible-notification contract:

1. Backend stores the source message and computes target agents.
2. Backend creates or updates a delivery task with a stable idempotency key.
3. Backend wakes the target runtime host through SSE.
4. A relay worker leases one eligible task.
5. The relay evaluates local safety: agent is hosted here, pane exists, not blocked, idle enough unless urgent.
6. The relay performs a final unread/stale check with backend.
7. The relay injects one notification into tmux through the shared injection primitive.
8. The relay acks backend.
9. Backend records delivered/acked state and mutates runtime inbox gate exactly as local queue currently does through `/api/runtime/push-delivered`.
10. `check_inbox()` advances the cursor and clears matching pending gates/tasks.

If any step is unknown, stale, or unsafe, the task stays pending, is retried later, or is terminally suppressed by backend. Unknown state never means "safe to inject".

## Backend Data Model

Recommended store name: `delivery-tasks.jsonl` plus a compacted `delivery-tasks.json` index, or a small embedded database if the project moves beyond JSON stores. JSON files are acceptable for the first migration if writes remain atomic and indexes are rebuilt on startup.

### DeliveryTask

```json
{
  "id": "deltask_...",
  "idempotencyKey": "targetAgent:kind:sourceFingerprint",
  "kind": "inbox_notification",
  "status": "pending",
  "targetAgent": "agentchat-worker",
  "targetServer": "local",
  "target": {
    "kind": "tmux",
    "tmux": "agentchat-worker:0.0"
  },
  "source": {
    "messageId": "msg_...",
    "messageIds": ["msg_..."],
    "summary": "operator request",
    "from": "ac-topleader",
    "group": null,
    "messageType": "request"
  },
  "notify": {
    "payload": "[NOTIFICATION] ...",
    "kind": "single_actionable",
    "priority": "high",
    "requiresInboxCheck": true,
    "unreadCount": 1,
    "hasHumanUnread": false,
    "hasRequestUnread": true,
    "needsReply": true,
    "hasMcp": true
  },
  "lease": {
    "ownerServer": null,
    "relayInstanceId": null,
    "claimedAt": null,
    "expiresAt": null
  },
  "attempt": {
    "count": 0,
    "lastAttemptAt": null,
    "nextAttemptAt": 1779900000000,
    "lastReason": null
  },
  "timestamps": {
    "createdAt": 1779900000000,
    "updatedAt": 1779900000000,
    "deliveredAt": null,
    "ackedAt": null,
    "terminalAt": null
  }
}
```

### Status Values

| Status | Owner | Meaning |
| --- | --- | --- |
| `pending` | backend | Eligible after `nextAttemptAt`; no active lease. |
| `leased` | backend | One relay has a time-bounded claim. |
| `deferred` | backend | Safe retry later; e.g. active pane, blocked, capture failed, server offline. |
| `delivered` | backend | Relay reported tmux injection success; inbox gate/runtime updated. |
| `stale` | backend | Source is no longer unread or cursor advanced before injection. |
| `suppressed` | backend | Explicit cancellation, read ack, deleted message, or target no longer valid. |
| `dead` | backend | Retry budget exhausted or permanent routing error. |

`delivered`, `stale`, `suppressed`, and `dead` are terminal. Terminal tasks are retained for audit and compaction.

### Idempotency Key

Use an idempotency key that represents the visible notification, not the transport attempt:

```text
targetAgent + ":" + notificationKind + ":" + sorted(messageIds).join(",") + ":" + unreadCount
```

For merged unread notifications, `messageIds` should include all source unread ids represented by the notification when known. If the task is only a generic unread backfill, use:

```text
targetAgent + ":unread_backfill:" + latestUnreadId + ":" + unreadTotal
```

Backend creates or updates by idempotency key. Duplicate message acceptance or duplicate SSE wakeups cannot create multiple visible notification tasks for the same inbox state.

### Lease Fields

Leases are backend-owned:

- `ownerServer`: server id that claimed the task;
- `relayInstanceId`: relay process instance;
- `claimedAt`: claim time;
- `expiresAt`: lease deadline;
- `attempt.count`: incremented when a lease is granted, not when a task is created.

Default lease TTL: 30 seconds. The relay may renew once while performing a long operation, but normal tmux injection should finish within the original TTL.

If the relay crashes after claim but before ack, backend reclaims the task after `expiresAt`.

### Retry Policy

Retry should be reason-aware:

| Reason | Retry |
| --- | --- |
| `agent-active` | Defer with short backoff, e.g. 3 seconds. |
| `agent-blocked` | Defer with medium backoff, e.g. 30 seconds, plus alert if actionable. |
| `capture-failed` | Defer with short backoff and cap. |
| `server-offline` | Keep pending until server heartbeat returns. |
| `tmux-missing` | Defer until heartbeat/runtime no longer lists target; then `dead` or `suppressed` depending manualDown. |
| `stale-read` | Terminal `stale`. |
| `inject-partial` | Terminal `delivered_partial` is not recommended; treat as delivered for no-repaste safety but mark high-risk audit event. |
| `inject-failed-before-payload` | Retry with bounded exponential backoff. |

Hard cap: 10 attempts or 24 hours, whichever comes first, then `dead` with operator-visible diagnostics.

## Push Relay Task Acquisition

Use SSE as a wakeup, not as the correctness channel.

### Backend APIs

Add these backend endpoints:

- `POST /api/delivery/claim`
  - Auth: host credential.
  - Body: `{ server, relayInstanceId, limit, capabilities }`.
  - Returns leased tasks for that server only.

- `POST /api/delivery/:id/defer`
  - Auth: same server that owns lease.
  - Body: `{ reason, nextAttemptAt, observation }`.
  - Releases lease and stores retry metadata.

- `POST /api/delivery/:id/ack`
  - Auth: same server that owns lease.
  - Body: `{ deliveredAt, injection, notifyMeta, observation }`.
  - Marks delivered and updates runtime/inbox gate.

- `POST /api/delivery/:id/stale`
  - Auth: same server that owns lease.
  - Body: `{ reason: "stale-read", unreadSnapshot }`.
  - Terminal stale.

- `GET /api/delivery/tasks`
  - Auth: operator/dashboard.
  - Read-only queue view for `server.js` dashboard.

- `POST /api/delivery/:id/cancel`
  - Auth: operator/dashboard or backend internal read-ack path.
  - Terminal suppress.

### SSE Role

Backend emits `delivery_wakeup` events when:

- a new pending task is created;
- a task lease expires;
- a target server heartbeat returns;
- `check_inbox()` clears tasks and dashboard should refresh;
- operator cancels or requeues a task.

Relay behavior:

1. On SSE wakeup for its `server`, call `claim`.
2. Also poll `claim` every 5 seconds as a fallback.
3. On SSE disconnect/reconnect, call `claim` immediately.
4. Never inject directly from generic `message` SSE.

This removes the current split where relay treats backend `message` SSE as a direct delivery task while local queue receives a different backend push notification.

## Idle Gate

Idle gate belongs to the runtime host relay, because only the runtime host can reliably observe local tmux panes.

Backend owns policy values:

- `idleThresholdMs`;
- whether `urgent` bypasses idle;
- blocked-state policy;
- max hold/defer duration;
- server maintenance state.

Relay owns measurements:

- pane exists;
- pane command;
- pane content hash;
- busy/active detection;
- blocked prompt detection;
- MCP process presence;
- workspace path.

Relay sends observations back in `defer` or `ack`:

```json
{
  "activeNow": false,
  "idleDurationSec": 24,
  "blocked": false,
  "blockedReason": null,
  "mcpPresent": true,
  "paneCommand": "codex",
  "workspacePath": "/home/shisui/laplace/agent-chat"
}
```

Gate rules:

- If pane observation is missing, capture failed, list failed, or target is unknown: defer, do not inject.
- If blocked prompt is detected: defer and report blocked state, do not inject unless the task is an explicit operator emergency class approved separately.
- If active and priority is not `urgent`: defer.
- If priority is `urgent`, bypass active/idle threshold only after target existence and non-blocked state are confirmed.

This keeps "urgent" from typing into unknown or blocked panes while still allowing urgent delivery to a known idle/active shell.

## Unread And Stale Check

Unread check must happen twice:

1. Backend filters at task creation and claim time using durable cursors.
2. Relay performs a final backend unread check immediately before injection.

The final relay check is required because cursor advancement is non-monotonic for delivery: a task that was valid at claim time can become stale after `check_inbox()`.

Recommended endpoint:

- `POST /api/delivery/:id/validate`
  - Auth: lease owner.
  - Returns `{ okToInject, reason, unreadSnapshot, notifyMeta }`.

Validation must reject when:

- `unread_total === 0`;
- `source.messageId` is not in unread ids for single-source tasks;
- any required `messageIds` are no longer unread for strict tasks;
- current unread count is lower than task `notify.unreadCount` and the task was a merged notification;
- task was cancelled, suppressed, expired, or read-acked after claim;
- agent target/server changed since claim.

If validation rejects due stale-read, relay calls `stale` and does not inject.

`check_inbox()` should also directly suppress pending/leasing tasks for all consumed `messageIds`. If a task is already leased, backend marks it `cancelRequested=true`; the relay's validate call sees that and drops before injection.

## Tmux Injection Primitive

There should be one shared injector used by every runtime-host delivery worker. `server.js` should not have a separate injector after migration.

Recommended primitive:

```js
injectTmuxNotification({
  target,
  payload,
  submitMode: 'enter',
  timeoutMs: 5000,
  settleMs: 150
})
```

Default exact sequence:

1. `tmux send-keys -l -t <target> <payload>`
2. wait `settleMs`
3. `tmux send-keys -t <target> C-m`

Do not use relay-specific `Tab`, double `Enter`, or double `C-m` as the default. Those extra keys are UI-state assumptions and caused local/remote drift. If a specific framework needs a different sequence, make it an explicit per-agent capability reported by launcher/runtime profile, not a hidden local-vs-remote difference.

Partial semantics:

- Failure before payload is sent: retryable.
- Failure after payload is sent but before submit: do not retry by default, because retry can paste duplicate text. Mark task `delivered` with `partial=true`, set high-risk delivery event, and require operator/agent recovery through inbox.
- Unknown result after timeout: treat as partial if payload step completed; otherwise retryable.

Future improvement: evaluate `tmux set-buffer` + `paste-buffer` for large/multiline payloads, but only after tests prove it works for Claude, Codex, and shell prompts.

## Ack Path And Runtime Gate

`ack` is the only path that marks a task delivered. It replaces the current split between local `/api/runtime/push-delivered` and relay `/api/delivery-events`.

On successful ack, backend must:

- transition task `leased -> delivered`;
- append a delivery event;
- update `agent_runtime.lastPushDeliveredAt`;
- update `lastPushKind`, `lastPushNeedsInboxCheck`, `lastPushUnreadCount`, `lastPushDeliveryDelayMs`;
- if `requiresInboxCheck`, set `runtime.inboxGate`;
- update `lastActionablePushAt` for human/request/actionable merged notifications;
- keep outbound guard behavior identical for local and remote.

`/api/runtime/push-delivered` can remain as compatibility wrapper during migration, but internally it should call the same delivery ack service.

## Crash And Restart Recovery

### Relay Crash

If relay crashes after claim and before injection:

- lease expires;
- backend returns task to pending;
- next relay claim can retry.

If relay crashes after injection and before ack:

- backend retries after lease expiry;
- duplicate visible notification is possible unless injection result is known.

Mitigation:

- Relay should ack immediately after injection and before any nonessential work.
- Injection attempt should include a durable `attemptId`.
- Backend should record `attemptId` at claim time.
- If relay restarts and can recover local attempt journal, it may ack previous success. This is optional for phase 1.

Minimal phase 1 acceptable semantics: at-least-once notification with bounded duplicate risk only in the narrow inject-success/ack-crash window. The agent inbox remains the authoritative recovery path.

### Backend Crash

Backend writes task claim before returning it. On startup:

- expired `leased` tasks are reset to `pending`;
- terminal tasks stay terminal;
- indexes are rebuilt from the durable task store;
- orphan tasks targeting missing agents become `suppressed` or `dead` based on reason.

### Server Reassignment

If an agent moves servers while a task is pending:

- backend updates `targetServer`;
- any lease owned by the old server is cancelled;
- new server receives a `delivery_wakeup`.

If an agent moves while a relay has a lease:

- relay validation fails with `target-changed`;
- relay defers/stales according to backend response and does not inject.

## Compatibility And Migration Path

### Phase A: Backend Queue Service Behind Existing Paths

- Add backend delivery task model and APIs.
- Change `backend-v2.js pushNotify()` to create delivery tasks instead of posting to `server.js /api/queue`.
- Keep old `/api/runtime/push-delivered` as wrapper over the new ack service.
- Keep `server.js /api/queue` for manual dashboard queue only.

Exit criteria:

- A backend-created task can be claimed, deferred, validated, injected by test relay, and acked.
- `check_inbox()` suppresses matching pending delivery tasks.

### Phase B: Relay Worker Uses Claim API

- Change `lib/push-relay-core.js` to stop treating `message` SSE as direct delivery.
- Relay listens for `delivery_wakeup`, calls claim, evaluates idle/unread, injects, and acks.
- Central-local and remote use the same relay code path.
- `remote/lib/push-relay-core.js` remains mirrored by package sync.

Exit criteria:

- Local and remote tests use the same helper to exercise delivery.
- No direct notification injection from raw message SSE remains.

### Phase C: Move Central-Local Default Delivery To Relay

- Ensure central machine runs `agent-chat-push-relay.service` as the local runtime host.
- Backend no longer posts notifications to `server.js /api/queue`.
- Dashboard reads backend delivery queue state through `GET /api/delivery/tasks`.
- Existing queue UI actions call backend cancel/requeue/force-deliver APIs.

Exit criteria:

- Disabling `server.js` queue processing does not stop notifications.
- Local and remote delivery behavior is indistinguishable except server id.

### Phase D: Remove Legacy Queue Ownership From `server.js`

- Delete local durable queue persistence and processing after stable soak.
- Keep dashboard visualizations and manual operator controls backed by backend APIs.
- Remove old queue file migration after retention window.

Exit criteria:

- `logs/queue.json` is not read or written for backend notifications.
- No default delivery path calls `server.js /api/queue`.

### Phase E: Cleanup And Hard Gates

- Convert `/api/runtime/push-delivered` callers to `/api/delivery/:id/ack`.
- Remove stale local-only push queue env vars.
- Add CI gates preventing raw message SSE direct injection and server queue delivery ownership from returning.

## Code Deletion And Refactor Inventory

### `server.js`

Delete or demote after migration:

- durable queue store and helpers: queue map, `QUEUE_FILE`, `saveQueue`, queue load/recovery, terminal delivery state helpers;
- queue mutation endpoints as delivery owners: `POST /api/queue`, `POST /api/queue/:id/send`, delivery-side `DELETE /api/queue/:id`;
- queue processing loop: `processQueueTick()` and its interval;
- local tmux notification delivery: `deliverMessage()`, `notifyPushDelivered()` for queue entries;
- queue stale unread checks that belong to backend/relay validation;
- queue-specific dashboard SSE as source of truth.

Keep or rewire:

- dashboard page rendering;
- read-only delivery queue display via backend API;
- manual cancel/requeue/force action buttons as backend API clients;
- reminders UI, if reminders remain a dashboard feature;
- redirects UI, if redirect mapping remains an operator feature.

### `backend-v2.js`

Add:

- delivery task store and indexes;
- task create/update by idempotency key;
- claim/defer/validate/ack/stale/cancel APIs;
- lease expiry sweeper;
- task suppression from `check_inbox()` read ack;
- delivery queue serialization for dashboard;
- unified ack service used by both new relay ack and old `/api/runtime/push-delivered`.

Refactor:

- `dispatchStoredMessage()` continues to persist and broadcast message truth, but notification delivery goes through delivery task creation;
- `pushNotify()` becomes a compatibility facade or is replaced by `createDeliveryTaskForAgent()`;
- `notifyAgentCatchup()` creates delivery tasks and does not mark remote catchup complete until delivery ack, stale, or cursor advance;
- `clearQueuedNotificationsForAgent()` becomes backend-local delivery task cancellation, not web-bridge DELETE to `server.js`;
- outbound guard reads unified runtime gate state set by delivery ack.

### `lib/push-relay-core.js`

Refactor:

- stop injecting from generic `message` SSE;
- add delivery wakeup handler and claim loop;
- replace in-memory `relayQueue` with backend leases/defer;
- keep only short-lived local execution state for current claim;
- call backend validation immediately before injection;
- call backend ack immediately after injection;
- use shared `injectTmuxNotification()` primitive;
- report blocked/idle observations in defer/ack payloads;
- maintain heartbeat/runtime reporting.

Delete or demote:

- `delivered`, `inFlight`, `deliveredOrder` as correctness state;
- `unreadBackfillCursor` as delivery correctness state;
- synthetic unread backfill direct injection. Reconnect should claim backend tasks; generic backfill can remain only as operator diagnostic if no task exists and backend explicitly asks for it.

### `remote/lib/push-relay-core.js`

Keep mirrored with root `lib/push-relay-core.js`. Any divergence must be profile configuration in wrappers, not implementation.

### `backend SSE adapter`

Keep SSE as event transport, but change delivery semantics:

- `message` remains an informational stream for dashboards/bridges;
- `delivery_wakeup` is the only relay delivery signal;
- relay correctness does not depend on receiving every SSE frame because polling claim is required.

### `bin/agent-up` And `remote/bin/agent-up`

Not part of delivery queue migration, but required for full local/remote unification:

- both launchers must inject the same `AGENT_CHAT_SERVER` into MCP;
- remote must not silently default MCP registration to `local`;
- managed MCP behavior must be tested and aligned;
- Codex MCP auth must be explicit through per-agent token or injected host-safe credential.

## Reminders And Redirects Decision

Current `server.js` queue also supports delayed reminders and target redirects. These should be separated from delivery ownership.

Recommended split:

- Reminder scheduling remains a backend-owned task/message producer.
- When a reminder is due, backend creates either:
  - an internal message, then a delivery task; or
  - a delivery task with `kind=reminder_notification` if it does not need inbox message truth.
- Redirects become backend address-resolution rules applied at task creation and claim validation.
- Dashboard can manage reminders/redirects, but cannot own final delivery.

Decision needed:

- If reminders should appear in `check_inbox()`, model them as messages.
- If reminders are only tmux nudges, model them as delivery tasks but accept that recovery is audit log, not inbox.

For safety, operator-facing reminders should be messages so they survive missed injection.

## SSE Versus Polling Decision

SSE alone is not enough as a delivery queue. It is fine as a wakeup channel.

Recommended:

- Use SSE for low latency.
- Use `claim` polling for correctness.
- Use backend leases for exclusive ownership.
- Use backend unread validation for stale suppression.

Polling interval:

- normal: 5 seconds;
- after SSE wakeup: immediate;
- after repeated empty claims: back off to 15 seconds;
- after server offline/maintenance: no claims until heartbeat accepted.

This gives near-real-time behavior without making SSE replay reliability a correctness dependency.

## Stepwise Versus Big-Bang Migration

Recommended: staged migration.

Reasons:

- Direct tmux injection is human-visible and destructive enough that duplicate bugs matter.
- Current local and remote services are live.
- `server.js` also hosts dashboard/reminder/redirect surfaces that must be separated without breaking operator workflows.
- Backend task store can be introduced under tests before switching live delivery.

Do not do a big-bang cut unless an operator maintenance window accepts notification delays and manual rollback.

## Test Coverage Requirements

### Backend Delivery Store

- create task by idempotency key is idempotent;
- claim grants one lease per task;
- second claim cannot take unexpired lease;
- expired lease returns to pending;
- ack from non-owner server is rejected;
- ack mutates same runtime fields as current `/api/runtime/push-delivered`;
- `check_inbox()` suppresses matching pending and leased tasks;
- terminal tasks are not retried after restart.

### Relay Worker

- relay claims only tasks for its server;
- active pane defers, idle pane injects;
- blocked pane defers even when idle;
- capture failure defers;
- urgent bypasses active idle threshold but not missing/blocked/unknown target;
- validate stale-read before injection drops task and does not call tmux;
- injection success calls ack with notify metadata;
- injection failure before payload defers/retries;
- partial after payload does not repaste.

### Local/Remote Parity

- same relay worker test runs with `PUSH_RELAY_MODE=local` and `remote`;
- `remote/lib/push-relay-core.js` mirrors root core;
- server id mismatch fails closed;
- missing `AGENT_CHAT_SERVER` in remote profile fails startup or registers no agent.

### Dashboard Compatibility

- dashboard queue page reads backend delivery tasks;
- cancel/requeue actions call backend delivery APIs;
- old manual queue endpoints are either hidden, compatibility-only, or clearly marked non-default.

### Migration Tests

- existing `logs/queue.json` entries can be imported or ignored according to migration decision;
- old `/api/runtime/push-delivered` wrapper still updates new delivery ack service;
- no backend path posts default notifications to `server.js /api/queue`.

## Operational Signals

Add or normalize these event types:

- `delivery.task_created`
- `delivery.claimed`
- `delivery.deferred`
- `delivery.validated`
- `delivery.stale`
- `delivery.injected`
- `delivery.acked`
- `delivery.partial`
- `delivery.dead`
- `delivery.cancelled`

Dashboard should expose:

- pending tasks by server and target agent;
- oldest pending age;
- lease owner and expiry;
- retry count and last reason;
- stale/suppressed/dead terminal counts;
- relay heartbeat/version per server.

Alerts:

- task pending longer than threshold for human/operator messages;
- repeated `inject-partial`;
- server has pending tasks but no heartbeat;
- relay version mismatch while tasks are pending;
- stale-read drops spike, suggesting duplicate wakeups or slow agents.

## Rollback Plan

During Phase A/B:

- Keep old `server.js /api/queue` delivery path behind a feature flag such as `AGENTCHAT_LEGACY_WEB_QUEUE_DELIVERY=1`.
- New backend task creation can be disabled with `AGENTCHAT_DELIVERY_QUEUE_ENABLED=0`.
- Relay claim worker can run in dry-run mode: claim/defer without injection.

Rollback from Phase C:

1. Disable relay claim injection.
2. Re-enable legacy `pushNotify()` web queue posting.
3. Leave backend task store read-only for diagnostics.
4. Do not delete task history until after stable soak.

Rollback after Phase D is harder and should require a maintenance window.

## Open Decision Points

1. Should reminders be represented as inbox messages or delivery-only tasks?
2. Should `urgent` ever bypass blocked prompt detection? Recommended: no.
3. Should partial injection after payload be treated as delivered or dead? Recommended: delivered with `partial=true`, no automatic retry.
4. Should task storage remain JSON or move to SQLite? JSON is acceptable for phase 1; SQLite becomes attractive once task volume or query complexity grows.
5. What is the first production mode: shadow queue, dry-run relay claims, or direct switch for one canary agent?
6. Should host credentials split from `API_TOKEN` in the same migration, or remain a later auth phase? Recommended: keep compatibility first, but design endpoints around host-scoped auth.

## Recommended Implementation Order

1. Backend task store, idempotency, lease, claim/defer/ack/stale/cancel APIs.
2. Unified ack service and `/api/runtime/push-delivered` compatibility wrapper.
3. `check_inbox()` task suppression.
4. Relay claim worker behind feature flag, with dry-run mode.
5. Shared tmux injector and relay validation before injection.
6. Switch central-local relay to claim API while keeping legacy web queue fallback disabled by default but available.
7. Switch remote relay to claim API.
8. Dashboard queue view backed by backend delivery tasks.
9. Remove default backend posting to `server.js /api/queue`.
10. After soak, delete server.js delivery queue ownership.

## Success Criteria

- A notification task follows the same state machine whether target agent is on central-local or remote.
- No default delivery path injects directly from raw message SSE.
- `server.js` can be restarted without losing or replaying backend-owned delivery tasks.
- Relay crash before ack is recovered by lease expiry.
- `check_inbox()` before relay drain prevents injection.
- Delivery ack always updates inboxGate/runtime for actionable notifications.
- Remote and local tests exercise the same relay worker code.
- Operators can inspect one backend queue to answer: what should be delivered, who owns it, when it was last attempted, and why it is waiting.
