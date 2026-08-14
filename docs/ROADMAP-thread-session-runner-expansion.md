# Roadmap — Expanding thread-session runners to Octos and remote hosts

Status: Planned, non-normative  
Baseline: ADR-011 / REQ-THREAD-SCOPED-SESSIONS  
Last updated: 2026-08-12

## What this roadmap does and does not mean

The current branch contains a default-off implementation of disposable Claude
and Codex runners on the backend host. Its real-model continuity and canary
release gates are not yet complete. When the global thread-session switch is
enabled, it deliberately rejects Octos and agents registered to a remote
server:

- Octos returns `unsupported_framework`;
- a remote-registered agent returns `remote_runner_unsupported`;
- neither case may fall back to legacy tmux delivery.

This document records the work needed to change that safely. It does not amend
ADR-011, enable either runtime, or turn an exclusion into implied support. Each
track requires an accepted ADR, requirement, task contract, and black-box
evidence before the corresponding refusal can be narrowed. The new governance
must explicitly amend or supersede the relevant ADR-011 text and replace or
narrow `REQ-TSS-OCTOS-EXCLUDED` or `REQ-TSS-REMOTE-EXCLUDED`; adding a
contradictory requirement beside the existing MUST is not sufficient.

Existing long-lived Octos agents and existing remote-relay agents keep their
legacy behavior only on the non-thread-session path while the global feature is
disabled. If it is globally enabled, an Octos or remote thread-session dispatch
is rejected and never downgraded to legacy delivery. The current branch has no
per-agent thread-session allowlist, so a one-agent production canary requires
an isolated backend/traffic scope or a new per-agent kill switch first.

## Entry gates shared by both tracks

Protocol research and governance may begin immediately. Adapter implementation,
production canaries, and narrowing either refusal must wait until the local
baseline proves that the runner model itself is sound:

1. Complete the real-model context-continuity gate in `docs/THREAD-SESSIONS.md`:
   at least four of five three-turn conversations recover the first-turn
   agreement within the configured context budget.
2. Before any canary, close the local lifecycle gates: both frameworks must
   produce a child-originated structured acknowledgement after accepting the
   complete payload; a successful result must stop and confirm the guardian
   and all descendants before `completed` releases the workspace lease; an
   `outcome_unknown` quarantine cannot be resolved while a mutating descendant
   is still alive or unverifiable; detached descendants must not escape.
3. Add a per-agent allowlist/kill switch, or run the local Claude and Codex
   canaries on an isolated backend with isolated Matrix traffic. Exercise owner
   approval, process kill, backend restart, late-output fencing, and
   `outcome_unknown` recovery.
4. Freeze the corrected local runner protocol and failure vocabulary as
   versioned canonical fixtures so a new adapter cannot reinterpret `started`,
   `parked`, `completed`, `cancelled_before_start`, or `outcome_unknown`.
   Incompatible fixture changes require adapter reconformance and a new canary.
5. Extract a transport-neutral `RunnerControlPlane`/adapter/guardian contract
   from the current process-local Claude/Codex functions without changing their
   behavior. A local implementation may call `RouterStore`; a remote
   implementation must use the authenticated node protocol.
6. Keep every current fail-closed eligibility check enabled until the new
   adapter's release gate passes.

## Track A — Octos headless disposable runner

### Why the existing Octos integration cannot be reused directly

The current managed Octos runtime is an interactive, long-lived chain:

```text
octos-tui -> owner-approval proxy -> octos serve --stdio
```

It intentionally protects existing tmux agents, but its session lifecycle,
prompt injection, reconnect hydration, and approval ownership are coupled to a
persistent TUI. A thread-session runner instead needs one process tree per
dispatch, structured input, a verified input acknowledgement, dispatch-scoped
MCP, and deterministic teardown. Wrapping the existing TUI would reintroduce
the terminal and process-carried-context failure classes rejected by ADR-011.

Octos already exposes a stdio protocol, so the preferred direction is a new
headless adapter around `octos serve --stdio`, not terminal automation.

### O0 — Protocol and lifecycle spike

