import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

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
      },
      groups: {},
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

    const readResponse = await request(context.app).get(`/api/messages/${createResponse.body.id}`);
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

    const readResponse = await request(context.app).get(`/api/messages/${createResponse.body.id}`);
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

    const readResponse = await request(context.app).get(`/api/messages/${createResponse.body.id}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.priority).toBe('urgent');
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
});
