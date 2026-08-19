# Operator walkthrough: status and how to continue

This is the handoff for continuing manual, click-by-click verification of HAFleet as an
actual operator would use it — not the automated suite (`docs/TESTING.md` covers that),
not the API reference. The premise of this whole effort: **every bug found this way was
invisible to every test that existed**, because each one is a disagreement between two
things that are individually correct — a credential that verifies but an inbound path
that's dead, a commitment that's real but an agent that no longer exists, a room
membership read that works everywhere except the one deployment shape nobody had tried.
Reading code does not find these. Running the actual sequence on actual machines does.

**The one rule that matters more than any other in this document:** verify claims by
reading the artifact the claim is about, not by reading the log line that reports it.
`accessState: accepted` is a claim; the homeserver's own `joined_members` list is the
artifact. `verify` succeeding is a claim; the edge's own transaction counter is the
artifact. A stored `messages.json` entry is an artifact; a console screen that says
"delivered" is not. Every fix in this series was found by preferring the artifact.

## What has been walked and proven, with evidence

All of this was done on two real machines (a HAFleet host and a separate customer
Palpo host), not in unit tests, not by inference from code. PRs #116–#119.

| Step | Proven | Evidence |
|---|---|---|
| Find the "take on a project side" flow | Fixed — it had no entry point at all | `/projects/new` had zero links to it anywhere in the console; added a button |
| Probe an unregistered server name | Works, with a working remedy path when discovery fails | `.test` names have no DNS; the form's own fallback message names the fix |
| Create a project side | Works | — |
| Choose appservice credential, co-located edge | Works, once the address bug (below) was fixed | registration issued, installed, homeserver restarted |
| Verify credential | Reports `accepted` correctly | — but see the inbound-liveness item below, this alone is not enough |
| **Inbound actually arrives** | Works, with a real edge, real homeserver, real restart | edge counter: `transactions from the homeserver: N`, `delivered: N` |
| Customer types `!offer` in their own room | Works — answered by the **representative**, not a silent bot | homeserver's own room timeline: `@hafleet:walk.test → This contributor has nothing on offer right now.` |
| Customer types `!request <role> <tokens> <rate>` | Not yet walked to completion (see below) | — |
| Operator approves/rejects in 接洽/Engagements | Not yet re-walked after #110–#115's changes to that screen | — |
| Inbound survives HAFleet's own bot being unconfigured | Works — proven end to end | with `MATRIX_BOT_PASSWORD` deliberately unset, a customer's Matrix message reached HAFleet's own message store: `boss -> worker \| 无 bot 端到端 \| source=matrix`, `HTTP 200` back to the (fake) homeserver |
| Deleting an agent releases its budget, group membership, and Matrix room seats | Works | `#110`/`#113`/`#114`/`#115`; verified against a live fleet with a real 150k leaked commitment, cleaned to 0 |
| A dead-inbound side does NOT silently read as fine | Works | `GET /api/matrix/reach` → `appservice.inbound.state` distinguishes `never-called` / `not-collected` / `rejected` / `flowing`, each pointing at a different owner |
| A just-restarted edge doesn't cry wolf | Works | `settling` flag, 2-minute window, requires HAFleet to actually be connected |

## What has NOT been walked yet

These are the gaps a continuing agent should prioritize, roughly in the order they'd
naturally come up if you kept going from where this left off:

1. **`!request` through to an actual engagement, with the owner properly configured.**
   Every engagement seen in this series either auto-joined or landed in the
   `awaitingBind` state because `HAFLEET_OWNER_MXID` / `HAFLEET_OWNER_DM_ROOM` weren't
   set. Nobody has walked the path where a human actually receives an approval DM, sees
   a request, and approves it — the fully human-in-the-loop path is unverified.

2. **The `registrationToken` credential kind**, end to end. Everything walked here used
   `appservice`. The purely-outbound path (`HAFleet /syncs like a phone`) has its own
   registration flow, its own per-agent token minting, and has not been walked on a
   clean pair of machines.

3. **Credential reissue on a *live* fleet with active engagements.** `docs/FOR-PROJECT-SIDES.md`
   and the credential-staging code (`pendingCredential`) describe this working without
   breaking a running credential, but nobody has walked "customer's registration token
   is rotated while agents are actively dispatched" as a scenario.

4. **Two project sides on one HAFleet, each with its own co-located edge.** The
   `HAFLEET_EDGE_URL`/`SIDE`/`LINK_TOKEN` triplet is env-var-shaped, meaning one process
   currently serves **one** edge. If a deployment needs two co-located customers, that's
   either two bridge processes or a gap — not confirmed either way by walking it.

