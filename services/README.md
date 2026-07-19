# Agent Chat Supervised Services

The local profile manages `backend`, `dashboard`, `bridge`, and `relay` under
one detached supervisor. Use an existing writable runtime directory:

```bash
set -a; . ./.env; set +a  # neither script below auto-loads .env — source it first
export AGENT_CHAT_RUNTIME_DIR="$PWD"
node services/agentchat-services.mjs start
node services/agentchat-services.mjs status
node services/agentchat-services.mjs doctor
node services/agentchat-services.mjs stop
```

Add `--json` to `status` or `doctor` for structured output. Runtime state and
logs are written below `data/services-local/`. A failed `status` or `doctor`
returns exit code 1 and names each unhealthy service.

## Two doctors: process-level vs. business-level

`agentchat-services.mjs doctor` (above) is **process-level**: it answers "is each
service's PID alive and passing its configured TCP/HTTP/process probe". That is
necessary but not sufficient — a bridge process can be alive and still not be
syncing with Matrix; a relay process can be alive and still not be delivering to
any agent.

`services/standalone-doctor.mjs` is the **business-level** cross-component gate.
It checks:

1. Palpo (`MATRIX_HOMESERVER`) responds on `/_matrix/client/versions`.
2. The agent-chat backend responds healthy on `/health`.
3. The dashboard's TCP/HTTP probe (reusing `agentchat-services.mjs`'s own check).
4. The four-service supervisor status (reusing `agentchat-services.mjs`'s own check).
5. Freshness of the bridge and relay's self-reported business-health records
   (`data/health/matrix-bridge.json`, `data/health/push-relay.json` under the
   runtime root — written atomically at 0600 by `bridge-matrix.js` /
   `push-relay.js`; schema and the redaction guard that keeps them free of
   tokens/passwords/message bodies/the bridge secret live in
   `src/health-record.mjs`).
6. The bridge's companion bot **and** every agent in `MATRIX_ACCEPTANCE_AGENTS`
   are joined to `MATRIX_ACCEPTANCE_ROOM_ID`, using the bridge's own
   self-reported membership summary (the doctor never holds Matrix credentials
   itself).
7. `AGENTCHAT_AGENT_TOKEN_MODE` is `hard` and every managed agent's token is
   loaded, via the backend `/health` response's `auth.agentTokens`.

**Operator note — record freshness (check 5) is not membership freshness (check
6):** `bridge-matrix.js` rewrites `data/health/matrix-bridge.json` on its own
`BRIDGE_HEALTH_WRITE_INTERVAL_MS` timer (default 30s), so `generatedAt` — and
therefore check 5 — can be seconds old even when nothing about the room
membership has changed. The `requiredMembership` data *inside* that same
record is only as current as the bridge's last joined-room scan, which runs on
`MATRIX_ROOM_SCAN_POLL_MS` (default 120s, floor 30s). A green check 5 proves
the bridge process is alive and writing; it does not prove check 6 was
evaluated against membership state newer than the last scan, which can lag by
up to that poll interval (longer if a Matrix rate-limit cooldown skipped a
round). If you need a tighter bound on membership staleness specifically,
tune `MATRIX_ROOM_SCAN_POLL_MS` rather than the health-record thresholds.

```bash
set -a; . ./.env; set +a  # the doctor reads MATRIX_HOMESERVER, MATRIX_ACCEPTANCE_*, etc. directly
export AGENT_CHAT_RUNTIME_DIR="$PWD"
node services/standalone-doctor.mjs
node services/standalone-doctor.mjs --json
```

`MATRIX_ACCEPTANCE_ROOM_ID` / `MATRIX_ACCEPTANCE_AGENTS` are optional — see
`.env.example`. When `MATRIX_ACCEPTANCE_ROOM_ID` is unset, check 6 reports
`not_configured` and the doctor still exits non-zero (fail closed) unless run
with `--allow-unconfigured-room`, which is meant for bootstrapping before that
room exists yet — it should not be part of a normal production check. Freshness
thresholds (`BRIDGE_HEALTH_MAX_AGE_MS`, `RELAY_HEALTH_MAX_AGE_MS`) and the
bridge/relay's own record-write cadence (`BRIDGE_HEALTH_WRITE_INTERVAL_MS`,
`PUSH_RELAY_HEALTH_WRITE_INTERVAL_MS`) are also documented there.

**Operator note — `MATRIX_ACCEPTANCE_AGENTS` must name the actual wake
target(s):** check 6 only proves that the agents you list are joined to the
room; it says nothing about agents you didn't list. An un-addressed group
message's default recipient is decided by `pickDefaultGroupRecipient()`
(`bridge-matrix.js`), which falls back to `wf_coordinator` when the room maps
to a single agent. If that default-wake agent is left out of
`MATRIX_ACCEPTANCE_AGENTS`, a green doctor run gives no signal that this path
— a human's default-wake message actually reaching an agent — still works.
Include `wf_coordinator` (or whichever agent your rooms actually wake)
explicitly, not just whatever happens to be convenient to list.

