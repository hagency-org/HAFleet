---
kind: requirement
id: REQ-AGENT-OPS-CLIENT
title: "Scoped Agent Operations client access"
status: Accepted
liveness: auto
tags: [robrix2, agent-ops, client-auth, projection, capability, router]
---

## Problem

Robrix2 needs to display and request a bounded set of Agent Operations without
receiving agent-chat's backend-wide Dashboard credential, private approval
content, local paths, or authority to invent router state transitions. The
current `/api/router/*` contract cannot safely serve that role.

## Requirements

[REQ-AOC-COMPATIBILITY] Agent Operations MUST use a separate versioned route and authentication boundary, MUST be disabled by default, and MUST NOT change existing Dashboard Router, Matrix ingestion, owner approval, task, or runner behavior while disabled.

[REQ-AOC-AUTHORITY] Agent-chat MUST remain the only authorization and state-transition authority; Robrix2 MUST be a presentation and request client and MUST NOT receive `API_TOKEN`, bridge secrets, agent tokens, runner capabilities, or approval capabilities.

[REQ-AOC-LOCAL-ONLY] V1 data-plane requests MUST be restricted to the configured IPv4 or IPv6 loopback origin with exact Host validation, no browser Origin, no redirects, and `Cache-Control: no-store` on capability-bearing responses.

[REQ-AOC-SCOPE] Every grant, session, projection, invalidation, action capability, and mutation MUST bind one exact `(owner MXID, owner DM room id, project room id, stable agent id)` scope and MUST fail closed on any mismatch.

[REQ-AOC-MATRIX-BOOTSTRAP] Bootstrap MUST originate as the dedicated Agent Operations control message in the exact encrypted owner-DM room, and the bridge MUST verify the full sender MXID, original encrypted envelope, event id, Megolm algorithm, restricted membership, enrolled Matrix device id and keys, and current device self-signature before forwarding it.

[REQ-AOC-DEVICE-ENROLLMENT] V1 MUST require local operator enrollment of the exact Matrix device id, Ed25519 key, and Curve25519 key; enrollment change, removal, binding change, room membership change, agent deletion, explicit revoke, or backend client-auth key rotation MUST advance a persistent auth fence and revoke older grants and sessions.

[REQ-AOC-POP] Grant exchange and every data-plane request MUST require an unpadded-base64url Ed25519 proof from the client ephemeral key over the frozen canonical request context, with a fresh consume-once nonce, exact audience, expiry, and no bearer-only or Dashboard-token fallback.

[REQ-AOC-SERVER-IDENTITY] The backend MUST own a persistent mode-0600 Ed25519 identity, MUST identify it by SHA-256 public-key fingerprint in the encrypted bootstrap response, and MUST sign grant and exchange material so the client can pin the intended loopback service.

[REQ-AOC-SESSION] A grant MUST be single-use and atomically exchanged for a short-lived opaque session capability; every request MUST recheck capability hash, client key, scope, expiry, revocation state, and auth-fence generation.

[REQ-AOC-PROJECTION] The backend MUST return a privacy-filtered authoritative `io.agentchat.agent_ops.v1` snapshot for one scope with projection id, persistent stream epoch, auth fence, monotonic JSON-safe sequence, backend-computed attention/tasks/queue/worktrees, persistent entity versions, resource dirty generations, and complete Matrix thread references.

[REQ-AOC-PRIVACY] A projection, error, fixture, log, or audit record MUST NOT expose absolute or home-relative paths, secrets, environment values, command-output credentials, unnecessary message bodies, private approval details, or another scope's data; action and session capabilities MUST be redacted from logs.

[REQ-AOC-INVALIDATION] Client events MUST be invalidation signals rather than deltas; any schema, scope, projection, stream epoch, auth fence, sequence gap, authentication, or privacy mismatch MUST make the client discard actionable state and re-bootstrap or re-snapshot as appropriate.

[REQ-AOC-ACTION-CAPABILITY] Every displayed mutation MUST be explicitly authorized by a short-lived backend-issued capability binding client session, scope, projection, stream epoch, auth fence, action kind, target id/version, optional resource generation, allowed resolutions, expiry, and unique jti.

