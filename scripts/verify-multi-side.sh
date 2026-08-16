#!/usr/bin/env bash
#
# Multi-tenancy, asserted against two REAL homeservers.
#
# Three claims ADR-016 makes that cannot be tested with one project side, because there is nothing for
# them to be isolated FROM:
#
#   1. budgets are per side — one customer running out must not affect another;
#   2. credentials do not reach across — neither at the homeservers, nor in our code, nor at the intake;
#   3. removing a side sweeps ITS records and nobody else's.
#
# All three were established by hand on 2026-08-15 and none of it was replayable, which makes it an
# anecdote rather than evidence. This is the replay.
#
# WHAT IT WILL NOT DO. It never writes to the FIRST side: it reads that side's budget and invitations to
# prove they were untouched, and nothing else. Everything it creates is on the second side and is removed
# again at the end — including the side itself, which is the third assertion.
#
# Usage:
#   HAFLEET_RUNTIME_DIR=~/.hafleet-e2e-runtime scripts/verify-multi-side.sh
#
# Requires a second homeserver. Bring one up with:
#   scripts/verify-multi-side.sh --print-second-homeserver
# which prints a compose file and config rather than starting anything, because a verification script
# that provisions infrastructure is a deploy tool wearing a test's clothes.

set -uo pipefail

RUNTIME="${HAFLEET_RUNTIME_DIR:-}"
BACKEND="${HAFLEET_BACKEND_URL:-http://127.0.0.1:8090}"
SIDE_B="${MULTI_SIDE_SERVER:-acme.test}"
SIDE_B_URL="${MULTI_SIDE_URL:-http://127.0.0.1:8018}"
SIDE_B_REG="${MULTI_SIDE_REGISTRATION:-$HOME/.hafleet-palpo-b/appservices/hafleet.yaml}"

failed=0
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s%s\n' "$name" "${detail:+  — $detail}"
    failed=$((failed + 1))
  fi
}

# `--if-available` turns MISSING PREREQUISITES into a skip instead of a refusal, and nothing else. The
# default refusal exists for a human at a terminal: these assertions include a side REMOVAL, and a script
# that guessed which fleet to point at would eventually remove a real customer. CI has no fleet at all, so
# there the same absence is simply "not applicable" — and conflating the two would mean either a CI job
# that always fails or a local run that silently targets the wrong deployment.
#
# It never softens a FAILED assertion. Only "there is nothing here to test".
IF_AVAILABLE=0
for arg in "$@"; do
  [ "$arg" = "--if-available" ] && IF_AVAILABLE=1
done

skip_or_fail() {
  local message="$1"
  if [ "$IF_AVAILABLE" = "1" ]; then
    echo "verify-multi-side: SKIPPED — $message"
    exit 0
  fi
  echo "verify-multi-side: $message" >&2
  exit 2
}

if [ "${1:-}" = "--print-second-homeserver" ]; then
  cat <<'DOC'
A second homeserver, for the isolation assertions. Ports are +10 from the first so they cannot collide.

  mkdir -p ~/.hafleet-palpo-b/{data/media,appservices}

  cat > ~/.hafleet-palpo-b/palpo.toml <<'TOML'
  server_name = "acme.test"
  allow_registration = true
  appservice_registration_dir = "/var/palpo/appservices"
  [[listeners]]
  address = "0.0.0.0:8008"
  [db]
  pool_size = 10
  [well_known]
  client = "http://127.0.0.1:8018"
  TOML

  # compose.yml: palpo on 127.0.0.1:8018->8008 with its own postgres, then:
  #   as_token/hs_token: generate with `openssl rand -hex 32`
  #   url: MUST be reachable FROM the container — host.docker.internal, not 127.0.0.1.
  #        (docs/FOR-PROJECT-SIDES.md explains why: 127.0.0.1 there is the container itself.)
DOC
  exit 0
fi

if [ -z "$RUNTIME" ]; then
  skip_or_fail "HAFLEET_RUNTIME_DIR is required. There is no safe default: guessing would run these assertions — including a side REMOVAL — against a fleet other than the one you meant."
