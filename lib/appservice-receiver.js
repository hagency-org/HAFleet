/*
 * The inbound half of an appservice: the homeserver pushes events to US.
 *
 * ADR-016 decision 2 and its "questions settled" entry 6. The operator ruled that Application Service
 * support is mandatory after reading the argument against it, and that argument was about topology
 * rather than effort: an appservice requires the project's homeserver to reach an address we expose,
 * and `bridge-matrix.js` has no `listen(` and no `createServer` — verified from the running process,
 * which holds zero listening sockets. This module is that missing surface.
 *
 * A SEPARATE LISTENER, NOT A ROUTE ON THE BACKEND. The backend already runs express and would be
 * cheaper to extend, but its port carries the operator API guarded by `API_TOKEN`. An appservice
 * endpoint has to be reachable by a foreign homeserver, so sharing a listener would mean exposing the
 * operator API to reach the appservice. That is a deployment property no amount of route guarding
 * fixes, so the surfaces are separate from the start.
 *
 * TWO THINGS HERE ARE MEASURED, NOT READ FROM THE SPEC. Both come from registering a throwaway
 * appservice against the Palpo build this deployment runs, observing real transactions, and removing
 * it again:
 *
 *   - Palpo authenticates with `?access_token=<hs_token>` and sends NO `Authorization` header at all.
 *     Three transactions were observed with header names limited to accept, content-length,
 *     content-type and host. A receiver that reads only `Authorization: Bearer` rejects every
 *     transaction with a 401, which presents as an appservice that is configured and silent.
 *   - Delivery is real and interest-by-namespace holds: putting one namespaced user in a room was
 *     enough for that room's events to arrive.
 *
 * So both forms are accepted. The header is the spec's; the query parameter is what actually arrives.
 */

import { randomBytes, timingSafeEqual } from 'crypto';

/** How many transaction ids to remember. The homeserver retries, so this is the deduplication window. */
const DEFAULT_SEEN_LIMIT = 4096;

export class AppserviceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppserviceError';
    this.code = code;
  }
}

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * `timingSafeEqual` THROWS on length mismatch, which would itself be a length oracle and — worse — an
 * unhandled rejection on the request path. Lengths are compared first and a mismatch answers false,
 * which leaks only the length, exactly as any correct implementation does.
 */
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Generate the registration a project side installs.
 *
 * TOKENS ARE RANDOM, NEVER DERIVED. That is ADR-014 decision 3's entire holding, and it binds harder
 * here than it did for agent passwords: an `as_token` authorises the whole claimed namespace, so a
 * derived one would make `.env` compromise permanent control of every lent agent on that side, with no
 * rotation path. 32 bytes of `randomBytes` per token, generated once, and the caller stores them.
 *
 * `sender_localpart` is lowercased because the spec requires lowercase localparts, and the namespace
 * default matches the existing `MATRIX_AGENT_PREFIX` — formalising the current naming rather than
 * changing it (ADR-014 decision 2).
 */
export function generateRegistration({
  id,
  url,
  senderLocalpart = 'hafleet',
  userNamespaceRegex = '@ac_.*',
  aliasNamespaceRegex = null,
  rateLimited = false,
} = {}) {
  if (!id || typeof id !== 'string') throw new AppserviceError('bad_request', 'id is required');
  if (!url || typeof url !== 'string') throw new AppserviceError('bad_request', 'url is required');
  const namespaces = {
    users: [{ exclusive: false, regex: userNamespaceRegex }],
    aliases: aliasNamespaceRegex ? [{ exclusive: false, regex: aliasNamespaceRegex }] : [],
    rooms: [],
  };
  return {
    id,
    url: url.replace(/\/+$/, ''),
    as_token: randomBytes(32).toString('hex'),
    hs_token: randomBytes(32).toString('hex'),
    sender_localpart: String(senderLocalpart).toLowerCase(),
    rate_limited: rateLimited,
    namespaces,
  };
}

/**
 * Render a registration as the YAML a homeserver reads.
 *
 * Hand-rendered rather than pulled from a YAML library, because the shape is fixed and small and this
 * repository's dependency-isolation check exists to keep additions deliberate. The values that could
 * need quoting — tokens and localparts — are hex and lowercase identifiers, and the regexes are
 * quoted explicitly.
 */
export function renderRegistrationYaml(reg) {
  const lines = [
    '# HAFleet appservice registration. Generated — do not hand-edit the tokens.',
    '# Install on the project side\'s homeserver and restart it: registrations load once.',
    `id: ${reg.id}`,
    `url: "${reg.url}"`,
    `as_token: ${reg.as_token}`,
    `hs_token: ${reg.hs_token}`,
    `sender_localpart: ${reg.sender_localpart}`,
    `rate_limited: ${reg.rate_limited ? 'true' : 'false'}`,
    'namespaces:',
    '  users:',
  ];
  for (const ns of reg.namespaces.users) {
    lines.push(`    - exclusive: ${ns.exclusive ? 'true' : 'false'}`);
    lines.push(`      regex: "${ns.regex}"`);
  }
  lines.push('  aliases:');
  for (const ns of reg.namespaces.aliases) {
    lines.push(`    - exclusive: ${ns.exclusive ? 'true' : 'false'}`);
    lines.push(`      regex: "${ns.regex}"`);
  }
  if (!reg.namespaces.aliases.length) lines[lines.length - 1] = '  aliases: []';
  lines.push('  rooms: []');
  return `${lines.join('\n')}\n`;
}

