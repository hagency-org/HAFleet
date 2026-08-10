# HAFleet as a PDU — capability review against the digital-labour model

What HAFleet is, stated as a business function rather than a feature list, and how much of
it the code already does. Written after the review round on
[dashboard-relayout.md](dashboard-relayout.md) kept re-deriving the same boundary from
scratch.

## The definition

**HAFleet is a resource connector: it takes in coding agents wherever they run, classifies
them by capability and role, and offers a scheduling interface to whoever wants to use
them.** By analogy it is a digital-employee outsourcing house — a PDU that deploys staff of
different capabilities against a product need, manages them while deployed, and assesses
them afterwards.

**What it is not.** How to run a project, and how to divide the product process into
phases, is the customer's own business, conducted in Matrix. HAFleet supplies the workforce;
it does not own the project.

That boundary is already enforced in code, which is why it is worth writing down:

| write | guard | owner |
|---|---|---|
| `POST /api/groups`, `/groups/:name/members`, `DELETE /groups/:name` | `requireBridgeSecret` | the customer, via Matrix |
| `PUT/GET/DELETE /api/approval-bindings` | `requireApprovalBridgeSecret` | the customer |
| `POST /api/approvals/:id/verdict`, `/matrix` | `requireApprovalBridgeSecret` | the customer — a human answers in the room |
| agents, tasks, dispatch, pool, alerts, presets, frameworks | agent token / loopback | **HAFleet** |

A project is a Matrix room (`bridge-matrix.js` keeps `roomGroupMap`/`groupRoomMap`, and
`approval-store.js:255` filters bindings on `project || projectRoomId`). HAFleet reads it and
can never author it. HR sourcing — continuously finding better price/performance employees —
is out of scope for this review by request.

## Capability inventory

Status is one of **works**, **built, unconnected** (the machinery exists and nothing drives
it), or **absent**.

### 入职 — connecting a new employee

| capability | where | status |
|---|---|---|
| Five framework adapters, each declaring launch command, transport, guards, permission summary | `lib/frameworks/{claude,codex,codex-acp,hermes,octos}.json` | works |
| Two transports, chosen by the adapter, not by the operator | manifest `transport`, resolved at `backend-v2.js:8177-8182` | works |
| Paneless ACP onboarding: model-flag pre-validation, agent-token provisioning at mode 600, profile registration or detached host, readiness-marker wait with **sustained** health sampling | `bin/hafleet-acp-up`, `docs/agent-onboarding.md` §What onboarding does | works |
| tmux onboarding | `hafleet up` | works |
| One agent, one host — guarded in both directions | `docs/agent-onboarding.md` §One agent, one host | works |
| Remote machines join the same registry; one central backend is the sole data source | `/api/servers`, `/api/servers/fleet`, `POST /api/servers/heartbeat`, agent `server` field | works |
| Credential readiness is reported, never handled — the agent authenticates itself first | per-framework `credentialHome` + `authFix` | works, deliberately |
| Framework detection for the dashboard | `GET /api/frameworks/detect` | **absent** |
| Role/capability at registration | `POST /api/agents` destructures both | **built, unconnected** — no CLI path sends either |
| Competency check at hire time | manifests record a hand-run one (`codex-acp.json` `verifiedEndToEnd`) | **absent** as an automated step |

### 分类 — capability and role

| capability | where | status |
|---|---|---|
| Six roles as columns, three **ordered** capability tiers as rows | `lib/matrix-agent.js:11-14` | works |
| Default tier per role | `ROLE_DEFAULT_TIER` | works |
| Tier → runtime/model | `TIER_RUNTIME` (claude opus / sonnet / haiku) | works |
| Role inference from a legacy agent name | `canonicalRole()` | works, and matches nothing on this fleet |
| Role values validated against `ROLES` | nowhere — `agentRole()` trusts a stored value verbatim | **absent** (see gap 6) |

### 派遣 — deployment

| capability | where | status |
|---|---|---|
| `POST /api/dispatch {role, capability}` → `routed` / `provision` / `queued` | `backend-v2.js:8489-8526` | **built, unconnected** |
| Cheapest-sufficient-first selection, with substitution bounded to one role | `selectAgent()` | built, unconnected |
| Leases: 15-min renewable TTL, release, reaping, `dispatch_lease_expired` alert | `src/dispatch-lease-store.mjs` | built, unconnected |
| Per-cell dispatch queue with tickets | `dispatchQueues` | built, unconnected |
| Auto-provisioning plans under a per-cell cap | `MATRIX_AGENT_MAX_PER_CELL`, default `0` | built, off |
| The lease records **who the work is for**: `owner`, `room`, `taskId`, `ticket`, `role`, `tier`, `task` | `dispatch-lease-store.mjs:96` | works — and the dashboard shows only `owner` |

