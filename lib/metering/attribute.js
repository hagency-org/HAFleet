/*
 * Find the transcripts belonging to an agent, and total them.
 *
 * The chain is `agent → workspacePath → session transcripts → tokens`. Each link is
 * verified rather than assumed, because a wrong link attributes one agent's consumption
 * to another, which is worse than reporting none: an absent figure prompts a question, a
 * misattributed one gets believed.
 *
 * WORKSPACE IS THE KEY, AND IT HAD TO BE ADDED. `workspacePath` was null on every ACP
 * agent until the host was made to report it. A tmux agent reports it through the MCP
 * server. An agent with no recorded workspace is unattributable, and says so.
 *
 * DISCOVERY DIFFERS BY FRAMEWORK, VERIFICATION DOES NOT.
 *
 *   claude   transcripts live under `~/.claude/projects/<dir>`, where <dir> is the cwd
 *            with `/` replaced by `-`. That mapping is sound forwards and ambiguous
 *            backwards, so it is used only to NARROW the search.
 *   codex    transcripts are filed flat by date with no cwd in the path, so candidates
 *            are bounded by modification time and each one's own `session_meta.cwd` is
 *            read.
 *
 * In both cases the transcript's own `cwd` decides. The directory name is a hint; the
 * record is the evidence.
 *
 * SHARED WORKSPACES ARE AMBIGUOUS AND REPORTED AS SUCH. Two agents in one directory
 * produce transcripts nothing here can tell apart — the CLI records the directory, not
 * which agent hafleet started in it. Splitting them would be a guess, so the total is
 * withheld and the collision named.
 */

import path from 'path';
import { PARSERS, KINDS, meteringSupport } from './parsers.js';

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/**
 * Claude's directory name for a working directory.
 *
 * Forward only. `/Users/a/b` becomes `-Users-a-b`; a path already containing `-` maps
 * into the same space as a path containing `/`, so this is never inverted — verified
 * against a real installation, where `/Users/yuechen/home/hagency` is
 * `-Users-yuechen-home-hagency`.
 */
export function claudeProjectDir(workspacePath) {
  const p = String(workspacePath ?? '');
  if (!p.startsWith('/')) return null;
  return p.replace(/\//g, '-');
}

/**
 * Where to look for one framework's transcripts, given a workspace.
 *
 * Returns a directory to scan and whether every candidate must be opened to confirm its
 * cwd. `narrowed: true` means the directory itself already implies the workspace, so a
 * scan is cheap; `false` means every file in the window has to be read far enough to
 * find its own cwd.
 */
export function transcriptSearch(framework, workspacePath, homeDir) {
  const home = String(homeDir ?? '');
  switch (String(framework ?? '').toLowerCase()) {
    case 'claude': {
      const dir = claudeProjectDir(workspacePath);
      if (!dir) return null;
      return { dir: path.join(home, '.claude', 'projects', dir), narrowed: true };
    }
    case 'codex':
      // Filed by date, not by workspace, so nothing can be narrowed by path.
      return { dir: path.join(home, '.codex', 'sessions'), narrowed: false };
    default:
      return null;
  }
}

/**
 * Total one agent's consumption from its transcripts.
 *
 * `readSessions` is injected — it takes a search descriptor and yields
 * `{ file, text }` — so this is testable without a home directory and without the
 * developer's own transcripts leaking into a test's numbers.
 *
 * Returns `available: false` with a reason for every case it cannot answer, never a
 * zero: REQ-CONTRIBUTION-CONSOLE-BLANK, and a zero here would read as "this agent cost
 * you nothing".
 */
export async function meterAgent({ agent, homeDir, readSessions }) {
  const framework = String(agent?.type ?? '').toLowerCase();
  const support = meteringSupport(framework);
  if (!support.available) {
    return { agent: agent?.name ?? null, available: false, framework, reason: support.reason };
  }

  const workspace = typeof agent?.workspacePath === 'string' && agent.workspacePath.trim()
    ? agent.workspacePath.trim()
    : null;
  if (!workspace) {
    return {
      agent: agent?.name ?? null,
      available: false,
      framework,
      reason: 'no workspace recorded for this agent, so its transcripts cannot be located; '
        + 'a running agent reports one and a stopped one may never have',
    };
  }

  const search = transcriptSearch(framework, workspace, homeDir);
  if (!search) {
    return {
      agent: agent.name, available: false, framework,
      reason: `no transcript location known for ${framework}`,
    };
  }

  const parse = PARSERS[framework];
  const totals = zero();
  const files = [];
  let matched = 0;
  let skipped = 0;

  for await (const { file, text } of readSessions(search)) {
    const parsed = parse(text);
    /*
     * The transcript's own cwd decides, even when the directory already implied it.
     * Claude's directory mapping is ambiguous backwards, and a transcript moved or
     * copied between directories would otherwise be counted against the wrong agent.
     */
    if (parsed.cwd && path.resolve(parsed.cwd) !== path.resolve(workspace)) { skipped += 1; continue; }
    if (!parsed.cwd) { skipped += 1; continue; }
    for (const k of KINDS) totals[k] += parsed.totals[k];
    files.push({ file, totals: parsed.totals });
    matched += 1;
  }

  if (matched === 0) {
    return {
      agent: agent.name, available: false, framework, workspace,
      reason: skipped > 0
        ? `found ${skipped} transcript(s) but none recorded this workspace`
        : 'no transcripts found for this workspace yet',
    };
  }

  return {
    agent: agent.name,
    available: true,
    framework,
    workspace,
    totals,
    total: KINDS.reduce((n, k) => n + totals[k], 0),
    sessions: matched,
    // Named rather than dropped: a caller can see the scan was not exhaustive.
    skipped,
    files,
  };
}

/**
 * Total a fleet, keeping every gap visible.
 *
 * Agents sharing a workspace are reported as ambiguous instead of summed. The CLI records
 * the directory it ran in, not which agent hafleet started there, so two agents in one
 * directory cannot be separated — and attributing the whole directory to each would
 * double-count the fleet, while splitting it evenly would invent a division.
 */
export function summarizeFleet(rows = []) {
  const byWorkspace = new Map();
  for (const r of rows) {
    if (!r?.workspace) continue;
    const key = path.resolve(r.workspace);
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), r.agent]);
  }

  const out = rows.map((r) => {
    const shared = r?.workspace ? byWorkspace.get(path.resolve(r.workspace)) : null;
    if (shared && shared.length > 1) {
      return {
        ...r,
        available: false,
        totals: undefined,
        total: undefined,
        reason: `workspace is shared with ${shared.filter((a) => a !== r.agent).join(', ')}; `
          + 'transcripts record the directory, not which agent ran there, so consumption '
          + 'cannot be attributed',
      };
    }
    return r;
  });

  const priced = out.filter((r) => r.available);
  const totals = zero();
  for (const r of priced) for (const k of KINDS) totals[k] += r.totals[k];
  return {
    agents: out,
    totals: priced.length ? totals : null,
    total: priced.length ? KINDS.reduce((n, k) => n + totals[k], 0) : null,
    attributed: priced.length,
    unattributed: out.length - priced.length,
    // A total that silently omitted the unattributable would read as the fleet's whole
    // consumption.
    reason: out.length - priced.length
      ? `${out.length - priced.length} of ${out.length} agents could not be attributed`
      : null,
  };
}