/**
 * A receiver for one project side's appservice traffic.
 *
 * `onEvents` is awaited and its outcome decides the response, which is the whole contract with the
 * homeserver: a 200 means "we have this, stop retrying". Returning 200 first and processing after
 * would turn every processing failure into silent event loss, because nothing would ask again.
 */
export function createAppserviceReceiver({
  hsToken,
  onEvents,
  seenLimit = DEFAULT_SEEN_LIMIT,
  onUserQuery = null,
} = {}) {
  if (!hsToken || typeof hsToken !== 'string') {
    throw new AppserviceError('bad_request', 'hsToken is required');
  }
  if (typeof onEvents !== 'function') {
    throw new AppserviceError('bad_request', 'onEvents must be a function');
  }

  /*
   * Insertion-ordered, and pruned from the front. A Set preserves insertion order in JS, so the oldest
   * transaction id is the first key — which makes eviction a `Set` delete rather than a second
   * structure. Bounded because the homeserver retries indefinitely and an unbounded set is a slow leak
   * on a long-lived bridge.
   */
  const seen = new Set();

  function rememberTxn(txnId) {
    seen.add(txnId);
    while (seen.size > seenLimit) {
      const oldest = seen.values().next().value;
      seen.delete(oldest);
    }
  }

  /**
   * Is this request carrying our `hs_token`?
   *
   * BOTH FORMS, and the query parameter is not a fallback — it is what Palpo actually sends. Checked
   * before anything else about the request, so an unauthenticated caller learns nothing about
   * transaction ids, namespaces, or whether a given txn was already handled.
   */
  function authorized({ query, headers }) {
    const fromQuery = query?.access_token;
    if (typeof fromQuery === 'string' && secretEquals(fromQuery, hsToken)) return true;
    const auth = headers?.authorization ?? headers?.Authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return secretEquals(auth.slice(7), hsToken);
    }
    return false;
  }

  /**
   * Handle one appservice request.
   *
   * Framework-free on purpose: it takes a plain description and returns `{ status, body }`, so it can
   * be driven by a test directly, mounted on a bare `http` server, or later on express, without any of
   * them being able to change what it decides.
   */
  async function handle({ method, path, query = {}, headers = {}, body = null } = {}) {
    if (!authorized({ query, headers })) {
      return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'bad hs_token' } };
    }

    const txnMatch = /^\/_matrix\/app\/v1\/transactions\/(.+)$/.exec(path || '');
    if (txnMatch && method === 'PUT') {
      const txnId = decodeURIComponent(txnMatch[1]);
      /*
       * A REPEAT IS A 200 WITHOUT REPROCESSING. The homeserver retries on anything that is not a 200,
       * including a transaction it already delivered whose response was lost — so processing twice is
       * the normal case, not an anomaly, and would double-deliver every message in it.
       */
      if (seen.has(txnId)) {
        return { status: 200, body: {}, duplicate: true };
      }
      const events = Array.isArray(body?.events) ? body.events : [];
      try {
        await onEvents(events, { txnId });
      } catch (error) {
        /*
         * NOT remembered on failure, and that ordering is the point: marking it seen before processing
         * succeeded would make the homeserver's retry look like a duplicate and skip it, which is
         * exactly how events get lost while both sides believe delivery happened. A 500 asks again.
         */
        return {
          status: 500,
          body: { errcode: 'M_UNKNOWN', error: `appservice failed to process transaction: ${error?.message || 'unknown'}` },
        };
      }
      rememberTxn(txnId);
      return { status: 200, body: {} };
    }

    const userMatch = /^\/_matrix\/app\/v1\/users\/(.+)$/.exec(path || '');
    if (userMatch && method === 'GET') {
      /*
       * The homeserver asking whether a user in our namespace exists. Palpo never calls this — it
       * creates namespaced users implicitly on a masqueraded request instead — but Synapse does, and a
       * 404 here is the correct answer for "not ours" rather than an error.
       */
      const userId = decodeURIComponent(userMatch[1]);
      const exists = onUserQuery ? await onUserQuery(userId) : false;
      return exists
        ? { status: 200, body: {} }
        : { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'no such user in this appservice namespace' } };
    }

    /*
     * `M_UNRECOGNIZED` rather than a bare 404: an unimplemented appservice endpoint (third-party
     * lookups, room queries) must be distinguishable by the homeserver from a route that exists and
     * found nothing, which is what the user query above returns.
     */
    return { status: 404, body: { errcode: 'M_UNRECOGNIZED', error: 'unrecognized appservice endpoint' } };
  }

  return {
    handle,
    /** For an operator surface and for tests: how many transactions are being remembered. */
    seenCount: () => seen.size,
    hasSeen: (txnId) => seen.has(txnId),
  };
}
