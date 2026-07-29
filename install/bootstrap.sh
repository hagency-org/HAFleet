#!/usr/bin/env bash
# HAFleet bootstrap installer.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/hagency-org/HAFleet/master/install/bootstrap.sh)
#
# Clones the repository at a pinned release and hands off to install-full.sh.
# This exists because the only documented install path was "git clone, then run
# the installer" — and the README pointed at the upstream repository, so
# following it did not produce HAFleet.
#
# Everything after `--` is forwarded to install-full.sh, so its flags all work:
#   bash <(curl -fsSL .../bootstrap.sh) -- --dry-run
#   bash <(curl -fsSL .../bootstrap.sh) --ref v1.2.0 -- --with-bridge
#
# Options:
#   --ref REF     Tag, branch or commit to install (default: latest release tag)
#   --dir PATH    Where to clone (default: ~/hafleet)
#   --list        List available releases and exit
#   --no-install  Clone and stop, without running the installer
set -euo pipefail

REPO_URL="${HAFLEET_REPO_URL:-https://github.com/hagency-org/HAFleet.git}"
TARGET_DIR="${HAFLEET_DIR:-$HOME/hafleet}"
REQUESTED_REF="${HAFLEET_REF:-}"
DO_LIST=false
RUN_INSTALLER=true
INSTALLER_ARGS=()

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REQUESTED_REF="${2:?--ref requires a value}"; shift 2 ;;
    --dir) TARGET_DIR="${2:?--dir requires a value}"; shift 2 ;;
    --list) DO_LIST=true; shift ;;
    --no-install) RUN_INSTALLER=false; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --) shift; INSTALLER_ARGS=("$@"); break ;;
    *) die "unknown option: $1 (pass installer flags after --)" ;;
  esac
done

for cmd in git curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done

# --- Resolve the ref ---------------------------------------------------------
# Default to the newest release tag rather than a branch tip, so a bootstrap
# install is reproducible.
resolve_latest_tag() {
  git ls-remote --tags --refs "$REPO_URL" 'v[0-9]*' 2>/dev/null \
    | awk '{print $2}' | sed 's#refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1,1V -k2,2V -k3,3V \
    | tail -1
}

if [ "$DO_LIST" = true ]; then
  log "Releases in $REPO_URL:"
  git ls-remote --tags --refs "$REPO_URL" 'v[0-9]*' 2>/dev/null \
    | awk '{print $2}' | sed 's#refs/tags/##' \
    | sort -t. -k1,1V -k2,2V -k3,3V | tail -20 | sed 's/^/  /'
  exit 0
fi

if [ -z "$REQUESTED_REF" ]; then
  REQUESTED_REF="$(resolve_latest_tag || true)"
  if [ -n "$REQUESTED_REF" ]; then
    log "Latest release: $REQUESTED_REF"
  else
    # No tags published yet. Say so plainly rather than silently installing a
    # moving branch tip.
    REQUESTED_REF="master"
    log "WARNING: no release tags found; falling back to '$REQUESTED_REF'."
    log "         This is a moving target, not a pinned release."
  fi
fi

# --- Fetch: release tarball preferred, git clone as fallback -----------------
# A checksummed release artifact is better than a clone: no git dependency, no
# 20MB of history, and the contents are exactly what CI built and published.
# Falls back to cloning when installing a branch/commit, or when the release has
# no attached artifact (anything tagged before this existed).
RELEASE_BASE="${HAFLEET_RELEASE_BASE:-}"
if [ -z "$RELEASE_BASE" ]; then
  # Derive the releases URL from the clone URL so a fork works unchanged.
  RELEASE_BASE="$(printf '%s' "$REPO_URL" | sed -e 's|\.git$||')/releases/download"
fi

