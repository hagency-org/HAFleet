import express from 'express';
import { readFile as readFileAsync, open, stat as statAsync, appendFile } from 'fs/promises';
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, lstatSync, rmSync, unlinkSync, readdirSync, renameSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { defaultAgentchatHomeDir, resolveAgentDocsPaths, resolveV1ManifestForAgent } from './lib/agent-home-v1.js';
import { detectPaneBusyState } from './lib/pane-activity.js';
import { assertRuntimeDir, isLocalAgentServer as isLocalServerIdentity, resolveLocalServerId } from './lib/runtime-dir-guard.js';
import { enforceStartupConfig } from './lib/startup-config.js';
import { createDashboardMutationBoundary } from './lib/dashboard/request-boundary.js';
import { installDashboardPageRoutes } from './lib/dashboard/page-routes.js';
import {
  installAlertProxyRoutes,
  installSubconsciousEventProxyRoutes,
  installSubconsciousProxyRoutes,
  installSupervisorProxyRoutes,
  installTaskProxyRoutes,
} from './lib/dashboard/proxy-routes.js';

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
const DELIVERY_EVENT_FILE = path.join(LOGS_ROOT, 'delivery-events.jsonl');
const AGENT_DOWN_BIN = path.join(REPO_ROOT, 'bin', 'agent-down');
const BACKEND_V2_URL = (process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).trim().replace(/\/$/, '');
const PUSH_DELIVERED_URL = `${BACKEND_V2_URL}/api/runtime/push-delivered`;
const DELIVERY_EVENTS_URL = `${BACKEND_V2_URL}/api/delivery-events`;
const BACKEND_API_TOKEN = (process.env.API_TOKEN || '').trim();
const defaultBackendFetchTransport = (url, opts) => fetch(url, opts);
let backendFetchTransport = defaultBackendFetchTransport;
function backendFetch(url, opts = {}) {
  const headers = { ...opts.headers };
  if (BACKEND_API_TOKEN) headers['Authorization'] = `Bearer ${BACKEND_API_TOKEN}`;
  return backendFetchTransport(url, { ...opts, headers });
}
const DEFAULT_IDLE_THRESHOLD_MS = 20_000;
const envIdleThreshold = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || `${DEFAULT_IDLE_THRESHOLD_MS}`, 10);
const IDLE_THRESHOLD = Number.isFinite(envIdleThreshold) && envIdleThreshold > 0
  ? envIdleThreshold
  : DEFAULT_IDLE_THRESHOLD_MS;
const IDLE_THRESHOLD_SEC = Math.max(1, Math.ceil(IDLE_THRESHOLD / 1000));
const execFileAsync = promisify(execFile);
let execFileAsyncImpl = execFileAsync;
const DASHBOARD_API_TOKEN = (process.env.AGENT_CHAT_DASHBOARD_TOKEN || '').trim();
const SERVER_STARTUP_OPTIONAL_ENV = [
  {
    name: 'AGENT_CHAT_DASHBOARD_TOKEN',
    description: 'Non-local dashboard mutations will remain unavailable unless this token is configured.',
  },
];
let dashboardRequestLocalOverride = null;
const dashboardMutationBoundary = createDashboardMutationBoundary({
  dashboardApiToken: DASHBOARD_API_TOKEN,
  getLocalOverride: () => dashboardRequestLocalOverride,
});
const { requireDashboardMutationBoundary } = dashboardMutationBoundary;
const runtimeIntervals = new Set();
const runtimeTimeouts = new Set();
let runtimeLoopsStarted = false;

function trackRuntimeInterval(callback, ms) {
  const handle = setInterval(callback, ms);
  runtimeIntervals.add(handle);
  return handle;
}

function trackRuntimeTimeout(callback, ms) {
  const handle = setTimeout(() => {
    runtimeTimeouts.delete(handle);
    callback();
  }, ms);
  runtimeTimeouts.add(handle);
  return handle;
}

function clearRuntimeHandles() {
  for (const handle of runtimeIntervals) clearInterval(handle);
  for (const handle of runtimeTimeouts) clearTimeout(handle);
  runtimeIntervals.clear();
  runtimeTimeouts.clear();
}

mkdirSync(DATA_ROOT, { recursive: true });
mkdirSync(LOGS_ROOT, { recursive: true });
mkdirSync(path.join(DATA_ROOT, 'agents'), { recursive: true });

