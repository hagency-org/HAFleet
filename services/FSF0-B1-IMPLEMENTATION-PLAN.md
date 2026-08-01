# FSF-0B1 Agent-Chat Supervised Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo's manual infrastructure startup with one deterministic
local supervisor profile and one team Compose profile for backend, dashboard,
Matrix bridge, and relay, while proving registry persistence and registry-owned
dashboard roster behavior.

**Architecture:** A validated JSON profile describes the four service commands,
dependencies, and bounded health probes. A Node supervisor owns child-process
restart loops and writes an atomic runtime snapshot; a CLI starts the supervisor
as a detached process and provides bounded `status`, `doctor`, and `stop`
commands. Team deployment builds the same source once and runs the four commands
as separate Compose services. Existing systemd and tmux paths remain available.

**Tech Stack:** Node.js 22 ESM, `node:child_process`, atomic JSON files, Vitest,
Docker Compose.

## Global Constraints

- Allowed changes are only `services/**`, `src/**`, and `tests/**`.
- Do not change the Matrix command vocabulary.
- Do not remove the existing tmux or systemd paths.
- Default tests must not start Claude, Codex, Palpo, or any remote service.
  Production-entry smoke tests use an isolated runtime and a local Matrix socket.
- Status and doctor probes must have bounded timeouts and redact environment
  secrets.

---

### Task 1: Validated Service Profile

**Files:**
- Create: `services/services-local.json`
- Create: `src/service-profile.mjs`
- Test: `tests/service-profile.test.js`

**Interfaces:**
- Consumes: repository root plus a JSON profile path.
- Produces: `loadServiceProfile({ profilePath, repoRoot })` returning a frozen
  `{ name, services }` object with exactly `backend`, `dashboard`, `bridge`, and
  `relay` in dependency order.

- [x] **Step 1: Write failing validation tests**

Cover exact service set, duplicate/missing names, unsafe commands, paths outside
the repository, dependency cycles, unsupported health types, and timeout bounds.

- [x] **Step 2: Observe the missing-module failure**

Run: `npx vitest run tests/service-profile.test.js --no-file-parallelism --maxWorkers=1`

Expected: FAIL because `src/service-profile.mjs` does not exist.

- [x] **Step 3: Implement loader and local profile**

Use structured command arrays, allow only `process`, `tcp`, and `http` health
types, require probe timeout `100..4000` ms, topologically order dependencies,
and reject repository path escape. The production profile maps:

```text
backend   -> node backend-v2.js     -> HTTP /health
dashboard -> node server.js         -> TCP HAFLEET_WEB_PORT
bridge    -> node bridge-matrix.js  -> process + backend dependency
relay     -> node push-relay.js     -> process + backend dependency
```

- [x] **Step 4: Run profile tests**

Expected: PASS.

### Task 2: Local Supervisor and Operator CLI

**Files:**
- Create: `src/local-service-supervisor.mjs`
- Create: `services/hafleet-services.mjs`
- Create: `tests/fixtures/service-child.mjs`
- Test: `tests/local-service-supervisor.test.js`

**Interfaces:**
- Produces: `LocalServiceSupervisor`, `readServiceStatus`, and
  `diagnoseServices`.
- Runtime files: `<runtime>/data/services-local/{supervisor.pid,state.json}`.
- CLI: `node services/hafleet-services.mjs start|run|status|doctor|stop`.

- [x] **Step 1: Write failing process tests**

Use four fixture children and ephemeral ports. Cover ordered startup, all-four
healthy status, automatic restart after relay crash, stopped bridge diagnosis,
status completion under five seconds, state-file atomicity, PID reuse guard,
and secret-free JSON output.

- [x] **Step 2: Observe missing supervisor failure**

Run: `npx vitest run tests/local-service-supervisor.test.js --no-file-parallelism --maxWorkers=1`

Expected: FAIL because the supervisor module is absent.

- [x] **Step 3: Implement supervisor core**

Spawn commands without a shell, start only after dependencies are healthy,
restart unexpected exits with bounded backoff, preserve explicit stop state,
write snapshots through temp-file rename, and terminate children in reverse
dependency order. Probe process/TCP/HTTP health with `AbortSignal.timeout` or
socket timers.

