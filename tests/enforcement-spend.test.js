/*
 * Enforcement: a ceiling is spent by CONSUMPTION, not only by what was promised.
 *
 * ADR-013 said ceilings were declarations because nothing measured consumption — "without
 * it a ceiling is a decoration". Now that `lib/metering` measures it, the allocation and
 * the spend can disagree in both directions:
 *
 *   allocated 400k, consumed 900k   the ceiling is exceeded while the allocation says fine
 *   allocated 400k, consumed  50k   350k is reserved and unused
 *
 * The policy this pins, chosen deliberately: refuse new auto-joins against an exhausted
 * ceiling, and NEVER stop a running agent. Killing an agent at its cap converts a budgeting
 * decision into lost work, and a request that exceeds the ceiling falls back to approval
 * rather than rejection — the project did nothing wrong by asking.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const CEILING = 1_000_000;

const seedWith = (extra = {}) => ({
  agents: {
    a1: {
      name: 'a1', type: 'claude', server: 'local', tmux: null, online: true,
      manualDown: false, presetId: 'p1',
      runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
    },
  },
  frameworkPresets: [{
    id: 'p1', name: 'p', framework: 'claude', model: 'claude-opus-5',
    ceiling: { tokens: CEILING, period: 'monthly' },
  }],
  ...extra,
});

/** Drive one metering sweep so the ledger has a bucket for this period. */
async function meterOnce(ctx) {
  await request(ctx.app).get('/api/usage');
}

describe('remaining capacity counts spend as well as reservations', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('with nothing measured, the figure rests on allocations alone', async () => {
    /*
     * An unmeasured period must not be read as zero spend — that would report full headroom
     * for an agent nobody has looked at. The allocation figure stands alone instead.
     */
    ctx = await createBackendTestContext('enf-none-', seedWith());
    const res = await request(ctx.app).get('/api/capability');
    const coding = res.body.roles.find((r) => r.role === 'coding');
    // The agent qualifies, so the ceiling has not been treated as exhausted.
    expect(coding.able.map((a) => a.agent)).toContain('a1');
  });

  test('an approved allocation reduces what is left', async () => {
    ctx = await createBackendTestContext('enf-alloc-', seedWith());
    const room = '!enf1:hq.example';
    await request(ctx.app).post('/api/whitelist').send({ projectRoomId: room });
    /*
     * A published offer with room to spare, so the CEILING is what binds. Without one the
     * request stops at `overOffer` first — an earlier version of this test asserted
     * `overCeiling` and failed on that, which is the routing order doing its job.
     */
    await request(ctx.app).put('/api/offers/coding')
      .send({ published: true, budgetCapPerEngagement: CEILING, rateCap: 100_000 });
    const created = await request(ctx.app).post('/api/engagements').send({
      project: 'p', projectRoomId: room, role: 'coding',
      requester: '@r:hq.example', requestedTokens: 900_000, ratePerDay: 1000,
      requestId: '$e1',
    });
    expect(created.status).toBe(200);
    await request(ctx.app).post(`/api/engagements/${created.body.engagement.id}/verdict`)
      .send({ approve: true, allocatedTokens: 900_000 });

    /*
     * A second request for more than the remaining 100k must fall back to approval, not be
     * rejected and not auto-join. The project did nothing wrong by asking.
     */
    const second = await request(ctx.app).post('/api/engagements').send({
      project: 'p2', projectRoomId: room, role: 'coding',
      requester: '@r:hq.example', requestedTokens: 500_000, ratePerDay: 1000,
      requestId: '$e2',
    });
    expect(second.status).toBe(200);
    expect(second.body.engagement.state).toBe('pending');
    expect(second.body.engagement.route).toBe('overCeiling');
  });

  test('an exhausted ceiling refuses auto-join but does not end a running engagement', async () => {
    /*
     * The policy, stated as a test. Terminating live work when a cap is reached turns a
     * budgeting decision into data loss; that stays an explicit human act with its own
     * confirmation, exactly as whitelist removal does.
     */
    ctx = await createBackendTestContext('enf-live-', seedWith());
    const room = '!enf2:hq.example';
    await request(ctx.app).post('/api/whitelist').send({ projectRoomId: room });
    await request(ctx.app).put('/api/offers/coding')
      .send({ published: true, budgetCapPerEngagement: CEILING, rateCap: 100_000 });

    const first = await request(ctx.app).post('/api/engagements').send({
      project: 'p', projectRoomId: room, role: 'coding',
      requester: '@r:hq.example', requestedTokens: CEILING, ratePerDay: 1000,
      requestId: '$live1',
    });
    await request(ctx.app).post(`/api/engagements/${first.body.engagement.id}/verdict`)
      .send({ approve: true, allocatedTokens: CEILING });

    // Ceiling now fully committed. A further request cannot auto-join.
    const next = await request(ctx.app).post('/api/engagements').send({
      project: 'p3', projectRoomId: room, role: 'coding',
      requester: '@r:hq.example', requestedTokens: 1000, ratePerDay: 100,
      requestId: '$live2',
    });
    expect(next.body.engagement.state).toBe('pending');

    // And the live one is untouched.
    const live = await request(ctx.app).get('/api/engagements');
    const still = live.body.engagements.find((e) => e.id === first.body.engagement.id);
    expect(still.state).toBe('active');
  });

  test('every ceiling still reports itself unenforced where enforcement is not absolute', async () => {
    /*
     * Admission control exists now, but nothing STOPS an agent mid-task, so a ceiling is
     * still not a guard rail in the sense an operator might assume. The surfaces keep
     * saying so — REQ-CONTRIBUTION-CONSOLE-UNENFORCED.
     */
    /*
     * Created through the API, not seeded: `enforced` is stamped by normalizeCeiling on
     * write, so a raw fixture never carries it. Asserting against seeded data would have
     * tested the fixture rather than the product — the first version of this test did
     * exactly that and failed with `expected undefined to be false`.
     */
    ctx = await createBackendTestContext('enf-declared-', { agents: seedWith().agents });
    const made = await request(ctx.app).post('/api/framework-presets').send({
      name: 'p', framework: 'claude', model: 'claude-opus-5',
      ceiling: { tokens: CEILING, period: 'monthly' },
    });
    expect(made.status).toBe(200);
    await meterOnce(ctx);
    expect(made.body.preset.ceiling.enforced).toBe(false);
  });

  test('an agent with no ceiling has unknown headroom, and does not auto-join', async () => {
    /*
     * The rule ADR-013 set and this must not weaken: a null ceiling is "not declared", not
     * "unlimited". Auto-joining against an unknown limit is how a contributor loses track of
     * what they lent.
     */
    ctx = await createBackendTestContext('enf-noceiling-', {
      agents: {
        a1: {
          name: 'a1', type: 'claude', server: 'local', tmux: null, online: true,
          manualDown: false,
          runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
        },
      },
    });
    const room = '!enf3:hq.example';
    await request(ctx.app).post('/api/whitelist').send({ projectRoomId: room });
    await request(ctx.app).put('/api/offers/coding')
      .send({ published: true, budgetCapPerEngagement: 999_999, rateCap: 100_000 });
    const res = await request(ctx.app).post('/api/engagements').send({
      project: 'p', projectRoomId: room, role: 'coding',
      requester: '@r:hq.example', requestedTokens: 10, ratePerDay: 1,
      requestId: '$nc1',
    });
    expect(res.body.engagement.state).toBe('pending');
    expect(res.body.engagement.route).toBe('overCeiling');
  });
});
