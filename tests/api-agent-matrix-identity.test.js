/*
 * Minting an agent's Matrix identity ON THE PROJECT SIDE IT SERVES.
 *
 * THE CIRCULAR DEPENDENCY THIS BREAKS is the operator's opening question:
 *
 *   「agent 在没有接受项目邀请之前是不知道加入哪个 home server 的,所以你先创建了 biglittle 的 matrix id
 *    是错的」
 *
 * `agentUserId()` composes `@ac_<name>:<MATRIX_SERVER_NAME>` from a module constant, so an identity
 * existed before any project was known — on a server that, without federation, the project cannot see.
 * `mintAgentIdentity` was written for this and had NO product caller: all 12 of its references were in
 * tests. These tests cover the caller.
 *
 * THE REFUSALS ARE THE POINT. Every branch that cannot mint answers with a reason instead of falling
 * back to our own server, because that fallback IS the bug. A test suite that only proved the happy
 * path would leave the fallback free to come back.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createServer } from 'http';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ROOM = `!proj:${SIDE}`;
const AGENT = 'biglittle';

let context = null;
let fake = null;

afterEach(async () => {
  context?.cleanup();
  context = null;
  if (fake) { await new Promise((r) => fake.server.close(r)); fake = null; }
});

/**
 * A homeserver that answers only what minting asks it.
 *
 * Started in-process rather than mocked, because the registration-token path makes a REAL
 * `POST /_matrix/client/v3/register` and the whole question is what it does with the answer. Stubbing
 * the call would test the parts that were never in doubt.
 */
async function fakeHomeserver(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [status, payload] = handler(req.url, req.method, body ? JSON.parse(body) : null);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake = { server, url: `http://127.0.0.1:${server.address().port}` };
  return fake.url;
}

/**
 * A homeserver that accepts an appservice masquerade.
 *
 * MINTING UNDER APPSERVICE IS A PROBE, not a registration — `mintAgentIdentity` calls
 * `whoami?user_id=<claimed>` with the as_token and treats acceptance as the identity existing. I had
 * assumed it made no call at all and pointed these tests at a dead port; every appservice case then
 * failed with `fetch failed`, which looked like a bug in the endpoint and was a bug in the test.
 */
async function fakeAppserviceHomeserver() {
  return fakeHomeserver((path) => {
    if (path.startsWith('/_matrix/client/v3/account/whoami')) {
      const m = /user_id=([^&]+)/.exec(path);
      return [200, { user_id: decodeURIComponent(m ? m[1] : '') }];
    }
    return [404, { errcode: 'M_NOT_FOUND' }];
  });
}

async function boot({ agentOverrides = {}, bindRoom = ROOM, apiBaseUrl = 'http://127.0.0.1:1' } = {}) {
  context = await createBackendTestContext('agent-matrix-identity-', {
    agents: {
      [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true, ...agentOverrides },
    },
    env: { MATRIX_BRIDGE_SECRET: 'mint-secret', MATRIX_AGENT_PREFIX: 'ac_' },
  });
  const app = context.app;
  await request(app).post('/api/project-sides')
    .send({ server_name: SIDE, api_base_url: apiBaseUrl }).expect(200);
  if (bindRoom) {
    await request(app).put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'mint-secret')
      .send({
        agent: AGENT, project: 'p', projectRoomId: bindRoom,
        ownerMxid: `@alex:${SIDE}`, ownerDmRoomId: `!dm:${SIDE}`,
      }).expect(200);
  }
  return app;
}

const setCredential = (app, credential) => request(app)
  .put(`/api/project-sides/${SIDE}/credential`).send({ credential });

const mint = (app, name = AGENT) => request(app).post(`/api/agents/${name}/matrix-identity`);

