# Round 3 review — codex

Final round, 2026-08-04. Verbatim.

Round 3 score: 8/10.

That is real progress, not generosity. The design now answers the seven page-level operator questions, distinguishes ACP/tmux/no-source Activity, preserves old monitor capabilities during migration, specifies failure/in-flight policy, provides an actual keyboard contract, and replaces the fake 34/100 precision with falsifiable tasks.

Page scores and remaining defects

Overview — 8.5. Severity and ordering are now legible, activity is usefully filtered, and migration sequencing prevents a big-bang replacement. Still missing: what clicking each counter/attention row does, how alerts/reminders/queue items are normalized into one ranked list, and the actual Queue view promised by the migration table. Reminder cancel/dismiss semantics are not specified.

Agent detail — 8. Activity sources are now honest. The ACP log-tail endpoint still needs a contract: allowed agent-name/path mapping, byte/event limit, log rotation/truncation, encoding, ordering, redaction, stale indication, and response shape. A raw service log is not equivalent to session activity; the UI must label it “agent log,” not imply complete work history. Oversight and Configuration content/action maps remain absent.

Alerts — 8. The core page remains strong, but the stats strip still mixes four lifecycle statuses with one severity metric, and the mockup’s selected row/detail mismatch remains. Both must be corrected because they encode contradictory state.

Tasks — 7. The lifecycle is fixed and empty state is honest, but a task system cannot be judged from an empty-state mockup. A populated blocked-first list, task detail, edit/comment/in-flight state, and explicit shared contract between Fleet Tasks and agent Work are still required.

Projects — 8. The fleet scope is now correct, but the mockup still says “0 groups” while rendering a selected group. It also claims all current project-board content survives without showing where graphs and detailed artifacts/issues go. State collapsed/below-fold/removed explicitly.

Capacity — 7.5. Clearer than Pool, but its existence is still conditional. Decide keep/retire before implementation. If kept, define the cell drill-down and reconcile orange 0/n with the “all busy” legend.

Config — 7.5. Blast radius and credential semantics are improved, but provider-global credentials appear to require backend/data-model work not covered in the change plan. Specify API, storage scope, migration, confirmation/result behavior, and that New Agent moves here.

Exactly what remains before 9

1. Reconcile the document into one authoritative design. This is still the largest blocker and was not fixed from Round 2:
- shell.active still includes queue and omits overview/capacity (line 155);
- “no new server work” conflicts with the new ACP log endpoint (173);
- breakpoints still hide names/state at 900px and claim fleet state survives (240–245);
- state diagram still models / as NoAgent monitor (255);
- re-parent table still puts Stop/Remove in the page header and text still defaults to Terminal (309–312);
- change plan still says Terminal and fold Projects under an agent (385, 388);
- invariants still speak only of terminal polling (404).
Until these are removed, an implementer can correctly follow the document and build the rejected Round 1 design.

2. Write the two missing agent-tab maps: Oversight and Configuration. For each section specify read-only facts, mutable controls, save boundary, source endpoint, and warning/destructive tier. This prevents two new “Internals” junk drawers.

3. Add one populated Tasks list/detail plate and define Fleet Tasks ↔ agent Work as the same canonical record/view with scope changed, not duplicated UI logic.

4. Correct the two mockup contradictions: Alerts selected row must match detail and status/severity summaries must be separated; Projects rail count must match the selected group.

5. Turn the monitor migration destinations into contracts:
- Queue needs a named route/view and must carry send/cancel feedback plus hover lock, pending guards, tombstones, restore-on-failure.
- Reminders need destination and cancel semantics.
- Message log cannot silently become Messages unless global log vs per-agent DM scope is explicitly mapped.
The table currently names destinations but does not prove capability preservation.

6. Specify responsive rail behavior beyond breakpoints, then validate it at 1/5/20/100 agents and 375/640/900/1440px. Requirements: Fleet nav remains reachable, Agents scroll independently, filter remains available, and compact mode never leaves indistinguishable unlabeled glyphs.

7. Complete the ACP log endpoint/security contract and add it to module/change/test plans. A user-controlled agent name must never become an unconstrained filesystem path.

8. Add page-specific acceptance assertions for the new state/accessibility contracts, then run the six benchmark tasks once against the current UI to establish a real baseline. The design has a protocol now; it does not yet have baseline evidence.

Items 1–6 are the threshold for 9/10. Items 7–8 can be completed in the same design pass and make implementation substantially safer. The fastest path is not another visual mockup cycle; it is a consistency edit, two content maps, one populated Tasks plate, and explicit migration/responsive contracts.
