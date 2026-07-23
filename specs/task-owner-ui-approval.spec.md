spec: task
name: "Owner-scoped Matrix UI approvals"
inherits: project
satisfies: [REQ-OWNER-UI-APPROVAL, ADR-002, ADR-003, ADR-004, ADR-005, ADR-006]
tags: [active, security, matrix, approval]
estimate: 3d
---

## Intent

Relay supported coding-runtime permission requests to the owning developer
without granting approval power to other project-room members. Separate public
coordination status from private details and require structured, single-use UI
verdicts in the encrypted owner DM.

## Constraints

### Must
- Persist a crash-safe approval state machine with pending, approved, denied, expired, and consumed outcomes.
- Durably retain undecryptable approval-room events and retry them after later Matrix room-key delivery.
- Reconcile and replenish the bridge device's signed Curve25519 one-time keys
  when a homeserver omits usable counts, without turning an absent sync field
  into an unbounded upload loop.
- Validate full Matrix `event.sender`, owner DM room, project room, agent, request id, digest, expiry, and pending state.
- Preserve one independent inviter, owner, and approval-DM binding for every
  agent invited into the same project room; joining a second agent must not
  overwrite or reuse the first agent's binding.
- Keep public notices redacted and non-actionable.
- Use Claude Code's supported channel permission request/verdict protocol for Claude agents.
- Keep Claude agents in auto mode, but install content-scoped `ask` rules for protected external VCS operations so auto-mode hard denials become native permission prompts that the channel can relay.
- Use Codex's supported `PermissionRequest` command hook for Codex agents.
- Prevent recursive approval loops for the exact agent-chat MCP coordination
  tools that the managed runtime is expected to use. Text-only messaging and
  task-control calls may be allowed by the already-trusted hook; sending a
  local file attachment must still enter owner approval.
- Before creating a background Codex tmux session, verify the minimum supported
  Codex version, inspect the exact session hook through Codex App Server, and
  require one explicit local trust confirmation when its content-bound hash is
  untrusted or changed.
- Bind the Codex hook configuration to the hook script digest and derive its
  timeout from the backend approval TTL plus a bounded delivery margin.
- Resolve Claude and Codex approvals through one fail-closed state transition:
  consume the server-authorized result before delivering it to the runtime,
  and deliver an explicit deny when the approval channel fails.
- Abort managed background startup when a required approval adapter cannot be
  verified. Never leave a hidden native terminal prompt as the fallback.
- Prepare Codex project trust idempotently without depending on an optional
  Python TOML module; repair only identical duplicate target sections and fail
  closed on conflicting duplicates.
- Make managed Claude authentication deterministic: use an API key only when
  the agent's runtime profile explicitly defines one; otherwise clear an
  inherited `ANTHROPIC_API_KEY` so Claude can use its authenticated account.
- Keep encrypted owner approval rooms as the default and only permit a
  deliberately insecure plaintext diagnostic room when two explicit test-mode
  settings are present and the process is not running in production.

### Must Not
- Do not accept approval from free-form text, display names, localparts, room power level alone, or global administrator fallback.
- Do not inject terminal keystrokes to impersonate a runtime permission verdict.
- Do not render approval actions in public project rooms.
- Do not permit plaintext approval diagnostics in production or as an implicit
  fallback after an encryption failure.

## Decisions

- Owner provenance is the trusted full MXID that invited the exact managed agent into the project room.
- The private Matrix event contract carries `agent`, `project`, `project_room_id`, `request_id`, `input_digest`, `expires_at`, and UI actions.
- Robrix2 renders the event and emits a structured response; agent-chat performs every authorization check.
- Approval consumption uses an atomic compare-and-set from pending to a terminal state.
- Preserve `/sync` count semantics: a missing
  `device_one_time_keys_count` field means unchanged and is never rewritten.
- When `/sync` does not provide a numeric `signed_curve25519` count, perform a
  bounded empty `/keys/upload` probe, use its response as the authoritative
  count, and feed that count to the crypto state machine at most once every
  five minutes.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- bin/agent-up
