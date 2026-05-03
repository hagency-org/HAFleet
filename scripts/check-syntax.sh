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

echo "Checking shell syntax..."
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  bash -n "$file"
  shell_count=$((shell_count + 1))
done < <(git ls-files 'bin/*' 'remote/bin/*' 'scripts/*.sh' 'remote/install-remote.sh' 'remote/*.sh' '*.sh' | sort -u)
echo "[OK] Shell syntax: $shell_count file(s)"

echo "Syntax check passed."
