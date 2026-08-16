/*
 * Two defects that shipped, and the seam that hid the first one.
 *
 * 1. `normalizeSender` rejected `{ kind: 'token', token }` — the exact shape `agentSenderFor` returns
 *    for an agent that HAS a token. Every group send by such an agent became "sendAsAgent had no way
 *    to send". It reached master because the two halves were tested apart: `agentSenderFor` on its own,
 *    and `sendAsAgentContent` with a raw string. Nothing passed the value that travels BETWEEN them
 *    through both, so two green suites still added up to a broken path. The first test below is that
 *    missing seam, written as a round trip rather than a shape assertion, so it keeps holding if either
 *    side's shape changes again.
 *
 * 2. Progress reports landed in the main timeline. `resolveGroupReplyRelation` replies at top level
 *    when the source message is not already threaded — right for a reply, wrong for progress, which
 *    exists for the one person waiting and 「把其他人的对话都冲了」 for everyone else.
 *
 * WHAT THESE TESTS DO NOT PROVE, and the room should know it: a thread is the same room, the same
 * membership and the same history visibility. Everyone present can still read every line. This buys
 * attention, not privacy — see the note in `resolveGroupReplyRelation`.
 */
import { describe, expect, test } from 'vitest';
import { MatrixBridge, resolveGroupReplyRelation } from '../bridge-matrix.js';

const ROOM = '!room:example.org';
const GROUP = 'hafleet';
const QUESTION = '$question-event';

/** Route metadata for a question asked at the room's top level — no thread anywhere. */
function topLevelQuestion() {
  return {
    group: GROUP,
    source: 'matrix',
    matrixContext: { roomId: ROOM, eventId: QUESTION, threadRootEventId: null },
  };
}

describe('the shape that travels between agentSenderFor and normalizeSender', () => {
  test('a token sender survives the round trip that broke in production', () => {
    /*
     * `agentSenderFor` is CALLED, not imitated. A hand-written literal is what the existing tests
     * already had, and it is why this shipped: a literal asserts the shape I believe travels, while
     * the bug was that the real one differs. Only feeding the producer's actual output to the
     * consumer tests the seam, and it keeps testing it when either end changes.
     */
    const bridge = new MatrixBridge();
    bridge.knownAgents = new Set(['biglittle']);
    bridge.knownAgentIndex = new Map([['biglittle', 'biglittle']]);
    bridge.getAgentToken = () => 'syt_agent_token';
    bridge.sideForRoom = () => null; // no project side owns this room, so the token path applies

    const produced = bridge.agentSenderFor('biglittle', '!room:example.org');
    expect(produced).toMatchObject({ kind: 'token', token: 'syt_agent_token' });

    const normalized = MatrixBridge.normalizeSender(produced);
    expect(normalized).not.toBeNull();
    expect(normalized.kind).toBe('token');
    expect(normalized.token).toBe('syt_agent_token');
  });

  test('a bare token string still works, because that caller was never broken', () => {
    expect(MatrixBridge.normalizeSender('syt_raw')).toEqual({ kind: 'token', token: 'syt_raw' });
  });

  test('a token-shaped object with no token is still refused', () => {
    // The failure this guards is worse than no send: an empty Authorization header reads as the
    // bridge's own identity to some homeservers, so the agent's message would go out as the bot.
    expect(MatrixBridge.normalizeSender({ kind: 'token', token: '' })).toBeNull();
    expect(MatrixBridge.normalizeSender({ kind: 'token' })).toBeNull();
  });
});

describe('where an incidental message goes', () => {
  test('it opens a thread on the message it accompanies', () => {
    const resolution = resolveGroupReplyRelation(topLevelQuestion(), {
      group: GROUP, roomId: ROOM, incidental: true,
    });
    expect(resolution.kind).toBe('relation');
    expect(resolution.threadRootEventId).toBe(QUESTION);
    expect(resolution.relation.rel_type).toBe('m.thread');
    expect(resolution.relation.event_id).toBe(QUESTION);
    // Clients without thread support must still show it rather than drop it.
    expect(resolution.relation.is_falling_back).toBe(true);
  });

  test('an ordinary reply to the same message stays at the top level', () => {
    // The guard against this change leaking into normal traffic. Moving every answer into a thread
    // would take conversations out of the room they were started in, which is a worse room.
    const resolution = resolveGroupReplyRelation(topLevelQuestion(), { group: GROUP, roomId: ROOM });
    expect(resolution.kind).toBe('relation');
    expect(resolution.threadRootEventId).toBeNull();
    expect(resolution.relation.rel_type).toBeUndefined();
    expect(resolution.relation['m.in_reply_to']).toEqual({ event_id: QUESTION });
  });

  test('it never re-roots a thread that already exists', () => {
    // A question asked INSIDE a thread already has a root. Rooting progress at the question instead
    // would split one conversation into two, and Matrix has no way to merge them back.
    const threaded = {
      group: GROUP,
      source: 'matrix',
      matrixContext: { roomId: ROOM, eventId: QUESTION, threadRootEventId: '$real-root' },
    };
    for (const incidental of [true, false]) {
      const resolution = resolveGroupReplyRelation(threaded, { group: GROUP, roomId: ROOM, incidental });
      expect(resolution.threadRootEventId).toBe('$real-root');
      expect(resolution.relation.event_id).toBe('$real-root');
    }
  });

  test('being incidental does not buy reach a reply would not have', () => {
    // The reason this flag is safe to accept from any caller, unlike `thread_root_event_id`. A wrong
    // room is still rejected and a wrong group is still rejected; the flag only ever narrows where a
    // permitted message lands, so a caller that lies about it makes its own message quieter.
    expect(resolveGroupReplyRelation(topLevelQuestion(), {
      group: GROUP, roomId: '!elsewhere:example.org', incidental: true,
    }).kind).toBe('reject');
    expect(resolveGroupReplyRelation(topLevelQuestion(), {
      group: 'other-group', roomId: ROOM, incidental: true,
    }).kind).toBe('reject');
  });

  test('with no source metadata it falls back rather than inventing a root', () => {
    const resolution = resolveGroupReplyRelation(null, { group: GROUP, roomId: ROOM, incidental: true });
    expect(resolution.kind).toBe('fallback');
    expect(resolution.threadRootEventId).toBeNull();
  });
});
