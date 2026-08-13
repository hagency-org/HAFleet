/*
 * The bridge's token-taking Matrix primitives, EXECUTED against a homeserver this test controls.
 *
 * WHY THIS FILE EXISTS. ADR-014 decision 4 classified `bridge-matrix.js`'s 44 `HOMESERVER`
 * references into three buckets and named the third as the expensive one: functions that take
 * whichever token their caller holds, and therefore need a base URL passed in beside the token
 * instead of reading a module constant. ADR-016's first pass has to make that change.
 *
 * Nothing in this repository ran any of them. Every existing bridge test asserts against the file's
 * SOURCE TEXT — `readFileSync(new URL('../bridge-matrix.js'))` and a pile of regexes — which is a
 * reasonable way to pin a comment or a constant and a useless way to know whether a signature change
 * still talks to a homeserver correctly. Threading a base URL through seven functions under text
 * assertions is a refactor with no safety net.
 *
 * The premise that it COULD not be exercised turned out to be wrong: the module imports cleanly in
 * 590ms and already exports fifty-odd symbols including test hooks. What was missing was the willingness
 * to point it at a fake server. `MATRIX_HOMESERVER` is read at module evaluation, so setting it before
 * a cache-busted dynamic import gives real HTTP against an in-process listener.
 *
 * WHAT IS PINNED HERE IS CURRENT BEHAVIOUR, INCLUDING ITS DEFECTS. `getUserId` parses its body with
 * no status check — exactly what `getMatrixAccessTokenSession`'s own comment warns against —
 * and `setUserAvatar` ignores its PUT's response. Those are asserted as they are, so the refactor is
 * judged against what the code does rather than against what it should do. Fixing them is a separate
 * change with a separate argument.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createServer } from 'http';
import { pathToFileURL } from 'url';

let server;
let baseUrl;
let calls = [];
/** Per-path handler: (path, searchParams, method, body, headers) => [status, jsonBody]. */
let handler = () => [404, { errcode: 'M_UNRECOGNIZED' }];
let bridge;

const savedEnv = new Map();
function rememberEnv(key) { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      calls.push({
        path: url.pathname,
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw.toString('utf8'),
        bytes: raw.length,
      });
      const [status, payload] = handler(url.pathname, url.searchParams, req.method, raw, req.headers);
      res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/html' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  /*
   * Set before the import, because the module captures HOMESERVER at evaluation. Cache-busted so
   * this file gets its own instance rather than one another test already bound elsewhere — the same
   * hazard `tests/helpers/backend-test-runtime.js` documents at length for the backend.
   */
  for (const key of ['MATRIX_HOMESERVER', 'MATRIX_SERVER_NAME', 'MATRIX_REG_TOKEN']) rememberEnv(key);
  process.env.MATRIX_HOMESERVER = baseUrl;
  process.env.MATRIX_SERVER_NAME = 'fake.test';
  process.env.MATRIX_REG_TOKEN = 'reg-token-from-env';

  const url = pathToFileURL(new URL('../bridge-matrix.js', import.meta.url).pathname).href;
  bridge = await import(`${url}?http-primitives=${Date.now()}`);
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  calls = [];
  handler = () => [404, { errcode: 'M_UNRECOGNIZED' }];
  // The token map is returned BY REFERENCE, so leaving entries behind would arm the
  // setRoomAvatar retry ladder for unrelated cases.
  const tokens = bridge.agentTokenStateForTest();
  for (const key of Object.keys(tokens)) delete tokens[key];
});

const jsonOnce = (payload, status = 200) => { handler = () => [status, payload]; };
const bearerOf = (call) => String(call.headers.authorization || '').replace(/^Bearer /, '');

