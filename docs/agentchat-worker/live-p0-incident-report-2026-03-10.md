# Live P0 Incident Report — 2026-03-10

## Summary
- On 2026-03-10, the live `agent-chat` service entered a P0 degraded state centered on the live backend at `127.0.0.1:8090`.
- The service became unreliable enough to break MCP transport, stall live API requests, destabilize the Matrix bridge, and undermine operator trust during the post-stable rollout window.
- The incident is now mitigated and the live service is back to usable, but a durable code-level fix is still required for the expensive live sweep path.

## Impact
- Affected surfaces:
  - live backend `8090`
  - live web `8084`
  - agentchat MCP transport using the live backend
  - `bridge-matrix`
- User-visible impact:
  - page loads and API-driven content could hang or blank
  - MCP actions intermittently failed as `fetch failed`
  - live detail views showed misleading warning state before a separate truthfulness hotfix
- Operational impact:
  - execution agents could not reliably `check_inbox()` / `send_message()`
  - live rollout confidence dropped

## Symptoms Observed
- `GET /health` on `127.0.0.1:8090` timed out.
- `GET /api/inbox/:agent` on `127.0.0.1:8090` timed out during the incident window.
- Socket backlog on `8090` filled.
- Local socket state showed hundreds of `ESTAB` and `CLOSE_WAIT` connections against `8090`.
- `mcp__agent-chat__*` tool calls intermittently returned `fetch failed`.
- `bridge-matrix` startup could time out while probing backend state.
- live web `8084` dropped during rollout validation and had to be manually restored.

## Root Cause
This was an amplification chain, not a single bug.

### 1. Expensive synchronous live sweeps
- In [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js), live background sweeps were running every 5s or 15s.
- Those sweeps perform synchronous local runtime probing, including `tmux` and related system calls, across a large live agent set.
- On live, with ~50+ agents, that can monopolize the Node event loop and starve normal HTTP request handling.

### 2. Asymmetric timeout boundaries
- Bridge-side backend calls were already bounded:
  - [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js)
  - [bot-commands.js](/home/shisui/laplace/agent-chat/lib/bot-commands.js)
- But backend-owned calls back into the web/queue bridge were not bounded.
- In [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js), these call sites had no timeout before the incident fix:
  - `pushResourceAlertToAgent()`
  - `clearQueuedNotificationsForAgent()`
  - `pushNotify()`
- That let local stalls on the backend/web bridge path hang indefinitely and widen the blast radius.

### 3. Operational ownership on live was still fragile
- live code/runtime split had been introduced, but live recovery still depended partly on manual tmux-backed recovery.
- During the rollout window, `8084` had to be manually restored, which made the incident response path less deterministic than a clean managed restart model.

## Contributing Factors
- live runtime sweeps were too aggressive for the current agent count
- `AGENT_SCOPE_MONITOR_ENABLED` defaulted on
- internal service-to-service timeout policy was inconsistent
- browser-visible stale supervisor warning logic had just been hotfixed in the same rollout window
- systemd/user-bus ownership is not currently a reliable recovery/control path on this host

## Immediate Response
### Hotfix 1: visible stale supervisor warning
- Historical supervisor rows were prevented from rendering as current warning state.
- Commits:
  - `master`: `7b8b2a3`
  - `stable`: `1c0c14d`

### Hotfix 2: bridge-side backend fetch timeout
- Added hard timeout on backend fetches in:
  - [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js)
  - [bot-commands.js](/home/shisui/laplace/agent-chat/lib/bot-commands.js)
- Commits:
  - `master`: `dabed2c`
  - `stable`: `02b0abe`

### Hotfix 3: backend-side web/queue bridge timeout
- Added hard timeout on backend-owned bridge fetches in:
  - [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js)
- Commits:
  - `master`: `d2bca0f`
  - `stable`: `9798d5a`

### Live runtime mitigation
- Applied live-only env throttling in `agent-chat-live-runtime/.env`:
  - `AGENT_LOCAL_ACTIVITY_SWEEP_MS=30000`
  - `AGENT_SCOPE_SWEEP_INTERVAL_MS=30000`
  - `AGENT_RULE_SWEEP_INTERVAL_MS=30000`
  - `AGENT_SERVER_SWEEP_INTERVAL_MS=30000`
  - `AGENT_SWAP_SWEEP_INTERVAL_MS=30000`
  - `AGENT_SCOPE_MONITOR_ENABLED=false`

### Live recovery
- Restored:
  - live backend
  - live bridge
  - live web
- Re-verified browser-visible behavior after mitigation.

## Verification Performed
- repeated `GET /health` probes on `8090`
- repeated `GET /api/inbox/:agent` probes on `8090`
- socket-state inspection on `8090`
- browser re-audit by `webdebug`
- live root page and `Yato` detail page both passed after recovery
- `bridge-matrix` was verified able to start after runtime mitigation

## Current Status
- P0 user-visible outage: resolved
- live backend: responding
- live web: responding
- MCP transport: recovered
- Matrix bridge: recovered
- residual risk: still present

## Residual Risk
### 1. Runtime throttling is still a mitigation, not the final design
- The live service is currently stable with reduced sweep frequency and scope monitoring disabled.
- That is not yet a durable architectural fix.

### 2. The sweep model is still expensive
- The synchronous tmux/system probe model still exists.
- It has only been de-pressurized, not redesigned.

### 3. Live service ownership is still not fully clean
- Recovery still relied on direct process/tmux intervention.
- This should be tightened before future rollout work.

## Recommended Follow-up
1. Reduce or redesign the expensive live local-sweep path in [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js), especially synchronous tmux probing.
2. Keep internal service-to-service fetches bounded everywhere. No unbounded local bridge/backend/web fetches should remain.
3. Tighten live operational ownership so service recovery does not depend on ad hoc tmux rescue.
4. Run a post-incident live load sanity pass with many agents online, bridge active, and repeated dashboard/detail/MCP activity.

## Bottom Line
- The severe incident is over.
- The live system is back to usable.
- The immediate failures were fixed.
- The deeper structural weakness is the expensive synchronous live sweep model plus previously unbounded internal bridge fetches.
- The remaining work is to turn the current mitigation into a durable code-level fix.
