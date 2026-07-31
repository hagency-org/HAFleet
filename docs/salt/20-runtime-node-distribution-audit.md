# 20 Runtime Node Distribution Audit

Date: 2026-05-28
Status: internal design audit. Not public README or operator install instructions.

## Context

This audit was triggered after operator feedback that "remote" and "local" should not
remain product-level concepts. The current system has already partly merged those
concepts, but many scripts, package paths, update paths, and operator commands still
encode them as if they were architectural boundaries.

Four read-only subagent audits reviewed:

- distribution and update topology;
- agent launch and MCP configuration;
- packaging, CI gates, artifact identity, and dependency reproducibility;
- runtime ownership and operator command surface.

`hafleet-worker` also provided context from the delivery/server-identity drift repair
that landed as `4a10651 Fix push relay server identity drift`.

## Core Finding

`remote` and `local` are overloaded labels. They currently mix at least five separate
concerns:

| Concern | Correct question | Current failure mode |
| --- | --- | --- |
| Runtime node identity | Which node owns the target tmux sessions? | `local`, hostname, and `HAFLEET_SERVER` all carry compatibility meaning. |
| Node capabilities | Can this node launch agents, inject tmux notifications, heartbeat MCP, control services, or autodeploy? | Code branches on remote/local instead of explicit capabilities. |
| Runtime profile | Which process set is running on this node? | Backend sweep, dashboard queue, and relay observation can overlap. |
| Artifact/install profile | Is this a source checkout, stable live checkout, standalone package, systemd install, or launchd install? | `remote/` is simultaneously a package source, mirror, and runtime profile surface. |
| Operator surface | Which commands should be available and what scope do they mutate? | CLI help, symlinks, update, service, and verify commands do not always match installed capabilities. |

The target model should keep one backend kernel and one runtime-node contract. A
coordinator node can also be a runtime node, but that is a composition of capabilities,
not a separate "local" implementation. A worker node is the same runtime-node adapter
without backend/dashboard/Matrix capabilities.

## Findings

### P0: Delivery Ownership Is Still Split

Impact:

The same user-visible notification class can be produced through multiple paths with
different ack, stale-read, retry, idle, and restart semantics. This can leave messages
durably present in inbox while no runtime node believes it owns push delivery, or it can
create duplicate visible injection risk.

Evidence:

- The historical current-state audit already says backend sweep, dashboard queue, and
  push relay all infer or write runtime state in overlapping ways.
- `hafleet-worker` reported a concrete failure mode: a Matrix/operator message reached
  backend and inbox, but backend classified the target as `remote-relay-expected` while
  the local relay classified itself as `server-mismatch`, so no push was delivered.
- Short-term hardening now prevents local relay from consuming backend-sourced message
  SSE, but that is a guardrail, not a unified delivery contract.

Repair direction:

Move visible notification delivery to a durable backend delivery task model:

```text
backend creates delivery task
  -> runtime node with delivery_worker + tmux_inject claims by serverId
  -> worker performs final unread/stale check
  -> worker injects local tmux side effect
  -> worker ack/defer/stale back to backend
```

SSE should wake workers only. Correctness should come from durable task state plus
agent inbox recovery.

Acceptance tests:

- A single source message creates one delivery task for one target agent.
- Coordinator-hosted and worker-hosted agents both use the same claim/ack/defer/stale
  API path.
- Backend restart or relay restart does not duplicate visible injection.
- `check_inbox()` before injection terminally stales or suppresses the pending task.

### P0: Server Identity And Capabilities Are Not The Sole Routing Source

Impact:

Routing still depends on legacy aliases and profile assumptions. New behavior can
accidentally interpret `local` as kernel host, runtime node, dashboard locality,
relay id, or MCP registration id.

Evidence:

- `HAFLEET_SERVER` is used by backend/MCP/relay with inconsistent defaults and
  meanings.
- `agent.server` and `agent.tmux` still carry route key, compatibility marker, and
  observation evidence in one field family.
- The recent identity repair centralized some alias logic in `server-identity.js`, but
  `local` remains a compatibility value rather than a clean runtime-node id.

Repair direction:

Persist heartbeat capabilities with the server record:

```json
{
  "serverId": "osaka-runtime-1",
  "instanceId": "relay_...",
  "capabilities": [
    "delivery_worker",
    "tmux_inject",
    "mcp_heartbeat",
    "agent_launch",
    "service_control",
    "autodeploy"
  ],
  "version": "8ffc86b",
  "leaseExpiresAt": 1779910000000
}
```

Route runtime work by `serverId + capabilities + lease`, not by remote/local labels.
Keep `local` only as a legacy alias during migration.

Acceptance tests:

