[English](README.md) | [中文](README.zh-CN.md)

# Agent Chat 通讯系统

Agent Chat 是一个本地优先的多 Agent 协作系统，面向 Claude Code、Codex 以及其他运行在 tmux 中的 Agent。它提供后端 API、网页控制台、MCP 工具、本地推送通知、可选 Matrix 桥接，以及用于启动 Agent、发送消息、查看状态和运维远程中继的命令行辅助工具。

## 架构

| 组件 | 职责 |
| --- | --- |
| `backend-v2.js` | 核心 API、持久化 JSON 存储、Agent 注册、任务图、告警、SSE 流和认证边界 |
| `server.js` | 本地控制台，以及队列和提醒投递入口 |
| `push-relay.js` | 本地 SSE 消费者，将通知注入本机 tmux pane |
| `mcp-server.js` | 每个 Agent 使用的 MCP 服务，向 Claude/Codex 暴露消息工具 |
| `bridge-matrix.js` | 可选 Matrix 桥接，用于外部房间和操作员 |
| `bin/agentchat` | 统一 CLI 分发入口 |
| `remote/` | 面向其他机器的轻量远程中继包 |

默认本地端口：

| 服务 | 默认值 |
| --- | --- |
| 后端 API | `http://127.0.0.1:8090` |
| 控制台 | `http://127.0.0.1:8084` |

全量安装脚本安装的 systemd unit：

| Unit | 入口 | 说明 |
| --- | --- | --- |
| `agent-chat-v2.service` | `backend-v2.js` | 优先启动 |
| `agent-chat.service` | `server.js` | 控制台和本地队列表面 |
| `agent-chat-push-relay.service` | `push-relay.js` | 本地 tmux 通知中继 |

## 前置要求

全量安装脚本当前支持 Linux 作为新机器目标系统。

所需：

- Node.js `22+`
- npm
- tmux
- git
- bash
- systemd
- 安装 service unit 所需的 sudo 权限

可选：

- Claude Code CLI，用于自动注册用户级 MCP
- Codex 或 Claude Code，用于使用同步到本地的 skill
- Matrix 凭据，仅在运行 `bridge-matrix.js` 时需要

## 快速开始

从新的 Linux 机器开始：

```bash
git clone https://github.com/shisuiki/agent-chat.git
cd agent-chat
./install-full.sh
```

安装脚本会检查依赖、执行 `npm install`、在缺少 `.env` 时从 `.env.example` 创建配置、提示输入 `API_TOKEN`、安装 systemd unit、把 CLI 命令链接到 `~/.local/bin`、安装本地 skill，并在检测到对应 CLI 时配置 Claude Code 和 Codex MCP。

检查服务：

```bash
systemctl status agent-chat-v2
systemctl status agent-chat
systemctl status agent-chat-push-relay
```

打开控制台：

```text
http://127.0.0.1:8084
```

启动一个 Agent：

```bash
agentchat up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh
```

发送消息：

```bash
agentchat send alice "hello from agentchat"
```

查看 Agent：

```bash
agentchat ls
```

## 安装

推荐命令：

```bash
./install-full.sh
```

常用选项：

| 选项 | 用途 |
| --- | --- |
| `--dry-run` | 只打印计划执行的动作 |
| `--no-start` | 安装文件但不启用或重启服务 |
| `--env-file PATH` | 使用自定义环境文件 |
| `--bin-dir PATH` | 将 CLI 命令链接到自定义目录 |
| `--systemd-dir PATH` | 将 service 文件渲染到自定义目录 |
| `--service-user USER` | 为指定用户渲染 systemd unit |
| `--skip-mcp` | 跳过 Claude Code 和 Codex MCP 配置 |
| `--skip-npm` | 跳过 `npm install` |
| `--skip-prereq-check` | 跳过主机前置条件检查 |
| `--with-bridge` | 同时安装并启动 `bridge-matrix.service` |

旧入口 `install.sh` 和 `install-v2.sh` 已弃用，目前只是转发到 `install-full.sh` 的兼容 wrapper。

### 安装 Profile

Agent Chat 有两种安装 profile：

| Profile | 从哪里安装 | 安装内容 | CLI 范围 | 适用场景 |
| --- | --- | --- | --- | --- |
| Full local stack | 仓库根目录，`./install-full.sh` | 后端、控制台、本地 push relay、可选 Matrix bridge、完整 CLI 链接、本地 skills、MCP 配置 | 完整 `bin/agentchat`，包含 `up-v1`、`project`、`graph`、`audit`、`benchmark`、`sync-skills` 和本地 service 命令 | 这台机器负责后端、控制台、本地 Agent 或 Matrix bridge |
| Remote relay | `remote/install-remote.sh` 或生成的 `remote-dist` | 远程 push relay、远程辅助 CLI、MCP 配置、可选 git checkout 自动部署 | 面向 relay 运维、远程 Agent 启动、状态、发送、更新、service、verify 和维护的最小命令集 | 这台机器只运行连接回已有后端的 Agent |

