/*
 * The tmux delivery queue — lifted whole from the retired web portal's process.
 *
 * WHAT THIS IS. Messages addressed to an agent's tmux pane wait here until the pane is IDLE, then get
 * typed into it (two tmux calls: the payload, then Enter — so a half-delivery is detectable as
 * `partial`). Idle is detected by CONTENT: pane snapshots are hashed and compared, because tmux's
 * window_activity counts a blinking cursor as activity. Reminders (`hafleet reminder`) are scheduled
 * here and merge into one queue entry per target rather than stacking. Backend notifications are
 * deduplicated, superseded, and dropped when the unread state that prompted them has already changed.
 *
 * WHY IT MOVED. The operator retired the old portal (「8084 是旧的 portal,完全没有用了」), but this
 * queue was the one live service on that port: `hafleet send` posts to it and the backend pushes
 * notifications into it. It now runs inside the backend process, which removes three HTTP hops the old
 * topology needed — delivery events, push-delivered acks and unread lookups were all requests from one
 * local process to another, and each is now a function call injected as a sink.
 *
 * SLICED, NOT REWRITTEN. This file was assembled from server.js by anchored extraction; the delivery
 * semantics — idempotency, rollback-on-persist-failure, recovery of in-flight entries after a crash,
 * stale-notification dropping, reminder merging — are the originals, verbatim. The deliberate changes
 * are exactly: module state behind init(), five HTTP calls become sinks, SSE frames go to the injected
 * broadcast, and the redirect CRUD routes are gone (nothing outside the portal ever called them;
 * redirects.json is still LOADED and applied, so an existing file keeps working — it just has to be
 * edited by hand until something needs more).
 *
 * MODULE STATE, LIKE THE STORES AROUND IT. Tests get isolation the same way they get it for
 * backend-v2.js itself: a cache-busted import per context. init() is synchronous so importers are not
 * forced to await construction.
 */
import path from 'path';
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'fs';
import { appendFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { detectPaneBusyState } from './pane-activity.js';

const realExecFileAsync = promisify(execFile);

// ── wiring set by init(); everything below reads these ──────────────────────────────────────────
let LOGS_ROOT = null;
let QUEUE_FILE = null;
let QUEUE_DROPPED_FILE = null;
let REMINDER_FILE = null;
let REDIRECT_FILE = null;
let LOG_FILE = null;
let DELIVERY_EVENT_FILE = null;
let IDLE_THRESHOLD = 20_000;
let POLL_INTERVAL = 1_000;
let REMINDER_MERGE_PREVIEW_LIMIT = 20;
let sinks = {};
let execFileAsyncImpl = realExecFileAsync;

export function setDeliveryQueueHooks({ execFileAsync: overrideExecFileAsync } = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : realExecFileAsync;
}
export function resetDeliveryQueueHooks() {
  execFileAsyncImpl = realExecFileAsync;
}



// Queue: Map<target, Array<{id, from, to, payload, queuedAt}>>
const queue = new Map();
const queueIdempotency = new Map();
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
    idempotency: new Map([...queueIdempotency.entries()].map(([key, value]) => [key, cloneJsonPlain(value)])),
  };
}

