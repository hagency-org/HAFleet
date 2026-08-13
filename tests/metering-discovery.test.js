/*
 * FINDING the transcripts, against a real filesystem.
 *
 * THE GAP THIS FILE EXISTS TO CLOSE. `tests/metering.test.js` covers parsing and
 * attribution thoroughly and proves neither of them wrong — because every one of its
 * `meterAgent` cases injects a fake `readSessions` that yields literal strings. The
 * discovery step, the only part that touches a directory, had no test at all. So a total
 * failure sat in it: the reader listed one directory level while codex writes
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and `~/.codex/sessions` holds nothing but
 * year directories. Zero files matched the `.jsonl` filter, zero transcripts were opened,
 * and every codex agent reported "no transcripts found for this workspace yet".
 *
 * That reason is what made it survive. It names the workspace, so it reads as "this agent
 * has not worked yet" — and it was returned for an agent with 4,313,968 measured tokens on
 * disk, in a file whose `cwd` matched its recorded workspace exactly. A test with an
 * injected reader cannot see this. Only a real directory can.
 *
 * So these tests build actual trees in a temp dir. They are the counterpart to
 * metering.test.js, not a duplicate of it: nothing here asserts a token figure that file
 * already covers, and nothing here injects a reader.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { makeSessionReader, boundsReport } from '../lib/metering/reader.js';
import { transcriptSearch, meterAgent } from '../lib/metering/attribute.js';

let home;

/** A codex transcript recording `cwd`, with a real cumulative total. */
const codexTranscript = (cwd, total) => [
  JSON.stringify({ type: 'session_meta', payload: { cwd } }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total - 100, output_tokens: 100, cached_input_tokens: 0,
          reasoning_output_tokens: 40, total_tokens: total,
        },
      },
    },
  }),
].join('\n');

/** Write a codex session where codex really puts it: a nested date directory. */
function writeCodexSession(name, cwd, total, { ageDays = 0, dateDir = '2026/08/12' } = {}) {
  const dir = path.join(home, '.codex', 'sessions', dateDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  writeFileSync(file, codexTranscript(cwd, total));
  if (ageDays) {
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(file, when, when);
  }
  return file;
}

const drain = async (reader, search) => {
  const seen = [];
  for await (const s of reader(search)) seen.push(s.file);
  return seen;
};

beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'metering-discovery-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('codex transcripts are found in the nested date tree', () => {
  test('THE BUG: a session under YYYY/MM/DD is discovered, not silently missed', async () => {
    /*
     * The regression test proper. Before the fix this yielded [] — and because the reader
     * yielded nothing rather than erroring, every layer above it reported an honest-looking
     * "no transcripts found" for an agent that had done millions of tokens of work.
     */
    const ws = '/Users/someone/agent-home/workdir';
    const file = writeCodexSession('nested', ws, 4_313_968);
    const search = transcriptSearch('codex', ws, home);
    const seen = await drain(makeSessionReader(), search);
    expect(seen).toEqual([file]);
  });

  test('the search descriptor says to recurse, because the layout does', () => {
    // Pinned on the descriptor as well as the behaviour: the reader is generic, so if this
    // flag is dropped the walk goes flat again and finds nothing.
    expect(transcriptSearch('codex', '/w', home).recursive).toBe(true);
    expect(transcriptSearch('claude', '/w', home).recursive).toBe(false);
  });

  test('sessions spread across several date directories are all found', async () => {
    const ws = '/Users/someone/ws';
    const a = writeCodexSession('a', ws, 1000, { dateDir: '2026/08/10' });
    const b = writeCodexSession('b', ws, 2000, { dateDir: '2026/08/11' });
    const c = writeCodexSession('c', ws, 3000, { dateDir: '2026/07/29' });
    const seen = await drain(makeSessionReader(), transcriptSearch('codex', ws, home));
    expect(seen.sort()).toEqual([a, b, c].sort());
  });

  test('and the tokens actually arrive, end to end through the real reader', async () => {
    /*
     * meterAgent with NO injected reader — the path the endpoint takes. This is the
     * assertion the old suite had no equivalent of.
     */
    const ws = '/Users/someone/real-ws';
    writeCodexSession('real', ws, 4_313_968);
    const row = await meterAgent({
      agent: { name: 'BigLittle', type: 'codex', lastWorkspacePath: ws },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.available).toBe(true);
    expect(row.total).toBe(4_313_968);
    expect(row.sessions).toBe(1);
  });
});

