# Group & Room System Architecture

> **Scope**: How agentchat groups, DM rooms, SPY rooms, and Matrix rooms are created, mapped, reconciled, and queried.
> **Primary sources**: `backend-v2.js`, `bridge-matrix.js`, `lib/group-store.js` (does not exist — all group logic is inline in backend-v2.js).

---

## Table of Contents

1. [Room Types](#1-room-types)
2. [Group System](#2-group-system)
3. [Room Lifecycle](#3-room-lifecycle)
4. [Key Data Structures](#4-key-data-structures)
5. [Matrix Bridge Integration](#5-matrix-bridge-integration)
6. [API Routes](#6-api-routes)
7. [Cursor System](#7-cursor-system)
8. [Message Delivery & Mentions](#8-message-delivery--mentions)

---

## 1. Room Types

Agentchat manages four distinct room types, each with different creation paths, naming conventions, and visibility rules.

### 1.1 Agent DM Rooms

**Purpose**: Private 1:1 channel between a human operator and an agent.

| Property | Value |
|----------|-------|
| Matrix room name | `DM: agentName` |
| Room preset | `trusted_private_chat` |
| Stored in | `state.dmRooms` (Map: agentName → roomId) |
| Created by | `ensureDmRoom()` in `bridge-matrix.js:2883-3043` |
| Triggered by | POST `/api/dm/ensure` → SSE `dm_ensure` event → bridge |

Creation flow:
```
POST /api/dm/ensure { agent: "alice" }
  → backend broadcasts SSE event: dm_ensure { agent: "alice" }
  → bridge receives SSE event
  → bridge calls ensureDmRoom("alice")
    → checks state.dmRooms for existing room
    → if none: creates Matrix room "DM: alice"
    → invites bot + agent puppet + human operator
    → sets room avatar (synced from agent avatar)
    → saves roomId to state.dmRooms
```

**Key**: DM rooms are excluded from group mapping and reconciliation. The `parseDmAgentName()` function (`bridge-matrix.js:693-699`) extracts the agent name from the `DM: agentName` room name format.

### 1.2 SPY Rooms

**Purpose**: Operator surveillance channel to observe messages between two agents or between an agent and a group.

| Property | Value |
|----------|-------|
| Matrix room name | `SPY: fromName ↔ toName` |
| Room preset | `trusted_private_chat` |
| Stored in | `state.dmRooms` (under spy key format) |
| Created by | `ensureDmRoom()` with spy parameters |
| Triggered by | `!spy` bot command from operator |

SPY rooms use the same `ensureDmRoom()` code path but with a different key format (`spy:from↔to`) and naming convention (`SPY: from ↔ to`). The `!spy` command invites the operator into the existing agent-agent DM room — the observed agents are active participants and can see the operator when invited.

### 1.3 Group Rooms

**Purpose**: Multi-agent collaboration channels mapped to backend groups.

| Property | Value |
|----------|-------|
| Matrix room name | `[AC] groupName` (convention, not enforced) |
| Room preset | Varies (typically `trusted_private_chat`) |
| Stored in | `state.roomGroupMap` / `state.groupRoomMap` |
| Created by | Bridge on room name event or operator via `!mkgroup` |
| Mapped by | `mapRoom()` in bridge-matrix.js |

Group rooms are the primary multi-party communication channel. When a Matrix room is named (or renamed), the bridge detects the name event and:
1. Checks if the name matches a DM/SPY pattern — if so, skips group mapping
2. Creates the group in the backend via `POST /api/groups`
3. Maps the room to the group via `mapRoom()`
4. Triggers membership reconciliation

### 1.4 Human DM Rooms

**Purpose**: Private 1:1 channel between a human and an agent, initiated from the human side.

| Property | Value |
|----------|-------|
| Matrix room name | `DM: agentName` (same as agent DM) |
| Created by | `ensureHumanDmRoom()` in `bridge-matrix.js:2854-2881` |
| Difference | Wraps `ensureDmRoom()` with human invite handling |

Human DM rooms use the same underlying creation mechanism as agent DM rooms. The `ensureHumanDmRoom()` wrapper handles the case where the human (identified by Matrix user ID) needs to be invited to the room.

---

## 2. Group System

### 2.1 Data Model

Groups are stored in `data/groups.json` as a flat object:

```json
{
  "info": {
    "name": "info",
    "members": ["ac-topleader", "ac-researcher", "ac-builder"],
    "createdAt": 1711612345678
  },
  "dev-team": {
    "name": "dev-team",
    "members": ["ac-builder", "ac-tester"],
    "createdAt": 1711612345999
  }
}
```

**Schema per group**:
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique group identifier |
| `members` | string[] | Array of agent names |
| `createdAt` | number | Unix timestamp (ms) |

There is **no separate `lib/group-store.js` module** — all group logic is inline in `backend-v2.js`.

- **Load**: `const groups = loadJsonSync('groups.json', {});` — `backend-v2.js:2650`
- **Save**: `function saveGroups() { saveJson('groups.json', groups); }` — `backend-v2.js:3101`

### 2.2 System Groups

The `info` group is auto-created at startup by `ensureInfoGroup()` (`backend-v2.js:3225-3228`). All registered agents are added to the `info` group automatically. This serves as the system-wide broadcast channel.

### 2.3 Group CRUD

All group mutations are protected by `requireBridgeSecret` auth (X-Bridge-Secret header). Read operations are unauthenticated.

| Operation | Route | Auth | SSE Event |
|-----------|-------|------|-----------|
| Create group | POST `/api/groups` | bridgeSecret | `group_created` |
| List groups | GET `/api/groups` | none | — |
| Get group | GET `/api/groups/:name` | none | — |
| Add members | POST `/api/groups/:name/members` `{add:[...]}` | bridgeSecret | `group_members` |
| Remove members | POST `/api/groups/:name/members` `{remove:[...]}` | bridgeSecret | `group_members` |
| Delete group | DELETE `/api/groups/:name` | bridgeSecret | — |

**Why bridgeSecret?** Group mutations originate from the Matrix bridge (room creation, membership changes) and are relayed to the backend via API. The bridge authenticates with a shared secret. This prevents arbitrary API callers from modifying group state.

### 2.4 Room-Group Mapping

The bridge maintains a bidirectional mapping between Matrix room IDs and group names:

```
roomGroupMap: { roomId → groupName }
groupRoomMap: { groupName → roomId }
```

- `mapRoom(roomId, groupName)` — establishes the mapping
- `groupForRoom(roomId)` — looks up group name for a room

These mappings are persisted in `data/matrix/bridge-state.json` and restored on bridge startup.

---

## 3. Room Lifecycle

### 3.1 Creation

```
                    ┌─────────────────────┐
                    │   Trigger Source     │
                    └─────┬───────────────┘
                          │
              ┌───────────┼───────────────┐
              │           │               │
         Matrix room   !mkgroup      POST /api/dm/ensure
         name event    bot cmd       (bearer auth)
              │           │               │
              ▼           ▼               ▼
         Bridge detects   Bridge calls   Backend emits
         room name        backend API    SSE dm_ensure
              │           │               │
              ▼           ▼               ▼
         Creates group    Creates group   Bridge calls
         in backend       + Matrix room   ensureDmRoom()
              │           │               │
              ▼           ▼               ▼
         Maps room ←──── Maps room       Stores in
         to group         to group        state.dmRooms
```

### 3.2 Joining

Agents join rooms through multiple paths:
- **Auto-join on registration**: New agents are added to the `info` group and invited to its Matrix room
- **Reconciliation**: `reconcileRoomGroupMembership()` syncs Matrix room membership with backend group membership
- **Bot command**: `!addmember` adds an agent to a group, triggering bridge to invite the agent puppet to the Matrix room
- **DM creation**: `ensureDmRoom()` auto-joins bot + target agent

### 3.3 Leaving

- **Bot command**: `!rmember` removes an agent from a group → bridge kicks puppet from Matrix room
- **Group deletion**: `DELETE /api/groups/:name` removes the group → bridge does not auto-kick (rooms persist as orphans)

### 3.4 Trust Classification

The bridge classifies rooms by trust level using `getRoomTrust()`:

```javascript
// bridge-matrix.js:1546-1561
this.botClient.on('room.invite', async (roomId, inviteEvent) => {
  const inviter = inviteEvent?.sender || null;
  const trust = getRoomTrust(roomId, { inviterMxid: inviter });
  if (!trust.trusted && MATRIX_TRUST_MODE === 'enforce') {
    await this.botClient.leaveRoom(roomId);  // reject untrusted
    return;
  }
  await this.botClient.joinRoom(roomId);
  if (trust.trusted) markRoomTrusted(roomId, { inviter });
});
```

Trust is determined by:
- Whether the room is in `trustedManagedRooms`
- Whether the inviter is a known operator (`MATRIX_OPERATOR_MXIDS`)
- `MATRIX_TRUST_MODE` setting: `enforce` rejects untrusted invites, other modes allow them

Trusted rooms are tracked in `state.trustedManagedRooms`.

### 3.5 Room Tombstone (Upgrade/Migration)

When a Matrix room is "tombstoned" (upgraded to a new room version), the bridge migrates all mappings to the replacement room (`bridge-matrix.js:2086-2124`):

```
Room tombstoned (m.room.tombstone event)
  → Extract replacement_room from event content
  → If room is in roomGroupMap:
      → Migrate group mapping to replacement room
  → If room is a DM room (in state.dmRooms):
      → Migrate DM mapping to replacement room
  → If room has avatar mapping:
      → Migrate avatar mapping to replacement room
  → Save updated state
```

### 3.6 Orphan Detection

Rooms become orphans when:
- A group is deleted but the Matrix room persists
- A room name is changed and the old mapping is removed
- The bridge state file is reset/corrupted

The periodic room scan (every 120s during bridge operation) detects joined rooms that have no mapping in `roomGroupMap` or `dmRooms`. These are logged but not automatically cleaned up.

---

## 4. Key Data Structures

### 4.1 Bridge State (`data/matrix/bridge-state.json`)

```json
{
  "botToken": "syt_...",
  "agentTokens": { "agentName": "syt_..." },
  "dmRooms": { "agentName": "!roomId:server" },
  "botDmRooms": { "agentName": "!roomId:server" },
  "roomGroupMap": { "!roomId:server": "groupName" },
  "groupRoomMap": { "groupName": "!roomId:server" },
  "trustedManagedRooms": { "!roomId:server": { "trusted": true, "inviter": "@user:server" } },
  "agentAvatars": { "agentName": "mxc://server/mediaId" },
  "roomAvatars": { "!roomId:server": "mxc://server/mediaId" }
}
```

### 4.2 dmRooms

**Type**: `Map<agentName, roomId>` (in-memory) / `Object<agentName, roomId>` (persisted)

Maps agent names to their DM room IDs. Also stores SPY room mappings under `spy:from↔to` keys.

- **Read**: Check if DM room exists for an agent before creating one
- **Write**: Set after `ensureDmRoom()` creates a new room
- **Migration**: Updated on room tombstone events

### 4.3 botDmRooms

**Type**: `Object<agentName, roomId>`

Maps agent names to bot-to-agent DM rooms (for bot commands sent directly to agents). Separate from operator DM rooms.

### 4.4 roomGroupMap / groupRoomMap

**Type**: `Object<roomId, groupName>` / `Object<groupName, roomId>`

Bidirectional mapping between Matrix rooms and backend groups. Maintained by `mapRoom()` and cleaned up on room rename/tombstone.

- `roomGroupMap` is the primary lookup (room → group) used when processing Matrix messages
- `groupRoomMap` is the reverse lookup (group → room) used when sending messages to a group's Matrix room

### 4.5 trustedManagedRooms

**Type**: `Object<roomId, { trusted: boolean, inviter: string }>`

Tracks which rooms are trusted (created by or invited by known operators). Used by `getRoomTrust()` to determine invite acceptance policy.

### 4.6 Backend Groups (`data/groups.json`)

See [Section 2.1](#21-data-model).

### 4.7 Cursors (`data/cursors.json`)

```json
{
  "agentName": {
    "inbox": 1711612345678,
    "inboxId": "msg_abc123",
    "groups": {
      "info": 1711612345678,
      "dev-team": 1711612300000
    },
    "groupIds": {
      "info": "msg_xyz789",
      "dev-team": "msg_def456"
    }
  }
}
```

See [Section 7](#7-cursor-system) for cursor mechanics.

---

## 5. Matrix Bridge Integration

### 5.1 Bridge Initialization Sequence

`bridge-matrix.js:1519-1618` — `start()` method:

```
 0. Wait for backend health check (5 retries, 2s delay)
 1. Ensure bot account exists, register trust-checked invite handler
 2. Ensure agent accounts for all known agents, prune stale tokens
 3. Set up bot commands (!groups, !mkgroup, !dm, !spy, etc.)
 4. Set up Matrix event listeners (room.message, room.event)
 5. Start bot sync (Matrix /sync long-polling)
 6. Connect SSE to backend (message, heartbeat, agent-status, dm_ensure events)
 7. Scan joined rooms → discover/restore room-group mappings
    → Backfill avatars for rooms missing them
    → Repeat room scan every 120s
 8. Poll for pending agent invites every 30s
 9. Poll for newly registered agents and humans
```

### 5.2 SSE Event Handling

The bridge subscribes to the backend's SSE stream and reacts to these events:

| SSE Event | Bridge Action |
|-----------|---------------|
| `message` | Relay message to appropriate Matrix room (DM or group) |
| `dm_ensure` | Call `ensureDmRoom()` to create DM room if needed |
| `group_created` | Create Matrix room for the new group if not already mapped |
| `group_members` | Trigger `reconcileRoomGroupMembership()` for the affected group |
| `heartbeat` | Update agent liveness tracking |
| `agent-status` | Update agent puppet presence in Matrix |

### 5.3 Reconciliation

`reconcileRoomGroupMembership()` (`bridge-matrix.js:2195-2218`) ensures Matrix room membership matches backend group membership:

```
For each group with a mapped Matrix room:
  1. Skip DM/SPY rooms (not subject to group reconciliation)
  2. Skip recently created rooms (grace period to avoid race conditions)
  3. Get Matrix room members (joined agents + humans)
  4. Get backend group members
  5. For members in backend but not in Matrix: invite puppet to room
  6. For members in Matrix but not in backend: (logged, not auto-kicked)
  7. Suspend reconciliation during backend failures
```

Reconciliation runs:
- On `group_members` SSE events
- On room rename events
- Periodically during room scan (every 120s)

### 5.4 Room Name Handling

`bridge-matrix.js:1985-2034` — When a `m.room.name` event is received:

1. **DM/SPY detection**: If name matches `DM: ...` or `SPY: ...`, skip group mapping
2. **New room**: If room has no existing group mapping, create group in backend and map room
3. **Rename**: If room already has a mapping, update `roomGroupMap`/`groupRoomMap` and trigger reconciliation

### 5.5 Message Relay: Matrix → Backend

When a message arrives in a Matrix room:
1. Bridge identifies the room type (DM, SPY, group) from mappings
2. For group rooms: POST message to backend with `group` field set
3. For DM rooms: POST message to backend as a DM to the agent
4. Message `source` is set to `"matrix"` to distinguish from API-originated messages

### 5.6 Message Relay: Backend → Matrix

When a message is posted via the backend API:
1. Backend broadcasts SSE `message` event
2. Bridge receives event, identifies target room(s)
3. Bridge sends message to Matrix room using the agent's puppet account
4. For group messages: sent to the group's mapped Matrix room
5. For DM messages: sent to the agent's DM room

---

## 6. API Routes

### 6.1 Group Management

| Method | Path | Auth | Description | Source |
|--------|------|------|-------------|--------|
| POST | `/api/groups` | bridgeSecret | Create a new group | `backend-v2.js:8127-8146` |
| GET | `/api/groups` | none | List all groups | `backend-v2.js:8148-8150` |
| GET | `/api/groups/:name` | none | Get single group (members, metadata) | `backend-v2.js:8152-8156` |
| POST | `/api/groups/:name/members` | bridgeSecret | Add/remove members `{add:[], remove:[]}` | `backend-v2.js:8158-8204` |
| DELETE | `/api/groups/:name` | bridgeSecret | Delete group | `backend-v2.js:8206-8211` |

### 6.2 DM Management

| Method | Path | Auth | Description | Source |
|--------|------|------|-------------|--------|
| POST | `/api/dm/ensure` | bearer | Trigger DM room creation for agent | `backend-v2.js:8214-8221` |
| GET | `/api/dm/:agent/history` | bearer | Get DM message history for agent | `backend-v2.js:8572-8591` |

### 6.3 Group Messages

| Method | Path | Auth | Description | Source |
|--------|------|------|-------------|--------|
| GET | `/api/groups/:name/messages` | none | Group messages with cursor-based read/unread | `backend-v2.js:8794-8862` |
| GET | `/api/agents/:name/groups` | none | List agent's groups with unread counts | `backend-v2.js:8865-8890` |

### 6.4 Message Operations

| Method | Path | Auth | Description | Source |
|--------|------|------|-------------|--------|
| POST | `/api/messages` | varies | Create message (with mention detection) | `backend-v2.js:8440-8570` |
| POST | `/api/messages/:id/suppress` | — | Suppress message delivery to specific agents | `backend-v2.js:8606-8635` |

### 6.5 Bot Commands (Matrix)

These commands are available in Matrix rooms and are handled by the bridge:

| Command | Description | ACL |
|---------|-------------|-----|
| `!groups` | List all groups | any |
| `!group <name>` | Show group details | any |
| `!mkgroup <name>` | Create a new group | operator |
| `!addmember <group> <agent>` | Add agent to group | operator |
| `!rmember <group> <agent>` | Remove agent from group | operator |
| `!rmgroup <name>` | Delete a group | operator |
| `!joingroup <name>` | Join a group (self) | operator |
| `!dm <agent>` | Create/open DM with agent | operator |
| `!spy <from> <to>` | Create SPY room for surveillance | operator |

---

## 7. Cursor System

The cursor system tracks per-agent, per-group read positions for unread message detection.

### 7.1 Data Model

```
cursors[agentName] = {
  inbox: <timestamp>,        // last-read inbox timestamp
  inboxId: <messageId>,      // last-read inbox message ID (tiebreaker)
  groups: {
    <groupName>: <timestamp> // last-read group timestamp
  },
  groupIds: {
    <groupName>: <messageId> // last-read group message ID (tiebreaker)
  }
}
```

Persisted in `data/cursors.json`.

### 7.2 Key Functions

All in `backend-v2.js:3581-3624`:

- **`ensureCursor(agentName)`** — Lazily initializes cursor structure for an agent. Normalizes missing fields.
- **`isAfterCursor(msg, ts, id)`** — Returns true if message is newer than the cursor position. Uses timestamp comparison with message ID as tiebreaker.
- **`getGroupCursor(cursor, groupName)`** — Returns `{ts, id}` for a specific group.
- **`advanceGroupCursor(cursor, groupName, unread)`** — Advances cursor to the last message in the unread array.
- **`advanceInboxCursor(cursor, unread)`** — Same for inbox cursor.

### 7.3 Advance Modes

When checking inbox/group messages via the API, the `advance` query parameter controls cursor behavior:

| Mode | Behavior |
|------|----------|
| `all` | Advance cursor past all returned messages |
| `delivered` | Advance cursor past messages marked as delivered |
| `none` | Do not advance cursor (peek) |

### 7.4 Message Ordering

`compareMsgOrder()` (`backend-v2.js:712-721`) establishes total ordering:
1. Compare by timestamp (`msg.ts`)
2. If timestamps equal, compare by sequence number extracted from message ID (`msgSeq()`)
3. If sequences equal, lexicographic comparison of message IDs

---

## 8. Message Delivery & Mentions

### 8.1 Mention Detection

When a message is created (`backend-v2.js:8440-8570`), mentions are extracted via two methods:
1. **Explicit mentions list**: `mentions` field in the POST body
2. **`@name` regex scan**: Scans message body for `@agentName` patterns

### 8.2 Delivery Warnings

The message creation endpoint generates warnings for:
- **Offline agents**: Mentioned agents not currently connected
- **Unknown agents**: Mentioned names not in the agent registry
- **Out-of-group mentions**: Mentioned agents not in the target group

### 8.3 Message Suppression

`isSuppressedForAgent(msg, agentName)` (`backend-v2.js:3310`) checks the `msg.suppressedRecipients` array. Suppressed messages are excluded from an agent's inbox/group views.

POST `/api/messages/:id/suppress` adds agent names to the suppression list after delivery.

### 8.4 Message Summary Format

`summarizeMsg()` (`backend-v2.js:3484-3499`) produces the canonical message representation returned by all read APIs:

```json
{
  "id": "msg_abc123",
  "from": "ac-builder",
  "type": "text",
  "priority": "normal",
  "summary": "Short summary",
  "full": "Full message body...",
  "mentions": ["ac-researcher"],
  "attachments": [],
  "ts": 1711612345678,
  "at": "2026-03-28T09:00:00.000Z",
  "time": "2 minutes ago",
  "reply_to": null,
  "group": "dev-team",
  "source": "api"
}
```

---

## Appendix: SSE Events Reference (Group/Room Related)

| Event | Payload | Emitted When |
|-------|---------|--------------|
| `group_created` | `{ name, members, createdAt }` | New group created via API |
| `group_members` | `{ name, members, added, removed }` | Group membership changed |
| `dm_ensure` | `{ agent }` | DM room creation requested |
| `message` | Full message object | Any message posted (DM or group) |
