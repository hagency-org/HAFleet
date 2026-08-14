---
kind: decision
id: ADR-011
title: "Backend-owned thread sessions executed by ephemeral one-shot runners"
status: Accepted
liveness: auto
tags: [sessions, matrix, threads, runtime, runner, scheduler, approval]
---

## Context

ADR-010's hibernating per-thread window model was prototyped and rejected:
every observed failure (post-exit text injection, hibernation/draft races,
unreliable resume-id capture, config-drift relaunches, model-filled reply
targets) traced to one root — authoritative session state living in a tmux
window the backend does not control. LEP-002 proposes inverting the model:
the backend owns sessions; runtimes become disposable per-dispatch workers.

## Decision

The backend store is the sole owner of topic sessions. A session has an opaque
id and a natural identity of `(stable agent id, room id, scope kind, thread
root)`: `scope kind = main` has no root, while `scope kind = thread` requires
the authenticated Matrix root event id. The stable agent id comes from the v1
home manifest; a mutable display name and delimiter-concatenated key are not
identities. A session record holds durable state only: copied normalized
inputs, a rolling summary, task state, and dispatch ledger entries. No
terminal, window, or process identity is ever authoritative.

**Runners.** Each dispatched message executes in a fresh one-shot headless
runner (`claude -p`, or one ephemeral Codex App Server thread and turn in a
short-lived `codex app-server --stdio` process) whose working context is rebuilt
from durable artifacts. Message content reaches the runner as data via
stdin or a file; it is never interpolated into a shell command line or argv.
When the runner exits, the dispatch settles from its captured output; late
output from a superseded runner is fenced by the ledger and cannot settle
anything. Context rebuild is a first-class concern: each rebuild has a token
budget (`AGENTCHAT_REBUILD_TOKEN_BUDGET`) and a continuity obligation — an
agreement stated in an earlier turn of the same session must survive into
later rebuilt turns.

**Front desk versus task.** A room's untreaded main timeline is one `main`
scope session per agent — a front desk, not a workshop. The backend
does not infer which main-timeline message is a new task; inference is the
model's job and guessing wrong is worse than not guessing. What the backend
enforces instead is a credential: **work reaches the coding execution layer
only with a `task_id` and a real `thread_root`, and a dispatch lacking either
is refused.** A coordinator therefore cannot smuggle work to a worker through
an ordinary message; the only path is the structured `create_task` tool.

`create_task` names its root and supplementary input messages, so one batch may
produce zero, one, or several tasks, one message may contribute to several
tasks, and a later main-timeline message may be attached through a separate
idempotent operation. Because follow-up routing is keyed by assignee and Matrix
root rather than by a model-selected task id, one assignee may own at most one
task binding for a given room/root. Multiple tasks derived from one source root
must therefore have distinct assignees; a second task for the same assignee and
root is rejected instead of being routed arbitrarily. The **thread root is the user's own originating Matrix
event**, known before task creation. The agent acknowledgement returned by
Matrix is a separate `thread_anchor_event_id`; it is proof that the thread
reply was sent, not the root itself.

Activation crosses Matrix through a durable outbox, not a database fiction.
One router transaction records the existing task record, its pending execution
binding, immutable inputs, and an idempotent Matrix command. The bridge sends
an `m.thread` relation rooted at the human event with a stable Matrix
transaction id, journals the result, and acknowledges the command. A second
router transaction records the anchor event and activates the task/session.
If sending fails, the binding becomes `thread_delivery_failed`, the inputs stay
unactivated, and the front desk gets a visible failure. Reconciliation may
replay the same command without creating a second Matrix event.

Task creation is idempotent on a caller request key — coordinator dispatch plus
tool-call id, originating Matrix event for `/task`, or an explicit operator
key — and stores a canonical payload digest. Reusing the key with the same
digest returns the original task; different content is a conflict. Input
attachment has its own request key. It is not keyed by the input set, because
that would forbid later attachment and multiple tasks derived from one human
message.

