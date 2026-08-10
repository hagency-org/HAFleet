/*
 * Engagements: what replaces dispatch.
 *
 * Nothing here schedules work. Which task an agent does is decided on the project
 * side; what the contributor decides is whether to be in a project at all and for
 * how much. So the record is a REQUEST and a VERDICT, never an assignment.
 *
 * THE ROUTING, and why each branch is the way it is:
 *
 *   whitelisted AND within the offer AND within the agent's ceiling → auto-join
 *   whitelisted BUT over either                                     → falls back to approval
 *   not whitelisted                                                 → awaits approval
 *
 * Falling back rather than rejecting is the rule that keeps the two halves
 * coherent. A whitelisted project asking for more than is left has not misbehaved —
 * it cannot see the contributor's ceiling — so refusing it would send the wrong
 * signal about the relationship. The owner decides.
 *
 * The whitelist keys on `projectRoomId`, never on a display name. Room ids are
 * already strictly validated upstream and a name-keyed list would be spoofable by
 * any project that renames itself after a trusted one; the name travels beside the
 * id for reading only.
 *
 * Removing a project from the whitelist affects FUTURE requests only. Terminating
 * live engagements on a trust change would make de-trusting a project silently kill
 * work in flight, so revocation is a separate, explicit act.
 *
 * Modelled on lib/approval-store.js: durable, audited, terminal states. Reused
 * because it is the right shape and already proven, not because engagements are
 * the same thing — approval-store is per-TOOL-CALL permission with a 5-minute TTL,
 * which is a genuinely different record.
 */

import { randomBytes } from 'crypto';

const ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;
const STATES = ['pending', 'active', 'ended'];
const ROUTES = ['autoJoin', 'notWhitelisted', 'overOffer', 'overCeiling'];
const AUDIT_LIMIT = 2000;
/*
 * How many ENDED engagements to keep. Pending and active are live state and are never
 * pruned however many there are.
 *
 * A soak found this unbounded: 48 request/approve/revoke cycles took
 * engagements.json from 3.4kB to 71.8kB, strictly linear at ~1.4kB a cycle with no
 * plateau — and the whole file is rewritten on every mutation, so the cost is paid by
 * every subsequent write, not just by the disk. The audit log has had a cap since it
 * was written; the engagement list never got one, and no test noticed because every
 * suite tears its own records down.
 *
 * Ending an engagement is separately recorded in the audit log, so pruning the record
 * does not erase the fact that it happened.
 */
const ENDED_LIMIT = 500;

export class EngagementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngagementError';
    this.code = code;
  }
}

function text(value, field, max = 256) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > max) throw new EngagementError('bad_request', `${field} must be 1..${max} characters`);
  return v;
}

function posInt(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new EngagementError('bad_request', `${field} must be a positive number`);
  /*
   * FLOOR FIRST, THEN VALIDATE. Validating `n` and flooring afterwards let 0.5 pass
   * as "positive" and be stored as 0 — and a 0 cap is falsy, so every later
   * `if (cap)` guard read it as "no cap set" and waved the request through. A
   * fractional budget cap silently became an unlimited one.
   *
   * MAX_SAFE_INTEGER is refused rather than truncated: beyond it, integer arithmetic
   * on token counts stops being exact, and a cap that cannot be compared reliably is
   * worse than an absent one.
   */
  const floored = Math.floor(n);
  if (floored <= 0 || floored > Number.MAX_SAFE_INTEGER) {
    throw new EngagementError('bad_request', `${field} must be a positive integer below 2^53`);
  }
  return floored;
}

/**
 * Decide how an inbound request routes.
 *
 * Pure, and separate from the store on purpose: the routing is the design's central
 * claim, so it must be testable without persistence, and the console must be able
 * to show the same verdict for a hypothetical request before anyone commits to it.
 *
 * The order of the checks is itself a decision. Whitelist first, because a project
 * that is not trusted needs the owner regardless of the amounts. Then the offer,
 * then the ceiling — offer before ceiling because the offer is the promise the
 * project could actually see, so "you asked for more than I advertised" is the more
 * informative reason when both are true.
 */
