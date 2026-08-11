/*
 * A durable record of measured consumption, so a number does not vanish with its source.
 *
 * WHY A LEDGER AT ALL. Metering reads transcripts the coding CLIs write, and those files
 * are not ours: they get rotated, pruned, moved when a workspace is renamed, and deleted
 * when someone clears their history. Computing consumption on demand means a figure that
 * silently drops when a file goes away — and a monthly ceiling was still spent by work
 * whose transcript is gone. PRD in-scope item 6 asks for usage events persisted across
 * restart; this is that record.
 *
 * THE MODEL IS A HIGH-WATER MARK PER SESSION, NOT AN APPENDED SUM.
 *
 * Every transcript reports a CUMULATIVE total for its session. Appending a snapshot each
 * sweep and summing the snapshots multiplies the session by the number of sweeps — which
 * is exactly the mistake the Codex parser made with `last_token_usage`, caught only by
 * checking against the CLI's own arithmetic. So the ledger stores, per session, the
 * highest total ever observed for it, and the agent's consumption is the sum of those
 * marks.
 *
 * That model has the property the problem needs: a session whose file disappears keeps
 * its mark, so the total does not fall. And because a session's own total only grows
 * while it is being appended to, re-reading the same file is idempotent rather than
 * additive.
 *
 * A FALLING TOTAL IS RECORDED, NOT SILENTLY CLAMPED. If a transcript is rewritten
 * smaller — an edited or truncated file — the mark stays at the high water and the event
 * is counted. Clamping without saying so would hide a source that can no longer be
 * trusted; the count is what tells an operator to look.
 *
 * STORAGE IS BOUNDED WITHOUT LOSING THE NUMBER. Old per-session detail is folded into a
 * `retired` bucket rather than deleted, so pruning costs granularity and never total.
 * Dropping the rows outright would make the ledger's own figure fall over time, which is
 * the failure it exists to prevent.
 */

import { KINDS } from './parsers.js';

/** Per-agent session detail beyond this is folded into `retired`. */
const SESSIONS_PER_AGENT = Math.max(
  10,
  Number.parseInt(process.env.HAFLEET_LEDGER_SESSIONS_PER_AGENT || '500', 10) || 500,
);

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const int = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
const sum = (a, b) => {
  const out = { ...a };
  for (const k of KINDS) out[k] = int(out[k]) + int(b?.[k]);
  return out;
};
const totalOf = (t) => KINDS.reduce((n, k) => n + int(t?.[k]), 0);

/**
 * Create a ledger over an injected load/persist pair.
 *
 * Same shape as engagement-store: the store owns the invariants, the caller owns the
 * bytes, and a test can drive it without a filesystem.
 */
export function createUsageLedger({ load = () => ({}), persist = null, now = Date.now } = {}) {
  const raw = load() ?? {};
  /** agentName -> { sessions: {key: {kinds, lastSeen}}, retired: kinds, retiredSessions, regressions } */
  const agents = raw.agents && typeof raw.agents === 'object' ? raw.agents : {};

  const save = () => {
    if (!persist) return true;
    return persist({ agents, updatedAt: now() });
  };

  function agentRow(name) {
    if (!agents[name]) {
      agents[name] = {
        sessions: {}, retired: zero(), retiredSessions: 0, regressions: 0, framework: null,
      };
    }
    const row = agents[name];
    if (!row.sessions || typeof row.sessions !== 'object') row.sessions = {};
    if (!row.retired) row.retired = zero();
    return row;
  }

  /**
   * Fold the oldest sessions into `retired` once the per-agent cap is exceeded.
   *
   * Oldest by last-seen, so what loses its detail is what is least likely to change
   * again. The tokens are kept; only the ability to say which session they came from is
   * given up.
   */
  function prune(row) {
    const keys = Object.keys(row.sessions);
    if (keys.length <= SESSIONS_PER_AGENT) return 0;
    keys.sort((a, b) => int(row.sessions[a].lastSeen) - int(row.sessions[b].lastSeen));
    const drop = keys.slice(0, keys.length - SESSIONS_PER_AGENT);
    for (const k of drop) {
      row.retired = sum(row.retired, row.sessions[k]);
      row.retiredSessions = int(row.retiredSessions) + 1;
      delete row.sessions[k];
    }
    return drop.length;
  }

  return {
    /**
     * Record one sweep's observations.
     *
     * `observations` is `[{ agent, framework, sessions: [{ key, totals }] }]` — the shape
     * meterAgent already produces, one entry per transcript.
     */
    record(observations = []) {
      let changed = false;
      for (const obs of observations) {
        if (!obs?.agent || !Array.isArray(obs.sessions)) continue;
        const row = agentRow(obs.agent);
        if (obs.framework && row.framework !== obs.framework) {
          row.framework = obs.framework;
          changed = true;
        }
        for (const s of obs.sessions) {
          if (!s?.key) continue;
          const prior = row.sessions[s.key];
          const observed = {
            input: int(s.totals?.input), output: int(s.totals?.output),
            cacheWrite: int(s.totals?.cacheWrite), cacheRead: int(s.totals?.cacheRead),
          };
          if (!prior) {
            row.sessions[s.key] = { ...observed, lastSeen: now() };
            changed = true;
            continue;
          }
          /*
           * High water per kind, not per total. A rewritten transcript could report more
           * of one kind and less of another; taking the max per kind keeps each figure at
           * the largest amount ever actually observed rather than picking a winner by a
           * summed comparison.
           */
          let grew = false;
          let fell = false;
          for (const k of KINDS) {
            if (observed[k] > int(prior[k])) { prior[k] = observed[k]; grew = true; } else if (observed[k] < int(prior[k])) fell = true;
          }
          if (fell) {
            // The source shrank. The mark holds; the event is counted so it can be seen.
            row.regressions = int(row.regressions) + 1;
            changed = true;
          }
          prior.lastSeen = now();
          if (grew) changed = true;
        }
        if (prune(row) > 0) changed = true;
      }
      if (changed) save();
      return changed;
    },

    /** What this agent has consumed, ever, as far as anything ever observed. */
    totalsFor(name) {
      const row = agents[name];
      if (!row) return null;
      let acc = { ...row.retired };
      for (const key of Object.keys(row.sessions)) acc = sum(acc, row.sessions[key]);
      return {
        agent: name,
        framework: row.framework ?? null,
        totals: acc,
        total: totalOf(acc),
        sessions: Object.keys(row.sessions).length,
        retiredSessions: int(row.retiredSessions),
        /*
         * Surfaced rather than buried: a non-zero count means a transcript reported less
         * than it had before, so the figure rests on a source that changed under us.
         */
        regressions: int(row.regressions),
      };
    },

    /** Every agent the ledger has ever seen, including ones no longer configured. */
    list() {
      return Object.keys(agents).sort().map((n) => this.totalsFor(n));
    },

    /**
     * Agents in the ledger that no longer exist in the fleet.
     *
     * Kept rather than dropped: a deleted agent still consumed what it consumed, and a
     * month's total that silently loses a removed agent understates the seat it drew on.
     */
    orphans(currentNames = []) {
      const live = new Set(currentNames);
      return Object.keys(agents).filter((n) => !live.has(n)).sort();
    },
  };
}
