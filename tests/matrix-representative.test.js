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
  createRoomOnSide,
  ensureRepresentative,
  inviteToRoomOnSide,
  joinRoomOnSideAsAgent,
  mintAgentIdentity,
  registerRepresentative,
  sendToRoomOnSide,
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
     * Asserted because a bare whoami would prove strictly less. It proves only that the homeserver
     * knows the token; the masqueraded form additionally proves the namespace claim functions, and it
     * exercises the exact call shape every later agent operation uses. Measured against the Palpo
     * 0.4.0 build this deployment runs: masquerading outside the claimed namespace is refused
     * `403 M_FORBIDDEN`, so the as_token is genuinely scoped.
     *
     * An earlier version of this comment gave a stronger reason — that a bare call fails until a
     * masqueraded one bootstraps the sender account — which was read out of Palpo's source, recorded
     * as verified, and did not reproduce. Kept as a note because the error is instructive: code paths
     * existing is not code paths behaving.
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

describe('minting an agent identity on a project side', () => {
  /*
   * ADR-016 decision 4 — the identity half. This is the act that could not exist before a project side
   * did, which is the circular dependency the operator named: 「agent 在没有接受项目邀请之前是不知道
   * 加入哪个 home server，所以你先创建了 biglittle 的 matrix id 是错的」.
   *
   * The two credential kinds diverge completely here, and that divergence is the payoff of making
   * appservice mandatory rather than a complication of it.
   */
  const SIDE_NS = { ...SIDE };

  test('APPSERVICE: nothing is created, nothing is stored, and there is NO per-agent token', async () => {
    /*
     * The account exists by virtue of the namespace the project side installed, so minting is a claim
     * rather than an act. `accessToken: null` is the point — HAFleet acts as this agent with the side's
     * one `as_token`, which is why ADR-014 decision 4's per-agent `{ homeserver, accessToken }` is
     * unrepresentable for such a side.
     */
    const impl = fakeFetch([ok({ user_id: `@ac_alpha:${SERVER}`, device_id: 'appservice' })]);
    const r = await mintAgentIdentity({ side: SIDE_NS, credential: asCred(), localpart: 'ac_alpha', fetchImpl: impl });
    expect(r).toMatchObject({ minted: true, kind: 'appservice', mxid: `@ac_alpha:${SERVER}`, accessToken: null });
    expect(impl.calls.some((c) => c.url.includes('/register'))).toBe(false);
    expect(impl.calls[0].url).toContain(`user_id=%40ac_alpha%3A${SERVER}`);
  });

  test('APPSERVICE: an out-of-namespace name is refused BEFORE the call, with the right reason', async () => {
    /*
     * The homeserver's refusal for an out-of-namespace masquerade is a 403 — identical to the one for a
     * bad `as_token`. Those send an operator to two different places: rename the agent, or re-issue a
     * credential. Checking the claimed regex locally is what keeps them distinguishable.
     */
    const impl = fakeFetch([]);
    const r = await mintAgentIdentity({
      side: SIDE_NS, credential: asCred(), localpart: 'not_prefixed', fetchImpl: impl,
    });
    expect(r.minted).toBe(false);
    expect(r.reason).toMatch(/outside the namespace this side claimed/);
    expect(impl.calls).toHaveLength(0);
  });

  test('APPSERVICE: an unusable namespace regex is reported rather than thrown', async () => {
    const impl = fakeFetch([]);
    const r = await mintAgentIdentity({
      side: SIDE_NS, credential: asCred({ namespace: '@ac_[' }), localpart: 'ac_alpha', fetchImpl: impl,
    });
    expect(r.minted).toBe(false);
    expect(r.reason).toMatch(/not a usable regex/);
  });

  test('REGISTRATION TOKEN: a real account is created and its token comes back', async () => {
    const impl = fakeFetch([
      fail(401, { session: 's1' }),
      ok({ access_token: 'agent_token', user_id: `@ac_beta:${SERVER}` }),
    ]);
    const r = await mintAgentIdentity({
      side: SIDE_NS, credential: regCred(), localpart: 'ac_beta', fetchImpl: impl,
    });
    expect(r).toMatchObject({ minted: true, kind: 'registrationToken', mxid: `@ac_beta:${SERVER}`, accessToken: 'agent_token' });
    expect(JSON.parse(impl.calls[1].body).auth.type).toBe('m.login.registration_token');
  });

  test('THE MXID IS THE SERVER\'S ANSWER, not the localpart we asked for', async () => {
    // ADR-014 decision 5. The localpart is a request; the homeserver decides. A side may register the
    // account under a name that does not match our convention, and it is still the account we hold.
    const impl = fakeFetch([
      fail(401, { session: 's1' }),
      ok({ access_token: 't', user_id: `@renamed_by_server:${SERVER}` }),
    ]);
    const r = await mintAgentIdentity({ side: SIDE_NS, credential: regCred(), localpart: 'ac_beta', fetchImpl: impl });
    expect(r.mxid).toBe(`@renamed_by_server:${SERVER}`);
  });

  test('M_USER_IN_USE comes back as an ERRCODE, not as a message to match on', async () => {
    /*
     * The one a caller must act on: the localpart is taken, which happens when an agent of that name was
     * minted before and its token was lost. Matching the prose would break on the next reword.
     */
    const impl = fakeFetch([fail(400, { errcode: 'M_USER_IN_USE' })]);
    const r = await mintAgentIdentity({ side: SIDE_NS, credential: regCred(), localpart: 'ac_taken', fetchImpl: impl });
    expect(r.minted).toBe(false);
    expect(r.errcode).toBe('M_USER_IN_USE');
  });

  test('a side with no registration token says so rather than trying', async () => {
    const impl = fakeFetch([]);
    const r = await mintAgentIdentity({
      side: SIDE_NS,
      credential: { kind: 'registrationToken', registrationToken: null, representativeToken: null },
      localpart: 'ac_x',
      fetchImpl: impl,
    });
    expect(r.minted).toBe(false);
    expect(r.reason).toMatch(/no registration token/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a Matrix failure is a STATE, never a throw', async () => {
    // The caller is a provisioning path that must record a reason per agent rather than abort a sweep.
    for (const [response, state] of [[fail(503), 'unreachable'], [fail(403), 'rejected']]) {
      const impl = fakeFetch([response]);
      const r = await mintAgentIdentity({ side: SIDE_NS, credential: asCred(), localpart: 'ac_a', fetchImpl: impl });
      expect(r.minted).toBe(false);
      expect(r.state).toBe(state);
    }
  });

  test('unactionable arguments DO throw', async () => {
    await expect(mintAgentIdentity({ side: {}, credential: asCred(), localpart: 'ac_a' }))
      .rejects.toThrow(/apiBaseUrl and serverName/);
    await expect(mintAgentIdentity({ side: SIDE_NS, credential: null, localpart: 'ac_a' }))
      .rejects.toThrow(/credential is required/);
    await expect(mintAgentIdentity({ side: SIDE_NS, credential: asCred(), localpart: '' }))
      .rejects.toThrow(/localpart is required/);
    await expect(mintAgentIdentity({ side: SIDE_NS, credential: { kind: 'password' }, localpart: 'a' }))
      .rejects.toThrow(/unsupported credential kind/);
  });
});

describe('creating a room on a project side', () => {
  /*
   * The capability that lets an approval room live where the DECIDER lives. The operator settled that
   * an execution approval is the borrower's — 「答借用方，当然是借用方」 — and the borrower is on the
   * project side's homeserver, which the bot has no account on.
   */
  const okRoom = (id = `!new:${SERVER}`) => ok({ room_id: id });

  test('an appservice side creates it MASQUERADED as its sender', async () => {
    const impl = fakeFetch([okRoom()]);
    const r = await createRoomOnSide({
      side: SIDE, credential: asCred(), name: 'Approval: alpha', encrypted: false, fetchImpl: impl,
    });
    expect(r).toMatchObject({ created: true, roomId: `!new:${SERVER}`, encrypted: false });
    expect(impl.calls[0].url).toContain(`user_id=%40hafleet%3A${SERVER}`);
    expect(impl.calls[0].headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
  });

  test('a registration-token side uses the representative\'s own token, unmasqueraded', async () => {
    const impl = fakeFetch([okRoom()]);
    await createRoomOnSide({
      side: SIDE,
      credential: regCred({ representativeToken: 'rep_tok' }),
      name: 'Approval: alpha', encrypted: false, fetchImpl: impl,
    });
    expect(impl.calls[0].headers.Authorization).toBe('Bearer rep_tok');
    expect(impl.calls[0].url).not.toContain('user_id=');
  });

  test('a registration-token side with no representative token says so, and creates nothing', async () => {
    const impl = fakeFetch([]);
    const r = await createRoomOnSide({
      side: SIDE, credential: regCred(), name: 'x', encrypted: false, fetchImpl: impl,
    });
    expect(r.created).toBe(false);
    expect(r.reason).toMatch(/no representative token/);
    expect(impl.calls).toHaveLength(0);
  });

  test('ENCRYPTED MUST BE STATED — an omission is refused, not defaulted', async () => {
    /*
     * Required rather than defaulted because either default is a silent wrong answer: defaulting to
     * true produces a room the representative cannot read, and defaulting to false silently makes a
     * confidentiality decision the caller never took.
     */
    await expect(createRoomOnSide({ side: SIDE, credential: asCred(), name: 'x' }))
      .rejects.toThrow(/encrypted must be stated explicitly/);
  });

  test('ENCRYPTED TRUE IS REFUSED, and the reason is a capability not a policy', async () => {
    /*
     * The representative is plaintext-only by construction — the single crypto store belongs to the
     * home bot on the contributor's server. A room it created with `m.room.encryption` would be a room
     * it cannot read: an approval channel that looks correct and delivers nothing, which is the exact
     * failure mode this project has now hit twice.
     */
    await expect(createRoomOnSide({ side: SIDE, credential: asCred(), name: 'x', encrypted: true }))
      .rejects.toThrow(/no crypto store/);
  });

  test('initial_state is EXPLICITLY EMPTY, not omitted', async () => {
    /*
     * A homeserver may be configured to encrypt private rooms by default, and inheriting that would
     * hand us a room we cannot read — the outcome the refusal above exists to prevent. Stating an empty
     * initial state is the only way to say "not that".
     */
    const impl = fakeFetch([okRoom()]);
    await createRoomOnSide({
      side: SIDE, credential: asCred(), name: 'x', encrypted: false, fetchImpl: impl,
    });
    const body = JSON.parse(impl.calls[0].body);
    expect(body).toHaveProperty('initial_state');
    expect(body.initial_state).toEqual([]);
  });

  test('access control replaces encryption: private preset and an explicit invite list', async () => {
    // What survives of ADR-003's requirement once the decider is the borrower: not confidentiality from
    // them, but who else inside their organisation may see and answer.
    const impl = fakeFetch([okRoom()]);
    await createRoomOnSide({
      side: SIDE, credential: asCred(), name: 'Approval: alpha',
      topic: 'UI-only approval requests.', invite: [`@borrower:${SERVER}`],
      isDirect: true, encrypted: false, fetchImpl: impl,
    });
    const body = JSON.parse(impl.calls[0].body);
    expect(body.preset).toBe('private_chat');
    expect(body.invite).toEqual([`@borrower:${SERVER}`]);
    expect(body.is_direct).toBe(true);
    expect(body.topic).toBe('UI-only approval requests.');
  });

  test('A ROOM ON THE WRONG SERVER IS REPORTED, not returned as success', async () => {
    /*
     * The room id names the server that owns it, and it must be this side. A homeserver answering with
     * a room on another origin means we created it somewhere we did not intend — worth catching here
     * rather than when the borrower cannot find it.
     */
    const impl = fakeFetch([ok({ room_id: '!elsewhere:other.example' })]);
    const r = await createRoomOnSide({
      side: SIDE, credential: asCred(), name: 'x', encrypted: false, fetchImpl: impl,
    });
    expect(r.created).toBe(false);
    expect(r.reason).toMatch(/not on palpo\.test/);
  });

  test('a Matrix failure is a state with its classification, never a throw', async () => {
    for (const [response, state] of [[fail(403, { errcode: 'M_FORBIDDEN' }), 'rejected'], [fail(502), 'unreachable']]) {
      const impl = fakeFetch([response]);
      const r = await createRoomOnSide({
        side: SIDE, credential: asCred(), name: 'x', encrypted: false, fetchImpl: impl,
      });
      expect(r.created).toBe(false);
      expect(r.state).toBe(state);
    }
  });

  test('a response with no room_id is a failure, not a success with null', async () => {
    const impl = fakeFetch([ok({})]);
    const r = await createRoomOnSide({
      side: SIDE, credential: asCred(), name: 'x', encrypted: false, fetchImpl: impl,
    });
    expect(r.created).toBe(false);
    expect(r.reason).toMatch(/did not return a room_id/);
  });

  test('unactionable arguments throw', async () => {
    await expect(createRoomOnSide({ side: {}, credential: asCred(), name: 'x', encrypted: false }))
      .rejects.toThrow(/apiBaseUrl and serverName/);
    await expect(createRoomOnSide({ side: SIDE, credential: null, name: 'x', encrypted: false }))
      .rejects.toThrow(/credential is required/);
    await expect(createRoomOnSide({ side: SIDE, credential: asCred(), encrypted: false }))
      .rejects.toThrow(/name is required/);
  });
});

describe('sending into a room on a project side', () => {
  /*
   * The counterpart to createRoomOnSide, and the reason an approval request can reach a decider who is
   * not on the contributor's homeserver. The bot cannot: it holds an account on one server only
   * (ADR-014 decision 4's split), so a room on a project side is unreachable to it.
   */
  const ROOM = `!approval:${SERVER}`;
  const CONTENT = { msgtype: 'm.text', body: 'Approval required for alpha' };

  test('an appservice side sends MASQUERADED, into the right room', async () => {
    const impl = fakeFetch([ok({ event_id: '$e1' })]);
    const r = await sendToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: 'req-1', fetchImpl: impl,
    });
    expect(r).toMatchObject({ sent: true, eventId: '$e1' });
    expect(impl.calls[0].method).toBe('PUT');
    expect(impl.calls[0].url).toContain(`user_id=%40hafleet%3A${SERVER}`);
    expect(impl.calls[0].url).toContain('/send/m.room.message/');
    expect(JSON.parse(impl.calls[0].body)).toEqual(CONTENT);
  });

  test('IDEMPOTENT BY SEED: the same seed produces the same transaction id', async () => {
    /*
     * Matrix deduplicates on the transaction id, so a retry after a timeout — where the send may or may
     * not have landed — must reuse it or post the message twice. A timestamp would make every retry a
     * new message, which is exactly the failure it looks like it prevents.
     */
    const urls = [];
    for (const _ of [1, 2]) {
      const impl = fakeFetch([ok({ event_id: '$e' })]);
      await sendToRoomOnSide({
        side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: 'same-request', fetchImpl: impl,
      });
      urls.push(impl.calls[0].url);
      void _;
    }
    expect(urls[0]).toBe(urls[1]);
  });

  test('a DIFFERENT seed produces a different transaction id', async () => {
    const ids = [];
    for (const seed of ['req-a', 'req-b']) {
      const impl = fakeFetch([ok({ event_id: '$e' })]);
      await sendToRoomOnSide({
        side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: seed, fetchImpl: impl,
      });
      ids.push(impl.calls[0].url);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('the seed is REQUIRED, because a clock-derived one would defeat the point', async () => {
    await expect(sendToRoomOnSide({ side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT }))
      .rejects.toThrow(/txnSeed is required/);
  });

  test('A ROOM ON ANOTHER SERVER IS REFUSED before anything is sent', async () => {
    /*
     * Sending to a room whose origin is not this side means presenting this side's credential to a room
     * it has no account in — at best a 403, at worst the cross-side disclosure that setRoomAvatar's
     * retry ladder used to produce.
     */
    const impl = fakeFetch([]);
    const r = await sendToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: '!elsewhere:other.example',
      content: CONTENT, txnSeed: 's', fetchImpl: impl,
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/not on palpo\.test/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a registration-token side uses its own token, unmasqueraded', async () => {
    const impl = fakeFetch([ok({ event_id: '$e' })]);
    await sendToRoomOnSide({
      side: SIDE, credential: regCred({ representativeToken: 'rep_tok' }),
      roomId: ROOM, content: CONTENT, txnSeed: 's', fetchImpl: impl,
    });
    expect(impl.calls[0].headers.Authorization).toBe('Bearer rep_tok');
    expect(impl.calls[0].url).not.toContain('user_id=');
  });

  test('no representative token means nothing is sent', async () => {
    const impl = fakeFetch([]);
    const r = await sendToRoomOnSide({
      side: SIDE, credential: regCred(), roomId: ROOM, content: CONTENT, txnSeed: 's', fetchImpl: impl,
    });
    expect(r.sent).toBe(false);
    expect(impl.calls).toHaveLength(0);
  });

  test('a failure is a classified state, and a missing event_id is a failure', async () => {
    const refused = fakeFetch([fail(403, { errcode: 'M_FORBIDDEN' })]);
    expect(await sendToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: 's', fetchImpl: refused,
    })).toMatchObject({ sent: false, state: 'rejected' });

    const empty = fakeFetch([ok({})]);
    const r = await sendToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: 's', fetchImpl: empty,
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/did not return an event_id/);
  });

  test('a non-default msgtype is honoured, for a status notice as well as a request', async () => {
    const impl = fakeFetch([ok({ event_id: '$e' })]);
    await sendToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: ROOM, content: CONTENT, txnSeed: 's',
      msgType: 'm.reaction', fetchImpl: impl,
    });
    expect(impl.calls[0].url).toContain('/send/m.reaction/');
  });
});

