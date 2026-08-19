/*
 * The co-located appservice, and the one property that must never break.
 *
 * WHY IT EXISTS. An appservice is inbound: the homeserver pushes to the `url` in its registration, so that
 * url had to point at HAFleet — impossible for a fleet on a laptop or an internal network without exposing
 * it. The operator named both the problem and the fix: 「我的 agent 都在内网…你这个设计是错的」, then
 * 「app service 不能和 matrix 服务器 co locate 吗」. Co-located, the homeserver dials loopback and HAFleet
 * dials out, so nothing needs to be reachable from outside.
 *
 * THE PROPERTY: a 200 to the homeserver means the events were PROCESSED, not received. Matrix retries on
 * anything else, which is what keeps events from being lost — and acknowledging on receipt across a network
 * would tell a homeserver "handled" about events still in flight to a laptop that might never see them.
 * Most of the tests below are that one sentence, from each direction it can fail.
 */
import { describe, expect, test, vi } from 'vitest';
import { createAppserviceEdge } from '../lib/appservice-edge.js';
import { resolveEdgeLinkConfig, startEdgePuller } from '../lib/appservice-puller.js';

const HS = 'hs-token-value';
const LINK = 'link-token-value';

function edge(overrides = {}) {
  return createAppserviceEdge({ hsToken: HS, linkToken: LINK, ...overrides });
}

const asHomeserver = (path, body, token = HS) => ({
  method: 'PUT', path, headers: { authorization: `Bearer ${token}` }, body,
});
const asHafleet = (path, method = 'GET', body = null, token = LINK) => ({
  method, path, headers: { 'x-hafleet-link': token }, body,
});

