# Round 1 review — claude

Requested 2026-08-04. Verbatim.

# Hostile review — dashboard relayout

**Score: 6/10.** The diagnosis is better than the design. The shell/rail module boundary is genuinely right and the IA-property tests are the best idea in either document. But the hero interaction in your own mockup does not exist in the codebase, the rail links to a route with no handler, and one page silently loses its only entry point in step 1 while the decision about it is deferred to step 5.

You asked me to check whether the undesigned bodies are the worst gap. They are not. Read finding A first.

---

## A. The Terminal tab does not exist, and step 3 is mis-risked

`grep -c terminal lib/dashboard/render/agent-detail-page.js` → **0**.

Agent detail's six panels are settings / tasks / dm / supervisor / subconscious / internals (lines 599–732). There is no terminal on that page and never has been. The terminal is monitor-only: `#terminal-wrap` / `#terminal` at monitor-page.js:626, fed by `fetchTerminal()` at 1681 — `GET /api/tmux/capture/<tmux target>`, with `If-None-Match`, `terminalFetchSeq` request sequencing, an in-flight set keyed by agent name, `wasAtBottom` scroll preservation, and the speed/pause/bottom controls at 619–622.

Your change plan says:

> | 3 | Rename tabs; default to Terminal; add `role="tab"` | `agent-detail-page.js` | **low — labels, hash values, ARIA** |

That is not a rename. It is porting the entire terminal apparatus into a second page — and it is precisely the machinery your companion review lists under *Load-bearing machinery* and your own *Invariants* section ("Terminal poll machinery — ETag reuse, request sequencing, visibility-aware rates, auto-scroll preservation, explicit Bottom"). You have a step labelled low-risk whose actual content is the thing you elsewhere warn must not be touched carelessly. Step 3 is the highest-risk step in the plan and is ranked lowest.

**And the mockup's hero state cannot exist.** The rail shows `octos-agent` tagged **ACP**, with Terminal as the active tab full of log lines. server.js:1117 is explicit: *"An ACP agent has no pane by design, so 'no tmux target' is not a fault for it."* ACP agents have no `tmux` field. `fetchTerminal()` has no guard for that — `encodeURIComponent(targetAgent.tmux)` with `tmux` undefined requests `/api/tmux/capture/undefined`. Three of the five agents in your mockup are tagged ACP. You are proposing to make Terminal the **default** tab for every agent, including the majority that have no pane, and the design never mentions the paneless state.

---

## B. Page by page

### 1. monitor-page.js (1,950 lines) — **not designed, and its fate is unstated**

*Does the design say what it becomes?* **No.** The only things said about the monitor are that it donates `runtimeStatusText()` / `fmtSpanSec()` / the duration tick to `SHELL_SCRIPT`, and one line in the state diagram: `[*] --> NoAgent: GET / (monitor, no ?agent)`.

*What would an operator come here for?* Everything they currently do. Five live surfaces: `#queue-panel` (pending queue, `/api/queue`, with the hover-locking and tombstone machinery you flag as load-bearing), `#reminder-panel` (`/api/reminders`), `#agent-info` (including `ai-down-btn` / `ai-delete-btn`), `#msglog`, and the new-agent modal (`/api/agents/create` + `/start`). None appear in the design or the mockup.

*What's wrong:* if agent detail gains Terminal, the monitor and the detail page answer the same question two ways, and the rail links only to `/agents/:name` — so the monitor becomes an orphan you keep paying 1,950 lines for. If the monitor survives as the terminal surface, then the mockup is a picture of the wrong page. You cannot have both, and the design picks neither. This is a bigger hole than all five undesigned bodies combined, because it is the page the operator actually lives on.

Also: **Stop/Remove already exist in two places.** monitor-page.js:1567/1569 renders them into `#agent-info`; agent detail has its own copy under Settings → System Controls. Your table moves *detail's* copy to the page header and says nothing about monitor's. That leaves the same irreversible action in two different placements with two different confirmation paths.

### 2. agent-detail-page.js (3,473 lines) — **designed, and the design is the good part**

*Does the design say what it becomes?* Yes, in the most detail. The `Internals` measurement (140,230 of 169,000 chars, 43 element IDs, 31 `getElementById` bindings, 0 depending on the `tab-internals` ancestor) is the strongest work in either document — it converts "scary 140 KB refactor" into "re-parent `<section>` nodes" with evidence. Step 4 being its own PR is correct.

