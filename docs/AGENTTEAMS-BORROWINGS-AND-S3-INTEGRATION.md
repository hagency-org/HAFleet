# AgentTeams 借鉴清单与 S3 对象存储(RustFS)集成规划

- 状态:参考文档(reference),已采纳为路线图输入;不改变任何现行阶段门禁
- 日期:2026-07-19
- 来源:AgentTeams(原 HiClaw,Higress/agentscope 系)架构探查 + 对照分析
- 决策存档:mempal `drawer_openfab_review_ccf10f7be401`(对照分析)
- 适用范围:robrix2 + agent-chat 独立栈(当前)、企业工厂路线图 FSF-2/3/5/7(远期)

## 0. 一句话结论

AgentTeams 与我们独立收敛到同一批架构赌注(Matrix 总线、无状态 worker、
单机=集群同一模型、技能市场),验证了方向;它的强项是**运维壳**
(编排/部署/凭证隔离),弱项是我们的强项——**信任核**(合约、对抗评审、
证据链)。策略:抄运维壳,守信任核。

## 1. AgentTeams 是什么(30 秒)

K8s-native 的 Manager-Workers 多智能体平台:Go operator 调和 4 个 CRD
(Worker/Team/Human/Manager)→ 每 Worker 一个 Pod/容器;Matrix(Tuwunel+
Element)做人机协作总线;MinIO 外置全部 agent 状态(worker 无状态可弃);
Higress AI 网关隔离真实凭证(agent 只拿限权 token);多运行时
(OpenClaw/QwenPaw/CoPaw/Hermes)同房协作;嵌入式进程内 kube-apiserver
让单机与集群共用同一声明式模型;`curl|bash` 单容器安装;Nacos 技能市场;
26 个脚本化黑盒 E2E。

## 2. 架构层借鉴(四个"想法")

| # | 想法 | 他们的实现 | 我们的映射 |
|---|------|-----------|-----------|
| A1 | **四面分离**:管事/干活/说话/记事各归各 | 控制器 / Worker 容器 / Matrix / MinIO | 即工厂角色表:Specify+agentd(管)/ worker(干)/ Palpo(说)/ 耐久存储(记)。现状病灶(P-10 绑定在 bridge、backend 身兼三职)都是"没分面"的症状 |
| A2 | **期望态 + 调和循环**为万能控制语法 | CRD reconcile;QwenPaw 5s 轮询 runtime.yaml 热更新 | 近期:team-roster.yaml;远期:ProjectExecutionSnapshot 本质即期望态 |
| A3 | **只编排不实现 agent**,运行时可插拔 | 四种运行时同房,WorkerSpec.runtime 字段 | 已在做(claude/codex 异构);守住 agent.json `type` 与 agentd RuntimeBackend 契约 |
| A4 | **层级管运维,同侪管质量** | LLM Manager 被禁止直连 API(只许 CLI) | 我们更进一步:控制面不是 LLM(agentd 确定性);评审保持同侪对抗。不改 |

**我们领先、不得放弃的**:agent-spec 合约(场景绑测试)、异构终审
(reviewer + Codex final gate)、证据链(签名 provenance、验收记录、
`[TEAM-NNN]` PR 门禁)。AgentTeams 无对应物。

## 3. 功能借鉴清单(按落地批次)

### 批次一(手工验收完成后,均为小活)

| 项 | 内容 | 治什么 |
|---|------|--------|
| F1 team-roster.yaml 生成器 | 全组一份花名册,`configure-standalone-env --roster` 自动生成每人 trusted-inviters / ignored-senders | 4 人拓扑 O(n²) 手工配置矩阵(Gap D) |
| F2 验收脚本化 | 手工验收单 C1-C8 逐项沉淀为 `tests/e2e/test-NN.sh`(仿其 26 场景) | 每次升级人肉回归 |
| F3 CLI-only 纪律 | issue-workflow 加一句:agent 只经 MCP 工具与 gh/agent-spec CLI 行事,禁止直连 backend HTTP | 工具面即治理面(openfab-bridge 删除事件的制度化) |
| F4 member-up.sh | 基础设施连接 + provision-team 收成一条命令 | 成员开通五步 → 一步 |

### 批次二(运维成熟度)

| 项 | 内容 |
|---|------|
| F5 preflight | `standalone-doctor --preflight`:Palpo 可达/token 有效/gh 登录/端口空闲,全绿才允许 cutover(可提前到验收前做) |
| F6 agentchat-embedded 镜像 | Palpo + 四件套(+可选 Element 兜底)单镜像 supervisord,成员开通= docker run |
| F7 upgrade.sh | 版本化部署 + 原地升级:先协调快照(复用 Task 9 剧本)→ 换版本 → 失败按快照回滚 |
| F8 rotate | configure-standalone-env `--rotate`:重生成 bridge secret / agent token + 有序重启 |

### 路线图对应项(拿 AgentTeams 当参考实现,不提前)