describe('every primitive targets MATRIX_HOMESERVER — the property the refactor changes', () => {
  test('all seven reach the configured base URL and nothing else', async () => {
    /*
     * The load-bearing assertion of this file. Once these take a base URL as an argument, this test
     * is what proves each one still uses the URL it was given: today that URL comes from the module
     * constant, and the host recorded here is the fake server's, so a function that kept reading the
     * constant after the refactor would fail.
     */
    handler = (path) => {
      if (path === '/_matrix/client/v3/account/whoami') return [200, { user_id: '@x:fake.test', device_id: 'D' }];
      if (path === '/_matrix/media/v3/upload') return [200, { content_uri: 'mxc://fake.test/abc' }];
      if (path === '/_matrix/client/v3/login') return [200, { access_token: 't', user_id: '@x:fake.test' }];
      return [200, {}];
    };
    await bridge.getUserIdForTest('tok');
    await bridge.getMatrixAccessTokenSessionForTest('tok');
    await bridge.uploadMediaForTest('tok', Buffer.from('png'), 'image/png');
    await bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc');
    await bridge.setRoomAvatarForTest('!r:fake.test', 'mxc://fake.test/abc', 'tok');
    await bridge.matrixLoginForTest('u', 'p');

    expect(calls.length).toBeGreaterThanOrEqual(6);
    const expectedHost = new URL(baseUrl).host;
    for (const call of calls) {
      expect(call.headers.host, call.path).toBe(expectedHost);
    }
  });
});

