---
kind: decision
id: ADR-007
title: "Persist trusted Matrix context and primary outbound delivery"
status: Accepted
liveness: auto
tags: [matrix, threads, durability, bridge]
---

## Context

hafleet previously reduced an inbound Matrix reply to a backend `reply_to`
id and discarded the Matrix thread root. Outbound group messages contained no
relation at all. The bridge also kept successful outbound event ids only in
process memory, so a second agent or a bridge restart could not continue the
thread.

## Decision

The backend persists two related records:

- `matrixContext` for authenticated inbound Matrix messages: room id, source
  event id, and optional thread-root event id.
- `matrixDelivery` for the primary outbound Matrix body event: room id, primary
  event id, and optional inherited thread-root event id.

The bridge resolves relations only from a trusted backend `reply_to` message.
It rejects a known group or room mismatch, uses `m.thread` for a threaded
source, and uses a rich reply for a top-level source. Missing delivery metadata
is a compatibility miss: the message is sent at the top level and a warning is
logged.

Before acknowledging a successful Matrix send as complete, the bridge appends
the primary event to a private local pending-delivery journal. It then calls a
bridge-secret-protected, idempotent backend upsert. Startup replays unfinished
upserts. The first primary event wins; replays and retries cannot overwrite it.

> **Corrected 2026-08-11.** "Before acknowledging … as complete" reads as a barrier, and it
> cannot be one. The journal write happens after the Matrix send has already succeeded, so if
> `recordPending` throws, the bridge logs, posts a `thread-durability` warning, and returns the
> event id anyway (the `recordPending` catch inside `sendAsAgentContent`, `bridge-matrix.js`).
> That is the only available behaviour — the message is on the homeserver and cannot be
> recalled — so the sentence describes an ordering
> the code observes, not a guarantee it enforces. What is actually guaranteed: the journal is
> attempted before the send is reported, and a failure to journal is surfaced as a warning
> rather than swallowed. Thread context for later replies may still be lost in that window, and
> the warning is what says so. That path has no test (`thread-durability` occurs nowhere under
> `tests/`).
>
> Cited by symbol rather than by line range, and that is the convention for code references in
> these records: line numbers rot as the file grows, and a rotted citation is worse than none,
> because a reader who follows it lands on unrelated code and may conclude the claim is false.

## Consequences

Good, because multi-agent thread replies survive process restarts and do not
depend on agent-supplied Matrix identifiers.

Bad, because Matrix send and backend persistence remain a two-system operation
and require a local recovery journal.

## Security Boundary

The raw agent-token `sendAsAgentContent` path is for non-encrypted group rooms.
Encrypted approval DMs remain on the Matrix crypto client path. If encrypted
thread replies are added later, thread relation metadata must remain outside
the encrypted payload as required by Matrix.

> **Corrected 2026-08-11.** The first sentence states a scope that nothing enforces.
> `sendAsAgentContent` (`bridge-matrix.js`) performs an unconditional plaintext
> `PUT /rooms/{roomId}/send/m.room.message/{txn}` and **contains no encryption check of any
> kind** — neither it nor any caller reads a room's encryption state. It is called for group
> sends, DM sends, and the public approval notice.
>
> So "is for non-encrypted group rooms" is a **convention held at the call sites**, not a
> property the function has. The separation is real today — the encrypted approval path goes
> through `botClient.sendMessage` after `ensureApprovalDmEncrypted`, and
> `tests/bridge-matrix-approval.test.js` asserts that the sensitive payload only ever reaches
> that sender — but nothing would stop a future caller from handing this function an encrypted
> room, and no test asserts such a send is refused.
>
> Stated rather than fixed because the fix is a design choice this record should not make
> silently: either the function gains an encryption check and fails closed, or the convention is
> made explicit by narrowing its callers. Until one is chosen, a reader should know the boundary
> is maintained by discipline.

## Alternatives Considered

- Keep the event mapping only in bridge memory: rejected because restart breaks
  the second reply hop.
- Let agents provide raw Matrix ids: rejected because agents are not a trusted
  routing authority.
- Reject every reply missing delivery metadata: rejected because one failed
  compatibility write would block all later workflow progress.
