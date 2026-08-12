import { describe, expect, it } from 'vitest';

import { buildProjectBoardSnapshot } from '../lib/project-board.js';

function inspection(agent, id, branch) {
  return {
    id,
    agent,
    project: 'demo-project',
    mode: 'symlink',
    locationLabel: `demo-${branch}`,
    available: true,
    absolutePath: `/Users/private/${branch}`,
    repository: {
      id: 'github:github.com:example/demo',
      provider: 'github',
      host: 'github.com',
      owner: 'example',
      name: 'demo',
      fullName: 'example/demo',
      webUrl: 'https://github.com/example/demo',
      accessToken: 'secret-repository-token',
      sync: { status: 'ok', observedAt: '2026-07-24T01:00:00.000Z' },
    },
    git: {
      available: true,
      branch,
      head: 'abcdef123456',
      dirty: branch === 'review',
      changeCount: branch === 'review' ? 2 : 0,
      isWorktree: true,
    },
    specs: [{
      id: 'project-spec',
      kind: 'project',
      name: 'Demo project contract',
      file: 'specs/project.spec.md',
      satisfies: ['REQ-DEMO'],
      scenarios: 2,
      tests: 2,
      modifiedAt: '2026-07-24T01:00:00.000Z',
      source: 'must not leave backend',
    }],
    localIssues: [{
      id: 'local:issue-1',
      source: 'local',
      number: '001',
      title: 'Local design issue',
      state: 'draft',
      file: 'issues/001-design.md',
      modifiedAt: '2026-07-24T02:00:00.000Z',
      publishTarget: {
        provider: 'github',
        repositoryId: 'github:github.com:example/demo',
        repository: 'example/demo',
        url: 'https://github.com/example/demo',
      },
    }],
    remoteIssues: [{
      id: 'github:example/demo:issue:42',
      source: 'remote',
      provider: 'github',
      repositoryId: 'github:github.com:example/demo',
      repository: 'example/demo',
      number: 42,
      title: 'Remote issue',
      state: 'open',
      url: 'https://github.com/example/demo/issues/42',
      updatedAt: '2026-07-24T03:00:00.000Z',
    }],
    changeRequests: [{
      id: 'github:example/demo:change:7',
      provider: 'github',
      kind: 'pull_request',
      repositoryId: 'github:github.com:example/demo',
      repository: 'example/demo',
      number: 7,
      title: 'Implement issue 42',
      state: 'open',
      url: 'https://github.com/example/demo/pull/7',
      headBranch: branch,
      baseBranch: 'main',
      checks: { passed: 3, failed: 0, pending: 1 },
      additions: 30,
      deletions: 4,
      changedFiles: 5,
    }],
  };
}

