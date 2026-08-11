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

    /*
     * REQ-PROJECT-BOARD-WORKTREES, the per-checkout fields. This is where the safe location
     * label, the branch, the revision and the clean/dirty state are actually pinned: the label
     * is the basename rather than the path, the head is truncated to 12 characters, and dirty
     * plus changeCount come from parsing porcelain status rather than from a flag someone set.
     * The owning-agent attachment is pinned on the board side, in tests/project-board.test.js.
     * `commandRunner` asserts every call is `git` with an argument array, which is what makes
     * this inspection bounded rather than a shell.
     */
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
    /*
     * REQ-PROJECT-BOARD-SPECS. A discovered contract is summarized, not shipped: kind, name,
     * requirement links and scenario count are each asserted, and the `satisfies` value here is
     * the synthetic id written into the fixture spec above, which is why it is a made-up one.
     * The modification time the statement also names is produced by the inspector but is not
     * asserted by this expectation — see the report accompanying this change.
     */
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
    /*
     * REQ-PROJECT-BOARD-ISSUES. `source: 'local'` is what keeps a draft on disk from reading as
     * something a provider is hosting, and the publish target is derived from the checkout's
     * own AtomGit remote — so the board can say where this issue would go without the operator
     * having to guess, and without inventing a target when there is no remote.
     */
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
    /*
     * NOT a citation for the repository-shape statement in req-project-board.md. That statement
     * names five host classes the provider-neutral shape must represent — GitHub, AtomGit,
     * GitLab, Gitee and unknown Git hosts — and this test exercises the first two. `gitlab`,
     * `gitee`, the generic `git` fallback and `unknown` are all live branches of
     * `providerFromHost` with no assertion anywhere, so the breadth the statement is actually
     * about is unverified and the row is left uncovered rather than greened by two providers.
     */
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
    /*
     * REQ-PROJECT-BOARD-CHANGES and the GitHub half of REQ-PROJECT-BOARD-PROVIDERS. A GitHub
     * pull request goes in and a change request comes out: provider, branch pair, state, checks
     * and the diff summary are all common fields, and none of GitHub's own vocabulary survives
     * — `headRefName`, `mergeStateStatus` and `statusCheckRollup` become `headBranch`,
     * `mergeState` and a passed/failed/pending count. `state: 'OPEN'` becoming `'open'` is part
     * of it: the projection has one spelling, not each provider's.
     */
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

    /*
     * REQ-PROJECT-BOARD-PROVIDERS, the AtomGit half and the credential clause. Three things
     * have to hold at once and each has its own assertion below: observation goes through
     * AtomGit's own read APIs rather than a GitHub-shaped guess (two calls, both to
     * `/api/v5/repos/example/demo/{issues,pulls}`); the results land in the same fields the
     * GitHub adapter produces; and the token appears in a request header and nowhere else —
     * `not.toContain('atomgit-secret-token')` over the whole result is the assertion that
     * would fail if the projection ever started carrying it.
     *
     * REQ-PROJECT-BOARD-CHANGES is carried here too, for the `number` and merge-request shape
     * the GitHub case above does not assert: an AtomGit merge request normalizes to
     * `kind: 'change_request'` with number 7, a branch pair, and a diff summary parsed out of
     * `added_lines`/`removed_lines`.
     *
     * REQ-PROJECT-BOARD-ISSUES gets its other side from `source: 'remote'` on the remote
     * issue — the local/remote distinction is a real field on both, not a collection name.
     */
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

    /*
     * REQ-PROJECT-BOARD-PROVIDERS on the failure path, which is where a credential is most
     * likely to escape. The `gh` runner throws an error whose message contains the local path,
     * and what reaches the projection is a fixed `'GitHub observation unavailable'` string —
     * not the thrown text. The last two assertions are the ones that matter: neither the path
     * nor the word `credential` survives, so the error is reported without being quoted, and
     * the repository stays visible instead of vanishing when observation fails.
     */
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
