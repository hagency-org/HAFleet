/*
 * Invitations awaiting the contributor's decision.
 *
 * ADR-014's 2026-08-11 amendment. What this record replaces was wrong in both directions:
 * `MATRIX_TRUST_MODE` defaults to `audit`, so an agent joined any room anyone invited it to while
 * no ownership binding was written — present, messageable, and permanently unengageable, because
 * every approval then failed `owner_binding_missing`. Under `enforce` the invitation was skipped
 * with only a log line, and `untrusted_inviter` occurs exactly once in the whole repository: the
 * line that produces it. Either way the contributor never learned they had been invited.
 *
 * The properties worth pinning are the ones a careless store would get wrong, and each of them
 * corresponds to a way the contributor's ANSWER could be lost or forged:
 *
 *   the poll repeats, so recording must be idempotent or one invitation becomes many
 *   a settled question must not reopen, or "no" is unexpressible
 *   the inviter is the OWNER (ADR-002), so it may never be guessed
 *   the project server is in the room id, so it may never be taken on trust from a caller
 *   a pending record may never be pruned, however much history accumulates
 */

import { describe, expect, test } from 'vitest';
import { createPendingInviteStore, PendingInviteError } from '../lib/pending-invite-store.js';

const ROOM = '!proj7Kq2:their-server.example';
const OTHER = '!other9Zz:their-server.example';
const INVITER = '@admin:their-server.example';

/** A store with an in-memory persist, so a test can see whether a write happened. */
function store({ now = () => 1_000 } = {}) {
  const writes = [];
  const s = createPendingInviteStore({ persist: (state) => { writes.push(state); return true; }, now });
  return { s, writes };
}

const invite = (over = {}) => ({
  project_room_id: ROOM, agent: 'lend-opus-01', inviter: INVITER, seen_at: 500, ...over,
});

describe('recording an invitation', () => {
  test('captures the room, the agent and the inviter', () => {
    const { s } = store();
    expect(s.upsert(invite())).toMatchObject({
      projectRoomId: ROOM, agent: 'lend-opus-01', inviter: INVITER, state: 'pending',
    });
  });

  test('DERIVES the project server from the room id rather than trusting the caller', () => {
    /*
     * The room id is `!opaque:origin-server`, so the server is already in it. Accepting a
     * `project_server` field on trust would let a caller label a room with a server it does not
     * belong to — and that label is what an operator reads when deciding whether to accept.
     */
    const { s } = store();
    const record = s.upsert(invite({ project_server: 'attacker-controlled.example' }));
    expect(record.projectServer).toBe('their-server.example');
  });

  test('is idempotent, because the invite poll runs on a timer', () => {
    // Reporting the same invitation every few seconds must not multiply it.
    const { s } = store();
    s.upsert(invite());
    s.upsert(invite());
    s.upsert(invite());
    expect(s.list()).toHaveLength(1);
    expect(s.pendingCount()).toBe(1);
  });

  test('one room can hold invitations for several agents, each with its own inviter', () => {
    /*
     * Keyed on (room, agent) for the reason ownership is (ADR-002): a project room can hold
     * several of the contributor's agents, each invited separately and each owned by whoever
     * invited THAT one. A room-only key would let the second invitation overwrite the first's
     * inviter, which is the ownership confusion ADR-002 exists to prevent.
     */
    const { s } = store();
    s.upsert(invite({ agent: 'lend-opus-01', inviter: '@alice:their-server.example' }));
    s.upsert(invite({ agent: 'lend-sonnet-02', inviter: '@bob:their-server.example' }));
    const byAgent = Object.fromEntries(s.list().map((r) => [r.agent, r.inviter]));
    expect(byAgent).toEqual({
      'lend-opus-01': '@alice:their-server.example',
      'lend-sonnet-02': '@bob:their-server.example',
    });
  });

  test('an unreadable inviter is kept as NULL, never filled in', () => {
    /*
     * The inviter IS the owner under ADR-002. An invitation whose sender the bridge could not
     * read must present as "no inviter known" so it can be refused on that basis; substituting a
     * plausible value would forge ownership.
     */
    const { s } = store();
    expect(s.upsert(invite({ inviter: null })).inviter).toBeNull();
    expect(s.upsert(invite({ agent: 'a2', inviter: '   ' })).inviter).toBeNull();
  });

  test('a malformed room id, agent or inviter is refused', () => {
    const { s } = store();
    expect(() => s.upsert(invite({ project_room_id: 'their-server.example' })))
      .toThrow(/Matrix room id/);
    expect(() => s.upsert(invite({ agent: 'has spaces' }))).toThrow(/simple name/);
    // A localpart is not an MXID, and an owner comparison against one would never match.
    expect(() => s.upsert(invite({ inviter: 'admin' }))).toThrow(/full Matrix MXID/);
  });
});

