# codex review of swarm-fleet-merge.md

gpt-5.6-sol, reasoning effort max, read-only sandbox, 455,819 tokens.
Reviewed octos at clean commit `c61c8f281ae468d33998c009c9889aac03f6529a`.
Ran `cargo metadata --locked --offline`. Could not compile (read-only workspace).

---

# Verdict

Reject the plan as written.

The merge direction is defensible—Fleet should own durable state—but Swarm is not currently a thin translation onto Fleet. It has semantics Fleet cannot represent. A1 is a definitive **no**, V5 and V11 are wrong, A2–A6 all fail materially, and §7 falsifiers **#2 and #3 hold**.

## 1. A1 settled: NO

`octos-fleet` cannot thread a dependency’s `ChildResultSnapshot.output` into a dependent task’s input.

The complete path is unambiguous:

1. Fleet does persist output. `Attempt.result_snapshot` stores a `ChildResultSnapshot`, whose `output` is a string: [records.rs:254](crates/octos-fleet/src/records.rs:254), [records.rs:284](crates/octos-fleet/src/records.rs:284).

2. Dependencies carry only task IDs that must become `Succeeded`: [records.rs:191](crates/octos-fleet/src/records.rs:191).

3. Readiness examines only the set of succeeded child IDs. It never loads an attempt or snapshot: [store.rs:642](crates/octos-fleet/src/store.rs:642).

4. `TaskView` contains title, detail, dependencies, acceptance, grant, and live state—but no predecessor result or input artifact: [fleet.rs:128](crates/octos-fleet/src/fleet.rs:128). `Fleet::view` never joins attempts: [fleet.rs:319](crates/octos-fleet/src/fleet.rs:319).

5. The pool selects only the current task’s `TaskView` and passes it unchanged to `run_attempt`: [pool.rs:243](crates/octos-fleet-worker/src/pool.rs:243).

6. The worker prompt is rendered solely from the current task’s title, detail, and acceptance criteria: [worker.rs:238](crates/octos-fleet-worker/src/worker.rs:238), [worker.rs:626](crates/octos-fleet-worker/src/worker.rs:626).

7. Completion writes the current task’s output, then merely recalculates readiness: [worker.rs:477](crates/octos-fleet-worker/src/worker.rs:477). The store writes the snapshot at [store.rs:1112](crates/octos-fleet/src/store.rs:1112).

There is a public `get_attempt` reader at [store.rs:2244](crates/octos-fleet/src/store.rs:2244), but repository-wide search found no production code using it to read a predecessor’s snapshot.

By contrast, Swarm explicitly clones the predecessor’s output and inserts `pipeline_input`: [dispatcher.rs:518](crates/octos-swarm/src/dispatcher.rs:518).

**Therefore `SwarmTopology::Pipeline` is a feature gap, not a translation. Phase 1’s Pipeline row is wrong.**

## 2. Section 2 claim audit

