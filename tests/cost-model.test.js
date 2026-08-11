/*
 * Cost from measured usage and operator-declared prices.
 *
 * The usage fixtures below are shaped from records actually found on disk, not invented:
 * Claude Code writes `{input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens}` per message, and Codex writes
 * `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`. A
 * fixture that guessed the shape would test the calculation against a record that never
 * arrives.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING. Three ways to produce a confidently wrong
 * number, each of which reads as a working feature:
 *
 *   - pricing a cache read at the fresh-input rate, which overstates a long session
 *     several-fold
 *   - treating a subscription as if it had a per-token rate, when the marginal cost of
 *     a token on a fixed plan is zero
 *   - totalling rows while silently dropping the ones that had no price
 */

import { describe, expect, test } from 'vitest';
import { normalizePrice, costFor, sumCosts, TOKEN_KINDS } from '../lib/cost-model.js';

/** A Claude Code usage record, normalized to this module's kinds. */
const claudeUsage = {
  // From a real session: 339,166 cache reads against 2 fresh input tokens. The ratio is
  // the whole point — mispricing cache reads here is a 100x error, not a rounding one.
  input: 2,
  output: 1810,
  cacheWrite: 1565,
  cacheRead: 339_166,
};

/** A Codex record: reasoning tokens are billed as output. */
const codexUsage = {
  input: 218_811 - 217_856,
  cacheRead: 217_856,
  cacheWrite: 0,
  output: 12_000 + 4_000,
};

const apiPrice = normalizePrice({
  authMode: 'api-key',
  currency: 'usd',
  perMillion: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
});

describe('price book normalization', () => {
  test('an api-key price needs every token kind', () => {
    // A book missing one rate would value that kind at zero and understate every total
    // silently, which is the failure this refuses rather than tolerates.
    for (const missing of TOKEN_KINDS) {
      const perMillion = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
      delete perMillion[missing];
      expect(normalizePrice({ authMode: 'api-key', currency: 'usd', perMillion }), missing).toBeNull();
    }
  });

  test('a declared zero is a price, not a gap', () => {
    // Some providers do not charge for cache reads. That is a rate of zero, and it must
    // be distinguishable from "nobody told us".
    const p = normalizePrice({
      authMode: 'api-key', currency: 'usd',
      perMillion: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0 },
    });
    expect(p.perMillion.cacheRead).toBe(0);
  });

  test('a price with no currency is not a price', () => {
    expect(normalizePrice({ authMode: 'api-key', perMillion: { input: 3, output: 15, cacheWrite: 1, cacheRead: 1 } }))
      .toBeNull();
  });

  test('a subscription price needs a plan cost AND a period', () => {
    expect(normalizePrice({ authMode: 'subscription', currency: 'usd', planCost: 200 })).toBeNull();
    expect(normalizePrice({ authMode: 'subscription', currency: 'usd', period: 'monthly' })).toBeNull();
    expect(normalizePrice({ authMode: 'subscription', currency: 'usd', planCost: 200, period: 'monthly' }))
      .toEqual({ authMode: 'subscription', currency: 'USD', planCost: 200, period: 'monthly' });
  });
});

describe('api-key cost is a rate times a quantity', () => {
  test('each token kind is priced at its own rate', () => {
    const r = costFor({ usage: claudeUsage, price: apiPrice });
    // 2/1e6*3 + 1810/1e6*15 + 1565/1e6*3.75 + 339166/1e6*0.3
    const expected = (2 * 3 + 1810 * 15 + 1565 * 3.75 + 339_166 * 0.3) / 1e6;
    expect(r.cost).toBeCloseTo(expected, 6);
    expect(r.currency).toBe('USD');
    expect(r.basis).toBe('metered');
  });

  test('pricing cache reads as fresh input overstates this session 7.8x', () => {
    /*
     * The number that makes separate kinds non-negotiable. This is not a precision
     * argument: conflating them changes the answer by most of its magnitude —
     * $0.134775 becomes $1.049349 on one real session's usage.
     *
     * The factor is asserted at the value computed from these figures, not at a round
     * guess. An earlier version of this test claimed 9x and failed at 7.79x, which is
     * the same class of error the module guards against: a plausible number nobody
     * checked.
     */
    const correct = costFor({ usage: claudeUsage, price: apiPrice }).cost;
    const naive = ((claudeUsage.input + claudeUsage.cacheRead + claudeUsage.cacheWrite) * 3
      + claudeUsage.output * 15) / 1e6;
    expect(correct).toBeCloseTo(0.134775, 5);
    expect(naive).toBeCloseTo(1.049349, 5);
    expect(naive / correct).toBeCloseTo(7.79, 1);
  });

  test('a Codex record prices the same way', () => {
    const r = costFor({ usage: codexUsage, price: apiPrice });
    expect(r.cost).toBeGreaterThan(0);
    expect(r.basis).toBe('metered');
  });

  test('one unmeasured kind withholds the total and names the gap', () => {
    // Not "close enough": the total would be wrong in a known direction, and a wrong
    // number that looks right is worse than a stated absence.
    const r = costFor({ usage: { ...claudeUsage, cacheRead: undefined }, price: apiPrice });
    expect(r.cost).toBeNull();
    expect(r.reason).toMatch(/cacheRead/);
  });

  test('no price declared yields null and says whose job it is', () => {
    const r = costFor({ usage: claudeUsage, price: null });
    expect(r.cost).toBeNull();
    expect(r.reason).toMatch(/operator supplies the price book/);
  });

  test('no usage yields null, never zero', () => {
    expect(costFor({ usage: null, price: apiPrice }).cost).toBeNull();
  });
});

