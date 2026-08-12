# Agentchat Authentication & Trust Model

> **已移除(2026-08-12)**:本文提到的「潜意识 / subconscious」子系统已整体删除,详见
> `knowledge/decisions/adr-015-remove-subconscious-memory-subsystem.md`。以下描述保留为当时的记录。


Date: 2026-03-28
Scope: backend-v2.js, bridge-matrix.js, mcp-server-core.js, bot-commands.js, provisioning scripts
Author: ac-researcher (task 5.35)

---

## Overview

Agentchat uses a layered authentication and trust system with three distinct credential tiers, a trust-level classification for message senders, and a room-trust boundary system for Matrix integration. Each tier protects a different surface and has independent configuration.

```
┌─────────────────────────────────────────────────────────────┐
│                     Request Sources                         │
│                                                             │
│  Dashboard/API ──► Bearer Token (API_TOKEN)                 │
│  Agent (MCP)   ──► Bearer Token + Per-Agent Token           │
│  Bridge        ──► Bridge Secret + Bearer Token             │
│  Localhost      ──► Bypass (no token required)              │
│  Subconscious  ──► Subconscious Event Token OR localhost    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Trust Classification                      │
│                                                             │
│  Matrix sender ──► operator (MATRIX_OPERATOR_MXIDS)         │
│                ──► external (any other Matrix user)          │
│  Non-Matrix    ──► null (API, internal, localhost)           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Room Trust (Bridge)                        │
│                                                             │
│  MATRIX_TRUSTED_ROOM_IDS  ──► allowlist (always trusted)    │
│  trustedManagedRooms      ──► managed (auto-seeded)         │
│  MATRIX_TRUSTED_INVITER_MXIDS ──► trusted_inviter           │
│  fallback                 ──► unknown_room (untrusted)      │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Bearer Token Authentication

### Purpose

Protects the REST API (`/api/*` routes) from unauthorized external access. Used by the dashboard, CLI tools, and any HTTP client calling backend-v2 endpoints.

### Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `API_TOKEN` | No (but strongly recommended) | Shared secret for API access. If unset, all `/api/*` routes are open. |

### How It Works

The global `/api` middleware (`backend-v2.js:6050-6061`) runs on every request to `/api/*`:

```javascript
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();                          // no token configured → open access
  const ip = req.ip || req.connection?.remoteAddress;
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();  // localhost bypass
  // subconscious event token exception (see §5)
  if (req.method === 'POST' && apiPath.endsWith('/subconscious/events')
      && SUBCONSCIOUS_EVENT_TOKEN && auth === `Bearer ${SUBCONSCIOUS_EVENT_TOKEN}`) {
    return next();
  }
  if (auth === `Bearer ${API_TOKEN}`) return next();      // valid bearer → allow
  return res.status(401).json({ error: 'unauthorized' }); // reject
});
```

### Key Behaviors

- **Localhost bypass**: Requests from `127.0.0.1`, `::1`, or `::ffff:127.0.0.1` skip bearer validation entirely. This allows local agents and tools to call the API without tokens.
- **No token = open**: If `API_TOKEN` is not set in the environment, all API routes are accessible without authentication.
- **Header format**: `Authorization: Bearer <token>` — standard HTTP bearer scheme.
- **Token parsing** (`backend-v2.js:2389-2397`): Extracts the token from the `Authorization` header using regex `/^Bearer\s+(.+)$/i`, trimmed and capped at 512 characters via `normalizeOptionalText()`.

### Where Used

- Dashboard HTTP requests (server.js → backend-v2.js)
- Bridge-matrix API calls (sends both bridge secret and bearer token)
- MCP server API calls (sends both bearer and per-agent token)
- CLI tools (`hafleet-send`, `hafleet-audit`, etc.)

### Additional Bearer-Protected Route

Some routes use the stricter `requireBearer` middleware (`backend-v2.js:2434-2437`) which rejects even localhost if the token doesn't match:

```javascript
function requireBearer(req, res, next) {
  const expectedToken = normalizeOptionalText(process.env.API_TOKEN, 512);
  if (expectedToken && getBearerToken(req) !== expectedToken) {
    return res.status(401).json({ error: 'bearer token required' });
  }
  next();
}
```

This is used on sensitive endpoints where localhost bypass would be inappropriate.

---

## 2. Per-Agent Token Authentication (X-Agent-Token)

### Purpose

Prevents agent impersonation. Each provisioned agent receives a unique cryptographic token at creation time. When an agent sends a message or calls an API endpoint that identifies a specific agent, the backend verifies the token matches the agent's registered credential.

### Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HAFLEET_AGENT_TOKEN_MODE` | No | `hard` | Enforcement mode: `hard`, `soft`, or `audit` |

### Token Generation

Tokens are generated once at provisioning time and never rotated automatically.

**Primary provisioning** (`scripts/provision-v1-agent-home.js:626-630`):
```javascript
const token = crypto.randomBytes(32).toString('hex');  // 64-char hex string
writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
```

**Supervisor-provisioned agents** (`lib/supervisor-provisioning.js:49-55`): Same mechanism — `randomBytes(32).toString('hex')`, mode `0o600`.

Token is stored at: `<homeDir>/agents/agent_<name>/state/agent-token`

### Token Loading

At backend startup, `loadAgentTokens()` (`backend-v2.js:175-194`) scans all agent home roots:

```javascript
const agentTokens = new Map();  // agentName → token string

function loadAgentTokens() {
  for (const homeRoot of allAgentHomeRoots()) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.name.startsWith('agent_')) continue;
      const name = entry.name.slice('agent_'.length);
      if (agentTokens.has(name)) continue;  // first home root wins
      const token = readFileSync(tokenPath, 'utf-8').trim();
      if (token) agentTokens.set(name, token);
    }
  }
}
```

- Tokens are loaded into an in-memory `Map<agentName, tokenString>`.
- If multiple home roots exist, the first root containing a token for a given agent wins.
- Missing token files are silently skipped — agents without tokens are treated as unmanaged.

### Enforcement Modes

The `HAFLEET_AGENT_TOKEN_MODE` variable (`backend-v2.js:163-167`) controls what happens when a token check fails:

| Mode | Behavior on Failure | Use Case |
|------|---------------------|----------|
| `hard` (default) | 403 Forbidden, request rejected | Production — full enforcement |
| `soft` | 403 Forbidden, request rejected | Same as hard (reserved for future differentiation) |
| `audit` | Warning logged, request allowed through | Migration/debugging — see who would fail |

### Verification Logic

`checkAgentToken()` (`backend-v2.js:196-204`):

```javascript
function checkAgentToken(agentName, req) {
  if (!agentName) return { ok: true };                    // no agent context → skip
  const expected = agentTokens.get(agentName);
  if (!expected) return { ok: true };                     // unmanaged agent → allow
  const provided = (req.headers['x-agent-token'] || '').trim();
  if (!provided) return { ok: false, reason: 'token required but not provided' };
  if (provided !== expected) return { ok: false, reason: 'token mismatch' };
  return { ok: true };
}
```

Key behavior:
- **No agent name in request** → passes (not an agent-scoped call)
- **Agent has no registered token** → passes (unmanaged/legacy agent)
- **Token missing from request** → fails with "token required but not provided"
- **Token doesn't match** → fails with "token mismatch"
- **Token matches** → passes

The `requireAgentToken(extractAgent)` middleware (`backend-v2.js:206-220`) wraps this into Express middleware, using the enforcement mode to decide whether to reject or log-and-continue.

### How Agents Send Tokens

**MCP server** (`lib/mcp-server-core.js:66-70`): Each agent's MCP process loads its token from `$HAFLEET_AGENT_STATE_DIR/agent-token` at startup.

**Dual-auth API calls** (`lib/mcp-server-core.js:77-95`): MCP sends both headers on every backend call:
```javascript
async function api(method, path, body) {
  const headers = {};
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  if (AGENT_TOKEN) headers['X-Agent-Token'] = AGENT_TOKEN;
  // ...
}
```

This dual-auth pattern ensures the request passes both the global bearer middleware and per-agent token verification.

### Protected Endpoints

The `requireAgentToken()` middleware is applied to endpoints where the caller asserts an agent identity — primarily message-send and agent-status endpoints. The agent name is extracted from the request (path parameter or body field) and checked against the token map.

---

## 3. Bridge Secret Authentication (X-Bridge-Secret)

### Purpose

Authenticates the Matrix bridge (bridge-matrix.js) when it calls backend-v2 APIs. This is a shared secret between the bridge process and the backend, separate from the bearer token, providing defense-in-depth for bridge-specific endpoints.

### Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_BRIDGE_SECRET` | No | Shared secret for bridge authentication. If unset, bridge-auth checks are skipped. |

### Backend Middleware

`requireBridgeSecret()` (`backend-v2.js:153-162`):

```javascript
function getBridgeSecret() {
  return (process.env.MATRIX_BRIDGE_SECRET || '').trim();
}

function requireBridgeSecret(req, res, next) {
  const secret = getBridgeSecret();
  if (secret && req.headers['x-bridge-secret'] !== secret) {
    return res.status(403).json({ error: 'bridge secret required' });
  }
  next();
}
```

- If `MATRIX_BRIDGE_SECRET` is not configured, the middleware passes all requests (no enforcement).
- If configured, requests without a matching `X-Bridge-Secret` header are rejected with 403.

### Bridge-Side Usage

The bridge sends its secret on every backend API call (`bridge-matrix.js:823-851`):

```javascript
const MATRIX_BRIDGE_SECRET = (process.env.MATRIX_BRIDGE_SECRET || '').trim();
const BRIDGE_API_TOKEN = (process.env.API_TOKEN || '').trim();

async function backendApi(method, path, body, contextLabel = '') {
  const opts = { method, headers: {} };
  if (MATRIX_BRIDGE_SECRET) opts.headers['X-Bridge-Secret'] = MATRIX_BRIDGE_SECRET;
  if (BRIDGE_API_TOKEN) opts.headers['Authorization'] = `Bearer ${BRIDGE_API_TOKEN}`;
  // ...
}
```

The bridge sends **both** the bridge secret and the bearer token, passing both auth layers.

### Role in Trust Level Derivation

The bridge secret also gates trust-level information. When the backend receives a message with `source: "matrix"`, it only extracts the sender's Matrix ID (and thus derives trust level) if the bridge secret is valid (`backend-v2.js:8334-8339`):

```javascript
const isBridgeAuthenticated = !bridgeSecret || req.headers['x-bridge-secret'] === bridgeSecret;
const senderMxid = isBridgeAuthenticated && sourceType === 'matrix'
  && typeof sender_mxid === 'string' && /^@[^:]+:.+/.test(sender_mxid.trim())
  ? sender_mxid.trim().slice(0, 255) : null;
```

If the bridge secret is wrong, `senderMxid` is set to `null`, which means no trust level is derived — the message is treated as coming from an untrusted non-Matrix source.

---

## 4. Trust Levels

### Purpose

Trust levels classify message senders to control what agents see and what actions are authorized. They are derived server-side in backend-v2 and never trusted from the caller.

### Classification

| Level | Meaning | Derived From |
|-------|---------|--------------|
| `operator` | Platform operator with full control | Sender's Matrix ID is in `MATRIX_OPERATOR_MXIDS` |
| `external` | Known Matrix user, not an operator | Sender has a valid Matrix ID but is not in `MATRIX_OPERATOR_MXIDS` |
| `null` | Non-Matrix source or unauthenticated bridge | API calls, localhost requests, or bridge-secret mismatch |

### Configuration

| Variable | Description |
|----------|-------------|
| `MATRIX_OPERATOR_MXIDS` | Comma-separated list of Matrix IDs (e.g., `@alice:matrix.org,@bob:matrix.org`) |
| `MATRIX_ADMIN_MXIDS` | Comma-separated list of admin Matrix IDs (used by bot-commands.js, superset of operator privileges) |

### Derivation Logic

Trust level is derived at message ingestion time in backend-v2.js (`lines 8334-8339`):

1. Check if the bridge secret is valid (or unconfigured)
2. Check if `sourceType === 'matrix'` and `sender_mxid` is a valid Matrix ID format (`@user:server`)
3. If valid: look up the MXID in `MATRIX_OPERATOR_MXIDS` → `operator` or `external`
4. If not valid (wrong bridge secret, non-Matrix source, invalid MXID): → `null`

**The trust level is NEVER accepted from the request payload.** It is always computed server-side from the authenticated bridge identity and the sender's MXID.

### How Trust Levels Affect Behavior

**Message visibility**: Trust level is stored with each message and can be used by agents and the dashboard to distinguish operator commands from external user messages.

**Bot command authorization** (`lib/bot-commands.js:20-46`): Matrix bot commands have a 4-tier ACL:

| Tier | Access | Examples |
|------|--------|----------|
| 0 | Public — any Matrix user | `!help`, `!status` |
| 1 | Operator — read-only management | `!agents`, `!groups` |
| 2 | Operator — management actions | `!hafleet-up`, `!hafleet-down` |
| 3 | Admin only (`MATRIX_ADMIN_MXIDS`) | System-level commands |

Authorization check (`bot-commands.js:40-46`):
```javascript
function authorizeCommand(senderMxid, tier) {
  if (MATRIX_ADMIN_MXIDS.has(senderMxid)) return true;          // admin bypasses all
  if (tier <= 2 && MATRIX_OPERATOR_MXIDS.has(senderMxid)) return true;  // operator up to tier 2
  if (tier === 0) return true;                                    // public commands
  return false;
}
```

**Agent CLAUDE.md policy**: The External Message Policy in agent CLAUDE.md files instructs agents to treat `trustLevel: "operator"` messages as authoritative directives, while `source: "matrix"` messages without operator trust are treated as user input that must not override agent instructions.

---

## 5. Subconscious Event Token

### Purpose

Authenticates remote Claude hook event ingestion. The subconscious system captures hook events (SessionStart, UserPromptSubmit, PreToolUse, Stop) from agent Claude Code sessions and posts them to the backend. When agents run on remote servers, this token authenticates those posts.

### Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `HAFLEET_SUBCONSCIOUS_EVENT_TOKEN` | No | Token for remote subconscious event ingestion. If unset, only localhost can post events. |

### Authorization Logic

`authorizeSubconsciousEventIngest()` (`backend-v2.js:2404-2412`):

```javascript
function authorizeSubconsciousEventIngest(req) {
  if (isLocalRequest(req)) return { ok: true, mode: 'local' };
  const expectedToken = normalizeOptionalText(process.env.HAFLEET_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (!expectedToken) return { ok: false, status: 403, error: '...local-only...', mode: 'local-only' };
  const providedToken = getBearerToken(req);
  if (providedToken === expectedToken) return { ok: true, mode: 'token' };
  return { ok: false, status: 401, error: 'invalid subconscious event token', mode: 'token-required' };
}
```

- **Localhost**: Always allowed, no token needed.
- **Remote + no token configured**: Rejected (403) — subconscious events are local-only by default.
- **Remote + token configured**: Must provide `Authorization: Bearer <HAFLEET_SUBCONSCIOUS_EVENT_TOKEN>`.

The global `/api` middleware also has a special exception for this endpoint (`backend-v2.js:6056-6058`), allowing the subconscious event token to pass even if it doesn't match `API_TOKEN`.

---

## 6. Room Trust System (Matrix Bridge)

### Purpose

Controls which Matrix rooms the bridge interacts with. Prevents the bot from being dragged into untrusted rooms where it could leak agent communications or be exploited.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MATRIX_TRUST_MODE` | `audit` | `audit` = log untrusted rooms but allow interaction; `enforce` = block untrusted rooms |
| `MATRIX_TRUSTED_ROOM_IDS` | (empty) | Comma-separated room IDs that are always trusted |
| `MATRIX_TRUSTED_INVITER_MXIDS` | (empty) | Matrix IDs whose invites are auto-trusted |
| `MATRIX_OPERATOR_MXIDS` | (empty) | Operators (used for trust level + room trust decisions) |

### Room Trust Classifier

`getRoomTrust()` (`bridge-matrix.js:892-898`) evaluates rooms in priority order:

```javascript
function getRoomTrust(roomId, { inviterMxid = null } = {}) {
  if (MATRIX_TRUSTED_ROOM_IDS.has(roomId))              return { trusted: true, reason: 'allowlist' };
  if (state.trustedManagedRooms?.[roomId])               return { trusted: true, reason: 'managed' };
  if (inviterMxid && MATRIX_TRUSTED_INVITER_MXIDS.has(inviterMxid))
                                                          return { trusted: true, reason: 'trusted_inviter' };
  return { trusted: false, reason: 'unknown_room' };
}
```

| Priority | Source | Reason Tag | Description |
|----------|--------|------------|-------------|
| 1 | `MATRIX_TRUSTED_ROOM_IDS` env var | `allowlist` | Manually configured trusted rooms |
| 2 | `state.trustedManagedRooms` | `managed` | Rooms created/managed by hafleet |
| 3 | `MATRIX_TRUSTED_INVITER_MXIDS` env var | `trusted_inviter` | Room invited by a trusted user |
| 4 | Fallback | `unknown_room` | Not trusted by any criterion |

### trustedManagedRooms Seeding

On bridge startup, `trustedManagedRooms` is auto-populated from existing state (`bridge-matrix.js:217-241`):

1. **roomGroupMap**: All rooms mapped to hafleet groups are seeded as managed
2. **dmRooms**: All DM rooms between operators and agents are seeded
3. **botDmRooms**: All bot-DM rooms are seeded (re-checked on every startup for upgrades)

New rooms created by the bridge (group rooms, DM rooms) are marked trusted via `markRoomTrusted()` at creation time.

### Trust Mode Enforcement

**`audit` mode** (default): Untrusted rooms are logged but interaction proceeds normally. Log format:
```
[trust:audit] <action> room=<roomId> UNTRUSTED reason=unknown_room
```

**`enforce` mode**: Untrusted rooms are actively blocked:

- **Invite handling** (`bridge-matrix.js:1546-1561`): Bot rejects invites from untrusted rooms (auto-leave).
- **Message ingress** (`bridge-matrix.js:1849-1854`): Messages from untrusted rooms are dropped silently.
- **Periodic audit** (`scanJoinedRooms()`, `bridge-matrix.js:2127-2179`): Scans all joined rooms, auto-leaves untrusted ones in enforce mode.
- **Agent invite polling** (`bridge-matrix.js:2334-2357`): Agent puppet invites to untrusted rooms are rejected.

### Room Trust Logging

All trust decisions are logged via `roomTrustLog()` (`bridge-matrix.js:908-912`):
```javascript
function roomTrustLog(action, roomId, trust, extra = '') {
  const tag = trust.trusted ? 'TRUSTED' : 'UNTRUSTED';
  console.log(`[trust:${MATRIX_TRUST_MODE}] ${action} room=${roomId} ${tag} reason=${trust.reason}${detail}`);
}
```

---

## 7. Environment Variable Reference

### Authentication Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `API_TOKEN` | backend-v2, bridge-matrix, mcp-server-core, server.js | Global bearer token for API access |
| `MATRIX_BRIDGE_SECRET` | backend-v2, bridge-matrix | Shared secret for bridge ↔ backend auth |
| `HAFLEET_AGENT_TOKEN_MODE` | backend-v2 | Per-agent token enforcement: `hard` / `soft` / `audit` |
| `HAFLEET_SUBCONSCIOUS_EVENT_TOKEN` | backend-v2 | Remote subconscious event ingestion token |

### Trust Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `MATRIX_OPERATOR_MXIDS` | backend-v2, bridge-matrix, bot-commands | Comma-separated operator Matrix IDs |
| `MATRIX_ADMIN_MXIDS` | bot-commands | Comma-separated admin Matrix IDs (superset of operator) |
| `MATRIX_TRUST_MODE` | bridge-matrix | Room trust enforcement: `audit` / `enforce` |
| `MATRIX_TRUSTED_ROOM_IDS` | bridge-matrix | Comma-separated always-trusted room IDs |
| `MATRIX_TRUSTED_INVITER_MXIDS` | bridge-matrix | Comma-separated Matrix IDs whose invites auto-trust |

---

## 8. Security Considerations

### Credential Storage

- **Bearer token** (`API_TOKEN`): Environment variable, shared across services. Not rotated automatically.
- **Per-agent tokens**: Filesystem (`state/agent-token`), mode `0o600`, one per agent. Generated once at provisioning. No automatic rotation.
- **Bridge secret**: Environment variable, shared between bridge and backend. Not rotated automatically.

### Attack Surface

| Threat | Mitigation | Residual Risk |
|--------|------------|---------------|
| Agent impersonation | Per-agent tokens (X-Agent-Token) | Token compromise allows impersonation until manual rotation |
| Unauthorized API access | Bearer token + localhost bypass | Localhost bypass means any local process can call the API |
| Bridge spoofing | Bridge secret (X-Bridge-Secret) | If secret leaks, attacker can inject messages with arbitrary trust levels |
| Untrusted Matrix rooms | Room trust classifier + enforce mode | In audit mode (default), untrusted rooms are logged but not blocked |
| Trust level injection | Server-side derivation only | Trust level cannot be set by callers — always computed from authenticated bridge identity |

### Localhost Bypass Implications

The global `/api` middleware allows all localhost requests without bearer token. This means:
- Any process on the same host can call any API endpoint
- Per-agent token checks still apply (separate middleware layer)
- In a multi-tenant environment, this bypass could be a concern

### Token Rotation

No automatic rotation exists for any credential tier. To rotate:
- **API_TOKEN**: Update `.env`, restart all services
- **Per-agent tokens**: Overwrite `state/agent-token` file, restart backend (to reload token map)
- **Bridge secret**: Update in both backend and bridge `.env`, restart both services
