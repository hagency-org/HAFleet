# 协作栈路线图:AgentTeams 借鉴、执行后端集成与 S3 规划

- 版本:v2(2026-07-20;v1 为 2026-07-19 的借鉴分析,本版并入项目定位、
  ARC serve mode 实况、无上限规模修正与已交付项状态)
- 范围:**robrix2 + agent-chat + agent-spec(核心)/ ARC(合作)**;
  OpenFab 暂缓,不在本路线图的启动链与验收依赖中
- 决策存档:mempal `drawer_openfab_review_ccf10f7be401`(AgentTeams 对照)、
  `drawer_robrix2_default_2b59c0798987`(standalone 实现里程碑)

## 0. 三句话总纲

1. **核心项目定标准,合作项目接标准**:agentd/agent-chat 与 agent-spec 是
   重心资产,负责协议、合约与验收把门;ARC 是合作项目,经由稳定协议面接入
   (serve mode 已证明依赖方向正确:是 ARC 适配了 agent-chat 的方言)。
2. **抄 AgentTeams 的运维壳,守自己的信任核**:编排/部署/凭证隔离向它学;
   合约(agent-spec)、对抗评审(异构 Codex 终审)、证据链是它没有而我们
   不得放弃的。
3. **规模目标是无上限**:成员数与单房间 agent 数都不设上限("4 人"只是
   首跑试点规模)。所有 O(N) 配置都要么反转成 O(1) 语义,要么收敛到
   成员权威(花名册 → 未来 Specify/Human 权威)。

## 1. 项目定位与依赖方向

| 项目 | 定位 | 投资姿势 |
|---|---|---|
| agent-chat / agentd | 核心:运行时与执行面 | 深耕(下表批次) |
| agent-spec | 核心:需求中枢 + 质量契约(KLL/gate/export±provenance/verify) | 深耕;`arc-native` dialect 是中枢地位的证明 |
| robrix2 | 核心:人机界面 | 深耕(cockpit 下期) |
| ARC | 合作:可派发执行后端 | **接口化**:不 import 其内部、不为其特化核心;需求走 feature request |
| OpenFab | 暂缓 | 文档/合约保留,运行时不接入;重接入按其路线图 §8 另行设计 |

**铁律**:任何第三方执行后端(含 ARC)只经 `task_request/task_result`
协议门接入;该协议面应从"事实标准"升格为成文的
**《执行后端接入规范》**(见 §4 文档投资 C2)。

## 2. 执行后端集成现状(ARC serve mode,2026-07-20 实况)

ARC `ec49ce6` 落地 serve mode:以 `arc-compiler` 身份 heartbeat 自动注册、
轮询 `GET /api/inbox/<name>`、执行 `schema:{kind:"task_request"}` 的 DM、
以 `task_result` 结构化回报;Bearer + `X-Agent-Token` 双头(hard 模式兼容);
网络失败只延迟不崩溃;`requirement_dir` 在 per-task payload(一实例多项目)。

**含义**:`/go NNN --via arc` 的派发面已存在;两端就绪
(agent-spec 1.1.0 `requirements export --dialect arc-native` → ARC serve),
只差 issue-workflow 一节约定。

四个缺口的归属:

