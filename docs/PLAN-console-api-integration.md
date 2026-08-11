# PLAN: wire the contribution console to the backend

**Date:** 2026-08-07
**Baseline:** `bed4207acf8cc9e6be28ae4afbe96d30952a7610` on `feat/contribution-console`
**Status:** **P0–P4 implemented and verified (2026-08-08).** See §7 for what landed,
what the build changed about this plan, and what remains open.
**Governs:** the five contracts in
[`../knowledge/decisions/adr-013-resource-contribution-console.md`](../knowledge/decisions/adr-013-resource-contribution-console.md) §7
**Audience:** an agent who has not seen the gap audit. Everything asserted here was checked
against the baseline; the evidence column is the check.

---

## 0. The fact that sets the shape of this plan

**The console currently makes zero backend calls.** `mockup/lib/mock-data.js:480` defines
`API_BASE`, and its only use is `presetCommand()` at `:499`, which renders a `curl` example
string. There is no `fetch`, no SWR, no proxy. Every page renders from fixtures.

So this is not an interface-mismatch problem. The integration layer does not exist, and it is
**contract zero** — absent from ADR-013's list of five because that list enumerates missing
*domain* records, not missing wiring.

Scale for orientation:

| surface | size |
|---|---|
| `backend-v2.js` route registrations | 101 |
| existing dashboard (`lib/dashboard/`) | 6 pages, 24 proxied endpoints |
| contribution console (`mockup/`) | 10 routes, 0 API calls |

### Read before writing code

| file | why |
|---|---|
| `lib/backend/auth-adapter.js` | `createApiAuthMiddleware` — the whole `/api` auth model, and why there is no read-only credential |
| `backend-v2.js:6876` | `serializeAgent()` — the exact field list `GET /api/agents` returns |
| `backend-v2.js:8114`, `:8146-8151` | where `presetId` arrives and where it is lost |
| `lib/frameworks/index.js:163-243` | `listFrameworks()`, `launchableFrameworkIds()`, `launchBlockedReason()` — all written, none routed |
| `lib/matrix-agent.js:11-75` | the role model actually in use, including `canonicalRole()`'s name-substring inference |
| `lib/alert-store.js:110-130`, `:298-328` | the actionability downgrade rule and the full 25-field alert record |
| `lib/approval-store.js:19`, `:186` | `ROOM_ID_RE` and `upsertBinding()` — the pattern P4 copies |
| `lib/role-capacity.json` | the role→model enumeration; today only `mockup/` reads it |

---

## 1. Gap inventory

### 1.1 Eight endpoint groups do not exist

| endpoint | purpose | evidence it is absent |
|---|---|---|
| `GET /api/frameworks` | list the five manifests: `id`, `displayName`, `launch.{command,defaultArgs,modelFlag,permissionSummary}`, `guards`, launchability | no `/api/frameworks` route; `listFrameworks()` exists and is unrouted |
| `GET /api/frameworks/detect` | scan the host: which frameworks are installed, versions, usable | nearest prior art is `bin/hafleet-up:1804`'s `command -v claude` — shell-level, one framework, no API |
| `/api/seats` | the accounting root: one credential home = one quota | `seat`, `credentialHome`, `planType`, `quota` all have **zero** occurrences in `lib/` and `backend-v2.js` |
| `GET /api/capability` | role → how many I can fill, computed server-side | `role-capacity.json` has no consumer outside `mockup/` |
| `/api/engagements` | inbound request + approve/reject writing a per-agent allocation | `engagement` — zero occurrences |
| `/api/offers` | the standing offer per role | zero occurrences |
| `/api/whitelist` | default-deny trust list, audited | `whitelist`/`allowlist` — zero occurrences |
| `GET /api/usage` | consumption per project and per agent | `tokensUsed`, `allocatedTokens` — zero occurrences |

### 1.2 Two field extensions on endpoints that already exist

- **`presetId` on the agent record.** Accepted at `backend-v2.js:8114`, resolved into a
  `runtimeProfile` at `:8149-8151`, then discarded — the string appears 4 times in the whole file
  and is never written to `agents[agentName]`. Consequence: the console can read an agent's
  resolved model, but cannot say which named preset produced it, so a preset's ceiling cannot be
  reached from an agent and editing a preset cannot identify who is affected.
- **`ceiling { tokens, period, rateCapPerDay }` and `seatId` on a preset.** `POST`/`PUT
  /api/framework-presets` already persist arbitrary preset fields; these two need to be
  normalized, validated and returned.

### 1.3 One access gap — the endpoint exists and the console cannot call it

`GET /api/approval-bindings` is guarded by `requireApprovalBridgeSecret`, a bridge-only secret.
The binding is the record ADR-013 §Context calls "the contribution record already exists under
another name", so the half that exists is behind the wrong credential.

