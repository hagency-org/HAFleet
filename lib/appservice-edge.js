/*
 * The appservice endpoint, moved to where the homeserver can actually reach it.
 *
 * WHY THIS EXISTS. An appservice is INBOUND: the homeserver pushes transactions to the `url` in its
 * registration. HAFleet's receiver has always lived inside the bridge, so that url had to point at
 * HAFleet — which for a fleet on a laptop or an internal network means exposing it. The operator said
 * what was wrong with that: 「我的 agent 都在内网，而且接入 matrix 服务器本身不需要公网地址，你这个设计是
 * 错的」. Then they said what to do instead: co-locate.
 *
 * SO NOTHING NEEDS TO BE REACHABLE FROM OUTSIDE. This process runs beside the homeserver, which dials
 * `127.0.0.1`. HAFleet dials THIS process — outbound, from behind whatever NAT it lives behind, over the
 * same route it already uses for the client-server API. The only inbound connection anywhere is a
 * homeserver talking to its own loopback.
 *
 *   homeserver ──▶ 127.0.0.1:8094 (this)          the only inbound hop, and it never leaves the host
 *   HAFleet    ──▶ this, long-poll               outbound: NAT blocks new connections IN, not data
 *                                                 coming back on a connection you opened
 *
 * WHAT IT REFUSES TO BE. It holds no credential of the fleet's, makes no decision about rooms or
 * agents, and stores nothing durable. It is a doorway: authenticate the homeserver, hand the events to
 * HAFleet, wait to be told they were processed, answer. Every judgement stays on the private side, which
 * is the reason a project side can be asked to run it at all.
 *
 * THE 200 IS THE WHOLE DESIGN. Matrix's appservice contract is that a non-2xx makes the homeserver retry,
 * so `lib/appservice-receiver.js` answers 200 only AFTER processing succeeded — that ordering is what
 * keeps events from being lost while both sides believe delivery happened. Acknowledging on receipt here
 * would break it across a network: the homeserver would be told "done" while the events were still in
 * flight to a laptop that might never see them. So this holds the request open and answers only when
 * HAFleet says it processed them. Nothing is queued, nothing is persisted, and nothing needs to be:
 * unacknowledged work is simply work the homeserver has not been told about, and it will send it again.
 */

import { createHash, timingSafeEqual } from 'crypto';

/** How long the homeserver's request is held while waiting for HAFleet, before giving it a retryable 500. */
export const DEFAULT_DELIVER_TIMEOUT_MS = 30_000;
/** How long HAFleet's long-poll waits for work before being told to come back. */
export const DEFAULT_POLL_TIMEOUT_MS = 25_000;

