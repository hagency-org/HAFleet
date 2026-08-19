/*
 * WHO SPEAKS IN A ROOM — behaviourally, because a source-level assertion could not see the defect.
 *
 * `!offer` typed by a customer on a clean pair of machines reached the dispatcher, was handled, and its
 * answer died with `M_FORBIDDEN: sender's membership is not 'join'`. Replies went out as HAFleet's own bot,
 * and on a project side the bot is not a member — the representative is. The customer saw nothing.
 *
 * THEN THE FIRST FIX WAS NOT ENOUGH, and that is the reason this file exists rather than another regex over
 * the source. Comparing the room's server against `MATRIX_SERVER_NAME` handles a customer on a DIFFERENT
 * homeserver. When a project side runs on the SAME homeserver as HAFleet's bot — an ordinary deployment, and
 * the one this was walked on — the comparison says "ours", the bot is used, and the bot still is not in the
 * room. Identical silence, one branch over.
 *
 * A source grep said the fix was present while the machine kept failing, and a mutation that deleted the
 * fallback outright still passed it. So the fallback is asserted by running it.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

const sendToRoomOnSide = vi.fn();

vi.mock('../lib/matrix-representative.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendToRoomOnSide: (...args) => sendToRoomOnSide(...args) };
});

let bridgeModule;
beforeAll(async () => {
  bridgeModule = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-say-in-room`);
  OURS = `!ours:${bridgeModule.ourServerNameForTest()}`;
});

/*
 * OUR OWN SERVER, READ FROM THE MODULE rather than recomputed. Two earlier versions of this constant were
 * wrong in the same way: `customer.test` for every case (so four tests exercised the cross-server fast path
 * while claiming to test the bot), then a duplicated expression with the wrong default. A test that
 * re-derives a value it is comparing against will eventually disagree with the code and pass anyway.
 */
let OURS;
const THEIRS = '!proj:customer.test';
const CONTENT = { msgtype: 'm.text', body: 'the answer' };

/** The minimum `sayInRoom` reads, driven through the prototype like the other bridge tests. */
function selfWith({ botThrows = null, acting = null, sendResult = { sent: true, eventId: '$rep' } } = {}) {
  sendToRoomOnSide.mockReset();
  sendToRoomOnSide.mockResolvedValue(sendResult);
  const botSends = [];
  return {
    botSends,
    self: {
      botClient: {
        sendMessage: vi.fn(async (roomId, content) => {
          botSends.push({ roomId, content });
          if (botThrows) throw botThrows;
          return '$bot';
        }),
      },
      actingSideFor: () => acting,
    },
  };
}

const say = (self, roomId = null, content = CONTENT, opts) => bridgeModule.MatrixBridge.prototype.sayInRoom
  .call(self, roomId ?? OURS, content, opts);

const ACTING = { side: { serverName: 'customer.test', apiBaseUrl: 'http://hs' }, credential: { kind: 'appservice', asToken: 'as' } };
const FORBIDDEN = Object.assign(new Error('M_FORBIDDEN: sender\'s membership is not `join`'), {
  errcode: 'M_FORBIDDEN',
  error: 'sender\'s membership is not `join`',
});

describe('a room our bot can speak in', () => {
  test('the bot sends it, and the representative is not involved', async () => {
    const { self, botSends } = selfWith({ acting: ACTING });
    await expect(say(self)).resolves.toBe('$bot');
    expect(botSends).toHaveLength(1);
    expect(sendToRoomOnSide).not.toHaveBeenCalled();
  });
});

