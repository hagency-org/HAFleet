spec: task
name: "Backend-owned Thread Sessions with Ephemeral Runners"
inherits: project
tags: [sessions, matrix-thread, isolation, runner, scheduler, approval]
satisfies: [REQ-THREAD-SCOPED-SESSIONS, ADR-011]
estimate: 4w
---

## Intent

Replace the rejected tmux-window session prototype with backend-owned topic
sessions identified by `(stable agent id, room id, scope kind, thread root)`.
Each turn runs through a capability-authenticated one-shot local runner whose
context comes only from durable session inputs. The backend computes reply
routing, scopes MCP inbox reads, fences late output, and never automatically
re-executes a started dispatch.

The task also removes three false boundaries from the earlier draft:

- Matrix sends and approval consumption are separate durable systems connected
  by idempotent outbox/inbox reconciliation, not one SQLite transaction.
- The router migrates and extends the existing task store instead of creating a
  second task truth.
- V1 is explicitly local-only; remote and Octos agents fail visibly.

## Constraints

### Must

**Activation gate.**

This is an accepted implementation contract. No implementation stage may start
until all of these pre-implementation spikes have passed and been recorded in
`docs/THREAD-SESSIONS.md`:

- a real short-lived `codex app-server --stdio` turn emits a server-initiated
  approval request, accepts a client verdict, and completes the protected
  operation without an interactive TUI or trust bypass;
- the Codex adapter binds upstream thread, turn, item, request, and operation
  identity to the router dispatch before forwarding an owner verdict;
- pinned `better-sqlite3`, `typescript`, `@types/node`, and
  `@types/better-sqlite3` dependencies install and build in a clean Node 22
  checkout, WAL restart recovery passes, and remote packaging is still
  deterministic;
- measured Claude and Codex wrapper cold starts establish
  `HAFLEET_RUNNER_ACK_MS`; first model output is not the acknowledgement.

Failure of a spike returns the ADR/REQ to design. It must not be hidden by a
JSON fallback, experimental `node:sqlite`, a trust bypass, or a longer
unmeasured timeout.

## Decisions

- The router runs in the backend process and is the sole writer of
  `data/router.db`. Source lives in `router/src`, checked-in production ESM in
  `router/dist`, and all external imports go through `router/dist/index.js`.
- TypeScript is strict and prohibits unchecked brand construction, `any`, and
  double-assertion escape hatches. CI typechecks, enforces the module boundary,
  and byte-checks `dist` against a fresh temporary build.
- Sessions use opaque UUIDs. Partial unique indexes enforce one main session
  per `(agent_id, room_id)` and one thread session per
  `(agent_id, room_id, thread_root_event_id)`. Feature-enabled agents without a
  stable v1 manifest id fail closed.
- `router_messages` stores normalized immutable input, including trusted Matrix
  room/root metadata. An idempotent ingestion cursor and startup scan reconcile
  messages that reached the JSON message store before a crash.
- The existing `/api/tasks` model moves from `tasks.json` into the router
  repository through a resumable deployment cutover with count and canonical
  digest verification. API shapes and lifecycle semantics stay compatible.
  The service has one writer; rollback is an offline reverse export, not
  runtime dual-write. Existing tasks remain valid but cannot execute until
  they receive a confirmed task-thread binding.
- Task workflow state and thread activation state are distinct. Task creation
  uses a caller request key plus payload digest; the same key and digest replays
  the original result, while changed content is an idempotency conflict.
- `attach_task_inputs(task_id, input_message_ids, request_key)` is a separate
  idempotent operation. A message may be input to more than one task.
- One stable assignee may own only one task binding for a Matrix room/thread
  root. Multiple tasks derived from one source root require distinct assignees;
  the router rejects a second same-assignee binding so follow-ups cannot resolve
  arbitrarily.
- The task intent stores the human source Matrix event as
  `thread_root_event_id`. The agent reply returned by Matrix is
  `thread_anchor_event_id`; it confirms delivery but never replaces the root.
- `create_task` atomically records the existing task, pending execution binding,
  immutable inputs, and Matrix outbox command. It does not call Matrix inside a
  SQLite transaction.
- The bridge claims task-thread outbox commands through bridge-secret endpoints,
  sends an explicit `m.thread` relation with a stable Matrix transaction id,
  journals the event using ADR-007's recovery pattern, and acknowledges it.
  Router acknowledgement activates the binding/session and task inputs in one
  transaction. Replay cannot duplicate the Matrix event.