fi
# shellcheck disable=SC1091
set -a; . "$RUNTIME/.env" >/dev/null 2>&1 || true; set +a
TOKEN="${API_TOKEN:-}"
AUTH=(-H "Authorization: Bearer $TOKEN")

api() { curl -s "${AUTH[@]}" -H 'Content-Type: application/json' "$@"; }
jq_py() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

echo
echo "Multi-tenancy assertions against $BACKEND"
echo

# ── preflight ──────────────────────────────────────────────────────────────────────────────────────
if ! curl -s -o /dev/null --max-time 5 "$BACKEND/health"; then
  skip_or_fail "backend not answering at $BACKEND/health"
fi
if ! curl -s -o /dev/null --max-time 5 "$SIDE_B_URL/_matrix/client/versions"; then
  echo "verify-multi-side: SKIPPED — no second homeserver at $SIDE_B_URL"
  echo "  Run with --print-second-homeserver for one. Skipping is not passing:"
  echo "  these three claims stay unverified until a second homeserver exists."
  exit 0
fi
if [ ! -f "$SIDE_B_REG" ]; then
  echo "verify-multi-side: SKIPPED — no registration file at $SIDE_B_REG" ; exit 0
fi
AS_B=$(awk '/^as_token:/{print $2}' "$SIDE_B_REG")
HS_B=$(awk '/^hs_token:/{print $2}' "$SIDE_B_REG")
[ -n "$AS_B" ] && [ -n "$HS_B" ] || { echo "verify-multi-side: registration file has no tokens" >&2; exit 2; }

# The FIRST side is whichever one is already configured. Never written to.
SIDE_A=$(api "$BACKEND/api/project-sides" | jq_py "print(next((s['id'] for s in d.get('sides',[]) if s['id']!='$SIDE_B'), ''))")
[ -n "$SIDE_A" ] || { echo "verify-multi-side: no existing project side to isolate against" >&2; exit 2; }
echo "  first side (read-only): $SIDE_A"
echo "  second side (created and removed): $SIDE_B"
echo

A_BUDGET_BEFORE=$(api "$BACKEND/api/project-sides/$SIDE_A/budget" | jq_py "print(d.get('committed'), d.get('allocated'))")

# ── onboard the second side ────────────────────────────────────────────────────────────────────────
api -X POST -d "{\"server_name\":\"$SIDE_B\",\"api_base_url\":\"$SIDE_B_URL\"}" "$BACKEND/api/project-sides" > /dev/null
api -X PUT -d "{\"credential\":{\"kind\":\"appservice\",\"asToken\":\"$AS_B\",\"hsToken\":\"$HS_B\",\"namespace\":\"@ac_.*\",\"senderLocalpart\":\"hafleet\"}}" \
  "$BACKEND/api/project-sides/$SIDE_B/credential" > /dev/null
VERDICT=$(api -X POST "$BACKEND/api/project-sides/$SIDE_B/verify" | jq_py "print(d.get('side',{}).get('accessState'))")
check "the second side's credential is accepted by its homeserver" "$([ "$VERDICT" = "accepted" ] && echo 1 || echo 0)" "got $VERDICT"
api -X PUT -d '{"allocated_tokens":100000}' "$BACKEND/api/project-sides/$SIDE_B/allocation" > /dev/null

# ── 1. credentials do not reach across ─────────────────────────────────────────────────────────────
AS_A=$(curl -s -H "X-Bridge-Secret: ${MATRIX_BRIDGE_SECRET:-}" "$BACKEND/api/project-sides/acting-credentials" \
  | jq_py "print(next((s.get('asToken','') for s in d.get('sides',[]) if s['sideId']=='$SIDE_A'), ''))")
