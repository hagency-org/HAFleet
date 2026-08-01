# 10 Remote Local Roadmap

Date: 2026-05-02
Status: design roadmap. Implementation requires ac-topleader approval per phase.

Phase 0/1 approval note: ac-topleader approved Phase 0 docs/terms and Phase 1 package honesty only. Phase 2-7 require operator architecture decisions.

## Goal

Eliminate local/remote architectural split by making runtime host, deployment profile, package shape, and operator command scope explicit.

This roadmap is not a request to start code repair immediately. It is the dependency order for future work.

## Phase 0: Freeze Terms And Authority

Type: docs and tests only.

Objectives:

- Define kernel invariants and runtime host contract.
- Mark `ROADMAP-remote.md` as superseded or replace it with current deployment docs after operator review.
- Add a profile matrix for central-live, central-dev, and remote-relay.
- Add command semantics by profile.

Exit criteria:

- Operators can answer: "Which process owns this state?" and "Which host does this command affect?"
- Remote/local docs no longer imply separate implementations.

Suggested files:

- `docs/salt/08-remote-local-current-state.md`
- `docs/salt/09-remote-local-unification-design.md`
- `docs/salt/10-remote-local-roadmap.md`
- `docs/salt/11-remote-local-phase0-terms.md`

Root docs such as `README.md`, `OPERATIONS.md`, `remote/README.md`, and `skills/hafleet/SKILL.md` are later synchronization targets, not Phase 0 edit targets.

## Phase 1: Make Package Shape Honest

Type: packaging/docs/tests. Avoid `hafleet-up` internals until approved.

Objectives:

- Decide supported remote package mode:
  - git checkout profile, or
  - standalone generated package, or
  - both with explicit tests.
- Make `remote/bin/hafleet` advertise only packaged commands.
- Add dispatch-target existence checks for every command in every profile.
- Include all transitive shared library deps, including `lib/blocked-patterns.js`.
- Stop committing partial `remote-dist/`, or commit a complete checked artifact.
- Exclude runtime artifacts such as `.env`, logs, node_modules, launchd runner scripts, and `.DS_Store`.

Exit criteria:

- `npm run build:remote:check` passes.
- `npm run check:remote-sync` passes.
- Generated remote package can resolve `push-relay.js` and `mcp-server.js` against package-local `lib/`.
- Remote CLI help matches actual files.

Known current blockers:

- `remote/bin/hafleet-up` drift is under active launch work and is explicitly deferred.
- Remote package checks must still prove every advertised command dispatches to an included executable.

## Phase 2: Converge Runtime Observation

Type: runtime code after approval.

Objectives:

- Run central-local through the same runtime host heartbeat path as remote.
- Make `HAFLEET_SERVER` explicit for every runtime host.
- Move local backend tmux sweep behind a compatibility flag.
- Ensure only one observer updates `mcpPresent`, activity, and blocked state for a hosted agent.
- Preserve missed-message recovery through inbox, not through delivery memory.

Exit criteria:

- Local and remote both produce server heartbeat records.
- `servers.json` is the canonical host liveness source.
- `agent_runtime.json` records observation source/host.
- Backend local sweep can be disabled without losing live delivery.

Dependencies:

- Batch 3 R-009 is complete, so relay MCP presence can work on macOS.
- Package command surface should be honest before relying on relay everywhere.

## Phase 3: Separate Identities And Credentials

Type: auth/config code after approval.

Objectives:

- Keep `API_TOKEN` as operator/backend bearer for compatibility.
- Introduce a server/relay credential for heartbeat/runtime report.
- Require per-agent tokens for agent memory reads/writes in production.
- Keep Matrix bridge secret separate from operator/admin and server credentials.
- RLP3-B1 added local-only/token enforcement for privileged dashboard proxy routes; full dashboard web auth remains a separate operator decision.

Exit criteria:

- A runtime host cannot impersonate arbitrary agents through bearer alone.
- A dashboard browser is not implicitly an operator because `server.js` has backend `API_TOKEN`.
- Agent, operator, server, and bridge auth paths have separate tests.

Related repair table entries:

- R-003 agent-token fail-closed.
- R-011 MCP launch auth.
- R-017 dashboard auth.
- R-018 Matrix trust.
- R-023 subconscious edge auth.