describe('the doorway holds the homeserver until HAFleet has processed', () => {
  test('a transaction is not answered before it has been acknowledged', async () => {
    const e = edge();
    let settled = null;
    const pending = e.handle(asHomeserver('/_matrix/app/v1/transactions/t1', { events: [{ id: 1 }] }))
      .then((r) => { settled = r; });

    // Nothing yet: this is the whole design, and a 200 here would be a lie about durability.
    await Promise.resolve();
    expect(settled).toBeNull();

    const pulled = await e.handle(asHafleet('/_hafleet/edge/pull'));
    expect(pulled.body).toEqual({ txn_id: 't1', events: [{ id: 1 }] });

    await e.handle(asHafleet('/_hafleet/edge/ack', 'POST', { txn_id: 't1', ok: true }));
    await pending;
    expect(settled).toMatchObject({ status: 200 });
  });

  test('HAFleet reporting failure becomes a 500, so the homeserver retries', async () => {
    // The same contract the in-process receiver keeps when `onEvents` throws. Swallowing it would drop
    // events that nobody would ever be asked for again.
    const e = edge();
    let settled = null;
    const pending = e.handle(asHomeserver('/_matrix/app/v1/transactions/t2', { events: [] }))
      .then((r) => { settled = r; });
    await e.handle(asHafleet('/_hafleet/edge/pull'));
    await e.handle(asHafleet('/_hafleet/edge/ack', 'POST', { txn_id: 't2', ok: false }));
    await pending;
    expect(settled.status).toBe(500);
  });

  test('an ack for the wrong transaction is refused', async () => {
    /*
     * The one check whose absence loses data silently: releasing a transaction HAFleet has not processed
     * would tell the homeserver it was handled, and those events are never sent again.
     */
    const e = edge();
    let settled = null;
    const pending = e.handle(asHomeserver('/_matrix/app/v1/transactions/real', { events: [] }))
      .then((r) => { settled = r; });
    await e.handle(asHafleet('/_hafleet/edge/pull'));

    const wrong = await e.handle(asHafleet('/_hafleet/edge/ack', 'POST', { txn_id: 'other', ok: true }));
    expect(wrong.status).toBe(409);
    expect(settled).toBeNull(); // still held

    await e.handle(asHafleet('/_hafleet/edge/ack', 'POST', { txn_id: 'real', ok: true }));
    await pending;
    expect(settled.status).toBe(200);
  });

  test('no acknowledgement in time is a retryable 500, not a hang', async () => {
    vi.useFakeTimers();
    try {
      const e = createAppserviceEdge({ hsToken: HS, linkToken: LINK, deliverTimeoutMs: 1000 });
      let settled = null;
      const pending = e.handle(asHomeserver('/_matrix/app/v1/transactions/t3', { events: [] }))
        .then((r) => { settled = r; });
      await vi.advanceTimersByTimeAsync(1001);
      await pending;
      expect(settled.status).toBe(500);
      expect(e.traffic().timedOut).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('shutting down releases what is held rather than dropping it', async () => {
    // A held request that dies with the process is a transaction the homeserver never hears about again
    // until it times out on its own. Answering 500 asks for it immediately.
    const e = edge();
    let settled = null;
    const pending = e.handle(asHomeserver('/_matrix/app/v1/transactions/t4', { events: [] }))
      .then((r) => { settled = r; });
    e.close();
    await pending;
    expect(settled.status).toBe(500);
  });
});

describe('what the doorway refuses', () => {
  test('a bad hs_token is rejected and counted apart from real traffic', () => {
    // Rejected traffic proves reachability and disproves the token — the inverse diagnosis from silence,
    // so adding them together would send an operator to look in the wrong place.
    const e = edge();
    return e.handle(asHomeserver('/_matrix/app/v1/transactions/x', { events: [] }, 'wrong')).then((r) => {
      expect(r.status).toBe(403);
      expect(e.traffic()).toMatchObject({ rejected: 1, transactions: 0 });
    });
  });

  test('the link token is not the hs_token', async () => {
    /*
     * Two secrets because there are two relationships. Reusing the hs_token would mean anyone who can read
     * the registration — a file on the homeserver's own disk — could drain this queue, and draining it is
     * reading the room's traffic.
     */
    const e = edge();
    expect((await e.handle(asHafleet('/_hafleet/edge/pull', 'GET', null, HS))).status).toBe(403);
    expect((await e.handle(asHafleet('/_hafleet/edge/status', 'GET', null, 'nope'))).status).toBe(403);
  });

  test('a second poller is refused rather than racing the first', async () => {
    // Two pollers would race for one transaction and one would ack work it never received.
    const e = edge();
    e.handle(asHafleet('/_hafleet/edge/pull'));
    await Promise.resolve();
    expect((await e.handle(asHafleet('/_hafleet/edge/pull'))).status).toBe(409);
    e.close();
  });

  test('a second transaction while one is in flight gets a retryable 500', async () => {
    // Ordering is the guarantee the appservice spec makes; depth is not. A 200 to get rid of it would be
    // telling the homeserver it was handled by something that never saw it.
    const e = edge();
    e.handle(asHomeserver('/_matrix/app/v1/transactions/first', { events: [] }));
    await Promise.resolve();
    const second = await e.handle(asHomeserver('/_matrix/app/v1/transactions/second', { events: [] }));
    expect(second.status).toBe(500);
    e.close();
  });

  test('a user query is answered here rather than forwarded', async () => {
    // The answer never varies — this appservice creates no accounts on demand — so a round trip to a
    // laptop would add latency to a constant.
    const e = edge();
    const res = await e.handle({ method: 'GET', path: '/_matrix/app/v1/users/@x:y', headers: { authorization: `Bearer ${HS}` } });
    expect(res.status).toBe(404);
  });

  test('status reports the address the HOMESERVER must dial, which is not the one HAFleet collects from', async () => {
    /*
     * THE TWO ADDRESSES THAT GOT CONFLATED, and it produced a silent dead inbound path.
     *
     * Walked on a clean pair of machines: the console pre-filled the registration with `HAFLEET_EDGE_URL`
     * (`http://69.194.3.128:8097`, how HAFleet reaches this edge) while the edge, bound to loopback, printed
     * `put this in the registration: url: http://127.0.0.1:8097`. The homeserver could not reach a public IP
     * that nothing listened on, so it never called — and `verify` still answered `accepted`, because
     * verification proves the OUTBOUND direction only. Every screen said the customer was onboarded; the
     * edge's own counter read `transactions from the homeserver: 0`.
     *
     * This process owns the socket, so it is the only honest source for that address.
     */
    const e = createAppserviceEdge({ hsToken: HS, linkToken: LINK, registrationUrl: 'http://127.0.0.1:8094' });
    const body = (await e.handle(asHafleet('/_hafleet/edge/status'))).body;
    expect(body.registrationUrl).toBe('http://127.0.0.1:8094');
  });

  test('an edge that was not told its address reports null rather than inventing one', async () => {
    // Null is what makes the console refuse to issue. A fabricated address would be the original defect.
    const body = (await edge().handle(asHafleet('/_hafleet/edge/status'))).body;
    expect(body.registrationUrl).toBeNull();
  });

  test('status reports counts and a fingerprint, never a token', async () => {
    const e = edge();
    const body = (await e.handle(asHafleet('/_hafleet/edge/status'))).body;
    expect(body.hsTokenFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain(HS);
    expect(JSON.stringify(body)).not.toContain(LINK);
  });
});

describe('deciding whether an edge link is configured at all', () => {
  test('nothing set means not in use, which is not an error', () => {
    expect(resolveEdgeLinkConfig({})).toMatchObject({ enabled: false });
  });

  test.each([
    ['url without token', { HAFLEET_EDGE_URL: 'http://h:1', HAFLEET_EDGE_SIDE: 's' }],
    ['token without url', { HAFLEET_EDGE_LINK_TOKEN: 't', HAFLEET_EDGE_SIDE: 's' }],
    ['url and token without a side', { HAFLEET_EDGE_URL: 'http://h:1', HAFLEET_EDGE_LINK_TOKEN: 't' }],
    ['a url that is not a url', { HAFLEET_EDGE_URL: 'h:1', HAFLEET_EDGE_LINK_TOKEN: 't', HAFLEET_EDGE_SIDE: 's' }],
  ])('%s is refused with a reason, not treated as off', (_label, env) => {
    // Half-configured means somebody was mid-setup. Silently doing nothing is how that gets shipped.
    const result = resolveEdgeLinkConfig(env);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('all three set is enabled', () => {
    expect(resolveEdgeLinkConfig({
      HAFLEET_EDGE_URL: 'http://edge:8094/', HAFLEET_EDGE_LINK_TOKEN: 't', HAFLEET_EDGE_SIDE: 'acme.test',
    })).toMatchObject({ enabled: true, url: 'http://edge:8094', side: 'acme.test' });
  });
});

describe('HAFleet collecting from an edge', () => {
  /** An edge driven in-process, so the pair is tested end to end without a socket. */
  function linked() {
    const e = edge();
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      const result = await e.handle({
        method: init.method || 'GET',
        path,
        headers: init.headers || {},
        body: init.body ? JSON.parse(init.body) : null,
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      };
    };
    return { e, fetchImpl };
  }

  test('a transaction reaches the router and the homeserver is then answered 200', async () => {
    /*
     * The seam that matters: the puller must drive the SAME router the local listener drives, with a
     * request shaped as the homeserver would shape it. A privileged short-cut would mean the co-located
     * path skipped a check the local path enforces.
     */
    const { e, fetchImpl } = linked();
    const seen = [];
    const router = {
      handle: async (req) => {
        seen.push(req);
        return { status: 200, body: {} };
      },
    };
    const puller = startEdgePuller({
      url: 'http://edge.test',
      token: LINK,
      router,
      hsTokenFor: () => HS,
      fetchImpl,
      sleep: () => Promise.resolve(),
      shouldContinue: () => seen.length < 1,
    });

    let answered = null;
    const held = e.handle(asHomeserver('/_matrix/app/v1/transactions/tx9', { events: [{ a: 1 }] }))
      .then((r) => { answered = r; });

    await puller.done;
    await held;

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/_matrix/app/v1/transactions/tx9');
    expect(seen[0].headers.authorization).toBe(`Bearer ${HS}`);
    expect(seen[0].body).toEqual({ events: [{ a: 1 }] });
    expect(answered).toMatchObject({ status: 200 });
  });

  test('a router failure is passed back as a failed ack, so the homeserver retries', async () => {
    const { e, fetchImpl } = linked();
    let rounds = 0;
    const router = { handle: async () => { rounds += 1; return { status: 500, body: {} }; } };
    const puller = startEdgePuller({
      url: 'http://edge.test',
      token: LINK,
      router,
      hsTokenFor: () => HS,
      fetchImpl,
      sleep: () => Promise.resolve(),
      shouldContinue: () => rounds < 1,
    });

    let answered = null;
    const held = e.handle(asHomeserver('/_matrix/app/v1/transactions/tx10', { events: [] }))
      .then((r) => { answered = r; });
    await puller.done;
    await held;
    expect(answered.status).toBe(500);
    expect(puller.stats()).toMatchObject({ collected: 1, failed: 1 });
  });

  test('the hs_token comes from our own store, never from the link', async () => {
    // HAFleet issued it. Sending it back over the wire would put a credential in flight for nothing, and
    // an edge that could choose it could authenticate as any side.
    const { e, fetchImpl } = linked();
    const seen = [];
    const router = { handle: async (r) => { seen.push(r); return { status: 200, body: {} }; } };
    const puller = startEdgePuller({
      url: 'http://edge.test',
      token: LINK,
      router,
      hsTokenFor: () => 'from-our-own-store',
      fetchImpl,
      sleep: () => Promise.resolve(),
      shouldContinue: () => seen.length < 1,
    });
    const held = e.handle(asHomeserver('/_matrix/app/v1/transactions/tx11', { events: [] }));
    await puller.done;
    await held;
    expect(seen[0].headers.authorization).toBe('Bearer from-our-own-store');
  });

  test('a rejected link token is reported rather than quietly backed off forever', async () => {
    // The one failure an operator can fix immediately, so it must not be buried under an ever-quieter retry.
    const { fetchImpl } = linked();
    const errors = [];
    let tries = 0;
    const puller = startEdgePuller({
      url: 'http://edge.test',
      token: 'wrong',
      router: { handle: async () => ({ status: 200, body: {} }) },
      hsTokenFor: () => HS,
      fetchImpl,
      logger: { error: (m) => errors.push(m), warn: () => {} },
      sleep: () => { tries += 1; return Promise.resolve(); },
      shouldContinue: () => tries < 1,
    });
    await puller.done;
    expect(errors.join(' ')).toMatch(/link token/i);
  });

  test('it needs a router and a token source rather than defaulting to something', () => {
    expect(() => startEdgePuller({ url: 'http://x', token: 't' })).toThrow(/router/);
    expect(() => startEdgePuller({ url: 'http://x', token: 't', router: { handle: () => {} } })).toThrow(/hsTokenFor/);
  });
});
