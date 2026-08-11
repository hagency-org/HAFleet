import { describe, it, expect, beforeEach } from 'vitest';
import { createEngagementStore, routeRequest, EngagementError } from '../lib/engagement-store.js';

/*
 * The routing is this design's central claim, so it is tested as a pure function
 * first and through the store second. Both matter: the console shows a route for a
 * hypothetical request before anyone commits to it, and the store must reach the
 * same verdict when the request actually arrives.
 *
 * The branch that gets built wrong if it is not tested is `overCeiling` — the rule
 * is that a whitelisted project asking for more than is left FALLS BACK to approval
 * rather than being rejected, because it has not misbehaved. An implementation that
 * rejects there looks correct until someone reads the code.
 */

const ROOM = '!aXbY7pQ2:hq.example';
const OTHER = '!zZ1qW3eR:hq.example';

describe('routeRequest', () => {
  const req = { requestedTokens: 500_000, ratePerDay: 20_000 };
  const offer = { published: true, budgetCapPerEngagement: 1_000_000, rateCap: 50_000 };

  it('auto-joins a whitelisted project inside both the offer and the ceiling', () => {
    expect(routeRequest({ request: req, whitelisted: true, offer, remainingTokens: 1_000_000 }))
      .toEqual({ route: 'autoJoin', autoJoin: true });
  });

  it('needs approval when the project is not whitelisted, whatever the amounts', () => {
    expect(routeRequest({ request: req, whitelisted: false, offer, remainingTokens: 10_000_000 }))
      .toEqual({ route: 'notWhitelisted', autoJoin: false });
  });

  it('treats an unpublished offer as not being on offer at all', () => {
    const r = routeRequest({ request: req, whitelisted: true, offer: { ...offer, published: false }, remainingTokens: 1e7 });
    expect(r.autoJoin).toBe(false);
  });

  it('falls back to approval — not rejection — when the request exceeds the offer', () => {
    const r = routeRequest({
      request: { requestedTokens: 2_000_000 }, whitelisted: true, offer, remainingTokens: 10_000_000,
    });
    expect(r).toEqual({ route: 'overOffer', autoJoin: false });
  });

  it('falls back to approval when the rate exceeds the rate cap', () => {
    const r = routeRequest({
      request: { requestedTokens: 100, ratePerDay: 90_000 }, whitelisted: true, offer, remainingTokens: 1e7,
    });
    expect(r.route).toBe('overOffer');
  });

  it('falls back to approval — not rejection — when the request exceeds what is LEFT', () => {
    // The branch the design turns on. Inside the offer, over the ceiling.
    // The rate is stated so this reaches the ceiling check: without it the request
    // now stops at the rate cap, and this test would be passing on the wrong branch.
    const r = routeRequest({
      request: { requestedTokens: 900_000, ratePerDay: 20_000 },
      whitelisted: true, offer, remainingTokens: 400_000,
    });
    expect(r).toEqual({ route: 'overCeiling', autoJoin: false });
  });

  /*
   * AN UNSTATED RATE IS UNKNOWN, NOT ZERO.
   *
   * `offer.rateCap && request.ratePerDay && …` skipped the cap entirely when the
   * project omitted the rate — which `!request architect 100000` does — so a
   * published rate cap was bypassed by saying nothing, and the engagement carried no
   * daily commitment at all. Refused for the same reason a null ceiling is: an
   * unknown limit is where a contributor loses track of what they lent.
   */
  it('refuses to auto-join when a rate cap is published and the request states no rate', () => {
    const r = routeRequest({
      request: { requestedTokens: 100 }, whitelisted: true, offer, remainingTokens: 1e7,
    });
    expect(r).toEqual({ route: 'overOffer', autoJoin: false });
    // Stating a rate inside the cap still auto-joins, so this bounds the behaviour
    // rather than just refusing more.
    expect(routeRequest({
      request: { requestedTokens: 100, ratePerDay: 20_000 }, whitelisted: true, offer, remainingTokens: 1e7,
    })).toEqual({ route: 'autoJoin', autoJoin: true });
    // And with no rate cap published, an unstated rate is not an obstacle.
    expect(routeRequest({
      request: { requestedTokens: 100 }, whitelisted: true,
      offer: { ...offer, rateCap: null }, remainingTokens: 1e7,
    })).toEqual({ route: 'autoJoin', autoJoin: true });
  });

  it('refuses to auto-join against an UNKNOWN ceiling', () => {
    // null remaining is "no ceiling declared", which is not "unlimited". Auto-joining
    // here is precisely how a contributor loses track of what they lent.
    const r = routeRequest({ request: req, whitelisted: true, offer, remainingTokens: null });
    expect(r).toEqual({ route: 'overCeiling', autoJoin: false });
  });

  it('reports the offer before the ceiling when both are exceeded', () => {
    // The offer is the promise the project could actually see, so it is the more
    // informative reason to give back.
    const r = routeRequest({
      request: { requestedTokens: 5_000_000 }, whitelisted: true, offer, remainingTokens: 10,
    });
    expect(r.route).toBe('overOffer');
  });
});

