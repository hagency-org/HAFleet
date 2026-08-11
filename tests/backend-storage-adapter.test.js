import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJsonStorage } from '../lib/backend/storage-adapter.js';

/*
 * Every durable byte backend-v2.js writes goes through this module: agents.json,
 * messages.json, tasks.json, alerts.json, engagements.json, the message counter and
 * the deleted-agent tombstones (backend-v2.js:353-388, 2906-3025). It had no test
 * file at all.
 *
 * The reason it needs one is not that writing JSON is hard. It is that four separate
 * stores treat this module's RETURN VALUE as the definition of durability —
 * lib/task-store.js:81, lib/engagement-store.js and lib/alert-store.js all convert a
 * `false` into a thrown error and roll their in-memory state back. So `false` must
 * mean "the old bytes are still on disk", and `true` must mean "the new bytes are",
 * and the batching path deliberately breaks the second half of that. These tests pin
 * which is which, because a caller cannot tell from the signature.
 *
 * They also pin the two ways this module is allowed to lose data on purpose — the
 * batch window and the corrupt-file quarantine — because both are invisible to the
 * caller and both have a failure mode that looks like success.
 */

const roots = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    // A test may have left a directory unreadable; restore before removing.
    try { chmodSync(root, 0o700); } catch { /* already gone */ }
    try { chmodSync(path.join(root, 'data'), 0o700); } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function context({ ...options } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'storage-adapter-test-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const logged = { error: [], log: [] };
  const storage = createJsonStorage({
    dataDir,
    logger: {
      error: (m) => logged.error.push(String(m)),
      log: (m) => logged.log.push(String(m)),
    },
    ...options,
  });
  return { root, dataDir, storage, logged };
}

/** A storage whose batch timers fire only when a test says so. */
function batchedContext(options = {}) {
  const timers = [];
  const ctx = context({
    jsonWriteBatchWindowMs: 1000,
    batchedFiles: ['batched.json'],
    setTimeoutFn: (fn) => {
      const handle = { fn, cleared: false, unrefCalls: 0, unref() { this.unrefCalls += 1; return this; } };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => { if (handle) handle.cleared = true; },
    ...options,
  });
  return { ...ctx, timers, fireAll: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()) };
}

const read = (dataDir, name) => JSON.parse(readFileSync(path.join(dataDir, name), 'utf-8'));
const tmpLeftovers = (dataDir) => readdirSync(dataDir).filter((f) => f.includes('.tmp-'));

/*
 * Precondition for the one test that needs the directory fsync to fail while the
 * rename succeeds: a directory with write+execute but no read. Root ignores that, so
 * detect it rather than asserting an environment.
 */
const CAN_DENY_DIRECTORY_READ = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'storage-adapter-probe-'));
  try {
    chmodSync(probe, 0o300);
    let fd;
    try {
      fd = openSync(probe, 'r');
      return false;
    } catch {
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } finally {
    chmodSync(probe, 0o700);
    rmSync(probe, { recursive: true, force: true });
  }
})();

// ── construction and path composition ─────────────────────────────────
describe('createJsonStorage', () => {
  it('refuses to be constructed without a dataDir', () => {
    // Without the guard, path.join(undefined, name) throws inside the first write —
    // long after the caller believed storage was ready, and reported as a failed save
    // of a specific file rather than as a misconfigured backend.
    expect(() => createJsonStorage({})).toThrow(/dataDir is required/);
    expect(() => createJsonStorage({ dataDir: '' })).toThrow(/dataDir is required/);
  });

  it('keeps agent scratch data under an agents/ subtree of the data dir', () => {
    /*
     * backend-v2.js:4640 deletes agentDataPath(name) recursively when an agent is
     * removed. Its containment is therefore the difference between deleting one agent's
     * scratch directory and deleting something else.
     */
    const { dataDir, storage } = context();
    expect(storage.dataPath('agents.json')).toBe(path.join(dataDir, 'agents.json'));
    expect(storage.agentDataPath('alpha')).toBe(path.join(dataDir, 'agents', 'alpha'));
    expect(path.relative(dataDir, storage.agentDataPath('alpha')).startsWith('..')).toBe(false);
  });
});

