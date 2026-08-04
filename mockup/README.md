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

| route | what it answers |
|---|---|
| `/overview` | What needs attention across the fleet, right now |
| `/agents/[name]` | What is this agent doing, is it healthy, how do I intervene |
| `/alerts` | Which incidents are actionable, why, and what changed |
| `/queue` | What is waiting for delivery, and what is it waiting on |
| `/tasks` | What is blocked, overdue or unowned |
| `/projects` | State of a coordinated project across agents and repos |
| `/capacity` | Which roles have an idle agent available |
| `/config` | Fleet-wide policy, and the destructive things |

`/` redirects to `/overview`. In the real dashboard it does **not** — `/` keeps serving
today's monitor until every surface in the migration table has a destination.

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
- **One `TaskList`** serves both fleet Tasks and the agent Work tab, which passes a
  locked assignee scope. Two renderers for one record is how the statuses in
  `lib/project-board.js` ended up with two vocabularies.

## Verifying it

With the app running on 3100:

```bash
node scripts/check-invariants.mjs
```

Checks the route inventory, one `aria-current` per page, the full tablist contract,
severity ordering, blocked-first task ordering, and that ACP agents are never offered
pane polling.

## Known limits

It is a prototype. No backend, no persistence, no live pane proxying, and the numbers are
illustrative rather than measured. The benchmark's *today* column in the design document
still needs measuring against the real dashboard.
