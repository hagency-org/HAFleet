# Dashboard refactor — two lines of report

Status: **built**. Phases 0–6 are implemented in `mockup/`; 167 static + 43 in-browser
assertions pass and `docs/design/shots/` is regenerated from the running app. What the
phases actually cost, and the four defects that only a screenshot caught, are recorded in
§8. Supersedes the navigation decision in
[`dashboard-relayout.md`](dashboard-relayout.md); everything that document says about
individual pages still stands.

The current console is organised around HAFleet's six functions — 接入 · 分类 · 派遣 ·
在岗管理 · 考核 · 培养 — one rail entry each. That was right about *what the product does*
and wrong about *how anyone arrives*. Two reviewers have now said the same thing from
different directions: the reviewer who called the organisation 乱, and the PDT/PDU framing
that prompted this document.

---

## 1. Diagnosis

### 1.1 The console mirrors a seam in the backend instead of closing it

HAFleet has two subsystems that never join.

| | **solid line** — delivery | **dotted line** — resource |
|---|---|---|
| record | a group (`data/groups.json`), bound to a project by a workflow binding | a pool record: agent + `role` + `capability` |
| written by | the Matrix bridge — `requireBridgeSecret` on every mutation (`backend-v2.js:10399,10434,10489`) | HAFleet registration — `POST /api/agents` |
| owner | the customer | the house |
| read via | `GET /api/project-board` | `GET /api/pool` |
| knows | members, worktrees, repositories, specs, local + remote issues, change requests, five task lanes, activity, a 15-field summary (`lib/project-board.js:462-545`) | role × tier cells, leases, per-cell dispatch queues |
| does **not** know | role, tier, lease, seat, cost, performance | project, group, room, requester, work item |

The only join key that exists is the agent name. Two more half-exist and neither is used:
a dispatch ticket carries `room` (`backend-v2.js:8400`) but it is `req.body?.room ?? null`,
optional, a Matrix room id rather than a group name, and nothing ever reads it back; an
agent manifest carries `managedProjects` (`lib/agent-home-v1.js:210`) as `{name, path}`
pairs, which `project-board.js` uses to attach worktrees but which the pool never sees.

**The prototype reproduces the seam faithfully.** `/projects` reads `board` and nothing
else. `/workforce`, `/capacity`, `/assignments`, `/performance`, `/knowledge` read
`agents`/`pool` and nothing else. Neither persona can finish their path, and the nine rail
links present two disjoint worlds as one flat list of siblings. That is the 乱.

### 1.2 The IA is attribute-first; both personas are scope-first

Today's six function pages are six *attributes* of the workforce — state, assignment,
capacity, score, memory, intake. Navigation means: pick an attribute, see every employee
through it.

But nobody arrives holding an attribute.

- The **PDT owner** arrives holding a *project* and wants all six facts about that
  project's people.
- The **PDU manager** arrives holding a *group* and wants all six facts about that bench.

Both must currently reassemble one scope's picture from six pages, by hand, keyed on agent
names they have to remember between clicks.

The app already contains the correct pattern, at the leaf: `/agents/[name]` is one scope
with attribute tabs. The refactor is to apply that same pattern one and two levels up.

---

## 2. The two flows, walked

### 2.1 PDT owner — solid line

> *"api-service is late. Who is on it, are they any good, and what is it costing me?"*

| step | wants | today |
|---|---|---|
| 1. open the portfolio | which of my projects are at risk | `/projects` renders **one** group, chosen from a `<select>`; there is no portfolio row |
| 2. open `api-service` | its work, its team, its spend | the page shows repos/specs/issues/changes — real project-board fields — but no roles, no tiers, no leases, no cost |
| 3. "why is the design work stalled?" | the constraint | `/assignments` has the answer (*nobody holds the architect role*) — on a different page, unfiltered, mixed with two other projects |
| 4. "is this coder any good?" | performance in role | `/performance` — third page, grouped by role, not filterable by project |
| 5. "what is it costing me?" | spend attributable to this project | `burn.byProject` exists in the fixture; nothing in the backend produces it |
| 6. drill to the agent | one employee's record | works — `/agents/[name]` is the one good leaf |