// ── writeJsonAtomic ───────────────────────────────────────────────────
describe('writeJsonAtomic', () => {
  it('writes owner-only, leaves no temp file, and TIGHTENS the mode of a loose existing file', () => {
    /*
     * agents.json carries every agent's workspace path and launch environment, and
     * data/ sits in a shared runtime dir. Two things must hold:
     *  - the temp file is created 0o600 from the start, so there is no window in which
     *    a world-readable copy exists;
     *  - re-writing a file whose mode had drifted to 0o666 (an older release, a
     *    hand-edit, a restored backup) leaves it 0o600 rather than inheriting the loose
     *    mode, because the rename replaces the inode.
     * And no `.tmp-` litter, or a crash-loop fills the data dir with copies of it.
     */
    const { dataDir, storage } = context();
    expect(storage.writeJsonAtomic('fresh.json', { a: 1 })).toBe(true);
    expect(statSync(path.join(dataDir, 'fresh.json')).mode & 0o777).toBe(0o600);
    expect(tmpLeftovers(dataDir)).toEqual([]);

    writeFileSync(path.join(dataDir, 'loose.json'), '{"old":true}', { mode: 0o666 });
    chmodSync(path.join(dataDir, 'loose.json'), 0o666);
    expect(storage.writeJsonAtomic('loose.json', { a: 2 })).toBe(true);
    expect(statSync(path.join(dataDir, 'loose.json')).mode & 0o777).toBe(0o600);
    expect(read(dataDir, 'loose.json')).toEqual({ a: 2 });
  });

  it('round-trips through JSON.parse and stays human-readable', () => {
    // data/*.json is read by operators and by scripts/ during incidents. A single-line
    // dump of agents.json is not reviewable, and the 2-space indent is what every
    // existing fixture and every hand-edit assumes.
    const { dataDir, storage } = context();
    storage.writeJsonAtomic('shape.json', { b: [1, 2], a: { nested: true } });
    const raw = readFileSync(path.join(dataDir, 'shape.json'), 'utf-8');
    expect(raw).toContain('\n  "b"');
    expect(JSON.parse(raw)).toEqual({ b: [1, 2], a: { nested: true } });
  });

  it('returns false, keeps the OLD bytes, and cleans up when the write cannot land', () => {
    /*
     * The contract every store depends on: a `false` return means the previous state is
     * still the state on disk, so rolling back in memory restores agreement. If a failed
     * write had truncated or removed the target, the rollback would restore memory to a
     * state that no longer exists anywhere.
     */
    const { dataDir, storage, logged } = context();
    storage.writeJsonAtomic('keep.json', { v: 'old' });
    const readOnly = path.join(dataDir, 'ro');
    mkdirSync(readOnly);
    const roStorage = createJsonStorage({ dataDir: readOnly, logger: { error() {}, log() {} } });
    chmodSync(readOnly, 0o500);
    let result;
    try {
      result = roStorage.writeJsonAtomic('nope.json', { v: 1 });
    } finally {
      chmodSync(readOnly, 0o700);
    }
    expect(result).toBe(false);
    expect(existsSync(path.join(readOnly, 'nope.json'))).toBe(false);
    expect(tmpLeftovers(readOnly)).toEqual([]);
    // The unrelated file is untouched, and the failure was reported rather than swallowed.
    expect(read(dataDir, 'keep.json')).toEqual({ v: 'old' });
    expect(logged.error).toEqual([]);
  });

  it('deletes the temp file when serialisation fails after it was opened', () => {
    /*
     * The one failure that happens with the temp file already on disk: the data cannot
     * be serialised. JSON.stringify runs as the argument to writeFileSync, so the
     * sequence is open-temp, THEN throw — every earlier failure mode (a missing or
     * read-only directory) never gets a temp file created, so the cleanup path is
     * unreachable from them.
     *
     * Without the unlink, each attempt strands a `data/agents.json.tmp-<pid>-<ms>` file
     * with a distinct name. A caller retrying on a schedule — which is what the
     * heartbeat sweep does — fills the runtime data directory with them, and the litter
     * outlives the process that made it because nothing ever sweeps that pattern.
     *
     * Both inputs are realistic accidents rather than contrivances: a BigInt in a
     * runtime record, and a self-referential object graph assembled from agent state.
     */
    const { dataDir, storage } = context();
    const circular = { name: 'alpha' };
    circular.self = circular;
    expect(storage.writeJsonAtomic('agents.json', circular)).toBe(false);
    expect(storage.writeJsonAtomic('agents.json', { tokens: 10n })).toBe(false);
    expect(existsSync(path.join(dataDir, 'agents.json'))).toBe(false);
    expect(tmpLeftovers(dataDir)).toEqual([]);
    // The directory is genuinely clean, not merely free of the pattern we looked for.
    expect(readdirSync(dataDir)).toEqual([]);
    // And a well-formed write into the same slot still works afterwards.
    expect(storage.writeJsonAtomic('agents.json', { name: 'alpha' })).toBe(true);
  });

  it('names the file and the errno when a save fails', () => {
    /*
     * This log line is the only artefact of a failed persist that reaches an operator —
     * the stores turn `false` into a generic "persistence failed". Without the path and
     * the code, ENOSPC on the runtime volume and EACCES on one file look identical.
     */
    const errors = [];
    const storage = createJsonStorage({
      dataDir: '/definitely/not/a/real/dir',
      logger: { error: (m) => errors.push(String(m)), log() {} },
    });
    expect(storage.writeJsonAtomic('x.json', { a: 1 })).toBe(false);
    const line = errors.at(-1);
    expect(line).toContain('/definitely/not/a/real/dir/x.json');
    expect(line).toContain('[ENOENT]');
  });

  it.skipIf(!CAN_DENY_DIRECTORY_READ)(
    'reports FAILURE for a write whose rename already succeeded, when the directory fsync fails',
    () => {
      /*
       * DEFECT, characterised rather than endorsed. See lib/backend/storage-adapter.js:68-84.
       *
       * The sequence is: write temp, fsync temp, close, RENAME, then open the parent
       * directory and fsync it so the rename itself is durable. If only that last step
       * fails, the new bytes are already the file's contents — but the catch block
       * returns false, which every caller reads as "nothing was written".
       *
       * What that costs the product: lib/task-store.js:81 turns the false into
       * `persistence_failed` and restores its in-memory snapshot, so the API reports the
       * task was not created while tasks.json contains it. The task is invisible until a
       * restart, at which point it reappears — and the assignee was already notified
       * (backend-v2.js:10131). Memory and disk disagree in the one direction the
       * rollback machinery cannot detect.
       *
       * This test asserts what the code actually does, so that a future fix (report the
       * fsync failure without disowning a landed write) has a case that changes colour
       * and a reader has the mechanism written down.
       */
      const { dataDir, storage } = context();
      storage.writeJsonAtomic('durable.json', { v: 'old' });
      chmodSync(dataDir, 0o300); // write+execute: rename works, opening the dir to read does not
      let result;
      try {
        result = storage.writeJsonAtomic('durable.json', { v: 'new' });
      } finally {
        chmodSync(dataDir, 0o700);
      }
      expect(result).toBe(false);
      // ...and yet:
      expect(read(dataDir, 'durable.json')).toEqual({ v: 'new' });
      expect(tmpLeftovers(dataDir)).toEqual([]);
    },
  );
});

