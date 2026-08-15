/*
 * What survived the old portal.
 *
 * `tests/server-dashboard-boundary.test.js` covered two unrelated things: the dashboard's own page
 * rendering, and the MUTATION BOUNDARY that decides which writes a non-local caller may make. The pages
 * are deleted (the operator: 「8084 是旧的 portal,完全没有用了」) and their tests went with them. The
 * boundary is not a page — it guards the queue and the agent routes this process still serves — so it is
 * kept, moved here, and no longer sits behind a filename that says "dashboard".
 *
 * Nothing here asserts rendered HTML. If a test in this file starts doing that, the portal has grown back.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';

const SERVER_ENV_KEYS = [
  'HAFLEET_RUNTIME_DIR',
  'HAFLEET_WEB_PORT',
  'HAFLEET_BACKEND_PORT',
  'HAFLEET_DASHBOARD_TOKEN',
  'AGENT_IDLE_THRESHOLD_MS',
];

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  if (!snapshot) return;
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function waitFor(promise, timeoutMs = 1000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function importServer(runtimeDir, extraEnv = {}) {
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.HAFLEET_WEB_PORT = '18084';
  process.env.HAFLEET_BACKEND_PORT = '18090';
  process.env.HAFLEET_DASHBOARD_TOKEN = extraEnv.HAFLEET_DASHBOARD_TOKEN || '';
  if (extraEnv.AGENT_IDLE_THRESHOLD_MS !== undefined) {
    process.env.AGENT_IDLE_THRESHOLD_MS = extraEnv.AGENT_IDLE_THRESHOLD_MS;
  } else {
    delete process.env.AGENT_IDLE_THRESHOLD_MS;
  }
  const serverUrl = pathToFileURL(path.resolve('server.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return import(`${serverUrl}?dashboard-boundary-test=${cacheBust}`);
}

describe('server dashboard mutation boundary', () => {
  let runtimeDir = null;
  let serverModule = null;
  let envSnapshot = null;

  async function setup(extraEnv = {}) {
    envSnapshot = snapshotEnv(SERVER_ENV_KEYS);
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-dashboard-boundary-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    if (typeof extraEnv.beforeImport === 'function') extraEnv.beforeImport(runtimeDir);
    serverModule = await importServer(runtimeDir, extraEnv);
    return serverModule;
  }

  afterEach(() => {
    if (serverModule?.resetServerTestHooks) serverModule.resetServerTestHooks();
    if (serverModule?.stopServer) serverModule.stopServer();
    serverModule = null;
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = null;
    restoreEnv(envSnapshot);
    envSnapshot = null;
  });

  test('keeps local queue mutation compatible', async () => {
    const mod = await setup();

    const create = await request(mod.app)
      .post('/api/queue')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({ ok: true, position: 1 });

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
  });

  test('backs up unreadable queue files on startup', async () => {
    const mod = await setup({
      beforeImport(dir) {
        writeFileSync(path.join(dir, 'logs', 'queue.json'), '{not-json', 'utf-8');
      },
    });

    const queuePath = path.join(runtimeDir, 'logs', 'queue.json');
    const backups = readdirSync(path.dirname(queuePath)).filter(name => name.startsWith('queue.json.corrupt-'));
    expect(existsSync(queuePath)).toBe(false);
    expect(backups).toHaveLength(1);

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  test('blocks non-local queue mutation', async () => {
    const mod = await setup();
    mod.setServerTestHooks({ dashboardRequestLocal: () => false });

    const create = await request(mod.app)
      .post('/api/queue')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'remote write' });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatch(/dashboard mutation/i);

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  test('allows non-local mutation with the dashboard bearer token only', async () => {
    const mod = await setup({ HAFLEET_DASHBOARD_TOKEN: 'dash-secret' });
    mod.setServerTestHooks({ dashboardRequestLocal: () => false });

    const wrongToken = await request(mod.app)
      .post('/api/queue')
      .set('Authorization', 'Bearer wrong-secret')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'bad token' });
    expect(wrongToken.status).toBe(403);

    const rightToken = await request(mod.app)
      .post('/api/queue')
      .set('Authorization', 'Bearer dash-secret')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'good token' });
    expect(rightToken.status).toBe(200);
    expect(rightToken.body).toMatchObject({ ok: true, position: 1 });
  });

  test('blocks non-local backend proxy mutation before upstream fetch', async () => {
    const mod = await setup();
    const seen = [];
    mod.setServerTestHooks({
      dashboardRequestLocal: () => false,
      backendFetch: async (url, init = {}) => {
        seen.push({ url: String(url), method: init.method || 'GET' });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });

    const create = await request(mod.app)
      .post('/api/task-graphs')
      .send({ owner: 'operator' });
    expect(create.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test('agent down command runs asynchronously without blocking other dashboard requests', async () => {
    const mod = await setup();
    let releaseAgentDown;
    let startedAgentDown;
    const agentDownStarted = new Promise((resolve) => {
      startedAgentDown = resolve;
    });

    mod.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        if (String(cmd).endsWith('/bin/hafleet-down')) {
          startedAgentDown();
          return new Promise((resolve) => {
            releaseAgentDown = () => resolve({ stdout: 'agent stopped\n' });
          });
        }
        throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
      },
    });

    const downRequest = request(mod.app).post('/api/agents/alpha/down').send({}).then((res) => res);
    await waitFor(agentDownStarted);

    const queueResponse = await request(mod.app).get('/api/queue');
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.body).toEqual([]);

    releaseAgentDown();
    const downResponse = await downRequest;
    expect(downResponse.status).toBe(200);
    expect(downResponse.body).toMatchObject({
      ok: true,
      action: 'hafleet-down-kill',
      outputTail: 'agent stopped',
    });
  });

  test('agent down fallback uses asynchronous tmux cleanup before marking offline', async () => {
    const mod = await setup();
    const execCalls = [];
    const backendCalls = [];

    mod.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (String(cmd).endsWith('/bin/hafleet-down')) {
          const error = new Error('hafleet-down failed');
          error.stdout = 'partial stdout\n';
          error.stderr = 'partial stderr\n';
          throw error;
        }
        if (cmd === 'tmux') return { stdout: '' };
        throw new Error(`unexpected exec ${cmd}`);
      },
      backendFetch: async (url, init = {}) => {
        backendCalls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });

    const response = await request(mod.app).post('/api/agents/alpha/down').send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'hafleet-down-kill-fallback',
    });
    expect(response.body.outputTail).toContain('partial stdout');
    expect(response.body.outputTail).toContain('partial stderr');
    expect(execCalls).toContainEqual(['tmux', 'kill-session', '-t', 'alpha']);
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(backendCalls[0].body)).toMatchObject({
      reason: 'manual-down:web-kill',
      clearTmux: true,
      manualDown: true,
    });
  });

  test('dashboard server avoids synchronous child process execution', () => {
    const source = readFileSync(path.resolve('server.js'), 'utf-8');
    expect(source).not.toContain('execFileSync');
  });

  test('agent status endpoint normalizes malformed backend agent payloads', async () => {
    const mod = await setup();
    mod.setServerTestHooks({
      backendFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ agents: null }),
      }),
    });

    const response = await request(mod.app).get('/api/agents/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  test('dashboard roster comes only from the backend registry, not stale tmux sessions', async () => {
    const mod = await setup();
    const tmuxCalls = [];
    const registry = [
      { name: 'worker-alpha', online: true, tmux: 'worker-alpha:0.0' },
      { name: 'worker-beta', online: false, tmux: null },
      { name: 'worker-gamma', online: true, tmux: 'worker-gamma:0.0' },
    ];
    mod.setServerTestHooks({
      backendFetch: async (url) => {
        expect(String(url)).toMatch(/\/api\/agents$/);
        return { ok: true, status: 200, json: async () => registry };
      },
      execFileAsync: async (command, args) => {
        tmuxCalls.push([command, ...args]);
        return { stdout: 'stale-tmux-session\n' };
      },
    });

    const response = await request(mod.app).get('/api/agents/all');

    expect(response.status).toBe(200);
    expect(response.body.map((agent) => agent.name)).toEqual([
      'worker-alpha', 'worker-beta', 'worker-gamma',
    ]);
    expect(response.text).not.toContain('stale-tmux-session');
    expect(tmuxCalls).toEqual([]);
  });

});
