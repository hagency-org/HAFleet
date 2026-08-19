# Running HAFleet's services

HAFleet has its own service supervisor — `src/local-service-supervisor.mjs`, 500 lines with five test
files — and until 2026-08-15 **nothing started it.** `bin/hafleet-acp-up` says the supervisor "is itself
started by launchd or systemd"; the systemd units in this repo start individual services instead, and on
macOS there was no unit at all. So restart-on-crash and reboot survival were both built and unreachable,
and every service on the development host was launched by hand with `nohup` — including throughout the
session that noticed.

That is the shape this codebase keeps producing: a capability built, tested, and never invoked. A test
suite proves a thing *can* work; only a caller makes it work.

## What works today

```bash
set -a; . "$HAFLEET_RUNTIME_DIR/.env"; set +a     # or wherever your runtime lives
node bin/hafleet-supervisor
```

Starts every service in the profile, in dependency order, waits for each to become healthy, and
supervises them: restart-on-crash with per-service backoff. `SIGTERM`/`SIGINT` stop the children before
exiting, so a shutdown does not leave orphans holding ports.

Verified on this host: three services (backend, bridge, relay) started and supervised, backend answering
`/health` 200 — both with a full environment and with launchd's minimal one
(`env -i PATH=… HAFLEET_RUNTIME_DIR=…`).

**`HAFLEET_RUNTIME_DIR` is required and has no default.** A supervisor that guessed could serve the repo's
dev `data/` while an operator believed it was serving the real fleet. That exact mistake happened once by
hand in the session that wrote this, and only a wrong agent count caught it.

**The runtime's own `.env` is loaded by the entrypoint**, not listed in a unit file. Children inherit this
process's environment and launchd gives a process almost nothing, so without this the backend starts
without `API_TOKEN` or Matrix credentials and never becomes healthy. Loading it here keeps secrets in the
one file that is mode 600, instead of copying them into a unit an installer rewrites.

**Health timeout is 60s**, over the supervisor's own 15s default, and settable with
`HAFLEET_SUPERVISOR_HEALTH_TIMEOUT_MS`. This backend takes about 7s to answer `/health` — it loads
agents, tokens, the queue and the ledger before it listens — and 15s left nothing for a loaded machine.
The failure it produces is a supervisor killing a service that was about to be ready.

## launchd: works, with one known limitation

```bash
mkdir -p ~/Library/LaunchAgents
sed -e "s|__REPO__|$PWD|g" -e "s|__RUNTIME__|$HAFLEET_RUNTIME_DIR|g" \
    deploy/com.hafleet.supervisor.plist > ~/Library/LaunchAgents/com.hafleet.supervisor.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hafleet.supervisor.plist
launchctl kickstart -p gui/$(id -u)/com.hafleet.supervisor
```

**Verified on this host:** all three services started under launchd, backend answering `/health` 200, and
a service killed by pid came back with a new pid — restart-on-crash working through launchd, which is the
whole point of the unit.

**Give it ~60 seconds.** The backend needs about 7s to listen and the supervisor starts services in
dependency order; checking a port at 20s and finding it closed says nothing. That cost real time to learn:
an earlier version of this document reported a crash loop that was partly this, a log line from a previous
run read as if it were current.

### Two things that were wrong, and are fixed

**The unit never started at all.** It used `KeepAlive: {SuccessfulExit: false}` — restart only on a
non-zero exit — reasoning that restarting a clean stop would make `bootout` unusable. `launchctl print`
showed the truth: `pended nondemand spawn = speculative`, `semaphores = { successful exit => 0 }`,
`runs = 0`. That condition is *unsatisfied* for a job that has never run, so launchd saw no reason to run
it. `KeepAlive: true` fixes it, and the worry was unfounded — `bootout` removes the job, so it stops the
service whatever KeepAlive says.

**One unhealthy service took down the healthy ones.** `supervisor.start()` throws on the first service
that misses its health deadline, and the entrypoint exited 1 there — discarding backend and bridge, which
were listening and serving, because the relay's probe timed out. A supervisor that quits because one
service is slow converts one degraded service into an outage. It now logs loudly and keeps supervising,
and the supervisor's own restart loop keeps working on whatever is unhealthy.

### The limitation

**Killing the supervisor by pid does not reliably bring it back.** It exits 0 (its SIGTERM handler stops
the children first), launchd reports `last exit code = 0` and `state = not running`, and with
`KeepAlive: true` it should respawn — it did not within 55 seconds. `launchctl kickstart` restores it
immediately.

