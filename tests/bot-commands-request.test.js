/*
 * `!request` — who gets to choose the request id, and which credential asks.
 *
 * This handler is the entire inbound path of L3: a project member types
 * `!request coding 400000 20000` in their own room and a contributor's capacity is asked
 * for. It had no test. What was untested is not the arithmetic but the two decisions that
 * cannot be checked by reading the reply text:
 *
 *   WHERE THE REQUEST ID COMES FROM. REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT requires it to be
 *   the AUTHENTICATED Matrix event id and never a value taken from message content. That
 *   clause exists because the id is a dedup key: a sender who could supply it could name
 *   someone else's request and have the store hand back — or silently overwrite — an
 *   engagement that was not theirs. The store's half of idempotency is pinned in
 *   tests/engagement-store.test.js; this is the half that decides what the key IS.
 *
 *   WHICH CREDENTIAL ASKS. REQ-CONTRIBUTION-CONSOLE-SUBMIT-SCOPE requires that the
 *   credential which submits a request cannot decide one, widen an offer, or edit the
 *   whitelist. That is implemented by preferring HAFLEET_REQUESTER_TOKEN over the operator
 *   API_TOKEN, so the bridge asks with the narrowest credential that can do the job. If the
 *   preference silently inverted, every request would be submitted with a token that can
 *   also approve it, and nothing in the reply text would change.
 *
 * Driven through `global.fetch`, which is the module's only outbound seam — `api()` is
 * module-private and reads its URL and headers from the environment at call time.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import BotCommands from '../lib/bot-commands.js';

const ROOM = '!aXbY7pQ2:hq.example';
const SENDER = '@requester:hq.example';
const EVENT_ID = '$authenticated-event-id';

let calls;
let realFetch;
const savedEnv = {};

/** A BotCommands whose Matrix client records rather than sends. */
function harness({ roomName = 'Demo project' } = {}) {
  const replies = [];
  const bot = new BotCommands({
    botClient: {
      sendMessage: async (roomId, content) => { replies.push({ roomId, body: content.body }); },
      getRoomStateEvent: async () => (roomName ? { name: roomName } : null),
    },
    bridge: {},
    botUserId: '@bot:hq.example',
  });
  return { bot, replies };
}

/** The body of the POST /api/engagements the handler made, or null if it made none. */
const engagementCall = () => calls.find((c) => c.path.endsWith('/api/engagements')) ?? null;

beforeEach(() => {
  calls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({
      path: String(url),
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    return {
      json: async () => ({
        engagement: {
          id: 'e1', role: 'coding', requestedTokens: 400_000, autoJoined: false, route: 'notWhitelisted',
        },
      }),
    };
  };
  for (const k of ['HAFLEET_REQUESTER_TOKEN', 'API_TOKEN', 'MATRIX_BRIDGE_SECRET']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  global.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the request id is the authenticated event id', () => {
  test('the event id from the context becomes the requestId', async () => {
    // REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT. The id both sides already share, and the one the
    // sender cannot choose.
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    expect(engagementCall().body.requestId).toBe(EVENT_ID);
  });

  test('a requestId written into the message ARGUMENTS is ignored', async () => {
    /*
     * The attack the requirement is about, stated as a test. A sender types extra words
     * hoping one is read as the dedup key; if any were, they could address a request id
     * that is not theirs. Only the event id may reach the body.
     */
    const { bot } = harness();
    await bot.cmdRequest(
      ROOM,
      ['coding', '400000', '20000', '$forged-event-id', 'requestId=$forged-event-id'],
      SENDER,
      { eventId: EVENT_ID },
    );
    const body = engagementCall().body;
    expect(body.requestId).toBe(EVENT_ID);
    expect(JSON.stringify(body)).not.toContain('forged');
  });

  test('with no event id, NO requestId is sent rather than a generated one', async () => {
    /*
     * The last clause of REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT: a request that could not be
     * deduplicated must RECORD that, not be assigned an invented key. Inventing one here
     * would make every un-authenticated call look deduplicated while sharing no key with
     * anybody — the store could never match a retry to it.
     */
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, {});
    expect(Object.hasOwn(engagementCall().body, 'requestId')).toBe(false);
  });

  test('the room id comes from the room, not from the arguments', async () => {
    // REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY, at the point of entry: the whitelist keys on
    // the authenticated projectRoomId, so a room id in message content must not reach it.
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000', '20000'], SENDER, { eventId: EVENT_ID });
    expect(engagementCall().body.projectRoomId).toBe(ROOM);
  });

  test('the requester is the authenticated sender', async () => {
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], '@someone:hq.example', { eventId: EVENT_ID });
    expect(engagementCall().body.requester).toBe('@someone:hq.example');
  });
});

