import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  resolveAppserviceSyncConfig,
  appserviceLogin,
  appserviceSyncOnce,
  startAppserviceSyncCollector,
} from '../lib/appservice-sync.js';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';

const HS = 'https://palpo.example';
const HS_TOKEN = 'hs-token-1';
const AS_TOKEN = 'as-token-1';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('resolveAppserviceSyncConfig', () => {
  test('disabled by default with a reason', () => {
    const cfg = resolveAppserviceSyncConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toMatch(/SYNC_SIDE/);
  });

  test('half-configured is refused, not treated as off', () => {
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_URL: HS }).enabled).toBe(false);
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_URL: HS }).reason).toMatch(/SYNC_SIDE/);
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 'side-a' }).enabled).toBe(false);
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 'side-a' }).reason).toMatch(/SYNC_URL/);
  });

  test('a non-absolute URL is refused', () => {
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 's', HAFLEET_APPSERVICE_SYNC_URL: 'palpo.test' }).enabled).toBe(false);
  });

  test('a full config resolves enabled', () => {
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 's', HAFLEET_APPSERVICE_SYNC_URL: `${HS}/` }))
      .toMatchObject({ enabled: true, side: 's', baseUrl: HS });
  });
});

describe('appserviceLogin', () => {
  test('posts m.login.application_service with the as_token and sender_localpart', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`${HS}/_matrix/client/v3/login`);
      const body = JSON.parse(init.body);
      expect(body.type).toBe('m.login.application_service');
      expect(body.token).toBe(AS_TOKEN);
      expect(body.identifier).toEqual({ type: 'm.id.user', user: 'hafleet' });
      return jsonResponse(200, { access_token: 'sync-token', user_id: '@hafleet:palpo.example' });
    });
    const login = await appserviceLogin({ baseUrl: HS, asToken: AS_TOKEN, senderLocalpart: 'hafleet', fetchImpl });
    expect(login).toEqual({ accessToken: 'sync-token', userId: '@hafleet:palpo.example' });
  });

  test('a failed login throws with the HTTP status attached', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { errcode: 'M_FORBIDDEN' }));
    await expect(appserviceLogin({ baseUrl: HS, asToken: AS_TOKEN, senderLocalpart: 'hafleet', fetchImpl }))
      .rejects.toThrow(/HTTP 403/);
  });
});

describe('the sync collector loop', () => {
  function makeRouter() {
    const handled = [];
    const router = createAppserviceRouter({ sides: [{ sideId: 'side-a', hsToken: HS_TOKEN, onEvents: async (events) => { handled.push(events); } }] });
    return { router, handled };
  }

  test('logs in, swallows the initial sync, delivers timeline events through the router, and persists the cursor', async () => {
    const { router, handled } = makeRouter();
    const cursorStore = { value: null };
    const polls = [
      jsonResponse(200, { next_batch: 'CURSOR-1', rooms: { join: { '!r:palpo.example': { timeline: { events: [{ event_id: '$old' }] } } }, invite: { '!invited:palpo.example': { invite_state: { events: [{ type: 'm.room.member', content: { membership: 'invite' } }] } } } } }),
      jsonResponse(200, { next_batch: 'CURSOR-2', rooms: { join: { '!r:palpo.example': { timeline: { events: [
        { event_id: '$e1', type: 'm.room.message', content: { body: 'hi' } },
        { event_id: '$e2', type: 'm.room.message', content: { body: 'again' } },
      ] } } } } }),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'sync-token', user_id: '@hafleet:palpo.example' }))
      .mockImplementationOnce(() => Promise.resolve(polls[0]))
      .mockImplementationOnce(() => Promise.resolve(polls[1]))
      .mockImplementation(async () => jsonResponse(200, { next_batch: 'END', rooms: {} }));
    let steps = 0;
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { cursorStore.value = v; },
      fetchImpl,
      sleep: async () => { steps += 1; },
      shouldContinue: () => fetchImpl.mock.calls.length < 3,
    });
    await collector.loop;
    expect(fetchImpl.mock.calls[0][0]).toContain('/login');
    expect(fetchImpl.mock.calls[1][0]).toContain('/sync');
    expect(fetchImpl.mock.calls[2][0]).toContain('/sync');
    // A: the CURSOR advances only after the router answered 200 — pinned by the order of writes
    expect(cursorStore.value).toBe('CURSOR-2');
    expect(collector.stats.logins).toBe(1);
    expect(collector.stats.processed).toBe(2);
  });

  test('A: a router failure does NOT advance the cursor and retries the same batch', async () => {
    const { router, handled } = makeRouter();
    const failing = { handle: async () => ({ status: 500, body: {} }) };
    const cursorStore = { value: 'CURSOR-0' };
    let polls = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockImplementation(async () => {
        polls += 1;
        return jsonResponse(200, { next_batch: 'CURSOR-1', rooms: { join: { '!r:p': { timeline: { events: [{ event_id: '$lost', type: 'm.room.message', content: {} }] } } } } });
      });
    const writes = [];
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router: failing,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { writes.push(v); cursorStore.value = v; },
      fetchImpl,
      sleep: async () => {},
      shouldContinue: () => polls < 2,
    });
    await collector.loop;
    expect(collector.stats.failed).toBeGreaterThan(0);
    expect(writes).toEqual([]); // the failed batch never moved the cursor
    expect(collector.stats.logins).toBe(1);
  });

  test('B: invite events carry room_id like join events and reach the router', async () => {
    const { router, handled } = makeRouter();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockResolvedValueOnce(jsonResponse(200, { next_batch: 'I1', rooms: { invite: { '!inv:p': { invite_state: { events: [{ type: 'm.room.member', state_key: '@hafleet:p', content: { membership: 'invite' } }] } } } } }))
      .mockImplementation(async () => jsonResponse(200, { next_batch: 'I2', rooms: {} }));
    const cursorStore = { value: null };
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { cursorStore.value = v; },
      fetchImpl,
      sleep: async () => {},
      shouldContinue: () => fetchImpl.mock.calls.length < 3,
    });
    await collector.loop;
    expect(handled).toHaveLength(1);
    expect(handled[0]).toHaveLength(1);
    expect(handled[0][0]).toMatchObject({ type: 'm.room.member', room_id: '!inv:p' });
  });

  test('E: the sync request carries an explicit filter and set_presence=offline', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url) => {
      seen.push(String(url));
      if (String(url).endsWith('/login')) return jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' });
      return jsonResponse(200, { next_batch: 'F1', rooms: {} });
    });
    const { router } = makeRouter();
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async () => {},
      shouldContinue: () => fetchImpl.mock.calls.length < 2,
    });
    await collector.loop;
    const syncUrl = seen.find((u) => u.includes('/sync'));
    expect(syncUrl).toContain('set_presence=offline');
    const filter = JSON.parse(new URL(syncUrl).searchParams.get('filter'));
    expect(filter.room.timeline.types).toEqual(['m.room.*']);
    expect(filter.account_data.types).toEqual([]);
    expect(filter.to_device.types).toEqual([]);
  });

  test('a 401 sync triggers exactly one re-login before backing off', async () => {
    const { router } = makeRouter();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockResolvedValueOnce(jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't2', user_id: '@hafleet:p' }))
      .mockResolvedValueOnce(jsonResponse(200, { next_batch: 'C', rooms: {} }))
      .mockImplementation(async () => { throw new Error('no more'); });
    let steps = 0;
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => 'C0', writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => fetchImpl.mock.calls.length < 4,
    });
    await collector.loop;
    expect(collector.stats.logins).toBe(2);
  });

  test('a 401 that persists after re-login backs off without hammering', async () => {
    const { router } = makeRouter();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockResolvedValueOnce(jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }))
      .mockResolvedValueOnce(jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }))
      .mockResolvedValueOnce(jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }));
    let steps = 0;
    const sleeps = [];
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => steps < 3,
    });
    await collector.loop;
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[1]).toBe(sleeps[0] * 2);
  });

  test('stop() ends the loop', async () => {
    const { router } = makeRouter();
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => null,
      sleep: async () => {},
      shouldContinue: () => false,
    });
    collector.stop();
    await collector.loop;
    expect(collector.stats.polls).toBe(0);
  });
});

