# Round 5 — final score, claude

2026-08-04. Verbatim.

# Final — 9/10

I said in round 3: *"Do those nine and it is a 9."* You did the nine. I verified all nine against the file rather than the summary, and they are applied as described. The score is 9.

(Record, since it keeps drifting: I gave 6, 7, 8 — three scores, one per round.)

---

## Verified, not trusted

**The nine edits** — all confirmed at the line:

1. l.160 — `'overview' | 'agent' | 'alerts' | 'tasks' | 'projects' | 'capacity' | 'config'`. Seven. `queue` gone, `capacity` and `overview` added, with the reasoning left in the comment.
2. l.528 — step 3 now **moderate**, *"Activity needs the step-7 endpoint for ACP agents, so it is not a label change"*. Step 7 exists at l.532.
3. l.329 — Stop/Remove → *separated Agent actions block, below the panel*.
4. l.333 — *"`Activity` becomes the default instead of `Settings`."*
5. l.531 — step 6 keeps `/projects` as the fleet board, adds the per-agent Repos lens.
6. l.535–540 — the Pool claim struck and restated honestly, quoting lines 3–4 of `pool-page.js` and naming what round 1 actually did wrong (read the label, not the file). The reframing — *does anything dispatch from this view* — is the right question.
7. l.12–17 and l.517 — Overview at `/overview`, moves to `/` when the table completes, monitor as the table's last row. *"It is the default landing page throughout, so it must not become a half-migrated hybrid"* is the correct instinct and nobody asked for it.
8. l.247–259 — Fleet pinned in its own grid row, only `.rail-agents` scrolls; at 900px the rail narrows to 150px and drops `.tag` while **keeping** name and status. The comment owns the round-1 error out loud: *"Round 1 hid `.st` and then claimed 'fleet state survives' — it did not; only indistinguishable dots survived."*
9. l.564–575 — byte-identical fixed with its rationale, route-resolution added, three ARIA assertions added. The `getElementById` allow-list is a catch you made yourselves and the reasoning is right: `#rail-agents` is hydration-filled and `#action-notice` is runtime-created, so the bare form could never pass.

**Three claims I checked against the filesystem, all true:**

- **The TaskDTO matches `task-store` exactly.** All 19 fields the doc lists — `id, title, description, status, priority, granularity, assignee, created_by, created_at, updated_at, started_at, completed_at, heartbeat_at, waiting_reason, waiting_until, parent_id, labels, health, comments` — are present in `lib/task-store.js`. None invented, none missing.
- **`page-agent-detail.jpg` is drawn from the real log.** The mockup's `tools check_inbox [completed], send_message [completed]` / `turn finished (end_turn)` / `agent PARITY2` at 01:22:19–21 corresponds to the actual bytes in `agent:octos-agent.log`. `PARITY2` is real content. The `12 lines of framework output` disclosure handles the interleaved host tracing I flagged, ANSI stripping is stated, and `Refresh: 3s` replaces the pane-polling `10/sec`. After three rounds of mockups drawn against data models that did not exist, this one is checkable and checks out.
- **The `active` list matches the registered routes**, with the one exception in item D below.

**Codex's four**, all integrated as claimed. Two are better than what I proposed:

- **The ACP endpoint contract** is the best-specified section in the document. Inventory resolution so no path is constructed for an unregistered name, `O_NOFOLLOW` plus `realpath` re-verification *after* open, a server-issued authenticated cursor so a client cannot author an offset, rotation vs truncation as distinct reset reasons with replace-not-append semantics, partial trailing lines withheld, sanitising before budgeting, and `200 + state:empty` rather than an error for a missing log. The labelling rule — *"Agent log… not a complete work history"* — is unusually honest for a spec.
- **The shared `TaskDTO`** is the best answer to a naming complaint in five rounds. I asked you to rename `Work` to `Tasks`. You did something better: made `Work` a *scope* of Tasks, enforced by one DTO, one renderer, and contract tests asserting identical output for both scopes. That converts a vocabulary argument into a code invariant, which is the only durable form of the fix.
- Seven tabs with the governing rule *"Oversight is read-only; controls must not sit beside the evidence used to judge them"* — a real principle, not a relabel. Splitting Subconscious into controls (Runtime) and status (Oversight, *Guidance path status*) is the correct cut, and declaring Supervisor Audit and Audit History two views of one collection properly retires round 1's "duplicate" as a measurement artifact.
- Alerts: two strips, one dimension each, `resolved` restored, severity scoped to the open set. That last choice is what dissolves my round-2 objection — a red row in the open list is now necessarily counted.

---

## What still stands

Ten items. None is a design flaw; all are artefacts of editing a long document by insertion, plus one miss.

**A. One of the two unpassable tests I named is still there.** l.573: *"No tab panel is under 500 chars, and none exceeds 60% of the page."* I flagged this in round 2 and again in round 3. Activity is a client-hydrated container fed by the step-7 endpoint, so its server-rendered template is a near-empty `<div>` and it fails the 500-char floor the day it ships. You fixed byte-identical (which I named) and `getElementById` (which I did not — your own catch) and left the one I named twice. The brief says both were fixed; one was not.

