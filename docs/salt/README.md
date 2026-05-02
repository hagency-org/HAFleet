# salt agent-chat system audit

Date: 2026-05-02
Owner: salt
Branch: master

## Purpose

This folder is the working documentation set for the current agent-chat system audit.
The target interpretation is:

- Core: agentchat kernel, where an agent is treated as an addressable, stateful, remembered individual.
- Adjacent: task graph, alerts, runtime monitoring, launch/provisioning, and dashboards that support the kernel.
- Edge: Supervisor, subconscious hooks, Matrix bridge, remote packaging, and optional operator interfaces.

The first phase is documentation and audit only. Code repairs start after the repair table is reviewed with ac-topleader.

## Document Set

| File | Purpose |
| --- | --- |
| `00-principles.md` | System definition, kernel invariants, and repair order. |
| `01-kernel.md` | Core kernel components, stores, APIs, and message semantics. |
| `02-runtime-and-transports.md` | MCP, push relay, CLI, remote, and Matrix transport map. |
| `03-edge-systems.md` | Dashboard, tasks, alerts, Supervisor, subconscious, and remote boundaries. |
| `04-data-config-tests.md` | Data schema, environment, CI, and test harness audit. |
| `05-docs-archive-index.md` | Old documentation trust/cleanup index. |
| `06-implementation-plan.md` | Approval-gated repair batch plan. |
| `system-map.md` | Repository map, runtime components, major flows, and source-of-truth boundaries. |
| `kernel-boundaries.md` | Core/adjacent/edge classification and ownership rules. |
| `audit-findings.md` | Consolidated structural and code audit findings with evidence. |
| `repair-table.md` | Single repair table to discuss with ac-topleader before implementation. |
| `subagent-briefs.md` | Parallel audit assignment log and returned report summaries. |
| `progress.md` | Durable progress log for this audit batch. |

## Current Status

- Initial repo orientation is complete.
- Five subagents completed read-only audits for kernel, MCP/CLI/push, persistence/config/tests, edge systems, and old docs.
- No code repair has started.
