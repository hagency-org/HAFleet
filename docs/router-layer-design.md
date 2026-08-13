# Router Layer — Module Boundary and Store Design

Implements ADR-011 / REQ-THREAD-SCOPED-SESSIONS. Read that pair first; this
document fixes the implementation shape, transaction boundaries, and recovery
protocol. It does not turn a Proposed decision into an implementation mandate.

> Status: accepted design, implemented in the current default-off worktree.
> Automated acceptance passes; production canary remains pending. The named
> runtime and storage spikes passed on 2026-08-03 and are recorded in
> `docs/THREAD-SESSIONS.md`.

## 1. Ownership and consistency model

The router runs in the agent-chat backend process and is the sole writer of
`data/router.db`. It owns topic sessions, the existing durable task model after
its one-time migration, immutable session inputs, task/thread bindings,
dispatches, runner capabilities, workspace state, leases, and the client read
projection.

Only changes inside `router.db` are described as atomic. Three command-shaped
operations are single SQLite transactions:

- task intent, task inputs, and its Matrix delivery outbox entry;
- dispatch claim, fencing generation, capability issuance, and all resource
  leases required by that dispatch;
- dispatch settlement, capability revocation, lease release, and persistent
  workspace-dirty state.

Matrix and the approval store are separate durable systems. They cannot take
part in a SQLite transaction. Their boundaries use an idempotent durable
outbox/inbox protocol:

- Matrix thread creation is a router outbox command with a stable transaction
  id. The bridge sends it idempotently, journals the Matrix event id, and
  acknowledges it. A router transaction then records the anchor event,
  activates the task binding, and marks its task inputs activated.
- Approval consumption remains authoritative in `lib/approval-store.js`. A
  consumed decision carries a stable decision-event id and dispatch binding.
  The router records that event idempotently before an allow can reach the
  runner. If either durable write fails, the adapter returns no allow; restart
  reconciliation replays consumed-but-unapplied events.

This is a fail-closed saga, not fictional cross-store atomicity. Reconciliation
may repeat commands, so every command has a stable idempotency key and a
payload digest; reusing a key with different content is a conflict.

## 2. Language, dependencies, and build

The router is TypeScript compiled to ordinary ESM JavaScript. Production runs
`router/dist/index.js`; it does not use Node type stripping or `node:sqlite`.
The implementation contract approves exactly four new direct dependencies for
this layer:

- `better-sqlite3` as the non-experimental SQLite adapter;
- `typescript`, `@types/node`, and `@types/better-sqlite3` as development
  dependencies.

Both are pinned through `package-lock.json` and must pass the repository's
dependency audit and a clean Node 22 install/build spike before ADR-011 can be
Accepted. Native-addon installation failure is a release blocker, not a reason
to fall back silently to JSON or experimental APIs.

Layout and build rules:

- Sources live in `router/src/**.ts`; checked-in output lives in
  `router/dist/**.js` and `router/dist/**.d.ts`.
