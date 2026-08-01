# hafleet 当前问题修复文档

Date: 2026-07-09  
Branch context: `feat/matrix-agent-capabilities`  
Status: analysis + repair plan (no code changes in this doc)  
Scope: **仅 hafleet 自身**（启动、registry、调度、Matrix bridge、可观测性）

---

## 1. 目的

把当前线上/联调里反复出现的 hafleet 故障，收敛成一份可执行的修复清单：

- 问题是什么
- 代码/架构上为什么会发生
- 建议怎么修
- 优先级与验收标准
- 建议落地顺序

本文不讨论外部系统（如 OpenFab / agentd）应如何演进；只回答：**hafleet 现在哪里坏了、怎么修。**

---

## 2. 现状摘要

hafleet 已具备完整本地多 agent 控制面：

| 组件 | 职责 |
| --- | --- |
| `backend-v2.js` | registry / messages / tasks / pool / dispatch / SSE |
| `server.js` | dashboard + 本地 queue 面 |
| `push-relay.js` | SSE → tmux 注入 |
| `bridge-matrix.js` | Matrix ↔ hafleet |
| `bin/hafleet-up*` / `hafleet-down` / `hafleet-ls` | 启动与运维 CLI |
| `lib/matrix-agent.js` | role × capability 纯调度决策 |
| `lib/agent-state.js` | agent 生命周期状态机 |

当前主分支已落地 capability 调度的**决策层**：

- `GET /api/pool`
- `POST /api/dispatch`
- `POST /api/dispatch/release`
- Dashboard `/pool`

但生产稳定性仍被下面 12 类问题拖累。它们的共同根因是：

> **多处“运行时信号”被当成事实源；关键状态缺少持久化、租约与幂等。**

---

## 3. 问题清单（按现象）

### P-01 tmux 手工启动、duplicate session

**现象**
- agent 依赖手工 / CLI 启 tmux session
- 同名 session 重复启动、半启动、残留 session 常见
- “CLI 以为起来了 / backend 不认”或反过来

**涉及**
- `bin/hafleet-up`, `bin/hafleet-up-v1`
- `lib/agent-state.js`（`offline/starting/online/degraded/manual_down`）
- backend agent registry（`tmux` / `online` / heartbeat）

**根因**
1. worker 身份过度绑定 **tmux session name**
2. 启动路径是“脚本副作用”，不是“控制面 desired state 收敛”
3. 重复启动缺少严格的 **single-live-instance** 协议（谁拥有、谁接管、谁拒绝）

**修复方向**
1. 启动前做原子占用：`identity → launch lease`（文件锁或 backend 锁）
2. 若 session 已存在：
   - 健康 → 复用并 reconcile registry
   - 不健康 → 明确 `replace` / `refuse`，禁止静默双开
3. registry 写回必须在“session 确认 + 注册成功”后才标 online
4. CLI 输出结构化结果：`created | reused | refused | degraded` + reason

**验收**
- 连续两次 `up-v1` 同名 agent：第二次不得产生第二个 live worker
- session 残留但进程已死：可自动回收或明确要求 `--replace`
- registry 中的 `tmux` / lifecycle state 与真实 session 一致

---

### P-02 dashboard agent 列表不准

**现象**
- 列表显示 online/idle/busy 与真实不符
- 已挂 agent 仍显示可用；刚启动 agent 长时间 unknown/offline
- busy 状态刷新不稳定

**涉及**
- `backend-v2.js` agent serialize / liveness refresh
- `lib/agent-state.js`
- dashboard monitor/detail pages
- **内存** `dispatchBusy`（不在 agent 持久字段中）

**根因**
列表混合了多个不完全同步的来源：

1. 持久 registry（`data/agents.json`）
2. 内存 lifecycle state machine
3. heartbeat / server liveness
4. 内存 `dispatchBusy`
5. dashboard 本地推断 / 过滤

任一源滞后，UI 就会“看起来像错的”。