fetch_release_tarball() {
  # Only semver tags have artifacts; branches and SHAs must be cloned.
  case "$REQUESTED_REF" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) return 1 ;;
  esac

  local release="${REQUESTED_REF#v}"
  local tarball="hafleet-${release}.tar.gz"
  local base="$RELEASE_BASE/$REQUESTED_REF"
  local work
  work="$(mktemp -d)"

  log "Fetching release artifact $tarball"
  if ! curl -fsSL --retry 2 -o "$work/$tarball" "$base/$tarball"; then
    log "No release artifact for $REQUESTED_REF; falling back to git clone."
    rm -rf "$work"; return 1
  fi

  # Verify against the published SHA256SUMS. A missing checksum file is a hard
  # failure, not a warning: silently installing unverified bytes is worse than
  # cloning.
  if ! curl -fsSL --retry 2 -o "$work/SHA256SUMS" "$base/SHA256SUMS"; then
    log "ERROR: $tarball published without SHA256SUMS; refusing to use it."
    rm -rf "$work"; return 1
  fi

  local expected actual
  expected="$(awk -v f="$tarball" '$2 ~ f {print $1}' "$work/SHA256SUMS" | head -1)"
  if [ -z "$expected" ]; then
    log "ERROR: SHA256SUMS has no entry for $tarball; refusing to use it."
    rm -rf "$work"; return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$work/$tarball" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$work/$tarball" | awk '{print $1}')"
  fi
  if [ "$expected" != "$actual" ]; then
    log "ERROR: checksum mismatch for $tarball"
    log "  expected $expected"
    log "  actual   $actual"
    rm -rf "$work"
    exit 1   # a mismatch is tampering or corruption; never fall back silently
  fi
  log "Checksum verified."

  if [ -e "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR/.git" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    log "ERROR: $TARGET_DIR is not empty and is not a git checkout; use --dir"
    rm -rf "$work"; exit 1
  fi

  tar -xzf "$work/$tarball" -C "$work"
  mkdir -p "$TARGET_DIR"
  # The tarball has a single hafleet-<release>/ top level.
  ( cd "$work/hafleet-${release}" && tar -cf - . ) | ( cd "$TARGET_DIR" && tar -xf - )
  rm -rf "$work"

  FETCH_MODE="release-artifact"
  return 0
}

FETCH_MODE=""
# Sets FETCH_MODE on success; returns non-zero to mean "clone instead". A
# checksum mismatch exits outright rather than returning, so it never degrades
# into a silent clone.
fetch_release_tarball || true

if [ -n "$FETCH_MODE" ]; then
  : # already unpacked from the verified artifact
elif [ -e "$TARGET_DIR" ]; then
  if [ -d "$TARGET_DIR/.git" ]; then
    log "Existing checkout at $TARGET_DIR; fetching $REQUESTED_REF"
    git -C "$TARGET_DIR" fetch --tags --prune origin \
      || die "fetch failed in $TARGET_DIR"
    [ -z "$(git -C "$TARGET_DIR" status --porcelain)" ] \
      || die "$TARGET_DIR has local changes; commit, stash or use --dir"
    git -C "$TARGET_DIR" -c advice.detachedHead=false checkout --force "$REQUESTED_REF" \
      || die "cannot check out '$REQUESTED_REF'"
  else
    die "$TARGET_DIR exists and is not a git checkout; use --dir"
  fi
else
  log "Cloning $REPO_URL into $TARGET_DIR"
  git clone --quiet "$REPO_URL" "$TARGET_DIR" || die "clone failed"
  git -C "$TARGET_DIR" -c advice.detachedHead=false checkout --force "$REQUESTED_REF" \
    || die "cannot check out '$REQUESTED_REF'"
fi

# A tarball install has no .git, so read identity from the stamp instead.
if [ -n "$FETCH_MODE" ]; then
  INSTALLED_REF="$(sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$TARGET_DIR/build-info.json" 2>/dev/null || true)"
  log "Installed $REQUESTED_REF (${INSTALLED_REF:-unknown}) from verified release artifact"
else
  INSTALLED_REF="$(git -C "$TARGET_DIR" rev-parse --short HEAD)"
  log "Checked out $REQUESTED_REF ($INSTALLED_REF) from git"
fi

# --- Hand off ----------------------------------------------------------------
if [ "$RUN_INSTALLER" = false ]; then
  log "Skipping installer (--no-install). Next:"
  log "  cd $TARGET_DIR && ./install-full.sh"
  exit 0
fi

[ -x "$TARGET_DIR/install-full.sh" ] || die "install-full.sh missing or not executable in $TARGET_DIR"

if [ "$(uname -s)" != "Linux" ]; then
  log "This host is $(uname -s). install-full.sh supports Linux only."
  log "See docs/DEPLOYMENT.md for the container and remote-relay options."
  log "Clone is ready at $TARGET_DIR."
  exit 1
fi

log "Running install-full.sh ${INSTALLER_ARGS[*]:-}"
cd "$TARGET_DIR"
exec ./install-full.sh "${INSTALLER_ARGS[@]:-}"
