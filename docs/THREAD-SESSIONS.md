# Thread Sessions

> Status: design accepted by the operator on 2026-08-03; implementation is
> present and default-off. A live one-agent canary was run and accepted by the
> operator on 2026-08-13/14 on the local test deployment (per-thread context
> isolation via independent nonce recall, reply thread-root correctness,
> long-task parallelism across threads, and context rebuild from router.db
> across a full backend restart). The five-run real-model continuity probe has
> NOT been executed and remains a release blocker for any non-local
> deployment; see "Rebuild continuity release gate" below.

## Pre-implementation verification

### Codex approval adapter

- Local Codex: `codex-cli 0.146.0`.
- The existing interactive hook was inspected, explicitly trusted through the
  supported preflight (`TRUST` in a TTY), and two subsequent inspections passed
  with the same content hash. Different capability environment values did not
  change that hash.
- Two real `codex exec --json` probes did not invoke the PermissionRequest hook
  and performed no protected action. This is consistent with `exec` being a
  non-interactive automation surface; it is not the adapter for this feature.
- A real short-lived `codex app-server --stdio` process created an ephemeral
  thread in a read-only sandbox. The turn emitted
  `item/commandExecution/requestApproval` with matching thread, turn, request,
  item, command, and cwd fields. The client replied `accept`; Codex emitted
  `serverRequest/resolved`, executed the command, and completed the turn. The
  marker was verified and removed.
- Decision: the thread-session Codex runner uses App Server's native approval
  requests and never depends on an unattended TUI prompt or per-dispatch hook
  mutation.

### Runner acknowledgement timing

Three consecutive local one-shot launches were fed a stdin prompt and measured
to their first structured stdout event. This is deliberately more conservative
than the wrapper's future child-stdin acknowledgement:

| Runtime | Samples | Maximum |
| --- | --- | --- |
| Codex | 4562 ms, 3549 ms, 3518 ms | 4562 ms |
| Claude | 22134 ms, 19305 ms, 20352 ms | 22134 ms |

The rejected 5000 ms default would falsely fail every measured Claude launch.
The implementation default is therefore `HAFLEET_RUNNER_ACK_MS=60000`; the
wrapper must acknowledge after the verified child accepts the complete stdin
payload and must not wait for model text.

### TypeScript and SQLite dependencies

- Runtime Node: `v22.23.1`; npm: `10.9.8`.
- Installed pinned `better-sqlite3@13.0.2`, `typescript@7.0.2`,
  `@types/node@26.1.2`, and `@types/better-sqlite3@9.6.0`.
- SQLite returned WAL mode with foreign keys enabled; a committed row survived
  database close and process restart.
- A clean temporary Node 22 checkout completed `npm ci`, rebuilt the native
  addon, and repeated the WAL restart probe successfully.
- `check:remote-package-smoke` passed. The dependency audit still reports the
  repository's existing transitive advisory set; none names the four packages
  introduced by this contract. No automatic audit fix or fallback was used.

### Rebuild continuity release gate

The required real-model continuity gate has not yet been executed for this
assembler revision. Before enabling the feature, run five independent
three-turn conversations in one session: turn 1 establishes a distinctive
agreement, turn 2 changes topic, and turn 3 asks for that agreement. At least
four runs must recover it verbatim or by an unambiguous reference. String-level
assembler tests do not satisfy this gate. Record the model/runtime, prompt set,
individual outcomes, and date here before canary enablement.

## Implementation order

1. Router TypeScript build, SQLite migrations, architecture boundary, and
   existing task-store cutover.
2. Immutable input ingestion and Matrix task-thread outbox/receipt protocol.
3. Capability-authenticated local one-shot dispatch, fencing, and resource
   leases.
4. Approval decision reconciliation, session-scoped MCP, and privacy-filtered
   snapshot/event read model.
5. Default-off integration, shadow mode, one-agent canary, then black-box and
   full regression verification.

## Implemented runtime contract

The backend owns opaque sessions keyed by stable agent id, Matrix room, and
main/thread scope. Matrix input is copied into `data/router.db`; tmux panes,
runtime conversation ids, and model-authored reply targets are not routing
inputs. Local Claude and Codex turns run as disposable child processes. Octos
and remote-registered agents are refused visibly while the feature is enabled.
Runner processes receive an explicit environment allowlist plus their agent
token and short-lived dispatch capability. Backend bearer, Matrix bridge, and
Dashboard credentials are never inherited by the model runtime or its MCP
child.

Each actual Claude/Codex runtime is held by a short-lived guardian process.
Normal shutdown stops new pump work, aborts all guardians, waits for their
dispatches to settle, and only then exits. If the backend is killed abruptly,
IPC ownership loss makes the guardian terminate the runtime process tree, so an
`outcome_unknown` workspace is not still being changed by an orphan.

Task creation and reply delivery cross the Matrix boundary through durable
outboxes with stable transaction ids. A worker main-timeline mention and an
explicit `/task @worker ...` command create a pending task/thread intent; no
coding dispatch exists until Matrix acknowledges the rooted thread event.
Before that acknowledgement, worker task input is stored without creating a
worker main session. Explicit task input is excluded from front-desk batching
but remains eligible for its bound worker task dispatch. If acknowledgement
succeeds but workspace or runner preparation fails, the task is durably blocked
and a thread notice is queued instead of misreporting the Matrix send as failed.
The backend derives the reply room and thread from the dispatch record.

Runner context contains only processed inputs and the current batch for that
session. The serialized context is hard-capped at four characters per
configured rebuild token; oversized current input carries an explicit
truncation marker and remains available in full only through the
capability-scoped inbox. Earlier agreement-like constraints are pinned in the
rolling summary, and coordinator main sessions begin with a bounded digest of
active topics.

