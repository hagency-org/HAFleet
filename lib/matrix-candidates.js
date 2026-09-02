/*
 * Which Matrix servers can this deployment actually reach, and at which address can they reach it back.
 *
 * WHY THIS EXISTS. Adding a project side was a shell recipe: create the side with one curl, generate a
 * registration with another, guess the callback URL, install it, restart the homeserver, and discover
 * only from silence whether the guess was right. That was handed to an operator as instructions, for a
 * procedure whose own documentation exists because it is full of traps. Traps are what a UI absorbs;
 * `docs/FOR-PROJECT-SIDES.md` should be the explanation of what happened, not the tool.
 *
 * TWO DIRECTIONS, and confusing them is the whole difficulty:
 *
 *   OUTBOUND — can we reach the homeserver? Answerable right now, by asking it. `/_matrix/client/versions`
 *   is unauthenticated and every homeserver serves it, so a probe gives a real verdict.
 *
 *   INBOUND — can the homeserver reach us? NOT answerable before installation. Matrix has no "call me
 *   back" endpoint, so nothing here can prove an appservice URL. What this module does instead is
 *   enumerate candidates with the reason each is a candidate, and say plainly that the proof is the first
 *   inbound transaction. A tool that presented a guess as a verdict would be worse than the shell recipe,
 *   because the operator would stop looking.
 *
 * NO SCANNING. Candidates come from configuration, from sides already recorded, and from this host's own
 * interfaces. Probing addresses nobody named would be a port scan of a customer's network run by their
 * contractor's software, and finding a homeserver that way would not mean anyone consented to it.
 */

import { networkInterfaces } from 'os';
import { resolveAppserviceSyncConfig } from './appservice-sync.js';

/** Reachability probe timeout. Short: this runs while an operator waits on a form. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Normalise whatever an operator or a config file called a homeserver into an origin we can probe.
 *
 * A bare `palpo.test` is a SERVER NAME, not a URL, and guessing a scheme for it is how a tool ends up
 * probing `http://` on a host that only serves `https://` and reporting the wrong verdict. So a value
 * without a scheme is returned as `null` here and handled by the caller, which knows whether it also
 * holds a base URL for that name.
 */
export function originFor(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Turn a server name into the address that serves it, the way the protocol says to.
 *
 * ASKING THE OPERATOR FOR THIS WAS WRONG, and they said so: 「服务器地址你应该知道」. Matrix specifies
 * exactly how a name becomes an address — every client does it on every login — so a form that demands
 * both is asking a human to do the protocol's job and to be right about it.
 *
 * The spec's order, followed here:
 *
 *   1. `GET https://<name>/.well-known/matrix/client` and read `m.homeserver.base_url`. This is why a
 *      server can be called `example.org` while its homeserver lives at `matrix.example.org` — the whole
 *      point of the mechanism, and the case a hand-typed guess gets wrong.
 *   2. No well-known, or an unusable one: fall back to `https://<name>`. The spec's own fallback.
 *
 * A NAME WITH A PORT SKIPS DISCOVERY. `palpo2.test:8009` is already an address in everything but scheme,
 * and the spec does not define well-known for one — so resolving it would mean inventing a rule.
 *
 * IT REPORTS HOW IT DECIDED. `via` travels with the answer because "we read your .well-known" and "we
 * guessed https://yourname" are different claims, and an operator debugging a wrong address needs to know
 * which one they are looking at.
 */
export async function discoverBaseUrl(serverName, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const name = String(serverName ?? '').trim().replace(/\/+$/, '');
  if (!name) return { url: null, via: 'no server name given' };
  if (/^https?:\/\//i.test(name)) return { url: originFor(name), via: 'you gave a URL, not a name' };

  if (name.includes(':')) {
    return { url: `https://${name}`, via: `${name} already carries a port, so well-known does not apply` };
  }

  try {
    const res = await fetchImpl(`https://${name}/.well-known/matrix/client`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const declared = originFor(body?.['m.homeserver']?.base_url);
      if (declared) return { url: declared, via: `${name} declares it in /.well-known/matrix/client` };
      return { url: `https://${name}`, via: `${name} serves a well-known with no usable base_url; fell back` };
    }
    return { url: `https://${name}`, via: `${name} has no well-known (HTTP ${res.status}); fell back to the name itself` };
  } catch (error) {
    /*
     * A FAILED LOOKUP IS NOT A FAILED ANSWER. The spec's fallback applies when well-known cannot be
     * fetched at all, and the most common reason on a private deployment is that the name does not
     * resolve publicly — which says nothing about whether the homeserver is reachable another way.
     */
    return {
      url: `https://${name}`,
      via: `could not read ${name}'s well-known (${String(error?.message || error).slice(0, 80)}); fell back to the name itself`,
    };
  }
}

/**
 * Ask a homeserver whether it is there.
 *
 * `/_matrix/client/versions` and not `/health`: the former is in the Matrix spec, unauthenticated, and
 * served by every homeserver, while the latter is a HAFleet convention that a customer's server has
 * never heard of. A 200 with a `versions` array is the only thing counted as reachable — some proxies
 * answer 200 with an HTML error page, and treating that as a homeserver sends the operator to install a
 * registration into something that is not one.
 */
export async function probeHomeserver(origin, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!origin) return { reachable: false, reason: 'no probeable URL: a bare server name is not an address' };
  try {
    const res = await fetchImpl(`${origin}/_matrix/client/versions`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, status: res.status, reason: `homeserver answered HTTP ${res.status}` };
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      return { reachable: false, status: res.status, reason: 'answered 200 but not with JSON — probably a proxy, not a homeserver' };
    }
    if (!Array.isArray(payload?.versions)) {
      return { reachable: false, status: res.status, reason: 'answered 200 with no `versions` array — not a Matrix homeserver' };
    }
    return { reachable: true, status: res.status, versions: payload.versions.slice(-3) };
  } catch (error) {
    const message = String(error?.message || error);
    return {
      reachable: false,
      reason: /abort|timeout/i.test(message) ? `no answer within ${timeoutMs}ms` : message.slice(0, 160),
    };
  }
}

