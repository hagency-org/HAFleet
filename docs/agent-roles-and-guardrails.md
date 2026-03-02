# Agent 角色定义、注意力边界与焦点纠偏机制

**日期：** 2026-03-03
**状态：** 设计稿 v2

---

## 核心理念

现代 Agent 框架（Claude Code permission mode、Codex approval mode）已经解决了"能不能做"的问题。我们不需要再造一层访问控制。

我们要解决的是**注意力分配**问题：

> Agent 读什么文件、调什么 API 都不是问题。问题是它是否在**关心它应该关心的事**。

一个 model-worker 去读 PRTS 的代码理解接口——完全正常。
一个 model-worker 花 30 分钟调查 PRTS 的调度 bug——这就是注意力错位。

两者的行为表象（读 PRTS 代码）一样，但意图完全不同。只有语义判断能区分。

---

## 一、注意力边界模型

### 每个 Agent 有三层关注域

```
┌─────────────────────────────────────────────┐
│              Core（核心关注）                  │
│  这是我当前任务直接要求的东西                  │
│  例：model-worker 的当前任务是跑 wave5 实验   │
│  → ptst_exp 的模型代码、配置、训练日志        │
├─────────────────────────────────────────────┤
│          Adjacent（相邻关注）                  │
│  完成核心任务需要用到但不是我负责的东西        │
│  例：wave5 训练需要数据                       │
│  → umiki 的输出格式（理解接口，不深入内部）    │
│  例：wave5 训练通过 PRTS 提交                 │
│  → PRTS 的 CLI 用法（当用户，不当维护者）      │
├─────────────────────────────────────────────┤
│          Outside（域外）                      │
│  和当前任务无关的一切                         │
│  例：agentchat 的消息格式、backtest-web 的    │
│  前端组件、GPU 集群的硬件配置                 │
└─────────────────────────────────────────────┘
```

### 关注域与行为对应

| 域 | 允许的行为 | 注意力上限 |
|----|-----------|-----------|
| **Core** | 深入阅读、修改、调试、重构 | 无限制，这是主战场 |
| **Adjacent** | 阅读接口/文档、调用工具、查看输出 | 短暂接触，**理解后立即回到 Core** |
| **Outside** | 几乎不应该出现 | 如果在这里花了超过 2 分钟，就是问题 |

### 注意力漂移的典型模式

| 模式 | 描述 | 真实案例 |
|------|------|---------|
| **兔子洞（Rabbit Hole）** | 从 Adjacent 滑入 Outside，越挖越深 | 用 PRTS 提交训练 → 发现 PRTS 报错 → 开始调查 PRTS 调度逻辑 → 试图修 PRTS 的 bug |
| **担忧驱动（Worry-Driven）** | 对依赖的稳定性产生不必要的关注 | "PRTS 最近老出问题，我先检查一下它的队列状态" → 花 20 分钟审查 PRTS 的健康状况 |
| **顺手牵羊（While-I'm-Here）** | 在 Adjacent 区域看到"可以改进的地方"就动手 | 读 umiki 文档理解数据格式 → 发现文档有 typo → 开始修 umiki 的文档 → 顺便重构了一段代码 |
| **完美主义蔓延（Perfectionism Creep）** | 在 Core 内部过度优化非关键部分 | 任务是跑实验，花了 2 小时重构日志系统使其"更优雅" |
| **卡死循环（Stuck Loop）** | 在同一个问题上反复尝试没有进展 | 同一个 import error 尝试了 5 种写法，都是同一个根因没找到 |

---

## 二、agents.md 中的角色定义规范

每个 agent 的 `docs/{agent}/agents.md` 应包含以下结构：

```markdown
## Role
- 一句话：我是谁，我负责什么
- Core 关注域：列出核心工作目录和主题
- Adjacent 关注域：列出可能需要接触的外部依赖，以及接触方式（"作为用户使用"、"读接口文档"）

## Boundaries
### 该做
- 完成 plan.md Current 中的任务
- 遇到 Adjacent 依赖的问题时，记录现象并通过 agentchat 转交给负责人

### 不该关心
- 不调查 Adjacent 依赖的内部实现问题（它坏了不是你的事，报告给负责人）
- 不优化与当前任务无关的代码（记到 plan.md Queue，不现在做）
- 不为"可能的未来需求"做预防性工作
```

