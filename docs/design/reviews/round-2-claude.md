# Round 2 review — claude

Requested 2026-08-04, after all seven pages were designed. Verbatim.

# Round 2 — 7/10

Up from 6. (One correction to the framing: I gave a single score in round 1, 6/10, not 5 and 6.)

The improvements are real and directly responsive — you took the hard note on the Terminal tab, ran the grep yourself, and reached a better answer than the one I proposed. Seven page bodies and a working Overview is a lot of ground covered in one pass.

It is not an 8 for one structural reason and three factual ones.

---

## The headline: you revised the prose and left the specification

**Lines 1–83 of `dashboard-relayout.md` are new. Lines 85–323 are round 1 verbatim. `dashboard-ux-review.md` is unchanged in its entirety.**

That is not a stylistic complaint. The half you didn't touch is the half an implementer opens. It still contains, word for word, every structural defect from round 1 — and the document now **contradicts itself on four decisions you just made**:

| you now say (line) | the same file still says (line) |
|---|---|
| "The first tab is **Activity**, not Terminal. Round 1 proposed Terminal and was wrong" (20) | "`Terminal` becomes the default instead of `Settings`" (274); change plan step 3: "default to **Terminal**" (282) |
| "**Stop/Remove are exiled** to a separated *Agent actions* block, not placed beside the refresh controls" (23) | Dissolving Internals table: "System Controls (Stop / Remove) → **page header**, beside the agent name" (271) |
| "Round 1 called Projects 'an attribute of an agent'… That was wrong… All of it survives" (41–44) | change plan step 6: "**Fold `/projects` under an agent**; keep a fleet roll-up" (285) — and `dashboard-ux-review.md:42` still asserts "So it is an **attribute of an agent**, not a peer of one" as a finding |
| "Renamed from `POOL`… the axes legible" (48) | change plan step 5: "`POOL` is 63 lines and **its purpose is not evident from the label or the file**" (288) — the claim I showed was false in round 1, since it is stated in lines 3–4 of that file |

Still unfixed in the spec half, all round-1 findings:

- **`active` union, line 117:** `'agent' | 'alerts' | 'queue' | 'tasks' | 'projects' | 'config'`. Still six values for seven pages. It still contains `queue`, a destination your new rail correctly dropped and which never had a route. It still omits the page you just renamed to **Capacity**. It is now inconsistent with your own mockups, not just with the router.
- **Collapse CSS, line 202:** unchanged. Still `.rail .nm,.rail .st{display:none}` at ≤900px — still hides the durations that *are* your ten-second success test, still omits `.tag`, so a 64px strip shows a dot plus an `ACP` chip and no name. The comment above it still reads `/* the terminal needs width more than the rail does */`, for a terminal the design no longer has.
- **"Pinned Fleet nav"** is in your change summary but not in the CSS. Line 199 is still `.rail{position:sticky;top:0;height:100vh;overflow-y:auto}` with Fleet below an unbounded agent list. At five agents no mockup can show the failure.
- **Rail DOM contract, line 181:** still `<span class="pill hot">9</span>` — bare number. The labelled counts ("9 open", "0 groups") that the mockups show, and that I credit below, exist nowhere in the spec.
- **State diagram, line 217:** still `[*] --> NoAgent: GET / (monitor, no ?agent)`. `/` is now the Fleet overview.
- **Tests, lines 313–320:** unchanged. Both impossible ones survive ("rail markup byte-identical" contradicts `aria-current`; the 500-char floor kills a client-hydrated Activity panel). The route-resolution test I asked for — the one that catches exactly the `queue`/`capacity` union bug — is not there.

Round 1 was wrong but internally consistent. This is more useful *and* less implementable. Fixing it is one editing pass, which is why it is item 1 of the path to 9.

---

## Page by page

### / — Fleet overview — **the best new work, with a self-inflicted wound**