function restoreQueueState(snapshot) {
  if (!snapshot) return;
  queueIdCounter = snapshot.idCounter;
  queue.clear();
  for (const [target, entries] of snapshot.buckets.entries()) {
    queue.set(target, entries.map((entry) => cloneJsonPlain(entry)));
  }
  queueIdempotency.clear();
  for (const [key, value] of snapshot.idempotency.entries()) {
    queueIdempotency.set(key, cloneJsonPlain(value));
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
  if (!entry || entry.from !== 'hafleet-backend') return false;
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
    console.debug(`[delivery-queue] delivery event append skipped: ${error.message}`);
  }
  try {
    /*
     * DIRECT, NOT HTTP. server.js POSTed this to the backend's /api/delivery-events; the queue now
     * lives inside that backend, so the sink is the same ingest function without a socket in the
     * middle. The local jsonl append above is kept: it is what several delivery tests read, and a
     * flat file the operator can tail is worth one write.
     */
    sinks.emitDeliveryEvent?.(row);
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
    const resp = await sinks.recordPushDelivered(body);
    if (!resp.ok) {
      const errText = String(resp.errText || '');
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
    // The same snapshot the HTTP route serves, minus the HTTP: one implementation of "what is unread".
    return await sinks.unreadSnapshot(agentName);
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
  let fd = null;
  try {
    const directory = path.dirname(QUEUE_FILE);
    mkdirSync(directory, { recursive: true });
    fd = openSync(tmp, 'w', 0o600);
    writeFileSync(fd, JSON.stringify(payload), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, QUEUE_FILE);
    chmodSync(QUEUE_FILE, 0o600);
    const directoryFd = openSync(directory, 'r');
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
    try { unlinkSync(tmp); } catch {}
    console.debug(`[delivery-queue] queue save skipped: ${e.message}`);
    return false;
  }
}

function saveQueue() {
  const items = [];
  for (const [, entries] of queue) items.push(...entries);
  return writeQueueFileAtomic({
    idCounter: queueIdCounter,
    items,
    idempotencyKeys: [...queueIdempotency.entries()],
  });
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
    console.warn(`[delivery-queue] backed up unreadable queue file: ${backupPath}`);
  } catch (backupError) {
    console.warn(`[delivery-queue] failed to back up unreadable queue file after ${error?.message || 'load error'}: ${backupError.message}`);
  }
}

// Load queue from disk on startup. Sync on purpose: this runs once inside init(), before any
// route or loop exists, and an async init would force every importer to await construction.
function loadPersistedQueue() {
try {
  const raw = readFileSync(QUEUE_FILE, 'utf-8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('invalid queue file shape');
  }
  queueIdCounter = Number.isFinite(Number(data.idCounter)) ? Number(data.idCounter) : 0;
  if (Array.isArray(data.idempotencyKeys)) {
    for (const item of data.idempotencyKeys) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, value] = item;
      if (typeof key !== 'string' || !key || key.length > 255) continue;
      if (!value || typeof value !== 'object' || !Number.isFinite(Number(value.id))) continue;
      queueIdempotency.set(key, cloneJsonPlain(value));
    }
  }
  let recoveredDelivering = 0;
  let suppressedUncertainMatrixWake = 0;
  let discardedTerminal = 0;
  for (const entry of data.items) {
    if (!entry || typeof entry !== 'object' || !entry.to) continue;
    if (QUEUE_DELIVERY_TERMINAL_STATES.has(entry.deliveryState)) {
      discardedTerminal++;
      continue;
    }
    if (entry.deliveryState === 'delivering') {
      const ledger = typeof entry.idempotencyKey === 'string'
        ? queueIdempotency.get(entry.idempotencyKey)
        : null;
      if (ledger && Number(ledger.id) === Number(entry.id)) {
        suppressedUncertainMatrixWake++;
        appendDeliveryEvent({
          type: 'queue.recovery_suppressed',
          ...queueEntryDeliveryEventFields(entry),
          reason: 'idempotent-delivery-outcome-uncertain',
        });
        continue;
      }
      resetQueueEntryDeliveryState(entry);
      recoveredDelivering++;
    }
    if (!queue.has(entry.to)) queue.set(entry.to, []);
    queue.get(entry.to).push(entry);
  }
  const compacted = compactReminderQueue();
  const normalized = normalizeReminderQueue();
  if (compacted.changed || normalized || recoveredDelivering > 0 || suppressedUncertainMatrixWake > 0 || discardedTerminal > 0) {
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
    if (suppressedUncertainMatrixWake > 0) {
      console.log(`Suppressed ${suppressedUncertainMatrixWake} uncertain idempotent wake(s) on load`);
    }
    if (discardedTerminal > 0) {
      console.log(`Discarded ${discardedTerminal} terminal queued message marker(s) on load`);
    }
  }
  console.log(`Restored ${data.items?.length || 0} queued messages from disk`);
} catch (e) {
  if (e?.code !== 'ENOENT') backupUnreadableQueueFile(e);
  console.debug(`[delivery-queue] queue load skipped: ${e.message}`);
}
}

// Accept queued message from hafleet-send

// Get current queue state

// Delete a queued message by id

// Force-send a queued message immediately (skip idle wait)

// Debug: expose idle state for all tracked panes




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
  try { sinks.broadcast?.('queue', queueSnapshot()); } catch { /* observability only */ }
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
    /*
     * The backend decides which sessions belong to offline LOCAL agents — it owns the registry and
     * the definition of "local", so the queue does not re-derive either.
     */
    offlineAgentSessions = await sinks.offlineLocalTmuxSessions();
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


// ── Target redirects (e.g. renamed sessions) ────────────────────────
const redirects = new Map(); // old target → new target

function loadPersistedRedirects() {
try {
  const raw = readFileSync(REDIRECT_FILE, 'utf-8');
  for (const [k, v] of Object.entries(JSON.parse(raw))) redirects.set(k, v);
  console.log(`Loaded ${redirects.size} redirects`);
} catch (e) {
  console.debug(`[delivery-queue] redirects load skipped: ${e.message}`);
}
}

function saveRedirects() {
  try { writeFileSync(REDIRECT_FILE, JSON.stringify(Object.fromEntries(redirects))); } catch (e) {
    console.debug(`[delivery-queue] redirects save skipped: ${e.message}`);
  }
}


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

