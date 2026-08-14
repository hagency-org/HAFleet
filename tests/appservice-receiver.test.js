/*
 * The inbound half of an appservice: what happens when a homeserver pushes events to us.
 *
 * ADR-016's settled question 6. The operator ruled appservice support mandatory after reading the
 * argument against it, which was about topology: an appservice needs the project's homeserver to reach
 * an address we expose, and the bridge has never had one.
 *
 * TWO PROPERTIES HERE COME FROM MEASUREMENT, NOT FROM THE SPEC, and they are the ones most likely to be
 * "simplified" away by someone reading only the spec:
 *
 *   - Palpo authenticates transactions with `?access_token=<hs_token>` and sends NO Authorization
 *     header. Measured against the running build with a throwaway registration: three transactions,
 *     header names limited to accept, content-length, content-type, host. A receiver that reads only
 *     the header rejects every transaction, and the symptom is an appservice that is configured and
 *     silent.
 *   - Retries are the normal case, not an anomaly, so idempotency is a correctness requirement rather
 *     than an optimisation.
 */

import { describe, expect, test } from 'vitest';
import { createServer } from 'http';
import {
  AppserviceError,
  createAppserviceReceiver,
  createAppserviceRouter,
  generateRegistration,
  renderRegistrationYaml,
} from '../lib/appservice-receiver.js';

const HS_TOKEN = 'hs_token_must_not_leak_0123456789abcdef';
const TXN = '/_matrix/app/v1/transactions/txn-1';

const put = (over = {}) => ({
  method: 'PUT',
  path: TXN,
  query: { access_token: HS_TOKEN },
  headers: {},
  body: { events: [{ type: 'm.room.message', event_id: '$e1' }] },
  ...over,
});

function receiver(over = {}) {
  const seenEvents = [];
  const rec = createAppserviceReceiver({
    hsToken: HS_TOKEN,
    onEvents: async (events, meta) => { seenEvents.push({ events, meta }); },
    ...over,
  });
  return { rec, seenEvents };
}

