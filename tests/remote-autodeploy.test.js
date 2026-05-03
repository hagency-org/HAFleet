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
if [ -n "\${AGENTCHAT_TEST_SLEEP_COUNT_FILE:-}" ]; then
  count=0
  if [ -f "$AGENTCHAT_TEST_SLEEP_COUNT_FILE" ]; then
    count="$(cat "$AGENTCHAT_TEST_SLEEP_COUNT_FILE")"
  fi
  count="$((count + 1))"
  printf '%s\\n' "$count" > "$AGENTCHAT_TEST_SLEEP_COUNT_FILE"
  if [ -n "\${AGENTCHAT_TEST_SLEEP_FAIL_AFTER:-}" ] && [ "$count" -ge "$AGENTCHAT_TEST_SLEEP_FAIL_AFTER" ]; then
    exit 42
  fi
fi
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
  await writeExecutable(
    path.join(ctx.binDir, 'verify-remote'),
    `#!/usr/bin/env bash
printf 'verify-remote:%s\\n' "$*" >> "$AGENTCHAT_TEST_LOG"
if [ -n "\${AGENTCHAT_FAIL_VERIFY_ONCE:-}" ] && [ -f "$AGENTCHAT_FAIL_VERIFY_ONCE" ]; then
  rm -f "$AGENTCHAT_FAIL_VERIFY_ONCE"
  exit 9
fi
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
    AGENTCHAT_VERIFY_REMOTE_BIN: path.join(ctx.binDir, 'verify-remote'),
    AGENTCHAT_TEST_LOG: ctx.log,
    AGENT_CHAT_API: 'http://127.0.0.1:8090',
    AGENT_CHAT_SERVER: 'remote-test',
    API_TOKEN: 'test-token',
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

async function runAutodeployExpectFailure(ctx, env = {}) {
  try {
    const result = await runAutodeploy(ctx, env);
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error?.code === 'number') {
      return {
        code: error.code,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
      };
    }
    throw error;
  }
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
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);
    commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain(`npm:${path.join(ctx.live, 'remote')}:`);
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('systemctl:list-units --type=service --all');
    expect(commandLog).toContain('sudo:');
    expect(commandLog).toContain('restart agent-chat-push-relay');
    expect(commandLog).toContain('verify-remote:');
    expect(commandLog).toContain('--api http://127.0.0.1:8090');
    expect(commandLog).toContain('--server remote-test');
    expect(commandLog).toContain('--samples 2');
    expect(commandLog).toContain('--interval 16');
    expect(commandLog).toContain(`--expect-version ${nextShort}`);
    expect(commandLog).toContain('--token test-token');
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
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).not.toContain('npm:');
    expect(commandLog).toContain('systemctl:list-units --type=service --all');
    expect(commandLog).toContain('restart agent-chat-push-relay');
    expect(commandLog).toContain('verify-remote:');
    expect(commandLog).toContain(`--expect-version ${nextShort}`);
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
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain(`npm:${path.join(ctx.live, 'remote')}:`);
    expect(commandLog).toContain('install --omit=dev');
    expect(commandLog).toContain('restart agent-chat-push-relay');
    expect(commandLog).toContain('verify-remote:');
    expect(commandLog).toContain(`--expect-version ${nextShort}`);
  });

  test('post-deploy verification failure keeps deploy pending without reporting success', async () => {
    const ctx = await setupRepo();
    const nextRef = await commitAndPush(ctx, { 'README.md': 'verify fail update\n' }, 'verify fails');
    const failOnce = path.join(ctx.tmp, 'fail-verify-once');
    await fs.writeFile(failOnce, 'fail\n');

    const runResult = await runAutodeploy(ctx, {
      AGENTCHAT_FAIL_VERIFY_ONCE: failOnce,
      VERIFY_AGENT: 'canary',
      VERIFY_SAMPLES: '3',
      VERIFY_INTERVAL: '17',
    });
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);

    expect(runResult.stdout).toContain('Update detected:');
    expect(runResult.stdout).toContain(`Reset to ${nextRef}`);
    expect(runResult.stdout).toContain(`Verifying remote deploy at version ${nextShort}`);
    expect(runResult.stdout).toContain(`ERROR: remote post-deploy verification failed at commit ${nextRef}`);
    expect(runResult.stdout).not.toContain('Deploy succeeded');
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('restart agent-chat-push-relay');
    expect(commandLog).toContain('verify-remote:');
    expect(commandLog).toContain('--samples 3');
    expect(commandLog).toContain('--interval 17');
    expect(commandLog).toContain('--agent canary');
    expect(commandLog).toContain(`--expect-version ${nextShort}`);
  });

  test('post-deploy verification failure retries on the next poll', async () => {
    const ctx = await setupRepo();
    const nextRef = await commitAndPush(ctx, { 'README.md': 'verify retry update\n' }, 'verify retries');
    const failOnce = path.join(ctx.tmp, 'fail-verify-once');
    const sleepCount = path.join(ctx.tmp, 'sleep-count');
    await fs.writeFile(failOnce, 'fail\n');

    const runResult = await runAutodeployExpectFailure(ctx, {
      AGENTCHAT_ONCE: '0',
      AGENTCHAT_FAIL_VERIFY_ONCE: failOnce,
      AGENTCHAT_TEST_SLEEP_COUNT_FILE: sleepCount,
      AGENTCHAT_TEST_SLEEP_FAIL_AFTER: '2',
    });
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);

    expect(runResult.code).toBe(42);
    expect(runResult.stdout).toContain(`ERROR: remote post-deploy verification failed at commit ${nextRef}`);
    expect(runResult.stdout).toContain(`Retrying failed deploy at ${nextRef}`);
    expect(runResult.stdout).toContain(`Verifying remote deploy at version ${nextShort}`);
    expect(runResult.stdout).toContain(`Deploy succeeded at commit ${nextRef}`);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog.match(/verify-remote:/g)?.length).toBe(2);
    expect(commandLog).toContain('sleep:5');
  });

  test('post-deploy verification can read API settings from remote env file', async () => {
    const ctx = await setupRepo();
    await fs.writeFile(
      path.join(ctx.live, 'remote', '.env'),
      [
        'AGENT_CHAT_API=http://env-file.example.test',
        'AGENT_CHAT_SERVER=env-server',
        'API_TOKEN=env-token',
        'VERIFY_AGENT=env-canary',
        'VERIFY_SAMPLES=4',
        'VERIFY_INTERVAL=18',
        '',
      ].join('\n'),
    );
    const nextRef = await commitAndPush(ctx, { 'README.md': 'env verify update\n' }, 'env verify');

    const runResult = await runAutodeploy(ctx, {
      AGENT_CHAT_API: undefined,
      AGENT_CHAT_SERVER: undefined,
      API_TOKEN: undefined,
    });
    const nextShort = await git(ctx.live, ['rev-parse', '--short', 'HEAD']);

    expect(runResult.stdout).toContain(`Deploy succeeded at commit ${nextRef}`);
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('verify-remote:');
    expect(commandLog).toContain('--api http://env-file.example.test');
    expect(commandLog).toContain('--server env-server');
    expect(commandLog).toContain('--token env-token');
    expect(commandLog).toContain('--agent env-canary');
    expect(commandLog).toContain('--samples 4');
    expect(commandLog).toContain('--interval 18');
    expect(commandLog).toContain(`--expect-version ${nextShort}`);
  });

  test('post-deploy verification missing server config keeps deploy pending without success', async () => {
    const ctx = await setupRepo();
    const nextRef = await commitAndPush(ctx, { 'README.md': 'missing server update\n' }, 'missing server');

    const runResult = await runAutodeploy(ctx, {
      AGENT_CHAT_SERVER: undefined,
    });

    expect(runResult.stdout).toContain(`Reset to ${nextRef}`);
    expect(runResult.stdout).toContain('ERROR: missing AGENT_CHAT_SERVER; cannot verify remote deploy');
    expect(runResult.stdout).toContain(`ERROR: remote post-deploy verification failed at commit ${nextRef}`);
    expect(runResult.stdout).not.toContain('Deploy succeeded');
    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toContain('restart agent-chat-push-relay');
    expect(commandLog).not.toContain('verify-remote:');
  });

  test('unchanged refs without marker stay idle', async () => {
    const ctx = await setupRepo();

    await runAutodeploy(ctx);

    const commandLog = await readIfExists(ctx.log);
    expect(commandLog).toBe('');
    await expect(pathExists(path.join(ctx.state, 'install-needed'))).resolves.toBe(false);
  });
});
