---
kind: decision
id: ADR-013
title: "Serve the resource contributor, not the dispatching house"
status: Accepted
liveness: auto
tags: [hafleet, resource-plane, contribution, capacity, metering, engagement]
---

## Amendment 2026-08-11 — the serving agent and its model are transparent, not hidden

Decision 2 made the privacy of the `role → (agent × model)` mapping the boundary the whole
design turned on: "HAgency sees roles, never raw agents … keeping that mapping private to the
provider is what makes this a resource market rather than a remote-shell directory."

**The operator's ruling reverses that: there is no need to hide the coding agent or the
model — they should be made transparent.** This is withdrawn as a design error, not relaxed
as a convenience.

The original argument had it backwards. Hiding model quality does not protect a market, it
produces a **lemon market**: a borrower who cannot tell Opus from a cheap model must assume
the worst and discount every offer accordingly, so the contributor lending a strong
subscription is priced as though they had lent nothing much. For a **contribution** console
that failure is fatal rather than incidental — the whole point is that lending capacity is a
legible contribution, and a contribution nobody can distinguish is not one. Disclosure is
what makes it legible. Reproducibility points the same way: a project reviewing work
produced by an agent has a legitimate engineering need to know which model produced it.

**The boundary moves; it does not disappear.** The line is now between the *capability* and
the *deployment*:

| | |
|---|---|
| **disclosed** | agent name, framework, model, reasoning level, the tier it qualifies at — everything a borrower needs to judge whether the work will be good enough, and to attribute it afterwards |
| **private** | host, workspace path, credential home, seat, API keys, tmux session, owner MXID, environment variable names — the provider's deployment, which tells a borrower nothing about the work and is a standing invitation to probe |

**The request direction is unchanged, and that is what preserves what decision 2 was
actually protecting.** A borrower still asks for a **role** and cannot pick an agent; a named
agent is a hint that is honoured only if it independently qualifies, and refused otherwise.
So the provider keeps full freedom to allocate, substitute and reconfigure. **Choosing stays
the provider's; knowing becomes the borrower's.**

Two facts about the state this replaces, recorded because they are the reason the ruling
matters in practice rather than only on paper:

- The implementation was **accidentally half-transparent**. The auto-join reply already
  named the agent into the project room (`lib/bot-commands.js`), and this deployment's names
  encode the framework — `claude-agent`, `codex-agent`, `octos-agent`. So it leaked the
  identity while withholding the model, the one fact a borrower can act on: the worst of
  both policies.
- The leak was **structural, not textual**. An agent replies in a project room under its own
  Matrix identity (`sendAsAgent` takes that agent's own access token; the MXID is
  `@ac_<name>:server`), so the name is the message sender on every message. Editing the
  reply text would have been theatre. Honouring the *old* decision would have required
  per-engagement anonymous Matrix identities, with their own E2EE devices and key handling —
  a cost this amendment removes rather than pays.

`REQ-CONTRIBUTION-CONSOLE-ROLES` is rewritten to match.

## Amendment 2026-08-10 — pricing is out of scope

Section 8 originally listed R8's `PriceBook` and `BillingSource` among the PRD models
**retained and load-bearing**. That was wrong and is withdrawn.

The operator's ruling: HAFleet's unit of account is the **token**. It answers how much
capacity was lent and to whom. Converting tokens to money depends on the contract, the
plan, the region and the negotiated rate — none of which HAFleet observes — so it is a
separate problem for a separate system.

The implementation had already voted this way and the ADR had not noticed: every
interface is denominated in tokens (`budgetCapPerEngagement`, `rateCap`, `quotaTokens`,
`requestedTokens`, `allocatedTokens`), and `currency` appears zero times in
`backend-v2.js`, `lib/seat-store.js` and `lib/engagement-store.js`. Contract 1 was always
written as **Token** metering.

The subscription case shows the confusion was semantic rather than a missing feature: on
a fixed plan the marginal cost of a token is zero, so a per-engagement "cost" is a share
of a bill paid regardless — an allocation with no rate. Presenting that beside a metered
charge would invite a comparison that means nothing.