Five pages for one question. Steps 3–5 require the reader to carry agent names across
routes.

### 2.2 PDU manager — dotted line

> *"How is my architect bench? Am I over-committed, what does it cost me to keep, and is
> anyone actually getting better?"*

| step | wants | today |
|---|---|---|
| 1. open the org | headcount and health per group | there is no group view. `/workforce` is a flat five-row roster |
| 2. the architect bench | who, at what tier, how loaded | `/capacity` — the role × tier grid *is* the org chart, but it is a separate destination that shows only staffing, no people |
| 3. utilisation and seats | am I over-committed | `/capacity` bottom (seats, burn) — right page, but the bench above it doesn't connect to the seats below |
| 4. cost to keep | run-rate per group | `burn.byProject` is sliced by project only; there is no per-group slice |
| 5. team memory | what this group knows | `/knowledge` — fleet-wide only. **There is no group-scoped memory anywhere in the system** |
| 6. self-evolution | is the group improving | `/performance` groups by role, which is the closest any page comes to being an org view |

`/capacity` + `/performance` + `/knowledge` + `/workforce` are four different slices of one
population by one attribute each. They are `/org` with the group level deleted.

---

## 3. Proposal: a scope ladder with two entrances

| level | solid line (PDT) | dotted line (PDU) |
|---|---|---|
| portfolio | `/projects` — every project | `/org` — every group |
| unit | `/projects/[key]` | `/org/[role]` |
| individual | `/agents/[name]` ← **both converge here** |

Every level renders the same five sections, in the same order, with the same words — learn
the vocabulary once, use it at three altitudes:

**Work** (派遣) · **People** (在岗管理) · **Cost** (成本) · **Performance** (考核) ·
**Memory** (培养)

接入/分类 is not a property of a scope — it is how employees enter the house at all — so it
stays global at `/onboard`.

The six functions do not disappear. They stop being *places* and become *questions you can
ask of any scope*, which is what they always were.

### 3.1 Three personas, three entrances

There is a third persona the current console already serves well and which the two-lens
framing must not evict: the house's own **dispatcher**, who watches the queue across all
projects and all groups. That is `/assignments` (renamed `/dispatch`) and `/alerts`.

### 3.2 The rail, from nine rows to six

```
DELIVERY
  ▤  Projects        0 projects       ← solid line
ORGANIZATION
  ▦  Org             5 hired          ← dotted line
  ⇄  Dispatch        3 queued         ← the house's own queue
FLEET
  ＋  Onboard        3 ready
  ◉  Alerts          4 open
  ⚙  Config
```

`/workforce`, `/capacity`, `/performance` and `/knowledge` stop being rail destinations.
They keep working as URLs — each redirecting to its anchor under `/org` — because bookmarks
and 103 existing assertions point at them.

### 3.3 Roles are defined by the user, not by the code

A role is not a label the scheduler happens to match on. It is a **job description the
manager writes**, and it composes two things:

```
Role   = { key, name, minTier, skills[], owner }   ← authored by the PDU manager
Worker = { agent, capability, skills[] }           ← what the house actually has
```

Allocation is an explicit act, not an inference: the manager takes a worker out of the
unassigned pool and assigns it a role. The system's job is to check the match, not guess it.

```
satisfies(worker, role) = tierRank(worker.capability) >= tierRank(role.minTier)
                       && role.skills ⊆ worker.skills
```

Note what this is: **a generalisation of what already ships, not a rewrite.** Today's model
is exactly the case where every role has `skills = ∅` and its name is its own identity.
`selectAgent()` keeps its shape; the candidate filter gains one clause.

**How much the backend already permits — more than expected.**

- `ROLES` (`lib/matrix-agent.js:14`) **is never imported by the backend.** Its only
  consumers are its own unit test and this prototype's assertion suite. `agentRole()`
  returns `agent.role` verbatim, unvalidated. Free-form user-defined role strings therefore
  already work end to end, and the three `worker-*` records in `data/agents.json` are the
  live proof. The six roles are documentation that reads like a constraint.