function fixture() {
  const now = Date.parse('2026-07-24T04:00:00.000Z');
  return {
    now,
    staleAfterMs: 300_000,
    groups: {
      info: { name: 'info', members: ['arbitrary-agent'] },
      demo: { name: 'demo', members: ['arbitrary-agent', 'review-agent', 'human-user'] },
    },
    bindings: {
      demo: {
        bindingId: 'demo:issue-workflow@1',
        group: 'demo',
        project: 'demo-project',
        workflowId: 'issue-workflow',
        workflowVersion: '1',
        createdByMxid: '@private:example.org',
      },
    },
    agents: [{
      name: 'arbitrary-agent',
      type: 'claude',
      online: true,
      healthy: true,
      activeNow: true,
      workspacePath: '/Users/private/workspace',
      apiKey: 'secret-agent-token',
      runtimeProfile: { primary: { framework: 'claude', model: 'strong-model', apiKey: 'secret-model-key' } },
      task: {
        id: 'task-active',
        owner: 'arbitrary-agent',
        status: 'active',
        updated_at: '2026-07-24T03:59:00.000Z',
        heartbeat_at: '2026-07-24T03:59:00.000Z',
      },
      projectInspections: [inspection('arbitrary-agent', 'worktree:one', 'feature')],
    }, {
      name: 'review-agent',
      type: 'codex',
      online: true,
      healthy: true,
      runtimeProfile: { primary: { framework: 'codex', model: 'review-model' } },
      task: {
        id: 'task-review',
        owner: 'review-agent',
        status: 'waiting',
        updated_at: '2026-07-24T03:00:00.000Z',
        heartbeat_at: '2026-07-24T03:00:00.000Z',
        waiting_reason: 'Waiting for implementation',
        waiting_until: '2026-07-24T05:00:00.000Z',
      },
      projectInspections: [
        inspection('review-agent', 'worktree:two', 'review'),
        { ...inspection('review-agent', 'worktree:other', 'other'), project: 'another-private-project' },
      ],
    }],
    tasks: [
      { id: 'task-1', title: 'Implement board', status: 'in_progress', assignee: 'arbitrary-agent', updated_at: '2026-07-24T03:00:00.000Z' },
      { id: 'task-2', title: 'Review board', status: 'accepted', assignee: 'review-agent', updated_at: '2026-07-24T02:00:00.000Z' },
      { id: 'private-task', title: 'Other project', status: 'created', assignee: 'outsider' },
    ],
    taskGraphs: [{
      id: 'graph-1',
      label: 'Board workflow',
      owner: 'arbitrary-agent',
      status: 'active',
      nodes: {
        implement: { assignee: 'arbitrary-agent', description: 'Implement', status: 'done', depends_on: [] },
        review: { assignee: 'review-agent', description: 'Review', status: 'in_progress', depends_on: ['implement'] },
      },
    }],
    messages: [
      { id: 'public', group: 'demo', from: 'arbitrary-agent', summary: 'Implementation is ready', body: 'full public body', ts: '2026-07-24T03:00:00.000Z' },
      { id: 'direct', from: 'arbitrary-agent', to: 'human-user', summary: 'Private DM approval detail', body: 'secret command', ts: '2026-07-24T03:30:00.000Z' },
      { id: 'approval', group: 'approval-room', summary: 'Approve shell command', approval: { request_id: 'secret' } },
    ],
  };
}

