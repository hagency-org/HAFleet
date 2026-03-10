1. Final screen layout

- Sticky header
  - back link
  - agent name
  - 3 to 5 status chips
  - one-line health summary
  - operational actions only: `Agent Down`, `Delete Agent`
- Exception banner
  - only visible when the agent is blocked, drifting, stuck, or otherwise needs attention
- Above-the-fold main row
  - `Current Work`
  - `Intervention`
- Above-the-fold secondary row
  - `Recent Events`
- Tabbed lower section
  - `Overview`
  - `Settings`
  - `Activity`
  - `Debug`

2. Section-by-section purpose

- Sticky header
  - answer "is this agent healthy right now?" in under 2 seconds
- Exception banner
  - make urgent blocked/non-focused conditions impossible to miss
- Current Work
  - answer "what is it doing right now?"
- Intervention
  - answer "does a human need to do something?"
- Recent Events
  - answer "what changed recently that matters?"
- Overview
  - complementary context only:
    - delivery summary
    - queue/workload summary
    - project/ownership summary
- Settings
  - safe editing surface for:
    - identity
    - owner
    - project scope
    - human notes
    - subconscious toggle
- Activity
  - operational history without raw internals:
    - unread delivery list
    - richer event stream
    - audit summary
- Debug
  - raw read-only diagnostics:
    - supervisor runtime
    - paths/manifests/docs sources
    - full audit table

3. Visual hierarchy rules

- One dominant surface first:
  - header and current work must visually outrank everything else
- Alert first:
  - blocked or non-focused state gets a high-contrast banner before all lower-priority content
- Editing vs read-only must look different:
  - editable blocks use clear input surfaces and save buttons
  - diagnostics use muted read-only containers and monospace values
- Debug should recede:
  - lower contrast
  - collapsed by default where possible
  - positioned behind a dedicated tab
- Avoid card spam:
  - group related signals into fewer, larger sections
  - do not expose every data source as a peer card

4. Component list

- `AgentDetailHeader`
- `StatusChipRow`
- `HealthSummaryLine`
- `ExceptionBanner`
- `CurrentWorkPanel`
- `InterventionPanel`
- `RecentEventsPanel`
- `TabBar`
- `OverviewDeliveryPanel`
- `OverviewProjectsPanel`
- `SettingsIdentityPanel`
- `SettingsMetadataPanel`
- `ActivityUnreadPanel`
- `ActivityTimelinePanel`
- `DebugRuntimePanel`
- `DebugPathsPanel`
- `DebugAuditTable`
- `ConfirmModal`
- `InlineSaveStatus`

5. Empty / error / blocked / loading states

- Loading
  - show low-motion skeleton text blocks in header/current work/tabs
  - do not show empty cards full of `Loading...`
- Healthy / empty
  - `No intervention needed`
  - `No recent critical events`
  - `No unread messages`
- Warning / blocked
  - red or amber exception banner
  - intervention panel explicitly names the issue and likely next step
- Error
  - localized panel errors where data failed
  - preserve rest of page if one source fails
- Save error
  - inline under the edited block
  - unsaved edits remain intact

6. Copywriting suggestions for labels

- Page title: `Agent Detail`
- Header summary:
  - healthy: `Healthy and aligned with current task.`
  - idle but okay: `Stable, but currently idle.`
  - warning: `Attention needed: recent supervision signals are negative.`
  - blocked: `Human intervention likely required.`
- Section labels:
  - `Current Work`
  - `Intervention`
  - `Recent Events`
  - `Delivery Summary`
  - `Project Context`
  - `Identity`
  - `Metadata & Runtime Settings`
  - `Activity`
  - `Debug`
- Buttons:
  - `Save Identity`
  - `Save Metadata`
  - `Agent Down`
  - `Delete Agent`
  - `View Full Audit`

7. Interaction details for edits, save actions, and drill-down

- Edit interactions
  - all save actions stay inside `Settings`
  - dirty-state message appears as soon as a field changes
  - save one block at a time
  - success and error states are inline and local to the edited area
- Auto-refresh handling
  - if settings are dirty, the page preserves draft inputs and does not overwrite them on background refresh
  - successful save triggers a controlled refresh of the underlying data
- Drill-down
  - click a recent event to switch to `Activity` or `Debug` depending on depth needed
  - `#audit` deep-link should open the `Debug` tab and reveal the full audit table
- Destructive actions
  - use a modal confirm
  - success returns user to monitor when appropriate

8. Implementation mapping for this repo

- The accepted design will be implemented in the current `server.js` inline HTML/CSS/JS stack.
- No React/Tailwind rewrite should be introduced for this repo phase because it would be architectural churn unrelated to the accepted frontend task.
- Existing routes and save flows remain the contract:
  - `PATCH /api/agents/:name`
  - `PATCH /api/agents/:name/home-metadata`
  - existing supervisor/detail/unread routes
