# 11 Remote Local Phase 0 Terms

Date: 2026-05-02
Status: Phase 0 working authority under `docs/salt/`. Do not treat this as final root documentation.

## Scope

This file freezes terms for the current remote/local repair work without moving or archiving root documentation.

Approved bounds:

- keep the central backend kernel as the durable truth owner;
- treat remote/local as deployment profiles, not separate implementations;
- use git checkout install as the primary remote deployment mode;
- keep generated standalone remote package support as secondary packaging;
- do not make local delivery use push relay by default in this phase;
- keep shared bearer credentials and trusted-local dashboard as compatibility decisions until Phase 3;
- do not edit or synchronize `bin/hafleet-up` and `remote/bin/hafleet-up` in Phase 0/1.

## Frozen Terms

| Term | Definition | Boundary |
| --- | --- | --- |
| Kernel | Central backend durable truth for agents, messages, groups, cursors, servers, runtime, tasks, and alerts. | Does not include dashboard queue, Matrix, remote package, or launcher internals. |
| Runtime host | A machine that owns local tmux sessions and can observe, heartbeat, report runtime, and inject notifications. | The central machine can be both kernel host and runtime host, but those roles are separate. |
| Deployment profile | A process/package shape for one host role. | `central-live`, `central-dev`, and `remote-relay` are profiles, not separate architectures. |
| Host adapter | The runtime-host adapter contract: list tmux, heartbeat, report runtime, inject notifications. | Push relay is the current remote adapter. Backend local sweep is compatibility observation. |
| Package shape | How files are deployed: root checkout, `remote/` package tree, or generated `remote-dist/`. | Packaging is not architectural truth. |
| Operator surface | CLI, dashboard, runbook, Matrix bot command, or service wrapper used by humans/operators. | Every command needs a host/service/backend scope. |
| `serverId` | Stable runtime host id. | It should not encode agent identity or message semantics. |
| `API_TOKEN` | Current overloaded compatibility bearer. | Operator/admin, runtime-host, agent, and bridge credentials are split only after Phase 3 approval. |

## Profile Matrix

| Profile | Runs Kernel | Owns Tmux Sessions | Primary Install Shape | Services | Notes |
| --- | --- | --- | --- | --- | --- |
| `central-live` | Yes | Yes, for local agents | Root git checkout | backend, dashboard, Matrix, optional local services | Kernel role and local runtime-host role must be reasoned about separately. |
| `central-dev` | Yes | Usually yes | Root git checkout | dev backend/dashboard services | Same contracts as live, different ports and service manager. |
| `remote-relay` | No | Yes | Git checkout install first; standalone package second | push relay, MCP, helper CLI | Does not run backend, dashboard, or Matrix. |

## Package Shape Rules

- Root `bin/hafleet` is the full checkout CLI.
- `remote/bin/hafleet` is a remote-profile CLI and must advertise only commands included in the remote package.
- `remote/bin/hafleet-up` is temporarily profile-specific and frozen until launch work clears.
- Mirrored remote files must match root unless explicitly listed as profile-specific.
- Generated `remote-dist/` is build output and should not be committed as a partial artifact.
- Runtime artifacts such as `.env`, `.DS_Store`, logs, `node_modules`, package locks, and launchd runner scripts must stay out of git.

## Command Scope Matrix

| Command | Root Checkout Scope | Remote Relay Scope |
| --- | --- | --- |
| `hafleet up` | Start or resume a tmux agent on the current runtime host. | Same, using remote launch profile. |
| `hafleet down` | Stop a tmux agent on the current runtime host; backend update is best effort. | Same. |
| `hafleet ls` | Host-local session view plus backend context. | Host-local session view plus central backend context. |
| `hafleet send` | Inject into a host-local target. | Inject into a host-local target. |
| `hafleet update` | Checkout/runtime update helper; service side effects depend on local install. | Remote checkout/package update helper. |
| `hafleet service` | Service control for configured local/remote profiles. | Remote service control only. |
| `hafleet verify-remote` | Verify a remote runtime host from checkout. | Verify this remote host against central backend. |
| `hafleet check-mcp` | Full checkout MCP wiring check. | Not packaged in Phase 1. |
| `hafleet up-v1`, `project`, `graph`, `resume-id`, `benchmark` | Full checkout commands. | Not packaged in Phase 1. |

## Phase 1 Gate

Phase 1 is limited to package honesty:

- remote CLI help and dispatch must match included files;
- dispatch targets must be checked for root and remote CLIs;
- remote shared `lib` mirrors must include transitive dependencies;
- remote sync checks may pass while explicitly treating `remote/bin/hafleet-up` as profile-specific pending Phase 5.

Anything that changes runtime observation, credentials, path resolution, launch internals, service semantics, or old-doc archival remains outside Phase 0/1.