### 在岗管理 — what each employee is doing, for whom, how far along

| PDU question | primitive | status |
|---|---|---|
| 在干什么 | `agent.task` (structured), ACTIVE/IDLE spans, tmux pane or ACP log | works |
| 给谁干 | lease `owner` + `room` + `taskId` | works in the data, **not surfaced** |
| 干到什么地步 | `TaskDTO` — status, priority, `waiting_reason`, `waiting_until`, `heartbeat_at`, health, comments; plus task graphs | works |
| 健康状态 | heartbeats, `offlineReason`, restart counts, alert lifecycle, supervisor signal | works |
| 利用率 | derivable from lease timestamps and ACTIVE/IDLE spans | **absent** — nothing computes it |
| 成本开支 | — | **absent entirely** (gap 1) |

### 考核 — assessment

| capability | where | status |
|---|---|---|
| Continuous per-agent evaluation: signal, severity, reason, lifecycle, evaluated-at, recommended action | the supervisor | works |
| Decision trail | Supervisor Audit + Audit History (one canonical event collection) | works |
| Crash-loop and prompt-timeout detection, session recycling | ACP host + supervisor | works |
| Per-agent **scorecard** — trend over a period, comparable across the fleet | — | **absent** (gap 4) |

### 培养 — self-evolution: project context and team memory

Not model training. An employee gets better by understanding the project better and by the
team remembering more. HAFleet has more of this than any other PDU function — and it is split
across three memories that do not talk to each other.

| lever | where | status |
|---|---|---|
| **The per-agent evolution loop.** A subconscious observer receives session start, each user prompt, and the full transcript on stop; maintains **memory blocks**; and returns commentary that is injected into the working agent's next prompt | `lib/upstream-claude-subconscious.js` — Letta-backed (`api.letta.com/v1` by default), `sync_letta_memory.ts`, `send_messages_to_letta.ts`, state under `~/.letta/claude` | **works** |
| Subconscious control: desired state, authoritative vs fallback mode, provider/model/endpoint | Runtime subsystem | works |
| Guidance (present / configured / injected) | agent profile | works |
| **A governed team knowledge base** with a real taxonomy — `decisions/` (nine ADRs, `adr-001`…`adr-009`), `requirements/` (four `req-*`), `guidance/` (`g-*`), `standards/canon/`, `proposals/`, `context/` — each type with a template and agent-spec lint | `knowledge/`, 16 accepted artifacts, git-tracked | exists, **served to nobody** |
| Per-workspace durable knowledge | `docs/agent-knowledge.md`, `docs/progress.md` | works, private |
| Skills | skill directories | works |
| Framework preset and model change | presets, `PATCH` | partial — gap 6 |
| **Promotion**: a private lesson becoming team memory | `proposals/` → `decisions/` taxonomy exists; no flow into it | **absent** (gap 5) |
| **Measurement**: did the injected guidance improve anything | — | **absent** (gap 5) |

## Critical gaps

Ordered by how much they block the definition above.

### 1. Cost does not exist, in any form

Searched `lib/`, `src/`, `backend-v2.js` for `price`, `pricing`, `cost`, `budget`, `quota`,
`billing`, `tokensUsed`, `tokenUsage`, `inputTokens`, `totalTokens`, `usage.`: **no hits**
other than an unrelated resource-budget alert string and an activity-capture pagination
variable. `lastObservedRateLimitAt` in `src/health-record.mjs` is the **Matrix bridge's**
429 tracking (`bridge-matrix.js:2013`), not a provider's.

A staffing house that cannot state what an employee costs cannot price a deployment, cannot
compare candidates, and cannot tell a customer what a project consumed. This gap blocks
两个 of the PDU's own functions at once — 按成本派遣 and 成本开支 reporting.

The dependency order matters, and it is usually stated backwards. A price table is the
*easy* part:

1. **capture usage per lease** — tokens where the framework reports them, wall-clock busy
   time where it does not. This is the real work, and it is per-framework: Claude Code,
   Codex and each ACP adapter report differently or not at all.
2. **attach a rate to the tier** — a config table. The opus/sonnet/haiku ladder is already
   the cost model, merely unpriced.
3. **attribute the total to the room** — free. The lease already carries `room`.

#### 1a. Token API and coding plan are different businesses

This is the distinction that decides whether the scheduler is even optimising the right
thing:

| | API key (pay per token) | coding plan (Claude Max, Codex plan …) |
|---|---|---|
| cost shape | variable, per token | fixed per seat, per month |
| the scarce resource | money | **the rate-limit window** |
| marginal cost of one more task | real | ≈ zero, until the window is exhausted — then infinite |
| what to optimise | fewest tokens; route to the cheapest sufficient tier | **seat utilisation**; do not burn the window before the day ends |
| failure mode | the bill grows | the agent is online, healthy, idle — **and refuses to work** |
| what HAFleet must record | usage per lease + a rate table | plan type, window length, consumption in window, reset time |

