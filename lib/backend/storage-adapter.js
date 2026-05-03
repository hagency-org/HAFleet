import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
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
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        logger.error(`Failed to load JSON ${filePath}: ${e.message}. Using fallback value.`);
        backupUnreadableJson(filePath);
      }
      return fallback;
    }
  }

  function writeJsonAtomic(name, data) {
    const target = dataPath(name);
    const tmp = `${target}.tmp-${processId}-${now()}`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, target);
      return true;
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      const code = e?.code || 'unknown';
      const msg = e?.message || 'unknown error';
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