**修复方向**
1. 定义单一投影模型 `AgentView`：
   - `lifecycle`（offline/starting/online/degraded/manual_down）
   - `health`（healthy/degraded/unknown）
   - `busy`（lease 占用）
   - `lastSeen`, `lastError`, `server`
2. 所有 UI / CLI 只读该投影，禁止各自推断
3. `busy` 进入可查询的调度状态（至少随 `/api/agents` 与 `/api/pool` 一致暴露）
4. stale 规则显式化：heartbeat TTL、runtime TTL、lease TTL

**验收**
- 杀死 tmux 后，在 TTL 内状态收敛到 offline/degraded，不长期假 online
- dispatch 占用后，agents 列表与 pool 页 busy 一致
- 重启 backend 后，列表不出现“永久 busy”或“幽灵 online”（见 P-07）

---

### P-03 bridge bot 没进房导致命令丢失

**现象**
- Matrix 房间发命令无响应
- bot 实际未 join / 被踢后未自动回房
- 失败常需翻 bridge 日志才发现

**涉及**
- `bridge-matrix.js` invite/join、room trust、room 扫描
- `state.trustedManagedRooms` / `roomGroupMap`
- bot command 处理路径

**根因**
1. membership 是“尽量 join”，不是 desired-state reconcile
2. 命令处理默认假设 bot 已在房
3. 未进房 / join 失败缺少稳定、可查询的错误码

**修复方向**
1. 为每个托管 room 维护 desired membership：`bot required = true`
2. 周期 reconcile：缺失则 rejoin；失败写入 room health
3. 命令入口预检：
   - bot not joined → 明确错误（房间提示或 operator alert），不静默丢
4. doctor/health 暴露：`matrix.rooms[].botJoined`

**验收**
- bot 被移出托管房后，自动 rejoin 或在限时内告警
- 未进房时发命令，操作者能在房间或 dashboard 看到失败原因
- 不再依赖“翻日志才知道 bot 不在房”

---

### P-04 Matrix 历史消息重放

**现象**
- bridge 重启 / 重同步后，历史消息被再次处理
- 命令可能重复执行，或重复注入内部消息

**涉及**
- `bridge-matrix.js` sync / backfill / room event handlers
- `state.agentRoomBackfillCursors`（存在但不构成完整幂等层）
- backend message create 路径

**根因**
Matrix 是 at-least-once 投递模型，但 bridge 缺少完整的：

1. 持久 event cursor
2. processed-event 幂等表
3. 业务层 idempotency key

**修复方向**
1. 每 room 持久化 `timeline_cursor`（token / order）
2. 处理前查询 `processed_events`（key: `roomId + eventId`）
3. 业务命令生成稳定 `commandId` / `idempotencyKey`，backend 去重
4. 重启只消费 cursor 之后事件；backfill 必须走同一幂等路径

**验收**
- 同一 Matrix event 重放 N 次，内部只产生 1 次业务副作用
- bridge 崩溃恢复不重复派发已处理命令
- 有测试：duplicate event → second handle is no-op

---

### P-05 create issue / 房间命令没有稳定路由到底层 agent

**现象**
- 房间里创建 issue / 下任务后，底层 agent 收不到
- 或落到错误 agent / 无人认领

**涉及**
- Matrix command 解析（`bridge-matrix.js` / `lib/bot-commands.js`）
- backend messages / tasks
- `/api/dispatch`（能力调度）
- agent inbox / push delivery

**根因**
命令到执行之间存在多条路径，且不保证进入统一链路：

```text
room command ─┬─► 直接发消息给某 agent
              ├─► 建 task 但不 dispatch
              └─► dispatch 后 delivery 失败且无补偿
```

缺少强制的“命令 → 任务事件 → 调度 → 投递 → 回执”闭环。

**修复方向**
1. 所有“要有人干活”的房间命令，统一落 **task event**（durable）
2. task 必须带：`role/capability` 或显式 agent，以及 `room`, `requester`, `idempotencyKey`
3. 默认走 `/api/dispatch`；只有显式 `@agent` 才点名
4. 投递失败进入可重试队列 / alert，不丢单
5. 房间回执至少包含：`taskId`, `status(routed|queued|provision|failed)`, `agent?`