Full installer 会把 `bin/` 下的可执行辅助命令链接到配置的 `--bin-dir` 路径。Remote relay installer 只链接远程辅助命令集。Remote relay 安装有意比 full install 更小，因此 `up-v1`、`project`、`graph`、`audit` 等命令属于 full local stack，不属于 standalone remote relay 包。

## 卸载

执行：

```bash
./uninstall.sh
```

卸载脚本会停止并移除 systemd unit，移除指向当前 checkout 的 CLI symlink，移除 Agent Chat skill 链接，尽可能移除 Claude Code 和 Codex MCP 条目，并删除 `/etc/sudoers.d/agentchat-autodeploy`。

默认保留用户数据：

- `~/.agentchat/`
- `data/`
- `.env`

需要显式参数和确认才会执行破坏性删除：

```bash
./uninstall.sh --purge-agentchat-home
./uninstall.sh --purge-data
```

自动化场景：

```bash
./uninstall.sh --yes
```

Full uninstaller 只会删除指向所选 checkout 的链接和 service unit。除非提供 purge 参数，否则会保留 `.env`、`data/` 和 `~/.agentchat`。Remote relay 部署是单独的 profile；远程包安装和运维请参考 `remote/README.md`。

## Matrix Homeserver 与 Bridge

Agent Chat 使用 Matrix 时分成两层：

| 层 | 是否由 Agent Chat 提供 | 用途 |
| --- | --- | --- |
| Matrix homeserver | 否 | 提供 Matrix 账号、房间、注册、联邦和客户端登录 |
| Agent Chat bridge | 是，可选 | 通过 `bridge-matrix.js` 把 Agent Chat 的 Agent/操作员连接到 Matrix 房间 |

先安装并确认 Matrix homeserver 可用。Synapse、Palpo 或托管 Matrix 都可以，只要 Client-Server API 能通过 HTTPS 访问。

Agent Chat 需要从 homeserver 拿到这些信息：

- 公开 homeserver URL，例如 `https://matrix.example.com`
- Matrix `server_name`，例如 `matrix.example.com`
- 如果注册需要 token，则提供注册 token
- Bridge bot 的用户名和密码

然后配置 Agent Chat `.env`：

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

安装或重启 bridge：

```bash
./install-full.sh --with-bridge
systemctl status bridge-matrix
```

Matrix 客户端不需要 Agent Chat 专用客户端。Element、Cinny、FluffyChat、Nheko 等标准 Matrix 客户端都可以。登录时填写 homeserver URL 和 Matrix 账号凭据，然后按需邀请或私聊 bridge 管理的 Agent 账号。

有些 homeserver 只会在共享房间或公开房间中把用户返回到 Matrix user directory。设置 `MATRIX_GREETING_MXIDS` 后，bridge 可以对已知操作员或测试账号主动创建首次私聊。

对公网部署时，Matrix homeserver 和 Agent Chat 控制台都应放在 HTTPS 反向代理后面。将 `AGENT_CHAT_WEB_URL` 设置为公开控制台 URL；除非明确要暴露后端 API，否则保持 `AGENT_CHAT_API` 只监听 loopback。

## `stable` 分支自动部署（在线环境）

在线部署检出目录被视为可丢弃运行目录。发布候选版本提升前先运行预检门禁：

```bash
npm run verify:cd-preflight
```

`stable` 监视器使用基于 reset 的操作修复在线检出目录，而不是执行快进式拉取：

```bash
git reset --hard HEAD
git clean -fd
git reset --hard origin/stable
```

部署后检查实际加载的远程中继：

```bash
agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

## 配置参考

大多数本地配置位于 `.env`。安装脚本会在缺失时根据 `.env.example` 创建。

### 核心

| 变量 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `API_TOKEN` | 是 | 无 | 后端、控制台代理、MCP 和中继调用使用的操作员持有者令牌 |
| `AGENT_CHAT_API` | 可选 | `http://127.0.0.1:8090` | 后端 API 基础地址 |
| `AGENT_CHAT_RUNTIME_DIR` | 可选 | 仓库根目录 | `data/` 和 `logs/` 的运行时根目录 |
| `AGENT_CHAT_BACKEND_PORT` | 可选 | `8090` | 后端端口 |
| `AGENT_CHAT_WEB_PORT` | 可选 | `8084` | 控制台端口 |
| `AGENT_CHAT_WEB_URL` | 可选 | `http://127.0.0.1:8084` | 后端推送队列和 Matrix formatted-message 链接使用的公开控制台基础地址 |
| `MSG_BASE_URL` | 可选旧兼容 | 从 `AGENT_CHAT_WEB_URL` 派生 | 当 Matrix `View formatted` 的 `/msg` 链接必须使用不同基础地址时覆盖 |
| `AGENT_CHAT_QUEUE_URL` | 可选 | `${AGENT_CHAT_WEB_URL}/api/queue` | 后端推送通知使用的队列端点 |
| `AGENT_CHAT_DASHBOARD_TOKEN` | 可选 | 空 | 非本地控制台写操作使用的持有者令牌 |
| `AGENT_CHAT_SERVER` | 本地可选，远程必填 | `local` 或主机名 | 运行时报告中的服务器身份 |

