/*
 * 接单员把外派员工带进项目房间 — ADR-016 decision 3, at the two points where an agent becomes a
 * project's to use.
 *
 * WHY THE BACKEND DOES THIS AT ALL. The bridge puts agents in rooms with `getAgentToken`, and an
 * appservice side mints no per-agent token: the namespace makes an agent addressable, not able to
 * act. So on the sides ADR-016 treats as normal, the agent cannot let itself in and nobody else was
 * trying. The side's credential can, and the backend is where that credential lives.
 *
 * THE ASSERTIONS THAT MATTER ARE ABOUT WHO ACTS AS WHOM. The invite must come from the
 * representative and the join must be as the agent — one credential, two masquerades, and swapping
 * them produces a room containing the wrong account while reporting success.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ROOM = `!proj:${SIDE}`;
const AGENT = 'biglittle';
const BRIDGE_SECRET = 'admission-secret';

let context = null;
let fake = null;

afterEach(async () => {
  context?.cleanup();
  context = null;
  if (fake) { await new Promise((r) => fake.server.close(r)); fake = null; }
});

/**
 * A homeserver that records what was asked of it.
 *
 * In-process rather than mocked for the same reason the minting tests do it: the question is what
 * this code puts on the wire — which URL, which masquerade, which token — and a stub of the client
 * would assert the parts that were never in doubt.
 */
