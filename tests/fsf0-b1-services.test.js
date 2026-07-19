import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import request from 'supertest';

import {
  LocalServiceSupervisor,
  readServiceStatus,
} from '../src/local-service-supervisor.mjs';
import { loadServiceProfile } from '../src/service-profile.mjs';

const repoRoot = path.resolve('.');
const execFileAsync = promisify(execFile);
const cliPath = path.join(repoRoot, 'services', 'agentchat-services.mjs');
const supervisors = [];
const runtimes = [];
const modulesToStop = [];
const envSnapshots = [];
const fixtureFiles = [];
const networkServers = [];
const networkSockets = [];

function snapshotEnv(keys) {
  const snapshot = new Map(keys.map((key) => [key, process.env[key]]));
  envSnapshots.push(snapshot);
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function createBackendRuntime(prefix) {
  const runtime = mkdtempSync(path.join(os.tmpdir(), prefix));
  runtimes.push(runtime);
  const data = path.join(runtime, 'data');
  mkdirSync(data, { recursive: true });
  for (const [name, value] of Object.entries({
    'agents.json': {},
    'groups.json': {},
    'messages.json': [],
    'cursors.json': {},
    'servers.json': {},
    'agent_runtime.json': {},
    'supervisor_state.json': { agents: {}, selectionCursor: 0 },
    'local_activity_sweep.json': { selectionCursor: 0 },
  })) writeJson(path.join(data, name), value);
  return runtime;
}

async function importBackend(runtime) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtime;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';
  delete process.env.API_TOKEN;
  const url = pathToFileURL(path.join(repoRoot, 'backend-v2.js')).href;
  const mod = await import(`${url}?fsf0-b1=${Date.now()}-${Math.random()}`);
  modulesToStop.push(mod);
  return mod;
}

async function fixtureSupervisor({ restartDelayMs = 40 } = {}) {
  const backendPort = await freePort();
  const dashboardPort = await freePort();
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'agentchat-fsf0-b1-services-'));
  runtimes.push(runtimeRoot);
  const fixture = 'tests/fixtures/service-child.mjs';
  const service = (name, dependsOn, health, env = {}) => ({
    name,
    command: ['node', fixture],
    dependsOn,
    health,
    env: { SERVICE_CHILD_NAME: name, ...env },
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
    restartDelayMs,
    dependencyTimeoutMs: 3000,
  });
  supervisors.push(supervisor);
  return { supervisor, profile, runtimeRoot };
}

async function importDashboard(runtime) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtime;
  process.env.AGENT_CHAT_WEB_PORT = '18084';
  process.env.AGENT_CHAT_BACKEND_PORT = '18090';
  const url = pathToFileURL(path.join(repoRoot, 'server.js')).href;
  const mod = await import(`${url}?fsf0-b1-dashboard=${Date.now()}-${Math.random()}`);
  modulesToStop.push(mod);
  return mod;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met in ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) await supervisor.stop().catch(() => {});
  for (const mod of modulesToStop.splice(0).reverse()) {
    if (typeof mod.resetServerTestHooks === 'function') mod.resetServerTestHooks();
    if (typeof mod.stopServer === 'function') await mod.stopServer();
  }
  for (const runtime of runtimes.splice(0)) rmSync(runtime, { recursive: true, force: true });
  for (const filename of fixtureFiles.splice(0)) rmSync(filename, { force: true });
  for (const socket of networkSockets.splice(0)) socket.destroy();
  await Promise.all(networkServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const snapshot of envSnapshots.splice(0).reverse()) restoreEnv(snapshot);
});

