import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProjectInspector,
  normalizeAtomGitChangeRequest,
  normalizeAtomGitIssue,
  normalizeGitHubChangeRequest,
  normalizeGitHubIssue,
  normalizeGitRemote,
} from '../lib/project-inspector.js';

const temporaryRoots = [];

function temporaryProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-project-inspector-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'specs'), { recursive: true });
  mkdirSync(path.join(root, 'issues'), { recursive: true });
  writeFileSync(path.join(root, 'specs', 'project.spec.md'), `spec: project
name: "Inspector demo"
satisfies: [REQ-DEMO]
tags: [project, demo]
---
Scenario: Safe summary
  Test: inspector_summarizes
`);
  writeFileSync(path.join(root, 'issues', '001-publish.md'), `---
status: draft
---
# Publish this issue
`);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe('project inspector', () => {
  it('project_inspector_summarizes_agent_specs and local_issue_exposes_provider_neutral_publish_target', async () => {
    const root = temporaryProject();
    const commandRunner = async (command, args) => {
      expect(command).toBe('git');
      if (args[0] === 'rev-parse') {
        return { stdout: `${root}\n${root}/.git/worktrees/feature\n${root}/.git\nabcdef1234567890\n` };
      }
      if (args[0] === 'symbolic-ref') return { stdout: 'feature/project-board\n' };
      if (args[0] === 'status') return { stdout: ' M backend-v2.js\n?? specs/new.spec.md\n' };
      if (args[0] === 'remote') return { stdout: 'git@atomgit.com:example/demo.git\n' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const inspector = createProjectInspector({ commandRunner, remoteSync: false });

    const result = await inspector.inspectManagedProject({
      name: 'demo',
      path: root,
      source: 'symlink',
      originPath: root,
    }, 'reviewer');

    expect(result.locationLabel).toBe(path.basename(root));
    expect(result.git).toEqual(expect.objectContaining({
      branch: 'feature/project-board',
      head: 'abcdef123456',
      dirty: true,
      changeCount: 2,
      isWorktree: true,
    }));
    expect(result.repository).toEqual(expect.objectContaining({
      provider: 'atomgit',
      fullName: 'example/demo',
      webUrl: 'https://atomgit.com/example/demo',
    }));
    expect(result.specs).toEqual([
      expect.objectContaining({
        kind: 'project',
        name: 'Inspector demo',
        file: 'specs/project.spec.md',
        satisfies: ['REQ-DEMO'],
        scenarios: 1,
        tests: 1,
      }),
    ]);
    expect(result.localIssues[0]).toEqual(expect.objectContaining({
      source: 'local',
      title: 'Publish this issue',
      file: 'issues/001-publish.md',
      publishTarget: expect.objectContaining({
        provider: 'atomgit',
        repository: 'example/demo',
      }),
    }));
    expect(JSON.stringify(result)).not.toContain(`${root}/`);
  });

  it('normalizes common HTTPS and SSH repository remotes', () => {
    expect(normalizeGitRemote('https://github.com/example/demo.git')).toEqual(expect.objectContaining({
      provider: 'github',
      fullName: 'example/demo',
    }));
    expect(normalizeGitRemote('ssh://git@atomgit.com/example/demo.git')).toEqual(expect.objectContaining({
      provider: 'atomgit',
      fullName: 'example/demo',
    }));
  });

  it('github_pull_request_normalizes_to_change_request', () => {
    const repository = normalizeGitRemote('https://github.com/example/demo.git');
    const issue = normalizeGitHubIssue({
      number: 42,
      title: 'Issue',
      state: 'OPEN',
      url: 'https://github.com/example/demo/issues/42',
      labels: [{ name: 'feature' }],
    }, repository);
    const change = normalizeGitHubChangeRequest({
      number: 7,
      title: 'Change',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/example/demo/pull/7',
      headRefName: 'feature',
      baseRefName: 'main',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { conclusion: 'SUCCESS', status: 'COMPLETED' },
        { conclusion: '', status: 'IN_PROGRESS' },
      ],
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    }, repository);

    expect(issue).toEqual(expect.objectContaining({
      source: 'remote',
      provider: 'github',
      number: 42,
      state: 'open',
    }));
    expect(change).toEqual(expect.objectContaining({
      provider: 'github',
      kind: 'pull_request',
      state: 'open',
      headBranch: 'feature',
      baseBranch: 'main',
      mergeState: 'clean',
      checks: { passed: 1, failed: 0, pending: 1 },
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    }));
  });

  it('atomgit_issues_and_change_requests_use_the_provider_neutral_projection', async () => {
    const root = temporaryProject();
    const commandRunner = async (command, args) => {
      expect(command).toBe('git');
      if (args[0] === 'rev-parse') {
        return { stdout: `${root}\n${root}/.git\n${root}/.git\nabcdef1234567890\n` };
      }
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'remote') return { stdout: 'git@atomgit.com:example/demo.git\n' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const requests = [];
    const atomGitFetch = async (url, options) => {
      requests.push({ url: String(url), options });
      const rows = String(url).includes('/issues?')
        ? [{
            number: '42',
            title: 'AtomGit issue',
            state: 'open',
            html_url: 'https://atomgit.com/example/demo/issues/42',
            updated_at: '2026-07-24T11:00:00+08:00',
            labels: [{ name: 'feature' }],
            assignees: [{ login: 'alex' }],
          }]
        : [{
            number: 7,
            title: 'AtomGit change',
            state: 'open',
            draft: false,
            html_url: 'https://atomgit.com/example/demo/merge_requests/7',
            head: { ref: 'feature' },
            base: { ref: 'main' },
            updated_at: '2026-07-24T12:00:00+08:00',
            mergeable: true,
            added_lines: 10,
            removed_lines: 2,
            changed_files: 3,
          }];
      return { ok: true, status: 200, async json() { return rows; } };
    };
    const inspector = createProjectInspector({
      commandRunner,
      atomGitFetch,
      atomGitToken: 'atomgit-secret-token',
      remoteSync: true,
    });

    const result = await inspector.inspectManagedProject({
      name: 'demo',
      path: root,
      source: 'copy',
    }, 'reviewer');

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toMatch(
        /^https:\/\/api\.atomgit\.com\/api\/v5\/repos\/example\/demo\/(issues|pulls)\?/,
      );
      expect(request.url).toContain('state=all');
      expect(request.url).toContain('per_page=30');
      expect(request.options).toEqual(expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer atomgit-secret-token',
        }),
      }));
    }
    expect(result.repository).toEqual(expect.objectContaining({
      provider: 'atomgit',
      sync: expect.objectContaining({ status: 'ok' }),
    }));
    expect(result.remoteIssues).toEqual([
      expect.objectContaining({
        provider: 'atomgit',
        source: 'remote',
        number: 42,
        labels: ['feature'],
        assignees: ['alex'],
      }),
    ]);
    expect(result.changeRequests).toEqual([
      expect.objectContaining({
        provider: 'atomgit',
        kind: 'change_request',
        number: 7,
        headBranch: 'feature',
        baseBranch: 'main',
        mergeState: 'mergeable',
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('atomgit-secret-token');
  });

  it('atomgit_normalizers_accept_current_and_legacy_response_fields', () => {
    const repository = normalizeGitRemote('https://atomgit.com/example/demo.git');
    expect(normalizeAtomGitIssue({
      number: 3,
      title: 'Legacy issue',
      state: 'closed',
      html_url: 'https://atomgit.com/example/demo/issues/3',
      assignee: { login: 'owner' },
    }, repository)).toEqual(expect.objectContaining({
      provider: 'atomgit',
      number: 3,
      assignees: ['owner'],
    }));
    expect(normalizeAtomGitChangeRequest({
      iid: '9',
      title: 'Current change',
      state: 'open',
      source_branch: 'topic',
      target_branch: 'main',
      web_url: 'https://atomgit.com/example/demo/merge_requests/9',
      added_lines: '5',
      removed_lines: '1',
    }, repository)).toEqual(expect.objectContaining({
      provider: 'atomgit',
      number: 9,
      headBranch: 'topic',
      baseBranch: 'main',
      additions: 5,
      deletions: 1,
    }));
  });

  it('project_inspector_reports_remote_unavailable', async () => {
    const root = temporaryProject();
    const commandRunner = async (command, args) => {
      if (command === 'gh') {
        const error = new Error(`credential rejected for ${root}`);
        error.code = 'AUTH';
        throw error;
      }
      if (args[0] === 'rev-parse') return { stdout: `${root}\n${root}/.git\n${root}/.git\nabcdef1234567890\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'remote') return { stdout: 'https://github.com/example/demo.git\n' };
      throw new Error('unexpected command');
    };
    const inspector = createProjectInspector({ commandRunner, remoteSync: true });

    const result = await inspector.inspectManagedProject({
      name: 'demo',
      path: root,
      source: 'copy',
    }, 'implementer');

    expect(result.repository).toEqual(expect.objectContaining({
      provider: 'github',
      fullName: 'example/demo',
      sync: {
        status: 'unavailable',
        error: 'GitHub observation unavailable',
      },
    }));
    expect(result.remoteIssues).toEqual([]);
    expect(result.changeRequests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('credential');
  });
});
