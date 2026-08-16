/*
 * The bridge's side of the appservice: what a pushed transaction actually does.
 *
 * The last piece of ADR-016's second pass. The receiver, the listener and the router are covered by
 * their own files; this covers the wiring — which path an event takes once it is inside the bridge,
 * and how the set of served project sides is kept current.
 *
 * WHY THE WIRING IS THE INTERESTING PART. Events could have been handled where they arrive. Routing
 * them through `onRoomMessage` / `onRoomEvent` instead means they inherit gates those two already
 * carry: event-id deduplication and in-flight coalescing on the message path, the historical-event
 * cutoff and the room trust gate on the other. A parallel path would be a second place for each of
 * those to be got right, and the ones it forgot would stay invisible until a project side sent
 * something unusual.
 *
 * `handleAppserviceEvents` is exercised through `MatrixBridge.prototype.call` with a minimal `this`.
 * That is deliberate: the method's whole content is the dispatch decision, and constructing a real
 * bridge would drag in a homeserver, a crypto store and a backend to observe one branch.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';

let bridgeModule;
let backend;
let backendCalls = [];
let backendReply = () => [200, { ok: true, sides: [] }];

const savedEnv = new Map();
const remember = (key) => { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); };

beforeAll(async () => {
  backend = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      backendCalls.push({ path: url.pathname, method: req.method, headers: req.headers });
      const [status, body] = backendReply(url.pathname, req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));

  for (const key of ['HAFLEET_API', 'MATRIX_BRIDGE_SECRET', 'MATRIX_HOMESERVER', 'MATRIX_SERVER_NAME',
    'HAFLEET_APPSERVICE_PORT', 'HAFLEET_APPSERVICE_BIND']) remember(key);
  process.env.HAFLEET_API = `http://127.0.0.1:${backend.address().port}`;
  process.env.MATRIX_BRIDGE_SECRET = 'bridge-secret-for-intake-test';
  process.env.MATRIX_HOMESERVER = 'http://127.0.0.1:1';
  process.env.MATRIX_SERVER_NAME = 'intake.test';
  delete process.env.HAFLEET_APPSERVICE_PORT;
  delete process.env.HAFLEET_APPSERVICE_BIND;

  const url = pathToFileURL(new URL('../bridge-matrix.js', import.meta.url).pathname).href;
  bridgeModule = await import(`${url}?appservice-intake=${Date.now()}`);
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((resolve) => backend.close(resolve));
});

/** A `this` carrying only what the method under test touches. */
function fakeBridge({ acting = null } = {}) {
  const seen = { messages: [], events: [], warnings: [], memberships: [] };
  return {
    seen,
    onRoomMessage: async (roomId, event) => { seen.messages.push({ roomId, type: event.type, id: event.event_id }); },
    onRoomEvent: async (roomId, event) => { seen.events.push({ roomId, type: event.type }); },
    // The intake raises operator-visible warnings (encrypted-room blindness); captured, not dropped.
    postWarning: (message, meta) => { seen.warnings.push({ message, ...meta }); },
    /*
     * Membership events now get a second look — an invite addressed to the REPRESENTATIVE is how a
     * project answers a knock (ADR-016 decision 5). Recorded here so the tests below can assert that it
     * happens BESIDE the generic path rather than instead of it: the trust gate and the historical
     * cutoff live in `onRoomEvent`, and a handler that swallowed the event would be a way around both.
     */
    onAppserviceMembership: async (sideId, roomId, event) => {
      seen.memberships.push({ sideId, roomId, membership: event?.content?.membership ?? null });
    },
    actingSideFor: () => acting,
  };
}

const call = (self, sideId, events, meta = { txnId: 't1' }) =>
  bridgeModule.MatrixBridge.prototype.handleAppserviceEvents.call(self, sideId, events, meta);

