# Remote Server Support — Roadmap

## Architecture

```
Server A (Central / 本机):
  ├── backend-v2.js  (:8090, HTTPS exposed)  ← 唯一数据源
  ├── bridge-matrix.js                        ← 唯一 Matrix bridge
  ├── server.js      (:8084)                  ← Dashboard + push (本地)
  ├── push-relay (内置于 backend)              ← 本地 agent tmux 注入
  └── local agents   (tmux + MCP)

Server B (Remote):
  ├── push-relay.js   ← 轻量级 SSE consumer + 本地 tmux 注入
  ├── mcp-server.js   ← 每个 agent 一份，指向中央 backend
  └── remote agents   (tmux + MCP)
```

### 核心原则

- **Backend 唯一**：所有 agent/group/message 数据存中央，不做多副本
- **Bridge 唯一**：Matrix 里只有一个 bot，不会出现多个 bridge
- **Push 本地化**：每台机器一个 push-relay，监听中央 SSE，本地 tmux 注入
- **MCP 直连**：远端 MCP 通过 HTTPS 直连中央 backend API

## Phase 1: API 安全

### 1.1 Token 认证
- backend-v2.js 增加 `API_TOKEN` 环境变量
- 请求头 `Authorization: Bearer <token>` 校验
- localhost 请求免认证（向后兼容）
- `.env` 文件存 token，`.gitignore` 排除

### 1.2 敏感数据分离
- 确认 `data/` 目录在 `.gitignore`
- 代码中无硬编码 token（已满足）
- homeserver URL 等走环境变量

## Phase 2: Backend HTTPS 暴露

### 2.1 暴露方式（选一）
- **frp**：已有 frp agent（看到有 frp 注册），可以直接加一个 tunnel
- **Reverse proxy**：nginx/caddy + Let's Encrypt
- 目标：`https://<domain>/agent-chat/api/...`

### 2.2 CORS / 安全
- 只允许 API 路径，不暴露 dashboard
- Rate limiting（可选）

## Phase 3: Push Relay

### 3.1 push-relay.js（新文件，~80 行）
```
职责：
1. 连接中央 backend SSE (/api/stream)
2. 过滤出本服务器 agent 的事件
3. 本地 tmux send-keys 注入通知
4. 定期刷新本地 agent 列表（扫描 tmux sessions）
```

### 3.2 需要改动的地方
- backend-v2.js 的 `pushNotify()` 目前直接 tmux send-keys
- 改为：本地 agent → 本地 push；远程 agent → 不推（由远端 relay 负责）
- agent 注册增加 `server` 字段区分来源
- SSE stream 需要包含足够信息让 relay 构造通知

## Phase 4: 远端部署包

### 4.1 远端需要的文件
```
agent-chat-remote/
  ├── push-relay.js
  ├── mcp-server.js
  ├── bin/agent-up       ← 快速起 agent 脚本
  ├── .env.example       ← AGENT_CHAT_API, API_TOKEN
  └── install-remote.sh  ← 安装脚本
```

### 4.2 安装流程
1. clone repo / 下载部署包
2. 复制 .env.example → .env，填写中央 API URL 和 token
3. 运行 install-remote.sh（装 systemd service for push-relay）
4. `agent-up <name> <path>` 起 agent

## Phase 5: Agent 注册增强

- agent 注册支持 `server` 字段（hostname 或标识）
- `!agents` 命令显示 agent 所在服务器
- `!autoregister` 已移除（agent presence 由 heartbeat 自动发现）
- 远端 push-relay 启动时自动注册本机 agent

## 依赖关系

```
Phase 1 (API安全) → Phase 2 (HTTPS暴露) → Phase 3 (Push Relay) → Phase 4 (部署包)
                                                                  ↗
Phase 5 (注册增强) ─────────────────────────────────────────────
```

Phase 1 和 Phase 5 可以并行。agent-up 脚本不依赖远端支持，可以先做。