### 示例：model-worker

```markdown
## Role
- 我是 model-worker，负责 ptst_exp/FBM-S 的模型实验、训练、评估
- Core：ptst_exp/, FBM-S/ 下的模型代码、配置、实验脚本
- Adjacent：
  - umiki → 作为数据消费者，理解输出 schema，不深入管线内部
  - PRTS → 作为用户提交训练任务，不关心调度实现
  - datasetflow → 作为用户拉取数据集，不关心同步机制

## Boundaries
### 该做
- 推进 plan.md Current 中的实验任务
- 实验失败时做 root-cause analysis（在模型层面）
- 结果记录到 progress.md

### 不该关心
- PRTS 的调度逻辑、队列状态、bug（报告给 ops-worker）
- umiki 的管线代码、数据质量问题（报告给 data-worker）
- 训练服务器的硬件状态、网络问题（报告给 ops-worker）
- agentchat、gastown 的任何事务
```

### 示例：data-worker

```markdown
## Role
- 我是 data-worker，负责 umiki 数据管线、datasetflow 同步、lm-preproc 缓存桥
- Core：umiki/, datasetflow/, lm-preproc/
- Adjacent：
  - Databento API → 作为数据源，理解 API 规范，不关心 Databento 平台本身的问题
  - ptst_exp → 理解模型对数据的需求（schema、字段），不碰模型代码

## Boundaries
### 该做
- 推进 plan.md Current 中的数据任务
- 数据质量异常的 root-cause analysis
- 确保下游（model-worker）能正常消费数据

### 不该关心
- 模型训练的超参数、架构选择（那是 model-worker 的事）
- PRTS 的调度和部署（那是 ops-worker 的事）
- Databento 平台本身的服务状态（不可控外部依赖，记录并等待）
```

---

## 三、Supervisor 设计

### 3.1 定位

Supervisor 不是警察，是**焦点助手**——像一个坐在旁边的同事，偶尔提醒你"你是不是跑偏了"。

它是一个**独立的传统进程**（Node.js 或 Python 脚本），不是 Claude/Codex Agent。它通过 agentchat REST API 和 tmux 与系统交互。

### 3.2 信息输入

每次检查只需要三样东西：

| 输入 | 来源 | 代表什么 |
|------|------|---------|
| 当前任务 | `docs/{agent}/plan.md` → `## Current` | agent 应该在做什么 |
| 角色定义 | `docs/{agent}/agents.md` → `## Role` + `## Boundaries` | agent 的关注域边界 |
| 实际行为 | `tmux capture-pane -t {agent} -p -S -100` | agent 正在做什么 |

### 3.3 判断逻辑

一次 LLM 调用，回答一个问题：

> 这个 agent 的注意力是否在服务它的当前任务？

#### Prompt 模板

```
你是一个 AI Agent 焦点监督者。你的唯一任务是判断 agent 的注意力是否对齐。

## 当前任务
{current_task}

## 角色定义
{role_and_boundaries}

## 最近行为（tmux 最后 100 行）
{pane_content}

## 判断维度

1. **任务对齐**：agent 正在做的事情是否直接推进"当前任务"？
2. **关注域**：agent 的注意力是在 Core、Adjacent 还是 Outside？
   - Core 内的深入工作 → 正常
   - Adjacent 的短暂接触（查接口、看文档） → 正常
   - Adjacent 的深入调查（调试依赖的内部实现） → 漂移
   - Outside 的任何实质性工作 → 偏离
3. **进展性**：agent 是否在取得进展，还是在兜圈子？

## 输出

只输出 JSON，不要任何其他内容：
{
  "status": "FOCUSED | DRIFTING | LOST | STUCK",
  "domain": "core | adjacent | outside",
  "reason": "一句话，说明 agent 当前在关心什么",
  "pattern": "null | rabbit_hole | worry_driven | while_im_here | perfectionism | stuck_loop",
  "suggestion": "如果需要纠正，给 agent 的具体建议（null 如果不需要）"
}
```

#### 状态定义

