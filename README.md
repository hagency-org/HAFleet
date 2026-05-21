# Agent Chat / Agent Chat 通讯系统

Agent Chat is a local-first coordination system for Claude Code, Codex, and other tmux-based agents. It provides a backend API, web dashboard, MCP tools, local push notifications, optional Matrix bridge, and command-line helpers for starting agents, sending messages, checking status, and operating remote relays.

Agent Chat 是一个本地优先的多 Agent 协作系统，面向 Claude Code、Codex 以及其他运行在 tmux 中的 Agent。它提供后端 API、Web Dashboard、MCP 工具、本地推送通知、可选 Matrix 桥接，以及用于启动 Agent、发送消息、查看状态和运维远程 relay 的 CLI。

## Architecture / 架构

| Component | Role | 中文说明 |
| --- | --- | --- |
| `backend-v2.js` | Central API, durable JSON stores, agent registry, task graphs, alerts, SSE stream, auth boundary | 核心后端，负责持久化、Agent 注册、任务图、告警、SSE 和认证边界 |
| `server.js` | Local dashboard and queue/reminder delivery surface | 本地 Dashboard，以及队列、提醒和页面代理层 |
| `push-relay.js` | Local SSE consumer that injects notifications into local tmux panes | 本机推送 relay，从后端接收 SSE 并注入本机 tmux pane |
| `mcp-server.js` | Per-agent MCP server exposing messaging tools to Claude/Codex | 每个 Agent 使用的 MCP 服务，提供消息工具 |
| `bridge-matrix.js` | Optional Matrix bridge for external rooms and operators | 可选 Matrix 桥接，用于外部房间和人工操作员 |
| `bin/agentchat` | Unified CLI dispatcher | 统一 CLI 入口 |
| `remote/` | Minimal remote relay package for other machines | 给其他机器使用的轻量远程 relay 包 |

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

## Prerequisites / 前置要求

Linux is the supported fresh-machine target for the full installer.

Linux 是当前全量安装脚本支持的目标系统。

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

## Quick Start / 快速开始

From a fresh Linux machine:

在一台新的 Linux 机器上：

```bash
git clone https://github.com/shisuiki/agent-chat.git
cd agent-chat
./install-full.sh
```

The installer checks prerequisites, runs `npm install`, creates `.env` from `.env.example` when needed, prompts for `API_TOKEN`, installs systemd units, links CLI commands into `~/.local/bin`, installs local skills, and configures Claude Code MCP when the `claude` CLI is available.

安装脚本会检查依赖、执行 `npm install`、在缺少 `.env` 时从 `.env.example` 创建配置、提示输入 `API_TOKEN`、安装 systemd unit、把 CLI 链接到 `~/.local/bin`、安装本地 skill，并在检测到 `claude` CLI 时配置 Claude Code MCP。

Verify services:

检查服务：

```bash
systemctl status agent-chat-v2
systemctl status agent-chat
systemctl status agent-chat-push-relay
```

Open the dashboard:

打开 Dashboard：

```text
http://127.0.0.1:8084
```

Start an agent:

启动一个 Agent：

```bash
agentchat up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh
```

Send a message:

发送消息：

```bash
agentchat send alice "hello from agentchat"
```

List agents:

查看 Agent：

```bash
agentchat ls
```

## Installation / 安装

Recommended command:

推荐命令：

```bash
./install-full.sh
```

Useful options:

常用选项：

| Option | Use | 中文说明 |
| --- | --- | --- |
| `--dry-run` | Print planned actions only | 只打印将执行的动作 |
| `--no-start` | Install files without enabling or restarting services | 只安装文件，不启动服务 |
| `--env-file PATH` | Use a custom env file | 指定自定义 `.env` 路径 |
| `--bin-dir PATH` | Link CLI commands into a custom directory | 指定 CLI 链接目录 |
| `--systemd-dir PATH` | Render service files into a custom directory | 指定 systemd unit 输出目录 |
| `--service-user USER` | Render systemd units for a specific user | 指定 systemd unit 的运行用户 |
| `--skip-mcp` | Skip Claude Code MCP configuration | 跳过 Claude Code MCP 配置 |
| `--skip-npm` | Skip `npm install` | 跳过 `npm install` |
| `--skip-prereq-check` | Skip host prerequisite checks | 跳过主机前置条件检查 |
| `--with-bridge` | Also install and start `bridge-matrix.service` | 同时安装并启动 Matrix bridge |

Legacy entrypoints `install.sh` and `install-v2.sh` are deprecated wrappers that delegate to `install-full.sh`.

旧入口 `install.sh` 和 `install-v2.sh` 已弃用，目前只是转发到 `install-full.sh` 的兼容 wrapper。

## Uninstallation / 卸载

