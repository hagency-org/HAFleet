# Dashboard relayout — clickable prototype

A Next.js app implementing the design in [`../docs/design/dashboard-relayout.md`](../docs/design/dashboard-relayout.md).
Mock data only: it talks to no backend and cannot affect a fleet.

```bash
cd mockup
npm install
npm run dev     # http://localhost:3100
```

## Why a running app rather than more images

Three findings from the review rounds could not be answered by a static mockup:

- **Populated Tasks.** An empty state cannot demonstrate blocked-first ordering,
  waiting/heartbeat density, or a detail panel with only the legal transitions.
- **The corrected Alerts strips.** The drawing kept showing the rejected version that
  mixed four lifecycle statuses with one severity metric.
- **The Queue destination.** The migration table promised it; nothing ever designed it.

A running app also makes the invariants testable rather than asserted. Every claim below
is checked against the served HTML.

## Routes

The console has **two entrances**, one per line of report, converging on the employee
record where they intersect. See
[`../docs/design/dashboard-two-lens-refactor.md`](../docs/design/dashboard-two-lens-refactor.md)
for why, in full.

| level | solid line — PDT | dotted line — PDU |
|---|---|---|
| portfolio | `/projects` | `/org` |
| unit | `/projects/[key]` | `/org/[role]` |
| individual | `/agents/[name]` — both converge here |

Every level renders the same five sections, in the same order: **Work** (派遣) · **People**
(在岗管理) · **Cost** (成本) · **Performance** (考核) · **Memory** (培养). HAFleet's six
functions stopped being places in the nav and became questions you can ask of any scope —
which is what they always were. 接入/分类 is not a property of a scope, so it stays global.

| route | what it answers |
|---|---|
| `/org` | The authored org chart: every role you defined, who fills it, and who is waiting to be allocated |
| `/org/[role]` | One role — its definition first, then its work, people, cost, performance and memory |
| `/projects` | The portfolio: what each product line is being delivered, by whom, and which lifecycle stages nobody holds |
| `/projects/[key]` | One project — the same five sections, plus its backlog, issues and change requests, read from worktrees and rendered without controls |
| `/agents/[name]` | One employee: both managers, qualification, assignment, performance, memory |
| `/assignments` | The dispatcher's own queue: what executes, what is queued, and the constraint each queued item failed |
| `/onboard` | What this host can employ, and hiring one |
| `/alerts`, `/config` | Incidents; fleet-wide policy and the destructive things |
| `/workforce`, `/capacity`, `/performance`, `/knowledge` | Still live URLs. They were four slices of one population by one attribute each — that is `/org` with the group level deleted — so they light up Org in the rail rather than being destinations |
| `/queue`, `/tasks` | Views of assigned work; they light up Dispatch |

`/` serves `/org`. Of the two entrances the dotted line is the right landing: this is the
house's own console, the resource plane is what it owns, and `/projects` opens empty on any
real fleet because no group has been bridged. Landing on Org also puts 分类 in front of the
operator, which is the step that has never had a surface and the reason every agent
returns `role=null`.

**Every scope defaults to the honest view.** On this fleet no group is bridged and no
worker is allocated, so `/projects` opens with no projects and `/org` opens with seven
defined roles and five unallocated workers — plus, for each, which roles they would already
satisfy. `?view=assigned` shows the projected fleet, labelled in the body. The honest view
is not "empty": it is "nobody has done the classifying step", which is actionable in a way
an empty grid never was.

## Roles are defined by the user

A role is a job description the manager writes, composing a **minimum tier** with
**required skills**. Seven templates ship and all of them are editable and deletable.

```
satisfies(worker, role) = tierRank(worker.capability) >= tierRank(role.minTier)
                       && role.skills ⊆ worker.skills
```

- **Key and name are separate fields.** `key` is the wire value `POST /api/dispatch` and
  `agentRole()` already use; `name` is the manager's word. Renaming *Coding* to *Coder*
  costs nothing, and only a genuinely new role mints a key.
- **Floor for routing, fix for accounting.** A stronger worker still qualifies — which is
  what `selectAgent()` already does — and wherever a worker's own tier exceeds its role's
  minimum, both are rendered. Floor's only real defect is that the substitution is silent.
- **A retired key aliases to a live one.** There is no Reviewer role; code review is the
  System Engineer's skill. But `review` is a live wire value, so deleting it outright would
  queue its dispatches forever — `review → system-engineer` keeps old callers routing, and
  the console shows the alias.
- **Narrowing is destructive too.** Raising Marketing's floor from `lightweight` to
  `medium` strands `claude-agent`, which is allocated there. It renders with the clause it
  now fails rather than disappearing.