Credit where due: this is my top round-1 finding, answered. The four counters are the right four (open alerts, blocked tasks, queued delivery, agents offline), `updated 4s ago` sets freshness, and a triage table finally exists. This alone moves the score.

Still wrong:

1. **All four rows of "Needs attention" say `info`, with four different dot colours — including a red dot labelled `info`.** Your typography section states the rule: *"Semantic colour is never the only signal — every state also carries a word."* The hero table on the hero page breaks it, in the mockup meant to demonstrate it. A red dot next to the word "info" is worse than no severity at all — it is two signals disagreeing.
2. **The table is sorted by age, not severity**, though line 14 says "ranked by severity". 18m → 47m → 1h12m → 1h58m, and the red row is last. The one page whose entire job is ranking does not rank.
3. **The rail highlights `octos-agent`, not `Overview`.** Every other mockup highlights its own destination correctly. On `/` the current page is Overview; the rail says you are on an agent. Your own `aria-current="page"` decision (line 191) is drawn wrong on the new default route.
4. Half the page is "Recent activity", of which two of four rows are `heartbeat OK`. On a triage surface, the second-largest block is healthy-state chatter.

### /agents/:name — Agent detail — **right diagnosis, and the data source still doesn't exist**

You did the thing I asked and went further: the grep, the `tmux=None` check on three of five agents, the `ACP · no pane` pill, the inset notice naming the source. Stop/Remove exiled to a bottom `AGENT ACTIONS` block is exactly right. Credited.

But this is round-1 finding A wearing a new costume. The notice says *"Showing its ACP session stream instead."* **There is no ACP session stream.** `grep -i acp server.js` returns 13 hits, all inside `/api/agents/status` liveness arithmetic (lines 1123–1164). The only content endpoint in the product is `/api/tmux/capture/:session` (server.js:1231); `/api/stream` (219) is the generic dashboard SSE broadcast, not a per-agent session tail. And the mockup's body shows `tool_call list_sessions {}` and `read_stream {"session_id":"9f3b2c1d","limit":200}` — call shapes that appear nowhere in these 38 API routes.

So the default tab of the main per-agent page is fed by an unbuilt, unnamed endpoint — for the majority of agents. Round 1 that was "port the terminal, mis-risked as low." Round 2 it is "invent a stream, not risked at all," because the change plan still describes step 3 as a rename. The problem moved; it did not get solved.

Also unaddressed from round 1: `Work` vs the fleet page named **Tasks**, and `Repos` vs the fleet page named **Projects** — two words for each concept, in a design whose founding complaint is vocabulary collision. And `Oversight` still merges supervisor audit with the agent's own background process. Three of six tab names still cost more than they save.

### /alerts — **preserved well, then contradicted itself**

The five-status strip, three labelled filters, `9 of 9 shown`, occurrence counts and ages, detail panel with transitions and notes — this correctly preserves a page that was already good, and the `OPEN 9` counter finally pins down what the rail's `9 open` means. Round-1 question answered.

Still wrong:

1. **`CRITICAL 0` sits above a list whose top row has a red dot.** Either red means critical and the counter is wrong, or red means nothing.
2. **Four dot colours for three severities.** The codebase has exactly `critical | warning | info` (alerts-page.js:117). The mockup uses red, amber, brown-orange and blue. Blue is also your accent `#1a73e8`, so "info" and "interactive" are the same colour.
3. **List rows carry no severity word** — dot only. Same violation of your own colour rule as Overview, on a second page.
4. **`Suppress` is gone** from the detail actions, though `SUPPRESSED` is one of your five counters and `open → suppressed` is a legal transition in the current code (alerts-page.js:269). You kept the counter and dropped the verb.
5. "Assign to me" implies an operator identity the dashboard does not have — notes are hardcoded `author:'operator'`.

### /tasks — **the best-executed page. No substantive complaint.**

