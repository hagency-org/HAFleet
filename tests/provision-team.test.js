import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { planTeamProvision, executeTeamProvision, ROLES } from '../scripts/provision-team.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function makeTempGitRepo(base) {
  const repo = path.join(base, 'proj');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  writeFileSync(path.join(repo, 'README.md'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  return repo;
}

describe('provision-team', () => {
  let tmp;
  let repo;
  let home;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'provteam-'));
    repo = makeTempGitRepo(tmp);
    home = path.join(tmp, 'hafleet-home');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('plan: four roles, final_reviewer is codex, worktree + branch derived from team', () => {
    const plan = planTeamProvision({ team: 'bob', project: repo, home });
    expect(plan.team).toBe('bob');
    expect(plan.branch).toBe('team/bob');
    expect(plan.worktree).toBe(path.resolve(path.dirname(repo), 'proj-bob'));
    expect(plan.agents.map(a => a.name)).toEqual([
      'bob_coordinator', 'bob_implementer', 'bob_reviewer', 'bob_final_reviewer',
    ]);
    const types = Object.fromEntries(plan.agents.map(a => [a.name, a.type]));
    expect(types.bob_coordinator).toBe('claude');
    expect(types.bob_final_reviewer).toBe('codex');
  });

  it('plan: rejects invalid team names and non-git projects', () => {
    expect(() => planTeamProvision({ team: 'Bob!', project: repo, home })).toThrow(/team/i);
    const notRepo = path.join(tmp, 'plain');
    mkdirSync(notRepo);
    expect(() => planTeamProvision({ team: 'bob', project: notRepo, home })).toThrow(/git/i);
  });

  it('execute: creates worktree on team branch and four agent homes with symlinked project', () => {
    const plan = planTeamProvision({ team: 'bob', project: repo, home });
    const result = executeTeamProvision(plan, { quiet: true });
    expect(result.created.worktree).toBe(true);
    expect(existsSync(path.join(plan.worktree, 'README.md'))).toBe(true);
    const branch = execFileSync('git', ['-C', plan.worktree, 'branch', '--show-current']).toString().trim();
    expect(branch).toBe('team/bob');
    for (const agent of plan.agents) {
      const manifest = JSON.parse(readFileSync(path.join(home, 'agents', agent.agentId, 'agent.json'), 'utf-8'));
      expect(manifest.name).toBe(agent.name);
      expect(manifest.type).toBe(agent.type);
      const link = path.join(manifest.workdir, 'projects', plan.projectName);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('execute: refuses to clobber an already-provisioned team', () => {
    const plan = planTeamProvision({ team: 'bob', project: repo, home });
    executeTeamProvision(plan, { quiet: true });
    expect(() => planTeamProvision({ team: 'bob', project: repo, home })).toThrow(/already/i);
  });

  it('dry-run: reports steps but creates nothing', () => {
    const plan = planTeamProvision({ team: 'eve', project: repo, home });
    const result = executeTeamProvision(plan, { dryRun: true, quiet: true });
    expect(result.dryRun).toBe(true);
    expect(existsSync(plan.worktree)).toBe(false);
    expect(existsSync(path.join(home, 'agents'))).toBe(false);
  });
});