describe('an event takes the SAME path a synced one takes', () => {
  test('m.room.message goes to onRoomMessage, which is where deduplication lives', async () => {
    /*
     * `onRoomMessage` carries event-id deduplication and in-flight coalescing. Sending appservice
     * messages anywhere else would mean a transaction retried after it aged out of the router's txn
     * window gets delivered twice — the two layers only compose because this one is reused.
     */
    const self = fakeBridge();
    await call(self, 'a.example', [
      { type: 'm.room.message', room_id: '!r:a.example', event_id: '$1' },
    ]);
    expect(self.seen.messages).toEqual([{ roomId: '!r:a.example', type: 'm.room.message', id: '$1' }]);
    expect(self.seen.events).toEqual([]);
  });

  test('everything else goes to onRoomEvent, which is where the trust gate lives', async () => {
    // Membership and room-name events reach the same gate a synced one does: the historical cutoff
    // and `getRoomTrust`. A separate handler would have needed both re-implemented.
    const self = fakeBridge();
    await call(self, 'a.example', [
      { type: 'm.room.member', room_id: '!r:a.example', event_id: '$2' },
      { type: 'm.room.name', room_id: '!r:a.example', event_id: '$3' },
    ]);
    expect(self.seen.events.map((e) => e.type)).toEqual(['m.room.member', 'm.room.name']);
    expect(self.seen.messages).toEqual([]);
    // Seen by the knock handler AS WELL, which is the point: an extra look, not a diversion.
    expect(self.seen.memberships).toHaveLength(1);
  });

  test('events are processed in order, because a join before a message is not the same as after', async () => {
    const order = [];
    const self = {
      onRoomMessage: async () => { order.push('message'); },
      onRoomEvent: async (r, e) => { order.push(e.type); },
      // Recorded in the same list, so ORDER covers the knock look too: it must run before the event
      // reaches the generic handler, not after — an invite answered out of order would join a room
      // whose membership the gate had already judged.
      onAppserviceMembership: async () => { order.push('knock-look'); },
      actingSideFor: () => null,
    };
    await call(self, 'a.example', [
      { type: 'm.room.member', room_id: '!r:a', event_id: '$1' },
      { type: 'm.room.message', room_id: '!r:a', event_id: '$2' },
    ]);
    expect(order).toEqual(['knock-look', 'm.room.member', 'message']);
  });
});

describe('what it refuses to pretend it handled', () => {
  test('an event with no room_id is skipped with the side and txn named', async () => {
    const self = fakeBridge();
    await call(self, 'a.example', [{ type: 'm.room.message', event_id: '$1' }]);
    expect(self.seen.messages).toEqual([]);
    expect(self.seen.events).toEqual([]);
  });

  test('an ENCRYPTED event RAISES AN OPERATOR ALERT, per room, with the remedy in it', async () => {
    /*
     * ADR-016 settled that intake rooms are plaintext; an appservice has no crypto store, so an
     * encrypted room is one this channel is BLIND to. That fact used to be a console.warn — and the
     * first live run succeeded only because the BOT could read the room, with nothing anywhere an
     * operator looks saying the appservice could not. The warning now rides postWarning into the alert
     * store, deduped by ROOM (kind + scope build the dedupe key), so a chatty room raises one alert
     * rather than burying itself, and the text names both remedies because there are exactly two.
     */
    const self = fakeBridge();
    await call(self, 'a.example', [{ type: 'm.room.encrypted', room_id: '!r:a', event_id: '$1' }]);
    expect(self.seen.messages).toEqual([]);
    expect(self.seen.events).toEqual([]);
    expect(self.seen.warnings).toHaveLength(1);
    expect(self.seen.warnings[0]).toMatchObject({ kind: 'appservice-encrypted-intake', scope: '!r:a' });
    expect(self.seen.warnings[0].message).toMatch(/BLIND to !r:a on a\.example/);
    expect(self.seen.warnings[0].message).toMatch(/create intake rooms unencrypted|keep relying on the bot/);
  });

  test('a later event is still processed after one is skipped', async () => {
    // Skipping must not abandon the rest of the transaction: the homeserver will not resend a
    // transaction that answered 200, so anything dropped here is dropped for good.
    const self = fakeBridge();
    await call(self, 'a.example', [
      { type: 'm.room.encrypted', room_id: '!r:a', event_id: '$1' },
      { type: 'm.room.message', room_id: '!r:a', event_id: '$2' },
    ]);
    expect(self.seen.messages.map((m) => m.id)).toEqual(['$2']);
  });

  test('THE ORDERING THAT MATTERS: a handler failure RE-THROWS, so the transaction is retried', async () => {
    /*
     * The receiver turns a throw into a 500, and a 500 makes the homeserver retry. Swallowing here
     * would answer 200 for a transaction that was not processed, and the homeserver would never send
     * it again — the same class of loss as remembering a txnId before processing succeeded.
     */
    const self = {
      onRoomMessage: async () => { throw new Error('backend refused'); },
      onRoomEvent: async () => {},
    };
    await expect(call(self, 'a.example', [
      { type: 'm.room.message', room_id: '!r:a', event_id: '$1' },
    ])).rejects.toThrow(/backend refused/);
  });
});

