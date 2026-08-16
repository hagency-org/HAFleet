/*
 * What this deployment can reach, and where it can be reached back — the read that turns adding a project
 * side from a shell recipe into a form.
 *
 * The operator's objection was 「你让用户跑 script？」, and the reason it lands is that the recipe's hardest
 * step is a GUESS: which address can the customer's homeserver use to call HAFleet. Guess wrong and, in the
 * words of `docs/FOR-PROJECT-SIDES.md`, "the symptom is silence rather than an error".
 *
 * So the tests below are mostly about honesty rather than features. Two things must never happen: an
 * unreachable homeserver must not be reported as reachable, and an unverified callback address must not be
 * presented as verified. The second is the harder discipline — Matrix has no way to ask a homeserver to
 * call us back, so this module CANNOT know, and a tool that implied otherwise would be worse than the
 * recipe because the operator would stop looking.
 */
import { describe, expect, test } from 'vitest';
import {
  callbackCandidates,
  describeMatrixReach,
  originFor,
  probeHomeserver,
} from '../lib/matrix-candidates.js';

/** A fetch that answers whatever the test says, and records what it was asked. */
function fakeFetch(routes) {
  const asked = [];
  const impl = async (url) => {
    asked.push(String(url));
    const answer = routes[String(url)] ?? routes.default;
    if (!answer) throw new Error('connect ECONNREFUSED');
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new Error('not json');
        return answer.body;
      },
    };
  };
  impl.asked = asked;
  return impl;
}

describe('turning what an operator typed into something probeable', () => {
  test('a bare server name is not an address', () => {
    // The distinction that keeps a probe honest. Guessing `http://` for `palpo.test` would produce a real
    // verdict about the wrong URL — and on a server that only serves https, the wrong verdict.
    expect(originFor('palpo.test')).toBeNull();
    expect(originFor('')).toBeNull();
    expect(originFor(null)).toBeNull();
  });

  test('a URL is reduced to its origin, so a path cannot change what gets probed', () => {
    expect(originFor('http://127.0.0.1:8008/_matrix/')).toBe('http://127.0.0.1:8008');
    expect(originFor('https://matrix.example.org')).toBe('https://matrix.example.org');
  });
});

describe('asking a homeserver whether it is there', () => {
  test('200 with a versions array is the only thing that counts as reachable', async () => {
    const fetchImpl = fakeFetch({ default: { status: 200, body: { versions: ['v1.11', 'v1.12'] } } });
    const result = await probeHomeserver('http://hs.test', { fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.versions).toEqual(['v1.11', 'v1.12']);
    expect(fetchImpl.asked[0]).toBe('http://hs.test/_matrix/client/versions');
  });

  test('a 200 that is not JSON is a proxy, not a homeserver', async () => {
    // The failure this prevents: installing a namespace-wide registration into something that answers 200
    // and is not a Matrix server at all.
    const result = await probeHomeserver('http://hs.test', { fetchImpl: fakeFetch({ default: { status: 200 } }) });
    expect(result.reachable).toBe(false);
    expect(result.reason).toMatch(/not with JSON/);
  });

  test('a 200 with no versions array is refused too', async () => {
    const fetchImpl = fakeFetch({ default: { status: 200, body: { hello: 'world' } } });
    const result = await probeHomeserver('http://hs.test', { fetchImpl });
    expect(result.reachable).toBe(false);
    expect(result.reason).toMatch(/no `versions` array/);
  });

  test('an HTTP error carries its status, because 404 and 502 send you to different places', async () => {
    const result = await probeHomeserver('http://hs.test', { fetchImpl: fakeFetch({ default: { status: 502 } }) });
    expect(result).toMatchObject({ reachable: false, status: 502 });
  });

  test('a refused connection is reported as itself, not as a timeout', async () => {
    const result = await probeHomeserver('http://hs.test', {
      fetchImpl: fakeFetch({ default: new Error('connect ECONNREFUSED 127.0.0.1:8008') }),
    });
    expect(result.reachable).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  test('a timeout says how long it waited', async () => {
    const result = await probeHomeserver('http://hs.test', {
      fetchImpl: fakeFetch({ default: new Error('The operation was aborted due to timeout') }),
      timeoutMs: 1234,
    });
    expect(result.reason).toBe('no answer within 1234ms');
  });

  test('nothing to probe is its own answer and makes no request', async () => {
    const fetchImpl = fakeFetch({});
    const result = await probeHomeserver(null, { fetchImpl });
    expect(result.reachable).toBe(false);
    expect(fetchImpl.asked).toHaveLength(0);
  });
});

describe('addresses the homeserver might reach us at', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false }],
  };

  test('the container name comes first and loopback comes last', () => {
    /*
     * Ordered by how often each is right, not alphabetically. The operator picking from this list is being
     * asked a question they should not have to be an expert to answer, and `127.0.0.1` is simultaneously
     * the right answer for a co-hosted homeserver and the most common wrong answer for a containerised one.
     */
    const list = callbackCandidates({ port: 8009, interfaces });
    expect(list[0].url).toBe('http://host.docker.internal:8009');
    expect(list[list.length - 1].url).toBe('http://127.0.0.1:8009');
  });

  test('loopback carries the warning that makes it safe to offer', () => {
    // Omitting it would be wrong for a co-hosted homeserver; offering it bare is how the documented
    // afternoon-long trap gets sprung again.
    const last = callbackCandidates({ port: 8009, interfaces }).at(-1);
    expect(last.confidence).toMatch(/container/);
    expect(last.confidence).toMatch(/receive nothing/);
  });

  test('internal and IPv6 addresses are left out', () => {
    const urls = callbackCandidates({ port: 8009, interfaces }).map((c) => c.url);
    expect(urls).toContain('http://192.168.1.20:8009');
    expect(urls.filter((u) => u.includes('127.0.0.1'))).toHaveLength(1); // the deliberate one only
    expect(urls.some((u) => u.includes('fe80'))).toBe(false);
  });

  test('every candidate says why it is a candidate', () => {
    for (const c of callbackCandidates({ port: 8009, interfaces })) {
      expect(typeof c.why).toBe('string');
      expect(c.why.length).toBeGreaterThan(10);
    }
  });
});