`0 open / 0 total` in the header, `showing 0`, the empty panel that defines what a task *is*, one clear action, and the footnote `Showing open tasks only. Switch Status to 'all' to include done.` That fully closes my round-1 denominator finding, and designing for the real state (empty) rather than a fantasy full state is the correct instinct.

One flaw: the **lifecycle strip draws `created → accepted → in progress → blocked → done` as a linear pipeline**. `blocked` is not stage four of five — it is a side state you enter and leave, which is why `project-board` renders five *parallel* lanes and why the task sort treats it as a peer status. The one place the page teaches the domain model teaches it wrong.

### /projects — **claim correctly withdrawn; mockup is fiction, and it knows it**

Withdrawing the "attribute of an agent" claim is right, and preserving the whole board is right — it reads `/api/project-board`, not `/api/agents/:name/projects`.

But: **the rail says `Projects 0 groups` and the body shows `Group: acme-platform` with 4 members, 17 tasks and 4 repos.** Your own review records the measured state as **0 projects**. So one image contains a truthful counter and an invented body, contradicting each other three inches apart. This matters more than usual because two pages earlier you write that Tasks is *"designed for its real state: empty"* and treat that as a virtue. It is a virtue. Projects got the opposite treatment, and the one screen this page will actually be in — empty, no groups — is the only Projects state not drawn.

The invented data also doesn't add up: lanes hold 2+1+1+2 = **6** open tasks under a counter reading **OPEN TASKS 7**; `WORKTREES 5` sits above a section titled "Repositories and worktrees" whose table has four rows and columns `REPO / BRANCH / STATE` — no worktrees are shown at all.

### /pool → Capacity — **best-improved page, drawn against the wrong data model**

The rename is right, the prose explanation of the axes is right, `idle/total` with a bar is right, the three-item legend is right, and the closing "if nothing reads it, retire it" is intellectually honest. Genuinely good.

Then: **neither axis matches the endpoint.** pool-page.js:42–43 —

```js
const TIERS=['strong','medium','lightweight'];
const ROLES=['architect','coding','testing','review','integration','documentation'];
```