*What's wrong:* the tab rename table has no source row for **Terminal**. Every other tab traces to existing panels; Terminal traces to nothing, which is how it got mis-risked in step 3. Separately, "Tab count stays at six" is presented as a virtue — but you are deleting nothing and adding Terminal, so six is arithmetic that only works because `Subconscious` was folded into `Oversight`. Say that, rather than implying the structure was conserved.

### 3. alerts-page.js (333 lines) — **not designed, and it is already better than the page you scored**

*Does the design say what it becomes?* **No.** It appears once, as a rail pill reading `9`.

*What would an operator come for?* Triage, and the page already supports it: stats bar (open / assigned / suppressed / crit / warn), three filters (status, severity, agent), a severity-dotted list with occurrence counts and relative times, and a detail panel that computes **legal transitions** from current status (line 269) plus notes. It has two `<h2>`-class headings, SSE live updates on four alert events, and in-flight/queued guards.

*What's wrong:* nothing structural — which is itself a finding. Scoring the dashboard's Information Architecture **10/100** while this page exists means you measured the monitor and generalised. What Alerts actually needs from the relayout is one sentence: **which number is the rail pill?** The page's own stats bar computes `open + acknowledged + assigned`; `/api/alerts/stats` also exposes `total` and per-severity. A pill showing `9` that disagrees with the stats bar the operator sees on arrival is worse than no pill.

### 4. tasks-page.js (374 lines) — **not designed**

*Does the design say what it becomes?* No — a rail pill reading `0`.

*What would an operator come for?* The fleet work list, and it delivers: a real `<table>` with status/priority badges, assignee+status filters that round-trip through the URL, create form, detail panel with status transitions, comments, delete, per-action in-flight keys (`taskActionKey`), and a sensible default sort (in_progress → accepted → blocked → created → done, then priority).

*What's wrong:* the design renames the per-agent tab to **Work** while this page stays **Tasks**, for the same objects from the same `/api/tasks` endpoint. Your companion review's central complaint is a name collision between `TASK_STATUSES` and `AGENT_TASK_STATUSES` — and the fix introduces a *third* name for the same concept. Also undefined: does rail `Tasks 0` mean 0 open or 0 ever? The page fetches `limit=200` with no status filter, so `done` tasks are included; a count whose denominator is unstated is worse than no count.

### 5. projects-page.js (451 lines) — **not designed, and step 6 underestimates it by an order of magnitude**

*Does the design say what it becomes?* Only "Fold `/projects` under an agent; keep a fleet roll-up. risk: moderate."

*What would an operator come for?* This is not a list of an agent's repos. It is an eight-section operations board: 8-metric header, group members, repositories & worktrees (with dirty state and branch/head), specs & issues (local + remote), a five-lane task board, workflow dependency graphs, change requests with CI check counts, and public activity. It reads `/api/project-board`, not `/api/agents/:name/projects`.

*What's wrong:* the review's claim that Projects "is an attribute of an agent, not a peer of one" is true of `/api/agents/:name/projects` and false of this page. Folding it under an agent discards seven of eight sections. "Keep a fleet roll-up" is doing enormous unspecified work — say which sections survive. Note also this is the **most accessible page in the codebase** (4 `aria-*`, `role="alert"`, `aria-current="page"`, `<section>` landmarks), which the 12/100 accessibility score does not reflect.

### 6. config-page.js (338 lines) — **not designed, and it collides with the rail**

*Does the design say what it becomes?* No — a rail link with no count.

*What would an operator come for?* Two things: framework presets, and — critically — the **All Agents** table (`/api/agents/all`), the only place in the product that lists *offline* agents and offers **Start** and **Delete**.

*What's wrong:* the rail lists agents from `/api/agents/status`; Config lists agents from `/api/agents/all`. Two agent lists, different membership, on the same screen, with no stated relationship. Worse, the mockup's brand block reads **"5 agents / 0 down"** — a fleet-health claim rendered from an endpoint that reports on running agents, sitting permanently above the page whose job is the agents that *aren't* running. Decide which list is authoritative and label both.

### 7. pool-page.js (63 lines) — **the design proposes retiring it on a false premise**

