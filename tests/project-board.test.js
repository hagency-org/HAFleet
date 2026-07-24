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

    expect(snapshot.projects[0].activity.map(item => item.id)).toEqual(['public']);
    expect(serialized).not.toContain('Private DM');
    expect(serialized).not.toContain('full public body');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('secret-agent-token');
    expect(serialized).not.toContain('secret-model-key');
    expect(serialized).not.toContain('@private:example.org');
  });

  it('groups tasks, graphs, and stale agent work deterministically', () => {
    const project = buildProjectBoardSnapshot(fixture()).projects[0];

    expect(project.taskLanes.in_progress.map(task => task.id)).toEqual(['task-1']);
    expect(project.taskLanes.accepted.map(task => task.id)).toEqual(['task-2']);
    expect(project.taskLanes.created).toEqual([]);
    expect(project.graphs[0].nodes.map(node => node.id)).toEqual(['implement', 'review']);
    expect(project.agents.find(agent => agent.name === 'review-agent').task.stale).toBe(true);
  });

  it('project_board_keeps_agent_worktrees_distinct behind an explicit binding', () => {
    const project = buildProjectBoardSnapshot(fixture()).projects[0];

    expect(project.binding).toEqual(expect.objectContaining({ group: 'demo', project: 'demo-project' }));
    expect(project.worktrees.map(item => [item.agent, item.git.branch])).toEqual([
      ['arbitrary-agent', 'feature'],
      ['review-agent', 'review'],
    ]);
    expect(project.repositories).toHaveLength(1);
    expect(project.specs).toHaveLength(2);
    expect(project.issues.local).toHaveLength(2);
    expect(project.issues.remote).toHaveLength(1);
    expect(project.changeRequests).toHaveLength(1);
    expect(project.summary.dirtyWorktrees).toBe(1);
    expect(JSON.stringify(project)).not.toContain('another-private-project');
  });

  it('project_board_requires_explicit_resource_binding', () => {
    const input = fixture();
    input.bindings = [];

    const project = buildProjectBoardSnapshot(input).projects[0];

    expect(project.binding).toBeNull();
    expect(project.worktrees).toEqual([]);
    expect(project.repositories).toEqual([]);
    expect(project.specs).toEqual([]);
  });
});