## Phase 4: Normalize Agent Home And Runtime Paths

Type: shared library and launcher work after approval.

Objectives:

- Use one resolver for home root, agent home, state dir, workdir, token path, pid path, and media cache.
- Make `HAFLEET_AGENT_STATE_DIR` a derived injected value, not a human-authored truth source.
- Move MCP media cache under agent state or runtime data.
- Make push relay pid lookup use the same resolver as v1 homes.

Exit criteria:

- MCP pid and token paths resolve the same way for local and remote.
- No component writes MCP cache into arbitrary project cwd.
- Tests cover runtime-dir derived home root and explicit `HAFLEET_HOMEDIR`.

Related repair table entries:

- R-012 MCP media cache.
- R-025 production data contract.
- R-026 env truth cleanup.

## Phase 5: Decompose Launch

Type: launcher refactor after active `hafleet-up` work clears.

Objectives:

- Extract launch responsibilities from `hafleet-up` into testable pieces:
  - profile config;
  - v1 home resolver;
  - MCP config generation;
  - tmux launch;
  - runtime profile injection;
  - resume/path recovery;
  - Claude/Codex differences.
- Generate or share remote launcher behavior instead of maintaining hand-edited mirrors.
- Keep `bin/hafleet-up` and `remote/bin/hafleet-up` untouched until this phase is explicitly approved.

Exit criteria:

- Root and remote launch behavior cannot drift silently.
- Remote package can launch agents with the same supported feature set or clearly documented subset.
- Shell quoting and env injection tests exist for Claude and Codex.

Related repair table entries:

- R-011 MCP launch auth.
- R-014 remote `hafleet-up` drift.
- R-022 remote package sync.

## Phase 6: CLI And Ops Profile Cleanup

Type: CLI/docs/tests after package and launch shape are clear.

Objectives:

- Make `hafleet service` require explicit profile or derive safe profile from install metadata.
- Rename or scope `hafleet update` if it remains remote-specific.
- Make `hafleet-ls` explicitly distinguish host-local sessions from backend registry.
- Make `hafleet-down` clearly host-local.
- Advertise `check-mcp` only where it is packaged.

Exit criteria:

- `hafleet <command> --help` states profile support.
- Remote install cannot expose commands that fail due missing targets.
- Operations docs map each incident command to central or remote scope.

## Phase 7: CI And Release Gates

Type: CI after drift is resolved.

Objectives:

- Require remote sync checks.
- Require generated package smoke checks.
- Require dependency audit policy.
- Keep Matrix native optional package behavior documented or installable in CI.

Exit criteria:

- `npm test` can run in the documented local dev setup.
- `npm run build:remote:check` and `npm run check:remote-sync` are green and enforced.
- Remote package import and shell syntax checks run in CI.

Related repair table entries:

- R-024 dependency security and CI checks.
- R-029 local verification.

## Dependency Order

```text
Phase 0 docs terms
  -> Phase 1 package honesty
    -> Phase 2 runtime host convergence
      -> Phase 3 credential separation
      -> Phase 4 path resolver normalization
        -> Phase 5 launch decomposition
          -> Phase 6 CLI profile cleanup
            -> Phase 7 CI gates
```

Phase 3 and Phase 4 can partly run in parallel after Phase 2 starts, but Phase 5 should wait until active `hafleet-up` work is no longer in flight.

## Design Decisions Needed

1. Should remote support standalone package, git checkout install, or both?
2. Should local central delivery move to push relay as the default host adapter?
3. What is the server credential model: shared bearer first, then per-server token, or immediate split?
4. Should dashboard remain trusted-local only or gain explicit web auth?
5. Which old docs should be reviewed before README/OPERATIONS are rewritten?

## Near-Term Staging Step

Keep formal remote/local terms in `docs/salt/11-remote-local-phase0-terms.md` until operator approval decides which root docs should become canonical.

The current architecture decisions staged for operator confirmation are:

1. Remote uses git checkout install as primary and standalone package as secondary.
2. Local central delivery does not need push relay as the default path in this phase.
3. Server credentials remain shared bearer until Phase 3.
4. Dashboard remains trusted-local only until a separate auth decision.
5. Old docs are not archived or moved until reviewed.
