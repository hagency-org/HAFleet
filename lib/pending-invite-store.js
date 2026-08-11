/*
 * Invitations a project has extended that the contributor has not yet answered.
 *
 * WHY THIS RECORD EXISTS. ADR-014's 2026-08-11 amendment: a project dictates how you join it, and
 * the artifact it hands you is an invitation. Before this, an invitation from an inviter the
 * contributor had not pre-declared in `MATRIX_TRUSTED_INVITER_MXIDS` had two possible fates and
 * both were wrong — on the default `audit` trust mode the agent JOINED anyway while no ownership
 * binding was written (present, messageable, and permanently unengageable because every approval
 * then failed `owner_binding_missing`), and under `enforce` the invitation was skipped with only
 * a log line, so the contributor never learned it had happened.
 *
 * WHAT IT IS NOT. Not a trust decision and not a whitelist. Accepting an invitation says "this
 * agent may be in this project" and establishes ownership from the inviter (ADR-002). The
 * whitelist — who may skip approval — stays a separate, stronger act (ADR-013 decision 4).
 *
 * THE BRIDGE OWNS THE TRUTH; THIS IS THE PROJECTION. The bridge holds Matrix state and pushes
 * here so the console can read it, the same shape `approval-bindings` uses. So this store is
 * deliberately dumb: it validates, it dedupes, it persists, and it does not decide anything.
 */

/** A full Matrix room id: `!opaque:server`. The server half is what names the project. */
const ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;
const AGENT_RE = /^[\w-]{1,64}$/;

/** How many settled records to keep before folding the oldest away. */
const SETTLED_CAP = Math.max(
  20,
  Number.parseInt(process.env.HAFLEET_PENDING_INVITE_HISTORY || '200', 10) || 200,
);

export class PendingInviteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PendingInviteError';
    this.code = code;
  }
}

const text = (value, field, max = 256) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new PendingInviteError('bad_request', `${field} is required`);
  if (raw.length > max) throw new PendingInviteError('bad_request', `${field} is too long`);
  return raw;
};

/**
 * The project's homeserver, derived rather than accepted from the caller.
 *
 * The room id already contains it, so taking a `project_server` field on trust would let a caller
 * label a room with a server it does not belong to — and the label is what an operator reads when
 * deciding whether to accept. Derived, it cannot disagree with the room.
 */
function serverFromRoomId(roomId) {
  const at = roomId.indexOf(':');
  return at > 0 ? roomId.slice(at + 1) : null;
}

/*
 * A space separates the two halves, and that is deliberate rather than lazy: agent names match
 * `AGENT_RE` and room ids `ROOM_ID_RE`, neither of which admits whitespace, so a space cannot be
 * ambiguous here.
 *
 * The first version used a NUL for the same guarantee. That tripped this repo's own guard
 * (tests/session-policy-wiring.test.js, "no tracked source file contains a NUL byte") — and
 * demonstrated exactly why the guard exists, because grep treats such a file as binary and had
 * been silently returning nothing for every search of this module.
 */
const key = (roomId, agent) => `${roomId} ${agent}`;

export function createPendingInviteStore({ load = () => ({}), persist = null, now = Date.now } = {}) {
  const raw = load() ?? {};
  /** key -> record */
  const invites = raw.invites && typeof raw.invites === 'object' ? raw.invites : {};

  const save = () => (persist ? persist({ invites, updatedAt: now() }) : true);

  /**
   * Fold the oldest settled records away once the cap is exceeded.
   *
   * Pending records are never pruned, whatever the count: an unanswered invitation is a decision
   * the contributor has not made, and silently dropping it would make the answer impossible.
   * Only decided ones are history.
   */
  function prune() {
    const settled = Object.entries(invites)
      .filter(([, r]) => r.state !== 'pending')
      .sort((a, b) => (a[1].decidedAt ?? 0) - (b[1].decidedAt ?? 0));
    let dropped = 0;
    while (settled.length - dropped > SETTLED_CAP) {
      delete invites[settled[dropped][0]];
      dropped += 1;
    }
    return dropped;
  }

  return {
    /**
     * Record or refresh an invitation.
     *
     * Idempotent on `(room, agent)`: the bridge polls, so the same invitation arrives repeatedly
     * and must not multiply. A record the contributor has already DECIDED is returned unchanged —
     * re-reporting must not reopen a settled question, which is how a declined invitation would
     * come back every poll.
     */
    upsert(input = {}) {
      const roomId = text(input.project_room_id ?? input.projectRoomId, 'project_room_id');
      if (!ROOM_ID_RE.test(roomId)) {
        throw new PendingInviteError('bad_request', 'project_room_id must be a Matrix room id');
      }
      const agent = text(input.agent, 'agent', 64);
      if (!AGENT_RE.test(agent)) {
        throw new PendingInviteError('bad_request', 'agent must be a simple name');
      }
      const rawInviter = input.inviter ?? input.inviterMxid ?? null;
      /*
       * Null is a legitimate value and is kept as null. The inviter IS the owner under ADR-002, so
       * an invitation whose sender the bridge could not read must present as "no inviter known"
       * and be refusable on that basis — never filled in with a plausible guess.
       */
      let inviter = null;
      if (rawInviter !== null && rawInviter !== undefined && String(rawInviter).trim()) {
        inviter = text(rawInviter, 'inviter');
        if (!MXID_RE.test(inviter)) {
          throw new PendingInviteError('bad_request', 'inviter must be a full Matrix MXID');
        }
      }

      const id = key(roomId, agent);
      const existing = invites[id];
      if (existing && existing.state !== 'pending') return { ...existing };

      const seenAt = Number.isFinite(Number(input.seen_at ?? input.seenAt))
        ? Math.floor(Number(input.seen_at ?? input.seenAt))
        : (existing?.seenAt ?? now());

      invites[id] = {
        projectRoomId: roomId,
        agent,
        inviter,
        // Derived, never taken from the caller — see serverFromRoomId.
        projectServer: serverFromRoomId(roomId),
        state: 'pending',
        seenAt,
        decidedAt: null,
        decidedBy: null,
      };
      prune();
      save();
      return { ...invites[id] };
    },

    /** Record the contributor's answer. */
    settle(roomId, agent, decision, by = 'operator') {
      if (decision !== 'accepted' && decision !== 'declined') {
        throw new PendingInviteError('bad_request', 'decision must be accepted or declined');
      }
      const record = invites[key(roomId, agent)];
      if (!record) throw new PendingInviteError('not_found', 'no such invitation');
      if (record.state !== 'pending') {
        throw new PendingInviteError('conflict', `invitation was already ${record.state}`);
      }
      record.state = decision;
      record.decidedAt = now();
      record.decidedBy = by;
      prune();
      save();
      return { ...record };
    },

    get(roomId, agent) {
      const record = invites[key(roomId, agent)];
      return record ? { ...record } : null;
    },

    /**
     * Invitations awaiting a decision, newest first.
     *
     * Pending only by default. The operator's question is "what needs me", and mixing settled
     * history into that list is how a surface stops being actionable.
     */
    list({ state = 'pending' } = {}) {
      return Object.values(invites)
        .filter((r) => (state === 'all' ? true : r.state === state))
        .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
        .map((r) => ({ ...r }));
    },

    /** How many invitations are waiting — for a badge, without shipping the list. */
    pendingCount() {
      return Object.values(invites).filter((r) => r.state === 'pending').length;
    },
  };
}
