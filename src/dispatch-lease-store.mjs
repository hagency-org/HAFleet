import { randomUUID } from 'node:crypto';

// Owner-bound, renewable leases over the matrix-Agent dispatch reservation (backend-v2.js
// POST /api/dispatch, /api/dispatch/renew, /api/dispatch/release — Task 7). Replaces the old
// bare `dispatchBusy` Set<agentName>: a lease additionally carries who claimed the agent
// (`owner`) and for how long (`expiresAt`), so a crashed/stuck caller can no longer pin an
// agent forever — the lease's TTL lapses and reapExpired() frees it.
//
// In-memory / process-local only, same as the dispatch queue it sits beside — a restart drops
// in-flight leases. That is a known limitation (see backend-v2.js's Task 7 notes above the
// dispatch routes), not something this module claims to fix.

export class LeaseValidationError extends Error {
  constructor(message = 'leaseId, agent, and owner are required') {
    super(message);
    this.name = 'LeaseValidationError';
    this.reason = 'missing_fields';
  }
}

export class LeaseNotFoundError extends Error {
  constructor(message = 'lease not found') {
    super(message);
    this.name = 'LeaseNotFoundError';
    this.reason = 'lease_not_found';
  }
}

export class LeaseOwnerMismatchError extends Error {
  constructor(message = 'lease owner mismatch') {
    super(message);
    this.name = 'LeaseOwnerMismatchError';
    this.reason = 'owner_mismatch';
  }
}

export class LeaseExpiredError extends Error {
  constructor(message = 'lease expired') {
    super(message);
    this.name = 'LeaseExpiredError';
    this.reason = 'lease_expired';
  }
}