- `tsconfig.router.json` enables `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- `npm run build:router` compiles; `npm run typecheck:router` runs
  `tsc --noEmit`.
- `npm run check:router-build` builds in a temporary directory and byte-checks
  the result against `router/dist`.
- `verify:ci` runs typecheck and the stale-build check.
- Code outside the router imports only `router/dist/index.js`. An architecture
  check rejects imports of `router/src`, router internals, or the database
  adapter.
- Branded values have private constructors at validation boundaries. Router
  source may not use `any`, unchecked double assertions, or exported brand
  constructors; lint and type-level tests enforce this. Types are a guardrail,
  not an authorization boundary.

## 3. Domain identity and existing task migration

A topic session has an opaque `session_id`. Its natural identity is:

```text
(agent_id, room_id, scope_kind, thread_root_event_id)
```

`agent_id` is the stable v1 home-manifest id, never the mutable display name.
Agents without a valid stable id are refused by the feature. `scope_kind` is
`main` or `thread`; main sessions have no thread root. Partial unique indexes
enforce one main session per agent/room and one thread session per
agent/room/root. No delimiter-concatenated string is a database identity.

The router does not create a second task system. A one-way task-store cutover is
a deployment prerequisite, separate from the thread-session feature switch. It
imports `tasks.json` into the `tasks` table under a versioned, resumable
migration, verifies count and canonical record digests, and then serves the
existing `/api/tasks` API from the router repository. Legacy tasks remain valid
workflow records but have no execution binding and are not dispatchable until
explicitly bound to a confirmed thread. After successful cutover, the JSON task
store becomes a timestamped read-only backup and is no longer written. The
service never switches writers at runtime; rollback requires stopping the
service and running the documented reverse export before restart.

Task workflow state (`created`, `accepted`, `in_progress`, `blocked`, `done`)
stays distinct from task-thread activation (`pending_thread`, `active`,
`thread_delivery_failed`, `closed`). The project board continues to consume the
existing API shape; it does not join a second router task feed.

Task creation uses a caller request key, not a hash of input messages:

- a coordinator uses `(creator_dispatch_id, tool_call_id)`;
- `/task` uses the authenticated originating Matrix event id;
- an operator endpoint requires an explicit idempotency key.

The router stores a canonical payload digest beside the key. A replay with the
same key and digest returns the original task; the same key with a different
digest fails with `idempotency_conflict`. `attachTaskInputs` has its own request
key and supports later supplementary messages. A message may be attached to
more than one task; consumption is therefore represented per task input, not
by a globally unique message row.

## 4. Matrix thread activation

The human source event already supplies `thread_root_event_id`. It is known
before task intent creation and never changes. The agent's acknowledgement is
a different value, `thread_anchor_event_id`, and remains null until the bridge
confirms its send.

`createTaskIntent` performs one router transaction:

1. validate the authenticated source messages and copy their normalized,
   immutable input into the router store;
2. create or replay the existing task plus its execution binding;
3. attach task inputs, leaving `activated_at` null;
4. enqueue a Matrix command whose `m.thread` root is the human event and whose
   stable Matrix transaction id derives from the outbox id.

The bridge is explicitly part of this contract. It claims the command through
a bridge-secret endpoint, sends an `m.thread` relation rooted at
`thread_root_event_id`, journals the returned event id using ADR-007's recovery
pattern, and acknowledges the outbox command. The acknowledgement transaction
sets `thread_anchor_event_id`, activates the task binding and session, and marks
the task inputs activated.

If Matrix rejects the send, the task becomes `thread_delivery_failed`, the
inputs stay unactivated, and the front desk receives a visible failure. A human
may retry the same outbox command; the stable Matrix transaction id prevents a
duplicate event when the first send succeeded but its acknowledgement was
lost. No runner may claim a dispatch for an unconfirmed binding.

## 5. Public interface

The only import is `router/dist/index.js`. Expected policy refusals are
discriminated results; corrupt state and programmer errors throw and fail the
request. Mutations are command-shaped so callers cannot split an invariant
across multiple transactions.

```ts
export type Router = {
  ingestMessage(input: AuthenticatedMessageInput): IngestResult;
  assembleFrontDeskBatch(sessionId: SessionId): Batch | null;

  createTaskIntent(input: CreateTaskIntent): TaskIntentResult;
  attachTaskInputs(input: AttachTaskInputs): AttachInputsResult;
  recordMatrixDelivery(input: MatrixDeliveryReceipt): ActivationResult;
  recordMatrixFailure(input: MatrixDeliveryFailure): TaskDeliveryResult;

  enqueueDispatch(input: EnqueueDispatch): EnqueueResult;
  claimDispatch(input: ClaimDispatch): ClaimResult;
  takePayload(input: TakePayload): StartedPayload | Refusal;
  acknowledgeRunnerEffect(input: RunnerEffect): EffectResult;
  parkForApproval(input: ParkDispatch): ParkResult;
  recordApprovalDecision(input: ApprovalDecisionEvent): ApprovalApplyResult;
  settleAndRelease(input: SettleDispatch): SettleResult;
  cancelBeforeStart(input: CancelQueuedDispatch): CancelResult;

  claimMatrixCommand(input: ClaimMatrixCommand): MatrixCommand | null;
  inspectWorkspace(input: InspectWorkspace): WorkspaceInspection;
  clearWorkspaceDirty(input: ClearWorkspaceDirty): ClearDirtyResult;

  snapshot(scope: AuthorizedSnapshotScope): Snapshot;
  eventsAfter(scope: AuthorizedSnapshotScope, seq: EventSeq): EventPage;
  reconcileOnStart(): ReconcileReport;
};
```

`claimDispatch` selects one queued dispatch, increments the durable fence,
issues a random short-lived capability whose hash is stored, and acquires all
workspace/named-resource leases in the same transaction. Raw capability values
are returned once and never persisted. The capability is bound to
`(runner_id, dispatch_id, fence_generation)` and is required by payload, inbox,
effect, park, and settlement calls.

`takePayload` atomically changes `leased` to `started` and returns the immutable
payload. HTTP response loss after commit is the deliberate ambiguous window:
the runner must not act without the success response, while the backend will
still settle the started dispatch as `outcome_unknown` rather than replay it.

`settleAndRelease` atomically records the terminal outcome, revokes the
capability, deletes ephemeral lease-holder rows, and updates persistent
workspace dirty state. There is no public `releaseWorkspace` operation.

Dispatch state is:

```ts
type Dispatch =
  | Queued
  | Leased
  | Started
  | Parked
  | Completed
  | CancelledBeforeStart
  | OutcomeUnknown;
