# Systems Skill Scan

Date: 2026-05-03
Owner: salt
Status: read-only audit, no runtime code changed

## Purpose

This pass used the expanded local `systems-audit` and `systems-refactoring`
skills to re-scan agent-chat with five lenses:

- reliability and operability
- delivery, replay, idempotency, and human-visible side effects
- CI/CD and release gates
- CLI and operator contracts
- architecture and maintainability

The local skill assets live under `~/.codex/skills/` and are not committed to
this repository. This document records the project findings that came out of
using those skills on agent-chat.

## High-Level Result

The previous work improved CI, remote package checks, idle display, and several
remote/local diagnostics. The new scan shows the remaining highest-risk gaps are
not simple syntax or dispatch drift. They are state-transition and observability
gaps:

- direct tmux injection still lacks a durable sink-side exactly-once boundary
- stale queued notifications are checked by unread counts, not by source message
- remote autodeploy can still call a restart successful without post-deploy
  version/heartbeat proof
- stable autodeploy has a release gate in the script, but the live service
  template still does not enable it by default
- `/health` does not model delivery, queue, heartbeat, runtime, or alert flows
- dashboard/local write paths can still become parallel truth sources beside the
  backend kernel

## Subagent Coverage

| Boundary | Result |
| --- | --- |
| Delivery/replay/direct injection | Found five state-machine issues around stale queue entries, partial tmux injection, concurrent SSE delivery, stale push-delivered acks, and implicit inbox ack. |
| CLI/CD | Found stable release gate default, remote post-deploy verification, remote dependency retry/install tree, standalone package versioning, and `agentchat send --help` contract gaps. |
| Operability | Found missing flow-level health, missing server-offline alerting, weak actionable alert fields, unknown-vs-pane-missing collapse, missing durable delivery event correlation, and stale supervisor snapshots. |
| Architecture | Found backend and dashboard hub/source-of-truth risks; current remote sync/package/CLI/dependency isolation gates are green, but profile and architecture decisions remain open. |

## New Findings