describe('getUserId', () => {
  test('returns the user_id the homeserver reports', async () => {
    jsonOnce({ user_id: '@agent:fake.test', device_id: 'DEV1' });
    expect(await bridge.getUserIdForTest('tok-a')).toBe('@agent:fake.test');
    expect(calls[0].path).toBe('/_matrix/client/v3/account/whoami');
    expect(bearerOf(calls[0])).toBe('tok-a');
  });

  test('PINNED DEFECT: it has no status check, so a non-JSON error body throws a SyntaxError', async () => {
    /*
     * Not an accusation of this test — the behaviour is real, and it is exactly what
     * `getMatrixAccessTokenSession`'s comment says must not happen: a SyntaxError carries no
     * `.status`, so a caller classifying failures cannot tell a dead token from an outage.
     *
     * Pinned as-is because the refactor under way is a base-URL change, and changing error handling
     * in the same commit would make a regression indistinguishable from an intended improvement.
     * The assertion is written so that FIXING it fails this test loudly, which is the right way for
     * that decision to be forced.
     */
    handler = () => [401, '<html>nginx</html>'];
    await expect(bridge.getUserIdForTest('dead')).rejects.toThrow(SyntaxError);
  });

  test('a 401 with a JSON body yields undefined rather than an error', async () => {
    // The other half of the same defect: no status check means an error body parses fine and the
    // function returns `undefined` for the user id, which reads as "no identity" rather than "denied".
    jsonOnce({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    expect(await bridge.getUserIdForTest('dead')).toBeUndefined();
  });
});

describe('getMatrixAccessTokenSession', () => {
  test('returns userId and deviceId', async () => {
    jsonOnce({ user_id: '@agent:fake.test', device_id: 'DEV1' });
    expect(await bridge.getMatrixAccessTokenSessionForTest('tok')).toEqual({
      userId: '@agent:fake.test', deviceId: 'DEV1',
    });
  });

  test('THE CONTRAST: it survives a non-JSON error body and carries the status', async () => {
    // The same 401 that makes getUserId throw a SyntaxError produces a usable verdict here, because
    // the status is read before the body is parsed.
    handler = () => [401, '<html>nginx</html>'];
    await expect(bridge.getMatrixAccessTokenSessionForTest('dead')).rejects.toMatchObject({ status: 401 });
  });

  test('a 5xx also carries its status, so a caller can tell it from a rejection', async () => {
    jsonOnce({ errcode: 'M_UNKNOWN' }, 503);
    await expect(bridge.getMatrixAccessTokenSessionForTest('tok')).rejects.toMatchObject({ status: 503 });
  });

  test('a 200 missing device_id is refused rather than returned half-built', async () => {
    jsonOnce({ user_id: '@agent:fake.test' });
    await expect(bridge.getMatrixAccessTokenSessionForTest('tok'))
      .rejects.toThrow(/did not return both user_id and device_id/);
  });
});

describe('uploadMedia', () => {
  test('POSTs the bytes and returns the content_uri', async () => {
    jsonOnce({ content_uri: 'mxc://fake.test/xyz' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(await bridge.uploadMediaForTest('tok', png, 'image/png')).toBe('mxc://fake.test/xyz');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/_matrix/media/v3/upload');
    expect(calls[0].headers['content-type']).toBe('image/png');
    // The body is the raw buffer, not JSON — pinned because a refactor that wrapped it would upload
    // a JSON document as an image and only fail later, when a client tried to render it.
    expect(calls[0].bytes).toBe(png.length);
  });

  test('a failed upload throws with the status', async () => {
    jsonOnce({ errcode: 'M_TOO_LARGE' }, 413);
    await expect(bridge.uploadMediaForTest('tok', Buffer.from('x'), 'image/png'))
      .rejects.toThrow(/Media upload failed: 413/);
  });
});

describe('setUserAvatar', () => {
  test('resolves the MXID first, then PUTs to that profile', async () => {
    handler = (path) => (path === '/_matrix/client/v3/account/whoami'
      ? [200, { user_id: '@agent:fake.test', device_id: 'D' }]
      : [200, {}]);
    await bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc');
    expect(calls[0].path).toBe('/_matrix/client/v3/account/whoami');
    // The MXID is URL-encoded into the path: `@` and `:` must not arrive raw.
    expect(calls[1].path).toBe('/_matrix/client/v3/profile/%40agent%3Afake.test/avatar_url');
    expect(JSON.parse(calls[1].body)).toEqual({ avatar_url: 'mxc://fake.test/abc' });
  });

  test('PINNED DEFECT: a rejected PUT is ignored, so the call resolves as if it worked', async () => {
    /*
     * There is no `res.ok` check. An avatar that the homeserver refused reports success, which is why
     * an operator can set one and see nothing change with no error anywhere.
     *
     * Pinned rather than fixed for the same reason as getUserId's: this is a base-URL refactor.
     */
    handler = (path) => (path === '/_matrix/client/v3/account/whoami'
      ? [200, { user_id: '@agent:fake.test', device_id: 'D' }]
      : [403, { errcode: 'M_FORBIDDEN' }]);
    await expect(bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc')).resolves.toBeUndefined();
  });
});

describe('setRoomAvatar and its retry ladder', () => {
  test('a successful PUT uses the supplied token and sends the mxc url', async () => {
    jsonOnce({ event_id: '$e' });
    await bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', 'explicit-token');
    /*
     * `!` arrives UNENCODED and `:` does not. `encodeURIComponent` leaves `- _ . ! ~ * ' ( )` alone,
     * so a room id keeps its sigil in the path while its colon becomes `%3A`. Written out because the
     * first version of this assertion guessed `%21` and failed — and because the same guess in the
     * opposite direction is what the console proxy's SAFE_SEGMENT class already had to get right.
     */
    expect(calls[0].path).toBe('/_matrix/client/v3/rooms/!room%3Afake.test/state/m.room.avatar');
    expect(bearerOf(calls[0])).toBe('explicit-token');
    expect(JSON.parse(calls[0].body)).toEqual({ url: 'mxc://fake.test/abc' });
  });

  test('THE LADDER: a 403 with the bot token retries with EVERY agent token', async () => {
    /*
     * THIS IS THE TEST THE REFACTOR NEEDS MOST, and not because the ladder is subtle.
     *
     * Under one homeserver it is a reasonable fallback: the bot may lack power to set a room avatar
     * while some agent in the room has it. Under ADR-016 there are MANY homeservers and
     * `state.agentTokens` holds one credential per agent across all of them — so this loop sends
     * every project side's access token to whichever homeserver `HOMESERVER` happens to name. That is
     * a credential disclosure across project sides, produced by a cosmetic feature, and it appears
     * the moment a second project side exists rather than being introduced by the refactor.
     *
     * Pinning the ladder's shape here is what makes the fix checkable: after the refactor this test
     * must be rewritten to assert that only tokens belonging to the TARGET side are tried.
     *
     * `null` is passed as the token so `useToken === state.botToken` holds (both are null on a bridge
     * that has not logged in), which is the condition guarding the ladder.
     */
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';
    tokens.beta = 'token-side-B';

    handler = () => [403, { errcode: 'M_FORBIDDEN' }];
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null))
      .rejects.toThrow(/setRoomAvatar failed: M_FORBIDDEN/);

    const tried = calls.map(bearerOf);
    expect(tried[0]).toBe('null'); // `Bearer null` — the bot token is unset on this instance
    expect(tried).toContain('token-side-A');
    expect(tried).toContain('token-side-B');
  });

  test('the ladder stops at the first agent token that succeeds', async () => {
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';
    tokens.beta = 'token-side-B';

    handler = (path, q, method, body, headers) => (
      String(headers.authorization) === 'Bearer token-side-A'
        ? [200, { event_id: '$ok' }]
        : [403, { errcode: 'M_FORBIDDEN' }]
    );
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null))
      .resolves.toBeUndefined();
    expect(calls.map(bearerOf)).not.toContain('token-side-B');
  });

  test('an EXPLICIT token that is refused does NOT trigger the ladder', async () => {
    // The guard is `useToken === state.botToken`. A caller who named a token gets its failure
    // reported rather than silently escalated to somebody else's credential.
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';

    handler = () => [403, { errcode: 'M_FORBIDDEN' }];
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', 'explicit'))
      .rejects.toThrow(/M_FORBIDDEN/);
    expect(calls).toHaveLength(1);
    expect(calls.map(bearerOf)).not.toContain('token-side-A');
  });

  test('a non-403 failure is reported without any retry', async () => {
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';
    jsonOnce({ errcode: 'M_NOT_FOUND' }, 404);
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null))
      .rejects.toThrow(/setRoomAvatar failed: M_NOT_FOUND/);
    expect(calls).toHaveLength(1);
  });
});

