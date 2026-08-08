# HAFleet as a resource-contribution console — UX design for review

Status: **design, one question left (§7).** Q1–Q3 answered and folded in;
`lib/role-capacity.json` is written and validated against the live constants.
The superseded PDU/two-lens console is tagged `mockup/pdu-two-lens`.

Every claim in §2 was checked against this repo. Anything not found is marked ❌ and is drawn
as a *contract* in §6, the way `/onboard` was drawn against `GET /api/frameworks/detect` — never
as if it existed.

---

## 0. The persona flips

Every previous design of this console assumed the user is **the house dispatching workers** —
a PDU manager staffing projects. That was wrong about who HAFleet serves.

The user is the **resource provider**: 带资入组的开源贡献者. Somebody who contributes to a
project not by writing code, but by **lending agent capacity**. They own Claude Code, Codex,
Hermes, Octos. They want to expose that capacity to a community — HAgency — and they need to
control exactly what they lend, in which configuration, and how much it may cost them.

Two consequences, and the second is the bigger one:

1. **Dispatch is not ours.** Who does which task is decided on the project side. Nothing in
   this console schedules work. The scheduler, the role×tier pool and the lease grid all leave.
2. **The console is inward-facing.** It answers *"what am I offering, on what terms, and what
   is it costing me"* — not *"who is working on what"*.

What replaces dispatch is **接洽**: a project asks for capacity, and the owner approves or
rejects it with a budget attached.

---

## 1. Four layers

```
L4  用量   Consumption   what my agents did, for whom, and what it cost
L3  接洽   Engagement    standing offer + whitelist → auto-join · else approve/reject
L2  能力   Capability    role templates: which (agent × model) combinations qualify
                         ↑ THIS is what is exposed to HAgency — roles, never raw agents
L1  资源   Resource      my agents, their model configuration, their token ceiling
```

The layer boundary that matters: **HAgency sees roles, not agents.** A project asks for a
System Architect; it does not ask for `octos-agent running Kimi K3`. The mapping between the
two is private to the provider, which is what makes it a resource market rather than a
remote-shell directory.

---

## 2. Grounding — what exists, per layer

### L1 资源 — mostly real

| item | state | evidence |
|---|---|---|
| agent registry | ✅ | `GET /api/agents`, `agents` in `backend-v2.js:2906`-style store; `bin/hafleet-ls` |
| fleet scan / liveness | ✅ | `refreshServerLiveness()`, `GET /api/agents/status`, `activeNow` / `idleDurationSec` |
| framework manifests | ✅ | `lib/frameworks/{claude,codex,codex-acp,hermes,octos}.json` — transport, `modelFlag`, `acpModelFlag`, `permissionSummary`, flag guards |
| **model configuration** | ✅ | `normalizeRuntimeProfileRole()` at `backend-v2.js:713` takes exactly `{ framework, provider, model, reasoning, extraArgs, apiBaseUrl, apiKey }` — shell-metachar validated |
| **reusable named configs** | ✅ | `framework-presets.json` + `GET/POST /api/framework-presets`; a `presetId` resolves into a `runtimeProfile` at registration (`backend-v2.js:8146-8151`) |
| per-provider models | ✅ | `provider` + `model` are free strings, so Octos↔Kimi/DeepSeek/Gemini and Codex reasoning levels already fit |
| capability / sandbox policy | ✅ | per-framework `guards` — HAFleet refuses `--yolo`, `--danger-full-access`, `--dangerously-skip-permissions` |
| **framework auto-detection** | ❌ | `GET /api/frameworks/detect` does not exist. Contract in §6. |
| **token ceiling per agent** | ❌ | **no token accounting anywhere.** Every `usage`/`budget` hit in `lib/` and `backend-v2.js` is a CLI help string. Contract in §6. |

The important find: **`reasoning` is already a field.** Codex thinking levels and Claude model
choice need no new schema — the wizard writes a preset, which is a real persisted record with
a real API.

### L2 能力 — half of it was already in the code