Record the exact `octos` and `octos-tui` revisions used by the spike, then
capture protocol fixtures for:

- opening a fresh server-selected or client-selected session without a TUI;
- submitting a complete turn as structured data;
- identifying an acknowledgement that the child accepted all input, without
  treating first model output as acknowledgement;
- normal completion, tool calls, cancellation, server error, EOF, and crash;
- every approval delivery form, including live notifications and hydrated
  `pending_approvals` results;
- child processes spawned for MCP or tools and how they are terminated;
- session, cache, plugin, skill, profile, and instance-state persistence roots.

Exit criterion: a repeatable non-production spike can start, run, approve only
a fixed no-side-effect test operation, complete, and kill an Octos turn without
`octos-tui`, tmux, or `send-keys`. Unknown or ambiguous protocol behavior is
documented as a blocker rather than guessed. O0 records observed versions; O1
decides which versions are supported.

### O1 — Governance contract

Create and accept an Octos runner ADR/REQ before implementation. It must define:

- which Octos versions and protocol schema are supported;
- one fresh Octos session and process tree per dispatch;
- how model/profile selection is pinned without ambient config overrides;
- the exact structured input-acceptance acknowledgement;
- how both approval paths are intercepted and bound to one router dispatch;
- how MCP reads are restricted to the dispatch session;
- how Octos-specific errors map to router terminal states;
- which process or protocol changes force the adapter to fail closed;
- per-dispatch isolation and cleanup/quarantine of Octos server-persisted state;
- an Octos-specific per-agent kill switch and rollback procedure.

The task contract must test observable effects, not merely that an Octos
session id or process record was created.

Exit criterion: the new ADR explicitly amends the Octos exclusion in ADR-011,
the new requirement explicitly narrows `REQ-TSS-OCTOS-EXCLUDED`, the task
contract binds every release behavior below, and all three are accepted before
the eligibility checks change. Failure leaves the current refusal unchanged.

### O2 — Headless adapter and guardian

First land the shared transport-neutral runner contract from the entry gates,
then implement an `OctosRunnerAdapter` behind it:

- spawn `octos serve --stdio` under the existing short-lived guardian;
- pass prompt/context as protocol data, never shell text or argv content;
- use an explicit environment allowlist and agent-chat-owned backend config;
- create a fresh session for each dispatch and never resume a TUI conversation;
- give each dispatch isolated data, instance, cache, config, and skills roots;
  discover no ambient plugin/skill, pin the executable/protocol digest, and
  prohibit dispatch-time auto-install or upgrade;
- bind every frame to the current dispatch capability and durable fence;
- return model text as display output only;
- stop and confirm the serve process, MCP children, and tool descendants before
  `completed` may settle and release a lease; clean the isolated state or keep
  it quarantined when safe deletion cannot be proved.

Exit criterion: killing the guardian leaves no Octos descendant and produces
the same `outcome_unknown` quarantine as a killed local Claude/Codex runner;
another dispatch cannot list, open, or read the prior dispatch's session or
state root. Failure keeps the adapter disabled for every agent.

### O3 — Owner approval and session-scoped MCP

Adapt the current Octos approval knowledge without retaining its TUI coupling:

- suppress both notification and hydration approval surfaces from any
  non-owner decision path;
- park the exact router dispatch and create one owner-DM approval request per
  Octos approval id, operation digest, and dispatch;
- consume the owner verdict, apply its stable decision-event idempotently to
  the Router, resume the exact parked operation, and only then send
  `approval/respond`;
- treat an explicit owner `deny` as a tool-operation denial that may resume the
  runner; before-start adapter failure aborts without starting, while Matrix,
  persistence, timeout, or transport failure after `started` terminates the
  runner and settles `outcome_unknown` instead of fabricating owner denial;
- deduplicate reconnect or replayed approval events;
- inject only the current dispatch capability into the managed MCP manifest;
- prove `check_inbox` cannot read another Matrix thread.

Exit criterion: no text, TUI key, replayed frame, or unrelated session can
approve an operation or read another session's inputs, and an infrastructure
failure cannot appear in the audit trail as an owner decision. Failure keeps
the adapter disabled.