/*
 * 接单员把外派员工带进项目房间 — ADR-016 decision 3's remaining half.
 *
 * WHY THIS COULD NOT BE THE AGENT'S OWN JOB. The bridge joins rooms with `getAgentToken`, and an
 * appservice side mints no per-agent token at all: the namespace makes an agent ADDRESSABLE, not able
 * to act. So on exactly the sides ADR-016 calls normal, nobody could put the agent in the room — the
 * agent least of all. The side's credential does it, which is what the namespace is for.
 */
describe('the representative brings an agent into a project room', () => {
  const ROOM = `!proj:${SERVER}`;
  const AGENT = `@ac_worker:${SERVER}`;

  test('invites as the representative, masquerading on an appservice side', async () => {
    const impl = fakeFetch([ok({ room_id: ROOM })]);
    const r = await inviteToRoomOnSide({ side: SIDE, credential: asCred(), roomId: ROOM, userId: AGENT, fetchImpl: impl });
    expect(r).toMatchObject({ invited: true, already: false });
    const [call] = impl.calls;
    expect(call.url).toContain(`/rooms/${encodeURIComponent(ROOM)}/invite`);
    // The masquerade is the sender_localpart, NOT the agent: the representative is who invites.
    expect(call.url).toContain(`user_id=${encodeURIComponent(`@hafleet:${SERVER}`)}`);
    expect(JSON.parse(call.body).user_id).toBe(AGENT);
    expect(call.headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
  });

  test('ALREADY A MEMBER is a success with nothing done, not a failure', async () => {
    /*
     * Matrix answers 403 M_FORBIDDEN both for "already in the room" and for "you may not invite here",
     * with no code to tell them apart. A caller that cannot either retries forever or reports a working
     * room as broken — so this is the difference that lets dispatch call invite every time.
     */
    const impl = fakeFetch([fail(403, { errcode: 'M_FORBIDDEN', error: `${AGENT} is already in the room.` })]);
    const r = await inviteToRoomOnSide({ side: SIDE, credential: asCred(), roomId: ROOM, userId: AGENT, fetchImpl: impl });
    expect(r).toMatchObject({ invited: false, already: true, reason: null });
  });

  test('a genuine 403 stays a failure and keeps its reason', async () => {
    const impl = fakeFetch([fail(403, { errcode: 'M_FORBIDDEN', error: 'You are not allowed to invite users' })]);
    const r = await inviteToRoomOnSide({ side: SIDE, credential: asCred(), roomId: ROOM, userId: AGENT, fetchImpl: impl });
    expect(r.invited).toBe(false);
    expect(r.already).toBe(false);
    /*
     * `M_FORBIDDEN`, not the prose. `matrixError` prefers the errcode module-wide, so the server's
     * sentence is dropped — which is why the already-a-member case above is matched on the prose
     * BEFORE the error is built, and not by inspecting it afterwards.
     */
    expect(r.reason).toMatch(/HTTP 403: M_FORBIDDEN/);
    expect(r.state).toBe('rejected');
  });

  test('a room on another server is refused before any credential is presented', async () => {
    const impl = fakeFetch([]);
    const r = await inviteToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: '!elsewhere:other.example', userId: AGENT, fetchImpl: impl,
    });
    expect(r.invited).toBe(false);
    expect(r.reason).toMatch(/not on palpo\.test/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a registrationToken side with no representative token yet says so', async () => {
    const impl = fakeFetch([]);
    const r = await inviteToRoomOnSide({ side: SIDE, credential: regCred(), roomId: ROOM, userId: AGENT, fetchImpl: impl });
    expect(r.invited).toBe(false);
    expect(r.reason).toMatch(/no representative token yet/);
    expect(impl.calls).toHaveLength(0);
  });

  test('the agent joins under the appservice credential, as itself', async () => {
    const impl = fakeFetch([ok({ room_id: ROOM })]);
    const r = await joinRoomOnSideAsAgent({ side: SIDE, credential: asCred(), roomId: ROOM, agentUserId: AGENT, fetchImpl: impl });
    expect(r).toMatchObject({ joined: true, roomId: ROOM });
    const [call] = impl.calls;
    expect(call.url).toContain(`/join/${encodeURIComponent(ROOM)}`);
    // Here the masquerade IS the agent — that is the whole difference from the invite above.
    expect(call.url).toContain(`user_id=${encodeURIComponent(AGENT)}`);
    expect(call.headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
  });

  test('joining as an agent is REFUSED on a registrationToken side', async () => {
    /*
     * There the agent holds a real token. Joining with the representative's would put the
     * REPRESENTATIVE in the room while reporting that the agent joined — a false record of who is
     * present, which is worse than a refusal that names the path that works.
     */
    const impl = fakeFetch([]);
    const r = await joinRoomOnSideAsAgent({
      side: SIDE, credential: regCred({ representativeToken: REP_TOKEN }), roomId: ROOM, agentUserId: AGENT, fetchImpl: impl,
    });
    expect(r.joined).toBe(false);
    expect(r.reason).toMatch(/per-agent token and must use it/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a user outside the namespace is refused, and the as_token is never sent', async () => {
    const impl = fakeFetch([]);
    const r = await joinRoomOnSideAsAgent({
      side: SIDE, credential: asCred(), roomId: ROOM, agentUserId: `@borrower:${SERVER}`, fetchImpl: impl,
    });
    expect(r.joined).toBe(false);
    expect(r.reason).toMatch(/outside the namespace/);
    expect(r.reason).toMatch(/@ac_\.\*/);
    expect(impl.calls).toHaveLength(0);
  });

  test('an unparseable namespace is reported as such, not silently permitted', async () => {
    const impl = fakeFetch([]);
    const r = await joinRoomOnSideAsAgent({
      side: SIDE, credential: asCred({ namespace: '@ac_[' }), roomId: ROOM, agentUserId: AGENT, fetchImpl: impl,
    });
    expect(r.joined).toBe(false);
    expect(r.reason).toMatch(/not a usable regex/);
    expect(impl.calls).toHaveLength(0);
  });

  test('a full MXID is required, because a bare name would masquerade as a guess', async () => {
    await expect(joinRoomOnSideAsAgent({
      side: SIDE, credential: asCred(), roomId: ROOM, agentUserId: 'ac_worker', fetchImpl: fakeFetch([]),
    })).rejects.toThrow(RepresentativeError);
    await expect(inviteToRoomOnSide({
      side: SIDE, credential: asCred(), roomId: ROOM, userId: 'worker', fetchImpl: fakeFetch([]),
    })).rejects.toThrow(RepresentativeError);
  });
});
