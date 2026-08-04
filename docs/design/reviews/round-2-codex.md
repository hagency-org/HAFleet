# Round 2 review — codex

Requested 2026-08-04, after all seven pages were designed. Verbatim.

Round 2 score: 7/10. This is materially better than 5: every top-level destination now has an operator question and a proposed body. It is not yet an implementable 9 because the document is internally contradictory and several mockups cover only the happy/empty state.

Page scores

Overview — 7/10. The four counters + ranked attention + activity finally answer the fleet question. But the fate of the old monitor surfaces is still undefined: queued delivery gets a number but no queue body/action; reminders, message log, New Agent, manual send/cancel, and their concurrency machinery have no destination. “Needs attention” also lacks row destinations/actions and source/dedup rules. The mockup’s severity column says “info” on every row while using blue/orange/red dots, so label and encoding disagree. Remedy: an explicit old-surface migration table and click/action contract for every overview row/card.

Agent detail — 7/10. Activity and “ACP · no pane” are correct improvements; destructive actions are properly separated. But Activity’s normalized event model is not specified across ACP, tmux, and absent streams. “Refresh 10/sec” still appears for ACP, although the old 10 Hz control was pane polling. Oversight remains a large supervisor + subconscious + LLM-control bundle, and Configuration remains a broad settings + roles + migration bundle. Only Activity is drawn; non-happy no-stream and the other five tab layouts are asserted, not demonstrated. Remedy: define event source/freshness/empty behavior per transport and a content/action map for all tabs.

Alerts — 8/10. Best page: clear stats, filters, master/detail, legal actions. Mockup bug: “High task failure rate” is selected but detail shows “Agent heartbeat missing”; that is exactly the stale-selection class of bug a design should prevent. “Critical” is severity while the other four cards are statuses, and resolved is omitted, mixing dimensions in one strip. Remedy: separate status and severity summaries; specify URL selection, refresh preservation, and visible transition feedback.

Tasks — 6.5/10. Good honest empty state and denominator, but it designs only zero tasks, not the normal list/detail/edit/comment state. The lifecycle strip is wrong: it depicts blocked as a mandatory linear step before done. Actual state is created→accepted→in_progress→{blocked,done}, blocked→in_progress. It also does not settle whether agent Work and fleet Tasks share one renderer/data contract. Remedy: draw a populated blocked-first view and task detail; show the branching state machine and cross-link/scoping contract.

Projects — 8/10. Correctly preserves fleet/project-group scope and gives strong at-a-glance hierarchy. But “all survives” is not evident: graphs and detailed artifacts/issues are absent from the mockup, and the rail says “0 groups” while a group is selected. The board is extremely dense and responsive behavior is unspecified. Remedy: state what is below the fold/collapsed vs removed, reconcile sample counts, and define narrow layout for five lanes + side column.

Capacity — 7/10. Renaming and explanation work. But the product decision remains unresolved, so implementation could polish a page slated for deletion. Legend says “all busy” gray while the matrix uses orange for 0/2; “not supported” vs zero capacity needs explicit semantics. “Click a cell” has no designed result. Remedy: first prove a consumer; if retained, design the cell drill-down, freshness, and empty/error state. Otherwise remove route and rail item.

Config — 7/10. Blast-radius grouping and blank-means-unchanged are strong. But this appears to invent provider-global credential storage beyond the existing preset API; no data/API/migration contract is stated. Delete buttons for presets and Stop/Remove for every agent need confirmation, dependency impact, and in-flight/result states. New Agent has moved here, but the document never explicitly says so. Remedy: specify current API reuse vs backend change, credential scope, confirmation copy, and migration of New Agent.

Cross-cutting defects that cap it at 7

The top was revised; the low-level spec was not. shell.active still includes queue and omits overview/capacity (dashboard-relayout.md:117); the state diagram still calls / “NoAgent monitor” (217); CSS still says “terminal” and collapses at 900px to anonymous glyphs, falsely claiming fleet state survives (199–207); the re-parent table still moves Stop/Remove into the header (271); the text still says Terminal default (274, 282); the plan still proposes folding Projects under an agent (286); invariants still preserve terminal polling (301). These are not editorial nits—they instruct implementation to undo Round 2 decisions.

The rail still has the Round 1 responsive failure: at 64px it hides name and state, and below 640px it stacks every agent ahead of content. “Pinned Fleet nav” and agent filter appear in images but are not specified in the DOM/CSS behavior. No fleet-size limits or separate agent-scroll region are defined.

Typography is over-specified relative to interaction: adding two font families/weights/assets before loading, errors, focus, keyboard, and responsive behavior is backwards. Also verify the exact “Open Sans SC” font artifact/license/name rather than assuming it exists as specified.

Shortest path to 9/10

1. Do one ruthless reconciliation pass: update shell API, route/state diagram, breakpoints, re-parent map, plan, invariants, and tests so no Round 1 decision remains. Add a 7-route × old-surface migration matrix. This is the highest-payoff step.
2. Add three state sheets, not dozens of mockups: populated Tasks/detail; Overview with queue/reminder/New Agent actions; Agent Activity for ACP, tmux, no-stream/error. Define loading/error/stale/in-flight feedback in text for every page.
3. Specify the responsive/rail contract at 1/5/20/100 agents and 375/640/900px: Fleet nav pinned, Agents independently searchable/scrollable, never glyph-only without accessible identity.
4. Write the minimum interaction contract: data source, URL state, primary row click, destructive confirmation, focus restoration, live result notice, keyboard/ARIA for rail/tabs/master-detail.
5. Add one acceptance scenario per page and five timed operator tasks. Full test implementation can follow, but the design needs falsifiable success criteria.

Complete 1–4 and this is 9/10 even before polished error-state artwork. Without the reconciliation pass, implementation will be forced to choose which half of the document is authoritative.