- `capability` **is** validated, against `CAPABILITY_TIERS`, in both `agentCapability()` and
  `resolveTier()`. Tiers are real; roles are not.

**What is genuinely missing, precisely.**

1. **No role registry.** Nothing stores a definition, so nothing can render a catalogue,
   validate a write, or stop `coding` and `codeing` becoming two roles that silently never
   match. This is the feature.
2. **`skills` does not exist** — zero occurrences across `backend-v2.js`, `lib/`, `src/`.
   The `skills` array in the prototype's `EMPLOYEE_FACTS` is invented, and must be labelled
   as the contract it is asking for rather than a field being read.
3. **`PATCH /api/agents/:name` takes `role` but not `capability`**
   (`backend-v2.js:8252-8271`). So the allocation act — *give this worker this role at this
   tier* — **is not expressible through the current API.** Half of it lands; the other half
   silently keeps whatever registration set.
4. **`canonicalRole()` turns from a convenience into a hazard.** It infers a role from
   substrings in the agent name (`lib/matrix-agent.js:45-55`) and `agentRole()` falls back
   to it, so it would mint roles the manager never defined, out of names — an agent called
   `test-harness-agent` becomes `testing` with nobody allocating it. Gate it behind a flag,
   off by default, once the registry exists.
5. **`ROLE_DEFAULT_TIER[role] || 'medium'`** hands `medium` to any unregistered role
   silently. The tier belongs on the role record; an unknown role should fail loudly.

**Decided: floor for routing, fix for accounting.**

A role's tier could be read two ways, and they differ in exactly one place — what happens to
an over-qualified worker:

```
FLOOR  satisfies = tierRank(worker.capability) >= tierRank(role.minTier)
FIX    satisfies = worker.capability === role.tier
```

With Coder at medium and this fleet's `codex-agent` (medium) + `octos-agent` (strong):

| | fix | floor |
|---|---|---|
| allocate `octos-agent` as a Coder | rejected, wrong tier | allowed, over-qualified |
| `codex-agent` busy, dispatch for Coder | queues while a strong agent sits idle | routes to `octos-agent` |
| capacity grid | collapses to a list, tier implied by the role | stays role × tier; an empty medium cell reads `↑ strong` |
| cost exposure | none — never opus prices for sonnet work | a strong worker absorbs medium work at opus prices |
| change to shipped code | `selectAgent()` becomes an equality check, losing the covering path | none |

**Routing takes floor**, for three reasons. `selectAgent()` already implements it
(`lib/matrix-agent.js:88-93`) and already blunts the cost objection by sorting eligible
workers cheapest-sufficient-first, so a strong agent is spent only when no medium one is
free. It keeps `coveringTier()`'s `↑ strong` display meaningful. And it keeps the org chart
the size the manager drew it: under fix, tier is part of identity, so *Coder* and *Senior
Coder* must be separate roles and the catalogue grows toward 3× its entries.

**Accounting takes fix.** Floor's one real defect is that substitution is *invisible* — the
work gets done and the bill is quietly larger. So wherever an allocated worker's own tier
exceeds its role's minimum, the console renders both and names the delta:

> `octos-agent` · **strong** on Coder (min medium) — paying opus for sonnet work

This costs one column and no new data: `worker.capability` and `role.minTier` are both
already in the model. Fix hides nothing but flexes nothing; floor flexes and hides — unless
the gap is rendered, which is the whole of this decision.

Two consequences to carry forward: a dispatch request may omit the tier and inherit the
role's minimum, and may still override it upward for one request; and the over-qualification
delta is a **cost** signal, not an error — it never blocks an allocation.

**Skills are asserted, never measured.** Nothing in the system observes what an agent is
good at, so a skill is a claim the manager makes at allocation time and the console labels
it as one — the same provenance rule as everywhere else. The loop worth building later:
per-role performance can confirm or contradict an asserted skill, which is the first thing
考核 could feed back into 分类. Skills also need a controlled vocabulary in the same
registry, or `node` / `nodejs` / `Node.js` fragment the pool inside a week.

### 3.4 This is also the fix for the empty pool

