import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const autodeployScript = path.join(repoRoot, 'scripts', 'agentchat-remote-autodeploy.sh');
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
printf 'systemctl:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
case " $* " in
  *" list-units "*) printf '%s.service loaded active running\\n' "$AGENTCHAT_RELAY_SERVICE" ;;
esac
exit 0
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'sudo'),
    `#!/usr/bin/env bash
printf 'sudo:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
"$@"
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'sleep'),
    `#!/usr/bin/env bash
printf 'sleep:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
exit 0
`,
  );
  await writeExecutable(
    path.join(ctx.binDir, 'npm'),
    `#!/usr/bin/env bash
printf 'npm:%s:%s\\n' "$PWD" "$*" >> "$AGENTCHAT_TEST_LOG"
case " $* " in
  *" install --omit=dev"*)
    if [ -n "\${AGENTCHAT_FAIL_INSTALL_ONCE:-}" ] && [ -f "$AGENTCHAT_FAIL_INSTALL_ONCE" ]; then
      rm -f "$AGENTCHAT_FAIL_INSTALL_ONCE"
      exit 8
    fi
    ;;
esac
exit 0
`,
  );
}

async function setupRepo() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentchat-remote-cd-'));
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
  await fs.mkdir(path.join(ctx.seed, 'remote'));
  await fs.writeFile(path.join(ctx.seed, 'remote', 'package.json'), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
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
    AGENT_CHAT_HOME: ctx.live,
    AGENTCHAT_DEPLOY_BRANCH: 'stable',
    AGENTCHAT_POLL_SEC: '5',
    AGENTCHAT_ONCE: '1',
    AGENTCHAT_DEPLOY_STATE_DIR: ctx.state,
    AGENTCHAT_RELAY_SERVICE: 'agent-chat-push-relay',
    AGENTCHAT_SYSTEMCTL_BIN: path.join(ctx.binDir, 'systemctl'),
    AGENTCHAT_SUDO_BIN: path.join(ctx.binDir, 'sudo'),
    AGENTCHAT_SLEEP_BIN: path.join(ctx.binDir, 'sleep'),
    AGENTCHAT_NPM_BIN: path.join(ctx.binDir, 'npm'),
    AGENTCHAT_TEST_LOG: ctx.log,
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

describe('remote autodeploy dependency retry', () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test('dependency install failure after reset retries on unchanged refs before restart', async () => {
    const ctx = await setupRepo();
    const nextPackage = `${JSON.stringify({ dependencies: { zod: '4.3.6' } }, null, 2)}\n`;
    const nextRef = await commitAndPush(ctx, { 'remote/package.json': nextPackage }, 'change remote dependencies');
    const failOnce = path.join(ctx.tmp, 'fail-install-once');
    await fs.writeFile(failOnce, 'fail\n');

    const firstRun = await runAutodeploy(ctx, { AGENTCHAT_FAIL_INSTALL_ONCE: failOnce });

    expect(firstRun.stdout).toContain('Update detected:');
    expect(firstRun.stdout).toContain(`Reset to ${nextRef}`);
    expect(firstRun.stdout).toContain('ERROR: npm install failed; skipping restart for this update');
    await expect(git(ctx.live, ['rev-parse', 'HEAD'])).resolves.toBe(nextRef);
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(true);
    let commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain(`npm:${path.join(ctx.live, 'remote')}:`);
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).not.toContain('sudo:');
    expect(commandLog).not.toContain('restart agent-chat-push-relay');

    await fs.writeFile(ctx.log, '');
    const secondRun = await runAutodeploy(ctx);

    expect(secondRun.stdout).toContain(`Retrying failed dependency install at ${nextRef}`);
    expect(secondRun.stdout).toContain('Remote dependency install retry marker present; running npm install --omit=dev in remote/');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain(`npm:${path.join(ctx.live, 'remote')}:`);
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('systemctl:list-units --type=service --all');
    expect(commandLog).toContain('sudo:');
    expect(commandLog).toContain('restart agent-chat-push-relay');
  });

  test('root package changes restart without installing remote dependencies', async () => {
    const ctx = await setupRepo();
    const nextPackage = `${JSON.stringify({ dependencies: { express: '4.21.0' } }, null, 2)}\n`;
    const nextLock = `${JSON.stringify({ name: 'root-lock', lockfileVersion: 3 }, null, 2)}\n`;
    const nextRef = await commitAndPush(
      ctx,
      {
        'package.json': nextPackage,
        'package-lock.json': nextLock,
      },
      'change root dependencies only',
    );

    const runResult = await runAutodeploy(ctx);

    expect(runResult.stdout).toContain('Update detected:');
    expect(runResult.stdout).toContain(`Reset to ${nextRef}`);
    expect(runResult.stdout).toContain('Deploy succeeded');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).not.toContain('npm:');
    expect(commandLog).toContain('systemctl:list-units --type=service --all');
    expect(commandLog).toContain('restart agent-chat-push-relay');
  });

  test('remote package lock changes install from the remote tree', async () => {
    const ctx = await setupRepo();
    const nextLock = `${JSON.stringify({ name: 'remote-lock', lockfileVersion: 3 }, null, 2)}\n`;
    const nextRef = await commitAndPush(ctx, { 'remote/package-lock.json': nextLock }, 'change remote lock');

    const runResult = await runAutodeploy(ctx);

    expect(runResult.stdout).toContain('Update detected:');
    expect(runResult.stdout).toContain(`Reset to ${nextRef}`);
    expect(runResult.stdout).toContain('Remote dependency manifest changed; running npm install --omit=dev in remote/');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain(`npm:${path.join(ctx.live, 'remote')}:`);
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('restart agent-chat-push-relay');
  });

  test('unchanged refs without marker stay idle', async () => {
    const ctx = await setupRepo();

    await runAutodeploy(ctx);

    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toBe('');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
  });
});