`lib/cost-model.js` and its test have been **deleted** (2026-08-10). An earlier version of
this amendment kept them in the tree, unwired, "for one verified finding". That was the
wrong call twice over: 430 lines implementing precisely the conversion this ADR withdraws
is a standing invitation to wire it up, and code is a poor place to store a finding — the
finding is a sentence, and the sentence is here:

> Pricing cache reads at the fresh-input rate overstated a real session by **7.79×**.
> Cache reads run orders of magnitude above fresh input in volume and below it in rate, so
> any future pricing work must price the four token kinds separately. A single blended rate
> is not an approximation of this; it is wrong by most of the total.

That is the whole of what the module was being kept for, and it survives its deletion. Its
one non-pricing export, `TOKEN_KINDS`, was a duplicate of `KINDS` in
`lib/metering/parsers.js`, which is the copy every live caller already used.

## Requirement

Derived into `REQ-CONTRIBUTION-CONSOLE`
(`knowledge/requirements/req-contribution-console.md`), which carries the MUST-form
statements and scenarios implementation is linked to. Contract 1 (token metering) has no
requirement statement yet and is recorded there as an open question, because a
requirement for a measurement nobody can take would be unmeetable by construction.

## Context

Every prior design of the HAFleet console assumed its user is **the house that dispatches
workers**: a PDU manager staffing projects. `docs/PRD-hafleet-pdu.md` v0.2 states that product
directly — HAFleet "accept[s] scoped staffing requests … and return[s] auditable assignments",
"analogous to a digital-employee outsourcing house or PDU" — and R0 builds an
`AssignmentRequest` / `StaffingAssignment` contract on top of it.

The operator has ruled that this is the wrong user. HAFleet's user is the **resource
provider**: 带资入组的开源贡献者 — somebody who contributes to a project not by writing code
but by lending agent capacity. They own Claude Code, Codex, Hermes, Octos installations. They
want to expose that capacity to a community and control exactly what they lend, in which
configuration, and at what cost to themselves. Two directives followed: dispatch is no longer
ours to build, and every layer of the design must be verified against what the system already
contains rather than invented.

The PRD anticipates this record. §2.1 requires that "Phase 0 must accept an amending or
superseding ADR"; §R0 requires that "Phase 0 must establish a separate Project Assignment
Requester ADR/REQ". This is that ADR, and it supersedes the dispatch half of the PRD rather
than the whole document.

The design was then grounded item by item against the implementation baseline. Four findings
shape the decisions below, and each is load-bearing:

- **The role vocabulary already exists and is already unenforced.** Six roles, three tiers,
  per-role default tier and tier subsumption are a real constant at `lib/matrix-agent.js:11-35`,
  including the cross-family review rule at `:26`. But `ROLES` at `:14` is never imported by the
  backend; `agentRole()` returns `agent.role` unvalidated. The vocabulary is a shared
  understanding with no enforcement point.
- **Model configuration is a real, persisted, API-backed record.** `normalizeRuntimeProfileRole()`
  at `backend-v2.js:713` accepts exactly
  `{ framework, provider, model, reasoning, extraArgs, apiBaseUrl, apiKey }`, shell-metachar
  validated. Named reusable configs persist through `backend-v2.js:2920-2921` and resolve by
  `presetId` at `:8146-8151`. `reasoning` already carries Codex thinking levels, so nothing about
  configuration needs new schema.
- **The contribution record already exists under another name.** `upsertBinding()` at
  `lib/approval-store.js:186` stores `{ agent, project, projectRoomId, ownerMxid, ownerDmRoomId,
  active }` — precisely the tuple a contribution needs. An earlier reading of this file was wrong
  and is corrected here: `createRequest()` is **per-tool-call** permission with a 5-minute TTL, not
  project-requests-agent. Its durability, audit trail and terminal states are the pattern for the
  new engagement flow; they are not the flow.
- **Nothing measures tokens, at any granularity.** Every `usage` and `budget` match in `lib/` and
  `backend-v2.js` is a CLI help string.