- **Skills are asserted, never measured.** Nothing in the fleet observes them, and the
  field does not exist upstream at all.

## Decisions you can see working

- **The rail carries the fleet on every route.** Agent state never leaves the screen.
  Fleet nav is a pinned grid row, so a long agent list cannot push it below the fold.
- **Agents are links, not buttons.** They already have URLs, so middle-click,
  bookmarking and keyboard navigation come free.
- **Seven agent tabs, not six.** `Configuration` was doing two unrelated jobs and splits
  into `Profile` and `Runtime`. `Oversight` is read-only — controls must not sit beside
  the evidence used to judge them.
- **Activity has three sources.** A tmux agent gets its pane; an ACP agent gets the
  supervisor's log, labelled as such; an agent with neither gets an empty state naming
  why. `Refresh: 10/sec` only appears where there is a pane to poll.
- **Severity is a dot AND a word.** Bound together in one component, so the round-2
  mistake — a red dot labelled `info` — cannot be drawn.
- **Counts are labelled.** `9 open`, `0 groups`. A bare number has an unstated
  denominator.
- **Destructive actions are exiled**, below a divider under their own heading, and
  removal requires typing the agent name. A confirm dialog is a reflex; typing is a
  decision.
- **Every action reports its outcome**, success or failure, through one `role="status"`
  live region. Failures linger longer, because they are the ones needing action.
- **Capacity opens on an empty grid, because that is the truth.** Every agent on this
  fleet returns `role=null` — `canonicalRole()` infers a role from substrings in the name
  and none of them match — so `indexPool()` skips all five and every `POST /api/dispatch`
  queues forever. `POST /api/agents` accepts `role` and `capability`; no onboarding path
  sends them. Three drafts of this page were wrong before this one, each because I read
  the renderer instead of running the scheduler.
- **The hypothetical view is at `/capacity?view=assigned`**, labelled as hypothetical in
  the body rather than only by a pressed button in the header — a lease table with rows in
  it is what makes an implementer think the API produces data. It is in the URL because
  selection belongs there, and because while it lived in `useState` no URL-driven check
  could reach it: the responsive sweep was measuring the empty view twice.
- **No grid cell states itself in a mark alone.** `— queues` and `↑ strong`, not `—` and a
  green `↑` with the meaning in a `title`. Naming the covering tier also says more than
  the arrow did, and the assertion is the general one: every `<td>` on the page carries a
  word.
- **Emptiness is a property of the cells, not of `total`.** `/api/pool` answers
  `total: records.length`, which is 5 on this fleet while the grid is `{}` — a page gated
  on `total === 0` would show a blank grid with no explanation once it was wired up.
- **One `TaskList`** serves both fleet Tasks and the agent Work tab, which passes a
  locked assignee scope. Two renderers for one record is how the statuses in
  `lib/project-board.js` ended up with two vocabularies.
- **A blank is never a zero.** Every em dash on the roster is followed by its reason —
  *available now*, *not staffed*, *no seat bound*, *no durable intervals yet*. `0` claims a
  measurement that was never taken, which is a different fact from "we have no way to price
  a plan seat".
- **The rail tag carries the job, not the transport.** `coding · medium`, not `ACP`. Three
  of five agents shared the tag `ACP`, which distinguished nothing an operator navigates by
  — and cost a reader a question about whether one agent had two transports. Transport moved
  to the roster row and the employee record, where it is diagnostic.
- **A queued assignment names the constraint it failed.** *nobody holds the architect role*,
  not a ticket id. A queue that only says "queued" is a backlog; one that says why is a
  diagnosis, and three of these need hiring rather than scheduling.
- **Acceptance is a state, never a button.** `ACCEPTANCE PENDING` shows the assignment
  waiting on its Matrix room. Accepting delivery is the customer's act and the console must
  not offer to do it.
- **Seats are counted once.** Two employees on one credential home draw on one subscription
  window; an agent-keyed model would count that capacity — and that spend — twice.
- **Performance shows its denominator.** Every figure carries `n` and a confidence read, and
  comparison stays inside a role. A scorecard that hides its sample size invites a decision
  from four data points.
- **`docs/design/shots/` is generated, not drawn** — `node scripts/shots.mjs` drives the
  running app, and it fails if a shot's page is not actually in the locale and theme it
  claims. The first version silently produced a `zh` render entirely in English.


## Language and theme

Both switches are in the rail footer and persist to `localStorage`. English and
Simplified Chinese, 407 keys in `lib/i18n.js`, and three theme states — light, dark,
system — as a token swap in `app/globals.css`.

