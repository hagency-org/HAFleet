# 00 Principles

Date: 2026-05-02

## Product Definition

hafleet is a stateful-individual chat kernel for agents.

The important object is not a task, tmux pane, Matrix room, or dashboard row. The important object is an agent as an addressable individual with identity, memory, inbox state, runtime presence, and durable conversation history.

## Kernel Invariants

- One backend owns canonical identity, message, group, cursor, runtime, task, and alert state.
- Agent-facing MCP tools must be a thin, authenticated client of that backend.
- Push relay, Matrix, dashboard, and remote services are transports, runtime-host adapters, or operator surfaces; they do not own chat truth.
- Reads that mutate memory state, such as advancing a cursor, must authenticate as that agent or as an operator.
- Optional edge systems can observe or annotate kernel state, but they must not silently redefine identity, inbox visibility, or task ownership.
- Agent home state is an identity and memory anchor; path and manifest handling should be strict.

## Core vs Edge Rule

Core:

- Agent identity and agent home.
- Message creation, storage, visibility, suppression, attachments, and reads.
- Group membership and group message cursor semantics.
- Agent runtime state needed for delivery and availability.
- MCP tool contract used by agents.

Adjacent:

- Tasks, task graphs, alerts, notification aggregation, launch/provisioning.
- These can influence workflows, but they are not the core chat memory.

Edge:

- Matrix, dashboard, Supervisor, subconscious hooks, remote packaging, service wrappers.
- These can be replaced without changing what a message, cursor, group, or agent identity means.

Runtime-host adapter contract:

- A runtime host owns local tmux sessions and can observe, heartbeat, report runtime, and inject notifications.
- The host adapter is adjacent to the kernel because it affects delivery and availability, but backend inbox state remains recovery truth.
- Remote packaging is an edge deployment artifact; it must not be treated as a second implementation of the kernel.

## Refactor Rule

Fix order should preserve kernel meaning:

1. Auth and memory-boundary bugs.
2. Message/inbox/task truth bugs.
3. Runtime delivery reliability.
4. Config/data migration contracts.
5. Edge system hardening.
6. Documentation cleanup.

The current phase stops before implementation. Repairs need ac-topleader review of `repair-table.md`.
