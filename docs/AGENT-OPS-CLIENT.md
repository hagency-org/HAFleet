# Agent Operations client V1

Status: implemented behind a default-off gate. The canonical manifest is
still `development`; Robrix2 must remain fail closed until the artifacts are
published from an immutable agent-chat commit.

## What this boundary permits

A Robrix2 process on the same host may obtain one short-lived view for one
exact owner, encrypted owner-DM, project room, and stable agent. It can render
the backend projection and request only the actions included in that
projection: cancel a dispatch, mark an unambiguous non-quarantined resource as
inspected, or inspect and resolve an `outcome_unknown` dispatch.

It cannot approve or deny runtime operations, delete a worktree or branch,
start a runner, read another scope, or authenticate with the Dashboard
`API_TOKEN`.

## Server prerequisites

The feature requires the accepted thread-session router and remains local
only:

```sh
HAFLEET_ROUTER_TASK_CUTOVER=1
HAFLEET_THREAD_SESSIONS=1
HAFLEET_AGENT_OPS_CLIENT=1
HAFLEET_AGENT_OPS_LOOPBACK_ORIGIN=http://127.0.0.1:8090
```

The backend creates `data/agent-ops-server-identity.json` with mode `0600`.
Replacing that identity rotates every Agent Operations auth fence and revokes
all older grants and sessions.

## Explicit device enrollment

V1 deliberately has no trust-on-first-use. After the approval binding exists,
an operator must pin the owner's current Matrix device id, Ed25519 key, and
Curve25519 key through the local Dashboard-authenticated endpoint:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -X PUT http://127.0.0.1:8090/api/agent-ops/v1/operator/device-enrollment \
  --data '{
    "agent":"worker",
    "project_room_id":"!project:example.org",
    "owner_mxid":"@owner:example.org",
    "owner_dm_room_id":"!approval:example.org",
    "matrix_device_id":"OWNERDEVICE",
    "matrix_device_ed25519":"base64-device-key",
    "matrix_device_curve25519":"base64-device-key"
  }'
```

Use this only on loopback and do not place `API_TOKEN` in Robrix2. Enrollment
replacement, owner-binding or approval-room membership change, Matrix device
list change, agent deletion, explicit revoke, and server identity rotation all
advance the persistent auth fence.

## Bootstrap and data plane

Robrix2 sends the dedicated
`com.hafleet.agent_ops.client_session.request.v1` message in the encrypted
owner-DM. The bridge validates the original encrypted envelope, exact room
membership, current device record and self-signature, then returns a signed
single-use grant in Matrix. Grant exchange and every loopback request require
Ed25519 proof of possession by the client's ephemeral key.

The authoritative artifacts are under
`specs/fixtures/agent-ops-client-v1/`. Verify them with:

```sh
npm run build:router
npm run check:agent-ops-contract
```

Do not change `manifest.json` to `released` until `source_commit` names the
immutable commit containing the exact artifacts and all recorded digests have
been regenerated and verified.
