# Unifying octos-swarm onto octos-fleet — review target

> ## ⛔ DRAWERED — do not action this plan
>
> Reviewed and **rejected as written** by codex (gpt-5.6-sol, max reasoning, 455k tokens,
> clean commit `c61c8f28`). Full verdict: [`swarm-fleet-merge-review.md`](swarm-fleet-merge-review.md).
>
> Three reasons, in order of weight:
>
> 1. **`docs/FLEET-RUNTIME-ADR.md` already sequences this work, and it is step 4 of 4** —
>    *"a phased follow-on, **not** a prerequisite for the goal win."* This document proposed
>    the last step first. The ADR was not read before it was written.
> 2. **It covers two of three stacks.** `octos-pipeline` also converges onto the same
>    stateless task-worker. Any future version must include it.
> 3. **It is a schema redesign plus a UI contract negotiation, not a lift.** A1 is a
>    definitive *no* — fleet cannot thread a predecessor's output — so `Pipeline` is a
>    feature gap. Of twelve "verified" claims, two were wrong (V5, V11) and two needed
>    qualifying (V8, V9). All five unverified assumptions (A2–A6) were false.
>
> The **direction** survives: fleet owns durable state, swarm becomes a facade. Reverse
> absorption is unsound. Retrieve this document at ADR step 4, and rewrite §3 and §5 from
> the review before doing anything with it.
>
> One motivating claim was also wrong and should not be repeated: this document implied
> swarm and fleet contend for the same agent. They do not — fleet mints an in-process
> `Agent`, swarm calls an injected external backend. The duplication is real; the collision
> was not.

**Purpose of this document:** to be attacked. It states a plan, the evidence the plan rests
on, and — separately and explicitly — the assumptions that were *not* verified. A reviewer
should go after §5 and §6 first.

Author: Claude (via HAFleet workspace), 2026-08-06. All evidence gathered by reading
`octos-org/octos` at `main` through the GitHub API. **Nothing here was compiled or run.**

---

## 1. The claim

`octos-swarm` and `octos-fleet` are two durable orchestration layers, both live, both
reachable from `octos-cli`'s API surface, each with its own redb store. They should become
one: **fleet keeps the state, swarm keeps the interface.**

`octos-swarm` stops being a crate with a database and becomes a thin front end — topology
types, a plan translator, an MCP executor, and the API contract `swarm-app` already speaks.

## 2. Verified evidence

Each of these was checked directly. File paths and quotes are from `main`.

| # | Fact | How verified |
|---|---|---|
| V1 | Both crates are dependencies of `octos-cli` | `crates/octos-cli/Cargo.toml:32` (`octos-swarm`), `:113` (`octos-fleet`), `:117` (`octos-fleet-worker`) |
| V2 | Fleet's store is ~15× swarm's | `octos-fleet/src/store.rs` 4,293 lines / 6 tables; `octos-swarm/src/persistence.rs` 275 lines / 1 table (`swarm_dispatch`), one `DispatchRecord` blob per dispatch |
| V3 | Fleet has CAS-fenced transitions, leases, generations, outbox, boot recovery | `store.rs`: `launch_child`, `mark_running`, `complete_child`, `record_escalation`, `replan`, `reconcile`, `claim_next`, `ack`, `append_decision` |
| V4 | Fleet's executor is **in-process** | `octos-fleet-worker/src/worker.rs`: *"mints a fresh closed-registry `octos_agent::Agent`"*, run under *"a HARD `tokio::time::timeout`"* |
| V5 | Swarm's executor is **remote MCP** | `octos-swarm/src/lib.rs` usage sketch calls `McpAgentBackend`, `tool_name: "claude_code/run_task"` |
| V6 | `WorkerKind` is a one-variant enum with a documented second | `octos-fleet/src/records.rs`: `StatelessTask` only; *"the interactive session-worker is Phase 2b"* |
| V7 | Fleet has two-level concurrency control | `octos-fleet-worker/src/pool.rs`: `global_concurrency` + `per_fleet_concurrency`, per-fleet permit taken **before** global (P2-1) |
| V8 | Swarm's cost ledger is stubbed; fleet's is real but under-counts | swarm `lib.rs`: *"rolls up cost via the M7.4 ledger (stubbed here until that work lands)"*. fleet `worker.rs`: *"Token under-commit on non-success paths (P2-2)"* — a timeout commits `0` tokens |
| V9 | `WorkerGrant` is a **capability** grant, not a kind switch | `octos-fleet/src/grant.rs`: *"which network it may reach (per-host allowlist), which tools it may hold, and which filesystem paths it may touch"*; base tools chosen so *"none blocks on human input"* |
| V10 | Fleet workers cannot call peer/spawn tools | `FLEET-KERNEL-V1-SPEC.md`: *"intrinsically non-interactive … **no** question/input, peer, spawn/delegate"* |
| V11 | Swarm has more callers than the HTTP API | `swarm-app/src/pages/SwarmPage.tsx`, `components/swarm/ContractEditor.tsx`, `octos-cli/src/api/swarm.rs`, `api/metrics.rs`, `octos-agent/src/dispatch_policy.rs`, `octos-agent/src/tools/spawn.rs`, `octos-bus/tests/matrix_swarm_supervisor.rs` |
| V12 | `MAX_CONTRACTS_PER_DISPATCH = 128` | `octos-swarm/src/topology.rs` |

### A correction worth carrying

`octos-fleet/src/lib.rs:12-14` still says the crate is *"**not** wired into any live path — the
closed task-worker, the outbox consumer, and the keeper land in later PRs."*

