#!/bin/sh
# Role-aware container healthcheck.
#
# One image serves four roles, so a single fixed probe cannot work. The
# entrypoint exports AGENTCHAT_ROLE; this probes accordingly. Roles with no
# meaningful endpoint (relay, bridge) report healthy if their process is the
# container's PID 1, which is all a container-level check can honestly assert.
set -eu

backend_port="${AGENT_CHAT_BACKEND_PORT:-8090}"
web_port="${AGENT_CHAT_WEB_PORT:-8084}"

probe() {
  node -e "
    fetch('$1')
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  "
}

case "${AGENTCHAT_ROLE:-}" in
  backend)   probe "http://127.0.0.1:${backend_port}/health" ;;
  dashboard) probe "http://127.0.0.1:${web_port}/" ;;
  relay|bridge)
    # No HTTP surface. Liveness of PID 1 is the honest limit here; the
    # authoritative check is services/standalone-doctor.mjs, which inspects
    # health-record freshness from outside the container.
    kill -0 1 2>/dev/null || exit 1
    ;;
  *)
    # Unknown or unset role: do not claim health we cannot verify.
    exit 1
    ;;
esac