describe('authentication accepts BOTH forms, because only one of them arrives', () => {
  test('the QUERY PARAMETER is accepted — this is what Palpo sends', async () => {
    /*
     * Measured, not assumed. Palpo appends `?access_token=<hs_token>` and sends no Authorization
     * header; its source has the header form present but commented out. A receiver built from the spec
     * alone would 403 every real transaction.
     */
    const { rec, seenEvents } = receiver();
    const res = await rec.handle(put());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(seenEvents).toHaveLength(1);
  });

  test('the Authorization header is accepted — this is what the spec says', async () => {
    const { rec, seenEvents } = receiver();
    const res = await rec.handle(put({
      query: {},
      headers: { authorization: `Bearer ${HS_TOKEN}` },
    }));
    expect(res.status).toBe(200);
    expect(seenEvents).toHaveLength(1);
  });

  test('a wrong token is 403 and NOTHING is processed', async () => {
    const { rec, seenEvents } = receiver();
    const res = await rec.handle(put({ query: { access_token: 'wrong' } }));
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(seenEvents).toHaveLength(0);
  });

  test('no token at all is 403, not 401 — the request was understood and refused', async () => {
    const { rec } = receiver();
    expect((await rec.handle(put({ query: {}, headers: {} }))).status).toBe(403);
  });

  test('a token of the WRONG LENGTH is refused without throwing', async () => {
    /*
     * `timingSafeEqual` throws on length mismatch. Comparing lengths first is not a shortcut — an
     * unhandled throw here would be an unhandled rejection on the request path, and a homeserver would
     * see a hang rather than a refusal.
     */
    const { rec } = receiver();
    for (const bad of ['', 'x', `${HS_TOKEN}extra`, HS_TOKEN.slice(0, -1)]) {
      const res = await rec.handle(put({ query: { access_token: bad } }));
      expect(res.status, JSON.stringify(bad)).toBe(403);
    }
  });

  test('the comparison is constant-time — asserted against the SOURCE, and here is why', async () => {
    /*
     * The one property in this file a behavioural test cannot reach. Replacing `timingSafeEqual` with
     * `===` survives every functional assertion, because both return the same boolean for every input;
     * the difference is only in how long a wrong answer takes, and a timing assertion would be exactly
     * the kind of wall-clock-dependent test this suite has spent days removing.
     *
     * So this reads the source, which is normally the wrong tool and is the right one here: the
     * requirement is about HOW the comparison is performed, not about what it returns. Recorded as an
     * acknowledged equivalent mutant rather than left looking like coverage.
     */
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../lib/appservice-receiver.js', import.meta.url), 'utf8');
    expect(source).toMatch(/timingSafeEqual\(left, right\)/);
    expect(source).not.toMatch(/return a === b;/);
  });

  test('a non-Bearer Authorization header is refused rather than parsed loosely', async () => {
    const { rec } = receiver();
    for (const auth of [HS_TOKEN, `Basic ${HS_TOKEN}`, `bearer ${HS_TOKEN}`]) {
      expect((await rec.handle(put({ query: {}, headers: { authorization: auth } }))).status, auth).toBe(403);
    }
  });

  test('authentication is checked BEFORE the path, so a stranger learns nothing', async () => {
    // An unauthenticated caller must not be able to tell an implemented endpoint from an
    // unimplemented one, or a seen transaction from a new one.
    const { rec } = receiver();
    const unknown = await rec.handle(put({ path: '/_matrix/app/v1/thirdparty/protocol/x', query: {} }));
    expect(unknown.status).toBe(403);
    expect(unknown.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('idempotency, because a retry is the normal case', () => {
  test('a repeated transaction id answers 200 WITHOUT reprocessing', async () => {
    /*
     * The homeserver retries anything that is not a 200, including a transaction it delivered whose
     * response was lost. Processing twice would double-deliver every message in it — for a bridge, that
     * is the same borrower message posted twice.
     */
    const { rec, seenEvents } = receiver();
    expect((await rec.handle(put())).status).toBe(200);
    const second = await rec.handle(put());
    expect(second.status).toBe(200);
    expect(second.duplicate).toBe(true);
    expect(seenEvents).toHaveLength(1);
  });

  test('DIFFERENT transaction ids are both processed', async () => {
    const { rec, seenEvents } = receiver();
    await rec.handle(put({ path: '/_matrix/app/v1/transactions/a' }));
    await rec.handle(put({ path: '/_matrix/app/v1/transactions/b' }));
    expect(seenEvents.map((s) => s.meta.txnId)).toEqual(['a', 'b']);
  });

  test('THE ORDERING THAT MATTERS: a failed transaction is NOT remembered', async () => {
    /*
     * Marking a transaction seen before processing succeeded would make the homeserver's retry look
     * like a duplicate and skip it — which is exactly how events are lost while both sides believe
     * delivery happened. The failure must leave the id unremembered so the retry is a fresh attempt.
     */
    let attempts = 0;
    const { rec } = receiver({
      onEvents: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('downstream unavailable');
      },
    });
    const first = await rec.handle(put());
    expect(first.status).toBe(500);
    expect(rec.hasSeen('txn-1')).toBe(false);

    const retry = await rec.handle(put());
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
    expect(rec.hasSeen('txn-1')).toBe(true);
  });

  test('a 500 carries a reason without carrying the token', async () => {
    const { rec } = receiver({ onEvents: async () => { throw new Error('boom'); } });
    const res = await rec.handle(put());
    expect(res.body.error).toMatch(/boom/);
    expect(JSON.stringify(res.body)).not.toContain(HS_TOKEN);
  });

  test('the remembered set is BOUNDED, so a long-lived bridge does not leak', async () => {
    const { rec } = receiver({ seenLimit: 3 });
    for (const id of ['a', 'b', 'c', 'd']) {
      await rec.handle(put({ path: `/_matrix/app/v1/transactions/${id}` }));
    }
    expect(rec.seenCount()).toBe(3);
    // The oldest is evicted first: insertion order, pruned from the front.
    expect(rec.hasSeen('a')).toBe(false);
    expect(rec.hasSeen('d')).toBe(true);
  });

  test('a percent-encoded transaction id is decoded once, and matches its own retry', async () => {
    // Palpo's txn ids are base64url-ish and safe, but Synapse's contain characters a client would
    // encode. A receiver that compared raw path segments would treat a retry as a new transaction.
    const { rec, seenEvents } = receiver();
    const path = `/_matrix/app/v1/transactions/${encodeURIComponent('txn/with slash')}`;
    await rec.handle(put({ path }));
    const again = await rec.handle(put({ path }));
    expect(again.duplicate).toBe(true);
    expect(seenEvents[0].meta.txnId).toBe('txn/with slash');
  });
});

describe('what arrives, and what is handed on', () => {
  test('the events array is passed through with its transaction id', async () => {
    const { rec, seenEvents } = receiver();
    await rec.handle(put({
      path: '/_matrix/app/v1/transactions/t9',
      body: { events: [{ type: 'm.room.member' }, { type: 'm.room.message' }] },
    }));
    expect(seenEvents[0].events.map((e) => e.type)).toEqual(['m.room.member', 'm.room.message']);
    expect(seenEvents[0].meta.txnId).toBe('t9');
  });

  test('a body with no events is an empty array, not a crash', async () => {
    // Observed shapes include ephemeral-only transactions when a registration opts into them, and a
    // homeserver is entitled to send an empty one.
    const { rec, seenEvents } = receiver();
    for (const body of [{}, { events: null }, null, { events: 'nope' }]) {
      const res = await rec.handle(put({ path: `/_matrix/app/v1/transactions/${Math.abs(hash(body))}`, body }));
      expect(res.status).toBe(200);
    }
    expect(seenEvents.every((s) => Array.isArray(s.events))).toBe(true);
  });

  test('an unimplemented endpoint is M_UNRECOGNIZED, distinct from a 404 that means "not ours"', async () => {
    /*
     * The homeserver must be able to tell "this appservice does not implement third-party lookups" from
     * "this appservice implements user queries and that user is not ours". Both are 404s; only the
     * errcode separates them.
     */
    const { rec } = receiver();
    const res = await rec.handle(put({ method: 'GET', path: '/_matrix/app/v1/thirdparty/protocol/x' }));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  test('a transaction sent with the wrong METHOD is not processed', async () => {
    const { rec, seenEvents } = receiver();
    const res = await rec.handle(put({ method: 'POST' }));
    expect(res.status).toBe(404);
    expect(seenEvents).toHaveLength(0);
  });
});

describe('the user query', () => {
  test('it answers 200 when the callback claims the user', async () => {
    const { rec } = receiver({ onUserQuery: async (userId) => userId === '@ac_alpha:hs.test' });
    const res = await rec.handle(put({
      method: 'GET', path: `/_matrix/app/v1/users/${encodeURIComponent('@ac_alpha:hs.test')}`,
    }));
    expect(res.status).toBe(200);
  });

  test('M_NOT_FOUND is the CORRECT answer for a user that is not ours', async () => {
    const { rec } = receiver({ onUserQuery: async () => false });
    const res = await rec.handle(put({
      method: 'GET', path: `/_matrix/app/v1/users/${encodeURIComponent('@stranger:hs.test')}`,
    }));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  test('with no callback it answers M_NOT_FOUND rather than claiming everything', async () => {
    /*
     * Failing closed. Claiming a user we cannot serve would make the homeserver route traffic for it to
     * us and then see nothing happen — worse than declining, because declining is a state the
     * homeserver knows how to handle.
     */
    const { rec } = receiver();
    const res = await rec.handle(put({
      method: 'GET', path: `/_matrix/app/v1/users/${encodeURIComponent('@anyone:hs.test')}`,
    }));
    expect(res.status).toBe(404);
  });
});

describe('the registration we hand to a project side', () => {
  test('tokens are RANDOM and distinct, never derived', async () => {
    /*
     * ADR-014 decision 3's holding, and it binds harder here than it did for agent passwords: an
     * as_token authorises a whole namespace, so a derived one would make .env compromise permanent
     * control of every lent agent on that side, with no rotation path.
     */
    const a = generateRegistration({ id: 'hafleet', url: 'https://us.example' });
    const b = generateRegistration({ id: 'hafleet', url: 'https://us.example' });
    /*
     * The two tokens must DIFFER, and that is a separate requirement from being random. They
     * authorise opposite directions — `as_token` lets us act on the homeserver, `hs_token` lets the
     * homeserver push to us — so a single shared value would mean anyone who learned one could use it
     * in both directions, and a project side we lend to would be able to act as us.
     */
    expect(a.as_token).not.toBe(a.hs_token);
    expect(a.as_token).not.toBe(b.as_token);
    expect(a.hs_token).not.toBe(b.hs_token);
    expect(a.as_token).toHaveLength(64); // 32 bytes, hex
    expect(a.hs_token).toHaveLength(64);
    // Hex, not base64: a token that travels in a QUERY STRING must not need percent-encoding, and
    // base64's `+/=` would. Measured: Palpo sends the hs_token as `?access_token=`.
    expect(a.hs_token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('it carries every field a homeserver needs', () => {
    const reg = generateRegistration({ id: 'hafleet', url: 'https://us.example/' });
    expect(Object.keys(reg).sort()).toEqual([
      'as_token', 'hs_token', 'id', 'namespaces', 'rate_limited', 'sender_localpart', 'url',
    ]);
    // The trailing slash is trimmed: the homeserver appends the appservice path to this.
    expect(reg.url).toBe('https://us.example');
  });

  test('sender_localpart is lowercased, because the spec requires it of localparts', () => {
    expect(generateRegistration({ id: 'x', url: 'https://u.example', senderLocalpart: 'HAFleet' })
      .sender_localpart).toBe('hafleet');
  });

  test('the default namespace matches the existing agent prefix rather than changing it', () => {
    // `MATRIX_AGENT_PREFIX` already defaults to `ac_`, so `@ac_.*` formalises today's naming.
    expect(generateRegistration({ id: 'x', url: 'https://u.example' }).namespaces.users[0].regex)
      .toBe('@ac_.*');
  });

  test('id and url are required', () => {
    expect(() => generateRegistration({ url: 'https://u.example' })).toThrow(AppserviceError);
    expect(() => generateRegistration({ id: 'x' })).toThrow(/url is required/);
  });

  test('the YAML round-trips through the fields a homeserver parses', () => {
    const reg = generateRegistration({ id: 'hafleet-side-a', url: 'https://us.example' });
    const yaml = renderRegistrationYaml(reg);
    expect(yaml).toContain('id: hafleet-side-a');
    expect(yaml).toContain('url: "https://us.example"');
    expect(yaml).toContain(`as_token: ${reg.as_token}`);
    expect(yaml).toContain(`hs_token: ${reg.hs_token}`);
    expect(yaml).toContain('sender_localpart: hafleet');
    expect(yaml).toContain('regex: "@ac_.*"');
    expect(yaml).toContain('aliases: []');
    expect(yaml).toContain('rooms: []');
  });

  test('the YAML says the homeserver must be restarted', () => {
    // Measured: Palpo loads registrations into a OnceCell, so adding one needs a restart. An operator
    // who installs the file and waits is the failure this comment prevents.
    expect(renderRegistrationYaml(generateRegistration({ id: 'x', url: 'https://u.example' })))
      .toMatch(/restart/i);
  });
});

describe('construction refuses to be misconfigured', () => {
  test('an hsToken is required — without one nothing could be authenticated', () => {
    expect(() => createAppserviceReceiver({ onEvents: async () => {} })).toThrow(/hsToken is required/);
  });

  test('onEvents is required — a receiver that drops events is worse than none', () => {
    expect(() => createAppserviceReceiver({ hsToken: HS_TOKEN })).toThrow(/onEvents must be a function/);
  });
});

describe('driven over a real socket', () => {
  test('it works as the request handler of a bare http server', async () => {
    /*
     * `handle()` is framework-free so a test can call it directly, but the thing that has to work is a
     * homeserver reaching it over TCP with the query-parameter token. This mounts it on `http` and
     * drives it with fetch, which is the shape the bridge will use — the module deliberately does not
     * own a listener, because which port and interface to expose is a deployment decision.
     */
    const seenEvents = [];
    const rec = createAppserviceReceiver({
      hsToken: HS_TOKEN,
      onEvents: async (events, meta) => { seenEvents.push({ count: events.length, txnId: meta.txnId }); },
    });
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const url = new URL(req.url, 'http://x');
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
        const out = await rec.handle({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
        });
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/_matrix/app/v1/transactions/wire-1?access_token=${HS_TOKEN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'm.room.message' }, { type: 'm.room.member' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(seenEvents).toEqual([{ count: 2, txnId: 'wire-1' }]);

      // And a caller without the token gets nowhere, over the same socket.
      const refused = await fetch(`${base}/_matrix/app/v1/transactions/wire-2`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"events":[]}',
      });
      expect(refused.status).toBe(403);
      expect(seenEvents).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** A tiny stable hash, so the empty-body cases get distinct transaction ids. */
function hash(value) {
  const s = JSON.stringify(value);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe('one socket, many project sides', () => {
  /*
   * A deployment lends to several project sides and each installs its own registration. Exposing one
   * inbound address per side would mean one port per side, which multiplies exactly the deployment
   * decision this design kept small — so one listener serves all of them, and the TOKEN decides which
   * side a transaction belongs to.
   *
   * Not a path. A base path in the registration `url` would work, since the homeserver appends the
   * appservice path to whatever it was given — but a path is unauthenticated, so the token would have
   * to decide anyway. One source of truth, and it is the same fact that authenticates.
   */
  const TOKEN_A = 'hs_side_a_0000000000000000000000000000';
  const TOKEN_B = 'hs_side_b_1111111111111111111111111111';

  const putFor = (token, id = 'r1') => ({
    method: 'PUT',
    path: `/_matrix/app/v1/transactions/${id}`,
    query: { access_token: token },
    headers: {},
    body: { events: [{ type: 'm.room.message' }] },
  });

  function router() {
    const seen = { a: [], b: [] };
    const r = createAppserviceRouter({
      sides: [
        { sideId: 'a.example', hsToken: TOKEN_A, onEvents: async (e, m) => { seen.a.push(m.txnId); } },
        { sideId: 'b.example', hsToken: TOKEN_B, onEvents: async (e, m) => { seen.b.push(m.txnId); } },
      ],
    });
    return { r, seen };
  }

  test("a transaction reaches the side whose token it carried, and only that side", async () => {
    const { r, seen } = router();
    const res = await r.handle(putFor(TOKEN_B, 'for-b'));
    expect(res.status).toBe(200);
    expect(res.sideId).toBe('b.example');
    expect(seen.b).toEqual(['for-b']);
    expect(seen.a).toEqual([]);
  });

  test('an unknown token is refused, and says nothing about how many sides exist', async () => {
    const { r, seen } = router();
    const res = await r.handle(putFor('hs_not_configured_999999999999999999'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ errcode: 'M_FORBIDDEN', error: 'bad hs_token' });
    expect(res.sideId).toBeUndefined();
    expect(seen.a).toEqual([]);
    expect(seen.b).toEqual([]);
  });

  test('the same txnId on DIFFERENT sides is two transactions, not a duplicate', async () => {
    /*
     * Transaction ids are per-homeserver, so two sides can legitimately use the same one. A single
     * shared deduplication window would silently drop the second side's events.
     */
    const { r, seen } = router();
    await r.handle(putFor(TOKEN_A, 'shared-id'));
    const second = await r.handle(putFor(TOKEN_B, 'shared-id'));
    expect(second.duplicate).toBeUndefined();
    expect(seen.a).toEqual(['shared-id']);
    expect(seen.b).toEqual(['shared-id']);
  });

  test('THE REFRESH PROPERTY: an unchanged side keeps its deduplication window', async () => {
    /*
     * Found by asking what happens when a side is ADDED, which is the ordinary case. Rebuilding every
     * receiver on refresh would discard each one's remembered transaction ids — so a homeserver
     * retrying across the refresh would be processed a second time, double-delivering every message in
     * that transaction.
     */
    const { r, seen } = router();
    await r.handle(putFor(TOKEN_A, 'keep-me'));
    expect(seen.a).toEqual(['keep-me']);

    r.setSides([
      { sideId: 'a.example', hsToken: TOKEN_A, onEvents: async (e, m) => { seen.a.push(m.txnId); } },
      { sideId: 'c.example', hsToken: 'hs_side_c_2222222222222222222222222222', onEvents: async () => {} },
    ]);
    const retry = await r.handle(putFor(TOKEN_A, 'keep-me'));
    expect(retry.duplicate).toBe(true);
    expect(seen.a).toEqual(['keep-me']); // not processed twice
    expect(r.sideIds()).toEqual(['a.example', 'c.example']);
  });

  test('a side whose TOKEN changed gets a fresh receiver', async () => {
    // A regenerated registration is a different credential, and its transaction ids come from a
    // homeserver that has just been restarted. Carrying the old window forward would be a guess.
    const { r, seen } = router();
    await r.handle(putFor(TOKEN_A, 'x'));
    const rotated = 'hs_side_a_rotated_33333333333333333333';
    r.setSides([{ sideId: 'a.example', hsToken: rotated, onEvents: async (e, m) => { seen.a.push(m.txnId); } }]);
    expect((await r.handle(putFor(TOKEN_A, 'x'))).status).toBe(403); // old token no longer works
    const again = await r.handle(putFor(rotated, 'x'));
    expect(again.duplicate).toBeUndefined();
    expect(seen.a).toEqual(['x', 'x']);
  });

  test('a removed side stops being reachable', async () => {
    const { r } = router();
    r.setSides([{ sideId: 'a.example', hsToken: TOKEN_A, onEvents: async () => {} }]);
    expect((await r.handle(putFor(TOKEN_B))).status).toBe(403);
    expect(r.sideIds()).toEqual(['a.example']);
  });

  test('an empty router refuses everything rather than accepting anything', async () => {
    const r = createAppserviceRouter();
    expect((await r.handle(putFor(TOKEN_A))).status).toBe(403);
    expect(r.sideIds()).toEqual([]);
  });

  test('sides with no id or no token are ignored, not half-registered', async () => {
    const r = createAppserviceRouter({
      sides: [
        { sideId: 'ok.example', hsToken: TOKEN_A, onEvents: async () => {} },
        { sideId: '', hsToken: TOKEN_B, onEvents: async () => {} },
        { sideId: 'no-token.example', onEvents: async () => {} },
      ],
    });
    expect(r.sideIds()).toEqual(['ok.example']);
  });

  test('the header form works through the router too', async () => {
    const { r, seen } = router();
    const res = await r.handle({
      method: 'PUT',
      path: '/_matrix/app/v1/transactions/hdr',
      query: {},
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: { events: [] },
    });
    expect(res.status).toBe(200);
    expect(seen.a).toEqual(['hdr']);
  });

  test('per-side deduplication windows are reportable', async () => {
    const { r } = router();
    await r.handle(putFor(TOKEN_A, 'one'));
    await r.handle(putFor(TOKEN_A, 'two'));
    await r.handle(putFor(TOKEN_B, 'one'));
    expect(r.seenCounts()).toEqual({ 'a.example': 2, 'b.example': 1 });
  });
});
