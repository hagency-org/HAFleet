/*
 * An appservice side IS a credential, and four places did not know it.
 *
 * FOUND BY RUNNING IT, not by a failing test. `POST /api/agents/:name/matrix-identity` told the operator
 * the agent "can be addressed AND can speak" — correctly, since `agentSenderFor` returns an appservice
 * sender for an agent on an appservice side and no per-agent token is needed. Meanwhile the bridge logged
 * `NEEDS PROVISIONING … has no usable Matrix credential` about that same agent, on every poll. Two answers
 * to one question, and the one that pages a human was the wrong one.
 *
 * THE FIX WENT IN THE WRONG PLACE THREE TIMES BEFORE IT WENT IN THE RIGHT ONE. Each warning site was
 * patched in turn — `ensureAgentToken`, then `pollRegistrations`, then the "token still missing" line — and
 * each redeploy moved the message rather than removing it. The rule belongs in `ensureAgentAccount`, the
 * single function all eight callers reach, which is where it is now.
 *
 * AND THE LAST ONE WAS NOT A LOGIC BUG AT ALL. With the rule correct, the warning persisted because
 * `actingCredentials` was loaded AFTER the agents were judged: the log showed it arriving twelve lines
 * before "serving 1 project side(s)". A rule consulted before its inputs exist is a rule that is always
 * false. That is why one of the tests below is about ordering rather than about logic.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

let bridgeModule;
beforeAll(async () => {
  bridgeModule = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-can-act`);
});

const SIDE = 'customer.test';

/**
 * The minimum shape `agentCanActOnMatrix` reads, driven through the prototype — the pattern the other
 * bridge tests use, because the constructor reaches for a homeserver.
 */
