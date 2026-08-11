/*
 * `GET /api/offer-book` — the read a project may make before it asks.
 *
 * The gap the 2026-08-11 transparency ruling opened. Once the serving agent and its model are
 * disclosed, a borrower reasonably wants to know what is on offer BEFORE committing to a
 * request — and the only inbound verb was `!request` itself, so the way to discover the caps
 * was to have a request refused.
 *
 * WHY A NEW PROJECTION RATHER THAN OPENING THE EXISTING THREE. `/api/capability`,
 * `/api/offers` and `/api/whitelist` already answer adjacent questions, and all three are the
 * PROVIDER's views: every role whether offered or not, every agent including ones that serve
 * nothing, and the whitelist in full. Handing those to a project would disclose the
 * provider's whole posture, which is a different thing from disclosing what serves a role.
 * Each of the three narrowings below is therefore a decision, and each is asserted.
 *
 * REQ-CONTRIBUTION-CONSOLE-OFFER-BOOK. Written after the endpoint rather than before it: the
 * capability did not exist until the transparency ruling made the answer worth giving, so the
 * statement records a decision taken here rather than one handed down.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!book:hq.example';
const OTHER = '!other:hq.example';

const seed = {
  agents: {
    'claude-agent': {
      name: 'claude-agent', type: 'claude', server: 'local', tmux: null, online: true,
      manualDown: false,
      runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5', reasoning: 'high' } },
      workspacePath: '/Users/someone/private/ws',
    },
  },
};

const publish = (ctx, role, body) => request(ctx.app).put(`/api/offers/${role}`).send(body);
const book = (ctx, room) => request(ctx.app)
  .get(`/api/offer-book${room ? `?projectRoomId=${encodeURIComponent(room)}` : ''}`);

describe('only what the provider published', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('an unpublished offer does not appear at all', async () => {
    /*
     * REQ-CONTRIBUTION-CONSOLE-ROUTE already says an unpublished offer is not on offer.
     * Listing it here would advertise capacity the provider deliberately did not advertise —
     * and a project that saw it would ask for something that cannot auto-join.
     */
    ctx = await createBackendTestContext('book-unpub-', seed);
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    await publish(ctx, 'review', { published: false, budgetCapPerEngagement: 999_999, rateCap: 99_999 });

    const res = await book(ctx, ROOM);
    expect(res.status).toBe(200);
    const roles = res.body.roles.map((r) => r.role);
    expect(roles).toContain('coding');
    expect(roles).not.toContain('review');
  });

  test('a role with no offer is omitted, not returned as nulls', async () => {
    /*
     * The opposite choice from `/api/offers`, which deliberately returns every role so the
     * provider can tell "configured but unadvertised" from "no such role". A project cannot
     * act on that difference, and a list of mostly-null rows reads as a broken endpoint.
     */
    ctx = await createBackendTestContext('book-omit-', seed);
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    const res = await book(ctx, ROOM);
    expect(res.body.roles).toHaveLength(1);
  });

  test('the published caps are reported, because they are the promise', async () => {
    ctx = await createBackendTestContext('book-caps-', seed);
    await publish(ctx, 'coding', {
      published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000, count: 2,
    });
    const [row] = (await book(ctx, ROOM)).body.roles;
    expect(row).toMatchObject({
      role: 'coding', budgetCapPerEngagement: 400_000, rateCap: 20_000, count: 2, runningNow: 0,
    });
  });
});