| item | state | evidence |
|---|---|---|
| role vocabulary is a real constant | ✅ | six roles, three tiers, per-role default tier and subsumption at `lib/matrix-agent.js:11-35` |
| tier → model mapping | ⚠️ | `TIER_RUNTIME` maps a tier to **one** `{runtime:'claude', model}` pair. A contributor lending Octos on Kimi K3 has nothing to match against |
| cross-family review intent | ✅ | `lib/matrix-agent.js:26` — *"Cross-model review = staff `review` from two different model families at `strong`"* |
| **role → (agent × model) enumeration** | ✅ **written** | `lib/role-capacity.json`, validated against the live constants: roles, `defaultTier` and tiers all match |
| **anything reads that file** | ❌ | no consumer yet. The console is its first. |
| **role capacity exposed upward** | ❌ | nothing publishes "I can offer 2 architects" |
| roles are enforced anywhere | ❌ | `ROLES` is **never imported by the backend**; `agentRole()` returns `agent.role` unvalidated, and `canonicalRole()` guesses a role from substrings in the agent *name* |

**Answered (Q2): the roles are the system's, not invented.** `role-capacity.json` keeps
`architect · coding · testing · review · integration · documentation`, their default tiers and
tier subsumption exactly as `matrix-agent.js` defines them, and adds only the missing
enumeration — which non-Claude combinations qualify for each tier. Display names sit beside the
keys so the console can read "System Architect" while the wire value stays `architect`.

Two things the file makes explicit that the code only implied:

- **Exclusions are named, not omitted.** Haiku and Fable are listed as excluded from `architect`
  and `review`, with the reason. A card that silently lacks a model reads as an oversight.
- **Subsumption has a cost the contributor should see.** `strong` fills every role, so lending
  only Opus means paying Opus rates to write documentation. That is the contributor's trade to
  make, so the console shows it rather than preventing it.

### L3 接洽 — half real, and not the half I expected

| item | state | evidence |
|---|---|---|
| **agent ↔ project ↔ owner binding** | ✅ | `upsertBinding()` at `lib/approval-store.js:186` stores exactly `{ agent, project, projectRoomId, ownerMxid, ownerDmRoomId, active }` — **this is the contribution record** |
| owner-approval over Matrix | ✅ | `createRequest()` / `submitMatrixVerdict()` / `denyPending()`, durable, audited, `listAudit()` |
| project = a Matrix room | ✅ | `projectRoomId`, bridge-guarded (`requireBridgeSecret`) |
| **inbound "project requests a role"** | ❌ | does not exist. Contract in §6. |
| **budget allocated per engagement** | ❌ | does not exist. |

**Correction to my own earlier reading.** I assumed `approval-store` was project-requests-agent.
It is not. `createRequest` takes `{ agent, runtime, tool_name, input_preview, upstream_request_id }`
with a 5-minute TTL — it is **per-tool-call** permission: an agent wants to run something, and
its human owner says yes over Matrix. Valuable, and a genuinely different thing.

What *is* reusable is the **binding**, which already carries the exact triple this design needs.
The approval machinery is the model for the new engagement flow, not the flow itself.

### L4 用量 — structure real, measurement absent

| item | state | evidence |
|---|---|---|
| tasks + status | ✅ | `lib/task-store.js`, `GET /api/tasks`, five statuses, `waiting_reason`, heartbeat |
| per-project rollup | ✅ | `buildProjectBoardSnapshot()` at `lib/project-board.js:462` — members, task lanes, activity |
| per-agent activity | ✅ | `activeNow`, durations, per-agent logs |
| **tokens consumed** | ❌ | nothing, at any granularity |
| alerts | ✅ | `lib/alert-store.js`, five statuses, actionable-field discipline |

---

## 3. High-level IA

Five screens. The order is the order a provider moves through them, once.

```
① 我的资源   /resources          agents, their configuration, their ceilings
② 配置向导   /resources/new      the wizard: framework → model → reasoning → budget
③ 能力目录   /capability         role templates, and what I can currently fill
④ 接洽       /engagements        inbound requests · approve/reject · budget
⑤ 用量       /usage              what ran, for whom, what it cost
```

Plus `/agents/[name]` as the per-agent record, and `/settings` for global ceilings.

**No `/dispatch`, no capacity grid, no lease table.** Removed on purpose (§8).

## 4. Low-level — screen by screen

### ① `/resources` — 我的资源

One row per agent: name, framework, transport, **the resolved model configuration**, its
token ceiling, spend-to-date, and whether it is bound to any project.

Two honest states this must carry, both true of a real host today:

- an agent with **no runtime profile** shows its framework default and says the model was not
  chosen, not that it is `claude-sonnet-5`;
- **spend-to-date is `—` with a reason**, not `0`. Nothing measures it (§2 L4). A zero would
  claim a measurement nobody takes.