**That comment is stale.** All three have landed: `octos-fleet-worker` is the task-worker,
`claim_next` is called from `octos-cli/src/api/fleet_wake.rs`, and `octos-cli/src/goal_tool.rs`
is the keeper. An earlier draft of this plan was built on that comment and had to be
rewritten. A reviewer should assume other doc comments in this crate may also lag `main`.

## 3. The plan

**Phase 0 — freeze the seam.** No new tables in `octos-swarm/src/persistence.rs`, no new
fields on `DispatchRecord`. New durable state goes in the kernel.

**Phase 1 — the translator.** A pure function
`(Vec<ContractSpec>, SwarmTopology) -> DurablePlan`:

| topology | plan shape |
|---|---|
| `Parallel { max_concurrency }` | N children, no deps, concurrency = n |
| `Sequential` | dep chain, ordering only |
| `Pipeline` | dep chain **plus artifact threading** |
| `Fanout { pattern }` | expand at plan time, then as `Parallel` |

Property test: for every topology, the plan's `ready_tasks` order reproduces swarm's
dispatch order. Lands with zero behavioural change — nothing calls it yet.

**Phase 2 — a second `WorkerKind`.** `McpContract { tool_name, backend }` beside
`StatelessTask`; `run_attempt` branches. CAS, leases, budget, acceptance and outbox stay
shared. Requires deciding what an `McpContract` commits against the budget when the remote
agent reports tokens differently, or not at all (see V8).

**Phase 3 — shadow, do not dual-run.** Swarm executes as today; the kernel records the same
plan **without executing it**; a reconciler asserts both reach the same terminal state. Flag
it, default off.

**Phase 4 — cut over one topology at a time.** Parallel, then Sequential, then Fanout,
Pipeline last. `api/swarm.rs` keeps its request/response shapes so `swarm-app` never changes.

**Phase 5 — drain, do not migrate.** Stop accepting new dispatches on the old path, let
in-flight finish, then flip. Completed `DispatchRecord` rows are inert.

**Phase 6 — delete.** `persistence.rs`, `DispatchStore`, the swarm redb file, `ledger.rs`.
Keep `topology.rs`, `gate.rs`, `result.rs`, the API.

Phases 1–4 are additive and flag-guarded. Phase 5 is the one-way door.

## 4. What must not break

`octos-bus/tests/matrix_swarm_supervisor.rs` should stay green through every phase,
**unmodified**. If a phase requires editing that test, the phase is wrong.

Plus the callers in V11: the `swarm-app` UI contract, `tools/spawn.rs` (agents spawn through
swarm), `dispatch_policy.rs`, and metric continuity in `api/metrics.rs`.

## 5. Assumptions NOT verified — attack these first

**A1. That fleet can thread artifacts between dependent tasks.** This is the load-bearing
unknown. `worker.rs` says it *"builds a `Task` from the task's brief + acceptance criteria"*
with no sign it reads a dependency's `ChildResultSnapshot.output`. If it cannot, `Pipeline`
is a **feature gap, not a translation**, and Phase 1's table is wrong on one of four rows.
This has been flagged three times in discussion and nobody has read the code path yet.

**A2. That the four topologies are fully expressible as deps + concurrency.** Follows from
A1 for Pipeline. `Fanout`'s `FanoutPattern` stamps a `variant` field on each expanded task;
whether `PlanTask` has somewhere to put that is unchecked.

**A3. That swarm's `gate.rs` validator and fleet's `AcceptanceVerdict` are semantically
compatible.** Asserted from names. Neither was read.

**A4. That `DispatchRecord`'s per-subtask state has no field without a home in the kernel's
normalised tables.** The blob was never enumerated field by field.

**A5. Effort sizing.** "Phases 1–4 are small, Phase 5 is the door" is judgement from reading,
not from having built any of it.

**A6. That `swarm-app`'s contract is fully expressed by `api/swarm.rs`.** The frontend was
identified by filename only; neither TSX file was read.

## 6. Open questions for the reviewer

1. **Is the direction right at all?** The plan assumes fleet absorbs swarm. The reverse —
   fleet's plan/attempt model expressed as swarm topologies — was considered and rejected on
   the grounds that swarm's single-blob store cannot represent attempts, generations or
   leases. Is that rejection sound?
2. **Should the two stores merge at all**, or is the real answer a shared *lease namespace*
   so they can coexist without double-claiming an agent? That is cheaper and reversible.
3. **What does `McpContract` commit against the budget?** V8 says fleet already under-counts
   on failure paths. Adding a worker kind whose token usage is reported by a remote process
   may make the budget advisory in name only.
4. **Is `swarm-app` a hard constraint or a rewrite candidate?** The plan treats it as a
   contract to preserve, which shapes Phases 4–6. If it can change, the plan gets simpler.
5. **Does the merge need to happen before or after Phase 2b** (the interactive
   session-worker)? The plan assumes before, on the grounds that 2b's hard parts — lease
   expiry, budget projection and timeout for unbounded work — are unrelated to the merge.

## 7. What would falsify this plan

- Fleet cannot thread artifacts **and** adding it is expensive → Pipeline blocks the merge,
  and a partial merge that drops one topology is a regression.
- `DispatchRecord` carries state with no normalised home → the merge is a schema redesign,
  not a lift.
- `swarm-app` depends on swarm's dispatch semantics rather than its API shape → Phase 4's
  "the UI never changes" premise fails and the cutover is a product change.
- The two systems already coordinate somewhere I did not find → the "two stores" premise is
  wrong and the whole motivation weakens.
