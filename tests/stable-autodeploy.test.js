import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const autodeployScript = path.join(repoRoot, 'scripts', 'hafleet-stable-autodeploy.sh');
const tmpRoots = [];

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 4,
    ...options,
  });
  return result.stdout.trim();
}

async function git(cwd, args) {
  return run('git', args, { cwd });
}

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

async function createFakeCommands(ctx) {
  await fs.mkdir(ctx.binDir, { recursive: true });
  await writeExecutable(
    path.join(ctx.binDir, 'systemctl'),
    `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> "$HAFLEET_TEST_LOG"
exit 0
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'curl'),
    `#!/usr/bin/env bash
printf 'curl:%s\\n' "$*" >> "$HAFLEET_TEST_LOG"
exit 0
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'sleep'),
    `#!/usr/bin/env bash
printf 'sleep:%s\\n' "$*" >> "$HAFLEET_TEST_LOG"
exit 0
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'npm'),
    `#!/usr/bin/env bash
prefix=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--prefix" ]; then
    prefix="$arg"
  fi
  previous="$arg"
done
target="\${prefix:-$PWD}"
printf 'npm:%s:%s\\n' "$target" "$*" >> "$HAFLEET_TEST_LOG"
case " $* " in
  *" run verify:cd-preflight"*)
    if [ -f "$target/gate-fail" ]; then
      exit 7
    fi
    ;;
esac
case " $* " in
  *" install --production"*)
    if [ -n "\${HAFLEET_FAIL_INSTALL_ONCE:-}" ] && [ -f "$HAFLEET_FAIL_INSTALL_ONCE" ]; then
      rm -f "$HAFLEET_FAIL_INSTALL_ONCE"
      exit 8
    fi
    ;;
