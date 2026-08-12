/*
 * Token metering: parsing the CLIs' own accounting, and attributing it to an agent.
 *
 * ADR-013 contract 1, which the ADR itself calls the gate for the other four. It is a
 * TOKEN count, not a cost — the ADR's 2026-08-10 amendment withdrew pricing entirely.
 *
 * THE FIXTURES ARE SHAPED FROM REAL TRANSCRIPTS, and the arithmetic in them is real
 * arithmetic taken off disk. Two bugs in the Codex parser survived reading the fields
 * carefully and were caught only by checking the parse against the total the CLI had
 * already computed for itself, so that cross-check is asserted here rather than assumed:
 *
 *   - summing `last_token_usage` double-counted, because a turn emits it more than once
 *     (725 records, 363 turns): a real session's cache reads came to 52,909,824 against
 *     the CLI's own 26,522,496
 *   - `reasoning_output_tokens` is a BREAKDOWN of `output_tokens`, not an addition, so
 *     adding it overstated output by 43%
 */

import { describe, expect, test } from 'vitest';
import { parseClaudeSession, parseCodexSession, meteringSupport } from '../lib/metering/parsers.js';
import { claudeProjectDir, transcriptSearch, meterAgent, summarizeFleet } from '../lib/metering/attribute.js';

const WS = '/Users/someone/work/payments-api';

/** A Claude transcript: two assistant messages, one repeated as a resumed session would. */
const claudeText = [
  JSON.stringify({ type: 'user', cwd: WS, uuid: 'u0' }),
  JSON.stringify({
    type: 'assistant', cwd: WS, uuid: 'a1',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 2, output_tokens: 1810,
        cache_creation_input_tokens: 1565, cache_read_input_tokens: 339_166,
      },
    },
  }),
  // The same record again: a resumed session replays context into the same file.
  JSON.stringify({
    type: 'assistant', cwd: WS, uuid: 'a1',
    message: { usage: { input_tokens: 2, output_tokens: 1810, cache_creation_input_tokens: 1565, cache_read_input_tokens: 339_166 } },
  }),
  JSON.stringify({
    type: 'assistant', cwd: WS, uuid: 'a2',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } },
  }),
].join('\n');

/**
 * A Codex transcript. `total_token_usage` is cumulative and satisfies
 * `total = input + output`; `input` includes the cached portion; `reasoning` sits inside
 * `output`. The same running total appears twice, as the real files do.
 */
