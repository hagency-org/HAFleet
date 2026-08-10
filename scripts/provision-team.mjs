#!/usr/bin/env node
// provision-team: one-shot onboarding for a per-member agent team.
//
// Creates a git worktree for the team, then provisions the four issue-workflow
// role agents (<team>_coordinator/implementer/reviewer/final_reviewer) with the
// worktree symlink-mounted under each agent's workdir/projects/. Thin
// orchestration over scripts/provision-v1-agent-home.js — no backend calls, no
// secrets: registration tokens and Matrix accounts stay explicit operator steps
// (printed as next steps).
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVISION_AGENT = path.join(__dirname, 'provision-v1-agent-home.js');

/*
 * Role order mirrors the issue-workflow skill; final_reviewer runs a different
 * runtime (codex) on purpose — adversarial diversity for the final gate.
 *
 * `role` here is an agent-NAME suffix, not a capability role: these become
 * `<team>_coordinator` and so on. They are a different vocabulary from the six in
 * lib/role-capacity.json, and the bridge between them has always been
 * canonicalRole(), which matches substrings of the agent's name.
 *
 * `canonical` states the intended target explicitly. The substring match still
 * does the work at runtime, but the intent is now written down and checked
 * (tests/provision-team.test.js), so renaming a workflow role or editing
 * canonicalRole's patterns can no longer silently re-file an agent under a
 * different capability role.
 */
export const ROLES = [
  { role: 'coordinator', defaultType: 'claude', canonical: 'architect' },
  { role: 'implementer', defaultType: 'claude', canonical: 'coding' },
  { role: 'reviewer', defaultType: 'claude', canonical: 'review' },
  { role: 'final_reviewer', defaultType: 'codex', canonical: 'review' },
];

function fail(message) {
  throw new Error(message);
}

function resolveHome(home) {
  return path.resolve(home || process.env.HAFLEET_HOMEDIR || path.join(os.homedir(), '.hafleet'));
}

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', ...opts });
}

export function planTeamProvision({ team, project, home, branch, worktree, type, finalType } = {}) {
  const teamName = String(team || '').trim();
  if (!/^[a-z][a-z0-9]{0,23}$/.test(teamName)) {
    fail(`invalid team name "${teamName}": lowercase letter followed by [a-z0-9], max 24 chars (it becomes the agent-name prefix)`);
  }
  const projectPath = path.resolve(String(project || ''));
  if (!existsSync(projectPath)) fail(`project path does not exist: ${projectPath}`);
  try {
    git(projectPath, ['rev-parse', '--git-dir'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    fail(`project is not a git repository: ${projectPath}`);
  }

  const homeDir = resolveHome(home);
  const agents = ROLES.map(({ role, defaultType }) => {
    const name = `${teamName}_${role}`;
    return {
      role,
      name,
      agentId: `agent_${name}`,
      type: role === 'final_reviewer' ? (finalType || defaultType) : (type || defaultType),
    };
  });
  for (const agent of agents) {
    if (existsSync(path.join(homeDir, 'agents', agent.agentId))) {
      fail(`team "${teamName}" already provisioned: agent home exists for ${agent.name} (${path.join(homeDir, 'agents', agent.agentId)})`);
    }
  }

  const projectName = path.basename(projectPath);
  const worktreePath = path.resolve(worktree || path.join(path.dirname(projectPath), `${projectName}-${teamName}`));
  if (existsSync(worktreePath)) fail(`worktree target already exists: ${worktreePath}`);

  return {
    team: teamName,
    project: projectPath,
    projectName,
    home: homeDir,
    branch: branch || `team/${teamName}`,
    worktree: worktreePath,
    agents,
  };
}

export function executeTeamProvision(plan, { dryRun = false, quiet = false } = {}) {
  const log = (line) => { if (!quiet) console.log(line); };
  const steps = [];
  const branchExists = (() => {
    try {
      git(plan.project, ['show-ref', '--verify', `refs/heads/${plan.branch}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch { return false; }
  })();

  steps.push(branchExists
    ? `git -C ${plan.project} worktree add ${plan.worktree} ${plan.branch}`
    : `git -C ${plan.project} worktree add -b ${plan.branch} ${plan.worktree}`);
  for (const agent of plan.agents) {
    steps.push(`provision-v1-agent-home --name ${agent.name} --type ${agent.type} --project ${plan.worktree} --project-mode symlink`);
  }

  if (dryRun) {
    log('[dry-run] would execute:');
    for (const s of steps) log(`  ${s}`);
    return { dryRun: true, steps, created: { worktree: false, agents: [] } };
  }

  if (branchExists) {
    git(plan.project, ['worktree', 'add', plan.worktree, plan.branch]);
  } else {
    git(plan.project, ['worktree', 'add', '-b', plan.branch, plan.worktree]);
  }
  log(`worktree ready: ${plan.worktree} (branch ${plan.branch})`);

  const created = [];
  for (const agent of plan.agents) {
    execFileSync(process.execPath, [
      PROVISION_AGENT,
      '--name', agent.name,
      '--type', agent.type,
      '--home', plan.home,
      '--project', plan.worktree,
      '--project-mode', 'symlink',
      '--project-name', plan.projectName,
    ], { stdio: quiet ? 'ignore' : 'inherit' });
    created.push(agent.name);
    log(`agent home ready: ${agent.name} (${agent.type})`);
  }

  log('');
  log('Next steps (explicit operator actions, not automated here):');
  log(`  1. Matrix accounts: register ac_${plan.team}_* users (see roadmap/hafleet-demo/register-accounts.mjs)`);
  log(`  2. Agent tokens (hard mode): mint tokens for the four agents before backend registration`);
  log(`  3. Register + start via backend API (POST /api/agents, POST /api/agents/<name>/start)`);
  log(`  4. In the member's Robrix room: invite ${plan.team}_coordinator (observer bot follows), then bind the room to group "${plan.team}"`);
  return { dryRun: false, steps, created: { worktree: true, agents: created } };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'dry-run') { args.dryRun = true; continue; }
    args[name] = argv[i + 1];
    i += 1;
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.team || !a.project) {
    console.log(`Usage: provision-team --team <name> --project <git-repo> [options]

Options:
  --branch <name>      Team branch (default: team/<team>)
  --worktree <path>    Worktree target (default: sibling <project>-<team>)
  --type <t>           Runtime for coordinator/implementer/reviewer (default: claude)
  --final-type <t>     Runtime for final_reviewer (default: codex — adversarial diversity)
  --home <path>        HAFLEET_HOMEDIR override
  --dry-run            Print the plan without creating anything`);
    process.exit(a.team || a.project ? 1 : 0);
  }
  try {
    const plan = planTeamProvision({
      team: a.team, project: a.project, home: a.home,
      branch: a.branch, worktree: a.worktree, type: a.type, finalType: a['final-type'],
    });
    executeTeamProvision(plan, { dryRun: Boolean(a.dryRun) });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