describe('the whole answer a setup form needs', () => {
  const interfaces = { en0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] };
  const reachable = { status: 200, body: { versions: ['v1.12'] } };

  test('no appservice port means no socket, and it says so instead of offering addresses', async () => {
    /*
     * The fact an operator would otherwise learn last. With no port the bridge opens no socket, so a
     * perfect registration installed at a perfect address receives nothing — and offering callback
     * addresses in that state would be inviting someone to pick between three answers that are all moot.
     */
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'hs.test', MATRIX_HOMESERVER: 'http://hs.test' },
      fetchImpl: fakeFetch({ default: reachable }),
      interfaces,
    });
    expect(reach.appservice.listening).toBe(false);
    expect(reach.appservice.callbackCandidates).toEqual([]);
    expect(reach.appservice.reason).toMatch(/HAFLEET_APPSERVICE_PORT/);
  });

  test('with a port, candidates come with an explicit statement that none is proven', async () => {
    // The discipline this module exists to keep. It cannot know, so it must not imply that it does.
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'hs.test', MATRIX_HOMESERVER: 'http://hs.test', HAFLEET_APPSERVICE_PORT: '8009' },
      fetchImpl: fakeFetch({ default: reachable }),
      interfaces,
    });
    expect(reach.appservice.listening).toBe(true);
    expect(reach.appservice.callbackCandidates.length).toBeGreaterThan(0);
    expect(reach.appservice.proof).toMatch(/None of these addresses is verified/);
  });

  test('a server that is already a project side is marked, not hidden', async () => {
    // Hidden, an operator wonders why their homeserver is missing and re-checks their config. Marked, they
    // can see it is here and already done.
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'hs.test', MATRIX_HOMESERVER: 'http://hs.test' },
      sides: [{ id: 'hs.test', serverName: 'hs.test' }],
      fetchImpl: fakeFetch({ default: reachable }),
      interfaces,
    });
    expect(reach.homeservers).toHaveLength(1);
    expect(reach.homeservers[0].alreadyASide).toBe(true);
  });

  test('the fleet\'s own homeserver is not listed twice when it is also a side', async () => {
    const fetchImpl = fakeFetch({ default: reachable });
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'hs.test', MATRIX_HOMESERVER: 'http://hs.test' },
      sides: [{ id: 'hs.test', serverName: 'hs.test', apiBaseUrl: 'http://hs.test' }],
      fetchImpl,
      interfaces,
    });
    expect(reach.homeservers).toHaveLength(1);
    // And probed once, not twice: a duplicate would double the wait an operator sits through.
    expect(fetchImpl.asked).toHaveLength(1);
  });

  test('a side with no probeable URL is listed with an honest reason, not omitted', async () => {
    /*
     * A side recorded by server name alone cannot be probed, and dropping it would make the form claim the
     * operator has fewer sides than they do. "Cannot tell" is a real answer and belongs on the screen.
     */
    const reach = await describeMatrixReach({
      env: {},
      sides: [{ id: 'nameonly.test', serverName: 'nameonly.test' }],
      fetchImpl: fakeFetch({}),
      interfaces,
    });
    expect(reach.homeservers).toHaveLength(1);
    expect(reach.homeservers[0].probe.reachable).toBe(false);
    expect(reach.homeservers[0].probe.reason).toMatch(/bare server name/);
  });

  test('one unreachable homeserver does not hide the reachable ones', async () => {
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'good.test', MATRIX_HOMESERVER: 'http://good.test' },
      sides: [{ id: 'bad.test', serverName: 'bad.test', apiBaseUrl: 'http://bad.test' }],
      fetchImpl: fakeFetch({
        'http://good.test/_matrix/client/versions': reachable,
        'http://bad.test/_matrix/client/versions': new Error('connect ECONNREFUSED'),
      }),
      interfaces,
    });
    const byName = Object.fromEntries(reach.homeservers.map((h) => [h.serverName, h.probe.reachable]));
    expect(byName).toEqual({ 'good.test': true, 'bad.test': false });
  });
});
