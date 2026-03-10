# Subconscious Synthetic Status/Timestamp Boundary Design

## Scope
This note defines the remaining synthetic-layer cleanup after the accepted first canonical-source slice.

In scope:
- classify residual synthetic status/timestamp fields
- separate presentation-only fields from debug-only fields
- identify fields that should be removed or recomputed from canonical sources

Out of scope:
- implementation
- hook expansion
- UI expansion
- broader canonical-source cleanup outside this field set

## Baseline
Accepted current state:
- durable upstream files already outrank mirrored `runtimeMeta.upstream.*` and `letta.upstream.*` for the first cleanup slice
- generic event `guidance*` fields are no longer canonical conversation state

Remaining problem:
- several upstream detail fields are still route-written snapshots copied into `state/letta.json` or `state/subconscious/runtime.json`
- those fields are useful for operators, but they still look canonical unless the contract explicitly demotes them

## Classification Rules

| Class | Rule |
|---|---|
| Presentation-only | Keep in the operational contract, but compute at read time from canonical facts or explicit route outcome rules. Never treat as first-class stored truth. |
| Debug-only | Show only in privileged debug detail. Useful for reconstructing a route run, but not stable enough for default operational state. |
| Remove/Recompute | Stop persisting as a contract field, or recompute from durable files/canonical objects when needed. |

## Field Classification

### Presentation-only

| Field | Current issue | Design decision |
|---|---|---|
| `upstream.session.status` | Synthetic label assembled from durable session presence plus notify/blocker context | Keep, but only as a presentation summary derived from durable `sessionId` + `conversationId` plus explicit notify substatus |
| `upstream.userPrompt.status` | Synthetic label inferred from durable `lastProcessedIndex` and route-local send outcome | Keep, but compute from durable cursor movement and blocker state at read time |
| `upstream.preTool.status` | Synthetic label; `seeded-baseline` is a summary, not a canonical upstream object | Keep as presentation-only; never treat `seeded-baseline`, `no-updates`, or `injected` as stored truth |
| `upstream.stop.status` | Synthetic label inferred from durable processed-index movement and route-local send outcome | Keep, but compute from durable stop cursor state and blocker state at read time |
| `upstream.session.notify.status` | Synthetic summary over notify attempt/send/block conditions | Keep as presentation-only and separate from lifecycle establishment |
| `attempted` / `messageSent` / `injected` booleans | Currently look object-backed, but they are route outcome summaries | Keep only as presentation booleans derived from canonical cursor movement or explicit blocker/success rules |
| `blockLabelCount` | Useful operator summary, but canonical source is durable `lastBlockValues` | Keep, but always recompute from durable `lastBlockValues` at read time |

### Debug-only

| Field | Current issue | Design decision |
|---|---|---|
| `attemptedAt` | Route-local timestamp; not durable upstream truth | Move to debug-only |
| `messageSentAt` | Route-local success timestamp; may not match durable upstream write time | Move to debug-only |
| `injectedAt` | Route-local injection timestamp; only meaningful for reconstructing one run | Move to debug-only |
| `lastProcessedIndexBefore` | Per-route diff baseline, not durable object state | Move to debug-only |
| `lastSeenMessageIdBefore` | Per-route diff baseline, not durable object state | Move to debug-only |
| `transcriptLineCount` | Parser/run-local count; useful for diagnosis, not canonical state | Move to debug-only |
| `transcriptMessageCount` | Route-run count; useful for diagnosis, not canonical state | Move to debug-only |
| `newMessageCount` | Route-local delta count from one sync attempt | Move to debug-only |
| `changedBlockCount` | Route-local delta count from one sync attempt | Move to debug-only |
| `toolName` on `preTool` | Useful for reconstructing a specific run, not the durable upstream object | Move to debug-only |

### Remove or Recompute

| Field | Current issue | Design decision |
|---|---|---|
| `checkedAt` | Pure route read/write timestamp; currently looks like canonical object freshness | Remove from canonical stored state; if needed, recompute as response-time metadata instead of persisting per object |
| top-level stored upstream `checkedAt` mirrors | Same problem at `upstream`, `session`, `userPrompt`, `preTool`, and `stop` levels | Remove persisted mirrors; use response metadata or debug transport metadata |
| persisted synthetic status labels in `state/letta.json` / `runtime.json` | They can drift from durable upstream files | Stop treating stored labels as authoritative; recompute from canonical files on read |
| persisted `attemptedAt` / `messageSentAt` / `injectedAt` mirrors | These are route-run timestamps, not canonical upstream facts | Stop persisting as authoritative object fields; retain only transient debug response metadata if still needed |
| persisted route-written counters (`newMessageCount`, `changedBlockCount`, `transcript*Count`) | They describe one route execution, not stable object state | Stop treating them as contract state; either compute on demand in debug mode or drop from stored state |

## Minimum Object-Level Decisions

### SessionStart
- Canonical:
  - durable `sessionId`
  - durable `conversationId`
  - durable session-file `startedAt` when present
- Presentation-only:
  - `status`
  - `established`
  - `notify.status`
  - `messageSent`
- Debug-only:
  - `notify.attemptedAt`
  - `notify.messageSentAt`
- Remove/Recompute:
  - `checkedAt`
  - persisted notify timing mirrors

### UserPromptSubmit
- Canonical:
  - `sessionId`
  - `conversationId`
  - durable `lastProcessedIndexAfter`
- Presentation-only:
  - `status`
  - `attempted`
  - `messageSent`
- Debug-only:
  - `attemptedAt`
  - `messageSentAt`
  - `lastProcessedIndexBefore`
  - `transcriptLineCount`
- Remove/Recompute:
  - `checkedAt`
  - persisted send timing mirrors

### PreToolUse
- Canonical:
  - `sessionId`
  - `conversationId`
  - durable `lastSeenMessageIdAfter`
  - durable `lastBlockValues`
- Presentation-only:
  - `status` including `seeded-baseline`, `no-updates`, `injected`
  - `attempted`
  - `injected`
  - recomputed `blockLabelCount`
- Debug-only:
  - `attemptedAt`
  - `injectedAt`
  - `lastSeenMessageIdBefore`
  - `newMessageCount`
  - `changedBlockCount`
  - `toolName`
- Remove/Recompute:
  - `checkedAt`
  - persisted synthetic status/timing mirrors

### Stop
- Canonical:
  - `sessionId`
  - `conversationId`
  - durable `lastProcessedIndexAfter`
- Presentation-only:
  - `status`
  - `attempted`
  - `messageSent`
- Debug-only:
  - `attemptedAt`
  - `messageSentAt`
  - `lastProcessedIndexBefore`
  - `transcriptMessageCount`
  - `newMessageCount`
- Remove/Recompute:
  - `checkedAt`
  - persisted synthetic send timing mirrors

## Recommended Cleanup Order
1. Stop persisting `checkedAt` as object state and move freshness reporting to response/debug metadata.
2. Recompute presentation statuses from canonical files at read time instead of trusting stored status strings.
3. Move route-run timing fields (`attemptedAt`, `messageSentAt`, `injectedAt`) behind privileged debug detail.
4. Move route-run delta counters and `*Before` baselines behind privileged debug detail.
5. Keep only canonical ids/cursors/durable values plus presentation summaries in the default operational contract.

## Acceptance Target For The Later Implementation Slice
- Default operational detail keeps stable operator-facing summaries without presenting route-local timestamps or delta counters as canonical state.
- Privileged debug detail still supports route reconstruction.
- Stored mirrors in `state/letta.json` and `state/subconscious/runtime.json` no longer outrank or impersonate canonical upstream state.
