# Kernel Boundaries

Date: 2026-05-02

## Working Definition

agent-chat is primarily a chat kernel for agents as persistent individuals. The kernel must answer these questions consistently:

- Who is this agent?
- What state and memory identify it across sessions?
- Which other individuals or groups can it address?
- What messages has it received, read, suppressed, or produced?
- How do optional transports and operator tools observe or deliver those facts without owning them?

## Core Kernel

Core files and concepts:

| Area | Current implementation | Why core |
| --- | --- | --- |
| Agent identity and registry | `backend-v2.js`, `lib/agent-state.js`, `lib/agent-home-v1.js` | Defines agent existence, type, runtime identity, and v1 home binding. |
| Message store and cursors | `backend-v2.js`, `lib/mcp-server-core.js` | Main product loop: send, receive, preview, mark read, suppress. |
| Group membership | `backend-v2.js`, `bridge-matrix.js` as a caller | Group membership affects addressability and inbox semantics. |
| Agent-facing MCP tools | `lib/mcp-server-core.js` | The API surface agents actually use. |
| Push delivery contract | `lib/push-relay-core.js` | Delivery mechanism for local tmux agents; should remain a transport, not source of truth. |
| Runtime data root | `backend-v2.js`, `lib/runtime-dir-guard.js` | Defines where persistent kernel facts live. |

## Adjacent Support Systems

| Area | Current implementation | Boundary rule |
| --- | --- | --- |
| Tasks and task graphs | `lib/task-store.js`, `lib/task-graph.js`, task routes in `backend-v2.js` | Useful workflow layer; must not redefine agent identity or message truth. |
| Alerts and monitoring | `lib/alert-store.js`, runtime routes in `backend-v2.js` | Operational layer; should observe kernel state and emit tickets. |
| Dashboard and queue | `server.js` | Operator/UI layer; should not become a second message or delivery truth. |
| Launch/provisioning | `bin/agent-up`, `bin/agent-up-v1`, `scripts/provision-v1-agent-home.js` | Creates runtime homes and sessions; must preserve one identity mapping. |

## Edge / Optional Systems

| Area | Current implementation | Boundary rule |
| --- | --- | --- |
| Matrix | `bridge-matrix.js`, `lib/bot-commands.js` | Optional external transport and operator surface. |
| Supervisor | `lib/supervisor-*`, supervisor routes/scripts | Optional attention audit layer. |
| Subconscious hooks | `lib/upstream-claude-subconscious.js`, `subconscious/*` | Optional Claude-specific memory/event integration. |
| Remote package | `remote/*`, `remote-dist/*` | Deployment mirror; should be generated or checked against core. |

## Initial Boundary Risks To Verify

- `backend-v2.js` mixes core kernel routes, edge routes, monitoring sweeps, launch control, and optional integrations in one file.
- `server.js` is large enough to risk becoming a parallel backend rather than a dashboard/queue surface.
- Remote copies under `remote/` may drift from root `lib/` and `bin/` implementations.
- Optional systems use many environment variables, making kernel configuration hard to separate from edge configuration.

These are initial hypotheses. Subagent reports and line-level evidence will decide what enters `audit-findings.md`.
