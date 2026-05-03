import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(filePath) {
  try {
    return readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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
    vi.useRealTimers();
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
    const backendEvents = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: '' };
      },
      backendFetch: async (url, init = {}) => {
        if (String(url).includes('/api/delivery-events')) {
          backendEvents.push(JSON.parse(init.body));
        }
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const result = await serverModule.deliverMessage({
      id: 1,
      from: 'system',
      to: 'alpha:0.0',
      payload: 'hello world',
    });

    expect(result.ok).toBe(true);
    expect(execCalls).toEqual([
      ['tmux', 'send-keys', '-l', '-t', 'alpha:0.0', 'hello world'],
      ['tmux', 'send-keys', '-t', 'alpha:0.0', 'C-m'],
    ]);

    await sleep(25);
    const logPath = path.join(runtimeDir, 'logs', 'messages.jsonl');
    const rows = readJsonl(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: 'system', to: 'alpha:0.0', payload: 'hello world' });

    const eventPath = path.join(runtimeDir, 'logs', 'delivery-events.jsonl');
    const events = readJsonl(eventPath);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tmux.delivered',
        queueEntryId: 1,
        target: 'alpha:0.0',
      }),
    ]));
    expect(backendEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tmux.delivered',
        queueEntryId: 1,
        target: 'alpha:0.0',
      }),
    ]));
  });

  test('manual send drops backend notifications whose source message is no longer unread', async () => {
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
      backendFetch: async (url) => {
        if (String(url).includes('/api/inbox/alpha/unread')) {
          return {
            ok: true,
            json: async () => ({
              agent: 'alpha',
              unread_total: 1,
              latest: { id: 'msg_0002' },
              messages: [{ id: 'msg_0002' }],
            }),
          };
        }
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'agent-chat-v2',
      to: 'alpha:0.0',
      payload: '[NOTIFICATION] unread message',
      notifyMeta: {
        kind: 'single_actionable',
        requiresInboxCheck: true,
        sourceMsgId: 'msg_0001',
        unreadCount: 1,
      },
    });

    const sent = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      ok: true,
      dropped: queued.body.id,
      reason: 'stale-notification',
    });
    expect(execCalls).toEqual([]);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
  });

  test('canceling one merged unread message drops correlated queue notifications', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    serverModule.setServerTestHooks({
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'agent-chat-v2',
      to: 'alpha:0.0',
      payload: '[NOTIFICATION] unread messages',
      notifyMeta: {
        kind: 'merged_unread_actionable',
        requiresInboxCheck: true,
        sourceMsgId: 'msg_0002',
        messageIds: ['msg_0001', 'msg_0002'],
        unreadCount: 2,
      },
    });
    expect(queued.status).toBe(200);

    const canceled = await request(serverModule.app)
      .post('/api/agents/alpha/unread-messages/msg_0001/cancel');

    expect(canceled.status).toBe(200);
    expect(canceled.body.queue_removed).toBe(1);
    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.dropped',
        reason: 'message-canceled',
        messageIds: ['msg_0001', 'msg_0002'],
        queueEntryId: queued.body.id,
      }),
    ]));
  });

  test('manual send does not re-paste payload after tmux enter fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const payloadCalls = [];
    let enterAttempts = 0;
    serverModule.setServerTestHooks({
      execFileAsync: async (_cmd, args) => {
        if (args[0] === 'send-keys' && args[1] === '-l') {
          payloadCalls.push(args[args.length - 1]);
          return { stdout: '' };
        }
        if (args[0] === 'send-keys' && args[args.length - 1] === 'C-m') {
          enterAttempts += 1;
          const error = new Error('enter failed');
          error.stderr = 'tmux enter failed';
          throw error;
        }
        throw new Error(`unexpected tmux args ${args.join(' ')}`);
      },
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'do not paste twice',
    });

    const first = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({
      ok: false,
      delivered: queued.body.id,
      requeued: false,
      reason: 'partial-delivery',
      stage: 'enter',
    });
    expect(payloadCalls).toEqual(['do not paste twice']);
    expect(enterAttempts).toBe(1);

    const second = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);
    expect(second.status).toBe(404);
    expect(payloadCalls).toEqual(['do not paste twice']);
    expect(enterAttempts).toBe(1);
  });

  test('queue snapshot reports untracked target observation before pane sweep', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    serverModule.setServerTestHooks({
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => [] }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'wait for observation',
    });

    expect(queued.status).toBe(200);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({
      id: queued.body.id,
      targetIdleMs: -1,
      targetObservation: {
        state: 'untracked',
        target: 'alpha:0.0',
      },
    });
  });

  test('queue tick does not drop backend notifications when pane capture fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (args[0] === 'list-panes') return { stdout: 'alpha:0.0\n' };
        if (args[0] === 'capture-pane' && args[2] === 'alpha:0.0') {
          throw new Error('capture failed');
        }
        throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
      },
      backendFetch: async (url) => {
        if (String(url).includes('/api/agents')) return { ok: true, json: async () => [] };
        if (String(url).includes('/api/inbox/alpha/unread')) return { ok: false, json: async () => ({}) };
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'agent-chat-v2',
      to: 'alpha:0.0',
      payload: '[NOTIFICATION] unread message',
      notifyMeta: {
        kind: 'single_actionable',
        requiresInboxCheck: true,
        sourceMsgId: 'msg_capture_failed',
        unreadCount: 1,
      },
    });

    expect(queued.status).toBe(200);
    await serverModule.sweepPaneSnapshots();

    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
    await serverModule.processQueueTickForTest();

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({
      id: queued.body.id,
      targetIdleMs: -1,
      targetObservation: {
        state: 'capture-failed',
        target: 'alpha:0.0',
      },
    });
    expect(execCalls.some((call) => call.includes('send-keys'))).toBe(false);
  });

  test('queue tick drops old backend notifications only after pane is confirmed missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    let sweepCount = 0;
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (args[0] === 'list-panes') {
          sweepCount += 1;
          return { stdout: sweepCount === 1 ? 'alpha:0.0\n' : '' };
        }
        if (args[0] === 'capture-pane' && args[2] === 'alpha:0.0') return { stdout: 'ready' };
        throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
      },
      backendFetch: async (url) => {
        if (String(url).includes('/api/agents')) return { ok: true, json: async () => [] };
        if (String(url).includes('/api/inbox/alpha/unread')) return { ok: false, json: async () => ({}) };
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'agent-chat-v2',
      to: 'alpha:0.0',
      payload: '[NOTIFICATION] unread message',
      notifyMeta: {
        kind: 'single_actionable',
        requiresInboxCheck: true,
        sourceMsgId: 'msg_pane_missing',
        unreadCount: 1,
      },
    });

    expect(queued.status).toBe(200);
    await serverModule.sweepPaneSnapshots();
    await serverModule.sweepPaneSnapshots();

    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
    await serverModule.processQueueTickForTest();

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
    expect(execCalls.some((call) => call.includes('send-keys'))).toBe(false);
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

  test('pane snapshot sweep keeps Codex working panes non-idle even when content is stable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    let paneText = [
      '› Run /review on my current changes',
      '',
      '• Working (12m 04s • esc to interrupt)',
    ].join('\n');
    serverModule.setServerTestHooks({
      execFileAsync: async (_cmd, args) => {
        if (args[0] === 'list-panes') return { stdout: 'alpha:0.0\n' };
        if (args[0] === 'capture-pane' && args[2] === 'alpha:0.0') return { stdout: paneText };
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      },
      backendFetch: async () => ({
        ok: true,
        json: async () => [],
      }),
    });

    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha:0.0')).toBe(0);

    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha:0.0')).toBe(0);

    paneText = '› ready for the next task';
    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha:0.0')).toBe(0);

    vi.setSystemTime(new Date('2026-01-01T00:02:25Z'));
    await serverModule.sweepPaneSnapshots();
    expect(serverModule.getPaneIdleMs('alpha:0.0')).toBeGreaterThanOrEqual(20_000);
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
