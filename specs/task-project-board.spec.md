spec: task
name: "Project operations board"
inherits: project
satisfies: [REQ-PROJECT-BOARD, ADR-001, ADR-009]
tags: [active, dashboard, projects, agents, tasks, workflow]
estimate: 1.5d
---

## Intent

Add a read-only hafleet project board that lets an operator understand
project health, agent activity, task progress, workflow execution, and recent
public updates without inspecting multiple Dashboard pages or private approval
rooms.

## Constraints

### Must
- Use a backend-owned project-board projection.
- Treat an hafleet group, excluding the reserved `info` group, as a project.
- Include all explicit group members without inferring identity or role from a name.
- Require an explicit group-to-project binding before exposing managed project resources.
- Redact runtime secrets and absolute filesystem paths before the Dashboard receives data.
- Associate tasks through exact registered group-member assignees.
- Associate task graphs through their owner or exact node assignees.
- Inspect managed project checkouts with bounded, argument-array git commands.
- Show safe worktree labels, owning agents, branch/revision, and dirty state.
- Discover bounded local task specs and local issue documents.
- Represent repository, remote issue, and change-request data with provider-neutral fields.
- Observe GitHub and AtomGit remote issues and change requests through backend-only provider adapters.
- Keep the optional AtomGit token in backend request headers and out of projections and logs.
- Keep local issues distinct from remote issues and expose a safe publish target.
- Include only exact-group message summaries in recent activity.
- Mark active or waiting agent tasks stale after a deterministic freshness window.
- Render project selection, KPI cards, agent status, task lanes, workflow graphs, and public activity.
- Refresh in the background without overlapping requests.
- Preserve the selected project when it still exists.
- Provide deterministic Vitest coverage for projection, API, proxy, and render boundaries.

### Must Not
- Do not expose direct messages, approval records, full message bodies, API keys, access tokens, or local paths.
- Do not infer role, project, owner, or authority from an agent name.
- Do not execute a shell command or accept a browser-supplied inspection path.
- Do not treat a Git provider as an authorization source.
- Do not add task, graph, group, agent, workflow, or approval mutations.
- Do not add a frontend framework or dependency.

## Decisions

- Backend endpoint: `GET /api/project-board`.
- Dashboard page: `GET /projects`.
- Project identity in v1 is the exact group name.
- Managed resources are selected by the existing explicit workflow binding's
  exact `group` and `project`; an unbound group exposes no local resources.
- Task lanes use the canonical durable task states:
  `created`, `accepted`, `in_progress`, `blocked`, and `done`.
- Agent task state remains separate from durable task state and is shown on
  agent cards.
- Repository resources, worktrees, specs, local issues, remote issues, and
  change requests are separate projection types.
- GitHub and AtomGit are remote observation adapters; unsupported providers
  remain visible with an explicit unsynced state instead of disappearing.
- AtomGit observation uses its current `/api/v5/repos/:owner/:repo` read APIs.
  Public repositories work without a token; private repositories may use the
  backend-only `ATOMGIT_TOKEN` environment variable.
- The visual hierarchy borrows Multica's project filter, KPI strip,
  status-board, and first-class agent assignment concepts while using the
  existing hafleet Dashboard style and dependency-free renderer.

## Boundaries

