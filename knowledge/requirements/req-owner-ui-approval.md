---
kind: requirement
id: REQ-OWNER-UI-APPROVAL
title: "Owner-scoped UI approval over encrypted Matrix DM"
status: accepted
liveness: auto
tags: [matrix, approval, owner, ui, security]
---

## Problem

Plain Matrix text cannot safely authorize a coding-agent tool operation, and a
public project room contains developers who do not own every participating
agent. The system needs a private, replay-resistant approval path that preserves
the coding runtime's native permission boundary.

## Requirements

[REQ-OWNER-UI-APPROVAL-PUBLIC] The project room MUST receive only a redacted, non-actionable approval status notice.

[REQ-OWNER-UI-APPROVAL-DM] The full approval request MUST be sent only to the agent-owner encrypted DM room.

[REQ-OWNER-UI-APPROVAL-UI] Approval and denial MUST be selected through structured UI actions, not chat text or commands.

[REQ-OWNER-UI-APPROVAL-IDENTITY] The service MUST authorize the response using the Matrix event's complete `event.sender` MXID.

[REQ-OWNER-UI-APPROVAL-BINDING] Each request MUST bind the agent, project room, project identity, upstream request id, input digest, owner MXID, and DM room id.

[REQ-OWNER-UI-APPROVAL-MULTI-AGENT] A project room MUST retain a separate authenticated inviter, owner MXID, and approval DM binding for every managed agent in that room. Adding one agent MUST NOT overwrite another agent's binding or reuse another agent's approval room.

[REQ-OWNER-UI-APPROVAL-LIFETIME] Each request MUST expire and MUST be consumed atomically at most once.

[REQ-OWNER-UI-APPROVAL-DELIVERY] An encrypted verdict that arrives before its Megolm room key MUST be retained durably and retried when later syncs deliver the key; an undecryptable verdict MUST NOT be interpreted as approval.

[REQ-OWNER-UI-APPROVAL-OTK] The bridge MUST maintain enough signed Curve25519 one-time keys for owner clients to establish Olm sessions and deliver Megolm room keys. Missing sync counts MUST be reconciled against an authoritative keys-upload response at a bounded cadence; an absent sync field MUST NOT be rewritten as zero on every sync.

[REQ-OWNER-UI-APPROVAL-FAIL-CLOSED] Missing, ambiguous, expired, mismatched, or already-consumed approval state MUST produce denial without administrator fallback.

[REQ-OWNER-UI-APPROVAL-BACKGROUND] A managed background runtime MUST NOT fall back to a native approval prompt that is visible only inside tmux. Adapter startup failures MUST abort launch, and request-time transport failures MUST produce an explicit runtime denial.

[REQ-OWNER-UI-APPROVAL-TRUST] A Codex permission hook MUST be inspected and trusted through Codex's supported trust interface before tmux creation. Trust MUST be scoped to the exact content-bound hook configuration, MUST require explicit local confirmation when new or changed, and MUST NOT use a trust-bypass flag or direct trust-state mutation.

[REQ-OWNER-UI-APPROVAL-PROJECT-TRUST] Repeated managed Codex startup MUST leave exactly one parseable trust table for the target project. An older identical duplicate MAY be repaired atomically with a backup; conflicting duplicate content MUST abort startup.

[REQ-OWNER-UI-APPROVAL-CLAUDE-AUTH] A managed Claude launch MUST use API-key authentication only when the agent's runtime profile explicitly supplies that key. Without an explicit profile key, the launcher MUST clear inherited `ANTHROPIC_API_KEY` before starting Claude so ambient shell state cannot override the authenticated account.

[REQ-OWNER-UI-APPROVAL-TIMEOUT] Runtime adapter timeouts MUST cover the configured server approval lifetime plus a bounded transport margin so the adapter cannot terminate before a still-live approval.

[REQ-OWNER-UI-APPROVAL-CONSUME] A server-authorized verdict MUST be consumed atomically before an allow or deny is delivered to the coding runtime.

[REQ-OWNER-UI-APPROVAL-CODEX-COORDINATION] A trusted Codex permission hook MUST
allow the exact agent-chat MCP coordination and task-control tools without
creating a recursive owner approval. Text-only agent-chat messaging MAY use
this path; any message that asks agent-chat to read and transmit a local file
attachment MUST remain owner-gated. Unrelated MCP tools and coding operations
MUST NOT inherit this exemption.

[REQ-OWNER-UI-APPROVAL-CONTROL] Public-room `!ctl key`, `!ctl send`, and equivalent generic controls MUST NOT bypass the approval state machine.

