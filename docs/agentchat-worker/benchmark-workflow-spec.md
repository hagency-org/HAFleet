# Agent Benchmark Workflow Spec

## Goal
Benchmark the `agent-chat` agent system itself in dev, not a generic CLI baseline.

The benchmark target is a versioned `agent profile`, consisting of:
- Claude Code behavior
- profile documents (`CLAUDE.md`, `AGENTS.md`, role/boundary docs)
- agent-scoped config (MCP/hooks/runtime knobs)
- subconscious mode/config
- resulting task performance

This benchmark must run in a clean dev workflow without disturbing human-operated agents or live services.

## Non-Goals
- Do not benchmark the currently running `Yato` session directly.
- Do not depend on Docker as the primary agent execution environment.
- Do not claim full Letta parity; subconscious remains whatever the current real implementation truthfully is.
- Do not make live changes as part of benchmark execution.

## Core Decision
Use `agent-up` and isolated agent homes on the host machine to run benchmark trials.

Reasoning:
- Current real agent system is host-based and login-state sensitive.
- Claude Code / Codex login state is awkward and fragile to reproduce inside Docker.
- The benchmark should measure the real `agent-chat` stack, not a simplified container-only surrogate.
- Existing `v1` home isolation already gives a workable boundary for benchmark trials.

## Benchmark Object Model

### 1. Agent Profile Version
A benchmarkable `agent profile version` is the canonical unit under test.

A profile version should capture:
- profile id: e.g. `yato`
- version: e.g. `1.0.0`
- model family defaults
- docs bundle:
  - `CLAUDE.md`
  - `AGENTS.md`
  - role/boundary docs
  - project/identity docs if needed
- agent-scoped config bundle:
  - `.claude/settings.json` template
  - `.mcp.json` template or equivalent MCP config template
  - hooks/runtime config defaults
- subconscious defaults:
  - enabled/disabled
  - runtime contract defaults
  - memory mode metadata
- metadata:
  - description
  - changelog/notes
  - createdAt

Important distinction:
- profile version = reusable, versioned input
- trial state = runtime output/artifacts

### 2. Benchmark Run
A benchmark run is a user-created evaluation request.

Fields:
- run id
- createdAt
- createdBy
- profile id + version
- agent type (`claude-code` first; later maybe codex)
- model override
- subconscious mode
- task set
- attempts / self-correction knobs
- status (`queued`, `running`, `completed`, `failed`, `partial`)
- output root
- summary metrics

### 3. Benchmark Trial
A trial is one task-attempt execution unit.

Fields:
- run id
- trial id
- task id
- attempt index
- agent home path
- workdir path
- output path
- runtime status
- start/end timestamps
- pass/fail/score fields
- artifact paths

## Execution Model

### Environment
Run benchmark trials in dev only.

Use:
- development repo: `~/laplace/agent-chat`
- benchmark runtime root: separate from current dev runtime

Recommended new root:
- `~/laplace/agent-chat-bench-runtime`

This avoids mixing benchmark trial artifacts with:
- human-operated dev agents
- current `agentchat-dev` stack runtime data

### Trial Bring-Up
Each trial should:
1. create a fresh benchmark agent home
2. materialize the selected profile version into that home/workdir
3. start the benchmark agent via `agent-up` or a benchmark-focused equivalent wrapper
4. execute the benchmark task
5. collect results and artifacts
6. mark the trial complete while preserving artifacts for inspection

Important constraint:
- benchmark agents must be separate agents, not existing interactive agents reused in place

### No-Docker Primary Path
Do not make Docker the primary agent runtime path.

Acceptable use of Docker:
- task preparation inherited from the benchmark dataset/harness
- test environments provided by task definitions

Not acceptable as the main control path:
- relying on containerized Claude/Codex login state for the real benchmarked agent runtime

## Integration with LongCLI-Bench
LongCLI-Bench is still useful, but not as-is.

Reuse:
- task corpus
- task metadata
- evaluation logic
- result formats where helpful

Do not rely on unchanged built-in adapters for the real target benchmark.

