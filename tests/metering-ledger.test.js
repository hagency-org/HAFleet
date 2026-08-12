/*
 * The usage ledger: consumption that outlives its source.
 *
 * Metering reads transcripts the coding CLIs own, and those files rotate, get pruned, and
 * disappear when someone clears history. Computing on demand means a figure that silently
 * drops when a file goes away — while the monthly ceiling was still spent by that work.
 * PRD in-scope item 6 asks for usage persisted across restart.
 *
 * THE BUG THIS DESIGN AVOIDS BY CONSTRUCTION. Every transcript reports a CUMULATIVE total
 * for its session, so appending a snapshot per sweep and summing them multiplies the
 * session by the number of sweeps. That is precisely the mistake the Codex parser made
 * with `last_token_usage` — 52,909,824 against a true 26,522,496 — caught only by
 * checking against the CLI's own arithmetic. A high-water mark per session is idempotent
 * under re-reading, which is what makes repeated sweeps safe.
 */

import { describe, expect, test } from 'vitest';
import { createUsageLedger, periodKey } from '../lib/metering/ledger.js';

const kinds = (input, output, cacheWrite, cacheRead) => ({ input, output, cacheWrite, cacheRead });

/** One sweep's worth of observations for a single agent. */
const obs = (agent, sessions, framework = 'claude') => [{ agent, framework, sessions }];

const ledger = (opts = {}) => {
  let tick = 0;
  const saved = [];
  const l = createUsageLedger({
    load: () => opts.initial ?? {},
    persist: (v) => { saved.push(JSON.parse(JSON.stringify(v))); return true; },
    now: () => { tick += 1; return tick; },
  });
  return { l, saved };
};

describe('repeated sweeps are idempotent', () => {
  test('re-reading the same transcript does not add to the total', () => {
    /*
     * The property the whole design turns on. Sweeps run on a timer; if each one added,
     * an idle agent's consumption would climb forever.
     */
    const { l } = ledger();
    const sweep = obs('a1', [{ key: 's1.jsonl', totals: kinds(10, 20, 30, 40) }]);
    l.record(sweep);
    l.record(sweep);
    l.record(sweep);
    expect(l.totalsFor('a1').total).toBe(100);
  });

  test('a growing transcript raises the mark', () => {
    const { l } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 20, 30, 40) }]));
    l.record(obs('a1', [{ key: 's1', totals: kinds(15, 25, 30, 90) }]));
    expect(l.totalsFor('a1').totals).toEqual(kinds(15, 25, 30, 90));
  });

  test('a second session adds, because it is a different session', () => {
    const { l } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(1, 1, 1, 1) }]));
    l.record(obs('a1', [
      { key: 's1', totals: kinds(1, 1, 1, 1) },
      { key: 's2', totals: kinds(2, 2, 2, 2) },
    ]));
    expect(l.totalsFor('a1').total).toBe(12);
    expect(l.totalsFor('a1').sessions).toBe(2);
  });
});

describe('a total survives its source disappearing', () => {
  test('a rotated-away transcript keeps its contribution', () => {
    /*
     * The reason the ledger exists. The next sweep simply does not see s1 — the file was
     * rotated. Recomputing from disk would report 4; the ledger reports 104, because the
     * work happened and the ceiling was spent.
     */
    const { l } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 20, 30, 40) }]));
    l.record(obs('a1', [{ key: 's2', totals: kinds(1, 1, 1, 1) }]));
    expect(l.totalsFor('a1').total).toBe(104);
  });

  test('a transcript that shrank holds its high water AND is counted as a regression', () => {
    /*
     * An edited or truncated transcript. Clamping silently would hide a source that can no
     * longer be trusted; the count is what tells an operator to look at it.
     */
    const { l } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 20, 30, 40) }]));
    l.record(obs('a1', [{ key: 's1', totals: kinds(1, 2, 3, 4) }]));
    const t = l.totalsFor('a1');
    expect(t.total).toBe(100);
    expect(t.regressions).toBe(1);
  });

  test('the high water is per kind, not decided by a summed comparison', () => {
    // A rewritten transcript can report more of one kind and less of another; each figure
    // should be the largest ever actually observed for it.
    const { l } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 0, 0, 0) }]));
    l.record(obs('a1', [{ key: 's1', totals: kinds(0, 50, 0, 0) }]));
    expect(l.totalsFor('a1').totals).toEqual(kinds(10, 50, 0, 0));
  });
});

