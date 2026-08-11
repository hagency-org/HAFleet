---
kind: requirement
id: REQ-CONTRIBUTION-CONSOLE
title: "Resource contribution console: capability, engagement, and declared ceilings"
status: Accepted
liveness: auto
tags: [console, engagement, capability, seat, ceiling, matrix, audit]
---

## Problem

HAFleet's dashboard was designed around a dispatcher: it answered "who is working on
what". The operator's actual position is the opposite one. They own agents and lend
capacity; scheduling belongs to whoever borrows it. A console built on the dispatcher
premise shows a provider information they cannot act on, and hides the three things
they can: what they are offering, on what terms, and what it is costing them.

Four records the design depends on did not exist. A gap audit found `seat`,
`credentialHome`, `planType` and `quota` with zero occurrences anywhere in `lib/` or
`backend-v2.js`, so every surface that showed them was drawing a picture of a record
with no storage behind it. Separately, approving an engagement changed nothing about
the world: six active engagements stood against zero bindings.

Consumption is the harder half. HAFleet launches a coding CLI that talks to its
provider directly, so no API response passes through HAFleet to read a usage figure
from — in api-key mode as much as on a subscription. A console that shows a number
there would be inventing it.

Consumption here means **tokens**, not money. ADR-013's amendment of 2026-08-10 withdrew
R8's `PriceBook` and `BillingSource`: converting tokens to currency depends on contract,
plan, region and negotiated rate, none of which HAFleet observes, so it belongs to a
different system. The implementation had already settled this — every interface is
denominated in tokens and `currency` appears nowhere in the stores.

## Requirements

[REQ-CONTRIBUTION-CONSOLE-INWARD] The console MUST answer what the provider offers, on
what terms, and how much of their capacity it consumed. It MUST NOT schedule work, and
MUST NOT present a scheduler, lease, queue, or work-assignment surface.

[REQ-CONTRIBUTION-CONSOLE-UNIT] The unit of account MUST be the token. Every ceiling,
quota, offer cap, rate cap and allocation MUST be denominated in tokens. The console MUST
NOT convert tokens to currency, because the rate depends on contract, plan, region and
negotiated terms that HAFleet does not observe, and on a fixed subscription the marginal
cost of a token is zero — so a monetary figure per engagement would be an allocation of a
bill paid regardless, not a charge.

[REQ-CONTRIBUTION-CONSOLE-ROLES] A borrower MUST request a role and MUST NOT be able to
select an agent; a named agent MUST be honoured only if it independently qualifies for the
role, and refused otherwise. The resource that serves a role MUST be disclosed to the
borrower — agent, framework, model and reasoning level — because a borrower who cannot tell
one model from another must discount every offer to the worst case, which makes a
contributor's strong subscription indistinguishable from a weak one. The provider's
deployment MUST NOT be disclosed: host, workspace path, credential home, seat, API keys,
tmux session, owner MXID and environment variable names are private, and a failure reported
to a project MUST NOT carry the provider's own configuration as its remedy.

> Rewritten 2026-08-11. This statement previously required the opposite — that the
> `role → (agent × model)` mapping stay private. See the amendment at the head of
> `knowledge/decisions/adr-013-resource-contribution-console.md`: choosing stays the
> provider's, knowing becomes the borrower's.

[REQ-CONTRIBUTION-CONSOLE-VOCABULARY] The role vocabulary MUST come from the system's
own enumeration. A provider MAY decline to offer a role or a model combination, and
MUST NOT introduce a role name the borrower cannot recognise. An excluded combination
MUST state its reason rather than be omitted.

[REQ-CONTRIBUTION-CONSOLE-CROSS-FAMILY] A role requiring two model families MUST NOT be
reported as fillable by a single family, however many agents qualify on tier. Any field
summarising fillability MUST agree with the cross-family constraint reported beside it.

[REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY] The whitelist MUST key on the authenticated
`projectRoomId` reported by Matrix. It MUST NOT key on a project name, and MUST NOT
accept a room id supplied in message content.

[REQ-CONTRIBUTION-CONSOLE-ROUTE] An inbound request MUST auto-join only when the room is
whitelisted AND the request is within the published offer AND within the serving agent's
remaining ceiling. A request exceeding the offer or the ceiling MUST fall back to
approval, not rejection. An absent or unpublished offer MUST NOT be treated as
unlimited.

