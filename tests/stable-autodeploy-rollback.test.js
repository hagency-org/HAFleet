import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const autodeployScript = path.join(repoRoot, 'scripts', 'agentchat-stable-autodeploy.sh');
const tmpRoots = [];

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    timeout: 15000, maxBuffer: 1024 * 1024 * 4, ...options,
  });
  return result.stdout.trim();
}

const git = (cwd, args) => run('git', args, { cwd });

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

/**
 * Fake commands. systemctl fails whenever the live checkout contains
 * `breaks-service`, which models a commit that genuinely breaks startup: once
 * rollback resets past that commit, the restart succeeds on its own.
 */
async function createFakeCommands(ctx) {
  await fs.mkdir(ctx.binDir, { recursive: true });
  await writeExecutable(path.join(ctx.binDir, 'systemctl'), `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
if [ -f "$AGENTCHAT_LIVE_DIR/breaks-service" ]; then
  printf 'systemctl:FAILED (breaks-service present)\\n' >> "$AGENTCHAT_TEST_LOG"
  exit 1
fi
exit 0
`);
  for (const name of ['curl', 'sleep']) {
    await writeExecutable(path.join(ctx.binDir, name), `#!/usr/bin/env bash
printf '${name}:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
exit 0
`);
  }
  await writeExecutable(path.join(ctx.binDir, 'npm'), `#!/usr/bin/env bash
printf 'npm:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
exit 0
`);
}

