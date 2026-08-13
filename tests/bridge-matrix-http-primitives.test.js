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

describe('every primitive uses the base URL it was HANDED', () => {
  test('all seven reach the URL passed to them and nothing else', async () => {
    /*
     * The load-bearing assertion of this file, and it has now done its job once: it was written while
     * these functions read `HOMESERVER`, so that a version taking the URL as an argument could be
     * checked against it. The threading is done, and the assertion is unchanged in substance — every
     * call goes to the host it was given.
     *
     * The URL is REQUIRED rather than defaulted, which is why this test passes `baseUrl` at each call.
     * A default would let a caller holding an agent's credential silently send it to this deployment's
     * server instead of the agent's — a request that fails at best, and lands one side's token on
     * another side's server at worst. JavaScript cannot enforce a required parameter, so `requireBaseUrl`
     * throws with the function's name instead of letting `undefined/_matrix/...` fail obscurely.
     */
    handler = (path) => {
      if (path === '/_matrix/client/v3/account/whoami') return [200, { user_id: '@x:fake.test', device_id: 'D' }];
      if (path === '/_matrix/media/v3/upload') return [200, { content_uri: 'mxc://fake.test/abc' }];
      if (path === '/_matrix/client/v3/login') return [200, { access_token: 't', user_id: '@x:fake.test' }];
      return [200, {}];
    };
    await bridge.getUserIdForTest('tok', baseUrl);
    await bridge.getMatrixAccessTokenSessionForTest('tok', baseUrl);
    await bridge.uploadMediaForTest('tok', Buffer.from('png'), 'image/png', baseUrl);
    await bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc', baseUrl);
    await bridge.setRoomAvatarForTest('!r:fake.test', 'mxc://fake.test/abc', 'tok', baseUrl);
    await bridge.matrixLoginForTest('u', 'p', baseUrl);

    expect(calls.length).toBeGreaterThanOrEqual(6);
    const expectedHost = new URL(baseUrl).host;
    for (const call of calls) {
      expect(call.headers.host, call.path).toBe(expectedHost);
    }
  });
});

describe('a token-only caller can still find its own side', () => {
  /*
   * `sendAsAgentContent` and `sendAttachmentAsAgent` receive a TOKEN, not an agent name, so they
   * cannot resolve a homeserver by name. `baseUrlForToken` is how they get one. Tested directly
   * because those two methods are the choke points for every outbound agent message, and the
   * consequence of getting this wrong is sending an agent's credential to the wrong server.
   */
  const cred = (accessToken, serverName, homeserver) => ({
    homeserver, serverName, mxid: `@a:${serverName}`, accessToken,
  });

  test("an agent's token resolves to that agent's own homeserver", () => {
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = cred('tok-alpha', 'other.example', 'https://other.example');
    expect(bridge.baseUrlForTokenForTest('tok-alpha')).toBe('https://other.example');
  });

  test('a token nobody holds falls back to THIS deployment, not to undefined', () => {
    /*
     * The bot's own token is the real case: it is not in `agentTokens`, and ADR-014 decision 4's
     * split says the bot stays on the contributor's own homeserver. Returning undefined here would
     * make `requireBaseUrl` throw on every bot-sent attachment.
     */
    expect(bridge.baseUrlForTokenForTest('some-bot-token')).toBe(process.env.MATRIX_HOMESERVER);
  });

  test('an absent token also falls back rather than throwing', () => {
    for (const bad of [null, undefined, '']) {
      expect(bridge.baseUrlForTokenForTest(bad), String(bad)).toBe(process.env.MATRIX_HOMESERVER);
    }
  });

  test('it matches on the token, not on the agent name', () => {
    // Two agents on different servers: the token decides, because the token is what the caller has.
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = cred('tok-alpha', 'a.example', 'https://a.example');
    tokens.beta = cred('tok-beta', 'b.example', 'https://b.example');
    expect(bridge.baseUrlForTokenForTest('tok-beta')).toBe('https://b.example');
  });
});