**验收**
- create issue 后，backend 一定有对应 task/ticket
- 有 idle agent 时必达；无 agent 时 `queued/provision`，不静默消失
- 房间可查询该命令当前状态

---

### P-06 scheduler queued/provision 后被 fallback 到默认 assignee

**现象**
- 调度返回 queued/provision 后，调用链仍把任务塞给默认 agent
- 表面“有人接了”，实际破坏了能力调度与排队语义

**涉及**
- `POST /api/dispatch`（`backend-v2.js`）
- 调用方（bridge / 外部 bridge / 脚本）
- 旧的点名 assignee 路径

**根因**
1. dispatch 与最终 delivery 分离，调用方可自行改派
2. 历史兼容路径仍允许默认 assignee
3. `queued/provision` 没有强制后续状态机（谁负责 provision、谁负责再 dispatch）

**代码事实（当前）**
- `dispatchBusy` / `dispatchQueues` / `provisionReservations` 均为进程内内存结构
- `provision` 只返回计划，不在 backend 内完成拉起
- 没有“禁止非 dispatch 路径写执行任务”的硬约束

**修复方向**
1. 明确契约：
   - `routed` → 只许投递给返回的 agent
   - `queued` → 等待 drain，禁止改派默认 agent
   - `provision` → 必须先完成 provision，再 route；失败则保持 queued/failed
2. 调用方若收到非 routed，不得 fallback 默认 assignee
3. backend 可增加保护：带 `dispatchTicket` 的执行写才被接受（逐步强制）
4. 指标/日志标记 `fallback_used`（过渡期），最终变为错误

**验收**
- 集成测试：dispatch=queued 时，任务不会出现在默认 agent inbox
- provision 失败不会“偷偷”落到无关 agent
- 文档与调用方错误处理一致

---

### P-07 reservation 泄漏

**现象**
- agent 长期 busy，无法再接到任务
- 队列不 drain
- backend 一重启，busy/queue 全丢或行为异常

**涉及**
```text
backend-v2.js
  dispatchBusy: Set            // 内存
  dispatchQueues: Map          // 内存
  provisionReservations: Map   // 内存
POST /api/dispatch
POST /api/dispatch/release
```

**根因**
当前是 **软锁**，不是 **lease**：

1. 无 TTL
2. 无 worker heartbeat 绑定
3. 无 reaper
4. caller 忘记 `/release` 即泄漏
5. 进程重启后内存态消失（另一类一致性问题）

**修复方向**
把 reservation 升级为 lease：

| 字段 | 含义 |
| --- | --- |
| `leaseId` | 租约 ID |
| `agent` | 占用的 agent |
| `taskId/ticket` | 关联任务 |
| `owner` | 调度调用方 |
| `expiresAt` | 到期时间 |
| `heartbeatAt` | 最近续租 |

配套机制：
1. 默认 TTL（如 5–15 分钟，可按任务类型配置）
2. 执行中可 heartbeat 续租
3. explicit release 正常释放
4. reaper 扫过期 lease，触发 requeue / fail
5. 中期：lease/queue 持久化，避免进程重启丢队列

**验收**
- 不调用 release 时，TTL 后 agent 自动恢复 idle
- 过期任务可被其他 idle agent 接手或标记 failed
- 重启后不会出现永久 busy（若已持久化，则按 lease 恢复；若未持久化，则安全清空并告警）

---

### P-08 trust 配置过度依赖 `.env`

**现象**
- operator / trusted inviter / trust mode 变更要改 env 并重启
- 环境间策略漂移难审计
- 空配置时行为不够直观（fail-open / fail-closed 风险）

