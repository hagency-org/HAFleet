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
import { classifyMatrixFailure } from '../lib/matrix-representative.js';
import {
  callbackCandidates,
  describeMatrixReach,
  diagnoseEdgeInbound,
  verifyCallbackFromHomeserver,
  discoverBaseUrl,
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

  test('Podman\'s name is offered too, since it is not the same as Docker\'s', () => {
    /*
     * `host.docker.internal` is injected by the container RUNTIME, not resolved by DNS, and runtimes do
     * not agree: Podman uses `host.containers.internal`, verified unreachable from a Docker container on
     * the deployment that prompted this. Offering only the Docker name silently excludes Podman users.
     */
    const urls = callbackCandidates({ port: 8009, interfaces }).map((c) => c.url);
    expect(urls).toContain('http://host.docker.internal:8009');
    expect(urls).toContain('http://host.containers.internal:8009');
  });

  test('the Docker name says it is absent on Linux Docker Engine', () => {
    // The first version claimed "Docker or Colima reaches its host by this name", which is wrong exactly
    // where it matters most: Linux Docker Engine is the commonest production shape and does not provide it.
    const docker = callbackCandidates({ port: 8009, interfaces })
      .find((c) => c.url.includes('host.docker.internal'));
    expect(docker.confidence).toMatch(/Linux/);
    expect(docker.confidence).toMatch(/add-host/);
  });

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

describe('turning a server name into an address, which the protocol already specifies', () => {
  /*
   * ASKING THE OPERATOR FOR BOTH WAS THE MISTAKE: 「服务器地址你应该知道」. Matrix defines how a name
   * becomes an address and every client does it on every login, so a form demanding both is asking a
   * human to do the protocol's job and to be right about it.
   */
  test('a well-known that declares a base_url is followed', async () => {
    // The case that makes the whole mechanism exist: the server is called one thing and served at another.
    const fetchImpl = fakeFetch({
      'https://example.org/.well-known/matrix/client': {
        status: 200,
        body: { 'm.homeserver': { base_url: 'https://matrix.example.org' } },
      },
    });
    const out = await discoverBaseUrl('example.org', { fetchImpl });
    expect(out.url).toBe('https://matrix.example.org');
    expect(out.via).toMatch(/well-known/);
  });

  test('no well-known falls back to the name itself, and says it fell back', async () => {
    // The spec's own fallback. `via` matters because "we read your well-known" and "we guessed" are
    // different claims, and an operator debugging a wrong address needs to know which they are seeing.
    const out = await discoverBaseUrl('example.org', { fetchImpl: fakeFetch({ default: { status: 404 } }) });
    expect(out.url).toBe('https://example.org');
    expect(out.via).toMatch(/no well-known/);
  });

  test('a well-known that cannot be fetched at all still yields the fallback', async () => {
    // The commonest case on a private deployment: the name does not resolve publicly, which says nothing
    // about whether the homeserver is reachable some other way.
    const out = await discoverBaseUrl('internal.test', {
      fetchImpl: fakeFetch({ default: new Error('getaddrinfo ENOTFOUND') }),
    });
    expect(out.url).toBe('https://internal.test');
    expect(out.via).toMatch(/could not read/);
  });

  test('a well-known with no usable base_url falls back rather than trusting it', async () => {
    const fetchImpl = fakeFetch({ default: { status: 200, body: { 'm.homeserver': { base_url: 'not a url' } } } });
    const out = await discoverBaseUrl('example.org', { fetchImpl });
    expect(out.url).toBe('https://example.org');
    expect(out.via).toMatch(/no usable base_url/);
  });

  test('a name carrying a port skips discovery instead of inventing a rule', async () => {
    // The spec does not define well-known for a name with a port, and `palpo2.test:8009` is already an
    // address in everything but scheme.
    const fetchImpl = fakeFetch({});
    const out = await discoverBaseUrl('palpo2.test:8009', { fetchImpl });
    expect(out.url).toBe('https://palpo2.test:8009');
    expect(fetchImpl.asked).toHaveLength(0);
  });

  test('an empty name is not turned into an address', async () => {
    expect((await discoverBaseUrl('', { fetchImpl: fakeFetch({}) })).url).toBeNull();
  });
});

describe('a co-located edge is also a way in', () => {
  /*
   * FOUND BY THE OPERATOR USING THE SCREEN. With no `HAFLEET_APPSERVICE_PORT` this reported "the bridge opens
   * no socket… a registration installed now would receive nothing" — while the edge link was delivering,
   * verified at 88 of 88 transactions. Worse than a cosmetic error: it told them to open an inbound socket,
   * which is precisely what co-locating exists to avoid, on a host that sits on a public IP.
   */
  const edgeEnv = {
    HAFLEET_EDGE_URL: 'http://127.0.0.1:8095',
    HAFLEET_EDGE_LINK_TOKEN: 'link',
    HAFLEET_EDGE_SIDE: 'acme.test',
  };

  test('an edge is reported as the way in, not as nothing listening', async () => {
    const reach = await describeMatrixReach({
      env: { ...edgeEnv, MATRIX_SERVER_NAME: 'acme.test' },
      fetchImpl: fakeFetch({ default: { status: 200, body: { versions: ['v1.12'] } } }),
      interfaces: {},
    });
    expect(reach.appservice.inboundVia).toBe('edge');
    expect(reach.appservice.reason).toMatch(/none is needed/);
    expect(reach.appservice.edgeSide).toBe('acme.test');
  });

  test('with neither a port nor an edge, the warning stands and names both fixes', async () => {
    // The refusal must survive the fix. This is the state the warning is FOR, and it should not send an
    // operator to the wrong remedy — a socket is one answer and an edge is the other.
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'acme.test' },
      fetchImpl: fakeFetch({ default: { status: 200, body: { versions: ['v1.12'] } } }),
      interfaces: {},
    });
    expect(reach.appservice.inboundVia).toBeNull();
    expect(reach.appservice.reason).toMatch(/hafleet-appservice-edge/);
  });

  test('a half-configured edge is not treated as an edge', async () => {
    // Same rule `resolveEdgeLinkConfig` applies: half-configured means somebody was mid-setup, and calling
    // it working would hide that at the moment it matters most.
    const reach = await describeMatrixReach({
      env: { HAFLEET_EDGE_URL: 'http://x:1', MATRIX_SERVER_NAME: 'acme.test' },
      fetchImpl: fakeFetch({ default: { status: 200, body: { versions: ['v1.12'] } } }),
      interfaces: {},
    });
    expect(reach.appservice.inboundVia).toBeNull();
  });

  test('a real socket still says so, and offers the callback addresses', async () => {
    const reach = await describeMatrixReach({
      env: { MATRIX_SERVER_NAME: 'acme.test', HAFLEET_APPSERVICE_PORT: '8094' },
      fetchImpl: fakeFetch({ default: { status: 200, body: { versions: ['v1.12'] } } }),
      interfaces: { en0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] },
    });
    expect(reach.appservice).toMatchObject({ listening: true, inboundVia: 'socket' });
    expect(reach.appservice.callbackCandidates.length).toBeGreaterThan(0);
  });
});

