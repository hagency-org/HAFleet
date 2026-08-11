/*
 * Turn measured usage into cost, using prices only the operator can supply.
 *
 * WHY THE PRICE BOOK IS DECLARED, NOT BUILT IN. A per-token price is not a property of
 * a model, it is a property of a contract: it differs by provider, by plan, by region,
 * by negotiated rate, and it changes without notice. Shipping a table of prices would
 * make HAFleet confidently wrong the first time a provider adjusted one, and an
 * invented price is worse than an absent one because it produces a number somebody
 * will put in a report. PRD line 250 already recorded that no price book exists;
 * this is the shape of the one the operator fills in.
 *
 * THE TWO BILLING MODES ARE NOT THE SAME CALCULATION, and collapsing them is the main
 * error this module exists to avoid.
 *
 *   api-key      cost = Σ (tokens of kind × rate for that kind). A rate times a
 *                quantity. Marginal, additive, knowable per engagement the moment the
 *                tokens are known.
 *
 *   subscription there IS no per-token rate. A plan costs a fixed amount per period,
 *                and the marginal cost of one more token is zero. Attributing cost to
 *                one engagement is therefore an ALLOCATION of a fixed sum across
 *                everything that shared the seat — which cannot be computed from that
 *                engagement's usage alone, and cannot be final until the period is.
 *
 * ADR-013 decision 5 already made the seat the accounting root for exactly this
 * reason. A subscription seat's cost is the plan's cost; what an engagement "cost" is
 * a share of it, and a share needs a denominator.
 *
 * TOKEN KINDS ARE PRICED SEPARATELY because they differ by an order of magnitude. A
 * cache read is a fraction of fresh input; summing them into one "input" number and
 * multiplying by the input rate overstates cost several-fold on a long session, and
 * the CLIs report them separately precisely because they bill separately.
 *
 * Every path that cannot produce a number returns `null` with a reason, never 0 —
 * PRD A-R7-3, and REQ-CONTRIBUTION-CONSOLE-BLANK.
 */

/** The token kinds the coding CLIs actually report, and which bill differently. */
export const TOKEN_KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/**
 * Normalize one operator-declared price entry.
 *
 * Returns null rather than a partial entry: a price book with three of four rates
 * would silently value the fourth kind at zero, which is the failure this module is
 * built to prevent. An entry priced per million tokens is stored as declared and
 * converted at use, because that is the unit every provider publishes.
 */
export function normalizePrice(input = {}) {
  const mode = input.authMode === 'subscription' ? 'subscription' : 'api-key';
  const currency = typeof input.currency === 'string' && input.currency.trim()
    ? input.currency.trim().toUpperCase().slice(0, 8)
    : null;
  if (!currency) return null;

  if (mode === 'subscription') {
    const period = ['daily', 'monthly'].includes(input.period) ? input.period : null;
    const planCost = num(input.planCost);
    // A subscription price is the plan's cost for a period. Without the period the
    // number cannot be compared to a usage window, so it is not a usable price.
    if (planCost === null || period === null) return null;
    return { authMode: 'subscription', currency, planCost, period };
  }

  const perMillion = {};
  for (const kind of TOKEN_KINDS) {
    const v = num(input.perMillion?.[kind]);
    // Zero is legitimate here and distinct from absent: some providers do not charge
    // for cache reads at all, and that is a declared price of zero, not a gap.
    if (v === null) return null;
    perMillion[kind] = v;
  }
  return { authMode: 'api-key', currency, perMillion };
}

/**
 * The cost of one usage record, or null with the reason it is not knowable.
 *
 * `usage` is the normalized per-kind token counts. `price` is a normalized entry.
 * `seatTotals` is only consulted for a subscription, where cost is a share.
 */
export function costFor({ usage, price, seatTotals = null } = {}) {
  if (!usage || typeof usage !== 'object') {
    return { cost: null, currency: null, reason: 'no usage measured' };
  }
  if (!price) {
    return {
      cost: null,
      currency: null,
      reason: 'no price declared for this model; the operator supplies the price book',
    };
  }

  if (price.authMode === 'api-key') {
    let total = 0;
    for (const kind of TOKEN_KINDS) {
      const tokens = num(usage[kind]);
      if (tokens === null) {
        // One unmeasured kind makes the total wrong rather than approximate, so the
        // whole figure is withheld and the gap named.
        return {
          cost: null,
          currency: price.currency,
          reason: `usage for ${kind} tokens was not measured, so the total would understate cost`,
        };
      }
      total += (tokens / 1_000_000) * price.perMillion[kind];
    }
    return {
      cost: Math.round(total * 1e6) / 1e6,
      currency: price.currency,
      basis: 'metered',
      reason: null,
    };
  }

  /*
   * Subscription: an allocation, and only computable against the seat's total for the
   * same period. Reported as `basis: 'allocated'` so a reader never mistakes a share
   * of a fixed plan for a metered charge — they behave differently under every
   * question anyone will ask of them.
   */
  const mine = num(usage.total ?? TOKEN_KINDS.reduce((n, k) => n + (num(usage[k]) ?? 0), 0));
  const seatTotal = num(seatTotals?.total);
  if (seatTotal === null) {
    return {
      cost: null,
      currency: price.currency,
      reason: 'a subscription cost is a share of a fixed plan; the seat total for the '
        + 'period is unknown, so the denominator is missing',
    };
  }
  if (seatTotal === 0) {
    return {
      cost: null,
      currency: price.currency,
      reason: 'the seat recorded no usage in this period, so no share can be attributed',
    };
  }
  if (mine === null) {
    return { cost: null, currency: price.currency, reason: 'no usage measured for this engagement' };
  }
  return {
    cost: Math.round((price.planCost * (mine / seatTotal)) * 1e6) / 1e6,
    currency: price.currency,
    basis: 'allocated',
    // Stated on every subscription figure: the marginal cost of these tokens was zero,
    // and this number is a division of a bill that was paid regardless.
    reason: null,
    share: Math.round((mine / seatTotal) * 1e6) / 1e6,
    provisional: seatTotals?.periodComplete !== true,
  };
}

/**
 * Sum a set of costed rows, keeping unknowns visible instead of dropping them.
 *
 * A total that quietly omits what it could not price reads as complete. Callers get
 * the priced total, the count that had no price, and the currency — refusing to mix
 * currencies rather than adding them, because a summed mixed-currency figure is
 * meaningless in a way a missing one is not.
 */
export function sumCosts(rows = []) {
  const priced = [];
  const unknown = [];
  for (const r of rows) {
    if (r && r.cost !== null && r.cost !== undefined) priced.push(r);
    else unknown.push(r);
  }
  const currencies = [...new Set(priced.map((r) => r.currency).filter(Boolean))];
  if (currencies.length > 1) {
    return {
      total: null, currency: null, pricedCount: priced.length, unknownCount: unknown.length,
      reason: `rows span ${currencies.length} currencies (${currencies.join(', ')}); a mixed total would be meaningless`,
    };
  }
  return {
    total: priced.length ? Math.round(priced.reduce((n, r) => n + r.cost, 0) * 1e6) / 1e6 : null,
    currency: currencies[0] ?? null,
    pricedCount: priced.length,
    unknownCount: unknown.length,
    // Partial by construction whenever anything could not be priced, and it says so.
    reason: unknown.length
      ? `${unknown.length} of ${rows.length} rows could not be priced and are excluded`
      : null,
  };
}