### O4 — Compatibility and canary release

Add canonical Octos protocol fixtures and run:

- context-isolation tests across two Matrix threads;
- approval wait, deny, timeout, reconnect, and replay tests;
- config/profile override and hostile environment tests;
- crash before payload acceptance and crash after `started` tests;
- backend graceful shutdown and hard-kill orphan tests;
- backend-derived reply routing and late-output fencing tests;
- the same five independent three-turn continuity runs as the local gate, with
  at least four successful recoveries;
- one explicitly allowlisted Octos agent canary through a recorded observation
  window, with the adapter kill switch and rollback exercised.

Exit criterion: accepted governance, a pinned canonical protocol version, all
black-box and real-runtime evidence, an operator-approved canary, and rollback
evidence are recorded together. In that same change, backend eligibility,
Router enqueue, launch-descriptor, and tests are narrowed so only compatible,
allowlisted Octos runners pass; every other Octos dispatch retains the visible
refusal. Interactive Octos agents remain available only through their existing
non-thread-session path.

## Track B — Authenticated remote runner nodes

### Why the existing remote relay is insufficient

The current remote package is a client of the central backend. It receives SSE,
reports heartbeat, and injects notifications into tmux. It does not own the
router ledger and cannot prove that a particular disposable child accepted a
payload, retained a lease, stopped changing a workspace, or completed exactly
one dispatch.

Remote thread sessions therefore need a dedicated execution-node protocol.
Copying router files into `remote/`, forwarding the global `API_TOKEN`, or
typing work into a remote pane does not provide remote-runner support.

Terms in this track are fixed as follows: the **central backend/router** owns
the ledger; a **legacy remote server registration** and **legacy push relay**
describe today's SSE/tmux path; a future **execution node** is an
operator-enrolled host identity; and its **execution daemon** is the new local
supervisor. The central backend authoritatively binds and revokes an agent's
stable id to one enrolled node. A legacy registration is not that binding.

### R0 — Threat model and protocol decision

Create a separate remote-runner ADR/REQ covering at least:

- operator enrollment and revocation of a stable remote node identity;
- outbound-only connection establishment where possible;
- mutual proof of central server and node identity without the Dashboard or
  backend-wide bearer token, over encrypted transport with central identity
  pinning and transcript/channel binding;
- short-lived capabilities bound to node, agent, dispatch, fence, workspace,
  operation, and expiry;
- protocol version negotiation and fail-closed upgrade behavior;
- resource leases and dirty generations for workspaces on that node;
- network partitions before and after payload acceptance;
- owner approvals crossing the network without transferring approval authority;
- event replay, duplicated delivery, delayed output, node clock skew, and
  central or node restart;
- a central-signed, short execution lease that the node cannot extend itself
  and must enforce against a local monotonic deadline;
- an opaque pre-enrolled workspace/resource id mapping; no claim may supply an
  arbitrary path, argv, or environment;
- process privilege separation that prevents coding children from reading node
  identity keys, journals, or control sockets.

The preferred topology is a small execution daemon colocated with the agent.
Running a second full agent-chat server is not automatically federation. If a
full server is reused as a node, it must implement the same explicit node
contract and must not share SQLite files or exchange global API tokens.

Exit criterion: the accepted ADR amends ADR-011's remote exclusion, the
accepted requirement narrows `REQ-TSS-REMOTE-EXCLUDED`, and the threat model
fixes the `started`, partition, credential, workspace, approval, and revoke
semantics before a production daemon is written. Failure leaves
`remote_runner_unsupported` unchanged.

### R1 — Canonical remote-runner protocol

Publish versioned schemas and positive/negative signing vectors for:

- node enrollment, session establishment, rotation, and revoke;
- dispatch offer, claim, payload take, child-input acknowledgement, output,
  approval request/application, cancellation, and settlement;
- heartbeat carrying active guardian identities rather than only host liveness;
- restart reconciliation and workspace inspection status;
- stable error codes, frame/body/output limits, backpressure, sequence windows,
  log redaction, and protocol limits;