// Timeouts that release a target's delivery lock. Tracked so stop() can clear them, and unref'd so a
// test process is never held open by a lock that would have released itself.
const pendingTimeouts = new Set();
function trackRuntimeTimeout(callback, ms) {
  const handle = setTimeout(() => {
    pendingTimeouts.delete(handle);
    callback();
  }, ms);
  handle.unref?.();
  pendingTimeouts.add(handle);
  return handle;
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
    console.debug(`[delivery-queue] reminders save skipped: ${e.message}`);
    return false;
  }
}

function saveReminders() {
  return writeReminderFileAtomic({ idCounter: reminderIdCounter, items: reminders });
}

function loadPersistedReminders() {
try {
  const raw = readFileSync(REMINDER_FILE, 'utf-8');
  const data = JSON.parse(raw);
  reminderIdCounter = data.idCounter || 0;
  for (const r of (data.items || [])) reminders.push(r);
  console.log(`Restored ${reminders.length} reminders from disk`);
} catch (e) {
  console.debug(`[delivery-queue] reminders load skipped: ${e.message}`);
}
}

function reminderSnapshot() {
  const now = Date.now();
  return reminders.map(r => ({ ...r, remainingMs: Math.max(0, r.fireAt - now) }));
}

function broadcastReminders() {
  try { sinks.broadcast?.('reminders', reminderSnapshot()); } catch { /* observability only */ }
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

// GET /api/reminders

// DELETE /api/reminders/:id


// ── lifecycle ───────────────────────────────────────────────────────────────────────────────────
let loopHandles = [];
let loopsStarted = false;

export function initDeliveryQueue({
  logsRoot,
  idleThresholdMs,
  pollIntervalMs,
  reminderMergePreviewLimit,
  emitDeliveryEvent,
  recordPushDelivered,
  unreadSnapshot,
  offlineLocalTmuxSessions,
  broadcast,
} = {}) {
  if (!logsRoot) throw new Error('initDeliveryQueue: logsRoot is required');
  LOGS_ROOT = logsRoot;
  QUEUE_FILE = path.join(LOGS_ROOT, 'queue.json');
  QUEUE_DROPPED_FILE = path.join(LOGS_ROOT, 'queue-dropped.jsonl');
  REMINDER_FILE = path.join(LOGS_ROOT, 'reminders.json');
  REDIRECT_FILE = path.join(LOGS_ROOT, 'redirects.json');
  LOG_FILE = path.join(LOGS_ROOT, 'messages.jsonl');
  DELIVERY_EVENT_FILE = path.join(LOGS_ROOT, 'delivery-events.jsonl');
  if (Number.isFinite(idleThresholdMs) && idleThresholdMs > 0) IDLE_THRESHOLD = idleThresholdMs;
  if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) POLL_INTERVAL = pollIntervalMs;
  if (Number.isFinite(reminderMergePreviewLimit) && reminderMergePreviewLimit > 0) {
    REMINDER_MERGE_PREVIEW_LIMIT = reminderMergePreviewLimit;
  }
  /*
   * RESET EVERYTHING BEFORE LOADING, because this module's state is shared in a way its importer's is
   * not. Tests isolate backend-v2.js with a cache-busting query (?test=N), which gives each context a
   * fresh backend — but `import './lib/delivery-queue.js'` inside it resolves to the same canonical URL
   * every time, so THIS module is one instance across all of them. Found as cross-test bleed: an entry
   * queued in one test's context appeared in the next test's freshly-seeded queue, because init() loaded
   * the new runtime dir's files INTO the old Maps instead of over them.
   */
  queue.clear();
  queueIdempotency.clear();
  queueIdCounter = 0;
  delivering.clear();
  reminders.splice(0, reminders.length);
  reminderIdCounter = 0;
  redirects.clear();
  paneSnapshots.clear();
  offlineAgentSessions = new Set();
  offlineAgentCacheTs = 0;
  lastPaneListObservation = { ok: false, at: 0, livePanes: new Set(), reason: 'not-swept' };
  stopDeliveryQueueLoops();
  sinks = {
    emitDeliveryEvent,
    recordPushDelivered: recordPushDelivered ?? (async () => ({ ok: true, status: 200 })),
    unreadSnapshot: unreadSnapshot ?? (async () => null),
    offlineLocalTmuxSessions: offlineLocalTmuxSessions ?? (async () => new Set()),
    broadcast,
  };
  loadPersistedQueue();
  loadPersistedReminders();
  loadPersistedRedirects();
}