test('services_start_all_healthy', async () => {
  const production = loadServiceProfile({
    profilePath: path.join(repoRoot, 'services', 'services-local.json'),
    repoRoot,
  });
  const runtimeRoot = createBackendRuntime('agentchat-fsf0-b1-production-services-');
  mkdirSync(path.join(runtimeRoot, 'logs'), { recursive: true });
  const backendPort = await freePort();
  const dashboardPort = await freePort();
  const matrixPort = await freePort();
  const matrixServer = net.createServer((socket) => networkSockets.push(socket));
  networkServers.push(matrixServer);
  await new Promise((resolve) => matrixServer.listen(matrixPort, '127.0.0.1', resolve));
  const supervisor = new LocalServiceSupervisor({
    profile: production,
    repoRoot,
    runtimeRoot,
    env: {
      ...process.env,
      AGENT_CHAT_RUNTIME_DIR: runtimeRoot,
      AGENT_CHAT_BACKEND_PORT: String(backendPort),
      AGENT_CHAT_WEB_PORT: String(dashboardPort),
      API_TOKEN: 'fsf0-b1-production-smoke-token',
      SUPERVISOR_ENABLED: 'false',
      AGENT_SCOPE_MONITOR_ENABLED: 'false',
      MATRIX_HOMESERVER: `http://127.0.0.1:${matrixPort}`,
      MATRIX_SERVER_NAME: 'localhost',
      MATRIX_BOT_PASSWORD: 'fsf0-b1-bot-password',
      MATRIX_AGENT_PASSWORD_SECRET: 'fsf0-b1-agent-password-secret',
    },
    dependencyTimeoutMs: 10000,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  const status = await supervisor.waitForHealthy(5000);
  expect(status.ok).toBe(true);
  expect(status.services.map((service) => service.name)).toEqual([
    'backend', 'dashboard', 'bridge', 'relay',
  ]);
  expect(production.services.map((service) => service.command[1])).toEqual([
    'backend-v2.js', 'server.js', 'bridge-matrix.js', 'push-relay.js',
  ]);
});

test('restart_preserves_agent_registry', async () => {
  snapshotEnv([
    'AGENT_CHAT_RUNTIME_DIR', 'SUPERVISOR_ENABLED', 'AGENT_SCOPE_MONITOR_ENABLED',
    'AGENT_JSON_WRITE_BATCH_MS', 'API_TOKEN',
  ]);
  const runtime = createBackendRuntime('agentchat-fsf0-b1-registry-');
  const first = await importBackend(runtime);
  for (const name of ['worker-alpha', 'worker-beta', 'worker-gamma']) {
    await request(first.app).post('/api/agents').send({ name, role: 'worker' }).expect(200);
  }
  const before = await request(first.app).get('/api/agents').query({ view: 'names' }).expect(200);
  await first.stopServer();
  const second = await importBackend(runtime);
  const after = await request(second.app).get('/api/agents').query({ view: 'names' }).expect(200);
  expect(after.body).toEqual(before.body);
});

test('dashboard_roster_matches_registry', async () => {
  snapshotEnv(['AGENT_CHAT_RUNTIME_DIR', 'AGENT_CHAT_WEB_PORT', 'AGENT_CHAT_BACKEND_PORT']);
  const runtime = createBackendRuntime('agentchat-fsf0-b1-dashboard-');
  mkdirSync(path.join(runtime, 'logs'), { recursive: true });
  const dashboard = await importDashboard(runtime);
  const registry = [
    { name: 'worker-alpha', tmux: 'worker-alpha:0.0' },
    { name: 'worker-beta', tmux: null },
    { name: 'worker-gamma', tmux: 'worker-gamma:0.0' },
  ];
  const tmuxCalls = [];
  dashboard.setServerTestHooks({
    backendFetch: async () => ({ ok: true, status: 200, json: async () => registry }),
    execFileAsync: async (...args) => {
      tmuxCalls.push(args);
      return { stdout: 'stale-tmux-session\n' };
    },
  });
  const roster = await request(dashboard.app).get('/api/agents/all').expect(200);
  expect(roster.body).toEqual(registry);
  expect(roster.text).not.toContain('stale-tmux-session');
  expect(tmuxCalls).toEqual([]);
});

test('doctor_reports_stopped_bridge', async () => {
  const { supervisor, runtimeRoot } = await fixtureSupervisor({ restartDelayMs: 2000 });
  await supervisor.start();
  await supervisor.waitForHealthy(3000);
  await supervisor.stopService('bridge', { restart: false });
  const profilePath = path.join(repoRoot, 'tests', 'fixtures', `.fsf0-b1-doctor-${randomUUID()}.json`);
  fixtureFiles.push(profilePath);
  writeJson(profilePath, supervisor.profile);
  let error = null;
  try {
    await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--profile', profilePath, '--runtime', runtimeRoot, '--json',
    ], { cwd: repoRoot, timeout: 5000, encoding: 'utf8' });
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe(1);
  const diagnosis = JSON.parse(error.stdout);
  expect(diagnosis.ok).toBe(false);
  expect(diagnosis.failures).toContainEqual(expect.objectContaining({ name: 'bridge' }));
});

test('status_reports_crashed_service', async () => {
  const { supervisor, profile, runtimeRoot } = await fixtureSupervisor({ restartDelayMs: 2000 });
  await supervisor.start();
  await supervisor.waitForHealthy(3000);
  const relayPid = supervisor.getServicePid('relay');
  process.kill(relayPid, 'SIGKILL');
  await waitFor(() => supervisor.getServicePid('relay') === null);

  const startedAt = Date.now();
  const status = await readServiceStatus({ profile, runtimeRoot });
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(status.services.find((service) => service.name === 'relay')).toMatchObject({
    healthy: false,
    state: 'not-healthy',
  });
});
