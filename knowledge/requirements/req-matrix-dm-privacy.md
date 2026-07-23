---
kind: requirement
id: REQ-MATRIX-DM-PRIVACY
title: "Keep direct human messages in verified private rooms"
status: accepted
liveness: auto
tags: [matrix, dm, privacy, routing]
---

## Problem

An agent-to-human direct message can carry `reply_to` for a message that came
from a public project room. The current bridge prefers the replied-to message's
room without proving it is a DM, so private content can be posted publicly.
Successful delivery to an inferred human is also returned as a warning, causing
agents to report false delivery failures.

## Requirements

[REQ-MATRIX-DM-PRIVACY-ROUTE] The bridge MUST reuse a `reply_to` source room only when the referenced backend message proves the same human-agent direct-message pair and has no group.

[REQ-MATRIX-DM-PRIVACY-FALLBACK] When a referenced message came from a group or another pair, the bridge MUST use the verified last private room or create the pair's private room.

[REQ-MATRIX-DM-PRIVACY-FAIL-CLOSED] The bridge MUST NOT send a direct human message to an unverified candidate room when message metadata is missing, mismatched, or unavailable.

[REQ-MATRIX-DM-PRIVACY-FEEDBACK] Successful automatic classification of a target as human MUST be reported as informational delivery metadata rather than a delivery warning.

## Scenarios

Scenario: Group reply context cannot redirect a human DM
  Given an agent direct message replies to a message from a mapped project group
  When the bridge resolves the outbound Matrix room
  Then the project room is excluded and the verified private room is selected

Scenario: Matching DM reply context is retained
  Given an agent direct message replies to a message from the same human-agent DM
  When the bridge resolves the outbound Matrix room
  Then that DM room remains the first candidate

Scenario: Another pair's DM is rejected
  Given an agent direct message references a DM involving another human or agent
  When the bridge resolves the outbound Matrix room
  Then the referenced room is excluded

Scenario: Human classification is not a failure warning
  Given an agent sends to a target that is not a registered agent
  When the backend accepts the target as human
  Then the response reports successful human classification without a warning

## Dependencies

- ADR-002

## Source Trace

- Matrix message `msg_0046` routed toward the public project room through `reply_to=msg_0045`.
- User report on 2026-07-23: outbound DM appeared missing while the agent reported `target_assumed_human`.

## Open Questions

None.
