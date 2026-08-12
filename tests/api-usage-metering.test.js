/*
 * `GET /api/usage` — the endpoint had no test at all, and it was just rewired to read
 * transcripts off disk.
 *
 * That gap mattered more than the usual: this is the surface that reports what a
 * contributor's capacity was spent on, so its failure mode is a number rather than an
 * error. The contract worth pinning is not "does it return 200" but the three ways it
 * could lie:
 *
 *   - a zero where nothing was measured, which reads as "this agent cost you nothing"
 *   - a global availability flag, which either denies measurements that exist or
 *     promises ones that do not
 *   - a total that silently omits what it could not attribute
 *
 * The reader's own bounds are tested separately against a real temporary directory,
 * because a scan that stops early understates consumption and must say so.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { makeSessionReader, boundsReport } from '../lib/metering/reader.js';

const agentRec = (name, type, extra = {}) => ({
  name, type, server: 'local', tmux: null, online: false, manualDown: false, ...extra,
});

describe('GET /api/usage metering block', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('an unmeasurable agent reports null with a reason, never zero', async () => {
    ctx = await createBackendTestContext('usage-null-', {
      agents: { a1: agentRec('a1', 'claude') },
    });
    const res = await request(ctx.app).get('/api/usage');
    expect(res.status).toBe(200);
    const row = res.body.agents.find((r) => r.agent === 'a1');
    // The whole point: a zero here is a claim about consumption, not an absence of one.
    expect(row.tokensUsed).toBeNull();
    expect(row.tokensByKind).toBeNull();
    expect(row.tokensReason).toMatch(/no workspace recorded/);
  });

  /*
   * The third failure mode this file's header names — "a total that silently omits what it
   * could not attribute" — and the one that went untested longest, because no endpoint case
   * produced a MEASURED row: doing that by transcript needs a real
   * `~/.claude/projects/<encoded>` tree. Seeding the ledger reaches the same branch, since
   * the row prefers `usageLedger.totalsFor()` over the live scan.
   *
   * `totals.tokensUsed` was unconditionally null here while per-agent rows carried real
   * figures, so the fleet number was thrown away. The fix must not overcorrect into a bare
   * sum: with some agents unattributable, a sum understates the fleet while reading as
   * authoritative.
   */
  const ledgerFor = (rows) => ({
    'usage-ledger.json': JSON.stringify({
      agents: Object.fromEntries(Object.entries(rows).map(([name, total]) => [name, {
        sessions: { s1: { input: total, output: 0, cacheWrite: 0, cacheRead: 0, lastSeen: 1 } },
        retired: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
        retiredSessions: 0, regressions: 0, framework: 'claude',
        periods: { daily: {}, monthly: {} },
      }])),
    }),
  });

  test('the fleet total sums what was measured instead of discarding it', async () => {
    ctx = await createBackendTestContext('usage-total-', {
      agents: { a1: agentRec('a1', 'claude'), a2: agentRec('a2', 'claude') },
      rawDataFiles: ledgerFor({ a1: 1000, a2: 2500 }),
    });
    const res = await request(ctx.app).get('/api/usage');
    expect(res.body.totals.tokensUsed).toBe(3500);
    expect(res.body.totals.tokensMeasuredFor).toBe(2);
    // Every agent measured, so the figure is a fleet total rather than a partial one.
    expect(res.body.totals.tokensPartial).toBe(false);
  });

  test('a partial total says so, so it cannot be read as the whole fleet', async () => {
    /*
     * The case that makes a bare sum dangerous: one agent measured out of three. 1000 is
     * true of what was measured and false of the fleet, and only `tokensPartial` and
     * `tokensMeasuredFor` distinguish them.
     */
    ctx = await createBackendTestContext('usage-partial-', {
      agents: {
        a1: agentRec('a1', 'claude'), a2: agentRec('a2', 'claude'), a3: agentRec('a3', 'octos'),
      },
      rawDataFiles: ledgerFor({ a1: 1000 }),
    });
    const res = await request(ctx.app).get('/api/usage');
    expect(res.body.totals.tokensUsed).toBe(1000);
    expect(res.body.totals.tokensMeasuredFor).toBe(1);
    expect(res.body.totals.tokensPartial).toBe(true);
    expect(res.body.totals.agents).toBe(3);
  });

  test('a fleet with nothing measured reports null, not zero', async () => {
    /*
     * The same rule the per-agent rows follow, at fleet scale: 0 is the claim that this
     * fleet consumed nothing, which is a stronger statement than anything measured it.
     */
    ctx = await createBackendTestContext('usage-total-none-', {
      agents: { a1: agentRec('a1', 'claude') },
    });
    const res = await request(ctx.app).get('/api/usage');
    expect(res.body.totals.tokensUsed).toBeNull();
    expect(res.body.totals.tokensMeasuredFor).toBe(0);
    // Not partial either — partial means "some of a set", and none were measured.
    expect(res.body.totals.tokensPartial).toBe(false);
  });

  test('availability is reported per framework, not once for the fleet', async () => {
    /*
     * REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE. Claude and Codex write the provider's
     * figures to disk; octos writes neither usage nor cwd. One flag for all three would
     * have to be wrong about two of them.
     */
    ctx = await createBackendTestContext('usage-frameworks-', {
      agents: {
        a1: agentRec('a1', 'claude'),
        a2: agentRec('a2', 'codex'),
        a3: agentRec('a3', 'octos'),
      },
    });
    const res = await request(ctx.app).get('/api/usage');
    const byId = Object.fromEntries(res.body.metering.tokens.frameworks.map((f) => [f.framework, f]));
    expect(byId.claude.available).toBe(true);
    expect(byId.codex.available).toBe(true);
    expect(byId.octos.available).toBe(false);
    // Unavailable WITH the reason: "false" alone sends an operator to check credentials.
    expect(byId.octos.reason).toMatch(/no usage object and no cwd/);
  });

  test('the fleet total says how many agents it could not attribute', async () => {
    /*
     * This test found the cache flaw before production did: a time-only cache kept the
     * previous test's fleet valid, so a differently-sized fleet read the wrong count.
     * The cache is keyed on the fleet's identity now, which is what makes this assertion
     * independent of test order.
     */
    ctx = await createBackendTestContext('usage-partial-', {
      agents: { a1: agentRec('a1', 'claude'), a2: agentRec('a2', 'octos') },
    });
    const t = (await request(ctx.app).get('/api/usage')).body.metering.tokens;
    expect(t.unattributed).toBe(2);
    expect(t.reason).toMatch(/could not be attributed/);
    // Nothing attributable, so availability is false rather than a total of zero.
    expect(t.available).toBe(false);
  });

  test('measured and declared stay distinct', async () => {
    /*
     * A ceiling is knowable — the operator declared it. Consumption is measured or it is
     * not. Presenting them in one column would invite reading the declaration as a result.
     */
    ctx = await createBackendTestContext('usage-declared-', {
      agents: { a1: agentRec('a1', 'claude', { presetId: 'p1' }) },
      frameworkPresets: [{ id: 'p1', name: 'p', framework: 'claude', model: 'claude-opus-5', ceiling: { tokens: 5_000_000, period: 'monthly' } }],
    });
    const row = (await request(ctx.app).get('/api/usage')).body.agents.find((r) => r.agent === 'a1');
    expect(row.ceilingTokens).toBe(5_000_000);
    expect(row.tokensUsed).toBeNull();
  });

  test('busy time and tasks remain available even when tokens are not', async () => {
    // Metering is one signal among several; losing the others because a transcript could
    // not be read would be the wrong trade for a read-only view.
    ctx = await createBackendTestContext('usage-others-', {
      agents: { a1: agentRec('a1', 'octos') },
    });
    const m = (await request(ctx.app).get('/api/usage')).body.metering;
    expect(m.tasks.available).toBe(true);
    expect(m.busyTime.available).toBe(true);
    expect(m.tokens.available).toBe(false);
  });
});

