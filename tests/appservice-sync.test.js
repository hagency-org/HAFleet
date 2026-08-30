import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAppserviceSyncConfig,
  appserviceLogin,
  appserviceSyncOnce,
  startAppserviceSyncCollector,
} from '../lib/appservice-sync.js';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';

const HS = 'https://palpo.example';
const HS_TOKEN = 'hs-token-1';
/*
 * HARNESS WATCHDOG (5-r1 supplement). Every shouldContinue in this file also consults this
 * absolute iteration counter, so NO test can loop forever even if its primary stop condition
 * is buggy — the 01:59–02:02 OOM was a loop exactly like that. Reset per test; checked with a
 * hard ceiling no legitimate test reaches.
 */
const LIVE_COLLECTORS = [];
/*
 * afterEACH STOP GUARD (5-r2 W): a collector whose loop exits abnormally (fetch threw before the
 * first mock resolved, sleep was a spin) must still be stopped, or the dangling async loop outlives
 * the test — the runaway family again. Every startAppserviceSyncCollector call registers here via
 * the wrapper below.
 */
function makeCollector(...args) { const c = startAppserviceSyncCollector(...args); LIVE_COLLECTORS.push(c); return c; }
afterEach(() => { for (const c of LIVE_COLLECTORS.splice(0)) { try { c.stop(); } catch { /* already stopped */ } } WATCHDOG_TICKS = 0; });
let WATCHDOG_TICKS = 0;
function watchdog(limit = 200) { WATCHDOG_TICKS += 1; if (WATCHDOG_TICKS > limit) throw new Error('test watchdog tripped: runaway loop'); return WATCHDOG_TICKS; }
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { cursorStore.value = v; },
      fetchImpl,
      sleep: async () => { steps += 1; },
      shouldContinue: () => fetchImpl.mock.calls.length < 3 && watchdog() < 200,
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

  test('A: a router failure does NOT advance the cursor; retries are CAPPED and the collector stops', async () => {
    /*
     * Harness hardening (5-r1 supplement): shouldContinue carries a HARD poll cap, sleep is a
     * non-spin mock (records and yields), and the loop's own stop — not a mock-call count —
     * is what ends it. A runaway here is exactly the 01:59–02:02 single-fork OOM shape.
     */
    const failing = { handle: async () => ({ status: 500, body: {} }) };
    const cursorStore = { value: 'CURSOR-0' };
    const HARD_CAP = 50; // far above MAX_DELIVERY_ATTEMPTS; reaching it means the cap failed
    let polls = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockImplementation(async () => {
        polls += 1;
        return jsonResponse(200, { next_batch: 'CURSOR-1', rooms: { join: { '!r:p': { timeline: { events: [{ event_id: '$lost', type: 'm.room.message', content: {} }] } } } } });
      });
    const writes = [];
    const sleeps = [];
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router: failing,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { writes.push(v); cursorStore.value = v; },
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); await Promise.resolve(); },
      shouldContinue: () => polls < HARD_CAP,
    });
    await collector.loop;
    expect(polls).toBeLessThan(HARD_CAP); // the LOOP stopped itself, not the harness
    expect(collector.stats.gaveUp).toBe(true);
    /*
     * THE CAP VALUE IS CONTRACTUAL (5-r2b): the spec says 8, so the break lands EXACTLY on the
     * 8th refusal — not merely "eventually". Pinning the number here is what stops the code and
     * the spec drifting apart again (the 5-r2 ACK claimed 8 while the constant read 12).
     */
    expect(collector.stats.failed).toBe(8);
    expect(collector.stats.batchAttempts).toBe(8);
    expect(sleeps.length).toBeGreaterThan(0); // backoff actually ran
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { cursorStore.value = v; },
      fetchImpl,
      sleep: async () => {},
      shouldContinue: () => fetchImpl.mock.calls.length < 3 && watchdog() < 200,
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async () => {},
      shouldContinue: () => fetchImpl.mock.calls.length < 2 && watchdog() < 200,
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => 'C0', writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => fetchImpl.mock.calls.length < 4 && watchdog() < 200,
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => steps < 3 && watchdog() < 200,
    });
    await collector.loop;
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[1]).toBe(sleeps[0] * 2);
  });

  test('stop() ends the loop', async () => {
    const { router } = makeRouter();
    const collector = makeCollector({
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
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async (ms) => { steps += 1; sleeps.push(ms); },
      shouldContinue: () => steps < 3 && watchdog() < 200,
    });
    await collector.loop;
    expect(collector.stats.logins).toBe(2); // exactly two: t1, t2 — never a third
    expect(sleeps.length).toBeGreaterThan(0); // backed off
  });
});