So: crash recovery of a SERVICE is verified working; crash recovery of the SUPERVISOR ITSELF is not. For
an unattended host that gap matters, and the next thing to check is whether the job needs
`ProcessType: Background` or a `LimitLoadToSessionType`, since a GUI-session agent that has lost its
session cannot be respawned into one.

## Which process receives a customer's messages

**The bridge, not the backend** — and this is worth stating on its own because the failure it produces is
silent and misattributed.

On a co-located appservice deployment the edge beside the customer's homeserver is drained by
`bridge-matrix.js`. With the bridge down: the console answers, the API answers, `POST
/api/project-sides/:id/verify` still returns `accepted` — because that verifies the OUTBOUND direction, our
ability to act as the representative — and not one message from the customer arrives. Walked on clean
machines: the edge's own counter read `transactions from the homeserver: 4` and `HAFleet last seen: never`
while every screen looked healthy.

Two things now say so rather than leaving it to be deduced:

- `GET /api/matrix/reach` reports `appservice.inbound` — `flowing`, `never-called`, `not-collected` or
  `rejected` — and the setup screen shows it beside the credential verdict, so "accepted" and "nothing is
  arriving" can no longer be mistaken for one answer.
- A fatal bridge start-up failure prints what it costs: `NOTHING WILL BE COLLECTED while this process is
  down`, naming the edge and the side. It appears only when an edge is actually configured. The failure that
  prompted it was `MATRIX_BOT_PASSWORD is required` — a credential with nothing to do with inbound, which
  ends inbound anyway.

**The bridge still needs its own bot account**, so a deployment that only serves appservice project sides
must nevertheless give it `MATRIX_HOMESERVER`, `MATRIX_BOT_USER` and `MATRIX_BOT_PASSWORD`. That is a real
constraint rather than a preference: the bot holds the single crypto store, talks to the operator, and owns
the approval DM rooms. Making the intake independent of it is not done.

`rejected` deserves its own note: it means the homeserver is calling with an `hs_token` the edge does not
accept, and the usual cause is a re-issued registration. Palpo keeps registrations in its database keyed by
id, and restarting does not update an existing row — so the new token never reaches it.

## Stopping

```bash
kill <supervisor pid>          # stops children first, then exits
```

Killing an individual service does **not** stop it: the supervisor restarts it, which is the supervisor
working. Stop the supervisor.

## Progress reporting: telling a room the agent is working

Asking an agent something over Matrix shows a read receipt and a typing indicator, then nothing until
the answer lands. For a ten-minute task a borrower cannot tell working from stuck.

```bash
set -a; . "$HAFLEET_RUNTIME_DIR/.env"; set +a
node bin/hafleet-install-progress-hooks --agent <name> --dry-run   # look first
node bin/hafleet-install-progress-hooks --agent <name>
```

`--agent` reads the workspace out of the agent's backend record. Prefer it to typing a path: the
backend already knows, and a hand-typed path is how hooks end up in the wrong tree — an agent
reporting into another customer's room. An agent whose record has no `workdir` or `homeDir` is
**refused**, not defaulted; on the fleet this was built against, four of five agents were in that state.

**It merges.** Whatever hooks are already in `.claude/settings.json` keep running and ours runs
alongside; the original is backed up once, and a second run changes nothing. An unparseable
`settings.json` is refused rather than rewritten, because a file with a comment in it is a file
somebody is editing.

### What lands in the room, and what does not

**Progress goes in a thread on the message that asked**, so the main timeline keeps two events — the
question and the answer. This was not the first design: the first posted each step into the room, and
the operator was right to reject it — 「在多人的房间…agent 老说话，把其他人的对话都冲了」. Steps also
coalesce (one line per minute, "read ×12, ran commands ×3"), and the reporter summarises verbs rather
than quoting tool inputs, which carry paths and sometimes credentials.

**A thread is not privacy.** Same room, same membership, same history visibility: everyone present can
open the thread and read every line. It buys attention, not secrecy. For work that must not be visible
to a room, the answer is a different room, not a thread.

**No anchor, no post.** The reporter refuses rather than falling back to the main timeline, because a
fallback would be invisible to whoever runs the agent and obvious to everyone else in the room. The
anchor is recorded when the agent reads `check_inbox` or `check_group`, so an agent that has read
nothing stays silent.

