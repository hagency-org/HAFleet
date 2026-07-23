---
kind: decision
id: ADR-002
title: "Derive a room agent owner from the trusted inviter"
status: Accepted
liveness: auto
tags: [matrix, authorization, ownership]
---

## Context

An agent can participate in a public project room containing multiple human
developers. UI state, display names, global administrator roles, and an agent's
self-reported identity do not prove which developer owns that agent in that
room.

## Decision

For a specific Matrix project room, the owner of a managed local agent is the
human whose authenticated full MXID invited that exact agent account into the
trusted room. The bridge persists inviter provenance under a compound
`project_room_id + agent` binding. A room can therefore contain multiple
managed agents without overwriting ownership or reusing another agent's
approval DM. Authorization checks compare the complete `event.sender` MXID
against the owner of that exact room-agent binding; an empty or ambiguous owner
set is rejected without administrator fallback.

## Consequences

Good, because ownership is derived from a server-observed Matrix event and is
scoped to the actual agent-room relationship.

Bad, because transferring ownership requires an explicit, audited transition;
renaming a display name or editing dashboard metadata cannot transfer it.

## Alternatives Considered

- Treat every project-room administrator as an approver: rejected because it leaks control across developers.
- Trust the Robrix2 UI or Matrix display name: rejected because neither is an authorization source.
- Use only the global agent `human.owner` string: rejected because ownership is room-scoped and that field is not authenticated Matrix provenance.