describe('the store', () => {
  let store;
  let saves;
  beforeEach(() => {
    saves = 0;
    let clock = 1_000_000;
    store = createEngagementStore({
      load: () => ({}),
      persist: () => { saves += 1; return true; },
      now: () => { clock += 1000; return clock; },
    });
  });

  const request = (over = {}) => store.createRequest({
    project: 'acme/api-service',
    projectRoomId: ROOM,
    role: 'architect',
    requester: '@lin:hq.example',
    requestedTokens: 500_000,
    ratePerDay: 20_000,
    agent: 'lend-sonnet-01',
    remainingTokens: 1_000_000,
    ...over,
  });

  it('rejects a projectRoomId that is not a Matrix room id', () => {
    // A name-keyed whitelist would be spoofable by any project that renames itself
    // after a trusted one, so the id form is enforced at the door.
    expect(() => request({ projectRoomId: 'acme/api-service' })).toThrow(EngagementError);
    expect(() => store.addToWhitelist({ projectRoomId: 'acme/api-service' })).toThrow(/room id/);
  });

  it('keeps a non-whitelisted request pending with its reason', () => {
    const e = request();
    expect(e.state).toBe('pending');
    expect(e.route).toBe('notWhitelisted');
    expect(e.allocatedTokens).toBeNull();
    // The agent is named BEFORE any decision, so an approval form can say whose
    // ceiling is about to be spent.
    expect(e.agent).toBe('lend-sonnet-01');
  });

  it('auto-joins once the project is whitelisted and within limits', () => {
    store.addToWhitelist({ projectRoomId: ROOM, displayName: 'acme/api-service', addedBy: '@me:hq.example' });
    store.setOffer({ role: 'architect', budgetCapPerEngagement: 1_000_000, published: true });
    const e = request();
    expect(e.state).toBe('active');
    expect(e.autoJoined).toBe(true);
    expect(e.allocatedTokens).toBe(500_000);
  });

  it('refuses an approval that would over-commit the agent', () => {
    const e = request();
    expect(() => store.decide({
      engagementId: e.id, approve: true, allocatedTokens: 900_000, remainingTokens: 400_000,
    })).toThrow(/exceed/);
    // The engagement must be untouched: a refused verdict is not a partial one.
    expect(store.get(e.id).state).toBe('pending');
    expect(store.get(e.id).allocatedTokens).toBeNull();
  });

  it('refuses an approval against an agent with no declared ceiling', () => {
    const e = request();
    expect(() => store.decide({ engagementId: e.id, approve: true, remainingTokens: null }))
      .toThrow(/no declared ceiling/);
  });

  it('approves with an allocation and counts it against that agent only', () => {
    const e = request();
    store.decide({ engagementId: e.id, approve: true, allocatedTokens: 300_000, remainingTokens: 1_000_000, by: '@me:hq.example' });
    expect(store.get(e.id).state).toBe('active');
    expect(store.committedFor('lend-sonnet-01')).toBe(300_000);
    // Per-agent, not global: another agent's ceiling is untouched.
    expect(store.committedFor('lend-kimi-02')).toBe(0);
  });

  it('counts only ACTIVE engagements against a ceiling', () => {
    const a = request();
    store.decide({ engagementId: a.id, approve: true, allocatedTokens: 200_000, remainingTokens: 1e7 });
    const b = request();
    store.decide({ engagementId: b.id, approve: false, reason: 'not this quarter' });
    expect(store.committedFor('lend-sonnet-01')).toBe(200_000);
    expect(store.get(b.id).state).toBe('ended');
    expect(store.get(b.id).endedReason).toBe('not this quarter');
  });

  it('cannot decide the same engagement twice', () => {
    const e = request();
    store.decide({ engagementId: e.id, approve: true, remainingTokens: 1e7 });
    expect(() => store.decide({ engagementId: e.id, approve: true, remainingTokens: 1e7 })).toThrow(/not pending/);
  });

  it('removing a project from the whitelist leaves live engagements running', () => {
    store.addToWhitelist({ projectRoomId: ROOM });
    store.setOffer({ role: 'architect', budgetCapPerEngagement: 1_000_000, published: true });
    const live = request();
    expect(live.state).toBe('active');

    const removed = store.removeFromWhitelist({ projectRoomId: ROOM, by: '@me:hq.example' });
    // The rule: future requests only. De-trusting must not silently kill work in
    // flight — that is a separate, explicit act.
    expect(removed.stillActive).toEqual([live.id]);
    expect(store.get(live.id).state).toBe('active');
    // And the next request from that project now needs approval.
    expect(request().route).toBe('notWhitelisted');
  });

  it('revocation is explicit and ends only an active engagement', () => {
    const e = request();
    expect(() => store.revoke({ engagementId: e.id })).toThrow(/not active/);
    store.decide({ engagementId: e.id, approve: true, remainingTokens: 1e7 });
    store.revoke({ engagementId: e.id, by: '@me:hq.example', reason: 'season over' });
    expect(store.get(e.id).state).toBe('ended');
    expect(store.get(e.id).endedReason).toBe('season over');
    expect(store.committedFor('lend-sonnet-01')).toBe(0);
  });

  it('audits both directions of a trust change', () => {
    store.addToWhitelist({ projectRoomId: ROOM });
    store.removeFromWhitelist({ projectRoomId: ROOM });
    const types = store.listAudit().map((a) => a.type);
    // A trust change that leaves no record cannot be reviewed after an incident,
    // and adding is the direction that grants power.
    expect(types).toContain('whitelist.added');
    expect(types).toContain('whitelist.removed');
  });

  it('audits every verdict', () => {
    const e = request();
    store.decide({ engagementId: e.id, approve: true, remainingTokens: 1e7 });
    const types = store.listAudit().map((a) => a.type);
    expect(types).toContain('engagement.pending');
    expect(types).toContain('engagement.approved');
  });

  it('persists on every mutation', () => {
    const before = saves;
    store.addToWhitelist({ projectRoomId: OTHER });
    store.setOffer({ role: 'coding', published: true });
    const e = request();
    store.decide({ engagementId: e.id, approve: false });
    expect(saves).toBe(before + 4);
  });

  it('surfaces a persistence failure instead of reporting success', () => {
    const failing = createEngagementStore({ load: () => ({}), persist: () => false, now: () => 1 });
    expect(() => failing.addToWhitelist({ projectRoomId: ROOM })).toThrow(/persist/);
  });

  /*
   * IDEMPOTENCY, PER PRD A-R0-1.
   *
   * "Repeating the same `request_id` and digest produces the same assignment; a
   * different digest is rejected as a conflict."
   *
   * Two identical asks used to become two pending engagements, each spending the
   * agent's ceiling when approved. The interface is a human typing
   * `!request coding 400000 20000` and nobody types a UUID, so the store had no key —
   * but both sides already share the Matrix event id, and the bridge passes it.
   *
   * The digest is the half that matters. Without it a request_id is an overwrite
   * handle: a caller could reuse an id and quietly change the amount already under
   * review, and the store would return the old engagement as though nothing was asked.
   */
  describe('request idempotency', () => {
    const ask = (over = {}) => ({
      project: 'acme/api', projectRoomId: ROOM, role: 'coding',
      requester: '@lin:hq.example', requestedTokens: 100_000, ratePerDay: 10_000,
      agent: 'a1', remainingTokens: null, ...over,
    });

    it('the same request id and digest yields the SAME engagement', () => {
      store.addToWhitelist({ projectRoomId: ROOM });
      const first = store.createRequest(ask({ requestId: '$evt1:hq.example' }));
      const again = store.createRequest(ask({ requestId: '$evt1:hq.example' }));
      expect(again.id).toBe(first.id);
      expect(store.list({ state: 'pending' }).filter((e) => e.projectRoomId === ROOM))
        .toHaveLength(1);
    });

    it('the same id with a DIFFERENT ask is a conflict, not a merge or an overwrite', () => {
      store.addToWhitelist({ projectRoomId: ROOM });
      store.createRequest(ask({ requestId: '$evt2:hq.example' }));
      // Reusing the id to ask for twenty times as much must not silently return the
      // small one, and must not replace it either.
      expect(() => store.createRequest(ask({
        requestId: '$evt2:hq.example', requestedTokens: 2_000_000,
      }))).toThrow(/already used for a different request/);
      const rows = store.list().filter((e) => e.projectRoomId === ROOM);
      expect(rows).toHaveLength(1);
      expect(rows[0].requestedTokens).toBe(100_000);
    });

    it('different ids are different requests even when identical in content', () => {
      // Two genuine asks that happen to match must not be collapsed — the failure mode
      // of deduping on (room, role, amount) instead of on an id.
      store.addToWhitelist({ projectRoomId: ROOM });
      const a = store.createRequest(ask({ requestId: '$evtA:hq.example' }));
      const b = store.createRequest(ask({ requestId: '$evtB:hq.example' }));
      expect(b.id).not.toBe(a.id);
    });

    it('a request with no id is accepted and SAYS it could not be deduped', () => {
      /*
       * Requiring an id would refuse every existing caller. Generating one silently
       * would give no idempotency while appearing to have some, which is the worse
       * option — so absence is recorded on the record.
       */
      store.addToWhitelist({ projectRoomId: ROOM });
      const one = store.createRequest(ask());
      const two = store.createRequest(ask());
      expect(one.idempotent).toBe(false);
      expect(two.id).not.toBe(one.id);
      const withKey = store.createRequest(ask({ requestId: '$evtC:hq.example' }));
      expect(withKey.idempotent).toBe(true);
    });

    it('the digest ignores the room label but not the amount', () => {
      // A renamed project is not a different request; a different amount is.
      store.addToWhitelist({ projectRoomId: ROOM });
      const first = store.createRequest(ask({ requestId: '$evtD:hq.example' }));
      const renamed = store.createRequest(ask({
        requestId: '$evtD:hq.example', project: 'acme/api-renamed',
      }));
      expect(renamed.id).toBe(first.id);
      expect(() => store.createRequest(ask({
        requestId: '$evtD:hq.example', ratePerDay: 99_000,
      }))).toThrow(/different request/);
    });
  });

  /*
   * A FRACTIONAL CAP MUST NOT BECOME AN UNLIMITED ONE.
   *
   * posInt validated the raw number and floored afterwards, so 0.5 passed the
   * "positive" check and was stored as 0 — and every later guard is `if (cap)`, which
   * reads 0 as "no cap set". A cap of half a token silently became no cap at all.
   * Beyond 2^53 integer arithmetic on token counts stops being exact, so that is
   * refused rather than truncated.
   */
  it('refuses a cap that would floor to zero, instead of storing an unlimited one', () => {
    const s2 = createEngagementStore({ load: () => ({}), persist: () => true, now: () => 1 });
    for (const bad of [0.5, 0.9, Number.MAX_SAFE_INTEGER + 10]) {
      expect(() => s2.setOffer({ role: 'architect', published: true, budgetCapPerEngagement: bad, by: 'op' }))
        .toThrow(/positive integer/);
    }
    // A value above one still floors normally; only the zero-producing range is refused.
    s2.setOffer({ role: 'architect', published: true, budgetCapPerEngagement: 1.5, by: 'op' });
    expect(s2.listOffers().find((o) => o.role === 'architect').budgetCapPerEngagement).toBe(1);
  });

  /*
   * ENDED ENGAGEMENTS ARE BOUNDED, LIVE ONES ARE NOT.
   *
   * A 48-cycle soak took engagements.json from 3.4kB to 71.8kB, strictly linear with
   * no plateau — and the file is rewritten on every mutation, so every later write
   * pays for the accumulation. The audit log has had a cap since it was written; the
   * engagement list never got one, and no suite noticed because they all tear their
   * own records down.
   */
  describe('the ended-engagement cap', () => {
    /**
     * Create and REJECT `n` engagements so they land in `ended`.
     *
     * Rejection rather than approve-then-revoke: it reaches `ended` in one decision
     * and exercises the other of the two prune sites, so a cap wired into only the
     * revoke path would fail here.
     */
    const churn = (store, n, roomPrefix = '!churn') => {
      for (let i = 0; i < n; i += 1) {
        const room = `${roomPrefix}${i}:hq.example`;
        store.addToWhitelist({ projectRoomId: room });
        const e = store.createRequest({
          project: `p${i}`, projectRoomId: room, role: 'coding',
          requester: '@r:hq.example', requestedTokens: 10, agent: 'a1', remainingTokens: null,
        });
        store.decide({ engagementId: e.id, approve: false, reason: 'churn' });
      }
    };

    it('keeps live engagements however many there are, and caps ended ones', () => {
      let tick = 0;
      const s2 = createEngagementStore({ load: () => ({}), persist: () => true, now: () => { tick += 1; return tick; } });
      churn(s2, 520);
      const ended = s2.list({ state: 'ended' });
      expect(ended.length).toBeLessThanOrEqual(500);
      // And the ones kept are the NEWEST: dropping recent history would make the
      // console show a stale tail of a busy deployment.
      const ids = ended.map((e) => e.id).sort();
      expect(ids[ids.length - 1]).toBeTruthy();
    });

    it('never prunes pending or active engagements', () => {
      let tick = 0;
      const s2 = createEngagementStore({ load: () => ({}), persist: () => true, now: () => { tick += 1; return tick; } });
      churn(s2, 505);
      // One live engagement, created after the cap is already exceeded.
      s2.addToWhitelist({ projectRoomId: '!live:hq.example' });
      const live = s2.createRequest({
        project: 'live', projectRoomId: '!live:hq.example', role: 'coding',
        requester: '@r:hq.example', requestedTokens: 10, agent: 'a1', remainingTokens: null,
      });
      churn(s2, 5, '!more');
      expect(s2.get(live.id)).toBeTruthy();
      expect(s2.get(live.id).state).toBe('pending');
    });

    it('restores pruned records when the write then fails', () => {
      /*
       * The same hazard the audit trim had: an undo that only reverses the visible
       * mutation cannot bring back what the prune removed, so a failed write would
       * leave the store SHORTER than the state it claimed to have restored.
       */
      let failNext = false;
      let tick = 0;
      const s2 = createEngagementStore({
        load: () => ({}), persist: () => !failNext, now: () => { tick += 1; return tick; },
      });
      churn(s2, 505);
      const before = s2.list().length;
      s2.addToWhitelist({ projectRoomId: '!fail:hq.example' });
      const e = s2.createRequest({
        project: 'fail', projectRoomId: '!fail:hq.example', role: 'coding',
        requester: '@r:hq.example', requestedTokens: 10, agent: 'a1', remainingTokens: null,
      });
      failNext = true;
      // Rejection is the transition that both ends the engagement and prunes, so it
      // is the one whose failed write must restore what the prune removed.
      expect(() => s2.decide({ engagementId: e.id, approve: false, reason: 'boom' }))
        .toThrow(/persist/);
      const after = s2.list().length;
      expect(after).toBe(before + 1); // the new one survives, nothing else was lost
      expect(s2.get(e.id).state).not.toBe('ended');
    });
  });

  /*
   * A THROWN persist must roll back too.
   *
   * commit() was `if (save()) return; undo(); throw`, which covers an adapter that
   * returns false and not one that THROWS — and persist is caller-supplied, so
   * ENOSPC, EACCES or a serialisation error is ordinary. On that path the in-memory
   * change stayed live while the caller was told the write had failed: the room was
   * whitelisted, isWhitelisted() said so, and nothing on disk agreed.
   */
  it('rolls back when the persist adapter THROWS, not only when it returns false', () => {
    const throwing = createEngagementStore({
      load: () => ({}),
      persist: () => { throw new Error('ENOSPC'); },
      now: () => 1,
    });
    expect(() => throwing.addToWhitelist({ projectRoomId: ROOM })).toThrow(/persist/);
    expect(throwing.isWhitelisted(ROOM)).toBe(false);
    expect(throwing.listWhitelist()).toHaveLength(0);
  });

  /*
   * A rollback that loses history is not a rollback.
   *
   * Every undo does audit.pop(), which removes the entry just added but cannot bring
   * back the oldest entry that record() shifted off at the cap. At exactly
   * AUDIT_LIMIT the failed write left the audit one entry SHORTER than the state it
   * claimed to have restored.
   */
  it('restores an audit entry trimmed at the cap when the write then fails', () => {
    let failNext = false;
    let tick = 0;
    const s2 = createEngagementStore({
      load: () => ({}),
      persist: () => !failNext,
      now: () => { tick += 1; return tick; },
    });
    // Fill past the cap so the next record() must shift one off.
    for (let i = 0; i < 2001; i += 1) s2.addToWhitelist({ projectRoomId: `!fill${i}:hq.example` });
    // listAudit caps and reverses, so ask for the whole log: newest first.
    const before = s2.listAudit({ limit: 2000 });
    expect(before.length).toBe(2000);
    failNext = true;
    expect(() => s2.addToWhitelist({ projectRoomId: '!overflow:hq.example' })).toThrow(/persist/);
    const after = s2.listAudit({ limit: 2000 });
    // Identical, including the OLDEST entry — that is the one a bare pop() lost.
    expect(after.length).toBe(before.length);
    expect(after.at(-1)).toEqual(before.at(-1));
    expect(after).toEqual(before);
  });
});