5. **What a real container restart of the edge looks like under actual load** — not a
   clean restart with zero pending transactions, but one with events in flight. The
   `settling` window (2 minutes) was sized by reasoning, not by observing a slow
   real-world restart.

6. **The full progress-in-thread flow with a *real* dispatched agent process** (not just
   the appservice message reaching HAFleet's inbox). An earlier part of this session
   (before the compaction this document follows) proved ACP progress threading works;
   it has not been re-verified since the bridge's send/read paths changed in #116–#119.
   Specifically: does a dispatched agent's reply, sent mid-conversation, also correctly
   route through `sayInRoom` when the project side and HAFleet share a homeserver? The
   unit tests say yes (`tests/bridge-say-in-room.test.js`); it has not been watched
   happen in Robrix.

7. **`!mkgroup` / `!bindroom` / `!addmember` / `!rmgroup` beyond the single happy path**
   used to prove the ordering flow — rebinding a room, removing a member mid-conversation,
   a group with no room bound to it yet.

## Reusable setup: a clean two-machine test rig

This is the highest-value reusable asset from this round. Building it from scratch cost
real time to a broken `colima` disk, a wrong network assumption, and a stale npm cache.
Two variants: **with HAFleet's own bot** (ordinary) and **without it** (proves #119).

### Prerequisites and picking a machine

- Check `~/.ssh/config` — it matches some hosts **by IP, not hostname**; connecting by
  FQDN silently skips the matched block (wrong user, no ControlMaster). Use the IP.
- Before claiming a machine, check it's actually idle:
  `ssh <host> 'sysctl -n vm.loadavg; lsof -nP -iTCP -sTCP:LISTEN | grep -cE "node|palpo"'`
- `docker`/`colima`/`node` are usually installed via Homebrew but **not on PATH** in a
  non-interactive shell — every command needs `export PATH=/opt/homebrew/bin:$PATH`
  prefixed, or run through a login shell.
- `colima` can have a disk locked by a stale `limactl usernet` process from months ago
  (`failed to run attach disk "colima", in use by instance "colima"`). Don't waste time
  fixing this — if a machine's colima is broken, check whether **docker itself already
  works without colima** (some hosts run docker directly). If not, pick a different idle
  machine.
- `npm ci` **deletes `node_modules` first, then installs** — if it fails partway
  (a broken shared npm cache directory is a common cause: `EEXIST`/`EACCES` under
  `~/.npm/_cacache`), you can be left with **zero dependencies** while a stale process
  still serves traffic on the same port. Always verify after: check every declared
  dependency in `package.json` actually has a directory under `node_modules`. Work
  around a broken shared cache with `npm ci --cache /tmp/some-private-dir`.

### Standing up the customer's homeserver (Palpo)

```bash
mkdir -p ~/palpo-<name>/appservices
cat > ~/palpo-<name>/palpo.toml <<EOF
server_name = "<name>.test"
allow_registration = true
registration_token = "<random hex>"
appservice_registration_dir = "/var/palpo/appservices"

[[listeners]]
address = "0.0.0.0:8008"

[db]
url = "postgres://palpo:palpo@palpo-<name>-db:5432/palpo"

[well_known]
server = "<name>.test:<host-port>"
client = "http://127.0.0.1:<host-port>"
EOF
chmod 600 ~/palpo-<name>/palpo.toml

docker network create palponet-<name>
docker run -d --name palpo-<name>-db --network palponet-<name> \
  -e POSTGRES_USER=palpo -e POSTGRES_PASSWORD=palpo -e POSTGRES_DB=palpo \
  postgres:16-alpine
sleep 12
docker run -d --name palpo-<name>-hs --network palponet-<name> \
  -v ~/palpo-<name>/palpo.toml:/var/palpo/palpo.toml \
  -v ~/palpo-<name>/appservices:/var/palpo/appservices \
  -e PALPO_CONFIG=/var/palpo/palpo.toml -e RUST_LOG=info \
  -p 127.0.0.1:<host-port>:8008 \
  ghcr.io/palpo-im/palpo:latest
```

**A `.test` server name has no real DNS.** Discovery (`.well-known`) will fail; that's
expected, and the console's own remedy message says exactly what to fill in instead —
that path is itself verified working, don't route around it.

### Standing up HAFleet

```bash
git clone https://github.com/hagency-org/HAFleet.git && cd HAFleet
npm ci --cache /tmp/some-private-dir      # see the PATH/cache notes above

R=~/.hafleet-<name>-runtime; mkdir -p $R/data
cat > $R/.env <<EOF
HAFLEET_RUNTIME_DIR=$R
HAFLEET_DATA_DIR=$R/data
HAFLEET_BACKEND_PORT=<port>
API_TOKEN=<random>
MATRIX_BRIDGE_SECRET=<random>
HAFLEET_EDGE_URL=http://<address HAFleet reaches the edge at>:<edge-port>
HAFLEET_EDGE_LINK_TOKEN=<random, shared with the edge — not the hs_token>
HAFLEET_EDGE_SIDE=<name>.test
EOF
chmod 600 $R/.env
set -a; . $R/.env; set +a
node backend-v2.js &
```

**For the with-bot variant**, also register a bot account on the customer homeserver and add:

```
MATRIX_HOMESERVER=http://<customer homeserver address>
MATRIX_SERVER_NAME=<name>.test
MATRIX_BOT_USER=hafleetbot
MATRIX_BOT_PASSWORD=<the password you registered with>
MATRIX_REG_TOKEN=<the customer homeserver's registration_token>
```

**For the without-bot variant**, leave those four unset entirely — do not set an empty
string, leave the keys absent. This is the configuration #119 makes survivable.

Then:

```bash
node bridge-matrix.js &
```

### The co-located edge — where every early attempt went wrong

**Rule 1: this operator's deployments use only the co-located appservice arrangement**
— the edge process runs *beside the customer's homeserver*, never a bare socket on a
public IP (`HAFLEET_APPSERVICE_PORT`). That other path exists in the code
(`lib/appservice-listener.js`, `resolveAppserviceListenerConfig`) and is real, not
deprecated — it's simply out of scope for this operator's walkthrough, matching how
they actually run HAFleet. This document assumes co-location throughout; don't reach
for the bare-socket path unless someone explicitly asks for it.

**Rule 2: there are two addresses for one socket, and they are never the same value.**

- The address the **homeserver** dials (goes in the registration `url:` field) — this
  must be reachable from inside the homeserver's own network view. For a co-located
  container, that's loopback: `http://127.0.0.1:<edge-port>`.
- The address **HAFleet** dials to collect (`HAFLEET_EDGE_URL`) — this is from wherever
  HAFleet actually runs, which is a different machine or at least a different network
  view.

The edge process is the only thing that knows the first one, because it owns the
socket. **Don't compute it, ask it** — `GET /api/matrix/reach` now does this itself
(`appservice.edgeRegistrationUrl`), reading it from the edge's own `/status` endpoint.
If you're doing this by hand: `hafleet-appservice-edge` prints
`put this in the registration:  url: http://127.0.0.1:<port>` on startup. That line is
the truth. Anything else is a guess.

**Rule 3: "co-located" means the same network namespace, which containers don't get for
free, and joining one has a cost of its own.** The working recipe:

```bash
# Run the edge sharing the homeserver container's network namespace:
docker run -d --name hafleet-edge-<name> --network container:palpo-<name>-hs \
  -v ~/HAFleet:/app:ro -v ~/palpo-<name>/appservices:/reg:ro -w /app \
  node:22-alpine node /app/bin/hafleet-appservice-edge \
    --registration /reg/<name>.yaml --link-token "<link-token>" \
    --port <edge-port> --host 0.0.0.0
```

This fixes the homeserver's dial address (now genuinely loopback from its point of
view). **It can break HAFleet's own access to the same socket**, because a container
that joins another container's network namespace cannot publish its own ports — only
the container that *owns* the namespace can. So the homeserver container must publish
the edge's port too, decided *before* starting it:

```bash
docker run -d --name palpo-<name>-hs ... -p 127.0.0.1:<host-port>:8008 -p 127.0.0.1:<edge-port>:<edge-port> ...
```

Getting rule 2 right and rule 3 wrong looks like: the homeserver starts calling
(progress!) and HAFleet still collects nothing. `hafleet-appservice-edge --check`
distinguishes these two failure states by name — read it, don't guess from symptoms.

**Rule 4: re-issuing a registration means restarting *two* things, not one.** Palpo
persists registrations in its database keyed by id; a homeserver restart does not
reload a changed token from disk, and the customer's homeserver will keep dialing with
the *old* `hs_token`, which the edge (now expecting the new one) will reject. Reissuing
a registration means: install the new file, restart the homeserver, **and restart the
edge process itself** so it's reading the new `hs_token` too. Skipping the edge restart
looks like `rejected` in `appservice.inbound.state` — that state exists specifically to
name this trap.

### Chaining SSH tunnels between three machines

If you (the operator's terminal), HAFleet, and the customer's Palpo are three different
places, you need transitive reachability without ever putting either homeserver on a
public interface. Loopback-forward through the middle host:

```bash
# From your terminal: reach the customer homeserver's port through the HAFleet host
ssh -f -N -L <local-port>:127.0.0.1:<customer-port> <hafleet-host>
# Then from the HAFleet host's own perspective, reverse-forward it onward if HAFleet
# itself needs to reach the customer host directly (e.g. no ssh key between them):
ssh -f -N -R <port>:127.0.0.1:<port> <hafleet-host>
```

Every `pkill -f "127.0.0.1:<port>"` you run to tear one tunnel down will match *every*
tunnel using that local port, including ones you meant to keep — rebuild all of them
together after any teardown, don't assume one survived.

### Verifying end to end, without trusting a screen

```bash
# 1. Register a human on the customer homeserver, create a room, invite the representative.
# 2. Post a message as that human.
# 3. Read the edge's own counters — not the console:
node bin/hafleet-appservice-edge --check --link-token "<link-token>" --port <edge-port>
# 4. Read what actually landed, off disk — not an API response:
cat $R/data/messages.json
# 5. Read the room from the customer's OWN side, as that human, not as HAFleet:
curl .../rooms/<room>/messages?dir=b -H "Authorization: Bearer <human's token>"
```

Step 5 is what caught the `M_FORBIDDEN` bug in #116 — the API and the logs looked
fine; the customer's own view of their own room was silent.

## Trap catalogue: exact mistakes made this round, so they aren't repeated

| Symptom | What it actually was | Where it's fixed / documented |
|---|---|---|
| `verify` says `accepted`, customer says nothing arrives | `verify` only proves the outbound direction | `GET /api/matrix/reach` → `appservice.inbound`, #117 |
| Healthy fleet shows an inbound warning right after a deploy | Edge counters reset on restart | `appservice.inbound.settling`, #118 |
| `!offer` / any bridge reply into a customer's room is silently lost | Bot isn't a member of that room; only the representative is | route ALL sends through `sayInRoom`, never `botClient.sendMessage` directly, #116/#119 |
| A DM room is misclassified (group vs. agent-DM vs. bot-DM) on a project side | Membership read used the bot's client, which can't see the room | route membership reads through `joinedMembersOf`, never `botClient.getJoinedRoomMembers` directly, #119 |
| One missing bot credential kills every customer's inbound | Bot bring-up wasn't isolated from appservice intake | `startBotSide()` is caught; intake continues if an appservice path exists, #119 |
| `project_room_id` accepted with `ok: true`, project has no room | Store reads `room_id`/`roomId`/`room` only | now refused by name instead of silently dropped, #111 |
| Engagement request refused for missing fields | Needs `project`, `requester`, `requestedTokens`, `role`, `projectRoomId` — five, not three | `scripts/verify-agent-e2e.sh` encodes the whole sequence |
| Preset silently has no ceiling three steps later | `ceiling` must be an object `{tokens, period}`, a bare number is dropped | — |
| `PATCH /api/agents/:name` with `projectSide` returns `ok:true` but nothing changes (old code) | Agents can't set their own employer; use `PUT .../project-side` | refused with a named code, prior series |
| `{"verdict":"approved"}` on an engagement reads as a *rejection* | Body must be `{approve: true, allocatedTokens}` | — |
| Deleting an agent leaves its budget/groups/room seats behind | Deletion never cascaded those three relationships | #110/#113/#114/#115 |
| A project shows 还没派人 next to a real commitment | `awaitingBind` — approved but no resolvable owner (`HAFLEET_OWNER_MXID`/`HAFLEET_OWNER_DM_ROOM`) | surfaced with the reason verbatim, #111; false-positive on an *already*-bound agent fixed in #112 |
| Bot-less degraded mode fills the log with a failure every poll | Guarding on `botClient` disabled functions that don't fully need it | guard the *specific stage* that needs the bot, not the whole function or the call site — verified by which existing tests broke, #119 |

## For whoever continues this

- Read `docs/TESTING.md` before assuming a test failure is your fault or not — this
  codebase has a documented class of whole-suite-only intermittent failures. Isolate
  first, run 3x, then decide.
- Every fix in this series shipped with a mutation that was verified to kill the
  regression it claims to catch — including at least one case (#117) where a
  source-level assertion was proven *worthless* by a mutation surviving it, and had to
  be rewritten to actually execute the code path. Do the same for anything new: write
  the test, then break the fix on purpose and confirm the test notices.
- Deploy and re-verify against a **real machine** before calling something done. Three
  separate fixes in this series (#111→#112, #114→#115, and the `writeHealthRecord()`
  crash inside #119's own development) were caught only because the fix was actually
  run, not because it passed review or unit tests.
- `docs/FOR-PROJECT-SIDES.md` and `docs/RUNNING-THE-SERVICES.md` carry the
  customer-facing and deployment-facing halves of what's in this document — this file
  is the narrative and the setup recipe; those two are the reference. Keep them in sync
  if either changes.