Run:

执行：

```bash
./uninstall.sh
```

The uninstaller stops and removes systemd units, removes CLI symlinks that point into this checkout, removes Agent Chat skill links, removes the Claude Code MCP entry when possible, and removes `/etc/sudoers.d/agentchat-autodeploy`.

卸载脚本会停止并移除 systemd unit，移除指向当前 checkout 的 CLI symlink，移除 Agent Chat skill 链接，尽可能移除 Claude Code MCP 条目，并删除 `/etc/sudoers.d/agentchat-autodeploy`。

By default it preserves user data:

默认保留用户数据：

- `~/.agentchat/`
- `data/`
- `.env`

Optional destructive removals require explicit flags and confirmation:

需要显式参数和确认才会执行破坏性删除：

```bash
./uninstall.sh --purge-agentchat-home
./uninstall.sh --purge-data
```

For automation:

自动化场景：

```bash
./uninstall.sh --yes
```

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

中文说明：live checkout 被视为可丢弃运行目录；发布前先跑 `npm run verify:cd-preflight`，部署时使用 reset/clean 复位到 `origin/stable`，部署后用 `agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>` 校验实际运行版本。

## Configuration Reference / 配置参考

Most local configuration lives in `.env`. The installer creates it from `.env.example` if missing.

大多数本地配置位于 `.env`。安装脚本会在缺失时根据 `.env.example` 创建。

### Core / 核心

| Variable | Required | Default | Meaning / 中文说明 |
| --- | --- | --- | --- |
| `API_TOKEN` | Yes | none | Operator bearer token for backend, dashboard proxy, MCP, and relay calls。后端、Dashboard 代理、MCP 和 relay 调用使用的 bearer token |
| `AGENT_CHAT_API` | Optional | `http://127.0.0.1:8090` | Backend API base URL。后端 API 地址 |
| `AGENT_CHAT_RUNTIME_DIR` | Optional | repository root | Runtime root for `data/` and `logs/`。运行时数据根目录 |
| `AGENT_CHAT_BACKEND_PORT` | Optional | `8090` | Backend port。后端端口 |
| `AGENT_CHAT_WEB_PORT` | Optional | `8084` | Dashboard port。Dashboard 端口 |
| `AGENT_CHAT_WEB_URL` | Optional | `http://127.0.0.1:8084` | Dashboard base URL used by backend push queue calls。后端推送队列使用的 Dashboard 地址 |
| `AGENT_CHAT_QUEUE_URL` | Optional | `${AGENT_CHAT_WEB_URL}/api/queue` | Queue endpoint for backend push notifications。后端推送通知队列地址 |
| `AGENT_CHAT_DASHBOARD_TOKEN` | Optional | empty | Bearer token for non-local dashboard mutations。非本地 Dashboard 写操作 token |
| `AGENT_CHAT_SERVER` | Optional local, required remote | `local` or hostname | Server identity in runtime reports。服务器身份标识 |

`backend-v2.js` and `server.js` now fail fast when directly started without a non-empty `API_TOKEN`. Optional variables only warn or disable optional integrations.

`backend-v2.js` 和 `server.js` 直接启动时，如果 `API_TOKEN` 为空会明确报错并退出；可选变量缺失只会警告或禁用对应可选集成。

### Agent Runtime / Agent 运行时

| Variable | Default | Meaning / 中文说明 |
| --- | --- | --- |
| `AGENTCHAT_HOMEDIR` | `~/.agentchat` | Agent home root。Agent home 根目录 |
| `AGENTCHAT_AGENT_TOKEN_MODE` | `hard` in `.env.example` | Per-agent token enforcement mode。每个 Agent token 的校验模式 |
| `AGENT_IDLE_THRESHOLD_MS` | `20000` | Idle threshold for push delivery。推送前判断空闲的阈值 |
| `AGENT_SCOPE_MONITOR_ENABLED` | `true` | Enable local resource monitoring。启用本地资源监控 |
| `OFFLINE_CATCHUP_LIST_LIMIT` | `50` | Offline catchup message limit。离线补发消息上限 |
| `REMINDER_MERGE_PREVIEW_LIMIT` | `20` | Reminder merge preview limit。提醒合并预览上限 |

### Push Relay / 推送 Relay

| Variable | Default | Meaning / 中文说明 |
| --- | --- | --- |
| `PUSH_RELAY_MODE` | `local` | Local or remote relay profile。relay 运行模式 |
| `PUSH_RELAY_SCAN_INTERVAL_MS` | `30000` | Runtime scan interval。运行态扫描间隔 |
| `PUSH_RELAY_RECONNECT_MS` | `5000` | SSE reconnect interval。SSE 重连间隔 |
| `PUSH_RELAY_HEARTBEAT_INTERVAL_MS` | `15000` | Server heartbeat interval。服务器心跳间隔 |
| `VERIFY_SAMPLES` | `2` in remote example | Remote post-deploy verification samples。远程部署后校验采样次数 |
| `VERIFY_INTERVAL` | `16` in remote example | Remote verification interval seconds。远程校验采样间隔秒数 |

