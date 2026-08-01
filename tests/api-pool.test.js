import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('matrix-Agent pool API', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-pool-test-', {
      agents: {
        // a legacy agent with no role/capability — should be inferred into the matrix
        wf_implementer: { name: 'wf_implementer', type: 'claude', kind: 'agent', online: true },
      },
    });
  });

  afterAll(async () => {
    await context?.cleanup?.();
  });

  test('registration persists a capability tier', async () => {
    const reg = await request(context.app)
      .post('/api/agents')
      .send({ name: 'arch1', role: 'architect', capability: 'strong' });
    expect(reg.status).toBe(200);
    const got = await request(context.app).get('/api/agents/arch1');
    expect(got.status).toBe(200);
    expect(got.body.role).toBe('architect');
    expect(got.body.capability).toBe('strong');
  });

  test('an invalid capability is rejected (not persisted)', async () => {
    await request(context.app)
      .post('/api/agents')
      .send({ name: 'weird', role: 'coding', capability: 'super-duper' });
    const got = await request(context.app).get('/api/agents/weird');
    expect(got.body.capability).toBeNull();
  });

  test('GET /api/pool returns the role×capability grid (with inference for legacy agents)', async () => {
    await request(context.app).post('/api/agents').send({ name: 'cod1', role: 'coding', capability: 'medium' });
    const res = await request(context.app).get('/api/pool');
    expect(res.status).toBe(200);
    // legacy wf_implementer (no role) is inferred → coding
    expect(res.body.counts.coding).toBeTruthy();
    // explicit architect@strong is present
    expect(res.body.counts.architect?.strong).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  test('GET /api/pool filters by role + capability', async () => {
    const res = await request(context.app).get('/api/pool?role=coding&capability=medium');
    expect(res.status).toBe(200);
    expect(res.body.agents.every((a) => a.role === 'coding' && a.capability === 'medium')).toBe(true);
  });
});