async function setupRepo({ brokenFromStart = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentchat-cd-rollback-'));
  tmpRoots.push(tmp);
  const ctx = {
    tmp,
    origin: path.join(tmp, 'origin.git'),
    seed: path.join(tmp, 'seed'),
    live: path.join(tmp, 'live'),
    state: path.join(tmp, 'state'),
    binDir: path.join(tmp, 'bin'),
    log: path.join(tmp, 'commands.log'),
  };

  await git(tmp, ['init', '--bare', ctx.origin]);
  await fs.mkdir(ctx.seed);
  await git(ctx.seed, ['init']);
  await git(ctx.seed, ['checkout', '-b', 'stable']);
  await git(ctx.seed, ['config', 'user.name', 'AgentChat Test']);
  await git(ctx.seed, ['config', 'user.email', 'agentchat@example.test']);
  await fs.writeFile(path.join(ctx.seed, 'package.json'), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
  await fs.writeFile(path.join(ctx.seed, 'README.md'), 'initial\n');
  if (brokenFromStart) {
    // Nothing in history is healthy, so even the rollback target fails.
    await fs.writeFile(path.join(ctx.seed, 'breaks-service'), 'boom\n');
  }
  await git(ctx.seed, ['add', '.']);
  await git(ctx.seed, ['commit', '-m', 'initial stable']);
  await git(ctx.seed, ['remote', 'add', 'origin', ctx.origin]);
  await git(ctx.seed, ['push', '-u', 'origin', 'stable']);
  await git(tmp, ['clone', '--branch', 'stable', ctx.origin, ctx.live]);
  ctx.initialRef = await git(ctx.live, ['rev-parse', 'HEAD']);
  await createFakeCommands(ctx);
  return ctx;
}

async function commitAndPush(ctx, files, message, removals = []) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(ctx.seed, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  for (const rel of removals) {
    await fs.rm(path.join(ctx.seed, rel), { force: true });
  }
  await git(ctx.seed, ['add', '-A']);
  await git(ctx.seed, ['commit', '-m', message]);
  await git(ctx.seed, ['push', 'origin', 'stable']);
  return git(ctx.seed, ['rev-parse', 'HEAD']);
}

function runAutodeploy(ctx, env = {}) {
  return execFileAsync('bash', [autodeployScript], {
    cwd: repoRoot,
    timeout: 20000,
    maxBuffer: 1024 * 1024 * 4,
    env: {
      ...process.env,
      AGENTCHAT_LIVE_DIR: ctx.live,
      AGENTCHAT_DEPLOY_USER: os.userInfo().username,
      AGENTCHAT_DEPLOY_BRANCH: 'stable',
      // The script enforces a floor of 5; sleep is faked, so this costs nothing.
      AGENTCHAT_POLL_SEC: '5',
      AGENTCHAT_ONCE: '1',
      AGENTCHAT_DEPLOY_STATE_DIR: ctx.state,
      AGENTCHAT_BACKEND_HEALTH_TIMEOUT: '1',
      AGENTCHAT_DEPLOY_SERVICES: 'agent-chat-v2 agent-chat',
      AGENTCHAT_SYSTEMCTL_BIN: path.join(ctx.binDir, 'systemctl'),
      AGENTCHAT_CURL_BIN: path.join(ctx.binDir, 'curl'),
      AGENTCHAT_SLEEP_BIN: path.join(ctx.binDir, 'sleep'),
      AGENTCHAT_NPM_BIN: path.join(ctx.binDir, 'npm'),
      AGENTCHAT_RELEASE_GATE: 'none',
      AGENTCHAT_TEST_LOG: ctx.log,
      ...env,
    },
  });
}

async function readIfExists(file) {
  try {
    return (await fs.readFile(file, 'utf-8')).trim();
  } catch {
    return null;
  }
}

const stateFile = (ctx, name) => path.join(ctx.state, name);

afterEach(async () => {
  while (tmpRoots.length) {
    await fs.rm(tmpRoots.pop(), { recursive: true, force: true });
  }
});

describe('autodeploy rollback', () => {
  test('a healthy deploy records the ref and leaves no quarantine', async () => {
    const ctx = await setupRepo();
    const good = await commitAndPush(ctx, { 'README.md': 'good\n' }, 'good change');

    await runAutodeploy(ctx);

    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(good);
    expect(await readIfExists(stateFile(ctx, 'last-successful-ref'))).toBe(good);
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBeNull();
    expect(await readIfExists(stateFile(ctx, 'last-failure'))).toBeNull();
  });

  test('a failed health gate rolls the live checkout back and quarantines the ref', async () => {
    const ctx = await setupRepo();
    const good = await commitAndPush(ctx, { 'README.md': 'good\n' }, 'good change');
    await runAutodeploy(ctx);
    expect(await readIfExists(stateFile(ctx, 'last-successful-ref'))).toBe(good);

    // This commit breaks startup: the fake systemctl fails while it is checked out.
    const bad = await commitAndPush(ctx, { 'breaks-service': 'boom\n' }, 'breaks the service');
    const { stdout } = await runAutodeploy(ctx);

    // Rolled back rather than left broken.
    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(good);
    expect(stdout).toContain(`Rolling back from ${bad}`);
    expect(stdout).toContain(`Rollback to ${good} succeeded`);

    // Quarantined, with the last good ref preserved.
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBe(bad);
    expect(await readIfExists(stateFile(ctx, 'last-successful-ref'))).toBe(good);

    const failure = JSON.parse(await readIfExists(stateFile(ctx, 'last-failure')));
    expect(failure).toMatchObject({ ref: bad, stage: 'health_gate', rollback: 'succeeded' });
    expect(failure.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('a quarantined ref is not retried on the next poll', async () => {
    const ctx = await setupRepo();
    const good = await commitAndPush(ctx, { 'README.md': 'good\n' }, 'good change');
    await runAutodeploy(ctx);
    const bad = await commitAndPush(ctx, { 'breaks-service': 'boom\n' }, 'breaks the service');
    await runAutodeploy(ctx);

    // This is the regression under test: previously deploy_pending stayed true
    // and the same bad commit was re-deployed every poll interval forever.
    const { stdout } = await runAutodeploy(ctx);

    expect(stdout).toContain('HOLDING');
    expect(stdout).not.toContain('Reset to');
    expect(stdout).not.toContain('Rolling back');
    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(good);
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBe(bad);
  });

  test('a new commit clears the quarantine and deploys', async () => {
    const ctx = await setupRepo();
    const good = await commitAndPush(ctx, { 'README.md': 'good\n' }, 'good change');
    await runAutodeploy(ctx);
    const bad = await commitAndPush(ctx, { 'breaks-service': 'boom\n' }, 'breaks the service');
    await runAutodeploy(ctx);
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBe(bad);

    // The fix removes the offending file.
    const fixed = await commitAndPush(ctx, { 'README.md': 'fixed\n' }, 'revert the breakage', ['breaks-service']);
    const { stdout } = await runAutodeploy(ctx);

    expect(stdout).toContain(`clearing quarantine`);
    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(fixed);
    expect(await readIfExists(stateFile(ctx, 'last-successful-ref'))).toBe(fixed);
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBeNull();
    expect(await readIfExists(stateFile(ctx, 'last-failure'))).toBeNull();
  });

  test('the very first deploy still has a rollback target', async () => {
    const ctx = await setupRepo();
    // initialize_success_state seeds last-successful-ref with the currently
    // checked-out ref before touching anything, so a first-ever deploy that
    // fails is still recoverable. Worth pinning: it is not obvious.
    const bad = await commitAndPush(ctx, { 'breaks-service': 'boom\n' }, 'breaks the service');
    const { stdout } = await runAutodeploy(ctx);

    expect(stdout).toContain(`Rollback to ${ctx.initialRef} succeeded`);
    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(ctx.initialRef);
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBe(bad);
  });

  test('reports fatal and does not claim success when the rollback target is also unhealthy', async () => {
    const ctx = await setupRepo({ brokenFromStart: true });
    const bad = await commitAndPush(ctx, { 'README.md': 'still broken\n' }, 'another broken commit');
    const { stdout } = await runAutodeploy(ctx);

    // Rollback ran but could not reach a healthy state; that must be reported
    // as FATAL rather than quietly implying recovery.
    expect(stdout).toContain('FATAL: rollback did not restore a healthy state');
    expect(stdout).toContain('Manual intervention required');
    expect(await readIfExists(stateFile(ctx, 'quarantined-ref'))).toBe(bad);

    const failure = JSON.parse(await readIfExists(stateFile(ctx, 'last-failure')));
    expect(failure).toMatchObject({ ref: bad, stage: 'health_gate', rollback: 'failed' });
  });

  test('alerting is opt-in and never masks the deploy failure', async () => {
    const ctx = await setupRepo();
    const good = await commitAndPush(ctx, { 'README.md': 'good\n' }, 'good change');
    await runAutodeploy(ctx);
    await commitAndPush(ctx, { 'breaks-service': 'boom\n' }, 'breaks the service');

    // Point the alert at a URL the fake curl "accepts"; the run must still
    // report the rollback rather than being derailed by alerting.
    const { stdout } = await runAutodeploy(ctx, {
      AGENTCHAT_ALERT_URL: 'http://127.0.0.1:9/api/alerts',
      AGENTCHAT_ALERT_TOKEN: 'test-token',
    });

    expect(stdout).toContain('Rollback to');
    expect(await git(ctx.live, ['rev-parse', 'HEAD'])).toBe(good);

    const log = await readIfExists(ctx.log);
    expect(log).toContain('/api/alerts');
  });
});