describe('project board projection', () => {
  it('project_board_uses_exact_group_membership and project_board_excludes_info_group', () => {
    /*
     * REQ-PROJECT-BOARD-BOUNDARY. The group IS the boundary, in both directions. The agent
     * list is the `demo` member list verbatim, so `human-user` shows up as an unregistered
     * member rather than being quietly dropped, and `arbitrary-agent` being a member of the
     * reserved `info` group as well does not pull that group into the board.
     *
     * And nothing is read off a name: the member whose name carries no workflow prefix still
     * appears, with `role` null rather than guessed. `arbitrary-agent` is named that way on
     * purpose — a projection that inferred anything from naming convention would have to
     * invent something here, and the null is what proves it did not.
     */
    const snapshot = buildProjectBoardSnapshot(fixture());

    expect(snapshot.projects.map(project => project.id)).toEqual(['demo']);
    expect(snapshot.projects[0].agents.map(agent => agent.name)).toEqual([
      'arbitrary-agent',
      'review-agent',
      'human-user',
    ]);
    expect(snapshot.projects[0].agents[0].role).toBeNull();
    expect(snapshot.projects[0].agents[2].registered).toBe(false);
  });

  it('project_board_excludes_private_messages and redacts_runtime_secrets_and_paths', () => {
    const snapshot = buildProjectBoardSnapshot(fixture());
    const serialized = JSON.stringify(snapshot);

    /*
     * REQ-PROJECT-BOARD-ACTIVITY. Activity is filtered on the stored record's own `group`
     * field and on nothing else, which is what the three fixture messages separate: `public`
     * names `demo` and survives, the DM names no group at all, and `approval` names a
     * different room. An exact-group match is the only thing that gets a message in.
     */
    expect(snapshot.projects[0].activity.map(item => item.id)).toEqual(['public']);
    /*
     * REQ-PROJECT-BOARD-PRIVACY, asserted against the serialized snapshot rather than named
     * fields on purpose: the requirement is about egress, so what must hold is that none of
     * these strings appears ANYWHERE in the payload, including in whatever field a later
     * change adds. Covered here, in the order the statement lists them — the direct message
     * and the approval-room message are excluded by the activity assertion above (and with
     * the approval message goes its `request_id`, the only approval detail in the input), the
     * full bodies, the workspace path, the agent token and the runtime model key each have
     * their own line, and the binding author's mxid goes with them.
     */
    expect(serialized).not.toContain('Private DM');
    expect(serialized).not.toContain('full public body');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('secret-agent-token');
    expect(serialized).not.toContain('secret-model-key');
    expect(serialized).not.toContain('@private:example.org');
  });

  it('groups tasks, graphs, and stale agent work deterministically', () => {
    const project = buildProjectBoardSnapshot(fixture()).projects[0];

    /*
     * REQ-PROJECT-BOARD-TASKS. Lanes are keyed by the canonical durable statuses and each
     * task lands in exactly the lane its status names. The empty `created` lane is the load-
     * bearing one: the fixture's only `created` task is assigned to `outsider`, who is not a
     * group member, so this pins the project scoping as well as the grouping.
     */
    expect(project.taskLanes.in_progress.map(task => task.id)).toEqual(['task-1']);
    expect(project.taskLanes.accepted.map(task => task.id)).toEqual(['task-2']);
    expect(project.taskLanes.created).toEqual([]);
    /*
     * The next two lines are NOT a citation for the graph or agent statements in
     * req-project-board.md, and the title of this test should not be read as one. Node ids
     * prove the graph reached the project; nothing here reaches `node.status` or
     * `node.dependsOn`, which those statements name explicitly. Likewise `stale === true`
     * for one WAITING task pins neither the active-task case the spec scenario describes,
     * nor the fresh case (nothing asserts `stale === false`, so a projection that marked
     * everything stale would pass), nor the runtime family and capability the agent
     * statement also requires the board to show.
     */
    expect(project.graphs[0].nodes.map(node => node.id)).toEqual(['implement', 'review']);
    expect(project.agents.find(agent => agent.name === 'review-agent').task.stale).toBe(true);
  });

  it('project_board_keeps_agent_worktrees_distinct behind an explicit binding', () => {
    const project = buildProjectBoardSnapshot(fixture()).projects[0];

    /*
     * REQ-PROJECT-BOARD-RESOURCE-BINDING, the EXACT half of it. `review-agent` also manages
     * `another-private-project`, and the binding names `demo-project`, so the selection has to
     * match on the project value rather than on anything that merely looks related. The last
     * line is the one that would fail on a substring or prefix match.
     */
    expect(project.binding).toEqual(expect.objectContaining({ group: 'demo', project: 'demo-project' }));
    /*
     * REQ-PROJECT-BOARD-WORKTREES, the attachment half: each checkout is paired with the
     * agent that owns it, so two agents on the same repository stay two rows and the
     * repository stays one. `summary.dirtyWorktrees` carries the clean/dirty state — only
     * `review-agent`'s worktree is dirty in the fixture. The safe location label and the
     * revision that this statement also names are pinned at the inspector boundary instead,
     * in tests/project-inspector.test.js.
     */
    expect(project.worktrees.map(item => [item.agent, item.git.branch])).toEqual([
      ['arbitrary-agent', 'feature'],
      ['review-agent', 'review'],
    ]);
    expect(project.repositories).toHaveLength(1);
    /*
     * REQ-PROJECT-BOARD-SPECS reaches the board here: both bound worktrees carry a contract
     * and both survive as separate rows, which is what "the board MUST discover" needs on
     * this side of the projection. Their fields are asserted in tests/project-inspector.test.js.
     *
     * REQ-PROJECT-BOARD-ISSUES is pinned by the next two lines: local and remote issues stay
     * in separate collections all the way through the projection, so a reader of the board
     * cannot mistake a draft document on disk for something a provider is hosting.
     */
    expect(project.specs).toHaveLength(2);
    expect(project.issues.local).toHaveLength(2);
    expect(project.issues.remote).toHaveLength(1);
    expect(project.changeRequests).toHaveLength(1);
    expect(project.summary.dirtyWorktrees).toBe(1);
    expect(JSON.stringify(project)).not.toContain('another-private-project');
  });

  it('project_board_requires_explicit_resource_binding', () => {
    /*
     * REQ-PROJECT-BOARD-RESOURCE-BINDING, the fail-closed half. Everything an inference would
     * need is still present in this input — the group is `demo`, the project is
     * `demo-project`, the agents still carry their inspections, the checkouts and the
     * repository are unchanged — and only the explicit binding is gone. So the empty results
     * below can only come from requiring the binding, not from missing data.
     */
    const input = fixture();
    input.bindings = [];

    const project = buildProjectBoardSnapshot(input).projects[0];

    expect(project.binding).toBeNull();
    expect(project.worktrees).toEqual([]);
    expect(project.repositories).toEqual([]);
    expect(project.specs).toEqual([]);
  });
});
