import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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

  test('auto-provision: under cap returns a provision plan, over cap queues', async () => {
    const prev = process.env.MATRIX_AGENT_MAX_PER_CELL;
    process.env.MATRIX_AGENT_MAX_PER_CELL = '1';
    try {
      // empty cell (documentation/lightweight has no agents) → first request provisions
      const a = await request(context.app).post('/api/dispatch').send({ role: 'documentation', capability: 'lightweight' });
      expect(a.body.status).toBe('provision');
      expect(a.body.runtime).toBeTruthy();
      expect(a.body.name).toMatch(/^mx_documentation_lightweight_/);
      // cap=1 reached (one outstanding plan) → second request queues
      const b = await request(context.app).post('/api/dispatch').send({ role: 'documentation', capability: 'lightweight' });
      expect(b.body.status).toBe('queued');
    } finally {
      if (prev === undefined) delete process.env.MATRIX_AGENT_MAX_PER_CELL;
      else process.env.MATRIX_AGENT_MAX_PER_CELL = prev;
    }
  });
});

// Task 7: dispatch reservations are owner-bound, renewable leases rather than a bare busy flag.
// Each test gets its own backend context + fake clock so lease TTL/expiry scenarios don't leak
// across tests (unlike the sequential/shared-state describe block above).
describe('matrix-Agent dispatch leases (Task 7)', () => {
  let context;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    context = await createBackendTestContext('agent-chat-dispatch-lease-test-', {
      agents: {
        cod1: { name: 'cod1', type: 'claude', kind: 'agent', online: true, role: 'coding', capability: 'medium' },
      },
      env: { AGENTCHAT_DISPATCH_LEASE_TTL_MS: '60000' }, // 60s — short enough to fast-forward past in tests
    });
  });

  afterEach(async () => {
    await context?.cleanup?.();
    vi.useRealTimers();
  });

  test('1. dispatch returns an owned lease (leaseId + expiresAt), on top of the existing fields', async () => {
    const res = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('routed');
    expect(res.body.agent).toBe('cod1'); // existing field, unchanged
    expect(res.body.role).toBe('coding'); // existing field, unchanged
    expect(typeof res.body.leaseId).toBe('string');
    expect(res.body.leaseId.length).toBeGreaterThan(0);
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  test('2. renew extends expiresAt for the owning dispatcher', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    const { leaseId, expiresAt: firstExpiry } = dispatch.body;

    vi.setSystemTime(new Date(Date.now() + 30_000)); // still well inside the 60s TTL
    const renew = await request(context.app).post('/api/dispatch/renew')
      .send({ leaseId, agent: 'cod1', owner: 'dispatcher-a' });
    expect(renew.status).toBe(200);
    expect(renew.body.status).toBe('renewed');
    expect(renew.body.leaseId).toBe(leaseId);
    expect(renew.body.expiresAt).toBeGreaterThan(firstExpiry);
  });

  test('3. renew/release reject an owner mismatch', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    const { leaseId } = dispatch.body;

    const renew = await request(context.app).post('/api/dispatch/renew')
      .send({ leaseId, agent: 'cod1', owner: 'dispatcher-b' });
    expect(renew.status).toBe(403);
    expect(renew.body.reason).toBe('owner_mismatch');

    const release = await request(context.app).post('/api/dispatch/release')
      .send({ leaseId, agent: 'cod1', owner: 'dispatcher-b' });
    expect(release.status).toBe(403);
    expect(release.body.reason).toBe('owner_mismatch');
  });

  test('4. release rejects a stale (superseded) leaseId', async () => {
    const first = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    await request(context.app).post('/api/dispatch/release')
      .send({ leaseId: first.body.leaseId, agent: 'cod1', owner: 'dispatcher-a' });
    // cod1 is idle again; a fresh dispatch mints a brand new leaseId for it.
    await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'B', owner: 'dispatcher-a' });

    const stale = await request(context.app).post('/api/dispatch/release')
      .send({ leaseId: first.body.leaseId, agent: 'cod1', owner: 'dispatcher-a' });
    expect(stale.status).toBe(404);
    expect(stale.body.reason).toBe('lease_not_found');
  });

  test('5. an unrenewed lease expires and frees the agent for a later dispatch', async () => {
    const first = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    expect(first.body.status).toBe('routed');

    vi.setSystemTime(new Date(first.body.expiresAt + 1));
    const second = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'B', owner: 'dispatcher-b' });
    expect(second.body.status).toBe('routed'); // cod1 was reaped, so this routes rather than queues
    expect(second.body.agent).toBe('cod1');
    expect(second.body.leaseId).not.toBe(first.body.leaseId);
  });

  test('6. a continuously-renewed long task is never reaped, even past the original TTL', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    const { leaseId } = dispatch.body;
    const ttlMs = dispatch.body.expiresAt - Date.now();

    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(new Date(Date.now() + Math.floor(ttlMs * 0.7)));
      const renew = await request(context.app).post('/api/dispatch/renew')
        .send({ leaseId, agent: 'cod1', owner: 'dispatcher-a' });
      expect(renew.status).toBe(200);
    }
    // total elapsed time (2.1x ttlMs) is well past the original TTL window, but every hop
    // renewed before lapsing, so the lease must still be alive.
    const pool = await request(context.app).get('/api/pool?state=busy');
    expect(pool.body.agents.some((a) => a.name === 'cod1')).toBe(true);
  });

  test('7. a reaped lease with a durable ticket is requeued exactly once', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a', ticket: 'durable-1' });
    expect(dispatch.body.status).toBe('routed');
    const firstExpiry = dispatch.body.expiresAt;

    // expire it unrenewed; GET /api/pool triggers the reap sweep (like refreshServerLiveness()).
    vi.setSystemTime(new Date(firstExpiry + 1));
    await request(context.app).get('/api/pool');

    // cod1 is idle again, but the durable ticket should now be queued for its cell; releasing
    // cod1 (even though nothing currently holds it) drains that queue and re-reserves it.
    const drained = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(drained.body.status).toBe('drained');
    expect(drained.body.ticket).toBe('durable-1');
    expect(typeof drained.body.leaseId).toBe('string');
    expect(drained.body.leaseId).not.toBe(dispatch.body.leaseId);
    const secondExpiry = drained.body.expiresAt;

    // let this SECOND (requeued) lease also expire unrenewed — the ticket already used its one
    // automatic requeue, so this time it must NOT be requeued again.
    vi.setSystemTime(new Date(secondExpiry + 1));
    await request(context.app).get('/api/pool');
    const secondRelease = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(secondRelease.body.status).toBe('released'); // nothing queued this time — no second requeue
  });

  test('8. a reaped lease with no durable ticket is marked failed and raises an alert (never silently duplicated)', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' }); // no ticket
    vi.setSystemTime(new Date(dispatch.body.expiresAt + 1));
    await request(context.app).get('/api/pool'); // triggers the reap

    const release = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(release.body.status).toBe('released'); // nothing was queued — no silent duplicate

    const alerts = await request(context.app).get('/api/alerts').query({ alertType: 'dispatch_lease_expired' });
    expect(alerts.status).toBe(200);
    expect(alerts.body.some((a) => a.sourceAgent === 'cod1')).toBe(true);
  });

  test('9. provision and release leave agent state consistent (no leaked leases)', async () => {
    // a normal routed → release round-trip leaves zero active leases behind
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    const release = await request(context.app).post('/api/dispatch/release')
      .send({ leaseId: dispatch.body.leaseId, agent: 'cod1', owner: 'dispatcher-a' });
    expect(release.body.status).toBe('released');
    expect(context.internals.dispatchLeaseStoreForTest.size).toBe(0);

    const idlePool = await request(context.app).get('/api/pool?state=idle');
    expect(idlePool.body.agents.some((a) => a.name === 'cod1')).toBe(true);

    // auto-provision (agent doesn't exist yet) never touches the lease store
    const prev = process.env.MATRIX_AGENT_MAX_PER_CELL;
    process.env.MATRIX_AGENT_MAX_PER_CELL = '1';
    try {
      const provisioned = await request(context.app).post('/api/dispatch')
        .send({ role: 'documentation', capability: 'lightweight' });
      expect(provisioned.body.status).toBe('provision');
      expect(provisioned.body.leaseId).toBeUndefined();
      expect(context.internals.dispatchLeaseStoreForTest.size).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MATRIX_AGENT_MAX_PER_CELL;
      else process.env.MATRIX_AGENT_MAX_PER_CELL = prev;
    }
  });

  test('legacy release (no leaseId/owner) still works — back-compat for pre-Task-7 callers', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A' }); // no owner supplied, like the OpenFab Bridge today
    expect(dispatch.body.status).toBe('routed');
    expect(typeof dispatch.body.leaseId).toBe('string'); // still gets a real lease under a default owner

    const release = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' }); // legacy shape
    expect(release.status).toBe(200);
    expect(release.body.status).toBe('released');
    expect(context.internals.dispatchLeaseStoreForTest.size).toBe(0);
  });

  test('release rejects a partial ownership tuple (leaseId without owner, or vice versa)', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });

    const onlyLeaseId = await request(context.app).post('/api/dispatch/release')
      .send({ agent: 'cod1', leaseId: dispatch.body.leaseId });
    expect(onlyLeaseId.status).toBe(400);
    expect(onlyLeaseId.body.reason).toBe('missing_fields');

    const onlyOwner = await request(context.app).post('/api/dispatch/release')
      .send({ agent: 'cod1', owner: 'dispatcher-a' });
    expect(onlyOwner.status).toBe(400);
    expect(onlyOwner.body.reason).toBe('missing_fields');
  });

  test('renew requires the full (leaseId, agent, owner) tuple', async () => {
    const res = await request(context.app).post('/api/dispatch/renew').send({ agent: 'cod1' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('missing_fields');
  });
});