### ② `/resources/new` — the wizard

Four steps, each writing a field that already exists:

1. **框架** — from the five real manifests. Shows the manifest's `permissionSummary` and the
   flags HAFleet will refuse, so the contributor sees the sandbox they are lending.
2. **模型** — `provider` + `model`. Per framework, from real options:
   Claude Code → Opus / Sonnet / Haiku / Fable · Codex → GPT-5.6 · Octos → Kimi K3 / DeepSeek /
   Gemini · Hermes → its configured provider.
   Where the adapter cannot honour a model choice the step says so rather than offering it:
   `codex-acp` accepts `--model` and ignores it, `hermes-acp` dies on it — both already
   recorded in the manifests.
3. **推理档位** — `reasoning`. Real field, and where Codex thinking levels live.
4. **预算** — daily / monthly token ceiling. **This is the one step with no backend field.**
   It is drawn against the contract in §6 and labelled as not yet enforced.

The wizard's output is a **preset** — a named, reusable, persisted record — so a contributor
configures "my Opus donation" once and attaches it to several agents.

### ③ `/capability` — 能力目录

The layer the provider exposes. One card per role, read from `lib/role-capacity.json` — the
system's own six, under their display names:

**System Architect · Reviewer · Software Engineer · Test Engineer · Integration/Release · Technical Writer**

Each card carries:
- the **qualifying combinations**, as an enumeration — architect accepts `claude-opus-5`,
  `gpt-5.6-sol` at high reasoning, `kimi-k3`, `deepseek-v-flash`; and **explicitly excludes**
  Haiku and Fable, with the reason shown;
- **how many I can currently fill**, computed from my configured agents;
- **what is missing** when I can fill zero — a model I have not configured versus an agent I do
  not own. Different problems, different actions;
- for **Reviewer**, the cross-family rule: a provider lending only one model family cannot staff
  both sides of a review. That is not a warning, it is the role's definition
  (`matrix-agent.js:26`), and the card says so.

The file ships with the product. A provider may narrow it — decline to offer a role, or a
combination — but not invent a role name, because the project side has to recognise it for the
market to mean anything.

**Each card publishes or withholds a standing offer**, which is what makes the provider
discoverable rather than waiting to be invited: how many of this role I offer, the budget cap
per engagement, and a rate cap. An unpublished role is configured but invisible — a real and
useful state, since a provider may want capacity ready before advertising it.

### ④ `/engagements` — 接洽

Replaces dispatch. Three sections:

**The routing (Q1 answered: hybrid, gated by a whitelist).** A standing offer makes me
discoverable so I am not idle waiting for invitations; a whitelist decides who skips me:

```
请求到达
 ├─ 项目在白名单 且 在常设报价范围内   →  自动加入
 ├─ 项目在白名单 但 超出报价/额度      →  落回待审批   ← 不是拒绝
 └─ 项目不在白名单                     →  待审批
```

Four rules, each of which is a decision rather than a detail:

1. **The whitelist keys on `projectRoomId`, never a project name.** The system already
   validates room ids strictly (`ROOM_ID_RE` at `lib/approval-store.js:19`) and
   `bindingKey(agent, projectRoomId)` keys on the room. A name-keyed whitelist would be
   spoofable by any project that renames itself after a trusted one.
2. **Auto-join is still capped.** Whitelisted does not mean unlimited. When a request would
   exceed the standing offer or the agent's ceiling, it **falls back to approval** — the
   project did nothing wrong by asking, so rejecting it would be the wrong signal.
3. **Editing the whitelist is a privilege escalation, not a preference.** Adding a project
   means "your future requests bypass me." It gets the treatment Config gives removal: its own
   section below a divider, and the project name typed out. Precedent for the shape:
   `TRUSTED_HAFLEET_COORDINATION_TOOLS` in `lib/codex-permission-hook.js:15` is a closed
   default-deny set — anything not named is refused.
4. **Removing from the whitelist affects only future requests.** It must not terminate running
   engagements, or de-trusting a project silently kills work in flight. Revoking an active
   engagement is a separate, explicit act with its own confirmation.

Sections:

- **待审批** — everything routed here by the rules above: which project, which role, requested
  budget and rate, and **why it needs me** (not whitelisted / over the offer / over the
  ceiling). **Approving requires allocating a budget**, and the form refuses an allocation that
  would over-commit — enforced at the point of decision, not discovered later.