*Does the design say what it becomes?* Step 5: *"Retire POOL or rename it to what it holds — needs a decision on intent: POOL is 63 lines and **its purpose is not evident from the label or the file**."*

Lines 3–4 of that file:

```js
// matrix-Agent pool view (Phase 7): the live role × capability grid — who's idle/busy per cell.
// Reads GET /api/pool; "按能力调度" at a glance.
```

The purpose is stated in the first two lines of the file, in the sentence that says it isn't. It is a scheduling view: three capability tiers × six roles, cells showing which agents are idle vs busy. Whether you still want that concept is a real product question. Whether the file explains itself is not.

**The concrete regression:** the rail has no Pool entry (mockup), and `renderShell`'s `active` union is `'agent' | 'alerts' | 'queue' | 'tasks' | 'projects' | 'config'` — **six values for seven pages, and `pool` is the missing one**. Meanwhile step 1 wraps all 7 routes. So after step 1, `/pool` renders inside a shell that cannot highlight it, from a rail that cannot reach it. Today its only link in the entire dashboard is projects-page.js:148 (`<a href="/pool">Pool</a>`) — and that nav bar is exactly what the rail replaces. **Step 1 deletes Pool's discoverability; step 5 is where you planned to decide whether to.** The regression ships four steps before the decision.

---

## C. Fatal or acceptable? — the five undesigned bodies

**Acceptable, and deliberately so — with one exception that is fatal.**

Not designing the bodies is the right call for Alerts, Tasks, Config and Projects. Your shell contract earns that: `renderShell` takes `head`/`body`/`script` opaquely and "never touches a page's CSS or JS," so each page can be relaid out later without the shell changing. Bodies are genuinely orthogonal. Designing five page bodies before proving the shell works would be the larger mistake.

The exception is **Pool**, where "undesigned" is not neutral — it is a live regression (finding B7).

What each minimally needs — one decision, not a redesign:

| page | minimum |
|---|---|
| **Alerts** | Define the rail pill: which of open / open+ack+assigned / total. Must match the page's own stats bar. |
| **Tasks** | Define the count's denominator (open, not all — `done` is currently included). State the rail→page link: `Tasks` → `/tasks`, and per-agent → `/tasks?assignee=NAME` (the filter already round-trips through the URL, so this is free). |
| **Projects** | Name which of the eight sections survive as the "fleet roll-up." Without that, step 6 is unreviewable. |
| **Pool** | A yes/no on role×capability scheduling. If yes: a rail slot and a seventh value in the `active` union. If no: delete the route in step 1, not step 5. Either way, correct the claim about the file. |
| **Config** | One sentence resolving the two agent lists: rail = live/running, Config = full registry including offline and startable. Put that sentence on the page. |

Every page also needs its **in-page nav bar deleted** when the rail arrives — Alerts, Tasks, Projects, Config and Pool each render their own header links. Five duplicate navigations is not in the change plan.

---

## D. The six things you asked me to challenge

**1. Is a left rail right, or cargo-culted?** Both, depending on a fleet size you never state. The rail's premise — agents are the only thing an operator operates, and their state must never leave the screen — is sound. But at the **measured** fleet of five, you are spending 242 of ~1,400px (17%) permanently on five items, in front of a terminal, which is the most width-hungry and height-tolerant widget in UI. A horizontal agent strip costs ~40px of height and zero width and would dominate at n=5. The rail wins at n≈20+. **State the fleet size you are designing for.** Right now the design optimises for a scale the evidence doesn't show, which is the definition of cargo-culting even when the destination is correct.

**2. 242px fixed, collapsing to 64px at 900px — right call?** The width is fine and undefended (no name-length derivation; `codex-acp-agent` is 15 chars ≈ 108px at 12px SF Mono, so 242 works — say so). The **collapse is wrong**, three ways:

- It hides exactly what justifies the rail. `@media(max-width:900px){ .rail .nm,.rail .st{display:none} }` — `.st` is `ACTIVE 2m14s`. Your success test is *"give an operator ten seconds and ask which agents are active and for how long."* At ≤900px the design deletes the answer and keeps a dot.
- **It's a bug as written.** `.tag` (the `ACP`/`TMUX` chip) is not in that rule. At 64px you get a dot and a 3-letter chip and no name.
- Viewport-triggered. The stated reason is "the terminal needs width more than the rail does" — that's a *task* judgement, not a screen-size one. Make it a user toggle persisted in `localStorage`, and it works at any width.