describe('claude transcripts stay flat, and that still works', () => {
  test('a transcript directly inside the project directory is found', async () => {
    const ws = '/Users/someone/proj';
    const dir = path.join(home, '.claude', 'projects', '-Users-someone-proj');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(file, JSON.stringify({
      uuid: 'u1', cwd: ws, message: { usage: { input_tokens: 10, output_tokens: 5 } },
    }));
    const seen = await drain(makeSessionReader(), transcriptSearch('claude', ws, home));
    expect(seen).toEqual([file]);
  });

  test('a non-recursive search does NOT descend — the flat contract is real, not incidental', async () => {
    /*
     * The counter-case to the fix. If the reader recursed unconditionally, claude's search
     * would reach into sibling project directories and attribute another workspace's
     * transcripts here. The cwd check in meterAgent would catch it, but only after reading
     * files it had no business opening, and it would spend the file budget doing so.
     */
    const ws = '/Users/someone/proj';
    const dir = path.join(home, '.claude', 'projects', '-Users-someone-proj');
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'deeper.jsonl'), '{}');
    const seen = await drain(makeSessionReader(), transcriptSearch('claude', ws, home));
    expect(seen).toEqual([]);
  });
});

describe('what the bounds may claim', () => {
  test('an out-of-window file in a NON-narrowed search is not called an understatement', async () => {
    /*
     * The claim this fix had to avoid making. Recursing means a codex scan now sees every
     * transcript on the machine — on a real installation 3,913 of 4,293 are outside a
     * 30-day window, nearly all of them other agents' work. Reporting those as "this figure
     * understates consumption" would attach a false caveat to every codex figure the
     * endpoint returns, so age-drops from a non-narrowed search are counted separately and
     * described as unread rather than as missing spend.
     */
    const ws = '/Users/someone/ws';
    writeCodexSession('old', '/some/other/workspace', 999, { ageDays: 90 });
    const reader = makeSessionReader();
    await drain(reader, transcriptSearch('codex', ws, home));

    expect(reader.bounds.unreadOutsideWindow).toBe(1);
    expect(reader.bounds.droppedByAge).toBe(0);
    const report = boundsReport(reader.bounds);
    expect(report).toMatch(/never read/);
    expect(report).not.toMatch(/understates/);
  });

  test('an out-of-window file in a NARROWED search IS an understatement, and says so', async () => {
    // The other side of the same distinction: claude's directory belongs to one workspace,
    // so a transcript aged out of it is definitely this agent's own older spend.
    const ws = '/Users/someone/proj';
    const dir = path.join(home, '.claude', 'projects', '-Users-someone-proj');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'old.jsonl');
    writeFileSync(file, '{}');
    const when = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(file, when, when);

    const reader = makeSessionReader();
    await drain(reader, transcriptSearch('claude', ws, home));

    expect(reader.bounds.droppedByAge).toBe(1);
    expect(reader.bounds.unreadOutsideWindow).toBe(0);
    expect(boundsReport(reader.bounds)).toMatch(/understates consumption/);
  });

  test('a complete scan reports no caveat at all', async () => {
    const ws = '/Users/someone/ws';
    writeCodexSession('fresh', ws, 500);
    const reader = makeSessionReader();
    await drain(reader, transcriptSearch('codex', ws, home));
    expect(boundsReport(reader.bounds)).toBeNull();
  });

  test('the traversal ceiling bites loudly rather than truncating in silence', async () => {
    /*
     * The walk grows with history even though it only stats, so it has a ceiling like every
     * other bound here — and, like them, it is reported. A silent traversal limit would
     * reproduce the original defect in a new place: files that exist, never opened, and a
     * figure that looks complete.
     */
    const ws = '/Users/someone/ws';
    for (let i = 0; i < 6; i += 1) writeCodexSession(`s${i}`, ws, 100, { dateDir: `2026/08/${10 + i}` });
    const reader = makeSessionReader({ maxEntries: 4 });
    await drain(reader, transcriptSearch('codex', ws, home));

    expect(reader.bounds.entriesUnwalked).toBeGreaterThan(0);
    expect(boundsReport(reader.bounds)).toMatch(/traversal limit/);
  });
});

