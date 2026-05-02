# Audit Findings

Date: 2026-05-02

Status: collection in progress.

This file will hold consolidated findings after subagent reports return. Each accepted finding must include:

- Severity
- File and line
- Impact
- Evidence
- Fix direction
- Verification

## Findings

- [Critical] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:8837) Anonymous group message reads can advance another agent's group cursor.
  Impact: Any caller can choose `agent=<name>` and mark that agent's group messages delivered/read, corrupting the agent's memory boundary.
  Evidence: The group message route uses query identity and can save cursor state without `requireAgentToken`.
  Fix: Require bearer or the target agent token for any read with an `agent` query; require target agent token for any cursor advancement.

- [Critical] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:8636) Message details are publicly readable.
  Impact: Full chat memory can leak through `GET /api/messages/:id`; `/msg/:id` also exposes an HTML rendering path.
  Evidence: The message detail routes are unauthenticated, while messages are core private kernel state.
  Fix: Require sender/recipient/group-member agent token or bearer; sanitize HTML rendering or remove public rendering.

- [Critical] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:166) Agent-token auth is fail-open by default.
  Impact: A local or network caller can impersonate managed agents when token mode is `audit` or no token exists.
  Evidence: `AGENTCHAT_AGENT_TOKEN_MODE` defaults to audit and missing expected tokens are treated as allowed.
  Fix: Make managed-agent core writes fail closed in production; keep audit/off only for explicit development or tests.

- [High] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:8572) Offline group mentions can be permanently hidden from inbox.
  Impact: An offline mentioned agent may never see a group mention after reconnecting, losing a chat fact.
  Evidence: Offline mention recipients can be put into `suppressedRecipients`, and inbox filtering excludes suppressed messages.
  Fix: Separate push-delivery suppression from inbox visibility; offline push skip must not mark message suppressed.

- [High] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:3437) Task graph result hooks can be spoofed by non-assignees.
  Impact: Any agent that knows or guesses graph/node identifiers can mark another node complete.
  Evidence: The hook accepts schema `graphId/nodeId` without validating `msg.from` against node assignee or dispatch message.
  Fix: Require node assignee match and preferably `reply_to` or a dispatch nonce.

- [Medium] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:3193) Task ownership has multiple truths.
  Impact: `agents[agent].task`, `tasks.json`, and `task_graphs.json` can diverge and make current commitments ambiguous.
  Evidence: The backend stores legacy agent task fields while also loading task store and task graph state.
  Fix: Declare `taskStore` canonical; demote agent task fields to mirrors or migrate them away.

- [Medium] [lib/notification-router.js](/Users/kamico/agent-chat/lib/notification-router.js:78) Aggregated alert cooldown can be persisted before notification flush.
  Impact: A process exit between buffer and flush can suppress an alert that was never sent.
  Evidence: Cooldown state is updated before aggregate dispatch.
  Fix: Persist cooldown after successful flush or make buffered notifications durable.

- [Low] [lib/agent-home-v1.js](/Users/kamico/agent-chat/lib/agent-home-v1.js:5) Relative paths are accepted after normalization.
  Impact: Agent home manifests have weaker path guarantees than the backend workspace path contract.
  Evidence: `path.resolve()` makes relative inputs absolute before the absolute-path check matters.
  Fix: Check `path.isAbsolute(trimmed)` before resolving.

- [High] [lib/push-relay-core.js](/Users/kamico/agent-chat/lib/push-relay-core.js:495) MCP presence detection is Linux-specific.
  Impact: macOS deployments can report `mcpPresent=false` even when an MCP process exists, degrading delivery/status behavior.
  Evidence: The detection path reads `/proc/<pid>/cmdline`, which is not available on default macOS.
  Fix: Use cross-platform `ps -p <pid> -o command=` or a shared pid/state contract.

- [High] [remote/bin/agentchat](/Users/kamico/agent-chat/remote/bin/agentchat:67) Remote CLI advertises missing commands.
  Impact: Remote users can run help-displayed commands such as `up-v1`, `project`, or `graph` and hit missing dispatch targets.
  Evidence: Remote help/dispatch references scripts that are not present under `remote/bin`.
  Fix: Include the target scripts in the remote package or remove commands from remote help/dispatch; audit dispatch targets.

- [High] [bin/agent-up](/Users/kamico/agent-chat/bin/agent-up:1749) Codex MCP launch auth may be incomplete for non-v1 agents.
  Impact: On authenticated backends, MCP tool calls can fail if Codex strips inherited environment and no explicit token is injected.
  Evidence: The explicit Codex MCP env injection omits `API_TOKEN`, while MCP core reads auth from environment or agent state.
  Fix: Coordinate with active launch work before editing; inject `API_TOKEN` explicitly or prefer per-agent tokens.

