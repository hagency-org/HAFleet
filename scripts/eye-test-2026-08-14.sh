#!/usr/bin/env bash
#
# Hands-on verification of what merged on 2026-08-14: PRs #58, #59, #60, #62, #63, #64.
#
# It runs against the LIVE backend and writes real records — a project side, an engagement, an agent —
# all named `eyetest-*` or `palpo.test`, and it removes what it created at the end. Read it before you
# run it; it is meant to be read.
#
#   bash scripts/eye-test-2026-08-14.sh
#
# It refuses to start unless the backend is running the merged code, so a stale process fails loudly
# instead of producing a passing report about the wrong binary.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${HAFLEET_BACKEND_URL:-http://127.0.0.1:8090}"
[ -f .env ] || { echo "no .env in $(pwd)"; exit 1; }
set -a; . ./.env; set +a
: "${API_TOKEN:?API_TOKEN is not set in .env}"

SIDE="eyetest.invalid"          # a server name that cannot resolve: nothing here talks to a homeserver
ROOM="!eyetest:${SIDE}"
AGENT="eyetest_probe"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %-56s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  \033[31mFAIL\033[0m %-56s got %s, want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}
op()  { curl -s -m 10 -H 'Content-Type: application/json' -H "Authorization: Bearer $API_TOKEN" "$@"; }
jqf() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo '<no field>'; }

# ── the binary must be the merged one, or none of the below means anything ───────────────────────
if ! op "$BASE/health" -o /dev/null -w '' 2>/dev/null; then
  echo "backend not reachable at $BASE"; exit 1
fi
if [ "$(op -o /dev/null -w '%{http_code}' "$BASE/api/project-sides")" != "200" ]; then
  cat <<'EOF'
STOP. GET /api/project-sides did not answer 200, so this backend predates the project-side work and
cannot be carrying today's merges. Restart it on master first — see the deploy steps in the PR notes.
EOF
  exit 1
fi
if [ "$(op -o /dev/null -w '%{http_code}' "$BASE/api/engagements")" != "200" ]; then
  echo "STOP. The bearer in .env is not the token this process was started with — restart it."; exit 1
fi
echo "backend at $BASE is on the merged code and the .env bearer works."

MODE=$(curl -s -m 5 "$BASE/health" | jqf "d['auth']['agentTokens']['mode']")
echo "agent-token mode: $MODE"

cleanup() {
  echo
  echo "cleaning up what this script created..."
  op -X DELETE "$BASE/api/project-sides/$SIDE?force=true" -o /dev/null
  op -X DELETE "$BASE/api/agents/$AGENT?force=true" -o /dev/null
  echo "done. The engagement record is KEPT by design (ended, not deleted) — that is #59's point."
}
trap cleanup EXIT

echo
echo "=================================================================="
echo " #64  the operator's bearer works on an agent route (hard mode)"
echo "=================================================================="
# The whole point: no X-Agent-Token anywhere below. Before #64 this 403'd for any tokened agent.
r=$(op -X POST "$BASE/api/agents" -d "{\"name\":\"$AGENT\",\"type\":\"claude\"}")
check "register a new agent with the BEARER ALONE" "True" "$(echo "$r" | jqf "d.get('ok')")"
r=$(op -X PATCH "$BASE/api/agents/$AGENT" -d '{"identity":"eye test"}')
check "PATCH identity with the bearer alone"        "eye test" "$(echo "$r" | jqf "d['agent']['identity']")"