- Work reaches a coding runner only with a standard `task_id`, active execution
  binding, confirmed root and anchor, and local supported agent. An ordinary
  coordinator message is not a task credential.
- `/task` bypasses model judgement and uses the authenticated source event as
  its request key. A main-timeline mention of a worker follows the same task
  intent/outbox path. Work never executes in a worker main session.
- Main sessions are bounded front desks. Their identity persists while rolling
  summaries, pinned agreements, recent inputs, and coordinator global digests
  rotate under `HAFLEET_REBUILD_TOKEN_BUDGET`.
- Batching changes launch count only. Every input keeps its own identity and
  order, and messages arriving during a dispatch form the next batch.
- Reply routing is read from the dispatch/session record. Runner input and
  output schemas contain no room, thread, or reply-target field.
- `check_inbox` and every runner MCP read require the dispatch capability and
  answer only from that session's projection.
- Claiming a dispatch, incrementing its durable fence generation, issuing the
  hashed short-lived capability, and taking all required resource leases are
  one router transaction. There is no separate public lease call.
- `takePayload` commits `leased → started` and returns the immutable payload to
  that capability. If the committed response is lost, reconciliation treats it
  as started and ambiguous; it is never automatically replayed.
- The wrapper acknowledges delivery only after the verified child accepted the
  complete stdin payload. Missing acknowledgement before the measured timeout
  (`HAFLEET_RUNNER_ACK_MS`, default 60000) settles `outcome_unknown` as
  stalled delivery.
- A short-lived guardian owns each actual Claude/Codex process tree. Backend
  shutdown first stops new pump work, then aborts and awaits every guardian;
  IPC ownership loss after a hard backend exit terminates the runtime tree.
- Dispatch terminal states are `completed`, `cancelled_before_start`, and
  `outcome_unknown`. Every non-completion after `started` is
  `outcome_unknown`; there is no generic clean `interrupted` state.
- Settlement, capability revocation, ephemeral lease release, and persistent
  workspace-dirty update are one transaction. Dirty belongs to a resource or
  worktree, not to the released lease, and only authenticated inspection can
  clear it.
- Workspace mode is `shared` or `worktree`, default `shared`. Shared mode has
  one writer lease. Worktree mode creates a branch/worktree per thread so
  independent writers may run concurrently when the live-runner cap permits.
- Runner workspace configuration is operator-owned. Worktree preparation runs
  in a separate helper with an explicit non-secret environment so bootstrap
  cost cannot block the backend loop and bootstrap code cannot inherit backend
  credentials. Dirty failure quarantine survives bootstrap configuration drift.
- Worktrees are never auto-merged, auto-deleted, or discarded while dirty, and
  removal never deletes the branch. Ports, databases, and caches require named
  resource leases because git does not isolate them.
- Approval consumption remains authoritative in `lib/approval-store.js`. A
  consumed verdict emits a stable, dispatch-bound decision event; the router
  must apply it idempotently before allow reaches the runner. Failure withholds
  allow and restart reconciliation replays the event.
- A runner parked for approval stays alive and keeps all leases. Both
  `HAFLEET_MAX_LIVE_RUNNERS` and `HAFLEET_MAX_PARKED_RUNNERS` are finite
  host-wide limits, and the parked limit stays below the live limit to reserve
  non-parked capacity. A full parked cap fails a new approval request closed
  before parking and never relaxes an existing lease.
- Router snapshots are bearer-authenticated, privacy-filtered local Dashboard
  views. Events are versioned invalidation signals with transactional
  low/high watermarks; clients re-snapshot on a gap. Absolute paths and
  owner-private approval data are never serialized.
- `HAFLEET_THREAD_SESSIONS` defaults off and gates session ingestion and
  dispatch only. Off restores legacy delivery but never switches the already
  migrated task writer back to JSON.
- Octos and remote-registered agents are rejected visibly from this path.

## Boundaries

### Allowed Changes

