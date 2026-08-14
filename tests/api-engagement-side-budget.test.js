/*
 * A BORROWER'S ALLOCATION IS CHECKED WHERE IT IS ACTUALLY COMMITTED.
 *
 * ADR-016 decision 6 says budget is admission control. Its first build put the check on
 * `POST /api/dispatch` Phase 4, and that was the wrong place twice over: ADR-013 decision 8 withdraws
 * `/api/dispatch` "and any successor router-facing assignment path", and the route has no product
 * caller — so the gate guarded a road nobody drives. ADR-016's own decision TEXT says an agent instance
 * is minted "on acceptance"; only its status rows pointed at dispatch.
 *
 * There are exactly two places a side's allocation gets committed, and both are here:
 *
 *   1. `POST /api/engagements` — a whitelisted project with a published offer AUTO-JOINS. The
 *      engagement is born `active` with `allocatedTokens = requestedTokens`, and no operator ever sees
 *      it. This is the path the dispatch gate could not cover at all.
 *   2. `POST /api/engagements/:id/verdict` — the deliberate approval, which may allocate MORE than was
 *      requested, and happens at a later moment when the side's remaining may have fallen.
 *
 * `committedForProjectSide` sums only ACTIVE engagements, so the state transition IS the accounting.
 * There is no second figure that can disagree with the state it came from — which is why these tests
 * assert the budget read after each transition rather than a counter.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SERVER = 'palpo.test';
const ROOM = `!proj:${SERVER}`;
/* A room on a server with NO side record, for the limitation test. */
const FOREIGN_ROOM = '!elsewhere:other.example';
const CEILING = 10_000_000;

let context = null;
afterEach(async () => { context?.cleanup(); context = null; });

/**
 * An agent with a real ceiling and a tier, because both gates below sit downstream of checks that
 * would otherwise fire first: `agentForRole` needs a qualifying model, and `decide()` refuses with
 * `no_ceiling` before it ever looks at a side. A generous ceiling keeps the AGENT's headroom out of
 * the way so that what these tests measure is the SIDE's allocation.
 */
async function boot(env = {}) {
  context = await createBackendTestContext('engagement-side-budget-', {
    agents: {
      a1: {
        name: 'a1', type: 'claude', kind: 'agent', server: 'local', online: true, presetId: 'p1',
        runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
      },
    },
    frameworkPresets: [{
      id: 'p1', name: 'p', framework: 'claude', model: 'claude-opus-5',
      ceiling: { tokens: CEILING, period: 'monthly' },
    }],
    env,
  });
  return context.app;
}

/** Configure the side, and optionally allocate. Omitting `tokens` leaves it UNALLOCATED. */
async function side(app, tokens) {
  await request(app).post('/api/project-sides')
    .send({ server_name: SERVER, api_base_url: 'http://127.0.0.1:8008' });
  if (tokens !== undefined) {
    await request(app).put(`/api/project-sides/${SERVER}/allocation`)
      .send({ allocated_tokens: tokens });
  }
}

/**
 * Whitelist plus a published offer with room to spare, which is what makes a request AUTO-JOIN. Both
 * are needed: `routeRequest` returns `notWhitelisted` without the first and `overOffer` without the
 * second, and either would make an auto-join test pass for the wrong reason.
 */
async function offerAutoJoin(app, room = ROOM) {
  await request(app).post('/api/whitelist').send({ projectRoomId: room });
  await request(app).put('/api/offers/coding')
    .send({ published: true, budgetCapPerEngagement: CEILING, rateCap: 100_000 });
}

let seq = 0;
const ask = (app, { tokens, room = ROOM }) => request(app).post('/api/engagements').send({
  project: 'p', projectRoomId: room, role: 'coding', requester: '@r:palpo.test',
  requestedTokens: tokens, ratePerDay: 1000, requestId: `$ask-${seq += 1}`,
});

const budgetOf = async (app) => (await request(app).get(`/api/project-sides/${SERVER}/budget`)).body;
const listEngagements = async (app) => (await request(app).get('/api/engagements')).body.engagements;

