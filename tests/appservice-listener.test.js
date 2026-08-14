/*
 * The socket the appservice receiver sits behind — off by default, loopback by default.
 *
 * Both defaults are chosen against a failure this repository has already shipped: the console's
 * `next dev` bound every interface, which handed operator authority to anyone on the LAN. An
 * appservice endpoint is guarded by `hs_token` and compared in constant time, so it is not
 * unauthenticated — but it is a surface the bridge has never had, and a surface that appears because
 * someone set a port should not also appear on every interface because nobody set an address.
 *
 * The receiver's own tests cover what a request MEANS. These cover what the socket does with one.
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_APPSERVICE_BIND,
  resolveAppserviceListenerConfig,
  startAppserviceListener,
} from '../lib/appservice-listener.js';
import { createAppserviceReceiver } from '../lib/appservice-receiver.js';

const HS_TOKEN = 'hs_token_listener_must_not_leak_0123456789';

let handle = null;
afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

function receiver(over = {}) {
  const seen = [];
  const rec = createAppserviceReceiver({
    hsToken: HS_TOKEN,
    onEvents: async (events, meta) => { seen.push({ count: events.length, txnId: meta.txnId }); },
    ...over,
  });
  return { rec, seen };
}

async function listen(rec, opts = {}) {
  handle = await startAppserviceListener({
    receiver: rec, port: 0, logger: { log: () => {}, error: () => {} }, ...opts,
  });
  return `http://127.0.0.1:${handle.port}`;
}

const txnUrl = (base, id, token = HS_TOKEN) =>
  `${base}/_matrix/app/v1/transactions/${id}?access_token=${encodeURIComponent(token)}`;

describe('it is OFF unless a port is set', () => {
  test('no port means no listener, with the reason', () => {
    /*
     * The whole opt-in. An operator who has not decided to expose anything gets no socket — not a
     * socket on a default port they never chose.
     */
    for (const env of [{}, { HAFLEET_APPSERVICE_PORT: '' }, { HAFLEET_APPSERVICE_PORT: '   ' }]) {
      const cfg = resolveAppserviceListenerConfig(env);
      expect(cfg.enabled).toBe(false);
      expect(cfg.reason).toMatch(/HAFLEET_APPSERVICE_PORT/);
    }
  });

  test('an unusable port is refused with the value, not silently defaulted', () => {
    for (const bad of ['abc', '0', '-1', '70000', '8009x']) {
      const cfg = resolveAppserviceListenerConfig({ HAFLEET_APPSERVICE_PORT: bad });
      expect(cfg.enabled, bad).toBe(false);
      expect(cfg.reason, bad).toContain(bad);
    }
  });

  test('a valid port enables it', () => {
    const cfg = resolveAppserviceListenerConfig({ HAFLEET_APPSERVICE_PORT: '8009' });
    expect(cfg).toMatchObject({ enabled: true, port: 8009 });
  });
});

describe('it is LOOPBACK unless explicitly widened', () => {
  test('the default bind is loopback', () => {
    expect(DEFAULT_APPSERVICE_BIND).toBe('127.0.0.1');
    expect(resolveAppserviceListenerConfig({ HAFLEET_APPSERVICE_PORT: '8009' }).host).toBe('127.0.0.1');
  });

  test('an empty bind value falls back to loopback rather than to every interface', () => {
    // `''` and whitespace are what an unset variable in a shell script looks like. Reading them as
    // "bind everything" is how a surface reaches the LAN by accident.
    for (const bind of ['', '   ']) {
      expect(resolveAppserviceListenerConfig({ HAFLEET_APPSERVICE_PORT: '8009', HAFLEET_APPSERVICE_BIND: bind }).host)
        .toBe('127.0.0.1');
    }
  });

  test('widening is ALLOWED but REPORTED', () => {
    /*
     * Legitimate — a project homeserver on another machine cannot reach 127.0.0.1 — so this is a flag
     * rather than a refusal. What it must not be is invisible: the consequence should be stated at
     * startup, not discovered from a port scan.
     */
    const wide = resolveAppserviceListenerConfig({
      HAFLEET_APPSERVICE_PORT: '8009', HAFLEET_APPSERVICE_BIND: '0.0.0.0',
    });
    expect(wide.enabled).toBe(true);
    expect(wide.exposedBeyondLoopback).toBe(true);
  });

  test('loopback spellings are NOT reported as exposed', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(resolveAppserviceListenerConfig({
        HAFLEET_APPSERVICE_PORT: '8009', HAFLEET_APPSERVICE_BIND: host,
      }).exposedBeyondLoopback, host).toBe(false);
    }
  });
});