Claude permission requests use the existing owner approval store through a
two-phase park/consume/apply path. Codex uses App Server's native approval
requests bound to upstream thread, turn, item, request, dispatch, and operation
digest. The dispatch room selects the exact owner binding when an agent belongs
to multiple project rooms, and the adapter timeout is derived from
`HAFLEET_APPROVAL_TTL_MS` plus the bounded delivery margin. A runner parked
for approval keeps its leases. Failure after `started` settles
`outcome_unknown`, creates an inspection notice, preserves workspace dirty
state, and is never automatically retried.

A process that fails before `takePayload` commits `started` is different: its
capability and leases are revoked atomically, the original dispatch and message
assignment remain queued, and the scheduler retries after the durable
`HAFLEET_RUNNER_LAUNCH_RETRY_MS` delay (default 5000 ms). This prevents a
broken executable or profile from becoming a hot launch loop without relaxing
the at-most-once rule after `started`.

### Recovering an `outcome_unknown` dispatch

The old dispatch is immutable terminal evidence. Recovery never changes it
back to queued and never gives its payload to another runner. Until an operator
resolves it, the router quarantines both its session and, for a writer, its
workspace. Later thread messages are stored and may form a new queued batch,
but the scheduler cannot claim that batch. A bare `clear-dirty` request cannot
bypass an outcome quarantine.

Recovery is a two-step authenticated operation:

1. `POST /api/router/dispatches/:id/outcome-inspection` returns a short-lived,
   single-use inspection token bound to the dispatch, safe workspace label,
   and durable dirty generation. The token is stored only as a hash and the
   response never includes an absolute path.
2. After inspecting the real checkout and any external side effects, the
   operator calls `POST /api/router/dispatches/:id/resolve-outcome` with that
   token, a unique request id, an audit note, and one action:
   - `continue` requires an explicit recovery instruction. It clears the
     matching quarantine and queues or extends a **new** dispatch containing
     that instruction plus any later pending inputs.
   - `accept_completed` accepts the inspected current result, marks the task
     done, and launches nothing.
   - `keep_blocked` clears the inspected workspace quarantine but keeps the
     task blocked and launches nothing.

Resolution is one SQLite transaction: it verifies the unexpired token and
dirty generation, consumes the inspection, records the idempotent audit row,
updates task/quarantine state, and, for `continue`, creates the replacement
dispatch. A changed dirty generation forces a new inspection. The scheduler
also refuses queued work for unresolved sessions, dirty resources, and tasks
whose durable status is blocked or done. Operator notes and raw inspection
tokens are excluded from snapshots and events.

V1 does not automatically evict durable session identities or remove
worktrees. Worktree cleanup is explicit, refuses dirty checkouts, and never
deletes the branch as a side effect.

One assignee may have only one task binding for a Matrix room/thread root, so a
follow-up can never resolve to an arbitrary task. A source message may still
contribute to several tasks when those tasks have distinct assignees. Worktree
resource identity includes the canonical repository and worktree root as well
as agent/thread identity, and a registered resource path cannot later be
overwritten by configuration drift. Bootstrap success is recorded outside the
checkout in that worktree's Git metadata. A missing, failed, or corrupt marker
never counts as successful initialization; a failed bootstrap that dirtied the
checkout requires operator repair before reuse.

The agent registration API treats `workdir`, `workspace_mode`, `worktrees_dir`,
and `worktree_bootstrap` as operator-owned execution configuration. Worktree
preparation runs in a separate helper process with a small environment
allowlist; backend, Matrix, Dashboard, agent, and provider credentials are not
inherited. The helper also keeps bootstrap cost off the backend event loop.

## Enablement and rollback

The task-store cutover and runtime switch are separate and both default off:

```text
HAFLEET_ROUTER_TASK_CUTOVER=1
HAFLEET_THREAD_SESSIONS=1
```

Both the backend and Matrix bridge must receive
`HAFLEET_THREAD_SESSIONS=1`. The backend refuses thread sessions unless the
task-store cutover is already enabled. Turning only the thread-session switch
off immediately restores legacy delivery without switching the migrated task
writer back to JSON.

Before cutover, `HAFLEET_ROUTER_SHADOW=1` copies eligible local Claude/Codex
Matrix inputs into router sessions while leaving task creation, dispatch,
outboxes, and legacy delivery untouched. Shadow failures are audit-only and do
not change the legacy delivery result.

On the first enabled startup, the durable source-ingestion cursor is based at
the newest already-persisted Matrix source message; historical backlog is not
replayed. Later startups scan strictly after that cursor and reconcile the
crash window idempotently before retention may prune an uncopied source row.

Recommended rollout is shadow observation, then one local agent, followed by
broader enablement. Rollback after task cutover requires an offline reverse
export if JSON is to become the task writer again; the service never switches
task writers dynamically.

Octos and remote-registered agents remain explicitly unsupported by this V1
contract. The staged prerequisites for changing those decisions are recorded
in `docs/ROADMAP-thread-session-runner-expansion.md`; that roadmap does not
enable either path or permit fallback to legacy tmux delivery.

## Verification

- The task spec has 45 deterministic selectors, all present in the router and
  integration suites.
- Focused router, runner, backend, Matrix bridge, MCP approval, and approval
  store verification passes serially.
- Strict TypeScript, checked-in build freshness, internal-import isolation,
  architecture ownership, syntax, and local/remote mirror gates pass.
- The clean-install acceptance test runs `npm ci`, builds the router, and
  verifies a committed WAL row across a fresh process restart on Node 22.

`agent-spec` 1.2 validates the contract at quality 100% and checks structural
boundaries, but it does not execute the Vitest selectors in this Node project;
the exact Vitest suite is therefore run separately and must not be reported as
an `agent-spec` execution result.
