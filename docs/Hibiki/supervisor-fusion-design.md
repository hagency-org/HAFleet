# Subconscious × agentchat 集成设计

**日期：** 2026-03-06
**作者：** Hibiki

---

## 一、设计原则

1. **以 claude-subconscious 为基底** — 它是成熟的开源项目，hooks 架构、Letta 记忆、transcript 处理都已经生产就绪
2. **per-agent 部署** — 每个 agent 一个 Letta subconscious 实例，不做中心化监控
3. **扩展而非改造** — 在 subconscious 的基础上增加 agentchat 感知，不重写核心逻辑
4. **现有 supervisor 逐步退役** — 审计 UI 保留并改为消费 subconscious 的事件流

---

## 二、需要扩展的三个方向

### 方向 1：让 Subconscious 感知 agentchat 工作流

当前 subconscious 是一个通用的 Claude Code 记忆层，不了解我们的 CLAUDE.md 工作约定。需要让它知道：

- **plan.md** 的存在和结构（Current / Queue / Blocked）
- **agents.md** 定义了 agent 的角色和边界
- **progress.md** 是完成工作的日志
- agent 应该在工作前更新 plan.md Current，完成后更新 progress.md

#### 改动：定制 Subconscious.af

在默认的 8 个 memory block 基础上，修改 `core_directives` 并新增 `workspace_conventions` block：

```
Block: workspace_conventions
Description: Agent workspace rules this agent follows (CLAUDE.md convention)

Content:
The Claude Code agent I observe follows a structured workspace convention:

FILES:
- docs/{agent}/plan.md — Task state. Structure: Current (one active task), Queue (ordered next tasks), Blocked (waiting items)
- docs/{agent}/agents.md — Agent's role, boundaries, and knowledge base
- docs/{agent}/progress.md — Append-only log of completed work

WORKFLOW:
- Before starting work: set plan.md Current
- After completing work: update plan.md (promote next Queue item), append to progress.md
- Agent should NOT work without a Current task in plan.md

WHAT TO WATCH:
- Is the agent updating plan.md before/after work? If not, nudge them.
- Is the agent's actual behavior aligned with plan.md Current?
- Is the agent working within the boundaries defined in agents.md?
- If the agent drifts, is it because the user redirected them? (user intent > plan.md)

ATTENTION DOMAINS:
- Core: directly related to plan.md Current task
- Adjacent: supporting work that enables the current task
- Outside: unrelated to current task AND not user-directed
```

同时修改 `core_directives` 追加：

```
WORKSPACE AWARENESS:
- I observe agents that follow a structured plan.md/agents.md/progress.md workflow
- When I see the agent working without updating plan.md, I should note this in guidance
- When the agent's behavior drifts from plan.md Current without user direction, I should flag it
- User intent always takes priority over plan.md — if the user redirects, that's fine
- I track attention domains: core (on-task), adjacent (supporting), outside (drifting)
```

#### 改动：扩展 Stop hook transcript 发送

当前 Stop hook 只发送 transcript。需要在发送前追加 plan.md 的当前内容，让 Letta 有判断基准：

```xml
<claude_code_session_update>
  <session_id>{sessionId}</session_id>

  <workspace_state>
    <plan_current>{content of plan.md Current section}</plan_current>
    <agent_role>{Role section from agents.md}</agent_role>
    <agent_boundaries>{Boundaries section from agents.md}</agent_boundaries>
  </workspace_state>

  <transcript>
    ...existing transcript format...
  </transcript>

  <instructions>
    ...existing instructions...
    Additionally, evaluate whether the agent's actions align with plan_current.
    If the agent seems to be drifting, note the attention domain (core/adjacent/outside)
    and any drift pattern (rabbit_hole, worry_driven, while_im_here, perfectionism, stuck_loop).
  </instructions>
</claude_code_session_update>
```

**实现方式：** fork claude-subconscious 的 `send_messages_to_letta.ts`，在构造 XML 前读取 `docs/{agent}/plan.md` 和 `docs/{agent}/agents.md`。agent 名从环境变量 `AGENT_NAME` 获取（agent-up 启动时注入）。

### 方向 2：Subconscious 事件上报到 agentchat 审计 UI

当前审计 UI 消费 supervisor 的事件格式。让 subconscious 也能产生兼容的事件，审计 UI 就能展示 subconscious 的判断。

#### 方案：Letta guidance → 审计事件

Subconscious 通过 `guidance` memory block 表达判断。新增一个机制：每当 guidance block 变化时，解析其中的焦点判断并推送到 agentchat。

**在 sync_letta_memory.ts 中增加逻辑：**