A_URL=$(api "$BACKEND/api/project-sides" | jq_py "print(next((s['apiBaseUrl'] for s in d.get('sides',[]) if s['id']=='$SIDE_A'), ''))")
if [ -n "$AS_A" ] && [ -n "$A_URL" ]; then
  X1=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AS_B" \
    "$A_URL/_matrix/client/v3/account/whoami?user_id=%40hafleet%3A$SIDE_A")
  X2=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AS_A" \
    "$SIDE_B_URL/_matrix/client/v3/account/whoami?user_id=%40hafleet%3A$SIDE_B")
  check "each side's as_token is refused by the OTHER homeserver" \
    "$([ "$X1" = "401" ] && [ "$X2" = "401" ] && echo 1 || echo 0)" "$SIDE_A=$X1 $SIDE_B=$X2"
else
  check "each side's as_token is refused by the OTHER homeserver" 0 "could not read acting credentials"
fi

# Our own code, before the wire: a fetch double that throws if called proves the refusal precedes any request.
CROSS=$(node --input-type=module -e "
const { inviteToRoomOnSide } = await import('./lib/matrix-representative.js');
const r = await inviteToRoomOnSide({
  side: { serverName: '$SIDE_B', apiBaseUrl: '$SIDE_B_URL' },
  credential: { kind: 'appservice', asToken: 'unused', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
  roomId: '!x:$SIDE_A', userId: '@ac_probe:$SIDE_A',
  fetchImpl: async () => { throw new Error('a request was made'); },
});
process.stdout.write(String(r.invited) + '|' + String(r.reason || ''));
" 2>/dev/null)
check "our code refuses a cross-side room BEFORE any request" \
  "$([ "${CROSS%%|*}" = "false" ] && echo 1 || echo 0)" "${CROSS#*|}"

# ── 2. budgets are per side ────────────────────────────────────────────────────────────────────────
api -X PUT -d '{"allocated_tokens":0}' "$BACKEND/api/project-sides/$SIDE_B/allocation" > /dev/null
B_REFUSAL=$(api -X POST -d "{\"project\":\"probe\",\"projectRoomId\":\"!probe:$SIDE_B\",\"role\":\"coding\",\"requester\":\"@probe:$SIDE_B\",\"requestedTokens\":1000,\"ratePerDay\":100,\"requestId\":\"\$multiside-b\"}" \
  "$BACKEND/api/engagements" | jq_py "print(d.get('reason',''), '|', (d.get('error') or '')[:90])")
check "the exhausted side refuses, and NAMES itself" \
  "$([ "${B_REFUSAL%% *}" = "over_allocation" ] && echo 1 || echo 0)" "$B_REFUSAL"
case "$B_REFUSAL" in *"$SIDE_B"*) NAMED=1 ;; *) NAMED=0 ;; esac
check "the refusal names the side, not a generic budget error" "$NAMED" "$B_REFUSAL"

A_BUDGET_MID=$(api "$BACKEND/api/project-sides/$SIDE_A/budget" | jq_py "print(d.get('committed'), d.get('allocated'))")
check "the first side's budget is unchanged while the second is exhausted" \
  "$([ "$A_BUDGET_BEFORE" = "$A_BUDGET_MID" ] && echo 1 || echo 0)" "before=[$A_BUDGET_BEFORE] now=[$A_BUDGET_MID]"