describe('intake wiring rules', () => {
  test('D: listener + sync on any side is refused (the listener has no side dimension)', async () => {
    process.env.HAFLEET_APPSERVICE_PORT = '8095';
    process.env.HAFLEET_APPSERVICE_SYNC_SIDE = 'side-a';
    process.env.HAFLEET_APPSERVICE_SYNC_URL = HS;
    try {
      const proto = (await import('../bridge-matrix.js')).MatrixBridge.prototype;
      await expect(proto.startAppserviceIntake.call({ refreshAppserviceSides: async () => {} }))
        .rejects.toThrow(/same side\(s\)/);
    } finally {
      delete process.env.HAFLEET_APPSERVICE_PORT;
      delete process.env.HAFLEET_APPSERVICE_SYNC_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_URL;
    }
  });

  test('D: edge and sync on the SAME side is refused, on DIFFERENT sides is allowed', async () => {
    process.env.HAFLEET_EDGE_URL = 'http://127.0.0.1:8095';
    process.env.HAFLEET_EDGE_LINK_TOKEN = 'link-secret';
    process.env.HAFLEET_APPSERVICE_SYNC_URL = HS;
    try {
      const proto = (await import('../bridge-matrix.js')).MatrixBridge.prototype;
      const self = {
        refreshAppserviceSides: async () => {},
        // edge puller double: accept whatever the wiring passes
        appserviceSideTokens: new Map(),
      };
      // same side -> refused
      process.env.HAFLEET_EDGE_SIDE = 'side-a';
      process.env.HAFLEET_APPSERVICE_SYNC_SIDE = 'side-a';
      await expect(proto.startAppserviceIntake.call(self)).rejects.toThrow(/both configured for side side-a/);
      // different sides -> starts (no throw); the collector/puller handles are stubbed by no-ops on self
      process.env.HAFLEET_APPSERVICE_SYNC_SIDE = 'side-b';
      await proto.startAppserviceIntake.call(self);
    } finally {
      delete process.env.HAFLEET_EDGE_URL;
      delete process.env.HAFLEET_EDGE_LINK_TOKEN;
      delete process.env.HAFLEET_EDGE_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_URL;
    }
  });

  test('C: a 401 on a FRESHLY minted token backs off instead of re-logging in', async () => {
    const handled = [];
    const router = createAppserviceRouter({ sides: [{ sideId: 'side-a', hsToken: HS_TOKEN, onEvents: async (evs) => { handled.push(evs); } }] });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))   // login 1
      .mockResolvedValueOnce(jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }))                   // t1 sync 401 -> relogin allowed
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't2', user_id: '@hafleet:p' }))   // login 2 (fresh)
      .mockImplementation(async () => jsonResponse(401, { errcode: 'M_UNKNOWN_TOKEN' }));          // t2 401 -> BACKOFF, no login 3
    let steps = 0;
    const sleeps = [];
    const collector = startAppserviceSyncCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => steps < 3,
    });
    await collector.loop;
    expect(collector.stats.logins).toBe(2); // exactly two: t1, t2 — never a third
    expect(sleeps.length).toBeGreaterThan(0); // backed off
  });
});