```

`cancelled_before_start` is the only clean non-completion state. Once started,
every non-completed terminal path is `outcome_unknown`, including operator
cancel and approval expiry.

## 6. Store outline

SQLite runs in WAL mode with foreign keys enabled. The exact migration SQL is
versioned under `router/src/migrations`; these are the ownership rules the
schema must enforce:

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  room_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('main', 'thread')),
  thread_root_event_id TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  CHECK ((scope_kind = 'main' AND thread_root_event_id IS NULL) OR
         (scope_kind = 'thread' AND thread_root_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_main_session
  ON sessions(agent_id, room_id) WHERE scope_kind = 'main';
CREATE UNIQUE INDEX one_thread_session
  ON sessions(agent_id, room_id, thread_root_event_id)
  WHERE scope_kind = 'thread';

CREATE TABLE router_messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  matrix_event_id TEXT,
  thread_root_event_id TEXT,
  sender_mxid TEXT,
  normalized_body TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- The existing durable task record, migrated from tasks.json.
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  granularity TEXT NOT NULL,
  assignee_agent_id TEXT,
  assignee_name TEXT,
  created_by TEXT,
  parent_id TEXT REFERENCES tasks(task_id),
  labels_json TEXT NOT NULL,
  comments_json TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  heartbeat_at INTEGER,
  waiting_reason TEXT,
  waiting_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  creator_agent_id TEXT,
  assignee_agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_event_id TEXT NOT NULL,
  thread_anchor_event_id TEXT,
  activation_state TEXT NOT NULL,
  request_scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  UNIQUE (request_scope, request_key),
  UNIQUE (assignee_agent_id, room_id, thread_root_event_id)
);

CREATE TABLE task_inputs (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  message_id TEXT NOT NULL REFERENCES router_messages(message_id),
  role TEXT NOT NULL CHECK (role IN ('root', 'supplement')),
  attached_at INTEGER NOT NULL,
  activated_at INTEGER,
  PRIMARY KEY (task_id, message_id)
);

CREATE TABLE matrix_outbox (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  txn_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_until INTEGER,
  delivered_event_id TEXT,
  last_error TEXT
);

CREATE TABLE dispatches (
  dispatch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  task_id TEXT REFERENCES tasks(task_id),
  state TEXT NOT NULL,
  fence_generation INTEGER NOT NULL,
  runner_id TEXT,
  lease_until INTEGER,
  launch_failures INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER,
  last_launch_error TEXT,
  started_at INTEGER,
  settled_at INTEGER,
  terminal_reason TEXT
);

CREATE TABLE runner_capabilities (
  capability_hash TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
  runner_id TEXT NOT NULL,
  fence_generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Persistent resource condition and ephemeral ownership are different facts.
CREATE TABLE resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  safe_label TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  dirty_reason TEXT,
  inspected_at INTEGER
);
CREATE TABLE resource_leases (
  resource_id TEXT PRIMARY KEY REFERENCES resources(resource_id),
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
  acquired_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE TABLE approval_inbox (
  decision_event_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
  decision TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE router_event_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  low_watermark INTEGER NOT NULL,
  high_watermark INTEGER NOT NULL
);
CREATE TABLE router_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  audience_scope TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
```