[REQ-OWNER-UI-APPROVAL-AUTHORITY] Robrix2 MUST remain a rendering and event-emission client; agent-chat MUST remain the authorization authority.

## Scenarios

Scenario: Owner approves once from the encrypted DM UI
  Given a pending request is bound to an agent, project, owner, and encrypted DM
  When the exact owner selects the approve-once button before expiry
  Then agent-chat atomically accepts one matching verdict and relays it through the supported runtime permission protocol

Scenario: Public project-room notice is read only
  Given an agent is waiting for approval
  When agent-chat publishes status to the project room
  Then the notice contains no private input and no actionable approval control

Scenario: Text approval is ignored
  Given a pending request exists in the owner DM
  When any participant sends text such as "approve" or "批准"
  Then the request remains pending

Scenario: Another developer cannot approve
  Given a pending request belongs to one owner MXID
  When another project-room developer selects or forges an approval action
  Then agent-chat rejects the event

Scenario: Two local agents share one project room without sharing authority
  Given a trusted developer invited two distinct managed agents into one project room
  When either runtime creates an approval request
  Then agent-chat resolves the request through that exact agent's room-agent binding
  And the other agent's approval room and state remain unchanged

Scenario: Public-room control commands cannot approve
  Given a pending request exists
  When a participant uses a generic control command in the public room
  Then no approval verdict is produced

Scenario: Expired or replayed action is rejected
  Given a request expired or already reached a terminal state
  When the owner repeats the previous UI action
  Then agent-chat rejects it without changing the terminal result

Scenario: Delayed encrypted verdict key is recoverable
  Given the owner submits a structured verdict before the bridge receives its room key
  When a later Matrix sync delivers the missing key
  Then the bridge decrypts and submits the retained verdict exactly once

Scenario: Exhausted bridge one-time keys are replenished
  Given the homeserver omits a usable one-time-key count for the bridge device
  When the bridge performs its bounded reconciliation
  Then it obtains the current count using an empty keys-upload request
  And it passes the authoritative count to the crypto state machine
  And it neither rewrites an absent sync field nor uploads keys every sync
  And replacement key contents are never logged

Scenario: Empty owner fails closed
  Given no trusted inviter provenance identifies an owner
  When a runtime requests permission
  Then agent-chat denies the request and creates no generally-approvable fallback

Scenario: Managed runtime transport failure does not hide in tmux
  Given a Claude or Codex agent runs as a managed background session
  When its approval adapter cannot create, poll, consume, or deliver a request
  Then the runtime receives an explicit deny
  And no unattended native approval prompt is used as fallback

Scenario: Managed Claude authentication ignores undeclared ambient keys
  Given a Claude agent has no API key in its runtime profile
  And the operator shell contains ANTHROPIC_API_KEY
  When the managed launch environment is created
  Then ANTHROPIC_API_KEY is unset for the Claude process
  And the authenticated Claude account remains the selected credential source

Scenario: Codex hook trust is explicit and content bound
  Given the managed Codex permission hook is new or its script contents changed
  When the launcher verifies it before creating tmux
  Then Codex App Server reports the exact hook as untrusted or modified
  And only an explicit local confirmation persists trust for that exact current hash
  And declining or running non-interactively aborts startup

Scenario: Adapter timeout covers approval lifetime
  Given the operator changes the server approval TTL
  When the launcher builds the Codex PermissionRequest hook
  Then its timeout is derived from that TTL plus a bounded delivery margin
  And the hook cannot expire before the server request

Scenario: Codex reads its workflow inbox without recursive approval
  Given the managed Codex hook is trusted for its exact current contents
  When Codex calls the exact agent-chat check_inbox MCP tool
  Then the hook allows that bounded coordination call locally
  And it creates no owner approval request
  And external coding tools remain owner-gated

## Dependencies

- ADR-002
- ADR-003
- ADR-004
- ADR-005
- ADR-006

## Source Trace

- User-approved workflow on 2026-07-23: public read-only reminder plus detailed owner DM request with UI buttons.
- Claude Code channel permission protocol documented at `https://code.claude.com/docs/en/channels-reference`.
- Codex `PermissionRequest` hook documented at `https://developers.openai.com/codex/hooks`.
- Codex App Server `hooks/list` and `config/batchWrite` documented at
  `https://developers.openai.com/codex/app-server`.
- Live Codex incident on 2026-07-24: a wildcard PermissionRequest hook created
  repeated approvals for `mcp__agent_chat__check_inbox`, preventing the agent
  from reading the message that triggered it.

## Open Questions

- Robrix2 still needs to adopt the versioned Matrix request/verdict schemas as a presentation-only client.
