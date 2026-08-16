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

### Occurrence log

Appended per sighting so the membership list stops being reconstructed from prose. A file
belongs here once it has failed in a whole-suite run and passed in isolation immediately after.

| Date | File | Test | Specimen kept? |
|---|---|---|---|
| 2026-08-11 | `alert-store` | `agent can resolve their assigned alert via agent-token` | **no** — title only |
| 2026-08-11 | `api-groups` | `lists groups for an agent with unread message and mention counts` | **yes** — `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` |
| 2026-08-11 | `engagement-binding` | `the failure is RECORDED on the engagement, not only returned` | **yes** — `Error: read ECONNRESET` |
| 2026-08-11 | `api-server-heartbeat-sweep` | `ignores heartbeats during maintenance while still updating lastSeen` | **yes** — `TypeError: Cannot read properties of undefined (reading 'lastSeen')` |
| 2026-08-12 | `api-usage-metering` | `a fleet with nothing measured reports null, not zero` | **yes** — `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` |
| 2026-08-12 | `api-pending-invites` | `reading the list needs the operator credential too` | **yes** — `AssertionError: expected 404 to be 401` |
| 2026-08-12 | `api-agent-preset-binding` | `presetId null unbinds, and the ceiling goes with it` | **yes** — `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` |
| 2026-08-12 | `server-delivery` | `queue snapshot reports untracked target observation before pane sweep` | **yes** — `AssertionError: expected 404 to be 200` |
| 2026-08-12 | `approval-fail-closed` | `denies a pending request and broadcasts the verdict` | **yes** — `Error: Test timed out in 30000ms` (a THIRD shape; clean in isolation, 7/7) |
| 2026-08-13 | `api-messages` | `message suppression appends a delivery event` | **yes** — whole-suite only, clean in isolation (39/39) |
| 2026-08-13 | `engagement-binding` | `the binding IS released once the last live engagement ends` | **yes** — `expected 404 to be 200`, clean in isolation (7/7) |
| 2026-08-13 | `api-server-heartbeat` | `accepts a new instance after the lease becomes stale` | **yes** — `AssertionError: expected null to be 'inst-B'`; CI only, on a DOCS-ONLY branch; see the investigation below |
| 2026-08-14 | `alert-store` | `alert API writes fail closed and keep visible state unchanged` | **yes** — `expected undefined to be 'agent-runtime'`; whole-suite only, clean in isolation 3/3 (18/18 each) |
| 2026-08-14 | `api-agents` | `DELETE /api/agents/:name returns 503 and keeps the agent registered on persistence failure` | **yes** — `expected 404 to be 503`; 1 failure in 10 runs of the file, 0/6 consecutive, 4/4 clean on master without the branch |
| 2026-08-14 | `api-server-heartbeat-sweep` | `accepts explicit offline without instance id when no lease is active` | **yes** — `Error: Test timed out in 30000ms`; whole-suite only, clean in isolation 4/4, and the next whole-suite run on the same tree was 194/194 |
| 2026-08-14 | `api-server-heartbeat` | `accepts takeover from a newer boot timestamp` | **yes** — `expected 404 to be 200`, the second shape; whole-suite only, clean in isolation 4/4; the branch touched engagements and project sides, which that file never references |
| 2026-08-14 | `api-runtime` | `MCP transitions do not emit legacy MCP-specific SSE event types` | **yes** — `Error: read ECONNRESET`, the third shape; whole-suite only, clean in isolation 4/4; seen on MERGED master, so no branch to attribute it to |
| 2026-08-14 | `acp-workspace-attribution` | `an agent that has never reported one has null, not a guess` | **yes** — `TypeError: res.body.find is not a function` on `GET /api/agents`; whole-suite only, clean in isolation 4/4; the branch touched only dashboard render/proxy files, which that test never reaches |
| 2026-08-14 | `agent-state-integration` | `PATCH unpause → agent not immediately deliverable` | **yes** — whole-suite only, clean in isolation 3/3; the branch touched project sides, credentials and the appservice receiver, none of which that file references |
| 2026-08-14 | `agent-ops-client-backend` | `agent_ops_cancel_dispatch_is_capability_bound_and_idempotent` (+5 cascading in the same file) | **yes** — `Test timed out in 30000ms`; whole-suite only, clean in isolation 3/3, and the branch changed only markdown |
| 2026-08-14 | four files in one run: `alert-store`, `api-operator-bearer-on-agent-routes`, `api-supervisor-v2`, `router-launch-recovery` | one test each | **yes** — FOUR different files in a single whole-suite run, all 54 tests green when the same four run together in isolation; seven long-lived processes were up |
| 2026-08-15 | `api-groups` | `rejects duplicate group names` | **yes** — `Parse Error: Expected HTTP/, RTSP/ or ICE/`, the first documented shape again; whole-suite only, clean in isolation 3/3 |
| 2026-08-15 | `api-dispatch` + `router-launch-recovery` | one test each, same pair as the 2026-08-14 four-file sighting | **yes** — `expected undefined to be 'released'`; whole-suite only, clean 3/3 together in isolation |
| 2026-08-15 | `delivery-queue` + `enforcement-spend` | one test each | **yes** — neither file is reachable from the change under test (`lib/matrix-representative.js`); clean 3/3 together in isolation |
| 2026-08-15 | `api-project-sides` | `agents minted for the side are RETIRED, and their record survives` | **yes** — `expected undefined to deeply equal [...]`: the DELETE answered without `retiredAgents` at all. Clean 69/69 in isolation and green on the very next whole-suite run of the SAME tree, so it is this class and not the change under test. Worth one note: that change made engagement approval do outbound HTTP to a project side, so if these sightings get more frequent from here, suspect socket pressure before suspecting the tests |
| 2026-08-15 | `api-project-sides` + `api-server-heartbeat` | one test each | **yes** — 94/94 in isolation, twice. They ran at positions #7 and #197 of 198, so the entire suite passes between them |
| 2026-08-16 | `router-launch-recovery` | `backend requeues a wrapper that dies before takePayload without losing its input` | **yes** — `launch_failures: 1` where 2 was expected, so a poll loop gave up rather than an assertion being wrong. **On GitHub Actions**, 8/8 clean locally in isolation, and the sibling PR on the same master base passed the same job |
| 2026-08-16 | `api-engagement-room-admission` | `an engagement on no configured side is skipped without a call` | **yes** — 3/3 in isolation and the very next whole-suite run of the same tree was 203/203. **A new file for this table, and the measurement predicted it**: 283ms per test, against 227ms median in the named set and 11ms outside it. The class is "files that wait on real time", and this is one |
| 2026-08-16 | `api-engagement-side-budget` + `api-runtime` | one test each | **yes** — 21/21 and 24/24 in isolation, and the very next whole-suite run of the same tree was 204/204. **Predicted again**: 237ms and 327ms per test. `api-runtime` was already on this table; the other is new and fits the measured profile exactly |

