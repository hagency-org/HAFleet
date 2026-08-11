/*
 * Approving an engagement must ATTACH the agent, or say it did not.
 *
 * REQ-CONTRIBUTION-CONSOLE-BIND. This is the requirement whose absence was measured rather
 * than argued: six active engagements existed against zero bindings on the live deployment,
 * because an approval allocated a number, wrote an audit line, and left the agent unattached
 * to the project room. The engagement said `active` and nothing about the world had changed.
 *
 * WHY IT NEEDED ITS OWN TEST FILE. `POST /api/engagements/:id/verdict` was already reached
 * by tests/enforcement-spend.test.js — which asserts state, route and remaining headroom, and
 * never looks at `binding`. So the endpoint was covered and this behaviour was not: the
 * binding could have been removed entirely without a single failure.
 *
 * THE HALF THAT MATTERS MORE IS THE FAILURE. A deployment with no owner configured cannot
 * bind, and the requirement says such a verdict must report the failure to the caller, record
 * it, and NOT report success. A silent partial success — allocation granted, attachment
 * skipped, `ok: true` — is the original defect wearing a hat, and it is what an
 * implementation drifts back into, because the allocation is the part that looks like the
 * point.
 *
 * `HAFLEET_OWNER_MXID` and `HAFLEET_OWNER_DM_ROOM` are read at module evaluation
 * (backend-v2.js:10764), so they are passed through `seed.env` — the harness sets them before
 * its cache-busted import for exactly this reason.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!bind1:hq.example';
/*
 * `GET /api/approval-bindings` is guarded by requireApprovalBridgeSecret and answers 503
 * without it — which is why this constant exists rather than the test reading the list
 * unauthenticated. Discovered by the 'a rejection binds nothing at all' case PASSING
 * against a 503: a refused request and an empty list are the same `undefined` once you
 * index into the body, so that assertion was vacuous. Every binding read below sends the
 * header and asserts status 200 first, so an absent binding is an absent binding.
 */
const BRIDGE_SECRET = 'test-bridge-secret';
const OWNER = '@owner:hq.example';
const OWNER_DM = '!ownerdm:hq.example';

const seed = (env) => ({
  agents: {
    a1: {
      name: 'a1', type: 'claude', server: 'local', tmux: null, online: true,
      manualDown: false, presetId: 'p1',
      runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
    },
  },
  frameworkPresets: [{
    id: 'p1', name: 'p', framework: 'claude', model: 'claude-opus-5',
    ceiling: { tokens: 5_000_000, period: 'monthly' },
  }],
  env: { MATRIX_BRIDGE_SECRET: BRIDGE_SECRET, ...(env ?? {}) },
});

/** The bindings for an agent, having proved the request was actually answered. */
async function bindingsFor(ctx, agent) {
  const res = await request(ctx.app).get('/api/approval-bindings')
    .set('X-Bridge-Secret', BRIDGE_SECRET);
  expect(res.status).toBe(200);
  const rows = Array.isArray(res.body) ? res.body : (res.body.bindings ?? []);
  return rows.filter((b) => (b.agent ?? b.agent_name) === agent);
}

/** A pending engagement to decide. */
async function pendingEngagement(ctx, requestId) {
  const created = await request(ctx.app).post('/api/engagements').send({
    project: 'acme/api', projectRoomId: ROOM, role: 'coding',
    requester: '@lin:hq.example', requestedTokens: 400_000, ratePerDay: 20_000,
    requestId,
  });
  expect(created.status).toBe(200);
  return created.body.engagement;
}

describe('an approval attaches the agent to the project room', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('with an owner configured, the verdict binds and says so', async () => {
    ctx = await createBackendTestContext('bind-ok-', seed({
      HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: OWNER_DM,
    }));
    const e = await pendingEngagement(ctx, '$bind-ok');
    const res = await request(ctx.app).post(`/api/engagements/${e.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });

    expect(res.status).toBe(200);
    expect(res.body.engagement.state).toBe('active');
    // The outcome rides back WITH the verdict: a caller must not have to make a second
    // request to learn whether the thing it approved actually happened.
    expect(res.body.binding.bound).toBe(true);
  });

  test('the binding names the agent, the project room and an owner', async () => {
    /*
     * All three, because a binding missing any one of them attaches nothing usable: the
     * agent says who serves, the room says where, and the owner is who the approval
     * machinery can reach. `upsertBinding` requires the owner pair, so a binding that
     * exists at all is one with an owner — asserted here rather than assumed.
     */
    ctx = await createBackendTestContext('bind-fields-', seed({
      HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: OWNER_DM,
    }));
    const e = await pendingEngagement(ctx, '$bind-fields');
    await request(ctx.app).post(`/api/engagements/${e.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });

    const [found] = await bindingsFor(ctx, 'a1');
    expect(found).toBeTruthy();
    expect(found.projectRoomId ?? found.project_room_id).toBe(ROOM);
    expect(found.ownerMxid ?? found.owner_mxid).toBe(OWNER);
  });
});

