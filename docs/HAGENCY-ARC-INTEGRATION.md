# HAgency × ARC 整合:需求编译与可插拔实现后端

- 版本:v1(2026-07-20)
- 范围:HAgency(robrix + agent-chat)× agent-spec × ARC × octos
- 定位参考:`docs/AGENTTEAMS-BORROWINGS-AND-S3-INTEGRATION.md`(协作栈路线图 v2)

## 0. 名词与一句话

- **HAgency** = robrix2(人机界面)+ agent-chat(编排 / 运行时 / 消息总线)。
  是人和多 agent 在可信、可审计的房间里协作的那一层。
- **agent-spec**(自研工具)= 需求中枢:把自然语言需求编译成机器可查的需求图,
  并**导出 ARC 兼容的输入格式**(arc-native dialect)。
- **ARC** = 需求编译器 + 可视化(ARC-Bench):把结构化需求树编译成接口、
  测试、代码,带可追溯执行轨迹。上游是**合作方项目**(`code-philia`);其
  **agent-chat 集成层是我们在自有 fork(`ZhangHanDong`)上加的**(见 §2)。
- **octos**(自研)= Rust-native API-first Agentic OS,可作为一个 coding agent。

**一句话**:HAgency 负责"人机协作 + 把门",agent-spec 负责"需求 → ARC 输入",
ARC 负责"编译 + 可视化 + 阶段编排",而**真正写代码的 coding agent 是可插拔的**
——可以是 ARC 自带的,也可以是 HAgency 里的 Claude/Codex,还可以是 octos。

## 1. 依赖方向(不可动摇)

```text
agent-spec ──arc-native──▶ ARC(编译/可视化/编排/系统所有的验证)
     ▲                          │  委托实现阶段
     │自然语言                   ▼
   人(robrix)          coding agent(可插拔:ARC自带 / Claude / Codex / octos)
     └────────── 全程在 agent-chat 房间里编排、审计 ────────────┘
```

铁律:**agent-chat 协议是主,ARC 侧适配它**。而且这个适配是**我们主动加的**
(见 §2 的分支事实):agent-chat 集成三级全部由 AlexZ 写在 ARC 的 fork 分支上,
所以 `arc_stage` 等 schema 的定义权与协议主动权都在我们手里。agent-chat 核心
永不 import ARC/octos 内部,一切经 `task_request/task_result` 协议门;ARC 上游
未来独立演进,HAgency 一行不改。

## 2. 关键事实:ARC 已实现的三级 agent-chat 集成

**分支事实(重要)**:这三级集成不是上游 ARC 自带的,而是**我们自己加的**。
提交 `54cd6f0`(进度上报)→ `ec49ce6`(serve)→ `e09cb38`(阶段委托)全部
**作者 AlexZ,2026-07-20**,在 ARC fork **`ZhangHanDong/agentic-requirement-compiler`**
的分支 **`feat/agent-chat-progress-reporting`** 上;上游是
`code-philia/agentic-requirement-compiler`。**尚未合入 ARC main / 未回上游**——
代码与 14 个测试齐全、可用,但状态是"我们 fork 的 feature 分支",要长期依赖需
决定是回贡上游还是维护自有 fork。

来源:该分支的 `AGENT-CHAT.md` + 上述三个提交。全部用同一组 env:
`AGENT_CHAT_URL` / `AGENT_CHAT_TOKEN` / `AGENT_CHAT_AGENT_TOKEN` /
`AGENT_CHAT_AGENT_NAME`(默认 `arc-compiler`)。

| 级别 | 是什么 | 对我们的意义 |
|---|---|---|
| **① 进度上报**(单向) | 编译里程碑/错误以 `arc_progress` 消息发进房间/DM;失败只延迟不影响编译 | ARC 在房间里"可见",人能看到它干到哪 |
| **② serve 模式**(整锅承包) | ARC 作为 `arc-compiler` agent 常驻:heartbeat 自动注册上线、轮询 inbox、执行 `task_request`(payload 带 `requirement_dir` 等)、回 `task_result`{ok, failed_nodes, output_dir, log_path} | HAgency 里"选 ARC 当代码 agent" = 给它发一条 DM |
| **③ 阶段委托**(编译器 + 别人写码) | ARC 把三个实现阶段(接口设计/测试生成/TDD)打包成 `arc_stage` 的 task_request,发给**配置的 implementer agent**,对方在共享工作区干活、回 task_result;**委托运行不构建 chat model、不需要 OpenAI key** | **这才是"用 ARC 的编译/可视化,实现交给别的 agent"的核心机制** |

③ 的信任设计尤其契合我们:**验证仍归系统所有**——委托 TDD 阶段后,**ARC 自己
跑该节点的测试,exit code 0 才接受 IMPLEMENTED**;委托失败则记为 failed,绝不静默
放过。这与我们"信任来自证据、不来自 agent 自报"的哲学同源。启用:`--delegate-to`
/ `ARC_DELEGATE_TO` + `AGENT_CHAT_URL`;可与 `--serve` 组合(任务串行,不与 worker
的 cursor 读竞争)。

