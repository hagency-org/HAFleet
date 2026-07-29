#!/usr/bin/env bash
# Build the full-stack release tarball.
#
# The release workflow previously published only the REMOTE RELAY package, so
# the remote profile was installable from a checksummed artifact while the main
# install had no artifact at all and could only be git-cloned. This closes that
# asymmetry.
#
# Contents come from `git archive`, i.e. exactly the tracked files at a ref —
# never the working tree, so uncommitted edits can't leak into a release. Then
# build-info.json is stamped in so the unpacked tree knows its own identity
# (it has no .git).
#
# Usage:
#   scripts/build-release-package.sh                    # HEAD -> dist/
#   scripts/build-release-package.sh --ref v1.3.0
#   scripts/build-release-package.sh --out-dir /tmp/x --channel release
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REF="HEAD"
OUT_DIR="$ROOT_DIR/dist"
CHANNEL="release"
RELEASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)     REF="${2:?--ref requires a value}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?--out-dir requires a value}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --release) RELEASE="${2:?--release requires a value}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT_DIR"

if [ -z "$RELEASE" ]; then
  RELEASE="$(node -e 'process.stdout.write(require("./package.json").version||"")')"
fi
RELEASE="${RELEASE#v}"
[ -n "$RELEASE" ] || { echo "could not determine release version" >&2; exit 1; }

REVISION="$(git rev-parse --short "$REF")"
NAME="hafleet-${RELEASE}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Tracked files only, at the requested ref.
mkdir -p "$STAGE/$NAME"
git archive --format=tar "$REF" | tar -x -C "$STAGE/$NAME"

# Strip what a deployed host never needs. Kept deliberately: docs/ (AGENTS.md
# and CLAUDE.md are symlinks into it) and tests/ (a host can then run its own
# verify gates, which is how the CD release gate works).
rm -rf "$STAGE/$NAME/.github" "$STAGE/$NAME/blog"

"$SCRIPT_DIR/stamp-version.sh" "$STAGE/$NAME" --channel "$CHANNEL" --release "$RELEASE" >/dev/null
echo "Stamped: $(tr -d '\n ' < "$STAGE/$NAME/build-info.json")"

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/${NAME}.tar.gz"
MTIME="$(git log -1 --format=%cI "$REF")"

# Reproducibility needs GNU tar: --sort, --owner/--group and --mtime are GNU
# extensions that bsdtar (the default on macOS) rejects outright. CI runs GNU
# tar, so releases are byte-reproducible; a local build on macOS still produces
# a correct tarball, just not a bit-identical one, and says so.
GNU_TAR=""
for candidate in gtar tar; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version 2>/dev/null | head -1 | grep -q GNU; then
    GNU_TAR="$candidate"
    break
  fi
done

if [ -n "$GNU_TAR" ]; then
  "$GNU_TAR" --sort=name \
      --owner=0 --group=0 --numeric-owner \
      --mtime="$MTIME" \
      -czf "$TARBALL" -C "$STAGE" "$NAME"
  REPRODUCIBLE=yes
else
  echo "WARNING: GNU tar not found (bsdtar cannot do --sort/--mtime)." >&2
  echo "         Building a correct but NOT byte-reproducible tarball." >&2
  echo "         Install GNU tar for reproducible local builds: brew install gnu-tar" >&2
  tar -czf "$TARBALL" -C "$STAGE" "$NAME"
  REPRODUCIBLE=no
fi

echo "Built $TARBALL"
echo "  release:  $RELEASE"
echo "  revision: $REVISION"
echo "  size:     $(du -h "$TARBALL" | cut -f1)"
echo "  entries:  $(tar -tzf "$TARBALL" | wc -l | tr -d ' ')"
echo "  reproducible: $REPRODUCIBLE"
