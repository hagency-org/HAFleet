import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const API_TOKEN = 'messages-test-api-token';
const ALPHA_TOKEN = 'alpha-agent-token';
const BETA_TOKEN = 'beta-agent-token';

function readDeliveryEvents(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'message-delivery-events.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readPersistedMessages(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'messages.json');
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readJsonFile(runtimeDir, name) {
  return JSON.parse(readFileSync(path.join(runtimeDir, 'data', name), 'utf-8'));
}

async function createQueueStub(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const parsed = raw ? JSON.parse(raw) : null;
      const requestRow = { method: req.method, url: req.url, body: parsed };
      requests.push(requestRow);
      const response = await handler(requestRow, requests.length);
      res.statusCode = response?.status || 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response?.body || { ok: true, id: requests.length, queuedAt: Date.now() }));
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  if (typeof server.unref === 'function') server.unref();
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/api/queue`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('backend message API', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('agent-chat-messages-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: true,
          offlineReason: 'test-offline',
        },
        beta: {
          name: 'beta',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
      },
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
      agentTokens: { alpha: ALPHA_TOKEN, beta: BETA_TOKEN },
      env: { API_TOKEN },
    });
  });

  afterAll(() => {
    context.cleanup();
  });

  test('POST message with schema containing kind + payload returns 200 and round-trips', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'schema success',
        full: 'body',
        schema: {
          kind: 'task_request',
          version: 1,
          payload: { taskId: 'T-1' },
        },
      });
    expect(createResponse.status).toBe(200);

    const readResponse = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.schema).toEqual({
      kind: 'task_request',
      version: 1,
      payload: { taskId: 'T-1' },
    });

    const deliveryResponse = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}/delivery?agent=alpha`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(deliveryResponse.status).toBe(200);
    expect(deliveryResponse.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message.accepted',
        messageId: createResponse.body.id,
        targetAgents: ['alpha'],
      }),
    ]));
  });

  test('POST message with schema missing kind returns 400', async () => {
    const response = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'missing kind',
        full: 'body',
        schema: { payload: { taskId: 'T-2' } },
      });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'schema.kind required' });
  });

  test('message suppression appends a delivery event', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'suppress me',
        full: 'suppress me',
      });
    expect(createResponse.status).toBe(200);

    const suppressResponse = await request(context.app)
      .post(`/api/messages/${createResponse.body.id}/suppress`)
      .set('X-Agent-Token', ALPHA_TOKEN)
      .send({ agent: 'alpha', reason: 'test-suppress' });
    expect(suppressResponse.status).toBe(200);
    expect(suppressResponse.body.suppressed).toBe(true);

    const deliveryResponse = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}/delivery?agent=alpha`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(deliveryResponse.status).toBe(200);
    expect(deliveryResponse.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message.suppressed',
        messageId: createResponse.body.id,
        agent: 'alpha',
        reason: 'test-suppress',
      }),
    ]));
  });

  test('message suppression returns 503 without side effects when messages persistence fails', async () => {
    const failContext = await createBackendTestContext('agent-chat-message-suppress-save-fail-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
        },
      },
      messages: [
        {
          id: 'msg_suppress_fail',
          ts: 1000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          priority: 'normal',
          summary: 'suppress failure',
          full: 'suppress failure',
          mentions: [],
          reply_to: null,
        },
      ],
      msgCounter: 1,
      agentTokens: { alpha: ALPHA_TOKEN },
    });

    try {
      failContext.internals.setJsonSaveFailureForTest('messages.json', true);
      const suppressResponse = await request(failContext.app)
        .post('/api/messages/msg_suppress_fail/suppress')
        .set('X-Agent-Token', ALPHA_TOKEN)
        .send({ agent: 'alpha', reason: 'test-suppress-fail' });

      expect(suppressResponse.status).toBe(503);
      expect(suppressResponse.body).toEqual({ error: 'messages persistence failed' });
      expect(readPersistedMessages(failContext.runtimeDir)[0].suppressedRecipients || []).toEqual([]);
      expect(readDeliveryEvents(failContext.runtimeDir)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'message.suppressed' }),
      ]));
    } finally {
      failContext.cleanup();
    }
  });

  test('delivery event APIs return matching tail entries with the requested limit from a large log', async () => {
    const largeContext = await createBackendTestContext('agent-chat-messages-delivery-tail-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_tail',
          ts: 100,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'tail delivery source',
          full: 'tail delivery source',
          mentions: [],
        },
      ],
      agentTokens: { alpha: ALPHA_TOKEN },
      env: { API_TOKEN },
    });

    try {
      const deliveryLogPath = path.join(largeContext.runtimeDir, 'data', 'message-delivery-events.jsonl');
      const rows = Array.from({ length: 5000 }, (_, index) => ({
        id: `devt_old_${index}`,
        ts: index + 1,
        type: 'message.accepted',
        source: 'test',
        messageId: `msg_other_${index}`,
        agent: 'beta',
      }));
      rows.push(
        { id: 'devt_tail_1', ts: 5001, type: 'message.tail_1', source: 'test', messageId: 'msg_tail', agent: 'alpha' },
        { id: 'devt_gap', ts: 5002, type: 'message.gap', source: 'test', messageId: 'msg_other_tail', agent: 'alpha' },
        { id: 'devt_tail_2', ts: 5003, type: 'message.tail_2', source: 'test', messageIds: ['msg_tail'], targetAgents: ['alpha'] },
        { id: 'devt_tail_3', ts: 5004, type: 'message.tail_3', source: 'test', messageId: 'msg_tail', agent: 'alpha' },
      );
      writeFileSync(deliveryLogPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

      const messageDelivery = await request(largeContext.app)
        .get('/api/messages/msg_tail/delivery?agent=alpha&limit=2')
        .set('Authorization', `Bearer ${API_TOKEN}`);
      expect(messageDelivery.status).toBe(200);
      expect(messageDelivery.body.events.map((row) => row.type)).toEqual(['message.tail_2', 'message.tail_3']);

      const agentDelivery = await request(largeContext.app)
        .get('/api/agents/alpha/delivery-events?limit=2')
        .set('X-Agent-Token', ALPHA_TOKEN);
      expect(agentDelivery.status).toBe(200);
      expect(agentDelivery.body.events.map((row) => row.type)).toEqual(['message.tail_2', 'message.tail_3']);
    } finally {
      largeContext.cleanup();
    }
  });

  test('unread inbox lookups use fresh indexed direct and group mention rows', async () => {
    const indexedContext = await createBackendTestContext('agent-chat-messages-unread-index-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
        beta: {
          name: 'beta',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
      },
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
      messages: [
        {
          id: 'msg_direct_seed',
          ts: 1001,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'seed direct',
          full: 'seed direct',
          mentions: [],
        },
        {
          id: 'msg_group_seed',
          ts: 1002,
          from: 'beta',
          group: 'dev',
          type: 'inform',
          summary: 'seed group',
          full: 'seed group',
          mentions: ['alpha'],
        },
      ],
      agentTokens: { alpha: ALPHA_TOKEN, beta: BETA_TOKEN },
    });

    try {
      const firstSnapshot = await request(indexedContext.app)
        .get('/api/inbox/alpha/unread')
        .set('X-Agent-Token', ALPHA_TOKEN);
      expect(firstSnapshot.status).toBe(200);
      expect(firstSnapshot.body.unread_ids).toEqual(['msg_direct_seed', 'msg_group_seed']);

      const suppressResponse = await request(indexedContext.app)
        .post('/api/messages/msg_direct_seed/suppress')
        .set('X-Agent-Token', ALPHA_TOKEN)
        .send({ agent: 'alpha', reason: 'index-regression' });
      expect(suppressResponse.status).toBe(200);

      const createResponse = await request(indexedContext.app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'fresh direct',
          full: 'fresh direct',
        });
      expect(createResponse.status).toBe(200);

      const secondSnapshot = await request(indexedContext.app)
        .get('/api/inbox/alpha/unread-list?limit=0')
        .set('X-Agent-Token', ALPHA_TOKEN);
      expect(secondSnapshot.status).toBe(200);
      expect(secondSnapshot.body.messages.map((row) => row.id)).toEqual([
        'msg_group_seed',
        createResponse.body.id,
      ]);
    } finally {
      indexedContext.cleanup();
    }
  });

  test('unread inbox indexing preserves equal timestamp cursor ordering', async () => {
    const indexedContext = await createBackendTestContext('agent-chat-messages-unread-order-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
      },
      groups: {},
      messages: ['msg_0001', 'msg_0002', 'msg_0003'].map((id) => ({
        id,
        ts: 2000,
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: id,
        full: id,
        mentions: [],
      })),
      cursors: {
        alpha: {
          inbox: 2000,
          inboxId: 'msg_0001',
          groups: {},
          groupIds: {},
        },
      },
      agentTokens: { alpha: ALPHA_TOKEN },
    });

    try {
      const response = await request(indexedContext.app)
        .get('/api/inbox/alpha/unread-list?limit=0')
        .set('X-Agent-Token', ALPHA_TOKEN);

      expect(response.status).toBe(200);
      expect(response.body.messages.map((row) => row.id)).toEqual(['msg_0002', 'msg_0003']);
    } finally {
      indexedContext.cleanup();
    }
  });

  test('offline catchup messages append source delivery events and do not recurse', async () => {
    const catchupContext = await createBackendTestContext('agent-chat-messages-catchup-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: false,
          offlineReason: 'test-offline',
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_1',
          ts: Date.now() - 1000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'missed while offline',
          full: 'missed while offline',
          mentions: [],
          reply_to: null,
        },
      ],
    });

    try {
      const response = await request(catchupContext.app)
        .post('/api/agents')
        .send({ name: 'alpha', type: 'agent', tmux: 'alpha:0.0', server: 'remote-1' });
      expect(response.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const firstMessages = readPersistedMessages(catchupContext.runtimeDir);
      const firstCatchups = firstMessages.filter((msg) => msg?.schema?.kind === 'system_catchup');
      expect(firstCatchups).toHaveLength(1);
      expect(firstCatchups[0].schema.payload).toMatchObject({
        reason: 'agent-online-update',
        sourceUnreadCount: 1,
        sourceUnreadIds: ['msg_1'],
        oldestId: 'msg_1',
        latestId: 'msg_1',
      });
      expect(readDeliveryEvents(catchupContext.runtimeDir)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'message.accepted',
          agent: 'alpha',
          targetAgents: ['alpha'],
          context: expect.objectContaining({
            reason: 'agent-online-update',
          }),
        }),
      ]));

      const offlineResponse = await request(catchupContext.app)
        .patch('/api/agents/alpha')
        .send({ online: false, tmux: null });
      expect(offlineResponse.status).toBe(200);

      const secondOnlineResponse = await request(catchupContext.app)
        .patch('/api/agents/alpha')
        .send({ online: true, tmux: 'alpha:0.0' });
      expect(secondOnlineResponse.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondMessages = readPersistedMessages(catchupContext.runtimeDir);
      expect(secondMessages.filter((msg) => msg?.schema?.kind === 'system_catchup')).toHaveLength(1);
    } finally {
      catchupContext.cleanup();
    }
  });

  test('merged unread push retries after queue failure instead of committing dedupe early', async () => {
    const queueStub = await createQueueStub((_req, count) => (
      count === 1
        ? { status: 503, body: { ok: false, error: 'queue down' } }
        : { status: 200, body: { ok: true, id: count, queuedAt: 3000 + count } }
    ));
    const retryContext = await createBackendTestContext('agent-chat-merged-push-retry-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          tmux: 'alpha:0.0',
          server: 'local',
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_merged_1',
          ts: 1000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'one',
          full: 'one',
          mentions: [],
        },
        {
          id: 'msg_merged_2',
          ts: 2000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'two',
          full: 'two',
          mentions: [],
        },
      ],
      env: { AGENT_CHAT_QUEUE_URL: queueStub.url },
    });

    try {
      const first = await retryContext.internals.pushNotifyForTest('alpha', {
        id: 'msg_merged_2',
        ts: 2000,
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'normal',
        summary: 'two',
      });
      const second = await retryContext.internals.pushNotifyForTest('alpha', {
        id: 'msg_merged_2',
        ts: 2000,
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'normal',
        summary: 'two',
      });

      expect(first).toMatchObject({ queued: false, reason: 'status-503' });
      expect(second).toMatchObject({ queued: true });
      expect(queueStub.requests).toHaveLength(2);

      const events = readDeliveryEvents(retryContext.runtimeDir);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'push.queue_failed',
          messageIds: ['msg_merged_1', 'msg_merged_2'],
          reason: 'status-503',
        }),
        expect.objectContaining({
          type: 'push.queued',
          messageIds: ['msg_merged_1', 'msg_merged_2'],
          queueEntryId: 2,
        }),
      ]));
    } finally {
      retryContext.cleanup();
      await queueStub.close();
    }
  });

  test('backend queues hostname-local agents when backend env still uses legacy local', async () => {
    const queueStub = await createQueueStub((_req, count) => ({
      status: 200,
      body: { ok: true, id: count, queuedAt: 3000 + count },
    }));
    const retryContext = await createBackendTestContext('agent-chat-hostname-local-push-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          tmux: 'alpha:0.0',
          server: os.hostname(),
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_hostname_local',
          ts: 1000,
          from: 'operator',
          to: 'alpha',
          type: 'human',
          summary: 'hostname local push',
          full: 'hostname local push',
          mentions: [],
          trustLevel: 'operator',
        },
      ],
      env: {
        AGENT_CHAT_SERVER: 'local',
        AGENT_CHAT_QUEUE_URL: queueStub.url,
      },
    });

    try {
      const result = await retryContext.internals.pushNotifyForTest('alpha', {
        id: 'msg_hostname_local',
        ts: 1000,
        from: 'operator',
        to: 'alpha',
        type: 'human',
        priority: 'normal',
        summary: 'hostname local push',
      });

      expect(result).toMatchObject({ queued: true });
      expect(queueStub.requests).toHaveLength(1);
      const events = readDeliveryEvents(retryContext.runtimeDir);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'push.queued',
          messageId: 'msg_hostname_local',
          agent: 'alpha',
        }),
      ]));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'push.not_queued',
          messageId: 'msg_hostname_local',
          reason: 'remote-relay-expected',
        }),
      ]));
    } finally {
      retryContext.cleanup();
      await queueStub.close();
    }
  });

  test('offline catchup retries queue failure without duplicating persisted catchup', async () => {
    const queueStub = await createQueueStub((_req, count) => (
      count === 1
        ? { status: 503, body: { ok: false, error: 'queue down' } }
        : { status: 200, body: { ok: true, id: count, queuedAt: 4000 + count } }
    ));
    const retryContext = await createBackendTestContext('agent-chat-catchup-retry-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          tmux: 'alpha:0.0',
          server: 'local',
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_catchup_1',
          ts: 1000,
          from: 'operator',
          to: 'alpha',
          type: 'human',
          summary: 'one',
          full: 'one',
          mentions: [],
          trustLevel: 'operator',
        },
        {
          id: 'msg_catchup_2',
          ts: 2000,
          from: 'beta',
          to: 'alpha',
          type: 'request',
          summary: 'two',
          full: 'two',
          mentions: [],
        },
      ],
      env: { AGENT_CHAT_QUEUE_URL: queueStub.url },
    });

    try {
      await retryContext.internals.notifyAgentCatchupForTest('alpha', 'retry-test');
      expect(queueStub.requests).toHaveLength(1);

      let persisted = readPersistedMessages(retryContext.runtimeDir);
      let catchups = persisted.filter((msg) => msg?.schema?.kind === 'system_catchup');
      expect(catchups).toHaveLength(1);
      expect(queueStub.requests[0].body.notifyMeta).toMatchObject({
        kind: 'merged_unread_actionable',
        unreadCount: 2,
        messageIds: ['msg_catchup_1', 'msg_catchup_2'],
      });

      await retryContext.internals.notifyAgentCatchupForTest('alpha', 'retry-test');
      expect(queueStub.requests).toHaveLength(2);

      persisted = readPersistedMessages(retryContext.runtimeDir);
      catchups = persisted.filter((msg) => msg?.schema?.kind === 'system_catchup');
      expect(catchups).toHaveLength(1);
      expect(queueStub.requests[1].body.notifyMeta).toMatchObject({
        kind: 'merged_unread_actionable',
        unreadCount: 2,
        messageIds: ['msg_catchup_1', 'msg_catchup_2'],
      });
      expect(queueStub.requests[1].body.notifyMeta.messageIds).not.toContain(catchups[0].id);

      const events = readDeliveryEvents(retryContext.runtimeDir);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'push.queue_failed',
          messageIds: ['msg_catchup_1', 'msg_catchup_2'],
          reason: 'status-503',
        }),
        expect.objectContaining({
          type: 'push.queued',
          messageIds: ['msg_catchup_1', 'msg_catchup_2'],
          queueEntryId: 2,
        }),
      ]));
    } finally {
      retryContext.cleanup();
      await queueStub.close();
    }
  });

  test('offline catchup reuses an existing persisted catchup after cursor reset', async () => {
    const queueStub = await createQueueStub((_req, count) => ({
      status: 200,
      body: { ok: true, id: count, queuedAt: 5000 + count },
    }));
    const existingCatchup = {
      id: 'msg_existing_catchup',
      ts: 3000,
      from: 'system',
      to: 'alpha',
      group: null,
      type: 'inform',
      priority: 'normal',
      summary: 'Queued while offline: 2 message(s).',
      full: 'existing catchup',
      mentions: [],
      reply_to: null,
      source: 'system',
      schema: {
        kind: 'system_catchup',
        version: 1,
        payload: {
          reason: 'previous-process',
          sourceUnreadCount: 2,
          sourceUnreadIds: ['msg_existing_1', 'msg_existing_2'],
          oldestId: 'msg_existing_1',
          latestId: 'msg_existing_2',
        },
      },
    };
    const retryContext = await createBackendTestContext('agent-chat-catchup-existing-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          tmux: 'alpha:0.0',
          server: 'local',
        },
      },
      groups: {},
      messages: [
        {
          id: 'msg_existing_1',
          ts: 1000,
          from: 'operator',
          to: 'alpha',
          type: 'human',
          summary: 'one',
          full: 'one',
          mentions: [],
          trustLevel: 'operator',
        },
        {
          id: 'msg_existing_2',
          ts: 2000,
          from: 'beta',
          to: 'alpha',
          type: 'request',
          summary: 'two',
          full: 'two',
          mentions: [],
        },
        existingCatchup,
      ],
      env: { AGENT_CHAT_QUEUE_URL: queueStub.url },
    });

    try {
      await retryContext.internals.notifyAgentCatchupForTest('alpha', 'after-restart');

      const persisted = readPersistedMessages(retryContext.runtimeDir);
      const catchups = persisted.filter((msg) => msg?.schema?.kind === 'system_catchup');
      expect(catchups).toHaveLength(1);
      expect(catchups[0].id).toBe('msg_existing_catchup');
      expect(queueStub.requests).toHaveLength(1);
      expect(queueStub.requests[0].body.notifyMeta).toMatchObject({
        kind: 'merged_unread_actionable',
        unreadCount: 2,
        messageIds: ['msg_existing_1', 'msg_existing_2'],
      });
      expect(queueStub.requests[0].body.notifyMeta.messageIds).not.toContain('msg_existing_catchup');
    } finally {
      retryContext.cleanup();
      await queueStub.close();
    }
  });

  test('POST message with schema.version as string returns 400', async () => {
    const response = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'string version',
        full: 'body',
        schema: {
          kind: 'task_request',
          version: '1',
          payload: { taskId: 'T-3' },
        },
      });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'schema.version must be a positive integer' });
  });

  test('POST message with priority=high stores priority', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'high',
        summary: 'high priority',
        full: 'body',
      });
    expect(createResponse.status).toBe(200);

    const readResponse = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.priority).toBe('high');
  });

  test('POST message with priority=urgent stores priority', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'urgent',
        summary: 'urgent priority',
        full: 'body',
      });
    expect(createResponse.status).toBe(200);

    const readResponse = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.priority).toBe('urgent');
  });

  test('GET message detail requires bearer or visible agent identity', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'private detail',
        full: 'private body',
      });
    expect(createResponse.status).toBe(200);

    const anonymous = await request(context.app).get(`/api/messages/${createResponse.body.id}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: 'agent identity required' });

    const wrongAgent = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .query({ agent: 'beta' })
      .set('X-Agent-Token', BETA_TOKEN);
    expect(wrongAgent.status).toBe(403);

    const recipient = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .query({ agent: 'alpha' })
      .set('X-Agent-Token', ALPHA_TOKEN);
    expect(recipient.status).toBe(200);
    expect(recipient.body.full).toBe('private body');

    const bearer = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(bearer.status).toBe(200);
  });

  test('GET message detail allows group members with agent token', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        group: 'dev',
        type: 'inform',
        summary: 'group detail',
        full: 'group body',
      });
    expect(createResponse.status).toBe(200);

    const member = await request(context.app)
      .get(`/api/messages/${createResponse.body.id}`)
      .query({ agent: 'beta' })
      .set('X-Agent-Token', BETA_TOKEN);
    expect(member.status).toBe(200);
    expect(member.body.full).toBe('group body');
  });

  test('GET HTML message detail requires the same message access', async () => {
    const createResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'html detail',
        full: 'html body',
      });
    expect(createResponse.status).toBe(200);

    const anonymous = await request(context.app).get(`/msg/${createResponse.body.id}`);
    expect(anonymous.status).toBe(401);

    const recipient = await request(context.app)
      .get(`/msg/${createResponse.body.id}`)
      .query({ agent: 'alpha' })
      .set('X-Agent-Token', ALPHA_TOKEN);
    expect(recipient.status).toBe(200);
    expect(recipient.text).toContain('html detail');
  });

  test('POST message with priority=invalid returns 400', async () => {
    const response = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'invalid',
        summary: 'bad priority',
        full: 'body',
      });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'priority must be one of: normal, high, urgent' });
  });

  test('POST message returns 503 without accept side effects when messages persistence fails', async () => {
    const failContext = await createBackendTestContext('agent-chat-messages-save-fail-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
        },
      },
      agentTokens: { alpha: ALPHA_TOKEN },
    });

    try {
      failContext.internals.setJsonSaveFailureForTest('messages.json', true);
      const response = await request(failContext.app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'durability failure',
          full: 'body',
        });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'messages persistence failed' });
      expect(readPersistedMessages(failContext.runtimeDir)).toEqual([]);
      expect(readDeliveryEvents(failContext.runtimeDir)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'message.accepted' }),
      ]));
    } finally {
      failContext.cleanup();
    }
  });

  test('POST message returns 503 without persistence when msg_counter persistence fails', async () => {
    const failContext = await createBackendTestContext('agent-chat-message-counter-fail-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
        },
      },
    });

    try {
      failContext.internals.setJsonSaveFailureForTest('.msg_counter', true);
      const response = await request(failContext.app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'counter failure',
          full: 'body',
        });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'msg_counter persistence failed' });
      expect(readPersistedMessages(failContext.runtimeDir)).toEqual([]);
      expect(readJsonFile(failContext.runtimeDir, '.msg_counter')).toBe(0);
      expect(readDeliveryEvents(failContext.runtimeDir)).toEqual([]);
    } finally {
      failContext.cleanup();
    }
  });

  test('startup reconciles stale msg_counter from persisted messages before assigning next id', async () => {
    const staleCounterContext = await createBackendTestContext('agent-chat-message-counter-reconcile-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
        },
      },
      messages: [
        {
          id: 'msg_9999',
          ts: 1000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          priority: 'normal',
          summary: 'seed high id',
          full: 'seed high id',
          mentions: [],
          reply_to: null,
        },
      ],
      msgCounter: 0,
    });

    try {
      expect(readJsonFile(staleCounterContext.runtimeDir, '.msg_counter')).toBe(9999);
      const response = await request(staleCounterContext.app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'after reconcile',
          full: 'body',
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('msg_10000');
      expect(readJsonFile(staleCounterContext.runtimeDir, '.msg_counter')).toBe(10000);
    } finally {
      staleCounterContext.cleanup();
    }
  });

  test('GET inbox returns 503 and leaves unread state when cursor persistence fails', async () => {
    const failContext = await createBackendTestContext('agent-chat-inbox-cursor-fail-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
        },
      },
      messages: [
        {
          id: 'msg_0001',
          ts: 1000,
          from: 'system',
          to: 'alpha',
          type: 'inform',
          priority: 'normal',
          summary: 'unread',
          full: 'unread',
          mentions: [],
          reply_to: null,
        },
      ],
      msgCounter: 1,
    });

    try {
      failContext.internals.setJsonSaveFailureForTest('cursors.json', true);
      const failedRead = await request(failContext.app).get('/api/inbox/alpha');

      expect(failedRead.status).toBe(503);
      expect(failedRead.body).toEqual({ error: 'cursor persistence failed' });
      expect(readJsonFile(failContext.runtimeDir, 'cursors.json')).toEqual({});
      expect(readDeliveryEvents(failContext.runtimeDir)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'inbox.read_ack' }),
      ]));

      failContext.internals.setJsonSaveFailureForTest('cursors.json', false);
      const preview = await request(failContext.app).get('/api/inbox/alpha');
      expect(preview.status).toBe(200);
      expect(preview.body.dm.map((row) => row.id)).toEqual(['msg_0001']);
    } finally {
      failContext.cleanup();
    }
  });

  test('GET inbox with kinds=task_request filter returns only matching messages', async () => {
    await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'task schema',
        full: 'body',
        schema: { kind: 'task_request', version: 1, payload: { taskId: 'T-4' } },
      });
    await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'other schema',
        full: 'body',
        schema: { kind: 'other_kind', version: 1, payload: { taskId: 'T-5' } },
      });

    const response = await request(context.app)
      .get('/api/inbox/alpha')
      .query({ kinds: 'task_request' });
    expect(response.status).toBe(200);
    expect(response.body.dm).toHaveLength(2);
    expect(response.body.dm.every((row) => row.schema?.kind === 'task_request')).toBe(true);
  });

  test('GET inbox with kinds filter does not advance cursor', async () => {
    await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'cursor task schema',
        full: 'body',
        schema: { kind: 'task_request', version: 1, payload: { taskId: 'T-6' } },
      });
    await request(context.app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'cursor plain',
        full: 'body',
      });

    const filteredResponse = await request(context.app)
      .get('/api/inbox/alpha')
      .query({ kinds: 'task_request' });
    expect(filteredResponse.status).toBe(200);
    expect(filteredResponse.body.dm.length).toBeGreaterThanOrEqual(1);
    expect(filteredResponse.body.dm.every((row) => row.schema?.kind === 'task_request')).toBe(true);

    const firstUnfilteredResponse = await request(context.app).get('/api/inbox/alpha');
    expect(firstUnfilteredResponse.status).toBe(200);
    expect(firstUnfilteredResponse.body.dm.length).toBeGreaterThanOrEqual(2);

    const secondUnfilteredResponse = await request(context.app).get('/api/inbox/alpha');
    expect(secondUnfilteredResponse.status).toBe(200);
    expect(secondUnfilteredResponse.body.dm).toHaveLength(0);
  });

  test('message persistence prunes acknowledged history and archives the dropped prefix', async () => {
    const largeContext = await createBackendTestContext('agent-chat-messages-prune-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: true,
          offlineReason: 'test-offline',
        },
      },
      groups: {},
      messages: Array.from({ length: 5002 }, (_, index) => ({
        id: `msg_${String(index + 1).padStart(4, '0')}`,
        ts: index + 1,
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: `seed ${index + 1}`,
        full: `seed ${index + 1}`,
        mentions: [],
      })),
      cursors: {
        alpha: {
          inbox: 5002,
          inboxId: 'msg_5002',
          groups: {},
          groupIds: {},
        },
      },
      msgCounter: 5002,
    });

    try {
      const response = await request(largeContext.app)
        .post('/api/messages')
        .send({
          from: 'system',
          to: 'alpha',
          type: 'inform',
          summary: 'post-prune message',
          full: 'body',
        });
      expect(response.status).toBe(200);

      const messagesPath = path.join(largeContext.runtimeDir, 'data', 'messages.json');
      const archivedPath = path.join(largeContext.runtimeDir, 'data', 'messages-archive.jsonl');
      const persisted = JSON.parse(readFileSync(messagesPath, 'utf-8'));

      expect(persisted).toHaveLength(5000);
      expect(persisted[0].id).toBe('msg_0004');
      expect(persisted[persisted.length - 1].id).toBe(response.body.id);
      expect(existsSync(archivedPath)).toBe(true);

      const archived = readFileSync(archivedPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(archived.map((row) => row.id)).toEqual(['msg_0001', 'msg_0002', 'msg_0003']);
    } finally {
      largeContext.cleanup();
    }
  });
});
