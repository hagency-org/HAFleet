# Agent Chat Supervised Services

The local profile manages `backend`, `dashboard`, `bridge`, and `relay` under
one detached supervisor. Use an existing writable runtime directory:

```bash
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

```bash
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
