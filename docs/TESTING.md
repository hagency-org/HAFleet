# Testing

```bash
npm test                  # full suite, serial
npm run test:kernel       # sharded kernel + CLI subset
npm run verify:ci         # all gates (needs GNU timeout; macOS: brew install coreutils)
```

## The backend test harness leaks memory, and it matters

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

### Why it causes flaky failures rather than a clean OOM

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

### The real fix, not yet done

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