| 状态 | 含义 | 典型场景 |
|------|------|---------|
| **FOCUSED** | 注意力在 Core 域内，直接推进当前任务 | 正常工作 |
| **DRIFTING** | 注意力从 Core 滑向 Adjacent 深处或 Core 内的非关键部分 | 兔子洞早期、顺手牵羊、完美主义 |
| **LOST** | 注意力在 Outside 域，或完全偏离当前任务 | 兔子洞晚期、担忧驱动 |
| **STUCK** | 在同一个问题上反复尝试没有实质进展 | 卡死循环 |

### 3.4 纠正策略

核心原则：**渐进式干预，最小侵入性。**

```
首次检测到非 FOCUSED:
  → 不干预，仅记录（可能是短暂的正常偏移）

连续 2 次检测到同一方向的非 FOCUSED:
  → 通过 agentchat 发送轻提醒（DM, type: inform）

连续 3 次:
  → 发送明确纠正（DM, type: request）

连续 5 次:
  → 通知人类介入（post to ops/info group, mention human）
```

#### 提醒消息的语气

**不是命令，是提问**——因为 supervisor 用的是廉价模型，它的判断可能是错的。提问式的纠正让 agent 自己思考，而不是盲从一个可能错误的指令。

轻提醒（连续 2 次）：
```
你当前的任务是「{current_task}」。
我注意到你最近在关注 {what_agent_is_doing}。
这是完成当前任务所必需的吗？如果不是，建议回到主线任务。
```

明确纠正（连续 3 次）：
```
你当前的任务是「{current_task}」。
过去几分钟你一直在 {what_agent_is_doing}。
这看起来属于 {responsible_agent} 的职责范围。
建议：{suggestion}，然后回到你的当前任务。
```

### 3.5 检查节奏与短路

| 条件 | 处理 |
|------|------|
| Agent idle（pane hash 未变化） | 跳过本轮检查 |
| Agent blocked（agentchat runtime 报告 blocked） | 跳过，blocked 有自己的处理机制 |
| 上一轮判断为 FOCUSED | 可以适当延长下次检查间隔（如 60s → 90s） |
| 上一轮判断为 DRIFTING/LOST | 缩短下次检查间隔（如 60s → 30s） |

### 3.6 日志

每次判断记录到 jsonl 文件，用于事后分析和 prompt 调优：

```jsonl
{"ts":"2026-03-03T10:00:30Z","agent":"model-worker","status":"FOCUSED","domain":"core","reason":"正在修改 ptst_exp/configs/wave5.yaml 配置实验参数","pattern":null,"cost_tokens":487}
{"ts":"2026-03-03T10:01:30Z","agent":"model-worker","status":"DRIFTING","domain":"adjacent","reason":"开始阅读 PRTS_Runner/src/scheduler.py 的调度逻辑","pattern":"rabbit_hole","cost_tokens":512}
{"ts":"2026-03-03T10:02:30Z","agent":"model-worker","status":"DRIFTING","domain":"adjacent","reason":"仍在 PRTS 调度代码中，试图理解任务排队机制","pattern":"rabbit_hole","action":"sent_reminder","cost_tokens":495}
```

事后分析可以回答：
- 哪些 agent 最容易漂移？
- 哪种 pattern 最常见？
- 纠正消息的有效率是多少（发了之后 agent 是否回到 FOCUSED）？
- supervisor 的误判率（人类复核后标记为误判的比例）？

---

## 四、实现方案

### 目录结构

```
agentchat/
└── supervisor/
    ├── index.js           # 入口：主循环、agent 发现、调度
    ├── collector.js        # 收集三样输入（plan.md、agents.md、tmux pane）
    ├── judge.js            # 调用 LLM API、解析返回
    ├── action.js           # 纠正动作（发消息、通知人类、记日志）
    ├── state.js            # 每个 agent 的连续状态追踪（连续 N 次 DRIFTING 等）
    ├── config.js           # 配置（扫描间隔、模型、API key、阈值）
    └── prompts/
        └── focus-check.txt # prompt 模板（方便迭代，不硬编码在 js 里）
```

### 依赖