## 3. 路径一:HAgency 里选后端(ARC 或其他)

在房间工作流(issue-workflow)里,`/go NNN` 时选择实现后端:

**1a. 选 ARC 整锅承包(serve 模式)**
```text
房间对话 → agent-spec 编需求树 → export --dialect arc-native → requirement_dir
  → send_message(to="arc-compiler", schema={kind:"task_request",
       payload:{requirement_dir, app_type, ...}})
  → ARC 编译(接口+测试+代码,自带 coding)→ task_result 回 coordinator
  → 统一验收:回房间 → Codex 终审 → PR
```

**1b. 选 ARC 编译 + HAgency 的 Claude/Codex 写码(阶段委托)**
```text
同上 export → ARC serve 收到任务 → 但 ARC 以 --delegate-to=<team>_implementer
  运行:每个实现阶段发 arc_stage 给你的 implementer,它在共享工作区写码,
  ARC 收 task_result 后自己跑测试判定 → 汇总 task_result
  → 你既拿到 ARC 的需求编译/可视化/编排,代码又是你信任的 Claude/Codex 写的
```

**1c. 选纯 HAgency(不经 ARC)**
```text
export --dialect v1 → 走 agent-spec 自己的 spec 路径 → issue-workflow 的
  implementer(Claude/Codex)实现 → reviewer + Codex 终审 → PR
```

选型直觉:绿地/需求树复杂/要可视化 → 1a/1b;存量仓库增量 → 1c。

## 4. 路径二:octos + agent-spec → ARC 后端 coding agent

octos 是 Rust-native Agentic OS(~140 REST endpoints,14 消息通道含 **Matrix**,
可多租户)。两种接入姿势:

**2a. octos 作为 ARC 的委托 coding agent**
octos 能在 Matrix/agent-chat 通道里以一个 agent 身份存在;当它实现了
`task_request(arc_stage)` 的应答,就能被 ARC 的 `--delegate-to` 指向——
即 ARC 编译、octos 写码。这是路径一 1b 的"coding agent = octos"变体。
> 状态:octos 具备通道与 REST 能力(已实现);作为 ARC 委托端的 `arc_stage`
> 应答适配是**设计路径**,需一个薄适配(与 ARC serve worker 同构)。

**2b. octos + agent-spec 产出 ARC 兼容需求**
agent-spec 的 `requirements export --dialect arc-native`(已发布,1.1.0)是
ARC 输入的标准生产者;octos 侧的需求对话/编排把自然语言汇成 agent-spec 的
输入,agent-spec 出 arc-native yaml,喂 ARC。
> 状态:agent-spec arc-native 导出已实现;octos↔agent-spec 的需求汇集编排是
> **设计路径**。

## 5. 共同起点:agent-spec 的 arc-native dialect(已实现)

无论哪条路径,ARC 的输入都由 agent-spec 统一生产:

```bash
agent-spec requirements import      # 自然语言/PRD → knowledge/requirements/
agent-spec requirements graph --gate      # 需求图机械把关
agent-spec requirements export --dialect arc-native --out arc.yaml --provenance prov.json
```

`arc-native` 输出单根需求树(ROOT/FOLDER/ATOMIC),正是 ARC `requirement_dir`
吃的格式;`--provenance` 让"哪版需求、经哪次编译"可追溯(需求版本权威的机械载体)。

## 6. 四个待接线缺口(实现前认账)

| 缺口 | 归属 | 说明 |
|---|---|---|
| `task_request` 稳定幂等 id | 我们(协议方) | 超时重发不能变新任务;schema 已有 version,加 `task_id` |
| agent-spec verify 仅 cargo test | 我们(核心投资) | runner 分发,让机械验收覆盖 ARC 产的 pytest/JS 测试 |
| 跨机产物取货 | 我们(基础设施) | ARC 产物在本机;多机需 S3 工件通道(路线图 S1) |
| ARC `--stop-after tests`(只要接口+测试) | 合作方 | 想要"前段复用"再提 feature request;现有整锅/委托两模式已够用 |

## 7. 落地顺序

1. 手工验收(HAgency 独立栈)先闭环;
2. agent-spec runner 分发(核心投资 #1);
3. `/via arc` 约定 + `task_id` 幂等 + 执行后端接入规范(把 task_request/
   task_result/arc_stage 成文,面向 ARC/octos/任意后端);
4. 小 demo 试点一单:对话 → arc-native → ARC(1a 或 1b)→ Codex 终审 → PR;
5. octos 适配(2a 薄适配)与 S3 工件通道按需触发。

一句话收尾:**HAgency 定标准与把门,agent-spec 定需求格式,ARC 提供编译与可视化,
coding agent 可插拔——三级集成里 ARC 已经把"整锅承包"和"我编译你写码"都实现了,
我们要做的只是把协议成文、把幂等和验收补齐。**