describe('the narrowest credential that can submit', () => {
  test('the requester token is preferred over the operator token', async () => {
    /*
     * REQ-CONTRIBUTION-CONSOLE-SUBMIT-SCOPE. Both configured is the normal deployment —
     * the operator token exists for the console — so the preference is what keeps a
     * submission from being made with a credential that can also approve it.
     */
    process.env.API_TOKEN = 'operator-token';
    process.env.HAFLEET_REQUESTER_TOKEN = 'requester-token';
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    expect(engagementCall().headers.Authorization).toBe('Bearer requester-token');
  });

  test('the operator token is used only when no requester token exists', async () => {
    // Not a security property but a compatibility one: an existing deployment that has not
    // provisioned a requester token must still be able to submit.
    process.env.API_TOKEN = 'operator-token';
    const { bot } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    expect(engagementCall().headers.Authorization).toBe('Bearer operator-token');
  });
});

describe('!offer — the read that precedes the ask', () => {
  /*
   * Before the transparency ruling there was nothing useful to answer: role names and caps,
   * with the one fact a borrower most needs — what actually serves the role — withheld by
   * policy. The command exists because the answer became worth giving.
   */
  const bookReply = (body) => async (url, opts = {}) => {
    calls.push({ path: String(url), headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    return { json: async () => body };
  };
  const oneRole = {
    roles: [{
      role: 'coding', budgetCapPerEngagement: 400_000, rateCap: 20_000, count: 2, runningNow: 1,
      serving: { agent: 'claude-agent', framework: 'claude', model: 'claude-opus-5', reasoning: 'high', tier: 'strong' },
    }],
    whitelisted: false,
    projectRoomId: ROOM,
  };

  test('the room id comes from the ROOM, and the command takes no arguments', async () => {
    /*
     * Same rule as `!request`, and here it decides what a caller is told about their own
     * trust state: a room id from message content would let a sender ask whether SOMEONE
     * ELSE's room is whitelisted.
     */
    global.fetch = bookReply(oneRole);
    const { bot } = harness();
    await bot.cmdOffer(ROOM);
    expect(calls[0].path).toContain(encodeURIComponent(ROOM));
  });

  test('it names the model and tier, not just the role', async () => {
    global.fetch = bookReply(oneRole);
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    const body = replies.at(-1).body;
    expect(body).toContain('coding');
    expect(body).toContain('claude-opus-5');
    expect(body).toContain('strong');
    // And the caps a request has to fit inside.
    expect(body).toContain('400000');
    expect(body).toMatch(/1 of 2 running/);
  });

  test('a not-whitelisted room is told its request will wait', async () => {
    // The most actionable line in the reply: auto-join or a decision.
    global.fetch = bookReply(oneRole);
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).toMatch(/waits for the contributor/);
  });

  test('a whitelisted room is told its request joins automatically', async () => {
    global.fetch = bookReply({ ...oneRole, whitelisted: true });
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).toMatch(/joins automatically/);
  });

  test('an unknown trust state says NOTHING about trust', async () => {
    /*
     * `whitelisted: null` is "no room was identified", and rendering that as either sentence
     * would be a statement the bot cannot support.
     */
    global.fetch = bookReply({ ...oneRole, whitelisted: null });
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).not.toMatch(/whitelist|automatically|waits/i);
  });

  test('nothing published reads as a state, not as a failure', async () => {
    /*
     * A contributor with capacity configured but unadvertised is a normal state. Reporting it
     * as an error sends the project to ask why the bot is broken.
     */
    global.fetch = bookReply({ roles: [], whitelisted: false, projectRoomId: ROOM });
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).toMatch(/nothing on offer/i);
    expect(replies.at(-1).body).not.toMatch(/error|cannot/i);
  });

  test('a published role nothing can serve says so', async () => {
    global.fetch = bookReply({
      roles: [{ role: 'coding', budgetCapPerEngagement: null, rateCap: null, count: null, runningNow: 0, serving: null }],
      whitelisted: false, projectRoomId: ROOM,
    });
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).toMatch(/nothing currently qualifies/);
  });

  test('a backend error is reported as one', async () => {
    global.fetch = bookReply({ error: 'unauthorized' });
    const { bot, replies } = harness();
    await bot.cmdOffer(ROOM);
    expect(replies.at(-1).body).toMatch(/Cannot read the offer book/);
  });
});