There is also a structural error the CSS makes plain: `.rail{height:100vh;overflow-y:auto}` with the **Fleet** nav *below* an unbounded agent list. At 25 agents, Alerts/Tasks/Projects/Config scroll off. Navigation must not live below a list that grows. Pin Fleet to the bottom; scroll only `#rail-agents`. Also add `overflow:hidden;text-overflow:ellipsis;white-space:nowrap` to `.nm` — projects-page.js does this on every name field; the rail spec does not.

**3. Six tabs: Terminal/Work/Messages/Repos/Oversight/Configuration vs Settings/Tasks/DM/Supervisor/Subconscious/Internals.** Net better — 4 improved, 2 regressions.

- Clear wins: `Internals` → gone, `Subconscious` → gone, `DM` → `Messages`, `Settings` → `Configuration`. `Internals` is named after nothing an operator wants; that diagnosis is correct and the fix is correct.
- **`Tasks` → `Work` is a regression.** `Tasks` is the domain noun: `/api/tasks`, `TASK_STATUSES`, and the fleet page is called Tasks. Renaming the per-agent view to Work breaks the vocabulary link in a design whose thesis is that vocabulary broke.
- **`Repos` is a regression for the same reason** — the fleet page for the identical concept stays `Projects`. Pick one word. (`Projects` is the better one; it's the API's word.)
- **`Oversight` merges two unrelated mechanisms.** Supervisor = external human/audit oversight. Subconscious = the agent's own background process. They share a tab because both were small, not because they're the same thing. That is exactly the "the tab bar promises a structure the content does not follow" failure you diagnosed, reintroduced.

**4. `Tasks 0` / `Projects 0` rather than hiding.** **Right call**, and your evidence supports it — the reason nobody knew those pages were empty is that emptiness was invisible until you clicked. Keep it. Two conditions: (a) the denominator must be stated (finding B4), and (b) the fleet-level `0` must not visually contradict a non-empty per-agent Work tab. Same word, two scopes, one screen.

**5. Stop/Remove into the page header.** **Reject.** This is the one change I would not ship. These are the only irreversible actions in the product — `DELETE /api/agents/:name?force=true`, confirmed with "This cannot be undone." Your companion review's own *Load-bearing machinery* section says: *"Stop vs Remove separation and its confirmations, including the irreversible wording"* — do not simplify away. Moving them into a **persistent** header, adjacent to the agent name, present on all six tabs, beside the Refresh/Pause controls the operator clicks constantly, maximises misclick exposure in the one region the pointer always visits. Their current burial under Settings → System Controls is friction that is *doing work*.

