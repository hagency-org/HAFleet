/*
 * 邀请码 as an endpoint — ADR-016 decision 5, from the operator's side of it.
 *
 * The operator pastes `#its-project:its-server` and the representative knocks. What this file pins is
 * mostly what the response must NOT say: a knock is not access, and it is not an approval. Membership
 * stays in `knock` until somebody on the project's side invites us, and lending an agent remains a
 * separate audited act — ADR-014's 「joining a Discord costs the joiner nothing. Lending an agent spends
 * tokens.」 is not softened by making a project findable.
 *
 * THE TWO FAILURES ARE KEPT APART on purpose. An unresolvable alias is a typo or an unpublished room; a
 * refused knock is the project's join rule. Reporting both as "failed" would hide which, and they send
 * an operator to different people.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ALIAS = `#acme-market:${SIDE}`;
const ROOM = `!market:${SIDE}`;
const TOKEN = 'knock-operator-token';

let context = null;
let fake = null;

afterEach(async () => {
  context?.cleanup();
  context = null;
  if (fake) { await new Promise((r) => fake.server.close(r)); fake = null; }
});

/** A homeserver that answers the directory read and the knock, and records both. */
async function fakeHomeserver({ directory = null, knockStatus = 200, knockBody = {} } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
      if (req.url.includes('/directory/room/')) {
        const found = directory !== null;
        res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(found ? { room_id: directory } : { errcode: 'M_NOT_FOUND' }));
      }
      if (req.url.includes('/knock/')) {
        res.writeHead(knockStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(knockStatus === 200 ? { room_id: ROOM } : knockBody));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ errcode: 'M_NOT_FOUND' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake = { server, seen, url: `http://127.0.0.1:${server.address().port}` };
  return fake;
}

async function boot({ hs = null, credential = 'appservice' } = {}) {
  context = await createBackendTestContext('project-side-knock-', {
    agents: {},
    env: { API_TOKEN: TOKEN },
  });
  const app = context.app;
  await request(app).post('/api/project-sides')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ server_name: SIDE, api_base_url: hs ? hs.url : 'http://127.0.0.1:1' })
    .expect(200);
  if (credential) {
    await request(app).put(`/api/project-sides/${SIDE}/credential`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        credential: credential === 'appservice'
          ? { kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok', namespace: '@ac_.*', senderLocalpart: 'hafleet' }
          : { kind: 'registrationToken', registrationToken: 'reg-tok' },
      })
      .expect(200);
  }
  return app;
}

const knock = (app, body) => request(app).post(`/api/project-sides/${SIDE}/knock`)
  .set('Authorization', `Bearer ${TOKEN}`).send(body);

describe('POST /api/project-sides/:id/knock', () => {
  test('resolves the alias, knocks, and says what it is still waiting for', async () => {
    const hs = await fakeHomeserver({ directory: ROOM });
    const app = await boot({ hs });

    const r = await knock(app, { alias: ALIAS, reason: 'HAFleet asks to take work here' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sideId: SIDE, alias: ALIAS, roomId: ROOM, state: 'knocked' });
    /*
     * The one assertion this endpoint exists for: it reports what has NOT happened. A response that said
     * only `ok: true` would read as access to a caller, and the project has not accepted anything yet.
     */
    expect(r.body.awaits).toMatch(/invites the representative/);
    expect(JSON.stringify(r.body)).not.toMatch(/approved|engaged|joined/i);

    const dir = hs.seen.find((c) => c.url.includes('/directory/room/'));
    const knocked = hs.seen.find((c) => c.url.includes('/knock/'));
    expect(dir).toBeDefined();
    expect(knocked.body).toEqual({ reason: 'HAFleet asks to take work here' });
    // The knock targets the RESOLVED room id, not the alias — one resolution, reported.
    expect(knocked.url).toContain(encodeURIComponent(ROOM));
  });

  test('an unresolvable alias is its own refusal, distinct from a refused knock', async () => {
    const hs = await fakeHomeserver({ directory: null });
    const app = await boot({ hs });

    const r = await knock(app, { alias: ALIAS });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ status: 'refused', reason: 'alias_unresolved', alias: ALIAS });
    // Never knocked: there was nothing to knock on.
    expect(hs.seen.some((c) => c.url.includes('/knock/'))).toBe(false);
  });

  test('a homeserver without knocking is reported as unsupported, not as a bad room', async () => {
    const hs = await fakeHomeserver({
      directory: ROOM, knockStatus: 404, knockBody: { errcode: 'M_UNRECOGNIZED' },
    });
    const app = await boot({ hs });

    const r = await knock(app, { alias: ALIAS });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('knock_unsupported');
    expect(r.body.error).toMatch(/does not implement knocking/);
  });

  test('a room that refuses the knock keeps its own reason', async () => {
    const hs = await fakeHomeserver({
      directory: ROOM, knockStatus: 403, knockBody: { errcode: 'M_FORBIDDEN', error: 'not allowed to knock' },
    });
    const app = await boot({ hs });

    const r = await knock(app, { alias: ALIAS });
    expect(r.body.reason).toBe('knock_refused');
    expect(r.body.roomId).toBe(ROOM);
  });

  test('already a member answers 200 with that state, so this is safe to repeat', async () => {
    const hs = await fakeHomeserver({
      directory: ROOM, knockStatus: 403,
      knockBody: { errcode: 'M_FORBIDDEN', error: 'You are already in the room.' },
    });
    const app = await boot({ hs });

    const r = await knock(app, { alias: ALIAS });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'already_member', awaits: null });
  });

  test('a room id may be given directly, and the directory is not consulted', async () => {
    const hs = await fakeHomeserver({ directory: ROOM });
    const app = await boot({ hs });
    const r = await knock(app, { alias: ROOM });
    expect(r.body.state).toBe('knocked');
    expect(hs.seen.some((c) => c.url.includes('/directory/room/'))).toBe(false);
  });

  test('no credential, no alias, unknown side: each refused on its own terms', async () => {
    const bare = await boot({ credential: null });
    expect((await knock(bare, { alias: ALIAS })).body.code).toBe('no_credential');

    const hs = await fakeHomeserver({ directory: ROOM });
    const app = await boot({ hs });
    const missing = await knock(app, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/alias is required/);

    const unknown = await request(app).post('/api/project-sides/nope.example/knock')
      .set('Authorization', `Bearer ${TOKEN}`).send({ alias: '#x:nope.example' });
    expect(unknown.status).toBe(404);
  });
});