esac
exit 0
`,
  );
}

async function setupRepo() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hafleet-stable-cd-'));
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
  await git(ctx.seed, ['config', 'user.email', 'hafleet@example.test']);
  await fs.writeFile(
    path.join(ctx.seed, 'package.json'),
    `${JSON.stringify({ scripts: { 'verify:cd-preflight': 'node -e "process.exit(0)"' }, dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(ctx.seed, 'README.md'), 'initial\n');
  await git(ctx.seed, ['add', '.']);
  await git(ctx.seed, ['commit', '-m', 'initial stable']);
  await git(ctx.seed, ['remote', 'add', 'origin', ctx.origin]);
  await git(ctx.seed, ['push', '-u', 'origin', 'stable']);
  await git(tmp, ['clone', '--branch', 'stable', ctx.origin, ctx.live]);
  ctx.initialRef = await git(ctx.live, ['rev-parse', 'HEAD']);
  await createFakeCommands(ctx);
  return ctx;
}

async function commitAndPush(ctx, files, message) {
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(ctx.seed, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await git(ctx.seed, ['add', '.']);
  await git(ctx.seed, ['commit', '-m', message]);
  await git(ctx.seed, ['push', 'origin', 'stable']);
  return git(ctx.seed, ['rev-parse', 'HEAD']);
}

async function runAutodeploy(ctx, env = {}) {
  const baseEnv = {
    ...process.env,
    HAFLEET_LIVE_DIR: ctx.live,
    HAFLEET_DEPLOY_USER: os.userInfo().username,
    HAFLEET_DEPLOY_BRANCH: 'stable',
    HAFLEET_POLL_SEC: '5',
    HAFLEET_ONCE: '1',
    HAFLEET_DEPLOY_STATE_DIR: ctx.state,
    HAFLEET_BACKEND_HEALTH_TIMEOUT: '1',
    HAFLEET_DEPLOY_SERVICES: 'hafleet-backend hafleet',
    HAFLEET_SYSTEMCTL_BIN: path.join(ctx.binDir, 'systemctl'),
    HAFLEET_CURL_BIN: path.join(ctx.binDir, 'curl'),
    HAFLEET_SLEEP_BIN: path.join(ctx.binDir, 'sleep'),
    HAFLEET_NPM_BIN: path.join(ctx.binDir, 'npm'),
    HAFLEET_RELEASE_GATE: 'none',
    HAFLEET_RELEASE_GATE_ARGS: '',
    HAFLEET_TEST_LOG: ctx.log,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete baseEnv[key];
    else baseEnv[key] = value;
  }
  return execFileAsync('bash', [autodeployScript], {
    cwd: repoRoot,
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 4,
    env: baseEnv,
  });
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function pathExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function expectGateInstallBeforePreflight(commandLog) {
  const npmLines = commandLog.split('\n').filter((line) => line.startsWith('npm:'));
  const ciIndex = npmLines.findIndex((line) => line.includes(' ci'));
  const preflightIndex = npmLines.findIndex((line) => line.includes(' run verify:cd-preflight'));
  expect(ciIndex).toBeGreaterThanOrEqual(0);
  expect(preflightIndex).toBeGreaterThan(ciIndex);
}

describe('stable autodeploy CD gate', () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test('worktree release gate failure does not reset or restart the live checkout', async () => {
    const ctx = await setupRepo();
    await commitAndPush(ctx, { 'gate-fail': 'fail the staged gate\n' }, 'add failing gate marker');

    const { stdout } = await runAutodeploy(ctx, { HAFLEET_RELEASE_GATE: 'worktree' });

    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(ctx.initialRef);
    expect(stdout).toContain('Running worktree release gate');
    expect(stdout).toContain('release gate failed');
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expectGateInstallBeforePreflight(commandLog);
    expect(commandLog).not.toContain('systemctl:');
    await expect(readIfExists(path.join(ctx.state, 'last-successful-ref'))).resolves.toBe('');
  });

  test('worktree release gate success resets and restarts the live checkout', async () => {
    const ctx = await setupRepo();
    const nextRef = await commitAndPush(ctx, { 'README.md': 'safe update\n' }, 'safe staged update');

    const { stdout } = await runAutodeploy(ctx, { HAFLEET_RELEASE_GATE: 'worktree' });

    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(nextRef);
    expect(stdout).toContain('Running worktree release gate');
    expect(stdout).toContain('Release gate passed');
    expect(stdout).toContain('Deploy succeeded');
    await expect(readIfExists(path.join(ctx.state, 'last-successful-ref'))).resolves.toBe(`${nextRef}\n`);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expectGateInstallBeforePreflight(commandLog);
    expect(commandLog).toContain('run verify:cd-preflight');
    expect(commandLog).not.toContain('install --production');
    expect(commandLog).toContain('systemctl:restart hafleet-backend');
    expect(commandLog).toContain('systemctl:restart hafleet');
  });

  test('default deploy state dir under .git supports the worktree gate', async () => {
    const ctx = await setupRepo();
    const nextRef = await commitAndPush(ctx, { 'README.md': 'default state update\n' }, 'default state update');
    const liveGitDir = await git(ctx.live, ['rev-parse', '--absolute-git-dir']);

    await runAutodeploy(ctx, {
      HAFLEET_RELEASE_GATE: 'worktree',
      HAFLEET_DEPLOY_STATE_DIR: undefined,
    });

    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(nextRef);
    await expect(readIfExists(path.join(liveGitDir, 'hafleet-autodeploy', 'last-successful-ref'))).resolves.toBe(`${nextRef}\n`);
  });

  test('dependency install failure persists retry state after the live checkout already reset', async () => {
    const ctx = await setupRepo();
    const nextPackage = `${JSON.stringify({ scripts: { 'verify:cd-preflight': 'node -e "process.exit(0)"' }, dependencies: { leftpad: '1.0.0' } }, null, 2)}\n`;
    const nextRef = await commitAndPush(ctx, { 'package.json': nextPackage }, 'change dependencies');
    const failOnce = path.join(ctx.tmp, 'fail-install-once');
    await fs.writeFile(failOnce, 'fail\n');

    await runAutodeploy(ctx, { HAFLEET_FAIL_INSTALL_ONCE: failOnce });

    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(nextRef);
    await expect(readIfExists(path.join(ctx.state, 'last-successful-ref'))).resolves.toBe(`${ctx.initialRef}\n`);
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(true);
    let commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expect(commandLog).not.toContain('systemctl:restart');

    await fs.writeFile(ctx.log, '');
    const { stdout } = await runAutodeploy(ctx);

    expect(stdout).toContain('Retrying failed dependency install');
    await expect(readIfExists(path.join(ctx.state, 'last-successful-ref'))).resolves.toBe(`${nextRef}\n`);
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expect(commandLog).toContain('systemctl:restart hafleet-backend');
    expect(commandLog).toContain('systemctl:restart hafleet');
    expect(commandLog).toContain('systemctl:is-active --quiet hafleet-backend');
  });
});
