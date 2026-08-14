spec: task
name: "Scoped Agent Operations client access"
inherits: project
satisfies: [REQ-AGENT-OPS-CLIENT, ADR-012, ADR-011, REQ-OWNER-UI-APPROVAL]
tags: [active, robrix2, agent-ops, security, router, client-auth]
estimate: 14d
---

## Intent

Publish and implement `com.hafleet.agent_ops.v1` as a same-host,
owner/project/agent-scoped client boundary so Robrix2 can render operational
state and request a bounded set of router operations without receiving
backend-wide credentials or becoming a state or approval authority.

## Constraints

### Must

- Keep the feature disabled by default and require the accepted thread-session router.
- Add independent client authentication and route namespaces; preserve existing Dashboard Router routes and DTOs.
- Bootstrap only from the exact encrypted owner-DM room and an operator-enrolled Matrix device.
- Require Ed25519 proof of possession for grant exchange and every data-plane request.
- Persist grants, sessions, nonces, auth fences, action consumption, and idempotency in RouterStore SQLite.
- Return one authoritative privacy-filtered projection per exact owner/project/agent scope.
- Generate action capabilities from live backend state and bind entity/resource versions.
- Adapt client commands to existing RouterStore transitions in one transaction.
- Publish canonical machine schema, positive/negative fixtures, stable errors, and SHA-256 manifest.
- Add deterministic feature-off, authentication, privacy, scope, replay, CAS, idempotency, revocation, and outcome-recovery tests.

### Must Not

- Do not pass `API_TOKEN`, bridge secrets, agent tokens, runner capabilities, or approval capabilities to Robrix2.
- Do not accept a Dashboard bearer on any client route.
- Do not change existing `/api/router/*`, Matrix message, approval, task, or runner semantics.
- Do not trust loopback placement, a Matrix display name/localpart, a client-supplied session id, or first-use device keys as authority.
- Do not create a second task/dispatch/resource state machine or database writer.
- Do not expose approve/deny, worktree deletion, branch deletion, or direct runner start/resume.
- Do not expose absolute paths, private approval content, unnecessary message bodies, or another scope's rows.
- Do not describe an uncommitted development manifest as released to Robrix2.

## Decisions

- Contract id: `com.hafleet.agent_ops.v1`.
- Routes: `/api/agent-ops/v1/*`; existing `/api/router/*` remains Dashboard-only.
- Feature flag: `HAFLEET_AGENT_OPS_CLIENT`, default false.
- Data plane: exact configured IPv4/IPv6 loopback origin, non-browser requests only.
- Client PoP and server identity: Ed25519 JWK, unpadded base64url signatures, SHA-256 canonical body digest.
- Scope identity: SHA-256 digest of owner MXID, owner DM room id, project room id, and stable agent id.
- Matrix device trust: explicit local operator enrollment plus bridge verification of encrypted envelope, exact keys, and self-signature.
- Session capability: opaque random bearer plus per-request Ed25519 proof; both are required.
- Projection events invalidate; clients never reduce deltas into domain state.
- Mutation idempotency applies to parsed canonical fields and is committed with the domain transition.

## Boundaries

### Allowed Changes

