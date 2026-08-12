import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';
import { execFile } from 'child_process';

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

function parseSseFrameData(frame) {
  const dataLine = String(frame || '').split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) return null;
  return JSON.parse(dataLine.slice('data: '.length));
}

function replacePathWithDirectory(filePath) {
  rmSync(filePath, { recursive: true, force: true });
  mkdirSync(filePath, { recursive: true });
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const SERVER_ENV_KEYS = [
  'HAFLEET_RUNTIME_DIR',
  'HAFLEET_WEB_PORT',
  'HAFLEET_BACKEND_PORT',
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

let serverImportEnvSnapshot = null;

async function importServer(runtimeDir) {
  if (!serverImportEnvSnapshot) serverImportEnvSnapshot = snapshotEnv(SERVER_ENV_KEYS);
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.HAFLEET_WEB_PORT = '18084';
  process.env.HAFLEET_BACKEND_PORT = '18090';
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
    restoreEnv(serverImportEnvSnapshot);
    serverImportEnvSnapshot = null;
  });

  test('server import and stop do not leave runtime handles active', async () => {
    const probeRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-lifecycle-probe-'));
    mkdirSync(path.join(probeRuntimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(probeRuntimeDir, 'data', 'agents'), { recursive: true });
    const serverUrl = pathToFileURL(path.resolve('server.js')).href;
    const probe = `
      const mod = await import(${JSON.stringify(`${serverUrl}?lifecycle-probe=${Date.now()}`)});
      await mod.stopServer();
      console.log('stopped');
    `;

    try {
      const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          HAFLEET_RUNTIME_DIR: probeRuntimeDir,
          HAFLEET_WEB_PORT: '18084',
          HAFLEET_BACKEND_PORT: '18090',
        },
        timeout: 3000,
      });
      expect(result.stdout).toContain('stopped');
    } finally {
      rmSync(probeRuntimeDir, { recursive: true, force: true });
    }
  });

  test('stopServer cancels backend SSE reconnect timers', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);
    vi.useFakeTimers();

    let streamFetches = 0;
    serverModule.setServerTestHooks({
      backendFetch: async (url) => {
        if (String(url).includes('/api/stream')) {
          streamFetches++;
          throw new Error('stream down');
        }
        return { ok: true, status: 200, text: async () => '', json: async () => [] };
      },
    });

    serverModule.startServer({ port: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(streamFetches).toBe(1);

    serverModule.stopServer();
    await vi.advanceTimersByTimeAsync(6000);

    expect(streamFetches).toBe(1);
  });

  test('deliverMessage uses the async tmux path and appends to the message log', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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

  test('message log API supports bounded tail pagination', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    const logPath = path.join(runtimeDir, 'logs', 'messages.jsonl');
    writeFileSync(logPath, [
      { id: 'msg_1', ts: 1000, from: 'system', to: 'alpha', payload: 'one' },
      { id: 'msg_2', ts: 2000, from: 'system', to: 'alpha', payload: 'two' },
      { id: 'msg_3', ts: 3000, from: 'system', to: 'alpha', payload: 'three' },
      { id: 'msg_4', ts: 4000, from: 'system', to: 'alpha', payload: 'four' },
      { id: 'msg_5', ts: 5000, from: 'system', to: 'alpha', payload: 'five' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    serverModule = await importServer(runtimeDir);

    const latest = await request(serverModule.app).get('/api/messages?limit=2');
    expect(latest.status).toBe(200);
    expect(latest.body.map((row) => row.id)).toEqual(['msg_4', 'msg_5']);

    const previousPage = await request(serverModule.app).get('/api/messages?before=4000&limit=2');
    expect(previousPage.status).toBe(200);
    expect(previousPage.body.map((row) => row.id)).toEqual(['msg_2', 'msg_3']);

    const sincePage = await request(serverModule.app).get('/api/messages?since=2000&limit=2');
    expect(sincePage.status).toBe(200);
    expect(sincePage.body.map((row) => row.id)).toEqual(['msg_4', 'msg_5']);
  });

  test('message log tail keeps partial JSONL records until newline', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    const logPath = path.join(runtimeDir, 'logs', 'messages.jsonl');
    serverModule = await importServer(runtimeDir);

    const frames = [];
    serverModule.addSseClientForTest({ write: (frame) => frames.push(frame) });

    const firstRow = JSON.stringify({ id: 'msg_tail_1', ts: 1000, from: 'system', to: 'alpha', payload: 'one' });
    const partial = firstRow.slice(0, Math.floor(firstRow.length / 2));
    writeFileSync(logPath, partial);

    await serverModule.pollMessageLogTailForTest();
    expect(frames).toHaveLength(0);

    writeFileSync(logPath, `${firstRow}\n`);
    await serverModule.pollMessageLogTailForTest();
    expect(frames).toHaveLength(1);
    expect(parseSseFrameData(frames[0])).toMatchObject({ id: 'msg_tail_1', payload: 'one' });

    const secondRow = JSON.stringify({ id: 'msg_tail_2', ts: 2000, from: 'system', to: 'alpha', payload: 'two' });
    writeFileSync(logPath, `${firstRow}\nnot-json\n${secondRow}\n`);
    await serverModule.pollMessageLogTailForTest();

    expect(frames).toHaveLength(2);
    expect(parseSseFrameData(frames[1])).toMatchObject({ id: 'msg_tail_2', payload: 'two' });
  });

  test('SSE write failures do not fail queue or reminder mutations', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const frames = [];
    const goodClient = { write: (frame) => frames.push(frame) };
    serverModule.addSseClientForTest({ write: () => { throw new Error('closed'); } });
    serverModule.addSseClientForTest(goodClient);

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'system',
      to: 'alpha:0.0',
      payload: 'hello',
    });
    expect(queued.status).toBe(200);
    expect(serverModule.getSseClientCountForTest()).toBe(1);
    expect(frames.some((frame) => String(frame).startsWith('event: queue\n'))).toBe(true);

    serverModule.addSseClientForTest({ write: () => { throw new Error('closed again'); } });
    const reminder = await request(serverModule.app).post('/api/reminders').send({
      target: 'alpha:0.0',
      delay: 60,
      msg: 'stand up',
    });

    expect(reminder.status).toBe(200);
    expect(serverModule.getSseClientCountForTest()).toBe(1);
    expect(frames.some((frame) => String(frame).startsWith('event: reminders\n'))).toBe(true);
  });

  test('queue accept rolls back when queue persistence fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'queue.json'));

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'persist me first',
    });

    expect(queued.status).toBe(500);
    expect(queued.body).toMatchObject({ ok: false, error: 'queue persistence failed' });

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'queue-accept-save-failed',
      }),
    ]));
    expect(events.some((event) => event.type === 'queue.accepted')).toBe(false);
  });

  test('queue_idempotency_key_survives_delivery_and_server_reload', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);
    serverModule.setServerTestHooks({
      execFileAsync: async () => ({ stdout: '' }),
      backendFetch: async (url) => {
        if (String(url).includes('/unread-list')) {
          return {
            ok: true,
            json: async () => ({ unread_total: 1, unread_ids: ['msg_matrix_1'] }),
          };
        }
        return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const payload = {
      from: 'hafleet-backend', to: 'alpha:0.0', payload: '[NOTIFICATION] durable wake',
      notifyMeta: { sourceMsgId: 'msg_matrix_1', messageIds: ['msg_matrix_1'] },
    };
    const first = await request(serverModule.app).post('/api/queue')
      .set('Idempotency-Key', 'matrix:$event:alpha').send(payload);
    const duplicate = await request(serverModule.app).post('/api/queue')
      .set('Idempotency-Key', 'matrix:$event:alpha').send(payload);

    expect(first.status).toBe(200);
    expect(duplicate.body).toMatchObject({ id: first.body.id, deduped: true });
    let snapshot = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf8'));
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.idempotencyKeys).toContainEqual([
      'matrix:$event:alpha', expect.objectContaining({ id: first.body.id }),
    ]);

    const delivered = await request(serverModule.app).post(`/api/queue/${first.body.id}/send`);
    expect(delivered.body).toMatchObject({ ok: true, delivered: first.body.id });
    snapshot = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf8'));
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.idempotencyKeys).toContainEqual([
      'matrix:$event:alpha', expect.objectContaining({ id: first.body.id }),
    ]);

    await serverModule.stopServer();
    serverModule = await importServer(runtimeDir);
    const afterReload = await request(serverModule.app).post('/api/queue')
      .set('Idempotency-Key', 'matrix:$event:alpha').send(payload);
    expect(afterReload.body).toMatchObject({ id: first.body.id, deduped: true });
    snapshot = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf8'));
    expect(snapshot.items).toHaveLength(0);
  });

  test('inflight_matrix_wake_restart_is_not_re_pasted', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    const idempotencyKey = 'matrix:$crash-after-tmux:alpha';
    writeFileSync(path.join(runtimeDir, 'logs', 'queue.json'), JSON.stringify({
      idCounter: 1,
      items: [{
        id: 1,
        from: 'hafleet-backend',
        to: 'alpha:0.0',
        payload: '[NOTIFICATION] uncertain prior tmux delivery',
        queuedAt: 1000,
        idempotencyKey,
        deliveryState: 'delivering',
        deliveringAt: 2000,
        deliveryAttempt: 1,
      }],
      idempotencyKeys: [[idempotencyKey, { id: 1, queuedAt: 1000, position: 1 }]],
    }));

    serverModule = await importServer(runtimeDir);
    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (...args) => {
        execCalls.push(args);
        return { stdout: '' };
      },
      backendFetch: async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
    await serverModule.processQueueTickForTest();
    expect(execCalls).toEqual([]);

    const replay = await request(serverModule.app).post('/api/queue')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        from: 'hafleet-backend', to: 'alpha:0.0', payload: '[NOTIFICATION] uncertain prior tmux delivery',
      });
    expect(replay.body).toMatchObject({ id: 1, deduped: true });
    expect(JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf8')).items)
      .toEqual([]);
  });

  test('manual send does not deliver when queue dequeue persistence fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: '' };
      },
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'do not deliver without durable dequeue',
    });
    expect(queued.status).toBe(200);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'queue.json'));

    const sent = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({
      ok: false,
      delivered: queued.body.id,
      requeued: true,
      reason: 'queue-persist-failed',
    });
    expect(execCalls.some((call) => call.includes('send-keys'))).toBe(false);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id: queued.body.id });

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'queue-dequeue-save-failed',
      }),
    ]));
    expect(events.some((event) => event.type === 'tmux.delivered')).toBe(false);
  });

  test('manual send persists delivering before tmux and removes after success', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    let persistedStateDuringPayload = null;
    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (args[0] === 'send-keys' && args[1] === '-l') {
          const queueFile = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf-8'));
          persistedStateDuringPayload = queueFile.items[0]?.deliveryState || null;
        }
        return { stdout: '' };
      },
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'deliver durably',
    });
    expect(queued.status).toBe(200);

    const sent = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, delivered: queued.body.id });
    expect(persistedStateDuringPayload).toBe('delivering');
    expect(execCalls).toEqual([
      ['tmux', 'send-keys', '-l', '-t', 'alpha:0.0', 'deliver durably'],
      ['tmux', 'send-keys', '-t', 'alpha:0.0', 'C-m'],
    ]);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
    const queueFile = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf-8'));
    expect(queueFile.items).toEqual([]);
  });

  test('manual send reports terminal persistence failure without hiding in-flight entry', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (args[0] === 'send-keys' && args[1] === '-l') {
          replacePathWithDirectory(path.join(runtimeDir, 'logs', 'queue.json'));
        }
        return { stdout: '' };
      },
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'tmux side effect happened',
    });
    expect(queued.status).toBe(200);

    const sent = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);

    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({
      ok: false,
      delivered: queued.body.id,
      requeued: true,
      reason: 'queue-persist-failed',
    });
    expect(execCalls).toEqual([
      ['tmux', 'send-keys', '-l', '-t', 'alpha:0.0', 'tmux side effect happened'],
      ['tmux', 'send-keys', '-t', 'alpha:0.0', 'C-m'],
    ]);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({
      id: queued.body.id,
      payload: 'tmux side effect happened',
      deliveryState: 'delivering',
      deliveryAttempt: 1,
    });

    const duplicateSend = await request(serverModule.app).post(`/api/queue/${queued.body.id}/send`);
    expect(duplicateSend.status).toBe(409);
    expect(duplicateSend.body).toMatchObject({ ok: false, reason: 'already-delivering' });

    const deleted = await request(serverModule.app).delete(`/api/queue/${queued.body.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body).toMatchObject({ ok: false, error: 'delivery in progress', id: queued.body.id });

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'queue-delivered-save-failed',
        queueEntryId: queued.body.id,
      }),
    ]));
  });

  test('queue load recovers in-flight entries and discards terminal markers', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    writeFileSync(path.join(runtimeDir, 'logs', 'queue.json'), JSON.stringify({
      idCounter: 4,
      items: [
        {
          id: 1,
          from: 'operator',
          to: 'alpha:0.0',
          payload: 'recover me',
          queuedAt: 1000,
          deliveryState: 'delivering',
          deliveringAt: 2000,
          deliveryAttempt: 1,
        },
        {
          id: 2,
          from: 'operator',
          to: 'alpha:0.0',
          payload: 'already delivered',
          queuedAt: 1100,
          deliveryState: 'delivered',
          deliveredAt: 2100,
        },
        {
          id: 3,
          from: 'operator',
          to: 'beta:0.0',
          payload: 'already dropped',
          queuedAt: 1200,
          deliveryState: 'dropped',
          droppedAt: 2200,
        },
        {
          id: 4,
          from: 'operator',
          to: 'beta:0.0',
          payload: 'still queued',
          queuedAt: 1300,
        },
      ],
    }), 'utf-8');

    serverModule = await importServer(runtimeDir);

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body.map((entry) => entry.id)).toEqual([1, 4]);
    expect(queue.body[0]).toMatchObject({ id: 1, payload: 'recover me' });
    expect(queue.body[0]).not.toHaveProperty('deliveryState');
    expect(queue.body[0]).not.toHaveProperty('deliveringAt');

    const queueFile = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf-8'));
    expect(queueFile.items.map((entry) => entry.id)).toEqual([1, 4]);
    expect(queueFile.items[0]).not.toHaveProperty('deliveryState');
    expect(queueFile.items[0]).not.toHaveProperty('deliveringAt');
  });

  test('queue delete rolls back when queue persistence fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'operator',
      to: 'alpha:0.0',
      payload: 'keep me queued',
    });
    expect(queued.status).toBe(200);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'queue.json'));

    const deleted = await request(serverModule.app).delete(`/api/queue/${queued.body.id}`);
    expect(deleted.status).toBe(500);
    expect(deleted.body).toMatchObject({ ok: false, error: 'queue persistence failed' });

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id: queued.body.id, payload: 'keep me queued' });

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'queue-delete-save-failed',
      }),
    ]));
    expect(events.some((event) => event.type === 'queue.canceled')).toBe(false);
  });

  test('reminder create rolls back when reminder persistence fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'reminders.json'));

    const reminder = await request(serverModule.app).post('/api/reminders').send({
      target: 'alpha:0.0',
      delay: 30,
      msg: 'durable first',
    });

    expect(reminder.status).toBe(500);
    expect(reminder.body).toMatchObject({ ok: false, error: 'reminder persistence failed' });

    const reminders = await request(serverModule.app).get('/api/reminders');
    expect(reminders.body).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'reminder-create-save-failed',
      }),
    ]));
  });

  test('reminder delete rolls back when reminder persistence fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const reminder = await request(serverModule.app).post('/api/reminders').send({
      target: 'alpha:0.0',
      delay: 30,
      msg: 'keep me scheduled',
    });
    expect(reminder.status).toBe(200);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'reminders.json'));

    const deleted = await request(serverModule.app).delete(`/api/reminders/${reminder.body.id}`);
    expect(deleted.status).toBe(500);
    expect(deleted.body).toMatchObject({ ok: false, error: 'reminder persistence failed' });

    const reminders = await request(serverModule.app).get('/api/reminders');
    expect(reminders.body).toHaveLength(1);
    expect(reminders.body[0]).toMatchObject({ id: reminder.body.id, msg: 'keep me scheduled' });

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'reminder-delete-save-failed',
      }),
    ]));
  });

  test('due reminders remain scheduled when queue persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const reminder = await request(serverModule.app).post('/api/reminders').send({
      target: 'alpha:0.0',
      delay: 1,
      msg: 'stay scheduled',
    });
    expect(reminder.status).toBe(200);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'queue.json'));
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    serverModule.processDueRemindersForTest();

    const reminders = await request(serverModule.app).get('/api/reminders');
    expect(reminders.body).toHaveLength(1);
    expect(reminders.body[0]).toMatchObject({ id: reminder.body.id, msg: 'stay scheduled' });

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'due-reminder-queue-save-failed',
      }),
    ]));
  });

  test('due reminders do not enqueue when reminder persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const reminder = await request(serverModule.app).post('/api/reminders').send({
      target: 'alpha:0.0',
      delay: 1,
      msg: 'do not duplicate',
    });
    expect(reminder.status).toBe(200);

    replacePathWithDirectory(path.join(runtimeDir, 'logs', 'reminders.json'));
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));

    serverModule.processDueRemindersForTest();
    serverModule.processDueRemindersForTest();

    const reminders = await request(serverModule.app).get('/api/reminders');
    expect(reminders.body).toHaveLength(1);
    expect(reminders.body[0]).toMatchObject({ id: reminder.body.id, msg: 'do not duplicate' });

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
    const queueFile = JSON.parse(readFileSync(path.join(runtimeDir, 'logs', 'queue.json'), 'utf-8'));
    expect(queueFile.items).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.persist_failed',
        reason: 'due-reminder-reminder-save-failed',
      }),
    ]));
  });

  test('manual send drops backend notifications whose source message is no longer unread', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    const unreadSnapshotUrls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: '' };
      },
      backendFetch: async (url) => {
        const urlText = String(url);
        if (urlText.includes('/api/inbox/alpha/unread-list')) {
          unreadSnapshotUrls.push(urlText);
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
        if (urlText.includes('/api/inbox/alpha/unread')) throw new Error('legacy unread endpoint used');
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
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
    expect(unreadSnapshotUrls).toHaveLength(1);
    expect(unreadSnapshotUrls[0]).toContain('limit=0');

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
  });

  test('queue tick drops backend notifications whose source message is no longer unread', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const execCalls = [];
    const unreadSnapshotUrls = [];
    serverModule.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: '' };
      },
      backendFetch: async (url) => {
        const urlText = String(url);
        if (urlText.includes('/api/inbox/alpha/unread-list')) {
          unreadSnapshotUrls.push(urlText);
          return {
            ok: true,
            json: async () => ({
              agent: 'alpha',
              unread_total: 0,
              messages: [],
            }),
          };
        }
        if (urlText.includes('/api/inbox/alpha/unread')) throw new Error('legacy unread endpoint used');
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
      to: 'alpha:0.0',
      payload: '[NOTIFICATION] unread message',
      notifyMeta: {
        kind: 'single_actionable',
        requiresInboxCheck: true,
        sourceMsgId: 'msg_0001',
        unreadCount: 1,
      },
    });

    await serverModule.processQueueTickForTest();

    expect(queued.status).toBe(200);
    expect(execCalls.some((call) => call.includes('send-keys'))).toBe(false);
    expect(unreadSnapshotUrls).toHaveLength(1);
    expect(unreadSnapshotUrls[0]).toContain('limit=0');

    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);

    const events = readJsonl(path.join(runtimeDir, 'logs', 'delivery-events.jsonl'));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'queue.dropped',
        reason: 'stale-notification-unread-changed',
        messageId: 'msg_0001',
        queueEntryId: queued.body.id,
      }),
    ]));
  });

  test('canceling one merged unread message drops correlated queue notifications', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    serverModule.setServerTestHooks({
      backendFetch: async () => ({ ok: true, text: async () => '', json: async () => ({ ok: true }) }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
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

  test('canceling an already-missing unread message still drops correlated queue notifications', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    serverModule.setServerTestHooks({
      backendFetch: async () => ({
        ok: false,
        status: 404,
        text: async () => '',
        json: async () => ({ error: 'message not found' }),
      }),
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
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
    expect(canceled.body).toMatchObject({
      ok: true,
      already_absent: true,
      queue_removed: 1,
      queue_remove_failed: false,
    });
    const queue = await request(serverModule.app).get('/api/queue');
    expect(queue.body).toEqual([]);
  });

  test('manual send does not re-paste payload after tmux enter fails', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
        if (String(url).includes('/api/inbox/alpha/unread-list')) return { ok: false, json: async () => ({}) };
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
        if (String(url).includes('/api/inbox/alpha/unread-list')) return { ok: false, json: async () => ({}) };
        return { ok: true, text: async () => '', json: async () => ({ ok: true }) };
      },
    });

    const queued = await request(serverModule.app).post('/api/queue').send({
      from: 'hafleet-backend',
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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

  test('message detail capability links proxy through the dashboard without operator credentials', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    serverModule = await importServer(runtimeDir);

    const seen = [];
    serverModule.setServerTestHooks({
      backendFetch: async (url, init = {}) => {
        seen.push({ url: String(url), headers: init.headers || {} });
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
          text: async () => '<html><body>scoped detail</body></html>',
        };
      },
    });

    const response = await request(serverModule.app)
      .get('/msg/msg_0034')
      .query({ view: 'scoped-view-token' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('scoped detail');
    expect(seen).toHaveLength(1);
    const [forwarded] = seen;
    expect(new URL(forwarded.url).pathname).toBe('/msg/msg_0034');
    expect(new URL(forwarded.url).searchParams.get('view')).toBe('scoped-view-token');
    expect(forwarded.headers.Authorization).toBeUndefined();
  });

  test('dashboard backend proxy route clusters forward to the backend correctly', async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-server-delivery-test-'));
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
          json: async () => ({ ok: true }),
          text: async () => '',
        };
      },
    });

    const taskCreate = await request(serverModule.app).post('/api/tasks').send({ title: 'ship it' });
    const taskList = await request(serverModule.app).get('/api/tasks?assignee=alpha&status=open&limit=25&offset=5');
    const supervisorAgent = await request(serverModule.app).get('/api/supervisor/agents/alpha?limit=7');
    const alertTransition = await request(serverModule.app)
      .post('/api/alerts/alert_1/transition')
      .send({ status: 'resolved' });

    expect(taskCreate.status).toBe(200);
    expect(taskList.status).toBe(200);
    expect(supervisorAgent.status).toBe(200);
    expect(alertTransition.status).toBe(200);

    const proxyRequests = seen
      .map((row) => ({ url: row.url.replace(/^https?:\/\/[^/]+/, ''), method: row.method }))
      .filter((row) => (
        row.url.startsWith('/api/tasks')
        || row.url.startsWith('/api/supervisor')
        || row.url.startsWith('/api/alerts')
      ));
    expect(proxyRequests).toEqual([
      { url: '/api/tasks', method: 'POST' },
      { url: '/api/tasks?assignee=alpha&status=open&limit=25&offset=5', method: 'GET' },
      { url: '/api/supervisor/agents/alpha?limit=7', method: 'GET' },
      { url: '/api/alerts/alert_1/transition', method: 'POST' },
    ]);
  });
});
