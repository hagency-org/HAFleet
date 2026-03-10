# V1 Agent Home Contract (Dev Batch)

Date: 2026-03-06
Scope: development implementation only (`no migration`, `no live runtime cutover`)

## Goals

1. Freeze the v1 storage/runtime contract for new agents.
2. Keep dual-read compatibility with existing `0.x` agents.
3. Place project material under each agent's own `workdir/projects/`.

## Runtime Root

- Environment variable: `AGENTCHAT_HOMEDIR`
- Default when unset: `~/.agentchat`
- v1 homes are rooted at:
  - `${AGENTCHAT_HOMEDIR}/agents/<agent-id>/`

## Directory Layout

```text
<home>/
  agent.json
  supervisor/
    CLAUDE.md
    AGENTS.md
    docs/
      plan.md
      progress.md
  state/
    resume-id
    letta.json
    history/
    locks/
    tmp/
  workdir/
    CLAUDE.md
    AGENTS.md
    task-writer
    docs/
      AGENTS.md -> ../AGENTS.md
      CLAUDE.md -> ../CLAUDE.md
      plan.md
      progress.md
      projects.md
    projects/
    scratch/
    inbox/
    outputs/
    data/   (runtime-created)
```

Ownership model:
- `state/`: system-owned runtime state.
- `supervisor/`: explicit supervisor-local sibling workspace; not a second canonical task/runtime-profile source.
- `workdir/`: agent-writable workspace.
- `workdir/CLAUDE.md`: maintained Claude workspace instructions generated from the repo template source-of-truth.
- `workdir/AGENTS.md`: maintained agent role/boundary/bootstrap instructions generated from the repo template source-of-truth.
- `workdir/task-writer`: maintained wrapper for canonical task-state writes through the home control-plane.
- `workdir/docs/AGENTS.md`: compatibility link/mirror back to `../AGENTS.md`.
- `workdir/docs/CLAUDE.md`: compatibility link/mirror back to `../CLAUDE.md`.

## `agent.json` Schema (v1)

```json
{
  "id": "agent_<normalized-name>",
  "name": "<agent-name>",
  "type": "claude|codex",
  "agentModelVersion": "1.0",
  "layoutVersion": 1,
  "homeDir": "<absolute path>",
  "workdir": "<absolute path>",
  "stateDir": "<absolute path>",
  "subconsciousEnabled": true,
  "managedProjects": [
    {
      "name": "<project-name>",
      "path": "<absolute path under workdir/projects>",
      "source": "symlink|copy",
      "originPath": "<source absolute path or null>"
    }
  ],
  "human": {
    "owner": "<nullable string>",
    "notes": "<string>",
    "projectScope": "<string>"
  },
  "task": {
    "id": "<string>",
    "owner": "<string>",
    "status": "active|waiting|blocked|done",
    "updated_at": "<ISO8601>",
    "heartbeat_at": "<ISO8601>",
    "waiting_reason": "<nullable string>",
    "waiting_until": "<nullable ISO8601>"
  },
  "runtimeProfile": {
    "primary": {
      "framework": "<nullable string>",
      "provider": "<nullable string>",
      "model": "<nullable string>",
      "reasoning": "<nullable string>",
      "extraArgs": "<nullable string>"
    },
    "supervisor": {
      "framework": "<nullable string>",
      "provider": "<nullable string>",
      "model": "<nullable string>",
      "reasoning": "<nullable string>",
      "extraArgs": "<nullable string>"
    }
  },
  "createdAt": "<ISO8601>",
  "updatedAt": "<ISO8601>"
}
```

## Provisioning Rules

1. Use `agentchat up-v1 ...` for new v1 agents.
2. Project materialization is explicit:
   - `--project-mode copy` (default)
   - `--project-mode symlink` (explicit opt-in compatibility mode)
3. No implicit migration of existing legacy metadata.
4. Workspace instructions are generated from `docs/workspace-claude-md-template.md` (`Template-Version: v1`), not inline hardcoded text.
5. Provisioning writes concrete root `workdir/CLAUDE.md` and `workdir/AGENTS.md`, then maintains `workdir/docs/CLAUDE.md` and `workdir/docs/AGENTS.md` as compatibility links/mirrors.
6. Provisioning writes a concrete `workdir/task-writer` wrapper that updates canonical task state through the existing v1 home control-plane route.
7. Provisioning also scaffolds a sibling `supervisor/` workspace with its own `CLAUDE.md`, `AGENTS.md`, `docs/plan.md`, and `docs/progress.md`.

## Docs Resolution Rules

Dual-read order:
1. v1: `<workdir>/docs/` with `AGENTS.md` compatibility link (fallback `agents.md`) + `plan.md`; root `<workdir>/AGENTS.md` is the primary workspace entry file
2. legacy workspace: `<workspace>/docs/<agent>/`
3. repo fallback: `<repo>/docs/<agent>/`

## Subconscious Scope (This Batch)

- Claude-only runtime wiring for v1 agents:
  - `subconsciousEnabled=false` by default; enable it explicitly per agent when needed.
  - `agent-up-v1` provisioning and `agent-up` launch both run `scripts/configure-v1-subconscious.js`.
  - Hook runtime is installed under `<stateDir>/subconscious/claude-agentchat/`.
  - Claude hook settings are merged into `<workdir>/.claude/settings.json`.
  - Per-agent Letta identity is resolved as:
    1. `LETTA_AGENT_ID` env override
    2. existing `<stateDir>/letta.json` `agentId`
    3. deterministic generated `agent-...` id based on v1 agent identity
  - Resolved Letta identity is persisted to `<stateDir>/letta.json` and reused across launches.
  - Hook event URL default is derived from runtime backend config (`AGENT_CHAT_API` or `AGENT_CHAT_BACKEND_PORT`, fallback `http://127.0.0.1:8090/api/subconscious/events`).
  - Hook events are posted to backend API: `POST /api/subconscious/events` and are reviewable via `GET /api/subconscious/events` (+ `/:name`).
- Codex subconscious integration remains out of scope in this batch.