A human who wants certainty bypasses model judgment with an explicit `/task`
(or the client's create-task action), which the backend turns into a task
directly. Explicit `/task` messages are never batched with anything else.

Addressing a coding worker directly in the main timeline is auto-promoted to
a task thread rooted at that message. This is not the backend inferring
semantics from content — it is a structural rule about which agent was
addressed — and a request that turns out to be a mere question simply
completes immediately. Work is never executed in a worker's `main` session.

**Front-desk context is bounded.** The `main` session's logical identity is
permanent; its LLM context is not. The backend keeps fixed room facts,
confirmed standing agreements, a rolling summary, recent messages, and an
index of active tasks; when the budget is exceeded a new context generation
begins. Identity survives, unbounded transcript does not.

**Batching is a performance optimization only.** Consecutive front-desk
messages may be merged into one dispatch behind a short quiet window, and
messages arriving while a runner works form the next batch. Each message
keeps its own id, order, and processing state; batching never implies the
batch is one task. V1 does not retain a warm model process between dispatches;
that optimization would need a later contract proving that it preserves the
same isolation and capability boundaries.

**Reply routing.** The backend computes reply addressing from the dispatch
record. The runner-facing protocol carries no reply-target field, so a wrong
`reply_to` is unrepresentable. MCP reads (`check_inbox` and related tools)
are scoped to the dispatching session.

**Workspace is the scheduling resource.** A runner that may write files must
hold its working directory's exclusive lease for its whole life, including
while parked on an approval. Two writing runners never share a directory.
Concurrency is therefore bounded by workspace leases, not by session count:
sessions that hold no workspace lease (coordination, reads, summaries) are
not charged against the writer budget and keep flowing. A finite host-wide
live-runner cap still bounds processes; worktree mode may use more than one
slot when independent leases and capacity are available.

**Workspace mode is per agent.** Each agent declares
`workspace_mode: shared | worktree`, defaulting to `shared`.

- `shared`: all of the agent's sessions contend for one exclusive lease on
  the agent's working directory. Simple and cheap, but writing topics
  serialize — including behind an approval wait.
- `worktree`: each thread session owns a git worktree at
  `<worktrees_dir>/<agent>/<thread-slug>` on branch
  `agentchat/<agent>/<thread-slug>`, created on the session's first dispatch
  and initialized by the agent's declared `worktree_bootstrap` command (for
  dependencies and untracked config that git does not carry). The lease is
  per worktree, so writing topics run in parallel and an approval wait in one
  topic does not stall the others.

Runner workspace paths, modes, worktree roots, and bootstrap argv are
operator-owned configuration. Worktree creation and bootstrap run in a
separate helper process with an explicit non-secret environment, keeping both
bootstrap latency and backend/Matrix credentials outside the backend event
loop and bootstrap process tree. A dirty failed bootstrap remains quarantined
even if its configured argv later changes.

Git isolates tracked files only. Ports, databases, global caches, and other
machine resources are NOT isolated by a worktree; a dispatch needing one
exclusively must take a separate named lease for it. This limit is stated
rather than assumed, because assuming isolation that does not exist is the
mistake that produced the rejected prototype.

Worktree lifecycle is deliberately conservative: never auto-merge, never
auto-delete, never delete the branch, and never discard a dirty checkout. A
session whose worktree still holds uncommitted changes keeps that worktree
on eviction and reports it for a human to resolve — the same principle as
`outcome_unknown` below. Landing a thread's branch stays a human or PR
action, which matches how these agents already work (one task, one branch,
one review).

