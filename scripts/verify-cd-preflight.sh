#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_CI=true
ALLOW_DIRTY=false
EXPECT_BRANCH="${AGENTCHAT_DEPLOY_BRANCH:-}"

usage() {
  cat <<'EOF'
Usage: scripts/verify-cd-preflight.sh [options]

Non-destructive CD preflight for a candidate checkout.

Options:
  --branch <name>   Require the current branch to match <name>
  --skip-ci         Skip npm run verify:ci and only print metadata
  --allow-dirty     Allow a dirty worktree
  -h, --help        Show this help

This script does not fetch, reset, pull, install dependencies, restart services,
or write service configuration.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)
      EXPECT_BRANCH="${2:-}"
      shift 2
      ;;
    --skip-ci)
      RUN_CI=false
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: missing required command: $1" >&2
    exit 1
  fi
}

need_cmd git
need_cmd npm

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git worktree" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
commit="$(git rev-parse HEAD)"
short_commit="$(git rev-parse --short HEAD)"
dirty="$(git status --porcelain)"

echo "== cd preflight target =="
echo "branch: $branch"
echo "commit: $short_commit ($commit)"
if [ -n "$EXPECT_BRANCH" ] && [ "$branch" != "$EXPECT_BRANCH" ]; then
  echo "Error: expected branch '$EXPECT_BRANCH', got '$branch'" >&2
  exit 1
fi
if [ -n "$dirty" ]; then
  echo "dirty: yes"
  if [ "$ALLOW_DIRTY" != true ]; then
    echo "Error: dirty worktree; commit or discard changes before CD preflight" >&2
    git status --short >&2
    exit 1
  fi
else
  echo "dirty: no"
fi

if [ "$RUN_CI" = true ]; then
  echo "== source/package gate =="
  npm run verify:ci
else
  echo "== source/package gate =="
  echo "skipped (--skip-ci)"
fi

echo "== post-deploy verification hint =="
verify_cmd="agentchat verify-remote --samples 2 --interval 16 --expect-version $short_commit"
if [ -n "${AGENT_CHAT_API:-}" ]; then
  verify_cmd="$verify_cmd --api ${AGENT_CHAT_API%/}"
fi
if [ -n "${AGENT_CHAT_SERVER:-}" ]; then
  verify_cmd="$verify_cmd --server $AGENT_CHAT_SERVER"
fi
if [ -n "${VERIFY_AGENT:-}" ]; then
  verify_cmd="$verify_cmd --agent $VERIFY_AGENT"
fi
echo "$verify_cmd"
if [ -n "${API_TOKEN:-}" ]; then
  echo "API_TOKEN: set (not printed)"
fi

echo "CD preflight passed for $short_commit."