/*
 * How long after an edge starts "nothing has arrived" is unremarkable. Two minutes: long enough to cover a
 * container restart and the bridge's first long-poll, short enough that a genuinely misdirected registration
 * is reported while the operator is still looking at the screen.
 */
const SETTLING_MS = 120_000;

/**
 * Is anything actually arriving — and if not, WHOSE problem is it?
 *
 * WHY THIS EXISTS, and it is the most dangerous thing a walkthrough turned up. `POST .../verify` answers
 * `accepted` after exercising the OUTBOUND direction only: HAFleet could act as the representative, so the
 * screen said the customer was onboarded. Inbound was dead, and nothing on any screen said so. The only
 * contrary evidence was a counter inside the edge process on somebody else's machine.
 *
 * FOUR STATES WITH FOUR DIFFERENT OWNERS, which is the reason a single "not working" is useless here:
 *
 *   `flowing`       events are arriving and being collected. Nothing to do.
 *   `never-called`  the homeserver has never called the edge. The registration's url, or the restart it
 *                   needs, or simply nothing has happened in a room yet — all on the CUSTOMER's side.
 *   `not-collected` the homeserver calls and HAFleet never picks up. The bridge is not running. This is
 *                   OURS, and it is the one the operator cannot guess: the console and the backend are
 *                   both fine, and a different process is the one that was never started.
 *   `rejected`      the homeserver calls with an hs_token the edge does not accept. Almost always the
 *                   documented trap: a re-issued registration whose new token never reached the
 *                   homeserver, because Palpo persists registrations in its database keyed by id and a
 *                   restart will not update an existing row.
 *
 * A PURE FUNCTION over the edge's own counters, so the diagnosis can be tested without a homeserver, a
 * bridge or a network — the three things that made this defect expensive to find in the first place.
 */