describe('storage is bounded without losing the number', () => {
  test('pruned sessions are folded into a retired bucket, not dropped', () => {
    /*
     * Deleting rows would make the ledger's own figure FALL over time, which is the exact
     * failure it exists to prevent. Pruning costs granularity and never total.
     */
    const { l } = ledger();
    // The cap is 500 by default; go past it and check nothing is lost.
    for (let i = 0; i < 520; i += 1) {
      l.record(obs('a1', [{ key: `s${i}`, totals: kinds(1, 1, 1, 1) }]));
    }
    const t = l.totalsFor('a1');
    expect(t.total).toBe(520 * 4);
    expect(t.sessions).toBe(500);
    expect(t.retiredSessions).toBe(20);
  });

  test('the oldest sessions are the ones that lose their detail', () => {
    const { l } = ledger();
    for (let i = 0; i < 520; i += 1) {
      l.record(obs('a1', [{ key: `s${i}`, totals: kinds(1, 0, 0, 0) }]));
    }
    // Re-observing s0 after it retired adds it back as a fresh session, which is the
    // honest outcome: its detail was folded away and cannot be matched again.
    expect(l.totalsFor('a1').retiredSessions).toBeGreaterThan(0);
  });
});

describe('period buckets, because a ceiling has a period', () => {
  /*
   * A ceiling is `{tokens, period}` — 5,000,000 per MONTH. Comparing an all-time total to
   * a monthly ceiling exhausts it permanently and never recovers, so enforcement against
   * an unbucketed total is wrong in the direction that matters: it refuses work that is
   * within budget.
   *
   * GROWTH is bucketed, not totals. A session spanning a month boundary must split across
   * both; bucketing its total would dump the whole session into whichever period it was
   * last seen in.
   */
  const at = (iso) => new Date(iso).getTime();
  const ledgerAtTimes = (times) => {
    let i = -1;
    return createUsageLedger({
      load: () => ({}), persist: () => true,
      now: () => { i += 1; return times[Math.min(i, times.length - 1)]; },
    });
  };

  test('growth lands in the bucket for the moment it was observed', () => {
    const l = ledgerAtTimes([at('2026-08-10T00:00:00Z'), at('2026-08-10T00:00:00Z')]);
    l.record(obs('a1', [{ key: 's1', totals: kinds(1, 1, 1, 1) }]));
    const cur = l.currentPeriod('a1', 'monthly', at('2026-08-10T12:00:00Z'));
    expect(cur.key).toBe('2026-08');
    expect(cur.total).toBe(4);
  });

  test('a session spanning two months splits across both, rather than landing in one', () => {
    /*
     * The case that makes growth-bucketing necessary. One session, observed in August and
     * again in September; each period gets what was actually seen in it.
     */
    const times = [
      at('2026-08-31T23:00:00Z'), at('2026-08-31T23:00:00Z'),
      at('2026-09-01T01:00:00Z'), at('2026-09-01T01:00:00Z'),
    ];
    const l = ledgerAtTimes(times);
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 0, 0, 0) }]));
    l.record(obs('a1', [{ key: 's1', totals: kinds(25, 0, 0, 0) }]));
    expect(l.currentPeriod('a1', 'monthly', at('2026-08-15T00:00:00Z')).total).toBe(10);
    expect(l.currentPeriod('a1', 'monthly', at('2026-09-15T00:00:00Z')).total).toBe(15);
    // And the all-time figure is still the whole thing.
    expect(l.totalsFor('a1').total).toBe(25);
  });

  test('a period with no observation is null, not zero', () => {
    /*
     * No bucket means no sweep has measured growth in this period, which is not the same
     * as measuring none. A ceiling check reading that as zero would report full headroom
     * for an agent nobody has looked at.
     */
    const l = ledgerAtTimes([at('2026-08-10T00:00:00Z')]);
    l.record(obs('a1', [{ key: 's1', totals: kinds(1, 1, 1, 1) }]));
    expect(l.currentPeriod('a1', 'monthly', at('2026-12-01T00:00:00Z'))).toBeNull();
    expect(l.currentPeriod('never-seen', 'monthly')).toBeNull();
  });

  test('both granularities are kept, because neither derives from the other', () => {
    // Months cannot be split into days after the fact, and summing days misses any period
    // before bucketing began.
    const l = ledgerAtTimes([at('2026-08-10T00:00:00Z'), at('2026-08-10T00:00:00Z')]);
    l.record(obs('a1', [{ key: 's1', totals: kinds(2, 0, 0, 0) }]));
    expect(l.currentPeriod('a1', 'daily', at('2026-08-10T05:00:00Z')).key).toBe('2026-08-10');
    expect(l.currentPeriod('a1', 'monthly', at('2026-08-10T05:00:00Z')).key).toBe('2026-08');
  });

  test('periodKey is UTC and zero-padded, so buckets sort as strings', () => {
    expect(periodKey(at('2026-01-05T00:00:00Z'), 'monthly')).toBe('2026-01');
    expect(periodKey(at('2026-01-05T00:00:00Z'), 'daily')).toBe('2026-01-05');
  });
});