describe('an omitted base URL is a throw, not a silent fallback', () => {
  test('every primitive refuses to run without one, and names itself', async () => {
    /*
     * The enforcement that makes "required" mean anything in JavaScript. Without it an omission
     * becomes `undefined/_matrix/...`, which fails several frames away as a fetch error against a
     * host that does not exist — and a DEFAULT would be worse still, because a caller holding an
     * agent's credential would silently send it to this deployment's own server.
     *
     * Each message names its function, so the frame that forgot is identifiable from the message
     * alone rather than from a stack trace through a rate-limit wrapper.
     */
    const cases = [
      ['getUserId', () => bridge.getUserIdForTest('tok')],
      ['getMatrixAccessTokenSession', () => bridge.getMatrixAccessTokenSessionForTest('tok')],
      ['uploadMedia', () => bridge.uploadMediaForTest('tok', Buffer.from('x'), 'image/png')],
      ['setUserAvatar', () => bridge.setUserAvatarForTest('tok', 'mxc://fake.test/a')],
      ['setRoomAvatar', () => bridge.setRoomAvatarForTest('!r:fake.test', 'mxc://fake.test/a', 'tok')],
      ['matrixLogin', () => bridge.matrixLoginForTest('u', 'p')],
      ['matrixRegister', () => bridge.matrixRegisterForTest('u', 'p')],
    ];
    for (const [name, call] of cases) {
      await expect(call(), name).rejects.toThrow(new RegExp(`^${name} requires a Matrix base URL`));
    }
    // And nothing was sent: the refusal happens before any request leaves.
    expect(calls).toHaveLength(0);
  });

  test('an empty or whitespace URL is refused too, not concatenated', async () => {
    for (const bad of ['', '   ', null, 0]) {
      await expect(bridge.getUserIdForTest('tok', bad), String(bad))
        .rejects.toThrow(/requires a Matrix base URL/);
    }
  });

  test('a trailing slash is trimmed rather than doubled', async () => {
    // Some homeservers 404 `//_matrix/...` instead of normalizing it.
    jsonOnce({ user_id: '@x:fake.test', device_id: 'D' });
    await bridge.getUserIdForTest('tok', `${baseUrl}///`);
    expect(calls[0].path).toBe('/_matrix/client/v3/account/whoami');
  });
});

