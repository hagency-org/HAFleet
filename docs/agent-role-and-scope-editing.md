# Agent Role & Scope Editing Guide

This file defines the canonical workflow to edit agent responsibility/scope inputs used by supervisor.

## Required Files Per Agent

Each agent must have:
- `docs/{agent}/agents.md`
- `docs/{agent}/plan.md`

Required sections:
- `agents.md`:
  - `## Role`
  - `## Boundaries`
- `plan.md`:
  - `## Current`

Supervisor will mark an agent as `skipped: missing-doc-sections` if these sections are missing.

## Editing Rules

1. Edit `docs/{agent}/agents.md` first.
2. Keep `Role` focused on ownership and core/adjacent scope.
3. Keep `Boundaries` explicit about what the agent must not investigate/fix.
4. Edit `docs/{agent}/plan.md` and keep `## Current` concrete and executable.
5. Do not place temporal status in `agents.md`; use `progress.md` for temporal logs.

## Validation

Validate all known agents:

```bash
npm run audit:agent-docs
```

Validate only online agents:

```bash
npm run audit:agent-docs -- --active
```

JSON output for automation:

```bash
npm run audit:agent-docs -- --active --json
```

Exit code:
- `0`: all checked agents pass
- `2`: one or more agents missing required sections
