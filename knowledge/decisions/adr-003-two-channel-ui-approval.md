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
hafleet alone validates and consumes them. Plain text and generic `!ctl`
commands never authorize an execution request.

### Amendment 2026-08-11 — the encrypted DM has one authorised exception, named here

"The agent-owner **encrypted** DM" above reads as admitting no exception, and the
implementation has one: with `HAFLEET_APPROVAL_DM_MODE=plaintext-test` **and**
`HAFLEET_ALLOW_PLAINTEXT_APPROVAL_TEST=1` **and** `NODE_ENV !== 'production'`
(`resolveApprovalDmMode`, `bridge-matrix.js`), the full structured request — input preview
included — is sent to a deliberately unencrypted diagnostic room.

The exception is authorised. It is not recorded here, which is the defect: the authorisation
lives in **ADR-006's Alternatives** section and in `specs/task-owner-ui-approval.spec.md:56-58`,
and this ADR neither states it nor cross-references them. Read alone — which is how a decision
record is read — ADR-003 overstates its own guarantee.

Recorded rather than removed, because the carve-out is genuinely useful: E2EE failures are
otherwise undiagnosable from outside the crypto layer. What makes it safe is that it requires
three independent settings and refuses in production, which the
`plaintext approval diagnostics require explicit non-production opt-in` test in
`tests/bridge-matrix-approval.test.js` asserts. What makes it honest is saying so in the
document that promises encryption.

## Consequences

Good, because project participants can see progress without receiving private
details or approval power.

Bad, because the workflow requires coordinated protocol support in hafleet
and Robrix2, plus a healthy encrypted DM channel.

## Alternatives Considered

- Approve by typing text in DM: rejected because free-form text is ambiguous and replayable.
- Put approval buttons in the public room: rejected because visibility would imply an unsafe control surface.
- Let Robrix2 decide authorization locally: rejected because clients are presentation surfaces, not server authority.
