#!/usr/bin/env bash
#
# The whole sequence from an empty fleet to a human's Matrix message reaching a group, as one script.
#
# WHY IT EXISTS. Walking this by hand on a clean fleet took an afternoon, and most of that was not
# debugging — it was discovering which field name each step wanted. `allocation` is `allocatedTokens`;
# `ceiling` is `{tokens, period}`; a verdict is `{approve, allocatedTokens}` and not `{verdict}`;
# engagements need `project`, `requester` and `requestedTokens` as well as the obvious three. Every one of
# those was found by sending a request and reading the refusal.
#
# A refusal that names the missing field is good design and it is still a round trip. This script is the
# knowledge from those round trips, so the next person spends their afternoon on whatever is actually
# broken.
#
# WHAT IT PROVES, and it is the sequence rather than any single call: an agent can be created, given a
# model, bound to a customer, minted an identity on that customer's homeserver, engaged against a budget,
# and then actually reached by a human talking in a Matrix room. Any of those steps passing alone means
# nothing — the failure this repeatedly produces is a chain where every link works and the chain does not.
#
# IT REFUSES TO GUESS A FLEET. `HAFLEET_RUNTIME_DIR` is required, because these calls create agents and
# commit budget, and doing that to a fleet the operator did not mean is worse than not running.

set -euo pipefail

RUNTIME="${HAFLEET_RUNTIME_DIR:-}"
IF_AVAILABLE=false
[[ "${1:-}" == "--if-available" ]] && IF_AVAILABLE=true

skip() {
  if $IF_AVAILABLE; then
    echo "verify-agent-e2e: SKIPPED — $1"
    exit 0
  fi
  echo "verify-agent-e2e: $1" >&2
  exit 2
}

[[ -n "$RUNTIME" ]] || skip "HAFLEET_RUNTIME_DIR is required. These calls create agents and commit budget; guessing which fleet would be worse than not running."
[[ -f "$RUNTIME/.env" ]] || skip "no .env at $RUNTIME"

# shellcheck disable=SC1090
set -a; . "$RUNTIME/.env"; set +a

BACKEND="http://127.0.0.1:${HAFLEET_BACKEND_PORT:-8090}"
T="${API_TOKEN:-}"
BS="${MATRIX_BRIDGE_SECRET:-}"
SIDE="${VERIFY_SIDE:-${MATRIX_SERVER_NAME:-}}"
HS="${MATRIX_HOMESERVER:-http://127.0.0.1:8008}"

[[ -n "$T" ]] || skip "API_TOKEN is unset in the runtime .env"
curl -sf -o /dev/null "$BACKEND/health" 2>/dev/null || skip "no backend at $BACKEND"
[[ -n "$SIDE" ]] || skip "no project side to test against (set VERIFY_SIDE)"

# A name per run, so a re-run does not collide with the last one's agent.
STAMP="$(date +%s)"
AGENT="e2e-probe-$STAMP"
GROUP="e2e-group-$STAMP"

