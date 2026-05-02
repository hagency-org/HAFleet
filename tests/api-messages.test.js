import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const API_TOKEN = 'messages-test-api-token';
const ALPHA_TOKEN = 'alpha-agent-token';
const BETA_TOKEN = 'beta-agent-token';

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