| Claim | Verdict | Source result |
|---|---|---|
| V1 | Verified | CLI depends on all three crates: [Cargo.toml:32](crates/octos-cli/Cargo.toml:32), [Cargo.toml:113](crates/octos-cli/Cargo.toml:113). |
| V2 | Verified | Fleet has six tables at [store.rs:46](crates/octos-fleet/src/store.rs:46); Swarm one at [persistence.rs:29](crates/octos-swarm/src/persistence.rs:29). Counts are exactly 4,293 versus 275 lines. |
| V3 | Verified | CAS lifecycle starts at [store.rs:746](crates/octos-fleet/src/store.rs:746); production boot reconciliation is wired at [serve.rs:657](crates/octos-cli/src/commands/serve.rs:657). |
| V4 | Verified | Fleet creates a fresh in-process agent and runs it under a hard timeout: [worker.rs:342](crates/octos-fleet-worker/src/worker.rs:342). |
| V5 | **Wrong** | Swarm is backend-pluggable external execution, not “remote MCP.” Production supports local stdio MCP, one-shot non-MCP CLI, and remote HTTP MCP: [serve.rs:1743](crates/octos-cli/src/commands/serve.rs:1743). |
| V6 | Verified | One current `WorkerKind`: [records.rs:100](crates/octos-fleet/src/records.rs:100). |
| V7 | Verified | Static global/per-fleet limits and acquisition order: [pool.rs:52](crates/octos-fleet-worker/src/pool.rs:52), [pool.rs:503](crates/octos-fleet-worker/src/pool.rs:503). |
| V8 | Verified, with correction | Swarm contains optional real accounting code, but its builder defaults to `NoopCostLedger`, and production does not wire `with_ledger` or `with_cost_budget`: [dispatcher.rs:749](crates/octos-swarm/src/dispatcher.rs:749), [api/swarm.rs:900](crates/octos-cli/src/api/swarm.rs:900). Fleet ordinary timeouts still commit zero: [worker.rs:534](crates/octos-fleet-worker/src/worker.rs:534). |
| V9 | Core verified; evidence misleading | It is a capability grant. But “which filesystem paths” overclaims: v1 supports only workspace or the entire host, explicitly no per-path scoping: [grant.rs:108](crates/octos-fleet/src/grant.rs:108). |
| V10 | Verified | Grantable tools are a closed catalog at [grant.rs:37](crates/octos-fleet/src/grant.rs:37); the registry retains only granted tools plus `escalate`: [closed_registry.rs:198](crates/octos-fleet-worker/src/closed_registry.rs:198). |
| V11 | **Wrong** | The evidence conflates callers, shared code, clients, metrics, and an unrelated transport test. `spawn.rs` dispatches directly to `McpAgentBackend`: [spawn.rs:3380](crates/octos-agent/src/tools/spawn.rs:3380). `octos-swarm` depends on `octos-agent`, so Agent cannot call Swarm without reversing/cycling the graph: [octos-swarm/Cargo.toml:9](crates/octos-swarm/Cargo.toml:9). The Matrix test imports `octos_bus`, not `octos_swarm`: [matrix_swarm_supervisor.rs:27](crates/octos-bus/tests/matrix_swarm_supervisor.rs:27). |
| V12 | Verified | [topology.rs:24](crates/octos-swarm/src/topology.rs:24). |

Section 4 repeats V11’s error: **agents do not spawn through Swarm**. The “Matrix test must remain unmodified” rule is also a weak merge gate because that test does not exercise `octos-swarm`.

## 3. A2–A6

**A2 is false.** The topologies are not expressible as dependencies plus current Fleet concurrency:

- `Sequential` is “ordering only”: it continues after a retryable failure and aborts only on hard failure: [dispatcher.rs:478](crates/octos-swarm/src/dispatcher.rs:478). A Fleet dependency requires predecessor success. Those semantics differ.
- `Parallel/Fanout.max_concurrency` is per dispatch. Fleet’s concurrency is one static `PoolConfig` shared across fleets; `DurablePlan` contains no concurrency field.
- `ContractSpec` contains `tool_name`, opaque JSON `task`, and `label`: [topology.rs:29](crates/octos-swarm/src/topology.rs:29). `PlanTask` has none of them: [records.rs:321](crates/octos-fleet/src/records.rs:321).
- Fleet returns ready tasks sorted by task ID: [store.rs:666](crates/octos-fleet/src/store.rs:666). That does not reproduce arbitrary Swarm contract order.
- Another stale comment exists: `topology.rs` promises parallel aggregation in arrival order, but the dispatcher writes outcomes back to their original index and aggregates that vector: [dispatcher.rs:447](crates/octos-swarm/src/dispatcher.rs:447), [result.rs:228](crates/octos-swarm/src/result.rs:228). Actual behavior is resolved-contract order.

**A3 is false.** `gate.rs` is a pre-dispatch policy adapter, not a validator: [gate.rs:1](crates/octos-swarm/src/gate.rs:1). Swarm separately supports required/optional completion validators per subtask and for the aggregate: [dispatcher.rs:586](crates/octos-swarm/src/dispatcher.rs:586). Fleet supports only limited mechanical criteria, treats all as required, and fails closed on `Manual`, `ValidatorRef`, and nonzero expected exit codes: [worker.rs:652](crates/octos-fleet-worker/src/worker.rs:652). `AcceptanceVerdict` is an outcome, not validator configuration.

**A4 is false.** Fields without faithful Fleet homes include:

- `topology`
- global `retry_rounds_used`
- `contracts_fingerprint`
- exact `final_result`, including aggregate validator and cost results
- controller `task_id`
- per-subtask `last_dispatch_outcome`
- the opaque contract task, tool name, and label
- Swarm’s three-state retry vocabulary

See the complete blob at [persistence.rs:32](crates/octos-swarm/src/persistence.rs:32) and subtask fields at [result.rs:55](crates/octos-swarm/src/result.rs:55). This is a schema redesign.

**A5 is false.** Phases 1–4 are not small:

- Phase 1 cannot produce a lossless `DurablePlan`.
- Phase 2’s proposed data-bearing `WorkerKind` is a persisted enum change. Fleet’s own schema commentary says adding an enum variant is incompatible: [records.rs:24](crates/octos-fleet/src/records.rs:24).
- `WorkerKind` lives on the child, not `PlanTask`, and fleet creation hardcodes `StatelessTask`: [store.rs:428](crates/octos-fleet/src/store.rs:428).
- `McpContract { tool_name, backend }` still omits the opaque task payload and label.
- Fleet has no explicit non-executable shadow state. Normal creation produces `Active` fleets and `Ready` dependency-free children: [store.rs:398](crates/octos-fleet/src/store.rs:398).

**A6 is false.** The frontend contract is broader than request/response shapes. It depends on:

- exact retry/status vocabulary and per-subtask attempts: [swarm.ts:89](swarm-app/src/api/swarm.ts:89)
- SSE event kinds and fields: [swarm.ts:419](swarm-app/src/api/swarm.ts:419)
- validator evidence, costs, and review lifecycle: [ReviewGate.tsx:13](swarm-app/src/components/swarm/ReviewGate.tsx:13)
- all four topology semantics through shipped templates: [swarm.ts:163](swarm-app/src/api/swarm.ts:163)

It also exposes USD budget fields that the frontend itself says the backend ignores: [swarm.ts:37](swarm-app/src/api/swarm.ts:37). The Rust request accepts only contract and retry limits: [api/swarm.rs:186](crates/octos-cli/src/api/swarm.rs:186).

## 4. Open questions

1. **Q1 — Is the direction right?**  
   **Yes, if unification is pursued: Fleet state with a Swarm facade is the correct direction.** Reverse absorption is unsound. Swarm has four static topology forms and one overwritten blob; Fleet has attempt history, leases, generations, replanning, grants, decisions, and an outbox. But “direction right” does not make this translator plan right. The kernel must first be generalized.

2. **Q2 — Shared lease namespace instead?**  
   It would be cheaper only if the actual problem were shared capacity. The source does not show two runtimes double-claiming one agent. Fleet mints a fresh in-process `Agent`; Swarm calls an injected external backend. Swarm’s only claim guard is an in-process set keyed by `dispatch_id`: [dispatcher.rs:830](crates/octos-swarm/src/dispatcher.rs:830). There is no common agent identity to lease.  
   If provider/profile capacity is the concern, build a shared semaphore or backend-capacity lease. It will not eliminate the duplicate durability, retry, validation, budget, or UI models.

3. **Q3 — Budget accounting for `McpContract`?**  
   `DispatchResponse` has no usage fields: [mcp_agent.rs:214](crates/octos-agent/src/tools/mcp_agent.rs:214). Current Swarm estimates input bytes/4, assumes zero output tokens, and refunds failures: [dispatcher.rs:987](crates/octos-swarm/src/dispatcher.rs:987). Do not import that as “real” accounting. Reserve a configured upper bound; commit actual usage when reported; otherwise commit the reservation conservatively. Never record zero for a timed-out remote run that may have spent money.

4. **Q4 — Is `swarm-app` hard?**  
   Treat it as a compatibility constraint unless product explicitly approves a rewrite. Preserving HTTP structs alone is insufficient; preserve status/retry/order, SSE, validators, cost attribution, and review semantics. Rewriting the UI removes facade work, not the kernel gaps.