[REQ-AOC-MUTATION-ATOMIC] In one RouterStore SQLite transaction a mutation MUST validate the live client session and action binding, compare current entity/resource preconditions, consume the action jti, invoke the existing router transition, and persist the idempotency digest and response; it MUST NOT introduce a second domain state machine or writer.

[REQ-AOC-IDEMPOTENCY] Mutations MUST digest parsed canonical fields, return the stored result for the same request id and digest, reject different content as `idempotency_conflict`, and retain results longer than the supported client retry window.

[REQ-AOC-OUTCOME-UNKNOWN] `outcome_unknown` MUST require begin-inspection followed by one backend-allowed resolution; `continue` MUST create a distinct recovery dispatch and MUST NEVER replay the original started dispatch, while `accept_completed` and `keep_blocked` MUST require a task.

[REQ-AOC-NO-APPROVAL-ACTIONS] Agent Operations MUST NOT expose approve or deny, delete worktrees or branches, or directly start/resume runners in V1.

[REQ-AOC-CANONICAL] Agent-chat MUST publish machine schema, positive and negative fixtures, stable errors, and a digest manifest; Robrix2 MUST remain fail closed until it consumes artifacts tied to an immutable agent-chat source commit.

## Scenarios

Scenario: Feature-off startup preserves all existing routes
  Given no Agent Operations client feature flag is configured
  When agent-chat starts and existing Dashboard, Matrix, approval, and runner tests execute
  Then every existing contract keeps its prior authentication and behavior
  And every `/api/agent-ops/v1/*` route returns unavailable

Scenario: Dashboard bearer is rejected from the client boundary
  Given the scoped client feature is enabled
  When a caller presents the backend `API_TOKEN` to a client endpoint
  Then the request is rejected
  And no client session or router mutation is created

Scenario: Encrypted enrolled owner bootstrap succeeds once
  Given an operator enrolled the exact owner Matrix device for one scope
  And the bridge verified a dedicated request from that device in the exact encrypted owner DM
  When the client proves possession of its ephemeral Ed25519 key
  Then one short-lived scoped session is issued
  And replaying the grant or proof nonce is rejected

Scenario: Device or scope substitution fails closed
  Given a valid bootstrap or session for one owner project and agent scope
  When any sender room device project agent scope or fence field is substituted
  Then authentication is rejected
  And no projection or mutation result is returned

Scenario: Snapshot contains only its authorized scope
  Given two agents or project rooms have router tasks dispatches and resources
  When one scoped client requests a snapshot
  Then only rows for its exact stable agent and project room appear
  And the response contains no local path secret approval body or other-scope row

Scenario: Stale mutation cannot change router state
  Given a snapshot action capability binds a dispatch version and resource dirty generation
  When either current value changes before the command arrives
  Then the command returns a stable precondition error
  And the router state is unchanged

Scenario: Mutation response loss is idempotent
  Given a valid client mutation committed but its HTTP response was lost
  When the identical request id and canonical payload are submitted again
  Then the original response is returned without applying the transition twice
  And different content with that request id is rejected

Scenario: Unknown runner outcome requires explicit inspection
  Given a started dispatch settled as outcome_unknown and dirtied its resource
  When the client asks to resolve it without a live inspection capability and matching generation
  Then the request is rejected
  And no original dispatch is replayed

Scenario: Revocation is immediate at the backend fence
  Given a live client session and action capability
  When its owner binding device enrollment membership or explicit revoke changes
  Then the persistent auth fence advances
  And every older session and action is rejected on its next request

Scenario: Canonical release is commit bound
  Given fixtures and schema exist in an uncommitted worktree
  When the canonical manifest is validated for release
  Then it is not considered consumable by Robrix2
  Until an immutable source commit and all artifact digests are recorded

## Dependencies

- REQ-OWNER-UI-APPROVAL
- REQ-THREAD-SCOPED-SESSIONS

## Source Trace

- decision: ADR-002
- decision: ADR-003
- decision: ADR-009
- decision: ADR-011
- decision: ADR-012
- Robrix2 `io.agentchat.agent_ops.v1` Proposed Revision 3, 2026-08-05.
- Operator directive in the 2026-08-05 implementation session.

## Open Questions

None.
