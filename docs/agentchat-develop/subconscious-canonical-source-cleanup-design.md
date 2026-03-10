# Subconscious Canonical-Source Cleanup Design

## Scope
This note defines the minimum canonical-source cleanup plan for subconscious state after the accepted operational-vs-debug split.

Out of scope:
- hook expansion
- UI expansion
- implementation in this batch

Accepted current baseline in dev:
- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop` are accepted upstream-backed slices
- default subconscious detail is operational-only
- privileged debug detail is currently available only on the backend route via local or `API_TOKEN`-authorized `?debug=1`

## First-Class Objects

### 1. Agent subconscious binding
Object:
- agent-level subconscious binding and identity

Canonical writer:
- `scripts/configure-v1-subconscious.js` bootstraps `state/letta.json`
- `PATCH /api/agents/:name/subconscious-guidance` in [server.js](/home/shisui/laplace/agent-chat/server.js) updates `state/letta.json`

Canonical reader:
- `resolveSubconsciousState()` in [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js)

Canonical file:
- `<stateDir>/letta.json`

Canonical fields:
- `provider`
- `mode`
- `agentId`
- `resolutionSource`
- `guidance`
- minimal upstream binding metadata needed to reconnect to the bound Letta agent

Should not outrank canonical:
- copied binding ids in `runtimeMeta.upstream.agentId`
- imported upstream config ids when they disagree with `state/letta.json`

### 2. Local runtime configuration
Object:
- local transitional runtime config and hook wiring

Canonical writer:
- `scripts/configure-v1-subconscious.js` writes initial `state/subconscious/runtime.json`
- `saveSubconsciousRuntime()` -> `PATCH /api/agents/:name/home-metadata` in [server.js](/home/shisui/laplace/agent-chat/server.js) updates manifest-controlled enablement and runtime config

Canonical reader:
- `resolveSubconsciousState()` in [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js)

Canonical file:
- `<stateDir>/subconscious/runtime.json`

Canonical fields:
- runtime enabled/disabled state
- provider/model/endpoint/keyEnv resolution inputs
- installed hook/runtime wiring metadata

Should not outrank canonical:
- generic event rows claiming runtime status
- top-level `stage`

### 3. Local episodic memory store
Object:
- local episodic memory journal used by the transitional runtime path

Canonical writer:
- `appendSubconsciousMemoryEpisode()` via `POST /api/subconscious/runtime/invoke/:name`
- memory retrieval metadata updates inside the same runtime invoke route

Canonical reader:
- `resolveSubconsciousMemoryState()` inside `resolveSubconsciousState()`

Canonical file:
- `<stateDir>/subconscious/memory.json`

Canonical fields:
- `episodes`
- retrieval strategy
- last stored/retrieved ids and timestamps

Should not outrank canonical:
- event-derived memory summaries
- `lastInvocation.memoryRetrieval.*` mirrors

### 4. Local conversation journal
Object:
- transcript-backed local session journal for the transitional runtime path

Canonical writer:
- `syncSubconsciousConversationState()` in [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js)
- called from:
  - `POST /api/subconscious/events`
  - `POST /api/subconscious/runtime/invoke/:name`

Canonical reader:
- `resolveSubconsciousConversationState()` inside `resolveSubconsciousState()`

Canonical file:
- `<stateDir>/subconscious/conversations.json`

Canonical fields:
- `currentSessionId`
- `lastSyncedAt`
- local journal session rows and per-session counts

Should not outrank canonical:
- event stream summaries
- route-written conversation mirrors in `lastInvocation.conversation`

### 5. Upstream conversation map
Object:
- session-to-conversation binding for the upstream Letta path

Canonical writer:
- upstream reused scripts under `claude-subconscious`, exercised through:
  - `POST /api/subconscious/upstream/session-start/:name`
  - `POST /api/subconscious/upstream/user-prompt/:name`
  - `POST /api/subconscious/upstream/pretool/:name`
  - `POST /api/subconscious/upstream/stop/:name`

Canonical reader:
- `buildSubconsciousUpstreamContract()` in [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js)

Canonical file:
- `<stateDir>/subconscious/upstream-home/.letta/claude/conversations.json`

Canonical fields:
- session id -> conversation id mapping

Should not outrank canonical:
- `runtimeMeta.upstream.session.conversationId`
- `letta.upstream.session.conversationId`
- route-local response values before durable reread

### 6. Upstream per-session sync state
Object:
- durable upstream per-session progress state

Canonical writer:
- upstream reused scripts through the same four upstream routes above

Canonical reader:
- `buildSubconsciousUpstreamContract()`

Canonical files:
- `<stateDir>/subconscious/upstream-home/.letta/claude/session-<session>.json`

Canonical fields:
- `sessionId`
- `conversationId`
- `lastProcessedIndex`
- `lastSeenMessageId`
- `lastBlockValues`
- upstream-started timestamps persisted by the upstream toolchain

Should not outrank canonical:
- route-written `attemptedAt` / `checkedAt` / `status` mirrors
- event-level `upstream*Status` claims

### 7. Upstream SessionStart object
Object:
- whether upstream session lifecycle is established for a session

Canonical writer:
- durable upstream conversation map + per-session sync state created by `POST /api/subconscious/upstream/session-start/:name`

Canonical reader:
- `buildSubconsciousUpstreamContract()`

Canonical source composition:
- `conversations.json`
- `session-<session>.json`
- bound Letta agent id from `state/letta.json`

Derived-only fields:
- `upstream.session.status`
- `upstream.session.established`
- `upstream.session.notify.*`

### 8. Upstream UserPromptSubmit object
Object:
- upstream prompt-send progress and durable last-processed cursor movement

Canonical writer:
- `POST /api/subconscious/upstream/user-prompt/:name`
- upstream sync script writes durable session/conversation state

Canonical reader:
- `buildSubconsciousUpstreamContract()`

Canonical source composition:
- `session-<session>.json`
- `conversations.json`

Derived-only fields:
- `upstream.userPrompt.status`
- `upstream.userPrompt.attempted`
- `upstream.userPrompt.messageSent`
- route-written timestamps

### 9. Upstream PreToolUse object
Object:
- upstream assistant-delta/block-delta read and inject state

Canonical writer:
- `POST /api/subconscious/upstream/pretool/:name`
- upstream sync script updates durable session sync state

Canonical reader:
- `buildSubconsciousUpstreamContract()`

Canonical source composition:
- `session-<session>.json`
- upstream conversation map and Letta-side state observed during the route

Derived-only fields:
- `upstream.preTool.status`
- `upstream.preTool.injected`
- `newMessageCount`
- `changedBlockCount`
- route-written timestamps

Note:
- this object still has the weakest canonical backing because some useful counters are computed during the route and then mirrored, not durably written by the upstream script itself

### 10. Upstream Stop object
Object:
- upstream transcript-send progress for the Stop path

Canonical writer:
- `POST /api/subconscious/upstream/stop/:name`
- upstream stop/send script updates durable session sync state

Canonical reader:
- `buildSubconsciousUpstreamContract()`

Canonical source composition:
- `session-<session>.json`
- `conversations.json`

Derived-only fields:
- `upstream.stop.status`
- `upstream.stop.messageSent`
- `transcriptMessageCount`
- `newMessageCount`
- route-written timestamps

### 11. Local runtime invocation snapshot
Object:
- latest local runtime invoke result

Canonical writer:
- `POST /api/subconscious/runtime/invoke/:name`

Canonical reader:
- `resolveSubconsciousState()`

Canonical file:
- `<stateDir>/letta.json`

Canonical fields:
- `lastInvocation`
- `lastRuntimeGuidance`

Should not outrank canonical:
- generic event `guidance*`
- local conversation preview mirrors

### 12. Event row
Object:
- observational hook event row

Canonical writer:
- `POST /api/subconscious/events` via `appendSubconsciousEvent()`

Canonical reader:
- `GET /api/subconscious/events`
- `GET /api/subconscious/events/:name`
- SSE stream

Canonical file:
- `<runtimeRoot>/data/subconscious-events.jsonl`

Boundary:
- event rows are canonical only for the event log itself
- event rows are not canonical for session/binding/runtime/upstream state

## Remaining Mirror or Derived Fields at Risk

### High risk
- top-level `stage`
  - useful summary, but not canonical state
  - currently compresses multiple objects into a single label
- generic event `guidance*` fields
  - span manual guidance, local runtime guidance, and upstream pre-tool injection
- `runtimeMeta.upstream.*` per-hook mirrors
  - `session`
  - `userPrompt`
  - `preTool`
  - `stop`
- `letta.upstream.*` per-hook mirrors
  - same object family, duplicated again in a second file

### Medium risk
- route-written timestamps that look authoritative but are not durable upstream truth:
  - `checkedAt`
  - `attemptedAt`
  - `messageSentAt`
  - `injectedAt`
- route-local counters mirrored as durable-looking fields:
  - `transcriptLineCount`
  - `transcriptMessageCount`
  - `newMessageCount`
  - `changedBlockCount`
  - `blockLabelCount`
- `lastInvocation.conversation.*`
  - useful snapshot, but not canonical conversation state

### Lower risk but still derived
- operational summaries assembled in the web page model:
  - `activeSubconsciousPath`
  - aggregated blocker lists
  - grouped guidance/memory summaries

## Minimum Correction Order

### 1. Declare canonical ownership in code comments and docs first
- mark each first-class object with one canonical writer and one canonical reader
- explicitly mark event rows and per-hook mirrors as observational/derived

Reason:
- without this, later cleanup will keep reintroducing precedence drift

### 2. Stop mirror precedence from outranking canonical files
- `buildSubconsciousUpstreamContract()` should read durable upstream files first for session and hook-progress state
- `runtimeMeta.upstream.*` and `letta.upstream.*` should become fallback cache only, never primary truth

Reason:
- this closes the same class of bugs already seen with stale `agentId`, session status, and user-prompt convergence

### 3. Demote or delete generic `guidance*` compatibility fields from canonical surfaces
- keep path-specific objects canonical:
  - `manualGuidance`
  - `runtime`
  - `lastRuntimeGuidance`
  - `upstream.userPrompt`
  - `upstream.preTool`
- keep generic `guidance*` only as compatibility summaries if still needed by the event stream

Reason:
- they currently collapse incompatible systems into one synthetic concept

### 4. Reduce duplicated per-hook mirror writes
- for each upstream route, persist only the minimum non-derivable cache needed for local debug convenience
- stop writing fields that can be recomputed from durable upstream files plus binding state

Reason:
- fewer mirrors means fewer precedence and convergence bugs

### 5. Only after the above, revisit `stage`
- keep it as presentation-only if still useful
- do not let any route, UI, or policy treat it as canonical

Reason:
- `stage` is the last synthetic layer; cleaning it first would hide, not solve, the source-of-truth problem

## Minimum Acceptable Implementation Batch After This Design
- make durable upstream files the first reader for upstream session/userPrompt/preTool/stop state
- explicitly demote `runtimeMeta.upstream.*` and `letta.upstream.*` hook records to cache/fallback
- document event rows as observational only
- demote generic `guidance*` fields from canonical state surfaces
- keep UI scope unchanged except for any adjustments required to consume the corrected canonical objects truthfully
