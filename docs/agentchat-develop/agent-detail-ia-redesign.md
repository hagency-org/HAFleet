A. Page Goal

Give an operator one clear control surface to assess agent health, understand the agent's current work, detect intervention needs, and safely change agent metadata/settings without wading through debug-heavy clutter.


B. User Questions

1. Is this agent healthy and progressing, or is it drifting, stuck, or blocked?
2. What is the agent doing right now, and what task is it supposed to be doing?
3. Does anything need human intervention right now?
4. What changed most recently that matters operationally?
5. Where do I make safe edits to metadata, identity, and runtime-related settings?


C. Information Hierarchy

Primary
- Current health/state summary:
  - active vs idle
  - latest supervisor status
  - blocked/intervention-needed state
  - unread/queued counts
- Current work:
  - current task
  - concise latest reason/status narrative
  - most recent important events
- Primary actions:
  - navigate back to monitor
  - move to deeper history/debug areas
  - agent down
  - delete agent

Secondary
- Identity and editable metadata:
  - identity
  - owner
  - project scope
  - human notes
  - subconscious toggle
- Delivery/workload context:
  - unread for delivery list
  - queued signal
- Project/home summary:
  - V1 home status
  - managed projects summary

Advanced / Debug
- Full audit event table
- Supervisor runtime internals
- role/boundaries source file paths
- home/state/workdir/manifest paths
- raw technical/runtime fields

Re-grouping of current sections
- `Agent runtime & identity` splits into:
  - primary: health chips + identity summary
  - secondary: editable identity/settings
  - advanced: path/resume/server/model/args
- `V1 home & projects metadata` splits into:
  - secondary: editable human metadata + project summary
  - advanced: home/workdir/state/manifest technical fields
- `Unread for delivery` stays secondary
- `Latest evaluation` moves to primary
- `Supervisor runtime` moves to advanced/debug
- `Current task` moves to primary
- `Role & boundaries sources` moves to advanced/debug
- `Audit` becomes a dedicated history/debug area rather than a same-weight peer card


D. Proposed Layout

1. Sticky page header
- agent name
- 3 to 5 status chips
- one-line health summary
- primary actions on the right

2. Above-the-fold main stack
- Health strip
  - supervisor status
  - active/idle
  - intervention needed
  - unread count
  - queue count
- Current Work panel
  - current task
  - latest evaluation reason
  - last judged / last warning timestamps
- Recent Exceptions panel
  - only show when something is non-focused, blocked, or action-worthy
  - collapses to empty state when healthy
- Recent Events panel
  - last 5 high-signal events only

3. Secondary content under the fold
- Overview tab
  - delivery summary
  - project summary
  - ownership/context summary
- Settings tab
  - identity editor
  - owner/project scope/notes
  - subconscious toggle
  - save affordances
- Activity tab
  - unread list
  - recent event stream
  - audit summary cards
- Debug tab
  - supervisor runtime
  - paths/manifests/source files
  - raw technical fields
  - full audit table

Why this structure
- It creates one dominant narrative:
  - status -> work -> exceptions -> actions
- It separates "inspect", "edit", and "debug" instead of mixing them into equal-weight cards.
- It removes the current card-spam pattern where all information competes visually at once.

Above the fold
- Header with status chips and actions
- Current Work panel
- Exceptions/Intervention panel
- Compact recent events list

Above-the-fold content must stay unique
- `Current Work` is only shown above the fold.
- `Overview` must not repeat current task, latest evaluation reason, or the same recent-events narrative.
- `Overview` exists to summarize adjacent context:
  - unread/delivery state
  - queue/workload state
  - project ownership/scope summary
  - managed-project rollup

Below the fold
- tabs for Overview / Settings / Activity / Debug

Tabs / collapsible panels / drawers / modals
- Tabs:
  - `Overview`
  - `Settings`
  - `Activity`
  - `Debug`
- Collapsible panels inside tabs:
  - `Managed Projects`
  - `Unread For Delivery`
  - `Role & Boundaries Sources`
  - `Supervisor Runtime`
- Drawer:
  - optional right-side event detail drawer when clicking a recent event row
- Modal:
  - destructive confirmation for `Agent Down` and `Delete Agent`
  - not for routine editing

Key actions and placement
- Header actions are operational/navigation only:
  - `Back to Monitor`
  - `Agent Down`
  - `Delete Agent`
  - optional navigation into deeper history/debug
- Save actions are explicitly non-header and settings-scoped:
  - `Save Identity`
    - Settings tab, identity block only
  - `Save Metadata`
    - Settings tab, metadata block only
- `Agent Down`
  - sticky header action cluster, destructive secondary
- `Delete Agent`
  - sticky header action cluster, destructive tertiary
- `Jump to full audit history`
  - Activity or Debug tab, not in the top header
- `Back to Monitor`
  - page header, low emphasis


E. Wireframe