- [x] **Step 4: Implement CLI**

`start` detaches `run`, waits for a healthy state deadline, and exits non-zero
with doctor output on failure. `status --json` and `doctor --json` never wait
longer than the configured total deadline. `stop` validates the supervisor PID
record before signaling it.

- [x] **Step 5: Run supervisor tests**

Expected: PASS and no fixture process remains.

### Task 3: Registry Persistence and Dashboard Roster

**Files:**
- Modify: `tests/backend-lifecycle.test.js`
- Modify: `tests/server-dashboard-boundary.test.js`

**Interfaces:**
- Consumes: existing `agents.json` registry and dashboard `/api/agents/all`
  backend proxy.
- Produces: direct evidence for `restart_preserves_agent_registry` and
  `dashboard_roster_matches_registry`; no new state store.

- [x] **Step 1: Add backend restart test**

Create three registry records in one temporary runtime, close the first backend
test context, start a second context on the same runtime, and assert the exact
three names remain.

- [x] **Step 2: Add dashboard roster test**

Inject a backend response containing the registry records while the test PATH
contains a fake stale tmux session. Query `/api/agents/all` and assert only the
registry records are returned.

- [x] **Step 3: Run focused tests**

Run:

```bash
npx vitest run tests/backend-lifecycle.test.js tests/server-dashboard-boundary.test.js \
  --no-file-parallelism --maxWorkers=1
```

Expected: PASS.

### Task 4: Team Compose Profile

**Files:**
- Create: `services/Dockerfile`
- Create: `services/services-team.compose.yml`
- Test: `tests/services-team-compose.test.js`

**Interfaces:**
- Consumes: `.env`, external Matrix homeserver URL, and one persistent runtime
  volume.
- Produces: four separately supervised Compose services using the same command
  definitions and backend health dependency.

- [x] **Step 1: Write Compose contract test**

Assert exact service names, shared image/build, persistent runtime mount,
read-only source in the final image, backend healthcheck, dependency conditions,
restart policies, and absence of literal credentials.

- [x] **Step 2: Observe missing Compose failure**

Expected: FAIL because the files do not exist.

- [x] **Step 3: Implement image and Compose profile**

Use Node 22, `npm ci --omit=dev`, non-root runtime user, one named runtime
volume, `restart: unless-stopped`, backend HTTP health, dashboard TCP health,
and `service_healthy` dependency for bridge/relay/dashboard.

- [x] **Step 4: Validate Compose**

Run the Vitest contract plus:

```bash
docker compose -f services/services-team.compose.yml config --quiet
```

Expected: PASS without starting containers.

### Task 5: FSF-0B1 Acceptance Selectors

**Files:**
- Create: `tests/fsf0-b1-services.test.js`
- Modify: `services/FSF0-B1-IMPLEMENTATION-PLAN.md`

**Interfaces:**
- Produces exact selectors: `services_start_all_healthy`,
  `restart_preserves_agent_registry`, `dashboard_roster_matches_registry`,
  `doctor_reports_stopped_bridge`, and `status_reports_crashed_service`.

- [x] **Step 1: Run exact selectors against production entries and temporary runtimes**

Run:

```bash
npx vitest run tests/fsf0-b1-services.test.js --no-file-parallelism --maxWorkers=1
```

The all-healthy selector launches the four production entry scripts on random
ports; the other lifecycle selectors use deterministic fixture children where
the scenario does not require a production entry. Expected: 5 passed, no
skipped selector and no residual child process.

- [x] **Step 2: Run all focused B1 tests and static checks**

Run profile, supervisor, backend lifecycle, dashboard boundary, Compose, and
selector tests together; then run `node --check` on new `.mjs` files and
`docker compose ... config --quiet`.

- [x] **Step 3: Validate the OpenFab task contract**

Run `agent-spec parse` and `agent-spec lint --min-score 0.7` on
`specs/phase1/fsf0-b1-hafleet-services.spec.md`; expected quality 100%.

- [ ] **Step 4: Present for user testing**

Do not commit. Report exact `start`, `status`, `doctor`, and `stop` commands,
plus tests and any unverified real Matrix dependency.