// ── loadJsonSync ──────────────────────────────────────────────────────
describe('loadJsonSync', () => {
  it('returns the fallback for a missing file WITHOUT quarantining anything', () => {
    /*
     * A fresh install has none of these files. Both halves matter: the fallback is what
     * lets the backend boot at all, and the absence of a `.corrupt-` file is what stops
     * a first boot from producing a dozen empty corruption reports and an error line per
     * file — which is how an operator learns to ignore the one that matters.
     */
    const { dataDir, storage, logged } = context();
    expect(storage.loadJsonSync('absent.json', { seeded: true })).toEqual({ seeded: true });
    expect(storage.loadJsonSync('absent-list.json', [])).toEqual([]);
    expect(readdirSync(dataDir)).toEqual([]);
    expect(logged.error).toEqual([]);
  });

  it('quarantines an unparseable file, PRESERVING its bytes, and boots on the fallback', () => {
    /*
     * The corrupt file is the only evidence of what went wrong — a half-written
     * agents.json says whether the process died mid-write or the volume filled. Moving
     * it aside instead of overwriting it in place is what keeps that evidence, and
     * returning the fallback is what keeps the backend from refusing to start.
     */
    const { dataDir, storage, logged } = context();
    const corrupt = '{"agents": {"alpha": ';
    writeFileSync(path.join(dataDir, 'agents.json'), corrupt);
    expect(storage.loadJsonSync('agents.json', {})).toEqual({});
    expect(existsSync(path.join(dataDir, 'agents.json'))).toBe(false);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('agents.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf-8')).toBe(corrupt);
    expect(logged.error.join('\n')).toMatch(/Failed to load JSON/);
    expect(logged.error.join('\n')).toMatch(/Backed up unreadable JSON file/);
  });

  it('quarantines each corrupt file separately even on a frozen clock', () => {
    // The backup name is `${file}.corrupt-${now()}`. Two files corrupted in the same
    // millisecond must not collide onto one name, or restoring an incident leaves you
    // with one of the two files and no way to know which.
    const { dataDir, storage } = context({ now: () => 1700000000000 });
    writeFileSync(path.join(dataDir, 'a.json'), 'nope');
    writeFileSync(path.join(dataDir, 'b.json'), 'also nope');
    storage.loadJsonSync('a.json', {});
    storage.loadJsonSync('b.json', {});
    expect(readdirSync(dataDir).sort())
      .toEqual(['a.json.corrupt-1700000000000', 'b.json.corrupt-1700000000000']);
  });

  it('still returns the fallback when the quarantine itself cannot be written', () => {
    /*
     * A read-only data dir is a real deployment state (a full volume, a bad mount). The
     * backend must still come up on fallbacks rather than throwing out of module
     * evaluation — a backend that will not start cannot report why.
     */
    const { dataDir, logged } = context();
    writeFileSync(path.join(dataDir, 'c.json'), 'nope');
    const storage = createJsonStorage({
      dataDir,
      logger: { error: (m) => logged.error.push(String(m)), log() {} },
    });
    chmodSync(dataDir, 0o500);
    let value;
    try {
      value = storage.loadJsonSync('c.json', { fell: 'back' });
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(value).toEqual({ fell: 'back' });
    expect(logged.error.join('\n')).toMatch(/Failed to backup unreadable JSON file/);
  });

  it('reads a valid file rather than the fallback', () => {
    // Bounds every case above: the fallback path must not be the only path that works.
    const { dataDir, storage } = context();
    writeFileSync(path.join(dataDir, 'good.json'), JSON.stringify({ real: 1 }));
    expect(storage.loadJsonSync('good.json', { real: 'fallback' })).toEqual({ real: 1 });
    expect(readdirSync(dataDir)).toEqual(['good.json']);
  });
});

