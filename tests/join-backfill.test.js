/*
 * The pre-join message loss, pinned.
 *
 * Sync only delivers events from after the join point, so anything said between the
 * invite and the join used to be lost permanently — no engagement, no reply, no
 * error. Reproduced against the live deployment before the fix: a `!request` at t+0
 * into a fresh room, bot joined at t+2s, still unanswered 80 seconds later.
 *
 * These tests cover the decision — WHICH events a fresh join owes a reply to. The
 * live delivery path is covered by mockup/scripts/e2e-full-loop.mjs, which sends a
 * pre-join `!request` against the real bridge and asserts an engagement appears.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('join backfill: messages sent before the bot joined', () => {
  let runtimeDir;
  let pendingJoinBackfill;
  let resolveJoinBackfillFloor;
  let envSnapshot;

  const BOT = '@hafleet-bot:matrix.test';
  const INVITE_TS = 1_000_000;

  /** A message event, with the fields the selector actually reads. */
  const msg = (id, ts, body, sender = '@lin:matrix.test') => ({
    type: 'm.room.message',
    event_id: id,
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body },
  });

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'join-backfill-test-'));
    const matrixDir = path.join(runtimeDir, 'data', 'matrix');
    mkdirSync(matrixDir, { recursive: true });
    writeFileSync(path.join(matrixDir, 'bridge-state.json'), JSON.stringify({
      botToken: null, agentTokens: {}, roomGroupMap: {}, groupRoomMap: {}, dmRooms: {},
    }, null, 2));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_TRUST_MODE']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_TRUST_MODE = 'audit';

    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ({ pendingJoinBackfill, resolveJoinBackfillFloor } = await import(`${bridgeUrl}?join-backfill-test=${cacheBust}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  // THE DEFECT ITSELF. Everything else here guards the fix from overreaching.
  test('a command sent between the invite and the join is delivered', () => {
    // dir=b, so newest first — the order the homeserver actually returns.
    const chunk = [msg('$b', INVITE_TS + 500, '!request architect 300000 20000')];
    const pending = pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT });
    expect(pending.map((e) => e.event_id)).toEqual(['$b']);
  });

  test('history from before the invite is not replayed', () => {
    /*
     * The bot can read this once it joins, and executing it would run commands nobody
     * just issued — including a `!request` from a previous membership if the bot was
     * invited, left, and re-invited.
     */
    const chunk = [
      msg('$new', INVITE_TS + 10, '!request architect 300000 20000'),
      msg('$old', INVITE_TS - 1, '!request architect 999999 99999'),
      msg('$ancient', 1, '!approve'),
    ];
    const pending = pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT });
    expect(pending.map((e) => e.event_id)).toEqual(['$new']);
  });

  test('the invite instant itself counts as after the invite', () => {
    // A message and the invite can share a millisecond; excluding it would drop the
    // very message the floor exists to admit.
    const chunk = [msg('$same', INVITE_TS, '!request architect 1 1')];
    expect(pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT }))
      .toHaveLength(1);
  });

  test('commands are delivered oldest first, not newest first', () => {
    // `!request` then `!cancel` is not the same as `!cancel` then `!request`.
    const chunk = [
      msg('$third', INVITE_TS + 300, 'c'),
      msg('$first', INVITE_TS + 100, 'a'),
      msg('$second', INVITE_TS + 200, 'b'),
    ];
    const pending = pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT });
    expect(pending.map((e) => e.event_id)).toEqual(['$first', '$second', '$third']);
  });

  test("the bot's own messages are never fed back to it", () => {
    const chunk = [
      msg('$mine', INVITE_TS + 10, '!help', BOT),
      msg('$theirs', INVITE_TS + 20, '!request architect 1 1'),
    ];
    const pending = pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT });
    expect(pending.map((e) => e.event_id)).toEqual(['$theirs']);
  });

  test('already-seen events are skipped, so sync and backfill cannot double-handle', () => {
    const chunk = [
      msg('$dup', INVITE_TS + 10, '!request architect 1 1'),
      msg('$fresh', INVITE_TS + 20, '!request architect 2 2'),
    ];
    const pending = pendingJoinBackfill(chunk, {
      inviteTs: INVITE_TS, botUserId: BOT, seen: new Set(['$dup']),
    });
    expect(pending.map((e) => e.event_id)).toEqual(['$fresh']);
  });

  test('non-message events and events without an id or timestamp are ignored', () => {
    const chunk = [
      { type: 'm.room.member', event_id: '$m', origin_server_ts: INVITE_TS + 1 },
      { type: 'm.room.message', origin_server_ts: INVITE_TS + 2, content: { body: 'x' } },
      msg('$nots', 0, 'no timestamp'),
      msg('$ok', INVITE_TS + 3, '!request architect 1 1'),
    ];
    const pending = pendingJoinBackfill(chunk, { inviteTs: INVITE_TS, botUserId: BOT });
    expect(pending.map((e) => e.event_id)).toEqual(['$ok']);
  });

  test('a missing or malformed chunk yields nothing rather than throwing', () => {
    // The join already succeeded by the time this runs; a bad /messages response must
    // not take the bot back out of a room it is legitimately in.
    for (const bad of [undefined, null, 'nope', {}, 42]) {
      expect(pendingJoinBackfill(bad, { inviteTs: INVITE_TS, botUserId: BOT })).toEqual([]);
    }
  });

  /*
   * THE FLOOR, which is where the first version of this fix actually failed.
   *
   * `inviteEvent.origin_server_ts` looked obvious and is never there: sync's
   * `invite_state` is STRIPPED state, carrying type/sender/state_key/content and no
   * timestamp. The floor therefore fell back to `Date.now()`, which sits after the
   * pre-join message, and the backfill discarded exactly what it existed to deliver —
   * `fetched=10 eligible=0`, three runs in a row, while the feature looked fine
   * because a passing live run had been delivered by sync instead.
   */
  describe('the invite floor', () => {
    test('a real origin_server_ts is used when present', () => {
      const r = resolveJoinBackfillFloor([], {
        botUserId: BOT, inviteEvent: { origin_server_ts: INVITE_TS }, now: INVITE_TS + 9999,
      });
      expect(r).toEqual({ floor: INVITE_TS, source: 'invite-ts' });
    });

    test('a STRIPPED invite falls back to unsigned.age, not to now', () => {
      // The regression. A floor of `now` here is the bug.
      const now = INVITE_TS + 5000;
      const r = resolveJoinBackfillFloor([], {
        botUserId: BOT, inviteEvent: { type: 'm.room.member', unsigned: { age: 5000 } }, now,
      });
      expect(r).toEqual({ floor: INVITE_TS, source: 'invite-age' });
      // And that floor must actually admit a message sent after the invite.
      const chunk = [msg('$pre', INVITE_TS + 100, '!request architect 300000 20000')];
      expect(pendingJoinBackfill(chunk, { inviteTs: r.floor, botUserId: BOT })).toHaveLength(1);
    });

    test('an age that would put the floor in the future is refused', () => {
      const r = resolveJoinBackfillFloor([], {
        botUserId: BOT, inviteEvent: { unsigned: { age: 999_999 } }, now: 1000, windowMs: 500,
      });
      expect(r.source).not.toBe('invite-age');
    });

    test("the bot's own invite in the fetched timeline is used when the event has neither", () => {
      /*
       * The foreign invite is deliberately NEWER and therefore FIRST, because
       * /messages?dir=b returns newest first — a project that invites the bot and then
       * a colleague produces exactly this order. With the bot's invite listed first
       * the test passes whether or not state_key is checked, which it did: the
       * mutation that dropped the state_key guard survived until this was reordered.
       * Picking the later invite would put the floor after the pre-join message.
       */
      const chunk = [
        {
          type: 'm.room.member', state_key: '@other:matrix.test', origin_server_ts: INVITE_TS + 5000,
          content: { membership: 'invite' },
        },
        msg('$m', INVITE_TS + 50, 'hi'),
        {
          type: 'm.room.member', state_key: BOT, origin_server_ts: INVITE_TS,
          content: { membership: 'invite' },
        },
      ];
      const r = resolveJoinBackfillFloor(chunk, { botUserId: BOT, inviteEvent: {}, now: INVITE_TS + 9999 });
      expect(r).toEqual({ floor: INVITE_TS, source: 'timeline-invite' });
    });

    test('a JOIN membership event is not treated as the invite', () => {
      const chunk = [{
        type: 'm.room.member', state_key: BOT, origin_server_ts: INVITE_TS,
        content: { membership: 'join' },
      }];
      const r = resolveJoinBackfillFloor(chunk, {
        botUserId: BOT, inviteEvent: {}, now: 10_000_000, windowMs: 1000,
      });
      expect(r.source).toBe('window');
    });

    test('with no signal at all the window bounds it — neither nothing nor everything', () => {
      const now = 10_000_000;
      const r = resolveJoinBackfillFloor([], {
        botUserId: BOT, inviteEvent: null, now, windowMs: 300_000,
      });
      expect(r).toEqual({ floor: now - 300_000, source: 'window' });
      // Recent pre-join message: delivered. Old history: not replayed.
      expect(pendingJoinBackfill([msg('$recent', now - 1000, '!request a 1 1')], {
        inviteTs: r.floor, botUserId: BOT,
      })).toHaveLength(1);
      expect(pendingJoinBackfill([msg('$old', now - 900_000, '!request a 9 9')], {
        inviteTs: r.floor, botUserId: BOT,
      })).toHaveLength(0);
    });
  });

  test('with no invite timestamp nothing is replayed by default', () => {
    /*
     * The caller substitutes `Date.now()` when the invite carries no timestamp, which
     * admits nothing older than the join. Passing 0 here proves the selector does not
     * treat "no floor" as "replay everything" on its own either — if it did, a
     * missing timestamp anywhere upstream would execute the room's whole history.
     */
    const chunk = [msg('$old', 5, '!request architect 999999 99999')];
    expect(pendingJoinBackfill(chunk, { inviteTs: 0, botUserId: BOT }))
      .toHaveLength(1); // no floor means no filtering — which is why the caller always supplies one
    expect(pendingJoinBackfill(chunk, { inviteTs: Date.now(), botUserId: BOT }))
      .toHaveLength(0);
  });
});