**B. Edit 7 left two off-by-one counts in its own section.** l.507 — *"owns **five** live surfaces"* — the table now has seven rows. l.517 — *"until the **seven** rows above ship"* — there are six above it.

**C. Module structure never learned that Overview exists, and this is the one real implementation question left.** The mermaid at l.135 still says *"7 app.get handlers"*, shows seven renderer nodes with no overview node, and still has `M["monitor-page.js"]` feeding a body. Constraints l.105/108 still say "7 pages / 7 `app.get` handlers". During migration there are **eight** routes — the seven plus `/overview` — and step 1 (l.526) still says *"wrap all 7 routes"*. Nothing states where `renderOverviewPage()` lives: a new file, or a second export from `monitor-page.js`. Everything else in this document is specified to the line; this is the one thing an implementer would have to invent.

**D. Capacity's href is unstated, and your new route test lands exactly on it.** The `active` key is `capacity`; the registered route is `/pool`. The test at l.566 — *"every rail destination resolves to a route registered in `page-routes.js`"* — is the right test and will fail or be ambiguous here unless the doc says whether the rail links `/pool` under the label Capacity, or the route is renamed to `/capacity`. One sentence.

**E. The Rail DOM contract is now the stale section, third round running.** l.227 still shows a bare `<span class="pill hot">9</span>` and l.239 still says *"Counts always rendered — `Tasks 0` / `Projects 0`"*, while §Alerts l.419 specifies `9 open` and all five regenerated mockups show `9 open` / `0 open` / `0 groups`. The contract also has no Overview or Capacity destinations, and the new selectors `.rail-agents` / `.rail-fleet` (l.249–250) appear nowhere in it — the contract has `id="rail-agents"` on a `<ul>` and an unclassed Fleet `<ul>`. CSS and contract disagree.

**F. `.rail` is declared twice, l.245 and l.248.** The first still sets `overflow-y:auto` on the whole rail — the exact behaviour the pin exists to prevent. Merge them, or the pin is defeated by its own predecessor two lines up.

**G. The `Repos` half of the naming fix was not applied.** §Populated Tasks settles `Work` with a shared DTO, a shared renderer and contract tests. Step 6 gives `Repos` the *identical* relationship to `/projects` — a per-agent lens on a fleet board — with a different name and none of that treatment. The document proves it knows the pattern and then declines to apply it one section later.

**H. Two cross-references broke when rows were inserted.** l.577 — *"The last three are a new kind of guard"* — now points at the 500-char test, the label allow-list and dirty-form preservation, and dirty-form is a *behaviour* guard, not an IA property. And the Dissolving-Internals mermaid at l.303–306 still shows `AFTER = Configuration / Oversight / Repos` — the six-tab world — directly above the table that splits `Configuration` and says the count goes to seven.

**I. The change plan's sequencing contradicts its own re-risking.** l.534 still says *"Steps 1–3 ship together as one reviewable change"*, but step 3 is moderate precisely *because* it depends on step 7. Either 7 moves ahead of 3, or 3 ships tmux-only with the ACP empty state and says so. Same sentence: *"Steps 5–6 need a product decision first"*, but step 5 is now `low` and is just a rename — only the retire question needs a decision.

**J. Two gaps in the ACP contract, proportionate to how good the rest of it is.** Redaction is by **key name**, and the real log carries free-text agent output — I read `agent: Tokyo` and raw curl error text in it. A secret pasted into a message body, or an env dump in command stdout, has no key to match. Say explicitly that key-name redaction is not content redaction. Second: the contract never states **who may read the endpoint**. It exposes inter-agent message text — `agent: PARITY2` in your own mockup is message content — and every other property here is specified to the byte. One line on authorization.

Not credited, as instructed: the alerts and projects mockup defects, undrawn populated Tasks, the undesigned queue view, untested responsive behaviour, the estimated benchmark baseline. Cosmetic and unlisted: five mockups now carry rail icons and two do not, being the two not regenerated.

---

## What 10 needs

Items A, C, D and E — the unpassable test, where Overview's renderer lives, Capacity's href, and the rail contract. Those four are the ones that would actually stop or mislead an implementer; B, F, H and I are five minutes of copy-editing.

Then two from your own open list, and only two matter:

- **Draw the queue view.** It is a destination in the migration table (l.512) with no route, no mockup and no body — the last undesigned surface the plan depends on.
- **Measure the benchmark's `today` column.** The document sets the standard itself: *"A design change is justified when it moves a number here."* With an estimated baseline, nothing can be shown to have moved. One session with one operator against today's dashboard converts the whole benchmark from a proposal into an instrument.

The rest — the two mockups, populated Tasks drawn, responsive tested — are worth doing and none of them changes a decision.

**What earned the 9:** verifying the log claim before building on it, choosing a bounded file read over a protocol surface, making `Work` a scope rather than a rename, keeping `/` on the untouched monitor so no route changes twice, and correcting round 1's Pool claim by quoting the file instead of defending the position. Five rounds in, the document's factual claims now survive checking. That is the thing that changed.

*(No files were edited.)*