describe('POST /api/engagements — the side is charged before the record exists', () => {
  test('AUTO-JOIN over the allocation is refused, and nothing is created', async () => {
    /*
     * The hole the move closes. An auto-join never passes through the verdict route, so a gate only
     * there would let a whitelisted project commit whatever its offer allowed against a side that
     * could not afford a token of it.
     */
    const app = await boot();
    await side(app, 100_000);
    await offerAutoJoin(app);

    const r = await ask(app, { tokens: 250_000 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      status: 'refused',
      reason: 'over_allocation',
      sideId: SERVER,
      allocatedTokens: 100_000,
      committedTokens: 0,
      remainingTokens: 100_000,
      requestedTokens: 250_000,
    });
    expect(r.body.error).toMatch(/raise the allocation/);
    // Not created, not queued: the record would be a commitment the side cannot honour.
    expect(await listEngagements(app)).toEqual([]);
  });

  test('within the allocation it auto-joins, and the side shows the commitment', async () => {
    /*
     * The other direction, without which the test above would also pass if engagements had simply
     * stopped working. The budget read is the point: `committed` is derived from the ACTIVE state, so
     * the transition and the accounting cannot disagree.
     */
    const app = await boot();
    await side(app, 1_000_000);
    await offerAutoJoin(app);

    const r = await ask(app, { tokens: 250_000 });
    expect(r.status).toBe(200);
    expect(r.body.engagement).toMatchObject({ state: 'active', allocatedTokens: 250_000 });
    expect(await budgetOf(app)).toMatchObject({
      allocated: 1_000_000, committed: 250_000, remaining: 750_000,
    });
  });

  test('the SECOND auto-join sees what the first committed', async () => {
    /*
     * Two requests that each fit but together do not. Without this the gate could be reading the
     * allocation and ignoring the commitment — which is the failure mode a per-request check has.
     */
    const app = await boot();
    await side(app, 300_000);
    await offerAutoJoin(app);

    expect((await ask(app, { tokens: 200_000 })).status).toBe(200);
    const second = await ask(app, { tokens: 200_000 });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      reason: 'over_allocation', committedTokens: 200_000, remainingTokens: 100_000,
    });
  });

  test('UNALLOCATED IS NOT UNLIMITED: a configured side with no allocation refuses', async () => {
    const app = await boot();
    await side(app); // configured, never budgeted
    await offerAutoJoin(app);

    const r = await ask(app, { tokens: 1 });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('no_allocation');
    expect(r.body.error).toMatch(/set one before this engagement can draw on it/);
  });

  test('zero is a real allocation, and refuses rather than being read as unset', async () => {
    // An operator may want to close a side to new work without deactivating it.
    const app = await boot();
    await side(app, 0);
    await offerAutoJoin(app);

    const r = await ask(app, { tokens: 1 });
    expect(r.body.reason).toBe('over_allocation');
    expect(r.body.allocatedTokens).toBe(0);
  });

  test('THE LIMITATION, ASSERTED: a room on a server with no side record is not gated', async () => {
    /*
     * Stated as a decision rather than left as a gap. Serving an engagement does not need a side —
     * the agent already exists and is already reachable — so a room this deployment has not configured
     * is un-attributed, not unserviceable. Refusing here would refuse every binding that predates
     * project sides, which is all of them.
     *
     * The dispatch path is stricter (`requireSide: true`) for a reason that does not apply here: it
     * MINTS, and under decision 1 an identity comes from the side's credential.
     */
    const app = await boot();
    await side(app, 1); // a side exists for palpo.test, and this request is not on it
    await offerAutoJoin(app, FOREIGN_ROOM);

    const r = await ask(app, { tokens: 5_000_000, room: FOREIGN_ROOM });
    expect(r.status).toBe(200);
    expect(r.body.engagement.state).toBe('active');
    // And it did not draw on the side it does not belong to.
    expect(await budgetOf(app)).toMatchObject({ allocated: 1, committed: 0 });
  });

  test("one side's commitment does not reduce another's", async () => {
    const app = await boot();
    await side(app, 300_000);
    await offerAutoJoin(app);
    await offerAutoJoin(app, FOREIGN_ROOM);

    expect((await ask(app, { tokens: 5_000_000, room: FOREIGN_ROOM })).status).toBe(200);
    // The foreign engagement is active and large; the side is untouched by it.
    expect(await budgetOf(app)).toMatchObject({ committed: 0, remaining: 300_000 });
    expect((await ask(app, { tokens: 300_000 })).status).toBe(200);
  });
});

