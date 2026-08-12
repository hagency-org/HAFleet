# Testing

```bash
npm test                  # full suite, serial
npm run test:kernel       # sharded kernel + CLI subset
npm run verify:ci         # all gates (needs GNU timeout; macOS: brew install coreutils)
```

## The memory theory, measured and dropped (2026-08-11)

**The section below is retained for its measurements but its DIAGNOSIS is wrong.** The retention
it describes is real; the claim that it causes the intermittent failures is not, and two rounds
of effort were aimed at it before anyone measured the thing it depends on.

Measured with `scripts/heap-probe-config.js`:

| file | contexts (runtime) | end heap | share of Node's limit |
|---|---|---|---|
| `api-groups` | 45 | 642 MB | **15%** |
| `api-tasks` | 16 | 249 MB | 6% |
| `alert-store` | 15 | 234 MB | 5% |
| `api-pool` | 1 | 43 MB | **1%** |

Node's `heap_size_limit` here is **4288 MB**. Nothing comes close to it, so "a worker gets
recycled or a module evaluates only partway" has no pressure to arise from. And `api-pool` — one
context, 43 MB, 1% of the limit — is one of the files that flakes. Memory cannot be why.

Two further measurements close the theory's escape routes:

- **Retention does not accumulate across the run.** Each file gets a fresh worker process (the
  pid in the probe output changes per file) and every file starts near 12 MB regardless of what
  ran before. So the heaviest file's 642 MB cannot pressure a later light one.
- **A dead instance cannot be made cheap.** Emptying every JSON store, Map and Set on `cleanup()`
  moved the numbers by 0.5%: 642→639, 249→249, 234→236 MB. The ~14 MB per instance is the
  MODULE — 13k lines of code, its closures, an express Router with ~101 layers — not its data. A
  test seeds two agents; that is kilobytes.

**And the prescribed fix would not have worked.** "Make the runtime directory injectable so one
module instance serves every test" is blocked by something the inventory below missed: **51 test
files inject `seed.env` at 156 sites**, including `API_TOKEN` (17), `AGENT_HEARTBEAT_TTL_MS` (12),
`HAFLEET_AGENT_TOKEN_MODE` (10) and `AGENT_SERVER_SWEEP_INTERVAL_MS` (7) — all read into module
CONSTANTS at import time. One shared instance would serve all of them whatever the first import
saw, silently: a test handed the wrong TTL does not fail, it measures the wrong thing.

So: do not spend more effort on memory here, and do not reduce contexts for flake reasons (wall
clock is dominated by test execution, ~322 s of a 342 s run, not by the ~5 s of module imports).
The cause of the intermittent failures is still **unknown**; what is now known is where it is not.
The live leads are the three specimens in "The specimen round" below — one of which was a genuine
timing race and is fixed, which is itself evidence that these failures are several unrelated bugs
rather than one systemic cause.

## The backend test harness leaks memory (measurements sound, diagnosis superseded above)

`tests/helpers/backend-test-runtime.js` gives each test an isolated backend by
importing `backend-v2.js` with a unique cache-buster:

```js
const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const backendModule = await import(`${backendUrl}?test=${cacheBust}`);
```

The ESM module registry retains **every** copy for the lifetime of the worker.
`cleanup()` cannot release it. Measured cost:

```
start:         11 MB
10 contexts:  135 MB
20 contexts:  247 MB
30 contexts:  363 MB      →  ~12 MB retained per context, linear
```

There are **212** `createBackendTestContext()` call sites, plus 34 `importServer()`
calls doing the same to `server.js`.

### Why it was thought to cause flaky failures (superseded)

Vitest discards each test *file's* module graph, so the leak is per-file rather
than cumulative — a fresh file starts at 11 MB again. But a single heavy file can
retain a lot on its own, and `scripts/run-kernel-tests.sh` runs shards in
parallel, multiplying the peak.

Under that pressure a worker gets recycled or a module evaluates only partway.
`backend-v2.js` creates its express `app` near the top of an 11,500-line file and
registers ~101 routes throughout, so a partially-evaluated module yields an app
with *some* routes missing. Observed symptoms, all from this one cause:

| Symptom | What it actually was |
|---|---|
| `expected 404 to be 200` on `GET /api/servers` | route never registered |
| `expected 404 to be 200` on `POST /api/queue` | route never registered |
| `expected 401 to be 200` | env/auth configuration incomplete |
| `expected null to be 'inst-B'` | store never loaded |

The failing test moves around between runs, which is what made this look like
several unrelated flakes rather than one systemic problem.

### Measured concurrency trade-off

| `HAFLEET_KERNEL_MAX_CONCURRENCY` | Wall clock | Result |
|---|---|---|
| 5 | ~69 s | fails ~2 runs in 3 |
| 2 | ~118 s | still fails |
| **1 (default)** | **~171 s** | **passes** |

The default is 1: slower, but a gate that is wrong two-thirds of the time gets
ignored, which is worse than a slow one. `verify:ci`'s wall-clock limit was raised
from 90 s to 300 s to accommodate it — that limit is a hang guard, not a
performance budget.

Override when you want speed and can tolerate flakes:

```bash
HAFLEET_KERNEL_MAX_CONCURRENCY=5 npm run test:kernel
```

### Ruled out

Recorded so nobody re-investigates these:

- **Not** environment leakage between files in a shard. The dashboard mutation
  boundary returns 403, never 404.
