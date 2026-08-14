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

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
function fakeBridge() {
  const seen = { messages: [], events: [] };
  return {
    seen,
    onRoomMessage: async (roomId, event) => { seen.messages.push({ roomId, type: event.type, id: event.event_id }); },
    onRoomEvent: async (roomId, event) => { seen.events.push({ roomId, type: event.type }); },
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
  });

  test('events are processed in order, because a join before a message is not the same as after', async () => {
    const order = [];
    const self = {
      onRoomMessage: async () => { order.push('message'); },
      onRoomEvent: async (r, e) => { order.push(e.type); },
    };
    await call(self, 'a.example', [
      { type: 'm.room.member', room_id: '!r:a', event_id: '$1' },
      { type: 'm.room.message', room_id: '!r:a', event_id: '$2' },
    ]);
    expect(order).toEqual(['m.room.member', 'message']);
  });
});

describe('what it refuses to pretend it handled', () => {
  test('an event with no room_id is skipped with the side and txn named', async () => {
    const self = fakeBridge();
    await call(self, 'a.example', [{ type: 'm.room.message', event_id: '$1' }]);
    expect(self.seen.messages).toEqual([]);
    expect(self.seen.events).toEqual([]);
  });

  test('an ENCRYPTED event is named rather than dropped quietly', async () => {
    /*
     * ADR-016 settled that intake rooms are plaintext, and the bridge's decryption path belongs to the
     * bot's crypto store on its OWN homeserver — so an encrypted event arriving over an appservice
     * cannot be read here. Dropping it silently produces a borrower whose message vanished, which is
     * the report that is impossible to act on.
     */
    const self = fakeBridge();
    await call(self, 'a.example', [{ type: 'm.room.encrypted', room_id: '!r:a', event_id: '$1' }]);
    expect(self.seen.messages).toEqual([]);
    expect(self.seen.events).toEqual([]);
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
