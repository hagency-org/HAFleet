spec: task
name: "Appservice sync intake (third inbound mode)"
inherits: project
satisfies: [ADR-016, ADR-014]
tags: [active, matrix, appservice, intake]
estimate: 2d
---

## Intent

Collect appservice events for a project side over an ordinary outbound
`/sync` loop — no inbound socket, no co-located edge process — so a fleet
behind NAT can still receive homeserver traffic. The sync loop feeds the
same router as the listener and edge paths, inheriting their ordering,
duplicate suppression, and authentication.

## Constraints

### Must

- Resolve configuration through `resolveAppserviceSyncConfig`: disabled by
  default; a half-configured pair (side without URL, URL without side, or a
  non-absolute URL) is REFUSED with a reason, never treated as off.
- Authenticate as the application service itself: `m.login.application_service`
  with `token = as_token` and `identifier = sender_localpart`. The resulting
  access token is a process-local cache only — never persisted, matching the
  in-memory-only acting-credential design.
- Carry an explicit `/sync` filter: `room.timeline.types = ["m.room.*"]`,
  empty `account_data` and `to_device`, plus `set_presence=offline`.
  Membership and invite sections must NOT be filtered out.
- Deliver `rooms.invite.*.invite_state.events` on EVERY poll including the
  first, with `room_id` injected so invite and join events are the same
  shape entering the router. The join timeline of the FIRST poll is
  swallowed (initial sync replays history); invites are not, because a
  pending invite that waits out a long-poll delays the knock handshake.
- Advance the cursor (`next_batch`) ONLY after the router answers 200. A
  non-200 leaves the cursor in place and retries the SAME batch after
  backoff — at-least-once, never at-most-once; the crash window between a
  successful handle and the cursor write is absorbed by the router's
  event-id dedup.
- Bound retries of a poison batch with FAST-BREAK semantics: the retry
  interval for a refusing batch is a FIXED 1s (no climb), and after
  `MAX_DELIVERY_ATTEMPTS` (default 8) consecutive refusals — about 8
  seconds — CIRCUIT-BREAK that side's collector: stop polling, warn
  exactly once through the existing operator-warning convention, and
  report TWO cursors in the warning: `heldCursor` (the current `since`,
  the point a restart actually resumes from) and `failedNextBatch` (the
  end of the batch that was never committed — NOT a recovery point).
  Recovery is by restart or manual action; infinite head-of-line
  blocking is forbidden, and so is stretching the window to minutes.
- Break the 401 loop: a 401 against a token minted in the CURRENT login
  generation goes straight to backoff; only a 401 against an older token
  triggers one re-login.
- Enforce intake mutex PER SIDE, after side-name NORMALIZATION (lowercase;
  reject trailing slashes and URL-shaped side names — aligned with the
  project-side store's identifier rules) for both the comparison and the
  credential lookup. `Palpo.Example` and `palpo.example` are the same side;
  a trailing-slash or `https://…` side value is refused. The listener has no
  side dimension, so it conflicts with any enabled edge or sync.
- Persist the sync cursor in bridge state keyed by side, so a restart
  resumes rather than replays.
- Idempotence of repeat deliveries is the Matrix join's own idempotence plus
  the bridge's trust-state reconciliation — invite-section events carry no
  `event_id`, so event-id dedup does not apply to them (a redelivered invite
  must be harmless). The executable pin (see `B-idem`) covers REDELIVERY
  through the collector and router: the same invite section delivered on
  successive polls produces byte-identical router batches with no loop
  error or state drift. The DOWNSTREAM claim — that the join path absorbs
  the duplicate without re-warning or re-backfilling — is exercised by the
  bridge's own membership tests, not by this spec's bound tests; this spec
  promises redelivery harmlessness at the collector boundary and no more.

### Must Not

- Must not persist the sync access token to disk.
- Must not advance the cursor past a batch the router has not accepted.
- Must not retry a poison batch without bound or without an operator warning.
- Must not run two intakes for the same side (post-normalization) in one
  bridge.
- Must not filter out membership or invite sections.

## Scenarios

Each scenario is bound to a named test in `tests/appservice-sync.test.js`;
that file is the executable form of this spec.

- **Cursor advances only on success** — the router answering non-200 leaves
  the cursor in place and the batch is retried.
  Test: `A: a router failure does NOT advance the cursor; retries are CAPPED and the collector stops`.
- **Poison batch circuit-breaks the side** — after the retry budget the
  collector stops, the cursor is held, and the operator is warned exactly once.
  Test: `A-cap: a poison batch circuit-breaks the collector, holds the cursor, warns once`
  (pins `heldCursor` and `failedNextBatch` separately, and the sleep
  sequence as seven fixed 1000ms waits — the eighth attempt breaks
  instead of sleeping).
- **Invites are delivered, first-poll join timeline is not** — both
  first-poll semantics pinned separately, invite events shaped like join
  events.
  Tests: `logs in, swallows the initial sync, delivers timeline events through the router, and persists the cursor`,
  `B: invite events carry room_id like join events and reach the router`,
  `B-idem: a repeated invite (restart redelivery) is harmless`.
- **401 circuit-break** — a fresh token rejected by sync backs off instead
  of re-logging in; only an older-generation token may trigger one re-login.
  Test: `C: a 401 on a FRESHLY minted token backs off instead of re-logging in`.
- **Per-side mutex with normalization** — same side (any spelling) refused;
  different sides allowed; listener conflicts with any.
  Tests: `D: listener + sync on any side is refused (the listener has no side dimension)`,
  `D: edge and sync on the SAME side is refused, on DIFFERENT sides is allowed`,
  `D-norm: side names are normalized before the mutex (case, trailing slash, URL form)`.
- **Filter allowlist on the wire** — the sync URL carries the filter JSON
  and `set_presence=offline`.
  Test: `E: the sync request carries an explicit filter and set_presence=offline`.
- **Half-configured refusal** — each half of the config pair is refused with
  a reason naming the missing half.
  Test: `half-configured is refused, not treated as off`.

## Test hygiene (binding)

Every loop-shaped test in `tests/appservice-sync.test.js` MUST use the
shared watchdog helper (absolute iteration cap, trips as an error), MUST NOT
use a mock-call count as its sole stop condition, MUST use a sleep mock that
records and yields (never a spin), and MUST call `collector.stop()` in an
`afterEach` guard.

## References

- `lib/appservice-sync.js` — implementation.
- `lib/appservice-receiver.js` — the shared router both intakes feed.
- `lib/project-side-store.js` — side identifier normalization rules.
- `docs/FOR-PROJECT-SIDES.md` — operator-facing description of the third option.
