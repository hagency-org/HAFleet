/*
 * WHICH TOKENS A CEILING DRAWS AGAINST. Operator ruling, 2026-08-12.
 *
 * A ceiling draws against FRESH tokens — input, output, cacheWrite. Cache reads are
 * measured, reported, and never drawn.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINE IN enforcement-spend.test.js. That suite covers
 * spend-vs-reservation thoroughly and could not see this rule at all: every fixture it
 * writes uses `input` and `output` only, so folding cache reads into the enforced total or
 * leaving them out produced identical results. The defect lived in the gap between two
 * suites that each looked complete.
 *
 * THE DEFECT IT PINS. `lib/metering/ledger.js` summed all four kinds into one `total`, and
 * `ceilingSpendFor` fed that total straight into `remainingFor`. Meanwhile `parsers.js`, in
 * the same subsystem, states that folding cache reads in is "a five-order-of-magnitude
 * error, not a rounding one" and records a real session with 4,800,089,833 cache reads
 * against 19,765 fresh input tokens. The module that established the separation was undone
 * by the one that consumed it.
 *
 * It was not theoretical. The first agent ever metered successfully had used 681,089 fresh
 * tokens of a 10,000,000 ceiling and was locked out at 13,609,601 — 95% cache reads — with
 * every approval refused for a reason unrelated to how much work it had done.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { CEILING_KINDS, KINDS } from '../lib/metering/parsers.js';
import { createUsageLedger } from '../lib/metering/ledger.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const API_TOKEN = 'ceiling-kinds-token';
const AGENT = 'ceiling-probe';

describe('the rule itself', () => {
  test('cache reads are measured but never drawn', () => {
    expect(KINDS).toContain('cacheRead');
    expect(CEILING_KINDS).not.toContain('cacheRead');
    // And nothing else was quietly dropped along with it: a ceiling that ignored cacheWrite
    // would under-draw on the kind that bills at a PREMIUM to fresh input.
    expect([...CEILING_KINDS].sort()).toEqual(['cacheWrite', 'input', 'output']);
  });
});

describe('the ledger reports both figures, and keeps them apart', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  const observe = (ledger, totals) => ledger.record([{
    agent: AGENT, framework: 'codex', sessions: [{ key: 'session-1', totals }],
  }]);

  test('total counts every kind; drawn counts only the fresh ones', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-kinds-'));
    const ledger = createUsageLedger({ file: path.join(dir, 'ledger.json') });
    /*
     * Shaped like the real observation that caused the lockout: cache reads dominating by
     * an order of magnitude. Exact numbers from BigLittle on 2026-08-12.
     */
    observe(ledger, { input: 604_823, output: 76_266, cacheWrite: 0, cacheRead: 12_928_512 });

    const bucket = ledger.currentPeriod(AGENT, 'monthly');
    expect(bucket.total).toBe(13_609_601);
    expect(bucket.drawn).toBe(681_089);
    // The distinction is the whole point: one must not be derivable from the other by
    // accident, and 681,089 is 5% of 13,609,601.
    expect(bucket.drawn).toBeLessThan(bucket.total);
  });

  test('with no cache reads at all the two figures agree', () => {
    // The counter-case. If `drawn` diverged from `total` when there was nothing to exclude,
    // it would be dropping a kind it should count.
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-nocache-'));
    const ledger = createUsageLedger({ file: path.join(dir, 'ledger.json') });
    observe(ledger, { input: 1000, output: 500, cacheWrite: 250, cacheRead: 0 });

    const bucket = ledger.currentPeriod(AGENT, 'monthly');
    expect(bucket.total).toBe(1750);
    expect(bucket.drawn).toBe(1750);
  });

  test('cacheWrite DOES draw — it bills above fresh input, not below', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-cachewrite-'));
    const ledger = createUsageLedger({ file: path.join(dir, 'ledger.json') });
    observe(ledger, { input: 0, output: 0, cacheWrite: 5000, cacheRead: 0 });

    const bucket = ledger.currentPeriod(AGENT, 'monthly');
    expect(bucket.drawn).toBe(5000);
  });

  test('the all-time figure carries both too, so a display caller cannot pick the wrong one', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-ever-'));
    const ledger = createUsageLedger({ file: path.join(dir, 'ledger.json') });
    observe(ledger, { input: 100, output: 10, cacheWrite: 0, cacheRead: 9_000_000 });

    const ever = ledger.totalsFor(AGENT);
    expect(ever.total).toBe(9_000_110);
    expect(ever.drawn).toBe(110);
  });
});