function selfWith({ credentials = [], token = null } = {}) {
  return {
    actingCredentials: new Map(credentials.map((c) => [c.serverName, c])),
    getAgentToken: () => token,
    normalizeName: (n) => String(n || '').toLowerCase(),
    actingSideFor(serverName) {
      const row = this.actingCredentials.get(String(serverName || '').toLowerCase());
      if (!row) return null;
      return {
        side: { serverName: row.serverName, apiBaseUrl: row.apiBaseUrl ?? 'http://x' },
        credential: row.kind === 'appservice'
          ? { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet', namespace: row.namespace }
          // A namespace is carried here too, so a test cannot pass by accident when the kind check is gone.
          : { kind: 'registrationToken', representativeToken: 'rt', registrationToken: null, namespace: row.namespace },
      };
    },
  };
}

const canAct = (self, name) => bridgeModule.MatrixBridge.prototype.agentCanActOnMatrix.call(self, name);

describe('whether an agent can act on Matrix', () => {
  test('an agent on an appservice side can act, with no token of its own', () => {
    // The case the whole change exists for. `@ac_soaker:customer.test` matches `@ac_.*`, so the side's
    // credential authorises it and no per-agent token is required.
    const self = selfWith({ credentials: [{ serverName: SIDE, kind: 'appservice', namespace: '@ac_.*' }] });
    expect(canAct(self, 'soaker')).toBe(true);
  });

  test('a token alone is still enough, with no side configured at all', () => {
    // The original path must keep working: most agents on most deployments have a token and no side.
    expect(canAct(selfWith({ token: 'syt_x' }), 'soaker')).toBe(true);
  });

  test('no token and no side means it genuinely cannot act', () => {
    // The refusal must survive. This is the state the warning is FOR, and losing it would replace a
    // misleading page with no page at all.
    expect(canAct(selfWith({}), 'soaker')).toBe(false);
  });

  test('a registrationToken side does not authorise an agent that has no token', () => {
    /*
     * The asymmetry that matters. An appservice namespace covers every agent; a registration token means
     * HAFleet must REGISTER an account and hold its access token, so until that has happened the agent
     * cannot act — and saying otherwise would suppress the warning that tells an operator to provision it.
     */
    /*
     * THE SIDE CARRIES A MATCHING NAMESPACE, which is what makes this test bite. A first version left the
     * namespace off, so `namespaceAdmits(undefined, …)` refused and the test passed even with the
     * `kind !== 'appservice'` check DELETED — verified by mutation. A guard that passes when the thing it
     * guards is removed is not testing the guard.
     */
    const self = selfWith({
      credentials: [{ serverName: SIDE, kind: 'registrationToken', namespace: '@ac_.*' }],
    });
    expect(canAct(self, 'soaker')).toBe(false);
  });

  test('a namespace that does not cover this agent does not authorise it', () => {
    // The check is the namespace, not the mere existence of an appservice side. A side claiming `@bot_.*`
    // says nothing about `@ac_soaker`.
    const self = selfWith({ credentials: [{ serverName: SIDE, kind: 'appservice', namespace: '@bot_.*' }] });
    expect(canAct(self, 'soaker')).toBe(false);
  });

  test('one usable side among several is enough', () => {
    const self = selfWith({
      credentials: [
        { serverName: 'a.test', kind: 'registrationToken' },
        { serverName: 'b.test', kind: 'appservice', namespace: '@bot_.*' },
        { serverName: 'c.test', kind: 'appservice', namespace: '@ac_.*' },
      ],
    });
    expect(canAct(self, 'soaker')).toBe(true);
  });

  test('an empty credential map is false rather than an exception', () => {
    // It is consulted during startup, when the map may not be loaded yet — see the ordering test below.
    expect(canAct({ actingCredentials: null, getAgentToken: () => null, normalizeName: (n) => n }, 'x'))
      .toBe(false);
  });
});

describe('the ordering that made a correct rule always false', () => {
  test('acting credentials are loaded before any agent is judged', () => {
    /*
     * A STRUCTURAL ASSERTION, and it is the only kind available for this. The bug was not in any
     * expression: `agentCanActOnMatrix` was right, and returned false because `actingCredentials` was
     * still empty when `ensureAgentAccount` asked. Four fixes went in before the log made the sequence
     * plain, so what is pinned here is the sequence itself.
     */
    const source = bridgeModule.bridgeSourceForTest?.()
      ?? require('fs').readFileSync(path.resolve('bridge-matrix.js'), 'utf8');
    const refresh = source.indexOf('await this.refreshActingCredentials();');
    const judge = source.indexOf('// 2. Ensure agent accounts for all known agents.');
    expect(refresh).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(judge);
  });
});

describe('who speaks in a room, chosen by the room\'s own server', () => {
  /*
   * `!offer` from a customer's room was answered as HAFleet's own bot, which is not a member there:
   * `M_FORBIDDEN: sender's membership is not 'join'`. The representative is the identity in that room, and a
   * room id already says which server it belongs to — so the choice needs no flag and no extra state.
   *
   * A SOURCE-LEVEL ASSERTION for the routing rule, because `sayInRoom` reaches a module-level constant
   * (`MATRIX_SERVER_NAME`) and the real send; the behavioural half is covered where `reply` is tested.
   */
  test('the rule is the room\'s server, and the bot is the fallback rather than the default', () => {
    const source = require('fs').readFileSync(path.resolve('bridge-matrix.js'), 'utf8');
    const fn = /async sayInRoom\([\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
    expect(fn).toBeTruthy();
    // It compares the room's server against ours, and asks the acting registry — not a flag.
    expect(fn).toMatch(/server !== MATRIX_SERVER_NAME/);
    expect(fn).toMatch(/actingSideFor\(server\)/);
    expect(fn).toMatch(/sendToRoomOnSide/);
    // A failed representative send THROWS rather than silently falling back to the bot, which would
    // reproduce the silence this fixes.
    expect(fn).toMatch(/if \(!sent\.sent\) throw/);
    // And the bot is still reached, for our own rooms.
    expect(fn).toMatch(/this\.botClient\.sendMessage\(roomId, content\)/);
    /*
     * AND THE FALLBACK KEYS ON THE FAILURE, NOT ON THE ADDRESS. A first version compared the room's server
     * against ours and stopped there — so when a project side runs on the SAME homeserver as HAFleet's bot,
     * which is an ordinary deployment and the one this was walked on, the comparison said "ours", the bot
     * was used, and the bot still was not a member. The same silence, one branch over.
     */
    expect(fn).toMatch(/M_FORBIDDEN/);
    expect(fn).toMatch(/membership is not/);
    // Narrow: anything that is not a membership refusal is re-thrown rather than retried.
    expect(fn).toMatch(/throw error;/);
  });

  test('every command reply goes through it, so no path keeps using the bot directly', () => {
    /*
     * The defect was ONE unconditional line, and the value of the fix is that there is only one exit. If a
     * second `botClient.sendMessage` appears in the command layer, this catches it — the same reason the
     * `ensureAgentAccount` rule above is asserted structurally.
     */
    const source = require('fs').readFileSync(path.resolve('lib/bot-commands.js'), 'utf8');
    const direct = [...source.matchAll(/this\.botClient\.sendMessage\(/g)];
    // Exactly one remains: the fallback inside `reply` for a bridge that has no `sayInRoom`.
    expect(direct).toHaveLength(1);
  });
});
