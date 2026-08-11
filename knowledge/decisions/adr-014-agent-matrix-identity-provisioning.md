---
kind: decision
id: ADR-014
title: "Provision agent Matrix identities by server capability, never by derived password"
status: Accepted
liveness: auto
tags: [matrix, identity, credentials, authorization, appservice]
---

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

**3. Derived-password self-registration is deleted, without a compatibility flag.** Not
deprecated behind a switch: a switch would be used, and it is the only one of the three that
produces a credential nobody can revoke. `MATRIX_AGENT_PASSWORD_SECRET`,
`MATRIX_ALLOW_LEGACY_AGENT_PASSWORD` and the `matrixRegister` path all go with it.

**4. HAFleet may connect agents to MULTIPLE homeservers; the bot stays on one.** The operator's
ruling is that agents must be registerable against different Matrix servers, not a single one.
The split that makes this affordable:

- **The bot keeps one homeserver** — the contributor's own. It is the E2EE sender, the
  authorization service, and the holder of the single crypto store. Rooms hosted elsewhere are
  reachable through **federation**, so a bot on one server does not need an account on another.
- **Each agent carries its own credential record** — `{ homeserver, accessToken }` — and every
  agent-side API call uses that record's base URL rather than the global one.

Measured, so the scope is a number rather than a feeling: of the 42 `HOMESERVER` references in
`bridge-matrix.js`, **19 are agent-side** (login, whoami, register, display name, send-as-agent)
and must become per-credential; **23 are bot-side** and stay as they are.

**5. An agent's MXID becomes DISCOVERED, not constructed.** Today it is composed as
`@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}`. With a credential from a foreign server that
composition is simply wrong, so the identity must come from `/whoami` on the agent's own
homeserver and be stored beside the credential.

This is load-bearing rather than tidy. `bridge-matrix.js:3932` derives the owner by searching the
invite state for `state_key === '@' + AGENT_PREFIX + agentName + ':' + MATRIX_SERVER_NAME`. For an
agent on any other homeserver that filter never matches, so no binding is written, and every
approval for that agent is later denied with `owner_binding_missing` — a silent authorization
failure rather than an error. That line is also the one the ADR-002 audit found untested: no
fixture ever makes the `state_key` filter reject anything. The untested filter and the
multi-homeserver breakage are the same defect seen from two directions.

**6. A dead credential is a human-visible state, not a retry loop.** Flow A's `as_token` does not
expire. Flow B's access token can be revoked, expired by server policy, or invalidated by
deleting its device — and unlike a derived password, **nothing can re-mint it**. So a failed
`/whoami` on an agent credential must surface as an explicit "this agent's credential is invalid
and a human must re-issue it" state on the operator's surfaces, carrying which agent and which
homeserver. It must not be absorbed into a background retry: the symptom would otherwise be an
agent that has silently stopped speaking.

**7. Flow B requires a DEDICATED login, and this must be stated where an operator will read it.**
An access token identifies a *device*. If an operator pastes a token from their own Element
session to save time, the bridge and a human client share one device and advance the same
Olm/Megolm state from two stores — which can break decryption for both, durably. ADR-008 already
binds the crypto store to the token's device, so the machinery to detect a change exists; what
does not exist is the rule.

**8. Sequencing: the ADR-008 crypto-store defect is a prerequisite, not a parallel task.**
`lib/matrix-crypto-store-identity.js` treats a store containing only the placeholder
`bot-sdk.json` (`{}`, which matrix-bot-sdk writes the instant the storage provider is
constructed, before any device id exists) as "contains data but has no device identity" and
refuses to start — permanently, and with no documented recovery path. Reproduced across five
store shapes. Today that window is widest on first deployment; under flow B, re-issuing a token
means a new device, which means the archive path runs routinely, so the defect moves from rare to
ordinary. It must be fixed before flow B ships.

## Consequences

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
