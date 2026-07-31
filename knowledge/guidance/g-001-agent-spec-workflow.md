---
kind: guidance
id: G-001
title: "Use agent-spec before implementing bounded work"
liveness: n/a
tags: [agent-spec, workflow]
---

## Scope

All hafleet source, protocol, test, and documentation changes.

## Instructions

- Read `specs/project.spec.md`, governing KLL artifacts, and the active Task Contract first.
- Run `agent-spec parse` and `agent-spec lint --min-score 0.7` before implementation.
- Link active task specs to accepted requirements and decisions with `satisfies`.
- Update and re-lint a contract before expanding its behavior or file boundaries.
- Run exact bound tests and `agent-spec lifecycle` before reporting completion.
- Store durable truth in `knowledge/`, executable acceptance in `specs/`, and explanatory prose in `docs/`.

## Applies To

- `**/*.js`
- `**/*.mjs`
- `tests/**`
- `docs/**`
- `specs/**`
- `knowledge/**`

## Skills

- `agent-spec-authoring`
- `agent-spec-tool-first`
