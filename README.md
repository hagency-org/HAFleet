[English](README.md) | [中文](README.zh-CN.md)

# Agent Chat

Agent Chat is a local-first coordination system for Claude Code, Codex, and other tmux-based agents. It provides a backend API, web dashboard, MCP tools, local push notifications, optional Matrix bridge, and command-line helpers for starting agents, sending messages, checking status, and operating remote relays.

## Architecture

| Component | Role |
| --- | --- |
| `backend-v2.js` | Central API, durable JSON stores, agent registry, task graphs, alerts, SSE stream, auth boundary |
| `server.js` | Local dashboard and queue/reminder delivery surface |
| `push-relay.js` | Local SSE consumer that injects notifications into local tmux panes |
| `mcp-server.js` | Per-agent MCP server exposing messaging tools to Claude/Codex |
| `bridge-matrix.js` | Optional Matrix bridge for external rooms and operators |
| `bin/agentchat` | Unified CLI dispatcher |
| `remote/` | Minimal remote relay package for other machines |

Default local ports:

| Service | Default |
| --- | --- |
| Backend API | `http://127.0.0.1:8090` |
| Dashboard | `http://127.0.0.1:8084` |

Systemd units installed by the full installer:

| Unit | Entrypoint | Notes |
| --- | --- | --- |
| `agent-chat-v2.service` | `backend-v2.js` | Starts first |
| `agent-chat.service` | `server.js` | Dashboard and local queue surface |
| `agent-chat-push-relay.service` | `push-relay.js` | Local tmux notification relay |

## Prerequisites

Linux is the supported fresh-machine target for the full installer.

Required:

- Node.js `22+`
- npm
- tmux
- git
- bash
- systemd
- sudo access for installing service units

Optional:

- Claude Code CLI, for automatic user-level MCP registration
- Codex or Claude Code, for using the synced local skill
- Matrix credentials, only if you run `bridge-matrix.js`

## Quick Start

From a fresh Linux machine:

```bash
git clone https://github.com/shisuiki/agent-chat.git
cd agent-chat
./install-full.sh
```

The installer checks prerequisites, runs `npm install`, creates `.env` from `.env.example` when needed, prompts for `API_TOKEN`, installs systemd units, links CLI commands into `~/.local/bin`, installs local skills, and configures Claude Code and Codex MCP when the CLIs are available.

Verify services:

```bash
systemctl status agent-chat-v2
systemctl status agent-chat
systemctl status agent-chat-push-relay
```

Open the dashboard:

```text
http://127.0.0.1:8084
```

Start an agent:

```bash
agentchat up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh
```

Send a message:

```bash
agentchat send alice "hello from agentchat"
```

List agents:

```bash
agentchat ls
```

## Installation

Recommended command:

```bash
./install-full.sh
```

Useful options:

| Option | Use |
| --- | --- |
| `--dry-run` | Print planned actions only |
| `--no-start` | Install files without enabling or restarting services |
| `--env-file PATH` | Use a custom env file |
| `--bin-dir PATH` | Link CLI commands into a custom directory |
| `--systemd-dir PATH` | Render service files into a custom directory |
| `--service-user USER` | Render systemd units for a specific user |
| `--skip-mcp` | Skip Claude Code and Codex MCP configuration |
| `--skip-npm` | Skip `npm install` |
| `--skip-prereq-check` | Skip host prerequisite checks |
| `--with-bridge` | Also install and start `bridge-matrix.service` |

Legacy entrypoints `install.sh` and `install-v2.sh` are deprecated wrappers that delegate to `install-full.sh`.

### Installation Profiles

Agent Chat has two installation profiles:

| Profile | Install from | Installs | CLI scope | Use when |
| --- | --- | --- | --- | --- |
| Full local stack | repository root, `./install-full.sh` | Backend, dashboard, local push relay, optional Matrix bridge, full CLI links, local skills, MCP config | Full `bin/agentchat`, including `up-v1`, `project`, `graph`, `audit`, `benchmark`, `sync-skills`, and local service commands | This machine owns the backend, dashboard, local agents, or Matrix bridge |
| Remote relay | `remote/install-remote.sh` or generated `remote-dist` | Remote push relay, remote helper CLI, MCP config, optional git-checkout autodeploy | Minimal remote commands for relay operation, remote agent launch, status, send, update, service, verify, and maintenance | This machine only runs agents that connect back to an existing backend |

The full installer links every executable helper from `bin/` into the configured `--bin-dir` path. The remote relay installer links the remote helper set only. Remote relay installs are intentionally smaller than full installs, so commands such as `up-v1`, `project`, `graph`, and `audit` are available from the full local stack, not from standalone remote relay packages.

## Uninstallation

Run:

```bash
./uninstall.sh
```