export function diagnoseEdgeInbound(status, { now = () => Date.now() } = {}) {
  if (!status || typeof status !== 'object') {
    return { state: 'unknown', detail: 'the edge did not report its traffic' };
  }
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const transactions = n(status.transactions);
  const delivered = n(status.delivered);
  const rejected = n(status.rejected);
  const collecting = Boolean(status.hafleetWaiting) || Boolean(status.hafleetLastSeenAt);

  /*
   * REJECTED IS CHECKED FIRST, even when something is also flowing. A token mismatch after a re-issue
   * shows up as a rising `rejected` beside a `delivered` that stopped moving, and reading the delivered
   * count first would report health while every new event is being turned away.
   */
  if (rejected > 0) {
    return {
      state: 'rejected',
      detail: `the homeserver called ${rejected} time(s) with an hs_token this edge does not accept. If you `
        + 're-issued the registration, the homeserver is probably still using the old token: Palpo keeps '
        + 'registrations in its database keyed by id, and restarting does not update an existing row.',
    };
  }
  if (transactions === 0) {
    /*
     * A JUST-RESTARTED EDGE HAS NOT HAD TIME TO BE CALLED, and saying otherwise costs the whole signal.
     * The counters live in the process, so a deploy resets them — and a healthy fleet would then raise an
     * inbound warning every time it was updated. A warning that fires on healthy systems is one an operator
     * learns to ignore, which is worse than not having it.
     *
     * `settling` rather than a fifth state: the fact is unchanged (nothing has arrived), only its
     * alarmingness differs, and a caller that ignores the flag still renders something true. It requires
     * HAFleet to be connected too, because a fresh edge nobody is collecting from is a real problem however
     * young it is.
     */
    const startedAt = Number(status.startedAt);
    const ageMs = Number.isFinite(startedAt) ? now() - startedAt : null;
    const settling = collecting && ageMs !== null && ageMs >= 0 && ageMs < SETTLING_MS;
    return {
      state: 'never-called',
      settling,
      detail: settling
        ? `this edge started ${Math.round(ageMs / 1000)}s ago and nothing has happened in a room it can see `
          + 'since. HAFleet is connected and waiting, so there is nothing to fix yet.'
        : 'the homeserver has never called this edge. Either nothing has happened in a room it can see '
        + 'yet, or the url in the registration is not one it can reach, or it has not been restarted since '
        + 'the registration was installed.',
    };
  }
  if (!collecting) {
    return {
      state: 'not-collected',
      detail: `the homeserver has called ${transactions} time(s) and HAFleet has never collected. The `
        + 'component that collects is the BRIDGE (bridge-matrix.js), not the backend — the console and the '
        + 'API are fine while this is true, so check whether the bridge is running.',
    };
  }
  if (delivered === 0) {
    return {
      state: 'not-collected',
      detail: `HAFleet is connected but has taken nothing of the ${transactions} transaction(s) offered.`,
    };
  }
  return {
    state: 'flowing',
    detail: `${delivered} of ${transactions} transaction(s) collected.`,
  };
}

/**
 * Addresses a homeserver might be able to reach this process at, each with why it is on the list.
 *
 * ORDERED BY HOW OFTEN IT IS THE RIGHT ANSWER, not alphabetically, because the operator picking from this
 * list is being asked a question they should not have to be an expert to answer.
 *
 * `127.0.0.1` is included and ranked LAST with an explicit warning. It is correct exactly when the
 * homeserver runs as a process on this same host, and it is the single most common wrong answer when it
 * runs in a container — the case `docs/FOR-PROJECT-SIDES.md` records as costing an afternoon, where the
 * appservice looks installed and is deaf. Omitting it would be wrong for the local case; presenting it
 * without the warning is how the trap gets sprung again.
 */
