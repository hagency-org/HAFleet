# Round 4 — codex design deliverables

Requested 2026-08-04: content maps, ACP log endpoint contract, alerts strip, populated Tasks. Verbatim.

DESIGN SPECIFICATION

1. AGENT-DETAIL CONTENT MAP

Replace Configuration with two tabs, Profile and Runtime. Final agent tabs: Activity, Work, Messages, Repos, Profile, Runtime, Oversight. Oversight is read-only; controls must not sit beside the evidence used to judge them.

Profile — operator question: Who is this agent, who owns it, and what intent should it follow?

Order:
1) Identity — name/description and immutable identity facts.
2) Guidance — human-authored intent; retain dirty-form preservation.
3) Ownership — owner, escalation/contact and groups.

One Save profile boundary covers these three, with dirty and last-saved states. Do not put framework/model, roles, automated controls, audit evidence, migration or presets here.

Runtime — operator question: How is it launched, and which automated systems shape its behavior?

Order:
1) Effective runtime (rename current Configuration): framework, transport, server, model, reasoning, workspace/home; effective values first.
2) Framework preset: show the applied preset and resolved values. Link to fleet Config for global preset CRUD.
3) Roles: Primary Role, then Supervisor Role; show desired versus effective values when different.
4) Supervisor control: enable/cadence/policy controls only.
5) Subconscious Control: desired state and authoritative/fallback mode.
6) Subconscious LLM: provider, model, endpoint, key-env reference and resolution status; never reveal secrets.
7) Workspace Migration: last, collapsed, marked disruptive, with preview, confirmation and outcome.

Save by subsystem: runtime/preset/roles; Supervisor; Subconscious/LLM. Migration is an action, never a save field. Do not put signals, audit/history, Stop/Remove or global preset management here.

Oversight — operator question: Does this agent need intervention, what evidence supports that, and what did oversight do?

Order:
1) Current assessment: Supervisor Signal, severity, reason, lifecycle, evaluated-at, freshness and recommended action. Disabled/stale state precedes history.
2) Current work evidence: Supervisor Docs Snapshot, source/time, with an explicit warning that it is not the canonical Task.
3) Guidance path status (rename Subconscious): read-only active path, stage, last invocation/injection and degraded/missing pieces. Link Configure to Runtime; no toggles here.
4) Recent supervisor decisions: Supervisor Audit, newest first.
5) Audit History: filterable full history.

Supervisor Audit and Audit History are two views of one canonical event collection, not duplicates. Raw AGENTS.md/plan/progress and runtime/path dumps belong in a collapsed Diagnostics drawer under Runtime or are omitted. Stop/Remove remain in the separate Agent actions block.

2. ACP AGENT-LOG ENDPOINT

Route:
GET /api/agents/:name/activity-log?limit=200&cursor=OPAQUE

Authorization: same dashboard authentication and agent-visibility policy as agent detail. Limit is logical lines, default 200, range 1–500. Hard sanitized response budget is 128 KiB; stop at either cap and report truncated. No path, filename or raw offset request parameter exists.

Safe mapping:
- Decode name once. Reject NUL, slash, backslash, dot segments, controls, or names outside ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$.
- Resolve against the registered-agent inventory; unknown is 404. Never construct a path for an unregistered name.
- Construct exactly agent:CANONICAL_NAME.log below the configured absolute log root.
- Open only a regular non-symlink. Use O_NOFOLLOW where supported; verify realpath(file) remains under realpath(root) plus path separator after open/stat. Never return the host path.
- Missing log for a known agent is HTTP 200 with state empty and reason log_not_found. Read failures are sanitized and leak no paths.

Cursor/rotation:
- Cursor is server-issued authenticated base64url state: version, device, inode, next offset, prior size. Clients cannot author offsets; expiry 24h.
- No cursor: bounded tail read, discard partial first line, return last complete lines.
- Same inode and size >= offset: return appended complete lines.
- Size < offset: resetReason truncated; fresh tail.
- Device/inode changed: resetReason rotated; fresh tail.
- Do not emit trailing partial lines until completed. Oldest-to-newest order. UI appends only without resetReason; otherwise replaces and announces reset.
- Invalid/expired cursor is 400 invalid_cursor, never a guessed read.