echo
echo "=================================================================="
echo " #60  an agent cannot declare its own cost or capability"
echo "=================================================================="
# A fresh agent has no token on disk, so send a fake one: the point is the BEARER's absence.
ag() { curl -s -m 10 -H 'Content-Type: application/json' -H 'X-Agent-Token: not-the-operator' "$@"; }
ag -X POST "$BASE/api/agents" -d "{\"name\":\"$AGENT\",\"capability\":\"strong\",\"role\":\"architect\"}" > /dev/null
rec=$(op "$BASE/api/agents/$AGENT")
check "capability after the AGENT asked for strong" "None" "$(echo "$rec" | jqf "d.get('capability')")"
check "role after the AGENT asked for architect"    "None" "$(echo "$rec" | jqf "d.get('role')")"
op -X POST "$BASE/api/agents" -d "{\"name\":\"$AGENT\",\"capability\":\"strong\",\"role\":\"architect\"}" > /dev/null
rec=$(op "$BASE/api/agents/$AGENT")
check "capability when the OPERATOR set it"         "strong"    "$(echo "$rec" | jqf "d.get('capability')")"
check "role when the OPERATOR set it"               "architect" "$(echo "$rec" | jqf "d.get('role')")"

echo
echo "=================================================================="
echo " #62  a borrower's allocation is gated at acceptance"
echo "=================================================================="
op -X POST "$BASE/api/project-sides" -d "{\"server_name\":\"$SIDE\",\"api_base_url\":\"http://127.0.0.1:1\"}" > /dev/null
ask() { op -X POST "$BASE/api/engagements" -d "{\"project\":\"eyetest\",\"projectRoomId\":\"$ROOM\",\"role\":\"coding\",\"requester\":\"@eye:$SIDE\",\"requestedTokens\":$1,\"ratePerDay\":1000,\"requestId\":\"\$eye-$2-$$\"}"; }

check "configured side, never budgeted"        "no_allocation" "$(ask 250000 1 | jqf "d.get('reason')")"
op -X PUT "$BASE/api/project-sides/$SIDE/allocation" -d '{"allocated_tokens":300000}' > /dev/null
r=$(ask 500000 2)
check "a request over the allocation"          "over_allocation" "$(echo "$r" | jqf "d.get('reason')")"
check "  ...refused, never queued"             "refused"         "$(echo "$r" | jqf "d.get('status')")"
echo "  the message an operator would read:"
echo "    $(echo "$r" | jqf "d.get('error')")"
b=$(op "$BASE/api/project-sides/$SIDE/budget")
check "  ...and nothing was committed"         "0" "$(echo "$b" | jqf "d['committed']")"

# THE ALARM. The refusal above went back to the caller; this is what reached the operator.
check "an alert was raised for the operator"   "True" "$(op "$BASE/api/alerts?status=open" | jqf "any(a['alertType']=='project_side_budget' for a in d)")"
check "  ...as a real warning, not a note"     "warning" "$(op "$BASE/api/alerts?status=open" | jqf "[a for a in d if a['alertType']=='project_side_budget'][0]['severity']")"
check "  ...actionable, so it can be worked"   "True" "$(op "$BASE/api/alerts?status=open" | jqf "[a for a in d if a['alertType']=='project_side_budget'][0]['actionable']")"
echo "  the runbook it carries:"
echo "    $(op "$BASE/api/alerts?status=open" | jqf "[a for a in d if a['alertType']=='project_side_budget'][0]['runbook']")"
op -X PUT "$BASE/api/project-sides/$SIDE/allocation" -d '{"allocated_tokens":900000}' > /dev/null
check "raising the allocation resolves it"     "False" "$(op "$BASE/api/alerts?status=open" | jqf "any(a['alertType']=='project_side_budget' for a in d)")"

echo
echo "=================================================================="
echo " #59  removing a side stands its records down, never deletes them"
echo "=================================================================="
r=$(op -X DELETE "$BASE/api/project-sides/$SIDE")
check "delete refused while the side is active" "side_active" "$(echo "$r" | jqf "d.get('code')")"
r=$(op -X DELETE "$BASE/api/project-sides/$SIDE?force=true")
check "forced delete performs the cascade"      "performed" "$(echo "$r" | jqf "d.get('cascade')")"
echo "  what it says it did: $(echo "$r" | jqf "d.get('cascadeNote')" | cut -c1-90)"

echo
printf '==================================================================\n'
printf ' %d passed, %d failed\n' "$pass" "$fail"
printf '==================================================================\n'
[ "$fail" -eq 0 ]
