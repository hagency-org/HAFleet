#!/usr/bin/env bash
# Write build-info.json so a built artifact carries its own identity.
#
# Generated standalone packages have no .git, so `git rev-parse` returns nothing
# and the runtime reported no version at all. This stamps release + revision at
# build time; lib/version.js prefers the stamp and falls back to the checkout.
#
# Usage: stamp-version.sh [TARGET_DIR] [--channel CHANNEL] [--release VERSION]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_DIR="$REPO_ROOT"
CHANNEL="dev"
RELEASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --release) RELEASE="${2:?--release requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '2,9p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TARGET_DIR="$1"; shift ;;
  esac
done

[ -d "$TARGET_DIR" ] || { echo "target directory does not exist: $TARGET_DIR" >&2; exit 1; }

if [ -z "$RELEASE" ]; then
  RELEASE="$(node -e 'process.stdout.write(require("./package.json").version || "")' 2>/dev/null || true)"
fi
[ -n "$RELEASE" ] || { echo "could not determine release version" >&2; exit 1; }

# Strip a leading v so tag-driven builds and package.json agree.
RELEASE="${RELEASE#v}"

REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")"
[ -n "$REVISION" ] || REVISION="unknown"

# Reproducibility: honour SOURCE_DATE_EPOCH, else the commit date, else now.
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
  BUILT_AT="$(date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
else
  # date-format-local with TZ=UTC keeps this UTC on both GNU and BSD date.
  BUILT_AT="$(TZ=UTC git -C "$REPO_ROOT" log -1 \
    --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd 2>/dev/null || true)"
  [ -n "$BUILT_AT" ] || BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

OUT="$TARGET_DIR/build-info.json"
cat > "$OUT" <<EOF
{
  "release": "$RELEASE",
  "revision": "$REVISION",
  "builtAt": "$BUILT_AT",
  "channel": "$CHANNEL"
}
EOF

echo "Stamped $OUT -> $RELEASE ($REVISION, $CHANNEL)"