- [Medium] [lib/mcp-server-core.js](/Users/kamico/agent-chat/lib/mcp-server-core.js:73) MCP media cache writes under the current working directory.
  Impact: Agents running in project repos can create `data/mcp-media-cache` inside source trees.
  Evidence: Cache path uses `path.resolve('data', ...)` without runtime or state directory.
  Fix: Use `AGENTCHAT_AGENT_STATE_DIR/tmp/mcp-media-cache` first, then `AGENT_CHAT_RUNTIME_DIR/data/mcp-media-cache`.

- [Medium] [bin/agent-down](/Users/kamico/agent-chat/bin/agent-down:426) Forced local shutdown can be blocked by backend unavailability.
  Impact: Operators may be unable to stop a local tmux agent during backend outage even with `--kill`.
  Evidence: Backend activity checks run before the force-kill branch.
  Fix: Add an emergency local kill path, making backend offline marking best-effort.

- [Medium] [remote/bin/agent-up](/Users/kamico/agent-chat/remote/bin/agent-up:1680) Remote launch script has drifted from root launch behavior.
  Impact: Remote launch is more fragile and may leak launch parameters or break on special characters.
  Evidence: Remote script embeds key fingerprint into generated Python source and differs from root managed-MCP logic.
  Fix: Coordinate with active launch work before editing; regenerate remote package and enforce sync checks.

- [Medium] [bin/agent-service](/Users/kamico/agent-chat/bin/agent-service:87) Service CLI assumes bash 4 features.
  Impact: macOS default bash 3.2 can fail on associative arrays.
  Evidence: Script uses `declare -A` under `/usr/bin/env bash`.
  Fix: Replace associative-array dedupe with bash 3.2-compatible logic and run a macOS bash smoke check.

- [Low] [lib/push-relay-core.js](/Users/kamico/agent-chat/lib/push-relay-core.js:575) Tmux injection sequence is over-defensive.
  Impact: Fixed `Tab` and repeated submit keys can trigger completion, duplicate submission, or confirmation in the wrong CLI state.
  Evidence: The same key sequence is used for all agent CLIs.
  Fix: Prefer paste-buffer plus single submit and adapter-specific behavior by current command.

- [High] [server.js](/Users/kamico/agent-chat/server.js:32) Dashboard is an unauthenticated privileged proxy.
  Impact: If exposed beyond a single trusted localhost user, browser clients can mutate backend state or inject tmux input through the dashboard surface.
  Evidence: Dashboard backend calls carry `API_TOKEN`, while web-layer mutating APIs and queue delivery paths lack an independent auth gate.
  Fix: Add dashboard auth/local-only gates, split read-only pages from mutating APIs, and require signed backend/agent authorization for queue injection.

- [High] [bridge-matrix.js](/Users/kamico/agent-chat/bridge-matrix.js:66) Matrix trust and command ACL defaults are fail-open.
  Impact: Untrusted Matrix rooms or empty ACL config can reach command paths that control tmux or write into the kernel message plane.
  Evidence: Audit trust mode continues processing, and bot command ACL defaults can allow operator/admin commands when allowlists are empty.
  Fix: Default trust to enforce for mutating commands; make empty ACL allow only tier-0/read-only commands; always require admin for control commands.

- [Medium] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:14) Supervisor lifecycle is imported and initialized by the backend.
  Impact: An edge automation system can kill or restart supervisor tmux sessions as a side effect of core backend startup/runtime.
  Evidence: Backend imports supervisor lifecycle modules and initializes sweep behavior while also owning kernel routes.
  Fix: Keep supervisor snapshot APIs in backend, but gate lifecycle under explicit enablement or move it to a separate process.

- [Medium] [scripts/write-supervisor-state.js](/Users/kamico/agent-chat/scripts/write-supervisor-state.js:27) Supervisor state CLI advertises a registration path it does not implement.
  Impact: Operators can believe `start` registers a supervisor lease, while backend requires the supervisor agent to already exist.
  Evidence: CLI only patches `/api/supervisor-state/:target`.
  Fix: Correct wording or add a real provisioning/register step.

- [Medium] [lib/supervisor-action-engine.js](/Users/kamico/agent-chat/lib/supervisor-action-engine.js:76) Supervisor escalation target is hard-coded.
  Impact: Non-current deployments can route escalation to a nonexistent or wrong agent.
  Evidence: Escalation target is written as `ac-topleader`.
  Fix: Use `SUPERVISOR_ESCALATION_TARGET` or group config and validate target existence.

