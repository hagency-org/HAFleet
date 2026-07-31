import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const autodeployScript = path.join(repoRoot, 'scripts', 'hafleet-dev-autodeploy.sh');
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
  *" install --omit=dev"*)
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hafleet-dev-cd-'));
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
  await git(ctx.seed, ['checkout', '-b', 'master']);
  await git(ctx.seed, ['config', 'user.name', 'AgentChat Test']);
  await git(ctx.seed, ['config', 'user.email', 'hafleet@example.test']);
  await fs.writeFile(path.join(ctx.seed, 'package.json'), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
  await fs.writeFile(path.join(ctx.seed, 'README.md'), 'initial\n');
  await git(ctx.seed, ['add', '.']);
  await git(ctx.seed, ['commit', '-m', 'initial master']);
  await git(ctx.seed, ['remote', 'add', 'origin', ctx.origin]);
  await git(ctx.seed, ['push', '-u', 'origin', 'master']);
  await git(tmp, ['clone', '--branch', 'master', ctx.origin, ctx.live]);
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
  await git(ctx.seed, ['push', 'origin', 'master']);
  return git(ctx.seed, ['rev-parse', 'HEAD']);
}

async function runAutodeploy(ctx, env = {}) {
  const baseEnv = {
    ...process.env,
    HAFLEET_DEPLOY_DIR: ctx.live,
    HAFLEET_DEPLOY_BRANCH: 'master',
    HAFLEET_POLL_SEC: '5',
    HAFLEET_ONCE: '1',
    HAFLEET_DEPLOY_STATE_DIR: ctx.state,
    HAFLEET_DEPLOY_SERVICES: 'hafleet-dev-backend.service hafleet-dev-web.service',
    HAFLEET_SYSTEMCTL_BIN: path.join(ctx.binDir, 'systemctl'),
    HAFLEET_SLEEP_BIN: path.join(ctx.binDir, 'sleep'),
    HAFLEET_NPM_BIN: path.join(ctx.binDir, 'npm'),
    HAFLEET_TEST_LOG: ctx.log,
    HOME: ctx.tmp,
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

describe('dev autodeploy dependency retry', () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test('dependency install failure persists retry state after the checkout already reset', async () => {
    const ctx = await setupRepo();
    const nextPackage = `${JSON.stringify({ dependencies: { leftpad: '1.0.0' } }, null, 2)}\n`;
    const nextRef = await commitAndPush(ctx, { 'package.json': nextPackage }, 'change dependencies');
    const failOnce = path.join(ctx.tmp, 'fail-install-once');
    await fs.writeFile(failOnce, 'fail\n');

    const firstRun = await runAutodeploy(ctx, { HAFLEET_FAIL_INSTALL_ONCE: failOnce });

    expect(firstRun.stdout).toContain('Update detected:');
    expect(firstRun.stdout).toContain(`Reset to ${nextRef}`);
    expect(firstRun.stdout).toContain('ERROR: npm install failed; skipping service restart for this update');
    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(nextRef);
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(true);
    let commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).not.toContain('systemctl:--user restart');

    await fs.writeFile(ctx.log, '');
    const secondRun = await runAutodeploy(ctx);

    expect(secondRun.stdout).toContain(`Retrying failed dependency install at ${nextRef}`);
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('systemctl:--user restart hafleet-dev-backend.service');
    expect(commandLog).toContain('systemctl:--user restart hafleet-dev-web.service');
    expect(commandLog).toContain('systemctl:--user is-active --quiet hafleet-dev-backend.service');
    expect(commandLog).toContain('systemctl:--user is-active --quiet hafleet-dev-web.service');
  });

  test('install-needed marker forces install when refs are unchanged', async () => {
    const ctx = await setupRepo();
    await fs.mkdir(ctx.state, { recursive: true });
    await fs.writeFile(path.join(ctx.state, 'install-needed'), '');

    const { stdout } = await runAutodeploy(ctx);

    expect(stdout).toContain(`Retrying failed dependency install at ${ctx.initialRef}`);
    expect(stdout).toContain('Dependency install retry marker present; running npm install --omit=dev');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('npm:');
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('systemctl:--user restart hafleet-dev-backend.service');
    expect(commandLog).toContain('systemctl:--user restart hafleet-dev-web.service');
  });

  test('unchanged refs without marker stay idle', async () => {
    const ctx = await setupRepo();

    await runAutodeploy(ctx);

    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toBe('');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
  });
});