function secretEquals(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Non-secret stand-in for a token, for logs. Four bytes: enough to compare, useless to authenticate. */
export function fingerprint(value) {
  if (typeof value !== 'string' || !value) return '(absent)';
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * The doorway, as a pure request handler.
 *
 * Framework-free like the receiver it stands in front of: it takes a plain description and returns
 * `{ status, body }`, so a test can drive it directly and no HTTP library can change what it decides.
 */
export function createAppserviceEdge({
  hsToken,
  linkToken,
  /*
   * THE ADDRESS THE HOMESERVER MUST DIAL, which is NOT the address HAFleet collects from — and conflating
   * the two shipped a registration that silently received nothing.
   *
   * Walked on a clean pair of machines: the console pre-filled the registration with `HAFLEET_EDGE_URL`
   * (`http://69.194.3.128:8097`, how HAFleet reaches this edge) while this process, bound to loopback, was
   * printing `put this in the registration: url: http://127.0.0.1:8097`. The homeserver could not reach the
   * former, so it never called — and `verify` still answered `accepted`, because verification proves the
   * OUTBOUND direction only. The operator was told the customer was onboarded while inbound was dead.
   *
   * This process is the only thing that knows its own socket, so it is the authority on that address and
   * reports it. Co-located means loopback, which is why the default names loopback rather than a hostname.
   */
  registrationUrl = null,
  deliverTimeoutMs = DEFAULT_DELIVER_TIMEOUT_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console,
} = {}) {
  if (!hsToken || typeof hsToken !== 'string') throw new Error('hsToken is required');
  /*
   * THE LINK TOKEN IS REQUIRED AND IS NOT THE hs_token. Reusing the homeserver's token would mean anyone
   * who could read the registration file — which lives on the homeserver's own disk — could also drain
   * this queue, and draining it is reading the room's traffic. Two secrets because there are two
   * relationships.
   */
  if (!linkToken || typeof linkToken !== 'string') throw new Error('linkToken is required');

  /**
   * At most ONE transaction in flight, which is correct rather than merely simple.
   *
   * The appservice spec has the homeserver send transactions in order and wait for a response before
   * sending the next, so a queue would model a concurrency that does not arise. If one does anyway — a
   * homeserver that pipelines, or a retry arriving beside the original — the second gets a retryable 500
   * rather than being silently dropped or reordered. Ordering is the guarantee; depth is not.
   */
  let inFlight = null; // { txnId, body, resolve, timer, takenAt }
  let waitingPoller = null; // { resolve, timer }

  const traffic = {
    firstSeenAt: null,
    lastSeenAt: null,
    transactions: 0,
    delivered: 0,
    timedOut: 0,
    rejected: 0,
    lastRejectedAt: null,
    hafleetLastSeenAt: null,
  };

  function fromHomeserver({ query, headers }) {
    const fromQuery = query?.access_token;
    if (typeof fromQuery === 'string' && secretEquals(fromQuery, hsToken)) return true;
    const auth = headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return secretEquals(auth.slice(7), hsToken);
    return false;
  }

  function fromHafleet({ headers }) {
    const auth = headers?.['x-hafleet-link'] ?? headers?.['X-Hafleet-Link'];
    return typeof auth === 'string' && secretEquals(auth, linkToken);
  }

  /** Hand whatever is pending to a waiting poller, if both exist. */
  function pump() {
    if (!inFlight || !waitingPoller || inFlight.takenAt) return;
    const poller = waitingPoller;
    waitingPoller = null;
    clearTimeoutImpl(poller.timer);
    inFlight.takenAt = now();
    poller.resolve({
      status: 200,
      body: { txn_id: inFlight.txnId, events: inFlight.body?.events ?? [] },
    });
  }

  async function handle({ method, path, query = {}, headers = {}, body = null } = {}) {
    // ── the homeserver's side ────────────────────────────────────────────
    const txnMatch = /^\/_matrix\/app\/v1\/transactions\/(.+)$/.exec(path || '');
    if (txnMatch && method === 'PUT') {
      if (!fromHomeserver({ query, headers })) {
        traffic.rejected += 1;
        traffic.lastRejectedAt = now();
        return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'bad hs_token' } };
      }
      const txnId = decodeURIComponent(txnMatch[1]);
      if (traffic.firstSeenAt === null) traffic.firstSeenAt = now();
      traffic.lastSeenAt = now();
      traffic.transactions += 1;

      if (inFlight) {
        /*
         * A retryable refusal, not a drop. The homeserver will send this again, and answering 200 to get
         * rid of it would be telling it the events were handled by something that never saw them.
         */
        return {
          status: 500,
          body: { errcode: 'M_UNKNOWN', error: 'another transaction is still in flight; retry' },
        };
      }

      return new Promise((resolve) => {
        const timer = setTimeoutImpl(() => {
          if (inFlight?.txnId !== txnId) return;
          inFlight = null;
          traffic.timedOut += 1;
          logger.warn?.(`[appservice-edge] no acknowledgement for ${txnId} within ${deliverTimeoutMs}ms; `
            + 'answering 500 so the homeserver retries');
          resolve({
            status: 500,
            body: { errcode: 'M_UNKNOWN', error: 'HAFleet did not acknowledge in time; retry' },
          });
        }, deliverTimeoutMs);
        inFlight = { txnId, body, resolve, timer, takenAt: null };
        pump();
      });
    }

    /*
     * USER QUERIES ARE ANSWERED 404 HERE, and that is the honest answer rather than a proxy of one.
     * HAFleet's namespace claims users that already exist — the appservice does not create accounts on
     * demand — so "not found" is what the in-process receiver's default says too. Forwarding it would add
     * a round trip to a laptop for a question whose answer never varies.
     */
    if (/^\/_matrix\/app\/v1\/users\//.test(path || '') && method === 'GET') {
      if (!fromHomeserver({ query, headers })) {
        traffic.rejected += 1;
        traffic.lastRejectedAt = now();
        return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'bad hs_token' } };
      }
      return { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'this appservice creates no users on demand' } };
    }

    // ── HAFleet's side, reached by HAFleet dialling out ──────────────────
    if (path === '/_hafleet/edge/pull' && method === 'GET') {
      if (!fromHafleet({ headers })) return { status: 403, body: { error: 'bad link token' } };
      traffic.hafleetLastSeenAt = now();
      if (waitingPoller) {
        /*
         * One poller at a time. Two would race for the same transaction and one of them would ack work it
         * never received — the failure mode that loses events while both sides report success.
         */
        return { status: 409, body: { error: 'another poller is already waiting' } };
      }
      if (inFlight && !inFlight.takenAt) {
        inFlight.takenAt = now();
        return { status: 200, body: { txn_id: inFlight.txnId, events: inFlight.body?.events ?? [] } };
      }
      return new Promise((resolve) => {
        const timer = setTimeoutImpl(() => {
          waitingPoller = null;
          // 204: come back. Not an error, and not an empty 200 that a caller might mistake for a
          // transaction with no events in it.
          resolve({ status: 204, body: null });
        }, pollTimeoutMs);
        waitingPoller = { resolve, timer };
        pump();
      });
    }

    if (path === '/_hafleet/edge/ack' && method === 'POST') {
      if (!fromHafleet({ headers })) return { status: 403, body: { error: 'bad link token' } };
      traffic.hafleetLastSeenAt = now();
      const txnId = typeof body?.txn_id === 'string' ? body.txn_id : '';
      const ok = body?.ok !== false;
      if (!inFlight) return { status: 409, body: { error: 'nothing is in flight' } };
      /*
       * MATCHED ON THE TRANSACTION ID. An ack for the wrong one would release a transaction HAFleet has
       * not processed — the homeserver would be told it was handled, and those events would never be sent
       * again. This is the one check in this file whose absence loses data silently.
       */
      if (txnId !== inFlight.txnId) {
        return { status: 409, body: { error: `ack is for ${txnId}, in flight is ${inFlight.txnId}` } };
      }
      const pending = inFlight;
      inFlight = null;
      clearTimeoutImpl(pending.timer);
      if (ok) {
        traffic.delivered += 1;
        pending.resolve({ status: 200, body: {} });
      } else {
        /*
         * HAFleet FAILED to process, and says so. Passing that through as a 500 is what makes the
         * homeserver retry — the same contract the in-process receiver keeps when `onEvents` throws.
         */
        pending.resolve({
          status: 500,
          body: { errcode: 'M_UNKNOWN', error: 'HAFleet failed to process this transaction' },
        });
      }
      return { status: 200, body: { ok: true } };
    }

    if (path === '/_hafleet/edge/status' && method === 'GET') {
      /*
       * READABLE WITH THE LINK TOKEN, because the operator running this on somebody else's machine needs
       * to answer "is it working" without shelling in, and the project side hosting it needs the same.
       * It reports counts and timestamps only — never an event, never a token.
       */
      if (!fromHafleet({ headers })) return { status: 403, body: { error: 'bad link token' } };
      return {
        status: 200,
        body: {
          ...traffic,
          inFlight: inFlight ? { txnId: inFlight.txnId, takenByHafleet: Boolean(inFlight.takenAt) } : null,
          hafleetWaiting: Boolean(waitingPoller),
          hsTokenFingerprint: fingerprint(hsToken),
          // What the registration must say, from the process that owns the socket. See `registrationUrl`.
          registrationUrl,
        },
      };
    }

    return { status: 404, body: { errcode: 'M_UNRECOGNIZED', error: 'unrecognized path' } };
  }

  return {
    handle,
    traffic: () => ({ ...traffic }),
    /** For shutdown: release anything held so the homeserver retries rather than hanging. */
    close() {
      if (inFlight) {
        clearTimeoutImpl(inFlight.timer);
        inFlight.resolve({ status: 500, body: { errcode: 'M_UNKNOWN', error: 'edge is shutting down; retry' } });
        inFlight = null;
      }
      if (waitingPoller) {
        clearTimeoutImpl(waitingPoller.timer);
        waitingPoller.resolve({ status: 204, body: null });
        waitingPoller = null;
      }
    },
  };
}