describe('5-r2 supplement: circuit break, side normalization, invite idempotence', () => {
  test('A-cap: a poison batch circuit-breaks the collector, holds the cursor, warns once', async () => {
    const failing = { handle: async () => ({ status: 500, body: {} }) };
    const cursorStore = { value: 'C0' };
    const HARD_CAP = 60;
    let polls = 0;
    const breaks = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockImplementation(async () => {
        polls += 1;
        return jsonResponse(200, { next_batch: 'POISON', rooms: { join: { '!r:p': { timeline: { events: [{ event_id: '$poison' }] } } } } });
      });
    const writes = [];
    const sleeps = [];
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router: failing,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { writes.push(v); cursorStore.value = v; },
      onCircuitBreak: (s, d) => { breaks.push({ s, d }); },
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); await Promise.resolve(); },
      shouldContinue: () => polls < HARD_CAP && watchdog() < 400,
    });
    await collector.loop;
    expect(polls).toBeLessThan(HARD_CAP);          // the collector stopped ITSELF
    expect(breaks).toHaveLength(1);                // warned exactly once
    expect(breaks[0].s).toBe('side-a');
    // TWO CURSORS, each in its place (5-r3): heldCursor is where a restart RESUMES (the
    // current since), failedNextBatch is the end of the batch that was never committed.
    // Calling nextBatch "the recovery point" was wrong — it names a position never reached.
    expect(breaks[0].d.heldCursor).toBe('C0');
    expect(breaks[0].d.failedNextBatch).toBe('POISON');
    expect(breaks[0].d.attempts).toBe(8);          // spec value, pinned (5-r2b)
    // FAST-BREAK (5-r3): the refusing batch retried at a FIXED 1s. Seven sleeps precede the
    // eighth attempt (which breaks the circuit rather than sleeping again) — attempts 1..7
    // retry, attempt 8 stops. The pinned sequence is what keeps "no climb" honest.
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(writes).toEqual([]);                    // cursor never advanced
    expect(cursorStore.value).toBe('C0');          // held at the pre-poison position
    expect(collector.stats.gaveUp).toBe(true);
  });

  test('D-norm: side names are normalized before the mutex (case, trailing slash, URL form)', () => {
    // case-folded: Side-A and side-a are ONE side
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 'Side-A', HAFLEET_APPSERVICE_SYNC_URL: HS }))
      .toMatchObject({ enabled: true, side: 'side-a' });
    // URL-shaped and slash-suffixed side values are refused outright
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 'https://palpo.example', HAFLEET_APPSERVICE_SYNC_URL: HS }).enabled).toBe(false);
    expect(resolveAppserviceSyncConfig({ HAFLEET_APPSERVICE_SYNC_SIDE: 'side-a/', HAFLEET_APPSERVICE_SYNC_URL: HS }).enabled).toBe(false);
  });

  test('D-norm: edge Side-A + sync side-a is refused as the SAME side', async () => {
    process.env.HAFLEET_EDGE_URL = 'http://127.0.0.1:8095';
    process.env.HAFLEET_EDGE_LINK_TOKEN = 'link-secret';
    process.env.HAFLEET_EDGE_SIDE = 'Side-A';               // different spelling, same side
    process.env.HAFLEET_APPSERVICE_SYNC_SIDE = 'side-a';
    process.env.HAFLEET_APPSERVICE_SYNC_URL = HS;
    try {
      const proto = (await import('../bridge-matrix.js')).MatrixBridge.prototype;
      await expect(proto.startAppserviceIntake.call({ refreshAppserviceSides: async () => {} }))
        .rejects.toThrow(/both configured for side side-a/);
    } finally {
      delete process.env.HAFLEET_EDGE_URL;
      delete process.env.HAFLEET_EDGE_LINK_TOKEN;
      delete process.env.HAFLEET_EDGE_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_SIDE;
      delete process.env.HAFLEET_APPSERVICE_SYNC_URL;
    }
  });

  test('B-idem: a repeated invite (restart redelivery) is harmless', async () => {
    /*
     * Invite-section events carry no event_id, so dedup CANNOT make them idempotent — the
     * join itself and the bridge's trust reconciliation must. What this pins is that a
     * redelivered invite goes through the router a second time without erroring and without
     * corrupting the loop state; semantic idempotence lives in the join path.
     */
    const handled = [];
    const router = createAppserviceRouter({ sides: [{ sideId: 'side-a', hsToken: HS_TOKEN, onEvents: async (evs) => { handled.push(evs); } }] });
    const inviteSection = { '!inv:p': { invite_state: { events: [{ type: 'm.room.member', state_key: '@hafleet:p', content: { membership: 'invite' } }] } } };
    // Two polls, ADVANCING cursors (the homeserver moved on) but the SAME invite still pending —
    // the redelivery shape a restart or a slow join produces. Same-cursor repeats are absorbed by
    // the txn-key dedup instead; both halves are pinned here.
    const bodies = [
      { next_batch: 'I1', rooms: { invite: inviteSection } },
      { next_batch: 'I2', rooms: { invite: inviteSection } },
    ];
    let polls = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 't1', user_id: '@hafleet:p' }))
      .mockImplementation(async () => { const b = bodies[Math.min(polls, 1)]; polls += 1; return jsonResponse(200, b); });
    const cursorStore = { value: null };
    const collector = makeCollector({
      baseUrl: HS, side: 'side-a', router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS_TOKEN, hsToken: HS_TOKEN, senderLocalpart: 'hafleet' }),
      readCursor: () => cursorStore.value,
      writeCursor: async (v) => { cursorStore.value = v; },
      fetchImpl,
      sleep: async (ms) => { await Promise.resolve(); },
      shouldContinue: () => polls < 2 && watchdog() < 400,
    });
    await collector.loop;
    expect(handled.length).toBe(2); // delivered twice (same invite section both polls)
    expect(handled[0]).toEqual(handled[1]); // byte-identical: no drift, no error
    expect(collector.stats.lastError).toBe(null);
  });
});