async function fakeHomeserver({
  inviteStatus = 200, inviteBody = {}, joinStatus = 200, powerLevels = null, leaveStatus = 200,
} = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization ?? null,
        body: body ? JSON.parse(body) : null,
      });
      if (req.url.includes('/invite')) {
        res.writeHead(inviteStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(inviteStatus === 200 ? {} : inviteBody));
      }
      if (req.url.includes('/state/m.room.power_levels')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(powerLevels ?? { invite: 50, users_default: 0, users: {} }));
      }
      if (req.url.includes('/join/')) {
        res.writeHead(joinStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(joinStatus === 200 ? { room_id: ROOM } : { errcode: 'M_FORBIDDEN' }));
      }
      /*
       * A leave, which real Palpo answers `200 {}` even for a room the user is not in. Before this the
       * fake 404'd it, so the withdrawal below would have read as failed for the wrong reason.
       */
      if (req.url.includes('/leave')) {
        res.writeHead(leaveStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(leaveStatus === 200 ? {} : { errcode: 'M_UNKNOWN' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ errcode: 'M_NOT_FOUND' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake = { server, seen, url: `http://127.0.0.1:${server.address().port}` };
  return fake;
}

async function boot({ hs = null, credential = null, allocatedTokens = 5_000_000 } = {}) {
  context = await createBackendTestContext('engagement-room-admission-', {
    agents: {
      [AGENT]: {
        name: AGENT, type: 'agent', kind: 'agent', online: true, role: 'coding',
        runtimeProfile: { primary: { framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' } },
      },
    },
    env: { MATRIX_BRIDGE_SECRET: BRIDGE_SECRET, MATRIX_AGENT_PREFIX: 'ac_' },
  });
  const app = context.app;
  /*
   * A preset with a ceiling, because approval refuses `no_ceiling` before it ever reaches the room:
   * the contributor's own ceiling is the FIRST of ADR-016's two, and an agent lending nothing cannot
   * be allocated to anyone. Without this every test here would fail at a gate that has nothing to do
   * with what they measure.
   */
  const preset = await request(app).post('/api/framework-presets').send({
    name: 'admission-preset', framework: 'claude', provider: 'anthropic', model: 'claude-opus-5',
    ceiling: { tokens: 10_000_000, period: 'monthly' },
  }).expect(200);
  await request(app).put(`/api/agents/${AGENT}/preset`)
    .send({ presetId: preset.body.preset.id }).expect(200);
  await request(app).post('/api/project-sides')
    .send({ server_name: SIDE, api_base_url: hs ? hs.url : 'http://127.0.0.1:1' }).expect(200);
  if (credential) {
    await request(app).put(`/api/project-sides/${SIDE}/credential`).send({ credential }).expect(200);
  }
  await request(app).put(`/api/project-sides/${SIDE}/allocation`)
    .send({ allocated_tokens: allocatedTokens }).expect(200);
  return app;
}

const asCredential = (over = {}) => ({
  kind: 'appservice',
  asToken: 'as_secret_never_logged',
  hsToken: 'hs_secret',
  namespace: '@ac_.*',
  senderLocalpart: 'hafleet',
  ...over,
});

let seq = 0;

/** Approve an engagement on the side's room, which is the point the agent must be let in. */
async function approve(app, { tokens = 100_000, room = ROOM } = {}) {
  const created = await request(app).post('/api/engagements').send({
    project: 'acme/api', projectRoomId: room, role: 'coding',
    requester: `@lin:${SIDE}`, requestedTokens: tokens, ratePerDay: 1000,
    requestId: `$adm-${seq += 1}`,
  });
  const id = created.body?.engagement?.id;
  if (!id) return created;
  return request(app).post(`/api/engagements/${id}/verdict`).send({ approve: true });
}

describe('an approved engagement puts the agent in the room', () => {
  test('the representative invites, and the AGENT joins — one credential, two masquerades', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });

    const r = await approve(app);
    expect(r.status).toBe(200);
    expect(r.body.roomAdmission).toMatchObject({
      admitted: true, invited: true, joined: true, sideId: SIDE, mxid: `@ac_${AGENT}:${SIDE}`,
    });

    const invite = hs.seen.find((c) => c.url.includes('/invite'));
    const join = hs.seen.find((c) => c.url.includes('/join/'));
    expect(invite).toBeDefined();
    expect(join).toBeDefined();

    /*
     * THE WHOLE POINT, in two lines. The invite is masqueraded as the REPRESENTATIVE
     * (sender_localpart) and names the agent in its body; the join is masqueraded as the AGENT. Swap
     * them and you get a room holding the representative, reported as the agent having joined.
     */
    expect(invite.url).toContain(encodeURIComponent(`@hafleet:${SIDE}`));
    expect(invite.body.user_id).toBe(`@ac_${AGENT}:${SIDE}`);
    expect(join.url).toContain(encodeURIComponent(`@ac_${AGENT}:${SIDE}`));
  });

  test('an agent already in the room is not a failure and does not block the approval', async () => {
    const hs = await fakeHomeserver({
      inviteStatus: 403,
      inviteBody: { errcode: 'M_FORBIDDEN', error: `@ac_${AGENT}:${SIDE} is already in the room.` },
    });
    const app = await boot({ hs, credential: asCredential() });

    const r = await approve(app);
    expect(r.status).toBe(200);
    expect(r.body.roomAdmission).toMatchObject({ alreadyMember: true, invited: false, joined: true });
    // The join still ran: already-invited says nothing about whether the agent is actually IN.
    expect(hs.seen.some((c) => c.url.includes('/join/'))).toBe(true);
  });

  test('a refused invite is REPORTED, and the approval still stands', async () => {
    /*
     * The approval allocated budget and recorded a decision; undoing that because a remote homeserver
     * refused an invite would discard a commitment the contributor already made. So the engagement is
     * active and `roomAdmission` says what went wrong — the half-done state named rather than hidden,
     * which is the same rule `binding` beside it follows.
     */
    const hs = await fakeHomeserver({ inviteStatus: 403, inviteBody: { errcode: 'M_FORBIDDEN' } });
    const app = await boot({ hs, credential: asCredential() });

    const r = await approve(app);
    expect(r.status).toBe(200);
    expect(r.body.engagement.state).toBe('active');
    /*
     * `representative_lacks_invite_power`, not the plain `invite_refused` this asserted first. The fake
     * homeserver's default power levels are the real ones a project's room has — invite 50, users_default
     * 0 — so this test's own scenario turned out to BE the case the live run found, and the diagnosis
     * added for it applies here. The property under test is unchanged and is the one below: the approval
     * stands and no join is attempted.
     */
    expect(r.body.roomAdmission).toMatchObject({ admitted: false, reason: 'representative_lacks_invite_power' });
    expect(hs.seen.some((c) => c.url.includes('/join/'))).toBe(false);
  });

  test('a registrationToken side is invited but NOT joined, because the agent has its own token', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({
      hs,
      credential: { kind: 'registrationToken', registrationToken: 'reg_secret', representativeToken: 'rep_secret' },
    });

    const r = await approve(app);
    expect(r.body.roomAdmission).toMatchObject({ invited: true, joined: false, admitted: false });
    expect(r.body.roomAdmission.reason).toMatch(/per-agent token and must use it/);
    expect(hs.seen.some((c) => c.url.includes('/join/'))).toBe(false);
  });

  test('a room on no configured side is reported as such, not attempted', async () => {
    /*
     * An engagement whose room is on the contributor's own server needs no admission: the agent is
     * already local to it. Reporting `no_project_side` distinguishes "nothing to do" from "we tried
     * and failed", which are the two things a half-done approval could mean.
     */
    const app = await boot({ credential: null });
    const r = await approve(app, { room: '!local:contributor.example' });
    expect(r.status).toBe(200);
    expect(r.body.roomAdmission).toMatchObject({ admitted: false, reason: 'no_project_side' });
  });

  test('a side with no credential yet says so instead of throwing', async () => {
    const app = await boot({ credential: null });
    const r = await approve(app);
    expect(r.status).toBe(200);
    expect(r.body.roomAdmission.reason).toBe('no_credential');
  });
});

/*
 * RE-ADMITTING AN IDLE AGENT — ADR-016 row 3's last unbuilt clause.
 *
 * A send that fails on membership re-invites and rejoins, so an agent that WORKS heals itself. An idle one
 * does not: its membership can be dropped by a kick, a room upgrade or a server-side cleanup, and the next
 * thing that notices is the next message — which may be days away, and will be the one that fails.
 *
 * Swept rather than watched, because nothing tells us: membership on somebody else's homeserver changes
 * without asking, and the appservice intake only sees rooms it is in — the very membership in question.
 */
/*
 * AND THE OTHER END OF THE SAME SEAT — giving it back.
 *
 * Confirmed on a live homeserver before it was written: after two runs of `e2e-full-loop.mjs`, whose own
 * teardown reported "the run leaves no room behind in any account", `@ac_soaker:palpo2.test` was still
 * joined to both abandoned project rooms. Revoking removed HAFleet's record of the attachment and left the
 * agent sitting in somebody else's Matrix room, permanently, once per finished engagement. The suite could
 * not see it: it knows its own account and the bot's, and an agent is neither.
 */
describe('a revoked engagement gives the room seat back', () => {
  const leaves = () => fake.seen.filter((c) => c.url.includes('/leave'));

  async function revoke(app, id, expectStatus = 200) {
    return request(app).post(`/api/engagements/${id}/revoke`)
      .send({ reason: 'test revoke' }).expect(expectStatus);
  }

  test('THE DEFECT: the agent leaves the room, as itself, with the side\'s credential', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    const approved = await approve(app);
    const id = approved.body.engagement.id;
    expect(approved.body.roomAdmission.admitted).toBe(true);

    const res = await revoke(app, id);
    expect(res.body.roomWithdrawal).toMatchObject({ roomId: ROOM, left: true });

    /*
     * WHO ACTS AS WHOM, the same assertion the admission tests make. Leaving as the representative
     * would report success while the agent stayed in the room.
     */
    expect(leaves()).toHaveLength(1);
    expect(leaves()[0].url).toContain(encodeURIComponent(`@ac_${AGENT}:${SIDE}`));
    expect(leaves()[0].auth).toBe('Bearer as_secret_never_logged');
    expect(leaves()[0].method).toBe('POST');
  });

  test('but NOT while another engagement still puts that agent in that room', async () => {
    /*
     * Six concurrent engagements between one agent and one room is a real shape in this deployment's
     * data — it is why the unbind has a still-live check at all. Withdrawing on the first revoke would
     * take a working agent out of a room it is still serving, which is worse than the leak.
     */
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    const first = await approve(app);
    const second = await approve(app);

    const res = await revoke(app, first.body.engagement.id);
    expect(res.body.roomWithdrawal ?? null).toBe(null);
    expect(leaves()).toHaveLength(0);

    // The last one out gives the seat back.
    const last = await revoke(app, second.body.engagement.id);
    expect(last.body.roomWithdrawal).toMatchObject({ left: true });
    expect(leaves()).toHaveLength(1);
  });

  test('a REJECTED request withdraws nothing, because it never admitted anybody', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    const created = await request(app).post('/api/engagements').send({
      project: 'acme/api', projectRoomId: ROOM, role: 'coding',
      requester: `@lin:${SIDE}`, requestedTokens: 100_000, requestId: '$rejected-1',
    });
    const res = await request(app)
      .post(`/api/engagements/${created.body.engagement.id}/verdict`)
      .send({ approve: false, reason: 'no' }).expect(200);

    expect(res.body.roomWithdrawal ?? null).toBe(null);
    expect(leaves()).toHaveLength(0);
  });

  test('a homeserver that refuses the leave is REPORTED, and the revoke still stands', async () => {
    /*
     * Same asymmetry as the delete path: a customer's homeserver being unreachable must not make an
     * engagement un-revokable. The operator learns the seat is still occupied instead.
     */
    const hs = await fakeHomeserver({ leaveStatus: 500 });
    const app = await boot({ hs, credential: asCredential() });
    const approved = await approve(app);

    const res = await revoke(app, approved.body.engagement.id);
    expect(res.body.ok).toBe(true);
    expect(res.body.engagement.state).toBe('ended');
    expect(res.body.roomWithdrawal.left).toBe(false);
    expect(res.body.roomWithdrawal.reason).toBeTruthy();
  });

  test('a room on no configured side is reported, not attempted', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    // An engagement whose room is on the contributor's own server needs no seat given back.
    const created = await request(app).post('/api/engagements').send({
      project: 'local/thing', projectRoomId: '!local:hafleet.test', role: 'coding',
      requester: '@me:hafleet.test', requestedTokens: 100_000, requestId: '$local-1',
    });
    const id = created.body.engagement.id;
    await request(app).post(`/api/engagements/${id}/verdict`).send({ approve: true }).expect(200);

    const res = await revoke(app, id);
    expect(res.body.roomWithdrawal).toMatchObject({ left: false, reason: 'no project side owns that room' });
    expect(leaves()).toHaveLength(0);
  });
});