describe('enforcement uses the drawn figure, not the parity total', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  const CEILING = 10_000_000;
  const ROOM = '!ceil:hq.example';

  /*
   * SEEDED THROUGH THE LEDGER FILE, because that is the only way to put MEASURED spend in
   * front of enforcement in a test.
   *
   * `enforcement-spend.test.js` exhausts a ceiling with allocations and never with a
   * measurement — the ledger is populated by a metering sweep over real transcripts, which a
   * test context has none of. That is exactly why nothing pinned this read: swapping
   * `bucket.drawn` back to `bucket.total` passed the entire suite. The shape below is what
   * `createUsageLedger` actually persists, taken from its own output rather than guessed.
   */
  const ledgerWith = (kinds) => {
    const periodKeys = {
      monthly: new Date().toISOString().slice(0, 7),
      daily: new Date().toISOString().slice(0, 10),
    };
    return {
      'usage-ledger.json': JSON.stringify({
        agents: {
          a1: {
            sessions: { s1: { ...kinds, lastSeen: Date.now() } },
            retired: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
            retiredSessions: 0,
            regressions: 0,
            framework: 'claude',
            periods: {
              daily: { [periodKeys.daily]: { ...kinds } },
              monthly: { [periodKeys.monthly]: { ...kinds } },
            },
          },
        },
        updatedAt: Date.now(),
      }),
    };
  };

  const seedWith = (kinds) => ({
    agents: {
      a1: {
        name: 'a1', type: 'claude', kind: 'agent', server: 'local', online: true,
        manualDown: false, presetId: 'p1', capability: 'coding',
        runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } },
      },
    },
    frameworkPresets: [{
      id: 'p1', name: 'codex-strong', framework: 'claude', model: 'claude-opus-5',
      ceiling: { tokens: CEILING, period: 'monthly' },
    }],
    rawDataFiles: ledgerWith(kinds),
  });

  /** Ask for an allocation and report what the verdict did. */
  async function askAndApprove(context, tokens) {
    await request(context.app).post('/api/whitelist').send({ projectRoomId: ROOM });
    const created = await request(context.app).post('/api/engagements').send({
      project: 'p', projectRoomId: ROOM, role: 'coding',
      requester: '@r:hq.example', requestedTokens: tokens, ratePerDay: 1000,
      requestId: `$ceil-${tokens}`,
    });
    const id = created.body?.engagement?.id;
    if (!id) return { status: created.status, body: created.body, id: null };
    const verdict = await request(context.app).post(`/api/engagements/${id}/verdict`)
      .send({ approve: true, allocatedTokens: tokens });
    return { status: verdict.status, body: verdict.body, id };
  }

  test('THE LOCKOUT: a ceiling swamped by cache reads still approves work', async () => {
    /*
     * 13.6M measured against a 10M ceiling, of which 681k is fresh tokens. Under the parity
     * total this agent had `remaining: 0` and every allocation threw `over_commit` — the
     * state BigLittle was actually in. Under the ruling it has ~9.3M left.
     */
    ctx = await createBackendTestContext('ceil-cacheswamp-', seedWith({
      input: 604_823, output: 76_266, cacheWrite: 0, cacheRead: 12_928_512,
    }));

    const usage = await request(ctx.app).get('/api/usage');
    const row = usage.body.agents.find((r) => r.agent === 'a1');
    // Unconditional. An earlier version guarded these in `if (row.tokensUsed !== null)`,
    // which is a test that passes by asserting nothing when the field it needs is missing.
    expect(row.tokensUsed).toBe(13_609_601);
    expect(row.tokensDrawn).toBe(681_089);
    expect(row.tokensByKind.cacheRead).toBe(12_928_512);

    // The assertion that kills the mutant: the approval SUCCEEDS.
    const approved = await askAndApprove(ctx, 1_000_000);
    expect(approved.status).toBe(200);
    expect(approved.body.engagement.state).toBe('active');
    expect(approved.body.engagement.allocatedTokens).toBe(1_000_000);
  });

  test('and fresh tokens DO exhaust it — the rule is not "measure nothing"', async () => {
    /*
     * The counter-case, and the reason the fix is a change of kinds rather than a removal of
     * enforcement. Same ceiling, same total order of magnitude, but the spend is fresh: the
     * ceiling is genuinely gone and the allocation must be refused.
     */
    ctx = await createBackendTestContext('ceil-freshspend-', seedWith({
      input: 9_500_000, output: 500_000, cacheWrite: 0, cacheRead: 0,
    }));

    const usage = await request(ctx.app).get('/api/usage');
    const row = usage.body.agents.find((r) => r.agent === 'a1');
    expect(row.tokensDrawn).toBe(10_000_000);

    const refused = await askAndApprove(ctx, 1_000_000);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/exceed|over_commit/);
  });

  test('the refusal reaching the API names the binding draw', async () => {
    // The message composed in the store has to survive the trip through the route, or the
    // operator still sees a bare number.
    ctx = await createBackendTestContext('ceil-refusalmsg-', seedWith({
      input: 9_900_000, output: 100_000, cacheWrite: 0, cacheRead: 4_000_000,
    }));
    const refused = await askAndApprove(ctx, 500_000);
    const body = JSON.stringify(refused.body);
    expect(body).toMatch(/measured spend is what is binding/);
    expect(body).toMatch(/codex-strong/);
    // And it explains why the console shows a bigger number than the one enforced.
    expect(body).toMatch(/cache reads are measured and shown but do not draw/);
  });
});