当检测到 `guidance` block 变化且包含焦点相关内容时，POST 到 agentchat：

```javascript
// 检测 guidance block 变化
if (guidanceChanged && guidanceContent.includes('[focus:')) {
  // 从 guidance 中提取结构化判断
  // Subconscious 被训练在 guidance 中用特定格式标记焦点判断：
  // [focus: DRIFTING | domain: outside | pattern: rabbit_hole]
  // 原因说明...

  const event = {
    id: `subconscious_${Date.now()}_${agentName}`,
    ts: Date.now(),
    agent: agentName,
    source: 'subconscious',  // 区别于 'supervisor'
    status: parsed.status,    // FOCUSED / DRIFTING / LOST / STUCK
    domain: parsed.domain,
    reason: parsed.reason,
    pattern: parsed.pattern,
    suggestion: parsed.suggestion,
    negative: ['DRIFTING', 'LOST', 'STUCK'].includes(parsed.status),
    // Letta-specific fields
    letta: {
      agentId: lettaAgentId,
      conversationId: conversationId,
      memoryBlocksChanged: changedBlocks,
    }
  };

  // POST to agentchat backend
  await fetch(`${AGENTCHAT_URL}/api/supervisor/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
}
```

**agentchat backend 侧新增：**

```javascript
// POST /api/supervisor/events — 接收外部事件
app.post('/api/supervisor/events', (req, res) => {
  const event = req.body;
  // 验证必要字段
  // 追加到 supervisor.jsonl
  // broadcastSSE('supervisor_audit', event)
  // 更新 latestByAgent
  res.json({ ok: true });
});
```

这样审计 UI 无需修改就能展示 subconscious 的判断——因为事件格式兼容。

#### guidance block 格式约定

训练 Subconscious 在 guidance 中用结构化格式标记焦点判断：

```
[focus: DRIFTING | domain: outside | pattern: rabbit_hole]
Agent 花了大量时间调研 Redis 集群配置，但当前任务是实现 API 缓存层。
建议用最简单的单节点 Redis 先跑通，集群是后续的事。

[plan-check: stale]
Agent 已完成 API 缓存层实现但未更新 plan.md。提醒更新。
```

这个格式同时服务两个目的：
1. 注入回 Claude 时是自然语言指导
2. 上报到审计 UI 时可以 parse 成结构化事件

### 方向 3：agent-up 集成

每个 agent 启动时自动配置 subconscious。

#### agent-up 新增流程：

```bash
# 1. 为该 agent 创建/获取 Letta agent
#    每个 agent 有独立的 Letta agent ID，存在 data/agents/{name}/letta.json
LETTA_AGENT_ID=$(get_or_create_letta_agent "$AGENT_NAME")

# 2. 配置 hooks（merge 到 .claude/settings.json）
configure_subconscious_hooks "$WORKSPACE" "$AGENT_NAME" "$LETTA_AGENT_ID"

