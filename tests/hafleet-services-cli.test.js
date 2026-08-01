import { afterEach, describe, expect, test } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const cliPath = path.join(repoRoot, 'services', 'hafleet-services.mjs');
const fixtureProfilePath = path.join(repoRoot, 'tests', 'fixtures', 'services-local-test.json');
const runtimes = [];
const profilePaths = new Map();

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function context() {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'hafleet-services-cli-'));
  runtimes.push(runtime);
  const profilePath = path.join(repoRoot, 'tests', 'fixtures', `.services-local-test-${randomUUID()}.json`);
  profilePaths.set(runtime, profilePath);
  const profile = JSON.parse(readFileSync(fixtureProfilePath, 'utf8'));
  for (const service of profile.services) service.command.push('--runtime-tag', runtime);
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const env = {
    ...process.env,
    TEST_BACKEND_PORT: String(await freePort()),
    TEST_DASHBOARD_PORT: String(await freePort()),
    SERVICE_CHILD_BACKEND_PORT: '',
    SERVICE_CHILD_DASHBOARD_PORT: '',
    API_TOKEN: 'cli-secret-must-be-redacted',
  };
  env.SERVICE_CHILD_BACKEND_PORT = env.TEST_BACKEND_PORT;
  env.SERVICE_CHILD_DASHBOARD_PORT = env.TEST_DASHBOARD_PORT;
  const args = ['--profile', profilePath, '--runtime', runtime, '--json'];
  return { runtime, env, args, profilePath };
}

async function run(command, ctx, timeout = 8000) {
  return execFileAsync(process.execPath, [cliPath, command, ...ctx.args], {
    cwd: repoRoot,
    env: ctx.env,
    timeout,
    encoding: 'utf8',
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function killRuntimeProcesses(runtime) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }));
  } catch {}
  const pids = stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !match[2].includes(runtime)) return [];
    return [Number(match[1])];
  }).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    const profilePath = profilePaths.get(runtime) || fixtureProfilePath;
    try {
      await execFileAsync(process.execPath, [
        cliPath, 'stop', '--profile', profilePath, '--runtime', runtime, '--json',
      ], { cwd: repoRoot, timeout: 5000, encoding: 'utf8' });
    } catch {}
    await killRuntimeProcesses(runtime);
    rmSync(runtime, { recursive: true, force: true });
    rmSync(profilePath, { force: true });
    profilePaths.delete(runtime);
  }
});

describe('hafleet-services CLI', () => {
  test('detached start, status, and stop manage all four processes', async () => {
    const ctx = await context();
    const started = JSON.parse((await run('start', ctx)).stdout);
    expect(started.ok).toBe(true);
    expect(started.services).toHaveLength(4);
    const pids = started.services.map((service) => service.pid);
    expect(pids.every(pidAlive)).toBe(true);

    const statusResult = await run('status', ctx);
    const status = JSON.parse(statusResult.stdout);
    expect(status.ok).toBe(true);
    expect(status.services.map((service) => service.name)).toEqual([
      'backend', 'dashboard', 'bridge', 'relay',
    ]);
    expect(statusResult.stdout).not.toContain('cli-secret-must-be-redacted');

    const stopped = JSON.parse((await run('stop', ctx)).stdout);
    expect(stopped.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pids.every((pid) => !pidAlive(pid))).toBe(true);
  });

  test('refuses to stop when the pid record token does not match state', async () => {
    const ctx = await context();
    await run('start', ctx);
    const pidPath = path.join(ctx.runtime, 'data', 'services-local', 'supervisor.pid.json');
    const pidRecord = JSON.parse(readFileSync(pidPath, 'utf8'));
    writeFileSync(pidPath, `${JSON.stringify({ ...pidRecord, token: 'tampered-token' })}\n`);

    await expect(run('stop', ctx)).rejects.toMatchObject({ code: expect.anything() });
    writeFileSync(pidPath, `${JSON.stringify(pidRecord)}\n`);
    const stopped = JSON.parse((await run('stop', ctx)).stdout);
    expect(stopped.ok).toBe(true);
  });

  test('stale supervisor status is unhealthy and its children self-terminate', async () => {
    const ctx = await context();
    const started = JSON.parse((await run('start', ctx)).stdout);
    const childPids = started.services.map((service) => service.pid);
    const pidPath = path.join(ctx.runtime, 'data', 'services-local', 'supervisor.pid.json');
    const supervisorPid = JSON.parse(readFileSync(pidPath, 'utf8')).pid;

    try {
      process.kill(supervisorPid, 'SIGKILL');
      await waitFor(() => !pidAlive(supervisorPid));
      await waitFor(() => childPids.every((pid) => !pidAlive(pid)), 5000);

      await expect(run('status', ctx)).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('supervisor'),
      });
      const stopped = JSON.parse((await run('stop', ctx)).stdout);
      expect(stopped.ok).toBe(true);
    } finally {
      for (const pid of childPids) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  });

  test('concurrent start calls leave exactly one managed supervisor', async () => {
    const ctx = await context();
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => run('start', ctx, 12000)));
    expect(attempts.every((attempt) => attempt.status === 'fulfilled')).toBe(true);

    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const supervisors = stdout.split('\n').filter((line) => (
      line.includes(cliPath) && line.includes(' run ') && line.includes(ctx.runtime)
    ));
    expect(supervisors).toHaveLength(1);

    const status = JSON.parse((await run('status', ctx)).stdout);
    expect(status.ok).toBe(true);
    expect(status.services.every((service) => pidAlive(service.pid))).toBe(true);
  });

  test('stop rejects a reused PID even when its command line is crafted to match', async () => {
    const ctx = await context();
    const stateDir = path.join(ctx.runtime, 'data', 'services-local');
    mkdirSync(stateDir, { recursive: true });
    const crafted = spawn(process.execPath, [
      path.join(repoRoot, 'tests', 'fixtures', 'service-child.mjs'), cliPath, 'run', ctx.runtime,
    ], { cwd: repoRoot, stdio: 'ignore' });
    await waitFor(() => pidAlive(crafted.pid));
    const token = 'matching-stale-token';
    const record = {
      pid: crafted.pid,
      token,
      runtimeRoot: ctx.runtime,
      profile: 'services-local-test',
      startedAt: new Date(0).toISOString(),
      processStartIdentity: 'stale-process-identity',
    };
    writeFileSync(path.join(stateDir, 'supervisor.pid.json'), `${JSON.stringify(record)}\n`);
    writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify({
      supervisor: record,
      services: [],
    })}\n`);

    try {
      await expect(run('stop', ctx)).rejects.toMatchObject({ code: 1 });
      expect(pidAlive(crafted.pid)).toBe(true);
    } finally {
      try { process.kill(crafted.pid, 'SIGKILL'); } catch {}
    }
  });
});