| ID | Severity | Area | Evidence | Impact | Repair direction |
| --- | --- | --- | --- | --- | --- |
| SYS-001 | P0 | Push delivery stale queue | [server.js](/Users/kamico/agent-chat/server.js:306), [server.js](/Users/kamico/agent-chat/server.js:3037) | A stale queued notification can be injected if the original message was read and a different unread message keeps the same unread count. | Bind stale checks to `sourceMsgId` and unread ids/cursor, not only unread totals. |
| SYS-002 | P0 | Tmux injection idempotency | [server.js](/Users/kamico/agent-chat/server.js:2922), [server.js](/Users/kamico/agent-chat/server.js:3031) | If payload paste succeeds and Enter fails, retry can paste the same payload again. | Add sink-side effect record or mark partial injection as operator-required instead of auto-requeue. |
| SYS-003 | P0 | Relay SSE dedupe | [lib/push-relay-core.js](/Users/kamico/agent-chat/lib/push-relay-core.js:765), [lib/push-relay-core.js](/Users/kamico/agent-chat/lib/push-relay-core.js:840) | Concurrent duplicate SSE frames can pass in-memory dedupe before either marks delivered, causing duplicate direct injection. | Claim `messageId:agent` before side effects; make the claim durable or backend-leased for multi-relay/restart safety. |
| SYS-004 | P1 | Push-delivered ack | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:7128), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:4203) | Late or stale local acks can overwrite current inbox gate/runtime timestamps. | Validate `queueEntryId`, `sourceMsgId`, and monotonic `deliveredAt`; make duplicate acks idempotent no-ops. |
| SYS-005 | P2 | Inbox cursor ack | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:9036), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:9068) | Reading inbox also advances cursor and clears queued notifications; a lost response can acknowledge unseen messages. | Split preview/read from explicit ack, or add compatibility `advance=1` semantics before a larger contract change. |
| SYS-006 | P0 | Stable CD gate | [agent-chat-stable-autodeploy.service](/Users/kamico/agent-chat/agent-chat-stable-autodeploy.service:10), [scripts/agentchat-stable-autodeploy.sh](/Users/kamico/agent-chat/scripts/agentchat-stable-autodeploy.sh:12) | The script has a worktree release gate, but the service default can still deploy pushed `stable` before CI completes. | Enable `AGENTCHAT_RELEASE_GATE=worktree` in the live service template or add a stronger GitHub check-run gate. |
| SYS-007 | P0 | Remote CD proof | [scripts/agentchat-remote-autodeploy.sh](/Users/kamico/agent-chat/scripts/agentchat-remote-autodeploy.sh:113), [bin/verify-remote](/Users/kamico/agent-chat/bin/verify-remote:193) | Remote restart success can be reported as deploy success without proving heartbeat, version, API token, or server id. | Call `verify-remote --expect-version <sha>` after restart and keep `deploy_pending=true` on failure. |
| SYS-008 | P0 | Remote dependency retry | [scripts/agentchat-remote-autodeploy.sh](/Users/kamico/agent-chat/scripts/agentchat-remote-autodeploy.sh:18), [scripts/agentchat-remote-autodeploy.sh](/Users/kamico/agent-chat/scripts/agentchat-remote-autodeploy.sh:98), [remote/install-remote.sh](/Users/kamico/agent-chat/remote/install-remote.sh:146) | Remote autodeploy checks root dependency manifests and can skip install after a failed install because `HEAD` already moved. | Watch `remote/package*.json`, install under `remote/`, and persist install-needed state from last successful deploy. |
| SYS-009 | P0 | Flow-level health | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:6304) | `/health` can remain `ok:true` while delivery, queue, runtime reports, or remote heartbeat are unhealthy. | Add health flows with `healthy/degraded/unhealthy/unknown`, TTLs, and decision rules. |
| SYS-010 | P0 | Server outage alerting | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:3404), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:5006), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:6525) | Server heartbeat expiry can collapse into agent offline state without a root server outage alert. | Emit actionable `server_offline:<server>` alerts with maintenance suppression, affected agents, runbook, and recovery condition. |
| SYS-011 | P1 | Delivery event correlation | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:3961), [server.js](/Users/kamico/agent-chat/server.js:2949), [lib/push-relay-core.js](/Users/kamico/agent-chat/lib/push-relay-core.js:750) | A direct-injection incident cannot be reconstructed end-to-end from durable state. | Add durable delivery events keyed by message, queue entry, target, attempt, state, reason, and relay instance. |
| SYS-012 | P1 | Queue observation states | [server.js](/Users/kamico/agent-chat/server.js:2726), [server.js](/Users/kamico/agent-chat/server.js:3007), [server.js](/Users/kamico/agent-chat/server.js:7297) | Capture failure, untracked pane, and confirmed pane-missing can all become `idleMs < 0`, eventually dropping notifications. | Track explicit `targetObservation.state` and drop only confirmed missing targets. |
| SYS-013 | P1 | CLI help contract | [bin/agentchat](/Users/kamico/agent-chat/bin/agentchat:29), [bin/agent-send](/Users/kamico/agent-chat/bin/agent-send:29), [scripts/check-cli-contract.js](/Users/kamico/agent-chat/scripts/check-cli-contract.js:82) | `agentchat send --help` is advertised but returns an unknown-option failure; current contract checks do not cover every advertised subcommand. | Make all advertised subcommands support `--help` and expand the manifest contract check. |
| SYS-014 | P1 | Dashboard local writes | [server.js](/Users/kamico/agent-chat/server.js:744), [server.js](/Users/kamico/agent-chat/server.js:1909), [server.js](/Users/kamico/agent-chat/server.js:2160) | Dashboard routes can write local manifests/runtime state before best-effort backend sync, creating parallel truth. | Route writes through backend commands or add durable local-first reconciliation with dirty markers. |
| SYS-015 | P2 | Dashboard delivery log naming | [server.js](/Users/kamico/agent-chat/server.js:29), [server.js](/Users/kamico/agent-chat/server.js:117), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:3964) | Dashboard `/api/messages` can be confused with kernel message truth even though it reads a local delivery log. | Rename/partition delivery-log APIs or proxy backend message truth for message history. |
| SYS-016 | P1 | Actionable alerts | [lib/alert-store.js](/Users/kamico/agent-chat/lib/alert-store.js:152), [lib/supervisor-action-engine.js](/Users/kamico/agent-chat/lib/supervisor-action-engine.js:45) | Alerts lack owner, runbook, exit condition, SLO impact, and correlation fields, limiting incident actionability. | Add required fields for warning/critical alerts or downgrade incomplete events to non-paging diagnostics. |
| SYS-017 | P2 | Supervisor snapshot staleness | [lib/supervisor-snapshot-store.js](/Users/kamico/agent-chat/lib/supervisor-snapshot-store.js:247), [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:8074) | Old negative/focused snapshots can influence current supervisor status or task health. | Add snapshot freshness/expiry and stop enriching current status from expired assessments. |
| SYS-018 | P2 | Architecture fitness | [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:11), [server.js](/Users/kamico/agent-chat/server.js:744), [docs/salt/kernel-boundaries.md](/Users/kamico/agent-chat/docs/salt/kernel-boundaries.md:49) | Kernel/edge/dashboard boundaries are mostly documented, not executable, so drift can return. | Add ADRs and `check:architecture-boundaries` for imports, route ownership, write paths, and root/remote profile decisions. |