5. **Q5 — Before or after Phase 2b?**  
   **After Phase 2b, or co-design both worker kinds now.** The repository’s accepted roadmap explicitly places durable interactive workers before Swarm/Pipeline convergence: [FLEET-RUNTIME-ADR.md:143](docs/FLEET-RUNTIME-ADR.md:143), [FLEET-KERNEL-FOUNDATION-SPEC.md:168](docs/FLEET-KERNEL-FOUNDATION-SPEC.md:168). The plan silently reverses that sequence. Both efforts touch persisted worker kinds, launch descriptors, timeout, and budgeting; treating them as unrelated invites two incompatible schema migrations.

## 5. Section 7 falsifiers

- **#1 partially holds, not fully.** Fleet cannot thread artifacts. “Adding it is expensive” is not established: output is already stored, the successful attempt ID is retained, and `get_attempt` exists. Correct edge semantics and payload plumbing are nontrivial, but an implementation spike is needed before calling it expensive.
- **#2 holds.** `DispatchRecord` and `SwarmResult` contain multiple facts without normalized Fleet homes. This is a schema redesign.
- **#3 holds.** The frontend depends on lifecycle, retry, validation, event, cost, and review semantics. Shape-only compatibility is insufficient.
- **#4 does not hold.** I found shared policy types, but no shared store, lease namespace, claim protocol, or execution coordination between Swarm and Fleet.

So: **exactly falsifiers #2 and #3 fully hold; #1 is half-proven; #4 is false.**

## Verified in source

- Reviewed clean commit `c61c8f281ae468d33998c009c9889aac03f6529a`.
- Ran `cargo metadata --locked --offline`; it confirms `octos-swarm → octos-agent`, not the reverse.
- Verified the A1 execution path, all twelve claims, A2–A6, UI consumers, persistence models, live production wiring, and roadmap order directly from source.
- Rust dependency/domain-model checks materially exposed V11’s reversed caller claim and A4’s missing state homes.

## Could not check

- I could not compile or run tests because this workspace is read-only and Cargo requires writable build/fingerprint storage.
- I did not inspect production redb contents or deployed configuration.
- Runtime timing, crash behavior, and performance remain unexecuted.
- “Artifact threading is expensive” and whether product will permit a UI rewrite are judgments requiring an implementation spike or owner decision.

Confidence is **high** on the source-level findings and merge-direction conclusion; **medium** on effort sizing.
tokens used
455,819
# Verdict

Reject the plan as written.

The merge direction is defensible—Fleet should own durable state—but Swarm is not currently a thin translation onto Fleet. It has semantics Fleet cannot represent. A1 is a definitive **no**, V5 and V11 are wrong, A2–A6 all fail materially, and §7 falsifiers **#2 and #3 hold**.

## 1. A1 settled: NO

`octos-fleet` cannot thread a dependency’s `ChildResultSnapshot.output` into a dependent task’s input.

The complete path is unambiguous:

1. Fleet does persist output. `Attempt.result_snapshot` stores a `ChildResultSnapshot`, whose `output` is a string: [records.rs:254](crates/octos-fleet/src/records.rs:254), [records.rs:284](crates/octos-fleet/src/records.rs:284).

2. Dependencies carry only task IDs that must become `Succeeded`: [records.rs:191](crates/octos-fleet/src/records.rs:191).

3. Readiness examines only the set of succeeded child IDs. It never loads an attempt or snapshot: [store.rs:642](crates/octos-fleet/src/store.rs:642).

4. `TaskView` contains title, detail, dependencies, acceptance, grant, and live state—but no predecessor result or input artifact: [fleet.rs:128](crates/octos-fleet/src/fleet.rs:128). `Fleet::view` never joins attempts: [fleet.rs:319](crates/octos-fleet/src/fleet.rs:319).

5. The pool selects only the current task’s `TaskView` and passes it unchanged to `run_attempt`: [pool.rs:243](crates/octos-fleet-worker/src/pool.rs:243).

6. The worker prompt is rendered solely from the current task’s title, detail, and acceptance criteria: [worker.rs:238](crates/octos-fleet-worker/src/worker.rs:238), [worker.rs:626](crates/octos-fleet-worker/src/worker.rs:626).

7. Completion writes the current task’s output, then merely recalculates readiness: [worker.rs:477](crates/octos-fleet-worker/src/worker.rs:477). The store writes the snapshot at [store.rs:1112](crates/octos-fleet/src/store.rs:1112).

