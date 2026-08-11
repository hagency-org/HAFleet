import { describe, it, expect } from 'vitest';
import {
  createDashboardMutationBoundary,
  dashboardBearerToken,
  isLoopbackAddress,
} from '../lib/dashboard/request-boundary.js';

/*
 * server.js:291 mounts `requireDashboardMutationBoundary` on ALL of /api. So this
 * 60-line module is the entire write boundary of the dashboard server: every queue
 * injection, every agent nudge, every state mutation the console can perform is
 * allowed or refused here. It had no test file.
 *
 * Two properties, pulling in opposite directions, and both have to hold:
 *
 *   READS MUST STAY OPEN. If the method allowlist regressed, the console would 403 for
 *   every viewer who is not on the box — the dashboard is normally read behind a
 *   reverse proxy, so closing reads breaks the product for everyone at once and would
 *   look like a server outage.
 *
 *   WRITES MUST BE CLOSED BY DEFAULT. HAFLEET_DASHBOARD_TOKEN is optional
 *   (server.js:70-76 warns that non-local mutations stay unavailable without it), which
 *   means the common deployment has NO token — so the "no token configured" path must
 *   refuse rather than compare two empty strings and let everyone through.
 *
 * The empty-token case is the one tested hardest below, because the code that prevents
 * it is a single line and its removal is an unauthenticated write to the whole API.
 */

const remote = (over = {}) => ({
  method: 'POST',
  headers: {},
  socket: { remoteAddress: '203.0.113.7' },
  connection: { remoteAddress: '203.0.113.7' },
  ip: '203.0.113.7',
  ...over,
});

function fakeRes() {
  const sent = { status: null, body: null };
  return {
    sent,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
}

/** Runs the middleware and reports whether it continued or responded. */
function run(boundary, request) {
  const res = fakeRes();
  let nextCalls = 0;
  boundary.requireDashboardMutationBoundary(request, res, () => { nextCalls += 1; });
  return { allowed: nextCalls === 1, status: res.sent.status, body: res.sent.body };
}

// ── isLoopbackAddress ─────────────────────────────────────────────────
describe('isLoopbackAddress', () => {
  it('recognises the loopback forms Node actually reports', () => {
    /*
     * All four appear in practice depending on whether the listener is bound to IPv4,
     * IPv6, or dual-stack: `127.0.0.1`, `::1`, the IPv4-mapped `::ffff:127.0.0.1`, and
     * the hostname when a client dials `localhost`. Missing any one of them locks the
     * operator out of their own console on a machine configured slightly differently —
     * a bug that only appears on someone else's laptop.
     */
    for (const value of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(value), value).toBe(true);
    }
    // Case and padding, because these arrive from headers and config as often as from
    // a socket.
    expect(isLoopbackAddress('  LOCALHOST  ')).toBe(true);
    expect(isLoopbackAddress('::FFFF:127.0.0.1')).toBe(true);
    // The whole 127/8 block is loopback, including the short form `127.1`.
    expect(isLoopbackAddress('127.1')).toBe(true);
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
  });

  it('does NOT treat every IPv4-mapped address as loopback', () => {
    /*
     * The load-bearing decoy for the `::ffff:` branch. That branch has to compare what
     * follows the prefix; a version that returned true for the prefix alone would make
     * every dual-stack client on the internet local, because `::ffff:` is how a
     * dual-stack listener reports ANY IPv4 peer — which is most of them.
     */
    expect(isLoopbackAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:203.0.113.7')).toBe(false);
  });

  it('rejects private, unspecified and absent addresses', () => {
    /*
     * "On my LAN" is not "on this machine". A dashboard reachable from a shared office
     * network must not treat the whole subnet as the operator, and `0.0.0.0` — which is
     * what a misconfigured proxy can present — is not a peer address at all.
     */
    for (const value of ['10.0.0.1', '192.168.1.5', '172.16.0.1', '0.0.0.0', '::', '8.8.8.8']) {
      expect(isLoopbackAddress(value), String(value)).toBe(false);
    }
    for (const value of ['', '   ', null, undefined, 127, {}, ['127.0.0.1']]) {
      expect(isLoopbackAddress(value), JSON.stringify(value)).toBe(false);
    }
  });
});

// ── dashboardBearerToken ──────────────────────────────────────────────
describe('dashboardBearerToken', () => {
  it('extracts only the credential, and yields empty for anything that is not one', () => {
    /*
     * The extracted value is compared against the configured token. Two hazards:
     * a bare `Bearer` must not yield the literal string 'Bearer' (a guessable secret),
     * and a non-Bearer scheme must not fall through as the raw header (which would make
     * `Basic <base64>` comparable as a token).
     */
    expect(dashboardBearerToken({ headers: { authorization: 'Bearer tok' } })).toBe('tok');
    expect(dashboardBearerToken({ headers: { authorization: 'bearer tok' } })).toBe('tok');
    expect(dashboardBearerToken({ headers: { authorization: '  Bearer   tok  ' } })).toBe('tok');
    expect(dashboardBearerToken({ headers: { authorization: 'Bearer' } })).toBe('');
    expect(dashboardBearerToken({ headers: { authorization: 'Basic tok' } })).toBe('');
    expect(dashboardBearerToken({ headers: {} })).toBe('');
    expect(dashboardBearerToken({})).toBe('');
    expect(dashboardBearerToken(undefined)).toBe('');
  });
});

// ── reads vs writes ───────────────────────────────────────────────────
describe('the read/write split', () => {
  const boundary = createDashboardMutationBoundary({ dashboardApiToken: 'dash-token' });

  it('lets an unauthenticated REMOTE reader through', () => {
    /*
     * The dashboard is normally viewed through a reverse proxy by people who are not on
     * the host and do not hold the token. If this boundary closed reads, the whole
     * console would 403 at once and read as a server outage rather than as an auth
     * change. OPTIONS is in the set because a browser preflights every cross-origin
     * mutation and must not be answered 403 before the real request is ever sent.
     */
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const result = run(boundary, remote({ method }));
      expect(result.allowed, method).toBe(true);
      expect(result.status).toBeNull();
    }
  });

  it('refuses every mutating method from an unauthenticated remote caller', () => {
    /*
     * The same caller as above, changed only in method. That contrast is the point: the
     * allowlist must be a method allowlist and not a general pass, or the read exemption
     * becomes the write exemption too.
     */
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = run(boundary, remote({ method }));
      expect(result.allowed, method).toBe(false);
      expect(result.status).toBe(403);
      expect(result.body.ok).toBe(false);
      expect(result.body.error).toMatch(/local client or dashboard bearer token/);
    }
  });
});

