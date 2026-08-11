import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';

export function createJsonStorage({
  dataDir,
  jsonWriteBatchWindowMs = 1000,
  batchedFiles = ['agents.json', 'agent_runtime.json'],
  now = Date.now,
  processId = process.pid,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const jsonBatchedFiles = new Set(batchedFiles);
  const pendingJsonWrites = new Map(); // name -> { data, timer }

  function dataPath(name) {
    return path.join(dataDir, name);
  }

  function agentDataPath(name) {
    return dataPath(path.join('agents', name));
  }

  function backupUnreadableJson(filePath) {
    const backupPath = `${filePath}.corrupt-${now()}`;
    try {
      renameSync(filePath, backupPath);
      logger.error(`Backed up unreadable JSON file: ${filePath} -> ${backupPath}`);
    } catch (backupErr) {
      logger.error(`Failed to backup unreadable JSON file ${filePath}: ${backupErr.message}`);
    }
  }

  function loadJsonSync(name, fallback) {
    const filePath = dataPath(name);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      /*
       * A file containing literal `null` parses successfully, so the fallback never
       * applied and `null` was handed to the caller. `backend-v2.js:2914` does
       * `loadJsonSync('agents.json', {})` and then `Object.values(agents)`, which throws
       * "Cannot convert undefined or null to object" — the backend does not start.
       *
       * Reachable rather than theoretical: `saveJson(name, null)` writes exactly that.
       *
       * Only null and undefined are replaced. A stored `false`, `0` or `""` is a value
       * somebody wrote on purpose, and substituting the fallback for those would lose data
       * rather than protect against it.
       */
      if (parsed === null || parsed === undefined) {
        logger.error(`JSON file ${filePath} contains null. Using fallback value.`);
        return fallback;
      }
      return parsed;
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        logger.error(`Failed to load JSON ${filePath}: ${e.message}. Using fallback value.`);
        backupUnreadableJson(filePath);
      }
      return fallback;
    }
  }

  /*
   * The return value answers exactly one question: is the caller's data now the content of
   * the target file? Callers roll back in-memory state on false (engagement-store's
   * commit/rollback pair does precisely this), so a false for a write that LANDED leaves
   * memory disagreeing with disk — the API reports the task was not created while
   * `tasks.json` contains it. That is worse than either outcome reported honestly.
   *
   * `renameSync` is the instant the answer flips from no to yes. Everything before it is
   * scratch work on a temp file; everything after it is DURABILITY hardening — the
   * directory fsync makes the rename survive a power cut, and it can fail on its own
   * (EACCES on the directory, ENOTSUP on filesystems that refuse fsync on a dirfd, EIO)
   * without unmaking the rename.
   *
   * So a post-rename failure is reported as what it is: the write is visible to every
   * reader including this process, and its durability across a crash is unproven. Logged at
   * error level because an operator on such a filesystem should know their writes are not
   * crash-safe; returned as true because the data is there and pretending otherwise
   * corrupts the caller's state.
   */
  function writeJsonAtomic(name, data) {
    const target = dataPath(name);
    const tmp = `${target}.tmp-${processId}-${now()}`;
    let fd = null;
    let landed = false;
    try {
      fd = openSync(tmp, 'w', 0o600);
      writeFileSync(fd, JSON.stringify(data, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, target);
      landed = true;
      const directoryFd = openSync(path.dirname(target), 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      return true;
    } catch (e) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      // Only when the rename did NOT happen. After it, `tmp` is the target's old inode name
      // and no longer exists; unlinking is a no-op, but the intent matters if that changes.
      if (!landed) {
        try { unlinkSync(tmp); } catch {}
      }
      const code = e?.code || 'unknown';
      const msg = e?.message || 'unknown error';
      if (landed) {
        logger.error(
          `Saved JSON ${target} but could not fsync its directory: [${code}] ${msg}. `
          + 'The data is written and readable; it may not survive a power loss.',
        );
        return true;
      }
      logger.error(`Failed to save JSON ${target}: [${code}] ${msg}`);
      return false;
    }
  }

  function flushPendingJsonWrite(name) {
    const entry = pendingJsonWrites.get(name);
    if (!entry) return true;
    if (entry.timer) clearTimeoutFn(entry.timer);
    pendingJsonWrites.delete(name);
    return writeJsonAtomic(name, entry.data);
  }

  function scheduleJsonWrite(name, data) {
    const existing = pendingJsonWrites.get(name);
    if (existing?.timer) clearTimeoutFn(existing.timer);
    const entry = { data, timer: null };
    entry.timer = setTimeoutFn(() => {
      flushPendingJsonWrite(name);
    }, jsonWriteBatchWindowMs);
    if (typeof entry.timer?.unref === 'function') entry.timer.unref();
    pendingJsonWrites.set(name, entry);
    return true;
  }

  function saveJson(name, data, options = {}) {
    if (options?.immediate === true) {
      flushPendingJsonWrite(name);
      return writeJsonAtomic(name, data);
    }
    if (!jsonBatchedFiles.has(name) || jsonWriteBatchWindowMs <= 0) {
      return writeJsonAtomic(name, data);
    }
    return scheduleJsonWrite(name, data);
  }

  function flushAllPendingJsonWrites() {
    for (const name of [...pendingJsonWrites.keys()]) {
      flushPendingJsonWrite(name);
    }
  }

  function loadJsonlTailSync(filePath, limit = 2000) {
    try {
      if (!existsSync(filePath)) return [];
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) return [];
      const rows = raw.trim().split('\n');
      const tail = rows.slice(-Math.max(1, limit));
      const out = [];
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') out.push(parsed);
        } catch {}
      }
      return out;
    } catch {
      return [];
    }
  }

  return {
    dataPath,
    agentDataPath,
    backupUnreadableJson,
    loadJsonSync,
    writeJsonAtomic,
    flushPendingJsonWrite,
    scheduleJsonWrite,
    saveJson,
    flushAllPendingJsonWrites,
    loadJsonlTailSync,
    pendingJsonWrites,
  };
}
