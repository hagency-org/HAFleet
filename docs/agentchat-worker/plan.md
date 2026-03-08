## Current
Keep architecture-first execution active by landing the first correction batch from the accepted subconscious event/security review: harden event ingestion and separate default operational detail from privileged debug exposure.
Acceptance criteria:
- accepted upstream slices remain stable on Yato (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`)
- `/api/subconscious/events` gains a real trust boundary instead of accepting unauthenticated caller-supplied telemetry wholesale
- the default subconscious detail surface stops exposing absolute paths and full text previews that are not required for operational state
- no new hook path or UI expansion is introduced while making these corrections

## Queue
1. Canonical-source cleanup for subconscious mirrors after the security boundary is fixed: assign one reader/writer per object and demote derived mirror fields.
2. Rebuild the web around environment grouping and first-class objects (`live/dev/benchmark/ephemeral`, canonical vs transitional states) before adding more summary concepts.
3. Start benchmark Batch 4 (result UI) only after the object model is stable enough not to fork benchmark product language from core system language.
4. Expose the per-agent config model in the unified web management page (MCP, hooks, skills, related runtime knobs) once its first-class objects and truth sources are defined.
5. Decide how to handle the enterprise-managed Claude MCP constraint for a real `agentchat-dev` alias (`policy change`, `approved central config update`, or `accept using existing agent-chat alias against dev env`).
6. Mirror the same code/runtime split design later for live (`agent-chat-live` + future `agent-chat-live-runtime`) after stable merge and explicit cutover planning.
7. Then implement secure external supervisor event ingest and reducer-based subconscious event flow.

## Blocked (optional)
None.
