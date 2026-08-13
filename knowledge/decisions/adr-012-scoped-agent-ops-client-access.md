---
kind: decision
id: ADR-012
title: "Scoped local Agent Operations access for Robrix2"
status: Accepted
liveness: auto
tags: [robrix2, agent-ops, client-auth, capability, router, matrix, security]
---

## Context

ADR-011 keeps the router's V1 read and mutation endpoints inside the local
Dashboard boundary. Those endpoints use the backend-wide `API_TOKEN`, expose
an operator-oriented DTO, and authorize operator operations rather than one
owner/project/agent scope. Giving that credential or wire format to Robrix2
would turn a presentation client into a backend operator and would violate
ADR-002, ADR-003, ADR-009, ADR-011, and REQ-OWNER-UI-APPROVAL.

Robrix2 proposed `io.agentchat.agent_ops.v1` Revision 3. It separates Matrix
bootstrap from a scoped loopback data plane, makes projections authoritative,
and binds mutations to short-lived action capabilities plus entity and
resource generations. This ADR accepts that shape with the concrete security
profile and compatibility boundary below.

## Decision

### Compatibility and authority

Agent Operations is a new, versioned client boundary. It does not change the
meaning, authentication, DTO, or route names of the existing Dashboard
`/api/router/*` endpoints. It is disabled unless
`AGENTCHAT_AGENT_OPS_CLIENT=1`; enabling it also requires the accepted
ADR-011 router and thread-session runtime. With the switch off no client
session service is activated, no Matrix control event is handled, and no Agent
Operations route is available.

Agent-chat remains the only authorization and state-transition authority.
Robrix2 renders snapshots and submits requests. It never receives
`API_TOKEN`, `MATRIX_BRIDGE_SECRET`, an agent token, a runner capability, or an
approval capability. Approve and deny remain exclusively on the existing
encrypted owner-DM verdict path.

### V1 deployment and scope

V1 supports a Robrix2 process on the same host as agent-chat. Data-plane
requests must arrive over an explicitly configured `http://127.0.0.1:<port>`
or `http://[::1]:<port>` origin, with an exact Host match, no Origin header,
and no redirect. Capability-bearing responses use `Cache-Control: no-store`.
Remote and mobile data planes are not supported.

Each client session authorizes exactly:

```text
owner_mxid + owner_dm_room_id + project_room_id + stable_agent_id
```

The owner and room pair must equal the current approval binding and the stable
agent id must resolve to that binding's registered agent. A projection cannot
aggregate scopes. Robrix2 may compose independent projections locally, but a
capability issued for one scope is invalid for every other scope.

### Matrix bootstrap and device enrollment

Bootstrap uses the dedicated
`io.agentchat.agent_ops.client_session.request.v1` message type in the exact
encrypted owner-DM room. The bridge records the original
`m.room.encrypted` envelope before decryption and verifies the full sender
MXID, event id, Megolm algorithm, Matrix device id, Curve25519 sender key, and
the restricted room membership. It queries the sender's current Matrix device
record and validates the device's Ed25519 self-signature using Matrix Canonical
JSON.

V1 does not use trust-on-first-use for a Matrix device. Before bootstrap, an
operator must enroll the exact device id, Ed25519 key, and Curve25519 key for
the scope through a local operator-authenticated endpoint. Enrollment and
replacement rotate the scope's client-auth fence and revoke every outstanding
grant and session. Removal, approval-binding change, room membership change,
agent deletion, explicit logout/revoke, and backend client-auth key rotation
do the same. A short client-session lifetime bounds delayed Matrix device-list
notifications; the bridge also revokes an enrolled scope when it observes the
enrolled device disappear or change keys.

This explicit enrollment is intentionally stricter than trusting a new
cross-signing master key observed during bootstrap. Automated cross-signing
enrollment may replace the manual step only in a later accepted security
profile that can consume and persist the SDK's verified-device state without
private SDK APIs.

### Proof of possession and server identity

The client generates an ephemeral Ed25519 key pair and sends the public JWK
and a unique client nonce in the encrypted bootstrap event. The backend owns
the session id and issues a single-use grant containing a unique jti, server
challenge, exact loopback audience, scope and auth-fence generation, expiry,
and server Ed25519 public-key fingerprint. The grant contains no reusable
data-plane bearer authority: exchanging it requires an Ed25519 signature by
the ephemeral client key over the grant jti, nonces, challenge, method, path,
canonical body digest, and audience.