Two consequences:

- **`selectAgent()`'s cheapest-sufficient-first rule silently assumes API pricing.** On a
  plan, the "cheap" agent is not cheaper — its seat is already paid for. The right question
  is which seat still has headroom in its window. The scheduler has no way to ask that.
- **Plan exhaustion is invisible.** Nothing tracks a provider rate limit, so an exhausted
  agent presents only as prompt timeouts and session recycling — indistinguishable from a
  hung agent. The dispatcher keeps routing work to an employee who cannot take it.

#### 1b. The seat is outside the system, and seats are shared

HAFleet never sees a credential by design: the agent authenticates itself before it joins,
and the secret lives in `~/.claude/`, `~/.codex/`, `~/.hermes/`, `~/.config/octos/`. Correct
for security, and it has an accounting consequence nobody has priced:

**Two `claude` agents on the same host and OS user read the same `~/.claude/` — one login,
one subscription, one rate-limit window.** The pool reports them as two independent `strong`
agents. Capacity is being double-counted at the business level. Unless they are deliberately
separated (different OS user, or a per-agent config-dir override), N same-framework agents on
one host are one seat — and there is no field recording which seat an agent draws on.

### 2. Nothing sets role or capability, so 派遣 never runs

Measured against the real module: all five agents on this fleet return `role=null`,
`indexPool()` skips every record, the grid is `{}`, and with `MATRIX_AGENT_MAX_PER_CELL` at
its default of `0` every `POST /api/dispatch` queues forever. `POST /api/agents` accepts both
fields; `hafleet acp-up`, `hafleet up`, `register-agents` and the ACP host all send neither.

The entire 派遣 subsystem — matrix, selection, leases, tickets, provisioning — is dormant
behind one missing registration field.

### 3. 利用率 is computable and uncomputed

Leases are timestamped and renewable; agents carry ACTIVE/IDLE durations. Busy-time over
available-time, per agent, per role, per room, needs **no new capture** — only aggregation
and a surface. It is the number that makes a digital workforce comparable to a human one, and
the natural headline of a PDU view. On a coding plan it is also the primary cost metric,
since the seat is paid whether or not it is used.

### 4. 考核 is an incident detector, not a performance review

The supervisor already performs continuous dotted-line assessment. But it answers *"does this
agent need intervention right now"* — per-incident, newest-first — and a PDU asks *"is this
employee worth keeping, and is it improving"*. Same data, wrong aggregation: no per-agent
scorecard, no trend, no cross-fleet comparison, no period. This is the cheapest high-value
work in the list; nothing new needs measuring.

### 5. 培养 — the per-agent loop works; team memory does not exist

Read as self-evolution (better project context, better team memory), this is the function
HAFleet has invested in most, and the gap is not the one it first appears to be. **The
per-agent loop is real and running**: the subconscious sees the transcript, keeps memory
blocks, and injects guidance into the next prompt. What is missing is everything *between*
agents.

Three memories, no connections:

| memory | scope | store | maintained by | read by |
|---|---|---|---|---|
| Subconscious memory blocks | one agent, one project | Letta — `api.letta.com/v1` by default, `~/.letta/claude` | the subconscious LLM, from transcripts | injected into that agent's next prompt |
| `knowledge/` — 9 ADRs, 4 requirements, guidance, standards | the repo, i.e. the team | git-tracked markdown | humans and agents by convention | whoever reads the file tree because `CLAUDE.md` told them to |
| `docs/agent-knowledge.md`, `docs/progress.md` | one agent's workspace | markdown | that agent, by instruction | that agent |

Four consequences:

- **Team memory is a convention, not a mechanism.** An agent's entire tool surface is eleven
  MCP tools (`lib/mcp-server-core.js`): `whoami`, `check_inbox`, `send_message`, `post`,
  `check_group`, `list_tasks`, `get_task`, `accept_task`, `comment_task`, `transition_task`,
  `update_task_execution` — messaging, tasks and identity. **Not one of them reaches
  `knowledge/`**, and no code in `lib/`, `src/` or `backend-v2.js` references that directory
  at all. Sixteen accepted artifacts, nine of them ADRs, are read only because an entry
  file instructs it. A remote agent, whose host may not even hold the repo tree, has no path
  to them whatsoever. 入职 does not include *"read the team's accepted decisions"*, and nothing
  measures whether an agent ever did.
