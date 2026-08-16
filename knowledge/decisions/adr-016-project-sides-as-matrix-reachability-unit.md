---
kind: decision
id: ADR-016
title: "Project sides are the unit of Matrix reachability; agents are minted per engagement"
status: Accepted
liveness: auto
tags: [matrix, identity, provisioning, intake, budget, federation]
---

## Implementation status 2026-08-14

This record began on 2026-08-13 with the header **"Nothing below is built"**, written before any code
moved. Six of the eight decisions have moved since, and that sentence — plus three rows that still said
"no such record exists" and "the repository has zero of it" — survived for a day after it stopped being
true. Recorded rather than quietly edited, because the discipline this ADR inherits from ADR-014 is that
**present-tense declarative for unbuilt work is a correctness defect**, and its mirror image is just as
bad: a gap table that under-reports what exists sends the next reader to build it twice.

Every decision carries its own status line and the table is the index. Rows now say what is built AND
what is not, because "partly built" without the second half is the same defect in a shorter form.

| # | decision | status | evidence for the gap |
|---|---|---|---|
| 1 | 项目方 (project side) is a first-class entity: one homeserver, one credential, one representative | **built** (2026-08-14) | `lib/project-side-store.js` + ten endpoints on `backend-v2.js`. The id IS the server name, so one side per homeserver is structural rather than validated. `publicSide` is an allow-list projection, so no read path can return the credential. THE AUDIT IS DONE (2026-08-15) — see "Which HOMESERVER references are wrong" below. 55 references, 41 of them live code: most are CORRECT (the bot's own account and sync, rooms on our server, fallbacks for credentials that state no homeserver). Two were reachable by a side room and are fixed via a new `sideForRoom`: inviting a human into a side DM now goes through the representative, and inviting the BOT into a side room is skipped rather than attempted. NOT built: five more sites are wrong-if-reached but not reachable yet (avatars, group member changes, legacy DM upgrades, media URLs, invite rejection) — listed below rather than fixed blind, because each needs the side's CREDENTIAL and not just its base url |
| 2 | non-federation is the assumption; federation is an optimization inside the same model; **built** for both credential kinds | **built and RUNNING** (2026-08-14) | `CREDENTIAL_KINDS = ['appservice', 'registrationToken']`; `lib/appservice-receiver.js` and `lib/appservice-listener.js` handle HS→AS transactions, and the bridge starts an intake (`startAppserviceIntake`) with a token-identified router. Verified against a real Palpo 0.4.0: registration installed, three transactions accepted, same-txnId idempotency, wrong-token 403, then unload proven via `M_UNKNOWN_TOKEN`. NOT built: nothing CHOOSES federation as the optimization — there is no code path that detects a federating side and skips registration. The listener IS running on this deployment (`serving 1 project side(s)`, `first transaction accepted`), but the existing intake room is ENCRYPTED and the appservice cannot read it — the run succeeded via the bot's crypto store. See "What the first live run found" |
| 3 | the representative is registered per project side and is NOT an agent | **built** (2026-08-14) | `lib/matrix-representative.js`: `registerRepresentative` (random password, discarded), `ensureRepresentative`, `whoami`, and `classifyMatrixFailure` where only 401/403 are verdicts and anything unknown is `unreachable`. Wired at two call sites in `backend-v2.js`, and the credential is stored BEFORE the verdict so a crash between the two writes loses a verdict rather than a token. `createRoomOnSide` / `sendToRoomOnSide` are used by the bridge, which is how an approval reaches a decider on the borrower's server. The representative now brings the agent in (2026-08-15): `inviteToRoomOnSide` invites as the representative and `joinRoomOnSideAsAgent` puts the agent in under the side's as_token — the one act only an appservice can perform, since a per-agent token does not exist on such a side. Called at both acceptance points (auto-join and approval verdict), awaited, and reported as `roomAdmission` beside `binding`; a refused invite does not undo the approval. A registrationToken side is invited but not joined, because there the agent holds its own token and the bridge's existing path uses it. Re-admission is built too (2026-08-15): a send that fails on membership re-invites and rejoins through the same pair, which is the only moment anything notices the loss. And the agent can now SPEAK: `sendAsAgentContent` accepts an appservice sender and signs with the side's as_token, naming the agent in `?user_id=`, so `canSend` stopped meaning has-a-per-agent-token. NOT built: nothing re-admits an IDLE agent, so a membership lost while it has nothing to say is discovered by the next message rather than by a sweep |
| 4 | an agent instance is minted on acceptance from a resource declaration | **partly built** (2026-08-14) | The identity act is built (`mintAgentIdentity`), and side attribution is built: a provision plan carries its `sideId`, the backend remembers the assignment in `provisionedSides`, and the agent record gains `projectSide` at registration — taken from that map, never from the agent's own request body, which `POST /api/agents` now enforces per-field. The provisioning path calls `mintAgentIdentity` now (2026-08-15): at registration, the moment both facts are first true — the record exists and the plan says which side it serves. Fire and forget, because minting talks to somebody else's homeserver and a registration that only 200s when a foreign server answers would put every launcher at that server's mercy; a refusal raises an actionable `agent_identity_unminted` instead, whose impact line says work is NOT blocked (the representative can still invite and join it, the appservice can still speak as it) and what is missing is an account the customer can attribute that work to. The resource declaration is now a ROLE-MATCHED selection (2026-08-15): `resourceForRole` picks the lowest-tier configured preset that can staff the (role, tier) ask — qualifying tier, a declared ceiling, and not on the role's `excluded` list — and a deployment with presets but none qualifying gets `no_resource_for_role`, a refusal taken BEFORE the reservation so an impossible ask holds no seat. A zero-preset deployment keeps the static `TIER_RUNTIME` row, so an upgrade is not an outage. Enforcing `excluded` also gave that list its first reader: it had stated a per-role rule no code applied. **Corrected 2026-08-14:** the budget half of this row cited the `/api/dispatch` gate; the admission point is acceptance, and the gate is there now |
| 5 | the invite object is a room alias plus `knock` | **built and PROVEN LIVE** (2026-08-15) | `resolveAliasOnSide` reads the side's directory for `#its-project:its-server` and `knockOnRoomOnSide` knocks as the representative; `POST /api/project-sides/:id/knock` is the operator's entry point. The two failures are kept apart because they send an operator to different people: an unresolvable alias is a typo or an unpublished room, a refused knock is the project's join rule, and a homeserver that does not implement knocking answers `M_UNRECOGNIZED` — reported as `knock_unsupported`, since HTTP 404 alone reads like a bad alias when the remedy is a homeserver upgrade. Verified against real Palpo 0.4.0: a room created by another user with `join_rule: knock` and a published alias, knocked on through the endpoint, and Palpo's own `/members` reports `@hafleet:palpo.test -> knock` carrying the reason we sent. The accept is watched too (2026-08-15): `onAppserviceMembership` sees an invite addressed to the representative on a side we hold an acting credential for, joins, and tells the operator — saying in the same breath that requests from that room still go through engagement approval and the side budget, so reachable is never read as approved. It runs BESIDE the generic handler rather than instead of it: two existing tests refused the first version with the right argument — the trust gate and the historical cutoff live in `onRoomEvent`, and a handler that swallowed membership events would be a way around both. Proven live: the project invited, the bridge logged `knock answered — @hafleet:palpo.test joined`, and Palpo reports `join` |
| 6 | budget is admission control, and **acceptance** is the admission point; a refusal RAISES AN ALARM | **built** (2026-08-14) | A project side carries a real `allocatedTokens`; `null` is UNALLOCATED and refuses rather than meaning unlimited. `refuseOverSideAllocation` answers `no_project_side`, `no_allocation` or `over_allocation` and names the shortfall — a refusal, never a queue entry — at BOTH points a side's allocation is committed: the auto-join inside `POST /api/engagements` and the approval in `POST /api/engagements/:id/verdict`. A refusal also raises an actionable `project_side_budget` alert, deduped per side, that auto-resolves when the allocation is raised far enough to leave headroom. **Corrected 2026-08-14:** this row previously cited the gate on `POST /api/dispatch` Phase 4, which ADR-013 decision 8 withdraws and which has no product caller — see "Where this gate belongs" below. The overrun DISPLAY obligation is built (2026-08-15): `overBy` in the console's derive layer reports how far past a ceiling an agent has drawn, and `components/Meter.jsx` renders it as its own state — a distinct fill plus a text figure — because the bar's unavoidable `Math.min(100, pct)` clamp had made a breach identical to landing exactly on the ceiling. Derived SEPARATELY from `remaining`, which floors at zero on purpose: that is the admission figure and there is no negative headroom to allocate. Two invariants hold it — no page may clamp a meter itself, and the state must actually render. An existing overrun now pages too (2026-08-15): `sweepCeilingOverruns` files an actionable `agent_ceiling_overrun` per agent whose drawn figure — `max(committed, measured)`, the same one `remainingFor` uses — is past its preset ceiling, and auto-resolves when it is not. Swept hourly rather than raised at a decision point, because nothing decides an overrun: it arrives when a ceiling is lowered under commitments that were already granted |
| 7 | deleting a project side cascades, but RETIRES agents rather than erasing usage | **built** (2026-08-14) | Removing a side retires the agents minted for it — record kept, ledger kept, `offlineReason` naming the side — and the precondition is checked BEFORE anything is retired, so a refused delete does not take a side's agents down. Engagements on the side are ENDED and approval bindings DEACTIVATED — kept with a reason, per the operator's compliance rule 「不删除，只是停用退役」 — and the response reports `cascade: 'performed'` with what it did rather than a claim of completeness. Two more stores are swept now (2026-08-15): PENDING INVITATIONS on the side are DECLINED with the decider recorded as `project-side-removed` — they could never be accepted, and 「不删除，只是停用退役」 makes a declined invitation history where a missing one is amnesia — and SIDE-SCOPED ALERTS are resolved by dedupe prefix, because an alert naming a side that no longer exists sends an operator chasing a 404 and teaches them to trust the next one less. NOT built: the BRIDGE's own state (`dmRooms`, `groupRoomMap`, `trustedManagedRooms`, `approvalDmRooms`) still holds rooms on a removed side, and the backend cannot reach that file — it would need the bridge to sweep on a signal it does not receive |
| 8 | a project side's credential is write-only through the console | **partly built** (2026-08-14) | The API half is done and is the half that could leak: `publicSide` is an allow-list projection, `accessState` is named to dodge the health writer's `/credential/` redaction guard, and the two credential-returning endpoints are excluded from the console proxy's read allow-list by a regex that requires a dot or colon in the id. The console has a credential form now (2026-08-15, `components/CredentialForm.jsx` on `/engagements`): per-kind fields, an explicit-null withdrawal behind a confirmation, and the typed token cleared from state on success. The proxy admits the PUT and nothing else — verified end to end, the write lands with no token in the response while all three credential READ paths answer 403, so the console can write a credential it can never read back. What entering it here costs is stated in the form: the token passes through the browser. The new secret class is also still unclassified — `cf.ownSecrets` covers install-time `.env` secrets only, and a side's `as_token` is somebody else's server |

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

*Status — **built** (2026-08-14). `lib/project-side-store.js` and ten endpoints; the id is the server name, so one-side-per-homeserver is structural. **Not built:** `HOMESERVER` remains the contributor's own server in 54 places, most of them correctly, and which of them are wrong has not been audited.*

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

*Status — **built and RUNNING** (2026-08-14). Both credential kinds, verified against a real Palpo 0.4.0 rather than a mock, and the intake is now live rather than merely implemented: the listener is up on this deployment, `refreshAppserviceSides` reports `serving 1 project side(s): palpo.test`, and a real homeserver push was accepted — `first transaction accepted from palpo.test`. **Not built:** nothing detects a federating side and skips registration, so federation remains a stated optimization with no code path. **Newly known and NOT solved: encryption blocks this channel** — see "What the first live run found".*

## Which HOMESERVER references are wrong (audit, 2026-08-15)

Row 1 recorded that an audit had not been done. Here it is. 55 textual references; 14 are comments or
the declarations themselves, leaving 41 in live code.

**Correct, and not to be "fixed":** `ensureBotAccount`, `start`, `pollBotInvites`, `ensureBotDmRoom`
(the bot has an account on our server and nowhere else — asserting our own server IS the right answer);
`ensureAgentAccount` (registers agents on our server, which is the legacy path a project-side agent
deliberately does not take — it warns NEEDS PROVISIONING instead); `_upgradeLegacyDmRoom` (rooms that
are ours by definition); `normalizeAgentCredential` and `baseUrlForToken` (fallbacks for a credential
that states no homeserver, where our own is the only defensible guess).

**Wrong AND reachable — fixed:**

| site | what it did | now |
|---|---|---|
| `_inviteHumanToDm` | tried the bot then an agent token against our server | the representative invites, on the side |
| `inviteBotIntoAgentRoom` | invited the bot with an AGENT token against OUR server | skipped for a side room, with the reason |

The first became reachable only because `ensureDmRoomOnSide` persists side DM rooms, so the next
message takes the existing-room branch and lands there. That reachability was introduced by the fix
above it, which is why both are in the same change.

**Wrong if reached, NOT reachable yet — left alone deliberately:** `ensureRoomAvatar`,
`syncAgentAvatarToDmRooms`, `ensureAgentAvatar`, `setCustomAgentAvatar` (avatars on a side room);
`onGroupMembersChanged` and `createRoomForGroup` (a group mapped to a side room — reachable only by
hand-editing `groupRoomMap`, which is how the live run drove it); `matrixMxcToHttpUrl` /
`matrixMxcToClientMediaUrl` (media uploaded to a side is served by the side); `rejectPendingInvite`
(rejecting an invite that came from a side room); `discoverAndGreetHumans` (searches our directory, so
it cannot see a side's humans — a gap, not a wrong call).

Each of those needs the side's CREDENTIAL and not merely its base url: swapping the url alone would
send the bot's token to somebody else's homeserver, which is a worse bug than the one it fixes. That is
why `sideForRoom` returns the acting pair rather than a string, and why these are listed rather than
converted in bulk.

## What the SECOND live run found (2026-08-15)

The chain from a role ask to an agent speaking in the customer's room, run against the same Palpo
0.4.0, with every claim checked against the homeserver rather than against our own response bodies.

**It works, and Palpo is the witness.** The representative created a real room on `palpo.test`; the
engagement approval invited and joined `@ac_sitehand:palpo.test`, an account **nobody ever
registered**; `GET /joined_members` came back with that agent and the representative in the room; and
a message from the agent arrived with `sender=@ac_sitehand:palpo.test` — the AGENT, not the
representative whose token carried it. That last line is the one worth having: a masquerade that
silently posted as `@hafleet` would have looked identical from this side.

**A SECOND TOKEN DEPENDENCY THE UNIT TESTS COULD NOT SEE, since fixed.** The first attempt went
through the DM path and was dropped before it reached the send at all: `ensureDmRoom` did
`if (!fromToken) return null` and created the room against `HOMESERVER` — our own server.
`ensureDmRoomOnSide` now creates it on the customer's homeserver, with the representative as creator,
both parties invited, and NO bot member (it has an account on our server only, so inviting it would
leave a pending invite nobody can accept — the appservice intake reads the room instead, which is why
it is plaintext).

That fix then produced a THIRD live finding, worth recording because of what it says about the tests:
the first version invited only the human, and Palpo answered **403 on the agent's own join** —
`private_chat` is invite-only and the representative is the creator, not the agent. The unit test had
passed because its fake homeserver answered 200 to any join. A mock permissive enough to hide a
precondition the real thing enforces is not a weaker test, it is a test of something else. Both
parties are now in the invite list and the test asserts it; verified after: Palpo reports the DM room
holding `@ac_sitehand` and `@hafleet`, and the message arriving with `sender=@ac_sitehand`.

**Also observed, and not a defect:** `/api/dispatch` answered `queued` rather than `provision`,
because `MATRIX_AGENT_MAX_PER_CELL` defaults to 0. Auto-provisioning is off by default and that route
has no product caller — so the role-matching selection built for it is correct and unexercised, which
is a different thing from working.

## What the first live run found, 2026-08-14

The chain was run end to end for the first time — a borrower registered on a real homeserver, typing
`!request` into a real room, through to a binding and a committed allocation. Everything below was found
by running it; none of it is visible by reading.

**IT WORKS, AND HERE IS THE EVIDENCE.** `@hafleet:palpo.test` was created BY the homeserver from the
registration — HAFleet never registered it — and joined a project room by masquerading with the
`as_token`. A borrower sent `!request coding 80000`; the bot read it, the backend created the
engagement, routed it `notWhitelisted`, assigned `biglittle`, and on approval bound the agent and
committed the tokens. The side's budget moved 0 → 250,000 → 450,000 of 1,000,000 across three requests.
Before the allocation existed the same request was REFUSED with `no_allocation` and raised the alarm;
setting the allocation resolved the alarm automatically. Both halves of decision 6 observed in one run.

**ENCRYPTION BLOCKS THE APPSERVICE CHANNEL, and this is the finding that matters most.** The intake room
is `m.megolm.v1.aes-sha2`, so the listener logged:

> `encrypted event in !TLrgp…:palpo.test cannot be read — ADR-016 requires plaintext intake rooms, and an
> appservice has no crypto store on the project side`

The run therefore succeeded **only because the BOT read the command** — it has a crypto store; the
appservice does not. So the appservice intake is live and, on this room, blind. The plaintext-intake
requirement was recorded as a settled question; it is now a live precondition with an existing room that
violates it. Either intake rooms are created plaintext, or the appservice needs a crypto store — which
is the cost decision 3 was written to avoid.

**PALPO PERSISTS REGISTRATIONS; REPLACING THE FILE DOES NOTHING.** The reconnaissance note in this ADR
says adding a registration needs a restart. True of ADDING and false of REPLACING: registrations live in
`appservice_registrations` in postgres, keyed by id, and a restart does not re-read a file for an id
already present. A homeserver kept pushing with tokens from a superseded registration while we compared
against current ones, which presents as an unexplained 403 forever. **Rotating an appservice token
requires deleting the row.** Two stale rows were found on this deployment, one of them holding a token
that had leaked into an operator's terminal; deleting them is what actually revoked it.

**A 403 WITH NO DIAGNOSTIC COSTS AN HOUR.** The homeserver logs its own token as `REDACTED`, so from
outside there was no way to separate "no token" from "the as_token instead of the hs_token" from "a
stale registration". The receiver now logs token FINGERPRINTS on refusal — sha256 truncated to 8 hex
characters, useless for authenticating and sufficient for comparing — and names the cause on the first
occurrence. Acceptance is announced once per side for the same reason: a working intake used to produce
silence, so "it works" could only be inferred from the absence of an error in somebody else's log.

**THE OWNER IS READ BY THE BACKEND, NOT THE BRIDGE.** `bindEngagement` runs in `backend-v2.js`, so
`HAFLEET_OWNER_MXID` and `HAFLEET_OWNER_DM_ROOM` must be set there. Three bridge restarts changed
nothing while the error message said exactly what was wrong; what it did not say is which process needed
to hear it. Until the owner was known, approval produced `active` engagements with `bound: false` — the
allocation was committed and the project could not reach the agent, which is the worst of both.

**A DESTRUCTIVE DEFAULT, FOUND BY TRIPPING IT.** `PUT /api/project-sides/:id/credential` read
`req.body?.credential ?? null`, so a body that did not mention a credential destroyed the existing one
and answered `ok: true`. On this path the cost of an accidental wipe lands on somebody we cannot reach:
re-issuing means the project side installs a new file and restarts their homeserver. The field must now
be present; clearing is an explicit `credential: null`.

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

*Status — **built** (2026-08-14). `registerRepresentative` / `ensureRepresentative` / `whoami`, wired at two call sites, with the credential stored before the verdict so a crash loses a verdict rather than a token. The plaintext-intake question that gated its cost is **closed**. **Not built:** the representative does not invite an agent into a project room — the agent still joins on its own, which is the half of decision 3 that removes the agent from the trust path.*

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

*Status — **partly built** (2026-08-14). The identity act exists (`mintAgentIdentity`) and side attribution is built end to end: a provision plan carries its `sideId`, the backend remembers it in `provisionedSides`, and the agent record gains `projectSide` at registration — from that map, never from the agent's own body, which `POST /api/agents` now enforces per-field. **Not built:** no product code calls `mintAgentIdentity` (its 12 references are all in tests) — the agent's Matrix identity `@ac_biglittle:palpo.test` appeared in the project room during the live run WITHOUT it, through the bridge's own path, so the minting function remains unexercised while the outcome it exists to produce happens by another route. The resource declaration is still an operator-chosen preset rather than a role-matched selection — `resourceForRole`, `presetTier`, `provisionedResources` and `no_resource_for_role` have zero occurrences. `provisionReservations` is incremented and never decremented, so plans leak for the process lifetime.*

**5. The invite object is a room alias plus `knock`.** The project publishes
`#its-project:its-server` and sets the join rule to `knock`; HAFleet's representative knocks; the
project accepts. This is the operator's 「邀请码 / 邀请 link」 in native Matrix terms — an alias is a
shareable, human-readable, server-scoped handle, and a knock is a pull rather than a push, which
matches the intake direction the design already has.

It does **not** replace approval. ADR-014's amendment stands unchanged: 「joining a Discord costs the
joiner nothing. Lending an agent spends tokens.」 An alias makes the project *findable*; the
contributor's approval is still a deliberate, audited act, and never a link click.

*Status — **built and proven live** (2026-08-15). `resolveAliasOnSide` + `knockOnRoomOnSide` in
`lib/matrix-representative.js`, `POST /api/project-sides/:id/knock` in the backend. The response
reports what has NOT happened — `state: 'knocked'`, `awaits: 'the project side invites the
representative'` — because a caller reading only `ok: true` would take it for access, and a test asserts
the payload never contains the words approved, engaged or joined. Palpo 0.4.0 does implement knocking:
its `/knock` route answered `M_NOT_FOUND` for an unknown alias rather than `M_UNRECOGNIZED`, which is
how we learned that before writing the unsupported branch. **Not watched:** nothing notices the
project's accept. The knock is a pull, so the next event is theirs, and only the appservice intake sees
it — wiring that to flip a side's state is the remaining half.*

*Status — **decided, not built**. Nothing in the repository joins by alias or knocks.*

**6. Budget is admission control, not a circuit breaker — and provisioning becomes a new admission
point.** The operator ruled 准入控制 over halt-and-resume, so `tests/enforcement-spend.test.js`
stands unchanged, including its central assertion:

> refuse new auto-joins against an exhausted ceiling, and NEVER stop a running agent. Killing an
> agent at its cap converts a budgeting decision into lost work.

What changes is *where* admission is checked. Minting an agent is a new gate, and it is the one the
operator named: 「如果 token 预算已经超标了…这时候应该报警，说无法创建 agent，需要加预算」. Two ceilings,
both of which must pass before an account is minted:

| ceiling | question | when written | now (2026-08-14) |
|---|---|---|---|
| HAFleet's own total | can this deployment afford another agent at all? | `remainingFor(agent)` exists; nothing calls it from a provisioning path | enforced by `engagementStore.decide()` at approval, and by `routeRequest` before an auto-join |
| the project side's allocation | can this project side afford this request? | no per-side allocation exists | `allocatedTokens` on the side; enforced by `refuseOverSideAllocation` at both admission points |

A refusal is an **alarm naming the shortfall**, not a queue entry: an agent that was never created
cannot be waited for, and enqueuing a ticket instead would present "waiting for capacity" when the truth
is "will never be created without more budget".

`POST /api/engagements` already accepts `requestedTokens` and `ratePerDay`, so the operator's
question 「项目请求的时候是否也要加上预算需求」 is answered: it already does. The missing half was that
nothing read the figure against the borrower's own allocation; as of 2026-08-14 that route does, before
it creates anything.

**A consequence of choosing admission control that must not surprise anyone.** A running engagement
CAN exceed its ceiling, because we refuse to stop it. This is not hypothetical — this deployment
measured 984,016 drawn against a 10M ceiling on the fresh-token basis, and roughly 136% of it on the
cache-read-inclusive basis. So the console acquires a **display obligation**: it must show the
overrun as an overrun. A ceiling that is admission-only and rendered as though it held is the console
asserting a guarantee the enforcement model deliberately does not make.

### Where this gate belongs — a correction, 2026-08-14

The first build of decision 6 put the budget check on `POST /api/dispatch` Phase 4, because that was the
only auto-provisioning path in the repository when this ADR was written. Two facts, both checkable, make
that the wrong home for it:

- **ADR-013 decision 8 withdraws the route.** Verbatim: "`/api/dispatch` and any successor
  router-facing assignment path". A gate whose only home is a withdrawn route is removed by the
  withdrawal it was written under.
- **The route has no product caller.** Nothing in `bin/`, `lib/` or `server.js` posts to it. So the gate
  guarded a road nobody drives, and the rows above reported it as the build.

The decision TEXT of this ADR was right where its status rows were wrong: an agent instance is minted
**on acceptance**. Acceptance has two forms and the code now gates both, because only gating one leaves
the other open:

| where | who decides | why it must be gated |
|---|---|---|
| the auto-join inside `POST /api/engagements` | nobody — a published offer plus a whitelist entry already decided | the engagement is born `active` and commits `requestedTokens` without an operator ever seeing it. The verdict route it would otherwise pass through never runs |
| `POST /api/engagements/:id/verdict` | the contributor | the approval may allocate MORE than was requested, and the side's remaining may have fallen since the request. Passing the request-time check is no evidence about this moment |

The check is a **refusal, not a routing outcome**, which is why it is not inside `routeRequest`. Every
value in that vocabulary — `notWhitelisted`, `overOffer`, `overCeiling` — ends in a pending engagement
the contributor can decide. A budget refusal must not: a queue entry reads as "waiting for capacity"
when the truth is "will not proceed without more budget", and the operator asked for an alarm
(「应该报警，说无法创建 agent，需要加预算」), which a queue entry is not.

**The dispatch check is kept, and demoted rather than deleted.** `POST /api/dispatch` carries no auth
guard, so anyone able to reach the backend can ask it for a provision plan; removing the check would
leave the unguarded route as the one place a plan is produced with no budget consulted. Withdrawn but
present is exactly when a cheap check earns its keep. It is defensive, not load-bearing, and its comment
now says so.

**One asymmetry, deliberate.** The minting path refuses a named room whose server has no configured side
(`no_project_side`); the engagement path does not. Minting needs a side because under decision 1 the
identity comes from the side's credential — no side, no agent. Serving an engagement does not: the agent
already exists and is already reachable, so an un-configured server is un-attributed, not
unserviceable. **The consequence, stated:** an engagement on a server with no side record escapes the
budget entirely. That is the migration state, not the design — every binding in this deployment predates
project sides — and refusing them all in the name of a budget nobody has allocated yet would be worse
than naming the escape.

*Status — **built** for admission and for the alarm (2026-08-14); **not built** for the display. Both
admission points are gated against the side's allocation and the agent's ceiling. A refusal now raises a
`project_side_budget` alert carrying owner, runbook, impact and recovery condition — all four are
load-bearing, because `buildActionability` silently downgrades a warning to `info` without them, which
would have produced an alarm that pages nobody. It is deduped per side, so a retrying borrower bumps a
counter instead of burying the alert, and it auto-resolves only when the allocation is raised far enough
to leave headroom — raising it below what is already committed reports no recovery, because there is
none. NOT built: the overrun display obligation above, and `no_project_side` deliberately does not alarm
(there is no side to attribute it to, and the route that raises it has no auth guard).*

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

*Status — **built** (2026-08-14). Engagements on the side are ENDED and approval bindings DEACTIVATED, both kept with a reason, and the precondition is checked BEFORE anything is stood down so a refused delete does no damage. The response reports what it DID rather than claiming completeness. **Not built:** nothing outside those three stores is swept.*

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

*Status — **partly built** (2026-08-14). The half that could leak is done: an allow-list projection on every read, a field named to survive the health redactor, and both credential-returning endpoints excluded from the console proxy. **Not built:** the console has no UI to enter one, so an operator uses `curl` today; and a side's `as_token` — a namespace on someone else's homeserver — is still an unclassified secret class.*

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

## RESOLVED 2026-08-13: an execution approval is the BORROWER's decision
The operator settled it: 「答借用方，当然是借用方」. Recorded here because it decides more than a room
location, and because the codebase currently implements BOTH answers.

**The question that was actually open.** Who approves an agent executing a command — the contributor
who lends the agent and pays the tokens, or the borrower who owns the repository the command touches?
Three places in this repository answered it, and not the same way:

| source | says the owner is |
|---|---|
| ADR-002's rule — owner is whoever invited the agent into the project room | the **borrower**, necessarily: without federation the project room is on their server, so the inviter is a project-side account |
| `HAFLEET_OWNER_MXID` / `HAFLEET_OWNER_DM_ROOM`, documented as `@you:your-server.example` | the **contributor** |
| `docs/design/hafleet-as-pdu.md` — "the customer — a human answers in the room" | the **borrower** |

The sharpest way to put it is by who is harmed when the answer is wrong. Give it to the borrower when
it was the contributor's, and the borrower approves spending someone else's tokens on their own
repository. Give it to the contributor when it was the borrower's, and the contributor rubber-stamps a
command against a repository they cannot see. The operator chose the second risk over the first.

**So ADR-002's rule is confirmed, and the config path is demoted.** `owner_mxid` derived from the
project-room inviter is now the model rather than a Matrix-flavoured accident; `HAFLEET_OWNER_MXID`
becomes a bootstrap fallback for a deployment with no project side yet, and should say so.

### What this decision requires, none of which is built

**The actionable channel has to move.** Today the borrower's room receives only
`buildPublicApprovalNotice` — `Agent X is waiting for approval from its owner`, with
`state: 'waiting_for_owner'`, no tool name, no command, no buttons. The full request with buttons
(`buildOwnerApprovalRequest`, carrying `tool_name`, `description` and `input_preview`) goes only to the
owner's DM. Under this decision those swap roles: the borrower gets the actionable request, and the
contributor gets the notice.

**ADR-003's encryption requirement has to be renegotiated, and the decision makes that easier rather
than harder.** The buttons live in an encrypted DM because `input_preview` is the literal command, and
the only crypto store is the bot's on the contributor's server. But the command operates on the
BORROWER's repository — they are not a third party to it, and disclosing it to them discloses nothing
they do not already own. What survives is a narrower requirement: the project room may contain other
members of the borrower's organisation, so the question becomes who inside that organisation may see
and answer, which is an access-control question rather than a cross-party confidentiality one.

**The unreversible part is not the room.** `owner_mxid` is stamped into every audit row already
written, and re-pointing it also re-points `MATRIX_TRUSTED_INVITER_MXIDS`, `MATRIX_OPERATOR_MXIDS` and
`HAFLEET_OWNER_MXID`. That is true whichever room location follows, so choosing this does not defer it.

### The three options this replaces

They were framed as a choice about where the approval room sits, and ADR-016 got two of the three cost
statements wrong — verified against the code:

- "the borrower cannot see which agent is being asked about" was **false**: the agent's name is in the
  body of both messages, and the borrower is not a member of the approval room under any option. The
  real transparency gap is that `model` appears nowhere in the approval record at all.
- "the operator, who lives on the contributor's server" was true only of the `HAFLEET_OWNER_MXID`
  fallback, not of ADR-002's actual rule. The cost that belonged in that cell was E2EE.
- "loses the visible attachment ADR-003's two-channel model leans on" had **no referent**: neither
  ADR-003 nor `specs/task-owner-ui-approval.spec.md` requires the agent to be a member anywhere. The
  two channels are the owner's DM and the public notice.

With the decision made, the room question answers itself: the actionable channel belongs where the
decider is.

### The collision as originally recorded


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