One further fact was found late and reorders the build: **capacity is physically per credential
home, not per agent.** `bin/hafleet-up:1640-1644` unsets `ANTHROPIC_API_KEY` for Claude agents
unless a per-agent runtime profile supplies one explicitly, and `$HOME` is never reassigned in the
launch path. So Claude agents share the operator's authenticated subscription and its quota by
default; API-key mode is the deliberate exception. Registering more agents does not add capacity.
The PRD already models this correctly as `Seat` / `SeatBinding` / `BillingSource` (R8), which
survives this ADR intact.

**Numbering.** `knowledge/decisions/` holds `adr-001`…`adr-009`. The PRD records
`adr-011-backend-owned-ephemeral-runner-sessions` and `adr-012-agent-operations-client-access` as
Accepted in a review checkout absent from this repository, and flags `adr-010` as unaccounted for.
This record therefore takes **013**, the first number that cannot collide with the review
checkout. The `adr-010` gap remains unresolved and is not closed by this document.

## Decision

**1. The console is inward-facing and answers the provider's question.** It answers "what am I
offering, on what terms, and what is it costing me" — never "who is working on what". Nothing in
it schedules work. The scheduler, the role×tier capacity grid, leases, the queue, seat-selection
UI, performance scoring and the knowledge/memory surfaces are withdrawn.

**2. Four layers, and L2 is the only one that faces outward.**

| layer | name | content |
|---|---|---|
| L1 | 资源 Resource | my agents, their model configuration, their declared ceiling |
| L2 | 能力 Capability | role templates: which `(agent × model)` combinations qualify |
| L3 | 接洽 Engagement | standing offer + whitelist → auto-join, else approve/reject with a budget |
| L4 | 用量 Consumption | what my agents did, for whom, and how many tokens it took (see the 2026-08-10 amendment: not what it cost in money) |

The boundary that matters: **HAgency sees roles, never raw agents.** A project asks for a System
Architect, not for `octos-agent running kimi-k3`. Keeping that mapping private to the provider is
what makes this a resource market rather than a remote-shell directory.

**3. The role vocabulary is the system's own; a provider may narrow it but not extend it.**
`lib/role-capacity.json` is the mapping from role to qualifying `(framework, model, reasoning)`
combinations. It reproduces `matrix-agent.js`'s six roles, their default tiers and tier subsumption
unchanged, and adds only the enumeration the code lacked — which non-Claude combinations qualify at
each tier, since `TIER_RUNTIME` maps a tier to one Claude pair and leaves a contributor lending Kimi
K3 nothing to match against. Exclusions are named with their reason rather than omitted, because a
role card that silently lacks a model reads as an oversight. The file ships with the product: a
provider may decline to offer a role or a combination, but may not invent a role name, because the
project side must recognise it for the vocabulary to mean anything. When this was written the file had **no consumer**. It now has five —
`backend-v2.js`, `lib/matrix-agent.js`, `lib/dashboard/render/pool-page.js`, the
console's capability page, and the role tests — so the vocabulary is single-sourced as
intended rather than restated per surface.

**4. 接洽 replaces dispatch, gated by a whitelist.** A standing offer makes the provider
discoverable; a whitelist decides who may skip them.

```
request arrives
 ├─ whitelisted AND within the standing offer   →  auto-join
 ├─ whitelisted BUT over the offer or ceiling   →  falls back to approval   (not rejection)
 └─ not whitelisted                             →  awaits approval
```

Four rules, each a decision rather than a detail:

- **The whitelist keys on `projectRoomId`, never on a project name.** Room ids are already strictly
  validated (`ROOM_ID_RE` at `lib/approval-store.js:19`) and `bindingKey()` already keys on the
  room. A name-keyed whitelist is spoofable by any project that renames itself after a trusted one.
- **Auto-join stays capped.** Whitelisted does not mean unlimited. A request exceeding the offer or
  the ceiling falls back to approval, because the project did nothing wrong by asking and rejecting
  it would be the wrong signal.
