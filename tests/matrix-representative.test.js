/*
 * 代表 — the representative on a project side (ADR-016 decision 3).
 *
 * THE SPLIT UNDER TEST. Until now the representative and the working agent were one thing, so an
 * agent identity had to exist before any project was known — composed on HAFleet's own server, which
 * is unusable for a project hosted elsewhere once you stop assuming federation. An operator named it:
 * 「所以你先创建了 biglittle 的 matrix id 是错的」. These tests pin the properties that make the
 * representative able to exist first.
 *
 * THE HEAVIEST GROUP IS `rejected` VERSUS `unreachable`, and not because it is subtle. Getting it
 * wrong sends an operator to ask a project side for a fresh credential when the one they hold is
 * fine — on this path that means a human doing account work on somebody else's homeserver. The
 * failure costs another organisation's afternoon, which is why unknown shapes must answer
 * `unreachable` rather than guessing.
 */

import { describe, expect, test } from 'vitest';
import {
  classifyMatrixFailure,
  ensureRepresentative,
  registerRepresentative,
  whoami,
  RepresentativeError,
  DEFAULT_REPRESENTATIVE_LOCALPART,
} from '../lib/matrix-representative.js';

const SERVER = 'palpo.test';
const API = 'http://127.0.0.1:8008';
const SIDE = { serverName: SERVER, apiBaseUrl: API };

const AS_TOKEN = 'as_secret_never_logged';
const REG_TOKEN = 'reg_secret_never_logged';
const REP_TOKEN = 'rep_secret_never_logged';

const asCred = (over = {}) => ({
  kind: 'appservice',
  asToken: AS_TOKEN,
  hsToken: 'hs_secret',
  namespace: '@ac_.*',
  senderLocalpart: 'hafleet',
  ...over,
});

const regCred = (over = {}) => ({
  kind: 'registrationToken',
  registrationToken: REG_TOKEN,
  representativeToken: null,
  ...over,
});

/** A fetch double that records calls and replays scripted responses in order. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    if (typeof next === 'function') return next({ url: String(url), init });
    return next;
  };
  impl.calls = calls;
  return impl;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });
/** A response whose body is not JSON at all — a proxy's HTML error page. */
const failNonJson = (status) => ({
  ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); },
});

describe('rejected versus unreachable', () => {
  test('only 401 and 403 are a verdict on the credential', () => {
    expect(classifyMatrixFailure({ status: 401 })).toBe('rejected');
    expect(classifyMatrixFailure({ status: 403 })).toBe('rejected');
  });

  test('everything else is unreachable, INCLUDING shapes with no status', () => {
    /*
     * The default must be `unreachable`. A timeout, a DNS failure and an AbortError carry no
     * `.status` at all, and calling those "your token was revoked" is the expensive direction of the
     * error.
     */
    for (const e of [
      { status: 500 }, { status: 502 }, { status: 429 }, { status: 404 },
      new Error('ECONNREFUSED'), new TypeError('fetch failed'), {}, null, undefined,
    ]) {
      expect(classifyMatrixFailure(e), JSON.stringify(e?.status ?? String(e))).toBe('unreachable');
    }
  });

  test('a 401 whose body is NOT json still classifies as rejected', async () => {
    /*
     * The defence `getMatrixAccessTokenSession` documents, re-pinned here. `await res.json()` on an
     * HTML 401 throws a SyntaxError with no `.status`; if the body were parsed before the status was
     * read, a genuinely dead token would be reported as an outage and retried forever while the
     * operator was never told.
     */
    const impl = fakeFetch([failNonJson(401)]);
    const r = await ensureRepresentative({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), fetchImpl: impl,
    });
    expect(r.accessState).toBe('rejected');
  });

  test('a 502 with an HTML body is unreachable, not rejected', async () => {
    const impl = fakeFetch([failNonJson(502)]);
    const r = await ensureRepresentative({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), fetchImpl: impl,
    });
    expect(r.accessState).toBe('unreachable');
  });
});