- agentchat backend API（获取在线 agent 列表、发送消息）
- tmux（capture-pane）
- 一个 LLM API（DeepSeek / Qwen / 任何兼容 OpenAI 格式的）
- 文件系统（读 plan.md、agents.md）

无需数据库，无需额外服务。

### 配置

```yaml
# supervisor/config.yaml
scan_interval_sec: 45            # 基础扫描间隔
scan_interval_focused_sec: 90    # FOCUSED 时放宽
scan_interval_drifting_sec: 30   # DRIFTING 时收紧

pane_lines: 100                  # capture-pane 行数

llm:
  provider: deepseek              # deepseek | qwen | openai-compatible
  model: deepseek-chat            # 具体模型名
  api_key_env: SUPERVISOR_LLM_KEY # 从环境变量读取
  max_tokens: 200                 # 返回很短，不需要多
  temperature: 0.1                # 判断任务要确定性

thresholds:
  remind_after: 2                 # 连续 N 次非 FOCUSED 后发提醒
  correct_after: 3                # 连续 N 次后发纠正
  escalate_after: 5               # 连续 N 次后通知人类

agentchat:
  api_url: http://127.0.0.1:8090
  api_token_env: API_TOKEN

docs_root: /Users/kamico/work/laplace/docs  # 读 plan.md 和 agents.md 的根路径

log_file: logs/supervisor.jsonl
```

### 与 agentchat 的集成点

| 集成点 | 方式 | 说明 |
|--------|------|------|
| 获取在线 agent 列表 | `GET /api/agents` | 只检查 online 的 agent |
| 获取 idle 状态 | `GET /api/queue`（SSE）或轮询 | idle 的 agent 跳过 |
| 发送纠正消息 | `POST /api/messages` | from: "supervisor" |
| 通知人类 | `POST /api/messages`（post to group） | 升级到 info 群组 |

Supervisor 注册为一个特殊 agent（kind: "service"），不占 tmux session，不接收 push。

---

## 五、成本估算

| 参数 | 值 |
|------|-----|
| 每次判断 token 消耗 | ~800 input + ~100 output ≈ 900 tokens |
| 扫描间隔 | 平均 60s（FOCUSED 放宽、DRIFTING 收紧） |
| 同时在线 agent | 3-5 个 |
| idle 跳过率 | 约 30%（agent 在等 PRTS、等用户回复等） |
| 实际调用频率 | ~3 agent × 1/min × 0.7 利用率 ≈ 2 次/min |
| 每小时 token | ~108K tokens/hour |
| DeepSeek-V3 价格 | ¥2/百万 input + ¥8/百万 output |
| **每小时成本** | **约 ¥0.25** |
| **每天（8小时工作）** | **约 ¥2** |

这个成本完全可以忽略。

---

## 六、不做什么

明确列出 supervisor **不做**的事，防止过度设计：

1. **不做文件级访问控制** — Agent 框架自己管权限
2. **不做命令过滤** — Claude Code 的 permission mode 已经覆盖
3. **不做硬性阻断** — 不 kill 进程，不拦截操作，只发消息
4. **不自己修代码** — supervisor 是观察者，不是参与者
5. **不追求零误判** — 用提问式纠正来容忍误判，让 agent 自己思考
6. **不替代人类决策** — 连续 5 次无法纠正就升级给人类，不自作主张

---

## 七、落地步骤

### Step 1：角色定义先行（前置条件）
- 为每个计划运行的 agent 写好 agents.md（Role + Boundaries）
- 确保 plan.md 的 Current 始终有明确的任务描述
- 这是 supervisor 判断的依据，没有这个一切免谈

### Step 2：最小可用 supervisor
- 实现 collector + judge + 日志
- 不发纠正消息，只记日志
- 人工审查日志，验证判断质量
- 调优 prompt 直到误判率可接受

### Step 3：接入纠正动作
- 开启 agentchat 消息发送
- 先只做轻提醒（连续 2 次），观察 agent 响应
- 逐步开启明确纠正和人类升级

### Step 4：持续迭代
- 分析 supervisor.jsonl 日志
- 识别新的漂移 pattern，补充到 prompt
- 追踪纠正有效率（发了提醒后多久回到 FOCUSED）
- 根据实际情况调整阈值