describe('a room our bot is not in', () => {
  test('THE DEFECT: the representative answers instead of the message being lost', async () => {
    const { self } = selfWith({ botThrows: FORBIDDEN, acting: ACTING });
    await expect(say(self)).resolves.toBe('$rep');
    expect(sendToRoomOnSide).toHaveBeenCalledTimes(1);
    const [args] = sendToRoomOnSide.mock.calls[0];
    expect(args.roomId).toBe(OURS);
    expect(args.content).toEqual(CONTENT);
  });

  test('with no credential for that server the original error is raised, not swallowed', async () => {
    /*
     * The refusal has to survive. "We cannot speak there" must stay visible — turning it into silence is
     * the defect, and a fallback that pretends to succeed would be worse than the bug.
     */
    const { self } = selfWith({ botThrows: FORBIDDEN, acting: null });
    await expect(say(self)).rejects.toThrow(/M_FORBIDDEN/);
  });

  test('when the representative cannot speak either, the answer names both failures', async () => {
    const { self } = selfWith({
      botThrows: FORBIDDEN,
      acting: ACTING,
      sendResult: { sent: false, reason: 'as_token rejected' },
    });
    await expect(say(self)).rejects.toThrow(/bot got .*representative got as_token rejected/s);
  });
});

describe('errors that are not about membership', () => {
  test('a rate limit is re-thrown rather than retried as somebody else', async () => {
    /*
     * NARROW ON PURPOSE. Retrying every failure as the representative would send messages under a different
     * identity for reasons that have nothing to do with who is in the room — and would hide real faults.
     */
    const limited = Object.assign(new Error('M_LIMIT_EXCEEDED: slow down'), { errcode: 'M_LIMIT_EXCEEDED' });
    const { self } = selfWith({ botThrows: limited, acting: ACTING });
    await expect(say(self)).rejects.toThrow(/M_LIMIT_EXCEEDED/);
    expect(sendToRoomOnSide).not.toHaveBeenCalled();
  });

  test('a forbidden that is NOT about membership is re-thrown too', async () => {
    // `M_FORBIDDEN` also covers "you may not do that here", which the representative cannot fix either.
    const other = Object.assign(new Error('M_FORBIDDEN: power level too low'), {
      errcode: 'M_FORBIDDEN', error: 'power level too low',
    });
    const { self } = selfWith({ botThrows: other, acting: ACTING });
    await expect(say(self)).rejects.toThrow(/power level too low/);
    expect(sendToRoomOnSide).not.toHaveBeenCalled();
  });
});

describe('a room on a project side, when that side is somebody else\'s homeserver', () => {
  test('the representative speaks first, with no failed bot attempt', async () => {
    /*
     * The fast path, and it matters: attempting the bot first would post nothing but would still cost a
     * round trip and log a failure for every answer to every customer.
     */
    const { self, botSends } = selfWith({ acting: ACTING });
    // `MATRIX_SERVER_NAME` for this process is not `customer.test`, so this is the cross-server case.
    await expect(say(self, THEIRS)).resolves.toBe('$rep');
    expect(botSends).toHaveLength(0);
  });
});

describe('the notice about a failure must not itself fail', () => {
  /*
   * `sendDeliveryNotice` is the one message a room is OWED when something went wrong — "your message was not
   * delivered" — and it was the message most certain to fail. It went out as the bot, so on a project side it
   * hit `M_FORBIDDEN`; with no bot at all it threw `Cannot read properties of null (reading 'sendMessage')`.
   * Found by running the bot-less path, one site after `reply` and the `!dm` nudge.
   */
  test('it goes through sayInRoom, so the representative can deliver it', async () => {
    const said = [];
    const self = {
      sayInRoom: async (roomId, content) => { said.push({ roomId, body: content.body }); },
    };
    await bridgeModule.MatrixBridge.prototype.sendDeliveryNotice.call(self, THEIRS, 'not delivered');
    expect(said).toEqual([{ roomId: THEIRS, body: 'not delivered' }]);
  });

  test('an empty notice is still not sent', async () => {
    const calls = [];
    const self = { sayInRoom: async () => { calls.push(1); } };
    await bridgeModule.MatrixBridge.prototype.sendDeliveryNotice.call(self, THEIRS, '');
    expect(calls).toHaveLength(0);
  });

  test('a failure to notice is logged, not thrown at the caller mid-message', async () => {
    // The caller is delivering a message. A broken notice must not become a second failure on top of the
    // first one it was trying to report.
    const self = { sayInRoom: async () => { throw new Error('nope'); } };
    await expect(
      bridgeModule.MatrixBridge.prototype.sendDeliveryNotice.call(self, THEIRS, 'x'),
    ).resolves.toBeUndefined();
  });
});