**涉及**
- `MATRIX_TRUST_MODE`
- `MATRIX_OPERATOR_MXIDS`
- `MATRIX_TRUSTED_INVITER_MXIDS`
- `MATRIX_TRUSTED_ROOM_IDS` 等
- room trust 判定逻辑（bridge + docs/architecture/auth-trust-model.md）

**根因**
把**运行时策略数据**放在**部署配置**里，导致：

1. 变更成本高
2. 无法按 room/project 精细授权
3. 审计不足

**修复方向**
1. 短期：
   - 明确默认 fail-closed（尤其 public homeserver）
   - 空 ACL 时只允许只读/帮助命令
   - 启动时打印 trust 生效摘要
2. 中期：
   - policy store（JSON 即可起步）：operators、inviters、room allowlist、command ACL
   - `.env` 只保留 bootstrap（homeserver、bot 凭证、bootstrap admin）
3. 策略变更写 audit log

**验收**
- 未授权用户无法执行变更类命令
- 策略文件变更可在不改代码的情况下生效（热加载或安全重启）
- `/health` 或 doctor 可看到当前 trust mode 与关键 ACL 是否配置齐全

---

### P-09 OpenFab signoff 语义被误用为强制门禁（hafleet 侧）

**现象**
- 执行完成后，系统/调用方把“未 signoff”当成“未交付”
- hafleet 路径混入认证语义，排障困难

**涉及**
- task 完成状态
- bridge/API 回执文案与状态字段
- 与外部认证系统的边界说明

**根因**
hafleet 作为执行层，没有把状态拆清：

- `delivered/executed`（执行完成）
- `certified/signed`（外部认证，可选）

**修复方向**
1. hafleet 任务状态只保证执行域：
   - `accepted → running → succeeded/failed`
2. 认证结果如需记录，使用独立字段：`certification: { status: optional|pending|signed|rejected }`
3. API/房间回执避免把 signed 当作成功前提
4. README/OPERATIONS 明确：执行成功 ≠ 认证通过

**验收**
- 无认证系统时，任务仍可正常闭环为 succeeded
- 回执中执行状态与认证状态可区分

---

### P-10 room/project mapping 重启后“丢失”或不一致

**现象**
- 重启后房间与 group/project 对应关系异常
- 映射存在于 bridge 本地，控制面不知道
- 部分路径看起来像丢 mapping

**涉及**
- `data/bridge-state.json`：`roomGroupMap` / `groupRoomMap` / DM maps
- backend groups
- project 管理（`hafleet-project` / agent home projects）

**根因**
1. 权威映射落在 bridge 本地状态，而不是 backend 控制面
2. room ↔ group ↔ project ↔ repo 没有统一注册表
3. 重启后 reconcile 不完整，导致“半恢复”

**修复方向**
1. 提升 durable registry（backend）：
   - `room_id → group/project`
   - `project → repo/path/default role routing`
2. bridge 仅缓存并 reconcile，不独享真相
3. 写路径：先写 registry，再同步 Matrix/bridge 缓存
4. 启动时做 mapping doctor：dangling room、missing group、冲突 map

**验收**
- 杀桥再启，room/group 映射恢复且一致
- backend 可直接查询 room/project 绑定
- 不再出现“bridge 知道、dashboard 不知道”

---

### P-11 Matrix 房间被当成 transcript 主存储

**现象**
- 房间塞满长对话与中间产物
- 难检索、难权限控制、难清理
- bridge 双向镜像放大噪声

**涉及**
- bridge 消息镜像
- agent 回复回灌 Matrix
- 附件/长日志发送路径

**根因**
协作信道（Matrix）承担了系统 of record 职责。

**修复方向**
1. Matrix 只发：
   - 命令
   - 状态摘要
   - 结果链接 / task id
2. 完整 transcript、diff、日志、产物进 hafleet storage（消息库/对象存储/agent outputs）
3. 长内容默认转存储 + 摘要回房
4. 可配置 `MATRIX_MIRROR_MODE=summary|full`（默认 summary）

**验收**
- 正常任务不在房间刷长日志
- 房间消息可跳转到完整结果
- 存储侧可按 task/agent 检索全文