- [Medium] [scripts/build-remote-package.sh](/Users/kamico/agent-chat/scripts/build-remote-package.sh:56) Remote package is out of sync.
  Impact: Remote install/runtime can fail or behave differently from root development code.
  Evidence: `check-remote-sync` and `build-remote-package.sh --check` fail with drift/missing managed files.
  Fix: Regenerate remote package after active launch work is coordinated; make sync checks required in CI.

- [Medium] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:6909) Subconscious upstream/runtime endpoints have weaker per-agent auth than event ingest.
  Impact: Local callers can write or invoke edge memory/runtime state for arbitrary agents.
  Evidence: Event ingest has token/local checks, but upstream bootstrap/pretool/stop/runtime invoke paths do not consistently require the same per-agent hook token.
  Fix: Reuse `AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN` or `requireAgentToken(name)` across all kernel-facing subconscious writes.

- [High] [scripts/audit-deps.sh](/Users/kamico/agent-chat/scripts/audit-deps.sh:34) Dependency audit currently fails and is not enforced by CI.
  Impact: Known vulnerable dependencies can enter or remain in the project without CI blocking them.
  Evidence: `npm run audit:deps` fails, while CI runs only install, syntax checks, and tests.
  Fix: Upgrade/replace vulnerable dependency chains or document temporary allowlist risk; add dependency and remote audits to CI.

- [High] [.github/workflows/ci.yml](/Users/kamico/agent-chat/.github/workflows/ci.yml:19) CI does not check remote sync.
  Impact: Remote package drift can ship undetected.
  Evidence: Current workflow only runs `node --check` and `npm test`; subagents confirmed remote sync checks fail locally.
  Fix: Add `npm run build:remote:check` and `npm run check:remote-sync` after active remote launch work is reconciled.

- [Medium] [package.json](/Users/kamico/agent-chat/package.json:25) Local checkout is missing dev test dependencies.
  Impact: `npm test` is not reproducible until `npm ci` restores `vitest` and `supertest`.
  Evidence: Subagent reported `npm ls --depth=0` missing dev dependencies and `vitest: command not found`.
  Fix: Document `npm ci` as required before verification and avoid production-only installs for development/test environments.

- [Medium] [.env.example](/Users/kamico/agent-chat/.env.example:47) Environment example documents unsupported or misleading modes.
  Impact: Operators can believe auth or Supervisor behavior is disabled when runtime code falls back to audit/enabled behavior.
  Evidence: Token mode comment includes `off`, while backend token parsing does not implement it as documented; Supervisor env switches do not map cleanly to lifecycle behavior.
  Fix: Either implement the documented modes or remove/rename the env entries to match actual behavior; add token mode tests.

- [High] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:2643) Production data files lack schema/version/migration contracts.
  Impact: Malformed or old JSON state can be silently normalized, dropped, or re-persisted in an unintended shape.
  Evidence: `schemas/` covers benchmark data only; core stores are loaded through ad hoc normalization.
  Fix: Add `schemaVersion`, validation, and explicit migrations for agents, messages, groups, cursors, tasks, alerts, runtime, and snapshots.

- [Medium] [backend-v2.js](/Users/kamico/agent-chat/backend-v2.js:269) Backend startup can mutate data during read/load.
  Impact: Audit or syntax-check runs against a real runtime directory can rename corrupt files or auto-write migrations.
  Evidence: JSON load failure can rename files and startup migration can write `agents.json`.
  Fix: Add read-only/check-data mode and make tests always use temporary runtime directories.

- [Medium] [tests/helpers/backend-test-runtime.js](/Users/kamico/agent-chat/tests/helpers/backend-test-runtime.js:21) Test helper has stale state filename and env cleanup gaps.
  Impact: Tests can miss current supervisor snapshot behavior and leak environment between cases.
  Evidence: Helper writes old `supervisor_state.json` while backend reads `supervisor_snapshots.json`; cleanup restores too few env vars.
  Fix: Update helper seed files and restore every mutated env var.

## Open Findings Still Under Verification

| ID | Area | Hypothesis | Status |
| --- | --- | --- | --- |
| A-001 | Kernel structure | `backend-v2.js` combines core kernel, optional systems, sweeps, launch control, and integration endpoints in one 9000+ line service. | Awaiting edge/config subagent evidence. |
| A-002 | Dashboard boundary | `server.js` is nearly as large as the backend and may contain duplicated queue/delivery state. | Partially confirmed: dashboard has privileged unauthenticated mutating surface. |
| A-003 | Config model | `.env.example` mixes core, Supervisor, Matrix, scope monitor, and launch configuration without kernel/edge separation. | Confirmed; env example also contains misleading/unsupported behavior. |
| A-004 | Remote mirror | `remote/` contains duplicated `lib/` and `bin/` files that may drift from root implementation. | Confirmed by MCP/CLI and edge audits. |

No repair is approved from this file yet.