- backend-v2.js
- bridge-matrix.js
- lib/agent-ops-client-auth.js
- router/**
- specs/fixtures/agent-ops-client-v1/**
- tests/agent-ops-client*.test.js
- tests/bridge-matrix.test.js
- tests/router-*.test.js
- scripts/**
- package.json
- package-lock.json
- knowledge/**
- docs/**
- specs/**

### Forbidden

- Do not change Robrix2 source in this task.
- Do not modify runtime data files or embed production keys/tokens in fixtures.
- Do not enable the client feature or thread sessions in production configuration.
- Do not accept remote/mobile transport or Octos/remote runner execution into this client contract.

## Acceptance Criteria

### Rule: compatibility — the new boundary is additive and default-off

Scenario: Existing behavior is unchanged while feature is off
  Tags: critical
  Test: agent_ops_client_feature_off_preserves_existing_backend_contracts
  Given agent-chat starts without HAFLEET_AGENT_OPS_CLIENT
  When existing Dashboard Router Matrix approval and runner routes are exercised
  Then their authentication DTOs and state transitions remain unchanged
  And Agent Operations client routes are unavailable

Scenario: Dashboard bearer cannot authenticate as Robrix2
  Tags: critical
  Test: agent_ops_client_rejects_dashboard_bearer
  Given the client feature and Dashboard API token are configured
  When a caller presents only the Dashboard bearer to a client endpoint
  Then the request is rejected before reading or mutating router state

### Rule: bootstrap — only an encrypted enrolled owner device can establish scope

Scenario: Encrypted owner bootstrap exchanges exactly once
  Tags: critical
  Test: agent_ops_client_bootstrap_and_exchange_are_single_use
  Given the exact owner device is enrolled for an approval-bound project and stable agent
  And the bridge attests a dedicated encrypted owner-DM control event
  When the client signs the canonical exchange with its ephemeral key
  Then the backend issues one scoped short-lived client session
  And grant or nonce replay is rejected

Scenario: Wrong room sender device or scope is rejected
  Tags: critical
  Test: agent_ops_client_bootstrap_rejects_identity_substitution
  Given a valid enrolled owner scope
  When the bridge attestation substitutes any owner room project agent device or device key
  Then no grant is issued
  And no scope auth state is widened

Scenario: First-use device cannot self-enroll
  Test: agent_ops_client_requires_operator_device_enrollment
  Given no operator device enrollment exists for the scope
  When a cryptographically valid Matrix device requests bootstrap
  Then the backend returns device_enrollment_required
  And creates no grant or session

### Rule: proof — bearer possession alone is insufficient

Scenario: Session request requires a fresh valid client proof
  Tags: critical
  Test: agent_ops_client_request_requires_pop_and_rejects_replay
  Given a live client session capability
  When the request has no proof a wrong signature or a previously consumed nonce
  Then it is rejected
  And the same bearer cannot retrieve a snapshot

Scenario: Host origin and server identity are frozen
  Test: agent_ops_client_data_plane_is_loopback_and_server_pinned
  Given the scoped client feature is enabled
  When a request uses a non-loopback peer wrong Host browser Origin or wrong audience
  Then it is rejected
  And a valid grant carries a signed server-key fingerprint from the configured loopback endpoint

### Rule: projection — the backend sends only authoritative scoped UI data

Scenario: Projection excludes other scopes and sensitive fields
  Tags: critical
  Test: agent_ops_projection_is_scope_and_privacy_filtered
  Given two rooms and agents have tasks dispatches resources paths secrets and approvals
  When one scoped session requests its snapshot
  Then only its stable agent and project-room rows appear
  And paths secrets message bodies and approval details do not appear in serialized output

Scenario: Snapshot carries stable freshness identity
  Test: agent_ops_projection_carries_epoch_fence_and_monotonic_seq
  Given a client obtains two snapshots around a router state change
  When it compares their scope projection stream auth-fence and sequence fields
  Then identity fields remain stable within the live scope and sequence increases
  And revocation changes the auth fence and invalidates the old session

Scenario: Queue blockage is backend computed
  Test: agent_ops_projection_reports_backend_blocking_chain
  Given a queued dispatch waits for a resource leased by a parked dispatch
  When the backend builds the scoped projection
  Then the queue row names the resource wait and holding dispatch
  And the client needs no lease-state inference

### Rule: mutation — capabilities and CAS guard the sole router state machine

Scenario: Valid cancel is atomic and idempotent
  Tags: critical
  Test: agent_ops_cancel_dispatch_is_capability_bound_and_idempotent
  Given a snapshot authorizes cancellation of a current dispatch version
  When the client sends a valid command twice with the same request id and digest
  Then the existing RouterStore cancel transition occurs exactly once
  And both responses are equivalent

Scenario: Stale target or dirty generation fails closed
  Tags: critical
  Test: agent_ops_mutation_rejects_stale_entity_and_resource_preconditions
  Given an action capability was issued for an entity version and dirty generation
  When either live value changes before mutation
  Then the command returns a stable precondition error
  And consumes no unrelated authority or state transition

Scenario: Dirty quarantine cannot be cleared as ordinary inspection
  Test: agent_ops_mark_inspected_requires_non_quarantine_resource
  Given a resource is dirty because an outcome_unknown dispatch is unresolved
  When the client requests mark_resource_inspected
  Then the backend returns inspection_required
  And the dirty marker and generation remain

### Rule: outcome-recovery — a dead runner is resolved without replay

Scenario: Begin inspection returns only allowed recovery actions
  Tags: critical
  Test: agent_ops_begin_outcome_inspection_issues_bound_resolution
  Given a scoped outcome_unknown dispatch and matching dirty resource
  When the client begins inspection with its displayed capability
  Then the backend returns a one-time inspection token and resolve capability
  And allowed_resolutions are backend-computed for whether a task exists

Scenario: Continue creates a new dispatch and never replays the old one
  Tags: critical
  Test: agent_ops_resolve_continue_creates_new_dispatch_once
  Given an inspected outcome_unknown task dispatch
  When the owner chooses continue with a recovery instruction
  Then a distinct queued replacement dispatch is created exactly once
  And the original dispatch remains terminal and is never executed again

Scenario: Terminal resolution rejects recovery instruction
  Test: agent_ops_terminal_resolution_rejects_recovery_instruction
  Given a task outcome can be accepted completed or kept blocked
  When either terminal resolution carries a recovery instruction
  Then strict request validation rejects it
  And the inspection remains unresolved

### Rule: revocation-and-release — stale authority and development artifacts stay unusable

Scenario: Scope revocation fences all derived authority
  Tags: critical
  Test: agent_ops_scope_revocation_invalidates_sessions_and_actions
  Given a live session and unconsumed action for a scope
  When operator enrollment owner binding room membership or explicit revoke rotates its fence
  Then the old session cannot read or mutate
  And the old action cannot be used through a replacement session

Scenario: Canonical manifest detects artifact drift
  Test: agent_ops_canonical_manifest_matches_artifacts
  Given the canonical V1 schema and fixtures
  When the manifest verifier hashes every artifact
  Then every SHA-256 digest matches
  And a development source revision remains explicitly non-releasable

## Out of Scope

- Robrix2 runtime transport and panel activation.
- Remote/mobile data planes.
- Automatic Matrix cross-signing enrollment without operator pinning.
- Approval/deny controls in Agent Operations.
- Worktree or branch deletion.
- Direct runner start/resume.
- A second task or dispatch state machine.