describe('what the homeserver must reach depends on which way in is configured', () => {
  /*
   * THE SAME DEFECT, IN A SECOND PLACE. `describeMatrixReach` was taught about the edge and this was not, so
   * with the edge deployed as a sidecar in the homeserver's own namespace and delivering, the callback check
   * still answered "no appservice port, so there is nothing to reach". Fixing a rule at one of its homes is
   * how a rule comes to disagree with itself — the same shape as the four warning sites earlier the same day.
   */
  const noExec = (_file, _args, _opts, cb) => cb(new Error('no docker here'), '');

  test('with neither a port nor an edge, it says both are missing', async () => {
    const out = await verifyCallbackFromHomeserver({
      homeserverUrl: 'http://127.0.0.1:8009', port: null, edgeUrl: null, execFileImpl: noExec,
    });
    expect(out.applicable).toBe(false);
    expect(out.reason).toMatch(/nor a co-located edge/);
  });

  test('an edge alone is enough to have something to check', async () => {
    // The port is deliberately null: an edge deployment has no local socket, and that is the whole point.
    const out = await verifyCallbackFromHomeserver({
      homeserverUrl: 'http://127.0.0.1:8009', port: null, edgeUrl: 'http://127.0.0.1:8095', execFileImpl: noExec,
    });
    expect(out.reason).not.toMatch(/nothing for your/);
    // Not applicable here only because there is no container runtime to ask, which is a different answer.
    expect(out.reason).toMatch(/container runtime/);
  });

  test('with an edge there is ONE candidate, not a list to choose from', async () => {
    /*
     * The list exists because nobody knows which of this host's addresses a homeserver can reach. An edge
     * beside the homeserver has a single address the operator already chose, and offering alternatives would
     * invite them to change a working answer.
     */
    const exec = (file, args, _opts, cb) => {
      if (args[0] === 'ps') return cb(null, 'palpo2-hs\t127.0.0.1:8009->8008/tcp');
      return cb(null, '403');
    };
    const out = await verifyCallbackFromHomeserver({
      homeserverUrl: 'http://127.0.0.1:8009', port: null, edgeUrl: 'http://127.0.0.1:8095', execFileImpl: exec,
    });
    expect(out.applicable).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.recommended).toBe('http://127.0.0.1:8095');
  });

  test('without an edge the candidate list is still offered', async () => {
    // The original behaviour must survive: a socket deployment genuinely does not know which address works.
    const exec = (file, args, _opts, cb) => {
      if (args[0] === 'ps') return cb(null, 'palpo2-hs\t127.0.0.1:8009->8008/tcp');
      return cb(null, '000');
    };
    const out = await verifyCallbackFromHomeserver({
      homeserverUrl: 'http://127.0.0.1:8009', port: 8094, edgeUrl: null, execFileImpl: exec,
      interfaces: { en0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] },
    });
    expect(out.results.length).toBeGreaterThan(1);
  });
});

