/*
 * The invitation endpoints, and the split of authority between them.
 *
 * ADR-014's amendment puts two different principals on two different verbs, and that split is the
 * whole security content of this feature:
 *
 *   the BRIDGE reports (bridge secret) — it is the only thing that sees Matrix state
 *   the OPERATOR decides (bearer) — accepting spends their tokens, so it is their call
 *
 * A caller who could do both could invite itself into the contributor's fleet. So the tests below
 * are mostly about which credential opens which verb, and about the one thing the backend must
 * NOT claim: that the agent has joined. Only the bridge can join a room, mark it trusted, and
 * write the ownership binding — the backend records the answer and broadcasts it, and saying
 * anything stronger would recreate the "looks accepted, works for nothing" state this replaces.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!proj7Kq2:their-server.example';
const INVITER = '@admin:their-server.example';
const SECRET = 'test-bridge-secret';

const seed = (extra = {}) => ({
  agents: {
    'lend-opus-01': {
      name: 'lend-opus-01', type: 'claude', server: 'local', tmux: null, online: true,
      manualDown: false,
      runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
    },
  },
  env: { MATRIX_BRIDGE_SECRET: SECRET, ...extra },
});

const report = (ctx, body) => request(ctx.app)
  .put('/api/matrix/pending-invites')
  .set('X-Bridge-Secret', SECRET)
  .send({ project_room_id: ROOM, agent: 'lend-opus-01', inviter: INVITER, ...body });

const listInvites = (ctx, state) => request(ctx.app)
  .get(`/api/matrix/pending-invites${state ? `?state=${state}` : ''}`);

const decide = (ctx, accept, over = {}) => request(ctx.app)
  .post('/api/matrix/pending-invites/decide')
  .send({ projectRoomId: ROOM, agent: 'lend-opus-01', accept, ...over });

describe('the bridge reports, the operator reads', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('a reported invitation appears for the operator with its derived server', async () => {
    ctx = await createBackendTestContext('inv-report-', seed());
    expect((await report(ctx)).status).toBe(200);

    const res = await listInvites(ctx);
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0]).toMatchObject({
      projectRoomId: ROOM,
      agent: 'lend-opus-01',
      inviter: INVITER,
      // Read off the room id, not accepted from the reporter.
      projectServer: 'their-server.example',
      state: 'pending',
    });
    expect(res.body.pending).toBe(1);
  });

  test('reporting REQUIRES the bridge secret', async () => {
    /*
     * Without this, anything that can reach the backend could manufacture an invitation and put
     * an unsolicited project in front of the contributor to accept.
     */
    ctx = await createBackendTestContext('inv-secret-', seed());
    const res = await request(ctx.app)
      .put('/api/matrix/pending-invites')
      .send({ project_room_id: ROOM, agent: 'lend-opus-01', inviter: INVITER });
    expect(res.status).toBe(403);
    expect((await listInvites(ctx)).body.invites).toEqual([]);
  });

  test('a malformed report is refused with a reason, not stored', async () => {
    ctx = await createBackendTestContext('inv-bad-', seed());
    const res = await report(ctx, { project_room_id: 'their-server.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Matrix room id/);
    expect((await listInvites(ctx)).body.invites).toEqual([]);
  });

  test('the same invitation reported repeatedly stays one row', async () => {
    // The bridge polls, so this is the normal case rather than an edge one.
    ctx = await createBackendTestContext('inv-idem-', seed());
    await report(ctx);
    await report(ctx);
    await report(ctx);
    expect((await listInvites(ctx)).body.invites).toHaveLength(1);
  });
});

describe('the operator decides', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('accepting records the answer and says QUEUED, never joined', async () => {
    /*
     * The backend cannot join a Matrix room. Reporting success as though the agent were in the
     * project would be the same class of defect as an approval that allocated budget and silently
     * failed to attach the agent — so the response says the decision was recorded and queued.
     */
    ctx = await createBackendTestContext('inv-accept-', seed());
    await report(ctx);
    const res = await decide(ctx, true);
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.invite.state).toBe('accepted');
    expect(JSON.stringify(res.body)).not.toMatch(/joined/i);
  });

  test('an accepted or declined invitation leaves the pending list', async () => {
    ctx = await createBackendTestContext('inv-leaves-', seed());
    await report(ctx);
    await decide(ctx, false);
    expect((await listInvites(ctx)).body.invites).toEqual([]);
    // But the answer is still on record, so the poll cannot resurrect it.
    const all = await listInvites(ctx, 'all');
    expect(all.body.invites[0].state).toBe('declined');
  });

  test('deciding twice is a 409', async () => {
    ctx = await createBackendTestContext('inv-twice-', seed());
    await report(ctx);
    expect((await decide(ctx, true)).status).toBe(200);
    const second = await decide(ctx, false);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already accepted/);
  });

  test('deciding an invitation nobody reported is a 404', async () => {
    // A decision cannot conjure the invitation it decides.
    ctx = await createBackendTestContext('inv-none-', seed());
    expect((await decide(ctx, true)).status).toBe(404);
  });

  test('a decision needs both the room and the agent', async () => {
    ctx = await createBackendTestContext('inv-args-', seed());
    await report(ctx);
    expect((await decide(ctx, true, { agent: undefined })).status).toBe(400);
    expect((await decide(ctx, true, { projectRoomId: undefined })).status).toBe(400);
    // Still pending, so a malformed decision has not consumed it.
    expect((await listInvites(ctx)).body.invites).toHaveLength(1);
  });

  test('the BRIDGE SECRET alone cannot decide', async () => {
    /*
     * The load-bearing half of the split. The bridge reports what Matrix says; it must not be
     * able to answer on the contributor's behalf, or a compromised bridge could accept every
     * project that invites it and spend the contributor's capacity.
     */
    ctx = await createBackendTestContext('inv-scope-', seed({ API_TOKEN: 'operator-token' }));
    await request(ctx.app).put('/api/matrix/pending-invites')
      .set('X-Bridge-Secret', SECRET)
      .send({ project_room_id: ROOM, agent: 'lend-opus-01', inviter: INVITER });

    const bridgeTried = await request(ctx.app)
      .post('/api/matrix/pending-invites/decide')
      .set('X-Bridge-Secret', SECRET)
      .send({ projectRoomId: ROOM, agent: 'lend-opus-01', accept: true });
    expect(bridgeTried.status).toBe(401);

    // The operator's own credential works.
    const operator = await request(ctx.app)
      .post('/api/matrix/pending-invites/decide')
      .set('Authorization', 'Bearer operator-token')
      .send({ projectRoomId: ROOM, agent: 'lend-opus-01', accept: true });
    expect(operator.status).toBe(200);
  });

  test('reading the list needs the operator credential too', async () => {
    // The list names projects and the humans who run them; it is not public.
    ctx = await createBackendTestContext('inv-read-scope-', seed({ API_TOKEN: 'operator-token' }));
    expect((await request(ctx.app).get('/api/matrix/pending-invites')).status).toBe(401);
    expect((await request(ctx.app).get('/api/matrix/pending-invites')
      .set('Authorization', 'Bearer operator-token')).status).toBe(200);
  });
});
