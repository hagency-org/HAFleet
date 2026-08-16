#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

js_count=0
shell_count=0

echo "Checking JavaScript syntax..."
while IFS= read -r file; do
  [ -n "$file" ] || continue
  node --check "$file" >/dev/null
  js_count=$((js_count + 1))
done < <(git ls-files '*.js' | sort)
echo "[OK] JavaScript syntax: $js_count file(s)"

echo "Checking shell and node executable syntax..."
# `bin/*` is a directory of EXECUTABLES, not a directory of shell scripts. Checking every one with
# `bash -n` worked only while they all happened to be shell: the first Node entrypoint added there
# (bin/hafleet-supervisor) failed with "syntax error near unexpected token (" on a perfectly valid
# `const`. The shebang says which parser a file wants, and it is the only thing that does — an
# extension would not, since these are extensionless on purpose so operators type `hafleet-x` and not
# `hafleet-x.sh`.
node_bin_count=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  if head -1 "$file" | grep -qE '^#!.*(node|bun|deno)'; then
    node --check "$file"
    node_bin_count=$((node_bin_count + 1))
  else
    bash -n "$file"
    shell_count=$((shell_count + 1))
  fi
done < <(git ls-files 'bin/*' 'remote/bin/*' 'scripts/*.sh' 'remote/install-remote.sh' 'remote/*.sh' '*.sh' | sort -u)
echo "[OK] Shell syntax: $shell_count file(s); node executables: $node_bin_count file(s)"

echo "Syntax check passed."
