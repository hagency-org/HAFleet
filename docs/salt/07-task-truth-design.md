# 07 Task Truth Design

Date: 2026-05-02
Status: design only; no code migration in Batch 2.

## Problem

Task truth currently exists in three places:

- `tasks.json` through `lib/task-store.js`
- `task_graphs.json` through `lib/task-graph.js`
- legacy per-agent fields such as `agents[agent].task`

This makes it unclear which record is canonical for an agent's current commitment. It also makes supervisor/dashboard/doc mirrors vulnerable to drift.

## Decision

Use `taskStore` as the canonical task object model.

Task graph nodes should become orchestration wrappers around canonical task records, not a separate lifecycle truth. Agent records should not own task state; they may expose a derived/mirrored summary for old clients only.

## Target Model

| Layer | Owns | Does not own |
| --- | --- | --- |
| `taskStore` | Task id, assignee, status, priority, acceptance, execution, comments. | Graph dependency topology. |
| `taskGraphStore` | DAG topology, dependency conditions, dispatch order, node-to-task link. | Independent assignee lifecycle once a task exists. |
| `agents[agent]` | Agent identity/runtime metadata. | Canonical task status. |
| Agent home docs/task-writer | Local coordination mirror and operator ergonomics. | Backend truth. |

## Migration Shape

1. Add optional `taskId` to task graph nodes.
2. On graph dispatch, create or link a canonical task for the node.
3. Node status becomes derived from linked task status where possible.
4. Keep accepting old graph-only nodes during migration.
5. Stop writing `agents[agent].task` as canonical state; derive summaries from task store.
6. Add source-of-truth tests that reject divergent agent/task/graph state.

## Non-Goals For Batch 2

- No migration of existing `task_graphs.json`.
- No removal of legacy `agents[agent].task`.
- No dashboard redesign.

Batch 2 only fixes the immediate task graph spoof issue by requiring `task_graph_result` and `task_graph_failed` messages to come from the node assignee.