| 项 | 参考物 | 我们的路线图位置 |
|---|--------|----------------|
| R1 凭证隔离网关 | Higress:真钥匙只在网关,agent 拿限权 consumer token;当前我们 /start 直接注入真实 API key | FSF-2 / AD-E1(secret broker);顺带获得按人计量 |
| R2 desired-state 热更新 | QwenPaw worker 5s 轮询存储配置,不重启热切 | agentd 快照刷新语义 |
| R3 worker 三级进化 | 进程 → 本机 Docker 容器(Docker socket 拉起)→ K8s Pod;每 worker 一个 Pod 而非 Deployment(worker 是身份不是副本) | agentd AD-E5 设计参考;FSF-7 照抄"一 worker 一 Pod" |
| R4 Human 一等资源 | Human CRD:permissionLevel / accessibleTeams,一处定义处处生效 | Specify 的 RBAC intent 参考形状(F1 花名册是其雏形) |
| R5 技能市场 | Nacos registry + `nacos://` URI + STS scope | FSF-5 Skill Hub 现成先例 |
| R6 auto-sleep | 空闲 worker 自动休眠 | agentd worker 生命周期经济学 |
| R7 镜像瘦身纪律 | 基础镜像 1.79GB→100MB:基础设施不进 agent 镜像 | worker 容器化时执行 |
| R8 provider 可插拔 | matrix/storage/gateway.provider 一行切换 | 部署 profile 语法;见 §4 存储契约 |

## 4. S3 对象存储集成规划(含 RustFS)

### 4.1 为什么是 S3 范式(而非共享盘/数据库/git/聊天附件)

对多机器多 agent 系统,对象存储是三件事的共同地基:

1. **省 token**:agent 间传"地址"不传"内容",大文件不进 LLM 上下文;
2. **敢死**:状态在桶里、访问只需 HTTP——worker 容器可任意销毁重建(无状态耗材的前提);
3. **可信**:限权临时钥匙(每 agent 只能写自己前缀、限时过期)、预签名 URL
   (免凭证限时分享)、**WORM+版本化**(签过字的验收记录物理上改不了——
   正中证据链哲学)。

替代方案的短板:NFS 跨机跨网是灾难;数据库厌恶大文件;git 装二进制永久发胖
且无过期语义;Matrix 附件进上下文即付 token 税。

### 4.2 契约先行:绑协议,不绑产品

部署配置一律写作:

```yaml
storage:
  provider: s3-compatible   # rustfs | minio | garage | oss/s3
```

选型是**装机时决定**,不是架构决定(AgentTeams `storage.provider` 同理)。

### 4.3 RustFS 评估(2026-07 快照)

- Apache 2.0(对照 MinIO AGPL 及其 2025 社区版功能削减);全 S3 兼容,
  号称 MinIO **二进制级 drop-in**(数据/桶/配置原地保留);
- 4KB 小对象基准 2.3×;版本化 / **WORM** / SSE / 多站点复制;
  OIDC/LDAP/OPA 在路线图;
- **现状 Alpha,官方明确不建议生产使用**;
- 加分项:全 Rust 拼图(Palpo/Robrix/agentd/openfab/agent-spec 同语言),
  WORM 契合证据链。
- 备选:MinIO(稳,AGPL)、Garage(Rust 且稳,AGPL,小集群向)、云 OSS/S3。

**结论:首选候选,待 GA 转正;GA 前不承载生产数据。**

### 4.4 分阶段接入(S0-S3)

| 阶段 | 触发条件 | 内容 |
|------|---------|------|
| **S0 现在:不装** | — | 单机验收与 4 人首跑均不需要;避免多养服务 |
| **S1 工件通道** | 第一次出现"跨机器递交非代码工件"的真实需求(评审包/日志/截图/验收证据) | 云端 Palpo 旁加一个 S3 节点(dev/staging 可先 RustFS,生产数据用 MinIO/Garage 顶班);每成员/agent 发限权前缀钥匙 `agents/<team>/*`;issue-workflow 补一节"大工件走对象存储传 key,禁止贴正文"约定;预签名 URL 用于人类下载 |
| **S2 agentd 工件库** | FSF-2/3 落地(durable artifact store) | content-addressed 工件 + object-store refs(路线图原文即此);验收记录/签名工件进 **WORM 桶**(不可篡改从纪律变物理事实);对接 R1 网关钥匙体系 |
| **S3 技能分发** | FSF-5 Skill Hub | 技能包(zip+manifest+签名)入桶分发,参考 Nacos+STS 模式;近期技能分发仍走 git(有版本有评审,契合合约哲学) |

### 4.5 转正前冒烟清单(1 小时)

- [ ] 限权钥匙:A 的钥匙写不进 B 的前缀;过期后失效
- [ ] 预签名 URL:生成/下载/过期三态
- [ ] 版本化 + WORM:覆盖写产生新版本;WORM 桶拒绝改写与删除
- [ ] 资源占用:与 Palpo 同机时的内存/磁盘基线
- [ ] 备份恢复:桶级导出导入一轮
- [ ] (若 RustFS)从 MinIO drop-in 切换 + 切回,数据完好

### 4.6 风险与回退

- RustFS alpha 风险 → 生产数据用 MinIO/Garage 顶班,API 相同随时对调;
- 多一个服务的运维负担 → 仅在 S1 触发条件成立后引入,并纳入
  standalone-doctor 检查面与 upgrade/rotate 剧本;
- 与 Matrix 媒体库职责重叠 → 约定:聊天上下文附件走 Matrix,工作产物走 S3。

## 5. 与现行计划的关系

- **不影响**当前手工验收(A0 起步)与 4 人拓扑上线——批次一之前无任何新依赖;
- 执行顺序:手工验收 → F5(preflight)→ 批次一(F1-F4)→ 批次二(F6-F8)
  → 触发式 S1 → 路线图节奏的 R1-R8 / S2-S3;
- 本文档为参考输入,各项落地仍走既有流程:skill 约定改动直接做,代码改动
  走 TDD + 评审,阶段性能力对齐 FSF 门禁。
