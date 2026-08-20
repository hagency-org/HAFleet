/*
 * A RETRIED TRANSACTION MUST NOT BE ANSWERED TWICE.
 *
 * Found by restarting the co-located edge with a customer mid-sentence — the one thing the operator
 * walkthrough listed as unwalked, because the `settling` window had been sized by reasoning and nobody
 * had watched a restart with events actually in flight.
 *
 * The good news came first: nothing was lost. Twenty messages sent across a `docker restart
 * hafleet-edge` all arrived, including the two sent while the edge was down — the design holds, because
 * the homeserver keeps the transaction until HAFleet acks it.
 *
 * THE BAD NEWS WAS IN THE SAME TIMELINE. Twenty messages drew THIRTY-TWO replies, in bursts of six, as
 * the homeserver re-delivered the batches nobody had acked:
 *
 *     9.2s   probe    edge-probe 9/20
 *     9.9s   probe    edge-probe 10/20
 *    10.3s   HAFLEET  Send !help for available commands.
 *    10.4s   HAFLEET  Send !help for available commands.      ← ×6, for two messages
 *
 * `onRoomMessage` has four outcomes and three of them record the event: the command branch calls
 * `rememberMatrixEvent`, `group` and `agent-dm` both `checkpointMatrixEvent`. Non-command text in a bot
 * DM replied and recorded nothing, so every redelivery replied again. A transaction is retried whenever
 * HAFleet does not answer 200 — a restarted edge, a 500, a slow ack — and none of those is unusual.
 *
 * The `!request` case was already safe, which is the difference between an annoyance and an incident:
 * a retried command would have created a second engagement. That branch is asserted here too, so the
 * thing that protects it stays visible.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const BOT = '@agent-bridge:matrix.test';
const HUMAN = '@lin:matrix.test';
const ROOM = '!dm:matrix.test';

let MatrixBridge;
let runtimeDir;
let envSnapshot;

beforeAll(async () => {
  envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_SERVER_NAME', 'MATRIX_TRUST_MODE']);
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'bot-dm-retry-'));
  mkdirSync(path.join(runtimeDir, 'data', 'matrix'), { recursive: true });
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_SERVER_NAME = 'matrix.test';
  // `audit`, so the trust gate is not what this file is measuring.
  process.env.MATRIX_TRUST_MODE = 'audit';
  ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-bot-dm-retry`));
});

afterAll(() => {
  restoreEnv(envSnapshot);
  rmSync(runtimeDir, { recursive: true, force: true });
});

/** A bridge in the shape that produces a bot DM: the bot, one human, no agents, no group mapping. */
function botDmBridge() {
  const bridge = new MatrixBridge();
  const handled = [];
  bridge.botUserId = BOT;
  bridge.botClient = {
    getJoinedRoomMembers: vi.fn().mockResolvedValue([BOT, HUMAN]),
    sendMessage: vi.fn().mockResolvedValue('$sent'),
  };
  bridge.commands = { handle: vi.fn(async (roomId, sender, text) => { handled.push(text); }) };
  bridge.submitHumanMessage = vi.fn(async () => ({ id: 'msg_1' }));
  return { bridge, handled };
}

const say = (body, eventId) => ({
  event_id: eventId, sender: HUMAN, origin_server_ts: Date.now() + 60_000,
  content: { msgtype: 'm.text', body },
});

describe('plain text in a bot DM', () => {
  test('THE DEFECT: the same event redelivered is answered ONCE, not twice', async () => {
    const { bridge, handled } = botDmBridge();
    await bridge.onRoomMessage(ROOM, say('hello, can you help', '$retried-1'));
    await bridge.onRoomMessage(ROOM, say('hello, can you help', '$retried-1'));

    expect(handled).toEqual(['hello, can you help']);
  });

  test('and a redelivery much later is still the same event', async () => {
    /*
     * The retry window is not bounded by anything HAFleet controls. A homeserver that could not reach us
     * for a minute delivers the same transaction a minute later, and "we already answered that" has to
     * still be true then.
     */
    const { bridge, handled } = botDmBridge();
    const event = say('are you there', '$retried-2');
    await bridge.onRoomMessage(ROOM, event);
    await bridge.onRoomMessage(ROOM, { ...event });
    await bridge.onRoomMessage(ROOM, { ...event });
    expect(handled).toHaveLength(1);
  });

  test('but two DIFFERENT messages are two answers — the fix must not swallow real traffic', async () => {
    const { bridge, handled } = botDmBridge();
    await bridge.onRoomMessage(ROOM, say('first', '$distinct-a'));
    await bridge.onRoomMessage(ROOM, say('second', '$distinct-b'));
    expect(handled).toEqual(['first', 'second']);
  });

  test('two deliveries racing in flight collapse to one, as they always did', async () => {
    // The in-flight map already covered the concurrent case; this pins that the added record does not
    // change it, because the two mechanisms answer different questions.
    const { bridge, handled } = botDmBridge();
    const event = say('concurrent', '$racing');
    await Promise.all([bridge.onRoomMessage(ROOM, event), bridge.onRoomMessage(ROOM, event)]);
    expect(handled).toHaveLength(1);
  });
});

describe('a COMMAND in a bot DM — already safe, and it has to stay that way', () => {
  test('a retried !request is executed once, so no second engagement is created', async () => {
    /*
     * The branch this file exists because of got its recording right. Worth an assertion of its own:
     * duplicate hint replies are noise, a duplicate `!request` is a second allocation of somebody's
     * budget, and the two branches are four lines apart.
     */
    const { bridge, handled } = botDmBridge();
    await bridge.onRoomMessage(ROOM, say('!request architect 300000 20000', '$cmd-1'));
    await bridge.onRoomMessage(ROOM, say('!request architect 300000 20000', '$cmd-1'));
    expect(handled).toEqual(['!request architect 300000 20000']);
  });
});
