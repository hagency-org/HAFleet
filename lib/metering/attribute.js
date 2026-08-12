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
 *            with `/` replaced by `-`, flat within that directory. That mapping is sound
 *            forwards and ambiguous backwards, so it is used only to NARROW the search.
 *   codex    transcripts are filed by DATE, in a nested `YYYY/MM/DD` tree, with no cwd
 *            anywhere in the path. So candidates are bounded by modification time and each
 *            one's own `session_meta.cwd` is read.
 *
 * The nesting is not a detail. This file used to say codex filed sessions "flat by date",
 * the reader listed one directory level, and `~/.codex/sessions` contains nothing but year
 * directories — so no codex transcript was ever opened and every codex agent reported
 * "no transcripts found for this workspace yet". Which directory to search is part of the
 * search descriptor for that reason: `recursive` is stated here, next to the layout it
 * describes, rather than assumed by the code that walks it.
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
 * Returns a directory to scan, whether it must be walked recursively, and whether every
 * candidate must be opened to confirm its cwd.
 *
 * `narrowed: true` means the directory itself already implies the workspace, so a scan is
 * cheap AND an out-of-window transcript there is definitely this agent's older spend.
 * `false` means every file in the window has to be read far enough to find its own cwd,
 * and that a candidate the bounds discard cannot be attributed to anyone.
 *
 * `recursive` says whether the transcripts sit directly in that directory or below it.
 * Stated per framework because it is a fact about that CLI's layout, and getting it wrong
 * is silent: a non-recursive walk of a nested tree finds zero files, which is
 * indistinguishable from an agent that has done no work.
 */
export function transcriptSearch(framework, workspacePath, homeDir) {
  const home = String(homeDir ?? '');
  switch (String(framework ?? '').toLowerCase()) {
    case 'claude': {
      const dir = claudeProjectDir(workspacePath);
      if (!dir) return null;
      // One directory per workspace, transcripts directly inside it.
      return { dir: path.join(home, '.claude', 'projects', dir), narrowed: true, recursive: false };
    }
    case 'codex':
      // Filed by date, not by workspace, so nothing can be narrowed by path — and the
      // dates are DIRECTORIES (`YYYY/MM/DD`), so the walk has to descend.
      return { dir: path.join(home, '.codex', 'sessions'), narrowed: false, recursive: true };
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

  /*
   * `lastWorkspacePath` first, because consumption outlives the process.
   *
   * `workspacePath` is cleared when an agent stops — correctly, since it answers where
   * the agent is running now. But transcripts stay on disk, and an agent that worked
   * this month and then stopped still spent against its ceiling. Reading only the live
   * field reported such an agent as having consumed nothing.
   */
  const workspace = [agent?.lastWorkspacePath, agent?.workspacePath]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean) || null;
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
    /*
     * A ZERO-MATCH REASON MUST NOT IMPLY THE AGENT DID NO WORK.
     *
     * "no transcripts found for this workspace yet" is the sentence that hid the
     * flat-directory bug for as long as it existed: it names the workspace, so it reads as
     * "this agent has not started", and it was returned for an agent with millions of
     * measured tokens sitting on disk. The scan had never looked in the right place.
     *
     * The same sentence can still be wrong for a live reason. Codex's search cannot be
     * narrowed, so it competes for the file budget with every other workspace on the
     * machine — on a real installation 380 transcripts fall inside a 30-day window against
     * a ceiling of 200. An agent whose transcript is not among the newest is never opened,
     * and reporting that as "none found" points the operator at the agent instead of at the
     * bound that stopped the scan.
     *
     * `readSessions.bounds` is attached to the reader by makeSessionReader, so what the
     * scan could not reach is available here. When a bound bit, say so.
     *
     * THE TWO FACTS COMBINE; neither one alone is the whole reason. A scan can both open
     * transcripts that belong to other workspaces AND stop before reaching the rest, which
     * is the ordinary case for codex. Reporting only the first ("found 2 transcript(s) but
     * none recorded this workspace") implies the search was exhaustive and quietly drops the
     * fact that more were never opened — found by a test of this very branch, which is why
     * the branches are additive rather than an if/else chain.
     */
    const bounds = readSessions?.bounds ?? null;
    const unreached = bounds
      ? (bounds.droppedByCount || 0) + (bounds.entriesUnwalked || 0)
      : 0;
    const parts = [];
    if (skipped > 0) parts.push(`opened ${skipped} transcript(s), none of which recorded this workspace`);
    if (unreached > 0) {
      parts.push(`${unreached} further candidate transcript(s) were never opened because the scan `
        + 'stopped at its bounds, so this is not evidence the agent did no work — raise '
        + 'HAFLEET_METERING_MAX_FILES to widen the scan');
    }
    return {
      agent: agent.name,
      available: false,
      framework,
      workspace,
      reason: parts.length ? parts.join('; and ') : 'no transcripts found for this workspace yet',
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