Sanitization before budgeting:
- UTF-8 with replacement; strip ANSI and OSC escapes and C0 controls except tab/newline.
- Maximum 8 KiB per line; mark clipped.
- Redact assignment/JSON/header keys containing api_key, apikey, token, secret, password, passwd, credential, authorization or cookie.
- Redact Bearer/Basic values, private-key blocks, URL userinfo, sensitive query parameters and recognizable token prefixes such as sk-, ghp_ and github_pat_.
- Also redact exact configured secret values known to the dashboard process, longest first, minimum length 8.
- Replace with [REDACTED]; no raw escape hatch. Return only aggregate redactionCount.

Response fields:
agent; source=agent-service-log; completeHistory=false; state=ok|empty|stale; reason; readAt; fileModifiedAt; staleAfterMs=15000; cursor; resetReason=rotated|truncated|null; truncated; redactionCount; entries=[{index,text,clipped}].

Do not invent timestamp/type parsing unless log format guarantees it. Index is response-local only.

Headers: Cache-Control: private, no-store; X-Content-Type-Options: nosniff. ETag derives from device/inode/size/mtime, never path. Honor If-None-Match only without cursor. No wildcard CORS.

UI label: Agent service log (recent tail). Supporting copy: “A bounded tail of this agent’s local service log. It may be incomplete and is not a session transcript or complete work history.” Show freshness, redaction count and reset/truncation notices. Never show Refresh: 10/sec for this source.

3. ALERTS SUMMARY STRIP

Never mix lifecycle and severity in one strip.

Primary lifecycle strip, canonical order:
Open | Acknowledged | Assigned | Resolved | Suppressed

Each applies the Status filter. An optional Active helper total equals Open + Acknowledged + Assigned but is not a sixth status. State the time window used for Resolved.

Secondary severity control:
Severity: All | Critical N | Warning N | Info N

Severity counts use the current time window and current non-severity filters; selection changes only Severity. Every state has word plus count; color is secondary.

List and detail share one selectedAlertId. If refresh removes it, clear detail and announce “Selected alert is no longer in this result.” Never retain mismatched stale detail.

4. POPULATED TASKS

Fleet header: Tasks — OPEN_COUNT open / TOTAL_COUNT total. Filters: Assignee, Status (default Open), Priority and text search. Open means all statuses except done.

Columns:
1) Status word badge.
2) Priority P0–P3.
3) Task: title; second line short ID plus parent/granularity.
4) Assignee: linked agent or Unassigned.
5) Waiting / heartbeat: blocked shows reason and until/OVERDUE; in-progress shows heartbeat age and STALE; others em dash.
6) Updated: relative age with exact accessible timestamp.

Open ordering:
- bucket: blocked, in_progress, accepted, created;
- priority P0 through P3;
- blocked ties: overdue first, earliest waiting_until, oldest updated_at;
- other ties: oldest updated_at, then ID.
Done orders completed_at descending.

Blocked rows say BLOCKED and OVERDUE in words. Row click opens detail and updates ?task=ID; embedded links retain their own actions.

Detail is master/detail on wide screens and full-width with Back on narrow screens. It shows title/ID; status, priority, granularity, labels; linked assignee; parent and children; full description; created_by and all lifecycle timestamps; heartbeat with stale state; waiting reason/until with overdue state; and comments oldest-first. Preserve comment drafts during refresh.

Render only legal transition actions: Accept, Start work, Mark blocked, Resume, Mark done. Blocking collects required waiting metadata. Actions remain in-flight until confirmed; failure keeps prior state. Priority/assignee/labels are editable only if the API supports them. Delete is separated, confirms ID/title and is non-optimistic.

Shared contract:
Fleet Tasks and agent Work consume the same TaskDTO and the same list/detail renderer/state module. Agent Work supplies a locked default scope assignee=agentName plus “View all fleet tasks”; it is not a fork.

Canonical DTO fields exactly match task-store: id,title,description,status,priority,granularity,assignee,created_by,created_at,updated_at,started_at,completed_at,heartbeat_at,waiting_reason,waiting_until,parent_id,labels,health,comments.

One shared definition owns status labels/order/Open predicate, priorities, legal transitions, stale threshold, sorting, time formatting, row/detail rendering, URL selection, in-flight state and draft preservation. Do not duplicate these in tasks-page.js and agent-detail-page.js. Under server-side templates, use an imported TASK_UI_SCRIPT/render helper, or canonical API metadata; task-store remains authoritative. Contract tests render the same DTO through both scopes and assert identical status, priority, waiting, timestamps, legal actions and detail content.
