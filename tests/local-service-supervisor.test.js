import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  LocalServiceSupervisor,
  diagnoseServices,
  readServiceStatus,
} from '../src/local-service-supervisor.mjs';
import { getProcessStartIdentity } from '../src/process-identity.mjs';

const repoRoot = path.resolve('.');
const fixtureScript = 'tests/fixtures/service-child.mjs';
const supervisors = [];
const runtimes = [];
const children = [];
const servers = [];

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

async function fixtureContext() {
  const backendPort = await freePort();
  const dashboardPort = await freePort();
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-services-runtime-'));
  runtimes.push(runtimeRoot);
  const eventLog = path.join(runtimeRoot, 'events.jsonl');
  const service = (name, dependsOn, health, extraEnv = {}) => ({
    name,
    command: ['node', fixtureScript],
    dependsOn,
    health,
    env: {
      SERVICE_CHILD_NAME: name,
      SERVICE_EVENT_LOG: eventLog,
      ...extraEnv,
    },
  });
  const profile = {
    name: 'services-local',
    services: [
      service('backend', [], {
        type: 'http', host: '127.0.0.1', defaultPort: backendPort, path: '/health', timeoutMs: 300,
      }, { SERVICE_CHILD_PORT: String(backendPort) }),
      service('dashboard', ['backend'], {
        type: 'tcp', host: '127.0.0.1', defaultPort: dashboardPort, timeoutMs: 300,
      }, { SERVICE_CHILD_PORT: String(dashboardPort) }),
      service('bridge', ['backend'], { type: 'process', timeoutMs: 300 }),
      service('relay', ['backend'], { type: 'process', timeoutMs: 300 }),
    ],
  };
  const supervisor = new LocalServiceSupervisor({
    profile,
    repoRoot,
    runtimeRoot,
    env: { ...process.env, API_TOKEN: 'must-not-appear-in-state' },
    restartDelayMs: 40,
    dependencyTimeoutMs: 3000,
  });
  supervisors.push(supervisor);
  return { supervisor, profile, runtimeRoot, eventLog };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) {
    await supervisor.stop().catch(() => {});
  }
  for (const runtime of runtimes.splice(0)) rmSync(runtime, { recursive: true, force: true });
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch {}
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('LocalServiceSupervisor', () => {
  test('starts all four services in dependency order and reports healthy', async () => {
    const { supervisor, eventLog } = await fixtureContext();
    await supervisor.start();
    const status = await supervisor.waitForHealthy(3000);

    expect(status.ok).toBe(true);
    expect(status.services.map((service) => service.name)).toEqual([
      'backend', 'dashboard', 'bridge', 'relay',
    ]);
    expect(status.services.every((service) => service.healthy && service.pid > 0)).toBe(true);

    const events = await waitFor(() => {
      const rows = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return rows.length === 4 ? rows : null;
    });
    // backend is the only real ordering constraint: dashboard, bridge and relay
    // all depend on backend alone, so they start CONCURRENTLY and the order in
    // which they report ready is a race. Asserting a fixed order passed on an
    // idle machine and failed under CI load.
    expect(events[0]).toMatchObject({ name: 'backend', event: 'ready' });
    expect(events.slice(1).map((event) => event.name).sort())
      .toEqual(['bridge', 'dashboard', 'relay']);
  });

  test('automatically restarts a crashed relay exactly once', async () => {
    const { supervisor, eventLog } = await fixtureContext();
    await supervisor.start();
    await supervisor.waitForHealthy(3000);
    const oldPid = supervisor.getServicePid('relay');
    const oldServicePid = await waitFor(() => {
      const rows = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return rows.find((event) => event.name === 'relay' && event.event === 'ready')?.pid || null;
    });

    try {
      process.kill(oldPid, 'SIGKILL');
      const restarted = await waitFor(async () => {
        const status = await supervisor.status();
        const relay = status.services.find((service) => service.name === 'relay');
        return relay?.healthy && relay.pid !== oldPid && relay.restarts === 1 ? relay : null;
      });

      expect(restarted.pid).not.toBe(oldPid);
      await waitFor(() => {
        try { process.kill(oldServicePid, 0); return false; } catch { return true; }
      });
    } finally {
      try { process.kill(oldServicePid, 'SIGKILL'); } catch {}
    }
  });

  test('doctor names an explicitly stopped bridge', async () => {
    const { supervisor, profile, runtimeRoot } = await fixtureContext();
    await supervisor.start();
    await supervisor.waitForHealthy(3000);
    await supervisor.stopService('bridge', { restart: false });

    const diagnosis = await diagnoseServices({ profile, runtimeRoot, env: process.env });
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.failures).toContainEqual(expect.objectContaining({
      name: 'bridge',
      cause: expect.stringMatching(/stopped|process/i),
    }));
  });

  test('status reports a crashed service within five seconds', async () => {
    const { supervisor, profile, runtimeRoot } = await fixtureContext();
    await supervisor.start();
    await supervisor.waitForHealthy(3000);
    await supervisor.stopService('relay', { restart: false });

    const startedAt = Date.now();
    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(status.services.find((service) => service.name === 'relay')).toMatchObject({
      healthy: false,
      desired: 'stopped',
    });
  });

  test('writes atomic redacted state snapshots', async () => {
    const { supervisor, runtimeRoot } = await fixtureContext();
    await supervisor.start();
    await supervisor.waitForHealthy(3000);

    const stateDir = path.join(runtimeRoot, 'data', 'services-local');
    const stateText = readFileSync(path.join(stateDir, 'state.json'), 'utf8');
    expect(JSON.parse(stateText).services).toHaveLength(4);
    expect(stateText).not.toContain('must-not-appear-in-state');
    expect(readdirSync(stateDir).some((name) => name.includes('.tmp'))).toBe(false);
  });

  test('offline status rejects a live PID whose command does not match the service script', async () => {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-services-pid-reuse-'));
    runtimes.push(runtimeRoot);
    const stateDir = path.join(runtimeRoot, 'data', 'services-local');
    mkdirSync(stateDir, { recursive: true });
    const profile = {
      name: 'services-local',
      services: ['backend', 'dashboard', 'bridge', 'relay'].map((name) => ({
        name,
        command: ['node', fixtureScript],
        dependsOn: [],
        env: {},
        health: { type: 'process', timeoutMs: 300 },
      })),
    };
    writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      supervisor: {
        pid: process.pid,
        processStartIdentity: getProcessStartIdentity(process.pid),
      },
      services: profile.services.map(({ name }) => ({
        name,
        pid: process.pid,
        processStartIdentity: getProcessStartIdentity(process.pid),
        desired: 'running',
        restarts: 0,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        startedAtMs: Date.now() - 1000,
      })),
    })}\n`);

    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    expect(status.ok).toBe(false);
    expect(status.services.every((service) => !service.healthy)).toBe(true);
    expect(status.services[0].reason).toMatch(/command|pid/i);
  });

  test('offline status rejects a matching command with a stale process identity', async () => {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-services-service-identity-'));
    runtimes.push(runtimeRoot);
    const stateDir = path.join(runtimeRoot, 'data', 'services-local');
    mkdirSync(stateDir, { recursive: true });
    const child = spawn(process.execPath, [fixtureScript, '--identity-test'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(() => {
      try { process.kill(child.pid, 0); return true; } catch { return false; }
    });
    const profile = {
      name: 'services-local',
      services: ['backend', 'dashboard', 'bridge', 'relay'].map((name) => ({
        name,
        command: ['node', fixtureScript],
        dependsOn: [],
        env: {},
        health: { type: 'process', timeoutMs: 300 },
      })),
    };
    writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify({
      supervisor: {
        pid: process.pid,
        processStartIdentity: getProcessStartIdentity(process.pid),
      },
      services: profile.services.map(({ name }) => ({
        name,
        pid: child.pid,
        processStartIdentity: 'stale-process-identity',
        desired: 'running',
        startedAtMs: Date.now() - 1000,
      })),
    })}\n`);

    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    expect(status.ok).toBe(false);
    expect(status.services.every((service) => !service.healthy)).toBe(true);
    expect(status.services[0].reason).toMatch(/identity/i);
  });

  test('offline status checks four slow probes concurrently within five seconds', async () => {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-services-bounded-status-'));
    runtimes.push(runtimeRoot);
    const stateDir = path.join(runtimeRoot, 'data', 'services-local');
    mkdirSync(stateDir, { recursive: true });
    const profile = { name: 'bounded-status', services: [] };
    const records = [];
    for (const name of ['backend', 'dashboard', 'bridge', 'relay']) {
      const server = http.createServer(() => {});
      servers.push(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const child = spawn(process.execPath, [fixtureScript, '--status-probe', name], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      children.push(child);
      await waitFor(() => {
        try { process.kill(child.pid, 0); return true; } catch { return false; }
      });
      profile.services.push({
        name,
        command: ['node', fixtureScript],
        dependsOn: [],
        env: {},
        health: {
          type: 'http', host: '127.0.0.1', defaultPort: server.address().port,
          path: '/health', timeoutMs: 1500,
        },
      });
      records.push({
        name,
        pid: child.pid,
        processStartIdentity: getProcessStartIdentity(child.pid),
        desired: 'running',
        restarts: 0,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        startedAtMs: Date.now() - 1000,
      });
    }
    writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify({
      supervisor: {
        pid: process.pid,
        processStartIdentity: getProcessStartIdentity(process.pid),
      },
      services: records,
    })}\n`);

    const startedAt = Date.now();
    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(status.ok).toBe(false);
    expect(status.services.every((service) => !service.healthy)).toBe(true);
  });
});