// ── locality ──────────────────────────────────────────────────────────
describe('local callers', () => {
  const boundary = createDashboardMutationBoundary({});

  it('accepts a mutation from a loopback peer with no token configured anywhere', () => {
    // The default single-user install: HAFLEET_DASHBOARD_TOKEN unset, operator at the
    // console. This must work, or the product is unusable out of the box.
    expect(run(boundary, {
      method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' },
    }).allowed).toBe(true);
  });

  it('consults socket, connection AND req.ip — any one of them suffices', () => {
    /*
     * `candidates.some(isLoopbackAddress)`. Which field carries the peer depends on the
     * Node version, on whether express's proxy handling is in play, and on whether the
     * request arrived over IPv4 or IPv6. Each case below sets exactly ONE field to
     * loopback and the other two to a public address, so reading only one of the three
     * would show up here rather than after a runtime upgrade — as a console that
     * silently stopped accepting the operator's own clicks.
     */
    const cases = [
      { socket: { remoteAddress: '127.0.0.1' } },
      { connection: { remoteAddress: '::1' } },
      { ip: '::ffff:127.0.0.1' },
    ];
    for (const only of cases) {
      const request = remote({ method: 'POST', ...only });
      expect(run(boundary, request).allowed, JSON.stringify(only)).toBe(true);
    }
    // And with none of the three on loopback it is refused, so the `some` is not
    // vacuously true.
    expect(run(boundary, remote({ method: 'POST' })).allowed).toBe(false);
  });

  it('survives a request object with no address fields at all', () => {
    // A mutation with no discoverable peer is not local. Reading through absent
    // socket/connection must not throw, because a throw inside this middleware is a 500
    // on every /api route rather than a 403 on one.
    expect(run(boundary, { method: 'POST', headers: {} }).allowed).toBe(false);
    expect(run(boundary, { method: 'GET' }).allowed).toBe(true);
  });
});

