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
| `/capacity` | Which roles have an idle agent available, and what is currently leased |
| `/onboard` | What this host can actually run, and bringing one up |
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
- **Capacity is a scheduler view.** `/api/pool` is read by `lib/matrix-agent.js` and
  `src/dispatch-lease-store.mjs`: `POST /api/dispatch` picks an agent from these cells and
  leases it, and an expired lease raises the `dispatch_lease_expired` alert. Two drafts of
  the design suggested retiring the page; both had checked the page and not the API.
- **One `TaskList`** serves both fleet Tasks and the agent Work tab, which passes a
  locked assignee scope. Two renderers for one record is how the statuses in
  `lib/project-board.js` ended up with two vocabularies.


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
npm run check            # 71 assertions against the served HTML
npm run check:switches   # 33 assertions in a real browser
npm run verify           # both
```

`check-invariants.mjs` covers the route inventory, one `aria-current` per page, the full
tablist contract, severity ordering, blocked-first task ordering, that ACP agents are
never offered pane polling, and the whole dictionary — both locales complete, placeholders
matching, every key used, no key rendered raw. It needs the server running (`npm start`). `check-switches.mjs` also
needs Chrome — it drives the system install through `puppeteer-core` and downloads
nothing; override with `CHROME=/path/to/chrome`.

The browser pass exists because the static pass reads server-rendered HTML, which is
always English and always light. It covers what only a browser can see: that the words
change, that dark actually repaints and is measurably darker, that contrast survives,
that both choices survive a route change, that no page scrolls sideways at 375 / 640 /
900 / 1440px, and that no button was shipped without a handler.

## Known limits

It is a prototype: no backend, no persistence, no live pane proxying, and the numbers are
illustrative rather than measured.

Still open, and listed in the design document's gaps table:

- `GET /api/frameworks/detect`, which `/onboard` is drawn against, has to be written.
- The fixture has five agents. Layout at 1 / 20 / 100 is untested and needs fixture
  variants rather than layout changes.
- The dispatch queue and the message queue share the word "queue". Both pages point at
  each other and say so; one needs renaming before either ships.
- The benchmark's *today* column still needs measuring against the real dashboard.
- `docs/design/page-*.jpg` predate several corrections the prototype carries. Prefer
  `docs/design/shots/`, which is generated from the running app.
