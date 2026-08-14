#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/agentchat-router-build.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

cd "$REPO_ROOT"
npx tsc -p tsconfig.router.json --outDir "$TMP_ROOT/dist"

if ! /usr/bin/diff -ru router/dist "$TMP_ROOT/dist"; then
  echo "router/dist is stale; run npm run build:router" >&2
  exit 1
fi