### Allowed Changes
- backend-v2.js
- server.js
- lib/project-board.js
- lib/project-inspector.js
- lib/dashboard/**
- tests/**
- knowledge/**
- specs/**

### Forbidden
- Do not change Matrix routing or approval behavior.
- Do not modify runtime data files.
- Do not make Robrix2 an authorization or project-data authority.

## Acceptance Criteria

### Rule: project-boundary — groups define project membership

Scenario: Arbitrarily named group member appears
  Tags: critical
  Test: project_board_uses_exact_group_membership
  Given a project group contains a registered agent whose name has no workflow prefix
  When the backend builds the project board
  Then the agent appears in that project
  And no role is inferred from its name

Scenario: Reserved info stream is excluded
  Test: project_board_excludes_info_group
  Given the backend contains the reserved info group and a project group
  When the backend builds the project board
  Then only the project group appears

### Rule: privacy-boundary — only project-safe data leaves the backend

Scenario: Direct and approval messages are absent
  Tags: critical
  Test: project_board_excludes_private_messages
  Given messages include a group update, a direct message, and an approval-room message
  When the project snapshot is returned
  Then only the group update summary appears
  And no full message body appears

Scenario: Agent runtime secrets and paths are absent
  Tags: critical
  Test: project_board_redacts_runtime_secrets_and_paths
  Given a project agent has runtime credentials and local workspace paths
  When the project snapshot is returned
  Then safe framework and model labels may appear
  And credentials and paths do not appear

### Rule: work-projection — tasks and graphs are project scoped

Scenario: Tasks form canonical status lanes
  Test: project_board_groups_tasks_by_status
  Given project-member agents own tasks in several statuses
  When the project snapshot is built
  Then each task appears exactly once in its canonical lane

Scenario: Related task graph exposes workflow stages
  Test: project_board_includes_related_task_graph
  Given a task graph assigns one node to a project agent
  When the project snapshot is built
  Then the graph and every node state appear

Scenario: Stale active task is visible
  Test: project_board_marks_stale_agent_task
  Given an active agent task heartbeat is older than the freshness window
  When the project snapshot is built
  Then the agent task is marked stale

### Rule: delivery-context — repositories, worktrees, specs, and issues stay distinct

Scenario: Two agents use separate worktrees
  Tags: critical
  Test: project_board_keeps_agent_worktrees_distinct
  Given two group agents bind the same repository through different managed project paths
  When the project snapshot is built
  Then both worktrees appear with their owning agent and branch
  And the repository appears once

Scenario: Unbound group cannot reveal managed projects
  Tags: critical
  Test: project_board_requires_explicit_resource_binding
  Given a group agent manages projects that are not explicitly bound to the group
  When the project snapshot is built
  Then no worktree, spec, issue, repository, or change request is exposed

Scenario: Local specs are summarized without full source
  Test: project_inspector_summarizes_agent_specs
  Given a managed project contains project and task spec files
  When the bounded inspector scans it
  Then each contract exposes its kind, name, satisfies links, scenarios, and modified time
  And the full source text is absent

Scenario: Local issues retain a remote publish target
  Test: local_issue_exposes_provider_neutral_publish_target
  Given a local issue document is found in a repository with an AtomGit remote
  When the project snapshot is built
  Then the issue source is local
  And the publish target provider is atomgit

Scenario: Provider change requests use common vocabulary
  Test: github_pull_request_normalizes_to_change_request
  Given the GitHub adapter observes an open pull request
  When the repository snapshot is returned
  Then it appears as a change request with provider, branch, state, checks, and diff summary

Scenario: AtomGit repository artifacts share the project read model
  Tags: critical
  Test: atomgit_issues_and_change_requests_use_the_provider_neutral_projection
  Given a bound repository has an AtomGit origin
  When the AtomGit adapter observes its issues and change requests
  Then remote issues and change requests use the common project-board fields
  And the AtomGit token does not appear in the projection

Scenario: Remote provider observation fails safely
  Test: project_inspector_reports_remote_unavailable
  Given a bound repository is valid but its provider observation command fails
  When the project inspector returns the repository snapshot
  Then the repository remains visible with sync state unavailable
  And no credential, command output, or local path appears

### Rule: dashboard-experience — operators can scan and refresh safely

Scenario: Project page renders all read-only surfaces
  Test: project_page_renders_board_surfaces
  Given the Dashboard serves the project page
  When the operator opens /projects
  Then project selection, KPIs, agents, task lanes, graphs, and activity containers exist

Scenario: Dashboard proxies the backend snapshot
  Test: project_board_proxy_is_read_only
  Given the browser requests /api/project-board
  When the Dashboard proxies the request
  Then it issues one GET to the backend
  And it exposes no project-board mutation route

Scenario: Overlapping refresh is coalesced
  Test: project_page_coalesces_refresh
  Given a project-board refresh is already in flight
  When another timer or stream event asks for a refresh
  Then no overlapping request starts
  And exactly one follow-up refresh is queued

Scenario: Project agent opens in Monitor
  Test: project_agents_link_to_the_monitor_and_monitor_has_complete_navigation
  Given a registered agent appears in the selected project's Agents section
  When the operator clicks that agent card
  Then the Monitor page opens with that exact agent selected
  And Monitor shows the same complete Dashboard navigation
  And MONITOR is marked as the current page

## Out of Scope

- Dragging tasks between lanes.
- Creating or editing projects.
- Persisting workflow role bindings.
- Publishing local issues or creating change requests.
- Rendering private owner-approval details.
- Cost and token accounting.