## Existing Rows Reconfirmed

The scan also reinforced these existing repair-table rows:

- R-032: remote autodeploy needs post-deploy `verify-remote`.
- R-033: remote autodeploy must install dependencies in the runtime tree it executes.
- R-037: stable deploy must be gated before live reset/restart.
- R-038: dependency install retry state must survive failed deploy attempts.
- R-047: full-clone remote install profile remains decision-gated.
- R-048: remote dependency reproducibility remains decision-gated.
- R-049: standalone remote package versioning remains decision-gated.
- R-050: remote CD install/service-helper reconciliation remains decision-gated.

## Recommended Repair Batches

### Batch SYS-A: Direct Injection Idempotency

Scope:

- SYS-001 stale notification source binding
- SYS-002 partial tmux injection handling
- SYS-003 relay in-flight/durable dedupe
- SYS-004 monotonic push-delivered ack

Verification:

- targeted `tests/server-delivery.test.js`
- targeted `tests/push-relay.test.js`
- `npm run verify:ci`

### Batch SYS-B: CD Must Prove Loaded Runtime

Scope:

- SYS-006 stable service release gate
- SYS-007 remote post-deploy verification
- SYS-008 remote dependency retry/install tree

Verification:

- `tests/stable-autodeploy.test.js`
- new remote-autodeploy fake-repo tests
- `npm run verify:cd-preflight`
- post-stable `verify-remote --expect-version`

This batch touches deploy behavior and should be explicitly approved by
ac-topleader/operator before implementation.

### Batch SYS-C: Health and Incident Evidence

Scope:

- SYS-009 flow-level health
- SYS-010 server outage alerting
- SYS-011 durable delivery events
- SYS-012 queue observation state
- SYS-016 actionable alert fields

Verification:

- API tests for `/health` flow states
- alert-store tests
- delivery event black-box tests
- dashboard queue observation tests

### Batch SYS-D: Operator and Architecture Contracts

Scope:

- SYS-013 CLI help contract expansion
- SYS-014 dashboard local write truth
- SYS-015 dashboard delivery log naming
- SYS-017 supervisor snapshot freshness
- SYS-018 architecture fitness checks and ADR index

Verification:

- `npm run check:cli-contract`
- new architecture boundary check
- focused dashboard/backend tests
- `npm run verify:ci`

## Decision Points

- Whether to implement effective exactly-once direct injection through backend
  delivery leases, local durable records, or a staged local in-flight record first.
- Whether stable service defaults may be changed immediately to
  `AGENTCHAT_RELEASE_GATE=worktree`.
- Whether remote autodeploy is allowed to own dependency install/retry behavior
  now, or if it must remain code-restart-only until operator policy is closed.
- Whether `/health.ok` may become false for degraded flows, or if compatibility
  requires preserving `ok:true` and adding a separate `/health/flows` endpoint.
- Whether dashboard local-first writes are still an intended product model or
  should be made backend-command-first.