- **No cross-agent propagation.** When one agent learns that hermes crash-loops without a
  provider, the lesson lands in its private memory blocks. The next agent rediscovers it.
  There is no write path from a private observation into `knowledge/` — even though
  `proposals/` → `decisions/` with templates and lint is *exactly* a promotion pipeline. The
  taxonomy exists; the flow into it does not.
- **The accumulated asset is not owned.** If the product is employees that get better, the
  improvement currently accrues to Letta memory blocks keyed to agent+project in an external
  service. `DELETE ?force=true` or a move to another host orphans it. What a staffing house
  sells is precisely this asset, and it is neither portable nor inspectable.
- **The loop is open at the far end.** Guidance is injected; nothing measures whether it
  helped. Without that, 培养 cannot be reported on, priced, or improved.

One deployment note that belongs with an enterprise conversation rather than in the gap list:
the subconscious sends **full session transcripts** to its configured endpoint, and that
endpoint defaults to `https://api.letta.com/v1`. The base URL is configurable, so self-hosting
is possible — but a product whose README says *"nothing needs to leave the machine"* ships a
memory subsystem whose default is a third-party SaaS. That is a default to change before a
customer asks.

### 6. The employee is not portable, and the tier cannot be changed

If an employee accumulates capability and a track record, the durable asset is **guidance +
knowledge + performance history**, and it must outlive any host, framework or model. The code
half-agrees already: the default `DELETE /api/agents/:name` is a soft unregister that keeps
the record, with an explicit `POST /api/agents/:name/undelete`; only `?force=true` purges.

But `PATCH /api/agents/:name` destructures `role` and **not** `capability`. An existing
employee can be given a job title but can only ever sit at that role's default tier; moving
one to a cheaper or stronger model means re-registering — which loses the employee. Swapping
the model under a profile is the core move of both 培养 and any future price/performance
substitution, and today it is impossible.

Related: `agentRole()` returns `agent.role || canonicalRole(name)` and **nothing validates the
value against `ROLES`**. `data/agents.json` in this checkout holds three agents at
`role: "worker"` — a seventh column with no grid, no default tier, and no page, which
`indexPool()` will nonetheless create and `resolveTier()` will silently staff at `medium`.

### 7. No multi-tenancy

There is no tenant, customer, or account dimension on an agent — only `environment`
(`live`/`dev`/`benchmark`/`ephemeral`), which is a lifecycle marker, not isolation. An
outsourcing house serving several customers has no way to partition its workforce, its costs,
or its dashboards between them. Matrix federates messages, not capacity, so cross-fleet
pooling has no protocol either.

## What the console should therefore show

The dashboard is the staffing house's internal view; the customer's view is Matrix. Its unit
is the agent-as-employee, and its table is a workforce roster, not a scheduler dump:

```
agent          role · tier      state   working for       on        since  util(7d)  cost
octos-agent    coding · medium  BUSY    #proj-api-prd     tk_0044   11m    68%       —
codex-agent    coding · medium  IDLE    —                 —         1h18m  31%       —
hermes-agent   testing · medium BUSY    #proj-api-test    tk_0049   2m     54%       —
```

Every column except `cost` is derivable from data that exists today. `cost` renders as `—`
with its reason, the way the Capacity page already handles the empty grid.

## Sequence

1. **Role/capability at registration** (gap 2) — unblocks 派遣, and everything downstream
   assumes it. Also fix `PATCH` to accept `capability` (gap 6) and validate against `ROLES`.
2. **Utilisation** (gap 3) — no new capture, immediate PDU value, and the correct cost proxy
   for plan-based employees.
3. **Usage capture** (gap 1, step 1) — per-framework, the prerequisite for cost *and* for any
   future price/performance comparison. Record the plan type and seat identity at the same
   time (gap 1b), because they cost nothing to capture at 入职 and cannot be reconstructed
   later.
4. **Scorecard** (gap 4) — reshape supervisor data into a per-agent performance record.
5. **Serve `knowledge/`** (gap 5) — the cheapest half of 培养. An MCP tool over the accepted
   artifacts turns team memory from a filesystem convention into something every agent
   receives, including remote ones, and makes *"read the team's decisions"* part of 入职. The
   subconscious already injects at session start, which is where accepted decisions should
   arrive.
6. **Promotion path** (gap 5) — a write path from a private observation into
   `knowledge/proposals/`, reviewed into `decisions/`. This is what turns one agent's lesson
   into the team's, and it is the difference between a fleet that learns and five agents that
   each learn alone.
7. **Close the loop** (gap 5) — measure whether injected guidance changed subsequent
   performance. Needs the scorecard first, which is why it is last.

Deliberately not scheduled: multi-tenancy (gap 7) until a second customer exists, and HR
sourcing until usage capture makes candidates comparable.