// ── saveJson: which writes are durable and which are only queued ──────
describe('saveJson', () => {
  it('writes a NON-batched file straight through and reports the real result', () => {
    // Decoy first: `batched.json` is the configured batch name, so this proves the
    // batching decision is per-file rather than global. tasks.json, messages.json and
    // the tombstones all rely on landing immediately.
    const { dataDir, storage } = batchedContext();
    expect(storage.saveJson('tasks.json', [{ id: 't1' }])).toBe(true);
    expect(read(dataDir, 'tasks.json')).toEqual([{ id: 't1' }]);
    expect(storage.pendingJsonWrites.size).toBe(0);
  });

  it('returns TRUE for a batched file that is still only in memory', () => {
    /*
     * The one place this module's return value lies, and it does so deliberately. A
     * caller that treats `true` as durability is wrong for agents.json and
     * agent_runtime.json — which is exactly why backend-v2.js passes
     * `{ immediate: true }` for the message counter and the deleted-agent tombstones
     * (backend-v2.js:3089, 4571) and not for heartbeat churn.
     *
     * The assertion that carries the weight is `existsSync === false` immediately after
     * a `true` return.
     */
    const { dataDir, storage, fireAll } = batchedContext();
    expect(storage.saveJson('batched.json', { v: 1 })).toBe(true);
    expect(existsSync(path.join(dataDir, 'batched.json'))).toBe(false);
    expect(storage.pendingJsonWrites.has('batched.json')).toBe(true);
    fireAll();
    expect(read(dataDir, 'batched.json')).toEqual({ v: 1 });
    expect(storage.pendingJsonWrites.size).toBe(0);
  });

  it('bypasses batching entirely when the window is 0', () => {
    /*
     * Decoy first: the file IS in batchedFiles. tests/helpers/backend-test-runtime.js:91
     * sets AGENT_JSON_WRITE_BATCH_MS=0 so that every endpoint test's writes are
     * synchronous. If a 0 window fell through to setTimeout(fn, 0), every one of those
     * tests would race its own persistence and the whole suite would read as flaky.
     */
    const { dataDir, storage, timers } = batchedContext({ jsonWriteBatchWindowMs: 0 });
    expect(storage.saveJson('batched.json', { v: 1 })).toBe(true);
    expect(read(dataDir, 'batched.json')).toEqual({ v: 1 });
    expect(timers).toEqual([]);
  });

  it('coalesces repeated saves into ONE write of the LAST value', () => {
    /*
     * agents.json is rewritten on every agent heartbeat. Without coalescing the batch
     * window buys nothing — it would only delay each write, not remove any. The cleared
     * flag on the superseded timer is the mechanism; the single file write is the point.
     */
    const { dataDir, storage, timers, fireAll } = batchedContext();
    storage.saveJson('batched.json', { v: 1 });
    storage.saveJson('batched.json', { v: 2 });
    storage.saveJson('batched.json', { v: 3 });
    expect(timers).toHaveLength(3);
    expect(timers.slice(0, 2).every((t) => t.cleared)).toBe(true);
    expect(timers.at(-1).cleared).toBe(false);
    fireAll();
    expect(read(dataDir, 'batched.json')).toEqual({ v: 3 });
  });

  it('unrefs the batch timer so a queued write cannot outlive the process', () => {
    // backend-v2.js flushes pending writes on shutdown (backend-v2.js:12817). A live
    // 1s timer would hold the event loop open past that flush, so `hafleet stop` would
    // hang for a second on every queued file — and the CLI treats that as a failed stop.
    const { storage, timers } = batchedContext();
    storage.saveJson('batched.json', { v: 1 });
    expect(timers.at(-1).unrefCalls).toBe(1);
  });

  it('immediate:true leaves nothing queued and lands the NEW value, not the stale one', () => {
    /*
     * Shutdown and the message counter both rely on `immediate` meaning "the queue is
     * empty when this returns". The ordering matters too: a pending older snapshot is
     * flushed first, so the value on disk afterwards must be the new one — flushing
     * after the write would leave the stale snapshot as the final state, and
     * `.msg_counter` going backwards re-issues message ids that already exist.
     */
    const { dataDir, storage, timers } = batchedContext();
    storage.saveJson('batched.json', { v: 'stale' });
    expect(storage.saveJson('batched.json', { v: 'fresh' }, { immediate: true })).toBe(true);
    expect(read(dataDir, 'batched.json')).toEqual({ v: 'fresh' });
    expect(storage.pendingJsonWrites.size).toBe(0);
    // The superseded timer was cancelled, so it cannot fire the stale value later.
    expect(timers.every((t) => t.cleared)).toBe(true);
  });
});