- **自动加入** — whitelisted engagements that started without me. Listed, not hidden: an
  auto-approval I cannot see afterwards is indistinguishable from a compromise. Each is
  revocable.
- **白名单** — the trust list, below a divider, keyed on room id with the display name beside
  it for reading only.
- **进行中** — active engagements: project, role, the agent behind it, budget allocated versus
  consumed, and the binding's owner.
- **已结束** — with the reason.

**Answered (Q3): the ceiling is per agent.** e.g. one Claude Code agent on Opus, 5,000,000
tokens per month. The consequence the screen has to make visible, and the reason this is not a
global pool:

> An engagement draws on **one agent's** ceiling. Two projects that both want an architect
> served by the same Opus agent **share that 5M** — approving 4M to one leaves 1M for the other,
> and the second approval form must say so before it is submitted.

So over-commitment is computed per agent, and the request queue has to show *which agent would
serve this role* before the decision, not after. A provider with two Opus agents can take both
projects; a provider with one cannot, and that is a hiring signal rather than a scheduling one.

Budget is also where this screen must stay honest: **nothing enforces a ceiling today**, so
allocations are declarations of intent and are labelled as such (§6).

### ⑤ `/usage` — 用量

Per engagement and per agent: tasks touched and their status (real), tokens consumed
(contract). Grouped by project, because the provider's question is *"what did this project
cost me"*.

---

## 5. Rules carried over, because they were right

- **A blank is never a zero.** Every absent number states why.
- **Counts are labelled** — `2 bound`, not `2`.
- **Severity is a dot AND a word.**
- **Destructive actions are exiled** and require typing the name. Revoking a contribution
  qualifies.
- **Selection lives in the URL.**
- **Both locales, or neither.** en + zh, asserted for parity.

## 6. Contracts this design asks for — five, and they are the build

Drawn explicitly, never as if they existed:

1. **`GET /api/frameworks/detect`** — scan and verify installed frameworks. Field-by-field
   contract already written in `dashboard-relayout.md`.
2. **Token ceiling on a preset or agent** — `{ daily, monthly }`, and a rate cap.
3. **Token accounting** — the measurement itself. Without it, ceilings are decoration and
   `/usage` is empty. **The largest gap in the whole design.**
4. ~~Role templates~~ — **written**: `lib/role-capacity.json`, validated against
   `matrix-agent.js`'s constants. Still needs a consumer; the console is it.
5. **Inbound engagement requests** — a record `{ project, projectRoomId, role, requestedBudget,
   rate, requester, status }`, plus approve/reject writing a **per-agent** budget allocation.
   The existing `approval-store` is the pattern: durable, audited, terminal states, TTL — and
   its `binding` already supplies the `(agent, project, room, owner)` half.
6. **The standing offer** — per role: `{ role, count, budgetCapPerEngagement, rateCap,
   published }`.
7. **The whitelist** — `{ projectRoomId, displayName, addedAt, addedBy }`, default-deny, plus
   an audit trail. Both the add and the remove belong in the audit log for the same reason
   `approval-store` audits every verdict: a trust change that leaves no record cannot be
   reviewed after an incident.

## 7. Questions before I build

**Answered:**

- ~~2. Roles: ours or theirs?~~ → the system's existing six, mapped in
  `lib/role-capacity.json`. A provider may narrow, not invent.
- ~~3. Budget granularity?~~ → **per agent**, e.g. Claude Code on Opus, 5M tokens/month. So
  over-commitment is per agent, and the approval form must name which agent would serve the
  role *before* the decision.

- ~~1. Four layers, and is `/engagements` the right dispatch replacement?~~ → yes, with the
  routing in §4④: a **standing offer** for discoverability, a **whitelist** for auto-join, and
  approval for everything else. Falling back to approval rather than rejecting when a
  whitelisted project exceeds its cap is the rule that keeps the two halves coherent.

**Still open:**

1. **Does the mockup keep `/agents/[name]` and `/alerts`** from the current prototype, or is
   this a clean five-screen build? A clean build is ~1,400 lines and drops working, asserted
   surfaces; keeping them means the rail carries seven entries rather than five.

## 8. Explicitly dropped

`/dispatch`, the role×tier capacity grid, leases, the queue, seat modelling, performance
scoring and the knowledge/memory surfaces. All of it assumed we schedule work. We do not.