The backend persists its Ed25519 identity in a mode-0600 file and signs the
grant and exchange response. Robrix2 pins the fingerprint delivered by the
encrypted control plane before accepting the loopback response. Exchange
atomically consumes the grant and returns an opaque, short-lived session
capability. Every subsequent request requires both that capability and a new
Ed25519 proof nonce; proof nonces are consume-once. There is no fallback to a
Dashboard bearer, plaintext Matrix, or a public room.

Wire bodies are canonicalized by recursively sorting object keys and encoding
strict JSON. SHA-256 is the body and semantic digest. Ed25519 is used directly
through the platform crypto implementation. Keys and signatures use unpadded
base64url. TTLs, sizes, nonce budgets, and stable error codes are frozen by
the canonical machine artifacts.

### Projection and invalidation

The client snapshot schema is `io.agentchat.agent_ops.v1`. A snapshot carries
one expanded scope, `scope_id`, stable `projection_id`, persistent
`stream_epoch`, current `auth_fence_generation`, and a JSON-safe monotonic
`seq`. Scope, projection, epoch, or fence mismatch invalidates the whole view.
Events are invalidation signals only; Robrix2 always re-snapshots.

The projection contains backend-computed `attention`, `tasks`, `queue`, and
`worktrees`. It excludes absolute and home-relative paths, secrets, command
output, message bodies unnecessary to the view, and owner approval contents.
Blocking chains and available actions are computed by the backend, never by
Robrix2. Actionable rows carry persistent entity versions; resource actions
also carry `dirty_generation`.

### Mutations

The client protocol does not introduce a second task, dispatch, resource, or
approval state machine. A client command is an authenticated adapter onto the
existing RouterStore transition. Every command includes a globally unique
`request_id`, client/session/scope/projection/epoch/fence fields,
`snapshot_seq`, an opaque action capability, an exact target entity/version,
and any resource generation precondition.

The action capability binds those fields, the action kind, allowed outcome
resolutions, expiry, and a unique jti. In one SQLite transaction agent-chat
rechecks the live client session and auth fence, verifies and consumes the
action jti, compares entity/resource state, applies the existing domain
transition, and stores the semantic request digest and response. Repeating the
same request id and digest returns the stored response; different content is
`idempotency_conflict`. `snapshot_seq` is freshness context, not authority.

V1 actions are `cancel_dispatch`, `mark_resource_inspected`,
`begin_outcome_inspection`, and `resolve_outcome`. It cannot delete a worktree
or branch, start or resume a runner directly, or approve/deny an operation.
`outcome_unknown` has the three accepted resolutions `continue`,
`accept_completed`, and `keep_blocked`; only `continue` is valid without a
task. Continuing creates a new queued recovery dispatch and never executes
the original started dispatch again.

### Canonical artifacts and release gate

Agent-chat owns the canonical fixtures, JSON Schema, stable errors, and a
SHA-256 manifest under `specs/fixtures/agent-ops-client-v1/`. A development
manifest may identify an uncommitted source tree but is not a releasable
cross-repository contract. Robrix2 remains fail closed until the manifest
contains the immutable agent-chat source commit used to publish the artifacts
and its local copies match every digest.

## Consequences

Good, because Robrix2 receives only the minimum owner/project/agent authority
and cannot reuse a stolen session bearer without its ephemeral private key.

Good, because the Dashboard API remains backward compatible and the router
keeps one state machine and one transactional writer.

Good, because stale views, replay, scope substitution, resource-generation
races, ambiguous runner outcomes, and credential fallback fail closed.

Bad, because V1 requires same-host deployment and a one-time operator device
enrollment before Robrix2 can bootstrap.

Bad, because short sessions and full re-snapshot invalidation add traffic and
implementation complexity.

Bad, because canonical artifact release requires coordination across two
repositories and an immutable source commit.

## Alternatives Considered

- Give Robrix2 `API_TOKEN`: rejected because it grants backend-wide operator
  authority and exposes an incompatible Dashboard contract.
- Reuse `/api/router/*` with conditional filtering: rejected because one route
  would carry two authentication and privacy meanings and is easy to regress.
- Put operational state and capabilities in Matrix events: rejected because
  timelines are durable, replicated, and unsuitable for high-volume or secret
  data-plane material.
- Bearer-only loopback sessions: rejected because another local process able
  to read or intercept the bearer could exercise the scope.
- Trust the first requesting Matrix device: rejected because account takeover
  or a newly added unverified device could enroll itself.
- Let Robrix2 derive actions or blocking chains: rejected because client and
  backend state machines would drift and stale UI state could become authority.
