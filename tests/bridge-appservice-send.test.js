/*
 * AN AGENT ON AN APPSERVICE SIDE CAN SPEAK — the `canSend: false` hole, closed.
 *
 * `POST /api/agents/:name/matrix-identity` has answered `canSend: false` with a note saying "the
 * bridge send path still requires [a per-agent token], so it cannot send as this agent yet" ever since
 * appservice sides existed. Everything else was in place: the namespace makes the agent addressable,
 * the representative invites it, and the as_token joins it. Then it had nothing to say with — the
 * outbound path resolved a token, found none, and dropped the message.
 *
 * THE ASSERTION THAT CARRIES THIS FILE is `?user_id=`. Sending with the as_token and no masquerade
 * posts as the REPRESENTATIVE while every caller believes the agent spoke — a false record of who said
 * what, in somebody else's room, which is worse than the message not being sent at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('sending as an agent that has no token of its own', () => {
  let MatrixBridge;
  let runtimeDir;
  let envSnapshot;

  const SIDE = 'palpo.test';
  const ROOM = `!proj:${SIDE}`;
  const AGENT = 'biglittle';
  const AGENT_MXID = `@ac_${AGENT}:${SIDE}`;
  const AS_TOKEN = 'as_secret_never_logged';

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-as-send-'));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-send`));
  });

  afterAll(() => {
    restoreEnv(envSnapshot);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * A bridge with only what the send path touches.
   *
   * Constructed as a bare object rather than a real `MatrixBridge`, because the constructor reaches for
   * a homeserver, a bot login and a state file — none of which this question depends on. The methods
   * under test are borrowed onto it, which is also how it stays honest: if `sendAsAgentContent` starts
   * depending on something else, this stops working rather than quietly testing a copy.
   */
  function bridgeStub() {
    const stub = {
      agentWork: new Map(),
      matrixDeliveryJournal: { get: () => null },
      ended: [],
      warnings: [],
      endAgentWork(name, roomId) { this.ended.push({ name, roomId }); },
      endAgentWorkForToken(token, roomId) { this.ended.push({ token, roomId }); },
      postWarning(message) { this.warnings.push(message); },
      rememberMatrixEvent() {},
    };
    stub.sendAsAgentContent = MatrixBridge.prototype.sendAsAgentContent.bind(stub);
    stub.sendAsAgent = MatrixBridge.prototype.sendAsAgent.bind(stub);
    return stub;
  }

  const appserviceSender = (over = {}) => ({
    kind: 'appservice',
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: AS_TOKEN, senderLocalpart: 'hafleet', namespace: '@ac_.*' },
    agentUserId: AGENT_MXID,
    agentName: AGENT,
    ...over,
  });

  function captureFetch(response = { ok: true, status: 200, json: async () => ({ event_id: '$ev1' }) }) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body });
      return response;
    });
    return calls;
  }

  test('the as_token sends, and the AGENT is named in ?user_id=', async () => {
    const calls = captureFetch();
    const bridge = bridgeStub();

    const eventId = await bridge.sendAsAgentContent(
      appserviceSender(), ROOM, { msgtype: 'm.text', body: 'hello from the site' },
    );

    expect(eventId).toBe('$ev1');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('PUT');
    // The side's own base url, not this deployment's homeserver.
    expect(call.url).toContain('http://127.0.0.1:8008/_matrix/client/v3/rooms/');
    expect(call.headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
    /*
     * THE MASQUERADE. Without this parameter the message is posted by the representative and reported
     * as the agent — the one outcome worse than a failed send, because nothing anywhere says so.
     */
    expect(call.url).toContain(`user_id=${encodeURIComponent(AGENT_MXID)}`);
    expect(JSON.parse(call.body)).toMatchObject({ body: 'hello from the site' });
  });

  test('the work indicator ends by NAME, because there is no token to look the name up from', async () => {
    captureFetch();
    const bridge = bridgeStub();
    await bridge.sendAsAgentContent(appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' });
    expect(bridge.ended).toEqual([{ name: AGENT, roomId: ROOM }]);
  });

  test('a token sender still sends exactly as it did, with no user_id', async () => {
    /*
     * The regression that matters most: every agent registered the old way keeps its own path. A
     * `user_id` on a real token's send would be a masquerade request from an account with no
     * appservice rights — a 403 on every message the old fleet sends.
     */
    const calls = captureFetch();
    const bridge = bridgeStub();
    await bridge.sendAsAgentContent('agent-own-token', ROOM, { msgtype: 'm.text', body: 'x' });
    expect(calls[0].headers.Authorization).toBe('Bearer agent-own-token');
    expect(calls[0].url).not.toContain('user_id=');
    expect(bridge.ended).toEqual([{ token: 'agent-own-token', roomId: ROOM }]);
  });

  test('no token and no appservice credential REFUSES, instead of sending "Bearer undefined"', async () => {
    /*
     * What the old signature did with a missing token: interpolated `undefined` into the header, got a
     * 401, and warned about the room. The refusal now names the missing credential, which is the thing
     * an operator has to fix.
     */
    const calls = captureFetch();
    const bridge = bridgeStub();
    const eventId = await bridge.sendAsAgentContent(null, ROOM, { msgtype: 'm.text', body: 'x' });
    expect(eventId).toBeNull();
    expect(calls).toHaveLength(0);
    expect(bridge.warnings.join(' ')).toMatch(/no credential or appservice sender/);
  });

  test('an incomplete appservice sender is refused, not half-used', async () => {
    const calls = captureFetch();
    const bridge = bridgeStub();
    // No agentUserId: the one field that decides WHO speaks.
    const eventId = await bridge.sendAsAgentContent(
      { kind: 'appservice', side: { serverName: SIDE, apiBaseUrl: 'http://x' }, credential: { asToken: 'a' } },
      ROOM, { msgtype: 'm.text', body: 'x' },
    );
    expect(eventId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a failed send throws when the caller asked to be told, and warns when it did not', async () => {
    const bridge = bridgeStub();
    captureFetch({ ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN', error: 'nope' }) });
    // Not a membership failure, so no re-admission is attempted — the plain refusal path.
    await expect(bridge.sendAsAgentContent(
      appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' }, null, { throwOnFailure: true },
    )).rejects.toThrow(/M_FORBIDDEN/);

    const quiet = bridgeStub();
    captureFetch({ ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN', error: 'nope' }) });
    expect(await quiet.sendAsAgentContent(appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' })).toBeNull();
    expect(quiet.warnings.join(' ')).toMatch(/M_FORBIDDEN/);
  });

  test('normalizeSender: a string is a token, a complete object is a sender, anything else is nothing', () => {
    expect(MatrixBridge.normalizeSender('tok')).toEqual({ kind: 'token', token: 'tok' });
    expect(MatrixBridge.normalizeSender(appserviceSender()).kind).toBe('appservice');
    for (const bad of [null, undefined, 42, {}, { kind: 'appservice' }, { kind: 'token' }]) {
      expect(MatrixBridge.normalizeSender(bad)).toBeNull();
    }
  });
});

/*
 * A DM FOR AN AGENT THAT HAS NO TOKEN — the gap the live run found.
 *
 * The 2026-08-15 run against real Palpo got the agent invited into the project room, joined, and
 * speaking in it, and then a DM to the same human was dropped one layer ABOVE the send path that had
 * just been taught to do this: `ensureDmRoom` did `if (!fromToken) return null`. Everything below was
 * ready and nothing reached it.
 */
describe('a DM room for an agent with no token of its own', () => {
  let MatrixBridge;
  let runtimeDir;
  let envSnapshot;
  let mod;

  const SIDE = 'palpo.test';
  const AGENT = 'sitehand';
  const AGENT_MXID = `@ac_${AGENT}:${SIDE}`;
  const HUMAN = 'borrower';
  const AS_TOKEN = 'as_secret_never_logged';

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-as-dm-'));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    mod = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-dm`);
    ({ MatrixBridge } = mod);
  });

  afterAll(() => {
    restoreEnv(envSnapshot);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * Only what `ensureDmRoomOnSide` touches, borrowed off the prototype.
   *
   * `agentSenderFor` is stubbed rather than driven through real state: what is under test is what this
   * method does with a sender, and building one through `actingSideFor` would be testing the credential
   * refresh loop instead.
   */
  function stub({ sender, humanMxid }) {
    const self = {
      dmRooms: new Map(),
      warnings: [],
      postWarning(message, meta) { this.warnings.push({ message, meta }); },
      agentSenderFor: () => sender,
    };
    self.ensureDmRoomOnSide = MatrixBridge.prototype.ensureDmRoomOnSide.bind(self);
    /*
     * Seeded through the live observed-MXID map (#73's `humanMxidStateForTest`), because that is the
     * map `humanUserId` reads and the whole question here is which server it answers with. A dedicated
     * setter would have been a second way in — I reached for one and it does not exist, which is the
     * map doing its job of having one owner.
     */
    if (humanMxid) {
      const state = mod.humanMxidStateForTest();
      state[String(humanMxid.slice(1, humanMxid.indexOf(':'))).toLowerCase()] = humanMxid;
    }
    return self;
  }

  const sender = (over = {}) => ({
    kind: 'appservice',
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: AS_TOKEN, senderLocalpart: 'hafleet', namespace: '@ac_.*' },
    agentUserId: AGENT_MXID,
    agentName: AGENT,
    ...over,
  });

  function fakeMatrix({ createOk = true, joinOk = true } = {}) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method, headers: init.headers ?? {}, body: init.body });
      if (u.includes('/createRoom')) {
        return createOk
          ? { ok: true, status: 200, json: async () => ({ room_id: `!dm:${SIDE}` }) }
          : { ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN' }) };
      }
      if (u.includes('/join/')) {
        return joinOk
          ? { ok: true, status: 200, json: async () => ({ room_id: `!dm:${SIDE}` }) }
          : { ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    return calls;
  }

  test('the representative creates it on the SIDE, and the agent joins by masquerade', async () => {
    const calls = fakeMatrix();
    const self = stub({ sender: sender(), humanMxid: `@${HUMAN}:${SIDE}` });

    const roomId = await self.ensureDmRoomOnSide({
      agentName: AGENT, humanName: HUMAN, humanIsAgent: false, key: `dm:${AGENT}`,
    });

    expect(roomId).toBe(`!dm:${SIDE}`);
    const create = calls.find((c) => c.url.includes('/createRoom'));
    const join = calls.find((c) => c.url.includes('/join/'));
    expect(create).toBeDefined();
    expect(join).toBeDefined();

    // The side's own homeserver, never ours.
    expect(create.url.startsWith('http://127.0.0.1:8008/')).toBe(true);
    // Created AS THE REPRESENTATIVE; joined AS THE AGENT. One credential, two masquerades.
    expect(create.url).toContain(encodeURIComponent(`@hafleet:${SIDE}`));
    expect(join.url).toContain(encodeURIComponent(AGENT_MXID));

    const body = JSON.parse(create.body);
    /*
     * BOTH parties in the invite list, and the agent's presence is the assertion a live run had to
     * teach this test: `private_chat` is invite-only and the representative is the creator, so an agent
     * that is not invited takes a 403 on the join. The first version asserted only the human and passed
     * against a fake homeserver that answered 200 to any join.
     */
    expect(body.invite).toEqual([`@${HUMAN}:${SIDE}`, AGENT_MXID]);
    expect(body.is_direct).toBe(true);
    /*
     * THE BOT IS NOT IN THE INVITE LIST, and that is the point rather than an omission: it holds an
     * account on our server only, so inviting it would leave a pending invite nobody can ever accept.
     */
    expect(JSON.stringify(body.invite)).not.toMatch(/bot/i);
    // Plaintext, stated: the representative holds no crypto store, and the appservice reads this room.
    expect(body.initial_state).toEqual([]);
  });

  test('a human on ANOTHER server is refused, and no room is created', async () => {
    /*
     * Without federation a room on `palpo.test` holds `palpo.test` accounts and nothing else, so this
     * DM is not a room that can exist. Creating one anyway and inviting an mxid nobody can accept is
     * the shape of the bug #73 fixed — a plausible identity composed onto the wrong server.
     */
    const calls = fakeMatrix();
    const self = stub({ sender: sender(), humanMxid: '@elsewhere:other.example' });

    const roomId = await self.ensureDmRoomOnSide({
      agentName: AGENT, humanName: 'elsewhere', humanIsAgent: false, key: `dm:${AGENT}`,
    });

    expect(roomId).toBeNull();
    expect(calls).toHaveLength(0);
    const warned = self.warnings.map((w) => w.message).join(' ');
    // Both servers are named, because which one is wrong decides the operator's fix.
    expect(warned).toMatch(/other\.example/);
    expect(warned).toMatch(/palpo\.test/);
  });

  test('an agent WITH a token never reaches this path', async () => {
    const calls = fakeMatrix();
    const self = stub({ sender: { kind: 'token', token: 'has-one' }, humanMxid: `@${HUMAN}:${SIDE}` });
    const roomId = await self.ensureDmRoomOnSide({
      agentName: AGENT, humanName: HUMAN, humanIsAgent: false, key: `dm:${AGENT}`,
    });
    expect(roomId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a created room the agent cannot join returns null, rather than a room it cannot post in', async () => {
    /*
     * Handing back a room the sender is not in would turn one clear failure into a 403 on every later
     * send, attributed to whatever message happened to be next.
     */
    const calls = fakeMatrix({ joinOk: false });
    const self = stub({ sender: sender(), humanMxid: `@${HUMAN}:${SIDE}` });
    const roomId = await self.ensureDmRoomOnSide({
      agentName: AGENT, humanName: HUMAN, humanIsAgent: false, key: `dm:${AGENT}`,
    });
    expect(roomId).toBeNull();
    expect(calls.some((c) => c.url.includes('/createRoom'))).toBe(true);
    expect(self.warnings.map((w) => w.message).join(' ')).toMatch(/could not join/);
  });

  test('an agent-to-agent room is refused rather than guessed', async () => {
    const calls = fakeMatrix();
    const self = stub({ sender: sender(), humanMxid: `@${HUMAN}:${SIDE}` });
    const roomId = await self.ensureDmRoomOnSide({
      agentName: AGENT, humanName: 'otheragent', humanIsAgent: true, key: `${AGENT}:otheragent`,
    });
    expect(roomId).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/*
 * WHICH SERVER ACTS IN WHICH ROOM — ADR-016 row 1's audit, at the two sites a side room reaches today.
 *
 * Every `HOMESERVER` in the bridge predates project sides and asserts our own server for whatever room
 * it was handed. Most are still right (the bot's own account, rooms on our server). These two are not,
 * and one of them became reachable only because `ensureDmRoomOnSide` now persists side DM rooms — a
 * reachability introduced by the fix above it, which is why it is tested beside it.
 */
describe('a room on a project side is acted in by the side, not by us', () => {
  let MatrixBridge;
  let runtimeDir;
  let envSnapshot;

  const SIDE = 'palpo.test';
  const SIDE_ROOM = `!proj:${SIDE}`;
  const OUR_ROOM = '!ours:matrix.example.test';

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-room-actor-'));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    process.env.MATRIX_SERVER_NAME = 'matrix.example.test';
    ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?room-actor`));
  });

  afterAll(() => {
    restoreEnv(envSnapshot);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const acting = {
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: 'as_secret_never_logged', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
  };

  function stub({ sides = { [SIDE]: acting } } = {}) {
    const self = {
      warnings: [],
      postWarning(m) { this.warnings.push(m); },
      actingSideFor: (server) => sides[String(server).toLowerCase()] ?? null,
      getBotToken: () => 'bot-token',
      getAgentToken: () => 'agent-token',
      botUserId: '@hafleetbot:matrix.example.test',
    };
    for (const m of ['sideForRoom', '_inviteHumanToDm', 'inviteBotIntoAgentRoom']) {
      self[m] = MatrixBridge.prototype[m].bind(self);
    }
    return self;
  }

  test('sideForRoom answers for a side room and null for our own', () => {
    const self = stub();
    expect(self.sideForRoom(SIDE_ROOM)).toBe(acting);
    expect(self.sideForRoom(OUR_ROOM)).toBeNull();
    // A server we hold no acting credential for is not ours to act in either.
    expect(self.sideForRoom('!x:stranger.example')).toBeNull();
    /*
     * OUR OWN SERVER WINS EVEN IF A CREDENTIAL EXISTS FOR IT. A deployment that registered an
     * appservice on its OWN homeserver would otherwise have every local room rerouted through the
     * representative — the bot's rooms answered with somebody else's actor. Found by a surviving
     * mutant: deleting the `=== MATRIX_SERVER_NAME` check passed every other test here, because none of
     * them had an acting credential for our own name.
     */
    const alsoOurs = stub({ sides: { [SIDE]: acting, 'matrix.example.test': acting } });
    expect(alsoOurs.sideForRoom(OUR_ROOM)).toBeNull();
    expect(alsoOurs.sideForRoom(SIDE_ROOM)).toBe(acting);
    for (const bad of [null, undefined, 'not-a-room', 42]) expect(self.sideForRoom(bad)).toBeNull();
  });

  test('inviting a human into a SIDE DM goes through the representative', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const self = stub();

    const r = await self._inviteHumanToDm(SIDE_ROOM, 'borrower');
    expect(r).toMatchObject({ ok: true, via: 'representative' });
    expect(calls).toHaveLength(1);
    // The SIDE's homeserver with the as_token — never ours with the bot's.
    expect(calls[0].url.startsWith('http://127.0.0.1:8008/')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('Bearer as_secret_never_logged');
  });

  test('inviting the bot into a SIDE room is skipped, with nothing attempted', async () => {
    /*
     * Not a failure to retry: the bot has no account there, so the invite would sit pending forever —
     * and it would be sent with an AGENT token against OUR homeserver, two wrong things at once.
     */
    const calls = [];
    vi.stubGlobal('fetch', async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; });
    const self = stub();
    expect(await self.inviteBotIntoAgentRoom(SIDE_ROOM, 'agent-token')).toBe('skipped-project-side');
    expect(calls).toHaveLength(0);
  });

  test('our own rooms keep the old path exactly', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const self = stub();
    await self.inviteBotIntoAgentRoom(OUR_ROOM, 'agent-token');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('matrix.example.test');
    expect(calls[0].headers.Authorization).toBe('Bearer agent-token');
  });
});