describe('the classifier, and the answer a walkthrough got wrong', () => {
  /*
   * FOUND BY WALKING THE FLOW, which is why it is here rather than in a review comment. A registration-token
   * side whose representative localpart was already taken reported `unreachable` — an outage verdict on a
   * homeserver that was answering perfectly, from `M_USER_IN_USE`.
   *
   * The default was right: an unrecognised failure should be transient rather than a verdict on somebody's
   * credential, because "rejected" sends an operator to ask a project side for a new token and that is a human
   * doing account work on someone else's homeserver. But `M_USER_IN_USE` is neither unknown nor transient — it
   * is definite, actionable, and about an account rather than a credential or a network.
   */
  test('401 and 403 are the only verdicts on a credential', () => {
    expect(classifyMatrixFailure({ status: 401 })).toBe('rejected');
    expect(classifyMatrixFailure({ status: 403 })).toBe('rejected');
  });

  test('a taken localpart is blocked, not unreachable', () => {
    // The wrong answer sent the operator to check a network that was fine.
    expect(classifyMatrixFailure({ status: 400, errcode: 'M_USER_IN_USE' })).toBe('blocked');
  });

  test('everything else stays unreachable, so an unknown failure is not a verdict', () => {
    for (const error of [{ status: 500 }, { status: 429 }, { status: 400 }, {}, { errcode: 'M_UNKNOWN' }]) {
      expect(classifyMatrixFailure(error)).toBe('unreachable');
    }
  });

  test('the errcode does not override a real credential verdict', () => {
    // A 403 that happens to carry M_USER_IN_USE is still a refusal of the token; status is the stronger signal.
    expect(classifyMatrixFailure({ status: 403, errcode: 'M_USER_IN_USE' })).toBe('rejected');
  });
});