describe('what the project is told it got', () => {
  /*
   * REQ-CONTRIBUTION-CONSOLE-ROLES as rewritten by the operator ruling of 2026-08-11: the
   * serving agent and its model are DISCLOSED to the borrower, while the provider's
   * deployment is not. Both halves are asserted, because a transparency rule with only its
   * first half is indistinguishable from a leak.
   */
  const autoJoined = (serving) => async (url, opts = {}) => {
    calls.push({ path: String(url), headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    return {
      json: async () => ({
        engagement: {
          id: 'e1', role: 'coding', allocatedTokens: 400_000, autoJoined: true, agent: 'claude-agent',
        },
        binding: { bound: false, error: 'no owner known for this agent: set HAFLEET_OWNER_MXID and HAFLEET_OWNER_DM_ROOM, or let the Matrix bridge create the first binding' },
        serving,
      }),
    };
  };

  test('the reply names the framework, model and reasoning level', async () => {
    /*
     * The fact a borrower can act on. Before the ruling this line named the agent and
     * nothing else — and this deployment's names encode the framework, so it disclosed the
     * identity while withholding the model: the worst of both policies.
     */
    global.fetch = autoJoined({
      agent: 'claude-agent', framework: 'claude', model: 'claude-opus-5', reasoning: 'high', tier: 'strong',
    });
    const { bot, replies } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    const body = replies.at(-1).body;
    expect(body).toContain('claude-opus-5');
    expect(body).toContain('high');
    expect(body).toContain('strong');
  });

  test('a failure does NOT hand the project the provider\'s configuration', async () => {
    /*
     * The private half, and the one that was wrong under the previous policy too. The
     * backend's bind error names `HAFLEET_OWNER_MXID` and `HAFLEET_OWNER_DM_ROOM` as the
     * remedy — actionable for the provider, and for a project it is a description of
     * somebody else's deployment. The project is told the attach did not happen, which is
     * all they can act on.
     */
    global.fetch = autoJoined({ agent: 'claude-agent', framework: 'claude', model: 'claude-opus-5', reasoning: null, tier: 'strong' });
    const { bot, replies } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    const body = replies.at(-1).body;
    expect(body).not.toMatch(/HAFLEET_/);
    expect(body).not.toMatch(/DM_ROOM|MXID/);
    // Still told, though — a silent partial success would be its own defect.
    expect(body).toMatch(/could not be attached/i);
  });

  test('an unknown configuration degrades to the agent alone, not to a fabricated one', async () => {
    // `serving: null` happens when the agent record is gone. Naming a model nobody
    // measured would be worse than naming none.
    global.fetch = autoJoined(null);
    const { bot, replies } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    const body = replies.at(-1).body;
    expect(body).toContain('claude-agent');
    expect(body).not.toMatch(/running/);
  });
});

describe('what the project is told', () => {
  test('a malformed token amount is refused without reaching the backend', async () => {
    /*
     * Both halves: the reply names the offending word, and NO engagement is created. A
     * handler that validated after the call would leave a record for every typo.
     */
    const { bot, replies } = harness();
    await bot.cmdRequest(ROOM, ['coding', 'four-hundred-thousand'], SENDER, { eventId: EVENT_ID });
    expect(replies.at(-1).body).toContain('four-hundred-thousand');
    expect(engagementCall()).toBeNull();
  });

  test('a pending request is told WHY, in the project\'s own terms', async () => {
    /*
     * "Pending" alone is not actionable. `notWhitelisted` and `overCeiling` are different
     * situations with different next steps, and the project can only act on the difference
     * if the reply states it.
     */
    const { bot, replies } = harness();
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    expect(replies.at(-1).body).toMatch(/whitelist/i);
  });

  test('the room NAME labels the engagement while the room ID identifies it', async () => {
    /*
     * Both, and not interchangeably: an unnamed room must still be requestable, and a
     * named one must not be identified by its label — which is renameable by anyone with
     * permission in the room.
     */
    const { bot } = harness({ roomName: 'Demo project' });
    await bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    expect(engagementCall().body.project).toBe('Demo project');
    expect(engagementCall().body.projectRoomId).toBe(ROOM);

    calls = [];
    const unnamed = harness({ roomName: null });
    await unnamed.bot.cmdRequest(ROOM, ['coding', '400000'], SENDER, { eventId: EVENT_ID });
    // Falls back to the id rather than failing: the id still identifies the project.
    expect(engagementCall().body.project).toBe(ROOM);
  });
});