**A HYPOTHESIS THIS KILLS: LOCAL RESOURCE PRESSURE.** The 2026-08-14 four-file row notes "seven
long-lived processes were up", and the working theory since has been that this host's own fleet —
backend, bridge, relay, homeservers — starves the suite of CPU, sockets or file handles. The
2026-08-16 sighting happened **on a GitHub Actions runner**, which starts clean and runs nothing of
ours. Whatever this is, it is not our long-lived processes, and tuning what runs on the development
host will not fix it.

That leaves the shape unchanged and narrows it usefully: the class survives a change of machine,
operating system image, and process population. Two earlier CI-only sightings (`api-server-heartbeat`
on a docs-only branch, 2026-08-13) already pointed this way and were not followed up; this one makes
three, so CI is no longer the exception. The remaining common factor is the suite itself — 201 files
sharing one worker with `fileParallelism: false` — and the next probe should be whether the failures
correlate with position in the run rather than with the host.

One thing this row is NOT evidence for: it is not evidence the tests are wrong. Every sighting so far
is a poll loop or an assertion that passes in isolation, which means the code did the right thing
slower than the test was willing to wait, or a shared resource was briefly unavailable. Loosening the
assertions would hide it, and this document exists because hiding it was rejected.

**THE FIRST MEASUREMENT IN THIS INVESTIGATION, AND WHAT IT NARROWS.** Every hypothesis above was
argued from anecdote. CI now uploads per-file timing (see `test:ci`), so the 2026-08-16 run gave real
numbers for all 201 files, compared against the 17 files this table has ever named:

| | the 17 named files | the other 184 |
|---|---|---|
| median tests per file | 17 | 9 |
| median file duration | 3.0s | 0.1s |
| **median duration per test** | **227ms** | **11ms** |

Twenty times. 13 of the 17 sit in the slowest quartile where chance would put 4. The flaky set is not
a random sample of the suite: it is precisely the files that start real HTTP servers, open real
sockets and wait on real elapsed time. The other 184 never flake because they never wait for
anything, and a test that does not wait cannot time out.