export function callbackCandidates({ port, interfaces = networkInterfaces() } = {}) {
  const out = [];
  const withPort = (host) => `http://${host}:${port}`;

  /*
   * NOT A DNS NAME — the container RUNTIME provides it, and which runtimes do is not uniform. Verified on
   * the deployment that prompted this: it is absent from the container's `/etc/hosts` and no `--add-host`
   * was given, yet it resolves to 192.168.5.2 through Docker's embedded resolver.
   *
   * Docker Desktop and Colima provide it. Docker Engine on Linux does NOT unless started with
   * `--add-host=host.docker.internal:host-gateway` — and Linux Docker Engine is the commonest production
   * shape, so the first version's "a homeserver in Docker or Colima reaches its host by this name" was
   * wrong exactly where it mattered most. Podman uses a different name entirely, which was also confirmed
   * unreachable from a Docker container here.
   */
  out.push({
    url: withPort('host.docker.internal'),
    why: 'a name the container runtime injects, not real DNS: Docker Desktop and Colima provide it',
    confidence: 'NOT provided by Docker Engine on Linux unless started with '
      + '--add-host=host.docker.internal:host-gateway',
  });

  out.push({
    url: withPort('host.containers.internal'),
    why: 'Podman\'s equivalent of the name above',
    confidence: 'only under Podman — a Docker container cannot resolve it',
  });

  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({
        url: withPort(addr.address),
        why: `this host's address on ${name}`,
        confidence: 'likely if the homeserver is another machine on the same network',
      });
    }
  }

  out.push({
    url: withPort('127.0.0.1'),
    why: 'correct ONLY if the homeserver runs as a process on this same host',
    confidence: 'wrong for a containerised homeserver — there 127.0.0.1 is the container itself, '
      + 'the appservice will look installed and receive nothing at all',
  });

  return out;
}

/**
 * Everything a "add a project side" flow needs to stop being a guessing game.
 *
 * `appservice.listening` is reported as its own fact, and it is the one an operator would otherwise
 * discover last. With no `HAFLEET_APPSERVICE_PORT` the bridge opens no socket at all, so a perfectly
 * installed registration pointing at a perfectly reachable address still receives nothing. Silent by
 * design in the bridge; stated here, before anyone generates a token.
 */
