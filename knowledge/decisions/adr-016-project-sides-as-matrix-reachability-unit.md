---
kind: decision
id: ADR-016
title: "Project sides are the unit of Matrix reachability; agents are minted per engagement"
status: Accepted
liveness: auto
tags: [matrix, identity, provisioning, intake, budget, federation]
---

## Implementation status 2026-08-13

**Nothing below is built.** This record exists because four questions were put to the operator and
answered; it captures the answers and derives what they imply, before any code moves. Per ADR-014's
own correction, present-tense declarative for unbuilt work is a correctness defect, so every decision
carries its own status line and the table is the index.

| # | decision | status | evidence for the gap |
|---|---|---|---|
| 1 | 项目方 (project side) is a first-class entity: one homeserver, one credential, one representative | **decided, not built** | no such record exists; `HOMESERVER` is one module constant with **51** product-code references (`bridge-matrix.js` 44, `lib/bot-commands.js` 7) plus 12 in tests, at `8c78a7e` |
| 2 | non-federation is the assumption; federation is an optimization inside the same model; **both** credential kinds are supported | **decided, not built** | ADR-014's amendment says the opposite — see "What this reverses". Appservice support is mandatory per the operator (2026-08-13) and the repository has zero of it: no `as_token`, `hs_token`, `sender_localpart` or registration file, and the running bridge holds zero listening sockets |
| 3 | the representative is registered per project side and is NOT an agent | **decided, not built**; in the first pass | the two roles are one thing today: the agent itself must be invited and must join |
| 4 | an agent instance is minted on acceptance from a resource declaration | **decided, not built** | `POST /api/dispatch` Phase 4 returns a `provision` plan, but gated on agent COUNT and unaware of any project side |
| 5 | the invite object is a room alias plus `knock` | **decided, not built** | `joinRoomByAlias`, `room_alias`, `matrix.to`, `inviteToken`, `joinCode` — zero matches repository-wide |
| 6 | budget is admission control, and provisioning becomes a new admission point | **partly decided, partly built** | approval-time admission is built and tested; provisioning-time admission does not exist — Phase 4 never consults the ledger |
| 7 | deleting a project side cascades, but RETIRES agents rather than erasing usage | **decided, not built** | there is no project-side record to delete, and no agent retirement path (`deleteAgent` is a dashboard button over the agent roster) |
| 8 | a project side's credential is write-only through the console | **decided, not built** | a new secret class: `cf.ownSecrets` covers install-time `.env` secrets only |

## What this reverses, and why that is stated first

ADR-014's 2026-08-11 amendment made the opposite scoping decision, in the same words this ADR now
inverts:

> **federated invite** (normal) | the servers federate and the project does not require local
> accounts | nothing — only the decision to accept

and, explicitly:

> project-issued-token mode without federation needs a project-level **bot** credential as well —
> and with it a second crypto store, a second device and a second E2EE state machine, doubling the
> ADR-008 surface. Non-federating homeservers are therefore **out of scope** until a real project
> requires one.

The operator's ruling of 2026-08-13: **do not assume federation. Assume the project's Matrix does
not federate; the agent must be registered there. Federation is a subset optimization.**

So non-federating homeservers move from out-of-scope to the default case, and the cost the amendment
priced is the cost this ADR accepts. Two corrections to that pricing, both measured rather than
assumed, because the amendment's estimate is what justified deferring the work:

- **Agent accounts are cheap.** `sendAsAgentContent` is a raw
  `PUT /_matrix/client/v3/rooms/{id}/send/m.room.message/{txn}` with a bearer token and no crypto
  path — HAFleet's agents have never been E2EE participants. An agent on a foreign server therefore
  needs a token and a base URL, not a crypto store.
- **`matrixRegister` already speaks the mechanism.** It implements
  `{ type: 'm.login.registration_token', token, session }` against the UIA flow. Minting agent
  accounts from a credential the project side issues is a **parameterization** of existing code —
  `HOMESERVER` and `REGISTRATION_TOKEN` become arguments — not a new subsystem.

What the amendment got right is that the **representative** is where the cost sits: the bot is the
E2EE sender and the holder of the single crypto store, and it creates rooms with
`m.room.encryption` unless a plaintext test flag is set. Decision 3 addresses that directly and
names the one question it leaves open.

This ADR also settles the shape of ADR-014 decisions 4 and 5 for the second time. The original put
the credential on the agent; the amendment moved it to `(project, agent)`; this moves it to
`(项目方, agent)` — see decision 1 for why a room cannot own a credential.

## Context

The operator's question, which the existing design cannot answer:

> 我们在 hafleet 定义了 contributions resource 然后据此定义了 agent，但是这个 agent 需要加入 matrix
> 房间吗？…现实中，项目可能在不同的 matrix home server，agent 在没有接受项目邀请之前是不知道加入哪个
> home server，所以你先创建了 biglittle 的 matrix id 是错的。

This is a real circular dependency, not a misreading. `agentUserId(name)` composes
`@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}` through `makeUserId()`, where `MATRIX_SERVER_NAME`
derives from the single `HOMESERVER` constant. An agent identity therefore exists **before** any
project is known, on **HAFleet's own** server. Under decision 2 that identity is unusable for any
project that does not federate with us — which is now the assumed case.

Three further facts, verified, that the design has to absorb:

- **The backend holds the same flat shape as the bridge.** `backend-v2.js` declares
  `const agentTokens = new Map(); // agentName → token string`. ADR-014 decision 4's evidence cites
  only `state.agentTokens` in the bridge; the backend has an independent copy of the same
  assumption.
- **Auto-provisioning exists and is budget-blind.** `POST /api/dispatch` Phase 4 returns
  `{ status: 'provision', role, tier, name, runtime }` when a `(role, tier)` cell is below
  `MATRIX_AGENT_MAX_PER_CELL`. The gate is a **count** of agents; nothing consults the ledger, and
  the generated name is `mx_${role}_${tier}_${seq}` with no project side in it. So the skeleton of
  what the operator asked for is present, and the two things they asked it to do — budget refusal
  and project attribution — are both absent.
- **Project identity degrades to a room id.** `const project = groupForRoom(projectRoomId) ||
  meta.group || projectRoomId;` — no project *name* is ever recorded, which is why all three
  bindings in this deployment display raw room ids.

## Decision

**1. 项目方 (project side) becomes a first-class entity, and it is the unit of Matrix
reachability.** A project side is: one homeserver (server name plus discovered API base URL), the
credential HAFleet holds there, and one representative account. The operator's framing — 「类似外包
公司在客户那边注册了一个接单资质」 — is the definition, not an analogy: what is registered is a
standing capacity to take work, held by the firm and not by any individual worker.

The cardinality that follows:

```
项目方 ProjectSide     = homeserver + credential + representative     (registered once)
  └── 项目 Project      = a room on that homeserver                    (many per side)
        └── 接洽 Engagement = an accepted request, with a budget         (many per project)
              └── agent instance = an MXID on that side's homeserver    (one per engagement)
```

**Why the credential belongs to the side and not to the project**, which reverses ADR-014's
amendment a second time: a homeserver issues accounts; a room does not. Two project rooms on one
homeserver are reachable through one registration credential, so keying credentials on the project
multiplies them by rooms-per-server for no gain — and, decisively, it cannot express the fact the
operator asked to store: *we are registered here*. That fact is about the server.

*Status — **decided, not built**.*

**2. Non-federation is the assumption; federation is an optimization inside the same model, not a
separate mode.** ADR-014's amendment offered three modes (federated invite / appservice /
project-issued tokens) with the federated one marked normal. That table is withdrawn. There is one
model — a project side, a credential, a representative, minted agent accounts — and federation
becomes a single permission inside it: **where the project's server federates with an existing
agent's server, that identity MAY be reused instead of minting a new one.**

Recorded as a flag on the agent instance (`reusedIdentity: true`) rather than as a branch in the
flow, because a second flow is a second set of failure modes and the amendment's own experience is
that the cheap mode becomes the only tested one.

AppService does not disappear; it stops being a *flow* and becomes a **credential kind** on the
project side (`{ kind: 'appservice', asToken, namespace }` versus
`{ kind: 'registrationToken', token }`). Both mint accounts on that side's server; they differ in
what the project installed, not in what HAFleet does afterwards.

*Status — **decided, not built**.*

**3. The representative is registered per project side, and it is NOT an agent.** The chicken-and-egg
dissolves at exactly this split, so it is the load-bearing decision of this record:

| | 代表 representative | agent instance |
|---|---|---|
| purpose | be registered on the project's server; receive requests; invite and join | do the work |
| lifetime | as long as the project side is configured | one engagement |
| how many | one per project side | one per engagement |
| draws budget | no | yes |
| has a role | no | yes |
| holds | the side's credential | one minted access token |

An agent identity **cannot** be minted before the project side is known, because the server name is
part of the identity. The representative is what makes the project side known while no agent exists.
Today both roles are collapsed — the agent itself must be invited and must join — which is precisely
why an identity had to be created first, and why `@ac_biglittle:palpo.test` only worked because
`MATRIX_HOMESERVER` happened to be the project's own server.