- Non-loopback heartbeat claiming reserved `local` is rejected or normalized by a single
  shared identity resolver.
- Delivery claim returns tasks only to the matching `serverId` with required
  capabilities.
- New agent assignment writes explicit runtime-node identity; old `local` data remains
  readable as compatibility projection only.

### P1: Install, Update, Autodeploy, And Verify Lack One Reconcile Contract

Impact:

One update path can deploy code while another leaves service units, helper symlinks,
sudoers, MCP config, launch wrappers, or version evidence stale. Operators cannot infer
from `hafleet update` whether a full-stack node, runtime node, or package artifact is
being reconciled.

Evidence:

- Full install owns env files, dependencies, CLI links, service units, skills, Claude
  MCP, and Codex MCP.
- Remote install owns a different env/deps/link/service/MCP/verify flow.
- `hafleet-update` is remote-checkout oriented and reruns `remote/install-remote.sh`.
- Remote autodeploy resets code, optionally installs remote deps, restarts relay, and
  runs `verify-remote`; it does not rerun install-owned artifact reconciliation.
- Stable autodeploy is a separate full-stack side path with different gates and service
  lists.

Repair direction:

Define one installer/updater state machine:

```text
detect installed profile
  -> plan changes
  -> install dependencies
  -> render service/plist with pinned runtime
  -> link capability-scoped CLI
  -> render MCP descriptors
  -> restart owned services
  -> verify health/version/capabilities
  -> persist accepted version/state
```

Every install/update/autodeploy path should either run this reconcile subset or fail
closed with a first-class `manual-reconcile-required` state.

Acceptance tests:

- Fake full-checkout install and standalone package install assert exact symlink targets,
  service/plist contents, MCP descriptors, and command surface.
- Autodeploy test changes a service template or MCP descriptor and proves reconcile runs
  or produces a durable manual-action state.
- `hafleet update` help and output name the artifact/install profile being updated.

### P1: CLI Command Surface Is Not Capability-Driven

Impact:

A command can appear available because of path layout rather than because the installed
node can perform that operation safely. Mutating operations can also affect more services
than intended.

Evidence:

- `remote/install-remote.sh` can prefer root `bin/` in a full clone, exposing the full
  checkout `hafleet` surface even when the node only has worker-node capabilities.
- Generated standalone package smoke tests validate `remote/bin/hafleet`, not the
  full-clone path that production may use.
- `hafleet service` defaults to `all`, which can expand to backend/dashboard/bridge
  and relay service names together.
- `verify` is an alias for remote verification even though it reads like a full-stack
  health command.

Repair direction:

Generate CLI dispatch/help from an installed capability manifest:

```json
{
  "installProfile": "source-checkout",
  "runtimeProfile": "runtime-node",
  "capabilities": ["agent_launch", "tmux_inject", "delivery_worker"],
  "commands": ["up", "down", "ls", "send", "service", "verify-node"]
}
```

Unsupported commands should fail with a scoped explanation and the required capability,
not dispatch to missing or irrelevant scripts.

Acceptance tests:

- Full checkout, runtime-node checkout, and standalone package each expose only the
  command set declared by their manifest.
- Mutating `hafleet service pause|resume|restart` requires explicit scope or resolves
  the installed profile from metadata without using `all` as the default.
- `hafleet verify` becomes profile-aware or is removed in favor of explicit
  `verify-node`, `verify-kernel`, and `verify-artifact` style scopes.

### P1: Launch And MCP Configuration Have No Single Descriptor

Impact:

Claude, Codex, global install-time MCP, per-agent MCP, root launch, remote launch, and
backend runtime profile fetch can disagree on API, token, server id, home root, state
dir, and command args. Long shell command construction remains fragile even after wrapper
scripts shortened tmux injection.

Evidence:

- `hafleet-up` renders Claude `.mcp.json`.
- Codex MCP is injected through many `-c` TOML override flags.
- Full install and remote install each register MCP in their own shape.
- `hafleet-up-v1` fetches launch env from backend and merges it into meta at launch time.
- `hafleet-up` still mutates global Claude/Codex trust/config during launch.

Repair direction:

Create a versioned launch descriptor and MCP descriptor renderer used by installer,
provisioner, backend, root wrapper, and package wrapper:

```json
{
  "schema": "hafleet.launch/v1",
  "agent": "hafleet-develop",
  "serverId": "osaka-runtime-1",
  "framework": "codex",
  "homeDir": "...",
  "stateDir": "...",
  "workdir": "...",
  "mcp": {
    "serverName": "hafleet",
    "command": "node",
    "args": [".../mcp-server.js"],
    "env": {
      "AGENT_NAME": "hafleet-develop",
      "HAFLEET_API": "https://...",
      "HAFLEET_SERVER": "osaka-runtime-1"
    }
  },
  "argv": ["codex", "..."]
}
```

