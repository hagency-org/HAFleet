spec: task
name: "Matrix direct-message privacy routing"
inherits: project
satisfies: [REQ-MATRIX-DM-PRIVACY]
tags: [bugfix, matrix, dm, privacy]
estimate: 0.5d
---

## Intent

Prevent an agent-to-human direct message from inheriting a public or unrelated
room through `reply_to`. Preserve reply threading only for a verified DM pair,
and make successful human-target inference clearly informational.

## Constraints

### Must
- Direct reply-room reuse must be decided from persisted backend message metadata.
- Metadata lookup failures must exclude the reply room and continue to a verified DM fallback.
- Existing matching-DM reply behavior and attachment delivery must remain intact.

### Must Not
- Do not infer privacy from a room name, Matrix display name, or room member count.
- Do not send a direct message to a group merely because `reply_to` originated there.

## Decisions

- A reusable reply room requires `group == null`, a non-empty `sourceRoom`, and the same normalized human-agent pair.
- The bridge caches message route metadata, not an already-authorized room decision.
- Automatic human classification is returned under `notices` with code `target_classified_human`; it is not returned under `warnings`.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- backend-v2.js
- tests/bridge-matrix.test.js
- tests/api-messages.test.js

### Forbidden
- Do not change Matrix room creation, encryption policy, or access-token storage.
- Do not add a new dependency.

## Acceptance Criteria

### Rule: verified-direct-reply-room — Only a verified DM pair can reuse reply context

Scenario: Group reply context is excluded from a human DM
  Tags: critical
  Test: direct_human_reply_to_group_uses_private_dm
  Given `reply_to` identifies a backend message with a group and public source room
  When an agent sends a direct message to that human
  Then the public room is not a candidate
  And the verified last private room is used

Scenario: Matching DM reply context is reused
  Test: direct_human_reply_to_matching_dm_reuses_reply_room
  Given `reply_to` identifies a group-less message between the same agent and human
  When the bridge resolves the direct message
  Then the referenced DM room is the first candidate

Scenario: Mismatched DM pair is excluded
  Tags: critical
  Test: direct_human_reply_to_mismatched_pair_uses_private_dm
  Given `reply_to` identifies a group-less message involving a different human
  When the bridge resolves the direct message
  Then that room is not a candidate
  And the verified last private room is used

Scenario: Metadata lookup failure fails closed
  Tags: critical
  Test: direct_human_reply_lookup_failure_uses_private_dm
  Given the backend cannot return metadata for `reply_to`
  When the bridge resolves the direct message
  Then no unverified reply room is used
  And the verified last private room remains available

Scenario: Missing direct-message classification fails closed
  Tags: critical
  Test: direct_human_reply_with_missing_group_uses_private_dm
  Given `reply_to` metadata has a source room but omits the group field
  When the bridge resolves the direct message
  Then the unclassified source room is not a candidate
  And the verified last private room is used

### Rule: human-target-feedback — Successful human classification is not a warning

Scenario: Inferred human target returns informational metadata
  Test: inferred_human_target_is_a_notice_not_a_warning
  Given a registered agent sends to an unregistered direct target using automatic classification
  When the backend accepts the message for human delivery
  Then the response contains `target_classified_human` under notices
  And warnings contain no `target_assumed_human`

## Out of Scope

- Owner-specific execution approvals.
- Robrix2 approval-button rendering.
- Migrating existing DM rooms.