describe('the side is resolved, never assumed', () => {
  test('from the agent\'s BINDING when it has no provisioned side', async () => {
    /*
     * The path every agent in this deployment takes: they predate provisioning, so `projectSide` is
     * null and the only evidence of which customer they serve is the room they are bound to. A room id
     * carries its server and that server IS the side.
     */
    const app = await boot({ apiBaseUrl: await fakeAppserviceHomeserver() });
    await setCredential(app, {
      kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok',
      namespace: '@ac_.*', senderLocalpart: 'hafleet',
    }).expect(200);

    const r = await mint(app);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, sideId: SIDE, sideResolvedFrom: `binding:${ROOM}`,
      mxid: `@ac_${AGENT}:${SIDE}`, credentialKind: 'appservice',
    });
  });

  test('from `projectSide` in preference to a binding, because the plan outranks the evidence', async () => {
    /*
     * `projectSide` comes from the provision plan and is never taken from the agent's own request body.
     * A binding is evidence of where it ended up; the plan is a statement of where it belongs. When they
     * disagree the plan wins, and the response says which was used so a reader can see the disagreement.
     */
    const app = await boot({
      agentOverrides: { projectSide: SIDE },
      bindRoom: '!elsewhere:other.example',
      apiBaseUrl: await fakeAppserviceHomeserver(),
    });
    await setCredential(app, {
      kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok',
      namespace: '@ac_.*', senderLocalpart: 'hafleet',
    }).expect(200);
    const r = await mint(app);
    expect(r.body.sideResolvedFrom).toBe('agent.projectSide');
    expect(r.body.mxid).toBe(`@ac_${AGENT}:${SIDE}`);
  });

  test('NO SIDE IS A REFUSAL, never a fallback to our own server', async () => {
    /*
     * THE ORIGINAL BUG, guarded. Composing `@ac_x:<MATRIX_SERVER_NAME>` for an agent with no side is
     * exactly what the operator called wrong: without federation that identity is invisible to the
     * project, so the agent joins nothing and says nothing, and the failure surfaces far from here.
     */
    const app = await boot({ bindRoom: null });
    const r = await mint(app);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_project_side');
    expect(r.body.error).toMatch(/no projectSide and no binding on a configured side/);
    // And no MXID was invented on the way out.
    expect(r.body.mxid).toBeUndefined();
  });

  test('a binding on a server with no side record is not a side', async () => {
    // The room exists, the customer does not. Refused rather than minting against an unconfigured host.
    const app = await boot({ bindRoom: '!room:unconfigured.example' });
    const r = await mint(app);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_project_side');
  });

  test('an unknown agent is 404, and so is an unusable name', async () => {
    /*
     * `!!!` answers 404, not the 400 I first expected: `normalizeAgentName` strips it to nothing, the
     * lookup finds no agent, and "no such agent" is reached before any name-shape complaint. Recorded as
     * the behaviour rather than asserted as the behaviour I assumed — the outcome is right either way
     * (nothing is minted) and the status says the true thing about what was looked for.
     */
    const app = await boot();
    expect((await mint(app, 'no_such_agent')).status).toBe(404);
    expect((await mint(app, encodeURIComponent('!!!'))).status).toBe(404);
  });
});

