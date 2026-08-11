---
kind: decision
id: ADR-014
title: "Provision agent Matrix identities by server capability, never by derived password"
status: Accepted
liveness: auto
tags: [matrix, identity, credentials, authorization, appservice]
---

## Implementation status 2026-08-11 — and a correction to how this record was written

**Accepted does not mean built, and this document could not tell you which was which.** The
Decision below is written in flat present-tense declarative from end to end, so a decision that has
merely been *taken* reads exactly like one that has *shipped*. The table restores the distinction.
It changes no decision's substance: everything below stands as accepted, including the parts nothing
has implemented yet.

| # | decision | status | evidence |
|---|---|---|---|
| A | amendment below — pending invitation, project supplies the server | **built** | `state.pendingInvites` and `pendingInviteKey()` in `bridge-matrix.js`; `createPendingInviteStore` plus its list/upsert/settle API in `backend-v2.js` |
| 1 | the ownership invariant does not change | **built** | true by construction — ADR-002's `(room, agent)` binding from the inviter is untouched, and acceptance now writes it |
| 2 | two provisioning flows, chosen by server capability | **decided, not built** | the repository still contains zero appservice support: no `as_token`, `hs_token`, `sender_localpart` or registration file — the only matches are prose in this ADR's own lineage |
| 3 | derived-password self-registration is to be deleted | **decided, not built** | every named symbol is still live: `deriveAgentPassword`, `agentPasswordCandidates`, `matrixRegister`, `MATRIX_AGENT_PASSWORD_SECRET`, `MATRIX_ALLOW_LEGACY_AGENT_PASSWORD`, and the last two are still documented in `.env.example` |
| 4 | multiple homeservers; a per-agent credential record | **decided, not built** | `HOMESERVER` is one module constant, and `state.agentTokens[name]` is a bare access-token string, not `{ homeserver, accessToken }` |
| 5 | an agent MXID is discovered via `/whoami`, not constructed | **decided, not built** | `agentUserId()` still composes `@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}`, and the invite poll's owner-derivation filter still matches that constructed `state_key` |
| 6 | a dead credential is a human-visible state | **decided, not built** | no "credential invalid, re-issue needed" state exists on any surface; a failed agent `/whoami` still falls through to re-login |
| 7 | flow B requires a dedicated login, stated where an operator reads | **decided, not built** | the rule exists only as prose here; there is no startup check and nothing in `.env.example` says it |
| 8 | the ADR-008 crypto-store defect is a prerequisite | **built** | `lib/matrix-crypto-store-identity.js` now excludes the `bot-sdk.json` placeholder by name, so an empty `{}` store no longer reads as "data without a device identity" |

Each decision below repeats its own status line, because a reader who arrives at one decision
through a link never sees this table.

**Why this is a correction and not a house-style preference.** The sibling audits in this same
round found the identical defect in other Accepted records — ADR-003 stating a guarantee that had an
authorised exception recorded elsewhere, ADR-007 stating a scope that nothing in the code enforces.
This ADR committed the same error and in its strongest form: decision 3 asserted a **completed
deletion** of code that is still live and still on the default startup path, so the record was
evidence for the opposite of the truth. An Accepted decision record is read as a description of the
system by everyone who was not in the room, which makes present-tense declarative for unbuilt work
a correctness defect rather than a matter of tone.

## Amendment 2026-08-11 — the project dictates access, and an invitation is the input

Two things in the Decision below are corrected, and one clause is added. The original text put
the credential on the **agent** (`{ homeserver, accessToken }` per agent) and had an operator
type a server address. Both are wrong.

**The credential belongs to the project, not the agent.** A homeserver is a property of the
project, so an agent serving three projects on three servers would need three credentials — the
real key is `(project, agent)` and the project is what supplies the server. Dispatch therefore
assigns the homeserver by itself; nothing needs to be chosen twice.

**The server is not typed, it is derived.** A Matrix room id is `!opaque:origin-server`
(`ROOM_ID_RE = /^![^:\s]+:[^\s]+$/`), so `projectRoomId` — already carried on every engagement and
every whitelist entry — names the project's server. What an operator cannot derive is the
server's *API* base URL, which may differ from the server name by `.well-known` delegation; that
is discovery, not data entry.

**And in the normal case there is no credential at all.** The operator's framing settles this: a
project dictates how you join it, the way an open-source project runs a Discord and developers
join it by accepting an invitation. What that analogy establishes is that **your account is yours
and portable** — an invitation authorises entry, it does not issue you an identity. Matrix's
equivalent is exactly federation plus a room invite: the agent keeps its one identity on the
contributor's homeserver, and joining a project is accepting an invite to a room hosted
elsewhere. So:

| mode | when | what is configured |
|---|---|---|
| **federated invite** (normal) | the servers federate and the project does not require local accounts | nothing — only the decision to accept |
| appservice | the project's server will install our registration | `{ apiUrl, asToken, namespace: '@ac_.*' }` on the project |
| project-issued tokens | the project requires local accounts | one token per `(project, agent)` on the project |

Per-`(project, agent)` rather than one token per project, in the last two modes, because
ADR-013's transparency amendment requires the borrower to know **which** agent and model serves
them, and ADR-002 binds ownership per `(room, agent)`. One shared account for all lent agents
collapses both.

**Where the analogy breaks, and it is the point where this product's economics differ:** joining
a Discord costs the joiner nothing. Lending an agent spends tokens. So acceptance stays a
deliberate, audited act by the contributor — never a link click, and never automatic. The shape
is still invitation-driven; only the click becomes an approval.

**What this replaces is broken in both directions today, which is why it is a fix and not a
feature.** `MATRIX_TRUST_MODE` defaults to `audit`, and the invite handler reads
`if (!trust.trusted && MATRIX_TRUST_MODE === 'enforce') continue;`:

- On the **default**, an agent joins any room anyone invites it to, but `markRoomTrusted` and
  `upsertRoomAgentBinding` are skipped — so the agent is present, the project can send
  `!request`, and every approval then fails `owner_binding_missing`. Joined and unengageable: a
  dead end that looks like presence.
- Under **`enforce`**, the invite is silently skipped. `untrusted_inviter` occurs exactly once in
  the repository — the line that produces it. There is no record, no API and no pending state, so
  the contributor never learns they were invited.
- And `MATRIX_TRUSTED_INVITER_MXIDS` is an env var read at module load, absent from the backend
  and the console. So "join a project" today means: learn an MXID out of band, edit `.env`,
  restart the bridge, and hope the invite is re-polled. The invitation carries no weight; the
  authorisation happens in a text editor.

**The decision:** an invite from an inviter that is not already trusted is recorded as a
**pending invitation** — room, derived server, inviter, and which agent was invited — and the
agent does **not** join until the contributor accepts. Accepting joins the room, marks it
trusted, and writes the `(room, agent)` ownership binding from the inviter, which is ADR-002's
mechanism unchanged: **accepting an invitation is how ownership is established.**

Accepting does **not** whitelist the project. The whitelist decides who may skip approval
(ADR-013 decision 4), which is a stronger and separate statement than "this agent may be in this
project". An earlier draft of this amendment had acceptance produce the whitelist entry too;
that was wrong.

The project surface is therefore read-mostly — the projects we have been invited into, their
server, their inviter, which agents are in them, and their trust state — with credential fields
appearing only in the two exceptional modes. `MATRIX_TRUSTED_INVITER_MXIDS` degrades from a
prerequisite to an optional bootstrap accelerator.

**A correction to decision 4 below.** "The bot keeps one homeserver … rooms hosted elsewhere are
reachable through federation" is true **only where the servers federate**. Where they do not, the
bot cannot see the project's room at all, so project-issued-token mode without federation needs a
project-level **bot** credential as well — and with it a second crypto store, a second device and
a second E2EE state machine, doubling the ADR-008 surface. Non-federating homeservers are
therefore **out of scope** until a real project requires one, and that limitation is stated to
the operator rather than discovered.

## Context

An agent needs a Matrix identity to participate in a project room. Today `bridge-matrix.js`
creates one itself: the username is composed as `@ac_<agent>:<our server>`, and the password is
**derived** — `sha256(MATRIX_AGENT_PASSWORD_SECRET + ':' + agentName)`. On startup the bridge
tries the cached access token, falls back to logging in with the derived password, and falls
back again to *registering* the account, which needs `MATRIX_REG_TOKEN` or open registration on
the homeserver.

Three properties of that model, each verified against the code rather than assumed:

- **The master secret cannot be rotated.** Every agent password is derived from it, so changing
  it invalidates every existing account's password at once. The bridge would then fail to log in
  and try to register usernames that are already taken. `MATRIX_ALLOW_LEGACY_AGENT_PASSWORD`
  exists as a migration path from an older *template* scheme, so this class of problem has been
  hit before; rotating the secret itself has no path at all.