pass=0; fail=0
ok()   { echo "  ok    $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
api()  { curl -s -X "$1" "$BACKEND$2" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
apib() { curl -s -X "$1" "$BACKEND$2" -H "Authorization: Bearer $T" -H "x-bridge-secret: $BS" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
# Read one field out of a JSON response by dotted path.
#
# A first version used `eval` on an interpolated subscript expression and swallowed every error with
# `2>/dev/null || true` — so a malformed response, a missing key and a genuine failure all produced an
# empty string, and the script reported eight failures that were entirely its own parsing. It also
# reported one "ok" whose value was empty, which is what gave it away. No eval, and errors are visible.
jqf() {
  python3 -c '
import sys, json
path = sys.argv[1].split(".")
try:
    node = json.load(sys.stdin)
except Exception as exc:
    print(f"<unparseable response: {exc}>")
    sys.exit(0)
for key in path:
    if not key:
        continue
    if isinstance(node, dict) and key in node:
        node = node[key]
    else:
        print("")
        sys.exit(0)
print("" if node is None else node)
' "$1"
}

cleanup() {
  api DELETE "/api/agents/$AGENT?force=true" >/dev/null 2>&1 || true
  [[ -n "${PRESET_ID:-}" ]] && api DELETE "/api/framework-presets/$PRESET_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "verify-agent-e2e: side=$SIDE backend=$BACKEND"
echo ""

# ── 1. the agent, and the model it needs before any role will accept it ──────
api POST /api/agents "{\"name\":\"$AGENT\",\"role\":\"documentation\",\"identity\":\"e2e probe\"}" >/dev/null
[[ "$(api GET "/api/agents/$AGENT" | jqf name)" == "$AGENT" ]] \
  && ok "the agent exists" || bad "the agent was not created"

# `ceiling` is an OBJECT. A number is accepted and dropped, and the failure appears three steps later as
# "cannot allocate against an agent with no declared ceiling" — pointing at the budget, not at the preset.
PRESET_ID="$(api POST /api/framework-presets \
  "{\"name\":\"e2e-$STAMP\",\"framework\":\"claude\",\"model\":\"claude-sonnet-5\",\"ceiling\":{\"tokens\":500000,\"period\":\"monthly\"}}" \
  | jqf preset.id)"
[[ -n "$PRESET_ID" ]] && ok "a preset with a ceiling exists" || bad "the preset was not created"

api PUT "/api/agents/$AGENT/preset" "{\"presetId\":\"$PRESET_ID\"}" >/dev/null
[[ -n "$(api GET "/api/agents/$AGENT" | jqf presetId)" ]] \
  && ok "the agent has a model, so a role can qualify it" || bad "the preset did not attach"

# ── 2. the binding this script was written for ───────────────────────────────
BIND="$(api PUT "/api/agents/$AGENT/project-side" "{\"projectSide\":\"$SIDE\"}")"
[[ "$(echo "$BIND" | jqf agent.projectSide)" == "$SIDE" ]] \
  && ok "the agent is bound to $SIDE" || bad "the binding did not take"

# The refusal that has to keep working: an agent must not choose its own employer.
PATCHED="$(curl -s -X PATCH "$BACKEND/api/agents/$AGENT" -H 'Content-Type: application/json' \
  -d "{\"projectSide\":\"$SIDE\"}")"
[[ "$(echo "$PATCHED" | jqf code)" == "project_side_not_settable_here" ]] \
  && ok "PATCH refuses projectSide instead of ignoring it" || bad "PATCH did not refuse projectSide"

# ── 3. the identity, on the customer's homeserver ────────────────────────────
IDENT="$(api POST "/api/agents/$AGENT/matrix-identity" '{}')"
MXID="$(echo "$IDENT" | jqf mxid)"
[[ -n "$MXID" ]] && ok "an identity was minted: $MXID" \
  || bad "minting failed: $(echo "$IDENT" | jqf error | cut -c1-90)"

# ── 4. the budget, whose field name is not `allocation` ──────────────────────
api PUT "/api/project-sides/$SIDE/allocation" '{"allocatedTokens":1000000}' >/dev/null
ALLOC="$(api GET "/api/project-sides/$SIDE/budget" | jqf allocated)"
[[ "$ALLOC" != "None" && -n "$ALLOC" ]] \
  && ok "the side has an allocation ($ALLOC)" || bad "the allocation did not persist"

# ── 5. the engagement, which needs five fields rather than three ─────────────
ROOM="${VERIFY_ROOM:-}"
if [[ -z "$ROOM" ]]; then
  echo "  ..    no VERIFY_ROOM given, so the engagement and Matrix legs are skipped"
else
  EID="$(api POST /api/engagements \
    "{\"agent\":\"$AGENT\",\"role\":\"documentation\",\"project\":\"e2e\",\"requester\":\"@hafleet:$SIDE\",\"requestedTokens\":50000,\"projectRoomId\":\"$ROOM\"}" \
    | jqf engagement.id)"
  [[ -n "$EID" ]] && ok "an engagement was created" || bad "the engagement was refused"

  # `{approve, allocatedTokens}`. A `{verdict:"approved"}` body is accepted and read as a refusal, which
  # ends the engagement — success-shaped and wrong.
  if [[ -n "$EID" ]]; then
    STATE="$(api POST "/api/engagements/$EID/verdict" '{"approve":true,"allocatedTokens":50000}' \
      | jqf engagement.state)"
    [[ "$STATE" == "active" ]] && ok "the engagement is active" || bad "the engagement is $STATE, not active"
  fi

  COMMITTED="$(api GET "/api/project-sides/$SIDE/budget" | jqf committed)"
  [[ "$COMMITTED" != "0" ]] && ok "the budget shows a commitment ($COMMITTED)" \
    || bad "nothing was committed against the side"
fi

echo ""
if [[ $fail -eq 0 ]]; then
  echo "An agent can be created, funded, bound to a customer, minted on their homeserver, and engaged: $pass check(s)."
  echo "What this does NOT prove: that a human's message reaches the group. That needs a room bound to a"
  echo "group (!bindroom in the room) and is verified by posting in it — see docs/RUNNING-THE-SERVICES.md."
  exit 0
fi
echo "verify-agent-e2e: $fail of $((pass+fail)) checks failed."
exit 1