const codexTotals = (input, cached, output, reasoning) => ({
  payload: {
    info: {
      total_token_usage: {
        input_tokens: input, cached_input_tokens: cached,
        output_tokens: output, reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
      last_token_usage: {
        input_tokens: input, cached_input_tokens: cached,
        output_tokens: output, reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

const codexText = [
  JSON.stringify({ payload: { type: 'session_meta', cwd: WS, id: 's1' } }),
  JSON.stringify(codexTotals(1000, 900, 100, 40)),
  JSON.stringify(codexTotals(1000, 900, 100, 40)),   // repeated running total, same turn
  JSON.stringify(codexTotals(5000, 4500, 300, 120)),
].join('\n');

describe('Claude transcript parsing', () => {
  test('token kinds stay separate', () => {
    const r = parseClaudeSession(claudeText);
    expect(r.totals).toEqual({ input: 12, output: 1900, cacheWrite: 1565, cacheRead: 340_166 });
    expect(r.cwd).toBe(WS);
    expect(r.models).toEqual(['claude-opus-4-8']);
  });

  test('a repeated record is counted once', () => {
    // A resumed session appends the same message again; summing blindly inflates usage.
    const r = parseClaudeSession(claudeText);
    expect(r.messages).toBe(2);
    expect(r.totals.output).toBe(1900);
  });

  test('records with no uuid are reported as undedupable rather than silently summed', () => {
    const text = [
      JSON.stringify({ cwd: WS, message: { usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      JSON.stringify({ cwd: WS, message: { usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join('\n');
    const r = parseClaudeSession(text);
    expect(r.messages).toBe(2);
    expect(r.undedupable).toBe(2);
  });

  test('malformed lines are skipped, not fatal', () => {
    const r = parseClaudeSession(`not json\n${claudeText}\n{"broken":`);
    expect(r.totals.output).toBe(1900);
  });
});

describe('Codex transcript parsing', () => {
  test('the session total is the cumulative figure, not a sum of deltas', () => {
    /*
     * The first bug. The same running total appears twice above; summing the delta field
     * would count that turn twice.
     */
    const r = parseCodexSession(codexText);
    expect(r.totals.cacheRead).toBe(4500);
    expect(r.totals.input).toBe(500);     // 5000 total input less 4500 cached
    expect(r.cumulativeTotal).toBe(5300);
  });

  test('reasoning tokens are not added to output', () => {
    // The second bug. reasoning (120) sits inside output (300); adding it gives 420.
    const r = parseCodexSession(codexText);
    expect(r.totals.output).toBe(300);
    expect(r.reasoningOutput).toBe(120);
  });

  test("the parse agrees with the CLI's own arithmetic", () => {
    /*
     * The assertion that caught both bugs, and the one that will catch a format change:
     * input + cacheRead + output must equal the CLI's total_tokens.
     */
    const r = parseCodexSession(codexText);
    expect(r.agreesWithCli).toBe(true);
    expect(r.totals.input + r.totals.cacheRead + r.totals.output).toBe(r.cumulativeTotal);
  });

  test('a turn is a change in the running total, not a record', () => {
    const r = parseCodexSession(codexText);
    expect(r.turns).toBe(2);
  });

  test('a non-monotonic total is reported rather than trusted', () => {
    const text = [
      JSON.stringify({ payload: { type: 'session_meta', cwd: WS } }),
      JSON.stringify(codexTotals(5000, 4500, 300, 0)),
      JSON.stringify(codexTotals(1000, 900, 100, 0)),   // went backwards
    ].join('\n');
    expect(parseCodexSession(text).nonMonotonic).toBe(1);
  });
});

describe('framework support is stated per framework', () => {
  test('supported frameworks say so', () => {
    expect(meteringSupport('claude').available).toBe(true);
    expect(meteringSupport('codex').available).toBe(true);
  });

  test('octos is unavailable WITH the reason, not merely false', () => {
    // "unavailable" alone sends an operator looking at credentials; the reason is that
    // the CLI does not write the number.
    const s = meteringSupport('octos');
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/no usage object and no cwd/);
  });

  test('an unknown framework is unavailable, not assumed supported', () => {
    expect(meteringSupport('something-new').available).toBe(false);
  });
});

describe('locating transcripts', () => {
  test("Claude's directory name is the cwd with slashes replaced", () => {
    expect(claudeProjectDir('/Users/yuechen/home/hagency')).toBe('-Users-yuechen-home-hagency');
  });

  test('a relative path has no project directory', () => {
    expect(claudeProjectDir('work/thing')).toBeNull();
  });

  test('Claude narrows by directory, Codex cannot', () => {
    expect(transcriptSearch('claude', WS, '/home/me').narrowed).toBe(true);
    // Codex files are dated, not filed by workspace, so every candidate must be opened.
    expect(transcriptSearch('codex', WS, '/home/me').narrowed).toBe(false);
  });
});

describe('attributing to an agent', () => {
  const reader = (files) => async function* gen() {
    for (const f of files) yield f;
  };

  test('a matching transcript is totalled', async () => {
    const r = await meterAgent({
      agent: { name: 'a1', type: 'claude', workspacePath: WS },
      homeDir: '/home/me',
      readSessions: reader([{ file: 's1.jsonl', text: claudeText }]),
    });
    expect(r.available).toBe(true);
    expect(r.totals.cacheRead).toBe(340_166);
    expect(r.sessions).toBe(1);
  });

  test("a transcript recording a DIFFERENT cwd is not counted", async () => {
    /*
     * The directory name is a hint and is ambiguous backwards, so the record decides. A
     * transcript from another workspace would otherwise be billed to this agent.
     */
    const other = claudeText.replaceAll(WS, '/Users/someone/work/other');
    const r = await meterAgent({
      agent: { name: 'a1', type: 'claude', workspacePath: WS },
      homeDir: '/home/me',
      readSessions: reader([{ file: 'x.jsonl', text: other }]),
    });
    expect(r.available).toBe(false);
    /*
     * Wording widened when the zero-match reason learned to state TWO facts at once: what it
     * opened, and what it never reached. "opened 1 transcript(s), none of which recorded this
     * workspace" so the unreached clause can be appended with "; and ...". The old phrasing
     * was a complete sentence that could not compose, which is how it came to imply an
     * exhaustive search on a scan that had stopped at its file ceiling.
     */
    expect(r.reason).toMatch(/none of which recorded this workspace/);
    // Nothing was left unreached here, so the scan must NOT hedge about bounds.
    expect(r.reason).not.toMatch(/never opened/);
  });

  test('an agent with no workspace is unattributable, not zero', async () => {
    const r = await meterAgent({
      agent: { name: 'a1', type: 'claude', workspacePath: null },
      homeDir: '/home/me',
      readSessions: reader([]),
    });
    expect(r.available).toBe(false);
    expect(r.totals).toBeUndefined();
    expect(r.reason).toMatch(/no workspace recorded/);
  });

  test('an unsupported framework reports its reason before looking for files', async () => {
    const r = await meterAgent({
      agent: { name: 'o1', type: 'octos', workspacePath: WS },
      homeDir: '/home/me',
      readSessions: reader([{ file: 'never-read', text: claudeText }]),
    });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no usage object/);
  });
});

describe('fleet summary keeps gaps visible', () => {
  const ok = (agent, workspace, cacheRead) => ({
    agent, available: true, framework: 'claude', workspace,
    totals: { input: 0, output: 0, cacheWrite: 0, cacheRead }, total: cacheRead,
  });

  test('agents sharing a workspace are ambiguous, not summed', () => {
    /*
     * The transcript records the directory, not which agent hafleet started in it.
     * Attributing the whole directory to each would double the fleet; splitting it evenly
     * would invent a division.
     */
    const s = summarizeFleet([ok('a1', WS, 100), ok('a2', WS, 100)]);
    expect(s.agents.every((a) => a.available === false)).toBe(true);
    expect(s.agents[0].reason).toMatch(/shared with a2/);
    expect(s.total).toBeNull();
  });

  test('distinct workspaces total normally', () => {
    const s = summarizeFleet([ok('a1', WS, 100), ok('a2', '/other/ws', 50)]);
    expect(s.total).toBe(150);
    expect(s.attributed).toBe(2);
    expect(s.reason).toBeNull();
  });

  test('a partial total says how many agents it excluded', () => {
    const s = summarizeFleet([
      ok('a1', WS, 100),
      { agent: 'a2', available: false, framework: 'octos', reason: 'no adapter' },
    ]);
    expect(s.total).toBe(100);
    expect(s.unattributed).toBe(1);
    expect(s.reason).toMatch(/could not be attributed/);
  });

  test('nothing attributable yields null, never zero', () => {
    const s = summarizeFleet([{ agent: 'a1', available: false, reason: 'no workspace' }]);
    expect(s.total).toBeNull();
  });
});
