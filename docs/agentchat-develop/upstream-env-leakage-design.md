# Upstream Letta Env Leakage Design

## Scope
Design only for audit finding `#1`.

In scope:
- upstream Letta cross-request env leakage in `lib/upstream-claude-subconscious.js`
- canonical per-request / per-agent env boundary
- concurrency model
- smallest safe implementation order

Out of scope:
- findings `#2` through `#7`
- intermittent Matrix / bridge timeout residual
- broader supervisor or UI changes

## Accepted 1-7 Triage Split

### Structural / Control-Plane
1. upstream Letta cross-request env leakage via `runWithUpstreamEnv()` mutating process-global `process.env`
2. supervisor sweep starvation / no fairness rotation
3. done-task false negatives / negative streak accumulation after idle
4. dead supervisor flags exposed without enforcement
5. copy-unsafe `audit:agent-docs --active`

### Release / Deploy Hygiene
6. remote package mirror drift
7. dependency advisory policy gate failures

## Why Finding #1 Is First
`runWithUpstreamEnv()` mutates process-global `process.env` and then performs async imports plus async upstream work. That makes the isolation boundary process-wide instead of request-scoped.

Blast radius:
- concurrent per-agent upstream bootstrap/session/user-prompt/pretool/stop flows
- incorrect `HOME` / `LETTA_HOME` / `LETTA_PROJECT`
- incorrect `LETTA_AGENT_ID` / `LETTA_MODEL` / `LETTA_API_KEY`
- cross-agent contamination of upstream state and external Letta calls

This is the only finding in the set that can directly corrupt another agent's accepted upstream subconscious path.

## Current State
Current branch state already contains a narrow mitigation: a process-local serialization gate around `runWithUpstreamEnv()`.

That mitigation is useful but not the final structural contract because:
- it preserves correctness by preventing overlap, but only by reducing concurrency to one upstream flow at a time per backend process
- it keeps the process-global env mutation model alive
- it does not create an explicit canonical request boundary that other maintainers can reason about safely

So the final fix should remove request-path dependence on mutating backend-global `process.env`.

## Canonical Boundary
The canonical boundary should be:
- one upstream request context per operation
- one isolated execution environment per request context
- no mutation of backend-global `process.env` on the live request path

Required properties:
- per-request `HOME` and `LETTA_HOME`
- per-request `LETTA_PROJECT`
- per-request `LETTA_BASE_URL`, `LETTA_API_KEY`, `LETTA_AGENT_ID`, `LETTA_MODEL`, `LETTA_CONTEXT_WINDOW`
- no visibility of one request's env values from another request
- deterministic cleanup after the request completes

## Preferred Structural Model
Use a dedicated subprocess boundary for upstream operations.

Reasoning:
- the upstream reused scripts are env-driven today
- rewriting upstream helper internals to thread explicit config objects through every imported function is higher-risk and larger-scope
- a subprocess gives a true OS-level env boundary immediately
- subprocess env isolation preserves concurrency without backend-global locking

### Canonical shape
- backend builds an explicit request payload
- backend spawns a short-lived upstream runner process for exactly one operation
- backend passes the request env only to that child process
- child process imports upstream scripts and performs the requested operation
- child returns structured JSON result on stdout
- backend never mutates `process.env` for upstream request handling

## Concurrency Model
Target model:
- concurrent upstream requests are allowed
- isolation is by child process, not by in-process lock
- each request owns its env and durable-home boundary independently

Non-goal:
- shared in-process concurrent access to env-driven upstream imports

Interim model already present:
- one-at-a-time serialization in the backend process

That interim model should stay only until the subprocess runner is proven.

## Smallest Safe Implementation Order
1. Keep the current serialization gate as a temporary correctness backstop.
2. Add a single-purpose upstream runner entrypoint, for example under `scripts/` or `lib/`, that:
   - reads one JSON request
   - sets child-local env only
   - imports the upstream scripts inside that child
   - executes one named operation
   - prints one JSON result
3. Migrate one upstream operation family first, starting with the common path used to prove isolation safely:
   - bootstrap and session-start first
4. Verify that concurrent requests with different agent/env bindings no longer serialize incorrectly and no longer require parent env mutation.
5. Move remaining upstream operations onto the same runner:
   - user-prompt
   - pretool
   - stop
6. Remove parent-process env mutation from `runWithUpstreamEnv()` entirely or delete that helper if no longer needed.
7. Keep one focused concurrency proof as a regression test fixture or scripted proof.

## Minimum Proof For The Later Implementation Slice
A later implementation should not be accepted without all of these:

1. Two concurrent upstream requests for different agents run successfully with distinct:
- `LETTA_AGENT_ID`
- `LETTA_HOME`
- `LETTA_PROJECT`

2. Each request returns only its own env-observed values.

3. Parent backend `process.env` remains unchanged before and after the requests.

4. The accepted upstream slices still function through the new boundary:
- SessionStart
- UserPromptSubmit
- PreToolUse
- Stop

5. The current serialization gate can be shown to be unnecessary for correctness once all routes are migrated.

## Rejected Alternatives
### Keep serialization as the final answer
Rejected because it fixes overlap by sacrificing concurrency while leaving the unsafe global-env model in place.

### Patch only imports but keep env mutation around calls
Rejected because the upstream scripts perform async work after import; partial removal still leaves cross-request contamination risk.

### Rewrite upstream reused scripts to take explicit config objects first
Rejected as the first move because it is broader, riskier, and crosses the current reuse boundary with the upstream package.

## Resulting Recommendation
The next implementation slice for finding `#1` should be:
- replace backend request-path env mutation with a subprocess runner boundary
- keep the current serialization gate only as temporary protection until the runner migration is complete
- migrate one upstream path family first, prove concurrent isolation, then expand
