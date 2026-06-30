import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('matrix-Agent capability scheduler', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('agent-chat-dispatch-test-', {
      agents: {
        cod1: { name: 'cod1', type: 'claude', kind: 'agent', online: true, role: 'coding', capability: 'medium' },
      },
    });
  });

  afterAll(async () => {
    await context?.cleanup?.();
  });

  test('routes to an idle agent, then queues a second concurrent request for the same cell', async () => {
    const first = await request(context.app).post('/api/dispatch').send({ role: 'coding', capability: 'medium', task: 'A' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('routed');
    expect(first.body.agent).toBe('cod1');

    // cod1 is now reserved → a second request for coding/medium has no idle agent → queued
    const second = await request(context.app).post('/api/dispatch').send({ role: 'coding', capability: 'medium', task: 'B' });
    expect(second.body.status).toBe('queued');
    expect(second.body.queueDepth).toBe(1);

    // the pool shows cod1 busy
    const pool = await request(context.app).get('/api/pool?state=busy');
    expect(pool.body.agents.some((a) => a.name === 'cod1')).toBe(true);
  });

  test('release drains the queue back onto the freed agent', async () => {
    const rel = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(rel.status).toBe(200);
    expect(rel.body.status).toBe('drained');
    expect(rel.body.agent).toBe('cod1');
    expect(rel.body.task).toBe('B'); // the queued ticket

    // queue now empty → a release with nothing waiting just releases
    const rel2 = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(rel2.body.status).toBe('released');
  });

  test('dispatch requires a role', async () => {
    const r = await request(context.app).post('/api/dispatch').send({ capability: 'medium' });
    expect(r.status).toBe(400);
  });
});