Reason:
- built-in `claude-code` adapter launches a fresh generic Claude Code CLI process
- that does not measure the `agent-chat` profile/doc/subconscious stack

Required integration direction:
- add an `agent-chat` aware benchmark runner / adapter
- feed tasks into isolated benchmark agents created by `agent-up`
- collect benchmark metrics plus agent-side artifacts

## Result Collection
Each trial must preserve enough evidence to answer both:
- did the task pass?
- what did the agent system do internally?

Required artifacts per trial:
- benchmark harness result json
- task result summary
- transcript/logs
- profile snapshot used for the trial
- agent manifest snapshot
- `state/letta.json`
- `state/subconscious/runtime.json`
- `state/subconscious/memory.json`
- subconscious events slice for that trial
- any generated patch/output files

## Web Presentation
Benchmark results need a first-class UI.

### Benchmark Runs page
Show:
- runs list
- profile version
- agent type/model
- subconscious mode
- task count
- pass rate / step scores
- status
- duration

### Benchmark Run Detail
Show:
- run configuration
- aggregate metrics
- trial table
- links into each trial detail
- comparison hooks for later profile-vs-profile views

### Trial Detail
Show:
- task info
- status/score
- artifacts
- transcript/logs
- subconscious state/output during the run
- memory file summary
- profile snapshot summary

The benchmark UI should remain separate from normal agent operations UI, but use the same visual system.

## Safety / Isolation Rules
- dev-only
- no live services touched
- no reuse of currently active human-work agents
- one trial = one fresh agent home
- benchmark runtime root separate from normal dev runtime root
- preserve artifacts unless explicitly cleaned up later

## Proposed Storage Layout
Suggested initial layout under dev runtime umbrella:
- `~/laplace/agent-chat-bench-runtime/`
- `~/laplace/agent-chat-bench-runtime/profiles/<profile-id>/<version>/...`
- `~/laplace/agent-chat-bench-runtime/runs/<run-id>/run.json`
- `~/laplace/agent-chat-bench-runtime/runs/<run-id>/trials/<trial-id>/...`
- `~/laplace/agent-chat-bench-runtime/homes/<trial-agent-id>/...`

## Phased Delivery Plan

### Batch 1 — Foundations
Scope:
- profile version schema + storage layout
- benchmark run/trial schema
- benchmark runtime root scaffolding
- host-based benchmark execution design wired into dev codebase
- no full UI yet; minimal inspectable state is enough

Acceptance focus:
- can define a benchmark profile version
- can create a benchmark run record in dev
- can materialize isolated benchmark home/output directories without touching normal dev agents

### Batch 2 — Trial Bring-Up
Scope:
- create trial agents from profile versions
- start benchmark trial agents via `agent-up`-based flow
- execute one smoke task in isolation
- collect result bundle/artifacts

Acceptance focus:
- one complete smoke trial runs end-to-end in dev
- artifacts are saved in the benchmark runtime root
- current human/dev agents remain unaffected

### Batch 3 — LongCLI Integration
Scope:
- adapt task ingestion/evaluation flow from LongCLI-Bench
- map benchmark tasks into the agent-chat benchmark run/trial system
- support at least single-task and small-batch runs

Acceptance focus:
- benchmark can run a real LongCLI task via the agent-chat trial system
- result summary and artifacts are coherent

### Batch 4 — Benchmark UI
Scope:
- `Benchmark Runs` page
- `Run Detail` page
- `Trial Detail` page
- result artifact visibility

Acceptance focus:
- human can inspect benchmark runs/trials from web without digging through filesystem logs

### Batch 5 — Comparison / Operational Refinement
Scope:
- compare profile versions
- compare subconscious on/off variants
- improve retry/reporting/cleanup behavior

Acceptance focus:
- benchmark outputs support meaningful comparison between profile/system variants

## Immediate Next Step
Start with Batch 1 only.

Reason:
- it is the smallest batch that freezes the model and directory/schema contracts
- it prevents `agentchat-develop` from overbuilding UI or execution paths before the benchmark object model is stable