# 3. 注入环境变量
export LETTA_API_KEY="$LETTA_API_KEY"
export LETTA_AGENT_ID="$LETTA_AGENT_ID"
export LETTA_MODE="whisper"  # 默认轻量模式
export AGENT_NAME="$AGENT_NAME"
export AGENTCHAT_URL="http://localhost:8090"
```

#### Letta agent 初始化

首次启动时，从定制的 Subconscious.af（包含 workspace_conventions block）导入 Letta agent。后续复用同一 agent ID。

```
data/agents/{agentName}/letta.json
{
  "agentId": "agent-xxxx-xxxx",
  "createdAt": "...",
  "model": "anthropic/claude-sonnet-4-5"
}
```

---

## 三、现有 supervisor 的过渡策略

不需要立即删除现有 supervisor。过渡计划：

| 阶段 | 状态 |
|------|------|
| Phase 0（当前） | supervisor 独立运行，subconscious 未接入 |
| Phase 1 | 对 1-2 个 agent 部署 subconscious，两套并行，审计 UI 同时展示两个来源 |
| Phase 2 | 验证 subconscious 判断质量后，逐步迁移更多 agent |
| Phase 3 | supervisor 的 LLM judge 退役，保留 collector 作为兜底（无 hooks 的 agent） |
| Phase 4 | supervisor 简化为事件聚合器 + 审计 UI 后端，不再做独立判断 |

最终状态：supervisor 模块变成"审计事件聚合服务"，接收来自各 agent 的 subconscious 事件，提供统一的 REST API 和 SSE 流给审计 UI。

---

## 四、关键问题和决策

### Q1: Letta 模型选择？

Subconscious 默认推荐 `anthropic/claude-sonnet-4-5`。但如果每个 agent 都有一个 Letta 实例持续处理 transcript，成本需要考虑。

选项：
- **Sonnet 4.5** — 最佳质量，但每个 agent 每轮 transcript 都消耗 Sonnet tokens
- **Haiku 4.5** — 便宜很多，对于焦点判断可能够用
- **GLM / DeepSeek** — 如果 Letta 支持自定义模型端点

**建议**：先用 Sonnet 测试质量，确认后切到 Haiku 降成本。焦点判断不需要最强推理能力。

### Q2: Letta Cloud vs Self-hosted？

- **Cloud** — 开箱即用，5000 credits/month 免费额度
- **Self-hosted** — 无限制，但需要维护

多 agent 场景下免费额度可能不够。如果每个 agent 每天产生 50 次 transcript 处理，20 个 active agent = 1000 次/天。

**建议**：Phase 1 用 Cloud 验证概念，Phase 2 评估用量后决定是否 self-host。

### Q3: plan.md 更新监控具体怎么做？

Subconscious 在每次收到 transcript 时同时收到 plan.md 内容。它可以：

1. 在 `project_context` block 中记住上次看到的 plan.md Current
2. 如果连续多次 transcript 中 plan.md Current 没变但 agent 明显在做新工作 → 在 guidance 中提醒
3. 如果 agent 完成了工作但 plan.md 没更新 → 提醒 "记得更新 plan.md"

这个逻辑完全由 Letta agent 的 prompt 驱动，不需要额外代码。

### Q4: 和现有 agentchat MCP 的关系？

Subconscious 的 hooks 和 agentchat 的 MCP server 是独立的：
- **MCP** 提供 agent 通讯能力（send_message, post, check_inbox）
- **Hooks** 提供观察和注入能力（观察 transcript，注入 guidance）

两者不冲突。agent-up 同时配置 MCP server 和 hooks 即可。

---

## 五、需要修改的文件清单

### claude-subconscious 侧（fork 或 patch）

| 文件 | 改动 |
|------|------|
| `Subconscious.af` | 新增 `workspace_conventions` block，修改 `core_directives` |
| `scripts/send_messages_to_letta.ts` | Stop hook 发送 transcript 时附加 plan.md + agents.md 内容 |
| `scripts/sync_letta_memory.ts` | 检测 guidance 变化时 POST 事件到 agentchat |
| `hooks/hooks.json` | 可能需要调整 hook 命令以支持 AGENT_NAME 环境变量 |
| `scripts/agent_config.ts` | 支持从 agentchat 的 data/agents/ 读取 Letta agent ID |

### agentchat 侧

| 文件 | 改动 |
|------|------|
| `backend-v2.js` | 新增 `POST /api/supervisor/events` 端点接收外部事件 |
| `bin/agent-up` | 新增 Letta agent 初始化 + hooks 配置逻辑 |
| `supervisor/index.js` | 可选：支持混合模式（自有判断 + 外部事件） |

### 新增文件

| 文件 | 用途 |
|------|------|
| `subconscious/Subconscious-agentchat.af` | 定制的 agent 定义（包含 workspace_conventions） |
| `subconscious/setup.js` | Letta agent 初始化脚本（创建 agent、配置 hooks） |

---

## 六、数据流总览

```
Agent Claude Code 会话
  │
  ├─ SessionStart ──→ Letta: 创建 conversation
  │
  ├─ UserPromptSubmit ──→ Letta: 获取 guidance + memory
  │                       ──→ stdout: 注入 Claude context
  │                       ──→ Letta: 早期发送 user prompt
  │
  ├─ Stop ──→ 读 plan.md + agents.md
  │          ──→ 构造 XML（transcript + workspace_state）
  │          ──→ Letta: 发送完整 transcript
  │          ──→ Letta 处理：更新 memory blocks，可能写 guidance
  │
  ├─ 下一个 UserPromptSubmit ──→ 检测 guidance 变化
  │                              ──→ 如果有 [focus:...] 标记 ──→ POST to agentchat
  │                              ──→ 注入 guidance 到 Claude context
  │
  └─ agentchat 审计 UI ──→ 展示事件（来源标记 subconscious）
                          ──→ 和 supervisor 事件并存
```

---

## 七、一句话总结

**用 claude-subconscious 的成熟 hooks 架构和 Letta 持久化记忆替代自研 supervisor 的无状态判断，通过定制 memory block 让 Letta 理解 agentchat 的 plan.md 工作流，通过事件上报让审计 UI 统一展示——本质上是让每个 agent 拥有一个"知道 agentchat 规矩的潜意识"。**
