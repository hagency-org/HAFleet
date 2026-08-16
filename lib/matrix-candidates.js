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

  out.push({
    url: withPort('host.docker.internal'),
    why: 'a homeserver in Docker or Colima reaches its host by this name',
    confidence: 'likely if your homeserver is a container',
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
    add({
      serverName: configuredName,
      url: configuredUrl,
      source: 'this deployment\'s own MATRIX_SERVER_NAME / MATRIX_HOMESERVER',
      alreadyASide: sides.some((s) => s?.serverName === configuredName),
    });
  }
  for (const side of sides) {
    if (!side?.serverName) continue;
    add({
      serverName: side.serverName,
      url: originFor(side.apiBaseUrl || side.api_base_url) || (side.serverName === configuredName ? configuredUrl : null),
      source: 'already recorded as a project side',
      alreadyASide: true,
      sideId: side.id ?? side.serverName,
    });
  }

  const probed = await Promise.all(candidates.map(async (entry) => ({
    ...entry,
    probe: await probeHomeserver(entry.url, { fetchImpl, timeoutMs }),
  })));

  const rawPort = String(env.HAFLEET_APPSERVICE_PORT ?? '').trim();
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : null;

  return {
    homeservers: probed,
    appservice: port
      ? {
        listening: true,
        port,
        callbackCandidates: callbackCandidates({ port, interfaces }),
        proof: 'None of these addresses is verified. Matrix has no way for us to ask your homeserver to '
          + 'call us, so the proof is the first inbound transaction after you install the registration.',
      }
      : {
        listening: false,
        port: null,
        reason: 'HAFLEET_APPSERVICE_PORT is not set, so the bridge opens no socket. A registration '
          + 'installed now would be correct and still receive nothing.',
        callbackCandidates: [],
      },
  };
}
