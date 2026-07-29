[English](README.md) | [中文](README.zh-CN.md)

# HAFleet

**交互式编码 agent 舰队的控制面。**

HAFleet 把 Claude Code 和 Codex agent 跑在 tmux pane 里，并补上它们本身没有的东西：
身份、消息总线、共享任务系统、人类监督，以及一个可选的 Matrix 门面。它是
local-first 的 —— 后端在构造上就只监听 loopback，任何东西都不需要离开这台机器。

HAFleet 是 [agent-chat](https://github.com/shisuiki/agent-chat) 的 fork。许多内部
标识符仍带 `agent-chat` / `AGENTCHAT_` 前缀；那些是稳定接口，刻意保持不变，
见下文[命名](#命名)。

## 目录

| 章节 | |
|---|---|
| [能做什么](#能做什么) | 能力面 |
| [架构](#架构) | 组件与分层 |
| [安装](#安装) | 五条路径，按主机用途选 |
| [快速上手](#快速上手) | 第一个 agent，第一条消息 |
| [运维](#运维) | 升级、回滚、验证 |
| [配置](#配置) | `.env` 参考 |
| [安全立场](#安全立场) | 强制了什么，假设了什么 |
| [开发](#开发) | 测试与门禁 |

## 能做什么

**舰队生命周期。** 以 tmux session 的形式启动、停止、列出、恢复 agent。每 agent
独立的 home 目录、项目挂载，以及可复用的 framework preset。

**消息总线。** agent 之间并不直接对话 —— 它们对话的对象是总线。DM、群组、信箱语义
（agent 忙时消息会留存）、离线补投、投递回执、附件。消息可携带结构化的
`schema: {kind, version, payload}` 信封，第三方执行后端就是靠这个接入的。

**任务系统。** 任务存储加上**任务图**：一个 DAG，每个节点带 assignee、依赖和可选
条件。上游结果会被注入下游派发，且只有被指派者能关闭自己的节点。

**注意力路由。** 后端发出 SSE，push relay 消费它，并通过*向 agent 的 tmux pane 里
打字*来投递。它还从 pane 输出推断状态 —— 空闲/活跃、卡在提示上、上下文压缩。

**11 个 MCP 工具**：`whoami`、`send_message`、`post`、`check_inbox`、`check_group`、
`list_tasks`、`get_task`、`accept_task`、`transition_task`、`comment_task`、
`update_task_execution`。

**人在环审批。** 编码运行时的权限请求被转给**归属开发者**，而不是房间里的所有人。

**可选 Matrix 桥。** 把 agent 放进真实的 Matrix 房间，于是你能用手机上的 Element
找到它们。每 agent 独立账号、E2EE、信任模型，以及 20 个 `!` 运维命令。

**可选 supervisor。** 盯着 agent 并升级：连续 N 次负面评估后先 nudge，再升级。
它只能发消息，不能启动、停止或改派。

接口面：**101 个 REST 端点**、**19 个 CLI 子命令**、**11 个 MCP 工具**、
**7 个 dashboard 页面**、**4 个运行依赖**。

## 架构

| 组件 | 职责 |
| --- | --- |
| `backend-v2.js` | 中央 API、持久 JSON 存储、agent 注册表、任务图、告警、SSE 流、鉴权边界 |
| `server.js` | Dashboard 与队列/提醒投递面 |
| `push-relay.js` | SSE 消费者，向 tmux pane 注入通知 |
| `mcp-server.js` | 每 agent 一个 MCP server，暴露消息与任务工具 |
| `bridge-matrix.js` | 可选的 Matrix 桥，对接外部房间与运维人员 |
| `services/agentchat-services.mjs` | 非 systemd 的进程 supervisor（macOS 上的运行方式） |
| `bin/agentchat` | 统一 CLI 分发器 |
| `remote/` | 给其它机器用的最小远程 relay 包 |

三层同心结构，在 `scripts/architecture-boundaries.json` 中声明，并**由 CI 强制**：

- **内核** —— `agent-state`、`task-graph`、`task-store`、`agent-launch-policy`。
  禁止 import backend、dashboard 或 `remote/`。
- **控制面** —— REST API、SSE、JSON 持久化，单进程。
- **边缘** —— tmux/CLI 胶水、Matrix 桥、dashboard、MCP。全部可选。

默认本地端口：

| 服务 | 默认 |
| --- | --- |
| 后端 API | `http://127.0.0.1:8090` |
| Dashboard | `http://127.0.0.1:8084` |

systemd 单元（Linux），全部带沙箱与资源限制：

| 单元 | 入口 | 说明 |
| --- | --- | --- |
| `agent-chat-v2.service` | `backend-v2.js` | 最先启动 |
| `agent-chat.service` | `server.js` | Dashboard 与本地队列面 |
| `agent-chat-push-relay.service` | `push-relay.js` | tmux 通知 relay |
| `bridge-matrix.service` | `bridge-matrix.js` | 可选，`--with-bridge` |
| `agent-chat-stable-autodeploy.service` | 监视器 | 可选；非特权运行 |

## 安装

五条路径，按主机用途选 —— 完整细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

| 路径 | 主机 | 何时用 |
| --- | --- | --- |
| Bootstrap | Linux + systemd | 常规情况 |
| 手动 clone | Linux + systemd | 想把 checkout 放在指定位置 |
| **macOS** | macOS | Mac 主机：launchd + 受管服务 |
| 容器 | 任意 | 只跑控制面，没有本地 agent |
| 远程 relay | Linux 或 macOS | 只跑 agent，回报给别处的后端 |

### Bootstrap（推荐，Linux）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/hagency-org/HAFleet/master/install/bootstrap.sh)
```

下载已发布的 release tarball，**用 `SHA256SUMS` 校验**后解包 —— 不需要 git。
校验不通过会直接中止，而不是退回克隆。安装器参数放在 `--` 之后：

```bash
bash <(curl -fsSL .../bootstrap.sh) -- --dry-run
bash <(curl -fsSL .../bootstrap.sh) --ref v1.2.0 -- --with-bridge
bash <(curl -fsSL .../bootstrap.sh) --list
```

### 手动 clone（Linux）

```bash
git clone https://github.com/hagency-org/HAFleet.git
cd HAFleet
./install-full.sh --dry-run   # 先审阅每一步动作
./install-full.sh
```

| 参数 | 用途 |
| --- | --- |
| `--dry-run` | 只打印计划动作，不做任何改动 |
| `--no-start` | 安装文件但不 enable/restart 服务 |
| `--with-bridge` | 同时安装并启动 `bridge-matrix.service` |
| `--env-file PATH` | 使用自定义 env 文件 |
| `--bin-dir PATH` | 把 CLI 命令链接到自定义目录 |
| `--systemd-dir PATH` | 把 service 文件渲染到自定义目录 |
| `--service-user USER` | 为指定用户渲染单元 |
| `--skip-mcp` | 跳过 Claude Code 与 Codex 的 MCP 配置 |
| `--skip-npm` | 跳过 `npm install` |
| `--skip-prereq-check` | 跳过宿主前置检查 |

`install.sh` 与 `install-v2.sh` 是已废弃的转发壳，会委派到这里。

### macOS

`install-full.sh` 在 macOS 上会拒绝运行，因为它渲染的是 systemd 单元。

```bash
./install/install-macos.sh --dry-run
./install/install-macos.sh
```

用 launchd 用户 agent 代替 systemd，用 `agentchat-services.mjs` 作 supervisor，
Matrix 桥默认关闭，且没有 autodeploy 监视器。缺失的前置（`node >= 22`、`tmux`）
会用 Homebrew 安装。

> **如果已存在无关的 tmux session，它会拒绝继续。** HAFleet 会把 tmux session
> 注册成 agent，而 relay 的投递方式就是往它们的 pane 里打字 —— 在共享主机上，
> 这意味着它可能打进别人的工作里。请先停掉或改名，或用
> `--allow-existing-tmux` 在知情的前提下接受这个风险。

### 前置条件

| | Linux | macOS |
| --- | --- | --- |
| Node.js | `22+` | `22+` |
| tmux、git、bash | 必需 | 必需 |
| systemd + sudo | 必需 | 不适用（launchd） |
| Homebrew | 不适用 | 装前置时必需 |

可选：Claude Code 或 Codex CLI 用于自动 MCP 注册；只有跑桥时才需要 Matrix 凭证。

### 卸载

```bash
./uninstall.sh              # 保留 ~/.agentchat、data/、.env
./uninstall.sh --yes        # 非交互
./uninstall.sh --purge-data --purge-agentchat-home   # 破坏性，需二次确认
```

卸载器只移除指向*本* checkout 的符号链接与单元，且只删它自己拥有的 skill 目录。

## 快速上手

```bash
# 启动一个 agent
agentchat up-v1 alice codex --project "$HOME/projects/example" --project-mode symlink --fresh

# 跟它说话
agentchat send alice "status?"

# 看舰队
agentchat ls
agentchat service status
```

然后打开 `http://127.0.0.1:8084`。

Dashboard 页面：

| 路径 | 用途 |
| --- | --- |
| `/` | 舰队监控 |
| `/agents/<name>` | agent 详情、终端捕获、任务、审计、DM 框 |
| `/tasks` | 任务列表与操作 |
| `/projects` | 项目板 |
| `/pool` | agent 池 |
| `/alerts` | 告警 |
| `/config` | agent 与 preset 配置 |

联系 agent 有五条路径：dashboard 的 DM 框、Matrix、`agentchat send`、直接 attach
到 pane，或 REST API。全部都是**等 agent 空闲时**才投递 —— 没有打断机制。

## 运维

### 验证

```bash
systemctl status agent-chat-v2 agent-chat agent-chat-push-relay
node services/standalone-doctor.mjs     # 跨组件健康
agentchat check-mcp
node -e 'import("./lib/version.js").then(m=>console.log(m.formatBuildIdentity()))'
```

### 升级，失败自动回退

```bash
./upgrade.sh --list          # 当前版本与可用发布
./upgrade.sh --to v1.3.0     # 把门、应用、健康检查、失败即回退
```

它拒绝在脏工作树上运行，会在一个一次性 worktree 里对**目标** ref 把门，因此有问题
的目标绝不会碰到线上 checkout；新版本起不来就回退。退出码 `1` 表示回退成功，
`2` 表示回退也失败、需要人介入。

### 自动部署（可选）

监视器轮询部署分支、对候选把门、然后重启。它以**非特权**身份运行，仅通过一条窄
sudoers 规则为 `systemctl restart` 提权，且发布门禁**默认开启**。

健康门禁失败时，它把线上 checkout 回退到上一个健康 ref，并**隔离**那个坏 ref，
于是同一个 commit 不会被无限重部。推一个修复即可清除隔离。见
[docs/ROLLBACK.md](docs/ROLLBACK.md)。

### stable 分支自动部署（线上）

线上部署 checkout 是**可丢弃的**。在把候选提升为部署目标之前，先跑预检门禁：

```bash
npm run verify:cd-preflight
```

监视器用 reset 类操作修复线上 checkout，而不是 fast-forward pull，这样已分叉或
脏掉的 checkout 永远不会卡住部署：

```bash
git reset --hard HEAD
git clean -fd
git reset --hard origin/stable
```

部署之后，验证已加载的远程 relay：

```bash
agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>
```

### 发布

以 tag 驱动。推 `v1.3.0` 会跑门禁，并发布两个可复现、带校验和的 tarball ——
全栈包与远程 relay 包。见 [docs/RELEASING.md](docs/RELEASING.md)。

## 配置

配置主要在 `.env`，由安装器从 `.env.example` 创建。

> 受管服务这条路径**不会**自动加载 `.env`，请先 source：
> `set -a; . ./.env; set +a`

### 核心

| 变量 | 必需 | 默认 | 含义 |
| --- | --- | --- | --- |
| `API_TOKEN` | **是** | 无 | 后端、dashboard 代理、MCP 与 relay 的运维 bearer token |
| `AGENT_CHAT_API` | 否 | `http://127.0.0.1:8090` | 后端 API 基址 |
| `AGENT_CHAT_RUNTIME_DIR` | 否 | 仓库根 | `data/` 与 `logs/` 的运行根目录 |
| `AGENT_CHAT_BACKEND_PORT` | 否 | `8090` | 后端端口 |
| `AGENT_CHAT_WEB_PORT` | 否 | `8084` | Dashboard 端口 |
| `AGENT_CHAT_BACKEND_HOST` | 否 | `127.0.0.1` | 后端监听地址。**仅容器场景** —— 见[安全立场](#安全立场) |
| `AGENT_CHAT_WEB_HOST` | 否 | `127.0.0.1` | Dashboard 监听地址，同上 |
| `AGENT_CHAT_WEB_URL` | 否 | `http://127.0.0.1:8084` | 公开 dashboard 地址，用于推送队列调用与 Matrix 链接 |
| `AGENT_CHAT_QUEUE_URL` | 否 | `${AGENT_CHAT_WEB_URL}/api/queue` | 推送通知的队列端点 |
| `AGENT_CHAT_DASHBOARD_TOKEN` | 否 | 空 | 非本地 dashboard 变更所需的 bearer token |
| `AGENT_CHAT_SERVER` | 远程：是 | `local` 或主机名 | 运行报告里的 server 身份 |
| `MSG_BASE_URL` | 遗留 | 由 `AGENT_CHAT_WEB_URL` 推导 | 覆盖 Matrix `/msg` 链接基址 |

`backend-v2.js` 与 `server.js` 在缺少非空 `API_TOKEN` 时会 fail fast。

### Agent 运行时

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AGENTCHAT_HOMEDIR` | `~/.agentchat` | agent home 根目录 |
| `AGENTCHAT_AGENT_TOKEN_MODE` | `hard` | 每 agent token 的强制模式 |
| `AGENT_IDLE_THRESHOLD_MS` | `20000` | 推送投递的空闲阈值 |
| `AGENT_SCOPE_MONITOR_ENABLED` | `true` | 本地资源监控 |
| `OFFLINE_CATCHUP_LIST_LIMIT` | `50` | 离线补投消息上限 |
| `REMINDER_MERGE_PREVIEW_LIMIT` | `20` | 提醒合并预览上限 |

编码 agent 的权限策略由**启动器强制**，不由 agent 自选：Claude 跑 `auto-mode`，
Codex 跑 Level 2（`workspace-write` + `on-request`）。会改变策略的 `extraArgs`
会被拒绝。

### Push relay

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PUSH_RELAY_MODE` | `local` | 本地或远程 relay 档位 |
| `PUSH_RELAY_SCAN_INTERVAL_MS` | `30000` | 运行时扫描间隔 |
| `PUSH_RELAY_RECONNECT_MS` | `5000` | SSE 重连间隔 |
| `PUSH_RELAY_HEARTBEAT_INTERVAL_MS` | `15000` | 心跳间隔 |

### Matrix 桥

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | `https://matrix.example.com` | homeserver 地址 |
| `MATRIX_SERVER_NAME` | homeserver 主机名 | Matrix server name |
| `MATRIX_BOT_USERNAME` | `agent-bridge` | 桥机器人用户名 |
| `MATRIX_BOT_PASSWORD` | 空 | 桥机器人密码 —— **无法自动生成** |
| `MATRIX_BRIDGE_SECRET` | 空 | 后端与桥之间的共享密钥；安装器会生成 |
| `MATRIX_REG_TOKEN` | 空 | 注册 token |
| `MATRIX_AGENT_PREFIX` | `ac_` | 派生 agent Matrix 账号的前缀 |
| `MATRIX_AGENT_PASSWORD_SECRET` | 空 | 派生 agent 密码用的密钥 |
| `MATRIX_DEFAULT_WAKE` | `off` | 仅 @ 寻址。未指名的群消息不唤醒任何人 |
| `MATRIX_TRUST_MODE` | `enforce` | `enforce`、`audit` 或 `off`。公开 homeserver 上用 `enforce` |
| `MATRIX_TRUSTED_INVITER_MXIDS` | 空 | 其邀请可自动加入的用户 |
| `MATRIX_OPERATOR_MXIDS` | 空 | 允许执行特权命令的用户 |
| `MATRIX_GREETING_MXIDS` | 空 | 目录里查不到时主动 DM 的用户 |
| `MATRIX_IGNORED_SENDER_MXIDS` | 空 | 完全忽略的发送者 |
| `MATRIX_INVITE_POLL_MS` | `60000` | 邀请轮询间隔，下限 5000。公开 homeserver 限流很严 |

### Supervisor

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `SUPERVISOR_ENABLED` | `false` | 启用 supervisor 循环 |
| `SUPERVISOR_LLM_PROVIDER` | `deepseek` | 模型提供方 |
| `SUPERVISOR_LLM_MODEL` | `deepseek-chat` | 模型 |
| `SUPERVISOR_LLM_KEY` | 占位 | 提供方 API key |
| `SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS` | `60000` | 生命周期巡检间隔 |

### 部署与发布门禁

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AGENTCHAT_DEPLOY_BRANCH` | `stable` | 部署监视器 watch 的分支 |
| `AGENTCHAT_RELEASE_GATE` | `worktree` | 候选门禁。`none` 关闭它 —— 必须是显式选择 |
| `AGENTCHAT_DEPLOY_SERVICES` | 按脚本而定 | 部署时重启的服务 |
| `AGENTCHAT_ALERT_URL` | 空 | 部署失败告警的可选端点 |
| `AGENTCHAT_ALERT_TOKEN` | 空 | 上者的 bearer token |
| `AGENTCHAT_VERIFY_REMOTE_BIN` | `bin/verify-remote` | 远程验证助手 |

## 安全立场

HAFleet **强制**的：

- **agent 不能给自己扩权。** 启动策略由启动器施加，改策略的参数会被拒绝。
- **agent 不能编排别的 agent。** 没有 MCP 工具能创建任务图，那需要运维 token。
- **审批走归属人**，不走房间。
- **服务带沙箱。** 每个单元都有 `NoNewPrivileges`、`ProtectSystem=full`、
  能力与系统调用限制，以及资源限制。
- **后端在构造上只绑 loopback** —— 在 Linux/systemd 路径上，这是一个没有环境变量
  可覆盖的函数默认值。

它**假设**的，你应当知道：

- **loopback 信任是机器级的，不是用户级的。** 本机任何进程都被当作 local。共享
  主机上，真正的控制手段是 per-agent token（`AGENTCHAT_AGENT_TOKEN_MODE=hard`）。
- **非 loopback 绑定是给容器用的。** `AGENT_CHAT_*_HOST` 的存在是为了让容器能
  通过发布端口被访问。每次启动都会大声记录；值写错时会退回 loopback 而不是放宽。
- **任务图的完成是自报的。** 节点由被指派者宣布关闭，没有任何东西校验这个声明。
- **已存在的 tmux session 会被收编。** HAFleet 会注册它找到的东西。
- **存在已知的依赖债** —— 53 条传递性告警，已做成棘轮，新的进不来。见
  [docs/SECURITY-DEBT.md](docs/SECURITY-DEBT.md)。

面向公网部署时，把 dashboard 放到 HTTPS 反向代理后面，并让 `AGENT_CHAT_API`
只监听 loopback。

## 开发

```bash
npm install

# 直接跑服务
API_TOKEN=dev-token node backend-v2.js
API_TOKEN=dev-token node server.js
API_TOKEN=dev-token node push-relay.js

# 或者跑在 supervisor 下
set -a; . ./.env; set +a
AGENT_CHAT_RUNTIME_DIR="$PWD" node services/agentchat-services.mjs start
```

测试与门禁：

```bash
npm test                              # 全量
npm run test:kernel
npm run check:syntax
npm run check:cli-contract
npm run check:architecture-boundaries # import 与路由归属规则
npm run audit:baseline                # 告警棘轮
AGENT_NAME=agentchat-develop npm run verify:ci
```

远程包与发布产物：

```bash
npm run build:remote:check
npm run check:remote-sync
./scripts/build-release-package.sh --out-dir dist
```

运行数据、日志、`.env`、生成的 `remote-dist/` 与 `dist/` 都被忽略，不是事实来源。

## 命名

项目名是 **HAFleet**。内部标识符仍沿用上游的 `agent-chat` / `agentchat` /
`AGENT_CHAT_` / `AGENTCHAT_` 命名，这是刻意的：systemd 单元名、CLI 命令名、`.env`
变量名、MCP server 名以及 `~/.agentchat` 数据目录，都在
[docs/RELEASING.md](docs/RELEASING.md) 的兼容性契约覆盖范围内。重命名它们属于
一次带迁移的大版本，而不是一次文档改动。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 五条安装路径、平台矩阵、加固 |
| [docs/RELEASING.md](docs/RELEASING.md) | 版本策略、SemVer 覆盖面、发版流程 |
| [docs/ROLLBACK.md](docs/ROLLBACK.md) | 自动部署与手工回滚、状态文件 |
| [docs/SECURITY-DEBT.md](docs/SECURITY-DEBT.md) | 依赖告警与棘轮 |
| [docs/LICENSING.md](docs/LICENSING.md) | fork 溯源与 Apache 2.0 的署名义务 |
| [OPERATIONS.md](OPERATIONS.md) | 运维手册：健康、部署、事故 |
| [CHANGELOG.md](CHANGELOG.md) | 发布历史 |
| [remote/README.md](remote/README.md) | 远程 relay 包 |
| [services/README.md](services/README.md) | 受管服务与两个 doctor |

以下已归档，仅作历史参考，请以上面的运维手册为准：
`ROADMAP-remote.md` —— 已被取代的远程规划归档。

## 许可

**Apache License 2.0** —— 见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。

HAFleet fork 自 [agent-chat](https://github.com/shisuiki/agent-chat)，后者已于
2026-07-29 采用 Apache 2.0，两者现在同许可。本树中**有 717 个 commit 继承自上游**，
因此 `NOTICE` 里署名了上游作者 —— 再分发时请保留它与 `LICENSE`，并标注你改过的
文件。见 [docs/LICENSING.md](docs/LICENSING.md)。
