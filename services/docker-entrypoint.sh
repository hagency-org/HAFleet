#!/bin/sh
# Entrypoint for the HAFleet service image.
#
# The image previously had no ENTRYPOINT or CMD, so `docker run <image>` did
# nothing and it only worked when compose supplied an explicit `command:`.
# This makes the image self-describing while staying backward compatible with
# the existing compose profiles.
#
#   docker run <image>                 -> usage
#   docker run <image> backend         -> node backend-v2.js
#   docker run <image> dashboard       -> node server.js
#   docker run <image> relay           -> node push-relay.js
#   docker run <image> bridge          -> services/run-bridge-container.sh
#   docker run <image> node server.js  -> passed straight through (legacy compose)
set -eu

usage() {
  cat <<'EOF'
HAFleet service image.

Usage: docker run [opts] <image> <role|command>

Roles:
  backend     Central API and SSE stream (default port 8090)
  dashboard   Web dashboard (default port 8084)
  relay       Push relay. Needs host tmux access; see docs/DEPLOYMENT.md
  bridge      Matrix bridge. Requires Matrix credentials in the environment
  doctor      Run the standalone health checks and exit
  version     Print build identity and exit

Any other argument is executed verbatim, so `node backend-v2.js` still works.
EOF
}

# AGENTCHAT_ROLE is exported so the image HEALTHCHECK knows what to probe.
role_exec() {
  AGENTCHAT_ROLE="$1"
  export AGENTCHAT_ROLE
  shift
  exec "$@"
}

case "${1:-}" in
  ''|-h|--help|help)
    usage
    [ -z "${1:-}" ] && exit 1
    exit 0
    ;;
  backend)   role_exec backend   node backend-v2.js ;;
  dashboard) role_exec dashboard node server.js ;;
  relay)     role_exec relay     node push-relay.js ;;
  bridge)    role_exec bridge    services/run-bridge-container.sh ;;
  doctor)    exec node services/standalone-doctor.mjs ;;
  version)
    exec node -e 'import("./lib/version.js").then(m=>console.log(m.formatBuildIdentity()))'
    ;;
  *)
    # Legacy / explicit form: run whatever was asked.
    exec "$@"
    ;;
esac