The operator's guess that this is what the bridge already does is half right: the bridge bot performs
the representative's *functions* (sync, invite polling, room state) but is configured as HAFleet's
single global bot, one per deployment rather than one per project side.

**Configuration is a prerequisite, in the operator's order:** HAFleet configures the representative's
admission first (「hafleet 需要先配置代表的加入」), then requests can arrive. Nothing about intake works
before a project side exists.

**What this used to cost, and no longer does.** A representative that must read an **encrypted**
intake room needs its own device and crypto store — the doubling ADR-014 feared. **Settled
2026-08-13: intake rooms are plaintext**, so the representative is an ordinary account holding a
token, and that cost is gone. The reasoning is under "Questions settled" below; in short, HAFleet's
agents send plaintext unconditionally, so requiring it of intake rooms makes an existing constraint
explicit rather than imposing a new one.

*Status — **decided, not built**. The plaintext-intake question that gated its cost is **closed**.*

**4. An agent instance is minted on acceptance, from a durable resource declaration. Manual creation
stops being the mechanism.** The operator's definition is adopted verbatim: a resource is 「coding
agent + 模型 + 思考深度 + token 预算的总和」. That declaration is durable, local to HAFleet, and is
ADR-013's L1/L2. An **agent instance** is the dispatched embodiment of a resource against one
engagement, and is L3.

This is a return to ADR-013's own layering rather than a new idea, which is the strongest argument
for it: the implementation placed the agent instance at L1 (created by hand, ahead of demand,
long-lived), and the accepted ADR puts engagements at L3. Requiring a contributor to guess demand in
advance is the symptom of that misplacement.

Flow: request arrives at the representative → whitelisted, or approved by the operator → role and
tier resolved from the request → resource declaration selected → **admission checked (decision 6)** →
account minted on the project side's homeserver → engagement bound.

Two constraints on this:

- **Reuse is an optimization, never the mechanism.** A warm instance has real value — context,
  no start-up cost — so reusing an idle instance of the same resource on the same project side is
  permitted. It must not be the path by which agents come to exist.
- **Names must carry the project side.** `mx_${role}_${tier}_${seq}` is not attributable to a
  project side, and under decision 7 the cascade needs exactly that attribution.

*Status — **decided, not built**. Phase 4 is the skeleton; it is count-gated, budget-blind and has no
project side.*

**5. The invite object is a room alias plus `knock`.** The project publishes
`#its-project:its-server` and sets the join rule to `knock`; HAFleet's representative knocks; the
project accepts. This is the operator's 「邀请码 / 邀请 link」 in native Matrix terms — an alias is a
shareable, human-readable, server-scoped handle, and a knock is a pull rather than a push, which
matches the intake direction the design already has.

It does **not** replace approval. ADR-014's amendment stands unchanged: 「joining a Discord costs the
joiner nothing. Lending an agent spends tokens.」 An alias makes the project *findable*; the
contributor's approval is still a deliberate, audited act, and never a link click.

*Status — **decided, not built**. Nothing in the repository joins by alias or knocks.*

**6. Budget is admission control, not a circuit breaker — and provisioning becomes a new admission
point.** The operator ruled 准入控制 over halt-and-resume, so `tests/enforcement-spend.test.js`
stands unchanged, including its central assertion:

> refuse new auto-joins against an exhausted ceiling, and NEVER stop a running agent. Killing an
> agent at its cap converts a budgeting decision into lost work.

What changes is *where* admission is checked. Minting an agent is a new gate, and it is the one the
operator named: 「如果 token 预算已经超标了…这时候应该报警，说无法创建 agent，需要加预算」. Two ceilings,
both of which must pass before an account is minted:

| ceiling | question | exists? |
|---|---|---|
| HAFleet's own total | can this deployment afford another agent at all? | `remainingFor(agent)` exists; nothing calls it from a provisioning path |
| the project side's allocation | can this project side afford this request? | no per-side allocation exists |

A refusal is an **alarm naming the shortfall**, not a queue entry: an agent that was never created
cannot be waited for, and Phase 4's current fallback — silently enqueue a ticket — would present
"waiting for capacity" when the truth is "will never be created without more budget".

`POST /api/engagements` already accepts `requestedTokens` and `ratePerDay`, so the operator's
question 「项目请求的时候是否也要加上预算需求」 is answered: it already does, and the missing half is
that provisioning never reads it.