describe('the MXID is discovered, never composed', () => {
  test("whoami's answer is used even when it differs from what we would have built", async () => {
    /*
     * ADR-014 decision 5, and the repository has a live example of the damage from composing: the
     * invite poll's owner-derivation filter matches a CONSTRUCTED state_key, so for an agent on any
     * other homeserver it never matches, no ownership binding is written, and every later approval is
     * denied `owner_binding_missing` — a silent authorization failure produced by a string built from
     * an assumption.
     *
     * The server here answers with a localpart we did not ask for. The module must believe it.
     */
    const impl = fakeFetch([ok({ user_id: '@hafleet-intake-7:palpo.test', device_id: 'D1' })]);
    const r = await ensureRepresentative({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), fetchImpl: impl,
    });
    expect(r.mxid).toBe('@hafleet-intake-7:palpo.test');
    expect(r.accessState).toBe('accepted');
  });

  test('a whoami with no user_id is an error rather than a null identity', async () => {
    const impl = fakeFetch([ok({ device_id: 'D1' })]);
    await expect(whoami({ baseUrl: API, token: REP_TOKEN, fetchImpl: impl }))
      .rejects.toThrow(/did not return a user_id/);
  });

  test('a trailing slash on the base URL does not produce a double slash', async () => {
    // Some homeservers 404 `//_matrix/...` rather than normalizing it.
    const impl = fakeFetch([ok({ user_id: `@hafleet:${SERVER}` })]);
    await whoami({ baseUrl: 'http://127.0.0.1:8008/', token: REP_TOKEN, fetchImpl: impl });
    expect(impl.calls[0].url).toContain('http://127.0.0.1:8008/_matrix/');
    expect(impl.calls[0].url).not.toContain('//_matrix/');
  });
});

describe('an appservice side registers nothing', () => {
  test('it masquerades as sender_localpart and is accepted', async () => {
    /*
     * The whoami answer deliberately does NOT match the localpart we masqueraded as. Found by
     * mutation testing: replacing `mxid: userId` with a composed `@hafleet:<server>` survived,
     * because the first version of this test had the server echo exactly what we would have built —
     * so it could not tell "believed the server" from "composed a string that happened to agree".
     *
     * The scenario is real, not contrived: `senderLocalpart` is what WE recorded, and the
     * registration the project side actually installed is what the server knows. When they disagree,
     * the server is right.
     */
    const impl = fakeFetch([ok({ user_id: `@hafleet-as:${SERVER}` })]);
    const r = await ensureRepresentative({ side: SIDE, credential: asCred(), fetchImpl: impl });
    expect(r.accessState).toBe('accepted');
    expect(r.mxid).toBe(`@hafleet-as:${SERVER}`);
    /*
     * The masquerade is the mechanism: the query parameter names the user, the as_token authorises.
     *
     * AND IT IS LOAD-BEARING ON THE FIRST CALL. Verified against the Palpo 0.4.0 build this
     * deployment runs: nothing there creates the `sender_localpart` account — registering an
     * appservice only inserts the registration row — and Palpo's non-masqueraded auth branch then
     * raises a database NotFound until some user carries that `appservice_id`. A masqueraded call
     * runs `get_or_create_appservice_user`, so this call is what bootstraps the account. Inverted
     * from Synapse and Conduit, where a bare call works immediately.
     *
     * So this assertion is not about style. Dropping the parameter would leave HAFleet unable to
     * reach a correctly configured Palpo side at all, and the symptom would look like a bad
     * credential.
     */
    expect(impl.calls[0].url).toContain(`user_id=%40hafleet%3A${SERVER}`);
    expect(impl.calls[0].headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
  });

  test('THE PAYOFF: no registration call is made, and nothing per-agent is minted', async () => {
    /*
     * The reason mandating appservice simplified the credential model rather than complicating it.
     * An appservice side's agents hold NO credential — HAFleet masquerades with the one `as_token` —
     * which is why ADR-014 decision 4's per-agent `{ homeserver, accessToken }` is not merely
     * misplaced for such a side but unrepresentable.
     */
    const impl = fakeFetch([ok({ user_id: `@hafleet:${SERVER}` })]);
    const r = await ensureRepresentative({ side: SIDE, credential: asCred(), fetchImpl: impl });
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls.some((c) => c.url.includes('/register'))).toBe(false);
    expect(r.credentialPatch).toBeNull();
  });

  test('a rejected as_token is reported, not retried', async () => {
    const impl = fakeFetch([fail(403, { errcode: 'M_FORBIDDEN' })]);
    const r = await ensureRepresentative({ side: SIDE, credential: asCred(), fetchImpl: impl });
    expect(r.accessState).toBe('rejected');
    expect(r.detail).toMatch(/M_FORBIDDEN/);
    expect(impl.calls).toHaveLength(1);
  });

  test('the sender localpart is lowercased into the masqueraded MXID', async () => {
    // Matrix requires lowercase localparts; an operator typing `HAFleet` has made a typo.
    const impl = fakeFetch([ok({ user_id: `@hafleet:${SERVER}` })]);
    await ensureRepresentative({
      side: SIDE, credential: asCred({ senderLocalpart: 'HAFleet' }), fetchImpl: impl,
    });
    expect(impl.calls[0].url).toContain('%40hafleet%3A');
  });
});