---

### P-12 问题诊断过度依赖翻日志

**现象**
- 故障定位要跨 backend / bridge / relay / tmux 日志人工拼接
- 用户可见失败缺少稳定错误码
- dashboard 不能直接回答“为什么没跑”

**涉及**
- `/api/health`（已有基础，但不足以覆盖调度/桥接闭环）
- alert store
- 各组件 console 日志

**根因**
缺少面向操作者的 **结构化诊断模型**。

**修复方向**
增加 `doctor`（可先挂在 backend）：

```text
GET /api/doctor
GET /api/doctor/matrix
GET /api/doctor/dispatch
GET /api/doctor/agents/:name
```

最小字段：
- agents: desired/actual/lifecycle/lastError
- dispatch: queueDepth by cell, leases, expired count
- matrix: bot online, room membership gaps, cursor lag, last event error
- delivery: pending/failed notifications
- config: trust mode readiness、关键 env 缺失

每个失败给：
- `code`（稳定）
- `message`（短）
- `since`
- `remediation`（下一步）

**验收**
- 常见故障（bot 不在房、lease 泄漏、agent offline、dispatch queued）无需翻日志即可定位
- CLI：`hafleet doctor` 输出同样信息
- 关键测试覆盖至少 5 个故障码

---

## 4. 根因归并（方便排期）

| 根因簇 | 覆盖问题 | 一句话 |
| --- | --- | --- |
| G1 身份与生命周期不收敛 | P-01, P-02 | session/registry/lifecycle 多源 |
| G2 调度态不是租约 | P-06, P-07 | busy/queue 内存软锁 |
| G3 命令链路不闭环 | P-05, P-06 | 命令可绕过 task/dispatch |
| G4 网关缺少幂等与 desired-state | P-03, P-04, P-10, P-11 | bridge 既不幂等也不权威 |
| G5 策略与可观测性不足 | P-08, P-09, P-12 | env 策略 + 日志排障 |

---

## 5. 建议修复批次

### Batch A — 调度可靠性（优先，收益最大）

目标：先让“选人/排队/释放”可信。

1. **P-07** lease TTL + release + reaper  
2. **P-06** 禁止 queued/provision 后 fallback 默认 assignee  
3. **P-02（busy 部分）** busy/lease 对 agents/pool/UI 一致暴露  
4. 基础 **P-12**：`/api/doctor/dispatch`

**出口标准**
- 无永久 busy
- queued 语义不被破坏
- 调度故障可在 API 直接看到

### Batch B — 命令闭环

1. **P-05** room command → durable task → dispatch → ack  
2. 房间回执标准化（taskId/status/agent/error）  
3. 投递失败重试与告警

**出口标准**
- create issue/命令不再“失踪”
- 每条命令可查询状态

### Batch C — Matrix 网关硬化

1. **P-04** event cursor + processed store  
2. **P-03** bot membership reconcile + 可见失败  
3. **P-10** room/group/project registry 上收  
4. **P-11** summary mirror 默认

**出口标准**
- 重启不重放业务副作用
- bot 掉房自愈或可诊断
- mapping 重启不丢

### Batch D — 启动与列表真实性

1. **P-01** single-live-instance 启动协议  
2. **P-02** 统一 AgentView 投影  
3. lifecycle/health TTL 规则统一

**出口标准**
- 无 duplicate live session
- dashboard/CLI/backend 三者状态一致

### Batch E — 策略与语义清理

1. **P-08** trust 默认 fail-closed + policy store 起步  
2. **P-09** executed 与 certified 状态分离  
3. doctor 全量与 runbook 链接

---

## 6. 每项修复的通用工程要求

1. **先加测试再改行为**  
   - 单元：纯决策（lease/select/idempotency）  
   - API：dispatch/release/doctor  
   - bridge：duplicate event、not-joined command
2. **优先持久化“会丢就出事”的状态**  
   - lease/queue/cursor/processed/mapping