**A consequence of choosing admission control that must not surprise anyone.** A running engagement
CAN exceed its ceiling, because we refuse to stop it. This is not hypothetical — this deployment
measured 984,016 drawn against a 10M ceiling on the fresh-token basis, and roughly 136% of it on the
cache-read-inclusive basis. So the console acquires a **display obligation**: it must show the
overrun as an overrun. A ceiling that is admission-only and rendered as though it held is the console
asserting a guarantee the enforcement model deliberately does not make.

*Status — **partly built**. Approval-time admission is built and tested; provisioning-time admission,
per-side allocation, the alarm, and the overrun display are not.*

**7. Deleting a project side cascades to its agents — but "delete" means RETIRE, and usage is never
erased.** The operator's requirement is adopted: 「删除项目方的时候，需要保证所有在项目方服务的 agent 都
需要一起删除」. It is necessary rather than tidy — those agents' MXIDs live on that side's homeserver and
their tokens were minted from its credential, so leaving them behind leaves identities that cannot be
reached, cleaned up, or revoked once the credential is gone.

**Why deletion must not erase consumption.** ADR-013 makes the token the unit of account and L4 the
record of it. If removing a project side erased its agents' consumption, a closed period's totals
would change retroactively and the ledger would become falsifiable by deletion — the accounting
equivalent of shredding invoices to reduce a balance. So a cascade:

- ends active engagements on that side (they are unreachable the moment the credential goes)
- releases their **committed** budget, which is a promise and should be freed
- deactivates bindings — ADR-002 ownership records are evidence of who invited what, and are kept
- retires agent identities: deactivated, unable to be dispatched, MXID retained for attribution
- **keeps every ledger row**, still attributed to the retired agent

**Order is load-bearing.** End engagements → release commitments → deactivate bindings → retire
identities → forget the credential, last. Forgetting the credential first orphans everything that
needed it: leaving rooms, revoking tokens, and any farewell to the borrower all require the token
that deletion would already have destroyed.

**Refuse by default when work is live.** With active engagements, deletion is refused and requires an
explicit force, because the party who loses is the borrower, who is not in the room when the operator
clicks.

*Status — **decided, not built**.*

**8. A project side's credential is write-only through the console.** The operator asked for CRUD
over project sides, which necessarily puts a **secret** — a registration token or an `as_token` —
into a store a browser can write. That collides with the console's own stated principle:

> HAFleet 自身的密钥——API_TOKEN、各 Agent 令牌、MATRIX_REG_TOKEN——在安装时一次性写入权限为 600 的
> .env。它们刻意不允许从浏览器修改：一个能改写自己认证令牌的面板，也就是一个能把所有人锁在门外的面板。

The collision is real but the reasoning does not transfer, and the difference is worth stating rather
than glossing: that rule protects HAFleet's **own** authentication, where a browser-writable value
can lock the operator out of the console itself. A project side's credential is **inbound work
capacity** — a bad value costs one project side's reachability and locks nobody out. So it may be
set from the console; the constraint is on reading:

- **write-only**: settable and replaceable, never returned by any API, never rendered
- state is reported as a **verdict, not a value** — accepted / rejected / unreachable, with the time
  it was last checked, which is the shape ADR-014 decision 6 already established for agent
  credentials
- naming must respect the health writer's redaction guard, which refuses any key matching
  `/credential/` — ADR-014 decision 6 hit this and renamed to `unprovisionedAgents`; a project-side
  field named `credentialState` would be silently dropped from the health record

*Status — **decided, not built**.*

## Consequences

Good, because the circular dependency is genuinely gone rather than worked around: identity is minted
after the server is known, which is the only order that can work when servers do not federate.

Good, because auto-provisioning becomes possible **as a consequence of decision 1**, and this is the
non-obvious payoff. Under ADR-014's amendment a project handed over one token per
`(project, agent)` — so creating an agent required a human on the project side to act first, and
automatic creation was structurally impossible. A registration credential held per project side is
what lets HAFleet mint accounts on demand. The operator's answers to questions 2 and 4 are load-bearing
for each other.

Good, because the cost is smaller than ADR-014 priced it: agents need no crypto store, and
`matrixRegister` already implements the registration-token flow.

Bad, because `HOMESERVER` must stop being a constant. Measured at `8c78a7e`: **51** product-code
references — 44 in `bridge-matrix.js` and 7 in `lib/bot-commands.js` — plus 12 in tests. ADR-014
decision 4 classified the bridge's 44 as 18 agent-side, 16 bot-side or global, and 10 that take
whichever token their caller holds; that third bucket is the expensive one, since those functions need
a base URL passed alongside the token, which is a signature change rather than a lookup.

