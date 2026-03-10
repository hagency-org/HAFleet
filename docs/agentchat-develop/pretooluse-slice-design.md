# PreToolUse Slice Design

## Scope
Prepare the first `PreToolUse` cutover as a narrow object-model slice only. This note does not add UI, new synthetic status concepts, or wider lifecycle changes.

Accepted baseline before this slice:
- `SessionStart` is upstream-backed.
- `UserPromptSubmit` is upstream-backed.
- `Stop` is upstream-backed.
- `PreToolUse` is still local/transitional.

The first `PreToolUse` cutover should stay a read-and-inject path over the existing upstream session/conversation state. It should not create a new session model, replace `Stop`, or widen into general runtime redesign.

## First-Class Objects Touched

### 1. Bound Letta Agent
The upstream subconscious agent already bound to the local agent home.

Touched fields:
- `agentId`
- memory `blocks[]`
- display `name`

Why `PreToolUse` touches it:
- to read current upstream memory block values and detect changes since the last successful sync
- to label any injected mid-workflow message/memory update with the real upstream agent name

### 2. Upstream Session Sync State
The durable per-session file under `state/subconscious/upstream-home/.letta/claude/session-<session>.json`.

Touched fields:
- `sessionId`
- `conversationId`
- `lastSeenMessageId`
- `lastBlockValues`
- existing `lastProcessedIndex` must remain readable but is not advanced by this slice

Why `PreToolUse` touches it:
- to know whether the session has enough prior state to diff against
- to remember which upstream assistant message was already surfaced
- to remember the previous upstream memory-block snapshot for change detection

### 3. Upstream Conversation Map
The durable conversation map under `state/subconscious/upstream-home/.letta/claude/conversations.json`.

Touched fields:
- `sessionId -> { conversationId, agentId }`

Why `PreToolUse` touches it:
- only as fallback truth when the session file has no `conversationId`
- to keep the session-to-conversation lookup aligned with the accepted `SessionStart` and `UserPromptSubmit` truth sources

### 4. Upstream Letta Conversation
The real remote Letta conversation already established for the session.

Touched fields:
- assistant messages in `GET /conversations/:conversationId/messages`
- message ids
- timestamps
- message text/content

Why `PreToolUse` touches it:
- to fetch new upstream assistant output that arrived after the last surfaced message
- to inject that output into Claude Code before the next tool runs

### 5. Hook Output Payload
The actual `PreToolUse` hook result returned to Claude Code.

Touched fields:
- `hookSpecificOutput.hookEventName`
- `hookSpecificOutput.additionalContext`

Why `PreToolUse` touches it:
- this is the only output object that changes Claude Code behavior in the first slice
- the slice succeeds only if the injected context is derived from upstream truth, not a local synthetic summary

### 6. Agent-Chat Event / Detail Projection
The existing local observability layer in `agent-chat`.

Touched fields:
- latest event fields for `PreToolUse`
- subconscious detail contract fields for the latest `PreToolUse` attempt/result

Why `PreToolUse` touches it:
- to project the real upstream-backed result into the existing object model
- not as a truth source for execution, only as a projection of execution

## Truth Sources By Touched State

| Field or state | Truth source |
|---|---|
| bound upstream `agentId` | `state/letta.json` first, with accepted binding-priority rules already in place |
| current session id | hook input `session_id` |
| current conversation id | `session-<session>.json.conversationId`, fallback `conversations.json[sessionId].conversationId` |
| whether `PreToolUse` has a prior baseline | `session-<session>.json.lastSeenMessageId` and `session-<session>.json.lastBlockValues` |
| new upstream assistant messages | Letta `GET /conversations/:conversationId/messages`, compared against durable `lastSeenMessageId` |
| changed upstream memory blocks | Letta agent `blocks[]`, compared against durable `lastBlockValues` |
| message text/timestamps surfaced to Claude | the Letta conversation message objects themselves |
| block-change diff surfaced to Claude | diff between current Letta `blocks[]` and durable `lastBlockValues` |
| persisted "already surfaced" message marker | `session-<session>.json.lastSeenMessageId` after successful save |
| persisted block snapshot for next diff | `session-<session>.json.lastBlockValues` after successful save |
| execution status shown by `agent-chat` | projection derived after save from durable session state plus the fetched upstream response; not helper-local memory only |