## Standalone trust configuration

Before pointing the bridge at real Matrix rooms, five settings define the
trust boundary between agent-chat and the outside Matrix world. `.env.example`
ships safe defaults for all five; a fresh `.env` only needs
`MATRIX_BRIDGE_SECRET` and `MATRIX_TRUSTED_INVITER_MXIDS` filled in.

1. **Bridge secret** (`MATRIX_BRIDGE_SECRET`) — non-empty, and the *same*
   value loaded by both `backend-v2.js` and `bridge-matrix.js`: start both
   processes from the same sourced environment, since neither one reads
   `.env` itself (nothing in this repo auto-loads it — every `start`/`status`/
   `doctor`/`stop` invocation must source it first, as in the command blocks
   above). Fails closed two ways: the bridge process refuses to `start()` with
   no secret to send (`bridge-matrix.js`), and the backend rejects
   `source: "matrix"` ingestion on `/api/messages` — 503 if its own secret is
   unset, 401 if the request's `X-Bridge-Secret` is missing or wrong
   (`backend-v2.js`). Covered by `tests/bridge-matrix.test.js` ("start()
   rejects immediately when MATRIX_BRIDGE_SECRET is unset"),
   `tests/api-messages.test.js` ("Matrix ingestion fails closed when bridge
   secret or event id is missing"), and `tests/api-provenance.test.js`
   ("wrong bridge secret rejects senderMxid + trustLevel", "missing bridge
   secret header rejects when MATRIX_BRIDGE_SECRET is set").
2. **Agent token mode** (`AGENTCHAT_AGENT_TOKEN_MODE=hard`) — see check 7
   above; a missing managed-agent token flips backend `/health` — and the
   doctor's `authAndTokenIntegrity` check — to degraded instead of silently
   letting the agent through. Covered by `tests/api-agent-token.test.js`
   ("health reports missing managed agent tokens without flipping hard-mode
   compatibility") and `tests/standalone-doctor.test.js` ("fails when hard
   mode is configured but a managed agent token is missing").
3. **Matrix trust mode** (`MATRIX_TRUST_MODE=enforce`) — the code default is
   `audit` (dev/CI only: logs untrusted rooms but does not block them); every
   real deployment, and `.env.example`, ship `enforce`, which actively rejects
   invites and messages from untrusted rooms/inviters. See
   `docs/architecture/auth-trust-model.md` §6.
4. **Trusted inviters** (`MATRIX_TRUSTED_INVITER_MXIDS`) — comma-separated
   Matrix IDs allowed to invite the bridge bot into a room; an invite from
   anyone else is auto-rejected (bot leaves the room) under `enforce`. Covered
   by `tests/fsf0-b2-matrix-routing.test.js` ("trusted_inviter_allowed",
   "untrusted_inviter_denied", "allowlisted_room_untrusted_inviter_denied")
   and the classifier-level `tests/room-trust.test.js`.
5. **Ignored senders** (`MATRIX_IGNORED_SENDER_MXIDS`) — comma-separated
   Matrix IDs whose messages the bridge drops before they ever reach an agent
   inbox; use it for other loop-causing appservice bots sharing a room. The
   bridge's own bot account and puppeted agent accounts are excluded from
   routing automatically and do not need to be listed. Covered by
   `tests/fsf0-b2-matrix-routing.test.js` ("ignored_sender_not_routed") and
   `tests/bridge-matrix.test.js` ("onRoomMessage skips configured external
   Matrix bot senders").

For the four-service team deployment, provide an operator-owned environment
file containing the existing Agent Chat and Matrix settings:

```bash
AGENTCHAT_ENV_FILE=/absolute/path/to/agent-chat.env \
  docker compose -f services/services-team.compose.yml up -d --build
docker compose -f services/services-team.compose.yml ps
docker compose -f services/services-team.compose.yml down
```

The environment file must define the same non-empty `MATRIX_BRIDGE_SECRET` for
the backend and bridge. Matrix ingestion fails closed without it; generate a
secret with `openssl rand -hex 32`.

The Compose profile uses host networking because the existing backend and
dashboard bind to `127.0.0.1`. The bridge also uses the host PID namespace so
its persisted owner record can distinguish a restarted container from the old
process. The Docker runtime must support host networking and host PID mode.
The shared named volume persists the registry and Matrix state. The bridge is
serialized with a kernel-held `flock`, so a crashed container cannot retain its
ownership lock across restart.
