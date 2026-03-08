## Role
- I am `agentchat-develop` (Codex) for the `agent-chat` repository.
- Core focus:
  - Implement and verify concrete code changes for supervisor audit, backend APIs, and related tooling in this repo.
  - Execute delegated implementation tasks from `agentchat-worker` with command-level validation evidence.
- Adjacent focus:
  - Improve developer workflows and scripts that increase audit signal quality and reduce false skips.

## Boundaries
### Must do
- Follow workspace bootstrap/state workflow in `AGENTS.md`.
- Keep supervisor behavior non-intrusive (web + matrix notice only; no agent control).
- Verify behavior after changes using commands, API responses, logs, or service checks.

### Must not do
- Perform destructive git resets/checkouts.
- Make unrelated refactors while delivering current task.
- Modify other agents' docs directories directly; use shared tooling and coordination channels instead.

## Operational Knowledge
- Supervisor doc extraction should treat nested headings (`###`) as part of a `## Role/Boundaries/Current` block; stopping on any heading causes false `missing-doc-sections`.
- `audit:agent-docs -- --active` should mirror supervisor candidate filters (`online + tmux + activeNow + not blocked`) to avoid inflated false-fail coverage reports.
- Auto-discovered agents can lack `data/agents/{agent}/meta.json`; runtime-reported `workspacePath` provides a reliable docs resolution fallback.
- Workspace resolution precedence for supervisor docs lookup must be stable-first: `meta workspace path` > `runtime workspace path` fallback; runtime path should not override meta when both exist.
- Delivery policy (operator update via `agentchat-worker`, 2026-03-04): local commits can be frequent, but `git push` should happen only after a full feature closure (`implementation + verification + docs + self-check`), except urgent production hotfixes.
- Local `curl` checks can be transparently routed through a proxy and return misleading `502`; use `curl --noproxy '*'` for localhost supervisor/API verification.
- v1 docs discovery must support flat `workdir/docs/` (`AGENTS.md` or `agents.md` + `plan.md`) before legacy `docs/{agent}/` fallback.
- `agentchat up-v1` is the provisioning entrypoint for new home-based agents and must refuse implicit conversion of legacy `0.x` metadata.
- v1 compatibility currently keeps `data/agents/{name}/meta.json` but points runtime files to `state/` via symlinked `resume-id` and `tmp`.
- Fresh isolated v1 homes can lack `data/agents/{name}/` even when `agent.json` already exists; any manifest-to-compat-meta sync must `mkdir` the parent before writing `meta.json` or fresh-home control-plane writes will fail with `ENOENT`.
- V1 `managedProjects` imports should reuse `scripts/provision-v1-agent-home.js` rather than duplicating copy/symlink logic in the web layer, so `workdir/projects/` materialization semantics stay aligned with provisioning and reprovision behavior.
- Legacy agent docs lookup must never prioritize generic `<workspace>/docs/` over `<workspace>/docs/{agent}`; generic docs can be unrelated and cause false supervisor/audit reads.
- V1 Claude subconscious wiring uses `scripts/configure-v1-subconscious.js` to sync hook runtime into `<stateDir>/subconscious/claude-agentchat`, merge hooks into `<workdir>/.claude/settings.json`, and persist/reuse per-agent Letta identity in `<stateDir>/letta.json`.
- Runtime data paths in `backend-v2.js`/`server.js` resolve from process CWD (`path.resolve('data')`), so safe parallel-dev validation should run from a separate checkout/workdir plus non-live ports.
- Runtime/code split model uses `AGENT_CHAT_RUNTIME_DIR` for mutable state roots (`data/`, `logs/`) while repo-owned assets/scripts must resolve from code root (`import.meta.url` / script dir), not runtime root.
- In this environment, `claude mcp add ...` can be blocked by enterprise policy (`enterprise MCP configuration is active and has exclusive control`), so MCP alias additions may need external admin changes instead of local CLI setup.
- `GET/POST /api/supervisor/control` is a stack-global supervisor audit control, not an agent-scoped setting; any Agent Detail UI must label that scope explicitly.
- Agent Detail top-of-page runtime summary must not present supervisor-derived task/status as first-class runtime health; supervisor data should stay explicitly labeled as docs snapshot or supervisor signal.
- Current subconscious observability payload from `/api/subconscious/events/:name` is hook-level telemetry plus `guidancePresent`; it does not include a normalized derived-summary or recognition/judgment object.
- The current Claude subconscious hook runtime does not call a Letta server or LLM; it reads a persisted `guidance` string from `state/letta.json`, posts hook events, and injects that static text back into eligible Claude hooks.
- Safe subconscious truthfulness contract in dev: hook runtime, hook bindings, event sink, and manual guidance file are real; backend reasoning runtime, model config, memory store semantics, and Letta/LLM invocation are not configured.
- Delivery standard from `agentchat-worker` overnight review: optimize for whole-plan convergence and end-state clarity, not narrow single-issue wins that leave adjacent ambiguity unresolved.
- `scripts/configure-v1-subconscious.js` must derive the subconscious invoke URL from the effective event URL (or explicit invoke env) to avoid silently falling back to live-port defaults during dev/runtime isolation.
- `PATCH /api/agents/:name/subconscious-guidance` must preserve existing `letta.json` runtime contract and last-invocation metadata; otherwise manual-guidance edits will wipe real runtime state.
- Successful subconscious runtime invokes must not persist env/default-resolved provider/model/endpoint/key-env values back into `state/letta.json`; doing so collapses truthful `configSources` from `subconscious-env/default` back to `state` after first use.
- Benchmark workflow foundations use a separate `AGENT_CHAT_BENCH_RUNTIME_DIR` (default `/home/shisui/laplace/agent-chat-bench-runtime`) with isolated trial homes under `<benchRoot>/homes/agents/*`; benchmark scaffolding must not write into the normal `AGENT_CHAT_RUNTIME_DIR`.
- `scripts/provision-v1-agent-home.js` now supports `--subconscious-enabled true|false`; benchmark trial materialization should use that explicit override instead of assuming every Claude profile has subconscious enabled.
- Benchmark trial launch plans must carry both `AGENT_CHAT_RUNTIME_DIR=<benchRoot>` and the dev backend/subconscious URL env (`AGENT_CHAT_API`, `AGENT_CHAT_BACKEND_PORT`, `AGENTCHAT_SUBCONSCIOUS_EVENT_URL`, `AGENTCHAT_SUBCONSCIOUS_INVOKE_URL`); otherwise `agent-up` and subconscious provisioning will silently fall back to the normal runtime tree or `8090`.
- Some upstream `longcli-bench` tasks are not usable proof tasks as-is because their checked-in `run-tests.sh` contains malformed bare text instead of shell commands; task selection must be validated before using a task as benchmark evidence.
- Valid LongCLI tasks can still require evaluator payloads beyond `/tests/run-tests.sh` plus `/tests/tests/*`; `cmu15_445_p0` specifically expects `/tests/test` and flat `/tests/f2p.py` / `/tests/p2p.py`, and it also fails if the evaluator reuses an incompatible build cache path.
- When a benchmark-owned trial agent stays active past the evaluation boundary, `agentchat down --kill` can refuse to stop it; the reliable fallback is direct tmux session termination plus an explicit backend offline mark for that benchmark agent.
- For LongCLI evaluation, `docker cp <testsDir> container:/tests` nests fixtures as `/tests/tests/*`; to satisfy task families like `cmu15_445_p0`, the harness must copy individual entries so `/tests/test`, `/tests/f2p.py`, and `/tests/p2p.py` exist at the exact paths expected by `run-tests.sh`.
- The LongCLI evaluator must scrub benchmark-agent build artifacts both before Docker build (remove `<project>/build` and task-injected `<project>/test` from the workdir) and again inside the container before `run-tests.sh`; otherwise stale `CMakeCache.txt` path state leaks into evaluation.
- `scripts/configure-v1-subconscious.js` now provisions an explicit conversation journal at `<stateDir>/subconscious/conversations.json`, and backend/runtime detail should treat it as persisted transcript-backed session bookkeeping rather than hidden reasoning state.
- For Qwen parity, the blocker to verify first is dev env wiring into the running backend process: if the runtime contract points at `keyEnv=DASHSCOPE_API_KEY` but that env var is absent from `/proc/<backend-pid>/environ`, `/api/subconscious/runtime/invoke/:name` will truthfully return `disabledReason: missing API key env DASHSCOPE_API_KEY` before any provider-level auth check.
- Subconscious conversation journal fields for `lastRuntime*` and `latestGuidance*` must only advance on a successful runtime/guidance update; failed or no-guidance events must not overwrite the last successful snapshot.
- The repo-local [`.env`](/home/shisui/laplace/agent-chat/.env) already carries `DASHSCOPE_API_KEY`; if detached dev backend/web sessions are launched as raw `node backend-v2.js` / `node server.js` without sourcing `.env`, the running processes will miss DashScope credentials even when the secret exists on disk.
- In the current dev secret layout, `SUBCONSCIOUS_LLM_KEY` is not interchangeable with DashScope/Qwen; driving `qwen-plus` with that DeepSeek key reproduces DashScope HTTP 401 `invalid_api_key`, while `DASHSCOPE_API_KEY` from the repo `.env` succeeds.
- Direct upstream `claude-subconscious` integration in `agent-chat` isolates upstream durable state per agent by setting `HOME`/`LETTA_HOME` to `<stateDir>/subconscious/upstream-home`; that keeps upstream `config.json` and `.letta/claude/conversations.json` from bleeding across agents.
- The direct-upstream slice reuses upstream `Subconscious.af`, `agent_config.ts`, `conversation_utils.ts`, and `transcript_utils.ts`; the live bootstrap route truthfully reflects whichever external Letta config is loaded in the running backend process.
- Upstream bootstrap binding priority must be: explicit request `lettaAgentId` first, then process `LETTA_AGENT_ID`, then previously stored upstream agent id; otherwise stale imported-agent state can shadow the intended real Letta binding.
- Upstream session/conversation cutover should persist the reused/created `conversationId` and session file even when the upstream session-start message send fails; otherwise a Letta-side error after conversation creation can crash the backend and hide the real state boundary.
- For upstream SessionStart truthfulness, lifecycle state must be derived from persisted upstream `sessionId` + `conversationId` presence, while notify/send failure must live in a separate substatus; collapsing both into one `status` field causes false regression back to the local transitional stage.
- Subconscious detail derivation must prefer the real bound Letta id from `state/letta.json` over imported/stale upstream `config.json` agent ids, and it must derive current upstream session state from durable conversation/session files when transient `runtimeMeta.upstream.*` fields were reset by reprovision or restart.
- Agent Detail subconscious UI must present upstream Letta lifecycle and local transitional runtime as separate paths; a degraded local runtime must not imply that upstream Letta is unavailable when upstream session state is established.
- The v1 home Claude-workspace contract now uses a maintained template source-of-truth at `docs/workspace-claude-md-template.md` (`Template-Version: v1`), generates `workdir/CLAUDE.md`, and keeps `workdir/docs/CLAUDE.md` as a compatibility symlink; reprovision can auto-upgrade the old inline stub when it matches the legacy generated text.
- The v1 workspace-entry contract now treats root `workdir/AGENTS.md` and root `workdir/CLAUDE.md` as the primary entry files; `workdir/docs/AGENTS.md` and `workdir/docs/CLAUDE.md` are compatibility symlinks, while `docs/` is reserved for support/history files like `plan.md`, `progress.md`, and `projects.md`.
- Existing-home root-entry migration can safely reuse `scripts/provision-v1-agent-home.js`: known/generated `docs/AGENTS.md` / `docs/CLAUDE.md` are converted into compatibility links, while hand-edited docs files are preserved and new root entry files are created alongside them.
- Managed-project lifecycle now supports explicit removal via the web control-plane; `deleteFiles=true` is only truthful/safe for paths under `workdir/projects`, where copied directories are deleted and symlinked entries are unlinked without touching the origin path.
- Managed-project `deleteFiles:false` means untrack only; the on-disk directory remains under `workdir/projects`, so a same-name re-import will truthfully fail until the leftover path is removed or a different project name is chosen.
- Upstream Letta model selection must normalize env aliases like `GLM-5` to the canonical Letta handle before persistence; otherwise the raw alias can be written back into `llm_config.handle/model` and reintroduce the `model-unknown` SessionStart notify blocker.