ALERTS=$(api "$BACKEND/api/alerts" | python3 -c "
import sys,json
rows=json.load(sys.stdin); rows=rows if isinstance(rows,list) else rows.get('alerts',[])
b=[a for a in rows if a.get('dedupeKey')=='project_side_budget:$SIDE_B' and a.get('status')!='resolved']
a=[x for x in rows if x.get('dedupeKey')=='project_side_budget:$SIDE_A' and x.get('status')!='resolved']
print(len(b), len(a))")
check "the alarm is raised for the exhausted side only" \
  "$([ "${ALERTS%% *}" != "0" ] && [ "${ALERTS##* }" = "0" ] && echo 1 || echo 0)" "open: $SIDE_B=${ALERTS%% *} $SIDE_A=${ALERTS##* }"

api -X PUT -d '{"allocated_tokens":100000}' "$BACKEND/api/project-sides/$SIDE_B/allocation" > /dev/null
RESOLVED=$(api "$BACKEND/api/alerts" | python3 -c "
import sys,json
rows=json.load(sys.stdin); rows=rows if isinstance(rows,list) else rows.get('alerts',[])
print(all(a.get('status')=='resolved' for a in rows if a.get('dedupeKey')=='project_side_budget:$SIDE_B'))")
check "raising the allocation auto-resolves that alarm" "$([ "$RESOLVED" = "True" ] && echo 1 || echo 0)" "$RESOLVED"

# ── 3. removal sweeps ITS records and nobody else's ────────────────────────────────────────────────
# A FRESH room id per run. `upsert` is keyed on (room, agent) and does not resurrect a settled
# invitation, so a second run of this script re-used the one the first run had already declined and the
# cascade correctly reported zero — a replay failure in the SCRIPT that read as a product defect. The
# room id therefore carries the epoch, which is also what makes two runs independent rather than
# accidentally ordered.
PROBE_ROOM="!multiside-$(date +%s):$SIDE_B"
api -X PUT -H "X-Bridge-Secret: ${MATRIX_BRIDGE_SECRET:-}" \
  -d "{\"project_room_id\":\"$PROBE_ROOM\",\"agent\":\"multiside-probe\",\"inviter\":\"@ac_owner:$SIDE_B\",\"roomName\":\"probe\"}" \
  "$BACKEND/api/matrix/pending-invites" > /dev/null
A_INVITES_BEFORE=$(api "$BACKEND/api/matrix/pending-invites" | python3 -c "
import sys,json
rows=json.load(sys.stdin); rows=rows.get('invites',rows) if isinstance(rows,dict) else rows
print(sum(1 for i in rows if i.get('projectServer')=='$SIDE_A' and i.get('state')=='pending'))")

api -X POST "$BACKEND/api/project-sides/$SIDE_B/deactivate" > /dev/null
CASCADE=$(api -X DELETE "$BACKEND/api/project-sides/$SIDE_B?confirm=$SIDE_B" | jq_py "
print(d.get('cascade'), '|', len(d.get('declinedInvites') or []))")
check "removal reports a performed cascade and declines the side's invitations" \
  "$([ "${CASCADE%% *}" = "performed" ] && [ "${CASCADE##* }" != "0" ] && echo 1 || echo 0)" "$CASCADE"

A_INVITES_AFTER=$(api "$BACKEND/api/matrix/pending-invites" | python3 -c "
import sys,json
rows=json.load(sys.stdin); rows=rows.get('invites',rows) if isinstance(rows,dict) else rows
print(sum(1 for i in rows if i.get('projectServer')=='$SIDE_A' and i.get('state')=='pending'))")
check "the first side's pending invitations are untouched by the removal" \
  "$([ "$A_INVITES_BEFORE" = "$A_INVITES_AFTER" ] && echo 1 || echo 0)" "before=$A_INVITES_BEFORE after=$A_INVITES_AFTER"

STILL=$(api "$BACKEND/api/project-sides" | jq_py "
ids=[s['id'] for s in d.get('sides',[])]; print(('$SIDE_A' in ids), ('$SIDE_B' in ids))")
check "the first side survives and the second is gone" "$([ "$STILL" = "True False" ] && echo 1 || echo 0)" "$STILL"

A_BUDGET_AFTER=$(api "$BACKEND/api/project-sides/$SIDE_A/budget" | jq_py "print(d.get('committed'), d.get('allocated'))")
check "the first side's budget survives the removal" \
  "$([ "$A_BUDGET_BEFORE" = "$A_BUDGET_AFTER" ] && echo 1 || echo 0)" "before=[$A_BUDGET_BEFORE] after=[$A_BUDGET_AFTER]"

echo
if [ "$failed" -eq 0 ]; then
  echo "Multi-tenancy holds: budgets isolated, credentials isolated, removal scoped."
else
  echo "$failed assertion(s) FAILED."
fi
exit "$([ "$failed" -eq 0 ] && echo 0 || echo 1)"
