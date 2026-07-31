---
kind: requirement
id: REQ-PROJECT-BOARD
title: "Provide a privacy-preserving project operations board"
status: Accepted
liveness: auto
tags: [dashboard, projects, agents, tasks, workflow]
---

## Problem

An operator can inspect agents, tasks, task graphs, and project-room groups on
separate dashboard pages, but cannot answer the project-level questions "who is
working", "what is blocked", and "what changed recently" without manually
joining those views. Workflow progress is especially difficult to follow when
several coding agents collaborate in one project room.

## Requirements

[REQ-PROJECT-BOARD-BOUNDARY] A project board entry MUST use an hafleet group
as its project-room boundary and MUST NOT infer project membership from agent
names.

[REQ-PROJECT-BOARD-AGENTS] The board MUST show the registered state, runtime
family, capability, current task state, and task heartbeat freshness of every
registered agent in the project group.

[REQ-PROJECT-BOARD-TASKS] The board MUST group durable tasks assigned to project
agents by canonical task status.

[REQ-PROJECT-BOARD-GRAPHS] The board MUST show task graphs whose owner or node
assignee belongs to the project group, including each node's dependency and
execution state.

[REQ-PROJECT-BOARD-WORKTREES] The board MUST show each managed project checkout
or worktree attached to a project agent, including the owning agent, safe
location label, branch, revision, and clean/dirty state.

[REQ-PROJECT-BOARD-RESOURCE-BINDING] Managed project resources MUST be selected
through an explicit exact group-to-project binding. An unbound group MUST NOT
infer a project from its group name, agent name, checkout name, or repository.

[REQ-PROJECT-BOARD-REPOSITORIES] Repository metadata MUST use a provider-neutral
shape that can represent GitHub, AtomGit, GitLab, Gitee, and unknown Git hosts
without treating GitHub fields as universal.

[REQ-PROJECT-BOARD-PROVIDERS] The backend MUST observe both GitHub and AtomGit
repositories through provider-specific read adapters, normalize hosted issues
and change requests into the common projection, and keep provider credentials
out of the projection and logs.

[REQ-PROJECT-BOARD-SPECS] The board MUST discover bounded local agent-spec task
contracts and show their name, kind, requirement links, scenario count, and
modification time.

[REQ-PROJECT-BOARD-ISSUES] Local issue documents MUST remain distinguishable
from provider-hosted issues and MUST show the selected repository publish
target when one is available.

[REQ-PROJECT-BOARD-CHANGES] Provider-hosted pull requests or merge requests MUST
be normalized as change requests with provider, repository, number, branch,
state, checks, and diff summary fields.

[REQ-PROJECT-BOARD-ACTIVITY] Recent activity MUST include only messages whose
authenticated backend record targets the exact project group.

[REQ-PROJECT-BOARD-PRIVACY] The board MUST NOT include direct messages,
approval-room messages, message full bodies, Matrix access tokens, runtime API
keys, local filesystem paths, or approval request details.

[REQ-PROJECT-BOARD-READ-ONLY] The first project board release MUST be read-only.
It MUST NOT expose task, graph, group, agent, or approval mutations.

[REQ-PROJECT-BOARD-REFRESH] The dashboard MUST refresh without overlapping
requests and MUST preserve the selected project while new data arrives.

## Scenarios

Scenario: Operator sees one project in one place
  Given a group contains registered coding agents with tasks and a task graph
  When the operator opens the project board
  Then the page shows project KPIs, agent cards, task lanes, graph stages, and recent public activity

Scenario: Private approval data stays private
  Given an agent has public group messages and detailed owner-DM approval messages
  When the project board snapshot is built
  Then only the public group message summaries appear
  And no approval detail or direct message content appears

Scenario: Membership does not depend on naming conventions
  Given an agent has an arbitrary name and is a member of the project group
  When the board snapshot is built
  Then the agent appears in that project

Scenario: Stale work is visible
  Given an active or waiting agent task has not heartbeated within the configured freshness window
  When the board snapshot is built
  Then that task is marked stale with its heartbeat age

Scenario: Worktree delivery context is visible
  Given a group is explicitly bound to a project
  And two project agents use separate worktrees for the same repository
  When the project board snapshot is built
  Then both agent-to-worktree associations, branches, and dirty states appear
  And absolute local paths do not appear

Scenario: Unbound project resources stay private
  Given an agent belongs to a group and manages several local projects
  And the group has no explicit project binding
  When the project board snapshot is built
  Then none of those local project resources appear

Scenario: Local issue has an explicit publish target
  Given a managed project contains a local issue document and a repository remote
  When the project board snapshot is built
  Then the issue is identified as local
  And its target provider and repository are shown separately

Scenario: AtomGit project resources are visible
  Given a bound project repository uses an AtomGit origin
  When the project board refreshes
  Then AtomGit issues and change requests are shown with provider-neutral fields
  And no AtomGit token is returned to the Dashboard

## Dependencies

- ADR-001
- ADR-009

## Source Trace

- User request on 2026-07-24 for an hafleet project board.
- Multica project, issue-board, and usage-dashboard review on 2026-07-24.
- Existing hafleet group, task, task-graph, agent-runtime, and message APIs.
- User request on 2026-07-24 to support AtomGit OpenAPI in addition to GitHub.

## Open Questions

- Publishing a local issue and editing repository bindings remain future
  operator-authorized mutations. They are intentionally outside this requirement.