`/onboard` hires an agent and never classifies it. That is *why* every agent returns
`role=null`, why the grid is empty, and why every `POST /api/dispatch` queues forever — the
gap that has sat in the gaps table since the first review.

Under this model 分类 stops being an invisible registration field and becomes a surface
someone actually uses: define the roles, then allocate workers into them. The org chart the
PDU manager wanted to see **is** the role catalogue, authored by the manager whose org it
is — so `/org` is both, and no separate CRUD route is needed (define at `/org`, edit at
`/org/[role]`, allocate from the unassigned bucket or from `/agents/[name]`).

Phase 0's first question is therefore answered, and with neither candidate: **not the code's
six, not the manager's five — whatever the manager defines.** Both sets ship as templates.

### 3.5 Default role templates

An empty catalogue is a worse first run than a wrong one: nobody wants to invent seven job
descriptions before they can allocate a single worker. So the registry ships **templates** —
add, modify, delete, all of it the manager's.

**Key and name are separate fields, and that is what resolves the naming mismatch.** The
`key` is the wire value `POST /api/dispatch` and `agentRole()` already use; the `name` is
the manager's word. Renaming *Coding* to *Coder* is then a display change with no
compatibility cost, and only a genuinely new role mints a new key.

| name (editable) | key (wire) | min tier | required skills | lifecycle stage |
|---|---|---|---|---|
| Product Manager | `product-manager` **new** | strong | requirement-analysis, prd-writing, acceptance-criteria | PRD |
| Architect | `architect` | strong | system-design, api-design | spec |
| System Engineer | `system-engineer` **new** | strong | system-design, integration-design, perf-analysis, **code-review** | spec → sub-spec |
| Coder | `coding` | medium | implementation | coding |
| Tester | `testing` | medium | test-design, e2e | testing |
| Release Engineer | `integration` | medium | ci-cd, packaging | release |
| Marketing / Tech Writer | `documentation` | medium | docs, release-notes, content | MO |

Five of the seven keep a key dispatch already routes. The two new ones — Product Manager and
System Engineer — are the honest signal that those are the roles the current scheduler has
never had a word for.

**There is no Reviewer role.** Code review is the System Engineer's responsibility, so
`code-review` is a skill on that role rather than a job of its own.

**Retiring `review` is not free, and this is where the registry earns its keep.** `review` is
a live wire value: `POST /api/dispatch {role: 'review'}` routes today, and
`canonicalRole()` mints it from any agent name containing `review` or `final_reviewer`
(`lib/matrix-agent.js:48-49`). Deleting the role would send those dispatches to a cell that
can never be staffed — queued forever, with no diagnosis. So delete needs a companion:

- **A retired key aliases to a live one.** `review → system-engineer`, stored in the
  registry, applied at dispatch. Old callers keep routing, to the bench that now owns the
  work, and the console shows the alias rather than hiding it. This is the missing half of
  the delete the manager was promised — without it, "users can delete roles" means "users
  can silently break dispatch".

**Two notes on Marketing.** Naming it Marketing while keeping key `documentation` is exactly
what §3.3's key/name split is for — no compatibility cost. But raising its floor from the
code's `lightweight` (`ROLE_DEFAULT_TIER.documentation`) to `medium` is a **narrowing**, and
so is the first live instance of the rule below: any worker allocated at `lightweight`
stops satisfying the role the moment the edit saves, and must be shown, not dropped.

The set now spans the full PDT lifecycle — PRD → spec → coding → testing → release → MO.
That is worth more than tidiness: it gives the solid-line lens a check it could not make
before. A project with no Product Manager allocated, or no Tester, is now a **visible
staffing gap** rather than an unexplained silence in the queue, and `/projects/[key]` can say
which lifecycle stage nobody is holding.

Rules the CRUD needs, all of which the console already has precedent for:

- **A template is a starting point, not a link.** Instantiate it and it is an ordinary role;
  editing it later does not touch the template, and the template set is not a live upgrade
  channel.
- **`key` is immutable after creation.** Changing it silently orphans every allocated worker
  and every queued ticket. Name is free; key is not.
