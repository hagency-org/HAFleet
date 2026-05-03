import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';

async function importServer(runtimeDir, extraEnv = {}) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.AGENT_CHAT_WEB_PORT = '18084';
  process.env.AGENT_CHAT_BACKEND_PORT = '18090';
  process.env.AGENT_CHAT_DASHBOARD_TOKEN = extraEnv.AGENT_CHAT_DASHBOARD_TOKEN || '';
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

  async function setup(extraEnv = {}) {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-dashboard-boundary-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir, extraEnv);
    return serverModule;
  }

  afterEach(() => {
    if (serverModule?.resetServerTestHooks) serverModule.resetServerTestHooks();
    if (serverModule?.stopServer) serverModule.stopServer();
    serverModule = null;
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = null;
    delete process.env.AGENT_CHAT_DASHBOARD_TOKEN;
    delete process.env.AGENT_IDLE_THRESHOLD_MS;
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
    const mod = await setup({ AGENT_CHAT_DASHBOARD_TOKEN: 'dash-secret' });
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

  test.each([
    ['/', ['<title>Agent Monitor</title>', 'AGENT MONITOR']],
    ['/agents/alpha', ['<title>Agent Detail · alpha</title>', 'Agent Detail', 'id="supervisor-audit-history"']],
    ['/alerts', ['<title>Alerts</title>', '<h1>ALERTS</h1>']],
    ['/tasks', ['<title>Tasks</title>', '<h1>TASKS</h1>']],
    ['/config', ['<title>Config</title>', '<h1>GLOBAL CONFIG</h1>']],
  ])('serves %s as non-cacheable html', async (route, markers) => {
    const mod = await setup();

    const response = await request(mod.app).get(route);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html\b/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('<!DOCTYPE html>');
    for (const marker of markers) expect(response.text).toContain(marker);
  });

  test('passes the idle threshold into the monitor page renderer', async () => {
    const mod = await setup({ AGENT_IDLE_THRESHOLD_MS: '45000' });

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('const IDLE_THRESHOLD_MS = 45000;');
    expect(response.text).toContain('const IDLE_THRESHOLD_SEC = 45;');
  });

  test('redirects agent audit page to the detail audit hash', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/agents/alpha/audit');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/agents/alpha#audit');
  });

  test.each([
    '/agents/bad.name',
    '/agents/bad.name/audit',
  ])('rejects invalid agent name for %s', async (route) => {
    const mod = await setup();

    const response = await request(mod.app).get(route);

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^text\/plain\b/);
    expect(response.text).toBe('invalid agent name');
  });
});