describe('a zero-match reason must not imply the agent did no work', () => {
  /*
   * The residual case, and it is the same defect class as the bug this file was written
   * for. Recursing fixes discovery, but codex's search competes for the file budget with
   * every workspace on the machine — 380 transcripts inside a 30-day window against a
   * ceiling of 200, measured on a real installation. An agent whose transcript is not among
   * the newest is never opened.
   */
  test('a scan stopped by the file ceiling says so, instead of "none found"', async () => {
    const ws = '/Users/someone/quiet-agent';
    // This agent's transcript is the OLDEST, so a ceiling of 2 never reaches it.
    writeCodexSession('mine', ws, 5000, { ageDays: 3 });
    for (let i = 0; i < 3; i += 1) {
      writeCodexSession(`busy${i}`, '/Users/someone/other-agent', 100, { dateDir: `2026/08/${11 + i}` });
    }
    const row = await meterAgent({
      agent: { name: 'Quiet', type: 'codex', lastWorkspacePath: ws },
      homeDir: home,
      readSessions: makeSessionReader({ maxFiles: 2 }),
    });

    expect(row.available).toBe(false);
    expect(row.reason).toMatch(/never opened/);
    // The claim that must NOT be made: that the absence is evidence about the agent.
    expect(row.reason).not.toMatch(/no transcripts found/);
    expect(row.reason).toMatch(/not evidence the agent did no work/);
    /*
     * BOTH facts, not the first one only. This scan opened two transcripts belonging to the
     * busy agent AND stopped before reaching this agent's. An earlier version of the fix
     * used an if/else chain, so the skipped-count branch won and the reason read "found 2
     * transcript(s) but none recorded this workspace" — which states the search was
     * exhaustive when two files were never opened. This assertion is why the branches are
     * additive.
     */
    expect(row.reason).toMatch(/opened 2 transcript\(s\)/);
  });

  test('a genuinely empty directory still says exactly that', async () => {
    // The counter-case: with no bound hit, "none found yet" is the true statement and must
    // survive. Widening the bounded-scan wording to cover this case would trade one
    // misleading reason for another.
    mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
    const row = await meterAgent({
      agent: { name: 'Fresh', type: 'codex', lastWorkspacePath: '/Users/someone/new' },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.available).toBe(false);
    expect(row.reason).toMatch(/no transcripts found for this workspace yet/);
  });

  test('transcripts that were READ but recorded another workspace keep their own reason', async () => {
    // Three distinct reasons for a zero, and they must stay distinguishable: never looked,
    // looked and stopped early, looked and they belong to someone else.
    writeCodexSession('elsewhere', '/Users/someone/other', 100);
    const row = await meterAgent({
      agent: { name: 'Mine', type: 'codex', lastWorkspacePath: '/Users/someone/mine' },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.reason).toMatch(/none of which recorded this workspace/);
  });
});

describe('the join between an agent record and its transcripts', () => {
  /*
   * Pinned on the REAL serialized shape, which is where I claimed a bug that was not there.
   * I reported that metering read `workspacePath` while the agent record carried `workdir`,
   * so the join could never match. That was wrong: `serializeAgent` sets `workspacePath` and
   * `lastWorkspacePath` from the runtime record, and on a live agent both equalled its
   * `workdir`. The real defect was the flat directory listing above. This test exists so the
   * join is asserted rather than assumed by either of us again.
   */
  const ws = '/Users/someone/agent-home/workdir';

  test('a record carrying workdir AND workspacePath meters on the workspace field', async () => {
    writeCodexSession('join', ws, 12_345);
    const row = await meterAgent({
      agent: {
        name: 'BigLittle', type: 'codex', kind: 'agent',
        workdir: ws, homeDir: '/Users/someone/agent-home',
        workspacePath: ws, lastWorkspacePath: ws,
      },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.available).toBe(true);
    expect(row.total).toBe(12_345);
  });

  test('a stopped agent still meters: workspacePath is cleared, lastWorkspacePath is not', async () => {
    writeCodexSession('stopped', ws, 777);
    const row = await meterAgent({
      agent: { name: 'BigLittle', type: 'codex', workdir: ws, workspacePath: null, lastWorkspacePath: ws },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.available).toBe(true);
    expect(row.total).toBe(777);
  });

  test('workdir alone does NOT meter, and the reason says so rather than reporting zero', async () => {
    /*
     * Deliberately asserting the CURRENT contract instead of quietly widening it. `workdir`
     * is where the agent's home was provisioned; `workspacePath` is where a process was
     * observed running. They coincide today, and adding `workdir` as a fallback would make
     * metering claim a location nothing measured — attributing another agent's transcripts
     * to this one if it ever ran elsewhere. Misattribution is worse than an absent figure:
     * an absent figure prompts a question, a wrong one gets believed.
     */
    writeCodexSession('workdir-only', ws, 888);
    const row = await meterAgent({
      agent: { name: 'BigLittle', type: 'codex', workdir: ws },
      homeDir: home,
      readSessions: makeSessionReader(),
    });
    expect(row.available).toBe(false);
    expect(row.total).toBeUndefined();
    expect(row.reason).toMatch(/no workspace recorded/);
  });
});
