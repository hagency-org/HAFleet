import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importServer(runtimeDir) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.AGENT_CHAT_WEB_PORT = '18084';
  process.env.AGENT_CHAT_BACKEND_PORT = '18090';
  const serverUrl = pathToFileURL(path.resolve('server.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return import(`${serverUrl}?server-test=${cacheBust}`);
}

describe('server delivery path', () => {
  let runtimeDir = null;
  let serverModule = null;

  afterEach(() => {
    if (serverModule?.resetServerTestHooks) serverModule.resetServerTestHooks();
    if (serverModule?.stopServer) serverModule.stopServer();
    serverModule = null;
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = null;
  });

  test('deliverMessage uses the async tmux path and appends to the message log', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: '' };
      },
      backendFetch: async () => ({ ok: true, text: async () => '' }),
    });

    const ok = await serverModule.deliverMessage({
      id: 1,
      from: 'system',
      to: 'alpha:0.0',
      payload: 'hello world',
    });

    expect(ok).toBe(true);
    expect(execCalls).toEqual([
      ['tmux', 'send-keys', '-l', '-t', 'alpha:0.0', 'hello world'],
      ['tmux', 'send-keys', '-t', 'alpha:0.0', 'C-m'],
    ]);

    await sleep(25);
    const logPath = path.join(runtimeDir, 'logs', 'messages.jsonl');
    const rows = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: 'system', to: 'alpha:0.0', payload: 'hello world' });
  });

  test('pane snapshot sweep tracks live panes and removes stale panes', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    let sweepCount = 0;
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        if (args[0] === 'list-panes') {
          sweepCount += 1;
          if (sweepCount === 1) {
            return { stdout: 'alpha:0.0\nbeta:0.0\n' };
          }
          return { stdout: 'alpha:0.0\n' };
        }
        if (args[0] === 'capture-pane' && args[2] === 'alpha:0.0') {
          return { stdout: sweepCount === 1 ? 'alpha tail 1' : 'alpha tail 2' };
        }
        if (args[0] === 'capture-pane' && args[2] === 'beta:0.0') {
          return { stdout: 'beta tail' };
        }
        throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
      },
      backendFetch: async () => ({
        ok: true,
        json: async () => [],
      }),
    });

    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha:0.0')).toBeGreaterThanOrEqual(0);
    expect(serverModule.getPaneIdleMs('beta:0.0')).toBeGreaterThanOrEqual(0);

    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha')).toBeGreaterThanOrEqual(0);
    expect(serverModule.getPaneIdleMs('beta:0.0')).toBe(-1);
  });

  test('task graph proxy routes forward to the backend correctly', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const seen = [];
    serverModule.setServerTestHooks({
      backendFetch: async (url, init = {}) => {
        seen.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, graph: { id: 'graph_1' }, node: { id: 'a' } }),
          text: async () => '',
        };
      },
    });

    const create = await request(serverModule.app).post('/api/task-graphs').send({ owner: 'orchestrator' });
    const list = await request(serverModule.app).get('/api/task-graphs?status=active');
    const show = await request(serverModule.app).get('/api/task-graphs/graph_1');
    const patch = await request(serverModule.app).patch('/api/task-graphs/graph_1/nodes/a').send({ status: 'complete' });
    const remove = await request(serverModule.app).delete('/api/task-graphs/graph_1');

    expect(create.status).toBe(200);
    expect(list.status).toBe(200);
    expect(show.status).toBe(200);
    expect(patch.status).toBe(200);
    expect(remove.status).toBe(200);

    const taskGraphRequests = seen
      .map((row) => ({ url: row.url.replace(/^https?:\/\/[^/]+/, ''), method: row.method }))
      .filter((row) => row.url.startsWith('/api/task-graph'));
    expect(taskGraphRequests).toEqual([
      { url: '/api/task-graphs', method: 'POST' },
      { url: '/api/task-graphs?status=active', method: 'GET' },
      { url: '/api/task-graphs/graph_1', method: 'GET' },
      { url: '/api/task-graphs/graph_1/nodes/a', method: 'PATCH' },
      { url: '/api/task-graphs/graph_1', method: 'DELETE' },
    ]);
  });
});