The mockup shows roles `coder / reviewer / researcher / operator` and capabilities `shell / git / web / browser`. **Zero overlap on either axis** — 4×4 where the data is 6×3, and `shell/git/web/browser` are tool capabilities (they appear in round 1's fabricated terminal line "Capabilities: shell, fs, git, web, tasks"), not the capability *tiers* `/api/pool` returns. The page whose stated purpose is *"make the axes legible"* has replaced the real axes with invented ones. Under "no new server work," this cannot be built.

Two more: `—` is legended as **"not supported"**, but the current page renders `—` for an *empty* cell (`if(!list.length)`) — "nobody here" and "impossible here" are different facts. And *"Click a cell to see the agents behind it"* **hides** information the current page shows inline — agent names are in the cells today — on a page whose whole value is at-a-glance dispatch, with the resulting panel undesigned.

### /config — **good structure, and it deletes a capability**

Splitting by blast radius is right. `destructive` on agent lifecycle is right. *"A blank field leaves the existing value unchanged"* is exactly the sentence masked credentials need, and `set 3 days ago` is a nice touch.

But: **there is no Start button.** The lifecycle table offers Stop and Remove on five agents. The reason `config-page.js`'s All Agents table exists is that it is the only surface in the product that lists **offline** agents and can start them — `startAgent()` at line 300, `POST /api/agents/:name/start`, gated on `canStart = !a.online && isLocal && validFw`. `+ New agent` creates a new one; it does not start an existing stopped one. As drawn, this redesign removes the only path to restart a stopped agent.

The round-1 collision is also still unresolved and now invisible: the rail (`/api/agents/status`) and this table (`/api/agents/all`) show the same five names because **0 are down**. The moment one is, they disagree, and the doc still says nothing about which is authoritative. And Stop/Remove now appear on **two** pages — here and agent-detail's actions block — with no statement about whether the confirmations match.

### Cross-page: the rail is not the same rail

Your shipped test asserts *"Rail markup is byte-identical across all 7 pages."* The mockups fail it:

- **Icons on Tasks, Projects, Config. No icons on Overview, agent detail, Alerts, Capacity.**
- Brand reads `5 agents · 0 down` on Overview, `5 agents / 0 down` on the other six.
- Capacity and Config carry no count pill while the other four destinations do (Capacity has an obvious one — idle agents).

---

## What I am not crediting, per your instruction

Loading and error states, the ARIA/keyboard spec, the task-timed benchmark replacing 34/100, and per-page acceptance tests — all still absent, all still needed, none counted above.

On the monitor's surfaces, one clarification since "Overview replaces it" is doing a lot of work: **`+ New agent` is homed** (Config), and the message log is arguably homed (Recent activity). **The queue panel and the reminder panel are not.** Queued delivery appears on Overview as a *counter*, but the panel behind it — `Send now · skip wait`, hover locking, pending-action guards, tombstones, restore-on-failure, the machinery your own Invariants section says must survive — has no page in the seven. Reminders (`/api/reminders`) appear nowhere at all.

---

## Shortest path to 9

Six items. One is mechanical, four are corrections, one is a redraw.

1. **Rewrite lines 85–323 to match lines 1–83.** One editing pass, no new thinking: `active` union → seven values, drop `queue`, add `capacity`; change plan steps 3, 5, 6; the last two rows of the Dissolving Internals table; the state diagram's `/`; the stale `/* terminal */` comment; the rail DOM contract's pill markup; add `.tag` to the collapse rule and stop hiding `.st`; actually pin the Fleet nav. Then fix `dashboard-ux-review.md`'s Projects section, which still asserts the claim this design withdrew. **This is the single highest-value edit available** — until it lands, the document cannot be implemented from, because it specifies two different products.

2. **Name Activity's data source, per transport.** tmux → `/api/tmux/capture/:session` (exists). ACP → name the endpoint; if it does not exist, write "new endpoint required" and add it to the change plan as its own step with honest risk. Redraw the mockup body with call shapes this codebase actually produces.

3. **Fix Capacity's axes** to `strong/medium/lightweight × architect/coding/testing/review/integration/documentation`, or state explicitly that `/api/pool` changes and drop the "no new server work" claim for this page. Keep agent names visible in cells; make the click a drill-down, not a reveal. Re-legend `—` as "none in this cell."

4. **Put Start back in Config**, and add one sentence resolving rail-vs-Config: rail = live from `/api/agents/status`, Config = full registry from `/api/agents/all` including offline and startable. Say which page owns Stop/Remove, or state that both do and share one confirmation.

5. **Make every state carry a word, as your own rule requires.** Real severities in Overview's table (not four rows of `info`), sorted by severity since that is what the heading claims; severity words in Alerts rows; reconcile `CRITICAL 0` with the red dot; restore `Suppress`; drop to three severity colours and stop using accent blue for `info`.

6. **Draw Projects in its real state (empty)** — or keep the full board, fix the arithmetic (6 vs 7; worktrees), and label it *illustrative data* so the rail's honest `0 groups` isn't reading as a bug. While redrawing, make the rail identical across all seven images: icons everywhere or nowhere, one brand string, a count on Capacity.

Items 1–4 get you to 9. Items 5–6 are cheap and make it stick. The remaining point to 10 is the four you already listed plus homing the queue and reminder panels.

**Do not touch:** the Overview counter set, the Tasks empty state and its denominator footnote, the `ACP · no pane` pill and inset notice, the Agent actions block, the Config blast-radius split and blank-means-unchanged, Capacity's retire notice, and the self-hosted-fonts rationale — refusing a CDN because the dashboard must work on a host with no outbound network is the best-argued paragraph in either document.

*(No files were edited.)*
