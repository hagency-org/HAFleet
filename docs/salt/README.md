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
| `05-docs-archive-index.md` | Stale documentation trust/cleanup index. |
| `06-implementation-plan.md` | Approval-gated repair batch plan. |
| `07-task-truth-design.md` | R-006 design-only canonical task model. |
| `08-remote-local-current-state.md` | Current remote/local topology, split inventory, and drift evidence. |
| `09-remote-local-unification-design.md` | Unified runtime-host, identity, config, and package design. |
| `10-remote-local-roadmap.md` | Dependency-ordered roadmap for future remote/local repair batches. |
| `11-remote-local-phase0-terms.md` | Approved Phase 0 terminology, profile matrix, and command-scope staging rules. |
| `12-cicd-gates.md` | First executable CI/CD gate design and remaining release-gate gaps. |
| `13-cd-flow-and-gaps.md` | CD audit findings, current gaps, and proposed deploy-gate model. |
| `14-cd-next-decisions.md` | Decision pack for the next CD batches after the first CI/preflight gate. |
| `15-phase2-7-resumption-plan.md` | Updated Phase 2-7 implementation order using the new CI/CD gates. |
| `system-map.md` | Repository map, runtime components, major flows, and source-of-truth boundaries. |
| `kernel-boundaries.md` | Core/adjacent/edge classification and ownership rules. |
| `audit-findings.md` | Consolidated structural and code audit findings with evidence. |
| `repair-table.md` | Single repair table to discuss with ac-topleader before implementation. |
| `subagent-briefs.md` | Parallel audit assignment log and returned report summaries. |
| `progress.md` | Durable progress log for this audit batch. |

## Current Status

- Initial repo orientation is complete.
- Five subagents completed read-only audits for kernel, MCP/CLI/push, persistence/config/tests, edge systems, and old docs.
- Batch 1 and Batch 2 repairs are implemented and pushed.
- Batch 3 approved scope R-009/R-015 is implemented.
- Remote/local split audit is documented as design-only in `08` through `10`; no runtime code repair started for this topic.
- Phase 0 terminology is staged in `11`; this folder is the temporary authority for remote/local terms until root docs are approved for rewrite.
- CI/CD first gate is implemented in `12` and exposed through `npm run verify:ci`.
- CD preflight and post-deploy version checks are implemented; remaining CD work is decision-gated in `14`.
- Phase 2-7 resumption is staged in `15`; RLP4-A MCP media cache relocation, RLP4-B v1 home/runtime resolver hardening, RLP2-A runtime observation provenance, RLP2-B custom local server ID/local server record, CLI unknown-activity observability, RLP6-A profile-scoped help/docs, RLP3-A auth readiness diagnostics, and RLP3-A2 server credential boundary diagnostics are implemented. CD decision docs now include full-clone remote profile, dependency lock, standalone version, and install-reconciliation decisions; deploy-behavior batches remain operator-gated.