/**
 * The ONE enqueue. The HTTP route and the backend's in-process notification push both call this, so
 * there is exactly one semantics for idempotency, redirects, supersession and rollback — the backend
 * pushing directly cannot drift from what `hafleet send` gets.
 *
 * Returns `{ status, body }` rather than touching a response, because one of its two callers has none.
 */
function enqueueFromRequestBody(rawBody = {}, idempotencyKey = '') {
  const { from, to, payload } = rawBody;
  if (!to || !payload) return { status: 400, body: { error: 'missing to or payload' } };
  const existingIdempotentResult = idempotencyKey ? queueIdempotency.get(idempotencyKey) : null;
  if (existingIdempotentResult) {
    return { status: 200, body: { ok: true, ...existingIdempotentResult, deduped: true } };
  }
  const rollback = snapshotQueueState();
  const id = ++queueIdCounter;
  const queuedAt = Date.now();
  const priority = normalizeQueuePriority(rawBody?.priority);
  // Apply redirect if target was renamed
  let actualTo = to;
  let redirectedFrom = null;
  if (redirects.has(to)) {
    actualTo = redirects.get(to);
    redirectedFrom = to;
  }
  const entry = { id, from: from || 'unknown', to: actualTo, payload, queuedAt, priority };
  if (idempotencyKey) entry.idempotencyKey = idempotencyKey;
  const notifyMeta = sanitizeNotifyMeta(rawBody?.notifyMeta);
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
  if (idempotencyKey) {
    queueIdempotency.set(idempotencyKey, {
      id,
      queuedAt,
      position: bucket.length,
      redirected: redirectedFrom || undefined,
    });
  }
  if (!saveQueue()) {
    restoreQueueState(rollback);
    appendQueuePersistFailedEvent(entry, 'queue-accept-save-failed', { path: 'api' });
    return { status: 500, body: { ok: false, error: 'queue persistence failed' } };
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
  return { status: 200, body: { ok: true, id, queuedAt, position: bucket.length, redirected: redirectedFrom || undefined } };
}

export function installDeliveryQueueRoutes(app, { requireMutation = (_req, _res, next) => next() } = {}) {
app.post('/api/queue', requireMutation, (req, res) => {
  const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim()
    : '';
  if (idempotencyKey.length > 255) {
    return res.status(400).json({ error: 'idempotency key must be at most 255 characters' });
  }
  const { status, body } = enqueueFromRequestBody(req.body ?? {}, idempotencyKey);
  return res.status(status).json(body);
});
app.get('/api/queue', (_req, res) => {
  res.json(queueSnapshot());
});
app.delete('/api/queue/:id', requireMutation, (req, res) => {
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
app.post('/api/queue/:id/send', requireMutation, async (req, res) => {
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
app.get('/api/idle', (_req, res) => {
  const result = {};
  for (const [target, snap] of paneSnapshots) {
    result[target] = getPaneSnapshotDebug(target, snap);
  }
  res.json(result);
});
app.delete('/api/queue/agents/:name/notifications', requireMutation, (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const result = dropQueuedBackendNotificationsBySource(name, null, 'agent-notifications-cleared');
  if (result.persistFailed) {
    return res.status(503).json({ ok: false, agent: name, removed: 0, error: 'queue persistence failed' });
  }
  return res.json({ ok: true, agent: name, removed: result.removed });
});
app.post('/api/reminders', requireMutation, (req, res) => {
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
app.get('/api/reminders', (_req, res) => {
  res.json(reminderSnapshot());
});
app.delete('/api/reminders/:id', requireMutation, (req, res) => {
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
}

export function startDeliveryQueueLoops() {
  if (loopsStarted) return;
  loopsStarted = true;
  loopHandles.push(setInterval(() => { void sweepPaneSnapshots(); }, 2000));
  loopHandles.push(setInterval(() => { void processQueueTick(); }, POLL_INTERVAL));
  loopHandles.push(setInterval(() => { processDueReminders(); }, 1000));
  for (const h of loopHandles) h.unref?.();
}

export function stopDeliveryQueueLoops() {
  loopsStarted = false;
  for (const h of loopHandles) clearInterval(h);
  loopHandles = [];
  for (const h of pendingTimeouts) clearTimeout(h);
  pendingTimeouts.clear();
  delivering.clear();
}

// The backend pushes notifications and clears them by source without HTTP; the CLI still uses the
// routes. Both go through the SAME functions, so there is exactly one enqueue semantics.
export {
  deliverMessage,
  dropQueuedBackendNotificationsBySource,
  enqueueFromRequestBody,
  getPaneIdleMs,
  getTargetObservation,
  processDueReminders,
  processQueueTick,
  queueSnapshot,
  reminderSnapshot,
  snapshotPaneAsync,
  sweepPaneSnapshots,
  updatePaneSnapshot,
};