That is not a surprising mechanism, and it should not be dressed up as one — it is close to
tautological. What it buys is a boundary. This is not a global property of the suite or of the
runner; it is ~17 integration files whose timing budgets are occasionally not met, and it predicts
exactly what has been observed: changing host, process population and file order all failed to move
it, because none of them is the variable.

It also kills the position hypothesis proposed one paragraph above, on the same day, by the same
person. Position rank and duration rank correlate at r=+0.40 in that run — vitest's sequencer runs
larger files first — so the flaky files' early positions are substantially a shadow of their size.
Position is not established as an independent factor and should not be chased as one.

**What this does NOT establish**, stated because two claims in this document have already been
retracted for outrunning their evidence: one run's timings, against a file list accumulated over
days, is a correlation and not a mechanism. It does not identify which resource runs short, and it
does not explain why a given run fails while the next one on the same tree passes. The next probe it
justifies is per-file rather than global — in those 17 files, replace fixed poll budgets with
condition-waits under a generous ceiling, and see whether the class disappears from the files that
get the treatment while continuing in the ones that do not. That is a controlled comparison the
previous four hypotheses never offered.

**A SECOND FAILURE CLASS, AND HOW TO TELL THEM APART IN ONE LOOK.** On 2026-08-16 a CI run failed 29
tests across 16 files at once, every one of them a file that imports the bridge. The cause was not the
timing class and not the branch:

```
Error: Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'
```

A platform-specific native OPTIONAL dependency, transitively required by the Matrix SDK, that `npm ci`
did not install on that runner. The same commit's previous run passed, and a re-run passed. Nothing in
the tests or the code was involved.

The diagnostic rule, which is the useful part:

| what you see | what it is | what to do |
|---|---|---|
| ONE test failing, passes in isolation | the timing class above | re-run; record the sighting |
| MANY files failing at once, all sharing an import | a missing native module from `npm ci` | re-run; if it repeats, pin the optional dep |
| failures that reproduce in isolation | your change | fix it |

Both of the 2026-08-16 diagnoses came out of the JSON artifact rather than the log. The failure above
appears in the raw log only as 29 `FAIL` lines with the module error buried thousands of lines away
among passing-test chatter; in the artifact it is one field on the first failed file. That is what the
instrumentation was for, and it has now paid for itself twice on the day it was added.

**A SIGHTING THAT WAS CHECKED FOR AUTHORSHIP BEFORE BEING CALLED A FLAKE.** The `api-agents` row above
failed once inside a whole-suite run and once more in isolation, which is unusual — this class is
normally whole-suite only. Because a branch was in flight that touched `agents.json` writes, the
attribution was tested rather than assumed:

| run | result |
|---|---|
| the file, on clean master (branch stashed) | 4/4 pass |
| the file, with the branch applied | 1 fail, then 9 passes across two batches |

One failure in ten runs with the branch and none in four without it is not a rate, and the branch's new
code is not reachable from that test at all — it runs only on project-side removal. So: the same
mechanism, a new file, and `expected 404 to be 503` is the second documented shape again — a handler
that did not answer, seen from an assertion that expected its status.

The step worth keeping is the stash-and-compare. "It passes in isolation" is weaker evidence than "it
passes in isolation on a tree without my change", and the second takes one extra command.

**A NAMED SPECIMEN FOR TWO SIGHTINGS THAT WENT UNNAMED.** Two earlier runs in the same session reported
intermittent failures whose identity was not captured, because the output was tailed rather than saved —
a process error, recorded as one at the time. The third occurrence was saved and is the `alert-store` row
above.

It is the SECOND shape, not a new one. The assertion reads `alert.body.owner` and gets `undefined`,
which is what a body containing an error object rather than the record looks like from an assertion's
side — the same event the `expected 404 to be 200` specimens show from the router's side. `alert-store`
had not appeared in this log before; the mechanism had, four times.

The practice that produced it is worth keeping: **save the run, do not tail it.** A flake that cannot be
named cannot be counted, and two sightings were lost that way before this one was kept.

**THE FIRST SIGHTING WITH NO BRANCH TO SUSPECT.** The `api-runtime` row above appeared on merged `master`
immediately after four PRs landed — 3197 passed, this one failed, 4/4 clean in isolation. Every earlier
row in this table was observed on a branch, which meant the first question was always "did I cause it",
and answering that took either a reachability read or a stash-and-compare.