- lib/approval-store.js
- lib/codex-hook-trust.js
- lib/codex-project-trust.js
- lib/pending-encrypted-event-store.js
- lib/codex-permission-hook.js
- lib/mcp-server-core.js
- lib/runtime-approval-client.js
- remote/lib/codex-hook-trust.js
- remote/lib/codex-project-trust.js
- remote/bin/agent-up
- remote/lib/codex-permission-hook.js
- remote/lib/mcp-server-core.js
- remote/lib/runtime-approval-client.js
- scripts/build-remote-package.sh
- scripts/check-remote-sync.sh
- schemas/approval/**
- tests/approval-store.test.js
- tests/api-approvals.test.js
- tests/bridge-matrix-approval.test.js
- tests/bridge-matrix.test.js
- tests/pending-encrypted-event-store.test.js
- tests/mcp-permission-channel.test.js
- tests/codex-project-trust.test.js
- tests/runtime-parity.test.js
- tests/bot-command-acl.test.js
- docs/architecture/**
- knowledge/**
- specs/**

### Forbidden
- Do not broaden public-room command permissions.
- Do not store approval details in public message bodies.
- Do not treat a UI client response as trusted until agent-chat validates the Matrix event.

## Acceptance Criteria

### Rule: private-ui-approval — Approval details and controls stay in the owner DM

Scenario: Public room receives redacted status only
  Test: public_approval_notice_is_redacted_and_non_actionable
  Given a runtime permission request is bound to a project room and owner
  When agent-chat publishes the waiting state
  Then the project room event contains no input preview or approval action

Scenario: Owner DM receives structured actions
  Test: owner_dm_approval_request_contains_structured_actions
  Given a valid encrypted owner DM exists
  When agent-chat publishes the detailed request
  Then the event contains approve-once and deny UI actions
  And the event binds the request fields and digest

Scenario: Multiple agents in one project room keep separate owner approval channels
  Tags: critical
  Test: project room retains independent room-agent approval bindings
  Given a project room already contains one managed agent and the bridge bot
  When the same trusted developer invites a second managed agent
  Then both room-agent ownership bindings remain active
  And each agent has its own encrypted approval DM
  And approval setup for the second agent does not depend on re-inviting the already-joined bridge bot

Scenario: Plaintext approval diagnostics are explicit and non-production only
  Tags: critical
  Test: plaintext approval diagnostics require explicit non-production opt-in
  Given encrypted owner approval rooms are the default
  When an operator requests the plaintext diagnostic mode
  Then a second explicit insecure-test acknowledgement is required
  And production startup rejects the mode
  And an encryption failure never selects the mode automatically

Scenario: A delayed room key does not lose the owner verdict
  Tags: critical
  Test: delayed_room_key_retries_encrypted_owner_verdict
  Given an encrypted owner verdict arrives before its Megolm room key
  When the bridge receives the room key in a later sync
  Then the retained verdict is decrypted and submitted exactly once
  And a bridge restart cannot silently discard the retained event

Scenario: Missing one-time-key counts are reconciled without an upload loop
  Tags: critical
  Test: OTK count reconciliation is bounded to one probe per interval
  Given a Matrix sync does not report a numeric signed Curve25519 count
  When the bridge passes the sync response to its crypto state machine
  Then the original sync count field remains unchanged
  And the bridge obtains the authoritative count from an empty keys-upload request
  And reconciliation runs at most once per bounded interval
  And the crypto state machine replenishes keys only when that count requires it

Scenario: Plain text cannot approve
  Tags: critical
  Test: approval_text_message_is_ignored
  Given a request is pending
  When the owner sends approval-like text
  Then the request remains pending

### Rule: owner-authorization — Only the bound owner can consume a live request

Scenario: Exact owner action is consumed once
  Tags: critical
  Test: owner_ui_verdict_is_consumed_once
  Given a live request is bound to an owner MXID and DM room
  When that exact Matrix sender selects approve once
  Then one approved verdict is persisted and relayed

Scenario: Another developer is rejected
  Tags: critical
  Test: non_owner_ui_verdict_is_rejected
  Given another project developer can see the agent in the public room
  When that developer submits the request id
  Then the request remains pending and an authorization failure is audited

Scenario: Expired or replayed action is rejected
  Tags: critical
  Test: expired_or_replayed_ui_verdict_is_rejected
  Given the request is expired or already terminal
  When the owner submits the same action
  Then no second verdict is relayed

Scenario: Empty owner has no administrator fallback
  Tags: critical
  Test: missing_owner_denies_without_admin_fallback
  Given no trusted inviter owner is recorded
  When a runtime requests permission
 Then agent-chat denies it without creating an approvable request

Scenario: Claude auto mode opens a relayable prompt for protected VCS operations
  Test: launchers_keep_sandbox_defaults_and_wire_only_supported_adapters
  Given a Claude agent uses auto mode and the owner permission channel
  When it invokes GitHub CLI or git push
  Then agent-chat installs content-scoped ask rules in the agent-local Claude settings
  And Claude opens a native permission prompt that the channel can relay

Scenario: Managed Claude approval transport fails closed
  Tags: critical
  Test: runtime_approval_failure_is_delivered_as_explicit_deny
  Given a Claude permission request was emitted through the managed channel
  When the backend request, polling, consumption, or verdict relay fails
  Then the channel delivers an explicit deny for the original request id
  And agent-chat does not leave an approval prompt hidden in tmux

Scenario: Managed Claude launch does not inherit an undeclared API key
  Tags: critical
  Test: launchers_clear_ambient_anthropic_key_without_explicit_profile
  Given the operator shell exports ANTHROPIC_API_KEY
  And the Claude agent runtime profile does not define an API key
  When agent-chat writes the managed launch environment
  Then the inherited API key is cleared before Claude starts
  And an explicit per-agent runtime profile API key is still exported when configured

Scenario: Codex hook trust is verified before background startup
  Tags: critical
  Test: codex_hook_preflight_precedes_tmux_and_requires_exact_trust
  Given a Codex agent uses the owner permission hook
  When agent-chat prepares the managed background session
  Then it checks the supported Codex capability through App Server before creating tmux
  And an untrusted or modified exact hook requires explicit local confirmation
  And a non-interactive or declined confirmation aborts startup
  And no hook-trust bypass flag is used

Scenario: Codex hook changes invalidate previous trust
  Tags: critical
  Test: codex_hook_command_binds_script_digest_and_dynamic_timeout
  Given the Codex permission hook was previously trusted
  When the hook script contents or approval TTL changes
  Then the generated hook command or timeout changes the Codex configuration hash
  And Codex requires trust for the new exact configuration before launch

Scenario: Repeated Codex startup keeps project trust parseable
  Tags: critical
  Test: repairs_identical_duplicate_sections_before_codex_parses_the_file
  Given a Codex project trust section already exists on a host without Python TOML support
  When agent-chat prepares the same managed project again
  Then exactly one trusted project section remains
  And conflicting duplicate sections abort startup without being merged

Scenario: Managed Codex approval transport fails closed
  Tags: critical
  Test: codex_hook_failure_emits_explicit_deny
  Given Codex invokes the managed PermissionRequest hook
  When agent identity, script integrity, backend transport, polling, or consumption fails
  Then the hook emits the documented deny decision
  And Codex does not fall back to an unattended native prompt

Scenario: Codex coordination does not recursively request owner approval
  Tags: critical
  Test: codex_internal_coordination_tools_are_allowed_without_recursive_approval
  Given the trusted Codex hook receives a permission request for an exact agent-chat MCP tool
  When the tool reads coordination state or sends text-only workflow messages
  Then the hook returns allow without creating an owner approval request
  And a message containing a local file attachment still requires owner approval
  And Bash, patch, and unrelated MCP tools still require owner approval

### Rule: public-control-fail-closed — Public generic controls cannot bypass approval

Scenario: Public control command is denied
  Tags: critical
  Test: public_room_ctl_cannot_bypass_approval
  Given a pending runtime request exists
  When a public-room member uses `!ctl key`, `!ctl send`, or `!ctl status`
  Then no approval state changes and no terminal input is injected

## Out of Scope

- Making Robrix2 an authorization authority.
- Replacing the runtime's own sandbox.
- Injecting terminal input or using an undocumented runtime approval protocol.