describe('matrixLogin', () => {
  test('posts a password login and returns the body', async () => {
    jsonOnce({ access_token: 'tok', user_id: '@u:fake.test', device_id: 'D' });
    const out = await bridge.matrixLoginForTest('someone', 'secret');
    expect(calls[0].path).toBe('/_matrix/client/v3/login');
    expect(calls[0].method).toBe('POST');
    const sent = JSON.parse(calls[0].body);
    expect(sent.type).toBe('m.login.password');
    expect(out.access_token).toBe('tok');
  });
});

describe('matrixRegister', () => {
  test('completes UIA with the configured registration token', async () => {
    let seen = 0;
    handler = (path, q, method, body) => {
      if (path !== '/_matrix/client/v3/register') return [404, {}];
      seen += 1;
      const parsed = JSON.parse(String(body) || '{}');
      if (!parsed.auth) return [401, { session: 's1', flows: [{ stages: ['m.login.registration_token'] }] }];
      return [200, { access_token: 'minted', user_id: '@new:fake.test' }];
    };
    const out = await bridge.matrixRegisterForTest('newuser', 'pw');
    expect(out.access_token).toBe('minted');
    expect(seen).toBe(2);
    expect(JSON.parse(calls[1].body).auth).toEqual({
      type: 'm.login.registration_token', token: 'reg-token-from-env', session: 's1',
    });
  });

  test('a server that registers outright needs no second call', async () => {
    jsonOnce({ access_token: 'immediate', user_id: '@new:fake.test' });
    expect((await bridge.matrixRegisterForTest('newuser', 'pw')).access_token).toBe('immediate');
    expect(calls).toHaveLength(1);
  });

  test('no session and no token is a refusal that names what to do', async () => {
    jsonOnce({ flows: [{ stages: ['m.login.email.identity'] }] }, 401);
    await expect(bridge.matrixRegisterForTest('newuser', 'pw')).rejects.toThrow(/No session in registration probe/);
  });
});