There is no branch here. That removes the question and leaves the class: `read ECONNRESET` is the third
documented shape, and `api-runtime` is the fifth file to show one. Five files, five shapes between them,
no two adjacent in the code — which is the same evidence the memory theory was dropped on, now with the
last confound removed.

### The failures are FAST, not slow — and what was done about it (2026-08-15)

Twenty-eight failures were collected out of one day's whole-suite logs and sorted by duration. **Three
took a second or more; twenty-five failed in under half a second.** Two of the three slow ones sat at
exactly 30006/30007 ms, which is vitest's timeout and a genuine hang; everything else was an assertion
that ran and disagreed.

That kills the intuition these sightings invite. "Whole-suite only" sounds like contention — slow tests
tipping over a limit — and the durations say otherwise. The recurring shape is instead:

    expected undefined to deeply equal [...]      // retiredAgents absent from a DELETE response
    expected 400 to be 200                        // a seeded agent answering as though absent
    expected undefined to be 'released'

A value that should exist is missing, in a file that passes alone. That is the shape
`backend-test-runtime.js` already documents for one known cause: *"A module bound to the wrong directory
finds no seeded agents and answers 404 to everything."* The directory guard added for that proves the
module bound to the path we meant — it cannot prove the module READ what we wrote there.

**So the helper now asks the second question too.** After the import it compares the seeded agent names
against the names the module can actually see, and throws at SETUP with both lists when they differ. It
is one in-process read, only when agents were seeded.

The message reports BOTH what the module sees and what the file at that path holds, because those two
disagreeing means the module read another directory while the file being wrong means the seed was written
elsewhere — opposite fixes, and a guard that could not tell them apart would produce a better-labelled
mystery instead of an answer.

**This does not fix the flake.** Nothing here identified the mechanism; four hypotheses died earlier the
same day (see the table above) and this is not a fifth. What it changes is what the next sighting looks
like: a labelled failure naming the missing data, instead of an unexplained assertion two hundred lines
downstream that gets recorded as one more row in this table.

**AND THE FIRST VERSION OF THIS GUARD WAS ITSELF A BUG, recorded because it is the more useful half of the
story.** It compared seeded KEYS against agent records only. The store also holds humans (`kind: 'human'`),
`inferRecordKind` is what separates them, and a human seed therefore read as missing data. Two test files
broke deterministically — and for one run I described that as the guard having *caught* a flake, which was
exactly backwards: it had caused two failures of the shape it was written to detect. Isolation said so
immediately (they failed alone too, and a flake never does).

Two lessons, in the order they matter. A check that duplicates a rule the code owns will drift from it, so
the snapshot now comes from the module that owns `inferRecordKind` rather than from the helper's idea of
it. And a new diagnostic's first failures deserve more suspicion than old code's, not less: a guard that
has never fired has never been shown to fire *correctly*.

### The pairing is arithmetic, not a signature (2026-08-15)

A first version of the two rows above argued that these sightings keep arriving as exactly TWO files
per run, and sent the next reader after "what two concurrently-running backend contexts share". Both
halves were wrong, and the table disproves the first on its own evidence — files per sighting, oldest
first:

    1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 1, 2, 2, 1, 2

The suite is ~3170 tests. At a uniform per-test flake probability near 0.0006 the EXPECTED number of
failures in a run is about two, and one-to-three every time is exactly what that produces. Counting
pairs and calling them a pattern was reading the mean as a mechanism.

The concurrency half was wrong for a plainer reason: this config sets `fileParallelism: false` and
`maxWorkers: 1`, so no two contexts are ever live at once. Adjacency does not explain it either — the
last pair ran at positions #7 and #197 of 198.

**What the table does show:** a recurring CAST. `api-server-heartbeat` (with its `-sweep` sibling)
appears three times, and `alert-store`, `api-groups`, `router-launch-recovery` and `api-project-sides`
twice each.

That is an observation, NOT evidence of a shared defect — and the difference matters, because a first
draft of this paragraph claimed the cast could not come from a uniform rate. Exposure is wildly
uneven: the measured table above has `api-groups` at 45 contexts and `api-pool` at 1, so a uniform
per-CONTEXT rate would produce exactly this kind of cast, with the heaviest files appearing most. It
would not explain `api-pool`, which flakes with one context — but one file is not a pattern either.

**Four hypotheses, refuted cheaply (2026-08-15), so nobody spends a round on them again:**

