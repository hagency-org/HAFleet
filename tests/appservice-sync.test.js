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
      jsonResponse(200, { next_batch: 'CURSOR-1', rooms: { join: { '!r:palpo.example': { timeline: { events: [{ event_id: '$old' }] } } } } }),
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
    expect(handled).toHaveLength(1);
    expect(handled[0].map((e) => e.event_id)).toEqual(['$e1', '$e2']);
    expect(handled[0][0].room_id).toBe('!r:palpo.example');
    expect(cursorStore.value).toBe('CURSOR-2');
    expect(collector.stats.logins).toBe(1);
    expect(collector.stats.processed).toBe(1);
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
  test('multiple intakes configured at once are refused with a naming error', async () => {
    // gap guard: two intakes = every event delivered twice; refusing names the collision
    process.env.HAFLEET_APPSERVICE_PORT = '8095';
    process.env.HAFLEET_APPSERVICE_SYNC_SIDE = 'side-a';
    process.env.HAFLEET_APPSERVICE_SYNC_URL = HS;
    try {
      const proto = (await import('../bridge-matrix.js')).MatrixBridge.prototype;
      await expect(proto.startAppserviceIntake.call({ refreshAppserviceSides: async () => {} }))
        .rejects.toThrow(/multiple intakes/);
    } finally {
      delete process.env.HAFLEET_APPSERVICE_PORT;
      delete process.env.HAFLEET_APPSERVICE_SYNC_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_URL;
    }
  });
});