describe('5-r3: real-side-effect invite idempotence (join path)', () => {
  test('B-real: the same invite delivered twice produces two joins and the second is absorbed by the homeserver, not by HAFleet', async () => {
    /*
     * REAL SIDE EFFECTS this time (5-r3 B), not just collector-boundary redelivery. The invite
     * travels the full path — collector → router → onEvents → onAppserviceMembership → the
     * homeserver's /join endpoint — twice, with a fake homeserver that COUNTS joins and always
     * answers 200 (an already-joined room joins again fine: Matrix join is idempotent at the
     * server). What must hold: both deliveries reach /join (HAFleet does NOT dedup invites —
     * they carry no event_id), each join succeeds, and no error state accumulates. The
     * absorbing layer is deliberately the homeserver; claiming HAFleet-side dedup would be
     * false, and this test pins that honesty.
     */
    const joins = [];
    const joinFetch = vi.fn(async (url) => {
      joins.push(String(url));
      return jsonResponse(200, { room_id: '!inv:p' });
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = joinFetch;
    const membershipEvents = [];
    const warnings = [];
    const bridge = {
      actingSideFor: () => ({ side: { apiBaseUrl: 'https://hs.example' }, credential: { asToken: 'as1', senderLocalpart: 'hafleet' } }),
      postWarning: async (msg, meta) => { warnings.push({ msg, meta }); },
    };
    // Drive the MEMBERSHIP dispatch twice through the real method shape
    const proto = (await import('../bridge-matrix.js')).MatrixBridge.prototype;
    for (let i = 0; i < 2; i += 1) {
      await proto.onAppserviceMembership.call(bridge, 'palpo.example', '!inv:palpo.example', {
        type: 'm.room.member',
        state_key: '@hafleet:palpo.example',
        content: { membership: 'invite' },
      });
      expect(watchdog() < 100).toBe(true);
    }
    globalThis.fetch = realFetch;
    expect(joins).toHaveLength(2);                       // both invites joined — no HAFleet dedup
    expect(joins[0]).toBe(joins[1]);                     // identical join request each time
    expect(joins[0]).toContain('/_matrix/client/v3/join/');
    expect(joins[0]).toContain('user_id=%40hafleet%3Apalpo.example'); // masquerade intact both times
    // and the room-server guard: an invite naming a foreign room must NOT join at all
    const foreignJoins = [];
    const fk = vi.fn(async (u) => { foreignJoins.push(String(u)); return jsonResponse(200, {}); });
    globalThis.fetch = fk;
    await proto.onAppserviceMembership.call(bridge, 'palpo.example', '!room:other.example', {
      type: 'm.room.member', state_key: '@hafleet:palpo.example', content: { membership: 'invite' },
    });
    globalThis.fetch = realFetch;
    expect(foreignJoins).toEqual([]);                    // origin guard held on the repeat path too
  });
});