- **Deleting a role with workers allocated is destructive** and gets the treatment Config
  already gives removal: exiled below a divider, under its own heading, requiring the role
  name typed out — and it must state where the workers go (back to unassigned, or to the
  alias target) before it will do it. Delete always asks for an alias or an explicit
  "retire with no successor", because a key that used to route and now doesn't is a silent
  failure by default.
- **Narrowing a role is destructive too, quietly.** Raising `minTier` or adding a required
  skill can make already-allocated workers stop satisfying their own role. The edit form has
  to show that count before saving, and the roster has to keep rendering those workers with
  the exception named rather than dropping them.

---

## 4. What must stay honest

This is the part that will make the new IA look *emptier* than the old one. That is the
point: the old one never asked the join question, so it never had to admit it can't answer.

1. **This fleet has zero projects.** `groups = loadJsonSync('groups.json', {})`
   (`backend-v2.js:2906`) and `data/groups.json` does not exist. `/api/project-board`
   therefore returns no projects at all. `/projects` must open empty and say *why*: groups
   are written by the Matrix bridge, so a project appears here when the customer's room is
   bridged — not "no data".
2. **This fleet already has an unregistered role.** `data/agents.json` holds
   `worker-alpha`, `worker-beta`, `worker-gamma` with `role: "worker"`. `agentRole()`
   returns `agent.role` verbatim with no validation (`lib/matrix-agent.js:59-61`), so
   `indexPool()` creates a `worker` column, `agentCapability()` falls through to
   `'medium'`, and `selectAgent(agents, 'worker', …)` would genuinely route.

   Under §3.3 this stops being an anomaly and becomes the *ordinary* case the registry has
   to handle: a role in use that nobody defined. `/org` renders it outside the authored
   chart, offers to adopt it into the registry or to reallocate its three workers, and does
   not quietly fold it into the six. It is also the existence proof that user-defined roles
   need no backend change to *route* — only to be *managed*.
3. **No engagement record exists.** A lease carries no project. A dispatch ticket carries
   an optional `room` that is never read back. So *"which employees are on this project"*
   is **not derivable today** — the project board answers it from group membership, which
   is a different question (membership is not deployment).

   This is the largest gap on the **solid** line, and it has an exact counterpart on the
   dotted line: **no role registry** (§3.3). One missing record per lens, and each is a
   backend task rather than a dashboard one. Neither lens can be finished in the console
   alone, and a prototype that renders both as though they resolve would be the same lie
   the Capacity page was rebuilt to stop telling.
4. **No per-project cost**, following from (3), and independently blocked by plan-vs-API
   pricing.
5. **No history.** `dispatchLeaseStore` and `dispatchQueues` are in-memory Maps
   (`backend-v2.js:8399-8401`); a restart drops every lease and every queued ticket. Any
   trend, any utilisation-over-time, any "干到什么地步" measured across a window is
   unavailable. Only point-in-time reads are honest.
6. **No team memory.** Memory today is per-agent (Letta blocks, `agent-knowledge.md`) or
   fleet-wide (`knowledge/`, 16 accepted artifacts). **Nothing is scoped to a group or a
   project.** So the Memory section renders a stated absence at both unit levels — which is
   exactly the "team memories" the PDU manager asked for, and it is a gap, not a page.

Gaps 3, 4 and 6 are new PRD rows. Gaps 1, 2 and 5 are already tracked.

---

## 5. Phases

### Phase 0 — closed

All three decisions are settled; nothing blocks Phase 1.

- **Which roles?** Whatever the manager defines. Seven templates ship (§3.5), all editable
  and deletable, with `review` retired to an alias.
- **Fix or floor?** Floor for routing, fix for accounting (§3.3).
- **Is "project" the group, or the workflow binding's `project` string?** The group — that
  is what `/api/project-board` keys on, what the bridge writes, and what already has
  members. Taken as the default rather than escalated; it is reversible, and the binding
  string remains available as a second key if a project ever needs to span groups.

### Phase 1 — the role registry (`lib/mock-data.js` + the contract it asks for)

The dotted line has no spine until roles are records. This moves ahead of the engagement
work because `/org` cannot render a group before a group exists.