- **Editing the whitelist is privilege escalation, not a preference.** Adding a project means "your
  future requests bypass me". It gets the treatment destructive actions get, and both the add and
  the remove are audited — for the same reason `approval-store` audits every verdict.
  `TRUSTED_HAFLEET_COORDINATION_TOOLS` at `lib/codex-permission-hook.js:15` is the precedent for
  the shape: a closed, default-deny set.
- **Removing a project affects only future requests.** It must not terminate running engagements.
  Revoking an active engagement is a separate, explicit act with its own confirmation.

**5. Ceilings are declared per agent and enforced per seat.** The operator's ruling is that a
budget is a per-agent quantity — e.g. one Claude Code agent on Opus, 5,000,000 tokens per month.
Two consequences the implementation must carry rather than paper over:

- An engagement draws on **one agent's** ceiling, so two projects wanting an architect served by
  the same agent share it. The approval form must name which agent would serve the role and refuse
  an over-committing allocation **at the point of decision**, not after.
- Because Claude agents share one credential home by default, a per-agent ceiling is an
  **allocation policy over a shared seat, not an independent quota**. Two agents each declaring 5M
  against one subscription do not have 10M. The seat is therefore the accounting root and the
  agent ceiling is a sub-allocation of it; a declared ceiling that exceeds its seat's remaining
  quota must be surfaced as over-subscription rather than silently accepted.