| hypothesis | how it died |
|---|---|
| two contexts running concurrently | `fileParallelism: false`, `maxWorkers: 1` — never two at once |
| a leaked timer from the previous FILE | the 2026-08-15 pair ran at #7 and #197 of 198 |
| the twelve files that set `HAFLEET_RUNTIME_DIR` themselves, bypassing the import lock | none of the recurring cast is among them; all nine use the helper |
| real sockets (the `Parse Error: Expected HTTP/` shape) | one of the nine calls `.listen()`; the other eight never open a port |

Note also that this section's own measurements say each file gets a FRESH WORKER PROCESS, which rules
out the whole family of cross-file-leakage theories before any of them is written down — including
three of the four above. Read that line before forming the fifth.

**A SIGHTING WITH AN AGGRAVATING FACTOR WORTH RECORDING.** The `agent-ops-client-backend` row above
failed on a run where the branch's only change was MARKDOWN — no code could have caused it — and the
machine was simultaneously running seven long-lived processes put there by the same session: a backend,
a bridge, a dashboard, a Next.js console, a homeserver in Docker, its postgres, and a GUI Matrix client.

That does not make the flake class load-dependent; four of the specimens above appeared on an otherwise
quiet machine. It does mean **a whole-suite run competing with a live deployment is not a clean
measurement**, and this table should say so, because the obvious next move — "run it again" — is right
for the wrong reason if nobody notices what else was running.

The practice: when a whole-suite failure appears while a deployment is up, record what was up. A 30s
timeout on a machine with seven servers is weaker evidence of a code defect than the same timeout on an
idle one, and the distinction is free to record and impossible to recover later.

**THE SAME FILE, A DIFFERENT TEST, A DIFFERENT SHAPE — and reachability answered instead of assumed.**
The `api-server-heartbeat-sweep` row dated 2026-08-14 is the second sighting in that file (the first is
the 2026-08-11 row) but a different test and the timeout shape rather than the TypeError. It arrived on a
branch that changed `POST /api/agents` and `PATCH /api/agents/:name`, so the branch had to be cleared
before the row could be called a flake at all — and here that was cheaper than a stash-and-compare:

> The test posts a server heartbeat and then `POST /api/servers/s1/offline`. It never calls either route
> the branch touched. The file's three `api/agents` mentions are path helpers that read `agents.json` off
> disk. The changed code is not reachable from this test.

Worth stating because a timeout is the shape where stash-and-compare is *weakest*: it is load-dependent,
so one clean comparison run is not evidence, and the several runs that would be evidence cost 5 minutes
each. Reading for reachability settles it in one step. Stash-and-compare stays the right move when
reachability is genuinely unclear — when the branch's new code *could* run inside the failing test. The
`api-agents` note above is that case: the branch touched `agents.json` writes and the failing test deletes
an agent, so reading could not settle it and two batches of runs did.

**A fourth shape, and the first one whose investigation eliminated its own most plausible cause.**
`relayInstanceId` read `null` where `inst-B` was expected. The branch under test added 562 lines to
two markdown files and nothing else, so it could not have caused it; the identical commit passed on
rerun.

What was checked, and what it ruled out — recorded because each of these is a dead end somebody would
otherwise re-walk:

- **"The file lags the in-memory store." FALSE.** The test asserts against `servers.json`, and
  `backend-v2.js` does carry a comment saying the store is the in-memory truth and the file only its
  persistence — which makes this the obvious reading. But the harness sets
  `AGENT_JSON_WRITE_BATCH_MS=0`, and `saveJson` takes the `jsonWriteBatchWindowMs <= 0` branch
  straight to `writeJsonAtomic`. Writes are synchronous in tests. Switching the assertion to
  `serversForTest` would have been a speculative fix that removed persistence coverage.
- **"It reproduces under CPU load." NO.** 37 local rounds — 12 idle, 25 against 16 concurrent busy
  loops on a 16-core machine — produced zero divergence between memory and file.
- **"It reproduces under whole-suite conditions." NO.** A probe was run inside a full-suite pass (the
  suite is `fileParallelism: false, maxWorkers: 1`, so one process, serial files, shared
  `process.env`) and diverged in none of 6 rounds. `api-server-heartbeat.test.js` itself passed 24/24
  in that run.