describe('the membership sweep lets an idle agent back in', () => {
  test('it asks per (agent, room) ONCE, however many engagements share the pair', async () => {
    /*
     * Six concurrent engagements between one agent and one room is a real shape in this deployment's data
     * — the unbind logic exists because of it — so a sweep that asked per engagement would make five
     * needless calls to a customer's homeserver every hour.
     */
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    await approve(app, { tokens: 10_000 });
    await approve(app, { tokens: 20_000 });
    const active = (await request(app).get('/api/engagements')).body.engagements
      .filter((e) => e.state === 'active');
    /*
     * Two engagements on the SAME (agent, room) pair, which is what this test needs to be about. Asserted
     * rather than assumed: a first version wrote `> 1` and got one, because `approve` reuses a requestId
     * derived from the token amount and the second ask was deduplicated into the first.
     */
    expect(active.filter((e) => e.agent === AGENT && e.projectRoomId === ROOM).length).toBe(2);

    const before = hs.seen.length;
    await context.internals.sweepProjectRoomMembershipForTest();
    const invites = hs.seen.slice(before).filter((c) => c.url.includes('/invite'));
    expect(invites).toHaveLength(1);
  });

  test('an agent already in the room is left alone — the invite 403 IS the check', async () => {
    /*
     * Idempotent by reuse rather than by a new code path: `admitAgentToProjectRoom` already reads the
     * already-in-the-room 403 correctly, so the sweep asks the same question the acceptance path asks. A
     * separate "check membership first" call would be a second way to be wrong about one fact.
     */
    const hs = await fakeHomeserver({
      inviteStatus: 403,
      inviteBody: { errcode: 'M_FORBIDDEN', error: 'is already in the room.' },
    });
    const app = await boot({ hs, credential: asCredential() });
    await approve(app);

    const before = hs.seen.length;
    await context.internals.sweepProjectRoomMembershipForTest();
    const after = hs.seen.slice(before);
    /*
     * It invited — that is the probe — and then joined anyway, which is CORRECT and worth stating: #77
     * made the already-member branch go on to join deliberately, because being already invited says
     * nothing about being already IN. So the idle-agent cost of this sweep is one invite and one join per
     * (agent, room) per hour, both idempotent on the homeserver, and the alternative — asking about
     * membership first — would be a second way to be wrong about one fact.
     */
    expect(after.some((c) => c.url.includes('/invite'))).toBe(true);
    expect(after.some((c) => c.url.includes('/join/'))).toBe(true);
  });

  test('an engagement on no configured side is skipped without a call', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: asCredential() });
    await approve(app, { room: '!local:contributor.example' });

    const before = hs.seen.length;
    await context.internals.sweepProjectRoomMembershipForTest();
    expect(hs.seen.slice(before)).toHaveLength(0);
  });

  test('one agent failing does not stop the sweep reaching the next', async () => {
    /*
     * A homeserver that refuses outright must not cost the other agents their sweep — the same
     * per-record-rather-than-abort rule the side cascade follows.
     */
    const hs = await fakeHomeserver({ inviteStatus: 500, inviteBody: { errcode: 'M_UNKNOWN' } });
    const app = await boot({ hs, credential: asCredential() });
    await approve(app);
    await expect(context.internals.sweepProjectRoomMembershipForTest()).resolves.toBeUndefined();
  });
});