**Approval parking.** A runner blocked on an owner approval stays alive and
keeps its workspace lease. Under `worktree` that costs only its own topic;
under `shared` it stalls the agent's other writing topics until the human
decides, and that blocking is stated plainly rather than designed around.
Either way the queued topics receive a visible "waiting for approval" status
in their own threads, and the operator can cancel the parked dispatch.
Parked runners are bounded by the approval TTL plus transport margin, after
which the adapter fails closed to deny, the runner is terminated, and the
dispatch settles per the at-most-once rule below. Killing and later
restarting a parked runner was rejected: an approval authorizes a specific
operation proposed by that specific process, and a replacement process may
propose something different, so reusing the verdict would be a
time-of-check/time-of-use flaw.

They are also bounded by `AGENTCHAT_MAX_PARKED_RUNNERS` (finite and host-wide,
proposed default 4). If the cap is full, a new approval request fails closed
before the runner enters parked state. The cap is a resource safety control,
not an isolation mechanism, and never releases a workspace lease early. It
must remain below the live-runner cap (proposed default 8), reserving capacity
for non-parked coordination and read-only work.

**At-most-once after start.** A dispatch moves `queued → leased → started →
completed`; it may move `started ↔ parked`, and its other terminal states are
`cancelled_before_start` and `outcome_unknown`. Taking the payload commits the
`started` transition and returns it through a short-lived capability bound to
runner id, dispatch id, and durable fence generation. A lost response after
commit is the one acknowledged ambiguous window. A runner MUST NOT act without
the successful response, while the backend MUST NOT replay that started
dispatch.

Before `started`, cancellation or a dead runner produces a clean
`cancelled_before_start` or re-lease. After `started`, the dispatch is NEVER
re-executed automatically, and any terminal state other than `completed` —
crash, lease overrun, approval expiry, operator cancel — settles as
`outcome_unknown`, not merely "failed": the turn may already have edited
files, run commands, or committed. Settlement revokes the capability, releases
ephemeral lease ownership, and persists the workspace's independent
"may hold uncommitted changes" state in one router transaction. Only an
authenticated human action after inspection clears it. Code-writing side
effects are not idempotent; duplicate application is strictly worse than
asking once.

Every actual Claude/Codex runtime is owned by a short-lived guardian connected
to the backend over IPC. Graceful shutdown stops new scheduling, terminates and
awaits all guardians, then exits. If the backend disappears abruptly, guardian
ownership loss terminates the runtime process tree so restart quarantine is not
undermined by an orphan that continues writing.

**Restart reconciliation.** On backend start, every dispatch left in
`started` whose runner lease is expired or unverifiable becomes
`outcome_unknown` with the same operator notice. A restart never silently
resumes or re-executes in-flight work.

**Mechanisms adopted from herdr** (`borrow-proj/herdr`), which supervises
interactive agent processes and solved the process-truth layer that killed
the ADR-010 prototype:

- *Delivery-effect gate.* `started` asserted by the backend is not evidence the
  child accepted input. A structured wrapper acknowledges only after the
  verified child process has accepted the complete payload on stdin. The
  timeout is measured in a pre-implementation cold-start spike; it is not a
  fixed five-second proxy for first model output. Missing acknowledgement
  settles the already-started dispatch as `outcome_unknown`.
- *Fencing by identity plus a durable sequence.* Currency is decided by an
  identity match AND a monotonic sequence greater than the value captured at
  submission. herdr keeps that counter in memory, so it resets on restart and
  provides no cross-restart fencing; ours is persisted.
- *Authority separation.* Only the structured runner protocol may move
  dispatch state; model-authored text is display-only and can never change
  state or routing.
- *Pre-write process verification.* Before writing input to any interactive
  runner, verify the intended runtime still owns that process's input
  channel and refuse otherwise. v1 runners are headless, so this is not on
  the hot path — but it is the guard that would have prevented the prototype's
  post-exit injection, and it is required for any interactive or parked
  runner a human is later attached to.
- *Worktree removal policy*, for the later worktree phase: removal is always
  explicit, never automatic; it never deletes the branch; and a dirty
  checkout requires an explicit force. herdr's worktrees are a workspace
  layout feature with no isolation, scheduling, or merge semantics, so the
  concurrency design is ours to build.