Deliberately **not** translated: agent names and ids, lifecycle values that are also API
values (`open`, `blocked`, `in_progress`), `ACTIVE`/`IDLE` because that is what
`hafleet ls` prints, shell commands and env vars, and payload data such as alert
summaries. Severity words *are* translated — the dot-and-word rule exists so severity
never rests on colour, and an operator who cannot read "critical" is back to reading the
dot. The raw API value stays in the element's `title`.

## Onboarding

`/onboard` reads a per-framework detection result and offers to bring up the ones that
are ready. Every field it shows comes from `lib/frameworks/<id>.json`, the same manifests
the launcher uses.

**`GET /api/frameworks/detect` does not exist yet.** The page is drawn against the shape
it needs; writing it is the implementation task. See the design doc for the field-by-field
contract.

`state` is derived, never stored: `ready` → `needs_auth` → `needs_setup` → `absent`,
checked in that order. Four states because "installed" and "usable" came apart in
practice — hermes with only the `[acp]` extra starts, reports healthy, and then cannot
see `check_inbox`.

No credential fields: an agent authenticates itself *before* it joins the fleet, so an
unauthenticated framework gets the one command that fixes it and no input box.

## Checks

```
npm run check            # static assertions against the served HTML
npm run check:switches   # assertions that need a real browser
npm run verify           # both
```

`check-invariants.mjs` covers the route inventory, one `aria-current` per page, the full
tablist contract, severity ordering, blocked-first task ordering, that ACP agents are
never offered pane polling, the whole dictionary, and the role registry: every key either
one the scheduler already routes or declared new, every tier and skill drawn from a
controlled list, every retired key resolving to a live role, `satisfies()` floored for
routing and exact for accounting, and cost sliced by project totalling the same as cost
sliced by role. It needs the server running (`npm start`). `check-switches.mjs` also
needs Chrome — it drives the system install through `puppeteer-core` and downloads
nothing; override with `CHROME=/path/to/chrome`.

The browser pass exists because the static pass reads server-rendered HTML, which is
always English and always light. It covers what only a browser can see: that the words
change, that dark actually repaints and is measurably darker, that contrast survives,
that both choices survive a route change, that no page scrolls sideways at 375 / 640 /
900 / 1440px, that no button was shipped without a handler, and that
`/capacity?view=assigned` really selects the populated grid — deep-linked, after a reload,
and back again.

It also carries two checks that **cannot** live in the static pass, each of which was
first written there, passed, and went on passing with the bug in:

- **the doubled em dash** — `.why-inline::before` supplies one, so a blank that also
  emitted a `.mk-dash` rendered `— — reason`. Generated content is not in the HTML and not
  in `innerText`; it takes a computed style to see.
- **raw `{placeholder}` leaks on projected views** — `?view=` is read in an effect, so
  every `?view=assigned` surface is client-only and the server-rendered HTML the static
  pass fetches is always the live view.

Every assertion added in the two-lens refactor was mutation-tested by reintroducing the
bug and confirming the check fails. An assertion is not evidence until it has failed on
purpose.

It waits for hydration before it clicks anything. `networkidle0` only says the bytes
arrived; a click that lands before React attaches its handlers does nothing, silently, and
every assertion after it reads the pre-click state. That passed against `npm start` and
failed on every run against `npm run dev`, which is the wrong way round for a check.

## Known limits

It is a prototype: no backend, no persistence, no live pane proxying, and the numbers are
illustrative rather than measured.

Still open, and listed in the design document's gaps table:

- `GET /api/frameworks/detect`, which `/onboard` is drawn against, has to be written.
- The fixture has five agents and seven roles. Layout at 1 / 20 / 100 agents and 0 / 50
  roles is untested and needs fixture variants rather than layout changes.
- Nothing populates the dispatch pool. `/org`'s Allocate action is the surface 分类 never
  had, but the write it needs does not exist: there is no role registry, `skills` occurs
  nowhere in `backend-v2.js`/`lib/`/`src/`, and `PATCH /api/agents/:name` destructures
  `role` and not `capability` — so the tier half of an allocation cannot land. The page
  prints the half-write the current API would perform and names the missing half rather
  than sending it silently.
- No engagement record links an employee to a project: a lease carries no project and a
  dispatch ticket's `room` is optional and never read back. Group membership is not
  deployment, so every staffing column on the solid line is projected.
- There is no group-scoped or project-scoped memory. Memory is per-agent or fleet-wide and
  nothing sits between, so a scope's "team memory" is the union of its members' — a weaker
  thing, named as such.
- The dispatch queue and the message queue share the word "queue". Both pages point at
  each other and say so; one needs renaming before either ships.
- The benchmark's *today* column still needs measuring against the real dashboard.
- `docs/design/page-*.jpg` predate several corrections the prototype carries. Prefer
  `docs/design/shots/`, which is generated from the running app.