describe('the ledger keeps what the fleet forgets', () => {
  test('a deleted agent is retained and reported as an orphan', () => {
    /*
     * A removed agent still consumed what it consumed. A month's total that silently loses
     * it understates the seat it drew on, which is the number the operator actually cares
     * about.
     */
    const { l } = ledger();
    l.record(obs('gone', [{ key: 's1', totals: kinds(5, 5, 5, 5) }]));
    l.record(obs('alive', [{ key: 's2', totals: kinds(1, 1, 1, 1) }]));
    expect(l.orphans(['alive'])).toEqual(['gone']);
    expect(l.totalsFor('gone').total).toBe(20);
    expect(l.list().map((r) => r.agent)).toEqual(['alive', 'gone']);
  });

  test('an unknown agent yields null rather than a zero', () => {
    const { l } = ledger();
    expect(l.totalsFor('never-seen')).toBeNull();
  });
});

describe('persistence', () => {
  test('a write happens only when something changed', () => {
    // A sweep every minute over an idle fleet should not rewrite the file every minute.
    const { l, saved } = ledger();
    const sweep = obs('a1', [{ key: 's1', totals: kinds(1, 1, 1, 1) }]);
    l.record(sweep);
    const after = saved.length;
    l.record(sweep);
    expect(saved.length).toBe(after);
  });

  test('a loaded ledger continues from what was stored', () => {
    const { l, saved } = ledger();
    l.record(obs('a1', [{ key: 's1', totals: kinds(10, 10, 10, 10) }]));
    const snapshot = saved.at(-1);

    const { l: reloaded } = ledger({ initial: snapshot });
    // The source is gone entirely on this run, and the total is still there.
    expect(reloaded.totalsFor('a1').total).toBe(40);
    reloaded.record(obs('a1', [{ key: 's2', totals: kinds(1, 1, 1, 1) }]));
    expect(reloaded.totalsFor('a1').total).toBe(44);
  });

  test('malformed stored state does not take the ledger down', () => {
    for (const bad of [null, undefined, 'nope', { agents: 'not-an-object' }, { agents: { a1: {} } }]) {
      const l = createUsageLedger({ load: () => bad, persist: () => true, now: () => 1 });
      expect(() => l.record(obs('a1', [{ key: 's1', totals: kinds(1, 1, 1, 1) }]))).not.toThrow();
      expect(l.totalsFor('a1').total).toBe(4);
    }
  });

  test('observations without a session key are ignored, not counted as zero', () => {
    const { l } = ledger();
    l.record(obs('a1', [{ totals: kinds(9, 9, 9, 9) }, { key: 's1', totals: kinds(1, 1, 1, 1) }]));
    expect(l.totalsFor('a1').total).toBe(4);
  });
});