describe('a real socket, end to end through the receiver', () => {
  test('a transaction with the token in the QUERY STRING is accepted', async () => {
    // The form Palpo actually sends, driven over TCP rather than through handle() directly.
    const { rec, seen } = receiver();
    const base = await listen(rec);
    const res = await fetch(txnUrl(base, 'wire-1'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'm.room.message' }, { type: 'm.room.member' }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(seen).toEqual([{ count: 2, txnId: 'wire-1' }]);
  });

  test('a transaction with no token is 403 and reaches no handler', async () => {
    const { rec, seen } = receiver();
    const base = await listen(rec);
    const res = await fetch(`${base}/_matrix/app/v1/transactions/wire-2`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"events":[]}',
    });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test('a retry of the same transaction is 200 and is not reprocessed', async () => {
    const { rec, seen } = receiver();
    const base = await listen(rec);
    const send = () => fetch(txnUrl(base, 'wire-3'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"events":[{"type":"m.room.message"}]}',
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test('a malformed body is M_NOT_JSON, and it does not consult the receiver', async () => {
    /*
     * Answered before the token is examined, so a broken body cannot be used to learn whether a token
     * was accepted. The receiver checks the token first for the same reason; this keeps that ordering
     * intact for a request that never reaches it.
     */
    const { rec, seen } = receiver();
    const base = await listen(rec);
    const res = await fetch(txnUrl(base, 'wire-4'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errcode).toBe('M_NOT_JSON');
    expect(seen).toHaveLength(0);
  });

  test('an oversized body is refused rather than buffered', async () => {
    const { rec, seen } = receiver();
    const base = await listen(rec);
    const huge = JSON.stringify({ events: [{ type: 'm.room.message', body: 'x'.repeat(3 * 1024 * 1024) }] });
    let status = 0;
    try {
      status = (await fetch(txnUrl(base, 'wire-5'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: huge,
      })).status;
    } catch {
      /*
       * The socket is destroyed once the ceiling is hit, so fetch may reject instead of returning a
       * response. Either outcome satisfies the requirement — what must NOT happen is the body being
       * buffered and handed on — so the assertion below is the one that matters.
       */
      status = 0;
    }
    expect([0, 413]).toContain(status);
    expect(seen).toHaveLength(0);
  });

  test('a handler that throws becomes a 500, not a dropped connection', async () => {
    /*
     * The homeserver retries on anything that is not a 200, and a hung connection makes it wait out a
     * timeout first. An unexpected failure should be fast and explicit.
     */
    const { rec } = receiver({ onEvents: async () => { throw new Error('downstream exploded'); } });
    const base = await listen(rec);
    const res = await fetch(txnUrl(base, 'wire-6'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"events":[]}',
    });
    expect(res.status).toBe(500);
  });

  test('an empty body is not treated as malformed', async () => {
    // A homeserver is entitled to send a transaction with no payload at all.
    const { rec } = receiver();
    const base = await listen(rec);
    const res = await fetch(txnUrl(base, 'wire-7'), { method: 'PUT' });
    expect(res.status).toBe(200);
  });

  test('no response body ever contains the hs_token', async () => {
    const { rec } = receiver();
    const base = await listen(rec);
    for (const url of [
      txnUrl(base, 'wire-8', 'wrong-token'),
      `${base}/_matrix/app/v1/thirdparty/protocol/x?access_token=${HS_TOKEN}`,
      txnUrl(base, 'wire-9'),
    ]) {
      const res = await fetch(url, { method: 'PUT', body: '{"events":[]}', headers: { 'Content-Type': 'application/json' } });
      expect(await res.text()).not.toContain(HS_TOKEN);
    }
  });
});

describe('the handle can be closed', () => {
  test('closing releases the port', async () => {
    const { rec } = receiver();
    const base = await listen(rec);
    const port = handle.port;
    await handle.close();
    handle = null;
    // A second listener on the same port proves the first released it.
    const second = await startAppserviceListener({
      receiver: rec, port, logger: { log: () => {}, error: () => {} },
    });
    expect(second.port).toBe(port);
    await second.close();
    void base;
  });

  test('a receiver without handle() is refused at construction', async () => {
    await expect(startAppserviceListener({ receiver: {}, port: 0 }))
      .rejects.toThrow(/requires a receiver with a handle\(\)/);
  });
});