describe('a registration-token side obtains a token once', () => {
  test('with no token it registers and hands the new token back for storage', async () => {
    const impl = fakeFetch([
      fail(401, { session: 'uia-session-1', flows: [{ stages: ['m.login.registration_token'] }] }),
      ok({ access_token: 'minted_token', user_id: `@hafleet:${SERVER}` }),
    ]);
    const r = await ensureRepresentative({ side: SIDE, credential: regCred(), fetchImpl: impl });
    expect(r.accessState).toBe('accepted');
    expect(r.mxid).toBe(`@hafleet:${SERVER}`);
    // Returned rather than written: this module holds no store, and letting a network helper mutate
    // credentials would put the change outside the store's audit trail.
    expect(r.credentialPatch).toEqual({ representativeToken: 'minted_token' });
  });

  test('the registration token travels in the UIA auth stage', async () => {
    const impl = fakeFetch([
      fail(401, { session: 's1' }),
      ok({ access_token: 't', user_id: `@hafleet:${SERVER}` }),
    ]);
    await ensureRepresentative({ side: SIDE, credential: regCred(), fetchImpl: impl });
    const auth = JSON.parse(impl.calls[1].body).auth;
    expect(auth).toEqual({ type: 'm.login.registration_token', token: REG_TOKEN, session: 's1' });
  });

  test('THE PASSWORD IS RANDOM AND IS NOT RETURNED', async () => {
    /*
     * Random rather than derived is ADR-014 decision 3's whole holding: a derived password cannot be
     * rotated (every account's changes at once) and cannot be revoked (it can always be
     * re-derived), so `.env` compromise became permanent control of every identity.
     *
     * Two registrations must not produce the same password, and neither may leak out of the call.
     */
    const seen = [];
    for (let i = 0; i < 2; i += 1) {
      const impl = fakeFetch([
        fail(401, { session: `s${i}` }),
        ok({ access_token: `t${i}`, user_id: `@hafleet:${SERVER}` }),
      ]);
      const r = await registerRepresentative({ baseUrl: API, registrationToken: REG_TOKEN, fetchImpl: impl });
      seen.push(JSON.parse(impl.calls[0].body).password);
      expect(Object.keys(r)).toEqual(['accessToken', 'userId']);
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0].length).toBeGreaterThanOrEqual(32);
  });

  test('a server that registers outright, with no UIA, is handled', async () => {
    const impl = fakeFetch([ok({ access_token: 'immediate', user_id: `@hafleet:${SERVER}` })]);
    const r = await registerRepresentative({ baseUrl: API, registrationToken: REG_TOKEN, fetchImpl: impl });
    expect(r.accessToken).toBe('immediate');
    expect(impl.calls).toHaveLength(1);
  });

  test('a register reply with no user_id is confirmed by asking', async () => {
    // Not every server echoes user_id. An MXID this side stores must come from an answer.
    const impl = fakeFetch([
      fail(401, { session: 's1' }),
      ok({ access_token: 'minted' }),
      ok({ user_id: `@hafleet:${SERVER}`, device_id: 'D1' }),
    ]);
    const r = await ensureRepresentative({ side: SIDE, credential: regCred(), fetchImpl: impl });
    expect(r.mxid).toBe(`@hafleet:${SERVER}`);
    expect(impl.calls[2].url).toContain('/account/whoami');
  });

  test('there is NO open-registration fallback', async () => {
    /*
     * `bridge-matrix.js`'s `matrixRegister` falls back to `m.login.dummy` when the server offers it.
     * A representative must not: this path exists because a project side issued us a credential, and
     * registering through open registration instead would create an account whose provenance nobody
     * agreed to — on someone else's homeserver.
     */
    const impl = fakeFetch([
      fail(401, { session: 's1', flows: [{ stages: ['m.login.dummy'] }] }),
      fail(401, { errcode: 'M_FORBIDDEN', error: 'registration token required' }),
    ]);
    const r = await ensureRepresentative({ side: SIDE, credential: regCred(), fetchImpl: impl });
    expect(r.accessState).toBe('rejected');
    expect(JSON.parse(impl.calls[1].body).auth.type).toBe('m.login.registration_token');
  });

  test('a probe refusal that is not a UIA challenge is raised rather than retried', async () => {
    // M_USER_IN_USE is the one an operator will meet: a representative was registered before and its
    // token was lost. That needs a person, not another attempt.
    const impl = fakeFetch([fail(400, { errcode: 'M_USER_IN_USE' })]);
    await expect(registerRepresentative({ baseUrl: API, registrationToken: REG_TOKEN, fetchImpl: impl }))
      .rejects.toThrow(/M_USER_IN_USE/);
  });

  test('the default localpart is lowercase', () => {
    expect(DEFAULT_REPRESENTATIVE_LOCALPART).toBe(DEFAULT_REPRESENTATIVE_LOCALPART.toLowerCase());
  });
});

