/*
 * The socket the appservice receiver sits behind.
 *
 * Separated from `lib/appservice-receiver.js` on purpose. The receiver decides what a request MEANS —
 * is the token right, has this transaction already been handled — and owning a socket would make that
 * untestable without one. This module owns only the socket, so the decision of WHERE to listen stays a
 * deployment question and never leaks into the protocol logic.
 *
 * OFF UNLESS EXPLICITLY TURNED ON, AND LOOPBACK UNLESS EXPLICITLY WIDENED. Both defaults are chosen
 * against the same failure this repository has already shipped once: the console's `next dev` bound
 * every interface, which handed operator authority to anyone on the LAN. An appservice endpoint is
 * guarded by `hs_token` and compared in constant time, so it is not unauthenticated — but it is a
 * surface the bridge has never had, and a surface that appears because someone set a port should not
 * also appear on every interface because nobody set an address.
 *
 * WHY THE DIRECTION IS SURPRISING, stated here because it is the thing that makes this module
 * necessary at all: under an appservice the PROJECT'S homeserver pushes to US
 * (`PUT /_matrix/app/v1/transactions/{txnId}`). HAFleet lends agents, so the intuition is that the
 * project exposes something — but the protocol is the other way round, and the registration-token
 * path is the one that survives NAT precisely because it is outbound-only.
 */

import { createServer } from 'http';

export const DEFAULT_APPSERVICE_BIND = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Resolve the listener's configuration from the environment.
 *
 * Returns `{ enabled: false }` when no port is set, and that is the whole opt-in: an operator who has
 * not decided to expose anything gets no socket rather than a socket on a default port.
 */
export function resolveAppserviceListenerConfig(env = process.env) {
  const rawPort = String(env.HAFLEET_APPSERVICE_PORT ?? '').trim();
  if (!rawPort) return { enabled: false, reason: 'HAFLEET_APPSERVICE_PORT is not set' };
  /*
   * A STRICT digits-only check before parseInt, which is not pedantry. `Number.parseInt('8009x', 10)`
   * returns 8009, so a typo'd port would bind a real socket on a number nobody typed — the surface
   * appears, on the wrong port, and the operator's mistake is invisible.
   */
  const port = /^\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { enabled: false, reason: `HAFLEET_APPSERVICE_PORT is not a usable port: ${rawPort}` };
  }
  const host = String(env.HAFLEET_APPSERVICE_BIND ?? '').trim() || DEFAULT_APPSERVICE_BIND;
  return {
    enabled: true,
    port,
    host,
    /*
     * Reported rather than merely allowed. Binding beyond loopback is legitimate — a project homeserver
     * on another machine cannot reach 127.0.0.1 — but it is a decision whose consequence an operator
     * should see stated at startup, not discover from a port scan.
     */
    exposedBeyondLoopback: host !== '127.0.0.1' && host !== '::1' && host !== 'localhost',
  };
}

/** Read a request body with a ceiling, so an oversized push cannot exhaust memory. */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`appservice request body exceeded ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Start listening, and hand back a handle that can stop.
 *
 * `receiver` is anything with the receiver's `handle({method, path, query, headers, body})` contract,
 * which is what keeps this module ignorant of appservice semantics.
 *
 * ASYNC so every failure is a rejection. A synchronous throw for a bad argument and a rejection for a
 * port already in use would make a caller handle the same function two ways, and the one it forgot
 * would be the one that crashes a startup path.
 */
export async function startAppserviceListener({ receiver, port, host = DEFAULT_APPSERVICE_BIND, logger = console } = {}) {
  if (!receiver || typeof receiver.handle !== 'function') {
    throw new Error('startAppserviceListener requires a receiver with a handle() method');
  }
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://appservice.invalid');
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        return send(413, { errcode: 'M_TOO_LARGE', error: error.message });
      }
      let body = null;
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          /*
           * A malformed body is M_NOT_JSON, and it is answered WITHOUT consulting the receiver — so a
           * caller cannot use a broken body to learn whether its token was accepted. The receiver
           * checks the token first for the same reason; this keeps that ordering intact for a request
           * that never reaches it.
           */
          return send(400, { errcode: 'M_NOT_JSON', error: 'request body is not valid JSON' });
        }
      }
      const out = await receiver.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      return send(out.status, out.body);
    } catch (error) {
      /*
       * A 500 rather than a dropped socket. The homeserver retries on anything that is not a 200, and a
       * hung connection makes it wait out a timeout first — so an unexpected failure should be fast and
       * explicit. The message is included; the token never appears in one.
       */
      logger.error?.(`[appservice] request failed: ${error?.message || error}`);
      return send(500, { errcode: 'M_UNKNOWN', error: 'appservice listener error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      logger.log?.(`[appservice] listening on http://${host}:${address.port} (homeserver → HAFleet)`);
      resolve({
        port: address.port,
        host,
        /** Await-able so a shutdown path can be sure the socket is released before exiting. */
        close: () => new Promise((done) => server.close(done)),
        server,
      });
    });
  });
}
