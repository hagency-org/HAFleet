# Subagent Briefs

Date: 2026-05-02

## Active Assignments

| Agent | Scope | Editing |
| --- | --- | --- |
| Arendt | Core kernel: backend, agent identity, messages, groups, inbox, task/alert adjacency. | Read-only |
| Dalton | MCP server, agent-facing tools, CLI, push relay, remote CLI parallels. | Read-only |
| Pascal | Persistence, environment variables, tests, schemas, dependency isolation. | Read-only |
| Banach | Edge systems: dashboard, Matrix, Supervisor, subconscious, remote packaging. | Read-only |
| Gauss | Existing documentation, stale docs, doc structure recommendations. | Read-only |

## Returned Reports

### Arendt: core kernel

Status: complete, read-only.

Core classification:

- Core kernel: agent registry/identity/home, message store, inbox, cursors, groups, and agent runtime state.
- Adjacent: task store, task graph, alert store, notification router, runtime-dir guard.
- Edge: Matrix, push relay, Supervisor lifecycle, subconscious/upstream, avatar/media UI.

Accepted high-risk findings for consolidation:

- Anonymous `GET /api/groups/:name/messages` can advance arbitrary agent group cursors through query identity, which violates per-agent memory boundaries.
- `GET /api/messages/:id` and `/msg/:id` expose full message content without auth; `/msg/:id` renders message content as HTML.
- Agent-token enforcement defaults to an audit/fail-open posture; managed agents without tokens are allowed through.
- Offline group mentions can be added to `suppressedRecipients`, causing them to disappear from later inbox reads.
- Task graph completion can be spoofed because schema `graphId/nodeId` is accepted without checking sender against node assignee.
- Task truth is split across `agents[agent].task`, `tasks.json`, and `task_graphs.json`.
- `NotificationRouter` writes cooldown before aggregate flush, risking silent notification loss on crash.
- `agent-home-v1` path normalization accepts relative paths after `path.resolve`.

### Dalton: MCP, CLI, push relay, remote CLI

Status: complete, read-only.

Flow summary:

- Agent registration is launched primarily by `agent-up`, with MCP core doing best-effort auto-registration.
- Agent send/post calls go through MCP to `POST /api/messages`; attachments are staged first through `/api/media/stage`.
- Agent inbox/group reads go through MCP `check_inbox` and `check_group`; attachments are localized into an MCP media cache.
- Push relay subscribes to `/api/stream`, routes by backend agent `server/tmux`, and injects notifications into local tmux panes.
- Remote mode uses a remote relay/MCP subset, but current `remote/bin` is not fully aligned with root commands.

Accepted findings for consolidation:

- macOS MCP presence detection reads `/proc/<pid>/cmdline`, so local macOS deployments can continuously report `mcpPresent=false`.
- Remote `agentchat` advertises commands whose scripts are absent from `remote/bin`.
- Codex MCP launch auth can be incomplete for non-v1 agents because explicit injected env omits `API_TOKEN`; this touches active `agent-up` work and must be coordinated before any edit.
- MCP media cache is rooted in the current working directory, which can pollute project repos.
- `agent-down --kill` can still be blocked by backend unavailability before local tmux kill.
- Remote `agent-up` has drifted from root `agent-up`; this touches active launch work and must be coordinated before any edit.
- `agent-service` uses bash associative arrays and may fail on macOS bash 3.2.
- Tmux injection uses a fixed defensive key sequence that may over-submit in some CLI states.

### Banach: edge systems

Status: complete, read-only.

Boundary conclusion:

- None of `server.js`, Matrix, Supervisor lifecycle/provision/action, subconscious hooks/runtime, or `remote/` should be a required kernel path.
- Supervisor snapshots and subconscious events are kernel-facing edge state because they land in backend data, but lifecycle side effects should remain outside the kernel service.

Accepted findings for consolidation:

- Dashboard `server.js` acts as an unauthenticated privileged proxy that can call backend with `API_TOKEN` and write into tmux through queue/delivery APIs.
- Matrix trust and bot command ACL defaults are fail-open: audit mode continues processing, and empty operator/admin ACLs can allow command execution paths.
- Supervisor lifecycle is imported and initialized by backend and can kill/restart supervisor tmux sessions as a backend side effect.
- `write-supervisor-state start` claims to register/begin lease but only patches existing supervisor state.
- Supervisor escalation target is hard-coded to `ac-topleader`.
- Remote package sync checks fail; remote wrappers and generated files are drifted, including standalone push relay path assumptions.
- Subconscious upstream/runtime endpoints do not consistently use the same per-agent hook token boundary as event ingest.

Verification reported by subagent:

- `bash scripts/check-remote-sync.sh` failed due remote drift.
- `bash scripts/build-remote-package.sh --check` failed due four managed remote file differences/missing files.

### Pascal: persistence, configuration, tests, dependency isolation

Status: complete, read-only.

Accepted findings for consolidation:

- Dependency audit fails, and CI does not run dependency or remote sync checks.
- Remote mirror drift is independently confirmed by `check-remote-sync` and `build-remote-package.sh --check`.
- Local test dependencies are incomplete in the current checkout: `vitest` and `supertest` are missing, so `npm test` cannot run without `npm ci`.
- `.env.example` documents misleading or unsupported runtime configuration, including token mode `off` and supervisor switches.
- Production data files do not have a unified schema/version/migration contract; benchmark schemas are the only formal schemas.
- Backend startup can implicitly rename corrupt JSON and auto-migrate/write agent data, which is dangerous for audit/check-only runs against real runtime data.
- Test helper writes an old supervisor state filename and does not restore all mutated environment variables.

Verification reported by subagent:

- `bash scripts/check-dep-isolation.sh` passed.
- `bash scripts/audit-deps.sh` failed.
- `bash scripts/check-remote-sync.sh` failed.
- `bash scripts/build-remote-package.sh --check` failed.
- `npm test` failed because `vitest` was not installed in the local checkout.

### Gauss: existing documentation and stale docs

Status: complete, read-only.

Key conclusions:

- Current reliable documentation spine: `README.md`, `OPERATIONS.md`, `skills/agent-chat/SKILL.md`, v1 workspace templates, and actual routes in code.
- The old `docs/{agent}` model conflicts with the current flat v1 workspace model. `docs/agent-role-and-scope-editing.md`, `docs/agent-roles-and-guardrails.md`, and `docs/Hibiki/agents.md` still describe old per-agent folders.
- `docs/architecture/system-components.md` has stale route names and API tables, including an outdated `/api/sse` path where current code exposes `/api/stream`.
- `ROADMAP-remote.md` reads as an implementation roadmap even though remote support is now a documented feature.
- Recommended `docs/salt` structure: principles, kernel, edges, agent-home-v1, message/trust, operations map, archive index.

Accepted actions for consolidation:

- Add an archive/stale-doc section to the repair table.
- Make `docs/salt` the current-system audit set, not another long-lived `docs/{agent}` model.
- Use the phrase "agentchat is a stateful-individual chat kernel" as the documentation anchor, with Task/Supervisor/Matrix/Dashboard/Remote relay as replaceable edges.