Worse, there is no scoped credential to issue. `createApiAuthMiddleware` blankets all of `/api`:
when `apiToken` is unset **everything is open**; `isLocalRequest(req)` **bypasses auth entirely**;
otherwise a single shared `Bearer ${API_TOKEN}` is required. A console holding that token can also
call `DELETE /api/agents/:name` and `POST /api/agents/:name/start`. There is no read-only tier.

> Do not read the earlier "41 routes have no guard" figure anywhere as an auth hole. That was a
> line-prefix parse artifact: guards like `_alertTransitionAuth` do not match a `require*` pattern,
> and the global middleware at `backend-v2.js:7589` covers the surface. **No auth hole was found.**

### 1.4 One gap that is not an API

Token metering. This is a measurement problem, not a schema problem, and it gates whether every
ceiling in the product is a guardrail or a decoration. See P3.

### 1.5 The reverse direction — real backend capability the console drops

Worth fixing in P0 because it costs almost nothing and the data is already there.

| available | console today |
|---|---|
| The alert record's 25 fields (`lib/alert-store.js:298-328`): `runbook`, `impact`, `recoveryCondition`, `correlation`, `owner`, `linkedTaskId`, `dedupeKey`, `tags` | fixture carries 10 |
| **`originalSeverity` + `missingActionableFields`** | dropped. `lib/alert-store.js:125-128` downgrades a `warning`/`critical` with missing actionable fields **to `info`**. A console user sees `info` with no way to know it was a downgraded `critical`. |
| `GET /api/project-board` — `buildProjectBoardSnapshot()` at `lib/project-board.js:434` already joins groups, agents, tasks, graphs and messages with privacy filtering | not called; `/usage` rolls up by project from fixtures |
| `GET /api/servers/fleet`, `/api/agents/:name/{groups,tasks,delivery-events}` | not called |
| `GET /api/pool`, `/api/dispatch{,/renew,/release}` — a working role×tier selector with owner-bound leases | **deliberately dropped** by ADR-013 §1. Not a gap. |

---

## 2. The plan

Five phases in dependency order. Each is independently verifiable; none waits on the next except
where stated.

### P0 — the integration layer, and the free wins

No new domain model. Turn the console from fixture-driven into real for the three surfaces that
are already complete server-side.

1. **A data layer in `mockup/lib/`** that fetches instead of importing fixtures, keeping the
   existing export names so pages do not change. `mock-data.js` stays as the fallback and as the
   fixture for the assertion scripts.
2. **Wire the three real surfaces:**
   - `GET /api/agents` — `serializeAgent()` returns `runtimeProfile` with secrets redacted, so
     `/resources`' model, provider and reasoning columns become real immediately.
   - `framework-presets` — all four CRUD routes exist under `requireBearer`. `/config` and the
     wizard's write path become real.
   - `alerts` — `GET /api/alerts`, `/stats`, `POST /:id/transition`, `/:id/notes`, `PATCH`,
     `DELETE` all exist. `/alerts` becomes real.
3. **`GET /api/frameworks`** — a route over `listFrameworks()`, plus `launchableFrameworkIds()`
   and `launchBlockedReason()` so the wizard can say which frameworks cannot launch and why.
   Follow the response convention of the nearest sibling route rather than inventing a third one:
   `/api/agents` returns a bare array, `/api/approval-bindings` returns `{ ok, bindings }`.
4. **Persist `presetId`** on the agent record and return it from `serializeAgent()`.
5. **Surface the dropped alert fields**, `originalSeverity` and `missingActionableFields` first.
   An `info` that was downgraded must say so on the row.
6. **Fix the invariant that does not test what its name says.**
   `mockup/scripts/check-invariants.mjs:117` is labelled "subsumption from matrix-agent.js" but
   the script never imports `lib/matrix-agent.js` — it only reads `role-capacity.json`. Import the
   real constants and assert the join, so a change to `ROLE_DEFAULT_TIER` fails the suite. Today it
   would not.

**Verified by:** the existing 90 static + 31 browser assertions, run against the real backend
rather than fixtures; plus new assertions for the alert fields and the matrix-agent join.
**Unblocks:** everything. After P0 the console is a real client and each later phase has a place
to land.
**Size:** small. Items 3, 4 and 6 are a few lines each.

### P1 — one role vocabulary

Today there are four copies, and the one that governs is the weakest.