Context generations, session inbox rows, worktree metadata, task-input request
keys, named resource requirements, and migration journal tables are additional
normalized tables; they follow the same ownership rules. Worktree absolute
paths remain backend-only. Client projections expose safe labels and branches,
never absolute paths.

The router copies normalized input content rather than retaining only a pointer
to `messages.json`. Backend ingestion is idempotent. A durable ingestion cursor
and startup scan reconcile messages persisted before a crash but not yet copied
into the router; message retention may not delete a source message until that
cursor has advanced past it.

## 7. Runner effect, parking, and local-only v1

The delivery-effect gate observes a structured wrapper acknowledgement after
the verified child process has accepted the complete payload on stdin. It does
not use first model output and does not assume a five-second model response.
`HAFLEET_RUNNER_ACK_MS` is set only after the launch spike measures Claude and
Codex cold starts; timeout after `started` settles `outcome_unknown`.
Failure before `takePayload` revokes the failed claim and returns the same
dispatch to `queued` with a durable availability timestamp. The backend retries
after `HAFLEET_RUNNER_LAUNCH_RETRY_MS` (default 5000 ms); it never cancels the
accepted input or asks the user to reconstruct it.

Approval parking keeps the process and all resource leases. Resource usage is
bounded by both approval TTL and `HAFLEET_MAX_PARKED_RUNNERS` (finite,
host-wide; proposed default 4). A separate `HAFLEET_MAX_LIVE_RUNNERS`
(proposed default 8) bounds all live local wrappers, and the parked limit must
remain lower so at least one slot is reserved for non-parked coordination and
read-only work. When the parked cap is full, a new approval request is failed
closed before it can become parked; no lease is relaxed.

V1 scheduling is local-only. An agent registered to a remote server is rejected
with `remote_runner_unsupported`; it is never silently routed through legacy
tmux. Remote mirror files may change only when their existing byte-sync
invariant requires it—those mirrors do not constitute remote runner support.

## 8. Read side and authorization

The router emits events and snapshots, but backend endpoints enforce identity,
authorization, and privacy:

- `GET /api/router/snapshot` returns an authoritative snapshot plus schema
  version and high watermark.
- `GET /api/router/events?after=<seq>` returns change notifications. Events are
  invalidation/freshness signals, not a client-owned state reducer.
- A request below the retained low watermark returns `gap: true`; the client
  discards its view and re-snapshots.
- Event retention advances `low_watermark` in the same transaction that trims
  events.
- V1 endpoints require the existing backend bearer operator credential and are
  served only through the local Dashboard trust boundary.
- Snapshot construction applies audience scoping before serialization. It
  excludes owner-DM approval content, secrets, message bodies not needed by the
  view, and absolute local paths, following ADR-009.

There is no claim that Robrix2 can call these endpoints yet. A separate accepted
authentication contract is required before a Matrix client receives router
snapshots or mutations. Approval/deny continues through the authenticated
Matrix verdict flow, never through a bridge or backend bearer secret embedded
in Robrix2.

## 9. Build order

1. Use the verified Codex App Server approval protocol and pinned dependency
   set recorded by the accepted ADR/REQ.
2. Add schema/migrations, strict types, architecture checks, and migrate the
   existing task store behind unchanged `/api/tasks` behavior.
3. Add immutable input ingestion and reconciliation.
4. Add task intent plus the bridge Matrix outbox/receipt protocol.
5. Add dispatch capability, claim/settlement transactions, fencing, and local
   runner wrapper.
6. Add resources, worktrees, approval decision inbox, parking limits, and
   restart reconciliation.
7. Add privacy-filtered snapshot/event endpoints.
8. After task-store cutover, wire only session ingestion/dispatch behind
   `HAFLEET_THREAD_SESSIONS`, default off; run shadow mode, then one
   local-agent canary, before any broader enablement. Turning this switch off
   restores legacy delivery but does not switch the task writer back to JSON.

No stage ships merely because its bookkeeping tests pass. The black-box
acceptance suite must prove actual Matrix placement, process isolation,
post-exit inertness, no automatic re-execution, and workspace exclusion.
