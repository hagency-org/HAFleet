---
kind: decision
id: ADR-003
title: "Use public status plus private UI-only approval"
status: Accepted
liveness: auto
tags: [matrix, approval, privacy, ui]
---

## Context

Execution approvals may contain commands, paths, issue content, or other
project-sensitive details. A public project room is useful for coordination but
must not become the approval authority or disclose the detailed request.

## Decision

Every remote execution approval uses two Matrix surfaces. The public project
room receives only a redacted, non-actionable status notice. The agent-owner
encrypted DM receives the full structured request and UI buttons for
single-use approve or deny actions. Button clicks emit structured Matrix events;
agent-chat alone validates and consumes them. Plain text and generic `!ctl`
commands never authorize an execution request.

## Consequences

Good, because project participants can see progress without receiving private
details or approval power.

Bad, because the workflow requires coordinated protocol support in agent-chat
and Robrix2, plus a healthy encrypted DM channel.

## Alternatives Considered

- Approve by typing text in DM: rejected because free-form text is ambiguous and replayable.
- Put approval buttons in the public room: rejected because visibility would imply an unsafe control surface.
- Let Robrix2 decide authorization locally: rejected because clients are presentation surfaces, not server authority.