The uninstaller stops and removes systemd units, removes CLI symlinks that point into this checkout, removes Agent Chat skill links, removes Claude Code and Codex MCP entries when possible, and removes `/etc/sudoers.d/agentchat-autodeploy`.

By default it preserves user data:

- `~/.agentchat/`
- `data/`
- `.env`

Optional destructive removals require explicit flags and confirmation:

```bash
./uninstall.sh --purge-agentchat-home
./uninstall.sh --purge-data
```

For automation:

```bash
./uninstall.sh --yes
```

The full uninstaller only removes links and service units that point into the selected checkout. It preserves `.env`, `data/`, and `~/.agentchat` unless purge flags are provided. Remote relay deployments are operated as a separate profile; see `remote/README.md` for remote package setup and operations.

## Matrix Homeserver and Bridge

Agent Chat can use Matrix in two layers:

| Layer | Owned by Agent Chat? | Purpose |
| --- | --- | --- |
| Matrix homeserver | No | Provides Matrix accounts, rooms, registration, federation, and client login |
| Agent Chat bridge | Yes, optional | Connects Agent Chat agents/operators to Matrix rooms through `bridge-matrix.js` |

Install and verify the Matrix homeserver first. Synapse, Palpo, and managed Matrix hosting are all acceptable as long as the Client-Server API is reachable over HTTPS.

Minimum homeserver outputs needed by Agent Chat:

- Public homeserver URL, for example `https://matrix.example.com`
- Matrix `server_name`, for example `matrix.example.com`
- Registration token if account registration is token-gated
- Bridge bot username and password

Then configure Agent Chat `.env`:

```bash
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_SERVER_NAME=matrix.example.com
MATRIX_BOT_USERNAME=agent-bridge
MATRIX_BOT_PASSWORD=<bridge-bot-password>
MATRIX_REG_TOKEN=<homeserver-registration-token>
MATRIX_AGENT_PREFIX=ac_
MATRIX_AGENT_PASSWORD_SECRET=<random-long-secret>
MATRIX_TRUST_MODE=audit
MATRIX_OPERATOR_MXIDS=@operator:matrix.example.com
MATRIX_GREETING_MXIDS=@operator:matrix.example.com
```

Install or restart the bridge:

```bash
./install-full.sh --with-bridge
systemctl status bridge-matrix
```

Matrix clients do not need to be Agent Chat-specific. Use any Matrix client, such as Element, Cinny, FluffyChat, or Nheko. Log in with the homeserver URL and Matrix account credentials, then invite or DM the bridge-managed agent accounts as needed.

Some homeservers only return users from the Matrix user directory after they share a room or appear in a public room. Set `MATRIX_GREETING_MXIDS` to let the bridge proactively create first-contact DMs for known operators or test accounts.

For internet-facing deployments, put both the Matrix homeserver and Agent Chat dashboard behind HTTPS reverse proxies. Set `AGENT_CHAT_WEB_URL` to the public dashboard URL and keep `AGENT_CHAT_API` loopback-only unless you explicitly intend to expose the backend API.

## Stable Branch Auto Deploy (Live)

The live deploy checkout is disposable. Run the preflight gate before promoting a deploy candidate:

```bash
npm run verify:cd-preflight
```

The stable watcher repairs the live checkout with reset-based operations instead of fast-forward pulls:

```bash
git reset --hard HEAD
git clean -fd
git reset --hard origin/stable
```

After deployment, verify the loaded remote relay:

```bash
agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

## Configuration Reference

Most local configuration lives in `.env`. The installer creates it from `.env.example` if missing.

### Core

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `API_TOKEN` | Yes | none | Operator bearer token for backend, dashboard proxy, MCP, and relay calls |
| `AGENT_CHAT_API` | Optional | `http://127.0.0.1:8090` | Backend API base URL |
| `AGENT_CHAT_RUNTIME_DIR` | Optional | repository root | Runtime root for `data/` and `logs/` |
| `AGENT_CHAT_BACKEND_PORT` | Optional | `8090` | Backend port |
| `AGENT_CHAT_WEB_PORT` | Optional | `8084` | Dashboard port |
| `AGENT_CHAT_WEB_URL` | Optional | `http://127.0.0.1:8084` | Public dashboard base URL used by backend push queue calls and Matrix formatted-message links |
| `MSG_BASE_URL` | Optional legacy | derived from `AGENT_CHAT_WEB_URL` | Override for Matrix `View formatted` `/msg` links when they must use a different base URL |
| `AGENT_CHAT_QUEUE_URL` | Optional | `${AGENT_CHAT_WEB_URL}/api/queue` | Queue endpoint for backend push notifications |
| `AGENT_CHAT_DASHBOARD_TOKEN` | Optional | empty | Bearer token for non-local dashboard mutations |
| `AGENT_CHAT_SERVER` | Optional local, required remote | `local` or hostname | Server identity in runtime reports |