// ── the token path ────────────────────────────────────────────────────
describe('the dashboard bearer token', () => {
  it('admits a remote mutation carrying the configured token, and nothing near it', () => {
    const boundary = createDashboardMutationBoundary({ dashboardApiToken: 'dash-token' });
    expect(run(boundary, remote({ headers: { authorization: 'Bearer dash-token' } })).allowed).toBe(true);
    // Trimming on both sides, since the token comes from an env var and the header from
    // a client that may pad it.
    expect(run(boundary, remote({ headers: { authorization: 'Bearer   dash-token  ' } })).allowed).toBe(true);
    for (const authorization of ['Bearer dash-toke', 'Bearer dash-token2', 'Basic dash-token', 'dash-token']) {
      expect(run(boundary, remote({ headers: { authorization } })).allowed, authorization).toBe(false);
    }
  });

  it('trims the configured token, so a padded env var still authenticates', () => {
    // `HAFLEET_DASHBOARD_TOKEN=" tok "` in a unit file or a .env line. Without the trim
    // the operator's token would never match and the failure would look like a wrong
    // secret rather than a stray space.
    const boundary = createDashboardMutationBoundary({ dashboardApiToken: '  padded-token  ' });
    expect(run(boundary, remote({ headers: { authorization: 'Bearer padded-token' } })).allowed).toBe(true);
  });

  it('REFUSES a remote mutation when no token is configured, including an empty bearer', () => {
    /*
     * The single most dangerous line in this module: `if (!dashboardToken) return false`.
     *
     * Remove it and the comparison becomes `dashboardBearerToken(req) === ''`, which is
     * TRUE for every request that sends no Authorization header — an unauthenticated
     * write to all of /api on the common deployment, since HAFLEET_DASHBOARD_TOKEN is
     * optional and usually unset.
     *
     * All four shapes are checked because they take different routes to the same empty
     * string: no header at all, an empty header, a bare `Bearer`, and `Bearer ` with
     * only whitespace after it.
     */
    for (const token of [undefined, '', '   ', null, 12345, {}]) {
      const boundary = createDashboardMutationBoundary({ dashboardApiToken: token });
      for (const headers of [{}, { authorization: '' }, { authorization: 'Bearer' }, { authorization: 'Bearer    ' }]) {
        const result = run(boundary, remote({ headers }));
        expect(result.allowed, `${JSON.stringify(token)} / ${JSON.stringify(headers)}`).toBe(false);
        expect(result.status).toBe(403);
      }
    }
    // A non-string token is not a token: `Bearer 12345` must not authenticate against
    // the number 12345 either.
    expect(run(
      createDashboardMutationBoundary({ dashboardApiToken: 12345 }),
      remote({ headers: { authorization: 'Bearer 12345' } }),
    ).allowed).toBe(false);
  });

  it('still lets the local operator in when no token is configured', () => {
    // Bounds the case above: closing the token path must not close the locality path,
    // which is the one the default install depends on.
    const boundary = createDashboardMutationBoundary({});
    expect(run(boundary, { method: 'POST', headers: {}, ip: '127.0.0.1' }).allowed).toBe(true);
  });
});