- router/src/**
- router/dist/**
- tsconfig*.json
- package*.json
- scripts/check-router-build.sh
- scripts/check-router-boundary.js
- scripts/check-architecture-boundaries.js
- scripts/architecture-boundaries.json
- scripts/verify-ci.sh
- backend-v2.js
- bridge-matrix.js
- lib/task-store.js
- lib/approval-store.js
- lib/runtime-approval-client.js
- lib/mcp-server-core.js
- lib/push-relay-core.js
- mcp-server.js
- push-relay.js
- remote/lib/mcp-server-core.js
- remote/lib/runtime-approval-client.js
- remote/lib/push-relay-core.js
- remote/mcp-server.js
- remote/push-relay.js
- tests/router-*.test.js
- tests/fixtures/fake-claude-runner.mjs
- tests/fixtures/fake-codex-app-server.mjs
- tests/api-tasks.test.js
- tests/api-messages.test.js
- tests/api-approvals.test.js
- tests/approval-store.test.js
- tests/bridge-matrix.test.js
- tests/mcp-permission-channel.test.js
- docs/THREAD-SESSIONS.md

### Forbidden

- Do not implement before the activation gate passes and the ADR/REQ are
  Accepted.
- Do not use tmux window, pane, process title, or runtime conversation id as a
  session identity or routing truth source.
- Do not interpolate message-derived text into shell command lines or argv.
- Do not create a second task API/store or leave JSON and SQLite as concurrent
  task writers.
- Do not claim Matrix send or approval-store mutation is atomic with SQLite.
- Do not weaken approval sender, owner, digest, room, expiry, or consume-once
  validation; approval schema changes are limited to dispatch binding and
  replayable decision-event delivery.
- Do not expose router bearer/bridge secrets to Robrix2 or treat Robrix2 as an
  authorization authority.
- Do not expose absolute workspace paths or owner-private approval data in the
  router projection.
- Do not add dependencies other than pinned `better-sqlite3`, `typescript`,
  `@types/node`, and `@types/better-sqlite3` for this contract.
- Do not import Node's experimental built-in SQLite adapter or use a silent
  JSON fallback; production router storage is pinned `better-sqlite3` only.
- Do not dispatch through remote or Octos legacy paths when the feature is on.
- Do not let local MCP/push-relay cores drift from their required remote byte
  mirrors; mirror changes preserve packaging only and do not enable remote
  runners.

## Acceptance Criteria

<!-- lint-ack: bdd-rule-grouping — flat structure keeps each security invariant independently selectable -->
<!-- lint-ack: output-mode-coverage — durable output and real delivery effects are covered by migration, outbox, process, and recovery scenarios -->

Scenario: Stable agent identity prevents same-thread collision
  Test: test_same_matrix_thread_has_distinct_sessions_per_agent_id
  Given two agents addressed in the same Matrix room and thread
  When the router resolves their sessions
  Then two opaque session ids exist
  And their rows differ by stable agent id

Scenario: A main session cannot duplicate through a null root
  Test: test_partial_unique_index_allows_one_main_session_per_agent_room
  Given one main session already exists for an agent and room
  When the same main session is created again
  Then the original session id is returned
  And no second null-root row exists

Scenario: Existing tasks migrate once and retain API behavior
  Test: test_task_json_migration_is_resumable_and_api_compatible
  Given legacy tasks.json contains tasks in each supported workflow state
  When router task migration is interrupted and restarted
  Then every legacy task exists exactly once in SQLite
  And existing GET and transition API responses retain their contract
  And tasks.json is no longer written after cutover

Scenario: A legacy task is not accidentally executable
  Test: test_legacy_task_without_thread_binding_is_not_dispatchable
  Given a migrated legacy task without an execution binding
  When dispatch is requested for it
  Then dispatch is refused with missing_task_binding
  And no runner launches

Scenario: One front-desk batch may create multiple independently keyed tasks
  Test: test_front_desk_batch_creates_independently_keyed_tasks
  Given three consecutive front-desk inputs where one contributes to two tasks
  When the coordinator makes two create_task calls with distinct tool-call ids and assignees
  Then two standard task records and pending bindings exist
  And the shared input is attached to both tasks without collision
  And a third task for either existing assignee on the same root is refused

Scenario: Reusing a task request key with changed content is refused
  Test: test_task_idempotency_key_rejects_payload_change
  Given a task intent exists for one creator request key and payload digest
  When the same key is used with a different assignee or title
  Then creation fails with idempotency_conflict
  And the original task is unchanged

Scenario: Supplementary task input attaches idempotently
  Test: test_task_input_attachment_has_independent_idempotency
  Given an active task and a later message in its thread
  When attach_task_inputs is repeated with the same request key and digest
  Then the input is attached once
  And the task root is unchanged

Scenario: Task intent and Matrix outbox are one transaction
  Test: test_task_intent_rolls_back_with_matrix_outbox_write_failure
  Given the router cannot persist the Matrix outbox command
  When create_task is called
  Then no task, binding, task input, or outbox row commits

Scenario: Task thread uses the human event as root
  Test: test_task_thread_command_distinguishes_root_and_anchor
  Given a top-level human event creates a task intent
  When the bridge sends its acknowledgement
  Then the outgoing relation is m.thread rooted at the human event
  And the returned agent event is stored separately as thread_anchor_event_id

Scenario: Lost Matrix acknowledgement replays without duplicate event
  Test: test_matrix_outbox_replay_reuses_transaction_id
  Given Matrix accepted a thread acknowledgement but backend acknowledgement was lost
  When the bridge replays the claimed outbox command after restart
  Then it uses the original Matrix transaction id
  And activation records the original event exactly once

Scenario: Matrix failure leaves the task non-dispatchable
  Test: test_task_activation_fails_closed_on_thread_send_failure
  Given Matrix permanently rejects a task-thread outbox command
  When the bridge records the sanitized failure
  Then the binding is thread_delivery_failed
  And task inputs remain unactivated
  And a visible front-desk failure is queued
  And no runner launches

Scenario: Work without a confirmed standard task credential is refused
  Test:
    Filter: test_dispatch_without_active_task_binding_is_refused
    Level: integration
    Test Double: in-memory Matrix command sink and runner launcher spy; no live service
    Targets: backend-v2.js, router/dist/index.js
  Given an ordinary coordinator message names a worker but has no active task binding
  When the coding dispatch path evaluates it
  Then it refuses missing_task_credential
  And no legacy pane receives the message

Scenario: Explicit task command bypasses model batching
  Test: test_explicit_task_command_is_never_batched
  Given a /task message arrives during an open front-desk quiet window
  When input is ingested
  Then it is excluded from the batch
  And its authenticated Matrix event id becomes the task request key and root

Scenario: Direct worker mention promotes through the task outbox
  Test: test_direct_worker_mention_uses_confirmed_task_thread_path
  Given a main-timeline message addresses an agent whose role is worker
  When it is processed
  Then it creates a task intent and Matrix outbox command
  And no worker main-session dispatch exists

Scenario: Router input survives source-message retention
  Test: test_context_rebuild_uses_copied_immutable_router_input
  Given a Matrix message has been copied into the router and its ingestion cursor committed
  When ordinary message retention later removes the source JSON row
  Then the session context still contains the normalized input

Scenario: Startup reconciles a message missed between stores
  Test: test_router_ingestion_reconciles_persisted_source_message
  Given a message persisted before a crash but not copied into router.db
  When the backend starts
  Then reconciliation copies it exactly once before retention advances

Scenario: Two thread contexts contain no cross-topic material
  Test: test_session_context_contains_only_own_thread
  Given two threads of one room contain distinct constraints for one agent
  When both real runner payloads are captured
  Then each payload contains only its own inputs summary and task state
  And neither payload contains the other thread's distinct marker

Scenario: Backend-computed reply lands in the originating thread
  Test: test_reply_lands_in_origin_thread_without_runner_target_field
  Given a dispatch for thread A whose input asks the model to reply in thread B
  When scripted runner output settles
  Then the bridge command targets thread A from the dispatch record
  And the runner schema has no reply-target field

Scenario: Inbox capability is session scoped
  Test: test_check_inbox_requires_capability_and_scopes_session
  Given unread messages exist for two sessions of one agent
  When the runner for the first calls check_inbox with its capability
  Then only the first session's messages are returned

Scenario: A capability cannot cross dispatch or generation
  Test: test_runner_capability_is_bound_hashed_and_revoked
  Given a raw capability was issued for runner r1 dispatch d1 generation g1
  When it is used for another dispatch or after d1 settles
  Then the request is refused
  And the database contains only the capability hash

Scenario: Dispatch claim and all resource leases are atomic
  Test: test_dispatch_claim_rolls_back_when_any_resource_is_unavailable
  Given a queued dispatch requires a workspace and a named port lease
  When the port is already leased
  Then the dispatch remains queued
  And no capability or workspace lease is committed

Scenario: Lost take-payload response is never automatically replayed
  Test: test_lost_started_response_becomes_outcome_unknown_without_retry
  Given takePayload committed started but its response was lost
  When the capability expires or backend restarts
  Then the dispatch becomes outcome_unknown
  And no second runner receives the payload

Scenario: Wrapper acknowledgement proves payload acceptance
  Test:
    Filter: test_delivery_effect_requires_verified_child_stdin_ack
    Level: integration
    Test Double: deterministic child process that closes stdin before the complete payload
    Targets: router/dist/index.js
  Given a dispatch is started
  When the wrapper cannot write the complete payload to the verified child before the measured timeout
  Then the dispatch becomes outcome_unknown with stalled_delivery
  And first stdout or model text is not accepted as the acknowledgement

Scenario: Post-exit metacharacters remain inert data
  Test: test_post_exit_message_with_shell_metachars_executes_nothing
  Given a session whose one-shot runner exited
  When a later message contains shell metacharacters and a file-creation command
  Then no shell or terminal receives the text
  And the marker file does not exist
  And the input waits durably for another dispatch

Scenario: A killed started runner is not automatically redone
  Test: test_killed_runner_settles_outcome_unknown_without_auto_retry
  Given a runner is killed after editing its workspace
  When its lease expires
  Then the dispatch becomes outcome_unknown
  And a sanitized inspection notice is queued in its thread
  And no second runner launches for that dispatch

Scenario: Backend ownership loss terminates the runtime process tree
  Test: runner guardian terminates its runtime when backend ownership disappears
  Given a one-shot runtime is alive under its backend-owned guardian
  When the guardian loses its backend IPC owner
  Then the runtime process exits
  And no orphan remains able to modify the workspace

Scenario: A runner that died before start is safely re-leased
  Test: test_leased_but_unstarted_dispatch_is_requeued
  Given a wrapper dies before takePayload commits started
  When its claim expires
  Then its capability and leases are revoked
  And the dispatch returns to queued

Scenario: Settlement releases ownership but preserves dirty state
  Test: test_outcome_unknown_releases_lease_and_preserves_resource_dirty
  Given a started writer settles outcome_unknown
  When settleAndRelease commits
  Then no resource lease remains for the dispatch
  And the workspace resource remains dirty
  And an unauthenticated clear attempt is refused

Scenario: Shared mode visibly queues another writer during approval
  Test: test_shared_mode_parked_approval_queues_other_writer
  Given one shared-workspace dispatch is parked for owner approval
  When another thread requests the same writer lease
  Then the second dispatch remains queued
  And its thread receives a waiting-for-approval status

Scenario: Worktree mode allows genuinely isolated writers
  Test: test_worktree_mode_runs_two_threads_in_distinct_worktrees
  Given two thread sessions use worktree mode and live-runner capacity is available
  When both request writing dispatches
  Then both runners execute concurrently in different canonical directories
  And each holds only its own workspace lease

Scenario: Worktree bootstrap is operator-owned and secret-free
  Test: runner workspace configuration requires operator authority
  Given an agent token attempts to set runner workspace or bootstrap configuration
  When the agent registration API validates the request
  Then it refuses the change without an operator bearer token
  And an operator bearer can apply the configuration

Scenario: Worktree bootstrap cannot inherit backend credentials
  Test: worktree bootstrap does not inherit backend credentials
  Given the backend environment contains an operator credential
  When an authorized worktree bootstrap runs in its preparation helper
  Then the bootstrap process and its parent helper do not contain that credential

Scenario: Dirty worktree survives eviction
  Test:
    Filter: test_dirty_worktree_retained_on_session_eviction
    Level: integration
    Test Double: temporary local git repository; no remote provider
    Targets: router/dist/index.js
  Given a thread worktree has uncommitted changes
  When its session is evicted
  Then the checkout and branch still exist
  And the safe read projection reports dirty without an absolute path

Scenario: Named resources remain exclusive across worktrees
  Test: test_worktrees_still_contend_for_named_port_lease
  Given two worktree dispatches require the same named port
  When both become runnable
  Then only one claims the port
  And the other remains queued despite separate directories

Scenario: Approval allow is withheld across the JSON-SQLite failure window
  Test: test_consumed_approval_is_not_delivered_before_router_application
  Given the approval store consumed an allow decision and router application fails
  When the runner polls for the verdict
  Then no allow is returned
  And the decision event remains replayable

Scenario: Approval replay stays bound to the original dispatch
  Test: test_approval_decision_event_reconciles_idempotently
  Given a consumed decision event is bound to dispatch d1 and input digest h1
  When startup reconciliation applies it twice and d2 is current
  Then it is recorded once for d1
  And it authorizes neither d2 nor different input

Scenario: Parked cap fails closed without relaxing leases
  Test: test_parked_runner_cap_denies_new_park_request
  Given HAFLEET_MAX_PARKED_RUNNERS is full
  When another runner requests owner approval
  Then the request is denied before it enters parked state
  And no existing workspace lease is released or transferred

Scenario: Parked runners cannot consume all live capacity
  Test: test_parked_cap_reserves_live_slot_for_non_writing_dispatch
  Given the parked-runner cap is full and remains below the live-runner cap
  When a non-writing coordinator dispatch becomes runnable
  Then that dispatch claims the reserved live capacity and completes
  And all parked writers retain their leases

Scenario: Restart makes unverifiable started work outcome unknown
  Test: test_restart_reconciles_started_dispatch_to_outcome_unknown
  Given a persisted started dispatch has no verifiable live wrapper
  When the backend starts
  Then it becomes outcome_unknown with a thread notice
  And no runner is launched to resume it

Scenario: Durable fencing rejects late output after restart
  Test: test_fencing_generation_survives_restart
  Given a capability for an older fence generation survives outside the process
  When it submits output after backend restart
  Then the output is recorded as fenced display-only evidence
  And no current dispatch settles

Scenario: Router event trimming exposes a detectable gap
  Test: test_router_event_gap_uses_transactional_low_watermark
  Given an authorized client cursor predates retained events
  When it requests events after that cursor
  Then the response reports gap true with the current schema version
  And the client must obtain a new snapshot

Scenario: Router projection protects local and approval-private data
  Test:
    Filter: test_router_snapshot_excludes_paths_and_owner_private_approval_data
    Level: integration
    Test Double: temporary router and approval stores with synthetic private records
    Targets: backend-v2.js, router/dist/index.js
  Given worktrees and owner-DM approvals exist
  When an authorized local Dashboard snapshot is built
  Then it contains safe workspace labels and attention counts
  And it contains no absolute path secret message body or actionable private approval

Scenario: A remote agent is rejected without legacy fallback
  Test:
    Filter: test_remote_agent_rejected_from_thread_session_dispatch
    Level: integration
    Test Double: registered remote agent plus tmux and remote-push spies
    Targets: backend-v2.js, router/dist/index.js
  Given an agent is registered to a remote server
  When a thread-session dispatch is attempted
  Then it fails with remote_runner_unsupported
  And no tmux or remote push path is invoked

Scenario: Octos remains visibly unsupported
  Test: test_octos_agent_rejected_from_thread_session_dispatch
  Given an Octos agent
  When a thread-session dispatch is attempted
  Then it fails with a visible unsupported-framework result
  And no long-lived proxy or runner launches

Scenario: Kill switch off preserves legacy delivery after task-store cutover
  Test:
    Filter: test_kill_switch_off_uses_legacy_delivery_after_task_store_cutover
    Level: integration
    Test Double: isolated runtime directory and legacy delivery recorder
    Targets: backend-v2.js, lib/task-store.js
  Given task storage has cut over to SQLite and HAFLEET_THREAD_SESSIONS is unset
  When a thread message and task API request are processed
  Then message delivery follows the pre-contract path
  And the task API writes only SQLite through its existing contract
  And no router session or dispatch row is created

Scenario: Router build artifacts must be fresh and isolated
  Test: test_router_build_check_detects_stale_or_internal_import
  Given router source differs from checked-in dist or backend imports a router internal module
  When CI verification runs
  Then verification fails before tests are accepted

Scenario: Router typecheck rejects prohibited escape hatches
  Test: test_router_typecheck_rejects_any_and_unchecked_brand_construction
  Given a fixture uses any or an exported unchecked brand constructor in router source
  When tsc --noEmit and the router architecture check run
  Then verification exits nonzero with the prohibited construct identified

Scenario: Approved dependencies install and recover WAL in an isolated Node checkout
  Test:
    Filter: test_router_dependency_spike_installs_and_recovers_wal
    Level: integration
    Test Double: temporary clean package directory and temporary SQLite database
    Targets: package.json, package-lock.json, router/dist/index.js
  Given the pinned better-sqlite3 TypeScript and Node/SQLite declaration packages on supported Node 22
  When npm ci builds the router and a process restarts after a committed WAL transaction
  Then npm ci and npm run build:router each exit with code 0
  And the committed row is present after restart
  And no node:sqlite or JSON fallback is loaded

## Out of Scope

- Accepting ADR-011 or REQ-THREAD-SCOPED-SESSIONS; governance approval remains
  an operator decision.
- Remote runner execution or cross-machine session migration.
- Octos runner adaptation.
- Robrix2 router snapshots, authentication, or operation-panel mutations.
- Automatic worktree merge, deletion, branch deletion, or dirty cleanup.
- Treating worktrees as isolation for ports, databases, caches, credentials, or
  other non-git resources.
- Automatic retry of any dispatch that reached started.
