---
kind: decision
id: ADR-007
title: "Persist trusted Matrix context and primary outbound delivery"
status: Accepted
liveness: auto
tags: [matrix, threads, durability, bridge]
---

## Context

agent-chat previously reduced an inbound Matrix reply to a backend `reply_to`
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

## Alternatives Considered

- Keep the event mapping only in bridge memory: rejected because restart breaks
  the second reply hop.
- Let agents provide raw Matrix ids: rejected because agents are not a trusted
  routing authority.
- Reject every reply missing delivery metadata: rejected because one failed
  compatibility write would block all later workflow progress.