- `roles`: `{ key, name, minTier, skills[], owner, lifecycleStage, fromTemplate }`, seeded
  from the seven templates in §3.5 and editable and deletable like any other row. `key`
  immutable after create; narrowing and deletion follow the destructive rules there.
- `retiredRoles`: `{ key, aliasTo, retiredAt }` — seeded with `review → system-engineer`.
  `resolveRoleKey(key)` follows one hop and is the only way any page or dispatch read
  reaches a role, so a retired key can never silently miss.
- `skillVocabulary`: the controlled list, so allocation offers a picker rather than a text
  box. Fragmentation is a data-model failure, not a user error.
- `satisfies(worker, role)` — **one implementation**, used by the allocation form's
  eligibility check, by the org page's headcount, and by the capacity read. Three call
  sites, one predicate; two would drift the way `routable()` drifted from `coveringTier()`.
  It returns a result, not a boolean: `{ ok, failedClause, tierDelta }`. `failedClause` is
  what the roster prints when a narrowed role strands a worker; `tierDelta` is the
  over-qualification the accounting half of §3.3 renders. A bare boolean would force every
  call site to recompute the reason, which is how two vocabularies get born.
- Retire `ROLE_DEFAULT_TIER` into the role record. Keep `CAPABILITY_TIERS` asserted against
  `lib/matrix-agent.js`, because tiers *are* enforced upstream. Change the `ROLES`
  assertion from "the fixture matches the constant" to "the seed catalogue matches the
  constant, and every role in use resolves in the registry."
- Write down the API this asks for, field by field, the way `/onboard` documents
  `GET /api/frameworks/detect`: `GET/POST/PATCH/DELETE /api/roles`, `skills[]` on the agent
  record, and `capability` added to the `PATCH /api/agents/:name` destructure — without
  that last one the allocation act cannot be performed at all (§3.3.3).

*New assertions:* every allocated worker satisfies its role, or the row states the
exception; no skill renders without its asserted-not-measured provenance; every role in the
fixture resolves in the registry.

### Phase 2 — one spine for the solid line (`lib/mock-data.js`, 979 → ~1200 lines)

The fixture currently holds five parallel arrays loosely keyed by agent name. Collapse to
one join table and derive everything.

- Add `projects`, shaped to `buildProjectBoardSnapshot`'s real output — name, members,
  summary, `taskLanes`, `specs`, `localIssues`, `remoteIssues`, `changeRequests`,
  `activity`. Retire the `board` fixture with it.
- Promote `assignments` → `engagements`, adding `project` to every row. Keep
  `export const assignments` as a derived alias so no page breaks in the same commit.
- Add **dimension-parameterised** selectors: `engagementsBy(dim, key)`, `costBy(dim)`,
  `perfBy(dim)`, `memoryBy(dim)` where `dim ∈ {project, role, agent}`. One implementation
  per fact, three slices — the same rule that unified `routable()` onto `coveringTier()`.
- Add `orgGroups()`: one entry per registered role — the workers who `satisfy()` it,
  split into allocated / eligible-but-unallocated — ⊕ the unassigned bucket ⊕ any role
  present in the agent data but absent from the registry (see §4.2).

