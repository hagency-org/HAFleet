/*
 * The pre-join message loss, pinned.
 *
 * Sync delivers only events from after the join point, so anything said between the
 * invite and the join used to be lost permanently — no engagement, no reply, no
 * error. Reproduced against the live deployment before the fix: a `!request` at t+0
 * into a fresh room, bot joined at t+2s, still unanswered 80 seconds later.
 *
 * THE FIRST FIX WAS UNSOUND AND THESE TESTS DID NOT CATCH IT. It computed a time
 * "floor" from the invite and admitted anything newer, which treats `origin_server_ts`
 * as timeline order. Matrix does not: `/messages` order is server-defined, an
 * application service can set timestamps without changing DAG order, and clocks skew.
 * The counterexamples that version failed are the first two tests below, and both
 * came from an adversarial review rather than from here.
 *
 * Selection is now by POSITION between the bot's current invite and its join, and it
 * FAILS CLOSED when that boundary is not in the fetched page.
 *
 * WHAT THESE TESTS DO NOT COVER. They exercise the SELECTOR only. Deleting the
 * `backfillJoinedRoom()` call from `handleBotInvite` leaves every assertion here
 * green, because the bridge class is not exported and cannot be instantiated from a
 * unit test. The wiring is covered instead by mockup/scripts/e2e-full-loop.mjs, which
 * sends a `!request` before the bot can join against the real bridge and asserts an
 * engagement appears — and by the bridge's own `Join backfill …` log line, whose
 * `already-claimed` counter separates this path from sync having won the race. Saying
 * so here rather than letting the count of green tests imply otherwise.
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
  let envSnapshot;

  const BOT = '@hafleet-bot:matrix.test';

  /** A message event, with the fields the selector actually reads. */
  const msg = (id, body, sender = '@lin:matrix.test', ts = 1000) => ({
    type: 'm.room.message',
    event_id: id,
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body },
  });

  const member = (membership, ts = 1000, who = BOT) => ({
    type: 'm.room.member', state_key: who, sender: '@lin:matrix.test',
    origin_server_ts: ts, content: { membership },
  });

  /**
   * Build a `/messages?dir=b` page from events given in TIMELINE order.
   *
   * The helper reverses, because the homeserver returns newest-first and a fixture
   * written in the convenient order would not be the shape the code receives.
   */
  const page = (...timelineOrder) => [...timelineOrder].reverse();

  const ids = (r) => r.events.map((e) => e.event_id);

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
    ({ pendingJoinBackfill } = await import(`${bridgeUrl}?join-backfill-test=${cacheBust}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  // ── the two counterexamples the timestamp version failed ──────────────────

  test('an older-in-timeline command with a NEWER timestamp is not admitted', () => {
    /*
     * The counterexample that condemned the floor approach. This `!request` sits
     * before the current invite in the timeline but carries a later wall-clock
     * timestamp — which an application service may legitimately set. A floor of
     * "invite time" admits and executes it.
     */
    const chunk = page(
      msg('$stale', '!request architect 999999 99999', '@lin:matrix.test', 1500),
      member('invite', 1000),
      msg('$real', '!request architect 300000 20000', '@lin:matrix.test', 1100),
      member('join', 1200),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$real']);
  });

  test('commands sharing a millisecond keep timeline order, not fetch order', () => {
    /*
     * `!request` then `!cancel` is not `!cancel` then `!request`. Sorting by
     * timestamp is stable, so equal timestamps preserved the newest-first order the
     * fetch returned and silently inverted the pair.
     */
    const chunk = page(
      member('invite', 1000),
      msg('$request', '!request architect 1 1', '@lin:matrix.test', 1100),
      msg('$cancel', '!cancel', '@lin:matrix.test', 1100),
      member('join', 1200),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$request', '$cancel']);
  });

  // ── the defect itself ─────────────────────────────────────────────────────

  test('a command sent between the invite and the join is delivered', () => {
    const chunk = page(
      member('invite'),
      msg('$b', '!request architect 300000 20000'),
      member('join'),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$b']);
  });

  test('a command that arrives after the join is left to sync', () => {
    // Not this function's window: sync delivers everything past the join point, and
    // routing it here as well is a second chance to double-handle.
    const chunk = page(
      member('invite'), msg('$before', 'a'), member('join'), msg('$after', 'b'),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$before']);
  });

  test('with no join yet in the page, everything after the invite is the window', () => {
    const chunk = page(member('invite'), msg('$a', 'a'), msg('$b', 'b'));
    const r = pendingJoinBackfill(chunk, { botUserId: BOT });
    expect(ids(r)).toEqual(['$a', '$b']);
    expect(r.boundary).toBe('invite..end');
  });

  // ── failing closed ────────────────────────────────────────────────────────

  test('with no provable invite in the page, NOTHING is routed', () => {
    /*
     * The bounded-window fallback that used to sit here was fail-open by
     * construction: on a re-invite whose current invite had fallen off the page, it
     * admitted a four-minute-old `!request` and executed it. Commands are executable;
     * replaying one nobody just issued is worse than missing it.
     */
    const chunk = page(msg('$old', '!request architect 999999 99999'), msg('$older', '!approve'));
    const r = pendingJoinBackfill(chunk, { botUserId: BOT });
    expect(r.events).toEqual([]);
    expect(r.boundary).toBe('unproven');
  });

  test('history before an EARLIER membership cycle is not replayed on re-invite', () => {
    /*
     * Invited, left, re-invited. Anchoring on the first invite found replays the
     * previous cycle's commands; the current invite is the only valid anchor.
     */
    const chunk = page(
      member('invite', 1000),
      msg('$oldCycle', '!request architect 999999 99999', '@lin:matrix.test', 1100),
      member('join', 1200),
      member('leave', 1300),
      member('invite', 1400),
      msg('$thisCycle', '!request architect 300000 20000', '@lin:matrix.test', 1500),
      member('join', 1600),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$thisCycle']);
  });

  test("another user's invite is not mistaken for the bot's", () => {
    /*
     * The colleague is invited AFTER the bot, which is the ordinary sequence — invite
     * the bot, then invite a teammate — and the one that makes this load-bearing.
     * With the foreign invite listed first, "last invite wins" lands on the bot's
     * either way and the test passes without the state_key check; that mutation
     * survived until this fixture was reordered.
     */
    const chunk = page(
      member('invite', 1000),
      msg('$ours', '!request architect 1 1'),
      member('invite', 1100, '@someone:matrix.test'),
      member('join', 1200),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$ours']);
  });

  test('a JOIN membership is not treated as an invite', () => {
    const chunk = page(member('join', 1000), msg('$m', '!request architect 1 1'));
    expect(pendingJoinBackfill(chunk, { botUserId: BOT }).boundary).toBe('unproven');
  });

  // ── filtering inside the window ───────────────────────────────────────────

  test("the bot's own messages are never fed back to it", () => {
    const chunk = page(
      member('invite'), msg('$mine', '!help', BOT), msg('$theirs', '!request architect 1 1'), member('join'),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$theirs']);
  });

  test('already-seen events are skipped, so sync and backfill cannot double-handle', () => {
    const chunk = page(
      member('invite'), msg('$dup', 'a'), msg('$fresh', 'b'), member('join'),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT, seen: new Set(['$dup']) })))
      .toEqual(['$fresh']);
  });

  test('non-message events and events without an id are ignored', () => {
    const chunk = page(
      member('invite'),
      { type: 'm.room.topic', event_id: '$t', content: { topic: 'x' } },
      { type: 'm.room.message', content: { body: 'no id' } },
      msg('$ok', '!request architect 1 1'),
      member('join'),
    );
    expect(ids(pendingJoinBackfill(chunk, { botUserId: BOT }))).toEqual(['$ok']);
  });

  test('a missing or malformed page yields nothing rather than throwing', () => {
    // The join already succeeded by the time this runs; a bad /messages response must
    // not take the bot back out of a room it is legitimately in.
    for (const bad of [undefined, null, 'nope', {}, 42]) {
      expect(pendingJoinBackfill(bad, { botUserId: BOT }).events).toEqual([]);
    }
    // And with no bot identity there is no boundary to find.
    expect(pendingJoinBackfill([member('invite')], {}).events).toEqual([]);
  });
});
