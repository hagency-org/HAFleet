#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cat >&2 <<'NOTICE'
install-v2.sh is deprecated and kept only for compatibility.
Use install-full.sh for fresh-machine and reinstall workflows.
NOTICE

exec "$SCRIPT_DIR/install-full.sh" "$@"
