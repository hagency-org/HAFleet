---
kind: requirement
id: REQ-MATRIX-THREAD-CONTINUITY
title: "Preserve Matrix thread context across agent workflow replies"
status: Accepted
liveness: auto
tags: [matrix, threads, bridge, workflow]
---

## Problem

agent-chat currently discards an inbound Matrix thread root and emits agent
replies as unrelated top-level events. The outbound Matrix event id is kept
only in process memory, so multi-agent hand-offs also lose their reply target
after a bridge restart.

## Requirements

[REQ-MATRIX-THREAD-CONTEXT] Authenticated inbound Matrix messages MUST persist their room id, source event id, and optional thread-root event id.

[REQ-MATRIX-THREAD-DELIVERY] The primary Matrix body event emitted for an agent message MUST be durably associated with that backend message before the delivery is considered complete.

[REQ-MATRIX-THREAD-RELATION] A reply to a threaded source MUST target the source primary event and retain the original thread root.

[REQ-MATRIX-RICH-REPLY] A reply to a top-level source MUST use a rich reply without implicitly creating a thread.

[REQ-MATRIX-THREAD-ROOM-BOUNDARY] A reply that resolves to another known group or Matrix room MUST be rejected before Matrix send.

[REQ-MATRIX-THREAD-COMPATIBILITY] Missing legacy Matrix delivery metadata MUST degrade to a top-level message with an operator-visible warning.

[REQ-MATRIX-THREAD-IDEMPOTENCY] Delivery recovery MUST retain the first primary event id and MUST NOT create a second backend delivery record.

[REQ-MATRIX-THREAD-PLAINTEXT-SCOPE] The raw agent-token thread sender MUST be limited to non-encrypted group rooms; encrypted approvals MUST retain their crypto-client path.

## Scenarios

Scenario: Threaded agent reply remains threaded
  Given a human Matrix message has a persisted thread root
  When an agent replies through the mapped project group
  Then the Matrix body event targets the source event inside the original thread

Scenario: Bridge restart preserves a multi-agent hand-off
  Given agent A's primary Matrix event was accepted before the bridge stopped
  When the bridge restarts and agent B replies to agent A
  Then agent B's Matrix relation targets agent A's persisted primary event

Scenario: Legacy message does not block delivery
  Given an old backend message has no persisted Matrix delivery
  When an agent replies to it in the same group
  Then the bridge sends a top-level message and records a compatibility warning

Scenario: Cross-room metadata is rejected
  Given a reply source records a different Matrix room
  When the bridge prepares the outgoing relation
  Then no Matrix send request is issued

## Dependencies

- ADR-001
- ADR-007

## Source Trace

- Matrix backend message `msg_0062` was received inside a thread, while agent
  response `msg_0063` was emitted at the project-room top level on 2026-07-23.
- User-approved design review on 2026-07-23 covering durable primary delivery,
  crash replay, compatibility fallback, and plaintext group scope.

## Open Questions

None.