describe('the reader reports every bound that bit', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  /** A minimal Claude transcript for a workspace. */
  const transcript = (cwd, output) => [
    JSON.stringify({ cwd, uuid: 'u1' }),
    JSON.stringify({ cwd, uuid: 'a1', message: { usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join('\n');

  const drain = async (reader, search) => {
    const out = [];
    for await (const s of reader(search)) out.push(s);
    return out;
  };

  test('a complete scan reports no caveat', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'meter-read-'));
    writeFileSync(path.join(dir, 'a.jsonl'), transcript('/ws', 10));
    const reader = makeSessionReader({});
    expect(await drain(reader, { dir })).toHaveLength(1);
    expect(boundsReport(reader.bounds)).toBeNull();
  });

  test('transcripts older than the window are dropped AND reported', async () => {
    /*
     * A silent drop understates consumption while looking like a total. The window exists
     * so a scan stays cheap; saying so is what keeps the number honest.
     */
    dir = mkdtempSync(path.join(os.tmpdir(), 'meter-old-'));
    const old = path.join(dir, 'old.jsonl');
    writeFileSync(old, transcript('/ws', 10));
    const ancient = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    utimesSync(old, ancient, ancient);
    const reader = makeSessionReader({ windowMs: 24 * 3600 * 1000 });
    expect(await drain(reader, { dir })).toHaveLength(0);
    expect(boundsReport(reader.bounds)).toMatch(/older than the window/);
  });

  test('the file ceiling is reported, and the newest files are the ones kept', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'meter-many-'));
    for (let i = 0; i < 5; i += 1) {
      const f = path.join(dir, `s${i}.jsonl`);
      writeFileSync(f, transcript('/ws', i));
      const t = new Date(Date.now() - (5 - i) * 60_000);
      utimesSync(f, t, t);
    }
    const reader = makeSessionReader({ maxFiles: 2 });
    const got = await drain(reader, { dir });
    expect(got).toHaveLength(2);
    // Newest first, so a bound drops the least relevant rather than an arbitrary slice.
    expect(got[0].file).toMatch(/s4\.jsonl$/);
    expect(boundsReport(reader.bounds)).toMatch(/beyond the file limit/);
  });

  test('a truncated transcript is cut at a line boundary and reported', async () => {
    /*
     * A half-line is unparseable and would be skipped silently, which looks identical to
     * a transcript with fewer records.
     */
    dir = mkdtempSync(path.join(os.tmpdir(), 'meter-big-'));
    writeFileSync(path.join(dir, 'big.jsonl'), transcript('/ws', 10));
    const reader = makeSessionReader({ maxBytes: 60 });
    const [got] = await drain(reader, { dir });
    expect(got.text.endsWith('}')).toBe(true);
    expect(boundsReport(reader.bounds)).toMatch(/truncated/);
  });

  test('a missing directory yields nothing rather than throwing', async () => {
    const reader = makeSessionReader({});
    expect(await drain(reader, { dir: '/definitely/not/here' })).toHaveLength(0);
  });
});