### ACP agents need nothing installed

An agent running under ACP — `octos`, `hermes`, `codex-acp` — reports progress with **no hook, no file, and
no trust prompt.** `scripts/hafleet-acp-agent.mjs` already receives `session/update` notifications and
`lib/runtime/acp.js` already parses tool calls out of them, so the host emits progress during the turn from
what it is already being told.

**This is the unification point, and hooks are not.** Every framework installs hooks differently — a
different file, a different scope, a different trust model — and octos has none at all, so "one hook for
every framework" is not a thing that can be built. Three of four frameworks speak ACP.

The same filter file decides for both transports. An operator who writes
`{"perGroup": {"acme": {"events": ["done"]}}}` does not write it a second time for ACP, and
`tools: {exclude: ["Bash"]}` covers an ACP agent's `execute` because kinds are mapped onto the same tool
names rather than reported under their own.

**The ACP `title` is never carried.** It is free text the agent wrote — "Read /home/customer/.env" — so only
the mapped verb travels, and a kind nobody has vetted reports as generic activity rather than by name.

**Install hooks only for a framework that will not run under ACP**, which in practice means Claude Code
started directly.

### Choosing what gets reported

Progress policy is a file, not a hardcoded decision: `~/.hafleet/progress-filter.json`. Absent means the
built-in default (start, steps, completion — one line a minute), so the feature works without it.

```json
{
  "events": ["start", "step", "done"],
  "tools": { "exclude": ["Bash"] },
  "minIntervalMs": 60000,
  "perGroup": { "acme-support": { "events": ["done"] } }
}
```

`perGroup` is the customer dimension: every group maps to a room on somebody's server, and rooms differ
— a three-person project room may want only "finished" while an ops channel wants every step. A
per-group rule **replaces** the top level rather than merging field by field, so a customer's rule can
be read on its own; a merge would mean a rule written to narrow one room silently inherits policy from
elsewhere.

`tools.exclude` is a privacy control as much as a verbosity one. `Bash` is reported as "ran commands"
and never with its command line, but an operator may still want the fact of running commands kept out
of a customer's room.

**It fails closed on configuration and open on absence.** A malformed filter reports **nothing** and
says why: an operator writing a filter is almost always narrowing what leaves the machine, and honouring
a typo by falling back to the permissive default would give them more than they had, in a room they
cannot see. A *missing* file is different — that is "nobody configured this", and it gets the default.

`minIntervalMs` has a floor of 5s that cannot be configured away. Throttling a caller can lower is
throttling a caller will lower, and this caller fires on every tool call.

**Where it lives, and why not the runtime directory.** The router's `INHERITED_RUNNER_ENV_KEYS` does not
pass `HAFLEET_RUNTIME_DIR` to a dispatched agent, so a filter kept there would be unreadable in exactly
the environment the reporter runs in. `HOME` is on that list. The anchor moved to `~/.hafleet/` for the
same reason plus one more: it was in `TMPDIR`, which the system cleans, so the "a later read does not
erase the anchor" guard was protecting state that could vanish for an unrelated reason.

### Two things this cost, worth knowing

**The anchor comes from `check_group` as well as `check_inbox`, and only the live run found that.**
Six unit tests passed against the inbox path while the feature was useless on the real fleet:
`check_inbox`'s group bucket carries @mentions, and HAFleet's ordinary way of addressing an agent in a
room is `name: question`, which is not a mention. It arrives through `check_group`.

**An agent's own progress crowded out the question it was answering.** Progress lines go into the group
like any other message, so a chatty agent's unread slice fills with its own output — observed at 10 of
10 on the live fleet, with the human's question out of view and the read history empty. No anchor could
be resolved, so nothing was reported: the more the agent had said, the more certainly it went mute. A
feature destroying its own precondition. `check_group` now makes ONE wider request, only when everything
visible is the agent's own, and a failure there leaves the agent's read successful.

**The reporter uses the per-agent token, not `API_TOKEN`.** The first version sent the operator token,
which the router puts in `FORBIDDEN_RUNNER_ENV_KEYS` — so it is absent from a dispatched agent's
environment, and should be: an agent runtime holding it could delete other agents and read every
side's credentials. Progress is the least privileged thing here and was reaching for the most
privileged key in the system. It now travels the same road as a reply.