describe('subscription cost is an allocation, not a rate', () => {
  const subPrice = normalizePrice({
    authMode: 'subscription', currency: 'usd', planCost: 200, period: 'monthly',
  });

  test('it is a share of the plan, and reports itself as allocated', () => {
    const r = costFor({
      usage: { ...claudeUsage, total: 342_543 },
      price: subPrice,
      seatTotals: { total: 3_425_430, periodComplete: true },
    });
    // 10% of the seat's usage in the period → 10% of the plan cost.
    expect(r.cost).toBeCloseTo(20, 6);
    expect(r.basis).toBe('allocated');
    expect(r.share).toBeCloseTo(0.1, 6);
    expect(r.provisional).toBe(false);
  });

  test('without the seat total there is no denominator, so no cost', () => {
    /*
     * The distinction the whole module exists for. A subscription engagement's usage is
     * knowable on its own; its cost is not, because the bill was fixed and shared.
     */
    const r = costFor({ usage: { ...claudeUsage, total: 342_543 }, price: subPrice });
    expect(r.cost).toBeNull();
    expect(r.reason).toMatch(/denominator/);
  });

  test('an incomplete period is marked provisional rather than reported as final', () => {
    const r = costFor({
      usage: { total: 100 }, price: subPrice,
      seatTotals: { total: 1000, periodComplete: false },
    });
    expect(r.cost).toBeCloseTo(20, 6);
    expect(r.provisional).toBe(true);
  });

  test('a seat with no usage attributes nothing rather than dividing by zero', () => {
    const r = costFor({ usage: { total: 0 }, price: subPrice, seatTotals: { total: 0 } });
    expect(r.cost).toBeNull();
    expect(r.reason).toMatch(/no usage in this period|no share/);
  });
});

describe('totals keep their gaps visible', () => {
  test('a partial total says how much it excluded', () => {
    const rows = [
      costFor({ usage: claudeUsage, price: apiPrice }),
      costFor({ usage: codexUsage, price: apiPrice }),
      costFor({ usage: claudeUsage, price: null }),
    ];
    const s = sumCosts(rows);
    expect(s.pricedCount).toBe(2);
    expect(s.unknownCount).toBe(1);
    expect(s.reason).toMatch(/could not be priced/);
  });

  test('a complete total carries no caveat', () => {
    const s = sumCosts([
      costFor({ usage: claudeUsage, price: apiPrice }),
      costFor({ usage: codexUsage, price: apiPrice }),
    ]);
    expect(s.unknownCount).toBe(0);
    expect(s.reason).toBeNull();
    expect(s.currency).toBe('USD');
  });

  test('mixed currencies refuse to total', () => {
    // Adding USD to EUR produces a number that is wrong in a way no caveat repairs.
    const eur = normalizePrice({
      authMode: 'api-key', currency: 'eur',
      perMillion: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    });
    const s = sumCosts([
      costFor({ usage: claudeUsage, price: apiPrice }),
      costFor({ usage: claudeUsage, price: eur }),
    ]);
    expect(s.total).toBeNull();
    expect(s.reason).toMatch(/currencies/);
  });

  test('nothing priced yields null, not zero', () => {
    const s = sumCosts([costFor({ usage: claudeUsage, price: null })]);
    expect(s.total).toBeNull();
    expect(s.pricedCount).toBe(0);
  });
});
