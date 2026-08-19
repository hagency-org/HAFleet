/*
 * What the setup screen is told about inbound reachability — and specifically WHICH address it hands the
 * customer.
 *
 * THE DEFECT THIS FILE EXISTS FOR, found by building a clean HAFleet on one machine and a clean customer
 * homeserver on another and following the operator guide click by click.
 *
 * There are two addresses for one edge socket and they are not the same:
 *
 *   HAFLEET_EDGE_URL   how HAFleet COLLECTS from the edge. Outbound, from wherever HAFleet runs.
 *   registration url   how the HOMESERVER dials the edge. Loopback, because co-located is the point.
 *
 * The console pre-filled the registration with the first one. On the walkthrough that produced
 * `url: "http://69.194.3.128:8097"` in the file installed on the customer's homeserver, while the edge —
 * bound to loopback, as it should be — printed `put this in the registration: url: http://127.0.0.1:8097`.
 * The homeserver never called. And `POST .../verify` answered **accepted**, because verification exercises
 * the OUTBOUND direction only: HAFleet could act as the representative perfectly well. So every screen said
 * the customer was onboarded while the only way in was dead, and the sole contrary evidence was the edge's
 * own counter reading `transactions from the homeserver: 0`.
 *
 * The fix is ownership: the edge process owns its socket, so it reports the address, and HAFleet asks rather
 * than guesses. When it cannot ask, it says so instead of falling back to the guess — which is the whole
 * defect in one line.
 */
import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createServer } from 'http';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const API_TOKEN = 'operator-token-reach';
const LINK = 'edge-link-token-reach';

let context = null;
let fake = null;

afterEach(async () => {
  context?.cleanup();
  context = null;
  if (fake) {
    await new Promise((resolve) => fake.server.close(resolve));
    fake = null;
  }
});

/** An edge that answers `/status` however the test says, on an ephemeral port. */
async function fakeEdge(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, link: req.headers['x-hafleet-link'] ?? null });
    const [status, payload] = handler(req.url);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake = { server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` };
  return fake;
}

async function boot(env) {
  context = await createBackendTestContext('api-matrix-reach-', { agents: {}, env: { API_TOKEN, ...env } });
  return context.app;
}

const reach = async (app) => (await request(app).get('/api/matrix/reach')
  .set('Authorization', `Bearer ${API_TOKEN}`)).body;

describe('the address a co-located edge tells us to put in the registration', () => {
  test('it comes from the edge, and is NOT the address HAFleet collects from', async () => {
    const edge = await fakeEdge(() => [200, {
      transactions: 0,
      registrationUrl: 'http://127.0.0.1:8094',
    }]);
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));

    expect(body.appservice.inboundVia).toBe('edge');
    expect(body.appservice.edgeReachable).toBe(true);
    expect(body.appservice.edgeRegistrationUrl).toBe('http://127.0.0.1:8094');
    // The distinction the defect erased: the collect address is reported too, and it is a DIFFERENT value.
    expect(body.appservice.edgeUrl).toBe(edge.baseUrl);
    expect(body.appservice.edgeRegistrationUrl).not.toBe(body.appservice.edgeUrl);
  });

  test('the link token authenticates the ask, and is sent as a header', async () => {
    const edge = await fakeEdge(() => [200, { registrationUrl: 'http://127.0.0.1:8094' }]);
    await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));
    expect(edge.calls[0].path).toContain('/_hafleet/edge/status');
    expect(edge.calls[0].link).toBe(LINK);
  });

  test('an edge HAFleet cannot reach reports the failure and NO address', async () => {
    /*
     * The heart of it. Falling back to the collect address here is precisely what shipped a registration
     * the homeserver could not dial — so there is no fallback, and the reason names the address that
     * failed. An operator who cannot reach their own edge needs to know before they hand a customer a file.
     */
    const body = await reach(await boot({
      // Port 9 is discard: nothing listens, so the attempt fails for real rather than being mocked.
      HAFLEET_EDGE_URL: 'http://127.0.0.1:9',
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));

    expect(body.appservice.inboundVia).toBe('edge');
    expect(body.appservice.edgeReachable).toBe(false);
    expect(body.appservice.edgeRegistrationUrl).toBeNull();
    expect(body.appservice.edgeNote).toMatch(/cannot reach the edge/);
    expect(body.appservice.edgeNote).toContain('127.0.0.1:9');
  });

  test('an edge that answers but reports no address is called out, not guessed for', async () => {
    // An older edge predates the field. Saying so beats silently substituting the collect address.
    const edge = await fakeEdge(() => [200, { transactions: 3 }]);
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));
    expect(body.appservice.edgeReachable).toBe(true);
    expect(body.appservice.edgeRegistrationUrl).toBeNull();
    expect(body.appservice.edgeNote).toMatch(/does not report/);
  });

  test('a wrong link token is a failure, not an address', async () => {
    const edge = await fakeEdge(() => [403, { error: 'bad link token' }]);
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));
    expect(body.appservice.edgeReachable).toBe(false);
    expect(body.appservice.edgeRegistrationUrl).toBeNull();
    expect(body.appservice.edgeNote).toMatch(/403/);
  });

  test('the traffic counters and the diagnosis come back, so a screen can say inbound is dead', async () => {
    /*
     * THE PAIR THAT MUST BE ANSWERABLE TOGETHER. A side can be `accepted` — HAFleet can act as the
     * representative — while nothing has ever arrived. On the walkthrough those two facts coexisted for an
     * hour and only the second one mattered. `verify` cannot see it; this can.
     */
    const edge = await fakeEdge(() => [200, {
      transactions: 4, delivered: 0, rejected: 0, hafleetWaiting: false,
      registrationUrl: 'http://127.0.0.1:8094',
    }]);
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));

    expect(body.appservice.inbound.state).toBe('not-collected');
    expect(body.appservice.inbound.detail).toMatch(/BRIDGE/);
    expect(body.appservice.edgeTraffic).toEqual({
      transactions: 4, delivered: 0, rejected: 0, collecting: false,
    });
  });

  test('a healthy edge reports flowing, so the warning means something when it appears', async () => {
    const edge = await fakeEdge(() => [200, {
      transactions: 7, delivered: 7, rejected: 0, hafleetWaiting: true,
      registrationUrl: 'http://127.0.0.1:8094',
    }]);
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: edge.baseUrl,
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));
    expect(body.appservice.inbound.state).toBe('flowing');
    expect(body.appservice.edgeTraffic.collecting).toBe(true);
  });

  test('an unreachable edge says unknown rather than claiming inbound is fine or broken', async () => {
    // Two different ignorances: "we asked and nothing is arriving" versus "we could not ask". Reporting the
    // second as the first would send an operator to restart a bridge that is running.
    const body = await reach(await boot({
      HAFLEET_EDGE_URL: 'http://127.0.0.1:9',
      HAFLEET_EDGE_LINK_TOKEN: LINK,
      HAFLEET_EDGE_SIDE: 'walk.test',
    }));
    expect(body.appservice.inbound.state).toBe('unknown');
  });

  test('with no edge configured nothing is asked and nothing is claimed', async () => {
    // The check must not invent an edge for the deployments that do not use one.
    const body = await reach(await boot({}));
    expect(body.appservice.inboundVia).toBeNull();
    expect(body.appservice.edgeRegistrationUrl).toBeUndefined();
  });
});