// ── Local server identity ───
const LOCAL_SERVER_ID = resolveLocalServerId();
function isLocalAgentServer(value) {
  return isLocalServerIdentity(value, LOCAL_SERVER_ID);
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

const MESSAGE_LIST_LIMIT_MAX = 500;
const MESSAGE_LIST_TAIL_CHUNK_BYTES = 64 * 1024;

function parseMessageLogRow(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function parseMessageListPositiveInt(value, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, max);
}

function parseMessageListTimestamp(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageInListWindow(msg, since, before) {
  const ts = Number(msg?.ts);
  if (since > 0 && !(ts > since)) return false;
  if (Number.isFinite(before) && !(ts < before)) return false;
  return true;
}

async function readAllMessagesFromLog(since, before) {
  const raw = await readFileAsync(LOG_FILE, 'utf-8');
  return raw.trim().split('\n')
    .filter(Boolean)
    .map(parseMessageLogRow)
    .filter((msg) => msg && messageInListWindow(msg, since, before));
}

async function readMessageLogPage(since, before, limit) {
  const fh = await open(LOG_FILE, 'r');
  try {
    const fileStat = await fh.stat();
    let position = fileStat.size;
    let carry = '';
    const rows = [];

    while (position > 0 && rows.length < limit) {
      const readSize = Math.min(MESSAGE_LIST_TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, position);

      const chunk = buffer.toString('utf-8') + carry;
      const lines = chunk.split('\n');
      carry = lines.shift() || '';

      for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const msg = parseMessageLogRow(line);
        if (msg && messageInListWindow(msg, since, before)) rows.push(msg);
      }
    }

    if (position === 0 && carry.trim() && rows.length < limit) {
      const msg = parseMessageLogRow(carry.trim());
      if (msg && messageInListWindow(msg, since, before)) rows.push(msg);
    }

    return rows.reverse();
  } finally {
    await fh.close();
  }
}

// ── API: fetch messages (optionally filtered by since/before/limit) ─
app.get('/api/messages', async (req, res) => {
  const since = parseMessageListTimestamp(req.query.since, 0);
  const before = parseMessageListTimestamp(req.query.before, Infinity);
  const limit = parseMessageListPositiveInt(req.query.limit, MESSAGE_LIST_LIMIT_MAX);
  try {
    const msgs = limit
      ? await readMessageLogPage(since, before, limit)
      : await readAllMessagesFromLog(since, before);
    res.json(msgs);
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
  broadcastSseFrame(frame);
}

function writeSseFrame(client, frame) {
  try {
    client.write(frame);
    return true;
  } catch {
    sseClients.delete(client);
    return false;
  }
}

function broadcastSseFrame(frame) {
  for (const client of sseClients) writeSseFrame(client, frame);
}

// ── Tail log file for new entries ────────────────────────────────────
let fileOffset = 0;
let messageLogTailCarry = '';
try {
  const raw = await readFileAsync(LOG_FILE, 'utf-8').catch(() => '');
  fileOffset = Buffer.byteLength(raw, 'utf-8');
} catch { /* file may not exist yet */ }

async function pollMessageLogTail() {
  try {
    const fh = await open(LOG_FILE, 'r');
    try {
      const fstat = await fh.stat();
      if (fstat.size < fileOffset) {
        fileOffset = 0; // truncated
        messageLogTailCarry = '';
      }
      if (fstat.size <= fileOffset) return;
      const buf = Buffer.alloc(fstat.size - fileOffset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, fileOffset);
      if (bytesRead <= 0) return;
      fileOffset += bytesRead;

      const chunk = messageLogTailCarry + buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      messageLogTailCarry = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { broadcast(JSON.parse(trimmed)); } catch { /* skip */ }
      }
    } finally {
      await fh.close();
    }
  } catch { /* ignore - file may not exist */ }
}

// ── Message Queue with Idle Detection ────────────────────────────────
const POLL_INTERVAL  = 1_000;  // check every 1s
const REMINDER_MERGE_PREVIEW_LIMIT = Math.max(1, Number.parseInt(process.env.REMINDER_MERGE_PREVIEW_LIMIT || '20', 10));

app.use(express.json());
app.use('/api', requireDashboardMutationBoundary);

// Queue: Map<target, Array<{id, from, to, payload, queuedAt}>>
const QUEUE_FILE = path.join(LOGS_ROOT, 'queue.json');
const QUEUE_DROPPED_FILE = path.join(LOGS_ROOT, 'queue-dropped.jsonl');
const queue = new Map();
let queueIdCounter = 0;
let queueTickRunning = false;
const QUEUE_DELIVERY_TERMINAL_STATES = new Set(['delivered', 'dropped', 'partial']);

function cloneJsonPlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotQueueState() {
  return {
    idCounter: queueIdCounter,
    buckets: new Map([...queue.entries()].map(([target, entries]) => [
      target,
      entries.map((entry) => cloneJsonPlain(entry)),
    ])),
  };
}

function restoreQueueState(snapshot) {
  if (!snapshot) return;
  queueIdCounter = snapshot.idCounter;
  queue.clear();
  for (const [target, entries] of snapshot.buckets.entries()) {
    queue.set(target, entries.map((entry) => cloneJsonPlain(entry)));
  }
}

function resetQueueEntryDeliveryState(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  delete entry.deliveryState;
  delete entry.deliveringAt;
  delete entry.deliveredAt;
  delete entry.droppedAt;
  delete entry.partialAt;
  return entry;
}

function markQueueEntryDelivering(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return entry;
  entry.deliveryState = 'delivering';
  entry.deliveringAt = now;
  entry.deliveryAttempt = Math.max(0, Number(entry.deliveryAttempt) || 0) + 1;
  return entry;
}

function markQueueEntryTerminal(entry, state, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return entry;
  entry.deliveryState = state;
  if (state === 'delivered') entry.deliveredAt = now;
  else if (state === 'partial') entry.partialAt = now;
  else entry.droppedAt = now;
  return entry;
}

function removeQueueEntry(target, entry) {
  const entries = queue.get(target);
  if (!Array.isArray(entries)) return false;
  const idx = entries.findIndex((candidate) => candidate === entry || candidate?.id === entry?.id);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  if (entries.length === 0) queue.delete(target);
  return true;
}

function claimQueueEntryForDelivery(entry, target, pathName, context = {}) {
  const rollback = snapshotQueueState();
  markQueueEntryDelivering(entry);
  if (!saveQueue()) {
    restoreQueueState(rollback);
    appendQueuePersistFailedEvent(entry, 'queue-dequeue-save-failed', {
      path: pathName,
      target,
      ...context,
    });
    broadcastQueue();
    return false;
  }
  broadcastQueue();
  appendDeliveryEvent({
    type: 'queue.dequeued',
    ...queueEntryDeliveryEventFields(entry),
    path: pathName,
    context,
  });
  return true;
}

function persistQueueEntryQueued(entry, reason, context = {}) {
  resetQueueEntryDeliveryState(entry);
  if (!saveQueue()) appendQueuePersistFailedEvent(entry, reason, context);
  broadcastQueue();
}

function finalizeQueueEntryAfterSideEffect(entry, target, state, reason, context = {}) {
  const now = Date.now();
  const rollback = snapshotQueueState();
  markQueueEntryTerminal(entry, state, now);
  const terminalPersisted = saveQueue();
  if (!terminalPersisted) {
    restoreQueueState(rollback);
    appendQueuePersistFailedEvent(entry, reason, context);
    broadcastQueue();
    return { ok: false, reason: 'queue-persist-failed' };
  }
  removeQueueEntry(target, entry);
  if (terminalPersisted && !saveQueue()) {
    appendQueuePersistFailedEvent(entry, `${reason}-remove-failed`, context);
  }
  broadcastQueue();
  return { ok: true };
}

function isBackendNotificationEntry(entry) {
  if (!entry || entry.from !== 'agent-chat-v2') return false;
  return typeof entry.payload === 'string' && entry.payload.startsWith('[NOTIFICATION]');
}

function targetSessionName(target) {
  if (typeof target !== 'string' || !target) return null;
  return target.split(':')[0] || null;
}

function dropQueuedBackendNotificationsBySource(agentName, sourceMsgId = null, reason = 'backend-notification-cleared') {
  const normalizedAgent = typeof agentName === 'string' ? agentName.trim() : '';
  if (!normalizedAgent) return { removed: 0, persistFailed: false };
  const sourceId = typeof sourceMsgId === 'string' ? sourceMsgId.trim() : '';
  const rollback = snapshotQueueState();
  const dropped = [];
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
      const entryMessageIds = Array.isArray(entry?.notifyMeta?.messageIds)
        ? entry.notifyMeta.messageIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
        : [];
      const matchesSource = sourceId ? (entrySource === sourceId || entryMessageIds.includes(sourceId)) : true;
      if (isNotification && matchesSource) {
        removed++;
        dropped.push({ entry, target });
        continue;
      }
      kept.push(entry);
    }

    if (kept.length === 0) queue.delete(target);
    else queue.set(target, kept);
  }

  if (removed > 0) {
    if (!saveQueue()) {
      restoreQueueState(rollback);
      appendQueuePersistFailedEvent(dropped[0]?.entry || null, 'queue-source-drop-save-failed', {
        path: 'api',
        requestedAgent: normalizedAgent,
        sourceMsgId: sourceId || null,
      });
      broadcastQueue();
      return { removed: 0, persistFailed: true };
    }
    for (const { entry, target } of dropped) {
      appendDeliveryEvent({
        type: 'queue.dropped',
        ...queueEntryDeliveryEventFields(entry),
        target,
        reason,
        context: {
          requestedAgent: normalizedAgent,
          sourceMsgId: sourceId || null,
        },
      });
    }
    broadcastQueue();
  }
  return { removed, persistFailed: false };
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
    messageIds: Array.isArray(rawMeta.messageIds)
      ? rawMeta.messageIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
      : [],
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

function deliveryMessageId(entry) {
  const source = typeof entry?.notifyMeta?.sourceMsgId === 'string' ? entry.notifyMeta.sourceMsgId.trim() : '';
  return source || null;
}

function queueEntryDeliveryEventFields(entry = {}) {
  const queueEntryId = Number(entry.id) || null;
  const queuedAt = Number(entry.queuedAt) || null;
  const agent = targetSessionName(entry.to);
  const notifyMeta = sanitizeNotifyMeta(entry.notifyMeta);
  const messageIds = Array.isArray(notifyMeta?.messageIds)
    ? notifyMeta.messageIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : [];
  return {
    messageId: deliveryMessageId(entry),
    messageIds,
    agent,
    target: entry.to || null,
    queueEntryId,
    queuedAt,
    priority: normalizeQueuePriority(entry.priority || notifyMeta?.priority),
    notifyMeta,
    attemptId: [deliveryMessageId(entry) || 'unknown-message', agent || entry.to || 'unknown-target', queueEntryId || queuedAt || Date.now()].join(':'),
  };
}

function appendDeliveryEvent(raw = {}) {
  const now = Date.now();
  const row = {
    id: `sdevt_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    ts: Number(raw.ts) > 0 ? Number(raw.ts) : now,
    ...raw,
    source: raw.source || 'dashboard-queue',
  };
  try {
    appendFileSync(DELIVERY_EVENT_FILE, `${JSON.stringify(row)}\n`);
  } catch (error) {
    console.debug(`[server] delivery event append skipped: ${error.message}`);
  }
  try {
    void backendFetch(DELIVERY_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    }).catch(() => {});
  } catch {
    // Best-effort diagnostics only.
  }
  return row;
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
    appendDeliveryEvent({
      type: 'push.delivered_ack_send',
      ...queueEntryDeliveryEventFields(entry),
      deliveredAt,
    });
    const resp = await backendFetch(PUSH_DELIVERED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      appendDeliveryEvent({
        type: 'push.delivered_ack_failed',
        ...queueEntryDeliveryEventFields(entry),
        deliveredAt,
        status: resp.status,
        reason: errText.slice(0, 200) || `status-${resp.status}`,
      });
      console.warn(`[push-delivered] backend rejected ${agent}: HTTP ${resp.status}${errText ? ` ${errText.slice(0, 120)}` : ''}`);
    } else {
      appendDeliveryEvent({
        type: 'push.delivered_ack_accepted',
        ...queueEntryDeliveryEventFields(entry),
        deliveredAt,
        status: resp.status,
      });
    }
  } catch (e) {
    appendDeliveryEvent({
      type: 'push.delivered_ack_failed',
      ...queueEntryDeliveryEventFields(entry),
      deliveredAt,
      reason: e.message,
    });
    console.warn(`[push-delivered] notify failed for ${agent}: ${e.message}`);
  }
}

async function fetchUnreadSnapshot(agentName) {
  if (!agentName) return null;
  try {
    const res = await backendFetch(`${BACKEND_V2_URL}/api/inbox/${encodeURIComponent(agentName)}/unread-list?limit=0`);
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
  const sourceMsgId = typeof entry?.notifyMeta?.sourceMsgId === 'string'
    ? entry.notifyMeta.sourceMsgId.trim()
    : '';
  if (sourceMsgId) {
    const unreadIds = new Set();
    const addId = (value) => {
      const id = typeof value === 'string' ? value.trim() : '';
      if (id) unreadIds.add(id);
    };
    const addMsg = (msg) => {
      if (msg && typeof msg === 'object') addId(msg.id);
    };
    if (Array.isArray(snapshot.unread_ids)) {
      for (const id of snapshot.unread_ids) addId(id);
    }
    if (Array.isArray(snapshot.messages)) {
      for (const msg of snapshot.messages) addMsg(msg);
    }
    if (Array.isArray(snapshot.unread)) {
      for (const msg of snapshot.unread) addMsg(msg);
    }
    if (unreadIds.size > 0) return !unreadIds.has(sourceMsgId);
    if (unreadTotal === 1 && snapshot.latest && typeof snapshot.latest === 'object') {
      const latestId = typeof snapshot.latest.id === 'string' ? snapshot.latest.id.trim() : '';
      if (latestId) return latestId !== sourceMsgId;
    }
  }
  const recordedUnread = Number(entry?.notifyMeta?.unreadCount || 0);
  // If unread has dropped since this notification was queued, the queued count is stale.
  // Drop and wait for a fresh notification based on current unread state.
  if (recordedUnread > 0 && unreadTotal < recordedUnread) return true;
  return false;
}

function deliveryResultOk(result) {
  return result === true || result?.ok === true;
}

function deliveryResultPartial(result) {
  return result?.ok === false && result.partial === true;
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
  for (const entry of entries) {
    appendDeliveryEvent({
      type: 'queue.dropped',
      ...queueEntryDeliveryEventFields(entry),
      target,
      reason,
    });
  }
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
function writeQueueFileAtomic(payload) {
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, QUEUE_FILE);
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    console.debug(`[server] queue save skipped: ${e.message}`);
    return false;
  }
}

function saveQueue() {
  const items = [];
  for (const [, entries] of queue) items.push(...entries);
  return writeQueueFileAtomic({ idCounter: queueIdCounter, items });
}

function appendQueuePersistFailedEvent(entry, reason, context = {}) {
  appendDeliveryEvent({
    type: 'queue.persist_failed',
    ...queueEntryDeliveryEventFields(entry || {}),
    reason,
    context,
  });
}

function backupUnreadableQueueFile(error) {
  if (!existsSync(QUEUE_FILE)) return;
  const backupPath = `${QUEUE_FILE}.corrupt-${Date.now()}`;
  try {
    renameSync(QUEUE_FILE, backupPath);
    console.warn(`[server] backed up unreadable queue file: ${backupPath}`);
  } catch (backupError) {
    console.warn(`[server] failed to back up unreadable queue file after ${error?.message || 'load error'}: ${backupError.message}`);
  }
}

// Load queue from disk on startup
try {
  const raw = await readFileAsync(QUEUE_FILE, 'utf-8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('invalid queue file shape');
  }
  queueIdCounter = Number.isFinite(Number(data.idCounter)) ? Number(data.idCounter) : 0;
  let recoveredDelivering = 0;
  let discardedTerminal = 0;
  for (const entry of data.items) {
    if (!entry || typeof entry !== 'object' || !entry.to) continue;
    if (QUEUE_DELIVERY_TERMINAL_STATES.has(entry.deliveryState)) {
      discardedTerminal++;
      continue;
    }
    if (entry.deliveryState === 'delivering') {
      resetQueueEntryDeliveryState(entry);
      recoveredDelivering++;
    }
    if (!queue.has(entry.to)) queue.set(entry.to, []);
    queue.get(entry.to).push(entry);
  }
  const compacted = compactReminderQueue();
  const normalized = normalizeReminderQueue();
  if (compacted.changed || normalized || recoveredDelivering > 0 || discardedTerminal > 0) {
    saveQueue();
    if (compacted.changed) {
      console.log(`Compacted reminder queue entries on load: merged ${compacted.mergedEntries}`);
    }
    if (normalized) {
      console.log('Normalized reminder queue payloads on load');
    }
    if (recoveredDelivering > 0) {
      console.log(`Recovered ${recoveredDelivering} in-flight queued message(s) on load`);
    }
    if (discardedTerminal > 0) {
      console.log(`Discarded ${discardedTerminal} terminal queued message marker(s) on load`);
    }
  }
  console.log(`Restored ${data.items?.length || 0} queued messages from disk`);
} catch (e) {
  if (e?.code !== 'ENOENT') backupUnreadableQueueFile(e);
  console.debug(`[server] queue load skipped: ${e.message}`);
}

// Accept queued message from agent-send
app.post('/api/queue', (req, res) => {
  const { from, to, payload } = req.body;
  if (!to || !payload) return res.status(400).json({ error: 'missing to or payload' });
  const rollback = snapshotQueueState();
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
  const superseded = [];
  if (isBackendNotificationEntry(entry)) {
    // Keep only the latest backend notification per target to avoid stale prompts.
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (isBackendNotificationEntry(bucket[i])) superseded.push(...bucket.splice(i, 1));
    }
  }
  bucket.push(entry);
  if (!saveQueue()) {
    restoreQueueState(rollback);
    appendQueuePersistFailedEvent(entry, 'queue-accept-save-failed', { path: 'api' });
    return res.status(500).json({ ok: false, error: 'queue persistence failed' });
  }
  broadcastQueue();
  appendDeliveryEvent({
    type: 'queue.accepted',
    ...queueEntryDeliveryEventFields(entry),
    path: 'api',
    context: {
      from: entry.from,
      position: bucket.length,
      redirectedFrom: redirectedFrom || null,
    },
  });
  for (const oldEntry of superseded) {
    appendDeliveryEvent({
      type: 'queue.superseded',
      ...queueEntryDeliveryEventFields(oldEntry),
      reason: 'superseded-backend-notification',
      context: { supersededByQueueEntryId: id },
    });
  }
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
      const rollback = snapshotQueueState();
      const [entry] = entries.splice(idx, 1);
      if (entry.deliveryState) {
        entries.splice(idx, 0, entry);
        return res.status(409).json({ ok: false, error: 'delivery in progress', id });
      }
      if (entries.length === 0) queue.delete(target);
      if (!saveQueue()) {
        restoreQueueState(rollback);
        appendQueuePersistFailedEvent(entry, 'queue-delete-save-failed', { path: 'api', target });
        return res.status(500).json({ ok: false, error: 'queue persistence failed' });
      }
      appendDeliveryEvent({
        type: 'queue.canceled',
        ...queueEntryDeliveryEventFields(entry),
        target,
        reason: 'operator-delete',
      });
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
      const entry = entries[idx];
      if (entry.deliveryState || delivering.has(target)) {
        return res.status(409).json({ ok: false, delivered: id, requeued: true, reason: 'already-delivering' });
      }
      delivering.add(target);
      try {
        if (!claimQueueEntryForDelivery(entry, target, 'manual')) {
          return res.status(503).json({ ok: false, delivered: id, requeued: true, reason: 'queue-persist-failed' });
        }
        if (await isStaleNotificationEntry(entry)) {
          const finalized = finalizeQueueEntryAfterSideEffect(entry, target, 'dropped', 'queue-stale-drop-save-failed', { path: 'manual', target });
          if (!finalized.ok) {
            return res.status(503).json({ ok: false, delivered: id, requeued: true, reason: finalized.reason });
          }
          archiveDroppedQueueEntries([entry], 'stale-notification-manual-send', target);
          return res.json({ ok: true, dropped: id, reason: 'stale-notification' });
        }
        const result = await deliverMessage(entry);
        if (!deliveryResultOk(result)) {
          if (deliveryResultPartial(result)) {
            const finalized = finalizeQueueEntryAfterSideEffect(entry, target, 'partial', 'queue-partial-save-failed', { path: 'manual', target, stage: result.stage || 'unknown' });
            if (!finalized.ok) {
              return res.status(503).json({
                ok: false,
                delivered: id,
                requeued: false,
                reason: finalized.reason,
                stage: result.stage || 'unknown',
              });
            }
            archiveDroppedQueueEntries([entry], 'partial-delivery-manual-send', target);
            return res.status(409).json({
              ok: false,
              delivered: id,
              requeued: false,
              reason: 'partial-delivery',
              stage: result.stage || 'unknown',
            });
          }
          // Keep behavior consistent with poll loop: failed delivery is retriable, not lost.
          persistQueueEntryQueued(entry, 'queue-requeue-save-failed', { path: 'manual', target });
          return res.status(503).json({ ok: false, delivered: id, requeued: true, reason: 'deliver-failed' });
        }
        const finalized = finalizeQueueEntryAfterSideEffect(entry, target, 'delivered', 'queue-delivered-save-failed', { path: 'manual', target });
        if (!finalized.ok) {
          return res.status(503).json({ ok: false, delivered: id, requeued: true, reason: finalized.reason });
        }
        return res.json({ ok: true, delivered: id });
      } finally {
        delivering.delete(target);
      }
    }
  }
  res.status(404).json({ error: 'not found' });
});

// Debug: expose idle state for all tracked panes
app.get('/api/idle', (_req, res) => {
  const result = {};
  for (const [target, snap] of paneSnapshots) {
    result[target] = getPaneSnapshotDebug(target, snap);
  }
  res.json(result);
});

// ── All agents (for config page agent management) ───────────────────
app.get('/api/agents/all', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

// ── Agent status (for dashboard monitor) ─────────────────────────────
app.get('/api/agents/status', async (_req, res) => {
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents`);
    if (!r.ok) throw new Error(`backend status ${r.status}`);
    const agentPayload = await r.json().catch(() => []);
    const agentList = Array.isArray(agentPayload)
      ? agentPayload.filter(a => a && typeof a === 'object')
      : [];
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

async function runProvisionForManifest(manifest, localMeta = null, options = {}) {
  const { args, homeRoot } = buildProvisionArgsForManifest(manifest, localMeta, options);
  const { stdout = '' } = await execFileAsyncImpl(process.execPath, args, {
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
                if (childCmd.includes('octos')) return 'octos';
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

installSubconsciousProxyRoutes(app, { backendBaseUrl: BACKEND_V2_URL, backendFetch });

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
    const alreadyAbsent = suppressRes.status === 404;
    if (!suppressRes.ok && !alreadyAbsent) return res.status(suppressRes.status).json(suppressData);

    const queueDrop = dropQueuedBackendNotificationsBySource(name, msgId, 'message-canceled');
    res.json({
      ok: true,
      canceled: { agent: name, message: msgId },
      already_absent: alreadyAbsent,
      queue_removed: queueDrop.removed,
      queue_remove_failed: queueDrop.persistFailed,
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
  const result = dropQueuedBackendNotificationsBySource(name, null, 'agent-notifications-cleared');
  if (result.persistFailed) {
    return res.status(503).json({ ok: false, agent: name, removed: 0, error: 'queue persistence failed' });
  }
  return res.json({ ok: true, agent: name, removed: result.removed });
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

app.post('/api/agents/create', async (req, res) => {
  const body = req.body || {};
  if (!body.name || !/^[\w\-]+$/.test(body.name)) return res.status(400).json({ error: 'invalid agent name' });
  try {
    const check = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(body.name)}`);
    if (check.ok) {
      const existing = await check.json();
      if (existing && existing.name) {
        return res.status(409).json({ error: 'agent already exists' });
      }
    }
  } catch {}
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'backend unreachable', detail: e.message });
  }
});

app.post('/api/agents/:name/start', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const r = await backendFetch(`${BACKEND_V2_URL}/api/agents/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(data);
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
    provisionPayload = await runProvisionForManifest(manifest, localMeta, {
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
    provisionPayload = await runProvisionForManifest(manifest, localMeta);
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
    const { stdout = '' } = await execFileAsyncImpl(AGENT_DOWN_BIN, [name, '--kill'], {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_PROXY: '*' },
    });
    const outputTail = toTail(stdout, 20);
    return res.json({ ok: true, action: 'agent-down-kill', outputTail });
  } catch (e) {
    const stdout = String(e?.stdout || '');
    const stderr = String(e?.stderr || e?.message || '');
    const detail = toTail(`${stdout}\n${stderr}`, 40);
    try {
      await execFileAsyncImpl('tmux', ['kill-session', '-t', name], {
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

installTaskProxyRoutes(app, { backendBaseUrl: BACKEND_V2_URL, backendFetch });
installSupervisorProxyRoutes(app, { backendBaseUrl: BACKEND_V2_URL, backendFetch });
installSubconsciousEventProxyRoutes(app, { backendBaseUrl: BACKEND_V2_URL, backendFetch });

// SSE for queue updates (reuse existing SSE clients, send typed events)
function queueSnapshot() {
  const items = [];
  for (const [, entries] of queue) items.push(...entries);
  items.sort((a, b) => a.queuedAt - b.queuedAt);
  // Attach live idle info per item
  return items.map((item) => {
    const observation = getTargetObservation(item.to);
    return {
      ...item,
      targetIdleMs: observation.idleMs ?? -1,
      targetObservation: observation,
    };
  });
}

function broadcastQueue() {
  const items = queueSnapshot();
  const frame = `event: queue\ndata: ${JSON.stringify(items)}\n\n`;
  broadcastSseFrame(frame);
}

// Content-based idle detection: compare pane snapshots.
// window_activity is unreliable (status bar / cursor refreshes count as activity).
// Observation states are explicit so unknown/capture-failed targets are not
// treated as confirmed missing panes.
const paneSnapshots = new Map(); // target -> observation record
let lastPaneListObservation = {
  ok: false,
  at: 0,
  livePanes: new Set(),
  reason: 'not-swept',
};

import { createHash } from 'crypto';

function formatPaneObservationError(e) {
  const stderr = (e && e.stderr) ? String(e.stderr).trim() : '';
  const stdout = (e && e.stdout) ? String(e.stdout).trim() : '';
  if (stderr) return stderr;
  if (stdout) return stdout;
  return e?.message || 'unknown error';
}

async function capturePaneActivityAsync(target) {
  try {
    const { stdout } = await execFileAsyncImpl(
      'tmux', ['capture-pane', '-t', target, '-p'],
      { encoding: 'utf-8', timeout: 3000 }
    );
    const text = String(stdout || '');
    return {
      hash: createHash('md5').update(text).digest('hex'),
      busy: detectPaneBusyState(text).busy,
    };
  } catch (e) {
    return {
      ok: false,
      reason: formatPaneObservationError(e),
    };
  }
}

async function snapshotPaneActivityAsync(target) {
  const snapshot = await capturePaneActivityAsync(target);
  if (snapshot?.ok === false) return null;
  return snapshot;
}

async function snapshotPaneAsync(target) {
  const snapshot = await snapshotPaneActivityAsync(target);
  return snapshot?.hash || null;
}

async function updatePaneSnapshot(target) {
  const snapshot = await capturePaneActivityAsync(target);
  const now = Date.now();
  if (snapshot?.ok === false) {
    paneSnapshots.set(target, {
      state: 'capture-failed',
      target,
      hash: null,
      changedAt: null,
      observedAt: now,
      busy: null,
      reason: snapshot.reason || 'capture-failed',
    });
    return;
  }
  const prev = paneSnapshots.get(target);
  const changedAt = (!prev || prev.state !== 'observed' || prev.hash !== snapshot.hash)
    ? now
    : prev.changedAt;
  paneSnapshots.set(target, {
    state: 'observed',
    target,
    hash: snapshot.hash,
    changedAt,
    observedAt: now,
    busy: snapshot.busy,
    reason: null,
  });
}

function findPaneObservation(target) {
  let prev = paneSnapshots.get(target);
  let observedTarget = target;
  if (!prev) {
    for (const [key, snap] of paneSnapshots) {
      if (key.startsWith(target + ':')) {
        prev = snap;
        observedTarget = key;
        break;
      }
    }
  }
  return { observation: prev || null, observedTarget };
}

function livePanesContainTarget(target) {
  const livePanes = lastPaneListObservation.livePanes;
  if (!livePanes || livePanes.size === 0) return false;
  if (livePanes.has(target)) return true;
  for (const key of livePanes) {
    if (key.startsWith(target + ':')) return true;
  }
  return false;
}

function buildTargetObservation(target) {
  const now = Date.now();
  const { observation, observedTarget } = findPaneObservation(target);
  if (observation?.state === 'observed') {
    const idleMs = observation.busy ? 0 : Math.max(0, now - Number(observation.changedAt || now));
    const active = observation.busy || idleMs < IDLE_THRESHOLD;
    return {
      target,
      observedTarget,
      state: active ? 'active' : 'idle',
      idleMs,
      idleSec: Math.floor(idleMs / 1000),
      observedAt: Number(observation.observedAt || 0) || null,
      busy: observation.busy === true,
      reason: null,
    };
  }
  if (observation?.state === 'capture-failed') {
    return {
      target,
      observedTarget,
      state: 'capture-failed',
      idleMs: null,
      idleSec: null,
      observedAt: Number(observation.observedAt || 0) || null,
      busy: null,
      reason: observation.reason || 'capture-failed',
    };
  }
  if (observation?.state === 'pane-missing') {
    return {
      target,
      observedTarget,
      state: 'pane-missing',
      idleMs: null,
      idleSec: null,
      observedAt: Number(observation.observedAt || 0) || null,
      busy: null,
      reason: observation.reason || 'pane-missing',
    };
  }
  if (lastPaneListObservation.ok) {
    if (livePanesContainTarget(target)) {
      return {
        target,
        observedTarget: target,
        state: 'untracked',
        idleMs: null,
        idleSec: null,
        observedAt: lastPaneListObservation.at || null,
        busy: null,
        reason: 'not-captured',
      };
    }
    return {
      target,
      observedTarget: target,
      state: 'pane-missing',
      idleMs: null,
      idleSec: null,
      observedAt: lastPaneListObservation.at || null,
      busy: null,
      reason: 'list-panes-missing',
    };
  }
  if (lastPaneListObservation.at > 0) {
    return {
      target,
      observedTarget: target,
      state: 'list-failed',
      idleMs: null,
      idleSec: null,
      observedAt: lastPaneListObservation.at,
      busy: null,
      reason: lastPaneListObservation.reason || 'list-panes-failed',
    };
  }
  return {
    target,
    observedTarget: target,
    state: 'untracked',
    idleMs: null,
    idleSec: null,
    observedAt: null,
    busy: null,
    reason: 'not-swept',
  };
}

function getTargetObservation(target) {
  if (typeof target !== 'string' || !target) {
    return {
      target,
      observedTarget: target,
      state: 'untracked',
      idleMs: null,
      idleSec: null,
      observedAt: null,
      busy: null,
      reason: 'invalid-target',
    };
  }
  return buildTargetObservation(target);
}

function getPaneIdleMs(target) {
  const observation = getTargetObservation(target);
  if (observation.state === 'active' || observation.state === 'idle') {
    return Number(observation.idleMs) || 0;
  }
  return -1;
}

function markPaneMissing(target, observedAt) {
  paneSnapshots.set(target, {
    state: 'pane-missing',
    target,
    hash: null,
    changedAt: null,
    observedAt,
    busy: null,
    reason: 'list-panes-missing',
  });
}

function getPaneSnapshotDebug(target, snap) {
  const observation = getTargetObservation(target);
  const row = {
    state: observation.state,
    idleMs: observation.idleMs ?? -1,
    idleSec: observation.idleSec ?? -1,
    observedAt: observation.observedAt,
    reason: observation.reason,
  };
  if (snap?.hash) row.hash = snap.hash.slice(0, 8);
  return row;
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
    const sweepAt = Date.now();
    lastPaneListObservation = {
      ok: true,
      at: sweepAt,
      livePanes,
      reason: null,
    };
    // Skip panes belonging to offline agents
    const activePanes = [...livePanes].filter(pane => {
      const sessionName = pane.split(':')[0];
      return !offlineAgentSessions.has(sessionName);
    });
    await Promise.all(activePanes.map((pane) => updatePaneSnapshot(pane)));
    // Mark stale snapshots as confirmed missing only after list-panes succeeds.
    for (const key of paneSnapshots.keys()) {
      if (!livePanes.has(key)) markPaneMissing(key, sweepAt);
    }
  } catch (e) {
    lastPaneListObservation = {
      ok: false,
      at: Date.now(),
      livePanes: lastPaneListObservation.livePanes || new Set(),
      reason: formatPaneObservationError(e),
    };
  } finally {
    paneSnapshotSweepRunning = false;
  }
}

installAlertProxyRoutes(app, { backendBaseUrl: BACKEND_V2_URL, backendFetch });

// Backend SSE consumer — forward alert events to dashboard clients
const ALERT_SSE_EVENTS = new Set(['alert_created', 'alert_updated', 'alert_resolved', 'alert_deleted', 'message', 'task_created', 'task_updated', 'task_deleted']);
let backendSSEAbort = null;
async function connectBackendSSE() {
  if (!runtimeLoopsStarted) return;
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
            broadcastSseFrame(frame);
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
  if (backendSSEAbort === ac) backendSSEAbort = null;
  if (runtimeLoopsStarted) trackRuntimeTimeout(connectBackendSSE, 5000);
}

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
      appendDeliveryEvent({
        type: 'tmux.delivery_failed',
        ...queueEntryDeliveryEventFields(entry),
        stage: 'payload',
        reason: formatExecError(e),
      });
      console.error(`Failed to deliver to ${entry.to} (payload step): ${formatExecError(e)}`);
      return { ok: false, stage: 'payload', partial: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await execFileAsyncImpl('tmux', ['send-keys', '-t', entry.to, 'C-m'], { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      appendDeliveryEvent({
        type: 'tmux.delivery_partial',
        ...queueEntryDeliveryEventFields(entry),
        stage: 'enter',
        reason: formatExecError(e),
      });
      console.error(`Failed to deliver to ${entry.to} (enter step): ${formatExecError(e)}`);
      return { ok: false, stage: 'enter', partial: true };
    }

    // Log to messages.jsonl
    const deliveredAt = Date.now();
    const logData = { ts: deliveredAt, from: entry.from, to: entry.to, payload: entry.payload };
    if (entry.notifyMeta) logData.notifyMeta = entry.notifyMeta;
    const logEntry = JSON.stringify(logData);
    appendFile(LOG_FILE, logEntry + '\n').catch(() => {});
    appendDeliveryEvent({
      type: 'tmux.delivered',
      ...queueEntryDeliveryEventFields(entry),
      deliveredAt,
    });
    void notifyPushDelivered(entry, deliveredAt);
    return { ok: true, deliveredAt };
  } catch (e) {
    console.error(`Failed to deliver to ${entry.to} (unexpected):`, e?.message || e);
    return { ok: false, stage: 'unexpected', partial: false };
  }
}

// Track delivery state per target: don't re-check until previous delivery settles
const delivering = new Set();

// Poll loop
async function processQueueTick() {
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
            const rollback = snapshotQueueState();
            if (kept.length === 0) {
              queue.delete(target);
              if (!saveQueue()) {
                restoreQueueState(rollback);
                appendQueuePersistFailedEvent(dropped[0], 'queue-stale-drop-save-failed', { path: 'poll', target });
                continue;
              }
              archiveDroppedQueueEntries(dropped, 'stale-notification-unread-changed', target);
              broadcastQueue();
              continue;
            }
            queue.set(target, kept);
            entries = kept;
            if (!saveQueue()) {
              restoreQueueState(rollback);
              appendQueuePersistFailedEvent(dropped[0], 'queue-stale-drop-save-failed', { path: 'poll', target });
              continue;
            }
            archiveDroppedQueueEntries(dropped, 'stale-notification-unread-changed', target);
            broadcastQueue();
          }
        }
      }

      const targetObservation = getTargetObservation(target);
      const idleMs = targetObservation.idleMs ?? -1;
      const priority = normalizeQueuePriority(entries[0]?.priority || entries[0]?.notifyMeta?.priority);
      const bypassIdleGate = priority === 'urgent';
      if (targetObservation.state !== 'active' && targetObservation.state !== 'idle') {
        // Only confirmed pane-missing can trim stale backend notifications.
        if (targetObservation.state !== 'pane-missing') continue;
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
            const rollback = snapshotQueueState();
            if (kept.length === 0) queue.delete(target);
            else queue.set(target, kept);
            if (!saveQueue()) {
              restoreQueueState(rollback);
              appendQueuePersistFailedEvent(dropped[0], 'queue-pane-missing-drop-save-failed', { path: 'poll', target });
              continue;
            }
            archiveDroppedQueueEntries(dropped, 'pane-missing-over-5m', target);
            broadcastQueue();
          }
        }
        continue;
      }
      if (!bypassIdleGate && idleMs < IDLE_THRESHOLD) continue; // not idle enough

      // Deliver first message
      delivering.add(target);
      const entry = entries[0];
      if (!entry || entry.deliveryState === 'delivering') {
        delivering.delete(target);
        continue;
      }
      if (!claimQueueEntryForDelivery(entry, target, 'poll', {
        targetObservation,
        idleMs,
        bypassIdleGate,
      })) {
        delivering.delete(target);
        continue;
      }

      const stale = unreadSnapshot && isBackendNotificationEntry(entry)
        ? isStaleNotificationBySnapshot(entry, unreadSnapshot)
        : await isStaleNotificationEntry(entry);
      if (stale) {
        console.log(`[queue] Dropped stale notification ${entry.id} for ${target}`);
        const finalized = finalizeQueueEntryAfterSideEffect(entry, target, 'dropped', 'queue-stale-drop-save-failed', {
          path: 'poll',
          target,
          targetObservation,
          idleMs,
          bypassIdleGate,
        });
        if (!finalized.ok) {
          delivering.delete(target);
          continue;
        }
        archiveDroppedQueueEntries([entry], 'stale-notification-on-deliver', target);
        delivering.delete(target);
        continue;
      }

      const result = await deliverMessage(entry);
      if (!deliveryResultOk(result) && entry) {
        if (deliveryResultPartial(result)) {
          const finalized = finalizeQueueEntryAfterSideEffect(entry, target, 'partial', 'queue-partial-save-failed', {
            path: 'poll',
            target,
            stage: result.stage || 'unknown',
          });
          if (!finalized.ok) {
            delivering.delete(target);
            continue;
          }
          archiveDroppedQueueEntries([entry], `partial-delivery-${result.stage || 'unknown'}`, target);
          trackRuntimeTimeout(() => delivering.delete(target), IDLE_THRESHOLD + 2000);
          continue;
        }
        persistQueueEntryQueued(entry, 'queue-requeue-save-failed', { path: 'poll', target });
      } else if (entry) {
        finalizeQueueEntryAfterSideEffect(entry, target, 'delivered', 'queue-delivered-save-failed', { path: 'poll', target });
      }
      // Wait a bit before allowing next delivery to same target
      trackRuntimeTimeout(() => delivering.delete(target), IDLE_THRESHOLD + 2000);
    }
    // Broadcast updated idle times to frontend while queue is non-empty
    if (queue.size > 0) broadcastQueue();
  } finally {
    queueTickRunning = false;
  }
}

// ── Delayed Reminders ────────────────────────────────────────────────
const REMINDER_FILE = path.join(LOGS_ROOT, 'reminders.json');
const reminders = []; // Array<{id, target, msg, createdAt, fireAt}>
let reminderIdCounter = 0;

function snapshotReminderState() {
  return {
    idCounter: reminderIdCounter,
    items: reminders.map((item) => cloneJsonPlain(item)),
  };
}

function restoreReminderState(snapshot) {
  if (!snapshot) return;
  reminderIdCounter = snapshot.idCounter;
  reminders.splice(0, reminders.length, ...snapshot.items.map((item) => cloneJsonPlain(item)));
}

function writeReminderFileAtomic(payload) {
  const tmp = `${REMINDER_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(REMINDER_FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, REMINDER_FILE);
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    console.debug(`[server] reminders save skipped: ${e.message}`);
    return false;
  }
}

function saveReminders() {
  return writeReminderFileAtomic({ idCounter: reminderIdCounter, items: reminders });
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
  broadcastSseFrame(frame);
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

function processDueReminders() {
  const now = Date.now();
  let changed = false;
  const reminderRollback = snapshotReminderState();
  const queueRollback = snapshotQueueState();
  const due = [];
  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].fireAt <= now) {
      due.push(cloneJsonPlain(reminders[i]));
      fireReminder(reminders[i]);
      reminders.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    if (!saveQueue()) {
      restoreQueueState(queueRollback);
      restoreReminderState(reminderRollback);
      appendQueuePersistFailedEvent(null, 'due-reminder-queue-save-failed', { path: 'reminder-tick', dueCount: due.length });
      broadcastReminders();
      broadcastQueue();
      return;
    }
    if (!saveReminders()) {
      restoreQueueState(queueRollback);
      restoreReminderState(reminderRollback);
      if (!saveQueue()) {
        appendQueuePersistFailedEvent(null, 'due-reminder-queue-rollback-save-failed', { path: 'reminder-tick', dueCount: due.length });
      }
      appendQueuePersistFailedEvent(null, 'due-reminder-reminder-save-failed', { path: 'reminder-tick', dueCount: due.length });
      broadcastReminders();
      broadcastQueue();
      return;
    }
    broadcastReminders();
    broadcastQueue();
  }
  // Periodically broadcast remaining times while reminders exist
  if (reminders.length > 0) broadcastReminders();
}

// POST /api/reminders — create a reminder
app.post('/api/reminders', (req, res) => {
  const { target, delay, msg } = req.body;
  if (!target || !delay || !msg) return res.status(400).json({ error: 'missing target, delay, or msg' });
  const delaySec = Number(delay);
  if (isNaN(delaySec) || delaySec <= 0) return res.status(400).json({ error: 'delay must be positive number (seconds)' });
  const rollback = snapshotReminderState();
  const now = Date.now();
  const id = ++reminderIdCounter;
  const reminder = { id, target, msg, createdAt: now, fireAt: now + delaySec * 1000 };
  reminders.push(reminder);
  if (!saveReminders()) {
    restoreReminderState(rollback);
    appendQueuePersistFailedEvent(null, 'reminder-create-save-failed', { path: 'api', reminderId: id, target });
    return res.status(500).json({ ok: false, error: 'reminder persistence failed' });
  }
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
  const rollback = snapshotReminderState();
  reminders.splice(idx, 1);
  if (!saveReminders()) {
    restoreReminderState(rollback);
    appendQueuePersistFailedEvent(null, 'reminder-delete-save-failed', { path: 'api', reminderId: id });
    return res.status(500).json({ ok: false, error: 'reminder persistence failed' });
  }
  broadcastReminders();
  res.json({ ok: true, deleted: id });
});

// ── Dashboard pages ─────────────────────────────────────────────────
installDashboardPageRoutes(app, { idleThreshold: IDLE_THRESHOLD, idleThresholdSec: IDLE_THRESHOLD_SEC });

function startRuntimeLoops() {
  if (runtimeLoopsStarted) return;
  runtimeLoopsStarted = true;
  trackRuntimeInterval(() => { void pollMessageLogTail(); }, 500);
  trackRuntimeInterval(() => { void sweepPaneSnapshots(); }, 2000);
  trackRuntimeInterval(() => { void processQueueTick(); }, POLL_INTERVAL);
  trackRuntimeInterval(() => { processDueReminders(); }, 1000);
  void connectBackendSSE();
}

function stopRuntimeLoops() {
  runtimeLoopsStarted = false;
  clearRuntimeHandles();
  if (backendSSEAbort) {
    try { backendSSEAbort.abort(); } catch {}
    backendSSEAbort = null;
  }
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();
  delivering.clear();
}

let serverInstance = null;
function startServer({ port = PORT, host = '127.0.0.1' } = {}) {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(port, host, () => {
    console.log(`agent-viz running on http://${host}:${port}`);
  });
  startRuntimeLoops();
  return serverInstance;
}

function stopServer() {
  stopRuntimeLoops();
  if (!serverInstance) return;
  const active = serverInstance;
  serverInstance = null;
  active.close();
}

function setServerTestHooks({
  execFileAsync: overrideExecFileAsync,
  backendFetch: overrideBackendFetch,
  dashboardRequestLocal: overrideDashboardRequestLocal,
} = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : execFileAsync;
  backendFetchTransport = typeof overrideBackendFetch === 'function'
    ? overrideBackendFetch
    : defaultBackendFetchTransport;
  dashboardRequestLocalOverride = typeof overrideDashboardRequestLocal === 'function'
    ? overrideDashboardRequestLocal
    : null;
}

function resetServerTestHooks() {
  execFileAsyncImpl = execFileAsync;
  backendFetchTransport = defaultBackendFetchTransport;
  dashboardRequestLocalOverride = null;
}

function addSseClientForTest(client) {
  sseClients.add(client);
  return () => sseClients.delete(client);
}

function getSseClientCountForTest() {
  return sseClients.size;
}

export {
  addSseClientForTest,
  app,
  deliverMessage,
  getSseClientCountForTest,
  getPaneIdleMs,
  getTargetObservation,
  pollMessageLogTail as pollMessageLogTailForTest,
  processDueReminders as processDueRemindersForTest,
  processQueueTick as processQueueTickForTest,
  resetServerTestHooks,
  setServerTestHooks,
  snapshotPaneAsync,
  startServer,
  stopServer,
  sweepPaneSnapshots,
  updatePaneSnapshot,
};

if (process.argv[1] === __filename) {
  enforceStartupConfig({
    serviceName: 'Agent Chat web dashboard',
    optional: SERVER_STARTUP_OPTIONAL_ENV,
  });
  startServer();
}
