/*
 * Read transcripts off disk, bounded, and cache the result.
 *
 * The parsing and attribution are pure and tested without a filesystem. This is the part
 * that touches one, and its whole job is to stay cheap enough to sit behind a request.
 *
 * WHY BOUNDS ARE NOT OPTIONAL. Claude's transcripts are narrowed by directory, but Codex
 * files by date with no cwd in the path, so answering "what did this agent use" means
 * opening candidates until one matches. A developer machine here holds hundreds of
 * sessions and single transcripts run to 1.8MB. An unbounded scan on a request would make
 * `GET /api/usage` cost seconds and grow with history.
 *
 * So: a modification-time window, a file-count ceiling, and a byte ceiling per file.
 * Every bound that bites is REPORTED — a truncated scan understates consumption, and an
 * understated number presented as a total is the failure this module exists to avoid.
 *
 * THE CACHE IS TIME-BASED AND SHARED. Consumption changes at the pace an agent works, not
 * at the pace a dashboard polls, so a short TTL turns a page refresh into an object
 * lookup. The cached value carries the timestamp it was computed at, so a client can see
 * it is reading a recent measurement rather than a live one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { meterAgent, summarizeFleet } from './attribute.js';

/*
 * How many directory entries one scan may traverse.
 *
 * The read bounds below cap the expensive work; this caps the WALK. A stat-only pass over
 * a real installation's 4,293 codex transcripts costs 22ms, which is nothing — but it
 * grows with history exactly like the scan this module refused to leave unbounded, so it
 * gets a ceiling and a report for the same reason.
 *
 * Deliberately not pruned by directory NAME even though codex's tree is `YYYY/MM/DD` and
 * the date is right there. A session that started before the window and is still being
 * appended to has an old directory and a current file mtime; pruning on the name would
 * drop the one transcript most likely to be live. The file's own mtime decides, which
 * means every candidate has to be stat'd.
 */
export const MAX_ENTRIES = 20_000;

const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** How far back to look. A transcript older than this cannot be current work. */
export const WINDOW_MS = int(process.env.HAFLEET_METERING_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
/** How many candidate files one agent's scan may open. */
export const MAX_FILES = int(process.env.HAFLEET_METERING_MAX_FILES, 200);
/** How much of one transcript to read. Usage records are spread throughout, so a
 *  truncated read understates; the truncation is reported rather than absorbed. */
export const MAX_BYTES = int(process.env.HAFLEET_METERING_MAX_BYTES, 8 * 1024 * 1024);
/** How long a computed figure stays fresh. */
export const CACHE_TTL_MS = int(process.env.HAFLEET_METERING_CACHE_MS, 60_000);

/**
 * Yield transcripts for one search, newest first, within the bounds.
 *
 * Newest first so that when a bound bites, what is dropped is the oldest and least
 * relevant rather than an arbitrary slice.
 */
export function makeSessionReader(limits = {}) {
  const now = limits.now ?? Date.now;
  const windowMs = limits.windowMs ?? WINDOW_MS;
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const bounds = {
    filesSeen: 0,
    filesRead: 0,
    droppedByCount: 0,
    droppedByAge: 0,
    truncated: 0,
    /*
     * Age-drops from a search that could NOT be narrowed to one workspace, kept apart from
     * `droppedByAge` because the two support different claims. In a narrowed search the
     * directory belongs to a single workspace, so an out-of-window transcript is this
     * agent's own older spend and the total genuinely understates it. In a non-narrowed
     * search the directory holds every workspace's sessions and the dropped file's cwd was
     * never read — on a real machine 3,913 of 4,293 codex transcripts are outside the
     * window, nearly all of them other agents' work. Counting those as this agent's
     * understatement would put a false caveat on every figure the endpoint returns.
     */
    unreadOutsideWindow: 0,
    /** Directory entries traversed, and whether the ceiling above stopped the walk. */
    entriesWalked: 0,
    entriesUnwalked: 0,
  };

  /*
   * List `.jsonl` candidates under a root, descending into subdirectories when asked.
   *
   * THE FLAT LIST WAS THE BUG. Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
   * and this listed only the root — which contains nothing but the year directories. So the
   * filter returned zero files, no transcript was ever opened, and every codex agent was
   * reported as "no transcripts found for this workspace yet": a reason that points at the
   * workspace when the scan had in fact never looked anywhere near it. Measured on a real
   * agent, 4,313,968 tokens were reported as nothing.
   */
  const candidates = (root, recursive) => {
    const out = [];
    const queue = [root];
    while (queue.length) {
      const dir = queue.shift();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (bounds.entriesWalked >= maxEntries) { bounds.entriesUnwalked += 1; continue; }
        bounds.entriesWalked += 1;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) queue.push(full);
        } else if (entry.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    }
    return out;
  };

  const read = async function* readSessions(search) {
    if (!search?.dir || !existsSync(search.dir)) return;
    const entries = candidates(search.dir, search.recursive === true);

    const cutoff = now() - windowMs;
    const narrowed = search.narrowed === true;
    const stamped = [];
    for (const file of entries) {
      let st;
      try { st = statSync(file); } catch { continue; }
      bounds.filesSeen += 1;
      if (st.mtimeMs < cutoff) {
        if (narrowed) bounds.droppedByAge += 1;
        else bounds.unreadOutsideWindow += 1;
        continue;
      }
      stamped.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    }
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of stamped) {
      if (bounds.filesRead >= maxFiles) { bounds.droppedByCount += 1; continue; }
      let text;
      try { text = readFileSync(entry.file, 'utf8'); } catch { continue; }
      if (text.length > maxBytes) {
        // Cut at a line boundary: a half-line is unparseable and would be skipped
        // silently, which looks the same as a transcript with fewer records.
        text = text.slice(0, text.lastIndexOf('\n', maxBytes));
        bounds.truncated += 1;
      }
      bounds.filesRead += 1;
      yield { file: entry.file, text };
    }
  };

  read.bounds = bounds;
  return read;
}