So the mechanism is still unidentified, and it remains consistent with the harness-lifecycle reading
above rather than with anything in the test's data. What DID come out of the investigation was a
separate, certain defect in the test, described in the rewrite's own comment: it made the lease stale
with a 100ms TTL plus `sleep(200)` — the exact pattern `backend-v2.js` already names in this file as a
flake source — and it sent a NEWER `bootTs`, which `evaluateHeartbeatLease` accepts as `newer-boot`
against a perfectly active lease. The assertion therefore passed whether or not the lease had gone
stale, so the case never exercised the branch it is named for.

The rewrite makes staleness deterministic by ageing `heartbeatAt` through `serversForTest`, and sends
an OLDER `bootTs` so that an active lease must answer 409 `older-boot` — which means a 200 can only
come from the stale-lease branch. A control case asserts that 409. Five mutants killed, including
`hasActiveLease` pinned to each constant. Whether this also removes the flake is unknown and is not
claimed: the timing margin it removes is a plausible contributor, not a demonstrated cause.

**A third shape, and it fits the same reading.** A 30-second TIMEOUT, whole-suite only, clean in
isolation. A test that hangs rather than asserting wrongly is what a request that never gets a
response looks like from the caller's side — the same event the `Parse Error` specimens show from
the socket's side and the `404` specimens show from the router's. Three shapes, one mechanism: the
harness's server lifecycle, not any test's data.

**A second same-run pair, in the same two shapes.** The last two rows also arrived together in one
whole-suite pass and were clean in isolation immediately after (41/41) — again one transport error and
one `expected 404 to be 200`, again in two unrelated files. That is now twice that the two shapes have
co-occurred, which is the strongest evidence yet for the single-mechanism reading below rather than
for two independent bugs. Neither file was touched by the change under test in either sighting.

The 2026-08-12 pair landed in ONE run, and that is the useful part: a transport error and a
`expected 404 to be …` in the same whole-suite pass, both files clean in isolation (24/24). The
second shape is the one this document has been recording since the beginning and attributing to
seeding or module state; seeing it beside a socket error, in the same run, is what a single
mechanism looks like from two angles.

**The first real specimens, and they change the shape of the problem.** Neither is an assertion
failure. Both are TRANSPORT errors from supertest's own socket: one is the HTTP parser refusing a
response that did not begin with a status line, the other a connection reset mid-read. Both files
passed together in isolation immediately afterwards (52/52).

That points somewhere different from every theory recorded above. `expected 404 to be 200` invited
explanations about seeding, ordering and module state; `Expected HTTP/, RTSP/ or ICE/` cannot be any
of those — the request reached a listening socket and what came back was not a valid HTTP response.
The candidates it does admit: an in-process server torn down by `cleanup()` while a request is still
in flight, a socket reused after close, or a response written after the connection went away. All
three are properties of the harness's server lifecycle rather than of any test's data.

The third specimen looked like a different mechanism and is probably the same one. `readJson(...).s1`
being undefined suggests a write race, so the obvious hypothesis was the JSON write batcher — and it
is WRONG: `batchedFiles` is `['agents.json', 'agent_runtime.json']`, so `servers.json` writes
immediately with no debounce window to lose. Checked before it went in the log, and recorded here
because it is the theory anyone would reach for next.

What remains fits all three: a REQUEST failed at the transport layer, and the symptom depends only on
what the test did with the result. Where the assertion was on the response, it surfaced as a parse
error or a reset; where an earlier request had created the state a later line reads, it surfaced as a
TypeError on something missing. That also explains why the failures look unrelated and land in a
different file each time.

Two things follow. The flaky set is probably ONE mechanism rather than the per-file coincidence the
context-count theory kept suggesting — and it is checkable, because a lifecycle bug leaves evidence:
whether `cleanup()` awaits the server's close, and whether any context outlives the test that made
it. Worth doing before another round of memory measurement.

Method note that made this possible: the run was `npx vitest run 2>&1 | tee <log>`, so the specimens
survived. The previous entry was lost to a run filtered to summary lines.

The `alert-store` sighting is recorded as a **failure of method, not just a new data point**: this
section exists because ~25 observations kept only the failing title, and this one kept only the
failing title too. It happened during unrelated work (the ADR-014 credential change), the suite was
run with output filtered to summary lines, and by the time the failure was noticed the assertion
diff had already scrolled. Passed twice in isolation straight after; nothing in that change touches
alerts, agent tokens, or the backend.

The lesson is narrow and worth stating: **filtering a full-suite run's output to the summary line
throws away the only specimen you were going to get.** Run `scripts/flake-hunt.sh` when the goal is
to catch a flake, and tee the output when it is not — a filtered run can only ever tell you that the
problem still exists, which is already known.

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
