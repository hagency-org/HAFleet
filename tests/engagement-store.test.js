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
    const r = routeRequest({
      request: { requestedTokens: 900_000 }, whitelisted: true, offer, remainingTokens: 400_000,
    });
    expect(r).toEqual({ route: 'overCeiling', autoJoin: false });
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