Note your own mockup renders the header with only `Refresh: 10/sec` and `Pause display` — it does not illustrate the change it proposes. If you keep any of it: header-mount **Stop** (reversible, and there's a real case for reaching it fast) and leave **Remove** in Configuration.

**6. Is 34/100 defensible, or theatre?** **The findings are solid; the number is theatre.** Four reasons:

- **Unweighted.** Seven dimensions averaged flat, so `Consistency/maintainability 18` (dead-CSS counting) pulls the headline as hard as `Answers what needs attention 15`. Your own *What not to fix first* section then argues maintainability must **not** lead. The score contradicts the document's own priority ordering.
- **Grep as metric.** `Accessibility 12` is `aria-*` and `role=` occurrence counts across "86 KB" — that's monitor-page.js (92,948 bytes) presented as a dashboard-wide figure. Measured across all seven: monitor has 0 `<h1>`–`<h4>`, but **five of seven pages have one**, projects has 4 `aria-*` + `role="alert"` + `aria-current`, and four pages use real `<table>`. No keyboard-trap test, no contrast check, no screen-reader pass. Counting attributes is a proxy for accessibility the way counting comments is a proxy for documentation.
- **Monitor findings generalised to the dashboard.** `Information architecture 10` while alerts-page.js ships filters + legal-transition detail + SSE, and tasks-page.js ships a sorted filterable table with URL round-tripping.
- **It scores a version that no longer exists.** The document says agent state "required a click *until `renderAgentButtons` changed*", and marks items 2 and 3 fixed. A denominator that moves during scoring isn't a measurement.

Directionally right, numerically decorative. Keep every finding. Either weight the dimensions and re-score against a pinned commit, or drop the number and lead with the success test — which is excellent and is the only part of that document an operator could verify in ten seconds.

---

## E. Two of your eight tests cannot pass

Otherwise the IA-assertion idea is the best thing in either document — asserting IA properties rather than behaviour is exactly right, because IA is what regressed.

- **"Rail markup is byte-identical across all 7 pages"** — fails by construction. Your own DOM contract puts `aria-current="page"` on the active item and highlights the active agent. The rail *must* differ per page. Assert instead: identical after stripping `aria-current` and the active class, and identical destination list and order.
- **"No tab panel is under 500 chars, and none exceeds 60% of the page"** — Terminal is a container filled client-side from `/api/tmux/capture`, so its server-rendered template is a near-empty `<div>` and it fails the 500-char floor on day one; meanwhile the whole point of the page is that the terminal dominates, so 60% is the wrong ceiling for it. Measure *hydrated* panels, or exempt live-content panels explicitly.

Add one test the list is missing: **every rail destination resolves to a registered route.** That single assertion catches the `/queue` invention and the `/pool` orphan, which are the two hardest defects in this design and both of which a route-table diff finds in milliseconds.

---

## F. Remedy — what would make it a 10

Ordered by what unblocks the most.

1. **Re-scope step 3.** "Add a Terminal tab" is a port of `fetchTerminal()` and its controls into a page that has never had one. Own PR, moderate risk, after step 4. Spec it: `/api/tmux/capture/:target`, ETag reuse, `terminalFetchSeq` sequencing, in-flight set, `wasAtBottom` preservation, speed/pause/bottom controls.
2. **Design the paneless state.** ACP agents have no `tmux` field and `fetchTerminal()` has no guard (`/api/tmux/capture/undefined`). Terminal cannot be the universal default. Either default per-transport, or specify the empty state — and fix the mockup, which shows an ACP agent with a full pane.
3. **Decide the monitor's fate in one paragraph.** Terminal surface, or triage home, or retired. Then say where `#queue-panel`, `#reminder-panel`, `#agent-info`, `#msglog` and the new-agent modal live. This is the largest hole in the design.
4. **Remove `Queue` from the rail, or add a `/queue` route.** There are seven `app.get` handlers and none is `/queue`; it is a panel inside the monitor. The rail as drawn links to a 404.
5. **Give Pool a rail slot and a seventh value in the `active` union — or delete the route in step 1.** Not step 5. And strike the claim that its purpose isn't evident from the file; it's in lines 3–4.
6. **Specify count sourcing.** The sequence diagram shows only `/api/agents/status`, but the rail renders four counts needing `/api/alerts/stats`, `/api/queue`, `/api/tasks`, `/api/project-board`. Say which, at what cadence, with what denominators, and how they dedupe against monitor's existing polls of `/api/alerts/stats` (line 1992) and `/api/queue` (1964). "No new server work" is true; "no new client work" is not, and it's ×4 on every page.
7. **Add the five one-line body decisions** from section C, plus: delete each page's in-page nav bar when the rail lands.
8. **Fix the collapse.** Add `.tag` to the hidden set (or drop it); stop hiding `.st`, which is the rail's whole justification; make collapse a persisted user toggle rather than a viewport rule.
9. **Fix the rail's vertical structure.** Pin the Fleet section; scroll only `#rail-agents`; ellipsis on `.nm`.
10. **Keep `Remove` out of the header.** Stop only, if anything. Update the mockup to actually show whatever you decide.
11. **Rename `Work` → `Tasks` and `Repos` → `Projects`; split `Oversight`** into supervision and the agent's background process, or find a word that honestly covers both.
12. **Fix the two broken tests, add the route-resolution test, and re-score with weights** against a pinned commit — or drop 34/100 and lead with the ten-second success test.

Do 1–6 and it's an 8: correct, complete, honestly risked. Add 7–12 and it's a 10.

**What is already right and should not be touched:** the shell's opaque `head`/`body`/`script` contract; `<a href>` over `<button>`; the `Internals` measurement and step 4's isolation; counts-always-rendered; the invariants list; and the ten-second success test.

*(No files were edited.)*