// ── the locality override ─────────────────────────────────────────────
describe('the local-request override', () => {
  it('REPLACES the address check in both directions', () => {
    /*
     * server.js:77-81 passes `() => dashboardRequestLocalOverride` so a test can drive
     * this boundary over a real socket. Both directions have to work: an override that
     * only ever widened access would make every "this request is refused" fixture pass
     * for the wrong reason, and a suite that cannot express a denial cannot test a
     * boundary at all.
     */
    const allowAll = createDashboardMutationBoundary({ getLocalOverride: () => () => true });
    expect(run(allowAll, remote()).allowed).toBe(true);

    const denyAll = createDashboardMutationBoundary({ getLocalOverride: () => () => false });
    expect(run(denyAll, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }).allowed).toBe(false);
    // ...and reads are still reads, because the method check comes first.
    expect(run(denyAll, { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }).allowed).toBe(true);
  });

  it('receives the request, so an override can decide per call', () => {
    // An override that ignored its argument could only answer globally, which is useless
    // for a fixture that needs one caller local and another not.
    const seen = [];
    const boundary = createDashboardMutationBoundary({
      getLocalOverride: () => (req) => { seen.push(req.headers['x-who']); return req.headers['x-who'] === 'operator'; },
    });
    expect(run(boundary, remote({ headers: { 'x-who': 'operator' } })).allowed).toBe(true);
    expect(run(boundary, remote({ headers: { 'x-who': 'stranger' } })).allowed).toBe(false);
    expect(seen).toEqual(['operator', 'stranger']);
  });

  it('requires the override to answer exactly true', () => {
    /*
     * `override(req) === true`. A predicate written to return a truthy value — a
     * non-empty string, a 1, a found object — would otherwise open the write boundary to
     * every remote caller. Strict equality means a sloppy override fails CLOSED, which
     * is the correct direction for the one function that can bypass the address check.
     */
    for (const truthy of ['yes', 1, {}, [], 'false']) {
      const boundary = createDashboardMutationBoundary({ getLocalOverride: () => () => truthy });
      expect(run(boundary, remote()).allowed, JSON.stringify(truthy)).toBe(false);
    }
  });

  it('falls back to the address check when the override is absent or not a function', () => {
    /*
     * server.js declares `let dashboardRequestLocalOverride = null` and assigns it only
     * in test setups, so the null case is the PRODUCTION case. Treating a null override
     * as "deny" would lock the local operator out of their own console on every real
     * deployment; treating it as "allow" would open the boundary to everyone.
     */
    for (const override of [null, undefined, 'nope', 42, {}]) {
      const boundary = createDashboardMutationBoundary({ getLocalOverride: () => override });
      expect(run(boundary, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }).allowed,
        JSON.stringify(override)).toBe(true);
      expect(run(boundary, remote()).allowed, JSON.stringify(override)).toBe(false);
    }
    // A non-function getLocalOverride itself is the same story.
    const noGetter = createDashboardMutationBoundary({ getLocalOverride: 'not a function' });
    expect(run(noGetter, { method: 'POST', headers: {}, ip: '127.0.0.1' }).allowed).toBe(true);
    expect(run(noGetter, remote()).allowed).toBe(false);
  });

  it('reads the override on EVERY request rather than capturing it at construction', () => {
    /*
     * server.js builds the boundary at module load, when `dashboardRequestLocalOverride`
     * is still null, and assigns it later. A captured value would mean the override never
     * takes effect — and every test that relies on it would silently exercise the plain
     * address check instead, passing while testing nothing it claimed to.
     */
    let override = null;
    const boundary = createDashboardMutationBoundary({ getLocalOverride: () => override });
    expect(run(boundary, remote()).allowed).toBe(false);
    override = () => true;
    expect(run(boundary, remote()).allowed).toBe(true);
    override = null;
    expect(run(boundary, remote()).allowed).toBe(false);
  });
});

// ── the exported predicate ────────────────────────────────────────────
describe('hasDashboardMutationAccess', () => {
  it('answers the same question as the middleware, minus the method exemption', () => {
    /*
     * The predicate is exported for callers that need to decide something other than
     * "continue or 403". It must NOT carry the read exemption: a GET is waved through by
     * the middleware because reading is safe, not because the caller has write access,
     * and a helper that conflated the two would report an anonymous reader as authorised.
     */
    const boundary = createDashboardMutationBoundary({ dashboardApiToken: 'dash-token' });
    expect(boundary.hasDashboardMutationAccess(remote({ method: 'GET' }))).toBe(false);
    expect(boundary.hasDashboardMutationAccess(remote({ headers: { authorization: 'Bearer dash-token' } }))).toBe(true);
    expect(boundary.hasDashboardMutationAccess({ method: 'POST', headers: {}, ip: '127.0.0.1' })).toBe(true);
    expect(boundary.isDashboardLocalRequest({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(boundary.isDashboardLocalRequest(remote())).toBe(false);
  });
});