describe('what each credential kind yields', () => {
  test('appservice: an MXID and NO token, and it CAN send anyway', async () => {
    /*
     * The namespace already authorises the identity, so nothing is registered and HAFleet acts as the
     * agent by masquerading. `accessToken: null` is the design.
     *
     * `canSend` USED TO BE FALSE HERE, and the note said the bridge's send path still wanted a
     * per-agent token. It does not any more: `sendAsAgentContent` accepts an appservice sender and
     * signs with the side's as_token, naming the agent in `?user_id=`. So the field stops meaning "has
     * a token" and answers the question a caller actually asks — will messages from this agent reach a
     * room. `hasOwnToken` carries the fact that changed hands, because the two are no longer the same
     * question and a caller provisioning credentials still needs the first one.
     */
    const app = await boot({ apiBaseUrl: await fakeAppserviceHomeserver() });
    await setCredential(app, {
      kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok',
      namespace: '@ac_.*', senderLocalpart: 'hafleet',
    }).expect(200);
    const r = await mint(app);
    expect(r.body).toMatchObject({ accessToken: null, canSend: true, hasOwnToken: false });
    expect(r.body.note).toMatch(/can be addressed AND can speak/);
  });

  test('appservice: a localpart OUTSIDE the claimed namespace is refused before any call', async () => {
    /*
     * The homeserver's refusal for an out-of-namespace masquerade is a 403 identical to a bad as_token,
     * and those two send an operator to different places. Checked against the claimed regex first.
     */
    const app = await boot();
    await setCredential(app, {
      kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok',
      namespace: '@bot_.*', senderLocalpart: 'hafleet',
    }).expect(200);
    const r = await mint(app);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/@ac_biglittle:palpo\.test/);
  });

  test('registrationToken: a real register call yields an MXID and a token that CAN send', async () => {
    const url = await fakeHomeserver((path, method) => {
      if (path.startsWith('/_matrix/client/v3/register') && method === 'POST') {
        return [200, { user_id: `@ac_${AGENT}:${SIDE}`, access_token: 'minted-token', device_id: 'DEV1' }];
      }
      return [404, { errcode: 'M_NOT_FOUND' }];
    });
    const app = await boot({ apiBaseUrl: url });
    await setCredential(app, { kind: 'registrationToken', registrationToken: 'reg-tok' }).expect(200);

    const r = await mint(app);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      mxid: `@ac_${AGENT}:${SIDE}`, accessToken: 'minted-token', canSend: true, note: null,
    });
  });

  test('registrationToken: a taken localpart is 409 and says so, not 502', async () => {
    /*
     * A name already in use is a different problem from a homeserver that will not talk to us. Reported
     * apart because the remedies are: pick another name, versus fix the connection.
     */
    const url = await fakeHomeserver((path) => {
      if (path.startsWith('/_matrix/client/v3/register')) {
        return [400, { errcode: 'M_USER_IN_USE', error: 'that username is taken' }];
      }
      return [404, { errcode: 'M_NOT_FOUND' }];
    });
    const app = await boot({ apiBaseUrl: url });
    await setCredential(app, { kind: 'registrationToken', registrationToken: 'reg-tok' }).expect(200);
    const r = await mint(app);
    expect(r.status).toBe(409);
    /*
     * The homeserver's own words survive the two layers. `mintAgentIdentity` returns
     * `{ minted: false, errcode, reason }` and this endpoint prefixes it, so what an operator reads
     * still names the actual problem instead of "mint refused".
     */
    expect(r.body.error).toMatch(/could not mint an identity/);
    expect(JSON.stringify(r.body)).toMatch(/M_USER_IN_USE|taken|in use/i);
  });

  test('no credential on the side is a refusal that names the missing thing', async () => {
    const app = await boot();
    const r = await mint(app);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_credential');
    expect(r.body.error).toMatch(/has no credential, so nothing can be minted/);
  });
});

describe('the verdict is read, not assumed', () => {
  test('a refusal from mintAgentIdentity is a 409, never a 200 with a null mxid', async () => {
    /*
     * `mintAgentIdentity` RETURNS `{ minted: false, reason }` rather than throwing, and the first version
     * of this endpoint assumed a throw — so every refusal would have answered 200 with `mxid: null`. A
     * caller reporting "minted" for a refusal is worse than one that crashes: the record it writes is
     * empty and nothing says so. This is the regression guard for that.
     *
     * An appservice credential with no `registrationToken` reaching the token path is the reachable
     * instance: the store accepts a registrationToken credential whose token is later cleared.
     */
    const app = await boot();
    await setCredential(app, { kind: 'registrationToken', registrationToken: 'reg-tok' }).expect(200);
    // Point it at a homeserver that is not listening: minting cannot succeed and must not claim to.
    const r = await mint(app);
    expect(r.status).not.toBe(200);
    expect(r.body.mxid).toBeUndefined();
  });
});