- dispatch-scoped MCP transport and proof vectors showing that another
  session's inbox cannot be read.

The central router remains the only dispatch-state authority. The node may
request transitions using its scoped capability; it may not invent or directly
write router state. The central Router atomically commits `leased -> started`
while reading the immutable payload, then returns that payload only in the
response bound to node, claim, dispatch, and fence. Loss of that response is
already ambiguous and the original dispatch can never be offered again, even
if the node reports it saw no payload. The later child-originated input
acknowledgement is a delivery-effect gate, not evidence used to permit replay;
missing it also settles `outcome_unknown`.

Exit criterion: independent fixtures demonstrate that a wrong node, agent,
dispatch, fence, capability, sequence, or payload digest is rejected; loss at
each started/payload/ack boundary never returns the original dispatch to the
queue. Incompatible fixture changes force node reconformance and re-canary.

### R2 — Remote execution daemon

Add a separately supervised daemon to the remote package. It must:

- run as an unprivileged account and expose no unauthenticated inbound control
  socket;
- keep stable node identity and control state behind an OS privilege boundary
  that coding children cannot read, signal, or ptrace;
- maintain one authenticated central connection with bounded reconnects;
- launch only the framework, workspace, and payload named by a valid claim;
- implement the shared `RunnerControlPlane` and reuse guardian/framework
  protocol code where its semantics are transport-neutral, never tmux delivery;
- hold no central Matrix, Dashboard, bridge, or backend-wide credential;
  provider credentials, when required, must be node-local and agent-scoped,
  enter only the guardian/child environment, and never enter the control
  connection, node journal, or logs;
- persist only the minimum node-side journal needed to reconcile guardians
  after daemon restart;
- enforce the central-signed execution lease against a local monotonic deadline
  and terminate the entire process tree on expiry, revoke, local daemon
  ownership loss, or shutdown;
- report a safe workspace label and dirty generation, never an unrestricted
  local path.

The existing push relay remains for legacy remote agents. The daemon is a new
service with separate health and deployment status; one must never silently
substitute for the other.

Exit criterion: a daemon running under the intended production account passes
the conformance suite, cannot expose its node key to a hostile child, kills all
descendants when its local execution deadline expires, and cannot execute an
unenrolled workspace/framework/agent claim. Failure keeps that node
unschedulable and leaves the legacy relay untouched.

### R3 — Partition and at-most-once semantics

The remote protocol must preserve the local recovery rule:

- before the central Router commits `started`, an expired claim may return to
  `queued`;
- after that commit, a lost payload response, child acknowledgement, or
  connection is ambiguous and must not cause automatic re-execution;
- an ordinary transport disconnect is not immediate local ownership loss: the
  daemon may keep the original guardian only until its already-issued local
  monotonic lease deadline. Only an authenticated central renewal received
  before that deadline can extend execution; the node cannot self-renew;
- a verifiably still-running guardian may reconnect within that lease only to
  report or continue its original dispatch, never to obtain the payload again;
- a dead or unverifiable started guardian settles `outcome_unknown`;
- lease expiry kills the whole process tree and settles `outcome_unknown`;
- late output after a fence change is recorded for audit and cannot settle;
- human resolution creates a new recovery dispatch for `continue`; it never
  rewinds or replays the original dispatch; resolution and recovery stay
  blocked until the old tree is confirmed dead or the maximum signed execution
  deadline has elapsed.

Exit criterion: killing the network at every protocol boundary results in
either a safely re-leasable pre-start dispatch or a visible `outcome_unknown`,
never silent loss or duplicate workspace mutation. A daemon crash is local
ownership loss and kills its guardians; only a central-connection interruption
with the daemon and guardian still alive may use the bounded reconnect rule.

### R4 — Approval, workspace, and operations integration

Complete the operational loop:

- central agent-chat remains the owner-binding and approval authority;
- the remote node parks the exact process and leases while it waits;
- owner verdict consumption and Router application precede delivery of a stable
  decision-event id to the node, which applies it idempotently;