describe('flushing', () => {
  it('reports success for a name with nothing pending', () => {
    // Shutdown iterates names it does not know the state of. A `false` for "nothing to
    // do" would be logged as a failed final write and would make a clean stop look dirty.
    const { storage } = batchedContext();
    expect(storage.flushPendingJsonWrite('never-written.json')).toBe(true);
  });

  it('propagates a real write failure out of a flush', () => {
    // The counterpart: when a queued write genuinely cannot land, the flush must say so,
    // or shutdown reports a clean stop over lost data.
    const root = mkdtempSync(path.join(os.tmpdir(), 'storage-adapter-test-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir);
    const timers = [];
    const storage = createJsonStorage({
      dataDir,
      jsonWriteBatchWindowMs: 1000,
      batchedFiles: ['batched.json'],
      setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeoutFn: () => {},
      logger: { error() {}, log() {} },
    });
    storage.saveJson('batched.json', { v: 1 });
    chmodSync(dataDir, 0o500);
    let result;
    try {
      result = storage.flushPendingJsonWrite('batched.json');
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(result).toBe(false);
  });

  it('flushes every pending file, and a timer that fires afterwards writes nothing', () => {
    /*
     * The shutdown sequence. Two batched names are queued, flushAll writes both, and
     * then a timer that was already scheduled fires — as it will, because the flush does
     * not and cannot cancel a callback the runtime has already dequeued. If that late
     * callback re-wrote its captured snapshot it would overwrite the final state with a
     * stale one, which is a data loss that only ever happens during a clean shutdown.
     */
    const { dataDir, storage, timers } = batchedContext({ batchedFiles: ['one.json', 'two.json'] });
    storage.saveJson('one.json', { v: 1 });
    storage.saveJson('two.json', { v: 2 });
    storage.flushAllPendingJsonWrites();
    expect(read(dataDir, 'one.json')).toEqual({ v: 1 });
    expect(read(dataDir, 'two.json')).toEqual({ v: 2 });
    expect(storage.pendingJsonWrites.size).toBe(0);

    // Land a newer value the direct way, then let the already-scheduled timer fire.
    storage.writeJsonAtomic('one.json', { v: 'final' });
    timers.forEach((t) => t.fn());
    expect(read(dataDir, 'one.json')).toEqual({ v: 'final' });
  });
});

// ── loadJsonlTailSync ─────────────────────────────────────────────────
describe('loadJsonlTailSync', () => {
  const jsonl = (dataDir, name, lines) => {
    const file = path.join(dataDir, name);
    writeFileSync(file, lines.join('\n'));
    return file;
  };

  it('returns an empty list for a missing or blank log rather than throwing', () => {
    // backend-v2.js:3213 seeds the subconscious event history from this at module
    // evaluation time. A throw here is a backend that will not start because a
    // best-effort log file is absent.
    const { dataDir, storage } = context();
    expect(storage.loadJsonlTailSync(path.join(dataDir, 'nope.jsonl'))).toEqual([]);
    expect(storage.loadJsonlTailSync(jsonl(dataDir, 'blank.jsonl', ['', '  ', '']))).toEqual([]);
    // A directory where a file was expected must also degrade, not throw.
    expect(storage.loadJsonlTailSync(dataDir)).toEqual([]);
  });

  it('keeps the NEWEST rows when the log is longer than the limit', () => {
    /*
     * The rows to keep are at the END of the file, and the interesting ones are put
     * FIRST here so a missing tail slice would change the answer rather than merely
     * pad it. Dropping the newest rows instead of the oldest is the failure that would
     * make the console show a stale event log on a busy deployment and look correct.
     */
    const { dataDir, storage } = context();
    const file = jsonl(dataDir, 'ev.jsonl', Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i })));
    expect(storage.loadJsonlTailSync(file, 3)).toEqual([{ n: 7 }, { n: 8 }, { n: 9 }]);
    // Order within the tail is file order, oldest-to-newest.
    expect(storage.loadJsonlTailSync(file, 100).map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('treats a limit of 0 or a negative limit as ONE row, never as unbounded', () => {
    /*
     * `Math.max(1, limit)`. A 0 that meant "no limit" would load an append-only log of
     * unbounded size into memory during module evaluation — the log this reads
     * (SUBCONSCIOUS_EVENT_LOG) grows for the life of the deployment.
     */
    const { dataDir, storage } = context();
    const file = jsonl(dataDir, 'ev.jsonl', ['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(storage.loadJsonlTailSync(file, 0)).toEqual([{ n: 3 }]);
    expect(storage.loadJsonlTailSync(file, -5)).toEqual([{ n: 3 }]);
  });

  it('skips an unparseable line and keeps the ones around it', () => {
    /*
     * A JSONL log written by a process that was killed mid-line always ends in a partial
     * record. Losing the whole history to one bad line would throw away every event that
     * preceded the crash — which is the history an operator wants after a crash.
     * The bad line is FIRST so a guard that bailed on the first failure would return
     * nothing and be visible here.
     */
    const { dataDir, storage } = context();
    const file = jsonl(dataDir, 'ev.jsonl', ['{"partial": ', '{"n":2}', 'not json at all', '{"n":4}']);
    expect(storage.loadJsonlTailSync(file, 10)).toEqual([{ n: 2 }, { n: 4 }]);
  });

  it('drops scalar rows, which are not events', () => {
    // `parsed && typeof parsed === 'object'`. A log line of `null`, `5` or `"text"` is
    // valid JSON, and admitting it would put a value with no `ts` and no `type` into the
    // event history that every consumer then reads fields off.
    const { dataDir, storage } = context();
    const file = jsonl(dataDir, 'ev.jsonl', ['null', '5', '"text"', 'true', '{"n":1}']);
    expect(storage.loadJsonlTailSync(file, 10)).toEqual([{ n: 1 }]);
  });
});
