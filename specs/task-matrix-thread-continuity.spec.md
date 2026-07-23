spec: task
name: "Durable Matrix thread continuity"
inherits: project
satisfies: [REQ-MATRIX-THREAD-CONTINUITY, ADR-001, ADR-007]
tags: [active, matrix, threads, durability, workflow]
estimate: 1.5d
---

## Intent

Keep agent replies in the Matrix project-room thread where work originated,
including multi-agent hand-offs and bridge restarts, without allowing agents to
choose Matrix room or event identifiers.

## Constraints

### Must
- Persist authenticated inbound room, event, and optional thread-root context.
- Persist the primary outbound body event through a bridge-secret-protected,
  idempotent backend upsert.
- Journal a successful primary Matrix send before its backend upsert and replay
  unfinished upserts after restart.
- Derive every outbound relation from a backend `reply_to` record in the same
  group and room.
- Continue a threaded source with `m.thread`, its original root, a rich-reply
  target, and `is_falling_back: true`.
- Reply to a top-level source with only `m.in_reply_to`; never create a thread
  implicitly.
- Treat a known group or room mismatch as a fail-closed delivery error.
- Treat missing legacy `matrixDelivery` or `matrixContext` as a compatibility
  miss: send at top level and emit a warning.
- Keep the first recorded primary event id immutable across retries and
  recovery replay.
- Include the backend `reply_to` id in single-message group wake guidance.

### Must Not
- Do not accept a Matrix event id, room id, or thread root from an agent post.
- Do not route encrypted approval DMs through the raw agent-token group sender.
- Do not treat attachment events as the primary reply target.
- Do not make Robrix2 an authorization or thread-routing authority.

## Decisions

- Inbound context is stored as `matrixContext`.
- Outbound primary delivery is stored as `matrixDelivery`.
- Both records use `{ roomId, eventId/primaryEventId, threadRootEventId }`.
- A private JSONL pending-delivery journal closes the send/upsert restart
  window; backend first-write-wins semantics close replay races.
- Explicit room-wide workflow summaries remain a future
  `broadcast_to_room=true` path and are not inferred from a thread reply.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/matrix-delivery-journal.js
- tests/api-messages.test.js
- tests/bridge-matrix.test.js
- tests/matrix-delivery-journal.test.js
- knowledge/**
- specs/**
- docs/architecture/**

### Forbidden
- Do not change Robrix2 thread rendering or timeline filtering.
- Do not change approval-room encryption behavior.
- Do not add a dependency.

## Acceptance Criteria

### Rule: inbound-thread-context — Matrix thread identity survives backend ingestion

Scenario: Threaded inbound message stores root and reply target
  Tags: critical
  Test: inbound_thread_context_is_persisted
  Given a Matrix group message has an m.thread relation and rich-reply target
  When the authenticated bridge ingests it
  Then the backend message stores its room, event, and thread-root ids
  And its backend reply_to resolves from the rich-reply target

### Rule: relation-reconstruction — Agent replies use the source delivery shape

Scenario: Thread source remains in the same thread
  Tags: critical
  Test: threaded_group_reply_rebuilds_matrix_relation
  Given reply_to identifies a source with a primary event and thread root
  When an agent reply is bridged to the same group room
  Then the outgoing body uses m.thread with that root
  And m.in_reply_to targets the source primary event

Scenario: Top-level source receives a rich reply only
  Test: top_level_group_reply_does_not_start_thread
  Given reply_to identifies a top-level Matrix source
  When an agent reply is bridged
  Then the outgoing body contains m.in_reply_to
  And it contains no m.thread relation

Scenario: Missing legacy delivery degrades without blocking
  Test: missing_matrix_delivery_falls_back_to_top_level
  Given reply_to identifies an old backend message without Matrix delivery
  When an agent reply is bridged
  Then the message is sent at the room top level
  And the bridge emits a compatibility warning

Scenario: Cross-room reply is rejected
  Tags: critical
  Test: cross_room_group_reply_fails_closed
  Given reply_to resolves to a different group or Matrix room
  When an agent attempts to bridge the reply
  Then no Matrix message is sent
  And the bridge emits a routing warning

### Rule: durable-primary-delivery — Multi-hop replies survive crashes and retries

Scenario: Primary delivery is idempotent
  Tags: critical
  Test: matrix_delivery_upsert_is_first_write_wins
  Given a backend message already has a primary Matrix event
  When the bridge replays the same upsert or submits a conflicting event
  Then the same upsert is accepted as deduplicated
  And the conflicting event is rejected without replacing the primary event

Scenario: Restart replays send-before-upsert window
  Tags: critical
  Test: pending_delivery_replays_after_restart
  Given Matrix accepted a primary body event and the backend upsert failed
  When the bridge restarts
  Then the pending journal replays the upsert without sending another event
  And the journal marks the delivery committed exactly once

Scenario: Second agent can reply to first agent after restart
  Tags: critical
  Test: multi_hop_agent_reply_uses_persisted_primary_delivery
  Given agent A's threaded reply has been persisted and the bridge restarted
  When agent B replies to agent A's backend message
  Then agent B targets agent A's primary Matrix event
  And agent B inherits the same thread root

### Rule: plaintext-group-boundary — Encrypted approvals keep their existing path

Scenario: Thread delivery applies only to plaintext group messages
  Test: encrypted_approval_send_does_not_create_group_delivery
  Given an encrypted owner approval request is sent
  When the approval bridge publishes it
  Then the plaintext group delivery journal is not used

### Rule: workflow-reply-guidance — Agents receive the trusted backend reply id

Scenario: Single group wake tells agent how to preserve context
  Test: group_push_hint_includes_reply_to
  Given one actionable human group message wakes an MCP-enabled agent
  When agent-chat constructs the push notification
  Then the post example includes that message's backend reply_to id

## Out of Scope

- Rendering a thread summary in the Robrix2 main timeline.
- Encrypted non-approval group rooms.
- Persisted workflow role bindings.