**6. A blank is never a zero.** Every absent number states why, in place. This is not a UI
preference — a `0` where nothing is measured claims a measurement nobody takes, and the PRD already
requires it independently at A-R7-3 ("missing provider usage is rendered as `unknown` … never as
zero"). Allocations, which are known, are kept strictly separate from consumption, which is not.

**7. The next round builds five contracts, in this order.**

| # | contract | why here |
|---|---|---|
| 1 | **Token metering** — observed consumption per agent, per engagement | Gates the other four. Without it a ceiling is a decoration and L4 is empty. |
| 2 | **Seat record and ceiling field** — the seat itself, plus a ceiling and rate cap on preset/agent that references it | Larger than it reads. A gap audit found `seat`, `credentialHome`, `planType` and `quota` have **zero** occurrences in `lib/` and `backend-v2.js`, so the accounting root §5 depends on must be created, not merely associated. |
| 3 | **`GET /api/frameworks/detect`** — scan and verify installed frameworks | Independent of 1–2 and may land in parallel; unblocks the wizard's first step. |
| 4 | **Inbound engagement request** — `{ project, projectRoomId, role, requestedBudget, rate, requester, status }`, with approve/reject writing a per-agent allocation | Reuses `approval-store`'s durability, audit and terminal-state pattern; `upsertBinding()` already supplies the `(agent, project, room, owner)` half. |
| 5 | **Standing offer and whitelist** — `{ role, count, budgetCapPerEngagement, rateCap, published }` and `{ projectRoomId, displayName, addedAt, addedBy }`, default-deny, both audited | The discoverability and trust surfaces; meaningless before 1–4 exist. |

Role templates were the sixth contract and are **already written** (`lib/role-capacity.json`), so
they are not in the build list; they need a backend consumer, which item 4 supplies.

A subsequent gap audit against the backend added a **contract zero** these five omit: the console
makes no backend calls at all, so the integration layer itself does not exist. It also found that
the role vocabulary has four divergent copies and that role eligibility is currently inferred from
the agent's *name* rather than its model. Both are prerequisites to item 4 and neither is a new
domain record. The phased sequence, per-endpoint shapes, evidence and verification strategy live in
[`../../docs/PLAN-console-api-integration.md`](../../docs/PLAN-console-api-integration.md), which is
the implementation plan for this table.

**8. What this withdraws from `docs/PRD-hafleet-pdu.md`.** Withdrawn: the PDU/outsourcing-house
product statement, R0's `AssignmentRequest` / `StaffingAssignment` contract, `/api/dispatch` and
any successor router-facing assignment path, and the staffing-request direction of travel.
**Retained and now load-bearing:** R7's usage accrual with A-R7-3's unknown-never-zero rule,
R8's `Seat` / `SeatBinding` / `BudgetReservation` model, and R12's roster acceptance written
against the running prototype. **Also withdrawn (amended 2026-08-10):** R8's `PriceBook` and
`BillingSource`, and the monetary half of R7's usage/cost accrual — HAFleet's unit of account is
the token, and token-to-currency conversion is out of scope. R7's accrual is retained in tokens. The PRD must be revised to v0.3 to record
this split; until then its dispatch requirements are not implementable and must not be scheduled.

The console is a running Next.js prototype under `mockup/`, published at
`hagency-org.github.io/HAFleet`, with 90 static and 31 in-browser assertions run before export. It
is the executable form of this decision and acceptance for the round should be written against it.

## Consequences

Good, because the console now serves a user who exists. A resource provider can answer what they
are lending, in which configuration, to whom, and under what cap — none of which the dispatch
design answered.

Good, because L1 and L2 are almost entirely already-shipped fields. Model configuration, presets,
framework manifests and the role vocabulary all exist, so the round's cost concentrates in L3 and
L4 rather than being spread across four layers.

Good, because `role-capacity.json` finally gives the role vocabulary an enforcement point.
`ROLES` being imported by nothing is a latent correctness bug independent of this design.

Good, because naming the seat as the accounting root turns a hidden over-subscription into a
visible one. A provider who declares 5M on each of two agents sharing one subscription learns it
from the console rather than from an exhausted plan.

Good, because falling back to approval instead of rejecting keeps auto-join and capping coherent.
A whitelisted project that asks for too much is not misbehaving.

Bad, because token metering is a genuine measurement problem, not a schema addition. Interactive
subscription sessions do not report per-call usage the way an API does, so item 1 may only be
satisfiable approximately, or only in API-key mode. Until it lands, every ceiling in the product is
a declaration of intent and must be labelled as one.

Bad, because per-agent ceilings over a shared seat are a two-level accounting model, which is
harder than either level alone. The alternative — accounting only per seat — was rejected against
the operator's ruling, so the complexity is accepted deliberately.

Bad, because withdrawing R0 invalidates PRD phase and release-gate content that other workstreams
may already be planning against. The split in §8 is the mitigation, and it needs the PRD revision
to be real.

Bad, because a provider narrowing `role-capacity.json` while the project side reads the shipped
version creates a version-skew question this ADR does not answer. It becomes a real problem only
when a second provider exists.

## Alternatives Considered

- **Keep the PDU/dispatch design and add a provider view beside it.** Rejected: the two designs
  disagree about who decides which agent does which task, and shipping both would put that
  contradiction in the product. The operator's directive was explicit that dispatch is out.
- **Invent a richer role taxonomy fitted to the provider's marketing.** Rejected: the project side
  must recognise the role for the vocabulary to be worth anything, and `matrix-agent.js` already
  defines six roles with tiers and subsumption. Provider control is expressed as narrowing.
- **Account for capacity per seat only, dropping per-agent ceilings.** Simpler and closer to the
  billing reality, but rejected against the operator's ruling: a provider reasons about "my Opus
  agent", not about a credential home, and per-agent is the unit they can act on.
- **Auto-join with no whitelist, or approval with no auto-join.** Both rejected: pure approval
  leaves a provider idle waiting for invitations, and pure auto-join hands unbounded spend to
  anyone who asks. The whitelist plus a cap is the smallest mechanism that avoids both.
- **Key the whitelist on project display name for legibility.** Rejected as spoofable; the display
  name is carried beside the room id for reading only.
- **Render unmeasured consumption as `0` and refine later.** Rejected: a zero is a false
  measurement, and it would let the dashboard look complete precisely where it is emptiest.
- **Defer metering and build the visible surfaces first.** Tempting, because L3 and L5 demo well.
  Rejected: ceilings, allocations and over-commitment checks all resolve to decoration without a
  measurement behind them, so the round would end with a console that cannot enforce anything it
  displays.