export class AgentAlreadyLeasedError extends Error {
  constructor(message = 'agent already leased') {
    super(message);
    this.name = 'AgentAlreadyLeasedError';
    this.reason = 'agent_busy';
  }
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// The public lease schema (leaseId/agent/owner/taskId/ticket/createdAt/heartbeatAt/expiresAt).
// Internal bookkeeping (`_context`) never leaves the store.
function publicView(lease) {
  const { leaseId, agent, owner, taskId, ticket, createdAt, heartbeatAt, expiresAt } = lease;
  return { leaseId, agent, owner, taskId, ticket, createdAt, heartbeatAt, expiresAt };
}

export class DispatchLeaseStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.ttlMs = ttlMs;
    this._now = now;
    this._idFactory = idFactory;
    this._byId = new Map();            // leaseId -> full lease record (incl. internal _context)
    this._byAgent = new Map();         // agent -> leaseId
    this._requeuedTickets = new Set(); // tickets already auto-requeued once (enforces "at most once")
  }

  /** True if `agent` currently has a live lease. Does not reap — callers that need fresh state
   *  after a TTL lapse must call reapExpired() first (backend-v2.js does this on GET /api/pool
   *  and POST /api/dispatch, mirroring its existing refreshServerLiveness() placement). */
  isBusy(agent) {
    return this._byAgent.has(agent);
  }

  getByAgent(agent) {
    const id = this._byAgent.get(agent);
    const lease = id ? this._byId.get(id) : null;
    return lease ? publicView(lease) : null;
  }

  /** Number of currently-live leases. Test/debug convenience for asserting no leaks. */
  get size() {
    return this._byId.size;
  }

  /** Claim `agent` with a fresh lease. Throws AgentAlreadyLeasedError if `agent` already has a
   *  live lease — callers are expected to only reserve agents selectAgent()/isBusy() reported
   *  idle, so this is a safety net, not part of the normal control flow.
   *  `role`/`tier`/`task`/`room` are internal dispatch context (not part of the public lease
   *  schema) retained only so an expiry-driven requeue can rebuild a valid dispatchQueues
   *  entry. */
  create({ agent, owner, taskId = null, ticket = null, role = null, tier = null, task = null, room = null }) {
    if (!agent) throw new LeaseValidationError('agent is required');
    if (!owner) throw new LeaseValidationError('owner is required');
    if (this._byAgent.has(agent)) {
      throw new AgentAlreadyLeasedError(`agent already leased: ${agent}`);
    }
    const now = this._now();
    const lease = {
      leaseId: this._idFactory(),
      agent,
      owner,
      taskId: taskId || `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      ticket: ticket || null,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: now + this.ttlMs,
      _context: { role, tier, task, room },
    };
    this._byId.set(lease.leaseId, lease);
    this._byAgent.set(agent, lease.leaseId);
    return publicView(lease);
  }

  /** Extend `leaseId`'s expiresAt from now — the only way a long task survives past one TTL
   *  window ("createdAt age alone" never kills it). Requires the exact (leaseId, agent, owner)
   *  tuple; rejects with LeaseNotFoundError / LeaseOwnerMismatchError / LeaseExpiredError, in
   *  that precedence order, otherwise. */
  renew({ leaseId, agent, owner }) {
    return this._withOwnedLease(leaseId, agent, owner, (lease) => {
      const now = this._now();
      lease.heartbeatAt = now;
      lease.expiresAt = now + this.ttlMs;
      return publicView(lease);
    });
  }

  /** Release `leaseId` held by (agent, owner). Same rejection rules as renew(). */
  release({ leaseId, agent, owner }) {
    return this._withOwnedLease(leaseId, agent, owner, (lease) => {
      this._invalidate(lease.leaseId);
      this._freeAgent(lease.agent);
      return publicView(lease);
    });
  }

  /** Back-compat release for callers that predate ownership (pre-Task-7 — e.g. the OpenFab
   *  Bridge as of this writing, which only ever sends {agent}): release whatever lease
   *  currently holds `agent`, no ownership check. Returns the released lease, or null if
   *  `agent` had no live lease (a tolerant no-op, matching the old
   *  `dispatchBusy.delete(name)` semantics it replaces). */
  releaseByAgent(agent) {
    const id = this._byAgent.get(agent);
    if (!id) return null;
    const lease = this._byId.get(id);
    this._invalidate(id);
    this._freeAgent(agent);
    return lease ? publicView(lease) : null;
  }

  _withOwnedLease(leaseId, agent, owner, fn) {
    if (!leaseId || !agent || !owner) throw new LeaseValidationError();
    const lease = this._byId.get(leaseId);
    if (!lease || lease.agent !== agent) {
      throw new LeaseNotFoundError(`no active lease ${leaseId} for agent ${agent}`);
    }
    if (lease.owner !== owner) {
      throw new LeaseOwnerMismatchError(`lease ${leaseId} is not owned by '${owner}'`);
    }
    if (lease.expiresAt <= this._now()) {
      throw new LeaseExpiredError(`lease ${leaseId} expired at ${lease.expiresAt}`);
    }
    return fn(lease);
  }

  /** Sweep every lease past its expiresAt. For each, invalidate the lease FIRST — so any
   *  in-flight renew/release for it starts failing immediately — THEN free the agent. Never the
   *  reverse: freeing the agent first would let a new dispatch hand it to a second caller while
   *  the original lease still looked valid to a renew/release call, i.e. a double-book.
   *  Returns one entry per reaped lease so the caller (backend-v2.js) can requeue its ticket
   *  (durable ticket, first time only) or fail it (no ticket, or the ticket already used its one
   *  requeue) — see `outcome`. */
  reapExpired(now = this._now()) {
    const expired = [];
    for (const lease of this._byId.values()) {
      if (lease.expiresAt <= now) expired.push(lease);
    }
    return expired.map((lease) => {
      this._invalidate(lease.leaseId);
      this._freeAgent(lease.agent);
      const ticket = lease.ticket;
      const canRequeue = Boolean(ticket) && !this._requeuedTickets.has(ticket);
      if (canRequeue) this._requeuedTickets.add(ticket);
      return { lease: publicView(lease), context: lease._context || {}, outcome: canRequeue ? 'requeued' : 'failed' };
    });
  }

  _invalidate(leaseId) {
    this._byId.delete(leaseId);
  }

  _freeAgent(agent) {
    this._byAgent.delete(agent);
  }
}