| location | content |
|---|---|
| `lib/matrix-agent.js:14` `ROLES` | the canonical six — **used nowhere in the repository, not even inside its own file** |
| `lib/dashboard/render/pool-page.js:43` | the same six as a hardcoded literal |
| `scripts/provision-team.mjs:21` | `coordinator` / `implementer` / `reviewer` / `final_reviewer` — four legacy names, and **this is the copy that actually provisions agents** |
| `lib/role-capacity.json` | the six plus the model enumeration — only `mockup/` reads it |

`canonicalRole()` (`lib/matrix-agent.js:45-55`) bridges the legacy names to the canonical six by
substring-matching the **agent name**, and `agentCapability()` falls back to the role's default
tier when `capability` is unset. So an agent whose name contains `architect` is offered as a
`strong` architect **without reference to the model it runs**. That is a correctness defect
independent of this console.

1. Make `role-capacity.json` the single source. Delete the `pool-page.js` literal in favour of it;
   map `provision-team.mjs`'s legacy names to canonical roles explicitly rather than by substring.
2. Reconcile the model-string mismatch: `role-capacity.json` uses full ids (`claude-opus-5`),
   `TIER_RUNTIME` uses short names (`{ runtime: 'claude', model: 'opus' }`). They do not join
   today. Pick full ids and adapt `TIER_RUNTIME`, since the short names cannot express
   `gpt-5.6-sol` at three reasoning levels.
3. Derive role eligibility from the resolved `runtimeProfile` — framework, model **and
   reasoning** — not from the agent name. `reasoning` is not optional in the match: the same model
   string sits at three tiers with only the thinking level separating them.
4. **`GET /api/capability`** — role → qualifying combinations, how many I can fill, and when zero,
   whether the cause is a model I have not configured or an agent I do not own. Different problems,
   different actions.

**Verified by:** unit tests on the eligibility function including the reasoning-sensitive cases,
plus an assertion that no role vocabulary exists outside `role-capacity.json`.
**Depends on:** nothing. Can run in parallel with P0.
**Size:** medium — the blast radius is wide but the code is pure functions.

### P2 — the accounting root

1. **`Seat` and `SeatBinding`.** Seat identity derives from the credential home. Follow PRD R8:
   a deployment-keyed HMAC with a key id and rotation policy, never a raw path and never a
   globally correlatable hash. The fact this models is verified:
   `bin/hafleet-up:1640-1644` unsets `ANTHROPIC_API_KEY` for Claude agents unless a per-agent
   runtime profile supplies one, and `$HOME` is never reassigned in the launch path — so Claude
   agents share the operator's authenticated subscription and its quota by default.
2. **`ceiling` and `rateCap` on preset/agent, referencing a `seatId`.**
3. **Over-subscription is computed and shown.** Two agents each declaring 5M against one
   subscription do not have 10M. A declared ceiling exceeding its seat's remaining quota is
   surfaced, not silently accepted.
4. Nothing is enforced yet. Every ceiling is labelled a declaration of intent.

**Verified by:** tests that two agents on one seat cannot jointly promise more than the seat, and
that an API-key-mode agent is accounted separately from the subscription seat.
**Depends on:** P0 item 4 (`presetId` reachable from an agent).
**Size:** medium. There is no prior art to extend — the four concept words have zero occurrences.

### P3 — metering (the gate, and the hard one)

Not a schema addition. Interactive subscription sessions do not report per-call usage the way an
API does. Three sources, to be pursued together rather than chosen between:

1. **Measured busy time as the honest floor.** Already required independently by the PRD's
   A-R7-3: render missing provider usage as `unknown` with measured busy time, **never as zero**.
   Ship this first — it is achievable now and makes the gap legible.
2. **Real numbers in API-key mode.** Providers report usage there. Note from P2 that this is the
   deliberate exception path, not the default.
3. **Session-log parsing** wherever a framework writes usage itself. Per-framework, best-effort.

Expect that subscription mode yields no per-call figures. The deliverable is therefore a clear
partition: which cells carry a measured number, which carry a blank with a reason. Do not close
this phase by inventing a rate estimate and calling it usage.

**Verified by:** a test that an unmetered engagement renders a reasoned blank and never `0`, and
that a metered one reports the provider's figure unmodified.
**Depends on:** P2 for something to meter against.
**Size:** large, with a genuinely uncontrolled component.

### P4 — engagement, offer, whitelist

Model on `approval-store`: durable, audited, terminal states, TTL.

1. **`/api/engagements`** — `{ project, projectRoomId, role, requestedBudget, rate, requester,
   status }`. Approve writes a per-agent allocation, checked against the seat's remaining quota at
   the point of decision. The record must name **which agent would serve the role before** the
   decision, not after.
2. **Routing** exactly as ADR-013 §4: whitelisted and within the offer → auto-join; whitelisted
   but over → **falls back to approval, not rejection**; not whitelisted → awaits approval.