export function routeRequest({ request, whitelisted, offer, remainingTokens, activeForRole = 0 }) {
  if (!whitelisted) return { route: 'notWhitelisted', autoJoin: false };
  /*
   * NO OFFER MEANS NOT ON OFFER — it does not mean unlimited.
   *
   * Every cap below was guarded with `offer && …`, so a null offer skipped all of
   * them and a whitelisted project auto-joined a role the contributor had never
   * published, for any amount its ceiling allowed. `published: false` had the same
   * effect for two of the three checks. Auto-join is a promise the contributor made
   * by publishing terms; without terms there is no promise to honour.
   */
  if (!offer || !offer.published) return { route: 'overOffer', autoJoin: false };
  if (offer.budgetCapPerEngagement && request.requestedTokens > offer.budgetCapPerEngagement) {
    return { route: 'overOffer', autoJoin: false };
  }
  /*
   * AN UNSTATED RATE IS UNKNOWN, NOT ZERO.
   *
   * This was `offer.rateCap && request.ratePerDay && …`, so a project that simply
   * omitted the rate — `!request architect 100000`, which the command accepts — was
   * never measured against the cap and auto-joined with no daily commitment at all.
   * The contributor published a rate cap precisely to bound that.
   *
   * Refused rather than defaulted, for the same reason a null ceiling is refused
   * twenty lines below: auto-joining against an unknown limit is exactly where a
   * contributor loses track of what they lent. The request still queues for a
   * decision; it is not rejected, and stating a rate makes it auto-join as before.
   */
  if (offer.rateCap) {
    if (!request.ratePerDay) return { route: 'overOffer', autoJoin: false };
    if (request.ratePerDay > offer.rateCap) return { route: 'overOffer', autoJoin: false };
  }
  /*
   * `count` is how many of this role are on offer, and nothing enforced it. Ten
   * concurrent requests against `count: 1` all auto-joined, because each was checked
   * against the budget and never against how many were already running.
   */
  if (offer.count !== null && offer.count !== undefined && activeForRole >= offer.count) {
    return { route: 'overOffer', autoJoin: false };
  }
  /*
   * A null remaining is "no ceiling declared", which is not "unlimited". Auto-join
   * is refused so the owner sees it: joining automatically against an unknown
   * ceiling is exactly the case where a contributor loses track of what they lent.
   */
  if (remainingTokens === null || remainingTokens === undefined) {
    return { route: 'overCeiling', autoJoin: false };
  }
  if (request.requestedTokens > remainingTokens) return { route: 'overCeiling', autoJoin: false };
  return { route: 'autoJoin', autoJoin: true };
}

