/*
 * HAFleet's half of the co-located appservice: dial out, collect, acknowledge.
 *
 * The edge process beside the homeserver cannot dial into a private network, so this dials it. NAT blocks
 * new connections coming IN; it does not block data returning on a connection you opened, which is why a
 * phone with no public address still receives messages. Long-poll rather than a socket library: one HTTP
 * request that the far end holds until there is work, which survives every proxy that would break a
 * WebSocket and needs no dependency.
 *
 * IT FEEDS THE SAME ROUTER THE LOCAL LISTENER FEEDS. `createAppserviceRouter().handle(...)` is called with
 * a request shaped exactly as the homeserver would have shaped it, so every rule about tokens, ordering,
 * duplicate transactions and failure lives in one place and behaves identically whether the events arrived
 * through a local socket or across the country. A second processing path would be a second set of bugs,
 * and the first one to drift would be the one nobody tests.
 *
 * THE ACK IS THE HOMESERVER'S 200. The edge holds the homeserver's request until this says the transaction
 * was processed, so an ack sent early is a homeserver told "handled" about events that were not. That is
 * why `ok: false` is reported honestly on failure rather than swallowed: it becomes a 500 to the
 * homeserver, which retries, which is the whole reason nothing is persisted anywhere.
 */

/** Backoff for a link that is refusing or unreachable. Gentle: the far end may be a customer's laptop. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export function resolveEdgeLinkConfig(env = process.env) {
  const url = String(env.HAFLEET_EDGE_URL ?? '').trim().replace(/\/+$/, '');
  const token = String(env.HAFLEET_EDGE_LINK_TOKEN ?? '').trim();
  const side = String(env.HAFLEET_EDGE_SIDE ?? '').trim();
  if (!url && !token) {
    return { enabled: false, reason: 'HAFLEET_EDGE_URL is not set, so no co-located appservice is expected' };
  }
  /*
   * HALF-CONFIGURED IS REFUSED, not treated as off. A URL with no token would poll and be rejected
   * forever; a token with no URL is a secret with nowhere to go. Both mean somebody was mid-setup, and
   * silently doing nothing is how that gets shipped.
   */
  if (!url) return { enabled: false, reason: 'HAFLEET_EDGE_LINK_TOKEN is set but HAFLEET_EDGE_URL is not' };
  if (!token) return { enabled: false, reason: 'HAFLEET_EDGE_URL is set but HAFLEET_EDGE_LINK_TOKEN is not' };
  if (!/^https?:\/\//i.test(url)) {
    return { enabled: false, reason: `HAFLEET_EDGE_URL must be an absolute http(s) URL, got ${url}` };
  }
  /*
   * WHICH SIDE THIS EDGE SERVES, and it cannot be inferred. One edge sits beside one homeserver, and the
   * `hs_token` the router authenticates with belongs to that side — read from HAFleet's own credential
   * store rather than sent over the link, because HAFleet issued it and shipping it back would put a
   * credential on the wire for no reason.
   */
  if (!side) return { enabled: false, reason: 'HAFLEET_EDGE_URL is set but HAFLEET_EDGE_SIDE names no project side' };
  return { enabled: true, url, token, side };
}

/**
 * Run the collect loop until stopped.
 *
 * `router` is whatever `createAppserviceRouter()` returned. `fetchImpl`, `sleep` and `now` are injected so
 * the loop can be driven in a test without real time or a real server.
 */
export function startEdgePuller({
  url,
  token,
  router,
  /** Returns the hs_token for the side this edge serves, from HAFleet's own store. */
  hsTokenFor,
  fetchImpl = fetch,
  logger = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  pollTimeoutMs = 40_000,
  shouldContinue = () => true,
} = {}) {
  if (!url || !token) throw new Error('startEdgePuller needs url and token');
  if (typeof router?.handle !== 'function') throw new Error('startEdgePuller needs a router with handle()');
  if (typeof hsTokenFor !== 'function') throw new Error('startEdgePuller needs hsTokenFor()');

  let stopped = false;
  let failures = 0;
  const stats = {
    collected: 0,
    processed: 0,
    failed: 0,
    lastCollectedAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  async function acknowledge(txnId, ok) {
    const res = await fetchImpl(`${url}/_hafleet/edge/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hafleet-link': token },
      body: JSON.stringify({ txn_id: txnId, ok }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      /*
       * A FAILED ACK IS NOT A FAILED DELIVERY, and must not be retried as one. The events were already
       * processed on this side; the edge will time out and the homeserver will resend, which the router's
       * own duplicate detection then absorbs. Logged, because a link that cannot ack is a link that will
       * process everything twice.
       */
      logger.warn?.(`[edge-puller] ack for ${txnId} answered HTTP ${res.status}; the homeserver will retry `
        + 'and the duplicate will be absorbed');
    }
  }

  const loop = (async () => {
    while (!stopped && shouldContinue()) {
      try {
        const res = await fetchImpl(`${url}/_hafleet/edge/pull`, {
          headers: { 'x-hafleet-link': token },
          signal: AbortSignal.timeout(pollTimeoutMs),
        });

        if (res.status === 204) { failures = 0; continue; }
        if (res.status === 403) {
          /*
           * A WRONG TOKEN IS NOT TRANSIENT. Backing off like a network error would hide a configuration
           * mistake behind an ever-quieter retry, so it is said plainly every time — this is the one
           * failure an operator can fix immediately.
           */
          stats.lastError = 'link token rejected';
          stats.lastErrorAt = Date.now();
          logger.error?.('[edge-puller] the edge rejected our link token — check HAFLEET_EDGE_LINK_TOKEN');
          await sleep(BACKOFF_MS.at(-1));
          continue;
        }
        if (!res.ok) throw new Error(`pull answered HTTP ${res.status}`);

        const payload = await res.json();
        const txnId = payload?.txn_id;
        const events = Array.isArray(payload?.events) ? payload.events : [];
        if (typeof txnId !== 'string' || !txnId) throw new Error('pull answered without a txn_id');

        failures = 0;
        stats.collected += 1;
        stats.lastCollectedAt = Date.now();

        /*
         * SHAPED AS THE HOMESERVER WOULD HAVE SHAPED IT, including the token, so the router authenticates
         * this exactly as it authenticates a local delivery. Handing the router a privileged short-cut
         * would mean the co-located path skipped a check the local path enforces.
         */
        const result = await router.handle({
          method: 'PUT',
          path: `/_matrix/app/v1/transactions/${encodeURIComponent(txnId)}`,
          query: {},
          headers: { authorization: `Bearer ${hsTokenFor() ?? ''}` },
          body: { events },
        });

        const processed = result?.status === 200;
        if (processed) stats.processed += 1;
        else {
          stats.failed += 1;
          stats.lastError = `router answered ${result?.status}`;
          stats.lastErrorAt = Date.now();
        }
        await acknowledge(txnId, processed);
      } catch (error) {
        stats.failed += 1;
        stats.lastError = String(error?.message || error).slice(0, 200);
        stats.lastErrorAt = Date.now();
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        failures += 1;
        // A timeout on a long-poll is ordinary, so it is not shouted about the way a real error is.
        if (!/abort|timeout/i.test(stats.lastError)) {
          logger.warn?.(`[edge-puller] ${stats.lastError}; retrying in ${wait}ms`);
        }
        await sleep(wait);
      }
    }
  })();

  return {
    stats: () => ({ ...stats }),
    stop() { stopped = true; return loop; },
    done: loop,
  };
}