export async function describeMatrixReach({
  env = process.env,
  sides = [],
  fetchImpl = fetch,
  interfaces = networkInterfaces(),
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const configuredUrl = originFor(env.MATRIX_HOMESERVER || env.MATRIX_HOMESERVER_URL);
  const configuredName = String(env.MATRIX_SERVER_NAME ?? '').trim() || null;

  /*
   * Deduplicated by ORIGIN, keeping the first mention. The fleet's own homeserver is very often also a
   * project side, and listing it twice would make an operator wonder which one to pick — a question with
   * no meaning, since both are the same server.
   */
  const seen = new Set();
  const candidates = [];
  const add = (entry) => {
    const key = entry.url || `name:${entry.serverName}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(entry);
  };

  if (configuredUrl || configuredName) {
    const asSide = sides.find((s) => s?.serverName === configuredName) ?? null;
    add({
      serverName: configuredName,
      url: configuredUrl,
      source: 'this deployment\'s own MATRIX_SERVER_NAME / MATRIX_HOMESERVER',
      alreadyASide: Boolean(asSide),
      /*
       * CARRIED SEPARATELY FROM `alreadyASide`, because the two states need opposite treatment and a
       * form that conflated them produced a dead end: a side created but never given a credential was
       * marked "already a side" and made unselectable, so the operator could neither finish it nor start
       * again. A side WITHOUT a credential is precisely the one that still needs this flow.
       */
      hasCredential: Boolean(asSide?.hasCredential),
      sideId: asSide?.id ?? null,
    });
  }
  for (const side of sides) {
    if (!side?.serverName) continue;
    add({
      serverName: side.serverName,
      url: originFor(side.apiBaseUrl || side.api_base_url) || (side.serverName === configuredName ? configuredUrl : null),
      source: 'already recorded as a project side',
      alreadyASide: true,
      hasCredential: Boolean(side.hasCredential),
      sideId: side.id ?? side.serverName,
    });
  }

  const probed = await Promise.all(candidates.map(async (entry) => ({
    ...entry,
    probe: await probeHomeserver(entry.url, { fetchImpl, timeoutMs }),
  })));

  const rawPort = String(env.HAFLEET_APPSERVICE_PORT ?? '').trim();
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : null;

  /*
   * A CO-LOCATED EDGE IS ALSO A WAY IN, and not knowing that made this screen wrong on the deployment the
   * feature was built for.
   *
   * With no `HAFLEET_APPSERVICE_PORT` this used to report "the bridge opens no socket… a registration
   * installed now would receive nothing" — while the edge link was delivering, verified at 88 of 88
   * transactions. Worse than a cosmetic error: it told the operator to open an inbound socket, which is
   * precisely what co-locating exists to avoid, on a host that sits on a public IP.
   *
   * Read from the same three variables `resolveEdgeLinkConfig` reads, so the two cannot disagree about
   * whether an edge is configured.
   */
  const edgeUrl = String(env.HAFLEET_EDGE_URL ?? '').trim();
  const edgeToken = String(env.HAFLEET_EDGE_LINK_TOKEN ?? '').trim();
  const edgeSide = String(env.HAFLEET_EDGE_SIDE ?? '').trim();
  const edge = Boolean(edgeUrl && edgeToken && edgeSide);
  /*
   * The third way in, read from the same two variables `resolveAppserviceSyncConfig` reads: an
   * outbound /sync collector needs no socket and no edge, and reach must not tell an operator whose
   * sync intake is live that "nothing will receive your homeserver's events" — it did, on the first
   * bot-less sync deployment.
   */
  const syncConfig = resolveAppserviceSyncConfig(env);
  const sync = Boolean(syncConfig?.enabled);
  const syncSide = sync ? syncConfig.side : null;
  const syncUrl = sync ? syncConfig.baseUrl : null;

  return {
    homeservers: probed,
    appservice: port
      ? {
        listening: true,
        inboundVia: 'socket',
        port,
        callbackCandidates: callbackCandidates({ port, interfaces }),
        proof: 'None of these addresses is verified. Matrix has no way for us to ask your homeserver to '
          + 'call us, so the proof is the first inbound transaction after you install the registration.',
      }
      : edge
        ? {
          /*
           * No socket here, and none needed. `listening` stays false because it describes THIS process
           * honestly; `inboundVia` is what a caller should render, because the question the screen is
           * really asking is "will my homeserver's events arrive".
           */
          listening: false,
          port: null,
          inboundVia: 'edge',
          edgeUrl,
          edgeSide,
          reason: `no local socket, and none is needed: a co-located appservice edge at ${edgeUrl} is `
            + `collecting for ${edgeSide}. Point the registration at that edge, not at this host.`,
          callbackCandidates: [],
        }
        : sync
          ? {
            listening: false,
            port: null,
            inboundVia: 'sync',
            syncSide,
            syncUrl,
            reason: `no local socket, and none is needed: this bridge polls ${syncUrl} outbound as the `
              + `representative for ${syncSide}. The registration's url is not dialled; install it and `
              + 'the collector picks events up on its next poll.',
            callbackCandidates: [],
          }
          : {
            listening: false,
            port: null,
            inboundVia: null,
            reason: 'HAFLEET_APPSERVICE_PORT is not set, no co-located edge is configured and no sync '
              + 'intake is configured, so nothing will receive your homeserver\'s events. Set the port, '
              + 'run bin/hafleet-appservice-edge beside the homeserver and set HAFLEET_EDGE_URL, or set '
              + 'HAFLEET_APPSERVICE_SYNC_SIDE and HAFLEET_APPSERVICE_SYNC_URL.',
            callbackCandidates: [],
          },
  };
}

/**
 * Which candidate address can the homeserver ACTUALLY reach us at — answered, when it can be.
 *
 * `describeMatrixReach` says none of the candidates is verified, and for a customer's homeserver on
 * somebody else's network that is the honest end of it. But it is not the end when the homeserver is a
 * container on this host, which is the whole self-hosted and development case: we can find the container
 * that publishes its port and ask, from inside it, which of our addresses answers.
 *
 * WHY THIS IS WORTH THE MACHINERY. The operator's question was 「这是什么，填什么」, about a field where the
 * wrong answer produces a setup that looks installed and receives nothing, forever, with no error. Asking
 * a human to be sure about container networking is asking them to know the one thing the failure hides.
 *
 * IT REFUSES CLEARLY WHEN IT CANNOT. No docker, no container publishing that port, or a homeserver that is
 * simply elsewhere: `applicable: false` with the reason. Guessing in that case would put a verified badge
 * on an unverified address — the exact dishonesty the rest of this module exists to avoid.
 *
 * THE CANDIDATES ARE REGENERATED HERE, never accepted from the caller. Taking a list from a request would
 * turn this into "curl any URL from inside a container of my choosing", which is a much larger capability
 * than the one being added.
 */