3. **`/api/whitelist`** — keyed on `projectRoomId`, never a name. `ROOM_ID_RE`
   (`lib/approval-store.js:19`) already validates room ids strictly. Default-deny, on the model of
   `TRUSTED_HAFLEET_COORDINATION_TOOLS` (`lib/codex-permission-hook.js:15`). Both add and remove
   are audited. Removal affects only future requests and must not terminate running engagements.
4. **`/api/offers`** — `{ role, count, budgetCapPerEngagement, rateCap, published }`.
5. **A bearer-readable, redacted binding projection**, replacing the bridge-secret path for the
   console's read. Do not widen `requireApprovalBridgeSecret` — add a projection that omits
   `ownerDmRoomId` and anything else the console has no business seeing.

**Verified by:** all three routing branches exercised; an over-committing approval rejected at
submit; a whitelist removal leaving a running engagement alive; both trust mutations present in
the audit log.
**Depends on:** P1 (role matching), P2 (seat quota to check against).
**Size:** medium.

---

## 3. Cross-cutting, and required before anything faces outward

**Scoped tokens.** One shared `API_TOKEN` for the whole surface, plus a local-request bypass, is
adequate for an operator running the console on their own host. It is not adequate for anything a
project side can reach, and it cannot express "this credential may read capability but not delete
an agent". Until a scoped tier exists, the console is a localhost tool. Treat this as a
precondition of any outward exposure, not as a later hardening pass.

---

## 4. How to verify, given what went wrong this round

Three failures from the console's own build are worth carrying forward, because each produced a
passing check over a real bug:

- **A static assertion cannot see generated content.** Two assertions written against server HTML
  passed while the defect was live, because the value came from an effect. Anything that depends on
  runtime state belongs in the browser suite.
- **A mutation test only counts if the mutation lands where you think.** The first mutation test of
  the `代理` ban did not fail, because `replace(…, 1)` hit the English dictionary, which the check
  does not inspect.
- **Mutation testing cannot detect a shared oracle.** Two assertions passed mutation testing while
  being tautologies, because they and the code under test derived the expected value the same way.
  For P3 in particular: do not assert a usage figure against the estimator that produced it.

Add to that the one this audit found: **`check-invariants.mjs:117` names `matrix-agent.js` in its
label and never imports it.** A check whose name claims a cross-file guarantee must read the other
file.

---

## 5. Governance precondition

`specs/project.spec.md:18` requires that active implementation work be linked to **accepted
requirements** through `satisfies`. ADR-013 is a decision, not a requirement, and is currently
`status: Proposed`. So before P0 opens:

1. ADR-013 moves to `Accepted`, or its §5 and §7 are amended first;
2. a paired `knowledge/requirements/req-*.md` is written and accepted, on the model of
   `req-project-board.md` beside `adr-009` — testable `MUST` statements plus Gherkin scenarios for
   the five phases;
3. `docs/PRD-hafleet-pdu.md` reaches v0.3, since its supersession notice currently marks R0 and the
   dispatch requirements as not implementable.

Items 1 and 2 gate code. Item 3 gates scheduling other workstreams against the PRD.

---

## 6. Out of scope

- Dispatch, the role×tier capacity grid, leases, the queue, performance scoring and the
  knowledge/memory surfaces. Withdrawn by ADR-013 §1. `GET /api/pool` and `/api/dispatch` remain in
  the backend and are not to be wired into this console.
- Replacing the existing dashboard at `lib/dashboard/`. It proxies 24 endpoints across 6 pages and
  is unaffected by this plan.
- `Matrix Space = Project` migration. PRD §2.1 requires its own amending ADR against
  `adr-009`/`REQ-PROJECT-BOARD`; nothing here depends on it.
- Enforcement of ceilings. P2 ships them as declarations; enforcement needs P3 to exist first and
  is a separate decision about what happens when a cap is hit.

---

## 7. What landed, and what the build changed about this plan

Implemented 2026-08-08 against the baseline above. Verification: **73 live UX checks**
(`mockup/scripts/live-ux.mjs`, Playwright against a running backend), **90 static
invariants**, **31 in-browser switch checks**, and **2187 backend tests** — all passing,
and the live suite is repeatable without a reseed.

### 7.1 Endpoints added