*New assertions:* every engagement's `project` resolves; `sum(costBy('project')) ===
sum(costBy('role'))` — one number, two slices, and no way for them to drift.

### Phase 3 — the two portfolio pages

- `app/org/page.jsx` — the authored org chart. One card per role showing its **definition**
  (min tier + required skills) above its **staffing** (allocated, eligible, deployed/idle,
  utilisation, run-rate, memory coverage, flagged). Plus *Define a role*, the unassigned
  bucket with an *Allocate* action, the unregistered-role warning, and retired roles shown
  with their alias target rather than dropped. Absorbs the `/workforce` roster and the
  `/capacity` grid.
- The **allocate** flow: pick a worker → pick a role → the form shows which clause of
  `satisfies()` fails and refuses to pretend otherwise, and shows `tierDelta` as a cost note
  that informs but never blocks (§3.3) → it prints the equivalent command,
  as `/onboard` does. On today's API that command is a `PATCH` carrying `role` only, and
  the page has to say that the tier half will not land (§3.3.3). A form that silently sends
  half a write is worse than one that names the gap.
- `app/projects/page.jsx` — rewritten as a portfolio: one row per project, blocked-first,
  each carrying its **lifecycle staffing** — which of PRD / spec / coding / testing /
  release / MO has nobody allocated. Opens empty on this fleet, with the bridge reason from
  §4.1.
- `components/Rail.jsx` — six rows under three headings; `also` arrays absorb the
  redirected routes so exactly one `aria-current` still holds from all ~15 URLs.

### Phase 4 — the two unit pages, one component

- `components/ScopeTabs.jsx` — the five sections, rendered from `<EngagementTable>`,
  `<PeopleTable>`, `<CostPanel>`, `<PerfTable>`, `<MemoryPanel>`, each taking a `dim`
  prop. Both unit pages are thin wrappers. This is where "one renderer per record" is
  enforced; two renderers is how `lib/project-board.js` ended up with two status
  vocabularies.
- `app/projects/[key]/page.jsx` — and this is where the reviewer's *backlog / issues / pr*
  finally lands, as `specs` / `localIssues` + `remoteIssues` / `changeRequests`, which
  `project-board.js` already computes. Labelled with their source: HAFleet reads them out
  of worktrees, it does not own them, and it must not offer to edit them.
- `app/org/[role]/page.jsx`.

### Phase 5 — the leaf shows both managers (~40 lines)

`/agents/[name]` gains a two-line affiliation in its header: solid line (the projects it is
a member of) and dotted line (its role, and whether it still satisfies that role's
definition), each linking up. Today the employee record shows neither. Cheapest change in
the plan and the one that makes the matrix legible. Its Profile tab is also where a
worker's skills are asserted, so allocation can be reached from either side.

### Phase 6 — assertions and shots

- Exactly one `aria-current` from every route against the six-row rail.
- Every scope page renders all five sections, or a stated reason in place of one.
- No cost figure renders without provenance; no skill renders without its
  asserted-not-measured provenance.
- Every allocated worker satisfies its role, **or** the row names the failing clause — the
  case Phase 1's narrowing rule creates and the one a naive filter would hide. The Marketing
  floor change in §3.5 is the fixture's live instance, so this assertion has something to
  catch on day one.
- Every retired key resolves through `resolveRoleKey()` to a live role, or is explicitly
  marked as having no successor. A dispatch key that silently matches nothing is the exact
  failure mode the empty pool already taught us to assert against.
- **No over-qualified allocation renders a single tier.** Wherever `tierDelta > 0` the row
  shows the worker's tier *and* the role's minimum. This is the assertion that keeps floor
  honest — without it, routing elasticity and a quietly larger bill look identical.
- Every role in the catalogue carries a lifecycle stage, so the solid-line staffing-gap
  check cannot be defeated by a role that belongs to no stage.
- **Every empty scope names who writes the missing record** — bridge, registration, role
  registry, or not-implemented. This is the §4 discipline made mechanical.
- `shots.mjs` 10 → 18 (the two trees, plus the role catalogue and the allocate form);
  `check-switches.mjs` gets `rail.rows === 6` and the drill path project → agent → org → back.

---

## 6. Explicitly not in scope

- **No backlog/issue/PR editing.** HAFleet reads those from worktrees and the customer owns
  them in Matrix. Rendering them is right; offering a button is the same error as offering
  to accept delivery.
- **No skill inference.** Skills are asserted by the manager. Deriving them from agent
  names is the mistake `canonicalRole()` already makes (§3.3.4); deriving them from
  observed work is a real feature but a later one, and it needs performance history that
  §4.5 says does not exist yet.
- **No page deleted.** Every current route survives as a URL; four stop being rail
  destinations.

---

## 7. Cost

| phase | scope |
|---|---|
| 0 | two decisions, no code |
| 1 | role registry + `satisfies()` + templates, ~180 lines, ~5 assertions, API contract written down |
| 2 | engagement spine, `mock-data.js` +~220 lines, ~4 assertions |
| 3 | two portfolio pages ~250 each, allocate form ~120, rail rewrite ~40 |
| 4 | one shared component ~300, two wrappers ~80 each |
| 5 | ~40 lines |
| 6 | ~180 lines of assertions, 8 new shots |
| i18n | ~160 new keys × 2 locales |

Phases 1 and 2 are the ones that must be right; 3–5 are mechanical once both spines exist.

**The shortest path to something worth reviewing is 1 + 3-partial + 5**: the role catalogue,
the allocate form, and the affiliation lines on the employee record. That alone closes the
PDU manager's steps 1–2, makes 分类 a surface for the first time, and produces the first
non-empty pool this fleet has ever had — without touching the solid line at all.

---

## 8. Built — what changed, and what the plan got wrong

### 8.1 Shipped

| | |
|---|---|
| new routes | `/org`, `/org/[role]`, `/projects/[key]` |
| rewritten | `/projects` (portfolio), `/` (now redirects to `/org`) |
| demoted, still live | `/workforce`, `/capacity`, `/performance`, `/knowledge` — URLs kept, they light up Org |
| new components | `ViewToggle` (the honest/projected switch, extracted from four copies), `ScopeSections` (the five sections at any scope) |
| data | role registry, `retiredRoles`, `satisfies()`, `orgGroups()`, `allocations`, `projects`, `engagementsBy`/`costBy`/`perfBy`/`memoryBy`, `stageGaps()` |
| dictionary | 591 → 692 keys, both locales, parity and placeholder checks green |
| assertions | 103 → 167 static, 39 → 43 in-browser |
| shots | 10 → 18, both lenses in both states |

### 8.2 One modelling error the plan contained

`orgGroups()` computed eligibility as *satisfies AND not already allocated*, so in the
projected view — where every worker holds a role — **Architect reported as a hiring gap
while an architect-capable employee sat one row above it**, allocated to Coder. That would
send someone out to buy capacity they already own.

An unfilled role has three causes needing three different actions, and the plan collapsed
them into two:

- **allocatable** — somebody free satisfies it. One click.
- **contended** — somebody satisfies it, but they are all allocated elsewhere. A priority
  call.
- **unhireable** — nobody in the fleet satisfies it at all. Go and hire.

### 8.3 Four defects no assertion caught, and why

Every one was found by looking at a rendered screenshot. Each is now covered, and each
cover was mutation-tested by reintroducing the bug.

| defect | why the suite missed it |
|---|---|
| The rail read `not qualified` beside a page showing that agent allocated as a Coder | no assertion compares the rail against the page it sits next to; fixed by making the per-agent tag follow `?view=`, while the fleet-level pills stay live |
| Every blank on the console rendered `— — reason` | the second dash is `.why-inline::before` **content**, which is not in the HTML and not in `innerText` either. Pre-existing on `/workforce`, propagated by the new pages |
| `nobody holds the {role} role`, and `rework rate {a}% against {b}%` | the i18n checks verify that keys *resolve* and that placeholders *match across locales* — both pass while the braces are on screen |
| Cost read "nothing to price" beside a populated People table | `engagementsBy(dim, null)` treated `null` as a value to match, so `costBy()` summed an empty list |

**The methodological finding is the last column.** Two of these were first "fixed" with a
static assertion that passed while the bug was still in:

- the doubled dash cannot be seen in markup, because it is generated content;
- **no `?view=assigned` content reaches the static pass at all** — the view is read in an
  effect, so server-rendered HTML is always the live view. A placeholder sweep over
  projected URLs looked like coverage and asserted nothing.

Both now live in `check-switches.mjs`. The rule this yields: *an assertion is not evidence
until it has failed on purpose.* Every check added in this refactor was mutation-tested.

### 8.4 Still open

- The role registry, `skills[]`, and `capability` on `PATCH /api/agents/:name` are all
  contracts the prototype is drawn against and the backend does not implement (§3.3). The
  Allocate action prints the half-write the current API would actually perform and names
  the missing half rather than sending it silently.
- Per-project cost, durable assignment history, and group-scoped memory remain gaps
  (§4.3–4.6), and each renders as a stated absence rather than a zero.
- Layout at 1 / 20 / 100 agents and 0 / 50 roles is untested; it needs fixture variants
  rather than layout changes.
