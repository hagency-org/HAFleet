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
