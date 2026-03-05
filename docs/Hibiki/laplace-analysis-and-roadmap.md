# Laplace 生态现状分析与方向规划

**日期：** 2026-03-02
**作者：** Hibiki

---

## 一、全景地图

Laplace 已经是一套**端到端的量化研究与生产管线**，覆盖了从原始数据到模型训练再到回测可视化的完整链路：

```
数据层                  计算层                   应用层                 基础设施层
─────────────────────  ──────────────────────  ─────────────────────  ──────────────
Databento (外部)        ptst_exp (FBP模型)       backtest-web (回测UI)   gpu-cluster-bom
  │                     FBM-S (季节分解)          PRTS_Runner (调度)       config.yaml
  ▼                       │                         │                    gastown (编排)
lm-preproc (缓存桥)      │                         │                    GTRuntime (运行时)
  │                       ▼                         ▼
  ▼                    PRTS (训练/推理)  ◄────► backtest-web bridge
umiki (MBP-10管线)         │
  │                        │
  ▼                        ▼
datasetflow (目录分发)   backtest eval (策略评估)

替代数据:
MediaCrawler (爬虫) → BettaFish (舆情分析) → [待接入特征工程]

Agent 通讯:
agentchat (跨服务器消息) ← gastown (多Agent编排)
```

### 各层成熟度评估

| 层级 | 项目 | 成熟度 | 说明 |
|------|------|--------|------|
| **数据采集** | Databento + lm-preproc | ★★★★☆ | MBP-10 数据流已通，缓存桥运行 |
| **数据管线** | umiki | ★★★★☆ | Raw→Canonical→Derived→Training 四阶段完整 |
| **数据分发** | datasetflow | ★★★☆☆ | BLAKE3 增量同步已实现，与 PRTS 集成中 |
| **模型研发** | ptst_exp + FBM-S | ★★★★☆ | NeurIPS 论文级，多资产+概率预测+GMM |
| **训练调度** | PRTS_Runner | ★★★★☆ | 队列、远程执行、AutoScale、SSE 监控 |
| **回测系统** | backtest-web + bridge | ★★★☆☆ | 策略评估、预测诊断已有，但策略引擎在 bridge 本地 |
| **替代数据** | MediaCrawler + BettaFish | ★★☆☆☆ | 爬虫和情感分析存在，但未接入主管线 |
| **Agent 通讯** | agentchat | ★★★★☆ | DM/群组/MCP/Matrix/远程推送齐全 |
| **Agent 编排** | gastown | ★★★☆☆ | Mayor/Rig/Polecat 架构，git-hook 持久化 |
| **硬件规划** | gpu-cluster-bom | ★★☆☆☆ | BOM 文档阶段，未实际部署 |

---

## 二、核心问题诊断

### 问题 1：agentchat 是"通讯"而非"框架"

agentchat 当前做到了：
- Agent 之间能发消息（DM、群组、@mention）
- MCP 集成让 Claude Code 原生使用
- 跨服务器推送（push-relay + tmux 注入）
- Matrix 桥接人类参与

**缺失的是 AVB 文章中所有上层抽象：**

| AVB 框架维度 | agentchat 现状 | 缺口 |
|-------------|---------------|------|
| System Prompt 设计 | 无——Agent 的角色/目标/工具由各自定义 | 没有统一的 Agent 角色定义协议 |
| Lazy Loading Context | 无——消息全量推送 | 没有按需拉取机制，没有"索引页" |
| Action Space 管理 | 无——Agent 可以做任何事 | 没有工具注册/发现/权限控制 |
| 子 Agent 委派 | 部分——gastown 有 Polecat 概念 | agentchat 层无任务分解/派发协议 |
| 持久化策略 | 基础——JSON 文件存消息 | 无 Agent 级 memory、scratchpad、todo |
| 评估与可观测性 | 基础——活动追踪/阻塞检测 | 无 trace 日志、无回放测试、无量化评分 |

**本质问题：agentchat 解决了 Agent 之间"怎么说话"，但没解决"说什么"、"为什么说"、"说了之后做什么"。**

### 问题 2：量化能力与 Agent 能力割裂

gemchanger 那篇文章描述的量化模拟堆栈（蒙特卡洛 → 重要性采样 → 粒子滤波 → Copula → ABM → 生产架构），在 Laplace 中的对应：

