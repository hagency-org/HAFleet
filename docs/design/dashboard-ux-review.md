# Dashboard UX review

Scored 2026-08-04 against a live five-agent fleet. Every number and file reference was
measured, not estimated. The companion design is
[dashboard-relayout.md](dashboard-relayout.md).

An independent review by a `codex` agent in the fleet informed the ranking and argued
against the ordering this review originally proposed — see *What not to fix first*.

## Score: 34 / 100

| dimension | score | evidence |
|---|---:|---|
| Answers "what needs attention" | 15 | 9 open alerts, invisible from the monitor. Agent state required a click until `renderAgentButtons` changed. |
| Information architecture | 10 | 2 of 6 nav slots (`PROJECTS`, `TASKS`) lead to empty pages. Agents have no top-level entry. |
| Labels name effects | 55 | Improved: `Refresh: 10/sec`, `Pause display`, `Send now · skip wait` replaced `10HZ`, `PAUSE`, `SEND NOW`. |
| Action feedback | 60 | Improved: queue and reminder outcomes announced. The rest of the surface is still silent. |
| Visual hierarchy | 20 | Monitor page: zero `h1`–`h4`, zero `<table>`, 29 inline `style=` attributes. |
| Accessibility | 12 | Two `aria-*` attributes and zero `role=` across 86 KB. Tabs are plain buttons. |
| Consistency / maintainability | 18 | 119 CSS classes defined, 76 used, **55 dead**, and **60 of the 76 used exactly once**. |

Measured fleet state at the time of scoring: 5 agents, 9 open alerts, **0 projects**,
**0 tasks**, 0 queued messages.

## The root problem

The monitor opens on `Select an agent to monitor` / `NO AGENT SELECTED`
(`monitor-page.js`, the `monitor-label` / `monitor-empty` elements). Agent state — ACTIVE/IDLE, duration,
unread counts, supervisor warnings — was computed only *after* selection. Answering
"what needs attention?" meant clicking every agent in turn.

It is a viewer, not a triage surface. Everything else is downstream of that.

## Three concepts that read as arbitrary

### Projects

A code repository bound into an agent's home — `projects/<name>/`, either a copy or a
symlink of a source repo, and where that agent's code edits land. The API is
`/api/agents/:name/projects`: fundamentally per-agent.

So it is an **attribute of an agent**, not a peer of one. Yet it holds a top-level nav
slot, and the per-agent view is buried inside a tab named `Internals`.

### Tasks

A work item with a lifecycle, assigned to an agent and grouped under a project. The
confusion is a name collision in `lib/project-board.js`:

| constant | values | means |
|---|---|---|
| `TASK_STATUSES` | created, accepted, in_progress, blocked, done | a work item's lifecycle |
| `AGENT_TASK_STATUSES` | active, waiting, blocked, done | what an agent is doing *right now* |

Only `blocked` and `done` appear in both, and they mean different things in each.

### The six agent submenus

Not a structure. By rendered size, one tab is the page and five are labels:

| tab | chars | contains |
|---|---:|---|
| Settings | 1,078 | Identity, Guidance, Configuration, Framework Presets, System Controls, Ownership |
| Tasks | 1,675 | Create Task, Task Detail |
| DM | 808 | Direct Messages |
| Supervisor | 1,790 | Docs Snapshot, Signal, Audit, Audit History |
| Subconscious | 374 | Subconscious |
| **Internals** | **140,230** | Primary Role, Supervisor Role, **Supervisor Audit** (duplicate), Subconscious Control, Subconscious LLM, **Managed Projects**, Import Project, Workspace Migration |

`Internals` is 83% of the page. It holds the Projects concept, duplicates Supervisor
Audit, and is named after nothing an operator wants. **The tab bar promises a structure
the content does not follow** — which is why the submenus feel arbitrary.

## Other findings, ranked by operator cost

1. **The agent list re-sorts on every refresh** (the `agents.sort(...)` in `renderAgentButtons`) — by
   local/remote, active/idle, then idle duration. Targets move while you scan, so
   position never becomes muscle memory.
2. **Controls named their implementation.** `10HZ` changed display polling, not agent
   behaviour. `PAUSE` paused the terminal refresh, not the agent. `SEND NOW` bypasses
   the idle delivery gate — verified in `server.js` at `app.post('/api/queue/:id/send')`, which claims the entry with
   reason `'manual'` — and nothing on the card said so.
3. **Failures were invisible.** Queue and reminder actions removed their row
   optimistically and, on failure, restored it and wrote to `console.debug`. A restored
   row read as a newly arrived one. The endpoints genuinely refuse: 409
   `already-delivering`, 503 `queue-persist-failed`.
4. **IA duplicates scope.** A global `TASKS` destination *and* an agent-detail Tasks
   tab. Agent detail defaults to `Settings` while current work sits under `Supervisor`.
5. **The 169 KB agent-detail page is not in the nav at all** — reachable only by
   clicking through.

Items 2 and 3 are fixed. 1 is mitigated (state is now on the button, so the list is
readable without relying on position). 4 and 5 are open.

## What not to fix first

The measurable defects — no semantic structure, 62 interactive controls on the detail
page, six separate `Save` buttons, dead CSS — are real, but they are the *maintainer's*
problems. From the codex review:

> Do not start with semantic HTML, capitalization normalization, a component layer, or
> splitting the 3,473-line file. Those are valid maintainability/accessibility projects,
> but they will not fix the highest-cost operator question and create broad regression
> surface.

That is correct, and it inverted the ordering this review first proposed.

Its line citations checked out on inspection, including the dirty-form guard above —
worth noting because an earlier draft of this document replaced that citation with a
guessed identifier (`document.activeElement`) that does not exist in the file.

## Load-bearing machinery

Reads as clutter, is not. Do not simplify away:

- auto-scroll preservation, explicit Bottom, ETag use, request sequencing,
  visibility-aware poll rates
- queue hover locking, pending-action guards, tombstones, restore-on-failure
- Stop vs Remove separation and its confirmations, including the irreversible wording
- **dirty-form preservation during periodic refresh** (`agent-detail-page.js`, `hasUnsavedDetailChanges()` -> `shouldPreserveDetailSettings()` -> `if (!shouldPreserveDirty) renderSettings(...)`).
  The refresh skips re-rendering Settings while edits are unsaved and warns instead;
  a careless visual refactor here destroys operator input mid-typing

## Success test

Give an operator ten seconds on the monitor and ask which agents are active and for how
long. Before, that required clicking. After:

```
○ renamed-agent      IDLE 1h59m
○ codex-agent        IDLE 33m46s
○ octos-agent        IDLE 1h6m
○ hermes-agent       IDLE 1h14m
○ codex-acp-agent    IDLE 1h6m
```