- an explicit owner `deny` may resume the parked operation with denial; adapter
  startup failure aborts before start, while approval expiry, persistence, or
  transport failure after `started` terminates the runner and settles
  `outcome_unknown`, never a fabricated clean owner denial;
- workspace quarantine survives node and central restart;
- Agent Operations projections expose safe node/workspace labels, blocked
  chains, and inspection actions without exposing remote paths;
- node revoke fences every session, claim, and action; live guardians stop when
  the revoke arrives or no later than their locally enforced signed deadline;
- deployment reports source revision and protocol compatibility before a node
  becomes schedulable.

Only an authenticated human action with `resource_id` and a matching
`dirty_generation` may clear inspected state. The node cannot clear its own
quarantine. A remote managed configuration must pin the node transport,
framework executable, workspace id, environment allowlist, and dispatch-scoped
MCP; ambient config cannot replace any of them.

Exit criterion: approval, operations projection, restart, revoke, workspace
inspection, backend-derived reply routing, and session-scoped MCP tests pass
with no path/secret leakage. Failure keeps the node unschedulable and preserves
its quarantine.

### R5 — Staged rollout

Roll out in this order:

1. protocol conformance harness with a fake node;
2. localhost daemon over the real transport;
3. two-host read-only tasks;
4. two-host disposable worktree writer with induced partitions;
5. one real remote agent canary;
6. limited fleet enablement with a per-node kill switch.

Exit criterion: accepted governance, canonical protocol version, conformance
and partition evidence, real-runtime evidence, an operator-approved observation
window, and exercised node kill switch/rollback are recorded. Backend
eligibility, Router enqueue, launch descriptor, and tests are narrowed in the
same change. The `remote_runner_unsupported` refusal remains for every node
that is not explicitly enrolled, compatible, healthy, and enabled for the new
protocol.

## Release gates

Support is not complete until black-box tests prove all applicable rows. The
stage column is the primary owner; final release re-runs every row:

| Behavior | Octos | Remote | Owned by stage |
| --- | --- | --- | --- |
| Two threads receive isolated context and inboxes | required | required | O3/O4, R4/R5 |
| Reply room/thread is derived by the central backend | required | required | O4, R4/R5 |
| Message content never reaches a shell or terminal | required | required | O2/O4, R2/R5 |
| Child-input acknowledgement is structural, not model output | required | required | O0/O2/O4, R1/R3/R5 |
| Approval is owner-bound, single-use, durable, and fail-closed | required | required | O3/O4, R4/R5 |
| Crash after `started` never auto-replays the dispatch | required | required | O2/O4, R1/R3/R5 |
| Late output cannot settle a fenced dispatch | required | required | O2/O4, R3/R5 |
| Process-tree teardown leaves no mutating orphan | required | required | O2/O4, R2/R3/R5 |
| Session-scoped MCP cannot read another thread | required | required | O3/O4, R1/R4/R5 |
| Config/environment cannot replace the managed transport | required | required | O2/O4, R2/R4/R5 |
| Network partition at every protocol boundary is deterministic | n/a | required | R1/R3/R5 |
| Revoked or substituted node identity cannot execute | n/a | required | R0/R1/R2/R4/R5 |

In addition, the task contract must pin the exact full-suite, directed-runtime,
router build-freshness, architecture-boundary, remote-package, syntax, and
requirement-graph commands. Results report actual failed/skipped/uncertain
counts and any focused reruns; an exit code alone and a clean rerun after an
initial failure are not described as a clean first pass. Real-runtime evidence
is mandatory; fake protocol fixtures alone do not remove either refusal.

## Recommended order

1. Finish the local Claude/Codex release gates.
2. Execute Track A for Octos because its stdio backend and approval proxy
   provide usable protocol knowledge on one host.
3. Stabilize the adapter interface and failure vocabulary from that work.
4. Execute Track B for remote nodes as a separate distributed-systems project.

Octos work must not become an excuse to weaken the one-shot runner contract.
Remote work must not become an excuse to turn the existing tmux relay into an
execution authority. If either track cannot meet the same isolation,
at-most-once, approval, fencing, and recovery guarantees as the local runner,
the correct release outcome is to keep its visible refusal.