describe('POST /api/engagements/:id/verdict — the other admission point, and the one that commits', () => {
  /** A PENDING engagement on the side: not whitelisted, so it waits for a decision. */
  async function pending(app, tokens) {
    const r = await request(app).post('/api/engagements').send({
      project: 'p', projectRoomId: ROOM, role: 'coding', requester: '@r:palpo.test',
      requestedTokens: tokens, ratePerDay: 1000, requestId: `$pend-${seq += 1}`,
    });
    expect(r.status).toBe(200);
    expect(r.body.engagement.state).toBe('pending');
    return r.body.engagement.id;
  }

  test('an approval that allocates MORE than was asked is checked against the side', async () => {
    /*
     * Why the request-time check is not sufficient on its own. `decide()` takes
     * `allocatedTokens ?? requestedTokens`, so the amount finally committed is the operator's, not the
     * borrower's — a request that passed at 100k can be approved at 400k.
     */
    const app = await boot();
    await side(app, 200_000);
    const id = await pending(app, 100_000);

    const over = await request(app).post(`/api/engagements/${id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      reason: 'over_allocation', engagementId: id, requestedTokens: 400_000, remainingTokens: 200_000,
    });
    // Still pending: refusing an approval must leave the decision open, not end the engagement.
    expect((await listEngagements(app)).find((e) => e.id === id).state).toBe('pending');

    const ok = await request(app).post(`/api/engagements/${id}/verdict`)
      .send({ approve: true, allocatedTokens: 150_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.engagement).toMatchObject({ state: 'active', allocatedTokens: 150_000 });
  });

  test("the side's remaining is read at the VERDICT, not remembered from the request", async () => {
    /*
     * Two pending requests that each fit at the time they were made. Approving the first commits, and
     * the second must be measured against what is left NOW. A gate that trusted the request-time check
     * would approve both and overrun the allocation with no refusal anywhere.
     */
    const app = await boot();
    await side(app, 300_000);
    const first = await pending(app, 200_000);
    const second = await pending(app, 200_000);

    expect((await request(app).post(`/api/engagements/${first}/verdict`).send({ approve: true })).status).toBe(200);
    const r = await request(app).post(`/api/engagements/${second}/verdict`).send({ approve: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'over_allocation', committedTokens: 200_000, remainingTokens: 100_000 });
  });

  test('a REJECTION is never refused for budget, on the very side that refuses approval', async () => {
    /*
     * A rejection commits nothing and releases nothing. Gating it would trap the engagement in
     * `pending` with no way out — the operator could neither approve it nor say no.
     *
     * The allocation is dropped to zero AFTER the request, which is also the only way to reach this
     * state through the API: the request-time gate refuses to create anything on an unallocated side,
     * so "pending on a side that cannot afford it" can only happen by the allocation moving. Both
     * verdicts are exercised on the same engagement, so the pass is not "budget stopped being checked".
     */
    const app = await boot();
    await side(app, 100_000);
    const id = await pending(app, 100_000);
    await request(app).put(`/api/project-sides/${SERVER}/allocation`).send({ allocated_tokens: 0 });

    const refused = await request(app).post(`/api/engagements/${id}/verdict`).send({ approve: true });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('over_allocation');

    const r = await request(app).post(`/api/engagements/${id}/verdict`)
      .send({ approve: false, reason: 'not now' });
    expect(r.status).toBe(200);
    expect(r.body.engagement).toMatchObject({ state: 'ended', endedReason: 'not now' });
  });

  test('a verdict on an unknown engagement still answers 404, not a budget refusal', async () => {
    /*
     * The gate needs the engagement to know which side to charge, so it must not answer FIRST for an
     * engagement that does not exist — that would replace "no such engagement" with a budget message
     * about a side the caller never named.
     */
    const app = await boot();
    await side(app, 1_000_000);
    const r = await request(app).post('/api/engagements/en_nope/verdict').send({ approve: true });
    expect(r.status).toBe(404);
  });
});