describe('what serves a role, and nothing about the deployment', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('the serving framework, model, reasoning level and tier are disclosed', async () => {
    ctx = await createBackendTestContext('book-serving-', seed);
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    const [row] = (await book(ctx, ROOM)).body.roles;
    expect(row.serving).toMatchObject({
      agent: 'claude-agent', framework: 'claude', model: 'claude-opus-5', reasoning: 'high',
    });
    expect(row.serving.tier).toBeTruthy();
  });

  test('the provider deployment is not disclosed with it', async () => {
    // Same boundary as the engagement response: capability yes, deployment no.
    ctx = await createBackendTestContext('book-private-', seed);
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    const body = JSON.stringify((await book(ctx, ROOM)).body);
    expect(body).not.toContain('private/ws');
    expect(body).not.toContain('workspacePath');
  });

  test('no ceiling is published, because it is state rather than a promise', async () => {
    /*
     * Deliberate. The offer caps are what the provider committed to; remaining ceiling moves
     * with every other project's activity, so a number here would be stale on arrival — and
     * a request over it still falls back to approval with `overCeiling` as the stated
     * reason, so the fact is disclosed when it becomes relevant.
     */
    ctx = await createBackendTestContext('book-noceiling-', seed);
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    const body = JSON.stringify((await book(ctx, ROOM)).body);
    expect(body).not.toMatch(/remaining|ceiling|quota|seat/i);
  });

  test('a published role nothing can serve says so rather than being dropped', async () => {
    /*
     * Worth stating rather than omitting in both directions: the project can stop waiting
     * and ask for something else, and the contributor probably wants to know their offer is
     * unfillable.
     */
    ctx = await createBackendTestContext('book-unfillable-', { agents: {} });
    await publish(ctx, 'coding', { published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });
    const [row] = (await book(ctx, ROOM)).body.roles;
    expect(row.role).toBe('coding');
    expect(row.serving).toBeNull();
  });
});

describe('this room\'s own trust state, never the list', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('a whitelisted room is told it will auto-join', async () => {
    ctx = await createBackendTestContext('book-wl-', seed);
    await request(ctx.app).post('/api/whitelist').send({ projectRoomId: ROOM });
    expect((await book(ctx, ROOM)).body.whitelisted).toBe(true);
  });

  test('a room that is not whitelisted is told that, and NOT who else is', async () => {
    /*
     * The line: whether YOUR request auto-joins is the most actionable fact for you and
     * yours alone. Who else the contributor trusts is a list of other people's projects.
     */
    ctx = await createBackendTestContext('book-wl-other-', seed);
    await request(ctx.app).post('/api/whitelist').send({ projectRoomId: OTHER });
    const res = await book(ctx, ROOM);
    expect(res.body.whitelisted).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(OTHER);
  });

  test('with no room named the answer is null, not false', async () => {
    /*
     * `false` would assert that the caller's room is not trusted — a claim about a room
     * nobody identified. The distinction matters because the bot renders false as "this room
     * is not whitelisted", which would be a statement it cannot support.
     */
    ctx = await createBackendTestContext('book-noroom-', seed);
    const res = await book(ctx, null);
    expect(res.body.whitelisted).toBeNull();
    expect(res.body.projectRoomId).toBeNull();
  });
});

describe('the submit-only credential may read it', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('the requester token is accepted, so a project can look before it asks', async () => {
    /*
     * The point of the endpoint existing separately: it is readable with the same narrow
     * credential that may already submit, so asking to look does not require the operator
     * token. REQ-CONTRIBUTION-CONSOLE-SUBMIT-SCOPE stays intact — reading an offer book is
     * not deciding, widening or editing.
     */
    ctx = await createBackendTestContext('book-token-', {
      ...seed,
      env: { API_TOKEN: 'operator-token', HAFLEET_REQUESTER_TOKEN: 'requester-token' },
    });
    await request(ctx.app).put('/api/offers/coding')
      .set('Authorization', 'Bearer operator-token')
      .send({ published: true, budgetCapPerEngagement: 400_000, rateCap: 20_000 });

    const res = await request(ctx.app).get('/api/offer-book')
      .set('Authorization', 'Bearer requester-token');
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r) => r.role)).toContain('coding');
  });

  test('and it still cannot widen an offer or edit the whitelist', async () => {
    // The scope is unchanged by adding a read: reading is not deciding.
    ctx = await createBackendTestContext('book-token-scope-', {
      ...seed,
      env: { API_TOKEN: 'operator-token', HAFLEET_REQUESTER_TOKEN: 'requester-token' },
    });
    const widen = await request(ctx.app).put('/api/offers/coding')
      .set('Authorization', 'Bearer requester-token')
      .send({ published: true, budgetCapPerEngagement: 9_999_999 });
    expect(widen.status).toBe(401);

    const trust = await request(ctx.app).post('/api/whitelist')
      .set('Authorization', 'Bearer requester-token')
      .send({ projectRoomId: ROOM });
    expect(trust.status).toBe(401);
  });
});
