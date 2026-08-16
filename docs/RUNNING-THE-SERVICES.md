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

## What does NOT work yet: launchd

`deploy/com.hafleet.supervisor.plist` is written and lints clean, and the install steps are in its header.
**Do not rely on it.** Under launchd on this host the supervised services crash-loop: the backend starts,
listens, logs `Shutting down, terminating runners and saving data…` — its own SIGTERM handler — and the
supervisor's restart counter climbs. The same entrypoint, with the same variables, works in the foreground.

What was ruled out, so the next person does not redo it:

- **not the environment** — reproduced successfully in the foreground under `env -i` with exactly the
  variables the unit provides;
- **not the health timeout** — the 60s value takes effect and the backend passes its probe;
- **not two supervisors fighting** — no second supervisor process, and the lease file is empty;
- **not a missing `.env`** — the entrypoint logs 18 variables loaded under launchd too.

What remains unexplained is why the children take a SIGTERM shortly after listening *only* when launchd
owns the supervisor. Two things worth trying first: whether launchd's process-group handling kills the
group when the entrypoint's own start path throws, and whether `pidMatchesService`'s `ps` output differs
under a launchd session (it matches on `service.command[1]`, and a mismatch reports a healthy service as
unhealthy, which is exactly what a stop-then-restart loop looks like).

Until that is understood, run the entrypoint under whatever already keeps processes alive on the host —
including `nohup`, which is what this host does now. The difference from before is real even so: one
supervised tree with restart-on-crash and ordered startup, instead of three hand-started processes that
nothing was watching.

## Stopping

```bash
kill <supervisor pid>          # stops children first, then exits
```

Killing an individual service does **not** stop it: the supervisor restarts it, which is the supervisor
working. Stop the supervisor.
