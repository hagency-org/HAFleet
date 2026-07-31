# 09 Remote Local Unification Design

Date: 2026-05-02
Status: design proposal. No runtime code changes in this pass.

## Design Thesis

Local and remote should not be separate implementations. They should be two deployment profiles of the same runtime-host model.

The kernel stays central. Every machine that owns tmux sessions becomes a runtime host. A runtime host reports observations and performs local delivery through the same host adapter contract, regardless of whether it is the central machine or a remote machine.

## Target Model

```text
                     central backend kernel
                agents / messages / groups / cursors
                servers / runtime / tasks / alerts
                              |
             backend API + durable store + event stream
                              |
        ------------------------------------------------
        |                                              |
  runtime host: central-local                     runtime host: remote-X
  push-relay host adapter                         push-relay host adapter
  local tmux agents                               local tmux agents
  MCP per agent                                   MCP per agent

  optional on central only:
  dashboard, Matrix bridge, Supervisor edges
```

The central machine can also be a runtime host, but it is not special as a runtime host. It is special only because it runs the kernel.

## Kernel Invariants

These facts must not vary by local or remote profile:

- Backend owns durable identity, message, group, cursor, server, runtime, task, and alert state.
- MCP tools are the agent-facing kernel API.
- Message visibility and cursor advancement require agent/operator authorization.
- Agent identity is anchored by backend record plus v1 home manifest.
- Server id is only runtime origin; it must not change message semantics.
- Transports may deliver, observe, and mirror. They do not own chat memory.

## Runtime Host Contract

A runtime host is a process set with a stable host id and local access to tmux sessions.

Required host inputs:

| Input | Meaning |
| --- | --- |
| `HAFLEET_API` | Backend base URL. |
| `HAFLEET_SERVER` | Explicit runtime host id. |
| Host credential | Credential allowed to heartbeat/report runtime for this host. |
| `HAFLEET_HOMEDIR` or derived home root | Root used to resolve local agent homes and state dirs. |

Host responsibilities:

- list local tmux sessions;
- heartbeat `serverId`, `relayInstanceId`, `bootTs`, and local sessions;
- report runtime observations for agents it hosts;
- inject notifications into local tmux targets;
- mark itself offline on controlled shutdown;
- never mutate message truth except through backend API contracts.

Compatibility responsibility:

- central-local may keep backend legacy local sweep temporarily, but it must be a fallback observer behind a compatibility flag, not a peer source of truth.

## Delivery Contract

Target behavior:

1. Backend stores message and updates durable unread/cursor state.
2. Backend emits an event.
3. Exactly one runtime host adapter owns delivery for each target agent, selected by `agent.serverId`.
4. The host adapter injects into tmux or logs delivery failure.
5. The agent still recovers missed messages through `check_inbox()`.

Implications:

- Dashboard queue is a legacy/manual operator path, not the default backend delivery path.
- Relay in central-local and relay in remote should use the same routing code.
- SSE delivery is best effort; backend inbox remains recovery truth.
- Relay dedupe may remain in-memory for notification noise, but correctness must rely on inbox state.

## Runtime State Contract

Recommended shape:

| Concept | Owner | Notes |
| --- | --- | --- |
| `agent.name` | backend | Stable agent id. |
| `agent.serverId` | backend, updated by host heartbeat/launch | Runtime host assignment. |
| `agent.runtimeTarget` | host observation | Tmux target or equivalent local target. |
| `agent.online` | derived | Derived from server liveness, target observation, and manual down state. |
| `agent.tmux` | compatibility field | Derived from `runtimeTarget` until old callers migrate. |
| `agent_runtime.mcpPresent` | host adapter or MCP adapter | Backend legacy scan only as fallback. |
| `servers[serverId]` | backend, fed by host heartbeat | Lease, sessions, version, maintenance, source IP. |

The current `agent.server` and `agent.tmux` fields can remain serialized for compatibility, but new code should treat them as legacy projections of runtime-host facts.

## Identity And Auth Boundaries

Separate four identities:

1. Operator/admin: can administer backend, groups, agents, repair state.
2. Runtime host: can heartbeat and report observations for one `serverId`.
3. Agent: can send/read as itself through per-agent token.
4. Transport bridge: can submit external messages under a scoped bridge credential.

Current `API_TOKEN` covers too many of these. The transition can be staged:

- keep `API_TOKEN` as operator/backend bearer for compatibility;
- introduce a host credential for relay heartbeat/runtime report;
- require per-agent tokens for agent writes/reads;
- keep Matrix bridge secrets distinct from operator/admin bearer;
- add dashboard web auth instead of relying only on backend proxy bearer.

## Configuration Contract

### Required For Backend