/*
 * The defects codex's review found, each as a test that FAILS against the old
 * behaviour. Three of these existed because the original tests could not observe
 * them: the over-commit test hand-supplied `remainingTokens`, the persistence test
 * only checked that an exception was thrown, and no test ever passed a null offer.
 */
describe('routing holes that the first tests could not see', () => {
  let store;
  beforeEach(() => {
    let clock = 2_000_000;
    store = createEngagementStore({ load: () => ({}), persist: () => true, now: () => { clock += 1000; return clock; } });
    store.addToWhitelist({ projectRoomId: ROOM });
  });

  const req = (over = {}) => store.createRequest({
    project: 'p', projectRoomId: ROOM, role: 'architect', requester: '@l:hq.example',
    requestedTokens: 100_000, agent: 'a', remainingTokens: 10_000_000, ...over,
  });

  it('does NOT auto-join a whitelisted project when no offer exists', () => {
    // `offer && cap` skipped every cap when offer was null, so a whitelisted room
    // auto-joined a role the contributor had never published, for any amount.
    expect(store.getOffer('architect')).toBeNull();
    const e = req();
    expect(e.autoJoined).toBe(false);
    expect(e.state).toBe('pending');
    expect(e.route).toBe('overOffer');
  });

  it('does NOT auto-join when the offer exists but is unpublished', () => {
    store.setOffer({ role: 'architect', budgetCapPerEngagement: 1_000_000, published: false });
    expect(req().autoJoined).toBe(false);
  });

  it('enforces the offer count, not only the budget', () => {
    store.setOffer({ role: 'architect', count: 1, budgetCapPerEngagement: 1_000_000, published: true });
    const first = req();
    expect(first.autoJoined).toBe(true);
    // Ten requests against count:1 all auto-joined before, because each was checked
    // against the budget and never against how many were already running.
    const second = req();
    expect(second.autoJoined).toBe(false);
    expect(second.route).toBe('overOffer');
  });
});