export function createEngagementStore({ load, persist, now = () => Date.now() } = {}) {
  const state = load?.() ?? {};
  const engagements = state.engagements ?? {};
  const whitelist = state.whitelist ?? {};
  const offers = state.offers ?? {};
  const audit = state.audit ?? [];

  function save() {
    if (!persist) return true;
    return persist({ engagements, whitelist, offers, audit });
  }

  /**
   * Drop the oldest ENDED engagements past the cap, returning an undo.
   *
   * Rollback-safe by construction, and deliberately so: `record()` originally trimmed
   * the audit with a bare shift, and its undo — a plain `pop()` — could not restore
   * what had been shifted off, so a failed write left the log shorter than the state
   * it claimed to have restored. Pruning here has the same hazard, so it hands back
   * exactly what it removed.
   *
   * Ordered by `endedAt` when present and by id otherwise: ids carry a base-36
   * timestamp, so they sort chronologically, and falling back to them keeps a record
   * written by an older version from being treated as the oldest thing in the store.
   */
  function pruneEnded() {
    const ended = Object.values(engagements).filter((e) => e.state === 'ended');
    if (ended.length <= ENDED_LIMIT) return () => {};
    ended.sort((a, b) => (Number(a.endedAt || 0) - Number(b.endedAt || 0))
      || String(a.id).localeCompare(String(b.id)));
    const removed = ended.slice(0, ended.length - ENDED_LIMIT);
    for (const e of removed) delete engagements[e.id];
    return () => { for (const e of removed) engagements[e.id] = e; };
  }

  /*
   * MUTATE, PERSIST, AND ROLL BACK IF THE WRITE FAILED.
   *
   * Every mutator used to change the in-memory maps, then throw when `save()`
   * returned false — leaving the change live. A disk error while adding a whitelist
   * entry returned an error to the caller AND made `isWhitelisted(room)` true, so a
   * project the operator was told had not been trusted could auto-join until the
   * process restarted. A failed verdict likewise consumed the agent's headroom.
   *
   * `undo` restores exactly what the caller captured before mutating, so the store
   * is left as the error report claims it is.
   */
  function commit(undo, what) {
    /*
     * A THROWN persist has to roll back as well as a falsy one.
     *
     * This used to be `if (save()) return; undo(); throw`, which handled the adapter
     * returning false and not the adapter throwing — and `persist` is supplied by the
     * caller, so throwing is entirely ordinary (ENOSPC, EACCES, a serialisation
     * error). On that path the in-memory change stayed live while the caller was told
     * the write had failed, which is the exact state this function exists to prevent.
     */
    let ok = false;
    try {
      ok = save();
    } catch (error) {
      undo();
      throw new EngagementError('persistence_failed', `failed to persist ${what}: ${error.message}`);
    }
    if (ok) return;
    undo();
    throw new EngagementError('persistence_failed', `failed to persist ${what}`);
  }

  function record(type, detail) {
    audit.push({ type, at: now(), ...detail });
    // Bounded, oldest first, so an audit log cannot grow without limit on a
    // long-lived deployment. The cap is generous enough that an incident review
    // still has history.
    /*
     * Trimmed entries are handed back so a rollback can restore them. Every undo
     * closure does `audit.pop()`, which removes the new entry but cannot bring back
     * the oldest one this shifted off — so at exactly AUDIT_LIMIT records, a failed
     * write left the audit one entry SHORTER than the file it was rolling back to.
     * A rollback that loses history is not a rollback.
     */
    const trimmed = [];
    while (audit.length > AUDIT_LIMIT) trimmed.push(audit.shift());
    return () => {
      audit.pop();
      for (let i = trimmed.length - 1; i >= 0; i -= 1) audit.unshift(trimmed[i]);
    };
  }

  const id = (prefix) => `${prefix}_${now().toString(36)}_${randomBytes(3).toString('hex')}`;

  return {
    // ── whitelist ──────────────────────────────────────────────────────
    /**
     * Add a project to the trust list.
     *
     * Audited on BOTH add and remove, for the same reason approval-store audits
     * every verdict: a trust change that leaves no record cannot be reviewed after
     * an incident, and adding is the direction that grants power.
     */
    addToWhitelist({ projectRoomId, displayName, addedBy }) {
      const room = text(projectRoomId, 'projectRoomId');
      if (!ROOM_ID_RE.test(room)) throw new EngagementError('bad_request', 'projectRoomId must be a Matrix room id');
      const by = addedBy ? text(addedBy, 'addedBy') : 'operator';
      if (addedBy && !MXID_RE.test(by)) throw new EngagementError('bad_request', 'addedBy must be an MXID');
      const previous = whitelist[room];
      const existed = Boolean(previous);
      whitelist[room] = {
        projectRoomId: room,
        // Display name is for reading only and is never matched on.
        displayName: typeof displayName === 'string' ? displayName.trim().slice(0, 256) || null : null,
        addedAt: whitelist[room]?.addedAt ?? now(),
        addedBy: by,
      };
      const unrecord = record(existed ? 'whitelist.updated' : 'whitelist.added', { projectRoomId: room, by });
      commit(() => {
        if (previous === undefined) delete whitelist[room];
        else whitelist[room] = previous;
        unrecord();
      }, 'whitelist');
      return whitelist[room];
    },

    /**
     * Remove a project. Future requests only.
     *
     * Live engagements are deliberately untouched: de-trusting a project must not
     * silently kill work in flight. The returned count of surviving engagements is
     * what a caller shows so the operator knows what is still running.
     */
    removeFromWhitelist({ projectRoomId, by }) {
      const room = text(projectRoomId, 'projectRoomId');
      const previous = whitelist[room];
      if (!previous) throw new EngagementError('not_found', 'project is not whitelisted');
      delete whitelist[room];
      const stillActive = Object.values(engagements)
        .filter((e) => e.projectRoomId === room && e.state === 'active')
        .map((e) => e.id);
      const unrecord = record('whitelist.removed', { projectRoomId: room, by: by ?? 'operator', stillActive: stillActive.length });
      commit(() => { whitelist[room] = previous; unrecord(); }, 'whitelist');
      return { projectRoomId: room, stillActive };
    },

    listWhitelist() {
      return Object.values(whitelist).sort((a, b) => b.addedAt - a.addedAt);
    },
    isWhitelisted(room) {
      return Boolean(whitelist[room]);
    },

    // ── offers ─────────────────────────────────────────────────────────
    setOffer({ role, count, budgetCapPerEngagement, rateCap, published, by }) {
      const key = text(role, 'role', 64);
      const next = {
        role: key,
        count: count === null || count === undefined ? null : posInt(count, 'count'),
        budgetCapPerEngagement: budgetCapPerEngagement === null || budgetCapPerEngagement === undefined
          ? null : posInt(budgetCapPerEngagement, 'budgetCapPerEngagement'),
        rateCap: rateCap === null || rateCap === undefined ? null : posInt(rateCap, 'rateCap'),
        published: published === true,
        updatedAt: now(),
        updatedBy: by ?? 'operator',
      };
      const previous = offers[key];
      offers[key] = next;
      const unrecord = record('offer.set', { role: key, published: next.published, by: next.updatedBy });
      commit(() => {
        if (previous === undefined) delete offers[key];
        else offers[key] = previous;
        unrecord();
      }, 'offer');
      return next;
    },
    listOffers() {
      return Object.values(offers);
    },
    getOffer(role) {
      return offers[role] ?? null;
    },

    // ── engagements ────────────────────────────────────────────────────
    /**
     * An inbound request, routed on arrival.
     *
     * `agent` and `remainingTokens` are supplied by the caller rather than looked
     * up here: which agent would serve a role depends on the capability model and
     * the seat arithmetic, both of which live outside this store. The important
     * consequence is that the record NAMES the agent before any decision, so an
     * approval form can say whose ceiling is about to be spent.
     */
    createRequest({ project, projectRoomId, role, requester, requestedTokens, ratePerDay, agent, offer, remainingTokens }) {
      const room = text(projectRoomId, 'projectRoomId');
      if (!ROOM_ID_RE.test(room)) throw new EngagementError('bad_request', 'projectRoomId must be a Matrix room id');
      const req = {
        id: id('en'),
        project: text(project, 'project'),
        projectRoomId: room,
        role: text(role, 'role', 64),
        requester: text(requester, 'requester'),
        requestedTokens: posInt(requestedTokens, 'requestedTokens'),
        ratePerDay: ratePerDay === null || ratePerDay === undefined ? null : posInt(ratePerDay, 'ratePerDay'),
        // Which agent would serve it. Null is legitimate: no configured agent may
        // qualify, and that is a state the queue has to show rather than hide.
        agent: agent ? text(agent, 'agent') : null,
        createdAt: now(),
      };
      const decision = routeRequest({
        request: req,
        whitelisted: Boolean(whitelist[room]),
        offer: offer ?? offers[req.role] ?? null,
        remainingTokens,
        // How many of this role are already running, so `count` can be enforced.
        activeForRole: Object.values(engagements)
          .filter((e) => e.role === req.role && e.state === 'active').length,
      });
      const engagement = {
        ...req,
        route: decision.route,
        autoJoined: decision.autoJoin,
        state: decision.autoJoin ? 'active' : 'pending',
        // An auto-join allocates exactly what was asked for; an approval allocates
        // whatever the owner decides, which is why it is null until then.
        allocatedTokens: decision.autoJoin ? req.requestedTokens : null,
        decidedAt: decision.autoJoin ? now() : null,
        decidedBy: decision.autoJoin ? 'auto' : null,
        endedAt: null,
        endedReason: null,
      };
      engagements[engagement.id] = engagement;
      const unrecord = record(decision.autoJoin ? 'engagement.auto_joined' : 'engagement.pending', {
        engagementId: engagement.id, project: engagement.project, role: engagement.role, route: decision.route,
      });
      commit(() => { delete engagements[engagement.id]; unrecord(); }, 'engagement');
      return engagement;
    },

    /**
     * Approve or reject, with the allocation checked at the point of decision.
     *
     * `remainingTokens` is passed in and enforced HERE rather than validated by the
     * caller, because "the form refuses an over-committing allocation" is only true
     * if the store refuses it too — otherwise any other client can write the
     * over-commitment the form prevented.
     */
    decide({ engagementId, approve, allocatedTokens, remainingTokens, by, reason }) {
      const e = engagements[text(engagementId, 'engagementId')];
      if (!e) throw new EngagementError('not_found', 'engagement not found');
      if (e.state !== 'pending') throw new EngagementError('conflict', `engagement is ${e.state}, not pending`);
      // Captured before any field is touched, so a failed write restores the record
      // exactly rather than approximately.
      const snapshot = { ...e };

      if (!approve) {
        e.state = 'ended';
        e.endedAt = now();
        e.endedReason = reason ? String(reason).slice(0, 256) : 'rejected';
        e.decidedAt = now();
        e.decidedBy = by ?? 'operator';
        const unrecord = record('engagement.rejected', { engagementId: e.id, by: e.decidedBy });
        // Rejection ends an engagement too, so it is the other place the cap can be
        // exceeded. Missing it would have made the bound depend on which way the
        // contributor decided.
        const unprune = pruneEnded();
        commit(() => { engagements[e.id] = snapshot; unprune(); unrecord(); }, 'verdict');
        return engagements[e.id];
      }

      const alloc = posInt(allocatedTokens ?? e.requestedTokens, 'allocatedTokens');
      if (remainingTokens === null || remainingTokens === undefined) {
        throw new EngagementError('no_ceiling', 'cannot allocate against an agent with no declared ceiling');
      }
      if (alloc > remainingTokens) {
        throw new EngagementError('over_commit', `allocating ${alloc} would exceed the ${remainingTokens} left on ${e.agent}`);
      }
      e.state = 'active';
      e.allocatedTokens = alloc;
      e.decidedAt = now();
      e.decidedBy = by ?? 'operator';
      const unrecord = record('engagement.approved', { engagementId: e.id, allocatedTokens: alloc, by: e.decidedBy });
      // Rolled back, or a failed approval keeps consuming the agent's headroom.
      commit(() => { engagements[e.id] = snapshot; unrecord(); }, 'verdict');
      return engagements[e.id];
    },

    /**
     * Record whether this engagement actually took effect.
     *
     * An approval that allocates budget but never binds the agent is bookkeeping:
     * the console said yes and nothing in the world changed. The outcome is stored
     * on the record so it is visible afterwards rather than inferred from the
     * absence of a binding somewhere else.
     */
    setBindingOutcome(engagementId, { bound, ownerMxid = null, error = null }) {
      const e = engagements[engagementId];
      if (!e) return null;
      const snapshot = { ...e };
      e.bound = bound === true;
      e.boundAt = bound ? now() : null;
      e.boundOwnerMxid = bound ? ownerMxid : null;
      // Kept when the bind failed, cleared when it succeeded: a stale reason beside
      // a working binding is worse than none.
      e.bindError = bound ? null : (error ? String(error).slice(0, 240) : null);
      const unrecord = record(bound ? 'engagement.bound' : 'engagement.bind_failed', {
        engagementId, ownerMxid, error: e.bindError,
      });
      commit(() => { engagements[engagementId] = snapshot; unrecord(); }, 'binding outcome');
      return e;
    },

    /** End an active engagement. Explicit, and separate from a trust change. */
    revoke({ engagementId, by, reason }) {
      const e = engagements[text(engagementId, 'engagementId')];
      if (!e) throw new EngagementError('not_found', 'engagement not found');
      if (e.state !== 'active') throw new EngagementError('conflict', `engagement is ${e.state}, not active`);
      const snap = { ...e };
      e.state = 'ended';
      e.endedAt = now();
      e.endedReason = reason ? String(reason).slice(0, 256) : 'revoked';
      const unrecord = record('engagement.revoked', { engagementId: e.id, by: by ?? 'operator' });
      // Pruned here rather than on a timer: this is the transition that creates an
      // ended record, so it is the moment the cap can be exceeded, and doing it
      // inside the same commit means one write instead of two.
      const unprune = pruneEnded();
      commit(() => { engagements[e.id] = snap; unprune(); unrecord(); }, 'revocation');
      return engagements[e.id];
    },

    list({ state } = {}) {
      const all = Object.values(engagements).sort((a, b) => b.createdAt - a.createdAt);
      return state ? all.filter((e) => e.state === state) : all;
    },
    get(engagementId) {
      return engagements[engagementId] ?? null;
    },
    /** Committed against ONE agent's ceiling: active engagements only. */
    committedFor(agentName) {
      return Object.values(engagements)
        .filter((e) => e.agent === agentName && e.state === 'active')
        .reduce((n, e) => n + (e.allocatedTokens ?? 0), 0);
    },
    listAudit({ limit = 200 } = {}) {
      return audit.slice(-Math.max(1, Math.min(limit, AUDIT_LIMIT))).reverse();
    },
  };
}

export { STATES as ENGAGEMENT_STATES, ROUTES as ENGAGEMENT_ROUTES, ROOM_ID_RE };
