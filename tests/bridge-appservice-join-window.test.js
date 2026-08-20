/*
 * WHAT A CUSTOMER SAYS BEFORE WE ARE IN THE ROOM — on a project side, where the bot is not.
 *
 * Walked on two machines and it failed. A customer creates a room, invites HAFleet, and types
 * `!request architect 300000 20000` in the same breath. The representative joined two seconds later and
 * the ask was gone: no engagement, no reply in the room, no error anywhere. The identical ask sent one
 * second AFTER the join worked end to end. Two probes, one difference.
 *
 * The cause is a second path to one relationship, which is this repository's recurring defect.
 * `handleBotInvite` has backfilled the invite→join window since the day a live `!request` was lost in
 * it — and `onAppserviceMembership`, which is the path that answers an invite on a project side, never
 * did. `backfillJoinedRoom` could not simply be called from there either: it paginates with
 * `this.botClient`, which has no account on the customer's homeserver and is not in the room, and it
 * delimits the window by the BOT's invite rather than the representative's.
 *
 * THREE MORE THINGS THE SAME WALK FOUND, all under `MATRIX_TRUST_MODE=enforce`, and none of them
 * visible under the `audit` default:
 *
 *   - the room was never marked trusted, so `message-ingress … UNTRUSTED reason=unknown_room` dropped
 *     every message from it and the next room scan LEFT the room;
 *   - the bot's own invite handler ran first, refused the invite (a customer is never a trusted
 *     inviter and never will be), and LEFT — which consumed the invite, so the appservice's join then
 *     failed `403 M_FORBIDDEN: cannot join a room that is not 'public'`;
 *   - the rig had been running for days on `MATRIX_TRUST_MODE=open`, which is not a mode at all.
 *
 * WHY THESE ARE BEHAVIOURAL. tests/join-backfill.test.js says outright that it covers the SELECTOR and
 * that deleting the backfill CALL leaves it green. That is exactly the hole the appservice path fell
 * through, so this file drives the methods and asserts the calls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const roomMessagesOnSide = vi.fn();

vi.mock('../lib/matrix-representative.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, roomMessagesOnSide: (...args) => roomMessagesOnSide(...args) };
});

const SIDE = 'customer.test';
const REP = `@hafleet:${SIDE}`;
const ROOM = `!market:${SIDE}`;
const HUMAN = `@lin:${SIDE}`;

const ACTING = {
  side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
  credential: { kind: 'appservice', asToken: 'as_secret_never_logged', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
};

/** A message event, with the fields the selector actually reads. */
const msg = (id, body, sender = HUMAN, ts = 1000) => ({
  type: 'm.room.message', event_id: id, sender, origin_server_ts: ts,
  content: { msgtype: 'm.text', body },
});
const member = (membership, who = REP, ts = 1000) => ({
  type: 'm.room.member', state_key: who, sender: HUMAN, origin_server_ts: ts, content: { membership },
});
/** `/messages?dir=b` is newest-first, so a fixture written readably has to be reversed. */
const backwards = (...timelineOrder) => [...timelineOrder].reverse();
const readable = (chunk, end = null) => ({ known: true, chunk, end, reason: null });

let bridgeModule;
let runtimeDir;
let envSnapshot;