Wrappers should execute structured argv/env from the descriptor. Operator-provided
extra args should be a validated array, not a raw shell suffix.

Acceptance tests:

- Rendered Claude JSON parses and matches the same descriptor as Codex TOML/config.
- Fake `tmux`, `claude`, and `codex` black-box tests assert argv and env, not only
  source substrings.
- Root and package wrappers generate identical canonical launch plans except for
  declared profile fields.

### P1: Artifact Identity And Dependency Reproducibility Are Incomplete

Impact:

Post-deploy checks can prove a git checkout commit, but standalone packages cannot prove
which source version is running. Remote runtime dependencies are semver-resolved at
install time instead of being reproducible like CI dependencies.

Evidence:

- Relay heartbeat version is derived from `git rev-parse --short HEAD`.
- Generated standalone packages do not contain a version/manifest file.
- `verify-remote --expect-version` therefore only applies cleanly to git checkouts.
- `remote/package-lock.json` is ignored/excluded, while remote install/autodeploy use
  `npm install --omit=dev`.

Repair direction:

Choose a production artifact policy:

- If standalone packages are first-class production artifacts, inject a version manifest
  and use it as heartbeat version when `.git` is absent.
- If they are bootstrap-only artifacts, document and enforce that `--expect-version`
  requires a source checkout.
- For remote runtime deps, either track/package a lock and use `npm ci --omit=dev`, or
  record resolved dependency versions in the artifact manifest as an explicit lockless
  policy.

Acceptance tests:

- Generated package smoke runs relay against a fake backend and asserts reported version
  equals artifact version.
- Remote install/autodeploy uses the chosen dependency policy and fails when the policy
  cannot be satisfied.

## Replacement Terminology

Avoid adding new public or root-doc language that treats remote/local as architecture.
Use these terms instead:

| Old overloaded term | Preferred term |
| --- | --- |
| local backend host | kernel host, or coordinator node when referring to runtime capabilities |
| local agent host | runtime node with `agent_launch` and `tmux_inject` |
| remote host | worker runtime node |
| remote package | standalone worker-node artifact |
| local/remote update | source-checkout update, stable-live reconcile, standalone package refresh |
| push relay mode | runtime-node capabilities and relay profile |

`remote/` can remain a legacy directory name during migration, but docs and operator
output should explain it as an artifact source path, not a separate runtime semantics.

## Ordered Repair Plan

1. **Delivery task model**
   - Add backend delivery task store and claim/defer/ack/stale APIs.
   - Move visible notification delivery onto the shared runtime-node worker path.
   - Keep dashboard queue only for manual compatibility while migration is active.

2. **Server identity and capabilities**
   - Persist heartbeat capabilities on server records.
   - Route runtime work by `serverId + capabilities + lease`.
   - Stop writing new `local` route identity except as explicit dev compatibility.

3. **Install/update reconcile contract**
   - Introduce install metadata and a dry-runable reconcile planner.
   - Make install, update, and autodeploy call the same reconcile phases or fail closed.
   - Add install-path tests for full checkout and standalone package.

4. **CLI capability manifest**
   - Generate dispatch/help from installed capabilities and artifact profile.
   - Remove unsafe default `all` behavior from mutating service commands.
   - Make verify scopes explicit.

5. **Launch/MCP descriptor**
   - Extract shared launch planner.
   - Generate Claude/Codex/global/per-agent MCP config from one descriptor.
   - Replace raw shell suffixes with structured argv/env tests.

6. **Artifact identity and reproducibility**
   - Decide standalone production status.
   - Add package version manifest or enforce checkout-only version verification.
   - Decide remote dependency lock policy and gate it in CI.

## Decision Gates

The following choices should go to the project leader/operator before behavior changes:

1. Is a standalone worker-node package a first-class production CD artifact or only a
   bootstrap/convenience artifact?
2. May autodeploy automatically reconcile service units, helper symlinks, sudoers rules,
   and MCP config, or should it fail closed and request manual reconcile for those changes?
3. Should full source checkouts installed as worker nodes expose the full checkout CLI, or
   should command exposure always follow node capabilities?
4. Should the coordinator node run the same delivery worker path by default, replacing
   dashboard queue ownership, or should that migration remain default-off until a canary
   proves it?
5. What is the timeline for retiring `local` as a writable runtime identity and keeping it
   only as a legacy read alias?

## Verification Status

This was a read-only design audit plus documentation storage pass. No runtime code was
changed in this report. The current production/service state must be verified separately
on Osaka before using this report to authorize implementation.