- **Not** the hard-coded ports (18084 / 18090) shared across shards.
- **Not** contention over the repository's own `data/`; nothing is created there
  during a run.
- **Not** CPU load by itself. A single file ran 40 contexts clean at load
  average 101.

### The specimen round (2026-08-11)

The intermittent failures continued under `maxWorkers: 1` — nine files by then, no two
adjacent in the code — and stayed unexplained for ~25 observations for a reason that had
nothing to do with the code: **every observation kept only the failing test's title.** The
assertion diff, the response body, the child stderr all scrolled away, so each occurrence
was an anecdote. `scripts/flake-hunt.sh` fixes that: K full runs, every failure's complete
output kept as a specimen. Its first deployment (six runs, quiet machine) produced three
specimens and three DIFFERENT mechanisms:

| Specimen | Test | Mechanism | Status |
|---|---|---|---|
| 2a | `api-server-heartbeat` recovery | TTL 100ms + sleep(200): every assertion after the recovery heartbeat sat inside a 100ms window, and one GC pause re-marked the recovered server stale, re-opening its alert | **FIXED** — the test now ages `heartbeatAt` directly through `internals.serversForTest` with a 60s TTL; no sleep, no window |
| 2b | `mcp-heartbeat` pid file | `waitFor`'s default timeout was 30000ms — the SAME as vitest's test timeout — so vitest's limit always fired first and replaced the wait's own error (which names what was awaited) with a bare "Test timed out" | **INSTRUMENTED** — `waitFor` defaults to 20s and takes a `diagnose` callback; the pid-file waits dump child stderr, so the next occurrence answers its own question |
| 5 | `api-messages` delivery tail | `expected 404 to be 200` on an entity seeded three lines earlier in the same context. A handler 404 would be JSON (points at seeding); a route-level 404 would be express's HTML fallback (points at the partial-evaluation class above). The status alone cannot distinguish them | **INSTRUMENTED** — the assertion now carries the response body in its failure message; the next occurrence settles which class this is |

Theories tested and **falsified** this round, recorded so nobody re-walks them:

- **Not** background sweeps racing test requests: the loops start only in `startServer()`,
  which supertest-driven tests never call.
- **Not** foreground load as the cause: six runs on a quiet machine still produced two
  failing runs, matching the historical rate. Concurrent local work (mutation testing,
  single-file vitest runs) is at most an amplifier.
- Context-count correlation is real but not sufficient, and 2026-08-11 weakened it further:
  `api-runtime` (25 sites) had been the clean counterexample cited against the theory — and
  then it flaked too (whole-suite run, `runtime reports persist backend-derived observation
  provenance`, passing alone immediately after). Eight files now. The one file that argued
  "heavy but stable" is no longer stable, so what the flaky set has in common is not a
  property of any file — it is `createBackendTestContext` under whole-suite memory pressure,
  exactly the mechanism the section above describes.

Method note, learned twice in one day: greping vitest output for failure counts silently
matches nothing because of ANSI escapes — strip them (`sed 's/\x1b\[[0-9;]*m//g'`) or the
count reads as "no failures", which is precisely how a flaky observation lies.

### The proposed "real fix" — do not attempt as written

Superseded: see "The memory theory, measured and dropped" at the top. It is blocked by
import-time `seed.env` in 51 files, and there is no memory pressure for it to relieve. Kept
because the state inventory below is accurate and useful for other purposes — with one
correction: there are **8** module-level `Set`s, not 3.

Stop minting a module per context. The cache-buster exists only because
`backend-v2.js` reads `HAFLEET_RUNTIME_DIR` at module scope
(`backend-v2.js:87`), so a fresh runtime directory requires a fresh module.

Making the runtime directory injectable would let one module instance serve every
test, deleting ~2.5 GB of retained memory and making the suite *faster* — 212
evaluations of an 11,500-line module is also where much of the wall clock goes.

It is not a small change. A correct reset has to handle:

- 15 JSON stores (`const` objects and arrays mutated in place)
- 19 module-level `Map`s, 3 `Set`s, 15 `let` bindings
- 5 sub-stores with their own internal state (`createTaskGraphStore`,
  `createTaskStore`, `createSupervisorSnapshotStore`, `createAlertStore`,
  `createSupervisorActionEngine`)
- `dataDir`, captured in a closure at `lib/backend/storage-adapter.js:28`

Missing any one of those produces **silent cross-test contamination**, which is
strictly worse than the loud 404 it replaces. That is why the concurrency cap
landed first.

A cheaper partial step: reduce contexts in the heaviest files. `api-groups.test.js`
still creates 45. `api-server-heartbeat.test.js` was split for this reason —
see `tests/helpers/server-heartbeat-fixtures.js`.

## Writing backend tests

```js
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const context = await createBackendTestContext('my-feature-test-', { agents: {} });
// context.app        supertest target
// context.internals  __backendV2TestInternals
// context.runtimeDir temp runtime root
context.cleanup();     // always, in afterEach
```

Prefer **one context per test file** over one per test where the tests do not
conflict. Each additional context costs ~12 MB that never comes back.

## Platform notes

- `verify:ci` needs GNU `timeout` or `gtimeout`. On macOS: `brew install coreutils`.
- Shell out through Node (`statSync`) rather than `stat(1)`: the `-f` / `-c`
  format flags differ between BSD and GNU, so a test can pass on macOS and fail
  on Linux CI.
- `install/install-macos.sh` refuses to run off macOS by design, so tests that
  execute it must branch on platform rather than assume they can.