beforeAll(async () => {
  envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_SERVER_NAME', 'MATRIX_TRUST_MODE']);
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'appservice-join-window-'));
  mkdirSync(path.join(runtimeDir, 'data', 'matrix'), { recursive: true });
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_SERVER_NAME = 'hafleet.test';
  process.env.MATRIX_TRUST_MODE = 'enforce';
  bridgeModule = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-join-window`);
});

afterAll(() => {
  restoreEnv(envSnapshot);
  rmSync(runtimeDir, { recursive: true, force: true });
});

beforeEach(() => { roomMessagesOnSide.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

/** The minimum `onAppserviceMembership` and `backfillJoinedRoomOnSide` read. */
function selfWith({ sides = { [SIDE]: ACTING }, joinOk = true, backfill = null } = {}) {
  const it = {
    warnings: [],
    routed: [],
    postWarning(message, meta) { this.warnings.push({ message, ...meta }); },
    actingSideFor: (id) => sides[String(id).toLowerCase()] ?? null,
    actingCredentials: new Map(Object.keys(sides).map((k) => [k, sides[k]])),
    onRoomMessage: async (roomId, event) => { it.routed.push({ roomId, id: event.event_id, body: event.content?.body }); },
    isDuplicateMatrixEvent: () => false,
    processingMatrixEventIds: new Set(),
  };
  it.backfillJoinedRoomOnSide = backfill
    ?? bridgeModule.MatrixBridge.prototype.backfillJoinedRoomOnSide.bind(it);
  it.routeBackfilledEvents = bridgeModule.MatrixBridge.prototype.routeBackfilledEvents.bind(it);
  vi.stubGlobal('fetch', async () => (joinOk
    ? { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
    : { ok: false, status: 403, text: async () => 'M_FORBIDDEN', json: async () => ({}) }));
  return it;
}

const invite = (stateKey = REP, roomId = ROOM) => ({
  type: 'm.room.member', room_id: roomId, state_key: stateKey, sender: HUMAN, content: { membership: 'invite' },
});

const answerKnock = (it, roomId = ROOM, event = invite()) => (
  bridgeModule.MatrixBridge.prototype.onAppserviceMembership.call(it, SIDE, roomId, event)
);
const backfillSide = (it, roomId = ROOM, rep = REP) => (
  bridgeModule.MatrixBridge.prototype.backfillJoinedRoomOnSide.call(it, SIDE, roomId, rep)
);

// ── the window itself ────────────────────────────────────────────────────────────────────────────

describe('the window between the representative\'s invite and its join', () => {
  test('THE DEFECT: an ask sent before the join is routed, not lost', async () => {
    const it = selfWith();
    roomMessagesOnSide.mockResolvedValue(readable(backwards(
      member('invite'),
      msg('$ask', '!request architect 300000 20000'),
      member('join'),
    )));

    await expect(backfillSide(it)).resolves.toBe(1);
    expect(it.routed).toEqual([{ roomId: ROOM, id: '$ask', body: '!request architect 300000 20000' }]);
  });

  test('it reads the customer\'s history with the SIDE\'s credential, as the representative', async () => {
    /*
     * The reason this could not reuse `backfillJoinedRoom`: that one asks with `this.botClient`, which
     * has no account on this homeserver. Asserted on the ARGUMENTS because getting the actor wrong
     * fails as a 403 at runtime and as nothing at all in a test that only checks the outcome.
     */
    const it = selfWith();
    roomMessagesOnSide.mockResolvedValue(readable(backwards(member('invite'), member('join'))));
    await backfillSide(it);

    expect(roomMessagesOnSide).toHaveBeenCalledTimes(1);
    const [args] = roomMessagesOnSide.mock.calls[0];
    expect(args.side).toEqual(ACTING.side);
    expect(args.credential).toEqual(ACTING.credential);
    expect(args.roomId).toBe(ROOM);
    expect(args.dir).toBe('b');
    expect(args.from).toBe(null);
  });

  test('it paginates until the boundary is in hand, and stops there', async () => {
    // A busy room pushes the invite off the first page. Giving up after one page is how a request the
    // backfill exists to deliver gets swallowed by whatever was said just beforehand.
    const it = selfWith();
    roomMessagesOnSide
      .mockResolvedValueOnce(readable(backwards(msg('$chatter', 'hello'), member('join')), 'p2'))
      .mockResolvedValueOnce(readable(backwards(member('invite'), msg('$ask', '!offer')), 'p3'));

    await backfillSide(it);
    expect(roomMessagesOnSide).toHaveBeenCalledTimes(2);
    expect(roomMessagesOnSide.mock.calls[1][0].from).toBe('p2');
    // The page-2 events are OLDER, so the timeline is invite, $ask, $chatter, join.
    expect(it.routed.map((r) => r.id)).toEqual(['$ask', '$chatter']);
  });

  test('an unreadable history routes NOTHING and says why', async () => {
    const it = selfWith();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    roomMessagesOnSide.mockResolvedValue({ known: false, chunk: [], end: null, reason: 'history unreadable: M_FORBIDDEN' });

    await expect(backfillSide(it)).resolves.toBe(0);
    expect(it.routed).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/history unreadable: M_FORBIDDEN/);
    warn.mockRestore();
  });

  test('an invite that is not in the pages fetched routes NOTHING', async () => {
    /*
     * Fails closed, the same rule the bot's backfill follows: commands are executable, and replaying
     * one nobody just issued is worse than missing it.
     */
    const it = selfWith();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    roomMessagesOnSide.mockResolvedValue(readable(backwards(msg('$one', 'hi'), msg('$two', '!request coding 1 1'))));

    await expect(backfillSide(it)).resolves.toBe(0);
    expect(it.routed).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not locate .*invite/);
    warn.mockRestore();
  });

  test('a side we hold no acting credential for reads nothing at all', async () => {
    const it = selfWith({ sides: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(backfillSide(it)).resolves.toBe(0);
    expect(roomMessagesOnSide).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('an event sync already claimed is not handled twice', async () => {
    const it = selfWith();
    it.isDuplicateMatrixEvent = (id) => id === '$seen';
    it.processingMatrixEventIds = new Set(['$inflight']);
    roomMessagesOnSide.mockResolvedValue(readable(backwards(
      member('invite'), msg('$seen', 'a'), msg('$inflight', 'b'), msg('$fresh', 'c'), member('join'),
    )));

    await expect(backfillSide(it)).resolves.toBe(1);
    expect(it.routed.map((r) => r.id)).toEqual(['$fresh']);
  });

  test('the representative\'s OWN messages are never fed back in', async () => {
    const it = selfWith();
    roomMessagesOnSide.mockResolvedValue(readable(backwards(
      member('invite'), msg('$mine', 'anything', REP), msg('$theirs', '!help'), member('join'),
    )));
    await backfillSide(it);
    expect(it.routed.map((r) => r.id)).toEqual(['$theirs']);
  });
});

// ── answering the knock, and what that has to set up ─────────────────────────────────────────────

describe('answering a project side\'s invite', () => {
  test('the room becomes trusted, so its messages are not dropped as unknown', async () => {
    /*
     * The assertion the enforce-mode failure exists for. Under `audit` this whole defect is a log line;
     * under `enforce` it is the feature not existing, and enforce is the mode an operator picks when they
     * want to be careful.
     */
    const room = '!trust-me:customer.test';
    const it = selfWith({ backfill: async () => 0 });
    expect(bridgeModule.getRoomTrust(room).trusted).toBe(false);

    await answerKnock(it, room, invite(REP, room));

    const trust = bridgeModule.getRoomTrust(room);
    expect(trust.trusted).toBe(true);
    expect(trust.reason).toBe('managed');
  });

  test('a FAILED join trusts nothing', async () => {
    const room = '!refused:customer.test';
    const it = selfWith({ joinOk: false, backfill: async () => 0 });
    await answerKnock(it, room, invite(REP, room));
    expect(bridgeModule.getRoomTrust(room).trusted).toBe(false);
    expect(it.warnings.map((w) => w.message).join(' ')).toMatch(/join failed/);
  });

  test('the backfill is invoked with the side, the room and the representative', async () => {
    const room = '!window:customer.test';
    const calls = [];
    const it = selfWith({ backfill: async (...args) => { calls.push(args); return 1; } });
    await answerKnock(it, room, invite(REP, room));
    expect(calls).toEqual([[SIDE, room, REP]]);
  });

  test('a backfill that throws does NOT become "the join failed"', async () => {
    /*
     * Ordering, and it is load-bearing. With the backfill inside the join's own try, any failure in it
     * — including a `this` with no such method, which is how four existing tests are built — was
     * reported to the operator as a failed join. The join is what makes the project reachable and that
     * stays true whatever the backfill then manages to read.
     */
    const room = '!broken-backfill:customer.test';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const it = selfWith({ backfill: async () => { throw new Error('history exploded'); } });

    await answerKnock(it, room, invite(REP, room));

    const said = it.warnings.map((w) => w.message).join(' ');
    expect(said).toMatch(/accepted our knock/);
    expect(said).not.toMatch(/join failed/);
    expect(bridgeModule.getRoomTrust(room).trusted).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/join backfill failed .*history exploded/);
    warn.mockRestore();
  });

  test('a room on another server is still refused, and gains no trust', async () => {
    const room = '!elsewhere:other.example';
    const it = selfWith({ backfill: async () => 0 });
    await answerKnock(it, room, invite(REP, room));
    expect(bridgeModule.getRoomTrust(room).trusted).toBe(false);
  });
});

// ── the bot must not refuse a room that is not its business ──────────────────────────────────────

describe('a room on a configured project side is not the bot\'s to refuse', () => {
  const trustOf = (roomId) => bridgeModule.MatrixBridge.prototype.projectSideInviteTrust.call(
    { actingCredentials: new Map([[SIDE, ACTING]]) }, roomId,
  );

  test('the classifier recognises a room on a side we hold a credential for', () => {
    expect(trustOf(ROOM)).toEqual({ trusted: true, reason: 'project_side_room' });
  });

  test('and nothing else: another server, a malformed id, a side we do not serve', () => {
    expect(trustOf('!x:other.example')).toBe(null);
    expect(trustOf('!no-colon')).toBe(null);
    expect(trustOf(null)).toBe(null);
    expect(bridgeModule.MatrixBridge.prototype.projectSideInviteTrust.call({}, ROOM)).toBe(null);
  });

  test('THE DEFECT: under enforce the bot no longer LEAVES a project side\'s room', async () => {
    /*
     * What made this severe rather than untidy: leaving CONSUMED the invite. The appservice's join then
     * failed with `403 cannot join a room that is not 'public'`, so one handler's correct refusal
     * destroyed the other's only way in and the customer's room was unreachable. Reproduced live.
     */
    const left = [];
    const joined = [];
    const it = {
      actingCredentials: new Map([[SIDE, ACTING]]),
      botClient: {
        joinRoom: async (roomId) => { joined.push(roomId); },
        leaveRoom: async (roomId) => { left.push(roomId); },
      },
      managedAgentBotInviteTrust: () => null,
      backfillJoinedRoom: async () => 0,
    };
    it.projectSideInviteTrust = bridgeModule.MatrixBridge.prototype.projectSideInviteTrust.bind(it);
    const result = await bridgeModule.MatrixBridge.prototype.handleBotInvite.call(
      it, ROOM, { sender: HUMAN, state_key: REP, content: { membership: 'invite' } },
    );

    expect(left).toEqual([]);
    expect(joined).toEqual([ROOM]);
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('project_side_room');
  });

  test('a room on a server we serve nothing for is still refused under enforce', async () => {
    // The rule is the room's ORIGIN, not "accept everything". A stranger's room is unchanged.
    const stranger = '!spam:nowhere.example';
    const left = [];
    const it = {
      actingCredentials: new Map([[SIDE, ACTING]]),
      botClient: {
        joinRoom: async () => { throw new Error('should not join'); },
        leaveRoom: async (roomId) => { left.push(roomId); },
      },
      managedAgentBotInviteTrust: () => null,
    };
    it.projectSideInviteTrust = bridgeModule.MatrixBridge.prototype.projectSideInviteTrust.bind(it);
    const result = await bridgeModule.MatrixBridge.prototype.handleBotInvite.call(
      it, stranger, { sender: '@stranger:nowhere.example', content: { membership: 'invite' } },
    );

    expect(left).toEqual([stranger]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('untrusted_inviter');
  });
});

// ── a mode that is not a mode ────────────────────────────────────────────────────────────────────

describe('MATRIX_TRUST_MODE', () => {
  test('an unrecognised value is called out, because it silently means audit', async () => {
    /*
     * The rig this was walked on had run for days on `MATRIX_TRUST_MODE=open`. Harmless there only by
     * luck — the accidental meaning happened to be the permissive one. `strict` or `enforced` is the
     * same typo pointing the other way: audit, and an operator who believes untrusted rooms are being
     * refused.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MATRIX_TRUST_MODE = 'open';
    await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-bad-trust-mode`);
    process.env.MATRIX_TRUST_MODE = 'enforce';

    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/MATRIX_TRUST_MODE="open" is not a mode/);
    expect(said).toMatch(/nothing is being enforced/);
    warn.mockRestore();
  });

  test('the two real modes say nothing', async () => {
    for (const mode of ['audit', 'enforce']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.MATRIX_TRUST_MODE = mode;
      // eslint-disable-next-line no-await-in-loop
      await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-mode-${mode}`);
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/is not a mode/);
      warn.mockRestore();
    }
    process.env.MATRIX_TRUST_MODE = 'enforce';
  });
});