[REQ-CONTRIBUTION-CONSOLE-UNKNOWN-LIMIT] An unknown limit MUST NOT auto-join. A null
ceiling, an unstated rate against a published rate cap, and a quota whose period is
unknown MUST each fall back to approval rather than be read as unbounded.

[REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT] A request carrying a `request_id` MUST produce at
most one engagement. Repeating the same `request_id` with the same request digest MUST
return the existing engagement; the same `request_id` with a different digest MUST be
refused as a conflict rather than merged or overwritten. The `request_id` for a request
arriving over Matrix MUST be the authenticated event id, never a value taken from message
content. A request with no `request_id` MUST record that it could not be deduplicated
rather than be assigned a generated one.

[REQ-CONTRIBUTION-CONSOLE-WHITELIST-AUDIT] Adding to or removing from the whitelist MUST
be audited. Removal MUST affect only future requests and MUST NOT terminate a running
engagement.

[REQ-CONTRIBUTION-CONSOLE-BIND] Approving an engagement MUST attach the agent to the
project room with an owner. A verdict that cannot resolve an owner MUST report the
failure to the caller and record it, and MUST NOT report success.

[REQ-CONTRIBUTION-CONSOLE-CEILING-SEAT] A declared per-agent ceiling MUST be treated as
a sub-allocation of the seat that funds it, keyed on the credential home rather than the
agent. A declared total exceeding the seat's quota MUST be surfaced as over-subscription.
Ceilings stated in different periods MUST NOT be summed, and a quota with no period MUST
NOT be compared.

[REQ-CONTRIBUTION-CONSOLE-OVERCOMMIT] The decision surface MUST name the agent whose
ceiling an allocation would spend, and MUST refuse an over-committing allocation at the
point of decision rather than afterwards.

[REQ-CONTRIBUTION-CONSOLE-BLANK] An unmeasured quantity MUST be rendered as unknown with
its reason stated in place, and MUST NOT be rendered as zero. Allocations, which are
known, MUST be kept distinct from consumption, which is not.

[REQ-CONTRIBUTION-CONSOLE-UNENFORCED] While no component measures consumption, every
ceiling, quota and cap MUST be reported as declared and unenforced wherever it is shown
or returned.

[REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE] Metering availability MUST be reported per
dimension and per framework. A dimension with no measurement MUST report its absence and
the reason, and MUST NOT be inferred from a dimension that is measured.

[REQ-CONTRIBUTION-CONSOLE-PROVENANCE] The console MUST report, per data slice, whether
the slice came from the live backend or from a fixture. A single slice MUST NOT imply
provenance for another.

[REQ-CONTRIBUTION-CONSOLE-SUBMIT-SCOPE] The credential that submits a request MUST NOT
be able to decide one, widen an offer, or edit the whitelist.

[REQ-CONTRIBUTION-CONSOLE-BROWSER-CREDENTIAL] The browser MUST NOT hold the backend
operator credential. A server-side proxy MUST enforce a default-deny path allowlist,
MUST validate path segments before any decoding and rebuild the outbound path from what
it validated, MUST refuse a cross-site state-changing request, and MUST NOT follow a
redirect.

[REQ-CONTRIBUTION-CONSOLE-DURABLE] A store mutation whose write fails MUST leave memory
matching the state the error reports, including any record trimmed by a cap during the
same mutation. A thrown write MUST roll back exactly as a rejected one does.

[REQ-CONTRIBUTION-CONSOLE-BOUNDED] Records that accumulate without operator action MUST
be bounded. Ended engagements MAY be capped; live engagements MUST NOT be. A bot DM room
whose counterpart has left MUST be released, and a room whose invitation is merely
unaccepted MUST NOT be.

## Scenarios

Scenario: A whitelisted project inside the offer auto-joins
  Given a published coding offer with a budget cap and a rate cap
  And the project room is on the whitelist
  When the project requests coding within both caps and within the agent's ceiling
  Then the engagement becomes active without an operator decision