/**
 * Whether any bound actually bit, and which. Null when the scan was complete.
 *
 * TWO CLAIMS, KEPT APART. A bound that dropped a transcript belonging to the workspace
 * being measured makes the figure an UNDERSTATEMENT. A bound that dropped a candidate
 * whose workspace was never read supports no such claim — it may have been any agent's, or
 * nobody's. Merging them would have attached "this figure understates consumption" to
 * essentially every codex figure the moment the scan started recursing, since a real
 * `~/.codex/sessions` holds thousands of transcripts outside a 30-day window.
 */
export function boundsReport(bounds) {
  const understates = [];
  if (bounds.droppedByAge) understates.push(`${bounds.droppedByAge} transcript(s) older than the window`);
  if (bounds.droppedByCount) understates.push(`${bounds.droppedByCount} transcript(s) beyond the file limit`);
  if (bounds.truncated) understates.push(`${bounds.truncated} transcript(s) truncated at the byte limit`);
  if (bounds.entriesUnwalked) understates.push(`${bounds.entriesUnwalked} directory entr(ies) beyond the traversal limit`);

  const unknown = [];
  if (bounds.unreadOutsideWindow) {
    unknown.push(`${bounds.unreadOutsideWindow} candidate transcript(s) fell outside the window `
      + 'in a search that could not be narrowed to one workspace, so whether any belong to '
      + 'this agent was never read');
  }

  if (!understates.length && !unknown.length) return null;
  if (!understates.length) return `scan was bounded: ${unknown.join('; ')}`;
  const head = `scan was bounded and this figure understates consumption: ${understates.join('; ')}`;
  return unknown.length ? `${head}. Separately, ${unknown.join('; ')}` : head;
}

const cache = { at: 0, key: null, value: null };

/**
 * A cache key over the fleet's identity, not just the clock.
 *
 * A time-only cache was wrong in a way that showed up in tests before production: adding
 * an agent left the previous fleet's answer valid for up to a minute, so the new agent
 * reported `unavailable` with a reason belonging to nobody. In a test file it made
 * results depend on which test ran first, which is the same defect with a faster
 * feedback loop.
 *
 * Keyed on what actually changes the answer — which agents exist, their framework, and
 * the workspace their transcripts are under. A heartbeat that changes none of those
 * still hits the cache, which is the point.
 */
function fleetKey(agents) {
  return JSON.stringify(agents
    .map((a) => [a?.name ?? '', a?.type ?? '', a?.lastWorkspacePath ?? a?.workspacePath ?? ''])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
}

/**
 * Meter a fleet, cached.
 *
 * `agents` are serialized agent records — they must carry `type` and `workspacePath`.
 * Returns the fleet summary plus what the scan could not cover, so a caller never has to
 * decide whether a total is complete.
 */
export async function meterFleet({ agents = [], homeDir, now = Date.now, force = false } = {}) {
  const key = fleetKey(agents);
  if (!force && cache.value && cache.key === key && now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.value, cached: true, computedAt: cache.at };
  }

  const rows = [];
  // Keys mirror `bounds` in makeSessionReader; the loop below sums by THESE keys, so a
  // bound absent here is silently never aggregated.
  let scanned = {
    filesSeen: 0,
    filesRead: 0,
    droppedByCount: 0,
    droppedByAge: 0,
    truncated: 0,
    unreadOutsideWindow: 0,
    entriesWalked: 0,
    entriesUnwalked: 0,
  };
  for (const agent of agents) {
    const reader = makeSessionReader({ now });
    // eslint-disable-next-line no-await-in-loop
    rows.push(await meterAgent({ agent, homeDir, readSessions: reader }));
    for (const k of Object.keys(scanned)) scanned[k] += reader.bounds[k];
  }

  const summary = summarizeFleet(rows);
  const value = {
    ...summary,
    scanned,
    // Two separate caveats and they must not be merged: `reason` is about agents that
    // could not be attributed at all, this is about a scan that stopped early.
    boundsReason: boundsReport(scanned),
  };
  cache.at = now();
  cache.key = key;
  cache.value = value;
  return { ...value, cached: false, computedAt: cache.at };
}

/** Drop the cache. For tests, and for a caller that has just changed the fleet. */
export function resetMeteringCache() {
  cache.at = 0;
  cache.key = null;
  cache.value = null;
}