describe('getUserId', () => {
  test('returns the user_id the homeserver reports', async () => {
    jsonOnce({ user_id: '@agent:fake.test', device_id: 'DEV1' });
    expect(await bridge.getUserIdForTest('tok-a', baseUrl)).toBe('@agent:fake.test');
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
    await expect(bridge.getUserIdForTest('dead', baseUrl)).rejects.toThrow(SyntaxError);
  });

  test('a 401 with a JSON body yields undefined rather than an error', async () => {
    // The other half of the same defect: no status check means an error body parses fine and the
    // function returns `undefined` for the user id, which reads as "no identity" rather than "denied".
    jsonOnce({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    expect(await bridge.getUserIdForTest('dead', baseUrl)).toBeUndefined();
  });
});

describe('getMatrixAccessTokenSession', () => {
  test('returns userId and deviceId', async () => {
    jsonOnce({ user_id: '@agent:fake.test', device_id: 'DEV1' });
    expect(await bridge.getMatrixAccessTokenSessionForTest('tok', baseUrl)).toEqual({
      userId: '@agent:fake.test', deviceId: 'DEV1',
    });
  });

  test('THE CONTRAST: it survives a non-JSON error body and carries the status', async () => {
    // The same 401 that makes getUserId throw a SyntaxError produces a usable verdict here, because
    // the status is read before the body is parsed.
    handler = () => [401, '<html>nginx</html>'];
    await expect(bridge.getMatrixAccessTokenSessionForTest('dead', baseUrl)).rejects.toMatchObject({ status: 401 });
  });

  test('a 5xx also carries its status, so a caller can tell it from a rejection', async () => {
    jsonOnce({ errcode: 'M_UNKNOWN' }, 503);
    await expect(bridge.getMatrixAccessTokenSessionForTest('tok', baseUrl)).rejects.toMatchObject({ status: 503 });
  });

  test('a 200 missing device_id is refused rather than returned half-built', async () => {
    jsonOnce({ user_id: '@agent:fake.test' });
    await expect(bridge.getMatrixAccessTokenSessionForTest('tok', baseUrl))
      .rejects.toThrow(/did not return both user_id and device_id/);
  });
});

describe('uploadMedia', () => {
  test('POSTs the bytes and returns the content_uri', async () => {
    jsonOnce({ content_uri: 'mxc://fake.test/xyz' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(await bridge.uploadMediaForTest('tok', png, 'image/png', baseUrl)).toBe('mxc://fake.test/xyz');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/_matrix/media/v3/upload');
    expect(calls[0].headers['content-type']).toBe('image/png');
    // The body is the raw buffer, not JSON — pinned because a refactor that wrapped it would upload
    // a JSON document as an image and only fail later, when a client tried to render it.
    expect(calls[0].bytes).toBe(png.length);
  });

  test('a failed upload throws with the status', async () => {
    jsonOnce({ errcode: 'M_TOO_LARGE' }, 413);
    await expect(bridge.uploadMediaForTest('tok', Buffer.from('x'), 'image/png', baseUrl))
      .rejects.toThrow(/Media upload failed: 413/);
  });
});

describe('setUserAvatar', () => {
  test('resolves the MXID first, then PUTs to that profile', async () => {
    handler = (path) => (path === '/_matrix/client/v3/account/whoami'
      ? [200, { user_id: '@agent:fake.test', device_id: 'D' }]
      : [200, {}]);
    await bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc', baseUrl);
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
    await expect(bridge.setUserAvatarForTest('tok', 'mxc://fake.test/abc', baseUrl)).resolves.toBeUndefined();
  });
});

describe('setRoomAvatar and its retry ladder', () => {
  test('a successful PUT uses the supplied token and sends the mxc url', async () => {
    jsonOnce({ event_id: '$e' });
    await bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', 'explicit-token', baseUrl);
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

  /** A credential record for a given server, which is the shape `state.agentTokens` now holds. */
  const cred = (accessToken, serverName) => ({
    homeserver: baseUrl, serverName, mxid: `@a:${serverName}`, accessToken,
  });

  test('THE LEAK, CLOSED: a credential for ANOTHER server is never offered to this room', async () => {
    /*
     * The defect this rewrite fixes, and the reason it was a defect rather than a tightening.
     *
     * The ladder used to iterate every value in `state.agentTokens` and send each to `HOMESERVER`.
     * Under one homeserver that is a sane fallback — the bot may lack the power level to set a room
     * avatar while an agent in the room has it. Once ADR-016 stops assuming federation, that map
     * holds one credential per agent ACROSS DIFFERENT HOMESERVERS, so the loop offered every project
     * side's access token to whichever server the call was aimed at. A credential disclosure across
     * project sides, caused by a cosmetic feature, arriving the moment a second project side exists.
     *
     * The room is `!room:fake.test`, so only `fake.test` credentials may be tried. The other side's
     * token must not appear in ANY request — which is what makes this an assertion about disclosure
     * and not merely about retry order.
     *
     * `null` is passed as the token so `useToken === state.botToken` holds (both are null on a bridge
     * that has not logged in), which is the condition guarding the ladder.
     */
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = cred('token-this-side', 'fake.test');
    tokens.beta = cred('token-OTHER-side', 'someone-else.example');

    handler = () => [403, { errcode: 'M_FORBIDDEN' }];
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null, baseUrl))
      .rejects.toThrow(/setRoomAvatar failed: M_FORBIDDEN/);

    const tried = calls.map(bearerOf);
    /*
     * The first attempt is the bot's, and it is asserted as "neither agent credential" rather than by
     * its literal value. An earlier version asserted `'null'`, on the reasoning that an instance which
     * has not logged in has `state.botToken === null` — but `loadState` returns the parsed file, so on
     * an instance bound to a real state directory the field is simply ABSENT and the header reads
     * `Bearer undefined`. The test then failed on the serialization of a value it does not care about.
     */
    expect(tried[0]).not.toBe('token-this-side');
    expect(tried[0]).not.toBe('token-OTHER-side');
    expect(tried).toContain('token-this-side');
    expect(tried).not.toContain('token-OTHER-side');
  });

  test('the ladder stops at the first same-server credential that succeeds', async () => {
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = cred('token-A', 'fake.test');
    tokens.beta = cred('token-B', 'fake.test');

    handler = (path, q, method, body, headers) => (
      String(headers.authorization) === 'Bearer token-A'
        ? [200, { event_id: '$ok' }]
        : [403, { errcode: 'M_FORBIDDEN' }]
    );
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null, baseUrl))
      .resolves.toBeUndefined();
    expect(calls.map(bearerOf)).not.toContain('token-B');
  });

  test('a room id with no server part tries NOTHING, rather than everything', async () => {
    /*
     * `projectServerFromRoomId` returns null for a malformed id. Failing closed matters here: the
     * alternative reading — "no target server, so any credential may as well be tried" — is the
     * original leak restored by a null check.
     */
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = cred('token-this-side', 'fake.test');

    handler = () => [403, { errcode: 'M_FORBIDDEN' }];
    await expect(bridge.setRoomAvatarForTest('malformed-room-id', 'mxc://fake.test/abc', null, baseUrl))
      .rejects.toThrow(/M_FORBIDDEN/);
    expect(calls).toHaveLength(1);
    expect(calls.map(bearerOf)).not.toContain('token-this-side');
  });

  test('the base URL is a PARAMETER, and an explicit one is used instead of the constant', async () => {
    /*
     * ADR-016's third first-pass shape. The default still reads `HOMESERVER`, so the other tests in
     * this file exercise the home-bot path; this one proves a caller that knows its side can override
     * it. The override points at a second in-process listener so "went somewhere else" is observable
     * rather than inferred from an error.
     */
    const otherCalls = [];
    const other = createServer((req, res) => {
      otherCalls.push({ path: new URL(req.url, 'http://x').pathname });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherBase = `http://127.0.0.1:${other.address().port}`;
    try {
      await bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', 'tok', otherBase);
      expect(otherCalls).toHaveLength(1);
      expect(otherCalls[0].path).toBe('/_matrix/client/v3/rooms/!room%3Afake.test/state/m.room.avatar');
      // And nothing reached the default server.
      expect(calls).toHaveLength(0);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  test('an EXPLICIT token that is refused does NOT trigger the ladder', async () => {
    // The guard is `useToken === state.botToken`. A caller who named a token gets its failure
    // reported rather than silently escalated to somebody else's credential.
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';

    handler = () => [403, { errcode: 'M_FORBIDDEN' }];
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', 'explicit', baseUrl))
      .rejects.toThrow(/M_FORBIDDEN/);
    expect(calls).toHaveLength(1);
    expect(calls.map(bearerOf)).not.toContain('token-side-A');
  });

  test('a non-403 failure is reported without any retry', async () => {
    const tokens = bridge.agentTokenStateForTest();
    tokens.alpha = 'token-side-A';
    jsonOnce({ errcode: 'M_NOT_FOUND' }, 404);
    await expect(bridge.setRoomAvatarForTest('!room:fake.test', 'mxc://fake.test/abc', null, baseUrl))
      .rejects.toThrow(/setRoomAvatar failed: M_NOT_FOUND/);
    expect(calls).toHaveLength(1);
  });
});

describe('matrixLogin', () => {
  test('posts a password login and returns the body', async () => {
    jsonOnce({ access_token: 'tok', user_id: '@u:fake.test', device_id: 'D' });
    const out = await bridge.matrixLoginForTest('someone', 'secret', baseUrl);
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
    const out = await bridge.matrixRegisterForTest('newuser', 'pw', baseUrl);
    expect(out.access_token).toBe('minted');
    expect(seen).toBe(2);
    expect(JSON.parse(calls[1].body).auth).toEqual({
      type: 'm.login.registration_token', token: 'reg-token-from-env', session: 's1',
    });
  });

  test('a server that registers outright needs no second call', async () => {
    jsonOnce({ access_token: 'immediate', user_id: '@new:fake.test' });
    expect((await bridge.matrixRegisterForTest('newuser', 'pw', baseUrl)).access_token).toBe('immediate');
    expect(calls).toHaveLength(1);
  });

  test('no session and no token is a refusal that names what to do', async () => {
    jsonOnce({ flows: [{ stages: ['m.login.email.identity'] }] }, 401);
    await expect(bridge.matrixRegisterForTest('newuser', 'pw', baseUrl)).rejects.toThrow(/No session in registration probe/);
  });
});
