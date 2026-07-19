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
      // Task 7: this pre-Task-7 suite releases by bare {agent} (no leaseId/owner). That shape is
      // rejected by default post-Task-7 (see the "dispatch leases" describe block below); the
      // compatibility shim keeps this suite's original behavior working unchanged.
      env: { AGENTCHAT_ALLOW_LEGACY_RELEASE: '1' },
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
        cod2: { name: 'cod2', type: 'claude', kind: 'agent', online: true, role: 'coding', capability: 'medium' },
      },
      env: { AGENTCHAT_DISPATCH_LEASE_TTL_MS: '60000' }, // 60s — short enough to fast-forward past in tests
      // AGENTCHAT_ALLOW_LEGACY_RELEASE deliberately left unset (default off): this block tests
      // the strict, owner-checked contract. The compatibility-shim describe block below covers
      // the opt-in legacy path.
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
    const first = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a', ticket: 'durable-1' });
    expect(first.body.agent).toBe('cod1');
    vi.setSystemTime(new Date(Date.now() + 5000)); // so cod2's lease outlives cod1's below
    const second = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'B', owner: 'dispatcher-b' });
    expect(second.body.agent).toBe('cod2'); // cod1 already reserved by `first`
    expect(second.body.expiresAt).toBeGreaterThan(first.body.expiresAt);

    // expire cod1's lease unrenewed; GET /api/pool triggers the reap sweep (like refreshServerLiveness()).
    vi.setSystemTime(new Date(first.body.expiresAt + 1));
    await request(context.app).get('/api/pool');
    // the durable ticket should now be queued for the coding:medium cell.
    const queuedAfterFirstReap = context.internals.dispatchQueuesForTest.get('coding:medium') || [];
    expect(queuedAfterFirstReap).toMatchObject([{ ticket: 'durable-1' }]);

    // A fully-owned, strict release of a DIFFERENT agent in the same cell drains that queue —
    // proving the requeue landed without touching the (now-restricted) legacy release shape.
    const drained = await request(context.app).post('/api/dispatch/release')
      .send({ agent: 'cod2', leaseId: second.body.leaseId, owner: 'dispatcher-b' });
    expect(drained.body.status).toBe('drained');
    expect(drained.body.agent).toBe('cod2');
    expect(drained.body.ticket).toBe('durable-1');
    expect(typeof drained.body.leaseId).toBe('string');
    const secondExpiry = drained.body.expiresAt;

    // let this SECOND (requeued) lease also expire unrenewed — the ticket already used its one
    // automatic requeue, so this time it must NOT be requeued again.
    vi.setSystemTime(new Date(secondExpiry + 1));
    await request(context.app).get('/api/pool');
    expect(context.internals.dispatchQueuesForTest.get('coding:medium') || []).toHaveLength(0);
  });

  test('8. a reaped lease with no durable ticket is marked failed and raises an alert (never silently duplicated)', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' }); // no ticket
    vi.setSystemTime(new Date(dispatch.body.expiresAt + 1));
    await request(context.app).get('/api/pool'); // triggers the reap

    // nothing queued for the cell — no silent duplicate of the failed task
    expect(context.internals.dispatchQueuesForTest.get('coding:medium') || []).toHaveLength(0);

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

  test('release rejects the legacy {agent}-only shape by default (ownership tuple required)', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A', owner: 'dispatcher-a' });
    expect(dispatch.body.status).toBe('routed');

    const release = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(release.status).toBe(400);
    expect(release.body.reason).toBe('missing_fields');
    expect(release.body.error).toMatch(/AGENTCHAT_ALLOW_LEGACY_RELEASE/);

    // rejected, not silently released — the lease and the agent's busy state are untouched
    expect(context.internals.dispatchLeaseStoreForTest.size).toBe(1);
    const pool = await request(context.app).get('/api/pool?state=busy');
    expect(pool.body.agents.some((a) => a.name === 'cod1')).toBe(true);
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

// AGENTCHAT_ALLOW_LEGACY_RELEASE=1: an explicit opt-in escape hatch for callers that predate
// ownership (e.g. a reintroduced OpenFab Bridge). Off by default — see "release rejects the
// legacy {agent}-only shape by default" above for the default-deny behavior this shim overrides.
describe('matrix-Agent dispatch leases — legacy release compatibility shim (AGENTCHAT_ALLOW_LEGACY_RELEASE=1)', () => {
  let context;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    context = await createBackendTestContext('agent-chat-dispatch-lease-shim-test-', {
      agents: {
        cod1: { name: 'cod1', type: 'claude', kind: 'agent', online: true, role: 'coding', capability: 'medium' },
      },
      env: {
        AGENTCHAT_DISPATCH_LEASE_TTL_MS: '60000',
        AGENTCHAT_ALLOW_LEGACY_RELEASE: '1',
      },
    });
  });

  afterEach(async () => {
    await context?.cleanup?.();
    vi.useRealTimers();
  });

  test('legacy {agent}-only release still works when the shim is explicitly enabled', async () => {
    const dispatch = await request(context.app).post('/api/dispatch')
      .send({ role: 'coding', capability: 'medium', task: 'A' }); // no owner supplied, like the OpenFab Bridge
    expect(dispatch.body.status).toBe('routed');
    expect(typeof dispatch.body.leaseId).toBe('string'); // still gets a real lease under a default owner

    const release = await request(context.app).post('/api/dispatch/release').send({ agent: 'cod1' });
    expect(release.status).toBe(200);
    expect(release.body.status).toBe('released');
    expect(context.internals.dispatchLeaseStoreForTest.size).toBe(0);
  });
});