- **The credentials it produces are not revocable.** Revoking every access token achieves
  nothing, because the password can be re-derived and used to log in again. Compromise of
  `.env` is therefore permanent control of every agent identity, recoverable only by renaming
  the agents.
- **It requires account-creation privilege on the homeserver.** That is a far larger grant than
  the ability to act as a handful of existing accounts, and no third-party project will give it
  to an external bridge. So the model **structurally cannot** onboard an agent onto a homeserver
  we do not administer — which is exactly what the contribution-console persona (ADR-013) will
  meet.

`Robrix2`'s own onboarding documentation already distinguishes the two paths that exist in
practice:

> Octos(AppService):注册在服务器上的应用服务 — 由服务器托管、可以管理自己名下的一批账号
> Octos(Direct)／Hermes／OpenClaw:以「Matrix 好友」形式直接添加 — 就是一个普通 Matrix 账号背后的机器人

HAFleet implements **neither**. It implements a third thing that needs server privilege like an
AppService while producing per-account credentials like a Direct agent, and makes them
non-revocable. It is dominated by both. The repository contains **zero** AppService support: no
`as_token`, no `hs_token`, no `sender_localpart`, no registration file (the only occurrences of
"appservice" are for *ignoring* other people's appservice bots).

## Decision

**1. The ownership model is the invariant, and it does not change.** The owner of an agent in a
room is the human whose authenticated full MXID invited that exact agent account into that
trusted room (ADR-002). Robrix2 requires the same thing and for the same reason:

> **你本人逐个邀请自己的 @ac_\<agent\> 木偶账号**
> 让 bridge 代替人类创建/邀请项目成员,不能证明"谁邀请 Agent,谁是 owner"

Credential provisioning and ownership are therefore **independent problems**. Changing how an
agent obtains its identity does not touch how its owner is established, which is what makes this
decision cheaper than it looks.

*Status — **built**, in the sense that nothing had to change for it to hold. The pending-invite work
in the amendment above preserved it rather than replacing it: acceptance is what writes the
`(room, agent)` binding, and the MXID it binds is still the inviter's.*

**2. Two provisioning flows, chosen by what the target homeserver supports.**

| | flow A — AppService | flow B — Direct token |
|---|---|---|
| when | the homeserver will install a registration (typically our own) | a third-party homeserver that will not |
| who creates the account | the homeserver, from a claimed namespace | a human, once per agent |
| what HAFleet holds | one `as_token` for the whole namespace | one access token per agent |
| server admin needed | yes, to install the registration | no — an ordinary user account |
| revocable | yes, by removing the registration | yes, per agent |

Flow A claims the namespace `@ac_.*`. The existing `MATRIX_AGENT_PREFIX` default (`ac_`) is
already namespace-shaped, so this is a formalisation of the current naming rather than a change
to it.

*Status — **decided, not built**. Neither flow exists. Flow A has no support of any kind: no
`as_token`, `hs_token`, `sender_localpart` or registration file anywhere in the repository. Flow B
has no intake either — nothing accepts a human-supplied token for an agent, because
`ensureAgentAccount` still mints its own credential (decision 3). The table in the amendment above
adds a third mode, **federated invite**, which is the one that is built; it needs no credential, so
it does not satisfy this decision, it postpones it.*

**3. Derived-password self-registration is to be deleted, without a compatibility flag.** Not
deprecated behind a switch: a switch would be used, and it is the only one of the three that
produces a credential nobody can revoke. `MATRIX_AGENT_PASSWORD_SECRET`,
`MATRIX_ALLOW_LEGACY_AGENT_PASSWORD` and the `matrixRegister` path go with it when it goes.

*Status — **decided, not built**, and this decision's own wording is what made that hard to see. It
read "Derived-password self-registration **is** deleted … all **go** with it", which asserts a
completed deletion. Nothing has been deleted. `ensureAgentAccount` still runs the whole ladder —
cached token → login with the derived password → `matrixRegister` — on the default startup path;
`deriveAgentPassword` still hashes `MATRIX_AGENT_PASSWORD_SECRET + ':' + agentName`;
`agentPasswordCandidates` still appends the `MATRIX_ALLOW_LEGACY_AGENT_PASSWORD` template fallback;
and both variables are still published in `.env.example`. The non-revocable credential this decision
exists to abolish is the one the bridge mints today, and the ADR read as though it did not.*

**4. HAFleet may connect agents to MULTIPLE homeservers; the bot stays on one.** The operator's
ruling is that agents must be registerable against different Matrix servers, not a single one.
The split that makes this affordable:

- **The bot keeps one homeserver** — the contributor's own. It is the E2EE sender, the
  authorization service, and the holder of the single crypto store. Rooms hosted elsewhere are
  reachable through **federation**, so a bot on one server does not need an account on another.
- **Each agent carries its own credential record** — `{ homeserver, accessToken }` — and every
  agent-side API call uses that record's base URL rather than the global one.

Measured, so the scope is a number rather than a feeling — and re-measured, because the first figure
recorded here was already stale. As of 2026-08-11 (`a52c3ea` and `a43896a` both) `bridge-matrix.js`
contains **44** `HOMESERVER` references, not 42, and the original 19/23 split does not survive contact
with them. Classified by which access token authenticates the call:

- **18 are agent-side** — agent `whoami`, display name, the avatar retry, the agent invite poll and
  room scan, agent joins and leaves, DM/SPY room creation, `sendAsAgentContent` — and must become
  per-credential.
- **16 are bot-side or global** — the constant itself, `MATRIX_SERVER_NAME`, the bot client, the
  media URL builders, the bot's own sync, invite, kick and `createRoom` — and stay as they are.
- **10 take whichever token their caller holds**: `matrixLogin`, `matrixRegister` (two sites),
  `getUserId`, `getMatrixAccessTokenSession`, `uploadMedia`, `setUserAvatar`, `setRoomAvatar`'s
  `token || state.botToken`, and the two bot-then-agent retry ladders in `_ensureHumanInviteOrFail`
  and `_upgradeLegacyDmRoom`. These cannot be assigned to a side at all: they need the base URL
  passed in with the token, which is a slightly larger change than "make the agent ones
  per-credential".

That third bucket is the substantive part of the correction; the drift from 42 to 44 is only the
reminder that a reference count in a decision record is a snapshot. Treat the total as scope, not as
an invariant — it moved by one inside an uncommitted working tree while this paragraph was being
written.

*Status — **decided, not built**. `HOMESERVER` is still a single module constant read from
`MATRIX_HOMESERVER`, and `state.agentTokens[name]` is still a bare access-token string rather than
`{ homeserver, accessToken }`. The amendment above moves the credential's owner from the agent to the
`(project, agent)` pair, so when this is built it is that shape that gets built, not the one in the
table below.*

**5. An agent's MXID becomes DISCOVERED, not constructed.** Today it is composed as
`@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}`. With a credential from a foreign server that
composition is simply wrong, so the identity must come from `/whoami` on the agent's own
homeserver and be stored beside the credential.

This is load-bearing rather than tidy. The owner-derivation expression in the agent invite poll —
`inviteState.find(e => e.type === 'm.room.member' && e.state_key === '@' + AGENT_PREFIX + agentName +
':' + MATRIX_SERVER_NAME)?.sender` in `bridge-matrix.js`, cited by its text rather than by a line
number per ADR-007's symbol-first convention, and because the original citation here,
`bridge-matrix.js:3932`, had already drifted past two hundred lines — derives the owner by searching
the invite state for a **constructed** MXID. For an agent on any other homeserver that filter never
matches, so no binding is written, and every approval for that agent is later denied with
`owner_binding_missing` — a silent authorization failure rather than an error. That line is also the
one the ADR-002 audit found untested: no fixture ever makes *this* `state_key` filter reject
anything. (`tests/join-backfill.test.js` does have a rejecting fixture for a `state_key` filter, but
it is the backfill selector's bot-membership check, a different filter in a different function; it is
easy to mistake for coverage of this one.) The untested filter and the multi-homeserver breakage are
the same defect seen from two directions.

*Status — **decided, not built**. `agentUserId()` still composes `@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}`
through `makeUserId()`, the filter above still matches that construction, and no agent MXID is stored
anywhere beside a credential because there is no credential record to store it beside (decision 4).*

**6. A dead credential is a human-visible state, not a retry loop.** Flow A's `as_token` does not
expire. Flow B's access token can be revoked, expired by server policy, or invalidated by
deleting its device — and unlike a derived password, **nothing can re-mint it**. So a failed
`/whoami` on an agent credential must surface as an explicit "this agent's credential is invalid
and a human must re-issue it" state on the operator's surfaces, carrying which agent and which
homeserver. It must not be absorbed into a background retry: the symptom would otherwise be an
agent that has silently stopped speaking.

*Status — **decided, not built**. No such state exists on any surface, and the current code does the
opposite by design: a failed agent `whoami` in `ensureAgentAccount` falls straight through to a
derived-password re-login, which is precisely the self-healing retry this decision forbids. That
fall-through is not a bug today — under a derived password it works — which is why it has to be
removed in the same change that lands flow B rather than after it.*

**7. Flow B requires a DEDICATED login, and this must be stated where an operator will read it.**
An access token identifies a *device*. If an operator pastes a token from their own Element
session to save time, the bridge and a human client share one device and advance the same
Olm/Megolm state from two stores — which can break decryption for both, durably. ADR-008 already
binds the crypto store to the token's device, so the machinery to detect a change exists; what
does not exist is the rule.

*Status — **decided, not built**. The rule is still stated only here, which is the one place the
decision itself says is not enough. `.env.example` documents the Matrix variables without it, and
there is no startup check that would refuse or warn about a shared device. Nothing about this waits
on flow B: it is a paragraph in operator-facing documentation plus, optionally, one check.*

**8. Sequencing: the ADR-008 crypto-store defect is a prerequisite, not a parallel task.**
`lib/matrix-crypto-store-identity.js` treats a store containing only the placeholder
`bot-sdk.json` (`{}`, which matrix-bot-sdk writes the instant the storage provider is
constructed, before any device id exists) as "contains data but has no device identity" and
refuses to start — permanently, and with no documented recovery path. Reproduced across five
store shapes. Today that window is widest on first deployment; under flow B, re-issuing a token
means a new device, which means the archive path runs routinely, so the defect moves from rare to
ordinary. It must be fixed before flow B ships.

*Status — **built**. `lib/matrix-crypto-store-identity.js` now excludes `bot-sdk.json` by name when
deciding whether a store "contains data", so a directory holding only that `{}` placeholder is
treated as empty and start-up proceeds. The prerequisite is therefore discharged; it is the only
part of this ADR whose implementation unblocks the rest.*

## Consequences

These are the consequences the decisions above would have, not outcomes anyone has observed. Per the
status table, only decisions 1 and 8 and the amendment are built, so nothing below has happened yet.

Good, because the credential a compromise yields becomes **revocable**, which the derived
password never was; because onboarding onto a homeserver we do not administer becomes possible at
all; because flow A removes per-agent credentials entirely for the common case; and because
`ensureAgentAccount`'s login/register/derive machinery disappears rather than being maintained.

Good, because AppService is unusually cheap here. The hard part of appservice bridges is E2EE for
puppet accounts, and HAFleet's agents send **plaintext** — `sendAsAgentContent` is a raw
`PUT /rooms/{id}/send/m.room.message/{txn}` with no crypto path, and the only crypto store is the
bot's. Flow A therefore does not inherit the problem that makes mautrix-style bridges complex.

Bad, because flow B loses self-healing. A derived password could always re-login; a pasted token
cannot be renewed, so credential expiry becomes an operator task. Decision 6 exists to make that
visible rather than mysterious, and it is a real ongoing cost, not a one-off.

Bad, because flow B is manual per agent. For the fleet size this product targets — a contributor
lending a handful of agents — that is acceptable; it would not be for fleets of fifty, and flow A
is the answer there.

Bad, because agents on different homeservers can only share a room where those servers federate.
Where they do not, an agent from one simply cannot serve a project on the other, and no amount of
credential work changes that. This is a property of Matrix, and it should be stated to an operator
rather than discovered.

## Alternatives Considered

- **Keep derived-password self-registration and add BYO alongside it:** rejected. Keeping it
  means keeping the one path that requires account-creation privilege *and* yields
  non-revocable credentials. A flag left in place is a flag someone uses.
- **AppService only:** rejected because it still needs a server admin to install a registration,
  so it does not solve the third-party homeserver case — the case that motivated this decision.
- **Rotate `MATRIX_AGENT_PASSWORD_SECRET` on a schedule instead:** rejected because there is no
  rotation path. Every derived password changes at once and the usernames are already taken.
- **Give every agent an account on the bot's homeserver and rely on federation only:** rejected
  because it re-introduces the account-creation privilege for the one case where we may not have
  it, and because a project may require the agent to be a local account on its own server.
- **Per-agent homeserver for the bot as well:** rejected as unnecessary. Federation already lets
  one bot serve rooms hosted elsewhere, and a second bot identity would mean a second crypto
  store, a second device, and a second E2EE state machine — the ADR-008 surface doubled for no
  gain.
