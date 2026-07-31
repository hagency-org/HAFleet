---
kind: decision
id: ADR-004
title: "Launch coding agents with sandboxed defaults"
status: Accepted
liveness: auto
tags: [sandbox, claude, codex, runtime]
---

## Context

Agents invited into shared Matrix rooms can receive untrusted or accidental
instructions. Their process permissions must not depend on every prompt being
well behaved.

## Decision

hafleet launches Claude Code with `--permission-mode auto` and launches
Codex with `--sandbox workspace-write --ask-for-approval on-request`. Agent
workspace materialization exposes only the configured managed project paths.
Launch arguments that disable these boundaries are rejected.

## Consequences

Good, because coding agents start with bounded filesystem and escalation
behavior even when room content is hostile.

Bad, because operations outside those boundaries require a supported native or
remote approval path and cannot be silently completed.

## Alternatives Considered

- Launch with unrestricted permissions: rejected because a public-room message could trigger host-wide effects.
- Rely only on prompt instructions: rejected because behavioral guidance is not an enforcement boundary.