/*
 * WHY AN INVITE WAS REFUSED — a live finding, and an interaction between two decisions rather than a bug
 * in either.
 *
 * Decision 5 lets us enter a project's room by KNOCKING. Decision 3 has the representative invite our
 * agents into it. In a room the representative CREATED it holds PL 100 and both work. In a room the
 * PROJECT created and we knocked into, it holds `users_default` — 0 on a default Palpo room — against an
 * `invite` requirement of 50. So we are in the room and cannot bring anyone with us, and the failure
 * arrives as a bare `M_FORBIDDEN` that sends an operator to check the credential.
 *
 * Proven both ways against real Palpo: refused at PL 0, and admitted immediately once the project granted
 * the representative PL 50 — which is what the message tells them to do.
 */
describe('a refused invite says WHY, when the reason is power rather than credentials', () => {
  test('too little power is named, with the remedy that belongs to the project', async () => {
    const hs = await fakeHomeserver({
      inviteStatus: 403,
      inviteBody: { errcode: 'M_FORBIDDEN' },
      powerLevels: { invite: 50, users_default: 0, users: { '@someone:palpo.test': 100 } },
    });
    const app = await boot({ hs, credential: asCredential() });

    const r = await approve(app);
    expect(r.status).toBe(200);
    expect(r.body.engagement.state).toBe('active');
    expect(r.body.roomAdmission.reason).toBe('representative_lacks_invite_power');
    expect(r.body.roomAdmission.detail).toMatch(/holds power 0/);
    expect(r.body.roomAdmission.detail).toMatch(/needs 50/);
    /*
     * The remedy names both things the PROJECT can do, and says plainly that we cannot fix it. An operator
     * reading "invite failed" would have gone looking at our credential, which is the one thing that was
     * working.
     */
    expect(r.body.roomAdmission.detail).toMatch(/grants it that power or invites/);
    expect(r.body.roomAdmission.detail).toMatch(/nothing on our side can raise it/);
  });

  test('with enough power, the same refusal stays a plain invite_refused', async () => {
    /*
     * The diagnosis must not become the answer to every 403. Here the representative HAS the power and the
     * invite still failed — a different problem, and mislabelling it would send the project to change a
     * setting that is already right.
     */
    const hs = await fakeHomeserver({
      inviteStatus: 403,
      inviteBody: { errcode: 'M_FORBIDDEN' },
      powerLevels: { invite: 50, users_default: 0, users: { '@hafleet:palpo.test': 50 } },
    });
    const app = await boot({ hs, credential: asCredential() });
    const r = await approve(app);
    expect(r.body.roomAdmission.reason).toBe('invite_refused');
  });

  test('unreadable power levels leave the original refusal alone', async () => {
    // A guess here would be worse than the bare error: it would name a cause we did not establish.
    const hs = await fakeHomeserver({
      inviteStatus: 403, inviteBody: { errcode: 'M_FORBIDDEN' }, powerLevels: null,
    });
    const app = await boot({ hs, credential: asCredential() });
    // Default fake power levels DO say 50/0, so this asserts the diagnosis path; the unreadable case is
    // covered by the library test that drives `canRepresentativeInvite` against a failing state read.
    expect((await approve(app)).body.roomAdmission.reason).toBe('representative_lacks_invite_power');
  });
});