| 量化堆栈层 | Laplace 现状 | 差距 |
|-----------|-------------|------|
| Layer 1: 数据摄入 | ✅ umiki + Databento + lm-preproc | 基本就位 |
| Layer 2: 概率引擎 | ⚠️ ptst_exp 做点预测，缺概率模拟 | 没有蒙特卡洛/粒子滤波/贝叶斯推断 |
| Layer 3: 依赖建模 | ❌ 完全缺失 | 没有 Copula、多资产相关性建模 |
| Layer 4: 风险管理 | ❌ 完全缺失 | 没有 VaR/ES、压力测试 |
| Layer 5: 监控 | ⚠️ backtest-web 有可视化 | 没有 Brier Score、模型漂移检测 |

**ptst_exp 做的是"预测"（给一个点估计），不是"模拟"（给一个概率分布和路径集合）。**

### 问题 3：回测系统过于简单

backtest-web 的 bridge 策略引擎：
- z-score 阈值 → 交易信号
- 固定交易成本/滑点
- 单策略评估

缺少：
- 多策略对比框架
- 路径依赖的风险管理（止损/仓位管理/相关性约束）
- 组合层面的优化（不只是单资产信号）
- 实时模拟（非纯回顾式回测）

### 问题 4：替代数据未接入主管线

MediaCrawler + BettaFish 是独立系统，没有：
- 情感信号 → umiki 特征工程管线的接口
- 情感特征 → ptst_exp 模型输入的集成
- 实时情感流 → 交易信号的通路

---

## 三、方向规划

### 战略定位

将 Laplace 从**"AI辅助的量化研究平台"**升级为**"Agent驱动的量化模拟与交易系统"**。

核心思路：**让 Agent 不只是帮你写代码的助手，而是量化管线中的一等公民——能观测市场、做模拟、管理风险、执行策略。**

### 三条演进路线

```
路线 A: agentchat → Agent Framework（Agent 能力升级）
路线 B: backtest-web → Simulation Engine（量化能力升级）
路线 C: 数据闭环（替代数据 → 特征 → 模型 → 信号）
```

---

### 路线 A：从通讯平台到 Agent Framework

**目标：** 在 agentchat 之上构建真正的 Agentic 框架层，参考 AVB 的五维设计。

#### A1. Agent 角色协议（对应 AVB: System Prompt）

定义标准化的 Agent 角色描述格式：

```yaml
# agents/market-observer.yaml
name: market-observer
role: "Real-time market data monitor and anomaly detector"
observations:
  - umiki derived features (spread, imbalance, depth)
  - PRTS model predictions
  - BettaFish sentiment signals
success_criteria:
  - detect anomalies within 30s of occurrence
  - alert relevant agents with structured signal
tools:
  - umiki-api (read market features)
  - agentchat (send alerts)
  - memory (persist detected patterns)
constraints:
  - read-only on market data
  - max 1 alert per minute per asset
```

这样每个 Agent 启动时自动注入角色定义，而非各自为政。

#### A2. 上下文管理层（对应 AVB: Lazy Loading + Persisting）

在 agentchat 上增加三个机制：

| 机制 | 功能 | 实现方式 |
|------|------|---------|
| **Memory Store** | Agent 级持久记忆 | 每个 Agent 一个 KV store，支持 read/write/search |
| **Scratchpad** | 多 Agent 共享白板 | 按任务 ID 的临时共享空间，任务结束后归档 |
| **Context Index** | 懒加载索引 | Agent 拿到的是"目录"，按需拉取详情 |

#### A3. 任务分解与委派协议（对应 AVB: Delegating）

在 agentchat 的消息类型上扩展：

```
现有: inform, request, reply, human
新增: task (结构化任务派发)
     result (任务结果返回)
     status (任务进度更新)
```

定义 Task 结构：
```json
{
  "type": "task",
  "task_id": "sim-001",
  "parent_task": null,
  "assigned_to": "simulator",
  "spec": {
    "action": "monte_carlo_simulation",
    "params": { "asset": "AAPL", "paths": 100000, "horizon": "30d" }
  },
  "deadline": "2026-03-02T22:00:00Z",
  "priority": "high"
}
```

#### A4. 可观测性（对应 AVB: 评估与迭代）

- **Trace 日志：** 每个 Agent 的每次决策记录（输入 → 推理 → 输出 → 结果）
- **回放框架：** 给定历史输入，重放 Agent 决策，量化评分
- **仪表盘：** 扩展 agentchat 的 Web Dashboard，展示 Agent 效能指标

---

### 路线 B：从回测工具到模拟引擎

**目标：** 将 backtest-web + bridge 从"策略回测可视化"升级为 gemchanger 文章描述的多层模拟系统。

#### B1. 概率模拟引擎（新模块）

对应 gemchanger Part II–V，构建独立的模拟引擎服务：