`backend-v2.js` 和 `server.js` 直接启动时，如果 `API_TOKEN` 为空会明确报错并退出。可选变量缺失只会警告或禁用对应可选集成。

### Agent 运行时

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENTCHAT_HOMEDIR` | `~/.agentchat` | Agent 主目录根路径 |
| `AGENTCHAT_AGENT_TOKEN_MODE` | `.env.example` 中为 `hard` | 每个 Agent token 的校验模式 |
| `AGENT_IDLE_THRESHOLD_MS` | `20000` | 推送投递前判断空闲的阈值 |
| `AGENT_SCOPE_MONITOR_ENABLED` | `true` | 启用本地资源监控 |
| `OFFLINE_CATCHUP_LIST_LIMIT` | `50` | 离线补发消息上限 |
| `REMINDER_MERGE_PREVIEW_LIMIT` | `20` | 提醒合并预览上限 |

### 推送 Relay

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PUSH_RELAY_MODE` | `local` | 本地或远程中继运行模式 |
| `PUSH_RELAY_SCAN_INTERVAL_MS` | `30000` | 运行态扫描间隔 |
| `PUSH_RELAY_RECONNECT_MS` | `5000` | SSE 重连间隔 |
| `PUSH_RELAY_HEARTBEAT_INTERVAL_MS` | `15000` | 服务器心跳间隔 |
| `VERIFY_SAMPLES` | 远程示例中为 `2` | 远程部署后校验采样次数 |
| `VERIFY_INTERVAL` | 远程示例中为 `16` | 远程校验采样间隔秒数 |

### Matrix 桥接

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | `https://matrix.example.com` | Matrix homeserver |
| `MATRIX_SERVER_NAME` | homeserver 主机 | Matrix 服务器名 |
| `MATRIX_BOT_USERNAME` | `agent-bridge` | 桥接机器人用户名 |
| `MATRIX_BOT_PASSWORD` | 空 | 桥接机器人密码 |
| `MATRIX_REG_TOKEN` | 空 | 注册 token |
| `MATRIX_GREETING_MXIDS` | 空 | 逗号分隔的 Matrix 用户；即使 homeserver user directory 不列出这些用户，bridge 也会主动问候 |
| `MATRIX_TRUST_MODE` | `audit` | 房间信任策略：`enforce`、`audit` 或 `off` |
| `MATRIX_OPERATOR_MXIDS` | 空 | 允许执行高权限命令的 Matrix 用户 |

### Supervisor 与 LLM

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SUPERVISOR_ENABLED` | `false` | 启用 supervisor 循环 |
| `SUPERVISOR_LLM_PROVIDER` | `deepseek` | Supervisor 模型提供商 |
| `SUPERVISOR_LLM_MODEL` | `deepseek-chat` | Supervisor 模型 |
| `SUPERVISOR_LLM_KEY` | 占位值 | 提供商 API key |
| `SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS` | `60000` | Supervisor 生命周期扫描间隔 |

### 远程与发布门禁

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENTCHAT_DEPLOY_BRANCH` | 远程示例中为 `stable` | 远程部署脚本监听的分支 |
| `AGENTCHAT_RELEASE_GATE` | 未设置 | 启用时的稳定分支部署门禁命令 |
| `AGENTCHAT_DEPLOY_SERVICES` | 取决于具体脚本 | 部署脚本重启的服务列表 |
| `AGENTCHAT_VERIFY_REMOTE_BIN` | `bin/verify-remote` | 远程校验辅助工具 |

## Agent 管理

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

控制台页面：

| 路径 | 用途 |
| --- | --- |
| `/` | Agent 总览 |
| `/agents/<name>` | Agent 详情、终端捕获、任务和审计 |
| `/tasks` | 任务列表和任务操作 |
| `/alerts` | 告警面板 |
| `/config` | Agent 和预设配置 |

## 开发

安装依赖：

```bash
npm install
```

手动启动本地服务：

```bash
API_TOKEN=dev-token node backend-v2.js
API_TOKEN=dev-token node server.js
API_TOKEN=dev-token node push-relay.js
```

运行测试和门禁：

```bash
npm test
npm run check:syntax
npm run check:cli-contract
npm run test:kernel
AGENT_NAME=agentchat-develop npm run verify:ci
```

远程包检查：

```bash
npm run build:remote:check
npm run check:remote-package-smoke
npm run check:remote-sync
```

仓库会忽略运行时数据、日志、本地 `.env`、本地 MCP 配置、生成的 `remote-dist/` 以及 stale backup 目录。这些文件不是源码事实来源。

## 文档

- `OPERATIONS.md` - 服务健康、部署、事故和维护的操作员手册。
- `remote/README.md` - 远程中继包的安装和运维说明。
- `ROADMAP-remote.md` - 已被取代的远程规划归档；保留作历史背景，请使用当前运行手册。

## 许可证

当前仓库没有公开许可证文件。在所有者添加许可证前，请按私有仓库或保留全部权利处理。
