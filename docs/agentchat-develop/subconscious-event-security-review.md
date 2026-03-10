# Subconscious Event Model and Security Review

## Scope
This note reviews only the current subconscious event/detail surfaces and their security boundary.

Out of scope:
- new hook paths
- UI redesign
- implementation changes in this batch

Accepted current execution baseline in dev:
- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop` are all exercised upstream-backed slices.
- local runtime guidance and local journals still exist as separate transitional paths.

## Finding 1: Hook result state has mirror-vs-canonical ambiguity
Severity: high

Current shape:
- hook execution writes a transient event row through `POST /api/subconscious/events`
- backend routes also persist per-hook status into both `runtimeMeta.upstream.*` and `letta.upstream.*`
- durable upstream session truth additionally lives in:
  - `state/subconscious/upstream-home/.letta/claude/session-<session>.json`
  - `state/subconscious/upstream-home/.letta/claude/conversations.json`
- `buildSubconsciousUpstreamContract()` then reconstructs detail state by mixing durable files with both mirrors

Why this is a problem:
- the same hook outcome is represented in at least three layers: durable upstream files, `runtimeMeta` mirror, and `letta` mirror
- some objects already have accepted durable truth rules (`conversationId`, `lastProcessedIndex`, `lastSeenMessageId`, `lastBlockValues`), but the detail contract still reads status fields from mirrors first for several per-hook subobjects
- this creates ongoing risk that route output, event output, and stored mirrors can drift even when the durable upstream state is correct

Exact ambiguity examples:
- `upstream.userPrompt.status`, `upstream.preTool.status`, and `upstream.stop.status` are mirror-driven summaries over durable state, not themselves canonical state
- `checkedAt`, `attemptedAt`, `messageSentAt`, `injectedAt`, and similar fields are route-written mirrors, not durable upstream truth
- the same `agentId` can exist in `state/letta.json`, `runtimeMeta.upstream.agentId`, `letta.upstream.agentId`, and imported upstream config

Recommendation:
1. Define one canonical writer and one canonical reader per object.
2. Make durable upstream files canonical for session/conversation and hook-progress markers.
3. Limit `runtimeMeta` to local runtime/config state.
4. Limit `letta.json` to agent binding, manual guidance, and minimal upstream binding metadata.
5. Treat per-hook mirror records as derived caches only, or remove them entirely once the detail contract can derive directly from durable sources.

## Finding 2: Generic `guidance*` fields are synthetic across incompatible paths
Severity: high

Current shape:
- events expose generic fields such as:
  - `guidancePresent`
  - `guidanceConfigured`
  - `guidanceInjected`
  - `guidanceSource`
  - `guidancePreview`
- these fields are reused across:
  - manual guidance from `state/letta.json`
  - local runtime LLM output
  - upstream `PreToolUse` Letta message injection
- the detail/UI model also groups several of these under generic `Guidance & Memory`

Why this is a problem:
- upstream `PreToolUse` is not the same object as local runtime guidance generation or manual guidance text
- collapsing them into one generic guidance abstraction creates synthetic meaning that is not present in the real system objects
- a consumer can see `guidanceInjected = true` without knowing whether that came from upstream Letta messages, a local runtime completion, or a manual static string

Concrete ambiguity:
- after the cutover, `PreToolUse` events use `guidanceSource = upstream-pretool`, but the field name still implies the same semantic category as manual/runtime guidance
- `guidanceEvents` and `guidanceInjectedEvents` in the web model now combine multiple different systems under one count

Recommendation:
1. Demote generic `guidance*` fields from canonical API status to presentation-only compatibility fields.
2. Add path-specific event groups instead of one merged guidance concept:
   - upstream conversation delta injection
   - local runtime guidance generation
   - manual guidance fallback
3. Keep the canonical detail surface object-led: `upstream.userPrompt`, `upstream.preTool`, `upstream.stop`, `runtime`, `manualGuidance`.
4. If compatibility fields remain temporarily, document them as derived and non-canonical.

## Finding 3: Default detail/event surfaces expose more debug material than the object model requires
Severity: high

Current shape:
- detail and event surfaces return absolute filesystem paths such as:
  - `lettaStateFile`
  - `transcriptPath`
  - `syncStateFile`
  - `scriptPath`
  - local memory/conversation store paths
- they also expose content previews and text bodies such as:
  - `promptPreview`
  - `guidancePreview`
  - `manualGuidance.text`
  - latest upstream-injected preview content through event/detail projection
- the web UI renders much of this directly in debug sections, and the backend API returns it by default rather than behind a privileged/debug gate

Why this is a problem:
- filesystem layout is implementation detail, not required runtime object state
- prompt and guidance previews can contain sensitive working context
- `manualGuidance.text` is returned as full text in the default detail contract, even though most consumers only need configured/updated/source status
- current dev binding is on `127.0.0.1`, but the API shape itself does not enforce a least-privilege boundary if the service is later proxied, tunneled, or widened

Recommendation:
1. Split the detail contract into default operational state vs privileged debug state.
2. Default surface should expose booleans, ids, counters, and statuses only.
3. Move absolute paths and text previews behind an explicit debug scope or local-only gate.
4. Return `manualGuidance.configured/source/updatedAt` by default; require a privileged path for full `manualGuidance.text`.

## Finding 4: Event ingestion trusts caller-supplied event content too broadly
Severity: medium-high

Current shape:
- `POST /api/subconscious/events` accepts caller-supplied hook metadata, source labels, paths, previews, upstream status fields, and injected-state claims
- backend then appends that to the in-memory event stream, log file, SSE broadcast, and conversation/detail projection
- the route does not currently enforce a mandatory event token or a strict local-only boundary in the handler itself

Why this is a problem:
- the event stream is being used as an observability source in the UI
- if a caller can reach the backend route, it can write synthetic event history and influence derived conversation snapshots and operator-facing status views
- the backend normalizes field shapes, but it does not establish a trust boundary around who is allowed to assert those fields

Recommendation:
1. Treat `/api/subconscious/events` as a privileged write surface.
2. Enforce one of these, explicitly:
   - mandatory bearer token tied to the installed hook runtime
   - strict local-only acceptance plus per-agent binding checks
3. Server-side stamp trusted fields where possible rather than accepting them wholesale from the caller.
4. Keep event rows observational; do not let them become authoritative for durable per-hook state.

## Finding 5: `stage` is a useful UI summary but a synthetic contract field
Severity: medium

Current shape:
- detail returns a single top-level `stage` such as:
  - `scaffold`
  - `conversation-aware-runtime`
  - `upstream-session-lifecycle`
  - `upstream-user-prompt-lifecycle`
  - `upstream-pretool-lifecycle`

Why this is a problem:
- `stage` compresses multiple first-class objects into one label
- it changes based on which hook path has most recently been exercised, not only on stable system structure
- consumers can misread it as a canonical runtime state machine even though the real system is object-composed, not stage-driven

Recommendation:
1. Keep `stage` only as a presentation helper if needed.
2. Do not use it as the canonical object-model contract for policy or security decisions.
3. Drive decisions from object fields directly:
   - `upstream.session.established`
   - `upstream.userPrompt.status`
   - `upstream.preTool.status`
   - `upstream.stop.status`
   - `runtime.invocationConfigured`

## Recommended Follow-Up Order
1. Security boundary first:
   - lock down `POST /api/subconscious/events`
   - define whether debug detail is local-only or privilege-gated
2. Canonical-source cleanup second:
   - assign canonical ownership for each object and reduce mirror writes
3. Synthetic-field cleanup third:
   - demote or remove generic `guidance*` compatibility fields from canonical surfaces
   - demote `stage` to presentation-only
4. API shape hardening fourth:
   - split operational contract from debug contract so future UI work cannot accidentally depend on unsafe/internal fields

## Minimum Acceptable Follow-Up Changes
A minimal correction batch after this review should do all of the following:
- define canonical truth sources for `session`, `userPrompt`, `preTool`, and `stop`
- explicitly mark mirror fields as derived or remove them
- require a real trust boundary on event ingestion
- redact absolute paths and full text previews from the default detail surface
- leave UI scope unchanged except where required to stay truthful after the API tightening