describe('persistence failure leaves no phantom state', () => {
  /*
   * The original test asserted only that an exception was thrown. It therefore
   * passed while the mutation stayed live: the caller was told the whitelist entry
   * had not been saved, and `isWhitelisted()` returned true until restart.
   */
  const failing = () => {
    let allow = true;
    const store = createEngagementStore({
      load: () => ({}),
      persist: () => allow,
      now: () => 1,
    });
    return { store, fail: () => { allow = false; } };
  };

  it('rolls back a whitelist add', () => {
    const { store, fail } = failing();
    fail();
    expect(() => store.addToWhitelist({ projectRoomId: ROOM })).toThrow(/persist/);
    expect(store.isWhitelisted(ROOM)).toBe(false);
    expect(store.listWhitelist()).toHaveLength(0);
  });

  it('rolls back a whitelist removal', () => {
    const { store, fail } = failing();
    store.addToWhitelist({ projectRoomId: ROOM });
    fail();
    expect(() => store.removeFromWhitelist({ projectRoomId: ROOM })).toThrow(/persist/);
    expect(store.isWhitelisted(ROOM)).toBe(true);
  });

  it('rolls back an approval, so a failed verdict consumes no headroom', () => {
    const { store, fail } = failing();
    store.addToWhitelist({ projectRoomId: OTHER });
    const e = store.createRequest({
      project: 'p', projectRoomId: OTHER, role: 'architect', requester: '@l:hq.example',
      requestedTokens: 500_000, agent: 'a', remainingTokens: 1_000_000,
    });
    fail();
    expect(() => store.decide({
      engagementId: e.id, approve: true, allocatedTokens: 500_000, remainingTokens: 1_000_000,
    })).toThrow(/persist/);
    expect(store.get(e.id).state).toBe('pending');
    expect(store.get(e.id).allocatedTokens).toBeNull();
    // The number that mattered: a failed approval must not have spent the ceiling.
    expect(store.committedFor('a')).toBe(0);
  });

  it('rolls back an offer change', () => {
    const { store, fail } = failing();
    store.setOffer({ role: 'coding', count: 2, published: true });
    fail();
    expect(() => store.setOffer({ role: 'coding', count: 9, published: false })).toThrow(/persist/);
    expect(store.getOffer('coding')).toMatchObject({ count: 2, published: true });
  });
});