export async function verifyCallbackFromHomeserver({
  homeserverUrl,
  port,
  /**
   * The co-located edge's URL, when one is configured. Then THAT is what the homeserver must reach, and
   * HAFleet's own port is irrelevant.
   */
  edgeUrl = null,
  execFileImpl,
  interfaces = networkInterfaces(),
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  /*
   * WHAT MUST BE REACHABLE DEPENDS ON WHICH WAY IN IS CONFIGURED, and this function knew only one of them.
   * The operator hit it directly: with the edge deployed as a sidecar in the homeserver's own namespace and
   * delivering, this still answered "no appservice port, so there is nothing to reach" — the same defect as
   * `describeMatrixReach` had, in a second place. Fixing a rule at one of its homes is how a rule comes to
   * disagree with itself.
   *
   * With an edge, the address to verify is the EDGE'S, and HAFleet's own port is beside the point. The check
   * is also more meaningful there: an edge co-located with the homeserver should answer on loopback from
   * inside it, which is exactly what this can test.
   */
  const target = edgeUrl ? originFor(edgeUrl) : null;
  if (!target && !port) {
    return {
      applicable: false,
      reason: 'neither an appservice port nor a co-located edge is configured, so there is nothing for your '
        + 'homeserver to reach',
    };
  }
  const origin = originFor(homeserverUrl);
  if (!origin) return { applicable: false, reason: 'the homeserver has no probeable address' };

  let hostPort;
  try {
    hostPort = new URL(origin).port || (new URL(origin).protocol === 'https:' ? '443' : '80');
  } catch {
    return { applicable: false, reason: 'could not read a port from the homeserver address' };
  }

  const run = (file, args) => new Promise((resolve) => {
    execFileImpl(file, args, { timeout: timeoutMs + 2000 }, (error, stdout) => {
      resolve({ error, stdout: String(stdout ?? '') });
    });
  });

  const listed = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  if (listed.error) {
    return { applicable: false, reason: `no local container runtime to ask (${String(listed.error.message || listed.error).slice(0, 80)})` };
  }

  /*
   * MATCHED ON THE PUBLISHED HOST PORT, which is the only fact that ties "the homeserver I can reach at
   * :8009" to "this container". Matching on a name would guess, and guessing which container is somebody's
   * homeserver is how you end up running commands in the wrong one.
   */
  const container = listed.stdout.split('\n')
    .map((line) => line.split('\t'))
    .filter(([name, ports]) => name && ports && new RegExp(`:${hostPort}->`).test(ports))
    .map(([name]) => name.trim())[0];

  if (!container) {
    return { applicable: false, reason: `no local container publishes port ${hostPort}; the homeserver is somewhere this cannot ask` };
  }

  /*
   * WITH AN EDGE THERE IS ONE CANDIDATE, not a list to choose from. The list exists because nobody knows
   * which of this host's addresses a homeserver can reach; an edge beside the homeserver has a single
   * address the operator already chose, so offering alternatives would invite them to change a working
   * answer.
   */
  const candidates = target
    ? [{
      url: target,
      why: 'the co-located edge you configured, which is what the registration should point at',
      confidence: 'verified below if this homeserver runs in a container on this host',
    }]
    : callbackCandidates({ port, interfaces });
  const results = [];
  for (const candidate of candidates) {
    /*
     * A 403 IS THE PASS. HAFleet's appservice endpoint refuses an unauthenticated GET, so "it answered at
     * all" is the question — any HTTP status proves the address is routable from in there, while a curl
     * failure proves it is not. Checking for 200 would fail every correct address.
     */
    const out = await run('docker', [
      'exec', container, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(Math.ceil(timeoutMs / 1000)), candidate.url,
    ]);
    const status = Number(out.stdout.trim());
    results.push({
      ...candidate,
      reachableFromHomeserver: Boolean(status) && status !== 0,
      status: status || null,
    });
  }

  const winner = results.find((r) => r.reachableFromHomeserver) ?? null;
  return {
    applicable: true,
    container,
    checkedFrom: `inside the container publishing :${hostPort}`,
    results,
    recommended: winner?.url ?? null,
    reason: winner
      ? `answered from inside ${container}, so your homeserver can reach HAFleet there`
      : `no candidate answered from inside ${container} — HAFleet may be bound somewhere that container cannot see`,
  };
}
