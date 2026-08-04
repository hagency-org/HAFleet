# Round 5 — final score, codex

2026-08-04. Verbatim.

Final score: 8.5/10.

This is now a coherent product direction and a credible implementation design. It earns the half-point above 8 because the content architecture, task contract, accessibility behavior, failure policy, monitor migration, and transport-specific Activity source are no longer hand-waving. It does not earn 9 while several visible contradictions and two implementation contracts remain unresolved.

Verified as fixed

- shell active values now name overview, agent, alerts, tasks, projects, capacity, config; queue is gone.
- Step 3 is moderate and Activity defaults correctly; Step 7 owns the ACP endpoint.
- Stop/Remove goes to the separated Agent actions block.
- Projects remains fleet-scoped with a per-agent Repos lens.
- Capacity’s real question is correctly stated as whether anyone dispatches from it.
- Rail keeps name/status at 900px and pins Fleet navigation separately.
- Profile/Runtime/Oversight mapping is substantially better; Oversight is explicitly read-only.
- Alerts and Tasks specifications are dimensionally/canonically correct in prose.
- ARIA and task-contract tests were added and the impossible byte-identical/DOM-ID assertions were repaired.
- Agent-detail and Overview mockups reflect the revised Activity and severity decisions.

What still stands before 9

1. Correct the two stale mockups. Alerts still shows the rejected mixed strip—Open, Acknowledged, Assigned, Suppressed, Critical—rather than separate Status and Severity strips, omits Resolved visually, and highlights “High task failure rate” while detail shows “Agent heartbeat missing.” Projects still says 0 groups while acme-platform is selected. These are not cosmetic: the drawings contradict the normative spec an implementer will follow.

2. Draw one populated Tasks list/detail state. The prose is now good enough to implement, but the only visual is the empty page. The drawing must prove blocked-first hierarchy, Waiting/heartbeat density, master/detail behavior, legal-transition-only actions, and narrow-screen replacement.

3. Design the Queue destination. The migration table promises “a queue view” but gives it no route, layout, empty/error state, send/cancel consequence copy, or action-feedback flow. This is the last major monitor capability without an actual destination design. Also specify reminder cancel/dismiss behavior and whether moving global message log into per-agent Messages changes scope.

4. Resolve the temporary route/shell model. During migration, existing / plus new /overview yields eight routes, not the seven claimed by shell.active and Step 1. The monitor is an eighth route temporarily, yet active has no monitor value. Specify whether / is wrapped by the shell, which rail item is aria-current there, and change Step 1/tests to “eight during migration, seven after cutover.” Otherwise the sequencing rule cannot be implemented without inventing behavior.

5. Restore the full ACP endpoint contract, or explicitly declare the shorter section normative. The document includes traversal-safe mapping, cursor/reset, basic sanitization and caps, but the delivered specification also required:
- dashboard authorization/agent visibility;
- limit range and hard response behavior;
- cursor expiry and partial-line behavior;
- full response schema/freshness fields;
- Cache-Control, ETag/304 and nosniff rules;
- broader redaction for Bearer/Basic, private keys, URL userinfo/query secrets, known token prefixes, and exact configured secret values;
- no raw bypass.
Those details are security and interoperability requirements, not optional elaboration. The current “no new server work” sentence in Render sequence also contradicts Step 7 and must become “no new server work for rail hydration.”

6. Validate responsive behavior rather than merely naming breakpoints. Test 1/5/20/100 agents at 375/640/900/1440 px. Confirm Fleet nav stays reachable, agent filtering remains usable, names/status do not become ambiguous, tabs fit or scroll, Tasks master/detail changes mode, and Projects’ five lanes remain navigable.

7. Measure the benchmark baseline with the stated three-operator/median-of-three protocol. Estimated “today” values are acceptable for a draft, not evidence that the relayout improves the named tasks. At minimum record baseline median and errors before implementation; then retain the targets as acceptance gates.

8. Add page-level acceptance tests for state retention and action semantics, not only structural shell/ARIA checks: stale-on-refresh, non-optimistic destructive actions, selected alert/detail identity, legal task transitions, identical Fleet Tasks/agent Work rendering, queue concurrency preservation, dirty-form preservation, and ACP rotation/truncation/redaction.

Shortest path to 9: fix the two mockups, add populated Tasks and Queue plates, resolve the 8→7 route transition, restore the endpoint’s omitted contract clauses, and document one responsive validation matrix. The measured benchmark and expanded behavioral tests should then be implementation gates, not another visual-design round.