## Transitional vs Upstream-Backed Boundary

What becomes upstream-backed in the first slice:
- fetching new mid-workflow assistant messages from the real Letta conversation
- fetching current memory blocks from the real bound Letta agent
- deriving `additionalContext` from those real upstream objects
- persisting the "last surfaced" markers into the durable upstream session file

What remains local/transitional after this slice:
- the formatting of `additionalContext` returned to Claude Code
- the event-post payload emitted to `/api/subconscious/events`
- the agent-detail projection of the latest `PreToolUse` result
- local runtime guidance and local episodic memory paths
- any policy about when to acknowledge surfaced subconscious output in a later assistant response

What must not change in this slice:
- `SessionStart`, `UserPromptSubmit`, and `Stop` truth sources
- `lastProcessedIndex` ownership by the transcript-backed prompt/stop flow
- the current session/conversation lifecycle model
- UI scope

## Minimum Proof
A minimum acceptable proof for the first slice is:

1. Start a real upstream-backed session for Yato.
2. Send a real upstream-backed user prompt for that same session so the session file and conversation map are established.
3. Create one real upstream change that `PreToolUse` can observe:
   - either a new upstream assistant message in the bound conversation,
   - or a real upstream memory-block change on the bound Letta agent.
4. Trigger a real `PreToolUse` hook for that same session.
5. Verify all of the following agree:
   - the hook returns `additionalContext` containing the upstream change
   - `session-<session>.json.lastSeenMessageId` and/or `lastBlockValues` advanced only after the successful sync
   - `GET /api/subconscious/detail/:name` reports the latest `PreToolUse` result from the durable saved state, not helper-local assumptions
   - a second identical `PreToolUse` call with no new upstream changes returns a truthful no-update result

That proof is enough for the first slice. It does not require full tool-policy reasoning, generalized planning, or UI expansion.

## New Failure Modes and UX or Latency Risks

### Durable-state convergence failure
The helper may fetch real upstream data but fail to persist `lastSeenMessageId` or `lastBlockValues`. If the route then reports success from in-memory values, `PreToolUse` will repeat the same update on the next tool call. The accepted `UserPromptSubmit` rule applies here too: route-facing status must converge to durable state after save.

### Conversation-id divergence
If `session-<session>.json.conversationId` and `conversations.json` disagree, `PreToolUse` can read the wrong conversation and inject unrelated output. The slice should use the same accepted precedence as the current upstream conversation lifecycle and fail loudly on durable divergence instead of silently picking one.

### Missing prior baseline
The upstream `pretool_sync.ts` semantics explicitly skip when there is no prior `lastSeenMessageId` and no `lastBlockValues`. That means the first `PreToolUse` after session establishment may truthfully have nothing to inject even if the path is wired. This is expected behavior, not a regression.

### Mid-tool latency
`PreToolUse` is on the hot path before every tool execution. A direct Letta fetch of both the agent object and conversation messages adds remote latency to every eligible tool call. The first slice should keep scope narrow and avoid extra bootstrap/model-refresh work on this path.

### Busy or stale upstream conversation state
If Letta conversation reads lag behind recent writes, `PreToolUse` may inject nothing on one call and surface the update on the next. That is acceptable if the persisted markers remain truthful and the route does not overclaim immediate visibility.

### Duplicate user-visible surfacing
If `PreToolUse` injects a mid-workflow Letta message that is also later reflected through local transitional guidance, Claude could see duplicative advice. The first slice should keep the boundary explicit: upstream `PreToolUse` surfaces only the direct Letta deltas it observed; it does not merge them with local runtime guidance into a new combined concept.