describe('the contributor\'s answer', () => {
  test('accepting and declining are both recorded with who decided', () => {
    const { s } = store();
    s.upsert(invite());
    const accepted = s.settle(ROOM, 'lend-opus-01', 'accepted', '@me:hq.example');
    expect(accepted).toMatchObject({ state: 'accepted', decidedBy: '@me:hq.example' });
    expect(accepted.decidedAt).toBe(1_000);

    s.upsert(invite({ project_room_id: OTHER }));
    expect(s.settle(OTHER, 'lend-opus-01', 'declined').state).toBe('declined');
  });

  test('a settled invitation does NOT reopen when the poll reports it again', () => {
    /*
     * The property that makes "no" possible. The invitation is still in Matrix state after a
     * decline, so the bridge will see it on the next round; if re-reporting reset it to pending,
     * the contributor would be asked forever and could never actually refuse.
     */
    const { s } = store();
    s.upsert(invite());
    s.settle(ROOM, 'lend-opus-01', 'declined');
    s.upsert(invite());
    expect(s.get(ROOM, 'lend-opus-01').state).toBe('declined');
    expect(s.list()).toEqual([]);
  });

  test('deciding twice is a conflict, not a silent overwrite', () => {
    // An accepted invitation that could be re-declined would revoke access without saying so.
    const { s } = store();
    s.upsert(invite());
    s.settle(ROOM, 'lend-opus-01', 'accepted');
    expect(() => s.settle(ROOM, 'lend-opus-01', 'declined')).toThrow(/already accepted/);
  });

  test('deciding an invitation that does not exist is a 404, not a new record', () => {
    const { s } = store();
    expect(() => s.settle(ROOM, 'lend-opus-01', 'accepted')).toThrow(PendingInviteError);
    expect(s.list({ state: 'all' })).toEqual([]);
  });

  test('only accepted or declined are decisions', () => {
    const { s } = store();
    s.upsert(invite());
    expect(() => s.settle(ROOM, 'lend-opus-01', 'maybe')).toThrow(/accepted or declined/);
  });
});

describe('what the operator is shown', () => {
  test('the list is pending-only by default, newest first', () => {
    /*
     * The operator's question is "what needs me". Mixing settled history into that list is how a
     * surface stops being actionable.
     */
    const { s } = store();
    s.upsert(invite({ agent: 'old', seen_at: 100 }));
    s.upsert(invite({ agent: 'new', seen_at: 900 }));
    s.upsert(invite({ agent: 'gone', seen_at: 500 }));
    s.settle(ROOM, 'gone', 'declined');

    expect(s.list().map((r) => r.agent)).toEqual(['new', 'old']);
    expect(s.list({ state: 'all' }).map((r) => r.agent).sort()).toEqual(['gone', 'new', 'old']);
  });

  test('a PENDING invitation is never pruned, however much history accumulates', () => {
    /*
     * The cap exists to bound settled history. Applying it to pending records would silently drop
     * a decision the contributor has not made — the one thing this store exists to hold.
     */
    const { s } = store();
    s.upsert(invite({ agent: 'waiting' }));
    for (let i = 0; i < 400; i += 1) {
      s.upsert(invite({ agent: `settled${i}` }));
      s.settle(ROOM, `settled${i}`, 'declined');
    }
    expect(s.get(ROOM, 'waiting')?.state).toBe('pending');
    expect(s.pendingCount()).toBe(1);
    // And the settled history is bounded rather than unbounded.
    expect(s.list({ state: 'all' }).length).toBeLessThan(400);
  });

  test('every mutation persists, so a restart does not lose a decision', () => {
    const { s, writes } = store();
    s.upsert(invite());
    expect(writes).toHaveLength(1);
    s.settle(ROOM, 'lend-opus-01', 'accepted');
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes.at(-1).invites)).toHaveLength(1);
  });

  test('a store reloaded from persisted state keeps its records', () => {
    const { s, writes } = store();
    s.upsert(invite());
    s.settle(ROOM, 'lend-opus-01', 'declined');
    const reloaded = createPendingInviteStore({ load: () => writes.at(-1) });
    expect(reloaded.get(ROOM, 'lend-opus-01').state).toBe('declined');
  });
});