| Variable | Contract |
| --- | --- |
| `HAFLEET_RUNTIME_DIR` | Backend runtime/data root. |
| `HAFLEET_SERVER` | Explicit id for the central-local runtime host. Dev may use `local`. |
| `API_TOKEN` | Operator/backend bearer; production required. |
| `HAFLEET_AGENT_TOKEN_MODE` | Production target: `hard`. |

### Required For Runtime Host Relay

| Variable | Contract |
| --- | --- |
| `HAFLEET_API` | Backend base URL. |
| `HAFLEET_SERVER` | Explicit host id; no hostname/local fallback in production. |
| Host credential | Initially `API_TOKEN`, later `HAFLEET_SERVER_TOKEN` or equivalent. |
| `HAFLEET_HOMEDIR` | Optional override; otherwise derived from runtime contract. |

### Required For Agent MCP

| Variable | Contract |
| --- | --- |
| `AGENT_NAME` | Agent identity. |
| `HAFLEET_API` | Backend base URL. |
| `HAFLEET_SERVER` | Host id assigned by launcher/manifest. |
| `HAFLEET_AGENT_STATE_DIR` | Derived state dir containing `agent-token` and `mcp-server.pid`. |

### Derived Paths

These should be derived from a common resolver, not hand-assembled per component:

- `homeRoot = HAFLEET_HOMEDIR || HAFLEET_RUNTIME_DIR/homes || ~/.hafleet`
- `agentId = agent_<normalized name>` unless manifest provides a stable id
- `homeDir = homeRoot/agents/<agentId>`
- `stateDir = homeDir/state`
- `workdir = homeDir/workdir`
- `agentTokenPath = stateDir/agent-token`
- `mcpPidPath = stateDir/mcp-server.pid`
- `mcpCacheDir = stateDir/tmp/mcp-media-cache`

## Package Architecture

Remote packaging should not be "copy some root files and hope." It should be profile-generated from a manifest.

Recommended package layers:

| Layer | Source | Included In |
| --- | --- | --- |
| Kernel source | root backend/server files | central profile only. |
| Shared host adapter | root `lib/push-relay-core.js`, `lib/mcp-server-core.js`, transitive deps | central-local and remote relay profiles. |
| CLI command manifest | profile-specific list | local CLI and remote CLI. |
| Legacy wrappers | generated from manifest | both, but only for supported commands. |
| Remote authored files | `remote/README.md`, install/service templates | remote package. |
| Generated artifact | build output | either ignored or complete and checked; never partial. |

Remote `hafleet` should dispatch only commands included in that package. If a command is central-only, the remote CLI should say so clearly instead of dispatching to a missing file.

## CLI Semantics

Every operator command should document scope:

| Command | Scope Contract |
| --- | --- |
| `hafleet up` | Start a tmux agent on the current runtime host and register it to backend. |
| `hafleet down` | Stop a tmux agent on the current runtime host; backend marking is best effort. |
| `hafleet ls` | Show current host sessions plus backend registry context; not a global truth dump. |
| `hafleet service` | Control services for an explicit profile; no `all` default on remote. |
| `hafleet update` | Remote package update only, or renamed to make that scope explicit. |
| `hafleet verify-remote` | Verify one runtime host against central backend. |
| `hafleet check-mcp` | Profile-specific; only advertised where packaged. |

## Documentation Architecture

Phase 0 documentation stays under `docs/salt/` until operator approval moves it into root docs.

Current staged authority:

- `08-remote-local-current-state.md`: current topology and drift evidence.
- `09-remote-local-unification-design.md`: target runtime-host design.
- `10-remote-local-roadmap.md`: dependency order and approval gates.
- `11-remote-local-phase0-terms.md`: frozen terminology, profile matrix, and command scope.

Later root-doc targets, after operator approval:

- `README.md`: product model, kernel invariant, profile index.
- `OPERATIONS.md`: incident runbooks by profile and command scope.
- `remote/README.md`: remote install shape and packaged command surface.
- `ROADMAP-remote.md`: rewrite as current remote status or clearly mark as superseded.

Do not move or archive old docs in Phase 0/1. For now, old docs are conflict evidence and later rewrite targets.

## Compatibility Rules

To avoid breaking live systems:

- Keep old env vars as aliases during migration.
- Keep `agent.tmux` and `agent.server` serialized until callers move.
- Keep dashboard queue available for manual/legacy use, but remove it from default push delivery after relay path is stable.
- Keep backend local sweep behind an explicit compatibility flag until local relay heartbeat is proven.
- Do not hand-edit `bin/hafleet-up` or `remote/bin/hafleet-up`; first extract launch contracts and tests.

## Target End State

There is one kernel, one runtime-host contract, and profile-specific packaging.

Local is not special because it is local. It is a runtime host that happens to share a machine with the central backend. Remote is not a separate implementation. It is the same runtime host adapter deployed without the kernel and operator UI.