describe('is anything actually arriving, and whose problem is it', () => {
  /*
   * THE MOST DANGEROUS THING THE WALKTHROUGH FOUND. `POST .../verify` answers `accepted` after exercising
   * the OUTBOUND direction only — HAFleet could act as the representative, so the screen said the customer
   * was onboarded. Inbound was dead. Nothing on any screen said so, and the only contrary evidence was a
   * counter inside a process on somebody else's machine.
   *
   * Four states because they have four different owners, and a single "not working" sends whoever reads it
   * to the wrong side of the fence.
   */
  test('nothing has arrived because the homeserver has never called — the customer\'s side', () => {
    const d = diagnoseEdgeInbound({ transactions: 0, delivered: 0, rejected: 0 });
    expect(d.state).toBe('never-called');
    // The three reasons, because they are checked in three different places.
    expect(d.detail).toMatch(/nothing has happened/);
    expect(d.detail).toMatch(/url in the registration/);
    expect(d.detail).toMatch(/restarted/);
  });

  test('the homeserver calls and nobody collects — OUR side, and it names the process', () => {
    /*
     * The state an operator cannot guess: the console works, the API works, `verify` says `accepted`, and a
     * DIFFERENT process — the bridge — is the one that was never started. Observed exactly this way:
     * `transactions: 4` with `HAFleet last seen: never`.
     */
    const d = diagnoseEdgeInbound({ transactions: 4, delivered: 0, rejected: 0, hafleetWaiting: false });
    expect(d.state).toBe('not-collected');
    expect(d.detail).toMatch(/BRIDGE/);
    expect(d.detail).toMatch(/bridge-matrix\.js/);
  });

  test('connected but taking nothing is still not-collected', () => {
    const d = diagnoseEdgeInbound({ transactions: 3, delivered: 0, hafleetWaiting: true });
    expect(d.state).toBe('not-collected');
  });

  test('a just-restarted edge is settling, not a warning — a pill that fires on healthy fleets is ignored', () => {
    /*
     * The counters live in the edge process, so a deploy zeroes them. Verified on the live fleet: restarting
     * the edge took a healthy `flowing` straight to `never-called` while HAFleet was long-polling it. Left
     * alone that would raise an inbound warning on every update of every working deployment.
     */
    const d = diagnoseEdgeInbound(
      { transactions: 0, hafleetWaiting: true, startedAt: 1_000_000 },
      { now: () => 1_030_000 },   // 30s old
    );
    expect(d.state).toBe('never-called');
    expect(d.settling).toBe(true);
    expect(d.detail).toMatch(/nothing to fix yet/);
  });

  test('once it has been up a while, never-called is a warning again', () => {
    const d = diagnoseEdgeInbound(
      { transactions: 0, hafleetWaiting: true, startedAt: 1_000_000 },
      { now: () => 1_000_000 + 200_000 },   // past the settling window
    );
    expect(d.settling).toBe(false);
    expect(d.detail).toMatch(/url in the registration/);
  });

  test('a fresh edge NOBODY is collecting from is not settling, however young', () => {
    // Youth excuses a quiet homeserver. It does not excuse a bridge that is not there.
    const d = diagnoseEdgeInbound(
      { transactions: 0, hafleetWaiting: false, startedAt: 1_000_000 },
      { now: () => 1_005_000 },
    );
    expect(d.settling).toBe(false);
  });

  test('an edge that does not report a start time is judged as before, not excused', () => {
    // An older edge predates the field. Treating a missing timestamp as "fresh" would mute the warning for
    // every one of them.
    const d = diagnoseEdgeInbound({ transactions: 0, hafleetWaiting: true });
    expect(d.settling).toBe(false);
  });

  test('a rejected token is diagnosed as the re-issue trap, not as an outage', () => {
    /*
     * Palpo keeps registrations in its database keyed by id and a restart does not update an existing row,
     * so a re-issued registration leaves the homeserver calling with the old hs_token. The remedy is
     * specific and unguessable, so it is stated.
     */
    const d = diagnoseEdgeInbound({ transactions: 5, delivered: 0, rejected: 5 });
    expect(d.state).toBe('rejected');
    expect(d.detail).toMatch(/old token/);
    expect(d.detail).toMatch(/database keyed by id/);
  });

  test('rejected wins over flowing, because a stopped stream beside a rising rejection reads as health', () => {
    // delivered > 0 from before the token changed, rejected climbing since. Reporting `flowing` here would
    // report health while every NEW event is turned away.
    const d = diagnoseEdgeInbound({ transactions: 9, delivered: 4, rejected: 5, hafleetWaiting: true });
    expect(d.state).toBe('rejected');
  });

  test('flowing says how much, so a number can be compared on the next look', () => {
    const d = diagnoseEdgeInbound({ transactions: 7, delivered: 7, rejected: 0, hafleetWaiting: true });
    expect(d.state).toBe('flowing');
    expect(d.detail).toMatch(/7 of 7/);
  });

  test('a previous collection counts as collecting, so a poll gap is not reported as a dead bridge', () => {
    // Between long-polls `hafleetWaiting` is briefly false; a bridge that has ever collected is not absent.
    const d = diagnoseEdgeInbound({
      transactions: 2, delivered: 2, hafleetWaiting: false, hafleetLastSeenAt: 1700000000000,
    });
    expect(d.state).toBe('flowing');
  });

  test('no status at all is `unknown` rather than a guess in either direction', () => {
    expect(diagnoseEdgeInbound(null).state).toBe('unknown');
    expect(diagnoseEdgeInbound(undefined).state).toBe('unknown');
    // Missing counters are treated as zero rather than throwing — an older edge reports fewer fields.
    expect(diagnoseEdgeInbound({}).state).toBe('never-called');
  });
});