`backend-v2.js` and `server.js` now fail fast when directly started without a non-empty `API_TOKEN`. Optional variables only warn or disable optional integrations.

### Agent Runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTCHAT_HOMEDIR` | `~/.agentchat` | Agent home root |
| `AGENTCHAT_AGENT_TOKEN_MODE` | `hard` in `.env.example` | Per-agent token enforcement mode |
| `AGENT_IDLE_THRESHOLD_MS` | `20000` | Idle threshold for push delivery |
| `AGENT_SCOPE_MONITOR_ENABLED` | `true` | Enable local resource monitoring |
| `OFFLINE_CATCHUP_LIST_LIMIT` | `50` | Offline catchup message limit |
| `REMINDER_MERGE_PREVIEW_LIMIT` | `20` | Reminder merge preview limit |

### Push Relay

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUSH_RELAY_MODE` | `local` | Local or remote relay profile |
| `PUSH_RELAY_SCAN_INTERVAL_MS` | `30000` | Runtime scan interval |
| `PUSH_RELAY_RECONNECT_MS` | `5000` | SSE reconnect interval |
| `PUSH_RELAY_HEARTBEAT_INTERVAL_MS` | `15000` | Server heartbeat interval |
| `VERIFY_SAMPLES` | `2` in remote example | Remote post-deploy verification samples |
| `VERIFY_INTERVAL` | `16` in remote example | Remote verification interval seconds |

### Matrix Bridge

| Variable | Default | Meaning |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | `https://matrix.example.com` | Matrix homeserver |
| `MATRIX_SERVER_NAME` | homeserver host | Matrix server name |
| `MATRIX_BOT_USERNAME` | `agent-bridge` | Bridge bot username |
| `MATRIX_BOT_PASSWORD` | empty | Bridge bot password |
| `MATRIX_REG_TOKEN` | empty | Registration token |
| `MATRIX_GREETING_MXIDS` | empty | Comma-separated Matrix users the bridge should proactively greet even if the homeserver user directory does not list them |
| `MATRIX_TRUST_MODE` | `audit` | Room trust policy: `enforce`, `audit`, or `off` |
| `MATRIX_OPERATOR_MXIDS` | empty | Matrix users allowed to operate privileged commands |

### Supervisor and LLM

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPERVISOR_ENABLED` | `false` | Enable supervisor loops |
| `SUPERVISOR_LLM_PROVIDER` | `deepseek` | Supervisor model provider |
| `SUPERVISOR_LLM_MODEL` | `deepseek-chat` | Supervisor model |
| `SUPERVISOR_LLM_KEY` | placeholder | Provider API key |
| `SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS` | `60000` | Supervisor lifecycle sweep interval |

### Remote and Release Gates

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTCHAT_DEPLOY_BRANCH` | `stable` in remote example | Branch watched by remote deploy scripts |
| `AGENTCHAT_RELEASE_GATE` | unset | Stable deploy gate command when enabled |
| `AGENTCHAT_DEPLOY_SERVICES` | script-specific | Services restarted by deploy scripts |
| `AGENTCHAT_VERIFY_REMOTE_BIN` | `bin/verify-remote` | Remote verification helper |

## Agent Management

Common commands:

```bash
agentchat up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh
agentchat ls
agentchat send alice "status?"
agentchat down alice
agentchat service status
agentchat check-mcp
agentchat sync-skills
agentchat maintain --dry-run
```

Dashboard pages:

| Path | Purpose |
| --- | --- |
| `/` | Fleet monitor |
| `/agents/<name>` | Agent detail, terminal capture, tasks, audit |
| `/tasks` | Task list and task actions |
| `/alerts` | Alert dashboard |
| `/config` | Agent and preset configuration |

## Development Setup

Install dependencies:

```bash
npm install
```

Run local services manually:

```bash
API_TOKEN=dev-token node backend-v2.js
API_TOKEN=dev-token node server.js
API_TOKEN=dev-token node push-relay.js
```

Run tests and gates:

```bash
npm test
npm run check:syntax
npm run check:cli-contract
npm run test:kernel
AGENT_NAME=agentchat-develop npm run verify:ci
```

Remote package checks:

```bash
npm run build:remote:check
npm run check:remote-package-smoke
npm run check:remote-sync
```

The repository intentionally ignores runtime data, logs, local `.env`, local MCP config, generated `remote-dist/`, and stale backup directories. These files are not source of truth.

## Documentation

- `OPERATIONS.md` - Operator runbook for service health, deploys, incidents, and maintenance.
- `remote/README.md` - Remote relay package setup and operation.
- `ROADMAP-remote.md` — Superseded remote planning archive; keep it as historical context and use current runbooks instead.

## License

No public license file is currently present. Treat this repository as private or all-rights-reserved unless the owner adds a license.