describe('an existing representative token is validated, never replaced', () => {
  test('a good token is accepted with one call', async () => {
    const impl = fakeFetch([ok({ user_id: `@hafleet:${SERVER}`, device_id: 'D1' })]);
    const r = await ensureRepresentative({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), fetchImpl: impl,
    });
    expect(r.accessState).toBe('accepted');
    expect(r.credentialPatch).toBeNull();
    expect(impl.calls).toHaveLength(1);
  });

  test('THE CASE THAT MATTERS: a 401 does NOT trigger re-registration', async () => {
    /*
     * Two reasons, and the second is the one that bites. The localpart is already taken so
     * registration would fail anyway — and attempting it would turn a clear "your token was revoked"
     * into a confusing M_USER_IN_USE raised from a different call. ADR-014 decision 6 wants a dead
     * credential surfaced, not healed.
     */
    const impl = fakeFetch([fail(401, { errcode: 'M_UNKNOWN_TOKEN' })]);
    const r = await ensureRepresentative({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), fetchImpl: impl,
    });
    expect(r.accessState).toBe('rejected');
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls.some((c) => c.url.includes('/register'))).toBe(false);
    expect(r.credentialPatch).toBeNull();
  });
});

describe('states rather than throws', () => {
  test('no credential is unverified, with a reason, and makes no network call', async () => {
    const impl = fakeFetch([]);
    const r = await ensureRepresentative({ side: SIDE, credential: null, fetchImpl: impl });
    expect(r.accessState).toBe('unverified');
    expect(r.detail).toMatch(/no credential configured/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a registration-token credential with neither token is unverified, not an error', async () => {
    const impl = fakeFetch([]);
    const r = await ensureRepresentative({
      side: SIDE,
      credential: { kind: 'registrationToken', registrationToken: null, representativeToken: null },
      fetchImpl: impl,
    });
    expect(r.accessState).toBe('unverified');
    expect(r.detail).toMatch(/no representative token and no registration token/);
  });

  test('a Matrix failure never throws out of ensureRepresentative', async () => {
    /*
     * A startup sweep over every project side must be able to record a reason per side. If this threw,
     * the caller would have to choose between crashing the sweep and swallowing the reason, and the
     * reason is the entire point of the access state.
     */
    for (const response of [fail(500), fail(401), failNonJson(503)]) {
      const impl = fakeFetch([response]);
      await expect(ensureRepresentative({
        side: SIDE, credential: asCred(), fetchImpl: impl,
      })).resolves.toBeTruthy();
    }
  });

  test('a side without apiBaseUrl or serverName DOES throw', async () => {
    // Unactionable arguments, as opposed to a Matrix outcome. Silently returning a state here would
    // record a verdict about a side that was never contacted.
    for (const bad of [{}, { serverName: SERVER }, { apiBaseUrl: API }, null]) {
      await expect(ensureRepresentative({ side: bad, credential: asCred() }))
        .rejects.toThrow(RepresentativeError);
    }
  });

  test('an unknown credential kind throws rather than reporting a state', async () => {
    await expect(ensureRepresentative({ side: SIDE, credential: { kind: 'password' } }))
      .rejects.toThrow(/unsupported credential kind: password/);
  });

  test('whoami refuses missing arguments', async () => {
    await expect(whoami({ token: 't' })).rejects.toThrow(/baseUrl is required/);
    await expect(whoami({ baseUrl: API })).rejects.toThrow(/token is required/);
  });
});

describe('secrets do not travel in messages', () => {
  test('no returned detail contains a token', async () => {
    /*
     * `detail` is written to the store and rendered to an operator. An error message that quoted the
     * credential would put a namespace-granting `as_token` into the console and into any log that
     * captured it.
     */
    const impl = fakeFetch([fail(403, { errcode: 'M_FORBIDDEN', error: 'bad token' })]);
    const r = await ensureRepresentative({ side: SIDE, credential: asCred(), fetchImpl: impl });
    for (const secret of [AS_TOKEN, REG_TOKEN, REP_TOKEN]) {
      expect(r.detail).not.toContain(secret);
    }
  });
});
