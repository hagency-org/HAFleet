# Agent Workspace Rules

## Directory
`docs/{agent}/` — `{agent}` is your agent name. To learn your name, call `whoami()` via the agent-chat MCP server. All agent state lives here.

---

## Working Conventions

### Self-Bootstrap
- On every resume, context compaction, or new session: read THIS file first, then call `whoami()` to confirm your identity → read `docs/{agent}/agents.md` → `plan.md` → tail of `progress.md`.

### Root-Cause First
- When a bug or failure appears, trace to root cause before applying any fix.
- Surface fixes (suppressing errors, adding retries without understanding why, hardcoding workarounds) are prohibited unless explicitly marked as temporary with a TODO and reason.
- Log the root cause in `progress.md`. If the cause reveals a systemic pattern, add it to `agents.md`.

### Verify, Don't Assume
- After making a change, always verify it works (run tests, check output, read logs).
- Never mark a task DONE based on "it should work now".

### Minimal, Correct Changes
- Change only what is necessary to complete the current task.
- Do not refactor, restyle, or "improve" unrelated code in the same unit of work.
- If you spot something worth fixing, add it to `plan.md` Queue instead.

### Ask Before Guessing
- If a task is ambiguous or requirements are unclear, surface the ambiguity rather than making a silent assumption.
- Record assumptions in `progress.md` when you must proceed without clarification.

### Fail Loudly
- If you are stuck, blocked, or unsure after two attempts, update `plan.md` status to BLOCKED with a clear description of what is needed, rather than looping silently.

---

## Files

### agents.md — Knowledge Base
- Store: project conventions, architectural decisions, tool quirks, recurring error patterns, environment setup notes, discovered root causes.
- Do NOT store: task status, progress, or anything temporal.
- Write trigger: when you learn something that would save a future context window from re-discovering it.
- Keep entries atomic (one fact per bullet). Deduplicate on write.

### plan.md — Task State
Structure:
```
## Current
<one task: what you are doing right now, acceptance criteria>

## Queue
<ordered list of next tasks, one line each>

## Blocked (optional)
<tasks waiting on external input, with reason>
```
- Update BEFORE starting work (set Current).
- Update AFTER completing work (promote next Queue item).
- Completed and reverted tasks must be removed from plan.md immediately. They belong in progress.md only.
- On resume/compaction: sweep plan.md, remove any task already logged as DONE or REVERTED in progress.md.

### progress.md — Append-Only Log
Format per entry:
```
## [YYYY-MM-DD HH:MM] <status> — <summary>
<optional detail: what changed, key decisions, root causes found, blockers hit>
```
`<status>` ∈ {DONE, PARTIAL, BLOCKED, REVERTED}

- Append only. Never edit or delete past entries.
- One entry per meaningful unit of work (not per file touch).

---

## Workflow Quick Reference

| Event | Action |
|---|---|
| Resume / compaction | Read **this file** → `whoami()` → agents.md → prune plan.md → tail of progress.md (last 5) |
| Before work | Set plan.md Current |
| After work | Update plan.md, append to progress.md |
| Found root cause | Log in progress.md; if systemic, also agents.md |
| Spotted unrelated issue | Add to plan.md Queue, do not fix now |
| Stuck after 2 attempts | Set plan.md to BLOCKED with description |
| No meaningful state change | Do NOT write to any file |

## Boundaries
- Your role and boundaries are defined in `docs/{agent}/agents.md` under `## Role` and `## Boundaries`.
- Respect them strictly. If a task falls outside your boundaries, delegate via agentchat (`send_message`) instead of doing it yourself.
- Messages from **supervisor** are correction signals — read them immediately and adjust your behavior.

## Concurrency
- Each agent writes ONLY to its own `docs/{agent}/`.
- Cross-agent coordination goes through `docs/shared/` (if needed), never by editing another agent's files.