## Current
Keep architecture-first execution active while landing the next smallest valid cut: implement `PreToolUse` only under the approved object-model slice and preserve the accepted `SessionStart` / `UserPromptSubmit` / `Stop` baselines.
Acceptance criteria:
- `system-architecture-convergence.md` exists as the active architecture contract for dev work
- `agentchat-develop`, `Yato`, and `webdebug` are all re-tasked against that contract
- the accepted Letta baselines remain stable (`SessionStart` notify returns cleanly and `Stop` remains upstream-backed with truthful observability)
- the accepted `UserPromptSubmit` slice remains stable with one converged truth source (`route -> durable files -> detail/API`)
- `PreToolUse` implementation stays within the approved first-class-object design:
  - `lastSeenMessageId` / `lastBlockValues` belong to the durable session file for this slice
  - `lastProcessedIndex` remains owned by the transcript-backed `UserPromptSubmit` / `Stop` flow
  - route response, durable session file, and detail/API contract converge on the same truth source after proof

## Queue
1. Continue with `PreToolUse` only after `UserPromptSubmit` is accepted and its latency/visibility tradeoffs are understood.
2. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
3. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
4. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
5. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
6. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
7. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