### Matrix Bridge / Matrix 桥接

| Variable | Default | Meaning / 中文说明 |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | `https://matrix.example.com` | Matrix homeserver。Matrix homeserver |
| `MATRIX_SERVER_NAME` | homeserver host | Matrix server name。Matrix 服务器名 |
| `MATRIX_BOT_USERNAME` | `agent-bridge` | Bridge bot username。桥接机器人用户名 |
| `MATRIX_BOT_PASSWORD` | empty | Bridge bot password。桥接机器人密码 |
| `MATRIX_REG_TOKEN` | empty | Registration token。注册 token |
| `MATRIX_TRUST_MODE` | `audit` | Room trust policy: `enforce`, `audit`, or `off`。房间信任策略 |
| `MATRIX_OPERATOR_MXIDS` | empty | Matrix users allowed to operate privileged commands。允许执行高权限命令的 Matrix 用户 |

### Supervisor and LLM / Supervisor 与 LLM

| Variable | Default | Meaning / 中文说明 |
| --- | --- | --- |
| `SUPERVISOR_ENABLED` | `false` | Enable supervisor loops。启用 supervisor 循环 |
| `SUPERVISOR_LLM_PROVIDER` | `deepseek` | Supervisor model provider。Supervisor 模型提供商 |
| `SUPERVISOR_LLM_MODEL` | `deepseek-chat` | Supervisor model。Supervisor 模型 |
| `SUPERVISOR_LLM_KEY` | placeholder | Provider API key。模型提供商 API key |
| `SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS` | `60000` | Supervisor lifecycle sweep interval。Supervisor 生命周期扫描间隔 |

### Remote and Release Gates / 远程与发布门禁

| Variable | Default | Meaning / 中文说明 |
| --- | --- | --- |
| `AGENTCHAT_DEPLOY_BRANCH` | `stable` in remote example | Branch watched by remote deploy scripts。远程部署脚本监听的分支 |
| `AGENTCHAT_RELEASE_GATE` | unset | Stable deploy gate command when enabled。stable 部署门禁命令 |
| `AGENTCHAT_DEPLOY_SERVICES` | script-specific | Services restarted by deploy scripts。部署脚本重启的服务列表 |
| `AGENTCHAT_VERIFY_REMOTE_BIN` | `bin/verify-remote` | Remote verification helper。远程校验工具 |

## Agent Management / Agent 管理

Common commands:

常用命令：

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

Dashboard 页面：

| Path | Purpose / 说明 |
| --- | --- |
| `/` | Fleet monitor。Agent 总览 |
| `/agents/<name>` | Agent detail, terminal capture, tasks, audit。Agent 详情、终端、任务和审计 |
| `/tasks` | Task list and task actions。任务列表与操作 |
| `/alerts` | Alert dashboard。告警面板 |
| `/config` | Agent and preset configuration。Agent 与预设配置 |

## Development Setup / 开发

Install dependencies:

安装依赖：

```bash
npm install
```

Run local services manually:

手动启动本地服务：

```bash
API_TOKEN=dev-token node backend-v2.js
API_TOKEN=dev-token node server.js
API_TOKEN=dev-token node push-relay.js
```

Run tests and gates:

运行测试和门禁：

```bash
npm test
npm run check:syntax
npm run check:cli-contract
npm run test:kernel
AGENT_NAME=agentchat-develop npm run verify:ci
```

Remote package checks:

远程包检查：

```bash
npm run build:remote:check
npm run check:remote-package-smoke
npm run check:remote-sync
```

The repository intentionally ignores runtime data, logs, local `.env`, local MCP config, generated `remote-dist/`, and stale backup directories. These files are not source of truth.

仓库会忽略运行时数据、日志、本地 `.env`、本地 MCP 配置、生成的 `remote-dist/` 以及 stale backup 目录。这些文件不是源码事实来源。

## Documentation / 文档

- `OPERATIONS.md` - Operator runbook for service health, deploys, incidents, and maintenance.
- `remote/README.md` - Remote relay package setup and operation.
- `ROADMAP-remote.md` — Superseded remote planning archive; keep it as historical context and use current runbooks instead.

## License / 许可证

No public license file is currently present. Treat this repository as private or all-rights-reserved unless the owner adds a license.

当前仓库没有公开许可证文件。在所有者添加许可证前，请按私有仓库或保留全部权利处理。