| endpoint | notes |
|---|---|
| `GET /api/frameworks` | Projects the compiled manifests. A bare `res.json(listFrameworks())` would have shipped empty guards — `RegExp` and `Set` flatten to `{}` — so a client would read "this framework refuses nothing". |
| `GET /api/capability` | The first consumer `lib/role-capacity.json` has ever had. Distinguishes `no-model` from `below-tier`, and reports over-tier rather than refusing it. |
| `GET /api/usage` | Carries a `metering` block declaring availability per signal. |
| `GET /api/seats`, `PUT`/`DELETE /api/seats/:seatId` | Identity derived, quota declared. |
| `GET`/`POST /api/engagements`, `POST /:id/verdict`, `POST /:id/revoke`, `GET /api/engagements/audit`, `GET /api/engagements/preview` | |
| `GET`/`PUT /api/offers`, `GET`/`POST`/`DELETE /api/whitelist` | |
| `GET /api/contributions` | The bearer-readable projection of the approval binding, omitting `ownerDmRoomId`. |

Field extensions: `presetId` now persists on the agent record and is returned by
`serializeAgent()`; `ceiling { tokens, period, rateCapPerDay, enforced:false }`
persists on a preset. Both were verified by round-trip against a running server, not
by reading the handler.

### 7.2 Three things the plan got wrong

- **Name inference is not a defect.** §P1 called `canonicalRole()`'s substring matching
  a correctness bug. `tests/matrix-agent.test.js` asserts it deliberately: it is the
  documented path that lets pre-existing `<team>_<role>` agents join the matrix without
  re-registration. What was actually missing is that the resolved MODEL was never
  consulted at all. So `agentCapability()` gained a model-derived step ABOVE the
  name-derived default rather than replacing it, and all 27 pre-existing tests still pass.
- **`provision-team.mjs` is not a fourth copy of the vocabulary.** Its `role` values are
  agent-name suffixes, which is what `canonicalRole()` exists to bridge. The change made
  the mapping explicit (`canonical:`) and bound it with a test, rather than deleting it.
- **API-key mode does not yield token numbers.** §P3 assumed providers report usage
  there. They do — but not to HAFleet, which launches a CLI that talks to the provider
  directly. No API response passes through this process in either mode. The routes that
  could work are the framework's own session logs, or becoming a proxy; both are
  decisions, and both are named in the `metering` block rather than merely admitted.

### 7.3 Defects the live data exposed that a fixture could not

Each of these rendered correctly against the fixture and was wrong against a backend:

- **The rail showed the fixture's five agents beside a live table** — same screen
  disagreeing with itself — and separately filtered on `alive !== false`, which excludes
  nothing when every fixture agent is alive and excluded EVERYTHING against a real
  backend whose agents are registered but not running. It read `AGENTS · 0` next to a
  five-row table.
- **Every ceiling cell assumed `preset.ceiling` existed.** It never did upstream.
- **`/api/agents` returns no `presetId`**, so no page could name the preset behind a model.
- **Fixture contract slices spliced onto live data** produced a usage table listing work
  for agents the backend did not have. Contract slices are now emptied whenever any live
  slice answered.
- **`fmtTokens` printed `-4000000` raw**, because seat headroom can now go negative and
  the function only handled positive magnitudes.
- **`lib/seat-store.js` contained a NUL byte** from an unintended separator in the HMAC
  material. Replaced with a JSON encoding, which needs no assumption about which
  character cannot appear in a server id.

### 7.4 What the verification harness had to learn

- **The seed must not look like the fixture.** The first live run reported "every live
  agent name appears" as PASSING while the page showed pure fixture data — the backend
  had been seeded with the fixture's own names, so the assertion could not tell its two
  possible sources apart. Fixed structurally: `scripts/seed-live.mjs` uses names and
  models that appear nowhere in the fixture, and every page suite additionally asserts
  that no fixture-only value is on screen.
- **A partial wipe leaves a dirty oracle.** Alerts outlive the agents that caused them,
  so re-seeding without clearing the alert store left stale names on screen.
- **A suite that consumes state must replenish it.** The write checks approve, reject and
  transition; run three times they exhausted their own supply. Engagements are now created
  by the suite; the alert check uses `open ⇄ suppressed`, the one reversible pair in the
  transition graph, and restores what it moved.
- **Skips are reported as SKIP, never as ok.** Used only where the precondition is outside
  the suite's control.
- **Two assertions had to be rewritten because their names had drifted from their
  subjects** — a check reporting green about something it never looks at is worse than a
  missing one. Both are now pinned to invariants rather than to which slices happen to be
  unimplemented today.

Three mutation tests confirm the routing rules are load-bearing: rejecting instead of
falling back on `overCeiling`, auto-joining against an unknown ceiling, and terminating
live engagements on a whitelist removal each fail exactly the assertion that names them.

### 7.5 Closing the loop against real components

Everything above validates hafleet against hafleet. `mockup/scripts/e2e-full-loop.mjs`
validates it against a real homeserver, a real bridge, a real GUI client and a real
browser at once: `@lin` posts `!request architect 300000 20000` into a room it creates on
the Palpo deployed to mini1, the running `bridge-matrix.js` picks it up, Playwright clicks
**Approve** in the console, and the suite asserts a binding appears and that revoking
detaches it. 19 checks, stable across repeated runs.

