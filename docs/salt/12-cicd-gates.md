# 12 CICD Gates

Date: 2026-05-03
Status: first executable CI/CD gate plan.

## Goal

The project needs a release gate that catches common operator-facing breakage before remote CD deploys it.

The immediate priority is not more runtime architecture repair. It is repeatable verification for:

- root CLI command dispatch;
- remote CLI command dispatch;
- remote/local mirror drift;
- standalone remote package shape;
- shell and JavaScript syntax across tracked entrypoints;
- high-value kernel and CLI smoke behavior.

## First Gate

`npm run verify:ci` is the local command for CI and remote CD environments.

It runs:

1. `npm run report:ci-env`
2. `npm run check:syntax`
3. `npm run check:cli-contract`
4. `npm run build:remote:check`
5. `npm run check:remote-sync`
6. `npm run check:remote-package-smoke`
7. `npm run check:dep-isolation`
8. `npm run test:kernel`

GitHub Actions now runs this as an added step in the existing `lint` job, then runs the existing full `npm test` job separately.

`npm run audit:deps` is intentionally not part of the first blocking CD gate. RLP7-B read-only audit found that the current baseline is still red: fixable transitive locks can likely be refreshed under existing semver ranges, while Matrix `request`-chain debt still needs allowlist or migration approval. Keep dependency audit as a separate security repair track until ac-topleader approves a green policy and adding it to release verification.

`npm test` also uses serialized file execution. The current backend/runtime tests create many temporary HTTP servers and timers; parallel file execution can produce timeout noise that hides real product failures.

## Two Environment Drift

The practical CD topology has at least two useful verification nodes: the operator/local checkout and the remote checkout. They are intentionally not identical, and that difference should be used as a test surface instead of hidden.

Each candidate commit should report:

- git commit and branch;
- OS, architecture, Node, and npm versions;
- install mode (`npm ci` vs `npm ci --ignore-scripts`);
- whether Matrix native optional dependencies are present and loadable;
- results for `npm run verify:ci`;
- results for remote package smoke and sync checks.

The current gate is single-node executable. The next CD layer should run the same gate on both local and remote checkouts, then compare the environment metadata and command results. A difference is allowed only when the profile explicitly owns it, such as remote command surface limits or optional Matrix native dependencies.

`npm run report:ci-env` is the first piece of this layer. It prints the environment metadata at the start of `verify:ci` without failing the run on expected local/remote differences. CD scripts can set `AGENTCHAT_INSTALL_MODE` when the install mode is known but no longer visible to the later `npm run` process.

## CLI Contract

The command manifest lives at `scripts/cli-command-manifest.json`.

The root profile is expected to expose the full checkout command surface, including launch, project, graph, resume-id, benchmark, and check-mcp helpers.

The remote profile is expected to expose only packaged remote commands:

- `up`
- `down`
- `ls`
- `send`
- `update`
- `service`
- `verify-remote`
- `audit`
- `maintain`
- `prune-agents`
- `sync-skills`
- `reminder`
- `cli`

Remote unsupported commands such as `graph`, `project`, `up-v1`, `resume-id`, `benchmark`, and `check-mcp` must fail clearly instead of dispatching to missing files.

## Remote Package Smoke

`npm run check:remote-package-smoke` builds a generated remote package in a temporary directory and checks:

- required wrapper, CLI, and shared lib files exist;
- runtime artifacts are excluded;
- generated JavaScript and shell entrypoints parse;
- remote help stays profile-scoped;
- unsupported remote commands fail with a clear remote command error.

This covers the gap where `remote/` and generated package behavior can drift even if root tests pass.

## What This Does Not Yet Cover

These remain future gates:

- real tmux launch smoke for `agent-up`;
- remote relay heartbeat against a staging backend;
- MCP authenticated tool smoke against a staging backend;
- stable/live deploy and rollback verification;
- Matrix bridge native optional dependency behavior across platforms.
- dependency vulnerability remediation and a future blocking `audit:deps` gate.

Those require operator/CD environment details and should be added after the current gate is stable.
