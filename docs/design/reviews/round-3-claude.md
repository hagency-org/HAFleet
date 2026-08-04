# Round 3 review — claude

Final round, 2026-08-04. Verbatim.

# Round 3 — 8/10

Up from 7. (Score history, for the record: I gave 6 in round 1 and 7 in round 2 — two scores, not four.)

This is the strongest round. Four new sections, each answering a specific standing objection, and one claim that is the first in three rounds to survive verification against the filesystem. It is not a 9 for one reason, and it is the same reason as round 2.

---

## Verified, and credited

**The Activity source table is true.** I checked it rather than reading it:

```
-rw------- 189023 Aug 3 18:22 data/services-local/logs/agent:octos-agent.log
```

189,023 bytes — your "189 KB for octos", exact. And the content is what you say it is:

```
[2026-08-01T20:02:33.497Z] turn finished (end_turn); delivered 1 message(s) so far
[2026-08-04T01:22:21.950Z]   tools: check_inbox [in_progress], call [completed], send_message [in_progress]
[2026-08-04T01:22:21.951Z]   agent: PARITY2
```

Turn boundaries, tool names, agent output. Three rounds of mockups drawn against data models that did not exist — the ACP terminal pane, the ACP session stream, Capacity's 4×4 axes — and this one checks out. The reasoning behind it is also right: choosing a bounded file read over exposing `session/update` from a host that runs no HTTP server is the correct trade, and you found it by verifying rather than assuming.

The sharpest thing in this round is one you caught yourself: **`Refresh: 10/sec` must not render for an ACP agent, because it was pane-polling.** Nobody flagged that. It is exactly the class of detail — a control whose label survives the removal of the thing it controlled — that the whole review has been about.

Also credited, all verifiable in the document:

- **Task lifecycle** as a branching state machine with `blocked → in_progress` returning. Correct model, correctly drawn.
- **Overview mockup regenerated**, and all four round-2 defects are fixed: severity words match their dots (critical/red, warning/amber, info/grey), rows sorted most-severe-first with a `sorted by severity` label, the rail highlights Overview rather than an agent, and Recent activity is `errors and state changes only` with the heartbeat noise gone.
- **States table** — seven pages × four states. The two rules carry it: *a failed refresh keeps the last good data and marks it stale*, and *no destructive action is optimistic*. The Projects row is the best line in the table — "one dead section must not blank the board" is precisely the failure mode of an eight-section page fed by one endpoint.
- **Accessibility contract** — this is a real spec, not `role="tab"` theatre. Roving tabindex with Home/End, `aria-selected` + `aria-controls` + `aria-labelledby`, hash and Back behaviour, one `role="status"` region rather than scattered live regions, and no `outline:none` without a replacement.
- **Benchmark** — six timed tasks with a today-column and a target, three operators, median of three. "A design change is justified when it moves a number here" is the right standard. Task 6 is well chosen: *what is a queued message waiting for* is the question the old `SEND NOW` label made unanswerable.
- **Monitor migration** — the six-row table homes every surface, and the sequencing rule is genuinely good engineering: `/` keeps rendering the monitor, Overview lives at `/overview`, the rail links `/overview` from day one **so no route changes twice**. That last clause is the kind of thing that only comes from thinking about the migration rather than the destination.

---

## Why it is not a 9

**The specification half is stale for the third round running, and this round it got worse.**

Round 2 I wrote: *"Rewrite lines 85–323 to match lines 1–83. One editing pass, no new thinking. This is the single highest-value edit available."* It was item 1 of six. Items 2–6 are all done or in progress. Item 1 has not been touched.

Everything below §Module structure is still round-1 text. So the document now says, of itself:

| the new sections say | the old sections still say |
|---|---|
| Activity, not Terminal (l.20); ACP needs a new endpoint (l.39) | change plan step 3: "default to **Terminal**… **risk: low** — labels, hash values, ARIA" (l.385); "`Terminal` becomes the default" (l.312) |
| Stop/Remove exiled to an Agent actions block (l.23); "agent detail's block is the only one" (l.374) | "System Controls (Stop / Remove) → **page header**, beside the agent name" (l.309) |
| Projects: "All of it survives" (l.82) | change plan step 6: "**Fold `/projects` under an agent**" (l.388) |
| Capacity, axes explained (l.84–88) | "`POOL` … **its purpose is not evident from the label or the file**" (l.391) — false since round 1; lines 3–4 of `pool-page.js` state it |
| **Overview lives at `/overview`; `/` keeps rendering the monitor** (l.376) | **"`/` — Fleet overview *(new; did not exist)*"** (l.12) |

The last row is new this round — **the fix introduced a fifth contradiction.** And the same fix exposed a structural consequence the document does not address: with `/` still the monitor, **"The seven pages" is now eight surfaces**, and the eighth — 1,950 lines, the page an operator lands on by default for the entire migration period — is the one with no designed body. Round 2's monitor objection is answered for *destinations* and reopened for *design*.

Three more things the round-3 additions created and did not close:

- **`active` union, l.155, regressed.** Still `'agent' | 'alerts' | 'queue' | 'tasks' | 'projects' | 'config'`: six values for what is now eight surfaces. It still contains `queue`, still omits `capacity`, and now also omits `overview` — a route this round invented.
- **"a queue view" (l.370)** has no route, no mockup, no body, and is not one of the seven. The Queued-delivery card links to it.
- **Reminders → Overview "Needs attention, reminder rows" (l.371)**, but that table's columns are SEVERITY / WHAT / AGENT / AGE and a reminder has no severity. Unspecified how it slots in.

And the collapse CSS is untouched for the third round: l.240 still hides `.st` — the durations that are benchmark task 1, your own ≤10s target — still omits `.tag`, under a comment at l.239 that still reads `/* the terminal needs width more than the rail does */` for a terminal this design no longer has.

**The Tests section does not know the new sections exist.** Eight assertions, unchanged since round 1. Two still cannot pass (byte-identical rail contradicts `aria-current`; the 500-char floor kills a client-hydrated Activity panel). Nothing asserts the States table, nothing asserts the accessibility contract — which is the most testable thing in the document (tablist present, exactly one `aria-selected="true"`, exactly one `tabindex="0"` in the tab set, every `aria-controls` resolves) — and nothing asserts the migration invariant that `/` still renders the monitor. The route-resolution test I asked for twice, which catches the `queue`/`capacity`/`overview` enum bug in milliseconds, is still absent.

---

## One residual on the ACP source

The source is real; the *reading* of it is under-specified in three cheap ways, all visible in the bytes:

1. **It carries ANSI escapes.** The log captures the host's tracing, so raw content includes `…[2m=[0m3 [3mmessages[0m…`. You specify freshness, byte cap and truncation marker — add stripping, or the panel renders escape garbage.
2. **It is a service log, not a session transcript.** Interleaved: `acp session open:` for multiple session IDs, host `INFO connection:` tracing lines, and agent output. A last-N-bytes tail returns the mixture, not the clean stream.
3. **Therefore `page-agent-detail.jpg` is now the stale one.** It was not regenerated (mtime unchanged), so it still shows `tool_call list_sessions {}` and `read_stream {"session_id":"9f3b2c1d","limit":200}` — call shapes from the invented API. The source became real; the picture of it did not.

Minor, worth one line in the spec: the log contains delivered message text (`agent: Tokyo`, DM replies). A read-only endpoint over it exposes inter-agent message content. Not a new class of exposure — the dashboard already shows panes — but say so deliberately rather than by accident.

Cosmetic: the rail now differs across four regenerated mockups and three not — Overview/Tasks/Projects/Config have icons, agent-detail/Alerts/Capacity do not.

Not credited, per your instruction: Oversight and Configuration content maps, the alerts stats strip mixing status with severity, the alerts stale selection, Projects' "0 groups", populated Tasks, responsive testing.

---

## Exactly what remains before 9

One editing pass. No new design work, no new mockups. Nine edits:

1. **l.155** — `active`: eight values, drop `queue` or give it a route, add `capacity` and `overview`.
2. **l.385, step 3** — "default to **Activity**"; risk **moderate**, not low, because l.39 says it needs a new endpoint. Split the ACP read endpoint out as its own step.
3. **l.309** — Stop/Remove → *Agent actions block*, matching l.23 and l.374.
4. **l.312** — "`Activity` becomes the default instead of `Settings`."
5. **l.388, step 6** — replace with "keep `/projects` as the fleet board," matching l.82.
6. **l.391** — strike the claim that Pool's purpose is not evident from the file; it is in lines 3–4 of `pool-page.js`. Restate step 5 as the real open question: does anything dispatch from it.
7. **l.12** — say Overview is at `/overview` during migration and moves to `/` when the l.367 table is done. Then add the monitor as the eighth surface with a one-line statement of what it looks like meanwhile, since it is the default landing page throughout.
8. **l.239–240** — delete the stale terminal comment; stop hiding `.st`; add `.tag` to the hidden set. Pin the Fleet nav, which l.237 still does not do.
9. **Tests** — fix the two that cannot pass, add *every rail destination resolves to a registered route*, and add three one-line assertions for the contract you just wrote: tablist present, exactly one `aria-selected="true"`, exactly one `tabindex="0"` per tab set.

Do those nine and it is a 9. Also regenerate `page-agent-detail.jpg` against the real log format and add ANSI-stripping to the source spec — that is the only mockup still showing invented data, and it is the default tab of the main page.

Between 9 and 10 is the list you already have: the two content maps, the alerts strip and its stale selection, Projects' `0 groups`, populated Tasks, responsive tested at real fleet sizes — plus designing the queue view that l.370 links to, and running the benchmark once to get the *today* column from measurement instead of estimate.

**Do not touch:** the Activity source table, the `Refresh: 10/sec` exclusion for ACP, the branching lifecycle, the two state rules, the roving-tabindex contract, the six benchmark tasks, and the sequencing rule that keeps `/` on the monitor so no route changes twice. That last one is the best decision in the document.

*(No files were edited.)*
