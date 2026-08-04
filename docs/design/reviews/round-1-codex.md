# Round 1 review — codex

Requested 2026-08-04. Verbatim.

Hostile review: 5/10. The rail is a plausible navigation primitive, but this is two page designs presented as a seven-page relayout. Five bodies are unspecified, and even the route model is internally inconsistent.

PAGE BY PAGE

1. Monitor (/)
Does the design say what it becomes? No. The mockup is actually an agent Terminal page, not the fleet monitor. The state diagram retains “NoAgent: GET /” but never designs its content. Existing monitor functions—queue, reminders, message log, new-agent flow, agent summary, and terminal selection—simply disappear from the design (current monitor-page.js:564–647).
Operator question: “What needs attention across the fleet, and what just happened?”
Missing: a fleet triage body, alert/queue/reminder summary, recent activity, empty/loading/error states, and a decision whether / redirects or remains useful. Minimum: an Overview body ranking open alerts, blocked tasks, queued delivery, offline agents, reminders, and recent outcomes; never default to a blank “no agent.”
Fatal? Yes. This is the primary route and the root problem the relayout claims to solve.

2. Agent detail (/agents/:name)
This is the only substantially designed body. Operator question: “What is this agent doing, is it healthy, and how do I intervene?”
The new labels are mostly better: Terminal/Work/Messages/Repos are operator nouns. Oversight is still a junk drawer: combining supervisor state, audit history, subconscious configuration/runtime, and LLM controls repeats Internals under a nicer name. Configuration still combines identity, guidance, presets, roles, migration, ownership. “Six balanced tabs” is a size test, not a coherent task model.
Terminal default is sensible only if every transport supplies useful terminal/output; specify ACP/no-tmux empty state. Work must be explicitly agent-scoped and link to the fleet task record. Repos must distinguish repo, managed copy, worktree, and project group.
Moving Stop/Remove beside the name is wrong: it puts rare destructive controls beside frequent navigation and refresh controls. Confirmations help after a slip, not before it. Put them in a clearly separated “Agent actions” overflow/admin block; keep status near the name.
Also, adding role=tab alone is fake accessibility: require tablist, aria-selected, aria-controls, roving tabindex/arrow keys, and hash/back behavior.

3. Alerts
Body undesigned; only a rail link/count exists. Operator question: “Which incidents are actionable now, why, who owns them, and what changed?”
Current page already has status/severity/agent filters, list/detail, transitions, assignment, notes and delete (alerts-page.js:66–89, 232–317). Minimum design must preserve those, put open/highest severity first, keep filter/selection in URL, show age/occurrence/owner, provide visible action feedback, and define responsive list-detail behavior. Rail count must define “open” vs all alerts and severity, or “9” is ambiguous.
Fatal for implementation approval because Alerts is the promised answer to “needs attention.”

4. Tasks
Body undesigned. Operator question: “What is blocked/overdue/unowned, and what should move next?”
Current page is a fleet table with assignee/status filtering, creation, lifecycle edits and comments (tasks-page.js:65–85, 205–260). Minimum: blocked-first fleet view, explicit lifecycle terminology, assignee/project filters, waiting reason/until, task deep links, create/edit/comment feedback. Define how global Tasks relates to agent Work; two independent implementations of the same record are a drift trap. Showing Tasks 0 is correct—do not hide valid empty destinations—but the zero must count a defined scope (open or total) and the empty page must explain how to create one.

5. Projects
Body not merely undesigned; the premise is wrong. The review calls Projects an agent attribute, but the current page is a project-group rollup spanning explicit group members, repos/worktrees, artifacts/issues, task lanes, graphs, change requests, and public activity (projects-page.js:145–189, 257–417). That is fleet/project scope, not reducible to an agent’s Repos tab.
Operator question: “What is the state of this coordinated project across agents and repositories?”
Minimum: retain project-group selector, binding/health, members, repos/worktrees, blocked task board, changes and activity; agent Repos should be a linked per-agent lens, not a replacement. “Projects 0” is useful only if it counts project groups and says so.

6. Pool
Completely missing. Worse, shell.js active values list queue but not pool, while the claimed seven renderers include pool; the rail mockup has Queue but no Pool. There is no queue renderer/page in the module graph. That is a concrete route-contract defect.
Operator question: “Which role/capability has available capacity for dispatch?”
Current pool is a role × capability idle/busy grid (pool-page.js:3–55). Decide product intent before wrapping it. Minimum if kept: rename to Capacity or Capabilities, explain axes/status/freshness, show empty/error states, and link cells to agents. If nobody makes dispatch decisions from it, retire it explicitly. Do not silently swap it for Queue.

7. Config
Body undesigned. Operator question: “What fleet-wide policy/runtime defaults exist, and what dangerous administrative change am I making?”
Current Config mixes agent start/delete with framework presets and credentials (config-page.js:47–88, 230–328). Minimum: separate Agent lifecycle from Framework presets/providers, label global vs per-agent scope, mask secrets and define whether blank means retain/clear, confirm deletes, show durable success/failure, and prevent the rail’s agent links from implying Config owns ordinary agent work. This needs stronger hierarchy than “drop existing body into main.”

CHALLENGED DECISIONS

Left rail: justified on desktop because agents are a persistent cross-page axis and real links improve navigation. Not justified as specified for scale. One 100vh scrolling rail lets a long agent list push Fleet destinations below the fold. Pin Fleet nav and independently scroll/collapse Agents; provide search after a threshold.

242px: plausible, not evidenced. Specify min main width and test real longest names/locales. At 900px, 64px glyph-only is the wrong collapse: CSS hides .nm and .st, so “fleet state survives” is false; indistinguishable dots survive. Use a drawer/compact selected-agent control or keep truncated names plus accessible labels/tooltips. Below 640px, stacking every agent before content is disastrous with a large fleet; use a disclosure/drawer.

Empty counts: keep zeros. Hiding empties creates uncertainty. But label count semantics and use subdued zeros; do not equate destination existence with body usefulness.

34/100: theatre, not a defensible score. Evidence is useful; arithmetic is not. No weights, rubric anchors, evaluator protocol, or consistent scope exist, so 15 vs 12 vs 20 is false precision. Call it a heuristic baseline or define weighted criteria and repeatable operator tasks.

WHAT MAKES THIS A 10

1. Design the / fleet Overview and all five omitted bodies with loading/empty/error/action states.
2. Reconcile the route inventory: monitor, agents, alerts, queue, tasks, projects, pool, config; decide Queue vs Pool and update shell active values/module graph.
3. Define scope/count semantics and cross-links: fleet Tasks ↔ agent Work; project groups ↔ agent Repos; Alerts ↔ affected agent/task.
4. Replace breakpoint guesses with layouts tested at fleet sizes 1/5/20/100 and widths 375/640/900/1440; keep names/status accessible.
5. Split rail into pinned fleet navigation plus searchable/scrollable agent region.
6. Produce a content map for Oversight and Configuration; separate monitoring facts from mutable controls.
7. Move Stop/Remove out of the primary header control cluster.
8. Specify full keyboard/ARIA behavior, focus restoration, live action notices, URL/history behavior, and no-tmux/ACP states.
9. Add page-specific acceptance tests, not only shell byte identity and character-count heuristics.
10. Replace 34/100 with a reproducible task-based benchmark: time/error rate for finding an alert, blocked task, idle agent, project state, and config action.

Until 1–3 are done, this is not ready to implement as a seven-page relayout.
