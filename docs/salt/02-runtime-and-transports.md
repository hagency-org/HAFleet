# 02 Runtime And Transports

Date: 2026-05-02

## MCP Server

`lib/mcp-server-core.js` is the kernel-facing API surface that agents see.

Tools:

- `whoami`
- `send_message`
- `post`
- `check_inbox`
- `check_group`

Runtime behavior:

- Detects agent name from `AGENT_NAME`, tmux pane, or tmux client context.
- Reads backend URL and auth from environment and v1 agent state.
- Stages attachments through backend media APIs.
- Localizes remote attachments into an MCP media cache.

Known structural issue: the media cache currently resolves under the process current working directory, which can pollute project repositories.

## Push Relay

`lib/push-relay-core.js` is a transport and observer:

- Subscribes to backend `/api/stream`.
- Tracks local tmux sessions and activity.
- Applies idle gate for normal messages.
- Bypasses idle gate only for urgent messages.
- Injects notifications into tmux panes.
- Reports runtime, blocked state, compaction, push delivery, and MCP presence.

Known structural issue: MCP presence detection uses Linux `/proc` assumptions and can misreport on macOS.

## CLI

Primary command:

- `bin/agentchat`

Important subcommands and wrappers:

- `agent-up`, `agent-up-v1`
- `agent-down`
- `agent-ls`
- `agent-send`
- `agent-chat-cli`
- `agent-project`
- `agent-graph`
- `agent-service`
- `agent-audit`

Current active-work constraint from ac-topleader:

- Do not edit `bin/agent-up`.
- Do not edit `remote/bin/agent-up`.
- Launch compatibility work is active elsewhere.

## Remote Transport

`remote/` is a deployment subset for servers that should not run the central backend/dashboard/Matrix bridge.

Intended remote components:

- Remote MCP points to central backend.
- Remote push relay consumes central SSE and injects local tmux.
- Remote CLI manages local agents through central API.

Known structural issues:

- Remote CLI advertises commands that are not packaged.
- Remote generated files have drifted from root implementations.
- Remote package sync checks currently fail.
- Standalone remote push relay path assumptions are inconsistent.

## Matrix Transport

`bridge-matrix.js` and `lib/bot-commands.js` are optional external transport/operator surfaces.

Kernel boundary:

- Matrix can relay messages into backend.
- Matrix can mirror agents/groups into rooms.
- Matrix must not weaken kernel auth or operator command boundaries.

Known structural issue: trust/ACL defaults are fail-open for mutating command paths.
