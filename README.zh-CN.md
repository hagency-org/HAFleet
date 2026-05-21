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

安装脚本会检查依赖、执行 `npm install`、在缺少 `.env` 时从 `.env.example` 创建配置、提示输入 `API_TOKEN`、安装 systemd unit、把 CLI 命令链接到 `~/.local/bin`、安装本地 skill，并在检测到 `claude` CLI 时配置 Claude Code MCP。

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
| `--skip-mcp` | 跳过 Claude Code MCP 配置 |
| `--skip-npm` | 跳过 `npm install` |
| `--skip-prereq-check` | 跳过主机前置条件检查 |
| `--with-bridge` | 同时安装并启动 `bridge-matrix.service` |

旧入口 `install.sh` 和 `install-v2.sh` 已弃用，目前只是转发到 `install-full.sh` 的兼容 wrapper。

## 卸载

执行：

```bash
./uninstall.sh
```

卸载脚本会停止并移除 systemd unit，移除指向当前 checkout 的 CLI symlink，移除 Agent Chat skill 链接，尽可能移除 Claude Code MCP 条目，并删除 `/etc/sudoers.d/agentchat-autodeploy`。

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
| `AGENT_CHAT_WEB_URL` | 可选 | `http://127.0.0.1:8084` | 后端推送队列调用使用的控制台基础地址 |
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