It found two defects and one limit.

**Pre-join message loss — found here, root-caused, fixed.** Sync delivers only events
from after the join point, and nothing backfilled a room the bot joined by invite. So
anything said in the invite→join window was lost **permanently**: no engagement, no reply,
no error. Confirmed against the deployment — a `!request` at t+0 into a fresh room, bot
joined at t+2s, still unanswered 80 seconds later. `backfillAgentManagedRooms()` did not
cover it, because it only walks rooms that already have an agent binding: the backfill was
gated on the very state the dropped message was trying to create.

The fix is `backfillJoinedRoom()` plus two exported, unit-tested decision functions in
`bridge-matrix.js`. On a successful join the bot fetches recent messages and routes them
through `onRoomMessage`, which keeps trust, sender filtering and dedup exactly where they
already were — the backfill decides only *which* events to deliver, never whether they are
allowed.

Two things about it are worth recording, because both were wrong first:

- **The floor cannot come from `inviteEvent.origin_server_ts`.** That was the first
  attempt. Sync's `invite_state` is STRIPPED state — type, sender, state_key, content, and
  no timestamp — so the value was always absent, the fallback was `Date.now()`, and a floor
  of "now" sits *after* the pre-join message. The backfill silently discarded exactly what
  it existed to deliver. `resolveJoinBackfillFloor()` now tries four sources in order:
  `origin_server_ts`, `unsigned.age`, the bot's own invite found in the fetched timeline,
  and last a bounded 5-minute window. In practice the third one fires. A floor is never
  "everything" — replaying a room's history would run commands nobody just issued,
  including a `!request` from a previous membership.
- **A no-op backfill must be as visible as a delivering one.** The first version logged
  only when it delivered something, and that ambiguity immediately misled me: a pre-join
  `!request` was answered, no backfill line appeared, and the obvious reading — "the fix
  works" — was wrong. Sync had won the race and the backfill had correctly deduped to
  zero. The log line is now unconditional and carries `already-synced`, which is what
  distinguishes the two. Three consecutive live runs report
  `eligible=1 delivered=1 already-synced=0`, so the attribution is not a guess.

Covered by `tests/join-backfill.test.js` (15 tests, all five mutations of the logic caught
— including one that survived until the fixture was reordered to match the newest-first
order the homeserver actually returns) and by the full-loop suite, which now sends its
request **before** the bot can join rather than waiting for a `!help` reply first. The
former `SKIP` recording the race is now a passing assertion.

**A refusal was passing as an answer.** `e2e-matrix.mjs` asserted only that the bridge
replied, which held while the reply was `Request refused: bearer token required`. Same
shape as the tautology in §7.4: an assertion true whether or not the behaviour works. It
now rejects refusals, and a missing credential fails fast at the top beside the
homeserver reachability check rather than surfacing six steps later as an apparently
broken bridge.

**The GUI client's rendering is not machine-observable from here, and the claim was
dropped rather than fudged.** Four signals were tried and all four are unsound:

| signal | why it is unsound |
|---|---|
| its log | silent in steady state — 23 sync requests a minute against a log frozen at 39,872 bytes |
| `room_info` count | the store retains LEFT rooms (7 rows against 4 joined) and the suite forgets its room each run, so +1 new and −1 pruned nets to zero |
| `room_info.room_id` | a 32-byte hashed BLOB; a specific room cannot be looked up |
| store mtime | advances only when there is state to persist, so an idle-but-healthy client looks stalled |

Three of those were written as passing assertions before being caught. What is asserted
now is only that the client survives the loop; whether this room and this message
**rendered** is skipped with that reason. This is not a hole in the harness — it is the
one part of the loop a machine cannot see from outside, and confirming it is exactly what
the human in human-in-the-loop is for.