describe('which project sides the bridge serves', () => {
  test('the credentials come from the BRIDGE-SECRET endpoint, with the secret attached', async () => {
    backendCalls = [];
    backendReply = () => [200, {
      ok: true,
      sides: [{ sideId: 'a.example', hsToken: 'hs_a_token_000000000000000000000000' }],
    }];
    const self = { appserviceRouter: createAppserviceRouter() };
    await bridgeModule.MatrixBridge.prototype.refreshAppserviceSides.call(self);

    const hit = backendCalls.find((c) => c.path === '/api/project-sides/inbound-credentials');
    expect(hit, 'the bridge did not call the inbound-credentials endpoint').toBeTruthy();
    expect(hit.headers['x-bridge-secret']).toBe('bridge-secret-for-intake-test');
    expect(self.appserviceRouter.sideIds()).toEqual(['a.example']);
  });

  test('a backend failure LEAVES THE EXISTING SIDES IN PLACE', async () => {
    /*
     * Tearing sides down because the backend blinked would turn a backend restart into refused
     * deliveries on every project side, and the homeserver's retries would expire while we were the
     * broken party. The listener keeps serving what it already had.
     */
    backendReply = () => [200, {
      ok: true, sides: [{ sideId: 'a.example', hsToken: 'hs_a_token_000000000000000000000000' }],
    }];
    const self = { appserviceRouter: createAppserviceRouter() };
    await bridgeModule.MatrixBridge.prototype.refreshAppserviceSides.call(self);
    expect(self.appserviceRouter.sideIds()).toEqual(['a.example']);

    backendReply = () => [503, { error: 'backend down' }];
    await bridgeModule.MatrixBridge.prototype.refreshAppserviceSides.call(self);
    expect(self.appserviceRouter.sideIds()).toEqual(['a.example']);
  });

  test('with no router configured it does nothing rather than throwing', async () => {
    // The listener is off on most deployments, so this runs with `appserviceRouter` null whenever a
    // timer fires before one exists.
    await expect(bridgeModule.MatrixBridge.prototype.refreshAppserviceSides.call({})).resolves.toBeUndefined();
  });
});

describe('the socket is off unless the deployment asked for one', () => {
  test('with no port set, nothing is created and the reason is logged', async () => {
    /*
     * Silent-by-default matters here: a deployment using only registration-token sides has no reason
     * to expose a socket, and a warning on every start would train an operator to ignore this log.
     */
    delete process.env.HAFLEET_APPSERVICE_PORT;
    const self = {};
    await bridgeModule.MatrixBridge.prototype.startAppserviceIntake.call(self);
    expect(self.appserviceRouter).toBeUndefined();
    expect(self.appserviceListener).toBeUndefined();
  });
});

