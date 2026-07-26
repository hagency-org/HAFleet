---
kind: decision
id: ADR-009
title: "Build the project board from a backend-owned read model"
status: Accepted
liveness: auto
tags: [dashboard, read-model, privacy, workflow]
---

## Context

agent-chat already persists the facts needed for a useful project operations
view, but they are split across groups, agents, durable tasks, task graphs, and
messages. Joining those records in browser JavaScript would duplicate domain
rules, make privacy filtering easy to bypass, and prevent other clients from
using the same project snapshot.

Multica demonstrates useful product patterns for this problem: a project
selector, compact KPI summaries, status-based work lanes, agents as first-class
assignees, and a project-scoped detail surface.

## Decision

The backend owns a read-only project-board projection. An agent-chat group is
the membership boundary. Managed project resources additionally require an
explicit exact group-to-project binding. The projection joins:

- registered group members and their redacted runtime/task state;
- durable tasks assigned to those members;
- task graphs owned by, or assigning nodes to, those members; and
- managed project worktrees, local specs/issues, and provider repository metadata; and
- summary-only messages sent to the exact group.

The system `info` group is excluded because it is an operational alert stream,
not a project room. Unknown human or remote member names remain visible as
unregistered members, but the board never assigns them an inferred agent role.

The Dashboard server only proxies the projection and renders it. The first
release is read-only. It adopts Multica's information hierarchy without
copying its mutation model or frontend stack.

Direct messages, approval-room events, full message bodies, secrets, and local
paths are excluded at the backend projection boundary rather than hidden only
by the page.

Project resources follow Multica's useful separation between repository
resources and daemon-local directories, extended for agent-chat's multi-agent
worktree model. A worktree records a safe location label and owning agent; a
repository records provider-neutral identity. Local issues and specs are
artifacts of a worktree. Remote issues and pull/merge requests are artifacts of
a repository. The common API calls the latter `changeRequests` rather than
assuming every provider uses GitHub's PR vocabulary.

The read model consumes the existing durable workflow binding only for its
explicit `group` and `project` values. It does not infer a project from a group
suffix, an agent name, a checkout basename, or a remote repository. Without a
binding, membership and task status remain visible but local resources do not.

Local inspection uses bounded filesystem traversal and `git` argument arrays,
never an agent-provided shell command. Remote provider reads are cached and
adapter-owned. GitHub is observed through the authenticated `gh` CLI. AtomGit
is observed through its current `/api/v5/repos/:owner/:repo/issues` and
`/pulls` read endpoints, with an optional backend-only `ATOMGIT_TOKEN` for
private repositories. Provider credentials and raw command output are never
returned.

## Consequences

Good, because Dashboard and future clients receive one consistent,
privacy-filtered project snapshot.

Good, because project membership is explicit group data rather than an agent
name convention.

Good, because GitHub and AtomGit can coexist behind one repository/change
request vocabulary without making GitHub the authorization source.

Good, because public AtomGit repositories can be observed without local CLI
installation while private repository credentials stay behind the backend
projection boundary.

Good, because a multi-project agent cannot leak one project's local resources
into another project group merely by belonging to both groups.

Bad, because tasks and graphs currently have no explicit project id. Until that
schema exists, they are associated through their owner or assignee's group
membership and can appear in more than one project when an agent belongs to
multiple groups.

Bad, because filesystem and remote repository inspection are eventually
consistent cached observations rather than transactional project state.

## Alternatives Considered

- Join existing endpoints in the browser: rejected because privacy and
  association rules would be duplicated in every client.
- Infer workflow roles from names such as `wf_reviewer`: rejected because
  names are not authorization or project metadata.
- Include owner-DM approval summaries for convenience: rejected because the
  public project view is not an approval-detail surface.
- Put worktree paths directly into the projection: rejected because basename
  labels and branch/revision state provide operational value without leaking
  the host's absolute directory structure.