Two smaller robustness fixes came out of the same runs: `M_LIMIT_EXCEEDED` retry is now
shared by both suites in `mockup/scripts/lib/matrix-rate-limit.mjs` (honouring the
server's own `retry_after_ms`, rethrowing every other error untouched), and both suites
have a top-level catch. Without it a rate-limited `createRoom` exited on an unhandled
rejection printing no summary line at all — a failed run that read as a run that never
started.

### 7.6 What a clean host exposed that the development machine could not

The whole thing was stood up from nothing on a second Mac (clone, install, fresh
secrets, fresh runtime dir, fresh Matrix accounts) and the documented onboarding
process walked end to end with a real Octos agent. Four defects surfaced, and **none
of them reproduce on the machine this was built on**. That is the finding worth
keeping: every one needed a condition the developer's box happened not to have.

| Defect | The condition that hides it |
|---|---|
| `fillable` contradicted `crossFamilyOk` on the same object — a one-family fleet reported `review: {fillable: 1, crossFamilyOk: false}` | a mixed-family fleet |
| `state: ready` for a framework that cannot start — the probe ran `--version` only, so octos 0.1.1 passed and `acp-up` then died on `unrecognized subcommand 'acp'` | a current binary |
| the preset's provider never reached the process — a preset saying `moonshot` launched a **deepseek** client and died on `DEEPSEEK_API_KEY`, because octos resolves the provider from its own config and hafleet passed none | a local octos config that agrees with the preset |
| a running ACP agent reported **offline** — `syncAcpAgentLiveness` set `agent.online` on the record, but `serializeAgent` reads the state machine, which only the tmux sweep updated | never having launched an ACP agent and looked at the console |

The last one is the sharpest: `agents.json` said `online: true` and the API said
`online: false`, indefinitely, for a healthy agent serving a live binding. Two
sources of truth where only one is ever read. Its test now asserts the two AGREE in
both directions, so a change that fixes one side and not the other fails whichever
side it breaks.

Two bootstrap gaps also showed up, neither a bug but both undocumented: the first
binding needs `HAFLEET_OWNER_DM_ROOM` as well as `HAFLEET_OWNER_MXID` (without it
approval goes `active` with `bound: false` — loudly, which is the behaviour §7.4
built), and `credentialPresent: true` means only that the credential DIRECTORY
exists. On the clean host that directory was root-owned and empty, and the framework
was reported ready three separate times before a launch proved otherwise.

### 7.7 Two PRD items that are withdrawn scope, not gaps

An assessment of the PRD's ten in-scope items listed these as unimplemented. They are
not. Both were withdrawn by ADR-013 §8 and its 2026-08-10 amendment, and recording them
as gaps invites someone to build scope the decision removed — which is exactly what
happened once with the cost model before it was caught.

**PRD 4.1 item 5, "use the durable router as the only execution truth."** The router is
`/api/dispatch`, backed by `src/dispatch-lease-store.mjs`. ADR-013 §8 withdraws
"`/api/dispatch` and any successor router-facing assignment path, and the staffing-request
direction of travel." The engagement path REPLACES it rather than feeding it, so
`engagement-store` not referencing the lease store is the decision, not an omission.

Worth noting independently: that machinery was never durable anyway. `backend-v2.js:8527`
states "a restart drops in-flight leases and queued tickets alike; this is not restart-safe
queueing." So the PRD item asks for a property its own named component does not have.

**PRD 4.1 item 8, "attribute cost … to assignment and project."** Withdrawn by the
2026-08-10 amendment: the unit of account is the token. See §7.6.

What remains genuinely open from those ten is item 6's other half — usage events are now
persisted (`lib/metering/ledger.js`) but there is no *cost* event ledger, and by the
amendment there should not be one.

### 7.9 Requirement traceability, and the four bugs it surfaced

Sixty-eight statement-level MUSTs live in `knowledge/requirements/`. Two were cited by a
test. The rest were verified or not, and nobody could tell which without reading every test
file — which is the state a traceability requirement exists to prevent, not a documentation
preference.

`scripts/check-requirement-traceability.mjs` now produces the answer, and it is a **ratchet
rather than a target**: coverage may not fall below the recorded baseline (63/68), and
demanding 100% is deliberately avoided. A required percentage pushes toward the empty
citation — add the tag, ship the green table, verify nothing — which is worse than an honest
92%, because it removes the signal the table exists to carry.

Two mechanical failure modes make a coverage table lie, and both were present:

- **Prefix collision.** `REQ-X` matched inside `REQ-X-DURABLE` reports a parent covered
  because a child is. The first survey made exactly that mistake and counted
  `REQ-CONTRIBUTION-CONSOLE` as covered. Matching is on word boundary — and `\b` is wrong
  here, because it treats `-` as a boundary.
- **Citing an id that does not exist.** A test naming `…-CEILING` when the statement is
  `…-CEILING-SEAT` looks like coverage and is nothing. Unknown ids are errors, with a named
  exception list for the one legitimate non-citation (`REQ-DEMO` is fixture data inside a
  synthetic spec file).

**Five statements remain on prose alone, and stay that way honestly:**
`REQ-OWNER-UI-APPROVAL-CONTROL` (the guard at `lib/bot-commands.js:86` is wired but every
test calls `bot.handle` with an empty context, so its true branch never executes),
`REQ-PROJECT-BOARD-AGENTS`, `-GRAPHS`, `-REPOSITORIES` and `-REFRESH`. In each case the
adjacent test was close enough to cite and citing it would have been the false green this
tooling exists to catch.

**Ten of fifty-eight spec `Test:` selectors do not resolve.** Reported, not failed: every one
checked so far is naming drift over real coverage — three project-board scenarios consolidated
into one test, one selector that lost its `project_board_` prefix — with two exceptions that
are genuine gaps (`public_room_ctl_cannot_bypass_approval`, `MATRIX_DEFAULT_WAKE defaults to
mention-only mode` have zero occurrences under `tests/`). Drift is still a defect: an
unresolvable selector means the chain cannot be followed without reading everything.

#### Writing the missing tests found four real defects

Traceability was supposed to be a documentation exercise. Filling the gaps required writing
tests that did not exist, and those tests failed:

1. **A rejection revoked an unrelated active engagement.** A binding is keyed on
   `(agent, projectRoomId)` while engagements are individual, so one binding serves every
   engagement between that agent and that room — and `unbindEngagement` removed it whenever
   any one of them ended. The live store holds **six** concurrent active engagements for one
   such pair, so refusing a seventh request would have cut the access the other six were
   relying on. Now last-one-out.

   Found only because the test approves before it rejects. The first version rejected without
   approving, which cannot distinguish "the rejection removed nothing" from "nothing was
   there to remove" — it passed against the bug, and a mutation confirmed the pass was
   vacuous.

2. **`REQ-CONTRIBUTION-CONSOLE-UNIT` and `-INWARD` were each checked on one page.** Both are
   stated about the console; both were asserted only on `/workforce`, the newest route, so the
   seven older ones were never checked. Now a per-route sweep — and the first run failed on
   `$HOME` in prose and on a string whose content is "a roster of my agents, **not** of
   assignments". Both were the check being wrong, not the pages: a shell variable is not a
   price and a disclaimer is not a violation. Narrowed to a symbol adjacent to a digit, and
   to column headings rather than body text.

3. **`GET /api/usage` discarded the fleet token total** — `tokensUsed: null` unconditionally
   while per-agent rows carried real figures. Restored as a sum that travels with its
   denominator (`tokensMeasuredFor`, `tokensPartial`), because a bare sum over 2 of 7
   measured agents understates the fleet while reading as authoritative.

4. **`!request` had no test at all** — the entire inbound path of L3, including the clause
   that the `request_id` must be the authenticated Matrix event id and never a value from
   message content. Four mutations (id from args, generated id, inverted credential
   preference, room id from args) each now fail exactly one case.

### 7.8 Still open

- **Token metering itself.** P3 shipped the partition, not the measurement. Nothing here
  counts a token, and the console says so on every affected cell.
- **Scoped tokens.** Still one shared `API_TOKEN` with a local-request bypass. The
  console compensates with a server-side proxy holding a default-deny path allowlist, so
  the browser never holds the credential — but that is a mitigation, not the scoped tier
  §3 asks for, and it remains a precondition of any outward exposure.
- **`specs/project.spec.md:18`** still requires a `satisfies` link to an accepted
  requirement. ADR-013 remains `Proposed` and the paired `req-*.md` is unwritten.
- **Enforcement.** Ceilings and seat quotas are declarations; every surface says
  `not enforced`. Enforcement needs metering first and is a separate decision about what
  happens when a cap is hit.
- **The flaky cluster got worse, still unexplained.** One full-suite run failed **42
  tests across 5 files** — an order of magnitude beyond the usual one to three — with
  task and server endpoints returning 404 where 200 was expected. All five files pass in
  isolation, and pass with and without the change being tested at the time, so it is not
  a regression. Two immediately following full runs were completely green (2309 passed).
  A 404 on a registered route suggests routes not being served rather than a timing
  slip, which does not match the "load-sensitive timing" theory and is worth recording
  as evidence against it.

- **A cluster of load-sensitive flaky tests, cause unknown.** Across roughly twenty
  full-suite runs, three files failed intermittently and never twice in the same run:
  `api-server-heartbeat-sweep` ("disables maintenance mode…"), `api-server-heartbeat`
  ("heartbeat recovery resolves only the matching server outage") and `api-messages`
  ("backend_receipt_survives_retention", failing with `Parse Error: Expected HTTP/`).
  All three pass every time in isolation, and none imports anything this branch
  changed. Ruled out so far: an `API_TOKEN`/`HAFLEET_REQUESTER_TOKEN` leak from the
  caller's shell (they pass with both set), a shared runtime directory (the harness
  uses `mkdtempSync`, which randomises), and per-file timing constructs (one of the
  three has none). All three go through `createBackendTestContext` and two bind real
  ports, which is the next thing to look at. Recorded rather than written off: a suite
  that is green four runs in five is not green, and the cause is unknown rather than
  known-benign.