describe('a cosmetic step must not take approval down with it', () => {
  /*
   * An architectural collision found while auditing the remaining single-server assumptions, and it is
   * worth a test because the failure it produced would have been attributed to the wrong thing.
   *
   * An approval room is created by the BOT, on the CONTRIBUTOR's homeserver
   * (`this.botClient.createRoom`). An agent minted for a project side has an account on THAT side's
   * server. Without federation — which ADR-016 stops assuming — it cannot join a room on ours.
   *
   * The join exists to keep the agent visibly attached for a human's benefit. Its own comment says the
   * bot remains the E2EE sender and authorization service and the agent token never submits a verdict.
   * So it is decorative, and it used to THROW: the first approval request for a project-side agent
   * would have failed with "agent failed to join approval room", which reads as approval being broken.
   *
   * Asserted against the source because reaching this branch needs a bot client, a created room and a
   * homeserver that refuses a join — three things whose construction would test none of them.
   */
  test('the approval-room join is best-effort, not fatal', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../bridge-matrix.js', import.meta.url), 'utf8');
    const marker = 'could not join';
    const idx = source.indexOf('[approval-room]');
    expect(idx, 'the approval-room join no longer logs its outcome').toBeGreaterThan(-1);
    expect(source.slice(idx, idx + 400)).toContain(marker);
    // The throw it replaced must be gone: a decorative step cannot be allowed to fail the approval.
    expect(source).not.toContain('throw new Error(`agent failed to join approval room');
  });

  test('the reason names the project-side case, so the log is actionable', async () => {
    // A warning that says only "could not join" sends an operator looking for a permissions bug. The
    // expected cause is that the agent is not on this server at all.
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../bridge-matrix.js', import.meta.url), 'utf8');
    const idx = source.indexOf('[approval-room]');
    const window = source.slice(idx, idx + 600);
    expect(window).toMatch(/project side/);
    expect(window).toMatch(/approval still works/);
  });
});

/*
 * ANSWERING A KNOCK — ADR-016 decision 5's other half.
 *
 * `POST /api/project-sides/:id/knock` returns `awaits: the project side invites the representative`, and
 * until this nothing watched for that invite: the knock sat until an operator happened to look. A knock
 * is a pull, so the next event is theirs, and the appservice intake is the only place it arrives.
 *
 * ACCEPTING AN INVITE IS NOT ACCEPTING WORK, which is what makes automating it safe: joining lets us
 * read what the project asks for, and every request from that room still goes through engagement
 * approval and the side's budget. ADR-014: 「joining a Discord costs the joiner nothing. Lending an agent
 * spends tokens.」
 */