3. **失败要有稳定 code**  
   - 例如：`dispatch.lease_expired`, `matrix.bot_not_joined`, `agent.duplicate_session`
4. **兼容迁移**  
   - 旧 agent 无 capability/role 仍可推断  
   - 旧命令路径可先 warn，再硬失败
5. **不把 dashboard 当真相源**  
   - 继续坚持 backend 控制面写路径

---

## 7. 建议新增/调整的观测面

| 接口/命令 | 作用 |
| --- | --- |
| `GET /api/doctor` | 总诊断 |
| `GET /api/pool` | 已有；补充 lease/queue 细节 |
| `GET /api/dispatch/leases` | 当前占用与到期时间 |
| `GET /api/dispatch/queues` | 各 cell 队列 |
| `hafleet doctor` | CLI 同款 |
| alert types | `dispatch_lease_expired`, `matrix_bot_not_joined`, `mapping_drift`, `duplicate_session_refused` |

---

## 8. 明确不在本文范围

- 外部 agentd 控制面重写方案
- OpenFab 侧认证/签名实现
- 大规模存储引擎替换（可先 JSON/JSONL）
- 远端 CD/remote package 既有 repair-table 条目（见 `docs/salt/repair-table.md`）

若与 `docs/salt/repair-table.md` 重叠，以“能否直接消除本文 P-xx 现象”为准做映射，不重复开无关工单。

---

## 9. 建议的第一周执行顺序（仅计划）

Day 1–2  
- 写清 dispatch lease 数据模型与 reaper 行为  
- 补 P-07/P-06 测试夹具

Day 3–4  
- 落地 lease TTL + release 契约  
- doctor/dispatch 最小实现

Day 5  
- 封住 fallback 默认 assignee（先 log+metric，再 fail）  
- 跑 `npm test` / 相关 API 测试

并行文档  
- OPERATIONS 增加：busy 泄漏、bot 不在房、命令无路由 的排查步骤（改为先看 doctor）

---

## 10. 结论

hafleet 当前不是“缺功能”，而是 **关键状态机没闭环**：

1. 启动身份不收敛  
2. 调度锁不可靠  
3. 命令链路可绕过  
4. Matrix 网关缺幂等与自愈  
5. 故障不可自解释

按 Batch A → B → C → D → E 推进，可以在不推翻现有架构的前提下，把现有问题修到可运营。

---

## 附录 A — 与代码锚点对照

| 问题 | 主要锚点 |
| --- | --- |
| 调度决策 | `lib/matrix-agent.js` |
| 调度占用/队列 | `backend-v2.js`（`dispatchBusy` / `dispatchQueues` / `provisionReservations`，`/api/dispatch*`） |
| agent 生命周期 | `lib/agent-state.js`, `bin/hafleet-up`, `backend-v2.js` registry |
| Matrix 状态 | `bridge-matrix.js`, `data/bridge-state.json` |
| 信任模型 | `.env` Matrix trust 变量, `docs/architecture/auth-trust-model.md` |
| 列表展示 | dashboard monitor/pool pages + `/api/agents` + `/api/pool` |

## 附录 B — 优先级总表

| ID | 问题 | 优先级 | 批次 |
| --- | --- | --- | --- |
| P-07 | reservation 泄漏 | P0 | A |
| P-06 | queued/provision 后 fallback | P0 | A |
| P-05 | 命令未路由到 agent | P0 | B |
| P-04 | Matrix 历史重放 | P0 | C |
| P-03 | bot 未进房丢命令 | P0 | C |
| P-01 | duplicate session | P1 | D |
| P-02 | dashboard 列表不准 | P1 | A/D |
| P-10 | room/project mapping 漂移 | P1 | C |
| P-12 | 只能翻日志排障 | P1 | A 起，贯穿 |
| P-08 | trust 靠 .env | P2 | E |
| P-11 | 房间当 transcript 库 | P2 | C |
| P-09 | signoff 语义污染执行态 | P2 | E |