describe('a verdict that cannot resolve an owner does not report success', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('the failure reaches the caller instead of a bare ok', async () => {
    /*
     * No owner configured — the state of any deployment before the Matrix bridge has created
     * a first binding. The verdict must not come back looking like a complete success.
     */
    ctx = await createBackendTestContext('bind-noowner-', seed());
    const e = await pendingEngagement(ctx, '$bind-noowner');
    const res = await request(ctx.app).post(`/api/engagements/${e.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });

    expect(res.body.binding.bound).toBe(false);
    // Actionable, not merely negative: the operator is told which two settings to provide.
    expect(res.body.binding.error).toMatch(/HAFLEET_OWNER_MXID/);
  });

  test('the failure is RECORDED on the engagement, not only returned', async () => {
    /*
     * The clause that a return value alone cannot satisfy. Whoever reads the engagement list
     * later — the console, an audit, the next operator — was not present for the response, so
     * an unbound approval has to be visible in the record itself. Otherwise the only trace of
     * a partial success is an HTTP response nobody kept.
     */
    ctx = await createBackendTestContext('bind-recorded-', seed());
    const e = await pendingEngagement(ctx, '$bind-recorded');
    await request(ctx.app).post(`/api/engagements/${e.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });

    const list = await request(ctx.app).get('/api/engagements');
    const stored = list.body.engagements.find((x) => x.id === e.id);
    expect(JSON.stringify(stored)).toMatch(/owner/i);
  });

  test('a rejection binds nothing at all', async () => {
    /*
     * The bind belongs to APPROVAL, not to deciding. A rejection that attached an agent
     * would grant exactly the access the rejection was refusing.
     */
    ctx = await createBackendTestContext('bind-reject-', seed({
      HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: OWNER_DM,
    }));
    const e = await pendingEngagement(ctx, '$bind-reject');
    await request(ctx.app).post(`/api/engagements/${e.id}/verdict`)
      .send({ approve: false, reason: 'not now' });

    expect(await bindingsFor(ctx, 'a1')).toEqual([]);
  });

  test('rejecting a second request does not detach the FIRST one that was approved', async () => {
    /*
     * The rejection path calls `unbindEngagement`, whose job is to remove what that
     * engagement attached — "anything already attached must go". Left unqualified that is
     * dangerous: a project asking twice and being refused once must not lose the access it
     * was already granted, or a refusal becomes a revocation of unrelated work.
     *
     * Written after the previous case turned out not to be load-bearing, and it FOUND THE
     * BUG on its first run. Rejecting without ever approving cannot distinguish "the
     * rejection removed nothing" from "nothing was there to remove", so the weaker version
     * passed against a real defect: `unbindEngagement` removed the `(agent, projectRoomId)`
     * binding unconditionally, and one binding serves every engagement between that agent
     * and that room. Refusing a second request therefore detached an engagement that was
     * still active.
     *
     * The live store holds six concurrent active engagements for one such pair, so the
     * consequence was one refusal cutting the access six approvals had granted.
     */
    ctx = await createBackendTestContext('bind-keep-', seed({
      HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: OWNER_DM,
    }));
    const first = await pendingEngagement(ctx, '$bind-keep-1');
    await request(ctx.app).post(`/api/engagements/${first.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });
    expect(await bindingsFor(ctx, 'a1')).toHaveLength(1);

    const second = await pendingEngagement(ctx, '$bind-keep-2');
    await request(ctx.app).post(`/api/engagements/${second.id}/verdict`)
      .send({ approve: false, reason: 'not now' });

    // Still exactly one, and still the same room.
    const after = await bindingsFor(ctx, 'a1');
    expect(after).toHaveLength(1);
    expect(after[0].projectRoomId ?? after[0].project_room_id).toBe(ROOM);
  });

  test('the binding IS released once the last live engagement ends', async () => {
    /*
     * The other side of the same rule, and the reason the fix is "last one out" rather than
     * "never unbind": standing reachability that outlives every justification for it is the
     * security problem a contributor lending their own machines actually has. So the
     * binding must survive a sibling ending and must NOT survive the last one.
     */
    ctx = await createBackendTestContext('bind-last-', seed({
      HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: OWNER_DM,
    }));
    const only = await pendingEngagement(ctx, '$bind-last-1');
    await request(ctx.app).post(`/api/engagements/${only.id}/verdict`)
      .send({ approve: true, allocatedTokens: 400_000 });
    expect(await bindingsFor(ctx, 'a1')).toHaveLength(1);

    const revoked = await request(ctx.app).post(`/api/engagements/${only.id}/revoke`)
      .send({ reason: 'done' });
    expect(revoked.status).toBe(200);
    expect(await bindingsFor(ctx, 'a1')).toEqual([]);
  });
});