describe('an invite for the representative is a knock being answered', () => {
  const SIDE = 'palpo.test';
  const REP = `@hafleet:${SIDE}`;
  const ROOM = `!market:${SIDE}`;

  const acting = {
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: 'as_secret_never_logged', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
  };

  function self({ sides = { [SIDE]: acting } } = {}) {
    const it = {
      warnings: [],
      postWarning(message, meta) { this.warnings.push({ message, ...meta }); },
      actingSideFor: (id) => sides[String(id).toLowerCase()] ?? null,
    };
    it.onAppserviceMembership = bridgeModule.MatrixBridge.prototype.onAppserviceMembership.bind(it);
    return it;
  }

  const invite = (stateKey = REP, roomId = ROOM) => ({
    type: 'm.room.member', room_id: roomId, state_key: stateKey, content: { membership: 'invite' },
  });

  function capture(ok = true) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers ?? {} });
      return ok
        ? { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
        : { ok: false, status: 403, text: async () => 'M_FORBIDDEN', json: async () => ({}) };
    });
    return calls;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  test('the representative joins, masquerading as itself, on the side', async () => {
    const calls = capture();
    const it = self();
    await it.onAppserviceMembership(SIDE, ROOM, invite());

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/join/${encodeURIComponent(ROOM)}`);
    expect(calls[0].url).toContain(encodeURIComponent(REP));
    expect(calls[0].url.startsWith('http://127.0.0.1:8008/')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('Bearer as_secret_never_logged');

    /*
     * The operator is told, because this is the moment a project becomes reachable and nothing else
     * announces it — and the message says what the join does NOT grant, so nobody reads reachable as
     * approved.
     */
    const said = it.warnings.map((w) => w.message).join(' ');
    expect(said).toMatch(/accepted our knock/);
    expect(said).toMatch(/still go through engagement approval/);
    expect(it.warnings[0].kind).toBe('knock-accepted');
    // Deduped per ROOM, so a homeserver retrying the transaction does not file twice.
    expect(it.warnings[0].scope).toBe(ROOM);
  });

  test('an invite for anyone else is left alone', async () => {
    /*
     * Agents, humans and the bot have their own paths, and an invite for an AGENT is handled at
     * acceptance by the representative rather than here. Acting on all of them would make this a
     * join-anything handler.
     */
    const calls = capture();
    const it = self();
    for (const who of [`@ac_worker:${SIDE}`, `@borrower:${SIDE}`, '@hafleetbot:matrix.example.test']) {
      await it.onAppserviceMembership(SIDE, ROOM, invite(who));
    }
    expect(calls).toHaveLength(0);
  });

  test('only an invite: a join, leave or ban for the representative does nothing', async () => {
    const calls = capture();
    const it = self();
    for (const membership of ['join', 'leave', 'ban', 'knock', undefined]) {
      await it.onAppserviceMembership(SIDE, ROOM, {
        type: 'm.room.member', room_id: ROOM, state_key: REP, content: { membership },
      });
    }
    expect(calls).toHaveLength(0);
  });

  test('a room on another server is refused, even when the invite names our representative', async () => {
    const calls = capture();
    const it = self();
    await it.onAppserviceMembership(SIDE, '!elsewhere:other.example', invite(REP, '!elsewhere:other.example'));
    expect(calls).toHaveLength(0);
  });

  test('a side we hold no acting credential for is ignored', async () => {
    const calls = capture();
    const it = self({ sides: {} });
    await it.onAppserviceMembership(SIDE, ROOM, invite());
    expect(calls).toHaveLength(0);
  });

  test('a failed join is reported, not swallowed', async () => {
    const calls = capture(false);
    const it = self();
    await it.onAppserviceMembership(SIDE, ROOM, invite());
    expect(calls).toHaveLength(1);
    expect(it.warnings.map((w) => w.message).join(' ')).toMatch(/join failed/);
  });
});

/*
 * FORGETTING A REMOVED SIDE'S ROOMS — ADR-016 row 7's last unswept store.
 *
 * The backend's cascade ends at its own records: it cannot reach `bridge-state.json`, and nothing told the
 * bridge to look. The credential refresh is the only signal that ever arrives — a side that was served and
 * is not any more has been removed — so the sweep hangs off the diff rather than off a message nobody
 * sends.
 *
 * IT FORGETS POINTERS, NOT ROOMS. The rooms are on somebody else's homeserver and stay theirs; HAFleet
 * tells project sides exactly that. What is dropped is our claim that those rooms are usable — and in the
 * case of `trustedManagedRooms`, a PERMISSION nobody meant to keep granting.
 */
describe('a removed project side stops being remembered locally', () => {
  const GONE = 'gone.example';
  const KEPT = 'kept.example';

  function bridgeWithState() {
    const st = bridgeModule.bridgeStateForTest();
    st.dmRooms = { 'dm:a': `!one:${GONE}`, 'dm:b': `!two:${KEPT}` };
    st.approvalDmRooms = { 'ap:a': `!three:${GONE}` };
    st.trustedManagedRooms = { [`!one:${GONE}`]: { dm: 'dm:a' }, [`!two:${KEPT}`]: { dm: 'dm:b' } };
    st.groupRoomMap = { work: `!four:${GONE}`, other: `!five:${KEPT}` };
    st.roomGroupMap = { [`!four:${GONE}`]: 'work', [`!five:${KEPT}`]: 'other' };
    const self = {
      dmRooms: new Map(Object.entries(st.dmRooms)),
      warnings: [],
      postWarning(message, meta) { this.warnings.push({ message, ...meta }); },
    };
    self.forgetRoomsOnSides = bridgeModule.MatrixBridge.prototype.forgetRoomsOnSides.bind(self);
    return { self, st };
  }

  test('every pointer to the removed side goes, and the other side keeps all of its own', async () => {
    const { self, st } = bridgeWithState();
    const dropped = self.forgetRoomsOnSides([GONE]);

    expect(dropped).toEqual({ dmRooms: 1, approvalDmRooms: 1, trustedManagedRooms: 1, groupRoomMap: 1 });
    expect(Object.values(st.dmRooms)).toEqual([`!two:${KEPT}`]);
    expect(st.approvalDmRooms).toEqual({});
    expect(Object.keys(st.trustedManagedRooms)).toEqual([`!two:${KEPT}`]);
    expect(st.groupRoomMap).toEqual({ other: `!five:${KEPT}` });
    // Both directions of the group map, or the reverse lookup outlives the forward one.
    expect(st.roomGroupMap).toEqual({ [`!five:${KEPT}`]: 'other' });
    // The live Map is dropped too: it is what the send path reads, and state alone would not help it.
    expect(self.dmRooms.has('dm:a')).toBe(false);
    expect(self.dmRooms.has('dm:b')).toBe(true);
  });

  test('the operator is told, and told that the rooms themselves are untouched', async () => {
    const { self } = bridgeWithState();
    self.forgetRoomsOnSides([GONE]);
    const said = self.warnings.map((w) => w.message).join(' ');
    expect(said).toMatch(/were removed/);
    expect(said).toMatch(/rooms themselves are untouched and remain theirs/);
    expect(self.warnings[0].kind).toBe('project-side-removed');
  });

  test('sweeping a side with nothing on it says nothing at all', async () => {
    const { self } = bridgeWithState();
    const dropped = self.forgetRoomsOnSides(['stranger.example']);
    expect(dropped).toEqual({ dmRooms: 0, approvalDmRooms: 0, trustedManagedRooms: 0, groupRoomMap: 0 });
    expect(self.warnings).toEqual([]);
  });

  test('a SUCCESSFUL refresh that drops a side triggers the sweep', async () => {
    /*
     * The connection between the two halves, and a surviving mutant found it missing: the tests above
     * covered what the sweep DOES and that a failed refresh must not run it, and neither noticed when the
     * refresh stopped calling it at all. A capability nothing invokes is the shape this whole session kept
     * finding — `mintAgentIdentity` had no caller for weeks.
     */
    const swept = [];
    const self = {
      actingCredentials: new Map([[GONE, { sideId: GONE }], [KEPT, { sideId: KEPT }]]),
      forgetRoomsOnSides: (ids) => { swept.push(...ids); },
    };
    // The backend now serves only the side that remains.
    /*
     * `text()`, not `json()`: `backendApi` reads the body as text and parses it itself. A stub that only
     * answered `json()` returned an empty payload, every side looked removed, and the test failed by
     * sweeping the side it was asserting must survive — which is the same class of mistake the code under
     * test exists to prevent.
     */
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sides: [{ sideId: KEPT, serverName: KEPT, apiBaseUrl: 'http://x' }] }),
    }));
    await bridgeModule.MatrixBridge.prototype.refreshActingCredentials.call(self);

    expect(swept).toEqual([GONE]);
    expect(self.actingCredentials.has(KEPT)).toBe(true);
    expect(self.actingCredentials.has(GONE)).toBe(false);
  });

  test('A FAILED REFRESH IS NOT A REMOVAL — the diff runs only when the fetch succeeded', async () => {
    /*
     * The failure this ordering prevents: the backend restarts, the refresh throws, the catch keeps the
     * old credentials — and a diff taken against an empty map would read every side as removed and sweep a
     * live deployment's rooms. Asserted by driving the real refresh against a backend that refuses.
     */
    const st = bridgeModule.bridgeStateForTest();
    st.dmRooms = { 'dm:a': `!one:${GONE}` };
    const self = {
      actingCredentials: new Map([[GONE, { sideId: GONE, serverName: GONE }]]),
      forgetRoomsOnSides: () => { throw new Error('must not sweep on a failed refresh'); },
    };
    vi.stubGlobal('fetch', async () => { throw new Error('backend down'); });
    await expect(bridgeModule.MatrixBridge.prototype.refreshActingCredentials.call(self)).resolves.toBeUndefined();
    // Kept, not emptied: the bridge still believes in the side it last saw.
    expect(self.actingCredentials.has(GONE)).toBe(true);
    expect(st.dmRooms['dm:a']).toBe(`!one:${GONE}`);
  });
});