describe('a refusal names what drew the ceiling down', () => {
  /*
   * "allocating 50000 would exceed the 0 left on BigLittle" is true and unusable: on an
   * agent holding one small engagement it reads as an arithmetic bug. Two numbers compete
   * for the ceiling — committed allocations and measured spend — and `remainingFor` takes
   * the larger. Which one is binding is the first thing anyone needs and is not inferable
   * from the result.
   *
   * Tested through the store rather than the endpoint because the message is composed there
   * and the endpoint would need a ledger with a live period bucket to reach it.
   */
  let store;

  const load = async () => import('../lib/engagement-store.js');
  /*
   * In-memory store. Two details the factory requires and neither is guessable: it takes
   * load/persist HOOKS rather than a file path, and `persist` must return TRUTHY — `commit()`
   * treats a falsy return as a failed write, rolls back, and throws `persistence_failed`.
   */
  const make = (createEngagementStore) => createEngagementStore({
    load: () => ({}),
    persist: () => true,
  });
  const ask = (st, agent, tokens) => st.createRequest({
    project: 'p', projectRoomId: '!r:s', role: 'coding', requester: '@a:s',
    requestedTokens: tokens, agent,
  });

  test('the plain form survives when no context is supplied', async () => {
    // A caller with no ledger must still get a usable error rather than a crash or a
    // fabricated breakdown. The optional context is why this is asserted.
    const { createEngagementStore } = await load();
    store = make(createEngagementStore);
    const created = ask(store, 'a1', 500);
    expect(() => store.decide({
      engagementId: created.id, approve: true, allocatedTokens: 500, remainingTokens: 100,
    })).toThrow(/would exceed the 100 left on a1/);
  });

  test('with context, it names the binding draw, the preset to raise, and the period', async () => {
    const { createEngagementStore } = await load();
    store = make(createEngagementStore);
    const created = ask(store, 'BigLittle', 50_000);

    let message = '';
    try {
      store.decide({
        engagementId: created.id,
        approve: true,
        allocatedTokens: 50_000,
        remainingTokens: 0,
        spendContext: {
          period: 'monthly',
          reserved: 250_000,
          spent: 10_000_000,
          consumed: 13_609_601,
          ceilingTokens: 10_000_000,
          presetName: 'codex-strong',
          spendPeriodKey: '2026-08',
        },
      });
    } catch (error) { message = String(error.message); }

    expect(message).toMatch(/10\.0M/);            // the ceiling
    expect(message).toMatch(/250k is committed/); // the reservation side
    expect(message).toMatch(/measured spend is what is binding/); // WHICH one bites
    expect(message).toMatch(/2026-08/);           // the period the measurement belongs to
    expect(message).toMatch(/codex-strong/);      // the remedy, named
    /*
     * And the discrepancy an operator will otherwise report as a bug: the console shows
     * 13.6M while enforcement acted on 10M, because cache reads do not draw.
     */
    expect(message).toMatch(/cache reads are measured and shown but do not draw/);
  });

  test('when reservations are the binding draw, it says so instead', async () => {
    // The mirror case. Naming "measured spend" whenever a measurement exists would be wrong
    // half the time, and misdirects the operator to the ledger rather than to the engagements.
    const { createEngagementStore } = await load();
    store = make(createEngagementStore);
    const created = ask(store, 'BigLittle', 50_000);
    let message = '';
    try {
      store.decide({
        engagementId: created.id, approve: true, allocatedTokens: 50_000, remainingTokens: 0,
        spendContext: {
          period: 'monthly', reserved: 9_000_000, spent: 100_000, consumed: 100_000,
          ceilingTokens: 9_000_000, presetName: 'codex-strong', spendPeriodKey: '2026-08',
        },
      });
    } catch (error) { message = String(error.message); }

    expect(message).toMatch(/committed allocations is what is binding/);
    // Nothing to explain here: consumed equals spent, so the cache-read note must NOT appear.
    expect(message).not.toMatch(/cache reads are measured/);
  });
});
