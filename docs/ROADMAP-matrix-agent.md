# Roadmap — matrix-Agent execution layer (agent-chat)

The execution-layer counterpart to OpenFab's verify-thickness roadmap. Scope boundary:
**OpenFab drives** (asks for "a `<role>` agent at `<capability>`, do this task") and signs the
result; **agent-chat is matrix-Agent** — it owns *agent pooling, capability scheduling, and the
6-role org matrix* (OpenFab pitch S8). This plan implements that here, incrementally, without
disturbing OpenFab's trust line.

Design detail: [DESIGN-matrix-agent-execution-layer.md](DESIGN-matrix-agent-execution-layer.md).

## The target shape (S8)

```
                 architect   coding   testing   review   integration   documentation   ← 6 roles
   strong          ●                              ●                                     (top model)
   medium                      ●        ●                    ●                          (mid model)
   lightweight                                                              ●           (cheap/fast)
```
A pool of capability-tagged agents; a scheduler routes each task to an idle agent of the right
`(role, tier)`, queuing or auto-provisioning when the pool can't staff it. Humans (总监/产品/
QA owner) set direction and hold the gate (the gate itself is OpenFab's N-of-M sign-off).

## Principles
- **Backward compatible.** Existing `<team>_<role>` agents keep working; role/capability are
  inferred when unset (`canonicalRole`). No re-registration required.
- **Pure core first, side effects at the edges.** Scheduling *decisions* are pure + unit-tested
  (`lib/matrix-agent.js`); the HTTP/process side effects wrap them.
- **Honest staffing.** If the pool can't meet a request and auto-provision is off/at cap, the
  task **queues** with a visible reason — never silently mis-assigned.
- **Attribution preserved.** Whatever agent runs, its identity (name · model family · tier) flows
  back in `task_result` so OpenFab records it in the signed AI-BOM.

---

## Phase 0 — capability core ✅ (landed)
`lib/matrix-agent.js` + tests: `CAPABILITY_TIERS`, `ROLES`, `ROLE_DEFAULT_TIER`, `TIER_RUNTIME`,
`resolveTier`, `canonicalRole`, `agentRole/agentCapability`, `indexPool`, `selectAgent`,
`planDispatch`. Pure, 6 vitest tests. Foundation for everything below.

## Phase 1 — persist capability on the agent record
- Extend the agent manifest + registration API: add `capability ∈ {strong,medium,lightweight}`
  (the backend already normalizes `role`). `up-v1 --role <r> --capability <tier>` writes both;
  `capability` selects the launch runtime/model via `TIER_RUNTIME`.
- Migration: agents without the field fall back to `agentCapability()` (inferred). No break.
- **Acceptance:** an agent registered with `{role, capability}` shows them in `data/agents.json`
  and `GET /api/agents`; legacy agents still resolve a role/tier.

## Phase 2 — pool query (read-only, safe)
- `GET /api/pool?role=&capability=&state=idle|busy|any` → agents grouped by `(role, capability)`,
  built from the registry via `indexPool`. No scheduling yet — pure visibility.
- **Acceptance:** returns the role×tier grid; filters by role/capability/state; covered by an
  API test (mirror `tests/api-agents.test.js`).

## Phase 3 — capability scheduler
- `POST /api/dispatch { role, capability?, task, room? }`:
  1. `resolveTier(role, capability)`;
  2. `selectAgent(pool, role, tier)` → if found, mark **busy**, deliver the task to it;
  3. if none → **enqueue** under `(role, tier)` with a reason (`no idle agent`).
- Free the agent (`busy=false`) on its `task_result`; drain the queue on free.
- Track `busy` on the agent record (or an in-memory dispatch table keyed by agent).
- **Acceptance:** dispatch routes to an idle agent; a second concurrent dispatch for the same
  `(role,tier)` queues; completing the first drains the queue. Unit + API tests.

## Phase 4 — auto-provision + concurrency caps
- When the queue for `(role, tier)` is non-empty and below a per-`(role,tier)` max, auto-launch
  an agent (`up-v1 <generated-name> <TIER_RUNTIME.runtime>` with the role/capability), then route.
- Idle-reap: scale provisioned agents back down after an idle TTL.
- Config: `MATRIX_AGENT_MAX_PER_CELL` (default e.g. 2), `MATRIX_AGENT_IDLE_TTL`.
- **Acceptance:** a dispatch with an empty pool provisions one agent (up to the cap) and routes;
  beyond the cap it queues; idle agents reap after the TTL.

## Phase 5 — staff the full 6-role org
- Add the roles not yet in active use as first-class: **testing**, **documentation**, and
  **integration** (integration may initially fold into coding). Provide skills/prompts per role
  so a provisioned agent knows its job.
- Map the existing 4 (`coordinator→architect`, `implementer→coding`, `reviewer→review`,
  `final_reviewer→review@strong`) onto the matrix (already handled by `canonicalRole`).
- **Acceptance:** `GET /api/pool` can show all six columns; a `role=testing` dispatch reaches a
  testing-skilled agent.

## Phase 6 — the OpenFab driving contract (small, OpenFab-side)
- OpenFab's Bridge gains capability-aware dispatch: instead of a fixed `BRIDGE_ASSIGNEE`, send
  `role` + `capability`; the Bridge calls `POST /api/dispatch` and the scheduler picks the agent.
- The chosen agent's identity (name · model family · tier) returns in `task_result` → OpenFab
  writes it into the signed AI-BOM (it already records model/agent identity).
- Cross-model review (OpenFab C14) = staff `review` from **two different model families** at
  `strong`; the scheduler simply returns two distinct agents.
- **Acceptance:** OpenFab can request `role=coding capability=medium` and get a build back, with
  the concrete agent recorded in provenance — without naming the agent.

## Phase 7 — observability
- The Agent Monitor (:8084) renders the live **role × tier matrix**: who's idle/busy, queue
  depth per cell, provisioned-vs-named. Surfaces "按能力调度" at a glance.
- **Acceptance:** the monitor shows the grid + queues and updates live.

---

## Sequencing & effort
| Phase | Effort | Risk | Unlocks |
|------|--------|------|---------|
| 0 core ✅ | — | — | the decision logic |
| 1 persist capability | S | low | tagged agents |
| 2 pool query | S | low | visibility |
| 3 scheduler | M | med | 按能力调度 |
| 4 auto-provision | M | med | 池化弹性 |
| 5 six roles | M | low | full org |
| 6 OpenFab contract | S | low | OpenFab drives by capability |
| 7 monitor | S | low | operability |

Recommended order: **1 → 2 → 3 → 6** (a usable capability-dispatch loop end-to-end with OpenFab),
then **4 → 5 → 7** (elasticity, full org, operability). Each phase: backward-compatible, vitest
covered, landed on this branch.

## Out of scope (stays in OpenFab)
spec authoring, verification (incl. layered QA / cross-model adversarial *gating*), in-toto/SLSA
signing, the N-of-M human gate, AI-BOM. agent-chat *executes*; OpenFab *certifies*.
