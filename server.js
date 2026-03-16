import express from 'express';
import { readFile as readFileAsync, open, stat as statAsync, appendFile } from 'fs/promises';
import { writeFileSync, readFileSync, existsSync, mkdirSync, lstatSync, rmSync, unlinkSync, readdirSync } from 'fs';
import { execFileSync, execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { defaultAgentchatHomeDir, resolveAgentDocsPaths, resolveV1ManifestForAgent } from './lib/agent-home-v1.js';
import { assertRuntimeDir } from './lib/runtime-dir-guard.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.AGENT_CHAT_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
assertRuntimeDir(RUNTIME_ROOT);
const LOGS_ROOT = path.join(RUNTIME_ROOT, 'logs');
const DATA_ROOT = path.join(RUNTIME_ROOT, 'data');
const DEFAULT_WEB_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_WEB_PORT || '8084', 10);
const PORT = Number.isFinite(DEFAULT_WEB_PORT_RAW) && DEFAULT_WEB_PORT_RAW > 0
  ? DEFAULT_WEB_PORT_RAW
  : 8084;
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const LOG_FILE = path.join(LOGS_ROOT, 'messages.jsonl');
const AGENT_DOWN_BIN = path.join(REPO_ROOT, 'bin', 'agent-down');
const BACKEND_V2_URL = (process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).trim().replace(/\/$/, '');
const PUSH_DELIVERED_URL = `${BACKEND_V2_URL}/api/runtime/push-delivered`;
const BACKEND_API_TOKEN = (process.env.API_TOKEN || '').trim();
function backendFetch(url, opts = {}) {
  const headers = { ...opts.headers };
  if (BACKEND_API_TOKEN) headers['Authorization'] = `Bearer ${BACKEND_API_TOKEN}`;
  return fetch(url, { ...opts, headers });
}
const DEFAULT_IDLE_THRESHOLD_MS = 20_000;
const envIdleThreshold = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || `${DEFAULT_IDLE_THRESHOLD_MS}`, 10);
const IDLE_THRESHOLD = Number.isFinite(envIdleThreshold) && envIdleThreshold > 0
  ? envIdleThreshold
  : DEFAULT_IDLE_THRESHOLD_MS;
const IDLE_THRESHOLD_SEC = Math.max(1, Math.ceil(IDLE_THRESHOLD / 1000));
const execFileAsync = promisify(execFile);
let execFileAsyncImpl = execFileAsync;
mkdirSync(DATA_ROOT, { recursive: true });
mkdirSync(LOGS_ROOT, { recursive: true });
mkdirSync(path.join(DATA_ROOT, 'agents'), { recursive: true });

// ── Local server identity ───
function isLocalAgentServer(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const localServerId = String(process.env.AGENT_CHAT_SERVER || 'local').trim() || 'local';
  return !raw || raw === 'local' || raw === localServerId;
}

// ── Server SSH config for remote tmux capture ────────────────────────
const SERVER_SSH_PATH = path.join(DATA_ROOT, 'server-ssh.json');
function loadServerSsh() {
  try {
    if (!existsSync(SERVER_SSH_PATH)) return {};
    return JSON.parse(readFileSync(SERVER_SSH_PATH, 'utf-8'));
  } catch { return {}; }
}
let serverSshConfig = loadServerSsh();

const app = express();

// ── API: fetch all messages (optionally filtered by since=timestamp) ─
app.get('/api/messages', async (req, res) => {
  const since = Number(req.query.since) || 0;
  try {
    const raw = await readFileAsync(LOG_FILE, 'utf-8');
    const msgs = raw.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    res.json(since ? msgs.filter((m) => m.ts > since) : msgs);
  } catch {
    res.json([]);
  }
});

// ── SSE: live stream of new messages ─────────────────────────────────
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(msg) {
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of sseClients) c.write(frame);
}

// ── Tail log file for new entries ────────────────────────────────────
let fileOffset = 0;
try {
  const raw = await readFileAsync(LOG_FILE, 'utf-8').catch(() => '');
  fileOffset = Buffer.byteLength(raw, 'utf-8');
} catch { /* file may not exist yet */ }

setInterval(async () => {
  try {
    const fh = await open(LOG_FILE, 'r');
    try {
      const fstat = await fh.stat();
      if (fstat.size < fileOffset) fileOffset = 0; // truncated
      if (fstat.size <= fileOffset) return;
      const buf = Buffer.alloc(fstat.size - fileOffset);
      await fh.read(buf, 0, buf.length, fileOffset);
      fileOffset = fstat.size;

      const lines = buf.toString('utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { broadcast(JSON.parse(line)); } catch { /* skip */ }
      }
    } finally {
      await fh.close();
    }
  } catch { /* ignore - file may not exist */ }
}, 500);

// ── Message Queue with Idle Detection ────────────────────────────────
const POLL_INTERVAL  = 1_000;  // check every 1s
const REMINDER_MERGE_PREVIEW_LIMIT = Math.max(1, Number.parseInt(process.env.REMINDER_MERGE_PREVIEW_LIMIT || '20', 10));

app.use(express.json());

// Queue: Map<target, Array<{id, from, to, payload, queuedAt}>>
const QUEUE_FILE = path.join(LOGS_ROOT, 'queue.json');
const QUEUE_DROPPED_FILE = path.join(LOGS_ROOT, 'queue-dropped.jsonl');
const queue = new Map();
let queueIdCounter = 0;
let queueTickRunning = false;

function isBackendNotificationEntry(entry) {
  if (!entry || entry.from !== 'agent-chat-v2') return false;
  return typeof entry.payload === 'string' && entry.payload.startsWith('[NOTIFICATION]');
}

function targetSessionName(target) {
  if (typeof target !== 'string' || !target) return null;
  return target.split(':')[0] || null;
}

function dropQueuedBackendNotificationsBySource(agentName, sourceMsgId = null) {
  const normalizedAgent = typeof agentName === 'string' ? agentName.trim() : '';
  if (!normalizedAgent) return 0;
  const sourceId = typeof sourceMsgId === 'string' ? sourceMsgId.trim() : '';
  let removed = 0;

  for (const [target, entries] of queue) {
    const session = targetSessionName(target);
    if (session !== normalizedAgent) continue;

    const kept = [];
    for (const entry of entries) {
      const isNotification = isBackendNotificationEntry(entry);
      const entrySource = (entry?.notifyMeta && typeof entry.notifyMeta.sourceMsgId === 'string')
        ? entry.notifyMeta.sourceMsgId.trim()
        : '';
      const matchesSource = sourceId ? entrySource === sourceId : true;
      if (isNotification && matchesSource) {
        removed++;
        continue;
      }
      kept.push(entry);
    }

    if (kept.length === 0) queue.delete(target);
    else queue.set(target, kept);
  }

  if (removed > 0) {
    saveQueue();
    broadcastQueue();
  }
  return removed;
}

function sanitizeNotifyMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') return null;
  const safeBool = (value) => value === true;
  const safeInt = (value) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  const safeStr = (value, fallback = null) => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
  };
  return {
    kind: safeStr(rawMeta.kind, 'unknown'),
    priority: normalizeQueuePriority(rawMeta.priority),
    requiresInboxCheck: safeBool(rawMeta.requiresInboxCheck),
    sourceMsgId: safeStr(rawMeta.sourceMsgId, null),
    unreadCount: safeInt(rawMeta.unreadCount),
    hasHumanUnread: safeBool(rawMeta.hasHumanUnread),
    hasRequestUnread: safeBool(rawMeta.hasRequestUnread),
    needsReply: safeBool(rawMeta.needsReply),
    hasMcp: safeBool(rawMeta.hasMcp),
  };
}

function normalizeQueuePriority(value) {
  if (typeof value !== 'string') return 'normal';
  const priority = value.trim().toLowerCase();
  if (priority === 'high' || priority === 'urgent') return priority;
  return 'normal';
}

async function notifyPushDelivered(entry, deliveredAt) {
  if (!entry || !isBackendNotificationEntry(entry)) return;
  const agent = targetSessionName(entry.to);
  if (!agent) return;
  const notifyMeta = sanitizeNotifyMeta(entry.notifyMeta) || { kind: 'unknown', requiresInboxCheck: false };
  const body = {
    agent,
    deliveredAt,
    queuedAt: Number(entry.queuedAt) || deliveredAt,
    queueEntryId: Number(entry.id) || null,
    notifyMeta,
  };
  try {
    const resp = await backendFetch(PUSH_DELIVERED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[push-delivered] backend rejected ${agent}: HTTP ${resp.status}${errText ? ` ${errText.slice(0, 120)}` : ''}`);
    }
  } catch (e) {
    console.warn(`[push-delivered] notify failed for ${agent}: ${e.message}`);
  }
}

async function fetchUnreadSnapshot(agentName) {
  if (!agentName) return null;
  try {
    const res = await backendFetch(`${BACKEND_V2_URL}/api/inbox/${encodeURIComponent(agentName)}/unread`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function isStaleNotificationBySnapshot(entry, snapshot) {
  if (!isBackendNotificationEntry(entry) || !snapshot) return false;
  const unreadTotal = Number(snapshot?.unread_total || 0);
  if (unreadTotal === 0) return true;
  const recordedUnread = Number(entry?.notifyMeta?.unreadCount || 0);
  // If unread has dropped since this notification was queued, the queued count is stale.
  // Drop and wait for a fresh notification based on current unread state.
  if (recordedUnread > 0 && unreadTotal < recordedUnread) return true;
  return false;
}

async function isStaleNotificationEntry(entry) {
  if (!isBackendNotificationEntry(entry)) return false;
  const agentName = targetSessionName(entry.to);
  const snapshot = await fetchUnreadSnapshot(agentName);
  return isStaleNotificationBySnapshot(entry, snapshot);
}

function archiveDroppedQueueEntries(entries, reason, target) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const now = Date.now();
  const lines = entries.map((entry) => JSON.stringify({
    ts: now,
    reason,
    target,
    entry,
  }));
  appendFile(QUEUE_DROPPED_FILE, lines.join('\n') + '\n').catch(() => {});
}

function mergeReminderEntryItems(targetEntry, sourceEntry) {
  const existing = normalizeReminderItems(targetEntry);
  const incoming = normalizeReminderItems(sourceEntry);
  const items = existing.concat(incoming);
  targetEntry.reminderItems = items;
  targetEntry.reminderCount = items.length;
  targetEntry.payload = renderReminderPayload(items);
}

function compactReminderEntriesInBucket(entries) {
  if (!Array.isArray(entries) || entries.length <= 1) return { changed: false, entries: entries || [] };

  const compacted = [];
  let changed = false;
  let currentMergedReminder = null;

  for (const entry of entries) {
    if (entry?.isReminder === true) {
      if (currentMergedReminder) {
        mergeReminderEntryItems(currentMergedReminder, entry);
        changed = true;
      } else {
        const normalized = { ...entry };
        const items = normalizeReminderItems(entry);
        normalized.reminderItems = items;
        normalized.reminderCount = items.length;
        normalized.payload = renderReminderPayload(items);
        compacted.push(normalized);
        currentMergedReminder = normalized;
      }
      continue;
    }

    compacted.push(entry);
    currentMergedReminder = null;
  }

  return { changed, entries: compacted };
}

function compactReminderQueue() {
  let changed = false;
  let mergedEntries = 0;
  for (const [target, entries] of queue) {
    const before = entries.length;
    const result = compactReminderEntriesInBucket(entries);
    if (!result.changed) continue;
    queue.set(target, result.entries);
    changed = true;
    mergedEntries += Math.max(0, before - result.entries.length);
  }
  return { changed, mergedEntries };
}

function normalizeReminderQueue() {
  let changed = false;
  for (const [, entries] of queue) {
    for (const entry of entries) {
      if (entry?.isReminder !== true) continue;
      const items = normalizeReminderItems(entry);
      const payload = renderReminderPayload(items);
      const count = items.length;
      if (!Array.isArray(entry.reminderItems) || entry.reminderCount !== count || entry.payload !== payload) {
        entry.reminderItems = items;
        entry.reminderCount = count;
        entry.payload = payload;
        changed = true;
      }
    }
  }
  return changed;
}

// Persist queue to disk
function saveQueue() {
  const items = [];
  for (const [, entries] of queue) items.push(...entries);
  try {
    writeFileSync(QUEUE_FILE, JSON.stringify({ idCounter: queueIdCounter, items }));
  } catch (e) {
    console.debug(`[server] queue save skipped: ${e.message}`);
  }
}

// Load queue from disk on startup
try {
  const raw = await readFileAsync(QUEUE_FILE, 'utf-8');
  const data = JSON.parse(raw);
  queueIdCounter = data.idCounter || 0;
  for (const entry of (data.items || [])) {
    if (!queue.has(entry.to)) queue.set(entry.to, []);
    queue.get(entry.to).push(entry);
  }
  const compacted = compactReminderQueue();
  const normalized = normalizeReminderQueue();
  if (compacted.changed || normalized) {
    saveQueue();
    if (compacted.changed) {
      console.log(`Compacted reminder queue entries on load: merged ${compacted.mergedEntries}`);
    }
    if (normalized) {
      console.log('Normalized reminder queue payloads on load');
    }
  }
  console.log(`Restored ${data.items?.length || 0} queued messages from disk`);
} catch (e) {
  console.debug(`[server] queue load skipped: ${e.message}`);
}

// Accept queued message from agent-send
app.post('/api/queue', (req, res) => {
  const { from, to, payload } = req.body;
  if (!to || !payload) return res.status(400).json({ error: 'missing to or payload' });
  const id = ++queueIdCounter;
  const queuedAt = Date.now();
  const priority = normalizeQueuePriority(req.body?.priority);
  // Apply redirect if target was renamed
  let actualTo = to;
  let redirectedFrom = null;
  if (redirects.has(to)) {
    actualTo = redirects.get(to);
    redirectedFrom = to;
  }
  const entry = { id, from: from || 'unknown', to: actualTo, payload, queuedAt, priority };
  const notifyMeta = sanitizeNotifyMeta(req.body?.notifyMeta);
  if (notifyMeta) entry.notifyMeta = notifyMeta;
  if (redirectedFrom) entry.redirectedFrom = redirectedFrom;
  if (!queue.has(actualTo)) queue.set(actualTo, []);
  const bucket = queue.get(actualTo);
  if (isBackendNotificationEntry(entry)) {
    // Keep only the latest backend notification per target to avoid stale prompts.
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (isBackendNotificationEntry(bucket[i])) bucket.splice(i, 1);
    }
  }
  bucket.push(entry);
  saveQueue();
  broadcastQueue();
  res.json({ ok: true, id, queuedAt, position: bucket.length, redirected: redirectedFrom || undefined });
});

// Get current queue state
app.get('/api/queue', (_req, res) => {
  res.json(queueSnapshot());
});

// Delete a queued message by id
app.delete('/api/queue/:id', (req, res) => {
  const id = Number(req.params.id);
  for (const [target, entries] of queue) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx !== -1) {
      entries.splice(idx, 1);
      if (entries.length === 0) queue.delete(target);
      saveQueue();
      broadcastQueue();
      return res.json({ ok: true, deleted: id });
    }
  }
  res.status(404).json({ error: 'not found' });
});

// Force-send a queued message immediately (skip idle wait)
app.post('/api/queue/:id/send', async (req, res) => {
  const id = Number(req.params.id);
  for (const [target, entries] of queue) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx !== -1) {
      const entry = entries.splice(idx, 1)[0];
      if (entries.length === 0) queue.delete(target);
      saveQueue();
      broadcastQueue();
      if (await isStaleNotificationEntry(entry)) {
        archiveDroppedQueueEntries([entry], 'stale-notification-manual-send', target);
        return res.json({ ok: true, dropped: id, reason: 'stale-notification' });
      }
      const ok = await deliverMessage(entry);
      if (!ok) {
        // Keep behavior consistent with poll loop: failed delivery is retriable, not lost.
        if (!queue.has(target)) queue.set(target, []);
        queue.get(target).unshift(entry);
        saveQueue();
        broadcastQueue();
        return res.status(503).json({ ok: false, delivered: id, requeued: true, reason: 'deliver-failed' });
      }
      return res.json({ ok: true, delivered: id });
    }
  }
  res.status(404).json({ error: 'not found' });
});

// Debug: expose idle state for all tracked panes
app.get('/api/idle', (_req, res) => {
  const now = Date.now();
  const result = {};
  for (const [target, snap] of paneSnapshots) {
    result[target] = { idleMs: now - snap.changedAt, idleSec: Math.floor((now - snap.changedAt) / 1000), hash: snap.hash.slice(0, 8) };
  }
  res.json(result);
});

// ── Agent status (for dashboard monitor) ─────────────────────────────
app.get('/api/agents/status', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents`);
    const agentList = await r.json();
    const result = agentList
      .filter(a => a.tmux)
      .map(a => {
        const isRemote = !isLocalAgentServer(a.server);
        if (isRemote) {
          // Skip pane probing for remote agents — they have no local tmux panes
          return {
            name: a.name, tmux: a.tmux, idleMs: -1, active: false,
            activeNow: typeof a.activeNow === 'boolean' ? a.activeNow : false,
            activeDurationSec: Number.isFinite(Number(a.activeDurationSec)) ? Math.max(0, Number(a.activeDurationSec)) : 0,
            idleDurationSec: Number.isFinite(Number(a.idleDurationSec)) ? Math.max(0, Number(a.idleDurationSec)) : 0,
            lastTmuxActivitySec: Number.isFinite(Number(a.lastTmuxActivitySec)) ? Math.max(0, Number(a.lastTmuxActivitySec)) : 0,
            alive: true, remote: true, type: a.type || 'agent', server: a.server || null, environment: a.environment || 'live',
          };
        }
        const idleMs = getPaneIdleMs(a.tmux);
        const alive = idleMs >= 0;
        const runtimeActiveNow = typeof a.activeNow === 'boolean' ? a.activeNow : null;
        const runtimeActiveDurationSec = Number.isFinite(Number(a.activeDurationSec)) ? Math.max(0, Number(a.activeDurationSec)) : 0;
        const runtimeIdleDurationSec = Number.isFinite(Number(a.idleDurationSec)) ? Math.max(0, Number(a.idleDurationSec)) : 0;
        const computedActive = alive && idleMs >= 0 ? idleMs < IDLE_THRESHOLD : false;
        const activeNow = runtimeActiveNow !== null ? runtimeActiveNow : computedActive;
        return {
          name: a.name,
          tmux: a.tmux,
          idleMs,
          active: activeNow,
          activeNow,
          activeDurationSec: runtimeActiveDurationSec,
          idleDurationSec: runtimeIdleDurationSec,
          lastTmuxActivitySec: Number.isFinite(Number(a.lastTmuxActivitySec))
            ? Math.max(0, Number(a.lastTmuxActivitySec))
            : 0,
          alive,
          remote: false,
          type: a.type || 'agent',
          server: a.server || null,
          environment: a.environment || 'live',
        };
      });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'backend-v2 unreachable', detail: e.message });
  }
});

// ── Tmux capture for agent monitor ───────────────────────────────────
function trimTrailingBlankLines(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

app.get('/api/tmux/capture/:session', async (req, res) => {
  const session = req.params.session;
  if (!/^[\w\-:.]+$/.test(session)) {
    return res.status(400).type('text').send('invalid session name');
  }
  const serverName = req.query.server || '';
  const sshConf = serverName ? serverSshConfig[serverName] : null;
  try {
    let rawContent;
    if (sshConf) {
      // Remote capture via SSH
      const { stdout } = await execFileAsync(
        'ssh', [
          '-o', 'ConnectTimeout=5',
          '-o', 'StrictHostKeyChecking=accept-new',
          sshConf.host,
          `tmux capture-pane -t ${session} -p -S -500`
        ],
        { encoding: 'utf-8', timeout: 8000 }
      );
      rawContent = stdout;
    } else {
      // Local capture
      const { stdout } = await execFileAsync(
        'tmux', ['capture-pane', '-t', session, '-p', '-S', '-500'],
        { encoding: 'utf-8', timeout: 3000 }
      );
      rawContent = stdout;
    }
    const content = trimTrailingBlankLines(rawContent);
    const etag = '"' + createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.type('text').send(content);
  } catch {
    const location = sshConf ? ` on ${serverName}` : '';
    res.status(404).type('text').send(`[session "${session}"${location} not found]`);
  }
});

// ── Agent detail (metadata + backend info) ───────────────────────────
const AGENTS_DATA_DIR = path.join(DATA_ROOT, 'agents');
const AGENTCHAT_HOMEDIR = defaultAgentchatHomeDir(process.env);
const PROGRESS_TAIL_LINE_LIMIT = 80;

function safeReadJsonSync(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadLocalAgentMeta(name) {
  const metaPath = path.join(AGENTS_DATA_DIR, name, 'meta.json');
  if (existsSync(metaPath)) return { metaPath, meta: safeReadJsonSync(metaPath) };
  // Case-insensitive fallback: scan AGENTS_DATA_DIR for a matching directory
  try {
    const lower = name.toLowerCase();
    const entries = readdirSync(AGENTS_DATA_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === lower) {
        const fallbackPath = path.join(AGENTS_DATA_DIR, entry.name, 'meta.json');
        if (existsSync(fallbackPath)) return { metaPath: fallbackPath, meta: safeReadJsonSync(fallbackPath) };
      }
    }
  } catch (e) {
    console.debug(`[server] local agent meta scan skipped for ${name}: ${e.message}`);
  }
  return { metaPath, meta: null };
}

function loadV1Manifest(name, localMeta = null) {
  const manifest = resolveV1ManifestForAgent(name, localMeta, process.env);
  if (manifest) return manifest;
  return null;
}

async function readTextFilePayload(filePath, options = {}) {
  const tailLines = Number(options.tailLines) > 0 ? Number(options.tailLines) : 0;
  if (!filePath) {
    return { exists: false, text: '', readError: null };
  }
  try {
    const text = await readFileAsync(filePath, 'utf-8');
    if (tailLines > 0) {
      const lines = text.split(/\r?\n/);
      return {
        exists: true,
        text: lines.slice(-tailLines).join('\n'),
        readError: null,
      };
    }
    return { exists: true, text, readError: null };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, text: '', readError: null };
    }
    return {
      exists: false,
      text: '',
      readError: String(error?.message || error),
    };
  }
}

async function buildAgentDocsPayload(agentName, workspacePath, v1Manifest = null) {
  const resolved = resolveAgentDocsPaths(agentName, workspacePath || AGENTCHAT_HOMEDIR, {
    cwd: REPO_ROOT,
    v1Manifest,
    includeWorkspaceFlatDocs: v1Manifest?.workdir ? true : false,
  });
  const progressPath = path.join(resolved.docsRoot, 'progress.md');
  const [agentsDoc, planDoc, progressDoc] = await Promise.all([
    readTextFilePayload(resolved.agentsPath),
    readTextFilePayload(resolved.planPath),
    readTextFilePayload(progressPath, { tailLines: PROGRESS_TAIL_LINE_LIMIT }),
  ]);
  return {
    docsRoot: resolved.docsRoot,
    agentsPath: resolved.agentsPath,
    planPath: resolved.planPath,
    progressPath,
    agents: agentsDoc,
    plan: planDoc,
    progress: {
      ...progressDoc,
      tailLines: PROGRESS_TAIL_LINE_LIMIT,
    },
  };
}

function writeV1Manifest(manifestPath, next) {
  const dir = path.dirname(manifestPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

function sanitizeManagedProjects(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name || '').trim();
    const projectPath = String(row.path || '').trim();
    if (!name || !projectPath) continue;
    const abs = path.resolve(projectPath);
    const source = String(row.source || 'unknown').trim() || 'unknown';
    const originPath = row.originPath ? path.resolve(String(row.originPath)) : null;
    const key = `${name}\n${abs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path: abs, source, originPath });
  }
  return out;
}

function syncLocalAgentMetaFromManifest(name, metaPath, localMeta, manifest, human = null) {
  if (!metaPath) return null;
  const nextHuman = (human && typeof human === 'object')
    ? human
    : ((manifest?.human && typeof manifest.human === 'object') ? manifest.human : {});
  const mergedMeta = {
    ...(localMeta && typeof localMeta === 'object' ? localMeta : {}),
    name,
    type: manifest?.type || (localMeta?.type || null),
    path: manifest?.workdir || (localMeta?.path || null),
    agentModelVersion: manifest?.agentModelVersion || '1.0',
    layoutVersion: Number(manifest?.layoutVersion) || 1,
    agentId: manifest?.id || null,
    homeDir: manifest?.homeDir || null,
    workdir: manifest?.workdir || null,
    stateDir: manifest?.stateDir || null,
    agentJsonPath: manifest?.agentJsonPath || (manifest?.homeDir ? path.join(manifest.homeDir, 'agent.json') : null),
    subconsciousEnabled: manifest?.subconsciousEnabled === true,
    managedProjects: Array.isArray(manifest?.managedProjects) ? manifest.managedProjects : [],
    human: nextHuman,
    task: normalizeTaskMeta(manifest?.task, name),
    runtimeProfile: normalizeRuntimeProfileMeta(manifest?.runtimeProfile),
  };
  mkdirSync(path.dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(mergedMeta, null, 2)}\n`, 'utf-8');
  return mergedMeta;
}

function normalizeHumanSyncMeta(value) {
  return {
    owner: normalizeMetaText(value?.owner, 256),
  };
}

function buildExpectedBackendAgentHomeState(name, manifest, human = null) {
  const nextHuman = (human && typeof human === 'object')
    ? human
    : ((manifest?.human && typeof manifest?.human === 'object') ? manifest.human : {});
  return {
    name,
    agentModelVersion: manifest?.agentModelVersion || '1.0',
    layoutVersion: Number(manifest?.layoutVersion) || 1,
    agentId: manifest?.id || null,
    homeDir: manifest?.homeDir || null,
    workdir: manifest?.workdir || null,
    stateDir: manifest?.stateDir || null,
    subconsciousEnabled: manifest?.subconsciousEnabled === true,
    managedProjects: Array.isArray(manifest?.managedProjects) ? sanitizeManagedProjects(manifest.managedProjects) : [],
    human: normalizeHumanSyncMeta(nextHuman),
    task: normalizeTaskMeta(manifest?.task, name),
    runtimeProfile: normalizeRuntimeProfileMeta(manifest?.runtimeProfile),
  };
}

function normalizeBackendAgentHomeState(agent, fallbackName = null) {
  if (!agent || typeof agent !== 'object') return null;
  return {
    name: normalizeMetaText(agent.name, 256) || normalizeMetaText(fallbackName, 256) || null,
    agentModelVersion: agent?.agentModelVersion || '1.0',
    layoutVersion: Number(agent?.layoutVersion) || 1,
    agentId: agent?.agentId || null,
    homeDir: agent?.homeDir || null,
    workdir: agent?.workdir || null,
    stateDir: agent?.stateDir || null,
    subconsciousEnabled: agent?.subconsciousEnabled === true,
    managedProjects: Array.isArray(agent?.managedProjects) ? sanitizeManagedProjects(agent.managedProjects) : [],
    human: normalizeHumanSyncMeta(agent?.human),
    task: normalizeTaskMeta(agent?.task, fallbackName),
    runtimeProfile: normalizeRuntimeProfileMeta(agent?.runtimeProfile),
  };
}

function summarizeBackendStateMismatches(expected, actual) {
  const fields = [
    'agentModelVersion',
    'layoutVersion',
    'agentId',
    'homeDir',
    'workdir',
    'stateDir',
    'subconsciousEnabled',
    'managedProjects',
    'human',
    'task',
    'runtimeProfile',
  ];
  const mismatches = [];
  for (const field of fields) {
    const expectedJson = JSON.stringify(expected?.[field] ?? null);
    const actualJson = JSON.stringify(actual?.[field] ?? null);
    if (expectedJson === actualJson) continue;
    mismatches.push({
      field,
      expected: expected?.[field] ?? null,
      actual: actual?.[field] ?? null,
    });
  }
  return mismatches;
}

async function syncBackendAgentHomeState(name, manifest, human = null) {
  const payload = buildExpectedBackendAgentHomeState(name, manifest, human);
  const summarizeFailure = async (res, mode, extra = {}) => {
    let detail = `${mode} ${res.status}`;
    try {
      const text = String(await res.text()).trim();
      if (text) detail = `${detail}: ${text.slice(0, 500)}`;
    } catch {
      // ignore response-body read failures
    }
    return {
      ok: false,
      status: 'failed',
      stale: true,
      method: mode,
      httpStatus: res.status,
      detail,
      ...extra,
    };
  };
  const verifyReadback = async (baseResult = {}) => {
    let readbackRes;
    try {
      readbackRes = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`);
    } catch (e) {
      return {
        ok: false,
        status: 'failed',
        stale: true,
        method: baseResult.method || 'readback',
        httpStatus: baseResult.httpStatus ?? null,
        patchStatus: baseResult.patchStatus,
        readbackStatus: null,
        detail: `readback fetch failed: ${e?.message || 'backend readback failed'}`,
      };
    }
    if (!readbackRes.ok) {
      return await summarizeFailure(readbackRes, baseResult.method || 'readback', {
        httpStatus: baseResult.httpStatus ?? null,
        patchStatus: baseResult.patchStatus,
        readbackStatus: readbackRes.status,
      });
    }
    let body = null;
    try {
      body = await readbackRes.json();
    } catch {
      return {
        ok: false,
        status: 'failed',
        stale: true,
        method: baseResult.method || 'readback',
        httpStatus: baseResult.httpStatus ?? null,
        patchStatus: baseResult.patchStatus,
        readbackStatus: readbackRes.status,
        detail: 'readback returned invalid json',
      };
    }
    const actual = normalizeBackendAgentHomeState(body, name);
    if (!actual) {
      return {
        ok: false,
        status: 'failed',
        stale: true,
        method: baseResult.method || 'readback',
        httpStatus: baseResult.httpStatus ?? null,
        patchStatus: baseResult.patchStatus,
        readbackStatus: readbackRes.status,
        detail: 'readback returned invalid agent payload',
      };
    }
    const mismatches = summarizeBackendStateMismatches(payload, actual);
    if (mismatches.length > 0) {
      return {
        ok: false,
        status: 'failed',
        stale: true,
        method: baseResult.method || 'readback',
        httpStatus: baseResult.httpStatus ?? null,
        patchStatus: baseResult.patchStatus,
        readbackStatus: readbackRes.status,
        mismatches,
        detail: `readback mismatch: ${mismatches.map(row => row.field).join(', ')}`,
      };
    }
    return {
      ok: true,
      status: baseResult.status || 'synced',
      stale: false,
      method: baseResult.method || 'readback',
      httpStatus: baseResult.httpStatus ?? null,
      patchStatus: baseResult.patchStatus,
      readbackStatus: readbackRes.status,
    };
  };
  try {
    const patchRes = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (patchRes.ok) {
      return await verifyReadback({
        status: 'synced',
        method: 'patch',
        httpStatus: patchRes.status,
      });
    }
    if (patchRes.status !== 404) {
      return await summarizeFailure(patchRes, 'patch');
    }
    const postRes = await backendFetch(`${BACKEND_V2_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (postRes.ok) {
      return await verifyReadback({
        status: 'created',
        method: 'post',
        httpStatus: postRes.status,
        patchStatus: patchRes.status,
      });
    }
    return await summarizeFailure(postRes, 'post', { patchStatus: patchRes.status });
  } catch (e) {
    return {
      ok: false,
      status: 'failed',
      stale: true,
      method: 'transport',
      httpStatus: null,
      detail: e?.message || 'backend sync failed',
    };
  }
}

function buildProjectsControlPayload(name, manifest) {
  const nextHuman = (manifest?.human && typeof manifest.human === 'object') ? manifest.human : {};
  return {
    ok: true,
    agent: name,
    writable: true,
    v1: true,
    projectRoot: manifest?.workdir ? path.join(manifest.workdir, 'projects') : null,
    manifestPath: manifest?.agentJsonPath || (manifest?.homeDir ? path.join(manifest.homeDir, 'agent.json') : null),
    managedProjects: Array.isArray(manifest?.managedProjects) ? manifest.managedProjects : [],
  };
}

function isSubpathOf(parentDir, candidatePath) {
  const parent = path.resolve(String(parentDir || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  if (!parent || !candidate) return false;
  const rel = path.relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function buildProvisionArgsForManifest(manifest, localMeta = null, options = {}) {
  const homeRoot = path.dirname(path.dirname(manifest.homeDir));
  const args = [
    path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js'),
    '--name', manifest.name,
    '--type', manifest.type || (localMeta?.type || 'claude'),
    '--agent-id', manifest.id,
    '--home', homeRoot,
    '--subconscious-enabled', manifest.subconsciousEnabled === true ? 'true' : 'false',
  ];
  if (options.projectPath) {
    args.push('--project', options.projectPath);
  }
  if (options.projectMode) {
    args.push('--project-mode', options.projectMode);
  }
  if (options.projectName) {
    args.push('--project-name', options.projectName);
  }
  return { args, homeRoot };
}

function runProvisionForManifest(manifest, localMeta = null, options = {}) {
  const { args, homeRoot } = buildProvisionArgsForManifest(manifest, localMeta, options);
  const stdout = execFileSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AGENTCHAT_HOMEDIR: homeRoot,
    },
    timeout: 30_000,
  });
  return JSON.parse(String(stdout || '{}'));
}

function buildWorkspaceEntryMigrationPayload(name, manifest, provisionPayload = null) {
  const workdir = manifest?.workdir || null;
  const docsDir = workdir ? path.join(workdir, 'docs') : null;
  return {
    ok: true,
    agent: name,
    manifestPath: manifest?.agentJsonPath || (manifest?.homeDir ? path.join(manifest.homeDir, 'agent.json') : null),
    workdir,
    rootClaudePath: workdir ? path.join(workdir, 'CLAUDE.md') : null,
    rootAgentsPath: workdir ? path.join(workdir, 'AGENTS.md') : null,
    docsClaudePath: docsDir ? path.join(docsDir, 'CLAUDE.md') : null,
    docsAgentsPath: docsDir ? path.join(docsDir, 'AGENTS.md') : null,
    workspaceSync: provisionPayload?.workspaceSync || null,
  };
}

function removeManagedProjectPath(projectPath) {
  if (!existsSync(projectPath)) return 'already-missing';
  const stat = lstatSync(projectPath);
  if (stat.isSymbolicLink()) {
    unlinkSync(projectPath);
    return 'unlinked';
  }
  if (stat.isDirectory()) {
    rmSync(projectPath, { recursive: true, force: false });
    return 'removed-directory';
  }
  unlinkSync(projectPath);
  return 'removed-file';
}

function normalizeMetaText(value, maxLen = 4000) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeMetaIsoTimestamp(value) {
  const raw = normalizeMetaText(value, 128);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTaskStatus(value) {
  const raw = normalizeMetaText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['active', 'waiting', 'blocked', 'done'].includes(lower)) return lower;
  return null;
}

function normalizeTaskMeta(value, fallbackOwner = null) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const status = normalizeTaskStatus(value.status);
  if (!status) return null;
  const owner = normalizeMetaText(value.owner, 128) || normalizeMetaText(fallbackOwner, 128);
  const updatedAt = normalizeMetaIsoTimestamp(value.updated_at);
  const heartbeatAt = normalizeMetaIsoTimestamp(value.heartbeat_at);
  const waitingReason = normalizeMetaText(value.waiting_reason, 2000);
  const waitingUntil = normalizeMetaIsoTimestamp(value.waiting_until);
  const id = normalizeMetaText(value.id, 256);
  if (!id || !owner || !updatedAt || !heartbeatAt) return null;
  if (status === 'waiting') {
    if (!waitingReason || !waitingUntil) return null;
  }
  return {
    id,
    owner,
    status,
    updated_at: updatedAt,
    heartbeat_at: heartbeatAt,
    waiting_reason: status === 'waiting' ? waitingReason : null,
    waiting_until: status === 'waiting' ? waitingUntil : null,
  };
}

function normalizeRuntimeProfileRole(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const framework = normalizeMetaText(value.framework, 32);
  const provider = normalizeMetaText(value.provider, 64);
  const model = normalizeMetaText(value.model, 256);
  const reasoning = normalizeMetaText(value.reasoning, 64);
  const extraArgs = normalizeMetaText(value.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
  };
}

function normalizeRuntimeProfileMeta(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const primary = normalizeRuntimeProfileRole(value.primary);
  const supervisor = normalizeRuntimeProfileRole(value.supervisor);
  if (!primary && !supervisor) return null;
  return {
    primary: primary || null,
    supervisor: supervisor || null,
  };
}

function cloneMetaValue(value) {
  if (value === null || value === undefined) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function redactMetaPathLikeText(value, maxLen = 1200) {
  const text = normalizeMetaText(value, maxLen);
  if (!text) return null;
  return text.replace(/(^|[\s(])((?:\/[^/\s)]+)+\/?[^)\s]*)/g, '$1[path removed]');
}

function buildOperationalSubconsciousDetail(detail) {
  const safe = cloneMetaValue(detail);
  if (!safe || typeof safe !== 'object') return safe;

  if (safe.runtime && typeof safe.runtime === 'object') {
    const runtimeSummary = {
      classification: safe.runtime.classification || 'transitional',
      desiredEnabled: safe.runtime.desiredEnabled === true,
      invocationConfigured: safe.runtime.invocationConfigured === true,
      disabledReason: safe.runtime.disabledReason || null,
    };
    delete safe.runtime.settingsPath;
    delete safe.runtime.pluginRoot;
    delete safe.runtime.eventUrl;
    delete safe.runtime.invokeUrl;
    delete safe.runtime.runtimeMetaPath;
    safe.runtime = runtimeSummary;
  }
  if (safe.provider && typeof safe.provider === 'object') {
    delete safe.provider.lettaStateFile;
  }
  if (safe.upstream && typeof safe.upstream === 'object') {
    delete safe.upstream.root;
    delete safe.upstream.promptFile;
    delete safe.upstream.scripts;
    delete safe.upstream.durableHome;
    delete safe.upstream.durableStateDir;
    delete safe.upstream.conversationsFile;
    delete safe.upstream.configPath;
    if (safe.upstream.bootstrap && typeof safe.upstream.bootstrap === 'object') {
      delete safe.upstream.bootstrap.workdir;
      if (safe.upstream.bootstrap.blockedReason) {
        safe.upstream.bootstrap.blockedReason = redactMetaPathLikeText(safe.upstream.bootstrap.blockedReason, 1200);
      }
    }
    if (safe.upstream.session && typeof safe.upstream.session === 'object') {
      delete safe.upstream.session.sessionStateFile;
      delete safe.upstream.session.cwd;
      if (safe.upstream.session.blockedReason) {
        safe.upstream.session.blockedReason = redactMetaPathLikeText(safe.upstream.session.blockedReason, 1200);
      }
      if (safe.upstream.session.notify && typeof safe.upstream.session.notify === 'object' && safe.upstream.session.notify.blockedReason) {
        safe.upstream.session.notify.blockedReason = redactMetaPathLikeText(safe.upstream.session.notify.blockedReason, 1200);
      }
    }
    if (safe.upstream.userPrompt && typeof safe.upstream.userPrompt === 'object') {
      delete safe.upstream.userPrompt.transcriptPath;
      delete safe.upstream.userPrompt.transcriptExists;
      delete safe.upstream.userPrompt.syncStateFile;
      delete safe.upstream.userPrompt.scriptPath;
      if (safe.upstream.userPrompt.blockedReason) {
        safe.upstream.userPrompt.blockedReason = redactMetaPathLikeText(safe.upstream.userPrompt.blockedReason, 1200);
      }
    }
    if (safe.upstream.preTool && typeof safe.upstream.preTool === 'object') {
      delete safe.upstream.preTool.syncStateFile;
      delete safe.upstream.preTool.scriptPath;
      if (safe.upstream.preTool.blockedReason) {
        safe.upstream.preTool.blockedReason = redactMetaPathLikeText(safe.upstream.preTool.blockedReason, 1200);
      }
    }
    if (safe.upstream.stop && typeof safe.upstream.stop === 'object') {
      delete safe.upstream.stop.transcriptPath;
      delete safe.upstream.stop.transcriptExists;
      delete safe.upstream.stop.syncStateFile;
      delete safe.upstream.stop.scriptPath;
      if (safe.upstream.stop.blockedReason) {
        safe.upstream.stop.blockedReason = redactMetaPathLikeText(safe.upstream.stop.blockedReason, 1200);
      }
    }
  }
  if (safe.memory && typeof safe.memory === 'object') {
    safe.memory = {
      classification: safe.memory.classification || 'transitional',
    };
  }
  if (safe.conversation && typeof safe.conversation === 'object') {
    safe.conversation = {
      classification: safe.conversation.classification || 'transitional',
    };
  }
  if (safe.guidance && typeof safe.guidance === 'object') {
    delete safe.guidance.text;
    delete safe.guidance.preview;
  }
  if (safe.manualGuidance && typeof safe.manualGuidance === 'object') {
    delete safe.manualGuidance.text;
    delete safe.manualGuidance.preview;
    if (!safe.guidance) safe.guidance = { ...safe.manualGuidance };
  }
  if (Object.prototype.hasOwnProperty.call(safe, 'lastRuntimeGuidance')) delete safe.lastRuntimeGuidance;
  if (Object.prototype.hasOwnProperty.call(safe, 'lastInvocation')) delete safe.lastInvocation;
  if (Array.isArray(safe.missingBackendPieces)) {
    safe.missingBackendPieces = safe.missingBackendPieces.map((item) => redactMetaPathLikeText(item, 1200) || item);
  }
  return safe;
}

function buildSubconsciousAuthoritySummaryMeta(enabled, upstream, lettaAgentId = null) {
  const bootstrap = (upstream && typeof upstream.bootstrap === 'object') ? upstream.bootstrap : {};
  const session = (upstream && typeof upstream.session === 'object') ? upstream.session : {};
  const userPrompt = (upstream && typeof upstream.userPrompt === 'object') ? upstream.userPrompt : {};
  const preTool = (upstream && typeof upstream.preTool === 'object') ? upstream.preTool : {};
  const stop = (upstream && typeof upstream.stop === 'object') ? upstream.stop : {};
  const boundAgentId = normalizeMetaText(bootstrap.agentId || lettaAgentId, 256);
  const bindingConfigured = Boolean(boundAgentId);
  const sessionEstablished = session.established === true;
  const progress = [
    { key: 'stop', label: 'Stop', status: normalizeMetaText(stop.status, 64) || 'not-run' },
    { key: 'preTool', label: 'PreToolUse', status: normalizeMetaText(preTool.status, 64) || 'not-run' },
    { key: 'userPrompt', label: 'UserPromptSubmit', status: normalizeMetaText(userPrompt.status, 64) || 'not-run' },
    { key: 'session', label: 'SessionStart', status: normalizeMetaText(session.status, 64) || 'not-run' },
  ];
  const latestProgress = progress.find((row) => row.status && row.status !== 'not-run') || progress[progress.length - 1];
  let status = 'off';
  let reason = enabled === true ? null : 'subconscious disabled';
  if (enabled === true) {
    if (sessionEstablished) {
      status = 'active';
      reason = null;
    } else if (bindingConfigured || normalizeMetaText(bootstrap.status, 64) === 'configured') {
      const sessionStatus = normalizeMetaText(session.status, 64);
      status = 'degraded';
      reason = normalizeMetaText(session.blockedReason, 1200)
        || normalizeMetaText(bootstrap.blockedReason, 1200)
        || ((sessionStatus === 'not-run' || sessionStatus === null)
          ? 'authoritative upstream session not established'
          : 'authoritative upstream path is configured but not established');
    } else {
      status = 'unconfigured';
      reason = normalizeMetaText(bootstrap.blockedReason, 1200)
        || 'authoritative upstream path is not configured';
    }
  }
  return {
    classification: 'authoritative',
    path: 'upstream-letta',
    status,
    reason,
    bindingConfigured,
    agentId: boundAgentId || null,
    sessionEstablished,
    conversationEstablished: Boolean(session.conversationId),
    latestProgress,
  };
}

function buildSubconsciousFallbackSummaryMeta(guidanceText) {
  const configured = typeof guidanceText === 'string' && guidanceText.trim().length > 0;
  return {
    classification: 'fallback',
    status: configured ? 'configured' : 'none',
    configured,
    source: configured ? 'manual-state-file' : 'none',
    note: 'Guidance is fallback configuration only; it is not the authoritative subconscious behavior path.',
  };
}

function buildSubconsciousTransitionalSummaryMeta(runtime, memory = null, conversation = null) {
  const runtimeDesired = runtime?.desiredEnabled === true;
  let runtimeStatus = 'off';
  if (runtimeDesired && runtime?.invocationConfigured === true) runtimeStatus = 'ready';
  else if (runtimeDesired) runtimeStatus = 'degraded';
  return {
    classification: 'transitional',
    runtimeStatus,
    runtimeDesired,
    runtimeInvocationConfigured: runtime?.invocationConfigured === true,
    runtimeDisabledReason: normalizeMetaText(runtime?.disabledReason, 1200),
    localMemoryConfigured: Number(memory?.entryCount || 0) > 0,
    localConversationConfigured: Number(conversation?.sessionCount || 0) > 0,
    note: 'Local runtime, memory, and conversation journals are transitional compatibility/debug surfaces only.',
  };
}

function normalizePositiveMetaInt(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeMetaFloat(value, fallback) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSubconsciousProviderInput(value) {
  const raw = normalizeMetaText(value, 64);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return ['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(lower) ? lower : null;
}

function normalizeSubconsciousHooksInput(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const hook = normalizeMetaText(String(item ?? ''), 120);
    if (!hook) continue;
    if (!['UserPromptSubmit', 'PreToolUse'].includes(hook)) continue;
    if (seen.has(hook)) continue;
    seen.add(hook);
    out.push(hook);
  }
  return out.length ? out : ['UserPromptSubmit', 'PreToolUse'];
}

const SUBCONSCIOUS_HOOK_NAMES = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

function detectInstalledSubconsciousHooks(settingsPath) {
  if (!settingsPath || !existsSync(settingsPath)) return [];
  const settings = safeReadJsonSync(settingsPath);
  const hooksRoot = (settings && typeof settings.hooks === 'object' && settings.hooks) ? settings.hooks : {};
  const installed = [];
  for (const hookName of SUBCONSCIOUS_HOOK_NAMES) {
    const rows = Array.isArray(hooksRoot[hookName]) ? hooksRoot[hookName] : [];
    const hasManagedEntry = rows.some((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return hooks.some((row) => typeof row?.command === 'string' && row.command.includes('hook-entry.mjs'));
    });
    if (hasManagedEntry) installed.push(hookName);
  }
  return installed;
}

function buildSubconsciousDetailPayload(name, manifest = null, detail = null) {
  const stateDir = manifest?.stateDir || detail?.stateDir || null;
  const workdir = manifest?.workdir || detail?.workdir || null;
  const runtimeMetaPath = stateDir ? path.join(stateDir, 'subconscious', 'runtime.json') : null;
  const lettaPath = stateDir ? path.join(stateDir, 'letta.json') : null;
  const runtime = runtimeMetaPath && existsSync(runtimeMetaPath) ? safeReadJsonSync(runtimeMetaPath) : null;
  const letta = lettaPath && existsSync(lettaPath) ? safeReadJsonSync(lettaPath) : null;
  const settingsPath = runtime?.settingsPath || (workdir ? path.join(workdir, '.claude', 'settings.json') : null);
  const pluginRoot = runtime?.pluginRoot || (stateDir ? path.join(stateDir, 'subconscious', 'claude-agentchat') : null);
  const hookScriptPath = pluginRoot ? path.join(pluginRoot, 'scripts', 'hook-entry.mjs') : null;
  const installedHooks = detectInstalledSubconsciousHooks(settingsPath);
  const guidanceText = normalizeMetaText(letta?.guidance, 6000) || '';
  const eventUrl = normalizeMetaText(runtime?.eventUrl, 2048);
  const upstream = (runtime?.upstream && typeof runtime.upstream === 'object') ? runtime.upstream : {};
  if (upstream && typeof upstream === 'object' && !upstream.classification) upstream.classification = 'authoritative';
  const missingBackendPieces = [
    'Direct upstream reuse may be recorded in runtime metadata, but the fallback detail path cannot execute the upstream Letta bootstrap itself.',
    'Real provider/model config path for subconscious reasoning is not implemented in this fallback path.',
    'Real memory state store semantics beyond a local state file are not implemented.',
    'No actual Letta/LLM invocation boundary is configured or executed by this fallback scaffold payload.',
  ];
  const runtimeContract = {
    classification: 'transitional',
    hookRuntimeInstalled: Boolean(hookScriptPath && existsSync(hookScriptPath)),
    hookBindingsInstalled: installedHooks.length === SUBCONSCIOUS_HOOK_NAMES.length,
    installedHooks,
    settingsPath: settingsPath || null,
    pluginRoot: pluginRoot || null,
    eventSinkConfigured: Boolean(eventUrl),
    eventUrl: eventUrl || null,
    runtimeMetaPath: runtimeMetaPath || null,
    updatedAt: normalizeMetaText(runtime?.updatedAt, 128),
  };
  const providerContract = {
    provider: normalizeMetaText(letta?.provider, 128) || 'letta',
    mode: normalizeMetaText(letta?.mode, 128) || 'claude-subconscious',
    lettaAgentId: normalizeMetaText(letta?.agentId || letta?.lettaAgentId, 256),
    resolutionSource: normalizeMetaText(letta?.resolutionSource, 64),
    lettaStateFile: lettaPath || null,
    backendRuntimeConfigured: false,
    modelConfigConfigured: false,
    memoryStoreConfigured: false,
    invocationConfigured: false,
  };
  const authority = buildSubconsciousAuthoritySummaryMeta(
    manifest?.subconsciousEnabled === true || detail?.subconsciousEnabled === true,
    upstream,
    providerContract.lettaAgentId,
  );
  const fallback = buildSubconsciousFallbackSummaryMeta(guidanceText);
  const transitional = buildSubconsciousTransitionalSummaryMeta(runtimeContract);

  return buildOperationalSubconsciousDetail({
    ok: true,
    agent: name,
    stage: 'scaffold',
    writable: Boolean(manifest?.stateDir),
    enabled: manifest?.subconsciousEnabled === true || detail?.subconsciousEnabled === true,
    authority,
    fallback,
    guidance: {
      classification: 'fallback',
      configured: guidanceText.length > 0,
      source: guidanceText ? 'manual-state-file' : 'none',
      role: 'fallback',
      text: guidanceText,
      preview: guidanceText.length > 240 ? `${guidanceText.slice(0, 240)}...` : guidanceText,
      updatedAt: normalizeMetaText(letta?.updatedAt, 128),
    },
    runtime: runtimeContract,
    transitional,
    provider: providerContract,
    upstream,
    missingBackendPieces,
  });
}

app.get('/api/agents/detail/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const detail = { name, homeRoot: AGENTCHAT_HOMEDIR };
  const { metaPath, meta: localMeta } = loadLocalAgentMeta(name);
  const v1Manifest = loadV1Manifest(name, localMeta);

  // From backend-v2
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`);
    const agent = await r.json();
    if (!agent.error) {
      detail.identity = agent.identity || null;
      detail.groups = agent.groups || [];
      detail.server = agent.server || null;
      detail.tmux = agent.tmux || null;
      detail.agentModelVersion = agent.agentModelVersion || null;
      detail.layoutVersion = Number(agent.layoutVersion) || null;
      detail.agentId = agent.agentId || null;
      detail.homeDir = agent.homeDir || null;
      detail.workdir = agent.workdir || null;
      detail.stateDir = agent.stateDir || null;
      detail.subconsciousEnabled = agent.subconsciousEnabled === true;
      detail.managedProjects = Array.isArray(agent.managedProjects) ? agent.managedProjects : [];
      detail.human = (agent.human && typeof agent.human === 'object') ? agent.human : {};
      detail.task = normalizeTaskMeta(agent.task, name);
      detail.runtimeProfile = normalizeRuntimeProfileMeta(agent.runtimeProfile);
      detail.role = agent.role || null;
    }
  } catch (e) {
    console.debug(`[server] backend subconscious detail fetch skipped for ${name}: ${e.message}`);
  }

  // From local meta.json
  if (localMeta && typeof localMeta === 'object') {
    detail.metaPath = metaPath;
    detail.agentType = detail.agentType || localMeta.type || null; // claude/codex
    detail.path = detail.path || localMeta.path || null;
    detail.model = localMeta.model || null;
    detail.extraArgs = localMeta.extraArgs || null;
    detail.lastUp = localMeta.lastUp || null;
    detail.lastDown = localMeta.lastDown || null;
    detail.agentModelVersion = detail.agentModelVersion || localMeta.agentModelVersion || null;
    detail.layoutVersion = detail.layoutVersion || Number(localMeta.layoutVersion) || null;
    detail.agentId = detail.agentId || localMeta.agentId || null;
    detail.homeDir = detail.homeDir || localMeta.homeDir || null;
    detail.workdir = detail.workdir || localMeta.workdir || null;
    detail.stateDir = detail.stateDir || localMeta.stateDir || null;
    detail.task = detail.task || normalizeTaskMeta(localMeta.task, name);
    detail.runtimeProfile = detail.runtimeProfile || normalizeRuntimeProfileMeta(localMeta.runtimeProfile);
  }

  if (v1Manifest) {
    detail.v1 = true;
    detail.agentJsonPath = v1Manifest.agentJsonPath || path.join(v1Manifest.homeDir, 'agent.json');
    detail.agentType = v1Manifest.type || detail.agentType || null;
    detail.path = v1Manifest.workdir || detail.path || null;
    detail.agentModelVersion = v1Manifest.agentModelVersion || detail.agentModelVersion || '1.0';
    detail.layoutVersion = Number(v1Manifest.layoutVersion) || detail.layoutVersion || 1;
    detail.agentId = v1Manifest.id || detail.agentId || null;
    detail.homeDir = v1Manifest.homeDir || detail.homeDir || null;
    detail.workdir = v1Manifest.workdir || detail.workdir || null;
    detail.stateDir = v1Manifest.stateDir || detail.stateDir || null;
    detail.subconsciousEnabled = v1Manifest.subconsciousEnabled === true;
    detail.managedProjects = Array.isArray(v1Manifest.managedProjects) ? v1Manifest.managedProjects : [];
    detail.human = (v1Manifest.human && typeof v1Manifest.human === 'object')
      ? v1Manifest.human
      : (detail.human || {});
    detail.task = normalizeTaskMeta(v1Manifest.task, name);
    detail.runtimeProfile = normalizeRuntimeProfileMeta(v1Manifest.runtimeProfile);
  } else {
    detail.v1 = false;
  }

  const humanMeta = (detail.human && typeof detail.human === 'object') ? detail.human : {};
  detail.human = normalizeHumanSyncMeta(humanMeta);
  detail.owner = typeof humanMeta.owner === 'string' ? humanMeta.owner : null;
  if (detail.stateDir) {
    const lettaPath = path.join(detail.stateDir, 'letta.json');
    const letta = existsSync(lettaPath) ? safeReadJsonSync(lettaPath) : null;
    const guidance = normalizeMetaText(letta?.guidance, 6000) || '';
    detail.subconsciousGuidanceText = guidance;
    detail.subconsciousGuidancePreview = guidance.length > 240 ? `${guidance.slice(0, 240)}...` : guidance;
  } else {
    detail.subconsciousGuidanceText = '';
    detail.subconsciousGuidancePreview = '';
  }

  // Idle info (sync — reads from in-memory snapshot cache)
  if (detail.tmux && isLocalAgentServer(detail.server)) {
    detail.idleMs = getPaneIdleMs(detail.tmux);
    detail.active = detail.idleMs >= 0 && detail.idleMs < IDLE_THRESHOLD;
  }

  // Parallel: resume-id, agent type probe, docs payload
  const resumeRoot = detail.v1 && detail.stateDir
    ? detail.stateDir
    : path.join(AGENTS_DATA_DIR, name);
  const docsWorkspacePath = detail.workdir || v1Manifest?.workdir || AGENTCHAT_HOMEDIR;
  const needsTypeProbe = detail.tmux && isLocalAgentServer(detail.server) && !detail.agentType;

  const [resumeResult, typeResult, docsResult] = await Promise.allSettled([
    readFileAsync(path.join(resumeRoot, 'resume-id'), 'utf-8').then(s => s.trim()).catch(e => {
      if (e.code !== 'ENOENT') console.debug(`[server] resume-id read failed for ${name}: ${e.message}`);
      return null;
    }),
    needsTypeProbe
      ? execFileAsync('tmux', ['list-panes', '-t', detail.tmux, '-F', '#{pane_pid}'], { encoding: 'utf-8', timeout: 2000 })
          .then(({ stdout }) => {
            const panePid = stdout.trim();
            if (!panePid) return null;
            return execFileAsync('ps', ['-o', 'args=', '--ppid', panePid], { encoding: 'utf-8', timeout: 2000 })
              .then(({ stdout: childCmdStdout }) => {
                const childCmd = childCmdStdout.toLowerCase();
                if (childCmd.includes('claude')) return 'claude';
                if (childCmd.includes('codex')) return 'codex';
                return null;
              });
          })
          .catch(e => { console.debug(`[server] agent type probe skipped for ${name}: ${e.message}`); return null; })
      : Promise.resolve(null),
    buildAgentDocsPayload(name, docsWorkspacePath, v1Manifest),
  ]);

  detail.resumeId = resumeResult.status === 'fulfilled' ? resumeResult.value : null;
  if (needsTypeProbe && typeResult.status === 'fulfilled' && typeResult.value) {
    detail.agentType = typeResult.value;
  }
  detail.docs = docsResult.status === 'fulfilled' ? docsResult.value : {};

  res.json(detail);
});

app.get('/api/subconscious/detail/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const backendUrl = new URL(`${BACKEND_V2_URL}/api/subconscious/detail/${encodeURIComponent(name)}`);
    if (normalizeMetaText(String(req.query?.debug ?? ''), 8) === '1') {
      backendUrl.searchParams.set('debug', '1');
    }
    const r = await backendFetch(backendUrl);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    if (r.ok) return res.json(data);
  } catch (e) {
    console.debug(`[server] backend agent detail fetch skipped for ${name}: ${e.message}`);
  }

  const { meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  let detail = null;
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`);
    detail = await r.json();
  } catch (e) {
    console.debug(`[server] backend agent detail fetch skipped for ${name}: ${e.message}`);
  }
  return res.json(buildSubconsciousDetailPayload(name, manifest, detail));
});

app.post('/api/subconscious/upstream/bootstrap/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/subconscious/upstream/bootstrap/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
    return res.status(r.status).json(payload);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'upstream bootstrap proxy failed' });
  }
});

app.post('/api/subconscious/upstream/session-start/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/subconscious/upstream/session-start/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
    return res.status(r.status).json(payload);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'upstream session-start proxy failed' });
  }
});

app.post('/api/subconscious/upstream/user-prompt/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/subconscious/upstream/user-prompt/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
    return res.status(r.status).json(payload);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'upstream user-prompt proxy failed' });
  }
});

app.post('/api/subconscious/upstream/pretool/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/subconscious/upstream/pretool/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
    return res.status(r.status).json(payload);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'upstream pretool proxy failed' });
  }
});

app.get('/api/agents/:name/unread-messages', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.min(limitRaw, 200) : 50;

  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/inbox/${encodeURIComponent(name)}/unread-list?limit=${limit}`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.post('/api/agents/:name/unread-messages/:msgId/cancel', async (req, res) => {
  const name = req.params.name;
  const msgId = req.params.msgId;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  if (!/^msg_[0-9]+$/.test(msgId)) return res.status(400).json({ error: 'invalid message id' });

  try {
    const suppressRes = await backendFetch(`${BACKEND_V2_URL}/api/messages/${encodeURIComponent(msgId)}/suppress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: name, reason: 'web-cancel' }),
    });
    const suppressData = await suppressRes.json().catch(() => ({ error: `backend status ${suppressRes.status}` }));
    if (!suppressRes.ok) return res.status(suppressRes.status).json(suppressData);

    const queueRemoved = dropQueuedBackendNotificationsBySource(name, msgId);
    res.json({
      ok: true,
      canceled: { agent: name, message: msgId },
      queue_removed: queueRemoved,
      suppress: suppressData,
    });
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

// ── DM tab proxies ────────────────────────────────────────────────────
app.get('/api/agents/:name/dm-history', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  const qs = `limit=${limit}`;
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/dm/${encodeURIComponent(name)}/history?${qs}`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.post('/api/agents/:name/dm-send', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const fromName = String(req.body?.from || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'operator';
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromName,
        to: name,
        type: 'human',
        full: text,
        source: 'web',
        target_type: 'agent',
      }),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.delete('/api/queue/agents/:name/notifications', (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const removed = dropQueuedBackendNotificationsBySource(name);
  return res.json({ ok: true, agent: name, removed });
});

app.patch('/api/agents/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.patch('/api/agents/:name/home-metadata', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { metaPath, meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest) {
    return res.status(404).json({ error: 'v1 agent manifest not found' });
  }

  const body = req.body || {};
  const next = { ...manifest };
  const nextHuman = {
    ...((manifest?.human && typeof manifest.human === 'object') ? manifest.human : {}),
    owner: normalizeMetaText(manifest?.human?.owner, 256),
  };

  if (Object.prototype.hasOwnProperty.call(body, 'owner')) {
    nextHuman.owner = normalizeMetaText(body.owner, 256);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'managedProjects')) {
    next.managedProjects = sanitizeManagedProjects(body.managedProjects);
  } else if (!Array.isArray(next.managedProjects)) {
    next.managedProjects = [];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'task')) {
    const nextTask = normalizeTaskMeta(body.task, name);
    if (body.task !== null && !nextTask) {
      return res.status(400).json({ error: 'invalid task payload' });
    }
    next.task = nextTask;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'runtimeProfile')) {
    const nextRuntimeProfile = normalizeRuntimeProfileMeta(body.runtimeProfile);
    if (body.runtimeProfile !== null && !nextRuntimeProfile) {
      return res.status(400).json({ error: 'invalid runtimeProfile payload' });
    }
    next.runtimeProfile = nextRuntimeProfile;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'subconsciousEnabled')) {
    next.subconsciousEnabled = body.subconsciousEnabled === true;
  }

  next.human = nextHuman;
  next.updatedAt = new Date().toISOString();
  writeV1Manifest(next.agentJsonPath || path.join(next.homeDir, 'agent.json'), next);

  syncLocalAgentMetaFromManifest(name, metaPath, localMeta, next, nextHuman);
  const backendSync = await syncBackendAgentHomeState(name, next, nextHuman);

  return res.json({
    ok: backendSync?.ok === true,
    localWriteOk: true,
    agent: name,
    backendSync,
    metadata: {
      owner: nextHuman.owner,
      subconsciousEnabled: next.subconsciousEnabled === true,
      managedProjects: Array.isArray(next.managedProjects) ? next.managedProjects : [],
      agentModelVersion: next.agentModelVersion || '1.0',
      layoutVersion: Number(next.layoutVersion) || 1,
      agentId: next.id || null,
      homeDir: next.homeDir || null,
      workdir: next.workdir || null,
      stateDir: next.stateDir || null,
      manifestPath: next.agentJsonPath || path.join(next.homeDir, 'agent.json'),
      task: normalizeTaskMeta(next.task, name),
      runtimeProfile: normalizeRuntimeProfileMeta(next.runtimeProfile),
    },
  });
});

app.get('/api/agents/:name/projects', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest) {
    return res.status(404).json({ error: 'v1 agent manifest not found' });
  }
  return res.json(buildProjectsControlPayload(name, manifest));
});

app.post('/api/agents/:name/projects/import', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { metaPath, meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest?.homeDir || !manifest?.workdir || !manifest?.id) {
    return res.status(404).json({ error: 'v1 agent manifest not found' });
  }

  const body = req.body || {};
  const sourceInput = String(body.sourcePath ?? body.projectPath ?? '').trim();
  if (!sourceInput) {
    return res.status(400).json({ error: 'sourcePath is required' });
  }
  const sourcePath = path.resolve(sourceInput);
  let sourceStat = null;
  try {
    sourceStat = await statAsync(sourcePath);
  } catch {
    return res.status(400).json({ error: `source path does not exist: ${sourcePath}` });
  }
  if (!sourceStat.isDirectory()) {
    return res.status(400).json({ error: `source path is not a directory: ${sourcePath}` });
  }

  const projectMode = String(body.mode ?? body.projectMode ?? 'copy').trim().toLowerCase();
  if (projectMode !== 'copy' && projectMode !== 'symlink') {
    return res.status(400).json({ error: 'mode must be copy or symlink' });
  }
  const projectName = normalizeMetaText(body.projectName ?? body.name, 256);
  let provisionPayload = null;
  try {
    provisionPayload = runProvisionForManifest(manifest, localMeta, {
      projectPath: sourcePath,
      projectMode,
      projectName,
    });
  } catch (e) {
    const stderr = String(e?.stderr || '').trim();
    const stdout = String(e?.stdout || '').trim();
    const detail = stderr || stdout || e?.message || 'project import failed';
    const status = /already exists and differs/i.test(detail) ? 409 : 400;
    return res.status(status).json({ ok: false, error: detail });
  }

  const next = loadV1Manifest(name, localMeta);
  if (!next) {
    return res.status(500).json({ ok: false, error: 'project import completed but manifest reload failed' });
  }
  syncLocalAgentMetaFromManifest(name, metaPath, localMeta, next);
  const backendSync = await syncBackendAgentHomeState(name, next);
  const importedProject = Array.isArray(next.managedProjects) && next.managedProjects.length
    ? next.managedProjects[next.managedProjects.length - 1]
    : null;

  return res.json({
    ...buildProjectsControlPayload(name, next),
    ok: backendSync?.ok === true,
    localWriteOk: true,
    backendSync,
    importedProject,
    materialization: provisionPayload?.materialization || null,
  });
});

app.post('/api/agents/:name/projects/remove', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { metaPath, meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest?.homeDir || !manifest?.workdir || !manifest?.id) {
    return res.status(404).json({ error: 'v1 agent manifest not found' });
  }

  const body = req.body || {};
  const projectName = normalizeMetaText(body.projectName ?? body.name, 256);
  const projectPath = normalizeMetaText(body.projectPath ?? body.path, 4096);
  if (!projectName && !projectPath) {
    return res.status(400).json({ error: 'projectName or projectPath is required' });
  }
  const managedProjects = Array.isArray(manifest.managedProjects) ? manifest.managedProjects : [];
  const matches = managedProjects.filter((row) => {
    const nameMatch = projectName ? String(row?.name || '') === projectName : true;
    const pathMatch = projectPath ? path.resolve(String(row?.path || '')) === path.resolve(projectPath) : true;
    return nameMatch && pathMatch;
  });
  if (matches.length === 0) {
    return res.status(404).json({ error: 'managed project not found' });
  }
  if (!projectPath && matches.length > 1) {
    return res.status(409).json({ error: 'managed project selection is ambiguous' });
  }
  const target = matches[0];
  const deleteFiles = body.deleteFiles === true;
  const projectRoot = path.join(manifest.workdir, 'projects');
  let fileAction = 'not-requested';
  if (deleteFiles) {
    if (!isSubpathOf(projectRoot, target.path)) {
      return res.status(400).json({ error: 'deleteFiles is allowed only for paths under workdir/projects' });
    }
    try {
      fileAction = removeManagedProjectPath(target.path);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e?.message || 'project removal failed' });
    }
  }

  const next = {
    ...manifest,
    managedProjects: managedProjects.filter((row) => !(String(row?.name || '') === String(target.name || '') && path.resolve(String(row?.path || '')) === path.resolve(String(target.path || '')))),
    updatedAt: new Date().toISOString(),
  };
  writeV1Manifest(next.agentJsonPath || path.join(next.homeDir, 'agent.json'), next);
  syncLocalAgentMetaFromManifest(name, metaPath, localMeta, next);
  const backendSync = await syncBackendAgentHomeState(name, next);

  return res.json({
    ...buildProjectsControlPayload(name, next),
    ok: backendSync?.ok === true,
    localWriteOk: true,
    backendSync,
    removedProject: target,
    deleteFiles,
    fileAction,
  });
});

app.post('/api/agents/:name/workspace/migrate-entry-files', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { metaPath, meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest?.homeDir || !manifest?.workdir || !manifest?.id) {
    return res.status(404).json({ error: 'v1 agent manifest not found' });
  }

  let provisionPayload = null;
  try {
    provisionPayload = runProvisionForManifest(manifest, localMeta);
  } catch (e) {
    const stderr = String(e?.stderr || '').trim();
    const stdout = String(e?.stdout || '').trim();
    const detail = stderr || stdout || e?.message || 'workspace migration failed';
    return res.status(400).json({ ok: false, error: detail });
  }

  const next = loadV1Manifest(name, localMeta);
  if (!next) {
    return res.status(500).json({ ok: false, error: 'workspace migration completed but manifest reload failed' });
  }
  syncLocalAgentMetaFromManifest(name, metaPath, localMeta, next);
  const backendSync = await syncBackendAgentHomeState(name, next);

  return res.json({
    ...buildWorkspaceEntryMigrationPayload(name, next, provisionPayload),
    ok: backendSync?.ok === true,
    localWriteOk: true,
    backendSync,
  });
});

app.get('/api/agents/:name/hooks', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const { meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  const stateDir = manifest?.stateDir || localMeta?.stateDir || null;
  if (!stateDir) return res.json({ hooks: null });
  const hooksPath = path.join(stateDir, 'subconscious', 'claude-agentchat', 'hooks', 'hooks.json');
  try {
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    return res.json({ hooks });
  } catch {
    return res.json({ hooks: null });
  }
});

app.get('/api/config/mcp', (_req, res) => {
  const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
  const settingsPath = path.join(homedir, '.claude', 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const raw = settings.mcpServers || {};
    const safe = {};
    for (const [name, cfg] of Object.entries(raw)) {
      safe[name] = { command: cfg?.command || null, type: cfg?.type || null };
    }
    return res.json({ mcpServers: safe });
  } catch {
    return res.json({ mcpServers: {} });
  }
});

app.patch('/api/agents/:name/subconscious-guidance', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest?.stateDir) {
    return res.status(404).json({ error: 'v1 subconscious state not found' });
  }

  const body = req.body || {};
  const guidance = normalizeMetaText(body.guidance, 6000)
    || normalizeMetaText(body.manualGuidance, 6000)
    || '';
  const lettaPath = path.join(manifest.stateDir, 'letta.json');
  const existing = safeReadJsonSync(lettaPath) || {};
  const now = new Date().toISOString();
  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    provider: normalizeMetaText(existing.provider, 128) || 'letta',
    mode: normalizeMetaText(existing.mode, 128) || 'claude-subconscious',
    enabled: manifest.subconsciousEnabled === true,
    agentName: normalizeMetaText(existing.agentName, 128) || manifest.name || name,
    agentId: normalizeMetaText(existing.agentId || existing.lettaAgentId, 256) || manifest.id || name,
    resolutionSource: normalizeMetaText(existing.resolutionSource, 64) || 'state',
    guidance,
    createdAt: normalizeMetaText(existing.createdAt, 128) || now,
    updatedAt: now,
  };

  mkdirSync(path.dirname(lettaPath), { recursive: true });
  writeFileSync(lettaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');

  return res.json({
    ok: true,
    agent: name,
    guidance: {
      configured: guidance.length > 0,
      source: guidance ? 'manual-state-file' : 'none',
      text: guidance,
      updatedAt: now,
      lettaPath,
    },
  });
});

app.patch('/api/agents/:name/subconscious-runtime', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const { meta: localMeta } = loadLocalAgentMeta(name);
  const manifest = loadV1Manifest(name, localMeta);
  if (!manifest?.stateDir) {
    return res.status(404).json({ error: 'v1 subconscious state not found' });
  }

  const lettaPath = path.join(manifest.stateDir, 'letta.json');
  const runtimeMetaPath = path.join(manifest.stateDir, 'subconscious', 'runtime.json');
  const existing = safeReadJsonSync(lettaPath) || {};
  const runtimeMeta = safeReadJsonSync(runtimeMetaPath) || {};
  const existingRuntime = (existing.runtime && typeof existing.runtime === 'object') ? existing.runtime : {};
  const body = req.body || {};
  const hasProvider = Object.prototype.hasOwnProperty.call(body, 'provider');
  const providerRaw = typeof body.provider === 'string' ? body.provider.trim() : '';
  const clearProvider = hasProvider && providerRaw === '';
  const provider = clearProvider ? null : normalizeSubconsciousProviderInput(body.provider);
  if (hasProvider && !clearProvider && !provider) {
    return res.status(400).json({ error: 'invalid subconscious provider' });
  }

  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
  const modelRaw = typeof body.model === 'string' ? body.model.trim() : '';
  const clearModel = hasModel && modelRaw === '';
  const model = clearModel ? null : normalizeMetaText(body.model, 256);

  const hasEndpoint = Object.prototype.hasOwnProperty.call(body, 'endpoint');
  const endpointRaw = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const clearEndpoint = hasEndpoint && endpointRaw === '';
  const endpoint = clearEndpoint ? null : normalizeMetaText(body.endpoint, 2048);

  const hasKeyEnv = Object.prototype.hasOwnProperty.call(body, 'keyEnv');
  const keyEnvRaw = typeof body.keyEnv === 'string' ? body.keyEnv.trim() : '';
  const clearKeyEnv = hasKeyEnv && keyEnvRaw === '';
  const keyEnv = clearKeyEnv ? null : normalizeMetaText(body.keyEnv, 128);
  if (hasKeyEnv && !clearKeyEnv && !keyEnv) {
    return res.status(400).json({ error: 'invalid subconscious key env' });
  }

  const now = new Date().toISOString();
  const nextRuntime = {
    ...existingRuntime,
    enabled: Object.prototype.hasOwnProperty.call(body, 'enabled')
      ? body.enabled === true
      : (existingRuntime.enabled !== false),
    timeoutMs: Object.prototype.hasOwnProperty.call(body, 'timeoutMs')
      ? normalizePositiveMetaInt(body.timeoutMs, 8000)
      : normalizePositiveMetaInt(existingRuntime.timeoutMs, 8000),
    maxTokens: Object.prototype.hasOwnProperty.call(body, 'maxTokens')
      ? normalizePositiveMetaInt(body.maxTokens, 220)
      : normalizePositiveMetaInt(existingRuntime.maxTokens, 220),
    temperature: Object.prototype.hasOwnProperty.call(body, 'temperature')
      ? normalizeMetaFloat(body.temperature, 0.2)
      : normalizeMetaFloat(existingRuntime.temperature, 0.2),
    allowedHooks: Object.prototype.hasOwnProperty.call(body, 'allowedHooks')
      ? normalizeSubconsciousHooksInput(body.allowedHooks)
      : normalizeSubconsciousHooksInput(existingRuntime.allowedHooks),
  };
  if (hasProvider) {
    if (clearProvider) delete nextRuntime.provider;
    else nextRuntime.provider = provider;
  }
  if (hasModel) {
    if (clearModel) delete nextRuntime.model;
    else nextRuntime.model = model || '';
  }
  if (hasEndpoint) {
    if (clearEndpoint) delete nextRuntime.endpoint;
    else nextRuntime.endpoint = endpoint || '';
  }
  if (hasKeyEnv) {
    if (clearKeyEnv) delete nextRuntime.keyEnv;
    else nextRuntime.keyEnv = keyEnv;
  }

  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    provider: normalizeMetaText(existing.provider, 128) || 'letta',
    mode: normalizeMetaText(existing.mode, 128) || 'claude-subconscious',
    enabled: manifest.subconsciousEnabled === true,
    agentName: normalizeMetaText(existing.agentName, 128) || manifest.name || name,
    agentId: normalizeMetaText(existing.agentId || existing.lettaAgentId, 256) || manifest.id || name,
    resolutionSource: normalizeMetaText(existing.resolutionSource, 64) || 'state',
    guidance: normalizeMetaText(existing.guidance, 6000) || '',
    runtime: nextRuntime,
    createdAt: normalizeMetaText(existing.createdAt, 128) || now,
    updatedAt: now,
  };
  mkdirSync(path.dirname(lettaPath), { recursive: true });
  writeFileSync(lettaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');

  const nextRuntimeMeta = {
    ...(runtimeMeta && typeof runtimeMeta === 'object' ? runtimeMeta : {}),
    backendMode: 'runtime-contract',
    reasoningRuntime: 'llm-compatible',
    memoryStore: (runtimeMeta && typeof runtimeMeta.memoryStore === 'object')
      ? runtimeMeta.memoryStore
        : {
          kind: 'local-episodic-journal',
          path: path.join(manifest.stateDir, 'subconscious', 'memory.json'),
          retrievalStrategy: 'keyword-overlap-recency',
        },
    conversationStore: (runtimeMeta && typeof runtimeMeta.conversationStore === 'object')
      ? runtimeMeta.conversationStore
      : {
          kind: 'claude-jsonl-session-journal',
          path: path.join(manifest.stateDir, 'subconscious', 'conversations.json'),
          syncSource: 'claude-jsonl-transcript',
        },
    updatedAt: now,
  };
  mkdirSync(path.dirname(runtimeMetaPath), { recursive: true });
  writeFileSync(runtimeMetaPath, `${JSON.stringify(nextRuntimeMeta, null, 2)}\n`, 'utf-8');

  return res.json({
    ok: true,
    agent: name,
    runtime: nextRuntime,
    runtimeMetaPath,
    lettaPath,
  });
});

app.post('/api/agents/:name/offline', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.post('/api/agents/:name/down', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  if (!existsSync(AGENT_DOWN_BIN)) {
    return res.status(500).json({ ok: false, error: 'agent-down binary missing', path: AGENT_DOWN_BIN });
  }
  const toTail = (text, lines) => String(text || '').trim().split('\n').slice(-lines).join('\n');
  try {
    const output = execFileSync(AGENT_DOWN_BIN, [name, '--kill'], {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: '*' },
    });
    const outputTail = toTail(output, 20);
    return res.json({ ok: true, action: 'agent-down-kill', outputTail });
  } catch (e) {
    const stdout = String(e?.stdout || '');
    const stderr = String(e?.stderr || e?.message || '');
    const detail = toTail(`${stdout}\n${stderr}`, 40);
    try {
      execFileSync('tmux', ['kill-session', '-t', name], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      // Best effort fallback: proceed to mark offline even when session already missing.
    }
    try {
      const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}/offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'manual-down:web-kill',
          clearTmux: true,
          manualDown: true,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.ok) {
        const apiErr = (data && (data.error || data.detail)) || `backend status ${r.status}`;
        return res.status(500).json({ ok: false, error: 'agent-down failed', detail, fallbackError: String(apiErr) });
      }
      return res.json({ ok: true, action: 'agent-down-kill-fallback', outputTail: detail });
    } catch (fallbackErr) {
      return res.status(500).json({
        ok: false,
        error: 'agent-down failed',
        detail,
        fallbackError: String(fallbackErr?.message || fallbackErr),
      });
    }
  }
});

app.delete('/api/agents/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const url = new URL(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}`);
    if (req.query.force === 'true') url.searchParams.set('force', 'true');
    const r = await backendFetch(url, { method: 'DELETE' });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

// ── Framework Presets proxy APIs ─────────────────────────────────────
app.get('/api/framework-presets', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/framework-presets`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.post('/api/framework-presets', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/framework-presets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.put('/api/framework-presets/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/framework-presets/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.delete('/api/framework-presets/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/framework-presets/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

// ── Task CRUD proxy APIs ─────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const url = new URL(`${BACKEND_V2_URL}/api/tasks`);
    for (const key of ['assignee', 'status', 'priority', 'label']) {
      if (typeof req.query[key] === 'string' && req.query[key].trim()) url.searchParams.set(key, req.query[key].trim());
    }
    const r = await backendFetch(url);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks/${encodeURIComponent(req.params.id)}`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks/${encodeURIComponent(req.params.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.post('/api/tasks/:id/transition', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks/${encodeURIComponent(req.params.id)}/transition`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/tasks/${encodeURIComponent(req.params.id)}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
});

app.post('/api/task-graphs', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/task-graphs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/task-graphs', async (req, res) => {
  try {
    const url = new URL(`${BACKEND_V2_URL}/api/task-graphs`);
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      url.searchParams.set('status', req.query.status.trim());
    }
    const r = await backendFetch(url);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/task-graphs/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/task-graphs/${encodeURIComponent(req.params.id)}`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.delete('/api/task-graphs/:id', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/task-graphs/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.patch('/api/task-graphs/:id/nodes/:nodeId', async (req, res) => {
  try {
    const r = await backendFetch(
      `${BACKEND_V2_URL}/api/task-graphs/${encodeURIComponent(req.params.id)}/nodes/${encodeURIComponent(req.params.nodeId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      }
    );
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

// ── Supervisor audit proxy APIs ──────────────────────────────────────
app.get('/api/supervisor/status', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/supervisor/status`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/supervisor/agents', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/supervisor/agents`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/supervisor/agents/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/supervisor/agents/${encodeURIComponent(name)}?limit=${limit}`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/supervisor/control', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/supervisor/control`);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.post('/api/supervisor/control', async (req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/supervisor/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/subconscious/events', async (req, res) => {
  try {
    const url = new URL(`${BACKEND_V2_URL}/api/subconscious/events`);
    if (typeof req.query.agent === 'string' && req.query.agent.trim()) {
      url.searchParams.set('agent', req.query.agent.trim());
    }
    const limitRaw = Number.parseInt(req.query.limit, 10);
    if (Number.isFinite(limitRaw) && limitRaw > 0) {
      url.searchParams.set('limit', String(Math.min(limitRaw, 500)));
    }
    const r = await backendFetch(url);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.get('/api/subconscious/events/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const url = new URL(`${BACKEND_V2_URL}/api/subconscious/events/${encodeURIComponent(name)}`);
    const limitRaw = Number.parseInt(req.query.limit, 10);
    if (Number.isFinite(limitRaw) && limitRaw > 0) {
      url.searchParams.set('limit', String(Math.min(limitRaw, 500)));
    }
    const r = await backendFetch(url);
    const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

// SSE for queue updates (reuse existing SSE clients, send typed events)
function queueSnapshot() {
  const items = [];
  for (const [, entries] of queue) items.push(...entries);
  items.sort((a, b) => a.queuedAt - b.queuedAt);
  // Attach live idle info per item
  for (const item of items) {
    item.targetIdleMs = getPaneIdleMs(item.to);
  }
  return items;
}

function broadcastQueue() {
  const items = queueSnapshot();
  const frame = `event: queue\ndata: ${JSON.stringify(items)}\n\n`;
  for (const c of sseClients) c.write(frame);
}

// Content-based idle detection: compare pane snapshots
// window_activity is unreliable (status bar / cursor refreshes count as activity)
const paneSnapshots = new Map(); // target -> { hash, changedAt }

import { createHash } from 'crypto';

async function snapshotPaneAsync(target) {
  try {
    const { stdout } = await execFileAsyncImpl(
      'tmux', ['capture-pane', '-t', target, '-p'],
      { encoding: 'utf-8', timeout: 3000 }
    );
    return createHash('md5').update(stdout).digest('hex');
  } catch {
    return null;
  }
}

async function updatePaneSnapshot(target) {
  const hash = await snapshotPaneAsync(target);
  if (hash === null) return;
  const now = Date.now();
  const prev = paneSnapshots.get(target);
  if (!prev || prev.hash !== hash) {
    paneSnapshots.set(target, { hash, changedAt: now });
  }
}

function getPaneIdleMs(target) {
  // Exact match first, then prefix match (e.g. "umiki-web" → "umiki-web:0.0")
  let prev = paneSnapshots.get(target);
  if (!prev) {
    for (const [key, snap] of paneSnapshots) {
      if (key.startsWith(target + ':')) { prev = snap; break; }
    }
  }
  if (!prev) return -1; // not tracked
  return Date.now() - prev.changedAt;
}

// Continuously track ALL panes every 2s (independent of queue)
let paneSnapshotSweepRunning = false;

// Cache offline agent session names to skip useless tmux captures
let offlineAgentSessions = new Set();
let offlineAgentCacheTs = 0;
const OFFLINE_CACHE_TTL_MS = 30_000; // refresh every 30s

async function refreshOfflineAgentCache() {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents`);
    const agentList = await r.json();
    const sessions = new Set();
    for (const a of agentList) {
      if (a.tmux && a.online === false && isLocalAgentServer(a.server)) {
        // Extract session name from tmux target (e.g. "agent:0.0" → "agent")
        const sessionName = String(a.tmux).split(':')[0];
        if (sessionName) sessions.add(sessionName);
      }
    }
    offlineAgentSessions = sessions;
    offlineAgentCacheTs = Date.now();
  } catch {
    // Keep stale cache on fetch failure
  }
}

async function sweepPaneSnapshots() {
  if (paneSnapshotSweepRunning) return;
  paneSnapshotSweepRunning = true;
  try {
    // Refresh offline cache if stale
    if (Date.now() - offlineAgentCacheTs > OFFLINE_CACHE_TTL_MS) {
      await refreshOfflineAgentCache();
    }
    const { stdout } = await execFileAsyncImpl(
      'tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf-8', timeout: 5000 }
    );
    const raw = stdout.trim();
    const livePanes = new Set(raw.split('\n').filter(Boolean));
    // Skip panes belonging to offline agents
    const activePanes = [...livePanes].filter(pane => {
      const sessionName = pane.split(':')[0];
      return !offlineAgentSessions.has(sessionName);
    });
    await Promise.all(activePanes.map((pane) => updatePaneSnapshot(pane)));
    // Clean up stale snapshots for panes that no longer exist
    for (const key of paneSnapshots.keys()) {
      if (!livePanes.has(key)) paneSnapshots.delete(key);
    }
  } catch {
    // Ignore transient tmux failures.
  } finally {
    paneSnapshotSweepRunning = false;
  }
}

setInterval(async () => {
  await sweepPaneSnapshots();
}, 2000);

// ── Alert proxy APIs ─────────────────────────────────────────────────
function alertProxyGet(routeSuffix) {
  return async (req, res) => {
    try {
      const url = new URL(`${BACKEND_V2_URL}/api/alerts${routeSuffix.replace(':id', encodeURIComponent(req.params.id || ''))}`);
      for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  };
}
function alertProxyMutate(routeSuffix, method) {
  return async (req, res) => {
    try {
      const path = routeSuffix.replace(':id', encodeURIComponent(req.params.id || ''));
      const r = await backendFetch(`${BACKEND_V2_URL}/api/alerts${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  };
}
app.get('/api/alerts', alertProxyGet(''));
app.get('/api/alerts/stats', alertProxyGet('/stats'));
app.get('/api/alerts/:id', alertProxyGet('/:id'));
app.post('/api/alerts/:id/transition', alertProxyMutate('/:id/transition', 'POST'));
app.post('/api/alerts/:id/notes', alertProxyMutate('/:id/notes', 'POST'));
app.patch('/api/alerts/:id', alertProxyMutate('/:id', 'PATCH'));
app.delete('/api/alerts/:id', alertProxyMutate('/:id', 'DELETE'));

// Backend SSE consumer — forward alert events to dashboard clients
const ALERT_SSE_EVENTS = new Set(['alert_created', 'alert_updated', 'alert_resolved', 'alert_deleted', 'message', 'task_created', 'task_updated', 'task_deleted']);
let backendSSEAbort = null;
async function connectBackendSSE() {
  if (backendSSEAbort) { try { backendSSEAbort.abort(); } catch {} }
  const ac = new AbortController();
  backendSSEAbort = ac;
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/stream`, { signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`backend SSE status ${r.status}`);
    let buf = '';
    let currentEvent = '';
    let currentData = '';
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); }
        else if (line.startsWith('data: ')) { currentData = line.slice(6); }
        else if (line === '') {
          if (ALERT_SSE_EVENTS.has(currentEvent) && currentData) {
            const frame = `event: ${currentEvent}\ndata: ${currentData}\n\n`;
            for (const c of sseClients) { try { c.write(frame); } catch {} }
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.debug(`[alert-sse] backend SSE disconnected: ${e.message}`);
    }
  }
  backendSSEAbort = null;
  setTimeout(connectBackendSSE, 5000);
}
connectBackendSSE();

// ── Target redirects (e.g. renamed sessions) ────────────────────────
const REDIRECT_FILE = path.join(LOGS_ROOT, 'redirects.json');
const redirects = new Map(); // old target → new target

try {
  const raw = await readFileAsync(REDIRECT_FILE, 'utf-8');
  for (const [k, v] of Object.entries(JSON.parse(raw))) redirects.set(k, v);
  console.log(`Loaded ${redirects.size} redirects`);
} catch (e) {
  console.debug(`[server] redirects load skipped: ${e.message}`);
}

function saveRedirects() {
  try { writeFileSync(REDIRECT_FILE, JSON.stringify(Object.fromEntries(redirects))); } catch (e) {
    console.debug(`[server] redirects save skipped: ${e.message}`);
  }
}

// API to manage redirects
app.get('/api/redirects', (_req, res) => res.json(Object.fromEntries(redirects)));

app.post('/api/redirects', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'missing from or to' });
  redirects.set(from, to);
  saveRedirects();
  // Rewrite any queued messages with the old target
  const old = queue.get(from);
  if (old && old.length > 0) {
    for (const entry of old) { entry.redirectedFrom = entry.to; entry.to = to; }
    if (!queue.has(to)) queue.set(to, []);
    queue.get(to).push(...old);
    queue.delete(from);
    saveQueue();
    broadcastQueue();
  }
  res.json({ ok: true, from, to, requeued: old?.length || 0 });
});

app.delete('/api/redirects/:from', (req, res) => {
  redirects.delete(req.params.from);
  saveRedirects();
  res.json({ ok: true });
});

// Deliver message to tmux pane without blocking the event loop.
async function deliverMessage(entry) {
  const formatExecError = (e) => {
    const stderr = (e && e.stderr) ? String(e.stderr).trim() : '';
    const stdout = (e && e.stdout) ? String(e.stdout).trim() : '';
    if (stderr) return stderr;
    if (stdout) return stdout;
    return e?.message || 'unknown error';
  };
  try {
    let finalPayload = entry.payload;
    if (entry.redirectedFrom) {
      finalPayload += '\n[REDIRECT NOTICE] This message was originally addressed to "' + entry.redirectedFrom + '" which has been renamed to "' + entry.to + '". Please update your target for future messages.';
    }
    try {
      await execFileAsyncImpl('tmux', ['send-keys', '-l', '-t', entry.to, finalPayload], { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      console.error(`Failed to deliver to ${entry.to} (payload step): ${formatExecError(e)}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await execFileAsyncImpl('tmux', ['send-keys', '-t', entry.to, 'C-m'], { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      console.error(`Failed to deliver to ${entry.to} (enter step): ${formatExecError(e)}`);
      return false;
    }

    // Log to messages.jsonl
    const deliveredAt = Date.now();
    const logData = { ts: deliveredAt, from: entry.from, to: entry.to, payload: entry.payload };
    if (entry.notifyMeta) logData.notifyMeta = entry.notifyMeta;
    const logEntry = JSON.stringify(logData);
    appendFile(LOG_FILE, logEntry + '\n').catch(() => {});
    void notifyPushDelivered(entry, deliveredAt);
    return true;
  } catch (e) {
    console.error(`Failed to deliver to ${entry.to} (unexpected):`, e?.message || e);
    return false;
  }
}

// Track delivery state per target: don't re-check until previous delivery settles
const delivering = new Set();

// Poll loop
setInterval(async () => {
  if (queueTickRunning) return;
  queueTickRunning = true;
  try {
    for (const [target, initialEntries] of queue) {
      let entries = initialEntries;
      if (entries.length === 0) { queue.delete(target); continue; }
      if (delivering.has(target)) continue;

      let unreadSnapshot = null;
      if (entries.some(isBackendNotificationEntry)) {
        const agentName = targetSessionName(target);
        unreadSnapshot = await fetchUnreadSnapshot(agentName);
        if (unreadSnapshot) {
          const dropped = [];
          const kept = [];
          for (const entry of entries) {
            if (isStaleNotificationBySnapshot(entry, unreadSnapshot)) dropped.push(entry);
            else kept.push(entry);
          }
          if (dropped.length > 0) {
            console.log(`[queue] Dropping ${dropped.length} stale notification(s) for ${target} (unread changed)`);
            archiveDroppedQueueEntries(dropped, 'stale-notification-unread-changed', target);
            if (kept.length === 0) {
              queue.delete(target);
              saveQueue();
              broadcastQueue();
              continue;
            }
            queue.set(target, kept);
            entries = kept;
            saveQueue();
            broadcastQueue();
          }
        }
      }

      const idleMs = getPaneIdleMs(target);
      const priority = normalizeQueuePriority(entries[0]?.priority || entries[0]?.notifyMeta?.priority);
      const bypassIdleGate = priority === 'high' || priority === 'urgent';
      if (idleMs < 0) {
        // Pane not found — only trim stale backend notifications, keep normal payloads queued.
        const oldest = entries[0];
        if (oldest && Date.now() - oldest.queuedAt > 5 * 60 * 1000) {
          const dropped = [];
          const kept = [];
          for (const entry of entries) {
            if (isBackendNotificationEntry(entry)) dropped.push(entry);
            else kept.push(entry);
          }
          if (dropped.length > 0) {
            console.log(`[queue] Dropping ${dropped.length} stale notification(s) for ${target} (pane not found, age > 5m)`);
            archiveDroppedQueueEntries(dropped, 'pane-missing-over-5m', target);
            if (kept.length === 0) queue.delete(target);
            else queue.set(target, kept);
            saveQueue();
            broadcastQueue();
          }
        }
        continue;
      }
      if (!bypassIdleGate && idleMs < IDLE_THRESHOLD) continue; // not idle enough

      // Deliver first message
      delivering.add(target);
      const entry = entries.shift();
      if (entries.length === 0) queue.delete(target);
      saveQueue();
      broadcastQueue();

      const stale = unreadSnapshot && isBackendNotificationEntry(entry)
        ? isStaleNotificationBySnapshot(entry, unreadSnapshot)
        : await isStaleNotificationEntry(entry);
      if (stale) {
        console.log(`[queue] Dropped stale notification ${entry.id} for ${target}`);
        archiveDroppedQueueEntries([entry], 'stale-notification-on-deliver', target);
        delivering.delete(target);
        continue;
      }

      const ok = await deliverMessage(entry);
      if (!ok && entry) {
        // Put it back at front
        if (!queue.has(target)) queue.set(target, []);
        queue.get(target).unshift(entry);
        saveQueue();
        broadcastQueue();
      }
      // Wait a bit before allowing next delivery to same target
      setTimeout(() => delivering.delete(target), IDLE_THRESHOLD + 2000);
    }
    // Broadcast updated idle times to frontend while queue is non-empty
    if (queue.size > 0) broadcastQueue();
  } finally {
    queueTickRunning = false;
  }
}, POLL_INTERVAL);

// ── Delayed Reminders ────────────────────────────────────────────────
const REMINDER_FILE = path.join(LOGS_ROOT, 'reminders.json');
const reminders = []; // Array<{id, target, msg, createdAt, fireAt}>
let reminderIdCounter = 0;

function saveReminders() {
  try {
    writeFileSync(REMINDER_FILE, JSON.stringify({ idCounter: reminderIdCounter, items: reminders }));
  } catch (e) {
    console.debug(`[server] reminders save skipped: ${e.message}`);
  }
}

// Load from disk
try {
  const raw = await readFileAsync(REMINDER_FILE, 'utf-8');
  const data = JSON.parse(raw);
  reminderIdCounter = data.idCounter || 0;
  for (const r of (data.items || [])) reminders.push(r);
  console.log(`Restored ${reminders.length} reminders from disk`);
} catch (e) {
  console.debug(`[server] reminders load skipped: ${e.message}`);
}

function reminderSnapshot() {
  const now = Date.now();
  return reminders.map(r => ({ ...r, remainingMs: Math.max(0, r.fireAt - now) }));
}

function broadcastReminders() {
  const items = reminderSnapshot();
  const frame = `event: reminders\ndata: ${JSON.stringify(items)}\n\n`;
  for (const c of sseClients) c.write(frame);
}

function formatRelativeTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm' + (sec % 60) + 's ago';
  const hr = Math.floor(min / 60);
  return hr + 'h' + (min % 60) + 'm ago';
}

function extractReminderMessage(rawValue) {
  const raw = String(rawValue || '').replace(/^\[Self Time Reminder\]\s*/, '').trim();
  if (!raw) return '(empty)';
  const match = raw.match(/\bMsg:\s*([\s\S]*)$/);
  if (match && match[1] && match[1].trim()) return match[1].trim();
  return raw;
}

function reminderItemFromInput(reminder, firedAt) {
  const createdAt = Number(reminder?.createdAt) > 0 ? Number(reminder.createdAt) : firedAt;
  const msg = extractReminderMessage(reminder?.msg);
  return { createdAt, firedAt, msg };
}

function normalizeReminderItems(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.reminderItems) && entry.reminderItems.length > 0) {
    return entry.reminderItems.map(item => ({
      createdAt: Number(item?.createdAt) > 0 ? Number(item.createdAt) : Date.now(),
      firedAt: Number(item?.firedAt) > 0 ? Number(item.firedAt) : Date.now(),
      msg: extractReminderMessage(item?.msg),
    }));
  }
  const fallbackTs = Number(entry.queuedAt) > 0 ? Number(entry.queuedAt) : Date.now();
  return [{
    createdAt: fallbackTs,
    firedAt: fallbackTs,
    msg: extractReminderMessage(entry.payload),
  }];
}

function renderReminderPayload(items) {
  const normalized = Array.isArray(items) ? items : [];
  if (normalized.length <= 1) {
    const item = normalized[0] || { createdAt: Date.now(), firedAt: Date.now(), msg: '(empty)' };
    const elapsed = Math.max(0, item.firedAt - item.createdAt);
    return `[Self Time Reminder] From ts:${item.createdAt} (${formatRelativeTime(elapsed)}), Now ts:${item.firedAt}, Msg: ${item.msg}`;
  }

  const preview = normalized.slice(-REMINDER_MERGE_PREVIEW_LIMIT);
  const omitted = Math.max(0, normalized.length - preview.length);
  const lines = preview.map((item, idx) => {
    const elapsed = Math.max(0, item.firedAt - item.createdAt);
    return `${idx + 1}. From ts:${item.createdAt} (${formatRelativeTime(elapsed)}), Now ts:${item.firedAt}, Msg: ${item.msg}`;
  });
  if (omitted > 0) lines.push(`... ${omitted} older reminder(s) omitted`);
  return `[Self Time Reminder] ${normalized.length} reminders due (latest ${preview.length} shown):\n${lines.join('\n')}`;
}

function enqueueReminder(reminder) {
  const now = Date.now();
  const target = String(reminder?.target || '').trim();
  if (!target) return;
  const newItem = reminderItemFromInput(reminder, now);

  if (!queue.has(target)) queue.set(target, []);
  const bucket = queue.get(target);
  const mergedEntry = bucket[bucket.length - 1]?.isReminder === true
    ? bucket[bucket.length - 1]
    : null;

  if (mergedEntry) {
    const items = normalizeReminderItems(mergedEntry);
    items.push(newItem);
    mergedEntry.reminderItems = items;
    mergedEntry.reminderCount = items.length;
    mergedEntry.payload = renderReminderPayload(items);
    return;
  }

  const items = [newItem];
  const payload = renderReminderPayload(items);
  const entry = {
    id: ++queueIdCounter,
    from: target,
    to: target,
    payload,
    queuedAt: now,
    isReminder: true,
    reminderItems: items,
    reminderCount: 1,
  };
  bucket.push(entry);
}

function fireReminder(reminder) {
  enqueueReminder(reminder);
}

// Timer: check every second for due reminders
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].fireAt <= now) {
      fireReminder(reminders[i]);
      reminders.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    saveReminders();
    saveQueue();
    broadcastReminders();
    broadcastQueue();
  }
  // Periodically broadcast remaining times while reminders exist
  if (reminders.length > 0) broadcastReminders();
}, 1000);

// POST /api/reminders — create a reminder
app.post('/api/reminders', (req, res) => {
  const { target, delay, msg } = req.body;
  if (!target || !delay || !msg) return res.status(400).json({ error: 'missing target, delay, or msg' });
  const delaySec = Number(delay);
  if (isNaN(delaySec) || delaySec <= 0) return res.status(400).json({ error: 'delay must be positive number (seconds)' });
  const now = Date.now();
  const id = ++reminderIdCounter;
  const reminder = { id, target, msg, createdAt: now, fireAt: now + delaySec * 1000 };
  reminders.push(reminder);
  saveReminders();
  broadcastReminders();
  res.json({ ok: true, id, fireAt: reminder.fireAt, remainingMs: delaySec * 1000 });
});

// GET /api/reminders
app.get('/api/reminders', (_req, res) => {
  res.json(reminderSnapshot());
});

// DELETE /api/reminders/:id
app.delete('/api/reminders/:id', (req, res) => {
  const id = Number(req.params.id);
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  reminders.splice(idx, 1);
  saveReminders();
  broadcastReminders();
  res.json({ ok: true, deleted: id });
});

// ── Alerts page ──────────────────────────────────────────────────────
app.get('/alerts', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderAlertsPage());
});

app.get('/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderConfigPage());
});

// ── Frontend ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(HTML);
});

app.get('/agents/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).type('text').send('invalid agent name');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderAgentDetailPage(name));
});

app.get('/agents/:name/audit', (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).type('text').send('invalid agent name');
  const target = `/agents/${encodeURIComponent(name)}#audit`;
  res.redirect(302, target);
});

let serverInstance = null;
function startServer({ port = PORT, host = '127.0.0.1' } = {}) {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(port, host, () => {
    console.log(`agent-viz running on http://${host}:${port}`);
  });
  return serverInstance;
}

function stopServer() {
  if (!serverInstance) return;
  const active = serverInstance;
  serverInstance = null;
  active.close();
}

function setServerTestHooks({ execFileAsync: overrideExecFileAsync } = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : execFileAsync;
}

function resetServerTestHooks() {
  execFileAsyncImpl = execFileAsync;
}

export {
  app,
  deliverMessage,
  getPaneIdleMs,
  resetServerTestHooks,
  setServerTestHooks,
  snapshotPaneAsync,
  startServer,
  stopServer,
  sweepPaneSnapshots,
  updatePaneSnapshot,
};

if (process.argv[1] === __filename) {
  startServer();
}

function renderAgentDetailPage(agentName) {
  const safeName = String(agentName).replace(/[&<>"]/g, (ch) => (
    ch === '&' ? '&amp;' : (ch === '<' ? '&lt;' : (ch === '>' ? '&gt;' : '&quot;'))
  ));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Detail · ${safeName}</title>
<style>
*{box-sizing:border-box}
:root{
  --bg:#08101a;
  --bg-soft:#0d1723;
  --panel:#0f1b29;
  --panel-2:#111f30;
  --border:rgba(154,182,210,0.18);
  --border-strong:rgba(154,182,210,0.28);
  --text:#e7eef7;
  --muted:rgba(215,227,241,0.62);
  --muted-2:rgba(215,227,241,0.42);
  --ok:#46c77a;
  --warn:#f0b34a;
  --danger:#f36b7d;
  --accent:#6dc1ff;
}
html,body{margin:0;min-height:100%;background:
  radial-gradient(circle at top left,rgba(38,72,112,0.32),transparent 34%),
  linear-gradient(180deg,#07111a 0%,#08101a 100%);
  color:var(--text);
  font-family:'SF Mono','Fira Code','Consolas',monospace;
}
:root{--detail-tabs-top:156px}
button,input,textarea{font:inherit}
a{color:var(--accent)}
.page{max-width:1240px;margin:0 auto;padding:20px 20px 40px}
.hero{
  position:sticky;top:0;z-index:20;
  background:linear-gradient(180deg,rgba(8,16,26,1) 0%,rgba(8,16,26,1) 100%);
  backdrop-filter:blur(16px);
  border:1px solid var(--border);
  border-radius:18px;
  padding:18px 18px 16px;
  box-shadow:0 18px 40px rgba(0,0,0,0.24);
}
.hero-top{
  display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;
}
.back-link{
  display:inline-flex;align-items:center;gap:6px;
  color:var(--muted);text-decoration:none;font-size:11px;letter-spacing:1px;
}
.back-link:hover{color:var(--text)}
.hero-actions{display:flex;gap:8px;flex-wrap:wrap}
.hero-btn{
  border:1px solid var(--border-strong);
  background:rgba(255,255,255,0.03);
  color:var(--text);
  border-radius:999px;
  padding:7px 12px;
  cursor:pointer;
  font-size:10px;
  letter-spacing:1px;
}
.hero-btn:hover{border-color:rgba(154,182,210,0.45)}
.hero-btn.warn{color:var(--warn);border-color:rgba(240,179,74,0.32)}
.hero-btn.warn:hover{border-color:rgba(240,179,74,0.62)}
.hero-btn.danger{color:var(--danger);border-color:rgba(243,107,125,0.32)}
.hero-btn.danger:hover{border-color:rgba(243,107,125,0.62)}
.hero-kicker{margin-top:10px;color:var(--muted-2);font-size:11px;letter-spacing:1.8px;text-transform:uppercase}
.hero-title-row{
  margin-top:8px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;
}
.hero-title{margin:0;font-size:30px;line-height:1.1;letter-spacing:-0.02em}
.hero-runtime{font-size:11px;color:var(--muted)}
.chip-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 10px;border-radius:999px;border:1px solid var(--border);
  background:rgba(255,255,255,0.03);font-size:10px;letter-spacing:0.8px;color:var(--text);
}
.chip.ok{border-color:rgba(70,199,122,0.35);color:var(--ok);background:rgba(70,199,122,0.10)}
.chip.warn{border-color:rgba(240,179,74,0.35);color:var(--warn);background:rgba(240,179,74,0.10)}
.chip.danger{border-color:rgba(243,107,125,0.35);color:var(--danger);background:rgba(243,107,125,0.10)}
.chip.neutral{color:var(--accent);border-color:rgba(109,193,255,0.28);background:rgba(109,193,255,0.08)}
.health-summary{margin-top:12px;font-size:14px;line-height:1.5;color:var(--text)}
.health-summary.health-error{color:rgba(248,113,113,0.9);padding:8px 12px;border-radius:6px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.25)}
.exception-banner{
  margin-top:14px;
  border:1px solid rgba(243,107,125,0.3);
  background:rgba(243,107,125,0.12);
  color:#ffdce2;
  border-radius:14px;
  padding:12px 14px;
}
.exception-banner.warn{
  border-color:rgba(240,179,74,0.32);
  background:rgba(240,179,74,0.12);
  color:#ffe8c0;
}
.hidden{display:none !important}
.detail-status{
  min-height:20px;
  margin:14px 4px 0;
  font-size:11px;
}
.detail-status-ok{color:var(--ok)}
.detail-status-warn{color:var(--warn)}
.detail-status-error{color:var(--danger)}
.top-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:14px;
  margin-top:14px;
}
.split-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:14px;
  margin-top:14px;
}
.stack{display:flex;flex-direction:column;gap:14px}
.panel{
  background:linear-gradient(180deg,rgba(15,27,41,0.94) 0%,rgba(11,21,32,0.98) 100%);
  border:1px solid var(--border);
  border-radius:16px;
  padding:16px;
  box-shadow:0 12px 24px rgba(0,0,0,0.18);
}
.panel-head{
  display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;
}
.panel-label{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted-2)}
.primary-text{margin-top:10px;font-size:20px;line-height:1.35;color:var(--text)}
.secondary-text{margin-top:8px;font-size:12px;line-height:1.55;color:var(--text)}
.muted{color:var(--muted)}
.meta-list{
  display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;
}
.meta-item{
  padding:6px 9px;border-radius:10px;background:rgba(255,255,255,0.03);
  border:1px solid rgba(154,182,210,0.12);font-size:10px;color:var(--muted);
}
.event-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.event-item{
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(255,255,255,0.025);
  border-radius:12px;
  padding:10px 12px;
}
.event-row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.event-time{font-size:10px;color:var(--muted-2);white-space:nowrap}
.event-main{font-size:12px;line-height:1.45;color:var(--text)}
.event-meta{margin-top:4px;font-size:10px;color:var(--muted)}

/* Subconscious Event Redesign */
.hook-badge{
  display:inline-block;font-size:9px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;padding:2px 7px;border-radius:6px;line-height:1.4;
  white-space:nowrap;vertical-align:middle;
}
.hook-badge.hook-session{background:rgba(99,179,237,0.15);color:#63b3ed}
.hook-badge.hook-prompt{background:rgba(154,230,180,0.15);color:#9ae6b4}
.hook-badge.hook-tool{background:rgba(246,173,85,0.15);color:#f6ad55}
.hook-badge.hook-stop{background:rgba(203,166,247,0.15);color:#cba6f7}
.hook-badge.hook-unknown{background:rgba(154,182,210,0.08);color:var(--muted)}

.event-item.ev-injected{
  border-color:rgba(154,230,180,0.22);
  background:rgba(154,230,180,0.03);
}
.event-item.ev-runtime{
  border-color:rgba(99,179,237,0.18);
}

.event-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.ev-chip{
  font-size:9px;padding:1px 6px;border-radius:5px;
  background:rgba(154,182,210,0.08);color:var(--muted);
}
.ev-chip.chip-injected{background:rgba(154,230,180,0.12);color:#9ae6b4}
.ev-chip.chip-runtime{background:rgba(99,179,237,0.12);color:#63b3ed}
.ev-chip.chip-error{background:rgba(252,129,129,0.12);color:#fc8181}

.event-summary{
  margin-top:5px;font-size:11px;line-height:1.45;
  color:var(--muted);
  border-left:2px solid rgba(154,182,210,0.1);
  padding-left:8px;
}

.guidance-preview{
  margin-top:8px;padding:8px 10px;
  border-radius:8px;font-size:11px;line-height:1.45;
  border:1px solid rgba(154,182,210,0.1);
}
.guidance-preview.gp-manual{
  background:rgba(246,173,85,0.04);border-color:rgba(246,173,85,0.12);
}
.guidance-preview.gp-runtime{
  background:rgba(99,179,237,0.04);border-color:rgba(99,179,237,0.12);
}
.guidance-label{
  font-size:9px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;color:var(--muted);margin-bottom:4px;
}
.guidance-text{font-size:11px;color:var(--text);line-height:1.5}

.hook-breakdown{
  display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;
}
.hook-count{
  font-size:10px;color:var(--muted);
  display:flex;align-items:center;gap:4px;
}
.hook-count .hook-badge{font-size:8px;padding:1px 5px}

.debug-sub-section{margin-bottom:14px}
.debug-sub-label{
  font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.5px;color:var(--muted);
  margin-bottom:6px;padding-bottom:4px;
  border-bottom:1px solid rgba(154,182,210,0.08);
}

.sub-section{margin-top:16px}
.sub-section-label{
  font-size:11px;font-weight:600;color:var(--text);
  margin-bottom:8px;display:flex;align-items:center;gap:6px;
}
.sub-section-label .section-count{
  font-size:9px;font-weight:500;color:var(--muted);
  background:rgba(154,182,210,0.08);padding:1px 6px;border-radius:5px;
}
.sub-divider{
  height:1px;background:rgba(154,182,210,0.08);margin:14px 0;
}
.sub-detail{
  margin-top:10px;
}
.sub-detail>summary{
  font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;color:var(--muted);cursor:pointer;
  padding:6px 0;user-select:none;
}
.sub-detail>summary:hover{color:var(--text)}
.sub-detail>.sub-detail-body{
  margin-top:8px;
}

.subconscious-mode-indicator{
  display:inline-flex;align-items:center;gap:5px;
  font-size:11px;padding:4px 10px;border-radius:8px;
  background:rgba(154,182,210,0.06);
  border:1px solid rgba(154,182,210,0.1);
  color:var(--muted);margin-top:6px;
}
.mode-dot{
  width:6px;height:6px;border-radius:50%;
  background:var(--muted);
}
.mode-dot.dot-active{background:#9ae6b4}
.mode-dot.dot-runtime{background:#63b3ed}
.mode-dot.dot-off{background:rgba(154,182,210,0.3)}

.inline-link{
  background:none;border:none;padding:0;color:var(--accent);cursor:pointer;font-size:11px;
}
.inline-link:hover{text-decoration:underline}
.tab-shell{margin-top:18px}
.tabs{
  display:flex;gap:8px;flex-wrap:wrap;
  position:sticky;top:var(--detail-tabs-top);z-index:21;
  margin-bottom:14px;padding:8px;
  background:rgba(8,16,26,1);
  backdrop-filter:blur(14px);
  border:1px solid var(--border);
  border-radius:14px;
}
.tab-btn{
  border:1px solid transparent;
  background:transparent;
  color:var(--muted);
  border-radius:999px;
  padding:8px 12px;
  cursor:pointer;
  font-size:11px;
  letter-spacing:0.9px;
}
.tab-btn:hover{color:var(--text);border-color:rgba(154,182,210,0.18)}
.tab-btn.active{
  background:rgba(109,193,255,0.12);
  color:var(--accent);
  border-color:rgba(109,193,255,0.28);
}
.tab-panel{display:block}
.summary-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
  gap:10px;
  margin-top:12px;
}
.summary-stat{
  border:1px solid rgba(154,182,210,0.12);
  border-radius:12px;
  background:rgba(255,255,255,0.03);
  padding:10px 12px;
}
.summary-k{font-size:10px;color:var(--muted-2);letter-spacing:1px}
.summary-v{margin-top:4px;font-size:18px;color:var(--text)}
.summary-note{
  margin-top:12px;
  padding:12px;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(255,255,255,0.02);
  font-size:12px;
  color:var(--muted);
  line-height:1.55;
}
.list{
  margin:10px 0 0 0;
  padding-left:18px;
  color:var(--text);
  font-size:12px;
  line-height:1.55;
}
.list.tight{margin-top:6px}
.read-block{
  margin-top:10px;
  padding:11px 12px;
  border-radius:12px;
  background:rgba(255,255,255,0.025);
  border:1px solid rgba(154,182,210,0.12);
  font-size:12px;
  line-height:1.55;
  color:var(--text);
}
.field-label{
  margin-top:12px;
  font-size:10px;
  letter-spacing:1.2px;
  text-transform:uppercase;
  color:var(--muted-2);
}
.detail-input,
.detail-textarea{
  width:100%;
  margin-top:6px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(109,193,255,0.24);
  border-radius:12px;
  color:var(--text);
  padding:10px 12px;
  outline:none;
  font-size:12px;
}
select{cursor:pointer}
select option{
  background:#0d1723;
  color:#e2eaf3;
}
.detail-input:focus,
.detail-textarea:focus{border-color:rgba(109,193,255,0.62)}
.detail-textarea{resize:vertical;min-height:110px;line-height:1.5}
.detail-toggle{
  display:flex;align-items:center;gap:8px;
  margin-top:14px;font-size:12px;color:var(--text);
}
.detail-actions{
  margin-top:12px;
  display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
}
.detail-save{
  background:rgba(109,193,255,0.12);
  border:1px solid rgba(109,193,255,0.32);
  color:var(--accent);
  border-radius:999px;
  padding:8px 14px;
  cursor:pointer;
  font-size:11px;
  letter-spacing:1px;
}
.detail-save:hover{border-color:rgba(109,193,255,0.62)}
.detail-save:disabled{opacity:0.45;cursor:default}
.detail-hint{font-size:11px;color:var(--muted);line-height:1.55}
.task-advanced{margin-top:10px}
.task-advanced-toggle{font-size:11px;color:var(--muted);cursor:pointer;letter-spacing:0.5px}
.task-advanced-toggle:hover{color:var(--text)}
.task-advanced[open] .task-advanced-toggle{color:var(--text)}
.task-list-table{width:100%;border-collapse:collapse;font-size:12px}
.task-list-table th{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(154,182,210,0.2);color:var(--muted);font-weight:500;font-size:11px;letter-spacing:0.5px}
.task-list-table td{padding:5px 8px;border-bottom:1px solid rgba(154,182,210,0.08);vertical-align:top}
.task-list-table tr:hover{background:rgba(109,193,255,0.04);cursor:pointer}
.task-status-badge{display:inline-block;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:600;letter-spacing:0.4px}
.task-status-created{background:rgba(154,182,210,0.15);color:rgba(154,182,210,0.9)}
.task-status-accepted{background:rgba(109,193,255,0.15);color:rgba(109,193,255,0.9)}
.task-status-in_progress{background:rgba(100,220,160,0.15);color:rgba(100,220,160,0.9)}
.task-status-blocked{background:rgba(255,160,80,0.15);color:rgba(255,160,80,0.9)}
.task-status-done{background:rgba(120,120,140,0.15);color:rgba(120,120,140,0.9)}
.task-priority-badge{font-size:10px;font-weight:600;letter-spacing:0.3px}
.task-priority-p0{color:rgba(255,80,80,0.9)}
.task-priority-p1{color:rgba(255,160,80,0.9)}
.task-priority-p2{color:var(--muted)}
.task-priority-p3{color:rgba(120,120,140,0.7)}
.task-create-form{display:flex;flex-direction:column;gap:8px}
.task-create-form textarea{min-height:60px;resize:vertical}
.task-create-row{display:flex;gap:8px;align-items:center}
.task-detail-back{font-size:11px;color:var(--accent);cursor:pointer;margin-bottom:8px;display:inline-block}
.task-detail-back:hover{text-decoration:underline}
.task-detail-title{font-size:15px;font-weight:600;margin-bottom:6px}
.task-detail-meta{font-size:11px;color:var(--muted);margin-bottom:10px}
.task-detail-desc{font-size:12px;line-height:1.6;margin-bottom:14px;white-space:pre-wrap}
.task-comments{margin-top:10px}
.task-comment{padding:8px 10px;border-left:2px solid rgba(109,193,255,0.3);margin-bottom:8px;background:rgba(0,0,0,0.12);border-radius:0 6px 6px 0}
.task-comment-meta{font-size:10px;color:var(--muted);margin-bottom:3px}
.task-comment-text{font-size:12px;line-height:1.5;white-space:pre-wrap}
.task-comment-form{display:flex;gap:8px;align-items:flex-end;margin-top:8px}
.task-comment-form textarea{flex:1;min-height:40px;resize:vertical}
.task-empty-state{text-align:center;color:var(--muted);padding:24px 0;font-size:12px}
.task-status-select{font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.2);border:1px solid rgba(154,182,210,0.15);color:var(--text);border-radius:4px}
.doc-frame{
  margin-top:10px;
  padding:12px;
  min-height:140px;
  max-height:420px;
  overflow:auto;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(0,0,0,0.18);
  font-family:'SF Mono','Fira Code','Consolas',monospace;
  font-size:11px;
  line-height:1.55;
  color:var(--text);
  white-space:pre-wrap;
  word-break:break-word;
}
.empty-state{font-size:12px;line-height:1.55;color:var(--muted);padding:6px 0}
.error-state{font-size:12px;line-height:1.55;padding:8px 12px;border-radius:6px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.25);color:rgba(248,113,113,0.85)}
.mono{font-family:'SF Mono','Fira Code','Consolas',monospace}
.debug-detail{
  border:1px solid rgba(154,182,210,0.12);
  border-radius:14px;
  background:rgba(255,255,255,0.02);
  overflow:hidden;
}
.debug-detail summary{
  list-style:none;cursor:pointer;padding:14px 16px;font-size:11px;letter-spacing:1.2px;
  text-transform:uppercase;color:var(--muted);background:rgba(255,255,255,0.02);
}
.debug-detail summary::-webkit-details-marker{display:none}
.debug-body{padding:0 16px 16px}
.debug-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  gap:12px;
}
.debug-kv{
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.1);
  background:rgba(255,255,255,0.02);
  font-size:11px;
  line-height:1.55;
  color:var(--muted);
}
.debug-kv b{display:block;color:var(--text);margin-bottom:4px}
.audit-wrap{
  margin-top:14px;
  overflow:auto;
  border:1px solid rgba(154,182,210,0.14);
  border-radius:14px;
  background:rgba(255,255,255,0.02);
}
table{
  width:100%;
  min-width:920px;
  border-collapse:collapse;
}
th,td{
  text-align:left;
  padding:10px 12px;
  border-bottom:1px solid rgba(154,182,210,0.09);
  font-size:11px;
  vertical-align:top;
}
th{
  position:sticky;top:0;
  background:#111c2a;
  color:var(--muted);
  letter-spacing:1px;
  text-transform:uppercase;
}
.status{
  display:inline-block;
  padding:4px 8px;
  border-radius:999px;
  border:1px solid var(--border);
  font-size:10px;
  letter-spacing:0.8px;
}
.status-focused{color:var(--ok);border-color:rgba(70,199,122,0.32);background:rgba(70,199,122,0.10)}
.status-negative{color:var(--danger);border-color:rgba(243,107,125,0.32);background:rgba(243,107,125,0.10)}
.status-unknown{color:var(--warn);border-color:rgba(240,179,74,0.32);background:rgba(240,179,74,0.10)}
.modal{
  position:fixed;inset:0;z-index:40;
  display:flex;align-items:center;justify-content:center;
  background:rgba(3,7,11,0.68);padding:18px;
}
.modal-card{
  width:min(460px,100%);
  border-radius:16px;
  border:1px solid rgba(243,107,125,0.24);
  background:#0d1723;
  box-shadow:0 24px 54px rgba(0,0,0,0.35);
  padding:18px;
}
.modal-title{font-size:18px;color:var(--text)}
.modal-copy{margin-top:10px;font-size:13px;line-height:1.6;color:var(--muted)}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}
.dm-container{display:flex;flex-direction:column;height:min(600px,70vh)}
.dm-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.dm-empty{color:var(--muted);text-align:center;padding:40px 0;font-size:13px}
.dm-msg{max-width:80%;width:fit-content;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.dm-msg.outgoing{align-self:flex-end;background:rgba(109,193,255,0.15);border:1px solid rgba(109,193,255,0.25);color:var(--text)}
.dm-msg.incoming{align-self:flex-start;background:rgba(154,182,210,0.08);border:1px solid rgba(154,182,210,0.15);color:var(--text)}
.dm-msg-meta{font-size:10px;color:var(--muted);margin-top:3px}
.dm-msg-from{font-weight:600;font-size:11px;margin-bottom:2px;color:var(--accent)}
.dm-msg.outgoing .dm-msg-from{color:rgba(109,193,255,0.7)}
.dm-input-row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(154,182,210,0.12)}
.dm-input{flex:1;background:rgba(154,182,210,0.06);border:1px solid rgba(154,182,210,0.18);border-radius:8px;color:var(--text);padding:8px 12px;font:inherit;font-size:13px;resize:none;min-height:38px;max-height:120px}
.dm-input:focus{outline:none;border-color:var(--accent)}
.dm-name-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(154,182,210,0.12)}
.dm-name-label{font-size:11px;color:var(--muted);white-space:nowrap}
.dm-name-input{width:120px;background:rgba(154,182,210,0.06);border:1px solid rgba(154,182,210,0.18);border-radius:6px;color:var(--text);padding:5px 8px;font:inherit;font-size:12px}
.dm-name-input:focus{outline:none;border-color:var(--accent)}
.dm-send-btn{background:rgba(109,193,255,0.15);border:1px solid rgba(109,193,255,0.30);color:var(--accent);border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}
.dm-send-btn:hover{background:rgba(109,193,255,0.25)}
.dm-send-btn:disabled{opacity:0.4;cursor:not-allowed}
@media (max-width:920px){
  .page{padding:14px 14px 32px}
  .hero{position:static}
  .tabs{position:static}
  .top-grid,.split-grid{grid-template-columns:1fr}
  .hero-title{font-size:26px}
}
</style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div class="hero-top">
        <a class="back-link" href="/">← Back to Monitor</a>
        <div class="hero-actions">
          <button class="hero-btn" onclick="openSupervisorAudit()">View Supervisor Audit</button>
          <button class="hero-btn warn" onclick="requestDangerAction('down')">Stop Agent</button>
          <button class="hero-btn danger" onclick="requestDangerAction('delete')">Remove Agent</button>
        </div>
      </div>
      <div class="hero-kicker">Agent Detail</div>
      <div class="hero-title-row">
        <h1 class="hero-title" id="hero-title">${safeName}</h1>
        <div class="hero-runtime muted" id="hero-runtime">Runtime details pending first refresh.</div>
      </div>
      <div class="chip-row" id="header-chips"></div>
      <div class="health-summary muted" id="health-summary">Runtime, delivery, and subconscious path facts appear after the first refresh.</div>
    </header>

    <div id="exception-banner" class="exception-banner hidden"></div>
    <div id="detail-status" class="detail-status muted"></div>

    <section class="top-grid">
      <article class="panel">
        <div class="panel-label">Message Delivery</div>
        <div id="overview-delivery"></div>
      </article>
      <article class="panel">
        <div class="panel-label">Agent Metadata</div>
        <div id="overview-projects"></div>
      </article>
    </section>

    <div class="tab-shell">
      <div class="tabs">
        <button class="tab-btn active" data-tab="settings" onclick="setActiveTab('settings')">Settings</button>
        <button class="tab-btn" data-tab="tasks" onclick="setActiveTab('tasks')">Tasks</button>
        <button class="tab-btn" data-tab="dm" onclick="setActiveTab('dm')">DM</button>
        <button class="tab-btn" data-tab="supervisor" onclick="setActiveTab('supervisor')">Supervisor</button>
        <button class="tab-btn" data-tab="subconscious" onclick="setActiveTab('subconscious')">Subconscious</button>
        <button class="tab-btn" data-tab="internals" onclick="setActiveTab('internals')">Internals</button>
      </div>

      <section id="tab-settings" class="tab-panel">
        <div class="stack">
          <article class="panel">
            <div class="panel-label">Identity</div>
            <div id="settings-identity"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Guidance</div>
            <div id="settings-guidance"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Configuration</div>
            <div id="settings-configuration"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Framework Presets</div>
            <div id="settings-presets"></div>
          </article>
          <article class="panel">
            <div class="panel-label">System Controls</div>
            <div id="settings-systems" class="split-grid"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Ownership</div>
            <div id="settings-owner"></div>
          </article>
        </div>
      </section>

      <section id="tab-tasks" class="tab-panel hidden">
        <article class="panel">
          <div class="panel-label">Create Task</div>
          <div class="task-create-form">
            <textarea id="task-create-title" class="detail-textarea" placeholder="Task title / description" style="min-height:50px"></textarea>
            <div class="task-create-row">
              <select id="task-create-priority" class="detail-input" style="width:80px">
                <option value="p0">P0</option>
                <option value="p1">P1</option>
                <option value="p2" selected>P2</option>
                <option value="p3">P3</option>
              </select>
              <input id="task-create-assignee" class="detail-input" placeholder="Assignee (optional)" style="flex:1">
              <button class="detail-save" onclick="taskCreateSubmit()">Create</button>
            </div>
            <div id="task-create-status" class="detail-status muted" style="font-size:11px"></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-label">Tasks</div>
          <div id="task-list-root"></div>
        </article>
        <article class="panel hidden" id="task-detail-panel">
          <div class="panel-label">Task Detail</div>
          <div id="task-detail-root"></div>
        </article>
      </section>

      <section id="tab-dm" class="tab-panel hidden">
        <article class="panel">
          <div class="panel-label">Direct Messages</div>
          <div class="dm-container">
            <div class="dm-name-bar"><label class="dm-name-label">Your name:</label><input class="dm-name-input" id="dm-operator-name" type="text" placeholder="operator" spellcheck="false" /></div>
            <div class="dm-messages" id="dm-messages"><div class="dm-empty">No messages yet. Send one below.</div></div>
            <div class="dm-input-row">
              <textarea class="dm-input" id="dm-input" placeholder="Type a message…" rows="1"></textarea>
              <button class="dm-send-btn" id="dm-send-btn" onclick="sendDm()">Send</button>
            </div>
          </div>
        </article>
      </section>

      <section id="tab-supervisor" class="tab-panel hidden">
        <div class="split-grid">
          <article class="panel">
            <div class="panel-label">Supervisor Docs Snapshot <span class="muted" style="font-size:9px;letter-spacing:0">(latest supervisor docs only)</span></div>
            <div id="current-work-main" class="primary-text">No supervisor task snapshot loaded yet.</div>
            <div id="current-work-reason" class="secondary-text muted"></div>
            <div id="current-work-meta" class="meta-list"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Supervisor Signal</div>
            <div id="intervention-main" class="primary-text">No supervisor signal loaded yet.</div>
            <div id="intervention-body" class="secondary-text muted"></div>
            <div id="intervention-meta" class="meta-list"></div>
          </article>
        </div>
        <article class="panel">
          <div class="panel-label">Supervisor Audit</div>
          <div id="activity-supervisor"></div>
        </article>
        <div class="panel" id="supervisor-audit-history">
          <div class="panel-label">Audit History</div>
          <div class="audit-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Domain</th>
                  <th>Pattern</th>
                  <th>Reason</th>
                  <th>Consecutive</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="audit-rows">
                <tr><td colspan="7" class="muted">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-subconscious" class="tab-panel hidden">
        <article class="panel" id="subconscious-unified">
          <div class="panel-head">
            <div class="panel-label">Subconscious</div>
            <div id="subconscious-mode-chip"></div>
          </div>
          <div id="subconscious-unified-content"></div>
        </article>
      </section>

      <section id="tab-internals" class="tab-panel hidden">
        <div class="stack">
          <details class="debug-detail">
            <summary>Supervisor Runtime Config</summary>
            <div class="debug-body">
              <div id="debug-runtime" class="debug-grid"></div>
            </div>
          </details>
          <details class="debug-detail">
            <summary>Paths & Sources</summary>
            <div class="debug-body">
              <div id="debug-paths" class="debug-grid"></div>
            </div>
          </details>
          <details class="debug-detail">
            <summary>AGENTS.md (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-agents-meta" class="meta-list"></div>
              <pre id="debug-doc-agents" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>plan.md (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-plan-meta" class="meta-list"></div>
              <pre id="debug-doc-plan" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>progress.md Tail (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-progress-meta" class="meta-list"></div>
              <pre id="debug-doc-progress" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>Agent Runtime Fields</summary>
            <div class="debug-body">
              <div id="debug-raw" class="debug-grid"></div>
            </div>
          </details>
        </div>
      </section>
    </div>
  </div>

  <div id="confirm-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card">
      <div class="modal-title" id="confirm-title">Confirm action</div>
      <div class="modal-copy" id="confirm-copy"></div>
      <div class="modal-actions">
        <button class="hero-btn" onclick="closeDangerModal()">Cancel</button>
        <button class="hero-btn danger" id="confirm-cta" onclick="confirmDangerAction()">Confirm</button>
      </div>
    </div>
  </div>
<script>
(() => {
  const agent = ${JSON.stringify(agentName)};
  const NEGATIVE_STATUSES = new Set(['DRIFTING', 'LOST', 'STUCK']);
  const TABS = new Set(['settings', 'tasks', 'dm', 'supervisor', 'subconscious', 'internals']);
  const fmtTs = (v) => {
    const n = Number(v) || 0;
    if (!n) return '-';
    return new Date(n).toLocaleString();
  };
  const esc = (v) => String(v || '').replace(/[&<>\\"]/g, (ch) => (
    ch === '&' ? '&amp;' : (ch === '<' ? '&lt;' : (ch === '>' ? '&gt;' : '&quot;'))
  ));
  const statusClass = (s) => {
    if (s === 'FOCUSED') return 'status-focused';
    if (s === 'DRIFTING' || s === 'LOST' || s === 'STUCK') return 'status-negative';
    return 'status-unknown';
  };
  const eventStatusText = (ev) => {
    if (ev?.status) return String(ev.status);
    if (ev?.domain === 'task-state') {
      const lifecycle = String(ev?.supervisor?.lifecycleState || ev?.state?.lifecycleState || '').trim().toLowerCase();
      if (lifecycle === 'idle') return 'IDLE';
      return 'NO-TASK';
    }
    return 'UNKNOWN';
  };
  const eventStatusClass = (ev) => {
    if (ev?.status) return statusClass(ev.status);
    if (ev?.domain === 'task-state') return 'status-focused';
    return 'status-unknown';
  };
  const toInt = (v, fallback = 0) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const fmtSpanSec = (secRaw) => {
    const sec = Math.max(0, toInt(secRaw, 0));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd' + Math.floor((sec % 86400) / 3600) + 'h';
  };
  const boolChip = (value, textTrue, textFalse) => (
    value
      ? '<span class="chip ok">' + esc(textTrue) + '</span>'
      : '<span class="chip danger">' + esc(textFalse) + '</span>'
  );
  let latestAgentDetail = null;
  let latestSupervisorDetail = null;
  let latestSupervisorControl = null;
  let latestSupervisorStatus = null;
  let latestSubconsciousPayload = null;
  let latestSubconsciousDetail = null;
  let latestUnreadPayload = null;
  let latestQueueItems = [];
  let detailStatusTimer = null;
  let detailSaveInFlight = false;
  let activeTab = 'overview';
  let dangerMode = null;
  let _presetCache = [];

  function setDetailStatus(message, kind = 'muted') {
    const el = document.getElementById('detail-status');
    if (!el) return;
    if (detailStatusTimer) {
      clearTimeout(detailStatusTimer);
      detailStatusTimer = null;
    }
    el.className = 'detail-status ' + (kind === 'ok'
      ? 'detail-status-ok'
      : (kind === 'warn' ? 'detail-status-warn' : (kind === 'error' ? 'detail-status-error' : 'muted')));
    el.textContent = message || '';
  }

  function getElVal(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : null;
  }

  function getCurrentDetailDraft() {
    const identityEl = document.getElementById('detail-identity-input');
    const ownerEl = document.getElementById('detail-owner');
    const projectImportSourceEl = document.getElementById('detail-project-import-source');
    const projectImportNameEl = document.getElementById('detail-project-import-name');
    const projectImportModeEl = document.getElementById('detail-project-import-mode');
    const supervisorEl = document.getElementById('detail-supervisor-enabled');
    const subconsciousEl = document.getElementById('detail-subconscious-enabled');
    const guidanceEl = document.getElementById('detail-guidance');
    const runtimeEnabledEl = document.getElementById('detail-subconscious-runtime-enabled');
    const runtimeProviderEl = document.getElementById('detail-subconscious-provider');
    const runtimeModelEl = document.getElementById('detail-subconscious-model');
    const runtimeEndpointEl = document.getElementById('detail-subconscious-endpoint');
    const runtimeKeyEnvEl = document.getElementById('detail-subconscious-key-env');
    return {
      identity: identityEl ? String(identityEl.value || '').trim() : null,
      owner: ownerEl ? String(ownerEl.value || '').trim() : null,
      projectImportSource: projectImportSourceEl ? String(projectImportSourceEl.value || '').trim() : null,
      projectImportName: projectImportNameEl ? String(projectImportNameEl.value || '').trim() : null,
      projectImportMode: projectImportModeEl ? String(projectImportModeEl.value || '').trim().toLowerCase() : null,
      supervisorEnabled: supervisorEl ? supervisorEl.checked === true : null,
      subconsciousEnabled: subconsciousEl ? subconsciousEl.checked === true : null,
      guidance: guidanceEl ? String(guidanceEl.value || '').trim() : null,
      subconsciousRuntimeEnabled: runtimeEnabledEl ? runtimeEnabledEl.checked === true : null,
      subconsciousRuntimeProvider: runtimeProviderEl ? String(runtimeProviderEl.value || '').trim() : null,
      subconsciousRuntimeModel: runtimeModelEl ? String(runtimeModelEl.value || '').trim() : null,
      subconsciousRuntimeEndpoint: runtimeEndpointEl ? String(runtimeEndpointEl.value || '').trim() : null,
      subconsciousRuntimeKeyEnv: runtimeKeyEnvEl ? String(runtimeKeyEnvEl.value || '').trim() : null,
      cfgPrimaryFramework: getElVal('cfg-primary-framework'),
      cfgPrimaryProvider: getElVal('cfg-primary-provider'),
      cfgPrimaryModel: getElVal('cfg-primary-model'),
      cfgPrimaryReasoning: getElVal('cfg-primary-reasoning'),
      cfgPrimaryExtraArgs: getElVal('cfg-primary-extraArgs'),
      cfgSupervisorFramework: getElVal('cfg-supervisor-framework'),
      cfgSupervisorProvider: getElVal('cfg-supervisor-provider'),
      cfgSupervisorModel: getElVal('cfg-supervisor-model'),
      cfgSupervisorReasoning: getElVal('cfg-supervisor-reasoning'),
      cfgSupervisorExtraArgs: getElVal('cfg-supervisor-extraArgs'),
      cfgRole: getElVal('cfg-role'),
    };
  }

  function hasUnsavedDetailChanges(detail, supervisorControl, subconsciousDetail) {
    if (!detail || detail.error) return false;
    const identityEl = document.getElementById('detail-identity-input');
    if (!identityEl) return false;
    const draft = getCurrentDetailDraft();
    if ((draft.identity || '') !== String(detail.identity || '').trim()) return true;
    if (draft.supervisorEnabled !== null && draft.supervisorEnabled !== (supervisorControl?.enabled === true)) return true;
    if (draft.guidance !== null && draft.guidance !== String(subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || '').trim()) return true;
    if (draft.subconsciousRuntimeEnabled !== null && draft.subconsciousRuntimeEnabled !== (subconsciousDetail?.runtime?.desiredEnabled === true)) return true;
    if (draft.subconsciousRuntimeProvider !== null && draft.subconsciousRuntimeProvider !== String(subconsciousDetail?.runtime?.provider || '').trim()) return true;
    if (draft.subconsciousRuntimeModel !== null && draft.subconsciousRuntimeModel !== String(subconsciousDetail?.runtime?.model || '').trim()) return true;
    if (draft.subconsciousRuntimeEndpoint !== null && draft.subconsciousRuntimeEndpoint !== String(subconsciousDetail?.runtime?.endpoint || '').trim()) return true;
    if (draft.subconsciousRuntimeKeyEnv !== null && draft.subconsciousRuntimeKeyEnv !== String(subconsciousDetail?.runtime?.keyEnv || '').trim()) return true;
    const rp = detail.runtimeProfile || {};
    const pri = rp.primary || {};
    const sup = rp.supervisor || {};
    if (draft.cfgPrimaryFramework !== null && draft.cfgPrimaryFramework !== String(pri.framework || '').trim()) return true;
    if (draft.cfgPrimaryProvider !== null && draft.cfgPrimaryProvider !== String(pri.provider || '').trim()) return true;
    if (draft.cfgPrimaryModel !== null && draft.cfgPrimaryModel !== String(pri.model || '').trim()) return true;
    if (draft.cfgPrimaryReasoning !== null && draft.cfgPrimaryReasoning !== String(pri.reasoning || '').trim()) return true;
    if (draft.cfgPrimaryExtraArgs !== null && draft.cfgPrimaryExtraArgs !== String(pri.extraArgs || '').trim()) return true;
    if (draft.cfgSupervisorFramework !== null && draft.cfgSupervisorFramework !== String(sup.framework || '').trim()) return true;
    if (draft.cfgSupervisorProvider !== null && draft.cfgSupervisorProvider !== String(sup.provider || '').trim()) return true;
    if (draft.cfgSupervisorModel !== null && draft.cfgSupervisorModel !== String(sup.model || '').trim()) return true;
    if (draft.cfgSupervisorReasoning !== null && draft.cfgSupervisorReasoning !== String(sup.reasoning || '').trim()) return true;
    if (draft.cfgSupervisorExtraArgs !== null && draft.cfgSupervisorExtraArgs !== String(sup.extraArgs || '').trim()) return true;
    if (draft.cfgRole !== null && draft.cfgRole !== String(detail.role || '').trim()) return true;
    if (!detail.v1) return false;
    if ((draft.owner || '') !== String(detail.owner || '').trim()) return true;
    if ((draft.projectImportSource || '') !== '') return true;
    if ((draft.projectImportName || '') !== '') return true;
    if (draft.projectImportMode !== null && draft.projectImportMode !== 'copy') return true;
    if (draft.subconsciousEnabled !== null && draft.subconsciousEnabled !== (detail.subconsciousEnabled === true)) return true;
    return false;
  }

  function syncDetailDirtyStatus() {
    if (detailSaveInFlight) return;
    if (hasUnsavedDetailChanges(latestAgentDetail, latestSupervisorControl, latestSubconsciousDetail)) {
      setDetailStatus('Unsaved changes in Agent Detail.', 'warn');
    } else if (document.getElementById('detail-status')?.textContent === 'Unsaved changes in Agent Detail.') {
      setDetailStatus('', 'muted');
    }
  }

  function bindDetailEditors() {
    const ids = [
      'detail-identity-input',
      'detail-owner',
      'detail-project-import-source',
      'detail-project-import-name',
      'detail-project-import-mode',
      'detail-supervisor-enabled',
      'detail-subconscious-enabled',
      'detail-guidance',
      'detail-subconscious-runtime-enabled',
      'detail-subconscious-provider',
      'detail-subconscious-model',
      'detail-subconscious-endpoint',
      'detail-subconscious-key-env',
      'cfg-primary-framework',
      'cfg-primary-provider',
      'cfg-primary-model',
      'cfg-primary-reasoning',
      'cfg-primary-extraArgs',
      'cfg-supervisor-framework',
      'cfg-supervisor-provider',
      'cfg-supervisor-model',
      'cfg-supervisor-reasoning',
      'cfg-supervisor-extraArgs',
      'cfg-role',
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'INPUT' && el.getAttribute('type') === 'checkbox' ? 'change' : 'input';
      el.addEventListener(evt, syncDetailDirtyStatus);
    });
  }

  function bindProjectLifecycleButtons() {
    document.querySelectorAll('.project-action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        removeManagedProject(
          btn.dataset.projectName || '',
          btn.dataset.projectPath || '',
          btn.dataset.deleteFiles === '1'
        );
      });
    });
  }

  function hashToTab(hashValue) {
    const raw = String(hashValue || '').replace(/^#/, '').trim().toLowerCase();
    if (raw === 'activity') return 'supervisor';
    if (raw === 'audit') return 'supervisor';
    if (raw === 'debug') return 'internals';
    if (raw === 'overview') return 'settings';
    if (TABS.has(raw)) return raw;
    return 'settings';
  }

  function setActiveTab(nextTab, options = {}) {
    const next = TABS.has(nextTab) ? nextTab : 'settings';
    activeTab = next;
    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === next);
    });
    document.querySelectorAll('.tab-panel[id^="tab-"]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== ('tab-' + next));
    });
    if (options.updateHash !== false) {
      const nextHash = options.focusAudit ? '#audit' : ('#' + next);
      history.replaceState(null, '', window.location.pathname + nextHash);
    }
    if (options.focusAudit) {
      requestAnimationFrame(() => {
        document.getElementById('supervisor-audit-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (next === 'dm' && !dmLoaded) loadDmHistory();
    if (next === 'tasks') taskListRefresh();
  }

  // ── DM tab logic ──────────────────────────────
  const DM_LS_KEY = 'dm_operator_name';
  function sanitizeOperatorName(raw) {
    return (raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'operator';
  }
  function getDmOperatorName() {
    return sanitizeOperatorName(localStorage.getItem(DM_LS_KEY));
  }
  {
    const nameInput = document.getElementById('dm-operator-name');
    if (nameInput) {
      nameInput.value = getDmOperatorName();
      nameInput.addEventListener('input', () => {
        const v = nameInput.value.replace(/[^a-zA-Z0-9_-]/g, '').trim();
        nameInput.value = v;
        localStorage.setItem(DM_LS_KEY, v);
      });
    }
  }
  let dmLoaded = false;
  let dmMessages = [];
  let dmSending = false;
  let dmScrollSnap = true; // true on first load and after sending

  function renderDmMessages() {
    const container = document.getElementById('dm-messages');
    if (!container) return;
    if (dmMessages.length === 0) {
      container.innerHTML = '<div class="dm-empty">No messages yet. Send one below.</div>';
      return;
    }
    // Check if user is at bottom before re-render (threshold 40px)
    const wasAtBottom = dmScrollSnap || (container.scrollTop + container.clientHeight >= container.scrollHeight - 40);
    container.innerHTML = dmMessages.map((m) => {
      const isOutgoing = m.from === getDmOperatorName() || (m.source === 'web' && m.type === 'human');
      const cls = isOutgoing ? 'outgoing' : 'incoming';
      const text = esc(m.full || m.summary || '');
      const fromLabel = esc(m.from || 'unknown');
      const time = m.at ? new Date(m.at).toLocaleString() : '';
      return '<div class="dm-msg ' + cls + '">'
        + '<div class="dm-msg-from">' + fromLabel + '</div>'
        + text
        + '<div class="dm-msg-meta">' + esc(time) + '</div>'
        + '</div>';
    }).join('');
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
    dmScrollSnap = false;
  }

  async function loadDmHistory() {
    try {
      const r = await fetch('/api/agents/' + encodeURIComponent(agent) + '/dm-history?limit=200');
      if (!r.ok) { console.warn('[dm] load failed:', r.status); return; }
      const data = await r.json();
      dmMessages = Array.isArray(data.messages) ? data.messages : [];
      dmLoaded = true;
      renderDmMessages();
    } catch (e) {
      console.warn('[dm] load error:', e);
    }
  }

  async function sendDm() {
    if (dmSending) return;
    const input = document.getElementById('dm-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const btn = document.getElementById('dm-send-btn');
    dmSending = true;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/agents/' + encodeURIComponent(agent) + '/dm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: getDmOperatorName() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.warn('[dm] send failed:', err);
        return;
      }
      input.value = '';
      input.style.height = '';
      dmScrollSnap = true;
      await loadDmHistory();
    } catch (e) {
      console.warn('[dm] send error:', e);
    } finally {
      dmSending = false;
      if (btn) btn.disabled = false;
    }
  }

  // Auto-resize textarea and send on Enter (Shift+Enter for newline)
  {
    const input = document.getElementById('dm-input');
    if (input) {
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendDm();
        }
      });
    }
  }

  function openSupervisorAudit() {
    setActiveTab('supervisor', { focusAudit: true });
  }

  function openSubconsciousDebug() {
    setActiveTab('subconscious');
  }

  function syncStickyOffsets() {
    const hero = document.querySelector('.hero');
    if (!hero) return;
    const heroRect = hero.getBoundingClientRect();
    const heroHeight = Math.max(0, Math.ceil(heroRect.height));
    const gap = 14;
    document.documentElement.style.setProperty('--detail-tabs-top', (heroHeight + gap) + 'px');
  }

  window.setActiveTab = setActiveTab;
  window.openSupervisorAudit = openSupervisorAudit;
  window.openSubconsciousDebug = openSubconsciousDebug;

  function queueItemsForAgent(queueItems) {
    return (Array.isArray(queueItems) ? queueItems : []).filter((item) => {
      const target = String(item?.to || '').split(':', 1)[0];
      return target === agent;
    });
  }

  function fmtWaitAge(ts) {
    const diff = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ' + (diff % 60) + 's';
    return Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'm';
  }

  function statusTone(status) {
    if (status === 'FOCUSED') return 'ok';
    if (NEGATIVE_STATUSES.has(status)) return 'danger';
    return 'warn';
  }

  function hasCurrentSupervisorIssue(state) {
    const classification = String(state?.classification || '').trim().toLowerCase();
    if (classification === 'stalled_wait' || classification === 'suspected_eos') return true;
    const lifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    return lifecycleState === 'active' && classification.length > 0;
  }

  function kvGrid(entries) {
    const rows = entries.filter((entry) => entry && entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
    if (rows.length === 0) return '<div class="empty-state">No data available.</div>';
    return rows.map((entry) => (
      '<div class="debug-kv"><b>' + esc(entry[0]) + '</b>' + esc(String(entry[1])) + '</div>'
    )).join('');
  }

  function buildPageModel(detail, statusRow, supervisorDetail, supervisorStatus, supervisorControl, subconsciousPayload, subconsciousDetail, unreadPayload, queueItems) {
    const latest = supervisorDetail?.latest || null;
    const state = supervisorDetail?.state || {};
    const events = Array.isArray(supervisorDetail?.events) ? supervisorDetail.events : [];
    const subconsciousEvents = Array.isArray(subconsciousPayload?.events) ? subconsciousPayload.events : [];
    const unreadRows = Array.isArray(unreadPayload?.messages) ? unreadPayload.messages : [];
    const queueRows = queueItemsForAgent(queueItems);
    const activeNow = statusRow && typeof statusRow.activeNow === 'boolean'
      ? statusRow.activeNow
      : !!detail?.active;
    const activeDurationSec = toInt(statusRow?.activeDurationSec, 0);
    const idleDurationSec = toInt(statusRow?.idleDurationSec, Math.floor((Number(detail?.idleMs) || 0) / 1000));
    const runtimeText = activeNow ? ('ACTIVE ' + fmtSpanSec(activeDurationSec)) : ('IDLE ' + fmtSpanSec(idleDurationSec));
    const latestLifecycle = String(latest?.supervisor?.lifecycleState || state?.lifecycleState || '').trim().toLowerCase();
    const latestStatus = String(
      latest?.status
      || ((latest?.domain === 'task-state' && latestLifecycle === 'idle') ? 'IDLE' : '')
      || ((!latest && latestLifecycle === 'idle') ? 'IDLE' : 'UNKNOWN')
    ).trim() || 'UNKNOWN';
    const latestReason = String(latest?.reason || '').trim();
    const supervisorTaskSnapshot = String(latest?.docs?.currentTask || '').trim();
    const unreadTotal = Math.max(0, toInt(unreadPayload?.unread_total, unreadRows.length));
    const queueCount = queueRows.length;
    const consecutiveNegative = toInt(state?.consecutiveNegative, 0);
    const supervisorEnabled = supervisorControl?.enabled === true;
    const supervisorRuntimeRunning = supervisorStatus?.runtime?.running === true;
    const supervisorClassification = String(state?.classification || '').trim().toUpperCase();
    const supervisorLifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    const supervisorCurrentStatePresent = supervisorClassification.length > 0 || supervisorLifecycleState.length > 0;
    const supervisorCurrentIssue = hasCurrentSupervisorIssue(state);
    const subconsciousEnabled = detail?.subconsciousEnabled === true;
    const subconsciousWritable = detail?.v1 === true;
    const subconsciousStage = String(subconsciousDetail?.stage || 'unknown').trim() || 'unknown';
    const authority = (subconsciousDetail?.authority && typeof subconsciousDetail.authority === 'object')
      ? subconsciousDetail.authority
      : buildSubconsciousAuthoritySummaryMeta(subconsciousEnabled, subconsciousDetail?.upstream || {}, subconsciousDetail?.provider?.lettaAgentId || null);
    const fallback = (subconsciousDetail?.fallback && typeof subconsciousDetail.fallback === 'object')
      ? subconsciousDetail.fallback
      : buildSubconsciousFallbackSummaryMeta(String(subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || ''));
    const runtimeContract = (subconsciousDetail?.runtime && typeof subconsciousDetail.runtime === 'object')
      ? subconsciousDetail.runtime
      : {};
    const transitional = (subconsciousDetail?.transitional && typeof subconsciousDetail.transitional === 'object')
      ? subconsciousDetail.transitional
      : buildSubconsciousTransitionalSummaryMeta(runtimeContract, subconsciousDetail?.memory, subconsciousDetail?.conversation);
    const upstreamDetail = (subconsciousDetail?.upstream && typeof subconsciousDetail.upstream === 'object')
      ? subconsciousDetail.upstream
      : {};
    const upstreamBootstrap = (upstreamDetail.bootstrap && typeof upstreamDetail.bootstrap === 'object')
      ? upstreamDetail.bootstrap
      : {};
    const upstreamSession = (upstreamDetail.session && typeof upstreamDetail.session === 'object')
      ? upstreamDetail.session
      : {};
    const upstreamUserPrompt = (upstreamDetail.userPrompt && typeof upstreamDetail.userPrompt === 'object')
      ? upstreamDetail.userPrompt
      : {};
    const upstreamPreTool = (upstreamDetail.preTool && typeof upstreamDetail.preTool === 'object')
      ? upstreamDetail.preTool
      : {};
    const blockedLikely = supervisorCurrentIssue && (latestStatus === 'STUCK' || /block|approval|intervention|waiting/i.test(latestReason));
    const needsAttention = supervisorCurrentIssue && NEGATIVE_STATUSES.has(latestStatus);
    let localRuntimeState = 'off';
    let localRuntimeLabel = 'Off';
    if (runtimeContract.desiredEnabled === true && runtimeContract.invocationConfigured === true) {
      localRuntimeState = 'ready';
      localRuntimeLabel = 'Ready';
    } else if (runtimeContract.desiredEnabled === true) {
      localRuntimeState = 'degraded';
      localRuntimeLabel = 'Degraded';
    }
    let activeSubconsciousPath = 'Off';
    if (authority.status === 'active') activeSubconsciousPath = 'Authoritative upstream active';
    else if (authority.status === 'degraded') activeSubconsciousPath = 'Authoritative upstream degraded';
    else if (authority.status === 'unconfigured') activeSubconsciousPath = 'Authoritative upstream unconfigured';
    else if (subconsciousEnabled) activeSubconsciousPath = 'Enabled without authoritative path';
    const healthParts = [
      'Runtime ' + (activeNow ? ('active ' + fmtSpanSec(activeDurationSec)) : ('idle ' + fmtSpanSec(idleDurationSec))),
      'Delivery ' + unreadTotal + ' unread / ' + queueCount + ' queued',
      'Subconscious ' + activeSubconsciousPath,
    ];
    if (needsAttention) healthParts.push('Supervisor warning present');
    const healthSummary = healthParts.join(' · ');
    let interventionTitle = 'No active supervisor warning';
    let interventionBody = 'Supervisor currently shows no active warning.';
    if (!supervisorEnabled && !supervisorCurrentIssue) {
      interventionTitle = 'No active supervisor warning';
      interventionBody = 'Supervisor is disabled. Historical findings remain in the Supervisor tab and audit history.';
    } else if (blockedLikely) {
      interventionTitle = latestStatus + ' (supervisor)';
      interventionBody = latestReason || 'Supervisor evaluated agent as blocked or stuck.';
    } else if (needsAttention) {
      interventionTitle = latestStatus + ' (supervisor)';
      interventionBody = latestReason || 'Supervisor flagged drift or loss of focus.';
    } else if (!supervisorRuntimeRunning && !supervisorCurrentStatePresent) {
      interventionTitle = 'No active supervisor warning';
      interventionBody = 'Supervisor is not actively running. Historical findings remain in the Supervisor tab and audit history.';
    }
    const banner = needsAttention
      ? {
          kind: blockedLikely ? 'danger' : 'warn',
          text: blockedLikely
            ? ('Blocked or stuck: ' + (latestReason || 'recent supervisor evaluation requires human attention'))
            : ('Supervisor warning: ' + (latestReason || 'recent evaluation is negative')),
        }
      : null;
    const guidanceEvents = subconsciousEvents.filter((ev) => ev?.guidancePresent === true);
    const guidanceInjectedEvents = subconsciousEvents.filter((ev) => ev?.guidanceInjected === true);
    const latestSubEvent = subconsciousEvents.length ? subconsciousEvents[subconsciousEvents.length - 1] : null;
    const hookCounts = new Map();
    for (const ev of subconsciousEvents) {
      const key = String(ev?.hook || ev?.hookEventName || 'Unknown');
      hookCounts.set(key, (hookCounts.get(key) || 0) + 1);
    }
    const topHooks = [...hookCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    return {
      latest,
      state,
      events,
      supervisorEnabled,
      supervisorDisabledReason: supervisorControl?.disabledReason || null,
      supervisorControl,
      subconsciousEnabled,
      subconsciousWritable,
      subconsciousStage,
      subconsciousDetail,
      authority,
      fallback,
      transitional,
      activeSubconsciousPath,
      localRuntimeState,
      localRuntimeLabel,
      upstreamBootstrap,
      upstreamSession,
      upstreamUserPrompt,
      upstreamPreTool,
      runtimeInvocationConfigured: runtimeContract.invocationConfigured === true,
      runtimeDesiredEnabled: runtimeContract.desiredEnabled === true,
      runtimeDisabledReason: String(runtimeContract.disabledReason || '').trim(),
      runtimeProvider: String(runtimeContract.provider || '').trim(),
      runtimeModel: String(runtimeContract.model || '').trim(),
      runtimeEndpoint: String(runtimeContract.endpoint || '').trim(),
      runtimeKeyEnv: String(runtimeContract.keyEnv || '').trim(),
      runtimeConfigFamily: String(runtimeContract.configFamily || '').trim(),
      runtimeConfigSources: (runtimeContract.configSources && typeof runtimeContract.configSources === 'object')
        ? runtimeContract.configSources
        : {},
      runtimeKeyAvailable: runtimeContract.keyAvailable === true,
      upstreamDetail,
      subconsciousMemory: (subconsciousDetail?.memory && typeof subconsciousDetail.memory === 'object')
        ? subconsciousDetail.memory
        : {},
      subconsciousConversation: (subconsciousDetail?.conversation && typeof subconsciousDetail.conversation === 'object')
        ? subconsciousDetail.conversation
        : {},
      currentConversation: (subconsciousDetail?.conversation?.current && typeof subconsciousDetail.conversation.current === 'object')
        ? subconsciousDetail.conversation.current
        : null,
      lastRuntimeInvocation: subconsciousDetail?.lastInvocation || null,
      lastRuntimeGuidance: subconsciousDetail?.lastRuntimeGuidance || null,
      subconsciousBlockers: Array.isArray(subconsciousDetail?.missingBackendPieces) ? subconsciousDetail.missingBackendPieces : [],
      subconsciousEvents,
      latestSubEvent,
      guidanceEvents,
      guidanceConfigured: fallback.configured === true,
      guidanceInjectedEvents,
      guidancePreview: String(detail?.subconsciousGuidancePreview || subconsciousDetail?.guidance?.preview || subconsciousDetail?.manualGuidance?.preview || '').trim(),
      guidanceText: String(detail?.subconsciousGuidanceText || subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || '').trim(),
      topHooks,
      unreadRows,
      unreadTotal,
      queueRows,
      queueCount,
      activeNow,
      runtimeText,
      latestStatus,
      latestReason,
      supervisorTaskSnapshot,
      supervisorRuntimeRunning,
      supervisorCurrentStatePresent,
      supervisorClassification,
      supervisorLifecycleState,
      healthSummary,
      interventionTitle,
      interventionBody,
      blockedLikely,
      needsAttention,
      consecutiveNegative,
      banner,
    };
  }

  function renderHeader(detail, model) {
    document.getElementById('hero-title').textContent = detail?.name || agent;
    const runtimeBits = [];
    if (detail?.agentType) runtimeBits.push(String(detail.agentType).toUpperCase());
    if (detail?.server) runtimeBits.push(String(detail.server));
    if (detail?.model) runtimeBits.push(String(detail.model));
    document.getElementById('hero-runtime').textContent = runtimeBits.length ? runtimeBits.join(' · ') : 'Runtime details unavailable';
    const chips = [];
    chips.push('<span class="chip ' + (model.activeNow ? 'ok' : 'neutral') + '">' + esc(model.runtimeText) + '</span>');
    if (model.supervisorEnabled && !model.supervisorRuntimeRunning) {
      chips.push('<span class="chip warn">SUPERVISOR NOT RUNNING</span>');
    } else {
      chips.push('<span class="chip ' + (model.supervisorEnabled ? 'ok' : 'danger') + '">SUPERVISOR ' + esc(model.supervisorEnabled ? 'ON' : 'OFF') + '</span>');
    }
    chips.push('<span class="chip ' + (model.subconsciousEnabled ? 'ok' : 'neutral') + '">SUBCONSCIOUS ' + esc(model.subconsciousEnabled ? 'ON' : 'OFF') + '</span>');
    chips.push('<span class="chip neutral">UNREAD ' + esc(String(model.unreadTotal)) + '</span>');
    chips.push('<span class="chip neutral">QUEUE ' + esc(String(model.queueCount)) + '</span>');
    if (model.needsAttention) {
      chips.push('<span class="chip ' + statusTone(model.latestStatus) + '">SUPERVISOR SIGNAL ' + esc(model.latestStatus) + '</span>');
    }
    document.getElementById('header-chips').innerHTML = chips.join('');
    const healthSumEl = document.getElementById('health-summary');
    healthSumEl.textContent = model.healthSummary;
    healthSumEl.classList.remove('health-error');
    const bannerEl = document.getElementById('exception-banner');
    if (model.banner) {
      bannerEl.classList.remove('hidden');
      bannerEl.classList.toggle('warn', model.banner.kind === 'warn');
      bannerEl.textContent = model.banner.text;
    } else {
      bannerEl.classList.add('hidden');
      bannerEl.classList.remove('warn');
      bannerEl.textContent = '';
    }
  }

  function renderCurrentWork(model) {
    const mainEl = document.getElementById('current-work-main');
    if (!model.supervisorEnabled) {
      mainEl.textContent = 'Supervisor disabled.';
    } else {
      mainEl.textContent = model.supervisorTaskSnapshot || 'No task text was recorded in the latest supervisor docs snapshot.';
    }
    mainEl.style.color = '';
    const reasonEl = document.getElementById('current-work-reason');
    if (!model.supervisorEnabled) {
      reasonEl.textContent = 'Supervisor doc snapshots are unavailable while supervisor is off.';
    } else {
      reasonEl.textContent = model.supervisorTaskSnapshot
        ? 'Raw text from the latest supervisor docs snapshot, not the canonical task object.'
        : 'The latest supervisor docs snapshot did not expose task text.';
    }
    const meta = [];
    if (model.supervisorEnabled) {
      meta.push('<span class="meta-item">judged ' + esc(fmtTs(model.state?.lastJudgedAt)) + '</span>');
      meta.push('<span class="meta-item">warning ' + esc(fmtTs(model.state?.lastWarningAt)) + '</span>');
      if (model.latest?.pattern) meta.push('<span class="meta-item">pattern ' + esc(model.latest.pattern) + '</span>');
      if (model.latest?.domain) meta.push('<span class="meta-item">domain ' + esc(model.latest.domain) + '</span>');
    }
    document.getElementById('current-work-meta').innerHTML = meta.join('');
  }

  function renderIntervention(model) {
    const mainEl = document.getElementById('intervention-main');
    mainEl.textContent = model.interventionTitle;
    mainEl.style.color = '';
    document.getElementById('intervention-body').textContent = model.interventionBody;
    const meta = [];
    meta.push('<span class="meta-item">neg streak ' + esc(String(model.consecutiveNegative)) + '</span>');
    if (model.blockedLikely) meta.push('<span class="meta-item">source: supervisor eval</span>');
    document.getElementById('intervention-meta').innerHTML = meta.join('');
  }

  function renderEventList(targetId, events, limit, emptyMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const rows = Array.isArray(events) ? events.slice().reverse().slice(0, limit) : [];
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(emptyMessage) + '</div>';
      return;
    }
    el.innerHTML = rows.map((ev) => {
      const action = ev?.action?.summary ? ev.action.summary : (ev?.action?.type || '');
      const metaParts = [];
      if (ev?.domain) metaParts.push(ev.domain);
      if (ev?.pattern) metaParts.push(ev.pattern);
      if (action) metaParts.push(action);
      return '<div class="event-item">'
        + '<div class="event-row"><div class="event-main">' + esc(ev?.reason || ev?.status || 'Event') + '</div><div class="event-time">' + esc(fmtTs(ev?.ts)) + '</div></div>'
        + '<div class="event-meta"><span class="status ' + eventStatusClass(ev) + '">' + esc(eventStatusText(ev)) + '</span>'
        + (metaParts.length ? (' · ' + esc(metaParts.join(' · '))) : '')
        + '</div></div>';
    }).join('');
  }

  function hookBadgeClass(hook) {
    const h = String(hook || '').toLowerCase();
    if (h === 'sessionstart') return 'hook-session';
    if (h === 'userpromptsubmit') return 'hook-prompt';
    if (h === 'pretooluse') return 'hook-tool';
    if (h === 'stop') return 'hook-stop';
    return 'hook-unknown';
  }
  function hookDisplayName(hook) {
    const h = String(hook || '');
    if (h === 'SessionStart') return 'Session';
    if (h === 'UserPromptSubmit') return 'Prompt';
    if (h === 'PreToolUse') return 'Tool';
    if (h === 'Stop') return 'Stop';
    return h || 'Unknown';
  }
  function cleanEventSummary(raw, hook, toolName) {
    let s = String(raw || '').trim();
    // Strip the full boilerplate prefix "Subconscious hook <hookType>[: <toolName>]"
    const boilerplate = /^Subconscious hook\s*(pre-tool:\s*\S+|user prompt|session start|stop)\s*$/i;
    if (boilerplate.test(s)) return '';
    // Strip just the "Subconscious hook" prefix if followed by other content
    s = s.replace(/^Subconscious hook\s*/i, '').trim();
    if (toolName && s === toolName) return '';
    return s;
  }
  function renderHookBreakdown(targetId, events) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const counts = new Map();
    for (const ev of (events || [])) {
      const key = String(ev?.hook || ev?.hookEventName || 'Unknown');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) { el.innerHTML = ''; return; }
    const injectedCount = (events || []).filter(e => e?.guidanceInjected === true).length;
    const runtimeCount = (events || []).filter(e => e?.runtimeInvoked === true).length;
    let html = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hook, count]) =>
      '<span class="hook-count"><span class="hook-badge ' + hookBadgeClass(hook) + '">' + esc(hookDisplayName(hook)) + '</span>' + esc(String(count)) + '</span>'
    ).join('');
    if (injectedCount > 0) html += '<span class="hook-count"><span class="ev-chip chip-injected">Injected</span>' + esc(String(injectedCount)) + '</span>';
    if (runtimeCount > 0) html += '<span class="hook-count"><span class="ev-chip chip-runtime">Runtime</span>' + esc(String(runtimeCount)) + '</span>';
    el.innerHTML = html;
  }
  function renderSubconsciousEventList(targetId, events, limit, emptyMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const rows = Array.isArray(events) ? events.slice().reverse().slice(0, limit) : [];
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(emptyMessage) + '</div>';
      return;
    }
    el.innerHTML = rows.map((ev) => {
      const hook = ev?.hook || ev?.hookEventName || 'Unknown';
      const injected = ev?.guidanceInjected === true;
      const runtimeInvoked = ev?.runtimeInvoked === true;
      const isEligible = hook === 'UserPromptSubmit' || hook === 'PreToolUse';
      const itemClass = 'event-item' + (injected ? ' ev-injected' : '') + (runtimeInvoked ? ' ev-runtime' : '');

      // Header: hook badge + tool name (if any) + timestamp
      let headerContent = '<span class="hook-badge ' + hookBadgeClass(hook) + '">' + esc(hookDisplayName(hook)) + '</span>';
      if (ev?.toolName) headerContent += ' <span class="event-main" style="font-size:11px">' + esc(ev.toolName) + '</span>';

      // Status chips
      const chips = [];
      if (injected) chips.push('<span class="ev-chip chip-injected">Injected</span>');
      else if (isEligible && ev?.guidanceConfigured === true) chips.push('<span class="ev-chip">Configured, not injected</span>');
      if (runtimeInvoked) {
        let rtLabel = 'Runtime';
        if (ev?.runtimeProvider || ev?.runtimeModel) rtLabel += ' (' + esc([ev.runtimeProvider, ev.runtimeModel].filter(Boolean).join('/')) + ')';
        if (ev?.runtimeLatencyMs) rtLabel += ' ' + esc(String(ev.runtimeLatencyMs)) + 'ms';
        chips.push('<span class="ev-chip chip-runtime">' + rtLabel + '</span>');
      }
      if (ev?.upstreamUserPromptMessageSent === true) {
        chips.push('<span class="ev-chip">Upstream prompt sent</span>');
      } else if (ev?.upstreamUserPromptStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream prompt blocked</span>');
      }
      if (ev?.upstreamPreToolInjected === true) {
        chips.push('<span class="ev-chip">Upstream pre-tool injected</span>');
      } else if (ev?.upstreamPreToolStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream pre-tool blocked</span>');
      }
      if (ev?.upstreamStopMessageSent === true) {
        chips.push('<span class="ev-chip">Upstream stop sent</span>');
      } else if (ev?.upstreamStopStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream stop blocked</span>');
      }
      if (ev?.runtimeError) chips.push('<span class="ev-chip chip-error">Error</span>');
      if (ev?.resolutionSource && ev.resolutionSource !== 'none') chips.push('<span class="ev-chip">' + esc(ev.resolutionSource) + '</span>');

      // Summary content — strip boilerplate "Subconscious hook ..." prefix
      const rawSummary = String(ev?.summary || ev?.promptPreview || '').replace(/\\s+/g, ' ').trim();
      const cleanedSummary = cleanEventSummary(rawSummary, hook, ev?.toolName);
      const summary = cleanedSummary.length > 200 ? (cleanedSummary.slice(0, 200) + '...') : cleanedSummary;

      let html = '<div class="' + itemClass + '">';
      html += '<div class="event-row"><div class="event-main">' + headerContent + '</div><div class="event-time">' + esc(fmtTs(ev?.ts)) + '</div></div>';
      if (chips.length > 0) html += '<div class="event-chips">' + chips.join('') + '</div>';
      if (summary) html += '<div class="event-summary">' + esc(summary) + '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  function renderOverview(detail, model) {
    const deliveryBits = [];
    deliveryBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Unread</div><div class="summary-v">' + esc(String(model.unreadTotal)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Queue</div><div class="summary-v">' + esc(String(model.queueCount)) + '</div></div>'
      + '</div>');
    if (model.unreadRows.length > 0) {
      const topUnread = model.unreadRows[0];
      const previewRaw = String(topUnread?.summary || topUnread?.full || '').replace(/\\s+/g, ' ').trim();
      const preview = previewRaw.length > 140 ? (previewRaw.slice(0, 140) + '...') : previewRaw;
      deliveryBits.push('<div class="summary-note"><strong>Next unread:</strong> ' + esc(preview || '(no summary)') + '</div>');
    } else if (model.queueRows.length > 0) {
      deliveryBits.push('<div class="summary-note"><strong>Queue oldest:</strong> waiting ' + esc(fmtWaitAge(model.queueRows[0]?.queuedAt)) + '</div>');
    } else {
      deliveryBits.push('<div class="summary-note">No unread messages or queued items.</div>');
    }
    document.getElementById('overview-delivery').innerHTML = deliveryBits.join('');

    const projects = Array.isArray(detail?.managedProjects) ? detail.managedProjects : [];
    const projectBits = [];
    projectBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Owner</div><div class="summary-v">' + esc(detail?.owner || '-') + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Projects</div><div class="summary-v">' + esc(String(projects.length)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Home</div><div class="summary-v">' + esc(detail?.v1 ? 'V1' : 'Legacy') + '</div></div>'
      + '</div>');
    if (projects.length > 0) {
      projectBits.push('<ul class="list tight">' + projects.slice(0, 4).map((p) => '<li>' + esc(p?.name || '?') + ' <span class="muted">(' + esc(p?.source || 'unknown') + ')</span></li>').join('') + '</ul>');
    } else {
      projectBits.push('<div class="summary-note">No managed projects recorded.</div>');
    }
    document.getElementById('overview-projects').innerHTML = projectBits.join('');
  }

  function renderSettings(detail, model) {
    const identityRoot = document.getElementById('settings-identity');
    const guidanceRoot = document.getElementById('settings-guidance');
    const systemsRoot = document.getElementById('settings-systems');
    const ownerRoot = document.getElementById('settings-owner');
    if (!detail || detail.error) {
      identityRoot.innerHTML = '<div class="error-state">Agent detail unavailable.</div>';
      guidanceRoot.innerHTML = '<div class="error-state">Guidance unavailable.</div>';
      const cfgRoot = document.getElementById('settings-configuration');
      if (cfgRoot) cfgRoot.innerHTML = '<div class="error-state">Configuration unavailable.</div>';
      systemsRoot.innerHTML = '<div class="error-state">System control state unavailable.</div>';
      ownerRoot.innerHTML = '<div class="error-state">Ownership unavailable.</div>';
      return;
    }
    identityRoot.innerHTML =
      '<div class="detail-hint">Short one-line external-facing description used in listings and summaries.</div>'
      + '<div class="field-label">Identity</div>'
      + '<input id="detail-identity-input" class="detail-input" value="' + esc(detail.identity || '').replace(/"/g, '&quot;') + '" placeholder="One-line external description">'
      + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailIdentity()">Save Identity</button></div>';

    const subconsciousWritable = detail.v1 === true;
    const guidanceText = String(model?.guidanceText || '');
    guidanceRoot.innerHTML = subconsciousWritable
      ? (
        '<div class="detail-hint">Human-authored intent surface. Current storage and writer boundary remain the existing v1 guidance state path.</div>'
        + '<textarea id="detail-guidance" class="detail-textarea" placeholder="Guidance text">' + esc(guidanceText) + '</textarea>'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailGuidance()">Save Guidance</button></div>'
      )
      : (
        '<div class="empty-state">Guidance is writable only for V1 home agents in the current implementation.</div>'
      );

    const configRoot = document.getElementById('settings-configuration');
    const rp = detail.runtimeProfile || {};
    const pri = rp.primary || {};
    const sup = rp.supervisor || {};
    function matchPreset(role) {
      if (!role || !role.framework) return '';
      for (const p of _presetCache) {
        if (p.framework === role.framework && p.provider === (role.provider || null) && p.model === (role.model || null)
            && p.reasoning === (role.reasoning || null) && (p.extraArgs || null) === (role.extraArgs || null)) return p.id;
      }
      return '';
    }
    const priPreset = matchPreset(pri);
    const supPreset = matchPreset(sup);
    function presetOpts(selectedId) {
      let h = '<option value="">(none)</option>';
      for (const p of _presetCache) {
        h += '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }
      h += '<option value="__custom__">Custom...</option>';
      return h;
    }
    const fwOpts = function(sel) {
      return '<option value="">(not set)</option>'
        + '<option value="claude"' + (sel === 'claude' ? ' selected' : '') + '>claude</option>'
        + '<option value="codex"' + (sel === 'codex' ? ' selected' : '') + '>codex</option>';
    };
    const rpCustomFields = function(prefix, role, presetId) {
      const hidden = presetId && presetId !== '__custom__' ? ' style="display:none"' : '';
      return '<div id="cfg-' + prefix + '-custom"' + hidden + '>'
        + '<div class="field-label">Framework</div>'
        + '<select id="cfg-' + prefix + '-framework" class="detail-input">' + fwOpts(role.framework || '') + '</select>'
        + '<div class="field-label">Provider</div>'
        + '<input id="cfg-' + prefix + '-provider" class="detail-input" value="' + esc(role.provider || '').replace(/"/g, '&quot;') + '" placeholder="e.g. anthropic">'
        + '<div class="field-label">Model</div>'
        + '<input id="cfg-' + prefix + '-model" class="detail-input" value="' + esc(role.model || '').replace(/"/g, '&quot;') + '" placeholder="e.g. claude-sonnet-4-20250514">'
        + '<div class="field-label">Reasoning</div>'
        + '<input id="cfg-' + prefix + '-reasoning" class="detail-input" value="' + esc(role.reasoning || '').replace(/"/g, '&quot;') + '" placeholder="e.g. extended">'
        + '<div class="field-label">Extra Args</div>'
        + '<input id="cfg-' + prefix + '-extraArgs" class="detail-input" value="' + esc(role.extraArgs || '').replace(/"/g, '&quot;') + '" placeholder="e.g. --verbose --max-tokens 4096">'
        + '<div class="detail-hint" style="margin-top:2px;font-size:10px">Only CLI flags allowed. Shell operators are rejected.</div>'
        + '</div>';
    };
    configRoot.innerHTML =
      '<div class="detail-hint">Per-agent runtime profile and role. Select a preset or choose Custom for raw fields. Changes take effect after restart.</div>'
      + '<div id="cfg-restart-banner" class="error-state" style="display:none;margin-bottom:8px;background:rgba(234,179,8,0.12);color:rgba(234,179,8,0.95);border-left:3px solid rgba(234,179,8,0.5);padding:6px 10px">Runtime profile changes take effect after agent restart. The running agent continues using its current configuration until restarted.</div>'
      + '<div class="panel"><div class="panel-label">Primary Role</div>'
      + '<div class="field-label">Preset</div>'
      + '<select id="cfg-primary-preset" class="detail-input" onchange="onPresetChange(\\'primary\\')">' + presetOpts(priPreset || (pri.framework ? '__custom__' : '')) + '</select>'
      + rpCustomFields('primary', pri, priPreset) + '</div>'
      + '<div class="panel"><div class="panel-label">Supervisor Role</div>'
      + '<div class="field-label">Preset</div>'
      + '<select id="cfg-supervisor-preset" class="detail-input" onchange="onPresetChange(\\'supervisor\\')">' + presetOpts(supPreset || (sup.framework ? '__custom__' : '')) + '</select>'
      + rpCustomFields('supervisor', sup, supPreset) + '</div>'
      + '<div class="field-label">Agent Role</div>'
      + '<input id="cfg-role" class="detail-input" value="' + esc(detail.role || '').replace(/"/g, '&quot;') + '" placeholder="Agent role description">'
      + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailConfiguration()">Save Configuration</button></div>';

    const ownerHtml = detail.v1
      ? (
        '<div class="detail-hint">First-class ownership field for this agent home.</div>'
        + '<div class="field-label">Owner</div>'
        + '<input id="detail-owner" class="detail-input" value="' + esc(detail.owner || '').replace(/"/g, '&quot;') + '" placeholder="Human owner">'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailOwner()">Save Owner</button></div>'
      )
      : '<div class="empty-state">This agent does not expose a writable V1 owner field.</div>';
    ownerRoot.innerHTML = ownerHtml;
    const supervisorControlHtml =
      '<div class="panel">'
      + '<div class="panel-label">Supervisor Audit</div>'
      + '<label class="detail-toggle"><input id="detail-supervisor-enabled" type="checkbox" ' + (model?.supervisorEnabled ? 'checked' : '') + '>Enabled</label>'
      + '<div class="detail-actions"><button class="detail-save" onclick="saveSupervisorAuditControl()">Save</button></div>'
      + '</div>';
    const subconsciousControlHtml = subconsciousWritable
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Subconscious Control</div>'
        + '<label class="detail-toggle"><input id="detail-subconscious-enabled" type="checkbox" ' + (detail.subconsciousEnabled ? 'checked' : '') + '>Enabled</label>'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveSubconsciousControl()">Save</button></div>'
        + '</div>'
      )
      : '';
    const runtimeContractHtml = subconsciousWritable
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Subconscious LLM</div>'
        + (model?.runtimeDisabledReason ? '<div class="error-state" style="margin-bottom:8px">' + esc(model.runtimeDisabledReason) + '</div>' : '')
        + '<label class="detail-toggle"><input id="detail-subconscious-runtime-enabled" type="checkbox" ' + (model?.runtimeDesiredEnabled ? 'checked' : '') + '>Enabled</label>'
        + '<div class="field-label">Provider</div>'
        + '<input id="detail-subconscious-provider" class="detail-input" value="' + esc(model?.runtimeProvider || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Model</div>'
        + '<input id="detail-subconscious-model" class="detail-input" value="' + esc(model?.runtimeModel || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Endpoint</div>'
        + '<input id="detail-subconscious-endpoint" class="detail-input" value="' + esc(model?.runtimeEndpoint || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Key Env</div>'
        + '<input id="detail-subconscious-key-env" class="detail-input" value="' + esc(model?.runtimeKeyEnv || '').replace(/"/g, '&quot;') + '" placeholder="SUBCONSCIOUS_LLM_KEY">'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveSubconsciousRuntime()">Save</button></div>'
        + '</div>'
      )
      : '';
    systemsRoot.innerHTML = supervisorControlHtml + subconsciousControlHtml + runtimeContractHtml;

    const presetsRoot = document.getElementById('settings-presets');
    if (presetsRoot) {
      let ph = '<div class="detail-hint">Named bundles of framework/provider/model settings. Used in Configuration above.</div>';
      if (_presetCache.length === 0) {
        ph += '<div class="task-empty-state">No presets defined yet.</div>';
      } else {
        ph += '<table class="task-list-table"><thead><tr><th>Name</th><th>Framework</th><th>Model</th><th></th></tr></thead><tbody>';
        for (const p of _presetCache) {
          ph += '<tr>'
            + '<td><strong>' + esc(p.name) + '</strong></td>'
            + '<td>' + esc(p.framework || '-') + '</td>'
            + '<td>' + esc(p.model || '-') + '</td>'
            + '<td><button class="detail-save" style="font-size:10px;padding:2px 8px" onclick="deletePreset(\\'' + esc(p.id) + '\\')">Del</button></td>'
            + '</tr>';
        }
        ph += '</tbody></table>';
      }
      ph += '<details class="task-advanced" style="margin-top:10px"><summary class="task-advanced-toggle">Add Preset</summary>'
        + '<div class="field-label">Name</div><input id="preset-name" class="detail-input" placeholder="e.g. Claude Opus">'
        + '<div class="field-label">Framework</div><select id="preset-framework" class="detail-input"><option value="">—</option><option value="claude">claude</option><option value="codex">codex</option></select>'
        + '<div class="field-label">Provider</div><input id="preset-provider" class="detail-input" placeholder="e.g. anthropic">'
        + '<div class="field-label">Model</div><input id="preset-model" class="detail-input" placeholder="e.g. claude-sonnet-4-20250514">'
        + '<div class="field-label">Reasoning</div><input id="preset-reasoning" class="detail-input" placeholder="e.g. extended">'
        + '<div class="field-label">Extra Args</div><input id="preset-extraArgs" class="detail-input" placeholder="e.g. --verbose">'
        + '<div class="detail-actions"><button class="detail-save" onclick="createPreset()">Create Preset</button></div>'
        + '</details>';
      presetsRoot.innerHTML = ph;
    }

    const managedProjects = Array.isArray(detail?.managedProjects) ? detail.managedProjects : [];
    const projectRows = managedProjects.length
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Managed Projects</div>'
        + '<div class="list">'
        + managedProjects.map((project) => (
          '<div class="summary-note"><strong>' + esc(project?.name || '?') + '</strong> · ' + esc(project?.source || 'unknown')
          + '<br><span class="mono">' + esc(project?.path || '-') + '</span>'
          + '<br>Origin: <span class="mono">' + esc(project?.originPath || '-') + '</span>'
          + '<div class="detail-actions">'
          + '<button class="detail-save project-action-btn" data-project-name="' + esc(project?.name || '').replace(/"/g, '&quot;') + '" data-project-path="' + esc(project?.path || '').replace(/"/g, '&quot;') + '" data-delete-files="0">Untrack</button>'
          + '<button class="detail-save project-action-btn" data-project-name="' + esc(project?.name || '').replace(/"/g, '&quot;') + '" data-project-path="' + esc(project?.path || '').replace(/"/g, '&quot;') + '" data-delete-files="1">Remove From Home</button>'
          + '</div></div>'
        )).join('')
        + '</div>'
        + '</div>'
      )
      : (
        '<div class="panel">'
        + '<div class="panel-label">Managed Projects</div>'
        + '<div class="empty-state">No managed projects.</div>'
        + '</div>'
      );
    const projectImportHtml =
      '<div class="panel">'
      + '<div class="panel-label">Import Project</div>'
      + '<div class="field-label">Source Path</div>'
      + '<input id="detail-project-import-source" class="detail-input" placeholder="/absolute/path/to/project">'
      + '<div class="field-label">Project Name</div>'
      + '<input id="detail-project-import-name" class="detail-input" placeholder="Optional; defaults to directory name">'
      + '<div class="field-label">Mode</div>'
      + '<select id="detail-project-import-mode" class="detail-input"><option value="copy">copy</option><option value="symlink">symlink</option></select>'
      + '<div class="detail-actions"><button class="detail-save" onclick="importManagedProject()">Import</button></div>'
      + '</div>';
    const workspaceMigrationHtml =
      '<div class="panel">'
      + '<div class="panel-label">Workspace Migration</div>'
      + '<div class="detail-actions"><button class="detail-save" onclick="migrateWorkspaceEntryFiles()">Migrate Entry Files</button></div>'
      + '</div>';

    if (detail.v1) {
      ownerRoot.innerHTML += projectRows + projectImportHtml + workspaceMigrationHtml;
    }
    bindDetailEditors();
    if (detail.v1) bindProjectLifecycleButtons();
  }

  function renderUnreadPanel(unreadRows, queueRows, unreadTotal) {
    const blocks = [];
    blocks.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Unread</div><div class="summary-v">' + esc(String(unreadTotal)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Queue</div><div class="summary-v">' + esc(String(queueRows.length)) + '</div></div>'
      + '</div>');
    if (unreadRows.length > 0) {
      blocks.push('<ul class="list">' + unreadRows.slice(0, 12).map((msg) => {
        const route = msg?.group ? ('Group #' + String(msg.group) + ' @' + String(msg.from || 'unknown')) : ('DM @' + String(msg?.from || 'unknown'));
        const previewRaw = String(msg?.summary || msg?.full || '(no summary)').replace(/\\s+/g, ' ').trim();
        const preview = previewRaw.length > 140 ? (previewRaw.slice(0, 140) + '...') : previewRaw;
        return '<li><span class="mono">' + esc(route) + '</span><br>' + esc(preview) + '</li>';
      }).join('') + '</ul>');
    } else {
      blocks.push('<div class="empty-state">No unread messages.</div>');
    }
    if (queueRows.length > 0) {
      blocks.push('<div class="summary-note"><strong>Queued targets:</strong><ul class="list tight">' + queueRows.slice(0, 8).map((item) => (
        '<li>waiting ' + esc(fmtWaitAge(item?.queuedAt)) + ' · ' + esc(String(item?.payload || '').slice(0, 90)) + '</li>'
      )).join('') + '</ul></div>');
    }
    return blocks.join('');
  }

  function renderSubconsciousUnified(model) {
    const upstream = (model.upstreamDetail && typeof model.upstreamDetail === 'object') ? model.upstreamDetail : {};
    const upstreamBootstrap = (model.upstreamBootstrap && typeof model.upstreamBootstrap === 'object') ? model.upstreamBootstrap : {};
    const upstreamSession = (model.upstreamSession && typeof model.upstreamSession === 'object') ? model.upstreamSession : {};
    const upstreamUserPrompt = (model.upstreamUserPrompt && typeof model.upstreamUserPrompt === 'object') ? model.upstreamUserPrompt : {};
    const upstreamPreTool = (model.upstreamPreTool && typeof model.upstreamPreTool === 'object') ? model.upstreamPreTool : {};
    const upstreamNotify = (upstreamSession.notify && typeof upstreamSession.notify === 'object') ? upstreamSession.notify : {};
    const directReuse = Array.isArray(upstream.directReuse) ? upstream.directReuse : [];


    const authority = (model.authority && typeof model.authority === 'object') ? model.authority : {};
    const fallback = (model.fallback && typeof model.fallback === 'object') ? model.fallback : {};
    const transitional = (model.transitional && typeof model.transitional === 'object') ? model.transitional : {};
    let modeDotClass = 'dot-off';
    let modeLabel = 'Subconscious Off';
    if (authority.status === 'active') {
      modeDotClass = 'dot-runtime';
      modeLabel = 'Authoritative Path Active';
    } else if (authority.status === 'degraded') {
      modeDotClass = 'dot-active';
      modeLabel = 'Authoritative Path Degraded';
    } else if (authority.status === 'unconfigured') {
      modeDotClass = 'dot-active';
      modeLabel = 'Authoritative Path Unconfigured';
    } else if (model.subconsciousEnabled) {
      modeDotClass = 'dot-active';
      modeLabel = 'Enabled Without Authority';
    }
    document.getElementById('subconscious-mode-chip').innerHTML = '<div class="subconscious-mode-indicator"><span class="mode-dot ' + modeDotClass + '"></span>' + esc(modeLabel) + '</div>';

    const bits = [];
    const conversation = (model.currentConversation && typeof model.currentConversation === 'object') ? model.currentConversation : null;
    const conversationStore = (model.subconsciousConversation && typeof model.subconsciousConversation === 'object') ? model.subconsciousConversation : {};

    // ═══════════════════════════════════════════════
    // TIER 1: Status at a glance
    // ═══════════════════════════════════════════════
    const authoritativeStatus = authority.status || 'off';
    const authoritativeSession = upstreamSession.established === true ? 'Established' : (upstreamSession.status || 'not-run');
    const fallbackStatus = fallback.configured === true ? 'Guidance configured' : 'No guidance';
    const localRuntimeStatus = transitional.runtimeStatus || model.localRuntimeLabel || 'off';
    bits.push('<div class="sub-section">');
    bits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Authority</div><div class="summary-v">' + esc(authoritativeStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Session</div><div class="summary-v">' + esc(authoritativeSession) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Fallback</div><div class="summary-v">' + esc(fallbackStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Events</div><div class="summary-v">' + esc(String(model.subconsciousEvents.length)) + '</div></div>'
      + '</div>');
    if (authority.reason) {
      bits.push('<div class="summary-note"><strong>Authority reason:</strong> ' + esc(authority.reason) + '</div>');
    }
    if (model.subconsciousBlockers.length > 0) {
      bits.push('<div style="margin-top:6px"><span style="color:#fc8181;font-size:11px">' + esc(model.subconsciousBlockers.length + ' blocker' + (model.subconsciousBlockers.length > 1 ? 's' : '')) + '</span></div>');
    }
    bits.push('</div>');

    // ═══════════════════════════════════════════════
    // TIER 2: Operational detail (always visible)
    // ═══════════════════════════════════════════════

    // --- Authoritative Path ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Authoritative Path</div>');
    bits.push('<div class="summary-note"><strong>Path:</strong> upstream Letta durable state</div>');
    bits.push('<div class="summary-note"><strong>Bootstrap:</strong> ' + esc(upstreamBootstrap.status || 'not-run')
      + (upstreamBootstrap.blockedReason ? (' · ' + esc(upstreamBootstrap.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Agent:</strong> ' + esc(upstreamBootstrap.agentId || model.subconsciousDetail?.provider?.lettaAgentId || '-') + '</div>');
    bits.push('<div class="summary-note"><strong>Session:</strong> ' + esc(upstreamSession.established === true ? 'Established' : (upstreamSession.status || 'not-run'))
      + (upstreamSession.sessionId ? (' · ' + esc(upstreamSession.sessionId)) : '')
      + (upstreamSession.blockedReason ? (' · ' + esc(upstreamSession.blockedReason)) : '') + '</div>');
    if (upstreamSession.conversationId) {
      bits.push('<div class="summary-note"><strong>Conversation:</strong> ' + esc(upstreamSession.conversationId) + (upstreamSession.conversationStatus ? (' · ' + esc(upstreamSession.conversationStatus)) : '') + '</div>');
    }
    bits.push('<div class="summary-note"><strong>User Prompt:</strong> ' + esc(upstreamUserPrompt.status || 'not-run')
      + (upstreamUserPrompt.sessionId ? (' · ' + esc(upstreamUserPrompt.sessionId)) : '')
      + (upstreamUserPrompt.blockedReason ? (' · ' + esc(upstreamUserPrompt.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Pre-Tool:</strong> ' + esc(upstreamPreTool.status || 'not-run')
      + (upstreamPreTool.sessionId ? (' · ' + esc(upstreamPreTool.sessionId)) : '')
      + (upstreamPreTool.blockedReason ? (' · ' + esc(upstreamPreTool.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Notify:</strong> ' + esc(upstreamNotify.status || 'not-attempted')
      + (upstreamNotify.blockedReason ? (' · ' + esc(upstreamNotify.blockedReason)) : '') + '</div>');
    bits.push('</div>');

    // --- Fallback & Transitional ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Fallback & Transitional</div>');
    bits.push('<div class="summary-note"><strong>Guidance:</strong> ' + esc(fallback.status || 'none')
      + (fallback.note ? (' · ' + esc(fallback.note)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Local runtime:</strong> ' + esc(localRuntimeStatus)
      + ' · transitional only'
      + (model.runtimeDisabledReason ? (' · ' + esc(model.runtimeDisabledReason)) : '') + '</div>');
    if (model.guidancePreview) {
      bits.push('<div class="guidance-preview gp-manual"><div class="guidance-label">Guidance</div><div class="guidance-text">' + esc(model.guidancePreview) + '</div></div>');
    }
    if (model.subconsciousMemory?.entryCount > 0) {
      bits.push('<div class="summary-note"><strong>Local memory journal:</strong> ' + esc(model.subconsciousMemory.kind || 'episodic') + ' · ' + esc(String(model.subconsciousMemory.entryCount)) + ' episodes · transitional only</div>');
    }
    if (!model.guidancePreview && !(model.subconsciousMemory?.entryCount > 0)) {
      bits.push('<div class="summary-note">' + esc(transitional.note || 'No fallback or transitional detail recorded.') + '</div>');
    }
    bits.push('</div>');

    // --- Latest Activity ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Latest Event</div>');
    if (model.latestSubEvent) {
      const lev = model.latestSubEvent;
      const latestHook = lev.hook || lev.hookEventName || 'Unknown';
      bits.push('<div class="summary-note">'
        + '<span class="hook-badge ' + hookBadgeClass(latestHook) + '">' + esc(hookDisplayName(latestHook)) + '</span> '
        + esc(fmtTs(lev.ts))
        + (lev.toolName ? (' · ' + esc(lev.toolName)) : '')
        + (lev.guidanceInjected === true ? ' · <span style="color:#9ae6b4">injected</span>' : '')
        + (lev.runtimeInvoked === true ? ' · <span style="color:#63b3ed">runtime</span>' : '')
        + '</div>');
      if (lev.summary) {
        const preview = cleanEventSummary(String(lev.summary).replace(/\\s+/g, ' ').trim(), latestHook, lev.toolName);
        if (preview) bits.push('<div class="event-summary">' + esc(preview.length > 160 ? preview.slice(0, 160) + '...' : preview) + '</div>');
      }
    } else {
      bits.push('<div class="empty-state">No hook events recorded yet.</div>');
    }
    bits.push('</div>');

    // --- Blockers (always visible if present) ---
    if (model.subconsciousBlockers.length > 0) {
      bits.push('<div class="sub-section">');
      bits.push('<div class="sub-section-label" style="color:#fc8181">Blockers</div>');
      bits.push('<ul class="list tight">' + model.subconsciousBlockers.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>');
      bits.push('</div>');
    }

    // ═══════════════════════════════════════════════
    // TIER 3: Collapsed details
    // ═══════════════════════════════════════════════
    bits.push('<div class="sub-divider"></div>');

    // --- Conversation State (collapsed) ---
    bits.push('<details class="sub-detail">');
    bits.push('<summary>Local Conversation Journal</summary>');
    bits.push('<div class="sub-detail-body">');
    if (conversation || conversationStore.currentSessionId) {
      bits.push('<div class="summary-note"><strong>Role:</strong> transitional compatibility journal only</div>');
      bits.push('<div class="summary-note"><strong>Session:</strong> ' + esc(conversation?.sessionId || conversationStore.currentSessionId || '-') + '</div>');
      bits.push('<div class="summary-note"><strong>Turns:</strong> user ' + esc(String(conversation?.userTurnCount ?? 0)) + ' · assistant ' + esc(String(conversation?.assistantTurnCount ?? 0)) + '</div>');
      bits.push('<div class="summary-note"><strong>Last activity:</strong> ' + esc(conversation?.lastEventAt || conversationStore.lastSyncedAt || '-') + '</div>');
    } else {
      bits.push('<div class="empty-state">No local transitional conversation journal recorded.</div>');
    }
    bits.push('</div></details>');

    // --- Hook Event Stream (collapsed) ---
    bits.push('<details class="sub-detail" id="subconscious-event-stream">');
    bits.push('<summary>Event Stream <span class="section-count">' + esc(String(model.subconsciousEvents.length)) + '</span></summary>');
    bits.push('<div class="sub-detail-body">');
    bits.push('<div id="unified-hook-breakdown" class="hook-breakdown" style="margin-bottom:10px"></div>');
    bits.push('<div id="unified-event-list" class="event-list"></div>');
    bits.push('</div></details>');

    // --- Section 6: Debug internals (collapsed by default) ---
    bits.push('<details class="sub-detail">');
    bits.push('<summary>Debug Internals</summary>');
    bits.push('<div class="sub-detail-body">');

    // Config Status
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Config Status</div>' + kvGrid([
      ['Stage', model.subconsciousStage],
      ['Enabled', model.subconsciousEnabled ? 'yes' : 'no'],
      ['Writable', model.subconsciousWritable ? 'yes' : 'no'],
      ['Guidance', model.guidanceConfigured ? 'configured' : 'none'],
      ['Event count', model.subconsciousEvents.length],
      ['Injected count', model.guidanceInjectedEvents.length],
    ]) + '</div>');

    // Hook Installation
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Hook Installation</div>' + kvGrid([
      ['Runtime installed', model.subconsciousDetail?.runtime?.hookRuntimeInstalled === true ? 'yes' : 'no'],
      ['Bindings installed', model.subconsciousDetail?.runtime?.hookBindingsInstalled === true ? 'yes' : 'no'],
      ['Hooks', Array.isArray(model.subconsciousDetail?.runtime?.installedHooks) && model.subconsciousDetail.runtime.installedHooks.length ? model.subconsciousDetail.runtime.installedHooks.join(', ') : '-'],
      ['Event sink', model.subconsciousDetail?.runtime?.eventSinkConfigured === true ? 'yes' : 'no'],
      ['Event URL', model.subconsciousDetail?.runtime?.eventUrl || '-'],
      ['Invoke URL', model.subconsciousDetail?.runtime?.invokeUrl || '-'],
    ]) + '</div>');

    // Runtime LLM
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Runtime LLM</div>' + kvGrid([
      ['Desired enabled', model.runtimeDesiredEnabled ? 'yes' : 'no'],
      ['Invocation configured', model.runtimeInvocationConfigured ? 'yes' : 'no'],
      ['Disabled reason', model.runtimeDisabledReason || '-'],
      ['Provider', model.runtimeProvider || '-'],
      ['Model', model.runtimeModel || '-'],
      ['Endpoint', model.runtimeEndpoint || '-'],
      ['Key env', model.runtimeKeyEnv || '-'],
      ['Key available', model.runtimeKeyAvailable ? 'yes' : 'no'],
    ]) + '</div>');

    // Config Sources
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Config Resolution</div>' + kvGrid([
      ['Provider', model.runtimeConfigSources?.provider || '-'],
      ['Model', model.runtimeConfigSources?.model || '-'],
      ['Endpoint', model.runtimeConfigSources?.endpoint || '-'],
      ['Key env', model.runtimeConfigSources?.keyEnv || '-'],
    ]) + '</div>');

    // Episodic Memory
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Episodic Memory</div>' + kvGrid([
      ['Store configured', model.subconsciousDetail?.provider?.memoryStoreConfigured === true ? 'yes' : 'no'],
      ['Kind', model.subconsciousMemory?.kind || '-'],
      ['Entries', model.subconsciousMemory?.entryCount ?? '-'],
      ['Strategy', model.subconsciousMemory?.retrievalStrategy || '-'],
      ['Path', model.subconsciousMemory?.path || '-'],
      ['Last retrieval', model.subconsciousMemory?.lastRetrievedAt || '-'],
      ['Last query', model.subconsciousMemory?.lastRetrievedQuery || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Conversation Journal</div>' + kvGrid([
      ['Store kind', model.subconsciousConversation?.kind || '-'],
      ['Store path', model.subconsciousConversation?.path || '-'],
      ['Sessions', model.subconsciousConversation?.sessionCount ?? '-'],
      ['Session limit', model.subconsciousConversation?.sessionLimit ?? '-'],
      ['Current session', model.currentConversation?.sessionId || model.subconsciousConversation?.currentSessionId || '-'],
      ['Transcript path', model.currentConversation?.transcriptPath || model.subconsciousConversation?.currentTranscriptPath || '-'],
      ['Transcript exists', model.currentConversation?.transcriptExists === true ? 'yes' : 'no'],
      ['User turns', model.currentConversation?.userTurnCount ?? '-'],
      ['Assistant turns', model.currentConversation?.assistantTurnCount ?? '-'],
      ['Latest guidance preview', model.currentConversation?.latestGuidancePreview || '-'],
      ['Last sync', model.subconsciousConversation?.lastSyncedAt || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream Session Lifecycle</div>' + kvGrid([
      ['Status', upstreamSession.status || '-'],
      ['Blocked reason', upstreamSession.blockedReason || '-'],
      ['Established', upstreamSession.established === true ? 'yes' : 'no'],
      ['Session id', upstreamSession.sessionId || '-'],
      ['Conversation id', upstreamSession.conversationId || '-'],
      ['Conversation status', upstreamSession.conversationStatus || '-'],
      ['Session state file', upstreamSession.sessionStateFile || '-'],
      ['Session started', upstreamSession.sessionStartedAt || '-'],
      ['Notify status', upstreamNotify.status || '-'],
      ['Notify blocker', upstreamNotify.blockedReason || '-'],
      ['Notify attempted', upstreamNotify.attempted ? 'yes' : 'no'],
      ['Message sent', upstreamNotify.messageSent ? 'yes' : 'no'],
      ['Notify attempted at', upstreamNotify.attemptedAt || '-'],
      ['Message sent at', upstreamNotify.messageSentAt || upstreamSession.messageSentAt || '-'],
      ['Required decision', upstreamNotify.requiredDecision || '-'],
      ['Checked at', upstreamSession.checkedAt || '-'],
      ['CWD', upstreamSession.cwd || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream User Prompt</div>' + kvGrid([
      ['Status', upstreamUserPrompt.status || '-'],
      ['Blocked reason', upstreamUserPrompt.blockedReason || '-'],
      ['Attempted', upstreamUserPrompt.attempted ? 'yes' : 'no'],
      ['Message sent', upstreamUserPrompt.messageSent ? 'yes' : 'no'],
      ['Session id', upstreamUserPrompt.sessionId || '-'],
      ['Conversation id', upstreamUserPrompt.conversationId || '-'],
      ['Transcript path', upstreamUserPrompt.transcriptPath || '-'],
      ['Transcript exists', upstreamUserPrompt.transcriptExists === true ? 'yes' : 'no'],
      ['Transcript lines', upstreamUserPrompt.transcriptLineCount ?? '-'],
      ['Sync state file', upstreamUserPrompt.syncStateFile || '-'],
      ['Last processed before', upstreamUserPrompt.lastProcessedIndexBefore ?? '-'],
      ['Last processed after', upstreamUserPrompt.lastProcessedIndexAfter ?? '-'],
      ['Script path', upstreamUserPrompt.scriptPath || '-'],
      ['Attempted at', upstreamUserPrompt.attemptedAt || '-'],
      ['Message sent at', upstreamUserPrompt.messageSentAt || '-'],
      ['Checked at', upstreamUserPrompt.checkedAt || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream Pre-Tool</div>' + kvGrid([
      ['Status', upstreamPreTool.status || '-'],
      ['Blocked reason', upstreamPreTool.blockedReason || '-'],
      ['Attempted', upstreamPreTool.attempted ? 'yes' : 'no'],
      ['Injected', upstreamPreTool.injected ? 'yes' : 'no'],
      ['Session id', upstreamPreTool.sessionId || '-'],
      ['Conversation id', upstreamPreTool.conversationId || '-'],
      ['Sync state file', upstreamPreTool.syncStateFile || '-'],
      ['New messages', upstreamPreTool.newMessageCount ?? '-'],
      ['Changed blocks', upstreamPreTool.changedBlockCount ?? '-'],
      ['Last seen before', upstreamPreTool.lastSeenMessageIdBefore || '-'],
      ['Last seen after', upstreamPreTool.lastSeenMessageIdAfter || '-'],
      ['Block labels', upstreamPreTool.blockLabelCount ?? '-'],
      ['Script path', upstreamPreTool.scriptPath || '-'],
      ['Attempted at', upstreamPreTool.attemptedAt || '-'],
      ['Injected at', upstreamPreTool.injectedAt || '-'],
      ['Checked at', upstreamPreTool.checkedAt || '-'],
    ]) + '</div>');

    // State & Invocation
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">State & Invocation</div>' + kvGrid([
      ['Letta agent id', model.subconsciousDetail?.provider?.lettaAgentId || model.latestSubEvent?.lettaAgentId || '-'],
      ['State file', model.latestSubEvent?.lettaStateFile || '-'],
      ['Backend runtime', model.subconsciousDetail?.provider?.backendRuntimeConfigured === true ? 'yes' : 'no'],
      ['Model config', model.subconsciousDetail?.provider?.modelConfigConfigured === true ? 'yes' : 'no'],
      ['Invocation boundary', model.subconsciousDetail?.provider?.invocationConfigured === true ? 'yes' : 'no'],
      ['Last invocation', model.lastRuntimeInvocation?.summary || '-'],
      ['Last retrieval matches', model.lastRuntimeInvocation?.memoryRetrieval?.matchCount ?? '-'],
      ['Last retrieval ids', Array.isArray(model.lastRuntimeInvocation?.memoryRetrieval?.matchIds) && model.lastRuntimeInvocation.memoryRetrieval.matchIds.length ? model.lastRuntimeInvocation.memoryRetrieval.matchIds.join(', ') : '-'],
      ['Last runtime guidance', model.lastRuntimeGuidance?.preview || '-'],
    ]) + '</div>');

    // Latest Event
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Latest Event Detail</div>' + kvGrid([
      ['Hook', model.latestSubEvent?.hook || model.latestSubEvent?.hookEventName || '-'],
      ['Source', model.latestSubEvent?.source || '-'],
      ['Tool', model.latestSubEvent?.toolName || '-'],
      ['Summary', model.latestSubEvent?.summary || '-'],
      ['Prompt preview', model.latestSubEvent?.promptPreview || '-'],
      ['Resolution', model.latestSubEvent?.resolutionSource || '-'],
    ]) + '</div>');

    bits.push('</div></details>');

    document.getElementById('subconscious-unified-content').innerHTML = bits.join('');

    // Render dynamic elements after innerHTML is set
    renderHookBreakdown('unified-hook-breakdown', model.subconsciousEvents);
    renderSubconsciousEventList('unified-event-list', model.subconsciousEvents, 30, 'No hook events recorded yet.');
  }

  function renderActivity(model) {
    const latest = model.latest || null;
    const supervisorBits = [];
    supervisorBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Enabled</div><div class="summary-v">' + esc(model.supervisorEnabled ? 'On' : 'Off') + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Latest Status</div><div class="summary-v">' + esc(model.latestStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Last Judged</div><div class="summary-v">' + esc(fmtTs(model.state?.lastJudgedAt)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Warnings</div><div class="summary-v">' + esc(String(model.consecutiveNegative)) + '</div></div>'
      + '</div>');
    if (!latest) {
      supervisorBits.push('<div class="empty-state">No supervisor evaluations yet.</div>');
    } else {
      supervisorBits.push('<div class="primary-text">' + esc(latest.reason || latest.status || 'No supervisor reason recorded.') + '</div>');
      const evaluated = [];
      if (latest.domain) evaluated.push('domain ' + latest.domain);
      if (latest.pattern) evaluated.push('pattern ' + latest.pattern);
      if (latest.action?.summary) evaluated.push(latest.action.summary);
      if (evaluated.length) supervisorBits.push('<div class="secondary-text muted">' + esc(evaluated.join(' · ')) + '</div>');
      const recentEval = model.events.slice(-4).reverse();
      if (recentEval.length > 0) {
        supervisorBits.push('<ul class="list tight">' + recentEval.map((ev) => (
          '<li><span class="mono">' + esc(fmtTs(ev?.ts)) + '</span> · '
          + esc(eventStatusText(ev)) + ' · '
          + esc(ev?.reason || 'No reason recorded.')
          + '</li>'
        )).join('') + '</ul>');
      }
    }
    document.getElementById('activity-supervisor').innerHTML = supervisorBits.join('');

    renderSubconsciousUnified(model);
  }

  function renderDocMeta(targetId, doc, filePath, suffix = '') {
    const el = document.getElementById(targetId);
    if (!el) return;
    const bits = [];
    bits.push('<span class="meta-item mono">' + esc(filePath || '-') + '</span>');
    if (doc?.readError) bits.push('<span class="meta-item">read error: ' + esc(doc.readError) + '</span>');
    else bits.push('<span class="meta-item">' + esc(doc?.exists ? 'present' : 'missing') + '</span>');
    if (suffix) bits.push('<span class="meta-item">' + esc(suffix) + '</span>');
    el.innerHTML = bits.join('');
  }

  function renderDocFrame(targetId, doc, missingMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (doc?.readError) {
      el.textContent = 'Read failed: ' + doc.readError;
      return;
    }
    if (!doc?.exists) {
      el.textContent = missingMessage;
      return;
    }
    el.textContent = String(doc?.text || '');
  }

  function renderInternals(detail, supervisorStatus, model) {
    const docs = (detail?.docs && typeof detail.docs === 'object') ? detail.docs : {};
    document.getElementById('debug-runtime').innerHTML = kvGrid([
      ['Enabled', supervisorStatus?.enabled],
      ['Interval (ms)', supervisorStatus?.intervalMs],
      ['Model', ((supervisorStatus?.llm?.provider || '-') + ' / ' + (supervisorStatus?.llm?.model || '-'))],
      ['Last sweep', fmtTs(supervisorStatus?.runtime?.lastSweepAt)],
      ['Evaluated(active)', String(toInt(supervisorStatus?.runtime?.lastSweepEvaluated, 0)) + ' / ' + String(toInt(supervisorStatus?.runtime?.lastSweepActive, 0))],
      ['Sweep error', supervisorStatus?.runtime?.lastSweepError || '-'],
    ]);
    document.getElementById('debug-paths').innerHTML = kvGrid([
      ['docsRoot', docs.docsRoot || '-'],
      ['agents.md', docs.agentsPath || '-'],
      ['plan.md', docs.planPath || '-'],
      ['progress.md', docs.progressPath || '-'],
      ['homeDir', detail?.homeDir || '-'],
      ['workdir', detail?.workdir || '-'],
      ['stateDir', detail?.stateDir || '-'],
      ['manifest', detail?.agentJsonPath || '-'],
    ]);
    renderDocMeta('debug-doc-agents-meta', docs.agents, docs.agentsPath);
    renderDocMeta('debug-doc-plan-meta', docs.plan, docs.planPath);
    renderDocMeta('debug-doc-progress-meta', docs.progress, docs.progressPath, (docs.progress?.tailLines ? ('tail ' + docs.progress.tailLines + ' lines') : ''));
    renderDocFrame('debug-doc-agents', docs.agents, 'AGENTS.md not found.');
    renderDocFrame('debug-doc-plan', docs.plan, 'plan.md not found.');
    renderDocFrame('debug-doc-progress', docs.progress, 'progress.md not found.');
    document.getElementById('debug-raw').innerHTML = kvGrid([
      ['path', detail?.path || '-'],
      ['resumeId', detail?.resumeId || '-'],
      ['server', detail?.server || '-'],
      ['model', detail?.model || '-'],
      ['extraArgs', detail?.extraArgs || '-'],
      ['groups', Array.isArray(detail?.groups) && detail.groups.length ? detail.groups.join(', ') : '-'],
      ['agentId', detail?.agentId || '-'],
      ['layoutVersion', detail?.layoutVersion || '-'],
    ]);
  }

  function renderAuditHistory(model) {
    const body = document.getElementById('audit-rows');
    if (!body) return;
    const rows = model.events.slice().reverse();
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="muted">No events yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((ev) => {
      const action = ev?.action ? (ev.action.type + (ev.action.summary ? (' · ' + ev.action.summary) : '')) : '-';
      return '<tr>'
        + '<td>' + esc(fmtTs(ev?.ts)) + '</td>'
        + '<td><span class="status ' + eventStatusClass(ev) + '">' + esc(eventStatusText(ev)) + '</span></td>'
        + '<td>' + esc(ev?.domain || '-') + '</td>'
        + '<td>' + esc(ev?.pattern || '-') + '</td>'
        + '<td>' + esc(ev?.reason || '-') + '</td>'
        + '<td>' + esc(String(ev?.state?.consecutiveNegative ?? '-')) + '</td>'
        + '<td>' + esc(action) + '</td>'
      + '</tr>';
    }).join('');
  }

  async function saveDetailIdentity() {
    if (detailSaveInFlight) return;
    const input = document.getElementById('detail-identity-input');
    if (!input) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving identity...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: String(input.value || '').trim() || null }),
      });
      if (!res.ok) throw new Error('identity save failed');
      setDetailStatus('Identity saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Identity save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveDetailOwner() {
    if (detailSaveInFlight) return;
    const ownerEl = document.getElementById('detail-owner');
    if (!ownerEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving owner...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/home-metadata', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: String(ownerEl.value || '').trim() || null,
        }),
      });
      if (!res.ok) throw new Error('owner save failed');
      setDetailStatus('Owner saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Owner save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSubconsciousControl() {
    if (detailSaveInFlight) return;
    const subconsciousEl = document.getElementById('detail-subconscious-enabled');
    if (!subconsciousEl) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Subconscious control is read-only here: writable only for V1 home agents.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Saving subconscious control...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/home-metadata', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subconsciousEnabled: subconsciousEl.checked === true,
        }),
      });
      if (!res.ok) throw new Error('subconscious control save failed');
      setDetailStatus('Subconscious control saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Subconscious control save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveDetailGuidance() {
    if (detailSaveInFlight) return;
    const guidanceEl = document.getElementById('detail-guidance');
    if (!guidanceEl) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Guidance is read-only here: writable only for V1 subconscious state.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Saving guidance...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/subconscious-guidance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guidance: String(guidanceEl.value || '').trim(),
        }),
      });
      if (!res.ok) throw new Error('guidance save failed');
      setDetailStatus('Guidance saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Guidance save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSubconsciousRuntime() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Subconscious runtime config is read-only here: writable only for V1 subconscious state.', 'error');
      return;
    }
    const enabledEl = document.getElementById('detail-subconscious-runtime-enabled');
    const providerEl = document.getElementById('detail-subconscious-provider');
    const modelEl = document.getElementById('detail-subconscious-model');
    const endpointEl = document.getElementById('detail-subconscious-endpoint');
    const keyEnvEl = document.getElementById('detail-subconscious-key-env');
    if (!enabledEl || !providerEl || !modelEl || !endpointEl || !keyEnvEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving subconscious runtime contract...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/subconscious-runtime', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: enabledEl.checked === true,
          provider: String(providerEl.value || '').trim(),
          model: String(modelEl.value || '').trim(),
          endpoint: String(endpointEl.value || '').trim(),
          keyEnv: String(keyEnvEl.value || '').trim(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'runtime contract save failed');
      }
      setDetailStatus('Subconscious runtime contract saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Subconscious runtime contract save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function importManagedProject() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Project import is writable only for V1 home agents.', 'error');
      return;
    }
    const sourceEl = document.getElementById('detail-project-import-source');
    const nameEl = document.getElementById('detail-project-import-name');
    const modeEl = document.getElementById('detail-project-import-mode');
    if (!sourceEl || !nameEl || !modeEl) return;
    const sourcePath = String(sourceEl.value || '').trim();
    if (!sourcePath) {
      setDetailStatus('Project import requires a source path.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Importing project into workdir/projects...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath,
          projectName: String(nameEl.value || '').trim(),
          mode: String(modeEl.value || 'copy').trim().toLowerCase(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'project import failed');
      }
      const importedName = payload?.importedProject?.name || '(project)';
      const materialization = payload?.materialization || 'updated';
      setDetailStatus('Project imported: ' + importedName + ' (' + materialization + ').', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2500);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Project import failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function removeManagedProject(projectName, projectPath, deleteFiles) {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Managed-project removal is writable only for V1 home agents.', 'error');
      return;
    }
    const confirmCopy = deleteFiles
      ? ('Remove ' + (projectName || '(project)') + ' from managedProjects and delete its local path under workdir/projects?')
      : ('Untrack ' + (projectName || '(project)') + ' from managedProjects but keep the current files on disk?');
    if (!window.confirm(confirmCopy)) return;
    detailSaveInFlight = true;
    setDetailStatus(deleteFiles ? 'Removing project from this home...' : 'Removing project from managedProjects...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/projects/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          projectPath,
          deleteFiles: deleteFiles === true,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'project removal failed');
      }
      const fileAction = payload?.fileAction ? (' [' + payload.fileAction + ']') : '';
      setDetailStatus((deleteFiles ? 'Project removed from this home: ' : 'Project untracked: ') + (projectName || '(project)') + fileAction + '.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2500);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Project removal failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function migrateWorkspaceEntryFiles() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Workspace entry migration is writable only for V1 home agents.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Migrating workspace entry files...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/workspace/migrate-entry-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'workspace migration failed');
      }
      const sync = payload?.workspaceSync || {};
      const summary = [
        sync.agentsRootStatus ? ('root AGENTS ' + sync.agentsRootStatus) : null,
        sync.docsAgentsStatus ? ('docs/AGENTS ' + sync.docsAgentsStatus) : null,
      ].filter(Boolean).join(', ');
      setDetailStatus('Workspace entry migration completed.' + (summary ? ' ' + summary + '.' : ''), 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 3000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Workspace entry migration failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSupervisorAuditControl() {
    if (detailSaveInFlight) return;
    const supervisorEl = document.getElementById('detail-supervisor-enabled');
    if (!supervisorEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving supervisor audit control...', 'warn');
    try {
      const res = await fetch('/api/supervisor/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: supervisorEl.checked === true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'supervisor control save failed');
      }
      setDetailStatus('Supervisor audit control saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Supervisor audit control save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  const CFG_VALID_FRAMEWORKS = ['claude', 'codex'];
  const CFG_SHELL_METACHAR_RE = /[;&|\x60$(){}!\\\\<>]/;

  function sanitizeExtraArgs(raw) {
    if (!raw) return null;
    const cleaned = String(raw).trim();
    if (!cleaned) return null;
    if (CFG_SHELL_METACHAR_RE.test(cleaned)) return '__REJECTED__';
    return cleaned;
  }

  function onPresetChange(prefix) {
    const sel = document.getElementById('cfg-' + prefix + '-preset');
    const custom = document.getElementById('cfg-' + prefix + '-custom');
    if (!sel || !custom) return;
    if (sel.value === '__custom__' || sel.value === '') {
      custom.style.display = '';
    } else {
      custom.style.display = 'none';
      const p = _presetCache.find(pp => pp.id === sel.value);
      if (p) {
        const fw = document.getElementById('cfg-' + prefix + '-framework');
        const pv = document.getElementById('cfg-' + prefix + '-provider');
        const md = document.getElementById('cfg-' + prefix + '-model');
        const rs = document.getElementById('cfg-' + prefix + '-reasoning');
        const ea = document.getElementById('cfg-' + prefix + '-extraArgs');
        if (fw) fw.value = p.framework || '';
        if (pv) pv.value = p.provider || '';
        if (md) md.value = p.model || '';
        if (rs) rs.value = p.reasoning || '';
        if (ea) ea.value = p.extraArgs || '';
      }
    }
  }
  window.onPresetChange = onPresetChange;

  async function createPreset() {
    const name = ((document.getElementById('preset-name') || {}).value || '').trim();
    if (!name) { setDetailStatus('Preset name is required.', 'error'); return; }
    const body = {
      name,
      framework: ((document.getElementById('preset-framework') || {}).value || '').trim() || null,
      provider: ((document.getElementById('preset-provider') || {}).value || '').trim() || null,
      model: ((document.getElementById('preset-model') || {}).value || '').trim() || null,
      reasoning: ((document.getElementById('preset-reasoning') || {}).value || '').trim() || null,
      extraArgs: ((document.getElementById('preset-extraArgs') || {}).value || '').trim() || null,
    };
    try {
      const r = await fetch('/api/framework-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'create failed');
      setDetailStatus('Preset created: ' + (data.preset?.name || ''), 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) { setDetailStatus('Preset create failed: ' + e.message, 'error'); }
  }

  async function deletePreset(id) {
    if (!confirm('Delete this preset?')) return;
    try {
      const r = await fetch('/api/framework-presets/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'delete failed');
      setDetailStatus('Preset deleted.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) { setDetailStatus('Preset delete failed: ' + e.message, 'error'); }
  }

  window.createPreset = createPreset;
  window.deletePreset = deletePreset;

  function resolveRoleFromUI(prefix) {
    const presetSel = document.getElementById('cfg-' + prefix + '-preset');
    const presetId = presetSel ? presetSel.value : '';
    if (presetId && presetId !== '__custom__') {
      const p = _presetCache.find(pp => pp.id === presetId);
      if (p) return { framework: p.framework, provider: p.provider, model: p.model, reasoning: p.reasoning, extraArgs: p.extraArgs || null };
    }
    const framework = ((document.getElementById('cfg-' + prefix + '-framework') || {}).value || '').trim() || null;
    const provider = ((document.getElementById('cfg-' + prefix + '-provider') || {}).value || '').trim() || null;
    const model = ((document.getElementById('cfg-' + prefix + '-model') || {}).value || '').trim() || null;
    const reasoning = ((document.getElementById('cfg-' + prefix + '-reasoning') || {}).value || '').trim() || null;
    const extraArgs = sanitizeExtraArgs(((document.getElementById('cfg-' + prefix + '-extraArgs') || {}).value));
    if (extraArgs === '__REJECTED__') return '__REJECTED__';
    if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
    if (framework && !CFG_VALID_FRAMEWORKS.includes(framework)) return '__INVALID_FW__';
    return { framework, provider, model, reasoning, extraArgs };
  }

  async function saveDetailConfiguration() {
    if (detailSaveInFlight) return;

    const primary = resolveRoleFromUI('primary');
    const supervisor = resolveRoleFromUI('supervisor');
    if (primary === '__REJECTED__' || supervisor === '__REJECTED__') {
      setDetailStatus('extraArgs contains disallowed shell characters. Only CLI flags are allowed.', 'error');
      return;
    }
    if (primary === '__INVALID_FW__') { setDetailStatus('Invalid primary framework — must be claude or codex.', 'error'); return; }
    if (supervisor === '__INVALID_FW__') { setDetailStatus('Invalid supervisor framework — must be claude or codex.', 'error'); return; }

    const runtimeProfile = (primary || supervisor) ? { primary: primary || null, supervisor: supervisor || null } : null;
    const role = ((document.getElementById('cfg-role') || {}).value || '').trim() || null;

    detailSaveInFlight = true;
    setDetailStatus('Saving configuration...', 'warn');
    try {
      const body = {};
      if (role !== undefined) body.role = role;
      body.runtimeProfile = runtimeProfile;
      const res = await fetch('/api/agents/' + encodeURIComponent(agent), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || 'configuration save failed');
      setDetailStatus('Configuration saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 3000);
      const banner = document.getElementById('cfg-restart-banner');
      if (banner) banner.style.display = '';
      await refresh(true);
    } catch (e) {
      setDetailStatus('Configuration save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  window.saveDetailIdentity = saveDetailIdentity;
  window.saveDetailOwner = saveDetailOwner;
  window.importManagedProject = importManagedProject;
  window.removeManagedProject = removeManagedProject;
  window.migrateWorkspaceEntryFiles = migrateWorkspaceEntryFiles;
  window.saveSubconsciousControl = saveSubconsciousControl;
  window.saveDetailGuidance = saveDetailGuidance;
  window.saveSupervisorAuditControl = saveSupervisorAuditControl;
  window.saveDetailConfiguration = saveDetailConfiguration;
  window.saveSubconsciousRuntime = saveSubconsciousRuntime;

  // ── Task list (minimal Jira) ──────────────────────────────────────
  let taskListCache = [];
  let taskDetailViewId = null;

  function fmtTaskTime(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch { return iso; }
  }

  async function taskListRefresh() {
    const root = document.getElementById('task-list-root');
    if (!root) return;
    try {
      const r = await fetch('/api/tasks');
      if (!r.ok) throw new Error('status ' + r.status);
      taskListCache = await r.json();
    } catch (e) {
      root.innerHTML = '<div class="error-state">Failed to load tasks: ' + esc(e.message) + '</div>';
      return;
    }
    if (taskDetailViewId) {
      const found = taskListCache.find(t => t.id === taskDetailViewId);
      if (found) { renderTaskDetail(found); return; }
      taskDetailViewId = null;
    }
    renderTaskList();
  }

  function renderTaskList() {
    const root = document.getElementById('task-list-root');
    const detailPanel = document.getElementById('task-detail-panel');
    if (detailPanel) detailPanel.classList.add('hidden');
    if (!root) return;
    if (!taskListCache.length) {
      root.innerHTML = '<div class="task-empty-state">No tasks yet. Create one above.</div>';
      return;
    }
    const sorted = [...taskListCache].sort((a, b) => {
      const po = { p0:0, p1:1, p2:2, p3:3 };
      const so = { in_progress:0, accepted:1, blocked:2, created:3, done:4 };
      const sd = (so[a.status] ?? 5) - (so[b.status] ?? 5);
      if (sd !== 0) return sd;
      const pd = (po[a.priority] ?? 2) - (po[b.priority] ?? 2);
      if (pd !== 0) return pd;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    let html = '<table class="task-list-table"><thead><tr>'
      + '<th>Status</th><th>Pri</th><th>Title</th><th>Assignee</th><th>Comments</th><th>Created</th>'
      + '</tr></thead><tbody>';
    for (const t of sorted) {
      const cc = Array.isArray(t.comments) ? t.comments.length : 0;
      html += '<tr onclick="taskShowDetail(\\'' + esc(t.id) + '\\')">'
        + '<td><span class="task-status-badge task-status-' + esc(t.status) + '">' + esc(t.status) + '</span></td>'
        + '<td><span class="task-priority-badge task-priority-' + esc(t.priority) + '">' + esc(t.priority || 'p2').toUpperCase() + '</span></td>'
        + '<td>' + esc(t.title || '-') + '</td>'
        + '<td>' + esc(t.assignee || '-') + '</td>'
        + '<td>' + (cc > 0 ? cc : '-') + '</td>'
        + '<td>' + esc(fmtTaskTime(t.created_at)) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
  }

  function renderTaskDetail(task) {
    const detailPanel = document.getElementById('task-detail-panel');
    const root = document.getElementById('task-detail-root');
    if (!detailPanel || !root) return;
    detailPanel.classList.remove('hidden');
    taskDetailViewId = task.id;
    const statusOptions = ['created','accepted','in_progress','blocked','done'];
    let html = '<span class="task-detail-back" onclick="taskBackToList()">&#8592; Back to list</span>'
      + '<div class="task-detail-title">' + esc(task.title || 'Untitled') + '</div>'
      + '<div class="task-detail-meta">'
      + '<strong>ID:</strong> ' + esc(task.id) + ' &middot; '
      + '<strong>Priority:</strong> <span class="task-priority-badge task-priority-' + esc(task.priority) + '">' + esc((task.priority || 'p2').toUpperCase()) + '</span> &middot; '
      + '<strong>Assignee:</strong> ' + esc(task.assignee || 'unassigned') + ' &middot; '
      + '<strong>Created:</strong> ' + esc(fmtTaskTime(task.created_at))
      + '</div>'
      + '<div class="task-detail-meta">'
      + '<strong>Status:</strong> <select class="task-status-select" id="task-detail-status" onchange="taskChangeStatus(\\'' + esc(task.id) + '\\')">';
    for (const s of statusOptions) {
      html += '<option value="' + s + '"' + (task.status === s ? ' selected' : '') + '>' + s + '</option>';
    }
    html += '</select></div>';
    if (task.description) {
      html += '<div class="task-detail-desc">' + esc(task.description) + '</div>';
    }
    if (task.waiting_reason) {
      html += '<div class="task-detail-meta"><strong>Waiting:</strong> ' + esc(task.waiting_reason)
        + (task.waiting_until ? ' (until ' + esc(task.waiting_until) + ')' : '') + '</div>';
    }
    // Comments section
    const comments = Array.isArray(task.comments) ? task.comments : [];
    html += '<div class="task-comments">'
      + '<div class="field-label">Comments (' + comments.length + ')</div>';
    if (comments.length === 0) {
      html += '<div class="task-empty-state" style="padding:8px 0">No comments yet.</div>';
    } else {
      for (const c of comments) {
        html += '<div class="task-comment">'
          + '<div class="task-comment-meta">' + esc(c.author || 'anonymous') + ' &middot; ' + esc(fmtTaskTime(c.ts)) + '</div>'
          + '<div class="task-comment-text">' + esc(c.text) + '</div>'
          + '</div>';
      }
    }
    html += '<div class="task-comment-form">'
      + '<textarea id="task-comment-input" class="detail-textarea" placeholder="Add a comment..."></textarea>'
      + '<button class="detail-save" onclick="taskAddComment(\\'' + esc(task.id) + '\\')">Post</button>'
      + '</div></div>';
    // Delete button
    html += '<div class="detail-actions" style="margin-top:14px">'
      + '<button class="detail-save" style="background:rgba(255,100,100,0.1);border-color:rgba(255,100,100,0.3);color:rgba(255,140,140,0.9)" onclick="taskDelete(\\'' + esc(task.id) + '\\')">Delete Task</button>'
      + '</div>';
    root.innerHTML = html;
  }

  function taskBackToList() {
    taskDetailViewId = null;
    renderTaskList();
  }

  function taskShowDetail(id) {
    const task = taskListCache.find(t => t.id === id);
    if (task) renderTaskDetail(task);
  }

  async function taskCreateSubmit() {
    const titleEl = document.getElementById('task-create-title');
    const prioEl = document.getElementById('task-create-priority');
    const assigneeEl = document.getElementById('task-create-assignee');
    const statusEl = document.getElementById('task-create-status');
    if (!titleEl || !prioEl) return;
    const title = titleEl.value.trim();
    if (!title) { if (statusEl) statusEl.textContent = 'Title is required.'; return; }
    try {
      const body = { title, priority: prioEl.value };
      const assignee = (assigneeEl?.value || '').trim();
      if (assignee) body.assignee = assignee;
      const r = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'create failed');
      titleEl.value = '';
      if (assigneeEl) assigneeEl.value = '';
      if (statusEl) { statusEl.textContent = 'Created: ' + (data.task?.id || ''); setTimeout(() => statusEl.textContent = '', 3000); }
      taskListRefresh();
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Error: ' + e.message;
    }
  }

  async function taskChangeStatus(id) {
    const sel = document.getElementById('task-detail-status');
    if (!sel) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/transition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: sel.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'transition failed');
      taskListRefresh();
    } catch (e) {
      alert('Status change failed: ' + e.message);
    }
  }

  async function taskAddComment(id) {
    const input = document.getElementById('task-comment-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, author: 'operator' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'comment failed');
      taskListRefresh();
    } catch (e) {
      alert('Comment failed: ' + e.message);
    }
  }

  async function taskDelete(id) {
    if (!confirm('Delete task ' + id + '?')) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'delete failed');
      taskDetailViewId = null;
      taskListRefresh();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  window.taskCreateSubmit = taskCreateSubmit;
  window.taskShowDetail = taskShowDetail;
  window.taskBackToList = taskBackToList;
  window.taskChangeStatus = taskChangeStatus;
  window.taskAddComment = taskAddComment;
  window.taskDelete = taskDelete;

  async function refresh(forceDetailRender = false) {
    try {
      const [statusRes, detailRes, controlRes, subconsciousRes, subconsciousDetailRes, agentDetailRes, agentStatusRes, unreadRes, queueRes, presetsRes] = await Promise.all([
        fetch('/api/supervisor/status'),
        fetch('/api/supervisor/agents/' + encodeURIComponent(agent) + '?limit=180'),
        fetch('/api/supervisor/control'),
        fetch('/api/subconscious/events/' + encodeURIComponent(agent) + '?limit=40'),
        fetch('/api/subconscious/detail/' + encodeURIComponent(agent)),
        fetch('/api/agents/detail/' + encodeURIComponent(agent)),
        fetch('/api/agents/status'),
        fetch('/api/agents/' + encodeURIComponent(agent) + '/unread-messages?limit=40'),
        fetch('/api/queue'),
        fetch('/api/framework-presets'),
      ]);
      const statusPayload = await statusRes.json();
      const detail = await detailRes.json();
      const supervisorControlPayload = await controlRes.json().catch(() => ({}));
      const subconsciousPayload = await subconsciousRes.json().catch(() => ({ ok: false, events: [] }));
      const subconsciousDetailPayload = await subconsciousDetailRes.json().catch(() => ({ ok: false, stage: 'unknown' }));
      const agentDetailPayload = await agentDetailRes.json().catch(() => ({ error: 'agent detail unavailable' }));
      const agentStatusPayload = await agentStatusRes.json().catch(() => []);
      const unreadPayload = await unreadRes.json().catch(() => ({ unread_total: 0, messages: [] }));
      const queuePayload = await queueRes.json().catch(() => []);
      const presetsPayload = await presetsRes.json().catch(() => []);
      _presetCache = Array.isArray(presetsPayload) ? presetsPayload : [];
      if (!statusRes.ok || !detailRes.ok) throw new Error((detail && detail.error) || 'load failed');
      const statusRows = Array.isArray(agentStatusPayload) ? agentStatusPayload : [];
      const statusRow = statusRows.find((row) => row && row.name === agent) || null;
      const model = buildPageModel(
        agentDetailPayload,
        statusRow,
        detail,
        statusPayload,
        supervisorControlPayload,
        subconsciousPayload,
        subconsciousDetailPayload,
        unreadPayload,
        Array.isArray(queuePayload) ? queuePayload : []
      );
      const shouldPreserveDirty = !forceDetailRender && hasUnsavedDetailChanges(agentDetailPayload, supervisorControlPayload, subconsciousDetailPayload);
      latestAgentDetail = agentDetailPayload;
      latestSupervisorDetail = detail;
      latestSupervisorControl = supervisorControlPayload;
      latestSupervisorStatus = statusPayload;
      latestSubconsciousPayload = subconsciousPayload;
      latestSubconsciousDetail = subconsciousDetailPayload;
      latestUnreadPayload = unreadPayload;
      latestQueueItems = Array.isArray(queuePayload) ? queuePayload : [];

      renderHeader(agentDetailPayload, model);
      renderCurrentWork(model);
      renderIntervention(model);
      renderOverview(agentDetailPayload, model);
      renderActivity(model);
      renderAuditHistory(model);
      renderInternals(agentDetailPayload, statusPayload, model);
      if (!shouldPreserveDirty) renderSettings(agentDetailPayload, model);
      else setDetailStatus('Unsaved changes in Agent Detail.', 'warn');
      syncStickyOffsets();
      if (activeTab === 'dm' && dmLoaded) loadDmHistory();
    } catch (e) {
      const healthEl = document.getElementById('health-summary');
      healthEl.textContent = 'Load failed: ' + e.message;
      healthEl.classList.add('health-error');
      document.getElementById('current-work-main').textContent = 'Load failed';
      document.getElementById('current-work-main').style.color = 'rgba(248,113,113,0.85)';
      document.getElementById('current-work-reason').textContent = e.message;
      document.getElementById('intervention-main').textContent = 'Data unavailable';
      document.getElementById('intervention-main').style.color = 'rgba(248,113,113,0.85)';
      document.getElementById('intervention-body').textContent = e.message;
    }
  }

  function requestDangerAction(mode) {
    dangerMode = mode;
    const title = document.getElementById('confirm-title');
    const copy = document.getElementById('confirm-copy');
    const cta = document.getElementById('confirm-cta');
    if (mode === 'down') {
      title.textContent = 'Stop Agent';
      copy.textContent = 'This will stop the agent session and mark it offline. Continue?';
      cta.textContent = 'Stop Agent';
    } else {
      title.textContent = 'Remove Agent';
      copy.textContent = 'This permanently removes the agent entry. This cannot be undone.';
      cta.textContent = 'Remove Agent';
    }
    document.getElementById('confirm-modal').classList.remove('hidden');
  }

  function closeDangerModal() {
    dangerMode = null;
    document.getElementById('confirm-modal').classList.add('hidden');
  }

  async function confirmDangerAction() {
    if (!dangerMode) return;
    const cta = document.getElementById('confirm-cta');
    cta.disabled = true;
    try {
      if (dangerMode === 'down') {
        const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/down', { method: 'POST' });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.ok) throw new Error((payload && (payload.detail || payload.error)) || 'agent down failed');
        setDetailStatus('Agent stopped. Returning to monitor…', 'ok');
      } else {
        const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '?force=true', { method: 'DELETE' });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.ok) throw new Error((payload && (payload.detail || payload.error)) || 'remove failed');
        setDetailStatus('Agent removed. Returning to monitor…', 'ok');
      }
      closeDangerModal();
      setTimeout(() => { window.location.href = '/'; }, 650);
    } catch (e) {
      setDetailStatus('Action failed: ' + e.message, 'error');
    } finally {
      cta.disabled = false;
    }
  }

  window.requestDangerAction = requestDangerAction;
  window.closeDangerModal = closeDangerModal;
  window.confirmDangerAction = confirmDangerAction;
  window.sendDm = sendDm;

  window.addEventListener('hashchange', () => {
    const next = hashToTab(window.location.hash);
    setActiveTab(next, { updateHash: false, focusAudit: window.location.hash === '#audit' });
  });
  window.addEventListener('resize', syncStickyOffsets);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDangerModal();
  });

  // ── SSE for real-time DM sync across tabs/devices ────
  {
    const es = new EventSource('/api/stream');
    es.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Only refresh DM if the message involves this agent
        if (dmLoaded && (msg.to === agent || msg.from === agent) && !msg.group) {
          loadDmHistory();
        }
      } catch {}
    });
  }

  setActiveTab(hashToTab(window.location.hash), {
    updateHash: false,
    focusAudit: window.location.hash === '#audit',
  });
  syncStickyOffsets();
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}

// ── Inline HTML ──────────────────────────────────────────────────────
const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Monitor</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='24' fill='none' stroke='%2300f0ff' stroke-width='3'/><circle cx='32' cy='32' r='6' fill='%2300f0ff'/></svg>"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#060a12;font-family:'SF Mono','Fira Code','Consolas',monospace;overscroll-behavior:none}

/* Layout */
#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
#main-row{display:flex;flex:1;min-height:0;padding:12px;gap:12px}

/* Queue panel (left) — always reserves width */
#queue-panel{
  width:280px;flex-shrink:0;overflow-y:auto;
  display:flex;flex-direction:column;
  border-radius:8px;
  scrollbar-width:thin;scrollbar-color:rgba(168,85,247,0.15) transparent;
}
#queue-panel.has-items{
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(168,85,247,0.2);
  backdrop-filter:blur(12px);
}
.panel-header{
  padding:10px 14px;font-size:10px;letter-spacing:2px;
  color:rgba(168,85,247,0.6);
  border-bottom:1px solid rgba(168,85,247,0.1);
  display:flex;align-items:center;gap:8px;flex-shrink:0;
}
.panel-header .dot{
  width:6px;height:6px;border-radius:50%;background:#a855f7;
  animation:pulse-dot 2s infinite;
}
@keyframes pulse-dot{
  0%,100%{opacity:0.4;box-shadow:none}
  50%{opacity:1;box-shadow:0 0 8px #a855f7}
}
.queue-item{padding:10px 14px;border-bottom:1px solid rgba(168,85,247,0.06);transition:background 0.2s;overflow:hidden;min-width:0}
.queue-item:hover{background:rgba(168,85,247,0.05)}
.queue-item:last-child{border-bottom:none}
.qi-route{font-size:11px;margin-bottom:3px}
.qi-from{color:rgba(0,240,255,0.6)}
.qi-arrow{color:rgba(168,85,247,0.3);margin:0 4px}
.qi-target{color:#a855f7}
.qi-payload{font-size:10px;color:rgba(255,255,255,0.2);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.qi-wait{font-size:10px;color:rgba(168,85,247,0.3);margin-top:3px}
.qi-idle{font-size:10px;margin-top:2px}
.qi-idle-busy{color:rgba(251,191,36,0.5)}
.qi-idle-ready{color:rgba(52,211,153,0.6)}
.qi-idle-warn{color:rgba(248,113,113,0.5)}
.qi-redir{color:rgba(251,191,36,0.5);font-size:9px}
.qi-actions{margin-top:6px;display:flex;gap:6px}
.qi-btn{font-family:inherit;letter-spacing:1px;border-radius:4px;cursor:pointer;border:1px solid;transition:all .2s;background:transparent}
.qi-btn-send{font-size:10px;padding:4px 14px;color:#34d399;border-color:rgba(52,211,153,0.4);font-weight:600}
.qi-btn-send:hover{background:rgba(52,211,153,0.15);border-color:#34d399}
.qi-btn-cancel{font-size:8px;padding:2px 8px;color:rgba(248,113,113,0.45);border-color:rgba(248,113,113,0.15)}
.qi-btn-cancel:hover{background:rgba(248,113,113,0.08);border-color:rgba(248,113,113,0.35);color:#f87171}

/* Reminder panel (right) */
#right-col{
  width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;min-height:0;
}
#reminder-panel{
  overflow-y:auto;
  display:flex;flex-direction:column;
  border-radius:8px;min-height:0;max-height:100%;
  scrollbar-width:thin;scrollbar-color:rgba(251,191,36,0.15) transparent;
}
#reminder-panel.has-items{
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(251,191,36,0.2);
  backdrop-filter:blur(12px);
}
.reminder-header{
  padding:10px 14px;font-size:10px;letter-spacing:2px;
  color:rgba(251,191,36,0.6);
  border-bottom:1px solid rgba(251,191,36,0.1);
  display:flex;align-items:center;gap:8px;flex-shrink:0;
}
.reminder-header .dot{width:6px;height:6px;border-radius:50%;background:#fbbf24;animation:pulse-dot-r 2s infinite}
@keyframes pulse-dot-r{0%,100%{opacity:0.4;box-shadow:none}50%{opacity:1;box-shadow:0 0 8px #fbbf24}}
.reminder-item{padding:10px 14px;border-bottom:1px solid rgba(251,191,36,0.06);transition:background 0.2s;overflow:hidden;min-width:0}
.reminder-item:hover{background:rgba(251,191,36,0.05)}
.reminder-item:last-child{border-bottom:none}
.ri-target{font-size:11px;color:#fbbf24}
.ri-msg{font-size:10px;color:rgba(255,255,255,0.25);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ri-countdown{font-size:12px;color:rgba(251,191,36,0.7);margin-top:4px;font-weight:bold}
.ri-created{font-size:9px;color:rgba(251,191,36,0.25);margin-top:2px}
.ri-actions{margin-top:6px}
.ri-btn-cancel{font-family:inherit;font-size:9px;letter-spacing:1px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid rgba(248,113,113,0.3);color:#f87171;background:transparent;transition:all .2s}
.ri-btn-cancel:hover{background:rgba(248,113,113,0.12);border-color:#f87171}

/* Center monitor panel */
#monitor-panel{
  flex:1;min-width:0;
  display:flex;flex-direction:column;
  background:linear-gradient(170deg,rgba(8,14,22,0.85) 0%,rgba(4,8,14,0.9) 50%,rgba(6,12,18,0.85) 100%);
  border:1px solid rgba(0,240,255,0.15);border-radius:10px;
  overflow:hidden;
  box-shadow:0 0 30px rgba(0,240,255,0.04),0 0 60px rgba(0,240,255,0.02),inset 0 1px 0 rgba(0,240,255,0.06);
}
.monitor-header{
  padding:10px 24px;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:10px;letter-spacing:3px;color:rgba(0,240,255,0.5);
  flex-shrink:0;
  text-shadow:0 0 8px rgba(0,240,255,0.15);
}
#agent-buttons-wrap{
  position:relative;flex-shrink:0;
  border-bottom:1px solid rgba(0,240,255,0.08);
}
#agent-buttons{
  padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px;
  overflow:hidden;transition:max-height .25s ease;
}
#agent-toggle{
  position:absolute;right:10px;bottom:4px;
  background:rgba(10,14,20,0.85);border:1px solid rgba(0,240,255,0.15);border-radius:4px;
  color:rgba(0,240,255,0.5);font-size:10px;padding:1px 8px;cursor:pointer;
  font-family:inherit;z-index:2;transition:all .2s;
}
#agent-toggle:hover{color:#00f0ff;border-color:rgba(0,240,255,0.3)}
.agent-btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 12px;border-radius:6px;cursor:pointer;
  font-family:inherit;font-size:11px;
  border:1px solid rgba(0,240,255,0.15);
  background:rgba(0,240,255,0.04);color:rgba(0,240,255,0.5);
  transition:all .2s;
}
.agent-btn:hover{background:rgba(0,240,255,0.10);border-color:rgba(0,240,255,0.3);color:#00f0ff}
.agent-btn.selected{background:rgba(0,240,255,0.12);border-color:#00f0ff;color:#00f0ff}
.agent-btn.active-agent .dot{color:#34d399}
.agent-btn.inactive-agent .dot{color:rgba(255,255,255,0.15)}
.agent-btn.remote-agent .dot{color:#a78bfa;font-size:9px}
.agent-btn.remote-agent.alive{opacity:1}
.agent-btn.remote-agent:not(.alive){opacity:0.45}
.agent-btn.no-tmux{opacity:0.35;cursor:default}
.agent-group{width:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.agent-group-label{width:100%;font-size:9px;letter-spacing:1.5px;color:rgba(0,240,255,0.25);text-transform:uppercase;padding:2px 0 0 2px;margin-top:4px}
.agent-group-label:first-child{margin-top:0}
.agent-group-label .agent-group-count{font-size:8px;color:rgba(0,240,255,0.15);letter-spacing:0;text-transform:none;margin-left:6px}
.monitor-bar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 24px;margin:5px 0 0 0;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:11px;color:rgba(0,240,255,0.4);flex-shrink:0;
}
.monitor-bar-name{color:#00f0ff;font-size:12px;text-shadow:0 0 6px rgba(0,240,255,0.2)}
.monitor-bar-btns{display:flex;gap:6px}
#btn-scroll-bottom,#btn-pause,#btn-speed,#btn-audit{
  padding:4px 14px;border-radius:5px;font-family:inherit;font-size:10px;
  letter-spacing:1px;cursor:pointer;
  border:1px solid rgba(0,240,255,0.25);
  background:rgba(0,240,255,0.06);color:#00f0ff;
  transition:all .2s;
}
#btn-scroll-bottom:hover,#btn-pause:hover,#btn-speed:hover,#btn-audit:hover{background:rgba(0,240,255,0.15)}
#btn-pause.paused{border-color:rgba(251,191,36,0.4);color:#fbbf24;background:rgba(251,191,36,0.06)}
#btn-speed.turbo{border-color:rgba(52,211,153,0.45);color:#34d399;background:rgba(52,211,153,0.08)}
#terminal-wrap{flex:1;min-height:0;overflow:hidden;position:relative;margin:5px;border-radius:18px / 14px}
#terminal-wrap.hidden{display:none}
/* CRT barrel — heavy elliptical vignette */
#terminal-wrap::before{
  content:'';position:absolute;inset:0;pointer-events:none;z-index:3;
  border-radius:18px / 14px;
  background:
    radial-gradient(ellipse 105% 105% at 50% 50%,transparent 45%,rgba(0,0,0,0.25) 58%,rgba(0,0,0,0.55) 72%,rgba(0,0,0,0.92) 100%);
  box-shadow:
    inset 0 0 120px rgba(0,240,255,0.03),
    inset 0 0 40px rgba(160,192,160,0.05);
}
/* CRT barrel — thick bezel frame */
#terminal-wrap::after{
  content:'';position:absolute;inset:-3px;pointer-events:none;z-index:4;
  border-radius:22px / 18px;
  border:3px solid rgba(0,0,0,0.7);
  box-shadow:
    inset 0 0 30px 12px rgba(0,0,0,0.6),
    inset 0 2px 6px rgba(160,200,160,0.08),
    inset 0 -2px 6px rgba(0,0,0,0.4),
    0 0 12px rgba(0,0,0,0.5);
}
#terminal{
  position:absolute;inset:0;overflow-y:auto;
  background:
    repeating-linear-gradient(0deg,rgba(120,170,120,0.06) 0px,rgba(120,170,120,0.06) 1px,transparent 1px,transparent 2px),
    #030303;
  background-attachment:local;
  padding:12px 22px;
  border:1px solid rgba(0,240,255,0.06);border-radius:18px / 14px;
  font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:12px;line-height:18px;
  color:#a0c8a0;white-space:pre-wrap;word-break:break-all;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.08) transparent;
  text-shadow:0 0 3px rgba(140,200,140,0.5),0 0 10px rgba(140,200,140,0.15),0 0 20px rgba(140,200,140,0.05);
  box-shadow:inset 0 0 120px rgba(0,0,0,0.75);
  animation:crt-flicker 3s infinite;
}
@keyframes crt-flicker{
  0%,100%{opacity:1}
  48%{opacity:1}
  49%{opacity:0.96}
  50%{opacity:1}
  92%{opacity:1}
  93%{opacity:0.94}
  94%{opacity:1}
  97%{opacity:0.97}
  98%{opacity:1}
}
/* Low-power mode when tab is hidden */
body.page-hidden .panel-header .dot,
body.page-hidden .reminder-header .dot,
body.page-hidden #terminal{
  animation:none !important;
}
body.page-hidden #terminal{
  text-shadow:none;
  box-shadow:inset 0 0 60px rgba(0,0,0,0.5);
}
body.page-hidden #queue-panel.has-items,
body.page-hidden #reminder-panel.has-items{
  backdrop-filter:none;
}
@media (prefers-reduced-motion: reduce){
  .panel-header .dot,
  .reminder-header .dot,
  #terminal{
    animation:none !important;
  }
}
#monitor-empty{
  display:flex;align-items:center;justify-content:center;
  flex:1;color:rgba(0,240,255,0.12);font-size:11px;letter-spacing:3px;
  text-shadow:0 0 6px rgba(0,240,255,0.1);
}
#agent-info{
  display:none;padding:10px 14px;
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(0,240,255,0.1);border-radius:8px;
  backdrop-filter:blur(12px);
  font-size:10px;line-height:1.7;color:rgba(0,240,255,0.35);
  flex-shrink:0;overflow:visible;max-height:none;
}
#agent-info.visible{display:block}
#agent-info .ai-identity-row{display:flex;align-items:center;gap:4px}
#agent-info .ai-identity-edit{
  background:none;border:none;color:rgba(0,240,255,0.25);cursor:pointer;font-size:10px;padding:0 2px;
}
#agent-info .ai-identity-edit:hover{color:rgba(0,240,255,0.6)}
#agent-info .ai-identity-input{
  background:rgba(0,0,0,0.4);border:1px solid rgba(0,240,255,0.2);border-radius:3px;
  color:rgba(255,255,255,0.7);font-size:10px;font-style:italic;font-family:inherit;
  padding:2px 6px;width:100%;outline:none;
}
#agent-info .ai-identity-input:focus{border-color:rgba(0,240,255,0.5)}
#agent-info .ai-v1-wrap{
  margin-top:8px;
  border-top:1px solid rgba(0,240,255,0.1);
  padding-top:8px;
}
#agent-info .ai-v1-title{
  color:rgba(0,240,255,0.5);
  font-size:9px;
  letter-spacing:1px;
  margin-bottom:6px;
}
#agent-info .ai-v1-row{
  margin-top:4px;
}
#agent-info .ai-v1-input,
#agent-info .ai-v1-textarea{
  width:100%;
  background:rgba(0,0,0,0.35);
  border:1px solid rgba(0,240,255,0.2);
  border-radius:4px;
  color:rgba(255,255,255,0.75);
  font-family:inherit;
  font-size:10px;
  padding:4px 6px;
  outline:none;
}
#agent-info .ai-v1-input:focus,
#agent-info .ai-v1-textarea:focus{
  border-color:rgba(0,240,255,0.55);
}
#agent-info .ai-v1-textarea{
  resize:vertical;
  min-height:52px;
  line-height:1.35;
}
#agent-info .ai-v1-hint{
  color:rgba(0,240,255,0.22);
  font-size:9px;
  margin-top:4px;
  word-break:break-word;
}
#agent-info .ai-v1-project-list{
  margin-top:4px;
  color:rgba(0,240,255,0.32);
  font-size:9px;
  line-height:1.35;
}
#agent-info .ai-v1-save{
  margin-top:6px;
  background:none;
  border:1px solid rgba(95,210,255,0.35);
  border-radius:4px;
  color:rgba(95,210,255,0.85);
  cursor:pointer;
  font-size:9px;
  padding:2px 8px;
  font-family:inherit;
}
#agent-info .ai-v1-save:hover{
  border-color:rgba(95,210,255,0.8);
  color:#5fd2ff;
}
.ai-action-row{margin-top:8px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}
.ai-action-spacer{flex:1;min-width:20px}
.ai-audit-btn{
  background:none;border:1px solid rgba(95,210,255,0.35);border-radius:3px;
  color:rgba(95,210,255,0.9);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-audit-btn:hover{border-color:rgba(95,210,255,0.75);color:#5fd2ff}
.ai-down-btn{
  background:none;border:1px solid rgba(251,191,36,0.35);border-radius:3px;
  color:rgba(251,191,36,0.8);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-down-btn:hover{border-color:rgba(251,191,36,0.65);color:#fbbf24}
.ai-down-btn.confirm{
  background:rgba(251,191,36,0.15);border-color:rgba(251,191,36,0.9);color:#fbbf24;
}
.ai-down-btn.downing{
  opacity:0.5;pointer-events:none;
}
.ai-delete-btn{
  background:none;border:1px solid rgba(255,80,80,0.25);border-radius:3px;
  color:rgba(255,80,80,0.5);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-delete-btn:hover{border-color:rgba(255,80,80,0.5);color:rgba(255,80,80,0.8)}
.ai-delete-btn.confirm{
  background:rgba(255,40,40,0.15);border-color:rgba(255,60,60,0.7);color:#ff4444;
}
.ai-delete-btn.deleting{
  opacity:0.5;pointer-events:none;
}
#delete-toast{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);
  background:rgba(255,60,60,0.15);border:1px solid rgba(255,80,80,0.5);
  border-radius:8px;padding:12px 28px;color:#ff6666;font-size:13px;letter-spacing:2px;
  backdrop-filter:blur(12px);opacity:0;pointer-events:none;
  transition:opacity 0.2s, transform 0.2s;z-index:9999;
}
#delete-toast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.root-modal{
  position:fixed;inset:0;z-index:40;
  display:flex;align-items:center;justify-content:center;
  background:rgba(3,7,11,0.68);padding:18px;
}
.root-modal.hidden{display:none}
.root-modal-card{
  width:min(420px,100%);
  border-radius:16px;
  border:1px solid rgba(243,107,125,0.24);
  background:#0d1723;
  box-shadow:0 24px 54px rgba(0,0,0,0.35);
  padding:18px;
}
.root-modal-title{font-size:16px;color:rgba(255,255,255,0.9);font-family:inherit}
.root-modal-copy{margin-top:10px;font-size:12px;line-height:1.6;color:rgba(255,255,255,0.4)}
.root-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.root-modal-btn{
  font-family:inherit;font-size:10px;letter-spacing:1px;padding:4px 14px;
  border-radius:4px;cursor:pointer;border:1px solid;background:transparent;transition:all .2s;
}
.root-modal-btn.cancel{color:rgba(255,255,255,0.4);border-color:rgba(255,255,255,0.15)}
.root-modal-btn.cancel:hover{color:rgba(255,255,255,0.6);border-color:rgba(255,255,255,0.3)}
.root-modal-btn.danger{color:#f87171;border-color:rgba(248,113,113,0.35)}
.root-modal-btn.danger:hover{background:rgba(248,113,113,0.1);border-color:#f87171}
.root-modal-btn.warn{color:#fbbf24;border-color:rgba(251,191,36,0.35)}
.root-modal-btn.warn:hover{background:rgba(251,191,36,0.1);border-color:#fbbf24}
.root-modal-btn:disabled{opacity:0.45;pointer-events:none}
#agent-info .ai-label{color:rgba(0,240,255,0.2);margin-right:4px}
#agent-info .ai-val{color:rgba(0,240,255,0.6)}
#agent-info .ai-identity{color:rgba(255,255,255,0.35);font-style:italic}
#agent-info .ai-tag{
  display:inline-block;padding:1px 8px;border-radius:3px;margin-right:4px;
  font-size:9px;letter-spacing:1px;
}
#agent-info .ai-tag-claude{background:rgba(168,85,247,0.15);color:#a855f7;border:1px solid rgba(168,85,247,0.25)}
#agent-info .ai-tag-codex{background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.25)}
#agent-info .ai-tag-active{background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2)}
#agent-info .ai-tag-inactive{background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.08)}
#agent-info .ai-tag-focused{background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2)}
#agent-info .ai-tag-alert{background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.28)}
#agent-info .ai-tag-neutral{background:rgba(95,210,255,0.08);color:rgba(95,210,255,0.8);border:1px solid rgba(95,210,255,0.22)}
#agent-info .ai-groups{color:rgba(168,85,247,0.5)}
#agent-info .ai-summary-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:6px;
  margin-top:8px;
}
#agent-info .ai-summary-item{
  border:1px solid rgba(0,240,255,0.12);
  background:rgba(0,0,0,0.22);
  border-radius:4px;
  padding:6px;
}
#agent-info .ai-summary-k{
  color:rgba(0,240,255,0.24);
  font-size:8px;
  letter-spacing:1px;
}
#agent-info .ai-summary-v{
  color:rgba(255,255,255,0.72);
  font-size:11px;
  margin-top:2px;
}
#agent-info .ai-warning{
  margin-top:8px;
  border:1px solid rgba(248,113,113,0.18);
  background:rgba(248,113,113,0.08);
  border-radius:4px;
  padding:6px;
}
#agent-info .ai-warning-title{
  color:#f87171;
  font-size:9px;
  letter-spacing:1px;
}
#agent-info .ai-warning-body{
  color:rgba(255,255,255,0.68);
  font-size:10px;
  line-height:1.4;
  margin-top:4px;
}
#agent-info .ai-summary-note{
  margin-top:8px;
  color:rgba(0,240,255,0.22);
  font-size:9px;
  line-height:1.4;
}
#agent-info .ai-unread-wrap{margin-top:8px;border-top:1px solid rgba(0,240,255,0.1);padding-top:8px}
#agent-info .ai-unread-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
#agent-info .ai-unread-title{color:rgba(0,240,255,0.5);font-size:9px;letter-spacing:1px}
#agent-info .ai-unread-meta{color:rgba(0,240,255,0.25);font-size:9px}
#agent-info .ai-unread-list{display:flex;flex-direction:column;gap:6px}
#agent-info .ai-unread-item{border:1px solid rgba(0,240,255,0.12);background:rgba(0,0,0,0.25);border-radius:4px;padding:6px}
#agent-info .ai-unread-route{color:rgba(0,240,255,0.45);font-size:9px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#agent-info .ai-unread-summary{color:rgba(255,255,255,0.58);font-size:10px;line-height:1.35;word-break:break-word}
#agent-info .ai-unread-sub{color:rgba(0,240,255,0.28);font-size:9px;margin-top:4px}
#agent-info .ai-unread-actions{margin-top:5px;text-align:right}
#agent-info .ai-unread-cancel{
  background:none;border:1px solid rgba(248,113,113,0.35);border-radius:3px;
  color:#f87171;cursor:pointer;font-size:9px;padding:1px 8px;font-family:inherit;
}
#agent-info .ai-unread-cancel:hover{background:rgba(248,113,113,0.1);border-color:#f87171}
#agent-info .ai-unread-empty{color:rgba(0,240,255,0.2);font-size:9px}

/* Message log (bottom) */
#msglog{
  flex-shrink:0;height:140px;overflow-y:auto;
  background:rgba(6,10,18,0.95);
  border-top:1px solid rgba(0,240,255,0.08);
  padding:8px 16px;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.15) transparent;
}
.log-entry{font-size:11px;line-height:1.5;color:rgba(0,240,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-entry .ts{color:rgba(0,240,255,0.25)}
.log-entry .from{color:#00f0ff}
.log-entry .to{color:#a855f7}
.log-entry .arrow{color:rgba(0,240,255,0.3)}
.log-entry .payload{color:rgba(255,255,255,0.3);overflow:hidden;text-overflow:ellipsis;max-width:100%}

/* Mobile FABs (hidden on desktop) */
.mobile-fab{display:none}

/* ── Mobile ──────────────────────────────────────── */
@media (max-width:768px){
  /* FAB dots */
  .mobile-fab{
    display:flex;align-items:center;justify-content:center;
    position:fixed;z-index:100;width:36px;height:36px;border-radius:50%;
    cursor:pointer;-webkit-tap-highlight-color:transparent;
    border:1px solid rgba(0,240,255,0.2);
    backdrop-filter:blur(8px);
  }
  .mobile-fab-dot{width:8px;height:8px;border-radius:50%}
  #mobile-fab-queue{
    top:10px;left:10px;background:rgba(168,85,247,0.15);
  }
  #mobile-fab-queue .mobile-fab-dot{background:#a855f7;box-shadow:0 0 6px #a855f7}
  #mobile-fab-queue.has-count{border-color:rgba(168,85,247,0.5)}
  #mobile-fab-reminder{
    top:10px;right:10px;background:rgba(251,191,36,0.15);
  }
  #mobile-fab-reminder .mobile-fab-dot{background:#fbbf24;box-shadow:0 0 6px #fbbf24}
  #mobile-fab-reminder.has-count{border-color:rgba(251,191,36,0.5)}

  /* Hide side panels and log by default */
  #queue-panel,#right-col,#msglog{display:none!important}

  /* Mobile overlay panel */
  #queue-panel.mobile-open,#right-col.mobile-open{
    display:flex!important;flex-direction:column;
    position:fixed;top:52px;bottom:0;width:85vw;max-width:320px;
    z-index:90;background:rgba(6,10,18,0.96);
    backdrop-filter:blur(16px);
    border:1px solid rgba(0,240,255,0.12);border-radius:0 12px 12px 0;
    overflow-y:auto;
  }
  #queue-panel.mobile-open{left:0;border-radius:0 12px 12px 0}
  #right-col.mobile-open{right:0;left:auto;border-radius:12px 0 0 12px}
  #right-col.mobile-open #reminder-panel{flex:none;overflow-y:visible}
  #right-col.mobile-open #agent-info{flex:none;overflow-y:visible}
  #right-col.mobile-open #agent-info.visible{display:block}

  /* Mobile overlay backdrop */
  .mobile-backdrop{
    display:none;position:fixed;inset:0;z-index:80;
    background:rgba(0,0,0,0.5);-webkit-tap-highlight-color:transparent;
  }
  .mobile-backdrop.active{display:block}

  /* Main row: full width, no side padding */
  #main-row{padding:6px;gap:0}
  #monitor-panel{border-radius:10px}
  .monitor-header{padding:8px 14px;font-size:9px}
  #agent-buttons{padding:8px 10px;gap:5px}
  .agent-btn{padding:4px 8px;font-size:10px;gap:4px}
  .monitor-bar{padding:6px 12px;margin:3px 0 0}
  .monitor-bar-name{font-size:11px}
  #btn-scroll-bottom,#btn-pause,#btn-speed,#btn-audit{padding:3px 10px;font-size:9px}
  #terminal{padding:8px 12px;font-size:11px}
  #terminal-wrap{margin:3px;border-radius:14px / 11px}
  #terminal-wrap::before{border-radius:14px / 11px}
  #terminal-wrap::after{border-radius:16px / 13px}
  #terminal{border-radius:14px / 11px}
}
</style>
</head>
<body>
<div id="app">
  <div id="mobile-fab-queue" class="mobile-fab" onclick="toggleMobilePanel('queue')"><span class="mobile-fab-dot"></span></div>
  <div id="mobile-fab-reminder" class="mobile-fab" onclick="toggleMobilePanel('reminder')"><span class="mobile-fab-dot"></span></div>
  <div id="mobile-backdrop" class="mobile-backdrop" onclick="closeMobilePanels()"></div>
  <div id="main-row">
    <div id="queue-panel">
      <div class="panel-header"><span class="dot"></span>PENDING QUEUE</div>
      <div id="queue-list"></div>
    </div>
    <div id="monitor-panel">
      <div class="monitor-header" style="display:flex;align-items:center;gap:12px">AGENT MONITOR<a href="/alerts" id="alert-badge" style="font-size:10px;color:rgba(255,107,107,0.7);text-decoration:none;display:none"></a><a href="/config" style="font-size:10px;color:rgba(0,240,255,0.4);text-decoration:none;letter-spacing:1px">CONFIG</a></div>
      <div id="agent-buttons-wrap">
        <div id="agent-buttons"><span style="color:rgba(0,240,255,0.2);font-size:10px">loading agents...</span></div>
        <button id="agent-toggle" title="Show all agents">▼ more</button>
      </div>
      <div class="monitor-bar">
        <span class="monitor-bar-name" id="monitor-label">Select an agent to monitor</span>
        <span class="monitor-bar-btns">
          <button id="btn-scroll-bottom" style="display:none">&#8615; BOTTOM</button>
          <button id="btn-speed" style="display:none">10HZ</button>
          <button id="btn-audit" style="display:none" onclick="openAuditPage()">DETAIL</button>
          <button id="btn-pause" style="display:none">&#9646;&#9646; PAUSE</button>
        </span>
      </div>
      <div id="monitor-empty">NO AGENT SELECTED</div>
      <div id="terminal-wrap" class="hidden"><div id="terminal"></div></div>
    </div>
    <div id="right-col">
      <div id="reminder-panel">
        <div class="reminder-header"><span class="dot"></span>REMINDERS</div>
        <div id="reminder-list"></div>
      </div>
      <div id="agent-info"></div>
    </div>
  </div>
  <div id="msglog"></div>
  <div id="delete-toast"></div>
  <div id="root-confirm-modal" class="root-modal hidden">
    <div class="root-modal-card">
      <div class="root-modal-title" id="root-confirm-title">Confirm action</div>
      <div class="root-modal-copy" id="root-confirm-copy"></div>
      <div class="root-modal-actions">
        <button class="root-modal-btn cancel" onclick="closeRootModal()">Cancel</button>
        <button class="root-modal-btn" id="root-confirm-cta" onclick="confirmRootAction()">Confirm</button>
      </div>
    </div>
  </div>
</div>

<script>
(() => {
  const IDLE_THRESHOLD_MS = ${IDLE_THRESHOLD};
  const IDLE_THRESHOLD_SEC = ${IDLE_THRESHOLD_SEC};
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function toNonNegInt(v, fallback = 0) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function fmtSpanSec(sec) {
    const s = Math.max(0, toNonNegInt(sec, 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function runtimeStatusText(activeNow, activeDurationSec, idleDurationSec) {
    if (activeNow) return 'ACTIVE ' + fmtSpanSec(activeDurationSec);
    return 'IDLE ' + fmtSpanSec(idleDurationSec);
  }

  // ── Message log ─────────────────────────────
  const msglogEl = document.getElementById('msglog');
  function addLogEntry(msg) {
    if (document.hidden) return;
    const ts = new Date(msg.ts).toLocaleTimeString();
    const payload = (msg.payload || '').slice(0, 120);
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML =
      '<span class="ts">' + ts + '</span> '
      + '<span class="from">' + esc(msg.from) + '</span> '
      + '<span class="arrow">&#10145;</span> '
      + '<span class="to">' + esc(msg.to) + '</span> '
      + '<span class="payload">' + esc(payload) + '</span>';
    msglogEl.appendChild(div);
    while (msglogEl.children.length > 200) msglogEl.removeChild(msglogEl.firstChild);
    msglogEl.scrollTop = msglogEl.scrollHeight;
  }

  // ── Queue panel ─────────────────────────────
  const queuePanel = document.getElementById('queue-panel');
  const queueList = document.getElementById('queue-list');
  let queueItems = [];

  let queueActionPending = false;
  let queueRenderLocked = false;
  let queueRenderPending = false;
  let lastQueueHtml = '';
  function computeQueueWaitStr(queuedAt) {
    const wait = Math.floor((Date.now() - queuedAt) / 1000);
    return wait < 60 ? wait + 's' : Math.floor(wait / 60) + 'm ' + (wait % 60) + 's';
  }

  function updateQueueTimersInPlace() {
    const byId = new Map(queueItems.map(item => [String(item.id), item]));
    for (const row of queueList.querySelectorAll('.queue-item[data-id]')) {
      const id = row.getAttribute('data-id');
      const item = byId.get(String(id));
      if (!item) continue;
      const waitEl = row.querySelector('.qi-wait');
      if (waitEl) waitEl.textContent = 'waiting ' + computeQueueWaitStr(item.queuedAt);
    }
  }

  function renderQueuePanel() {
    if (document.hidden) return;
    if (queueActionPending) return;
    if (queueItems.length === 0) { queuePanel.classList.remove('has-items'); queueList.innerHTML = ''; lastQueueHtml = ''; return; }
    queuePanel.classList.add('has-items');
    const html = queueItems.map(item => {
      const waitStr = computeQueueWaitStr(item.queuedAt);
      const payload = (item.payload || '').slice(0, 80);
      const idleMs = item.targetIdleMs || 0;
      let idleStr, idleClass;
      if (idleMs < 0) { idleStr = 'pane not found'; idleClass = 'qi-idle-warn'; }
      else if (idleMs >= IDLE_THRESHOLD_MS) {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'idle ' + (s < 60 ? s + 's' : Math.floor(s/60) + 'm' + (s%60) + 's') + ' (delivering soon)';
        idleClass = 'qi-idle-ready';
      } else {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'target active (idle ' + s + 's / ' + IDLE_THRESHOLD_SEC + 's)';
        idleClass = 'qi-idle-busy';
      }
      const redir = item.redirectedFrom ? ' <span class="qi-redir">(was ' + esc(item.redirectedFrom) + ')</span>' : '';
      return '<div class="queue-item" data-id="' + item.id + '">'
        + '<div class="qi-route"><span class="qi-from">' + esc(item.from) + '</span>'
        + '<span class="qi-arrow"> &#10145; </span>'
        + '<span class="qi-target">' + esc(item.to) + '</span>' + redir + '</div>'
        + '<div class="qi-payload">' + esc(payload) + '</div>'
        + '<div class="qi-wait">waiting ' + waitStr + '</div>'
        + '<div class="qi-idle ' + idleClass + '">' + idleStr + '</div>'
        + '<div class="qi-actions">'
        + '<button class="qi-btn qi-btn-send" onclick="queueAction(' + item.id + ',\\'send\\')">SEND NOW</button>'
        + '<button class="qi-btn qi-btn-cancel" onclick="queueAction(' + item.id + ',\\'cancel\\')">CANCEL</button>'
        + '</div></div>';
    }).join('');
    if (html !== lastQueueHtml) { queueList.innerHTML = html; lastQueueHtml = html; }
  }
  function requestQueueRender(force = false) {
    if (queueRenderLocked && !force) {
      queueRenderPending = true;
      updateQueueTimersInPlace();
      return;
    }
    queueRenderPending = false;
    renderQueuePanel();
  }
  setInterval(() => requestQueueRender(false), 2000);

  queuePanel.addEventListener('mouseenter', () => {
    queueRenderLocked = true;
  });
  queuePanel.addEventListener('mouseleave', () => {
    queueRenderLocked = false;
    if (queueRenderPending) requestQueueRender(true);
  });

  window.queueAction = async function(id, action) {
    // Optimistic: remove immediately, restore on failure
    const removed = queueItems.find(i => i.id === id);
    queueItems = queueItems.filter(i => i.id !== id);
    queueActionPending = false;
    requestQueueRender(true);
    try {
      let res;
      if (action === 'send') {
        res = await fetch('/api/queue/' + id + '/send', { method: 'POST' });
      } else {
        const sourceMsgId = (removed && removed.notifyMeta && typeof removed.notifyMeta.sourceMsgId === 'string')
          ? removed.notifyMeta.sourceMsgId.trim()
          : '';
        const targetAgent = (removed && typeof removed.to === 'string')
          ? String(removed.to).split(':', 1)[0]
          : '';
        const isBackendNotification = removed && removed.from === 'agent-chat-v2';
        if (isBackendNotification && sourceMsgId && targetAgent) {
          res = await fetch('/api/agents/' + encodeURIComponent(targetAgent) + '/unread-messages/' + encodeURIComponent(sourceMsgId) + '/cancel', {
            method: 'POST'
          });
        } else {
          res = await fetch('/api/queue/' + id, { method: 'DELETE' });
        }
      }
      let body = null;
      try { body = await res.json(); } catch (e) {
        console.debug('[agent-detail] queue action response parse skipped:', e.message);
      }
      if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.reason) || ('HTTP ' + res.status));
      }
      if (action !== 'send' && monitoredAgent && removed && typeof removed.to === 'string') {
        const targetAgent = String(removed.to).split(':', 1)[0];
        if (targetAgent === monitoredAgent.name) fetchAgentDetail(monitoredAgent.name);
      }
    } catch (e) {
      console.debug('[agent-detail] queue action failed, restoring removed entry:', e.message);
      if (removed) { queueItems.push(removed); requestQueueRender(true); }
    }
  };

  // ── Reminder panel ─────────────────────────
  const reminderPanel = document.getElementById('reminder-panel');
  const reminderList = document.getElementById('reminder-list');
  let reminderItems = [];

  function fmtCountdown(ms) {
    if (ms <= 0) return 'firing...';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  let reminderActionPending = false;
  let lastReminderHtml = '';
  function renderReminderPanel() {
    if (document.hidden) return;
    if (reminderActionPending) return;
    if (reminderItems.length === 0) { reminderPanel.classList.remove('has-items'); reminderList.innerHTML = ''; lastReminderHtml = ''; return; }
    reminderPanel.classList.add('has-items');
    const html = reminderItems.map(item => {
      const remaining = item.remainingMs || 0;
      const created = new Date(item.createdAt).toLocaleTimeString();
      const msg = (item.msg || '').slice(0, 80);
      return '<div class="reminder-item">'
        + '<div class="ri-target">' + esc(item.target) + '</div>'
        + '<div class="ri-msg">' + esc(msg) + '</div>'
        + '<div class="ri-countdown">&#9200; ' + fmtCountdown(remaining) + '</div>'
        + '<div class="ri-created">set at ' + created + '</div>'
        + '<div class="ri-actions">'
        + '<button class="ri-btn-cancel" onclick="cancelReminder(' + item.id + ')">CANCEL</button>'
        + '</div></div>';
    }).join('');
    if (html !== lastReminderHtml) { reminderList.innerHTML = html; lastReminderHtml = html; }
  }
  setInterval(renderReminderPanel, 2000);

  window.cancelReminder = async function(id) {
    // Optimistic: remove immediately, restore on failure
    const removed = reminderItems.find(i => i.id === id);
    reminderItems = reminderItems.filter(i => i.id !== id);
    reminderActionPending = false;
    renderReminderPanel();
    try {
      await fetch('/api/reminders/' + id, { method: 'DELETE' });
    } catch {
      if (removed) { reminderItems.push(removed); renderReminderPanel(); }
    }
  };

  // ── Agent Monitor ───────────────────────────
  const agentButtonsEl = document.getElementById('agent-buttons');
  const agentToggleEl  = document.getElementById('agent-toggle');
  const monitorLabelEl = document.getElementById('monitor-label');
  const monitorEmptyEl = document.getElementById('monitor-empty');
  const terminalWrapEl = document.getElementById('terminal-wrap');
  const terminalEl     = document.getElementById('terminal');
  const btnPause       = document.getElementById('btn-pause');
  const btnSpeed       = document.getElementById('btn-speed');
  const btnAudit       = document.getElementById('btn-audit');
  const btnScrollBottom = document.getElementById('btn-scroll-bottom');
  const agentInfoEl    = document.getElementById('agent-info');

  // Agent list collapse/expand
  let agentListExpanded = false;
  function calcTwoRowHeight() {
    const btns = agentButtonsEl.querySelectorAll('.agent-btn');
    if (btns.length === 0) return 86;
    // Find distinct row tops
    const tops = new Set();
    for (const b of btns) tops.add(Math.round(b.offsetTop));
    const sorted = [...tops].sort((a, b) => a - b);
    if (sorted.length <= 2) return agentButtonsEl.scrollHeight; // fits in 2 rows
    // Height = bottom of 2nd row buttons + padding
    const secondRowTop = sorted[1];
    let maxBottom = 0;
    for (const b of btns) {
      if (Math.round(b.offsetTop) === secondRowTop) {
        maxBottom = Math.max(maxBottom, b.offsetTop + b.offsetHeight);
      }
    }
    const style = getComputedStyle(agentButtonsEl);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    return maxBottom + padBottom + 2; // +2 for rounding
  }
  function updateAgentToggle() {
    if (!agentToggleEl) return;
    const twoRowH = calcTwoRowHeight();
    if (agentButtonsEl.scrollHeight <= twoRowH + 4) {
      agentToggleEl.style.display = 'none';
      agentButtonsEl.style.maxHeight = '';
    } else {
      agentToggleEl.style.display = '';
      if (!agentListExpanded) agentButtonsEl.style.maxHeight = twoRowH + 'px';
      else agentButtonsEl.style.maxHeight = agentButtonsEl.scrollHeight + 'px';
    }
    agentToggleEl.textContent = agentListExpanded ? '▲ less' : '▼ more';
  }
  if (agentToggleEl) {
    agentToggleEl.addEventListener('click', () => {
      agentListExpanded = !agentListExpanded;
      agentButtonsEl.classList.toggle('expanded', agentListExpanded);
      updateAgentToggle();
    });
  }

  btnScrollBottom.addEventListener('click', () => {
    terminalEl.scrollTop = terminalEl.scrollHeight;
  });

  let monitoredAgent = null;
  let monitorPaused  = false;
  let terminalTurboMode = true; // keep per-agent monitor at 10Hz when visible, unless toggled to ECO.
  let agentStatusList = [];
  const STATUS_SYNC_INTERVAL_MS = 30000;
  const STATUS_SYNC_INTERVAL_HIDDEN_MS = 120000;
  const TERMINAL_POLL_TURBO_MS = 100;
  const TERMINAL_POLL_VISIBLE_MS = 400;
  const TERMINAL_POLL_HIDDEN_MS = 3000;
  const DURATION_TICK_VISIBLE_MS = 1000;
  const DURATION_TICK_HIDDEN_MS = 4000;
  const DETAIL_REFRESH_VISIBLE_MS = 2500;
  const DETAIL_REFRESH_HIDDEN_MS = 10000;
  const UNREAD_PANEL_LIMIT = 1;
  let lastStatusSyncAt = 0;
  let statusSyncTimer = null;
  let terminalPollTimer = null;
  let durationTickTimer = null;
  let statusPollTimer = null;
  let detailRefreshTimer = null;
  let agentDetailRequestSeq = 0;
  let agentDetailAbortController = null;

  function updateSelectedRuntimeBadge() {
    if (!monitoredAgent) return;
    const snap = agentStatusList.find(x => x.name === monitoredAgent.name);
    if (!snap) return;
    const stateEl = document.getElementById('ai-runtime-state');
    if (stateEl) {
      const activeNow = !!snap.activeNow;
      const a = toNonNegInt(snap.activeDurationSec, 0);
      const i = toNonNegInt(snap.idleDurationSec, 0);
      stateEl.textContent = runtimeStatusText(activeNow, a, i);
      stateEl.classList.toggle('ai-tag-active', activeNow);
      stateEl.classList.toggle('ai-tag-inactive', !activeNow);
    }
  }

  function scheduleStatusSyncSoon(reason = '') {
    const now = Date.now();
    if (now - lastStatusSyncAt < 3000) return;
    if (statusSyncTimer) return;
    statusSyncTimer = setTimeout(() => {
      statusSyncTimer = null;
      fetchAgentStatus(reason || 'switch').catch(() => {});
    }, 400);
  }

  function updateSpeedButton() {
    if (!btnSpeed) return;
    if (terminalTurboMode) {
      btnSpeed.textContent = '10HZ';
      btnSpeed.classList.add('turbo');
    } else {
      btnSpeed.textContent = 'ECO';
      btnSpeed.classList.remove('turbo');
    }
  }

  function showAgentDetailLoading(name) {
    if (!agentInfoEl) return;
    const safeName = esc(String(name || ''));
    agentInfoEl.innerHTML = '<span class="ai-label">agent</span><span class="ai-val">' + safeName + '</span><br>'
      + '<span class="ai-unread-empty">Loading summary...</span>';
    agentInfoEl.classList.add('visible');
  }

  function showAgentDetailError(name, message) {
    if (!agentInfoEl) return;
    const safeName = esc(String(name || ''));
    const safeMessage = esc(String(message || 'Summary unavailable.'));
    agentInfoEl.innerHTML = '<span class="ai-label">agent</span><span class="ai-val">' + safeName + '</span><br>'
      + '<span class="ai-unread-empty">' + safeMessage + '</span>';
    agentInfoEl.classList.add('visible');
  }

  function hasCurrentSupervisorIssue(state) {
    const classification = String(state?.classification || '').trim().toLowerCase();
    if (classification === 'stalled_wait' || classification === 'suspected_eos') return true;
    const lifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    return lifecycleState === 'active' && classification.length > 0;
  }

  function scheduleDetailRefresh() {
    if (detailRefreshTimer) clearInterval(detailRefreshTimer);
    const interval = document.hidden ? DETAIL_REFRESH_HIDDEN_MS : DETAIL_REFRESH_VISIBLE_MS;
    detailRefreshTimer = setInterval(() => {
      if (!monitoredAgent) return;
      fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });
    }, interval);
  }

  btnPause.addEventListener('click', () => {
    monitorPaused = !monitorPaused;
    if (monitorPaused) {
      btnPause.innerHTML = '&#9654; RESUME';
      btnPause.classList.add('paused');
    } else {
      btnPause.innerHTML = '&#9646;&#9646; PAUSE';
      btnPause.classList.remove('paused');
      if (monitoredAgent) fetchTerminal();
    }
  });

  if (btnSpeed) {
    btnSpeed.addEventListener('click', () => {
      terminalTurboMode = !terminalTurboMode;
      updateSpeedButton();
      scheduleTerminalPoll();
      if (monitoredAgent && !monitorPaused && !document.hidden) {
        fetchTerminal();
      }
    });
  }

  function selectAgent(agent) {
    monitoredAgent = agent;
    monitorPaused = false;
    terminalEtag = null;
    btnPause.innerHTML = '&#9646;&#9646; PAUSE';
    btnPause.classList.remove('paused');
    btnPause.style.display = '';
    if (btnSpeed) {
      btnSpeed.style.display = '';
      updateSpeedButton();
    }
    if (btnAudit) btnAudit.style.display = '';
    btnScrollBottom.style.display = '';
    monitorLabelEl.textContent = 'Monitoring: ' + agent.name;
    monitorEmptyEl.style.display = 'none';
    terminalWrapEl.classList.remove('hidden');
    terminalEl.textContent = '';
    for (const btn of agentButtonsEl.querySelectorAll('.agent-btn')) {
      btn.classList.toggle('selected', btn.dataset.name === agent.name);
    }
    showAgentDetailLoading(agent.name);
    fetchAgentDetail(agent.name, { preserveVisible: true });
    fetchTerminal().then(() => {
      requestAnimationFrame(() => {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      });
    });
  }

  async function fetchAgentDetail(name, options = {}) {
    const targetName = String(name || '').trim();
    if (!targetName) return;

    const requestSeq = ++agentDetailRequestSeq;
    if (agentDetailAbortController) {
      try { agentDetailAbortController.abort(); } catch (e) {
        console.debug('[agent-detail] previous request abort skipped:', e.message);
      }
    }
    const controller = new AbortController();
    agentDetailAbortController = controller;

    if (!options.preserveVisible) {
      agentInfoEl.classList.remove('visible');
    }

    try {
      const [detailRespRaw, supervisorRespRaw, supervisorStatusRaw] = await Promise.allSettled([
        fetch('/api/agents/detail/' + encodeURIComponent(targetName), { signal: controller.signal }),
        fetch('/api/supervisor/agents/' + encodeURIComponent(targetName) + '?limit=1', { signal: controller.signal }),
        fetch('/api/supervisor/status', { signal: controller.signal }),
      ]);

      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      if (detailRespRaw.status !== 'fulfilled') return;
      const res = detailRespRaw.value;
      if (!res.ok) return;
      const d = await res.json();
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      let supervisorData = { latest: null, state: {} };
      let supervisorStatus = { enabled: null, runtime: { running: null } };
      try {
        if (supervisorRespRaw.status === 'fulfilled' && supervisorRespRaw.value.ok) {
          const payload = await supervisorRespRaw.value.json();
          if (payload && typeof payload === 'object') supervisorData = payload;
        }
      } catch (e) {
        console.debug('[agent-detail] supervisor detail fetch skipped:', e.message);
      }
      try {
        if (supervisorStatusRaw.status === 'fulfilled' && supervisorStatusRaw.value.ok) {
          const payload = await supervisorStatusRaw.value.json();
          if (payload && typeof payload === 'object') supervisorStatus = payload;
        }
      } catch (e) {
        console.debug('[agent-detail] supervisor status fetch skipped:', e.message);
      }
      const statusSnap = agentStatusList.find(x => x.name === targetName) || {};
      const activeNow = typeof statusSnap.activeNow === 'boolean'
        ? statusSnap.activeNow
        : (typeof d.active === 'boolean' ? d.active : false);
      const activeDurationSec = toNonNegInt(
        statusSnap.activeDurationSec !== undefined ? statusSnap.activeDurationSec : d.activeDurationSec,
        0
      );
      const idleDurationSec = toNonNegInt(
        statusSnap.idleDurationSec !== undefined ? statusSnap.idleDurationSec : d.idleDurationSec,
        0
      );
      const latestEval = supervisorData.latest && typeof supervisorData.latest === 'object'
        ? supervisorData.latest
        : null;
      const latestStatus = String(latestEval?.status || '').trim();
      const parts = [];
      if (d.agentType) {
        const cls = d.agentType === 'claude' ? 'ai-tag-claude' : 'ai-tag-codex';
        parts.push('<span class="ai-tag ' + cls + '">' + esc(d.agentType.toUpperCase()) + '</span>');
      }
      parts.push('<span class="ai-tag ' + (activeNow ? 'ai-tag-active' : 'ai-tag-inactive') + '" id="ai-runtime-state">'
        + esc(runtimeStatusText(activeNow, activeDurationSec, idleDurationSec)) + '</span>');
      const currentSupervisorIssue = hasCurrentSupervisorIssue(supervisorData.state || {});
      const showCurrentSupervisorWarning = latestStatus && currentSupervisorIssue;
      if (latestStatus && showCurrentSupervisorWarning) {
        const auditCls = latestStatus === 'FOCUSED'
          ? 'ai-tag-focused'
          : ((latestStatus === 'DRIFTING' || latestStatus === 'LOST' || latestStatus === 'STUCK') ? 'ai-tag-alert' : 'ai-tag-neutral');
        parts.push('<span class="ai-tag ' + auditCls + '">' + esc(latestStatus) + '</span>');
      }
      if (d.v1) parts.push('<span class="ai-tag ai-tag-neutral">V1 HOME</span>');
      parts.push('<span class="ai-tag ' + (d.subconsciousEnabled ? 'ai-tag-focused' : 'ai-tag-inactive') + '">'
        + esc(d.subconsciousEnabled ? 'SUBCONSCIOUS ON' : 'SUBCONSCIOUS OFF') + '</span>');
      parts.push('<br>');
      parts.push('<div class="ai-identity">' + esc(d.identity || '(no identity)') + '</div>');
      const supervisorEnabled = supervisorStatus?.enabled === true;
      const supervisorRunning = supervisorStatus?.runtime?.running === true;
      if (latestEval && latestStatus && latestStatus !== 'FOCUSED' && (showCurrentSupervisorWarning || ((supervisorEnabled || supervisorRunning) && currentSupervisorIssue))) {
        const reasonText = String(latestEval.reason || '').trim() || 'Supervisor raised a non-focused state.';
        const domainText = String(latestEval.domain || '').trim();
        const patternText = String(latestEval.pattern || '').trim();
        parts.push('<div class="ai-warning">'
          + '<div class="ai-warning-title">Supervisor Warning</div>'
          + '<div class="ai-warning-body">' + esc(reasonText)
          + ((domainText || patternText) ? ('<br>' + esc([domainText, patternText].filter(Boolean).join(' · '))) : '')
          + '</div></div>');
      } else {
      }
      parts.push('<div class="ai-action-row">'
        + '<button class="ai-audit-btn" onclick="openAuditPage()">Open Agent Detail</button>'
        + '<div class="ai-action-spacer"></div>'
        + '<button class="ai-down-btn" id="ai-down-btn" onclick="downAgent()">Stop Agent</button>'
        + '<div style="width:12px"></div>'
        + '<button class="ai-delete-btn" id="ai-delete-btn" onclick="deleteAgent()">Remove Agent</button>'
        + '</div>');
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;
      agentInfoEl.innerHTML = parts.join('');
      agentInfoEl.classList.add('visible');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('fetchAgentDetail error:', e);
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;
      showAgentDetailError(targetName, 'Summary unavailable. Refresh or reopen the panel.');
    } finally {
      if (requestSeq === agentDetailRequestSeq && agentDetailAbortController === controller) {
        agentDetailAbortController = null;
      }
    }
  }

  window.openAuditPage = function() {
    if (!monitoredAgent || !monitoredAgent.name) return;
    const url = '/agents/' + encodeURIComponent(monitoredAgent.name);
    window.location.href = url;
  };

  let rootDangerMode = null;

  function showActionToast(text) {
    const toast = document.getElementById('delete-toast');
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function clearMonitoredAgentView() {
    monitoredAgent = null;
    monitorPaused = true;
    monitorLabelEl.textContent = '';
    monitorEmptyEl.style.display = '';
    terminalWrapEl.classList.add('hidden');
    btnPause.style.display = 'none';
    if (btnSpeed) btnSpeed.style.display = 'none';
    if (btnAudit) btnAudit.style.display = 'none';
    btnScrollBottom.style.display = 'none';
    agentInfoEl.classList.remove('visible');
    agentInfoEl.innerHTML = '';
    fetchAgentStatus();
  }

  window.downAgent = function() {
    if (!monitoredAgent) return;
    rootDangerMode = 'down';
    document.getElementById('root-confirm-title').textContent = 'Stop Agent';
    document.getElementById('root-confirm-copy').textContent = 'This will stop the agent session for "' + monitoredAgent.name + '" and mark it offline. Continue?';
    const cta = document.getElementById('root-confirm-cta');
    cta.textContent = 'Stop Agent';
    cta.className = 'root-modal-btn warn';
    cta.disabled = false;
    document.getElementById('root-confirm-modal').classList.remove('hidden');
  };

  window.deleteAgent = function() {
    if (!monitoredAgent) return;
    rootDangerMode = 'delete';
    document.getElementById('root-confirm-title').textContent = 'Remove Agent';
    document.getElementById('root-confirm-copy').textContent = 'This permanently removes the agent entry for "' + monitoredAgent.name + '". This cannot be undone. Continue?';
    const cta = document.getElementById('root-confirm-cta');
    cta.textContent = 'Remove Agent';
    cta.className = 'root-modal-btn danger';
    cta.disabled = false;
    document.getElementById('root-confirm-modal').classList.remove('hidden');
  };

  window.closeRootModal = function() {
    rootDangerMode = null;
    document.getElementById('root-confirm-modal').classList.add('hidden');
  };

  window.confirmRootAction = async function() {
    if (!rootDangerMode || !monitoredAgent) return;
    const cta = document.getElementById('root-confirm-cta');
    cta.disabled = true;
    const name = monitoredAgent.name;
    try {
      if (rootDangerMode === 'down') {
        cta.textContent = 'Stopping...';
        const r = await fetch('/api/agents/' + encodeURIComponent(name) + '/down', { method: 'POST' });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.ok) throw new Error((d && (d.detail || d.error)) || 'stop failed');
        showActionToast('STOPPED: ' + name);
      } else {
        cta.textContent = 'Removing...';
        const r = await fetch('/api/agents/' + encodeURIComponent(name) + '?force=true', { method: 'DELETE' });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.ok) throw new Error((d && (d.detail || d.error)) || 'remove failed');
        showActionToast('REMOVED: ' + name);
      }
      closeRootModal();
      clearMonitoredAgentView();
    } catch (e) {
      cta.textContent = 'Failed: ' + e.message;
      setTimeout(() => closeRootModal(), 2000);
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rootDangerMode) closeRootModal();
  });

  let terminalEtag = null;
  let terminalFetching = false;
  async function fetchTerminal() {
    if (!monitoredAgent || monitorPaused || terminalFetching) return;
    terminalFetching = true;
    try {
      let url = '/api/tmux/capture/' + encodeURIComponent(monitoredAgent.tmux);
      if (monitoredAgent.remote && monitoredAgent.server) {
        url += '?server=' + encodeURIComponent(monitoredAgent.server);
      }
      const headers = {};
      if (terminalEtag) headers['If-None-Match'] = terminalEtag;
      const res = await fetch(url, { headers });
      if (res.status === 304) { terminalFetching = false; return; }
      const etag = res.headers.get('ETag');
      if (etag) terminalEtag = etag;
      const text = await res.text();
      const wasAtBottom = terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 30;
      terminalEl.textContent = text;
      if (wasAtBottom) terminalEl.scrollTop = terminalEl.scrollHeight;
    } catch (e) {
      console.error('fetchTerminal error:', e);
      terminalEl.textContent = '[Error fetching terminal: ' + e.message + ']';
    }
    terminalFetching = false;
  }

  function scheduleTerminalPoll() {
    if (terminalPollTimer) clearTimeout(terminalPollTimer);
    const waitMs = document.hidden
      ? TERMINAL_POLL_HIDDEN_MS
      : (terminalTurboMode ? TERMINAL_POLL_TURBO_MS : TERMINAL_POLL_VISIBLE_MS);
    terminalPollTimer = setTimeout(async () => {
      terminalPollTimer = null;
      if (monitoredAgent && !monitorPaused) await fetchTerminal();
      scheduleTerminalPoll();
    }, waitMs);
  }

  function renderAgentButtons(agents) {
    agentStatusList = agents;
    // Hide dead agents entirely
    agents = agents.filter(a => a.alive !== false);
    const selectedName = monitoredAgent?.name;
    if (agents.length === 0) {
      agentButtonsEl.innerHTML = '<span style="color:rgba(0,240,255,0.2);font-size:10px">no known agents</span>';
      return;
    }
    // Sort:
    // 1) local before remote
    // 2) active before idle
    // 3) among idle, smaller idleDurationSec first (more recently active first)
    // 4) tie-break with lastTmuxActivitySec desc, then name asc
    agents.sort((a, b) => {
      const tierOf = x => {
        if (x.remote) return 2;           // remote
        return 0;                         // local alive/idle
      };
      const ta = tierOf(a), tb = tierOf(b);
      if (ta !== tb) return ta - tb;

      const aActive = typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active;
      const bActive = typeof b.activeNow === 'boolean' ? b.activeNow : !!b.active;
      if (aActive !== bActive) return aActive ? -1 : 1;

      if (!aActive && !bActive) {
        const aIdle = toNonNegInt(a.idleDurationSec, Number.MAX_SAFE_INTEGER);
        const bIdle = toNonNegInt(b.idleDurationSec, Number.MAX_SAFE_INTEGER);
        if (aIdle !== bIdle) return aIdle - bIdle;
      }

      const aLast = toNonNegInt(a.lastTmuxActivitySec, 0);
      const bLast = toNonNegInt(b.lastTmuxActivitySec, 0);
      if (aLast !== bLast) return bLast - aLast;

      return a.name.localeCompare(b.name);
    });
    const envOrder = ['live', 'dev', 'benchmark', 'ephemeral'];
    const envLabels = { live: 'Live', dev: 'Dev', benchmark: 'Benchmark', ephemeral: 'Ephemeral' };
    const envGroups = {};
    for (const a of agents) { const e = a.environment || 'live'; (envGroups[e] || (envGroups[e] = [])).push(a); }
    function agentBtnHtml(a) {
      const isRemote = a.remote;
      const isActive = typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active;
      const dot = isRemote ? '&#9826;' : (isActive ? '&#9679;' : '&#9675;');
      const cls = ['agent-btn', isRemote ? 'remote-agent' : (isActive ? 'active-agent' : 'inactive-agent'), isRemote && a.alive ? 'alive' : '', a.name === selectedName ? 'selected' : ''].filter(Boolean).join(' ');
      return '<button class="' + cls + '" data-name="' + esc(a.name) + '" data-tmux="' + esc(a.tmux || '') + '">'
        + '<span class="dot">' + dot + '</span>' + esc(a.name) + '</button>';
    }
    let html = '';
    for (const env of envOrder) {
      const group = envGroups[env];
      if (!group || group.length === 0) continue;
      const activeCount = group.filter(a => a.remote ? a.alive : (typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active)).length;
      html += '<div class="agent-group-label">' + esc(envLabels[env]) + '<span class="agent-group-count">' + activeCount + ' active / ' + group.length + '</span></div>';
      html += group.map(agentBtnHtml).join('');
    }
    if (agentButtonsEl._lastHtml === html) return;
    agentButtonsEl._lastHtml = html;
    agentButtonsEl.innerHTML = html;
    for (const btn of agentButtonsEl.querySelectorAll('.agent-btn')) {
      btn.addEventListener('click', () => {
        const agent = agentStatusList.find(x => x.name === btn.dataset.name);
        if (agent && agent.tmux) selectAgent(agent);
      });
    }
    updateAgentToggle();
  }

  async function fetchAgentStatus(_reason = 'poll') {
    try {
      const res = await fetch('/api/agents/status');
      if (!res.ok) return;
      const rows = await res.json();
      const now = Date.now();
      const normalized = rows.map(row => ({
        ...row,
        activeNow: typeof row.activeNow === 'boolean' ? row.activeNow : !!row.active,
        activeDurationSec: toNonNegInt(row.activeDurationSec, 0),
        idleDurationSec: toNonNegInt(row.idleDurationSec, 0),
        _localTickAt: now,
      }));
      renderAgentButtons(normalized);
      updateSelectedRuntimeBadge();
      lastStatusSyncAt = now;
    } catch (e) {
      console.debug('[agent-status] status fetch skipped:', e.message);
    }
  }

  function tickAgentDurationsLocal() {
    if (!agentStatusList.length) return;
    const now = Date.now();
    let switched = false;
    for (const a of agentStatusList) {
      const last = Number(a._localTickAt) || now;
      const deltaSec = Math.floor((now - last) / 1000);
      if (deltaSec <= 0) continue;
      a._localTickAt = last + deltaSec * 1000;

      if (typeof a.idleMs === 'number' && a.idleMs >= 0) {
        a.idleMs += deltaSec * 1000;
      }

      const wasActive = !!a.activeNow;
      if (wasActive) {
        a.activeDurationSec = toNonNegInt(a.activeDurationSec, 0) + deltaSec;
        a.idleDurationSec = 0;
        if (typeof a.idleMs === 'number' && a.idleMs >= IDLE_THRESHOLD_MS) {
          a.activeNow = false;
          a.active = false;
          a.activeDurationSec = 0;
          a.idleDurationSec = 0;
          switched = true;
        }
      } else {
        a.activeNow = false;
        a.active = false;
        a.activeDurationSec = 0;
        a.idleDurationSec = toNonNegInt(a.idleDurationSec, 0) + deltaSec;
      }
    }
    updateSelectedRuntimeBadge();
    if (switched) scheduleStatusSyncSoon('state-switch');
  }

  // ── SSE ─────────────────────────────────────
  function connectSSE() {
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (e) => {
      try { addLogEntry(JSON.parse(e.data)); } catch (err) {
        console.debug('[sse] message parse skipped:', err.message);
      }
    };
    evtSource.addEventListener('queue', (e) => {
      try { queueItems = JSON.parse(e.data); requestQueueRender(false); } catch (err) {
        console.debug('[sse] queue parse skipped:', err.message);
      }
    });
    evtSource.addEventListener('reminders', (e) => {
      try { reminderItems = JSON.parse(e.data); renderReminderPanel(); } catch (err) {
        console.debug('[sse] reminders parse skipped:', err.message);
      }
    });
    for (const evt of ['task_created', 'task_updated', 'task_deleted']) {
      evtSource.addEventListener(evt, () => {
        if (activeTab === 'tasks') taskListRefresh();
      });
    }
  }

  // ── Init ────────────────────────────────────
  async function init() {
    // Load recent messages for log
    try {
      const res = await fetch('/api/messages');
      const msgs = await res.json();
      for (const msg of msgs.slice(-50)) addLogEntry(msg);
    } catch (e) { console.error('messages load failed:', e); }
    // Initial state
    try { const r = await fetch('/api/queue'); queueItems = await r.json(); requestQueueRender(true); } catch (e) {
      console.debug('[init] queue load skipped:', e.message);
    }
    try { const r = await fetch('/api/reminders'); reminderItems = await r.json(); renderReminderPanel(); } catch (e) {
      console.debug('[init] reminders load skipped:', e.message);
    }
    await fetchAgentStatus('init');
    statusPollTimer = setInterval(() => {
      if (!document.hidden) fetchAgentStatus('poll');
    }, STATUS_SYNC_INTERVAL_MS);
    durationTickTimer = setInterval(() => {
      if (!document.hidden) tickAgentDurationsLocal();
    }, DURATION_TICK_VISIBLE_MS);
    scheduleTerminalPoll();
    scheduleDetailRefresh();
    connectSSE();
    // Alert badge
    async function refreshAlertBadge(){
      try{
        const r=await fetch('/api/alerts/stats');
        if(!r.ok)return;
        const s=await r.json();
        const open=(s.byStatus.open||0)+(s.byStatus.acknowledged||0)+(s.byStatus.assigned||0);
        const crit=s.bySeverity.critical||0;
        const badge=document.getElementById('alert-badge');
        if(badge){
          if(open>0){badge.style.display='inline';badge.textContent='\\u26a0 '+open+' alert'+(open>1?'s':'')+(crit?' ('+crit+' crit)':'');}
          else{badge.style.display='none'}
        }
      }catch{}
    }
    refreshAlertBadge();
    setInterval(refreshAlertBadge,30000);
  }

  // ── Mobile panel toggle ─────────────────────
  const mobileBackdrop = document.getElementById('mobile-backdrop');
  const mobileFabQueue = document.getElementById('mobile-fab-queue');
  const mobileFabReminder = document.getElementById('mobile-fab-reminder');

  window.toggleMobilePanel = function(which) {
    const qp = document.getElementById('queue-panel');
    const rc = document.getElementById('right-col');
    if (which === 'queue') {
      const opening = !qp.classList.contains('mobile-open');
      rc.classList.remove('mobile-open');
      qp.classList.toggle('mobile-open');
      mobileBackdrop.classList.toggle('active', opening);
    } else {
      const opening = !rc.classList.contains('mobile-open');
      qp.classList.remove('mobile-open');
      rc.classList.toggle('mobile-open');
      mobileBackdrop.classList.toggle('active', opening);
    }
  };
  window.closeMobilePanels = function() {
    document.getElementById('queue-panel').classList.remove('mobile-open');
    document.getElementById('right-col').classList.remove('mobile-open');
    mobileBackdrop.classList.remove('active');
  };

  // Update FAB dot indicators when queue/reminder have items
  function updateMobileFabs() {
    if (document.hidden) return;
    mobileFabQueue.classList.toggle('has-count', queueItems.length > 0);
    mobileFabReminder.classList.toggle('has-count', reminderItems.length > 0);
  }
  setInterval(updateMobileFabs, 2000);

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-hidden', document.hidden);
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = setInterval(() => {
        if (!document.hidden) fetchAgentStatus('poll');
      }, document.hidden ? STATUS_SYNC_INTERVAL_HIDDEN_MS : STATUS_SYNC_INTERVAL_MS);
    }
    if (durationTickTimer) {
      clearInterval(durationTickTimer);
      durationTickTimer = setInterval(() => {
        if (!document.hidden) tickAgentDurationsLocal();
      }, document.hidden ? DURATION_TICK_HIDDEN_MS : DURATION_TICK_VISIBLE_MS);
    }
    scheduleTerminalPoll();
    scheduleDetailRefresh();
    if (!document.hidden) {
      requestQueueRender(true);
      renderReminderPanel();
      updateMobileFabs();
      fetchAgentStatus('visibility').catch(() => {});
      if (monitoredAgent) fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });
      if (monitoredAgent && !monitorPaused) fetchTerminal();
    }
  });

  init();
})();
</script>
</body>
</html>`;

function renderAlertsPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Alerts</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--red:#ff6b6b;--yellow:#ffd93d;--green:#6bff9e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.page{max-width:1200px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
.stats-bar{display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--muted);flex-wrap:wrap}
.stats-bar .stat{padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.stats-bar .stat.critical{border-color:rgba(255,107,107,0.4);color:var(--red)}
.stats-bar .stat.warning{border-color:rgba(255,217,61,0.4);color:var(--yellow)}
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.filters select,.filters input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.alert-list{display:flex;flex-direction:column;gap:2px}
.alert-row{display:grid;grid-template-columns:24px 80px 1fr 90px 80px 70px;gap:8px;align-items:center;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:border-color 0.15s}
.alert-row:hover{border-color:rgba(109,193,255,0.3)}
.alert-row.selected{border-color:var(--accent);background:rgba(109,193,255,0.05)}
.sev-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.sev-dot.critical{background:var(--red)}
.sev-dot.warning{background:var(--yellow)}
.sev-dot.info{background:rgba(109,193,255,0.5)}
.alert-type{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-agent{font-size:10px;color:var(--accent)}
.alert-status{font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.alert-status.open{color:var(--red)}
.alert-status.acknowledged{color:var(--yellow)}
.alert-status.assigned{color:var(--accent)}
.alert-status.resolved{color:var(--green)}
.alert-status.suppressed{color:var(--muted)}
.alert-time{font-size:10px;color:var(--muted);text-align:right}
.detail-panel{margin-top:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;display:none}
.detail-panel.visible{display:block}
.detail-panel h2{font-size:13px;color:var(--accent);margin-bottom:12px}
.detail-grid{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:11px;margin-bottom:12px}
.detail-grid .label{color:var(--muted)}
.detail-actions{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.detail-actions button{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer}
.detail-actions button:hover{border-color:var(--accent);color:var(--accent)}
.notes-section{margin-top:12px}
.note{padding:6px 0;border-bottom:1px solid var(--border);font-size:11px}
.note .note-meta{color:var(--muted);font-size:10px;margin-bottom:2px}
.note-form{display:flex;gap:8px;margin-top:8px}
.note-form input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.note-form button{background:var(--surface);border:1px solid var(--border);color:var(--accent);padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer}
.empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}
.occ{background:rgba(255,217,61,0.15);color:var(--yellow);padding:1px 6px;border-radius:8px;font-size:9px;margin-left:4px}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>ALERTS</h1>
    <a href="/">&#8592; Dashboard</a>
  </div>
  <div class="stats-bar" id="stats-bar"></div>
  <div class="filters">
    <select id="filter-status" onchange="window._applyFilters()">
      <option value="">All statuses</option>
      <option value="open" selected>Open</option>
      <option value="acknowledged">Acknowledged</option>
      <option value="assigned">Assigned</option>
      <option value="suppressed">Suppressed</option>
      <option value="resolved">Resolved</option>
    </select>
    <select id="filter-severity" onchange="window._applyFilters()">
      <option value="">All severities</option>
      <option value="critical">Critical</option>
      <option value="warning">Warning</option>
      <option value="info">Info</option>
    </select>
    <input id="filter-agent" type="text" placeholder="Filter by agent..." oninput="window._applyFilters()"/>
  </div>
  <div class="alert-list" id="alert-list"><div class="empty">Loading alerts...</div></div>
  <div class="detail-panel" id="detail-panel"></div>
</div>
<script>
(() => {
  function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
  function relTime(ts){const d=Date.now()-ts;if(d<60000)return Math.floor(d/1000)+'s ago';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago'}

  let alerts=[];
  let selectedId=null;
  const listEl=document.getElementById('alert-list');
  const detailEl=document.getElementById('detail-panel');
  const statsEl=document.getElementById('stats-bar');

  const urlParams=new URLSearchParams(window.location.search);
  const preAgent=urlParams.get('sourceAgent')||'';
  if(preAgent)document.getElementById('filter-agent').value=preAgent;

  async function fetchAlerts(){
    const status=document.getElementById('filter-status').value;
    const severity=document.getElementById('filter-severity').value;
    const agent=document.getElementById('filter-agent').value.trim();
    const p=new URLSearchParams();
    if(status)p.set('status',status);
    if(severity)p.set('severity',severity);
    if(agent)p.set('sourceAgent',agent);
    p.set('limit','200');
    try{const r=await fetch('/api/alerts?'+p);if(r.ok)alerts=await r.json()}catch{}
    renderList();
    if(selectedId)renderDetail();
    fetchStats();
  }

  async function fetchStats(){
    try{
      const r=await fetch('/api/alerts/stats');
      if(!r.ok)return;
      const s=await r.json();
      const open=(s.byStatus.open||0)+(s.byStatus.acknowledged||0)+(s.byStatus.assigned||0);
      const crit=s.bySeverity.critical||0;
      const warn=s.bySeverity.warning||0;
      statsEl.innerHTML=[
        '<span class="stat'+(crit?' critical':'')+'">Open: '+open+(crit?' ('+crit+' crit)':'')+'</span>',
        '<span class="stat">Assigned: '+(s.byStatus.assigned||0)+'</span>',
        '<span class="stat">Suppressed: '+(s.byStatus.suppressed||0)+'</span>',
        crit?'<span class="stat critical">Critical: '+crit+'</span>':'',
        warn?'<span class="stat warning">Warning: '+warn+'</span>':'',
        '<span class="stat">Info: '+(s.bySeverity.info||0)+'</span>',
        '<span class="stat">Total: '+s.total+'</span>',
      ].filter(Boolean).join('');
    }catch{}
  }

  function renderList(){
    if(!alerts.length){listEl.innerHTML='<div class="empty">No alerts found</div>';return}
    const html=[];
    for(const a of alerts){
      const sel=a.id===selectedId?' selected':'';
      const occ=a.occurrences>1?' <span class="occ">x'+a.occurrences+'</span>':'';
      html.push('<div class="alert-row'+sel+'" onclick="window._sel(this.dataset.id)" data-id="'+esc(a.id)+'">'
        +'<span class="sev-dot '+esc(a.severity)+'"></span>'
        +'<span class="alert-type">'+esc(a.alertType||'')+'</span>'
        +'<span class="alert-summary">'+esc(a.summary||'')+occ+'</span>'
        +'<span class="alert-agent">'+esc(a.sourceAgent||'-')+'</span>'
        +'<span class="alert-status '+esc(a.status)+'">'+esc(a.status)+'</span>'
        +'<span class="alert-time">'+relTime(a.lastSeenAt)+'</span>'
        +'</div>');
    }
    listEl.innerHTML=html.join('');
  }

  window._sel=function(id){selectedId=id;renderList();renderDetail()};

  function renderDetail(){
    const a=alerts.find(x=>x.id===selectedId);
    if(!a){detailEl.classList.remove('visible');return}
    detailEl.classList.add('visible');
    const rows=[
      ['ID',esc(a.id)],['Type',esc(a.alertType||'')],
      ['Severity','<span class="sev-dot '+esc(a.severity)+'" style="vertical-align:middle"></span> '+esc(a.severity)],
      ['Source',esc(a.source||'')],
      ['Agent',a.sourceAgent?'<a href="/agents/'+encodeURIComponent(a.sourceAgent)+'">'+esc(a.sourceAgent)+'</a>':'-'],
      ['Status','<span class="alert-status '+esc(a.status)+'">'+esc(a.status)+'</span>'+(a.assignee?' &rarr; '+esc(a.assignee):'')],
      ['Occurrences',String(a.occurrences||1)],
      ['First Seen',new Date(a.firstSeenAt).toISOString()],
      ['Last Seen',new Date(a.lastSeenAt).toISOString()],
      ['Linked Task',a.linkedTaskId?esc(a.linkedTaskId):'-'],
      ['Tags',(a.tags||[]).map(t=>'<span style="background:rgba(109,193,255,0.1);padding:1px 6px;border-radius:4px;margin-right:4px;font-size:10px">'+esc(t)+'</span>').join('')||'-'],
    ];
    const grid=rows.map(([l,v])=>'<div class="label">'+l+'</div><div>'+v+'</div>').join('');
    const acts=[];
    const trans={"open":["acknowledged","assigned","resolved","suppressed"],"acknowledged":["assigned","resolved"],"assigned":["resolved"],"suppressed":["open","assigned"]};
    const labels={"acknowledged":"Acknowledge","assigned":"Assign","resolved":"Resolve","suppressed":"Suppress","open":"Reopen"};
    for(const t of(trans[a.status]||[])){
      acts.push('<button onclick="window._tr(\\x27'+t+'\\x27)">'+labels[t]+'</button>');
    }
    acts.push('<button onclick="window._del()" style="color:var(--red)">Delete</button>');
    const notes=(a.notes||[]).map(n=>'<div class="note"><div class="note-meta">'+esc(n.author||'?')+' &middot; '+new Date(n.ts).toLocaleString()+'</div><div>'+esc(n.text)+'</div></div>').join('');
    detailEl.innerHTML='<h2>'+esc(a.summary||a.alertType)+'</h2>'
      +'<div class="detail-grid">'+grid+'</div>'
      +'<div class="detail-actions">'+acts.join('')+'</div>'
      +(a.detail?'<div style="margin-bottom:12px;padding:8px;background:var(--bg);border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto">'+esc(typeof a.detail==='string'?a.detail:JSON.stringify(a.detail,null,2))+'</div>':'')
      +'<div class="notes-section"><strong style="font-size:11px;color:var(--muted)">Notes</strong>'+notes
      +'<div class="note-form"><input id="note-text" placeholder="Add a note..."/><button onclick="window._addNote()">Post</button></div></div>';
  }

  window._tr=async function(status){
    if(!selectedId)return;
    const body={status};
    if(status==='assigned'){const a=prompt('Assign to:');if(!a)return;body.assignee=a}
    try{await fetch('/api/alerts/'+encodeURIComponent(selectedId)+'/transition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});fetchAlerts()}catch{}
  };
  window._addNote=async function(){
    if(!selectedId)return;
    const t=(document.getElementById('note-text')||{}).value||'';
    if(!t.trim())return;
    try{await fetch('/api/alerts/'+encodeURIComponent(selectedId)+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t.trim(),author:'operator'})});fetchAlerts()}catch{}
  };
  window._del=async function(){
    if(!selectedId||!confirm('Delete this alert?'))return;
    try{await fetch('/api/alerts/'+encodeURIComponent(selectedId),{method:'DELETE'});selectedId=null;fetchAlerts()}catch{}
  };
  window._applyFilters=function(){fetchAlerts()};

  // SSE real-time updates
  try{
    const es=new EventSource('/api/stream');
    ['alert_created','alert_updated','alert_resolved','alert_deleted'].forEach(e=>{
      es.addEventListener(e,()=>{fetchAlerts()});
    });
  }catch{}

  fetchAlerts();
})();
</script>
</body>
</html>`;
}

function renderConfigPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Config</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--red:#ff6b6b;--yellow:#ffd93d;--green:#6bff9e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
select{cursor:pointer}
select option{background:#0d1723;color:#e2eaf3}
.page{max-width:900px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.panel-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.hint{font-size:11px;color:var(--muted);margin-bottom:12px}
.preset-table{width:100%;border-collapse:collapse;font-size:11px}
.preset-table th{text-align:left;padding:6px 8px;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border)}
.preset-table td{padding:6px 8px;border-bottom:1px solid rgba(154,182,210,0.06)}
.preset-table tr:hover{background:rgba(109,193,255,0.04)}
.empty-state{text-align:center;padding:24px;color:var(--muted);font-size:11px}
.field-label{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-top:10px;margin-bottom:4px}
.cfg-input{width:100%;margin-top:2px;background:rgba(255,255,255,0.03);border:1px solid rgba(109,193,255,0.24);border-radius:8px;color:var(--text);padding:8px 10px;outline:none;font-size:12px;font-family:inherit}
.cfg-input:focus{border-color:rgba(109,193,255,0.5)}
.btn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;letter-spacing:0.5px}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-accent{border-color:rgba(109,193,255,0.4);color:var(--accent)}
.btn-danger{border-color:rgba(255,107,107,0.3);color:var(--red)}
.btn-danger:hover{border-color:var(--red);background:rgba(255,107,107,0.08)}
.actions-row{display:flex;gap:8px;margin-top:12px}
.status-msg{font-size:11px;margin-top:8px;min-height:16px}
.status-ok{color:var(--green)}
.status-error{color:var(--red)}
.add-form{display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.add-form.visible{display:block}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>GLOBAL CONFIG</h1>
    <a href="/">&larr; Monitor</a>
    <a href="/alerts">Alerts</a>
  </div>

  <div class="panel">
    <div class="panel-label">Framework Presets</div>
    <div class="hint">Named bundles of framework / provider / model settings. These presets appear in each agent's Configuration dropdowns.</div>
    <div id="preset-list"></div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-accent" onclick="toggleAddForm()">+ Add Preset</button>
    </div>
    <div id="add-form" class="add-form">
      <div class="field-label">Name</div>
      <input id="p-name" class="cfg-input" placeholder="e.g. Claude Opus">
      <div class="field-label">Framework</div>
      <select id="p-framework" class="cfg-input"><option value="">—</option><option value="claude">claude</option><option value="codex">codex</option></select>
      <div class="field-label">Provider</div>
      <input id="p-provider" class="cfg-input" placeholder="e.g. anthropic">
      <div class="field-label">Model</div>
      <input id="p-model" class="cfg-input" placeholder="e.g. claude-sonnet-4-20250514">
      <div class="field-label">Reasoning</div>
      <input id="p-reasoning" class="cfg-input" placeholder="e.g. extended">
      <div class="field-label">Extra Args</div>
      <input id="p-extraArgs" class="cfg-input" placeholder="e.g. --verbose">
      <div class="actions-row">
        <button class="btn btn-accent" onclick="submitPreset()">Create Preset</button>
        <button class="btn" onclick="toggleAddForm()">Cancel</button>
      </div>
    </div>
    <div id="status-msg" class="status-msg"></div>
  </div>
</div>
<script>
(function(){
  const listEl = document.getElementById('preset-list');
  const formEl = document.getElementById('add-form');
  const statusEl = document.getElementById('status-msg');
  let presets = [];

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status-msg ' + (cls || '');
    if (msg) setTimeout(function() { if (statusEl.textContent === msg) { statusEl.textContent = ''; statusEl.className = 'status-msg'; } }, 3000);
  }

  function render() {
    if (presets.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No presets defined yet.</div>';
      return;
    }
    var h = '<table class="preset-table"><thead><tr><th>Name</th><th>Framework</th><th>Provider</th><th>Model</th><th>Reasoning</th><th>Extra Args</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      h += '<tr>'
        + '<td><strong>' + esc(p.name) + '</strong></td>'
        + '<td>' + esc(p.framework || '-') + '</td>'
        + '<td>' + esc(p.provider || '-') + '</td>'
        + '<td>' + esc(p.model || '-') + '</td>'
        + '<td>' + esc(p.reasoning || '-') + '</td>'
        + '<td>' + esc(p.extraArgs || '-') + '</td>'
        + '<td><button class="btn btn-danger" onclick="deletePreset(\\'' + esc(p.id) + '\\')">Delete</button></td>'
        + '</tr>';
    }
    h += '</tbody></table>';
    listEl.innerHTML = h;
  }

  async function fetchPresets() {
    try {
      var r = await fetch('/api/framework-presets');
      if (r.ok) presets = await r.json();
    } catch (e) { console.error('fetch presets:', e); }
    render();
  }

  window.toggleAddForm = function() {
    formEl.classList.toggle('visible');
  };

  window.submitPreset = async function() {
    var name = (document.getElementById('p-name').value || '').trim();
    if (!name) { showStatus('Name is required.', 'status-error'); return; }
    var body = {
      name: name,
      framework: (document.getElementById('p-framework').value || '').trim() || null,
      provider: (document.getElementById('p-provider').value || '').trim() || null,
      model: (document.getElementById('p-model').value || '').trim() || null,
      reasoning: (document.getElementById('p-reasoning').value || '').trim() || null,
      extraArgs: (document.getElementById('p-extraArgs').value || '').trim() || null,
    };
    try {
      var r = await fetch('/api/framework-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'create failed');
      showStatus('Preset created: ' + (data.preset ? data.preset.name : name), 'status-ok');
      document.getElementById('p-name').value = '';
      document.getElementById('p-provider').value = '';
      document.getElementById('p-model').value = '';
      document.getElementById('p-reasoning').value = '';
      document.getElementById('p-extraArgs').value = '';
      formEl.classList.remove('visible');
      await fetchPresets();
    } catch (e) { showStatus('Create failed: ' + e.message, 'status-error'); }
  };

  window.deletePreset = async function(id) {
    if (!confirm('Delete this preset?')) return;
    try {
      var r = await fetch('/api/framework-presets/' + encodeURIComponent(id), { method: 'DELETE' });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'delete failed');
      showStatus('Preset deleted.', 'status-ok');
      await fetchPresets();
    } catch (e) { showStatus('Delete failed: ' + e.message, 'status-error'); }
  };

  fetchPresets();
})();
</script>
</body>
</html>`;
}
