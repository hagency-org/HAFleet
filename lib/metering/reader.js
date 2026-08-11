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
  const bounds = { filesSeen: 0, filesRead: 0, droppedByCount: 0, droppedByAge: 0, truncated: 0 };

  const read = async function* readSessions(search) {
    if (!search?.dir || !existsSync(search.dir)) return;
    let entries;
    try {
      entries = readdirSync(search.dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }

    const cutoff = now() - windowMs;
    const stamped = [];
    for (const name of entries) {
      const file = path.join(search.dir, name);
      let st;
      try { st = statSync(file); } catch { continue; }
      bounds.filesSeen += 1;
      if (st.mtimeMs < cutoff) { bounds.droppedByAge += 1; continue; }
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

/** Whether any bound actually bit, and which. Null when the scan was complete. */
export function boundsReport(bounds) {
  const hit = [];
  if (bounds.droppedByAge) hit.push(`${bounds.droppedByAge} transcript(s) older than the window`);
  if (bounds.droppedByCount) hit.push(`${bounds.droppedByCount} transcript(s) beyond the file limit`);
  if (bounds.truncated) hit.push(`${bounds.truncated} transcript(s) truncated at the byte limit`);
  if (!hit.length) return null;
  return `scan was bounded and this figure understates consumption: ${hit.join('; ')}`;
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
  let scanned = { filesSeen: 0, filesRead: 0, droppedByCount: 0, droppedByAge: 0, truncated: 0 };
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