**Coordinator visibility.** A coordinator session's rebuilt context always
begins with a backend-generated global digest (active topics and their
states); on-demand tools (`list_threads`, `read_thread_summary`) provide
depth. Passive visibility is not left to the model remembering to ask.

**Owner approval.** The runner model changes nothing about
REQ-OWNER-UI-APPROVAL: headless runners use supported approval adapters
(Claude MCP channel; Codex App Server's server-initiated command, file-change,
and permission approval requests), adapters remain mandatory, and adapter
startup failure aborts the dispatch. Codex `exec` is not used for this path:
it is a non-interactive automation surface and did not emit an approval request
in the spike. The App Server request carries thread, turn, and item identity;
agent-chat records and consumes the owner verdict before replying to that exact
request. This path does not install or mutate a per-dispatch hook, so it creates
no recurring TRUST prompt.
Approval consumption remains authoritative in the existing approval store.
Each consumed verdict produces a stable decision-event id bound to the
dispatch. The router applies that event idempotently before an allow reaches
the runner; a write or reconciliation failure withholds the allow and retries
the event rather than consuming authority silently.

**Octos is out of scope, decided now.** Octos approval runs through a
long-lived octos-tui → proxy → octos-serve pipeline that conflicts with
disposable runners. Octos agents are not servable by this model; dispatching
a thread-session workload to an octos agent is rejected visibly. This is a
scoping decision, not a deferred milestone.

**Remote execution is out of scope, decided now.** V1 runners execute only on
the backend host. A dispatch for an agent registered to another server is
rejected visibly as `remote_runner_unsupported`; it never falls through to the
legacy tmux path. A separate authenticated remote-runner protocol is required
before this can change.

**Implementation shape.** The router runs in the backend process and is the
sole writer of SQLite (WAL) state at `data/router.db`. Only router-owned changes
are one transaction: task intent plus its Matrix outbox, dispatch claim plus
capability/resource leases, and settlement plus lease release/persistent dirty
state. Matrix and the approval JSON store are separate durable systems; they
cross the boundary through stable idempotency keys, payload digests, durable
outbox/inbox events, and restart reconciliation. Failure produces no approval
allow and no dispatch activation. This is explicitly a fail-closed saga, not a
cross-store atomic transaction.

The router replaces the storage implementation behind the existing durable
task API instead of introducing a second task truth. `tasks.json` is imported
through a resumable one-time deployment cutover with count/digest verification,
existing `/api/tasks` semantics remain, and legacy tasks have no execution
credential until bound to a confirmed thread. Cutover is separate from the
thread-session kill switch: the service has exactly one task writer, and
rollback requires an offline reverse export rather than runtime dual-write or
writer switching. Session inputs are copied as normalized immutable records;
context rebuild does not depend on a reference that message retention may
delete.

The router is written in strict TypeScript and **compiled to JavaScript**; the
backend runs checked-in output and the production start command is unchanged.
The accepted implementation may add pinned `better-sqlite3`, `typescript`,
`@types/node`, and `@types/better-sqlite3` dependencies after a clean Node 22
install/build spike; it does not use experimental `node:sqlite`. CI typechecks,
rejects stale build output, enforces the public import boundary, and prohibits
brand-constructor or `any` escape hatches. Types prevent accidental category
errors but never substitute for runtime validation or authorization. Module
boundary, public commands, schema, and dependency rules are specified in
`docs/router-layer-design.md`.

Clients are read-only: an authoritative privacy-filtered snapshot plus a
persisted, versioned event feed with a transactional retention low watermark.
Events are invalidation signals; clients re-snapshot rather than deriving
domain state. V1 exposes this only inside the existing bearer-authenticated
local Dashboard boundary. It excludes absolute paths and owner-private
approval content under ADR-009. Robrix2 cannot call it until a separate client
authentication contract is Accepted, and approval actions continue through
authenticated Matrix verdict events rather than embedded backend secrets.