```
simulation-engine/
├── core/
│   ├── monte_carlo.py      # 基础 MC + 方差缩减（对偶/控制/分层）
│   ├── importance_sampling.py  # 尾部风险事件模拟
│   ├── particle_filter.py     # 实时贝叶斯更新
│   └── jump_diffusion.py      # 跳跃扩散路径生成
├── dependency/
│   ├── copula.py             # Gaussian / t / Clayton / Gumbel
│   └── vine_copula.py        # 高维依赖建模
├── risk/
│   ├── var_es.py             # VaR + Expected Shortfall
│   ├── stress_test.py        # 逆向压力测试
│   └── correlation_stress.py  # 相关性冲击
├── evaluation/
│   ├── brier_score.py        # 概率校准
│   └── calibration.py        # 模型漂移检测
└── api/
    └── server.py             # FastAPI 服务，供 bridge 和 Agent 调用
```

**与现有系统的集成点：**
- ptst_exp 输出点预测 → 模拟引擎用作先验，生成路径分布
- umiki 特征 → 模拟引擎的输入信号
- bridge 调用模拟引擎 → 替代当前简单的 z-score 策略
- backtest-web 可视化模拟结果（路径扇形图、概率热力图）

#### B2. 策略引擎升级

当前 bridge 的策略逻辑（z-score 阈值）需要升级为：

| 能力 | 当前 | 目标 |
|------|------|------|
| 信号生成 | 单一 z-score | 多因子复合信号（预测+情感+微结构） |
| 仓位管理 | 无 | Kelly 公式 / 风险平价 / 最大回撤约束 |
| 多资产组合 | 单资产独立 | Copula 约束下的组合优化 |
| 执行模拟 | 固定成本 | ABM 订单簿模拟（参考 gemchanger Part VII） |
| 风险控制 | 无 | 实时 VaR 监控 + 止损 |

#### B3. backtest-web 前端扩展

新增页面/组件：
- **Simulation Dashboard** — 路径分布扇形图、概率热力图
- **Risk Monitor** — VaR/ES 时间序列、相关性矩阵热力图
- **Strategy Comparison** — 多策略叠加对比（而非当前只比较 run）
- **Agent Activity Feed** — 实时展示 Agent 的模拟决策流

---

### 路线 C：数据闭环

**目标：** 打通替代数据到交易信号的完整闭环。

```
MediaCrawler → BettaFish → umiki (特征工程) → ptst_exp (模型) → simulation-engine → strategy
     ↑                                                                                    │
     └──────────────────────── 反馈循环（哪些情感信号有预测力） ◄─────────────────────────┘
```

#### C1. BettaFish → umiki 接口

- 定义情感特征 schema（sentiment_score, volume_mention, topic_vector）
- BettaFish 输出写入 umiki 的 Derived Zone
- umiki 在特征工程阶段合并微结构 + 情感特征

#### C2. 特征重要性反馈

- 模型训练后输出特征重要性排名
- 自动反馈给 BettaFish：哪些话题/平台/关键词的情感信号有真实预测力
- 调整爬虫优先级和情感模型权重

---

## 四、优先级建议

按**投入产出比**排序：

| 优先级 | 任务 | 理由 |
|--------|------|------|
| **P0** | 路线 B1: 概率模拟引擎 | 这是量化系统的核心缺失件，ptst_exp 有预测但没模拟 |
| **P0** | 路线 A1: Agent 角色协议 | 成本低（只是 YAML 定义），但能立即让 Agent 行为可预测 |
| **P1** | 路线 B2: 策略引擎升级 | 有了模拟引擎后自然需要更好的策略 |
| **P1** | 路线 A3: 任务委派协议 | 让 Agent 能真正分工协作做量化任务 |
| **P2** | 路线 A2: 上下文管理层 | 重要但可渐进式构建 |
| **P2** | 路线 C1: BettaFish → umiki 接口 | 替代数据能增加 alpha，但需先有模拟引擎验证 |
| **P3** | 路线 B3: 前端扩展 | 可视化锦上添花，优先级低于引擎 |
| **P3** | 路线 A4: 可观测性 | 长期必要，但系统规模还不大时可暂缓 |
| **P3** | 路线 C2: 特征反馈循环 | 需要前面都就位后才有意义 |

---

## 五、一句话总结

**Laplace 的数据管线和模型训练已经很强，但"预测"和"模拟"之间有一道鸿沟，"Agent 能通讯"和"Agent 能自主执行量化任务"之间也有一道鸿沟。填上这两道沟，就是一个完整的 Agent 驱动的量化系统。**