| 缺口 | 归属 | 动作 |
|---|---|---|
| task_request 幂等(稳定 task id) | **我们(协议方)** | 约定写进 issue-workflow / 接入规范;schema 已有 version 字段,加 `task_id` |
| agent-spec verify 只会 cargo test | **我们(核心投资 #1)** | runner 分发(`Runner: cargo\|vitest\|pytest\|node` 或按 Package 推断)——受益方是全栈机械验收,不只为 ARC |
| 跨机产物通道 | **我们(基础设施)** | 即 §5 S3 计划的 S1 触发场景之一 |
| ARC 管线阶段开关(`--stop-after tests`,前段复用) | **合作方** | 提 feature request,不自行改其管线;等不及则先用"整锅承包"模式(已就绪) |

试点计划:验收完成后,小 demo 项目跑一单
房间对话 → agent-spec 编需求树 → DM arc-compiler → task_result → Codex 终审。

## 3. 无上限规模修正(2026-07-20)

一个项目房间 = 不限成员数、不限 agent 数;4 角色团队是**工作流模式**而非
拓扑上限(服务型 agent 如 arc-compiler 与多团队可同房共存)。规模审计:

**天然 N 无关(不改)**:每实例本地 `roomGroupMap` / `!bindroom`;
`MATRIX_DEFAULT_WAKE=off` + @ 寻址;按名派生伴生 bot;`[TEAM-NNN]` GH
命名空间;opener 门控;TEAM 前缀隔离;`task_request` 协议;provision-team。

**有小规模假设(要改)**:

| # | 病灶 | 修法 |
|---|---|---|
| N1 | `MATRIX_IGNORED_SENDER_MXIDS` 精确黑名单 = O(N²) 维护 | **反转为 O(1) 白名单**:bridge 默认只路由"人类 + 本团队 agents",其余忽略——代码缺口,agent-chat 小 PR(接替原 F1 的黑名单生成思路) |
| N2 | 花名册角色 | 从"生成黑名单"改为**成员权威**(人类名单/团队归属/trusted inviters 来源);终局即 Specify Human/RBAC(参考 AgentTeams Human CRD) |
| N3 | 云端 Palpo 限流 | team profile 的 rc 按"bridge 数可增长"设 |
| N4 | token 铸造/注册 × N 手工步骤 | member-up 自动化从体验项升为规模前提 |
| N5 | 高 agent 密度房间的 UX(@ 补全、播报噪音) | robrix2 cockpit 下期 |

## 4. AgentTeams 借鉴清单(附状态)

### 已交付 ✅(2026-07-16~20)

- provision-team 成员开通脚本(agent-chat master)
- 三节工作流约定:gh 集成 / 多人协作 / shared-room(robrix2 #259)
- 共享房三件套:`MATRIX_DEFAULT_WAKE=off`、`!bindroom`(agent-chat master)、
  按团队派生伴生 bot(robrix2 #258)
- 本文档 v1

### 批次一(验收后,小活)

| 项 | 内容 |
|---|---|
| F1′ 白名单反转 | 即 §3 N1(原 F1 黑名单生成器思路作废,花名册转 N2 角色) |
| F2 验收脚本化 | 手工验收单 C1-C8 → `tests/e2e/test-NN.sh`(仿其 26 场景) |
| F3 CLI-only 纪律 | issue-workflow 加一句"agent 只经 MCP 工具与 gh/agent-spec CLI,禁止直连 backend HTTP" |
| F4 member-up.sh | 基础设施连接 + provision-team 一条命令(§3 N4) |
| F9 task_id 幂等约定 | §2 缺口表第一行 |

### 批次二(运维成熟度)

| 项 | 内容 |
|---|---|
| F5 preflight | `standalone-doctor --preflight`(可提前到验收前) |
| F6 agentchat-embedded 镜像 | Palpo + 四件套单镜像 supervisord,成员开通 = docker run |
| F7 upgrade.sh | 版本化 + 协调快照 → 换版 → 失败回滚 |
| F8 rotate | configure-standalone-env `--rotate` |

### 核心投资(agent-spec)

| 项 | 内容 |
|---|---|
| C1 runner 分发 | §2 缺口表第二行——**验收后的第一个代码投资** |
| C2 执行后端接入规范 | 把 `task_request/task_result`(kind/version/task_id/payload、错误形状、幂等、验收挂钩)写成正式文档,面向所有第三方后端 |

### 路线图对应项(拿 AgentTeams 当参考实现,不提前)

| 项 | 参考物 | 位置 |
|---|---|---|
| R1 凭证隔离网关 | Higress:真钥匙只在网关,agent 拿限权 token(现状 /start 直注真 key) | agentd AD-E1 / secret broker |
| R2 desired-state 热更新 | QwenPaw 5s 轮询存储配置热切 | agentd 快照刷新 |
| R3 worker 三级进化 | 进程 → 本机容器(Docker socket)→ K8s;一 worker 一 Pod(身份非副本) | agentd AD-E5 / 规模阶段 |
| R4 Human 一等资源 | Human CRD(permissionLevel/accessibleTeams) | §3 N2 花名册 → Specify |
| R5 技能市场 | Nacos registry + STS scope | 技能分发(近期走 git) |
| R6 auto-sleep | 空闲 worker 休眠 | agentd 生命周期经济学 |
| R7 镜像瘦身纪律 | 基础设施不进 agent 镜像(1.79GB→100MB) | worker 容器化时 |
| R8 provider 可插拔 | matrix/storage/gateway.provider 一行切换 | 部署 profile 语法(§5 契约) |

## 5. S3 对象存储规划(含 RustFS)

### 契约先行

```yaml
storage:
  provider: s3-compatible   # rustfs | minio | garage | oss/s3
```

选型是装机时决定。范式收益(对多机多 agent):传引用不传内容(省 token)、
worker 无状态可弃、限权临时钥匙 + 预签名 URL、WORM+版本化(证据不可篡改)。

### RustFS 快照(2026-07)

Apache 2.0;全 S3 兼容(号称 MinIO 二进制级 drop-in);WORM/版本化/SSE;
**Alpha,官方不建议生产**。首选候选,GA 前生产数据用 MinIO/Garage 顶班。

### 分阶段

| 阶段 | 触发 | 内容 |
|---|---|---|
| S0 现在 | — | 不装 |
| S1 工件通道 | 首次跨机递交非代码工件(评审包/证据/截图;**ARC serve 产物跨机取货是已知首个场景**) | 云端 Palpo 旁一节点;限权前缀钥匙 `agents/<team>/*`;issue-workflow 补"大工件传 key 不贴正文";预签名 URL 供人下载 |
| S2 工件库 | agentd FSF-2/3 | content-addressed + object-store refs;验收记录进 WORM 桶;接 R1 钥匙体系 |
| S3 技能分发 | Skill Hub 阶段 | 技能包入桶,参考 Nacos+STS;近期仍走 git |

转正冒烟(1h):限权钥匙互斥/过期、预签名三态、版本化+WORM 拒改、
资源基线、备份恢复、(RustFS)与 MinIO 互切数据完好。

## 6. 执行顺序(2026-07-20 版)

1. **手工验收**(A0 起步)——一切的地基,不受本文档任何项影响;
2. F5 preflight(对验收本身有用,可穿插);
3. **C1 agent-spec runner 分发**(核心投资 #1);
4. 批次一:F1′ 白名单反转 → F9 幂等约定 → F3 纪律 → F2 脚本化 → F4 member-up;
5. C2 执行后端接入规范 + `--via arc` 约定 → ARC 试点一单;
6. 批次二(F6-F8)→ 触发式 S1 → 路线图节奏的 R1-R8 / S2-S3。

robrix2 侧并行:#258/#259 合并;cockpit 手测后第三个 PR(N5 一并考虑)。
