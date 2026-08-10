/*
 * The bot's DM rooms are bounded; a pending greeting is not collateral.
 *
 * The bridge opens a DM with each new human it discovers and never closes one.
 * `ensureBotDmRoom` reuses per human, so it is one room per person rather than per
 * encounter — but nothing removes it when the person is gone, and `botDmRooms` grows
 * beside it. A 50-minute soak that registered 48 throwaway project accounts left the
 * bot sitting alone in 52 DMs; in production that is one permanent room for every
 * user who ever appeared.
 *
 * THE TRAP THIS GUARDS: a DM the human has not accepted yet also shows the bot as the
 * only joined member. Reaping on "nobody else joined" would delete every greeting
 * still in flight — the invitation would vanish before it was seen. So `leave`/`ban`
 * are the signal, and an unknown or pending membership is never treated as departure.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('reaping dead bot DM rooms', () => {
  let runtimeDir;
  let reapableBotDms;
  let forgetGreetingOnReap;
  let envSnapshot;

  const DMS = {
    gone: '!gone:matrix.test',
    pending: '!pending:matrix.test',
    active: '!active:matrix.test',
    banned: '!banned:matrix.test',
  };

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'dm-reap-test-'));
    mkdirSync(path.join(runtimeDir, 'data', 'matrix'), { recursive: true });
    writeFileSync(path.join(runtimeDir, 'data', 'matrix', 'bridge-state.json'), JSON.stringify({
      botToken: null, agentTokens: {}, roomGroupMap: {}, groupRoomMap: {}, dmRooms: {},
    }, null, 2));
    envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_TRUST_MODE']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_TRUST_MODE = 'audit';

    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({ reapableBotDms, forgetGreetingOnReap } = await import(
      `${url}?dm-reap-test=${Date.now()}-${Math.random()}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  const keys = (r) => r.map((x) => x.humanKey).sort();

  test('a DM whose human LEFT is reaped', () => {
    const reap = reapableBotDms({ alice: DMS.gone }, { [DMS.gone]: 'leave' });
    expect(keys(reap)).toEqual(['alice']);
    expect(reap[0].roomId).toBe(DMS.gone);
  });

  test('a DM whose invitation is still PENDING is left alone', () => {
    /*
     * The whole reason this is not a member-count check. The human has been invited
     * and has not looked yet; reaping withdraws the greeting before it is seen.
     */
    expect(reapableBotDms({ bob: DMS.pending }, { [DMS.pending]: 'invite' })).toEqual([]);
  });

  test('a DM the human is still IN is left alone', () => {
    expect(reapableBotDms({ carol: DMS.active }, { [DMS.active]: 'join' })).toEqual([]);
  });

  test('an UNKNOWN membership is never treated as departure', () => {
    // A failed lookup must not become a deletion. Absence of evidence is the state
    // this whole module keeps having to be taught about.
    expect(reapableBotDms({ dave: DMS.gone }, {})).toEqual([]);
    expect(reapableBotDms({ dave: DMS.gone }, { [DMS.gone]: null })).toEqual([]);
  });

  test('a ban counts as gone', () => {
    const reap = reapableBotDms({ eve: DMS.banned }, { [DMS.banned]: 'ban' });
    expect(keys(reap)).toEqual(['eve']);
    expect(reap[0].reason).toBe('ban');
  });

  test('a mixed state reaps only the dead ones', () => {
    const reap = reapableBotDms(
      { alice: DMS.gone, bob: DMS.pending, carol: DMS.active, eve: DMS.banned },
      {
        [DMS.gone]: 'leave', [DMS.pending]: 'invite',
        [DMS.active]: 'join', [DMS.banned]: 'ban',
      },
    );
    expect(keys(reap)).toEqual(['alice', 'eve']);
  });

  test('a room the BOT has left drops the entry without trying to leave again', () => {
    /*
     * The residual leak the first version had. `/members?membership=leave` still
     * answers for a room you have left, but `/joined_members` returns M_FORBIDDEN —
     * so the reaper read that as "unknown", and unknown is deliberately never reaped.
     * 50 entries pointing at nothing survived a reaper that was otherwise working.
     *
     * Not a member is durable, unlike a rate limit, so it is safe to act on — but the
     * action is dropping the pointer, NOT leaving a room the bot is already out of.
     */
    const reap = reapableBotDms({ frank: DMS.gone }, { [DMS.gone]: 'bot-absent' });
    expect(keys(reap)).toEqual(['frank']);
    expect(reap[0].action).toBe('drop');
  });

  test('a live departure is a LEAVE, not a bare entry drop', () => {
    const reap = reapableBotDms({ alice: DMS.gone }, { [DMS.gone]: 'leave' });
    expect(reap[0].action).toBe('leave');
  });

  /*
   * WHERE THE REAL BUG WAS, and what no test could previously see.
   *
   * The decision above was well covered; the CONSEQUENCE — what state to delete after
   * acting — was inline in the caller. Deleting the greeting record on every reap made
   * the bridge forget it had greeted the person, so it greeted them again, created a
   * fresh DM, reaped that too, forever. Live: 50 reaped, 38 re-greeted, 39 -> 45 rooms
   * in forty-five seconds. Strictly worse than the leak it replaced, because a leak is
   * finite.
   */
  describe('whether reaping also forgets the greeting', () => {
    test('a stale pointer does NOT forget it — that was the churn loop', () => {
      expect(forgetGreetingOnReap('bot-absent')).toBe(false);
    });

    test('an actual departure does, so a returning human is greeted again', () => {
      expect(forgetGreetingOnReap('leave')).toBe(true);
      expect(forgetGreetingOnReap('ban')).toBe(true);
    });

    test('an unrecognised reason forgets nothing', () => {
      // Fail toward keeping state: forgetting is the side with the runaway loop.
      for (const r of [undefined, null, '', 'invite', 'join', 'weird']) {
        expect(forgetGreetingOnReap(r)).toBe(false);
      }
    });
  });

  test('malformed state yields nothing rather than throwing', () => {
    // This runs on a timer against persisted state, so a corrupt entry must not take
    // the sweep down with it.
    for (const bad of [undefined, null, 'nope', 42, { alice: null }, { alice: 42 }, { alice: '' }]) {
      expect(reapableBotDms(bad, { [DMS.gone]: 'leave' })).toEqual([]);
    }
  });

  test('a corrupt room id is dropped even when it LOOKS reapable', () => {
    /*
     * The case that makes the type guard load-bearing, and the one the first version
     * of this test missed: an empty or non-string room id whose membership lookup
     * happens to resolve to 'leave'. Without the guard that entry is emitted and
     * handed to leaveRoom(), which is a request against a room id that cannot exist.
     * The earlier cases all fell through on the membership lookup instead, so they
     * would have passed with the guard removed.
     */
    expect(reapableBotDms({ alice: '' }, { '': 'leave' })).toEqual([]);
    expect(reapableBotDms({ alice: 42 }, { 42: 'leave' })).toEqual([]);
    expect(reapableBotDms({ alice: null }, { null: 'leave' })).toEqual([]);
    // ...while a well-formed id alongside it is still reaped.
    expect(keys(reapableBotDms(
      { alice: '', bob: DMS.gone }, { '': 'leave', [DMS.gone]: 'leave' },
    ))).toEqual(['bob']);
  });
});
