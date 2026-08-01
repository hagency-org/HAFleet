import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

import { buildSummary, SUMMARY_LIMIT } from '../lib/message-summary.js';

// The summary is what the relay types into a tmux agent's pane and what a reader
// sees first. `hafleet tell` cut it at 72 characters, so a 73-character message
// arrived as "CODEX-FINA" and the agent did the wrong thing with no error anywhere.
//
// Two places build summaries now — the operator CLI and the ACP host replying on
// an agent's behalf — so the rule lives in one module and is tested here rather
// than reimplemented and left to drift.

describe('buildSummary', () => {
  test.each([1, 71, 72, 73, 100, 239, 240])('a %i-character message passes through whole', (n) => {
    const text = 'x'.repeat(n);
    expect(buildSummary(text)).toBe(text);
  });

  test('the limit itself is not truncated', () => {
    const text = 'y'.repeat(SUMMARY_LIMIT);
    expect(buildSummary(text)).toBe(text);
    expect(buildSummary(text)).not.toContain('…');
  });

  test('one character over the limit is cut and marked', () => {
    const text = `${'word '.repeat(60)}end`;
    const summary = buildSummary(text);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
  });

  test('the cut lands on a word boundary, never mid-word', () => {
    const text = `${'alpha bravo charlie delta '.repeat(20)}omega`;
    const cut = buildSummary(text).slice(0, -1);
    expect(text.startsWith(cut)).toBe(true);
    expect(text[cut.length]).toMatch(/\s/);
  });

  test('whitespace is collapsed so a multi-line body reads as one line', () => {
    // A pane receives one line. Newlines in a summary would be typed as Enter.
    expect(buildSummary('one\n\ntwo   three\t four')).toBe('one two three four');
  });

  test('a single word longer than the limit is still cut to fit', () => {
    // No boundary to fall back to. Over-length output would defeat the point.
    const summary = buildSummary('z'.repeat(400));
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
  });

  test.each([null, undefined, ''])('%s becomes an empty string, not "null"', (value) => {
    expect(buildSummary(value)).toBe('');
  });
});

describe('the two callers share the rule rather than reimplementing it', () => {
  test('the ACP host imports it', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toContain("from '../lib/message-summary.js'");
    expect(host).toContain('buildSummary(body)');
  });

  test('the ACP host does not carry its own truncation arithmetic', () => {
    // A second copy of the rule is how the two drift apart.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).not.toMatch(/slice\(0,\s*23[0-9]\)/);
  });

  test('the CLI and this module agree on the limit', () => {
    // bin/hafleet-cli implements the same rule in bash and cannot import it, so
    // the number is asserted here instead of being silently duplicated.
    const cli = readFileSync('bin/hafleet-cli', 'utf-8');
    expect(cli).toContain(`-le ${SUMMARY_LIMIT} `);
    expect(cli).toContain(`cut -c1-${SUMMARY_LIMIT - 3}`);
  });
});