Scenario: A whitelisted project over the offer falls back to approval
  Given a published offer whose budget cap is below the requested amount
  And the project room is on the whitelist
  When the project submits the request
  Then the engagement awaits a decision and is not rejected

Scenario: A repeated request does not become two engagements
  Given a project has submitted a request carrying an event id
  When the identical request arrives again with the same event id
  Then the existing engagement is returned
  And the queue holds one engagement for that room

Scenario: A reused request id with a changed amount is refused
  Given a pending engagement created under an event id
  When a request reuses that event id but asks for twenty times the tokens
  Then the request is refused as a conflict
  And the original engagement is unchanged

Scenario: An unstated rate does not bypass a published rate cap
  Given a published offer carrying a rate cap
  When a whitelisted project requests capacity without stating a rate
  Then the engagement awaits a decision rather than auto-joining

Scenario: Approval attaches the agent to the project
  Given a pending engagement naming the agent that would serve the role
  When the contributor approves it with an allocation
  Then the agent is bound to the project room with an owner
  And revoking the engagement detaches it

Scenario: An unresolvable owner fails loudly
  Given a deployment with no owner identity configured
  When the contributor approves a pending engagement
  Then the response reports that no binding was created
  And the failure is recorded in the audit log

Scenario: One model family cannot staff a cross-family role
  Given a single agent qualifying on tier for a role requiring two model families
  When the capability surface is read
  Then the role reports that it cannot be filled

Scenario: An unmeasured quantity is not shown as zero
  Given no component measures token consumption
  When a consumption figure is requested
  Then the response reports the measurement as unavailable with its reason
  And every ceiling is reported as declared and unenforced

Scenario: A failed write leaves no phantom trust
  Given a whitelist addition whose persistence throws
  When the caller receives the error
  Then the room is not whitelisted in memory
  And an audit record trimmed during that mutation is restored

Scenario: A pending greeting survives room cleanup
  Given a bot DM whose invitation the human has not yet accepted
  When dead DM rooms are released
  Then that room is retained
  And a DM whose human has left is released

## Dependencies

- ADR-013
- REQ-OWNER-UI-APPROVAL — supplies the owner-scoped approval and binding machinery that
  `REQ-CONTRIBUTION-CONSOLE-BIND` attaches to.

## Traceability

- `REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT` implements PRD acceptance **A-R0-1**
  (`docs/PRD-hafleet-pdu.md:325`), whose traceability row names the gate `CT/IT-R0-IDEMP`
  and the accountable parties as the HAFleet and Robrix2 owners. The shared identifier is
  the Matrix event id rather than a negotiated token: it already exists on both sides, is
  stable, and cannot be forged by the sender.

## Source Trace

- Operator ruling that a budget is a per-agent quantity, enforced against the seat that
  funds it: two agents declaring 5M each against one subscription do not hold 10M.
- Operator ruling that the console serves the resource contributor, not the dispatching
  house; scheduling, leases and work assignment are withdrawn.
- Gap audit of `lib/` and `backend-v2.js` finding zero occurrences of `seat`,
  `credentialHome`, `planType` and `quota` before this work.
- Merged as PR #27 (`e5c2f6a`), reviewed adversarially rather than by a human; the
  caveats are recorded in that merge commit.

## Open Questions

- **Consumption measurement, in tokens.** ADR-013 contract 1 (token metering) is unbuilt,
  and it gates enforcement. It is a token count, not a cost. Session transcripts written by the CLIs themselves do carry usage
  (Claude Code records per-message `usage` with cache reads separated; Codex records
  `total_token_usage` and `last_token_usage`), so a per-framework reader is viable
  without proxying provider traffic. Two questions remain open: whether a session file
  can be attributed to an agent for every framework, and whether consumption overlapping
  two engagements on one agent can be split at all or must be reported per agent only.
- **Enforcement policy.** What a reached cap does is undecided. Refusing new auto-joins
  and alerting is proposed; stopping a running agent mid-task is not, because it converts
  a budgeting decision into lost work.
- **Scoped credentials.** `REQ-CONTRIBUTION-CONSOLE-SUBMIT-SCOPE` is satisfied by a
  separate requester token, but there is still no read-only tier and one shared operator
  token opens the rest of the API. A scope table is required before outward exposure.
