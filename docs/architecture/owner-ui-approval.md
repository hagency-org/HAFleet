# Owner-scoped Matrix UI approval

Agent-chat is the authorization authority. Robrix2 only renders the structured
Matrix events and emits a structured button response.

## Ownership and binding

For each managed agent in a project room, the owner is the authenticated full
MXID that invited that exact agent account. The bridge persists that provenance
as `roomAgentBindings[project_room_id][agent]` and creates a dedicated encrypted
room named `Approval: <agent>`. Inviting another agent into a room adds a new
entry; it does not replace the existing agent, owner, or approval room. A
backend binding is activated only after the owner has joined that encrypted
room:

`agent + project + project_room_id + owner_mxid + owner_dm_room_id`

Missing or ambiguous bindings deny the runtime request. Global administrators,
display names, and localparts are never fallback approvers.

## Matrix event contract

The versioned JSON Schemas live under `schemas/approval/`.

- Public room: `com.agentchat.approval.status.v1`. It contains only agent,
  project, and `waiting_for_owner`; it has no request id, digest, input preview,
  or actions.
- Encrypted owner room: `com.agentchat.approval.request.v1`. It contains the
  complete binding, expiry, runtime details, input digest, and exactly two UI
  actions: `approve_once` and `deny`.
- Encrypted owner response: `com.agentchat.approval.verdict.v1`. The bridge
  forwards the Matrix event's real `event.sender`, room id, event id, binding,
  digest, request id, and action to the backend. During the namespace transition
  the bridge also accepts verdicts sent under the older `com.hafleet.approval.*`
  names so events already in flight are not lost; it sends only `com.agentchat.*`.
  The wire namespace is pinned by the deployed Robrix2 client and does not follow
  product renames.

Free-form text is ordinary chat and never becomes a verdict. `!ctl` and
`!agentctl` are rejected in project and approval rooms even for a configured
global administrator.

For E2EE fault isolation only, a local non-production bridge may set both
`HAFLEET_APPROVAL_DM_MODE=plaintext-test` and
`HAFLEET_ALLOW_PLAINTEXT_APPROVAL_TEST=1`. This creates a separate private,
bridge-restricted room named `Approval Test (UNENCRYPTED): <agent>`. The mode is
never selected automatically, is rejected when `NODE_ENV=production`, and must
not be used for deployment.

## State and runtime relay

`data/approvals.json` is written atomically with mode `0600`. Requests move
through `pending`, `approved`/`denied`/`expired`, then `consumed`. Only a pending,
unexpired request matching every bound field can accept one verdict.

Claude Code uses the documented MCP Channel permission notification pair.
Because custom channels are still a research preview, the launcher enables the
development channel allowlist exception only for the configured local
hafleet MCP server. Managed channel failures are returned to Claude as an
explicit deny for the original request id; they are never left as a prompt that
can only be seen inside tmux. Restarting a managed Claude agent must go through
`hafleet up`, which restores auto mode, the channel flag, MCP configuration,
and agent-local protected-operation ask rules. The launcher replaces the tmux
pane shell with its managed runtime wrapper; when Claude exits, the pane closes
instead of leaving a shell where an unconfigured Claude process can be started.

Codex uses the documented synchronous `PermissionRequest` hook. The launcher
keeps Level 2 (`workspace-write` plus `on-request`) and adds the hook through a
session `-c hooks.PermissionRequest=...` override. Before tmux exists, the
launcher verifies Codex support and asks Codex App Server for the exact hook's
trust status. New or changed hooks require one explicit local confirmation;
non-interactive starts and declined trust abort. The persisted trust applies
only to Codex's reported current hash. Agent-chat neither edits Codex trust
state directly nor uses the trust-bypass flag.

The hook command embeds the SHA-256 digest of its script, and the script verifies
that digest before contacting the backend. Its timeout is the configured
approval TTL plus a delivery margin. A hook integrity, identity, transport,
polling, consumption, or output failure emits the documented deny decision, so
Codex cannot fall back to an unattended terminal prompt.

After integrity and agent-identity checks, the hook locally allows only the
exact hafleet MCP coordination/task tools. This prevents `check_inbox` from
recursively creating the approval it is trying to read. Text-only
`send_message` and `post` are also allowed; requests with local file
attachments, all unrelated MCP namespaces, and coding tools continue through
the owner approval state machine.

Both runtime adapters consume the terminal approval before delivering it to the
runtime. This preserves single-use authorization even if the runtime disconnects
immediately after the server accepts the verdict.