Two notes on that measurement, because ADR-014 warned that a reference count in a decision record is
a snapshot. The bridge's 44 has **not** drifted since 2026-08-11 — the same number, two days and
several merges later. But decision 4's classification is incomplete by one file: `lib/bot-commands.js`
holds 7 references and its own `MATRIX_SERVER_NAME` derivation, and constructs human MXIDs as
`@${humanName}:${MATRIX_SERVER_NAME}`. Those were never classified, so the real scope is the 44 plus
a file nobody has triaged.

Bad, because the representative multiplies per project side: N project sides means N syncs, N invite
polls, N rate-limit budgets, N sets of retry state — and, if the plaintext-intake question resolves
the other way, N crypto stores.

Bad, because retirement is a new lifecycle state, and every surface that lists agents must learn the
difference between "gone" and "retired but still owns history". A console that shows retired agents
in the roster is confusing; one that omits them from usage is wrong.

Bad, because admission control leaves overruns possible by design, and the honest console is
therefore one that displays a figure over 100%. This will look like a bug to anyone who has not read
this decision.

## Alternatives Considered

- **Keep federation as the normal case (ADR-014's amendment as written).** Rejected by operator
  ruling. The substantive argument against it is not preference: a project's homeserver federating
  with the contributor's is a property of someone else's infrastructure, so a design that requires it
  works only where we are lucky, and its failure mode is invisible — the representative simply never
  sees the room.
- **One agent identity per project side, shared across that side's projects.** Rejected. The Matrix
  constraint permits it — one identity can hold many rooms on one server — but ADR-013's transparency
  amendment requires the borrower to know which agent and model serves them, and per-engagement
  budget accounting needs per-engagement attribution. One shared account collapses both. Noted
  because the operator's inference 「一个 agent 只能同时服务一个 project/home server」 is true of
  *servers* and not of *projects*: the binding constraint is one identity per homeserver, and
  per-engagement identities are a deliberate accounting choice on top of it.
- **Halt and resume on budget exhaustion.** Rejected by operator ruling in favour of admission
  control. Recorded because it was seriously considered and has a real advantage — it is the only
  option that makes a ceiling a guarantee — and because resuming would have required defining
  whether a halted agent continues or restarts, which no CLI session model here supports.
- **Erase agents and their usage when a project side is deleted.** Rejected: it makes the ledger
  falsifiable by deletion. See decision 7.
- **Per-project credentials (ADR-014's amendment shape).** Rejected: a room does not issue accounts,
  and the shape cannot express "we are registered on this server".
- **A HAFleet-hosted intake room that projects join instead.** Rejected as a reversal of the intake
  direction: it requires every project to have an account on our server, which is the same
  account-creation privilege problem ADR-014 rejected, pointed the other way.

## An unresolved collision: approval rooms live on the contributor's server

Found 2026-08-13 while auditing what still assumes a single homeserver. Recorded rather than fixed,
because the fix is a decision.

An approval room is created by the BOT — `this.botClient.createRoom` — and the bot keeps one
homeserver by ADR-014 decision 4's explicit split. So every approval room is on the CONTRIBUTOR's
server. An agent minted for a project side (decision 4 here) has an account on THAT side's server, and
decision 2 stops assuming federation. **Such an agent cannot join its own approval room.**

Passing the agent's own base URL does not help: the room does not exist on the agent's server.

**A CORRECTION TO THIS SECTION, 2026-08-13.** It previously said "the immediate damage is bounded and
has been removed". **That was false when written.** The decorative join was made best-effort, and the
claim was recorded — while the same collision continued two lines later in the same function, in a
worse form.

`onApprovalRequested` does `const token = this.getAgentToken(approval.agent)` and throws
`missing Matrix token for approval agent` if there is none, then calls `sendAsAgentContent`, which read
a hardcoded `HOMESERVER`. For a project-side agent that presented a project side's token to the
contributor's homeserver; for an **appservice** side — where this ADR's own settled question 6 says the
agent holds no credential at all — the throw fires immediately. Either way the catch posts
`delivery-failed`, which calls `denyPending`, and **the request is denied.**

The user-visible sequence is worse than the failure it replaced, because the private send happens
first: the owner receives a fully rendered approval request with Approve and Deny buttons, the request
is silently denied behind them with no message posted in any room, and clicking Approve returns
`not_pending` → 409, which the bridge swallows with a `console.warn`. **A dead button** instead of an
error.

What has now been done: every agent-side path that presents an agent's token now sends it to that
token's OWN homeserver via `baseUrlForToken` — the message send, the reaction, the typing notification
and all five joins. That closes the wrong-server half. **The appservice half is not closed:**
`getAgentToken` returns nothing for an appservice side, because such a side has no per-agent
credential by design, so publishing a public notice as the agent needs the masquerade path
(`?user_id=` with the side's `as_token`) which nothing implements yet. Until it does, an appservice
side cannot carry an approval.

The lesson worth keeping is not about Matrix. The claim was written in the same commit as the fix, from
reading the function I had just edited — and the failure was sixteen lines below the part I was looking
at. A fix's own commit is the worst place to assert that a class of failure is gone.

What remains is the design question, and there are three shapes:

| option | cost |
|---|---|
| approval rooms stay on the contributor's server, without the agent present | the borrower cannot see which agent is being asked about, in the room where the asking happens |
| approval rooms move to the project side | the operator, who lives on the contributor's server, cannot be in them — which is the wrong half to lose, since the approval is theirs |
| approval stays entirely bot-mediated, and the agent is never a member anywhere | simplest, and closest to what the code already does; loses the visible attachment ADR-003's two-channel model leans on |

Nothing here is decided. The third looks likeliest because the code already treats the agent's presence
as decoration, but it touches ADR-003 and is not this ADR's to settle alone.

## Questions settled 2026-08-13

All three open questions were answered by the operator in the same session, along with three
scoping calls. Recorded here rather than folded silently into the decisions above, because a reader
needs to see that these were decided rather than assumed.

**1. Intake rooms are PLAINTEXT.** The representative never needs to decrypt, so a project side
costs a token and not a crypto store, and ADR-014's doubling of the ADR-008 surface does not
happen. This becomes a **requirement stated to the project side**, not a preference: HAFleet's
agents send plaintext unconditionally, so an encrypted intake room is already degraded — the
borrower sees unencrypted messages from the agent. The decision makes an existing de-facto
constraint explicit instead of leaving it to be discovered.

**2. A project side's token budget is a REAL allocation**, with its own record, not a derived slice
of the deployment total. Two reasons, and the second is the operative one: a slice model lets the
first project side consume the whole pool, and it cannot distinguish "this project exceeded its
allocation" from "the deployment is out of budget" — two sentences whose remedies are different
(raise this project's allocation versus raise the total). Decision 6's provisioning gate therefore
refuses against two ceilings, and can say which one it hit.

**3. Existing agents are DELETED rather than migrated.** They are test data. This removes the
migration path from scope entirely — there is no legacy-instance concept to build, and no
reconciliation between agents that predate project sides and agents minted from them. Decision 7's
retire-rather-erase rule still stands for the future; it governs deleting a *project side* with
history, which is a different act from clearing a test fixture.

**5. Manual creation survives as an explicit operator-only path**, no longer the default. The
automatic path depends on budget arithmetic and role matching, either of which can be wrong; with
no manual path the only remedy is editing configuration and restarting.

**6. AppService MUST be supported — the deferral is withdrawn.** An earlier draft of this section
deferred it, and the operator overruled that after reading the argument: 「必须支持 Application
Service」. Recorded as a reversal rather than edited away, because the argument against it was
specific and the operator's decision was made in full view of it.

**Both credential kinds are built; appservice does not replace the registration-token path.** The
registration-token path is the only one that works from behind NAT, so it remains the fallback for
exactly the deployment shape the counter-argument described. Decision 2 having framed appservice as
a *credential kind* rather than a *flow* is what makes supporting both cheap.

**The consequence that matters is not effort — it is that this SIMPLIFIES the credential model, and
retroactively corrects ADR-014 decision 4.** Under appservice an agent holds **no credential at
all**: HAFleet masquerades with the project side's single `as_token` by appending
`?user_id=@ac_x:their-server`. So `{ homeserver, accessToken }` per agent — decision 4's shape, and
the shape this ADR's decision 1 had already moved to the project side — is not merely differently
placed, it is **unrepresentable** for an appservice side. The agent record therefore holds
`{ projectSide, mxid }` and nothing else, and both credential kinds resolve from the side:

| | `kind: 'appservice'` | `kind: 'registrationToken'` |
|---|---|---|
| held on the project side | `asToken`, `hsToken`, `namespace` | the registration token |
| per-agent credential | **none** | one access token each |
| how an agent is created | implicit — no registration call | `POST /register` per agent |
| how events arrive | the homeserver **pushes** to us | we poll `/sync` outbound |
| revocation granularity | the whole namespace | per agent |

**The network constraint does not disappear by being decided; it becomes a deployment
requirement.** An appservice needs the project's homeserver to reach an address we expose, and
`bridge-matrix.js` has no `listen(` and no `createServer` — verified again live: the running bridge
process holds **zero** listening sockets. So appservice support requires, and must state to the
operator, that HAFleet is reachable inbound from the project side (a public host, a tunnel, or
same-network deployment). Where it is not, that project side must use a registration token.

What has to be built for it: `PUT /_matrix/app/v1/transactions/{txnId}` authenticated by `hsToken`
and **idempotent by `txnId`**, since the homeserver retries; `GET /_matrix/app/v1/users/{userId}` so
the homeserver can ask whether a claimed user exists; and generation of the registration file the
project side installs, whose `as_token` and `hs_token` must be **randomly generated, never
derived** — that is ADR-014's entire lesson, and an appservice token is the one credential in this
design that grants a whole namespace.

*Sequenced to the second pass, which is not the same as deferred support.* The first pass must get
three shapes right so the receiver is purely additive: the credential lives on the project side and
carries a `kind`; an agent record holds an MXID and its side, never a token; and every Matrix call
takes its `(baseUrl, auth)` from the side rather than a module constant. With those three, adding
the transaction receiver restructures nothing.

### The target homeserver can host one — verified 2026-08-13

Reconnaissance against the **Palpo 0.4.0** build this deployment actually runs, rather than against
its documentation. The capability is genuinely implemented, so the mandate above is exercisable
without patching the server, changing test homeservers, or waiting on upstream. Palpo is not a fork
of Conduit — an independent codebase on salvo rather than axum — but its appservice subsystem is a
near-verbatim port of Conduit's design (`NamespaceRegex{exclusive, non_exclusive}` over `RegexSet`,
`RegistrationInfo`, `send_pdu_appservice`), and Conduit's is mature.

| capability | state |
|---|---|
| registration-file intake (`appservice_registration_dir`) | implemented; **not configured on this deployment** |
| HS→AS transaction push, with a durable retry queue | implemented, **with one deviation — see below** |
| `as_token` accepted as a bearer credential (constant-time compare) | implemented |
| `?user_id=` masquerading, namespace-enforced | implemented |
| namespace claims incl. exclusivity and `M_EXCLUSIVE` | implemented |
| `knock` join rule and room aliases (decision 5) | implemented |
| outbound `GET /_matrix/app/v1/users/{userId}` back to the AS | **absent** — Palpo serves it but never calls it |

**Findings that constrain implementation.** The first was then confirmed on the wire by registering a
throwaway appservice against this instance, restarting it, and observing real transactions arrive —
so it is a measurement, not a reading. The section below distinguishes the two, because the first
version of this record did not and got one of them wrong.

1. **Transactions are authenticated with a QUERY PARAMETER, and carry no `Authorization` header at
   all. CONFIRMED ON THE WIRE.** Three transactions were observed (`m.room.member` ×2 from an invite
   and a join, then `m.room.message`). Every one carried `?access_token=<hs_token>`; every one had
   header names limited to `accept, content-length, content-type, host`. A receiver that reads only
   `Authorization: Bearer` will reject **every** transaction with a 401. The receiver must therefore
   accept the `hs_token` as a query parameter, and should accept the header too, since the query form
   is the deviation rather than the spec.
2. **End-to-end delivery works. CONFIRMED**, and it was the item the reconnaissance had to leave
   inferred. Interest-by-namespace holds: putting `@ap_test:palpo.test` in a room was enough for that
   room's events to be forwarded.
3. **Registrations load into a `OnceCell`**, so adding one requires a container restart — verified by
   needing exactly that. A runtime admin API for register/enable/disable exists, but the file path is
   read once. Palpo logs `Appservice registration dir: …` at startup, which is a usable readiness
   signal.
4. **Namespace enforcement works.** Masquerading as an MXID outside the claimed namespace is refused
   with `403 M_FORBIDDEN` "User is not in appservice's namespace". This is the property that makes an
   `as_token` a scoped credential rather than a superuser one, so it is worth having measured.

**A CORRECTION, recorded rather than edited away.** The first version of this section claimed that
nothing creates the `sender_localpart` account, that Palpo's non-masqueraded branch therefore raises a
database `NotFound`, and that the **first** call must consequently be masqueraded. That claim came
from reading the source and the binary's symbol table, and it **did not reproduce**. On this build a
bare `as_token` whoami answers `200` with the sender's own MXID (device `_`); the masqueraded form
answers `200` with device `appservice`. No bootstrap step is needed.

The claim was written into this record and into `lib/matrix-representative.js` as *verified*, when what
had been verified was that certain code paths exist — not what they do when called. That is the same
defect this project keeps finding in its own console: asserting a fact nobody checked, in a place
readers treat as checked. The masquerade is still the right call to make, for a reason that survives
the correction: a bare whoami proves only that the token is known, while a masqueraded one proves the
namespace claim actually functions and exercises the exact call shape every agent operation will use.

**The decisive evidence for masquerading**, before it was measured, was a symbol in the running binary
rather than a source grep: `auth_by_access_token_without_query_masquerade`, a deliberate opt-**out**
wrapper that exists because one endpoint reuses `user_id` for its own purposes. Nobody writes an
opt-out unless the behaviour is the default everywhere else. That inference held up.

**One trap recorded so it is not reused as evidence:** probing `PUT /_matrix/app/v1/transactions/1`
returns 401 rather than 404, and that says **nothing** about HS→AS push — Palpo also *serves* the
appservice-side API, which is the opposite direction. The push evidence is in its sending path, and
now in the observation above.

### Re-confirmed with the shipped code, 2026-08-13

The findings above came from a hand-written probe. They were then reproduced against the real modules,
which is a different claim: a registration generated by `POST /api/project-sides/:id/registration` was
installed into this Palpo, the instance restarted, and `lib/appservice-listener.js` started against
`lib/appservice-receiver.js`. Three real transactions arrived and were accepted — `m.room.member` for
the invite, `m.room.member` for the join, `m.room.message` for a human's message — every one
authenticated by the query-parameter `hs_token`.

Two properties only a live homeserver can demonstrate were measured in the same run: the same `txnId`
sent twice answered 200 both times and invoked the handler **once**, and a transaction carrying a wrong
token was refused 403 with the handler never reached.

The listener's defaults were verified the same way, because they are what an operator inherits: with no
`HAFLEET_APPSERVICE_PORT` the listener does not exist at all; with a port and no
`HAFLEET_APPSERVICE_BIND` it binds loopback only, which a container cannot reach; widening to
`0.0.0.0` is allowed and reported as `exposedBeyondLoopback`. Loopback-by-default is deliberate — the
console's `next dev` binding every interface is a failure this repository has already shipped once, and
a surface that appears because someone set a port should not also appear on every interface because
nobody set an address.

Cleaned up and verified the same way as before: registration, config key and bind mount removed, the
instance restarted, and the `as_token` refused `M_UNKNOWN_TOKEN`. Two further accounts (`@e2ehuman`,
`@ac_e2e`) and one room remain on this disposable homeserver.

**Residue from the experiment**, disclosed rather than left to be found: the throwaway registration,
the `appservice_registration_dir` key and the bind mount were all removed and the instance restarted,
verified by the `as_token` now being refused `M_UNKNOWN_TOKEN`. Two Matrix accounts (`@probehuman`,
`@ap_test`) and one room remain on this disposable homeserver. They are invisible to the HAFleet
console — neither is a HAFleet agent and neither inviter is trusted — so they pollute no surface, but
they do exist.

**Also relevant to decision 2:** this deployment runs with federation disabled, which matches the
non-federating assumption rather than working around it.

**7. A project's name comes from its room alias**, per decision 5. It is the first artifact in the
design carrying a human-readable handle, so it answers a question that has been open since the
console started rendering raw room ids.

## Build order

The first pass is decisions 1, 3, and the identity half of 4: the project-side record, the
representative/agent split, and an agent identity that carries its homeserver. It deliberately
**excludes** automatic minting (which needs decision 6's allocation), the cascade (which needs
something to cascade over), and the appservice transaction receiver (additive, given the three
shapes below). At the end of it the circular dependency is gone, `HOMESERVER` is no longer a
constant, and creation is still operator-triggered but travels the new path.

**Three shapes the first pass must get right**, because appservice support is mandatory and each of
these would otherwise force a restructure when the receiver lands:

1. the credential lives on the **project side** and carries a `kind`
2. an agent record holds `{ projectSide, mxid }` and **never a token** — an appservice agent has none
3. every Matrix call takes its `(baseUrl, auth)` from the project side, not from a module constant

**The starting state is clean, as of 2026-08-13.** Per the settled answer to question 3 the test
agent was force-deleted and its residue cleared: 0 agents, 0 bindings, no active engagement, and the
usage ledger retained. Two ended engagements and two standing offers remain as history.

That deletion also **demonstrated decision 7's cascade gap rather than predicting it**:
`DELETE /api/agents/:name?force=true` permanently removed the agent and left three bindings still
`active: true` plus one `active` engagement holding a 250k commitment against an agent that no longer
existed — so the console would have reported a deleted agent as reachable in three projects, and
`remainingFor` would have kept subtracting its commitment. Cleanup needed two separate endpoints, one
of them bridge-secret-guarded and unreachable from the console. Worth recording: the
refuse-by-default-with-explicit-force pattern decision 7 proposes for project sides **already
exists** for agents, which is where that proposal should take its shape from.