```text
+----------------------------------------------------------------------------------+
| Back to Monitor      Agent Detail: Yato                           [Down] [Delete]|
| [FOCUSED] [ACTIVE 2m] [NO BLOCKERS] [UNREAD 3] [QUEUE 1]                        |
| Healthy. Current task aligned. No immediate human intervention required.         |
+----------------------------------------------------------------------------------+

+--------------------------------------+-------------------------------------------+
| Current Work                         | Exceptions / Intervention                 |
| Current task: ...                    | If blocked/non-focused: show reason       |
| Latest evaluation: ...               | If healthy: "No intervention needed"      |
| Last judged: ...                     |                                           |
+--------------------------------------+-------------------------------------------+

+----------------------------------------------------------------------------------+
| Recent Events                                                                    |
| 10:32  supervisor judged FOCUSED                                                 |
| 10:29  unread message arrived                                                    |
| 10:18  metadata updated                                                          |
| [View activity history]                                                          |
+----------------------------------------------------------------------------------+

| Overview | Settings | Activity | Debug |

Overview
+--------------------------------------+-------------------------------------------+
| Delivery                             | Projects                                  |
| unread count + top items             | managed project summary                   |
| queue signal                         | owner + scope summary                     |
+--------------------------------------+-------------------------------------------+

Settings
+----------------------------------------------------------------------------------+
| Identity                                                                            |
| [ identity input.............................................................. ]  |
| [Save Identity]                                                                    |
|                                                                                   |
| Metadata                                                                           |
| [ owner input................................................................. ]  |
| [ project scope textarea...................................................... ]  |
| [ human notes textarea........................................................ ]  |
| [x] Claude subconscious enabled                                                   |
| [Save Metadata]                                                                   |
+----------------------------------------------------------------------------------+

Activity
+----------------------------------------------------------------------------------+
| Unread for Delivery                                                               |
| Recent important events                                                           |
| Audit summary                                                                     |
+----------------------------------------------------------------------------------+

Debug
+----------------------------------------------------------------------------------+
| Supervisor Runtime (collapsed by default)                                         |
| Paths / Manifest / Sources (collapsed)                                            |
| Full Audit Table                                                                  |
+----------------------------------------------------------------------------------+
```


F. Interaction Flows

1. Check whether the agent is healthy
- Open Agent Detail.
- Read the header chips first.
- Scan the one-line health summary.
- If non-focused or blocked, the Exceptions panel becomes the next stop.
- If more context is needed, use Activity for recent events or Debug for full audit.

2. Understand what the agent is doing right now
- Open Agent Detail.
- Read Current Work first:
  - current task
  - latest evaluation reason
  - last judged / warning times
- Check the Recent Events list to see the latest meaningful transitions.
- Only if the situation is unclear, move to Activity or Debug for deeper history.

3. Edit metadata safely
- Open Agent Detail and switch to Settings.
- Change identity and/or V1 metadata in clearly labeled form blocks.
- Dirty-state indicator appears immediately.
- Save one block at a time.
- On success:
  - inline success state
  - refreshed read model
  - no jump in page position
- On failure:
  - inline error on the same block
  - unsaved edits stay intact

Interaction-model principles
- Do not mix edit controls into inspection-heavy sections.
- Do not place save actions in the page header; header actions stay operational/destructive/navigation only.
- Do not expose raw file paths until the operator explicitly opens Debug.
- Use exception-driven emphasis:
  - healthy state is compact
  - blocked or drifting state expands visually
- Recent events should be curated, not a full table by default.
- One screen, one object:
  - every visible component should help explain this one agent.


G. Implementation Plan

Phase 1: Structural refactor
- Replace the equal-weight card grid with:
  - sticky summary header
  - current work / exceptions / recent events above the fold
  - tabbed lower section
- Keep current data sources and PATCH routes unchanged.

Phase 2: Move current content into the new IA buckets
- Promote:
  - current task
  - latest evaluation
  - intervention signals
- Keep unique above-the-fold:
  - current task / latest evaluation / recent-events narrative
- Define `Overview` as complementary only:
  - delivery summary
  - queue/workload summary
  - project/ownership rollup
- Demote to Debug:
  - supervisor runtime
  - role/boundaries source paths
  - manifest/home/workdir/state paths
  - full audit table
- Move editing controls fully into Settings.

Phase 3: Introduce interaction states
- Add dirty-state and save-state affordances per settings block.
- Add exception-first variants:
  - healthy
  - warning
  - blocked
- Add a curated recent-events list sourced from existing audit/event data.

Phase 4: Simplify content density
- Collapse verbose technical lines into expandable rows.
- Replace long repeated text with short summaries and "show more" affordances.
- Keep only 3 to 5 header chips.

Phase 5: Validation before any visual polish
- Verify the 5 user questions can be answered without entering Debug in normal cases.
- Verify edit flows remain coherent under auto-refresh.
- Verify blocked states are visually dominant when present.
- Verify the root monitor still works as a summary entry surface and Agent Detail remains the single management surface.

Recommended implementation order for the next coding batch
1. Header + above-the-fold restructuring
2. Tabs and content migration
3. Settings block consolidation
4. Event/history curation
5. Debug collapsibles
6. Final visual cleanup

Explicit stop boundary for this batch
- No UI implementation code yet.
- Wait for review and second-stage UI-spec / implementation direction first.
