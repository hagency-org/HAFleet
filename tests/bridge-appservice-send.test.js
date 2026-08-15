/*
 * AN AGENT ON AN APPSERVICE SIDE CAN SPEAK — the `canSend: false` hole, closed.
 *
 * `POST /api/agents/:name/matrix-identity` has answered `canSend: false` with a note saying "the
 * bridge send path still requires [a per-agent token], so it cannot send as this agent yet" ever since
 * appservice sides existed. Everything else was in place: the namespace makes the agent addressable,
 * the representative invites it, and the as_token joins it. Then it had nothing to say with — the
 * outbound path resolved a token, found none, and dropped the message.
 *
 * THE ASSERTION THAT CARRIES THIS FILE is `?user_id=`. Sending with the as_token and no masquerade
 * posts as the REPRESENTATIVE while every caller believes the agent spoke — a false record of who said
 * what, in somebody else's room, which is worse than the message not being sent at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('sending as an agent that has no token of its own', () => {
  let MatrixBridge;
  let runtimeDir;
  let envSnapshot;

  const SIDE = 'palpo.test';
  const ROOM = `!proj:${SIDE}`;
  const AGENT = 'biglittle';
  const AGENT_MXID = `@ac_${AGENT}:${SIDE}`;
  const AS_TOKEN = 'as_secret_never_logged';

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-as-send-'));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-send`));
  });

  afterAll(() => {
    restoreEnv(envSnapshot);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * A bridge with only what the send path touches.
   *
   * Constructed as a bare object rather than a real `MatrixBridge`, because the constructor reaches for
   * a homeserver, a bot login and a state file — none of which this question depends on. The methods
   * under test are borrowed onto it, which is also how it stays honest: if `sendAsAgentContent` starts
   * depending on something else, this stops working rather than quietly testing a copy.
   */
  function bridgeStub() {
    const stub = {
      agentWork: new Map(),
      matrixDeliveryJournal: { get: () => null },
      ended: [],
      warnings: [],
      endAgentWork(name, roomId) { this.ended.push({ name, roomId }); },
      endAgentWorkForToken(token, roomId) { this.ended.push({ token, roomId }); },
      postWarning(message) { this.warnings.push(message); },
      rememberMatrixEvent() {},
    };
    stub.sendAsAgentContent = MatrixBridge.prototype.sendAsAgentContent.bind(stub);
    stub.sendAsAgent = MatrixBridge.prototype.sendAsAgent.bind(stub);
    return stub;
  }

  const appserviceSender = (over = {}) => ({
    kind: 'appservice',
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: AS_TOKEN, senderLocalpart: 'hafleet', namespace: '@ac_.*' },
    agentUserId: AGENT_MXID,
    agentName: AGENT,
    ...over,
  });

  function captureFetch(response = { ok: true, status: 200, json: async () => ({ event_id: '$ev1' }) }) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body });
      return response;
    });
    return calls;
  }

  test('the as_token sends, and the AGENT is named in ?user_id=', async () => {
    const calls = captureFetch();
    const bridge = bridgeStub();

    const eventId = await bridge.sendAsAgentContent(
      appserviceSender(), ROOM, { msgtype: 'm.text', body: 'hello from the site' },
    );

    expect(eventId).toBe('$ev1');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('PUT');
    // The side's own base url, not this deployment's homeserver.
    expect(call.url).toContain('http://127.0.0.1:8008/_matrix/client/v3/rooms/');
    expect(call.headers.Authorization).toBe(`Bearer ${AS_TOKEN}`);
    /*
     * THE MASQUERADE. Without this parameter the message is posted by the representative and reported
     * as the agent — the one outcome worse than a failed send, because nothing anywhere says so.
     */
    expect(call.url).toContain(`user_id=${encodeURIComponent(AGENT_MXID)}`);
    expect(JSON.parse(call.body)).toMatchObject({ body: 'hello from the site' });
  });

  test('the work indicator ends by NAME, because there is no token to look the name up from', async () => {
    captureFetch();
    const bridge = bridgeStub();
    await bridge.sendAsAgentContent(appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' });
    expect(bridge.ended).toEqual([{ name: AGENT, roomId: ROOM }]);
  });

  test('a token sender still sends exactly as it did, with no user_id', async () => {
    /*
     * The regression that matters most: every agent registered the old way keeps its own path. A
     * `user_id` on a real token's send would be a masquerade request from an account with no
     * appservice rights — a 403 on every message the old fleet sends.
     */
    const calls = captureFetch();
    const bridge = bridgeStub();
    await bridge.sendAsAgentContent('agent-own-token', ROOM, { msgtype: 'm.text', body: 'x' });
    expect(calls[0].headers.Authorization).toBe('Bearer agent-own-token');
    expect(calls[0].url).not.toContain('user_id=');
    expect(bridge.ended).toEqual([{ token: 'agent-own-token', roomId: ROOM }]);
  });

  test('no token and no appservice credential REFUSES, instead of sending "Bearer undefined"', async () => {
    /*
     * What the old signature did with a missing token: interpolated `undefined` into the header, got a
     * 401, and warned about the room. The refusal now names the missing credential, which is the thing
     * an operator has to fix.
     */
    const calls = captureFetch();
    const bridge = bridgeStub();
    const eventId = await bridge.sendAsAgentContent(null, ROOM, { msgtype: 'm.text', body: 'x' });
    expect(eventId).toBeNull();
    expect(calls).toHaveLength(0);
    expect(bridge.warnings.join(' ')).toMatch(/no credential or appservice sender/);
  });

  test('an incomplete appservice sender is refused, not half-used', async () => {
    const calls = captureFetch();
    const bridge = bridgeStub();
    // No agentUserId: the one field that decides WHO speaks.
    const eventId = await bridge.sendAsAgentContent(
      { kind: 'appservice', side: { serverName: SIDE, apiBaseUrl: 'http://x' }, credential: { asToken: 'a' } },
      ROOM, { msgtype: 'm.text', body: 'x' },
    );
    expect(eventId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a failed send throws when the caller asked to be told, and warns when it did not', async () => {
    const bridge = bridgeStub();
    captureFetch({ ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN', error: 'nope' }) });
    // Not a membership failure, so no re-admission is attempted — the plain refusal path.
    await expect(bridge.sendAsAgentContent(
      appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' }, null, { throwOnFailure: true },
    )).rejects.toThrow(/M_FORBIDDEN/);

    const quiet = bridgeStub();
    captureFetch({ ok: false, status: 403, json: async () => ({ errcode: 'M_FORBIDDEN', error: 'nope' }) });
    expect(await quiet.sendAsAgentContent(appserviceSender(), ROOM, { msgtype: 'm.text', body: 'x' })).toBeNull();
    expect(quiet.warnings.join(' ')).toMatch(/M_FORBIDDEN/);
  });

  test('normalizeSender: a string is a token, a complete object is a sender, anything else is nothing', () => {
    expect(MatrixBridge.normalizeSender('tok')).toEqual({ kind: 'token', token: 'tok' });
    expect(MatrixBridge.normalizeSender(appserviceSender()).kind).toBe('appservice');
    for (const bad of [null, undefined, 42, {}, { kind: 'appservice' }, { kind: 'token' }]) {
      expect(MatrixBridge.normalizeSender(bad)).toBeNull();
    }
  });
});