## Alternatives Considered

- **Patch the window model further**: every failure had a local fix, but all
  fixes re-anchor on the uncontrollable window; the class outlives any patch
  set.
- **Kill and restart runners across approval waits**: cleanest resource
  story, but the verdict authorizes an operation proposed by the process
  that is being killed; a replacement may propose something else, so the
  reused verdict is a time-of-check/time-of-use flaw. Also incompatible with
  at-most-once for turns that already produced side effects. Rejected.
- **Keep the parked runner alive but free its concurrency slot**: would let
  approval waits stop blocking, and was the first draft of this ADR.
  Rejected: freeing the slot while the parked runner still owns the working
  directory admits a second writer into it — isolation claimed but not
  enforced, which is precisely the defect that sank the prototype. Parallel
  writing is bought with per-thread worktrees, not by relaxing the lease.
- **Defer worktrees to a later phase and ship a knowingly blocking v1**:
  rejected. The blocking is the main cost of the whole design, `git worktree
  add` plus a bootstrap command is a small mechanism, and branch-per-thread
  matches the existing one-task-one-branch-one-PR workflow. Keeping `shared`
  as the default preserves the conservative path for repositories where a
  fresh checkout plus dependency install is expensive.
- **Make worktrees mandatory**: rejected. Bootstrap cost is real and varies
  per repository, so the choice belongs to the agent's configuration.
- **Auto-retry on runner death**: recovers silently from crashes, but risks
  double-applying code changes; rejected in favor of fail-visible.
- **Describe Matrix, approval JSON, and SQLite as one transaction**: impossible
  without migrating every participant into one database. Rejected in favor of
  idempotent durable outbox/inbox events and explicit reconciliation.
- **Add router-specific tasks beside the existing task store**: creates two
  task identities and lifecycle authorities. Rejected in favor of migrating the
  storage behind the existing API and adding an optional execution binding.
- **Keep a warm model process in v1**: reduces cold-start cost but reintroduces
  process-carried context and a larger approval/capability surface. Deferred to
  a separate contract after the one-shot model is proven.
- **Always-live pane per thread / prompt-discipline only**: rejected in
  LEP-001 and re-confirmed by the prototype outcome.

## Consequences

Good, because the window-dependency failure class is removed by
construction: identity, routing, isolation, and settlement are backend
ledger semantics.
Good, because failure is always visible in the originating thread rather
than silent, and non-writing sessions keep flowing during a writer's wait.
Good, because `worktree` mode removes head-of-line blocking between topics
without weakening any lease: parallelism is bought with real isolation.
Bad, because `shared` mode — the default — still serializes writing topics,
so one approval wait can stall the others for up to the approval TTL. That
is the price of not paying worktree bootstrap cost, and it is stated rather
than hidden.
Bad, because `worktree` mode trades that for per-thread bootstrap latency,
disk, and a growing set of branches and checkouts a human must eventually
land or discard.
Bad, because a worktree isolates tracked files only; ports, databases, and
global caches still need explicit named leases.
Bad, because a runner that dies after `started` leaves work in
`outcome_unknown` and needs a human to inspect the workspace; the system
deliberately refuses to guess.
Bad, because every turn pays cold start plus context rebuild; rebuild cost
and quality need measurable targets and will dominate perceived latency.
Bad, because octos agents are excluded until a dedicated adaptation exists.
Bad, because remote agents are excluded until a dedicated authenticated runner
protocol exists.
Bad, because a parked runner is still a live process; the parked cap and
approval TTL are the only things bounding that cost.

## Source Trace

- proposal: LEP-002
- supersedes: ADR-010
- knowledge/requirements/req-thread-scoped-agent-sessions.md
- specs/task-thread-scoped-agent-sessions.spec.md
