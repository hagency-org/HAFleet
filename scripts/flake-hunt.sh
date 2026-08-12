#!/bin/bash
# Flake forensics: run the full suite K times and keep EVERY failure's complete output.
#
# The intermittent-failure investigation stalled for ~25 observations because each one kept
# only the failing test's TITLE — the assertion diff, the response body, the child stderr all
# scrolled away, so every occurrence was an anecdote instead of a specimen. This preserves
# them. Findings from its first deployment are in docs/TESTING.md under "The specimen round".
#
#   scripts/flake-hunt.sh [K] [outdir]
#
# Green runs are deleted; a run with failures keeps its full log plus an extracted specimen.
# Run it on an otherwise QUIET machine: concurrent vitest/mutation work in another terminal
# adds load that changes the failure rate you are trying to measure.
set -u
cd "$(dirname "$0")/.." || exit 1
K="${1:-5}"
OUT="${2:-/tmp/hafleet-flake-specimens}"
mkdir -p "$OUT"
for i in $(seq 1 "$K"); do
  log="$OUT/run-$i.log"
  npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "$log"
  summary=$(grep -E "^ *Tests " "$log" | tail -1)
  fails=$(grep -cE "^ FAIL " "$log")
  echo "run $i: $summary  (FAIL lines: $fails)"
  if [ "$fails" -gt 0 ]; then
    grep -n -A 40 "Failed Tests" "$log" | head -160 > "$OUT/specimen-$i.txt"
    echo "  specimen saved: $OUT/specimen-$i.txt"
  else
    rm -f "$log"
  fi
done
echo "done: $K runs, specimens (if any) in $OUT"
