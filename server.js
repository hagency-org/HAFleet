import express from 'express';
import { readFile as readFileAsync, open, stat as statAsync, appendFile } from 'fs/promises';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import path from 'path';

const PORT = 8084;
const LOG_FILE = path.resolve('logs/messages.jsonl');
const PUSH_DELIVERED_URL = 'http://127.0.0.1:8090/api/runtime/push-delivered';
const DEFAULT_IDLE_THRESHOLD_MS = 20_000;
const envIdleThreshold = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || `${DEFAULT_IDLE_THRESHOLD_MS}`, 10);
const IDLE_THRESHOLD = Number.isFinite(envIdleThreshold) && envIdleThreshold > 0
  ? envIdleThreshold
  : DEFAULT_IDLE_THRESHOLD_MS;
const IDLE_THRESHOLD_SEC = Math.max(1, Math.ceil(IDLE_THRESHOLD / 1000));

// ── Server SSH config for remote tmux capture ────────────────────────
const SERVER_SSH_PATH = path.resolve('data/server-ssh.json');
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
const QUEUE_FILE = path.resolve('logs/queue.json');
const QUEUE_DROPPED_FILE = path.resolve('logs/queue-dropped.jsonl');
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
    requiresInboxCheck: safeBool(rawMeta.requiresInboxCheck),
    sourceMsgId: safeStr(rawMeta.sourceMsgId, null),
    unreadCount: safeInt(rawMeta.unreadCount),
    hasHumanUnread: safeBool(rawMeta.hasHumanUnread),
    hasRequestUnread: safeBool(rawMeta.hasRequestUnread),
    needsReply: safeBool(rawMeta.needsReply),
    hasMcp: safeBool(rawMeta.hasMcp),
  };
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
    const resp = await fetch(PUSH_DELIVERED_URL, {
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
    const res = await fetch(`http://127.0.0.1:8090/api/inbox/${encodeURIComponent(agentName)}/unread`);
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
  } catch {}
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
} catch { /* no queue file or parse error, start fresh */ }

// Accept queued message from agent-send
app.post('/api/queue', (req, res) => {
  const { from, to, payload } = req.body;
  if (!to || !payload) return res.status(400).json({ error: 'missing to or payload' });
  const id = ++queueIdCounter;
  const queuedAt = Date.now();
  // Apply redirect if target was renamed
  let actualTo = to;
  let redirectedFrom = null;
  if (redirects.has(to)) {
    actualTo = redirects.get(to);
    redirectedFrom = to;
  }
  const entry = { id, from: from || 'unknown', to: actualTo, payload, queuedAt };
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
      const ok = deliverMessage(entry);
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
    const r = await fetch('http://127.0.0.1:8090/api/agents');
    const agentList = await r.json();
    const result = agentList
      .filter(a => a.tmux)
      .map(a => {
        const isRemote = a.server && a.server !== 'local';
        const idleMs = getPaneIdleMs(a.tmux);
        const alive = isRemote ? true : idleMs >= 0; // remote agents assumed alive; local checked via tmux
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
          remote: !!isRemote,
          type: a.type || 'agent',
          server: a.server || null,
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

app.get('/api/tmux/capture/:session', (req, res) => {
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
      rawContent = execFileSync(
        'ssh', [
          '-o', 'ConnectTimeout=5',
          '-o', 'StrictHostKeyChecking=accept-new',
          sshConf.host,
          `tmux capture-pane -t ${session} -p -S -500`
        ],
        { encoding: 'utf-8', timeout: 8000 }
      );
    } else {
      // Local capture
      rawContent = execFileSync(
        'tmux', ['capture-pane', '-t', session, '-p', '-S', '-500'],
        { encoding: 'utf-8', timeout: 3000 }
      );
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
const AGENTS_DATA_DIR = path.resolve('data/agents');

app.get('/api/agents/detail/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });

  const detail = { name };

  // From backend-v2
  try {
    const r = await fetch(`http://127.0.0.1:8090/api/agents/${encodeURIComponent(name)}`);
    const agent = await r.json();
    if (!agent.error) {
      detail.identity = agent.identity || null;
      detail.groups = agent.groups || [];
      detail.server = agent.server || null;
      detail.tmux = agent.tmux || null;
    }
  } catch {}

  // From local meta.json
  try {
    const meta = JSON.parse(await readFileAsync(path.join(AGENTS_DATA_DIR, name, 'meta.json'), 'utf-8'));
    detail.agentType = meta.type || null; // claude/codex
    detail.path = meta.path || null;
    detail.model = meta.model || null;
    detail.extraArgs = meta.extraArgs || null;
    detail.lastUp = meta.lastUp || null;
    detail.lastDown = meta.lastDown || null;
  } catch {}

  // From resume-id
  try {
    detail.resumeId = (await readFileAsync(path.join(AGENTS_DATA_DIR, name, 'resume-id'), 'utf-8')).trim();
  } catch { detail.resumeId = null; }

  // Idle info + detect agent type from process if missing
  if (detail.tmux) {
    detail.idleMs = getPaneIdleMs(detail.tmux);
    detail.active = detail.idleMs >= 0 && detail.idleMs < IDLE_THRESHOLD;
    if (!detail.agentType) {
      try {
        const panePid = execFileSync('tmux', ['list-panes', '-t', detail.tmux, '-F', '#{pane_pid}'], { encoding: 'utf-8', timeout: 2000 }).trim();
        if (panePid) {
          const childCmd = execFileSync('ps', ['-o', 'args=', '--ppid', panePid], { encoding: 'utf-8', timeout: 2000 }).toLowerCase();
          if (childCmd.includes('claude')) detail.agentType = 'claude';
          else if (childCmd.includes('codex')) detail.agentType = 'codex';
        }
      } catch {}
    }
  }

  res.json(detail);
});

app.get('/api/agents/:name/unread-messages', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.min(limitRaw, 200) : 50;

  try {
    const r = await fetch(`http://127.0.0.1:8090/api/inbox/${encodeURIComponent(name)}/unread-list?limit=${limit}`);
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
    const suppressRes = await fetch(`http://127.0.0.1:8090/api/messages/${encodeURIComponent(msgId)}/suppress`, {
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
    const r = await fetch(`http://127.0.0.1:8090/api/agents/${encodeURIComponent(name)}`, {
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

app.delete('/api/agents/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try {
    const url = new URL(`http://127.0.0.1:8090/api/agents/${encodeURIComponent(name)}`);
    if (req.query.force === 'true') url.searchParams.set('force', 'true');
    const r = await fetch(url, { method: 'DELETE' });
    const data = await r.json();
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

function snapshotPane(target) {
  try {
    const content = execFileSync(
      'tmux', ['capture-pane', '-t', target, '-p'],
      { encoding: 'utf-8', timeout: 3000 }
    );
    return createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

function updatePaneSnapshot(target) {
  const hash = snapshotPane(target);
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
setInterval(() => {
  try {
    const raw = execFileSync(
      'tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const livePanes = new Set(raw.split('\n').filter(Boolean));
    for (const pane of livePanes) {
      updatePaneSnapshot(pane);
    }
    // Clean up stale snapshots for panes that no longer exist
    for (const key of paneSnapshots.keys()) {
      if (!livePanes.has(key)) paneSnapshots.delete(key);
    }
  } catch {}
}, 2000);

// ── Target redirects (e.g. renamed sessions) ────────────────────────
const REDIRECT_FILE = path.resolve('logs/redirects.json');
const redirects = new Map(); // old target → new target

try {
  const raw = await readFileAsync(REDIRECT_FILE, 'utf-8');
  for (const [k, v] of Object.entries(JSON.parse(raw))) redirects.set(k, v);
  console.log(`Loaded ${redirects.size} redirects`);
} catch {}

function saveRedirects() {
  try { writeFileSync(REDIRECT_FILE, JSON.stringify(Object.fromEntries(redirects))); } catch {}
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

function sleepMs(ms) { execSync(`sleep ${ms / 1000}`); }

// Deliver message to tmux pane (uses execFileSync to avoid shell injection)
function deliverMessage(entry) {
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
      execFileSync('tmux', ['send-keys', '-l', '-t', entry.to, finalPayload], { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      console.error(`Failed to deliver to ${entry.to} (payload step): ${formatExecError(e)}`);
      return false;
    }
    sleepMs(150);
    try {
      execFileSync('tmux', ['send-keys', '-t', entry.to, 'C-m'], { timeout: 5000, stdio: 'pipe' });
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
      if (idleMs < IDLE_THRESHOLD) continue; // not idle enough

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

      const ok = deliverMessage(entry);
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
const REMINDER_FILE = path.resolve('logs/reminders.json');
const reminders = []; // Array<{id, target, msg, createdAt, fireAt}>
let reminderIdCounter = 0;

function saveReminders() {
  try {
    writeFileSync(REMINDER_FILE, JSON.stringify({ idCounter: reminderIdCounter, items: reminders }));
  } catch {}
}

// Load from disk
try {
  const raw = await readFileAsync(REMINDER_FILE, 'utf-8');
  const data = JSON.parse(raw);
  reminderIdCounter = data.idCounter || 0;
  for (const r of (data.items || [])) reminders.push(r);
  console.log(`Restored ${reminders.length} reminders from disk`);
} catch {}

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

// ── Frontend ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(HTML);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-viz running on http://127.0.0.1:${PORT}`);
});

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
.queue-item{padding:10px 14px;border-bottom:1px solid rgba(168,85,247,0.06);transition:background 0.2s}
.queue-item:hover{background:rgba(168,85,247,0.05)}
.queue-item:last-child{border-bottom:none}
.qi-route{font-size:11px;margin-bottom:3px}
.qi-from{color:rgba(0,240,255,0.6)}
.qi-arrow{color:rgba(168,85,247,0.3);margin:0 4px}
.qi-target{color:#a855f7}
.qi-payload{font-size:10px;color:rgba(255,255,255,0.2);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px}
.qi-wait{font-size:10px;color:rgba(168,85,247,0.3);margin-top:3px}
.qi-idle{font-size:10px;margin-top:2px}
.qi-idle-busy{color:rgba(251,191,36,0.5)}
.qi-idle-ready{color:rgba(52,211,153,0.6)}
.qi-idle-warn{color:rgba(248,113,113,0.5)}
.qi-redir{color:rgba(251,191,36,0.5);font-size:9px}
.qi-actions{margin-top:6px;display:flex;gap:6px}
.qi-btn{font-family:inherit;font-size:9px;letter-spacing:1px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid;transition:all .2s;background:transparent}
.qi-btn-send{color:#34d399;border-color:rgba(52,211,153,0.3)}
.qi-btn-send:hover{background:rgba(52,211,153,0.12);border-color:#34d399}
.qi-btn-cancel{color:#f87171;border-color:rgba(248,113,113,0.3)}
.qi-btn-cancel:hover{background:rgba(248,113,113,0.12);border-color:#f87171}

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
.reminder-item{padding:10px 14px;border-bottom:1px solid rgba(251,191,36,0.06);transition:background 0.2s}
.reminder-item:hover{background:rgba(251,191,36,0.05)}
.reminder-item:last-child{border-bottom:none}
.ri-target{font-size:11px;color:#fbbf24}
.ri-msg{font-size:10px;color:rgba(255,255,255,0.25);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px}
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
.monitor-bar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 24px;margin:5px 0 0 0;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:11px;color:rgba(0,240,255,0.4);flex-shrink:0;
}
.monitor-bar-name{color:#00f0ff;font-size:12px;text-shadow:0 0 6px rgba(0,240,255,0.2)}
.monitor-bar-btns{display:flex;gap:6px}
#btn-scroll-bottom,#btn-pause,#btn-speed{
  padding:4px 14px;border-radius:5px;font-family:inherit;font-size:10px;
  letter-spacing:1px;cursor:pointer;
  border:1px solid rgba(0,240,255,0.25);
  background:rgba(0,240,255,0.06);color:#00f0ff;
  transition:all .2s;
}
#btn-scroll-bottom:hover,#btn-pause:hover,#btn-speed:hover{background:rgba(0,240,255,0.15)}
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
.ai-delete-row{margin-top:8px;text-align:right}
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
#agent-info .ai-groups{color:rgba(168,85,247,0.5)}
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
.log-entry .payload{color:rgba(255,255,255,0.3)}

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
  #btn-scroll-bottom,#btn-pause,#btn-speed{padding:3px 10px;font-size:9px}
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
      <div class="monitor-header">AGENT MONITOR</div>
      <div id="agent-buttons-wrap">
        <div id="agent-buttons"><span style="color:rgba(0,240,255,0.2);font-size:10px">loading agents...</span></div>
        <button id="agent-toggle" title="Show all agents">▼ more</button>
      </div>
      <div class="monitor-bar">
        <span class="monitor-bar-name" id="monitor-label">Select an agent to monitor</span>
        <span class="monitor-bar-btns">
          <button id="btn-scroll-bottom" style="display:none">&#8615; BOTTOM</button>
          <button id="btn-speed" style="display:none">10HZ</button>
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
      try { body = await res.json(); } catch {}
      if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.reason) || ('HTTP ' + res.status));
      }
      if (action !== 'send' && monitoredAgent && removed && typeof removed.to === 'string') {
        const targetAgent = String(removed.to).split(':', 1)[0];
        if (targetAgent === monitoredAgent.name) fetchAgentDetail(monitoredAgent.name);
      }
    } catch {
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
  const UNREAD_PANEL_LIMIT = 40;
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
      + '<span class="ai-unread-empty">Loading detail...</span>';
    agentInfoEl.classList.add('visible');
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
      try { agentDetailAbortController.abort(); } catch {}
    }
    const controller = new AbortController();
    agentDetailAbortController = controller;

    if (!options.preserveVisible) {
      agentInfoEl.classList.remove('visible');
    }

    try {
      const [detailRespRaw, unreadRespRaw] = await Promise.allSettled([
        fetch('/api/agents/detail/' + encodeURIComponent(targetName), { signal: controller.signal }),
        fetch('/api/agents/' + encodeURIComponent(targetName) + '/unread-messages?limit=' + UNREAD_PANEL_LIMIT, { signal: controller.signal }),
      ]);

      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      if (detailRespRaw.status !== 'fulfilled') return;
      const res = detailRespRaw.value;
      if (!res.ok) return;
      const d = await res.json();
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      let unreadData = { unread_total: 0, unread_returned: 0, unread_omitted: 0, messages: [] };
      try {
        if (unreadRespRaw.status === 'fulfilled' && unreadRespRaw.value.ok) {
          const payload = await unreadRespRaw.value.json();
          if (payload && typeof payload === 'object') unreadData = payload;
        }
      } catch {}
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
      const parts = [];
      // Type tag
      if (d.agentType) {
        const cls = d.agentType === 'claude' ? 'ai-tag-claude' : 'ai-tag-codex';
        parts.push('<span class="ai-tag ' + cls + '">' + esc(d.agentType.toUpperCase()) + '</span>');
      }
      // Active tag
      parts.push('<span class="ai-tag ' + (activeNow ? 'ai-tag-active' : 'ai-tag-inactive') + '" id="ai-runtime-state">'
        + esc(runtimeStatusText(activeNow, activeDurationSec, idleDurationSec)) + '</span>');
      parts.push('<br>');
      // Identity (editable)
      parts.push('<div class="ai-identity-row"><span class="ai-identity" id="ai-identity-text">'
        + esc(d.identity || '(no identity)')
        + '</span><button class="ai-identity-edit" onclick="editIdentity()" title="Edit identity">&#9998;</button></div>');
      // Path
      if (d.path) parts.push('<span class="ai-label">path</span><span class="ai-val">' + esc(d.path) + '</span><br>');
      // Resume ID
      if (d.resumeId) parts.push('<span class="ai-label">resume</span><span class="ai-val">' + esc(d.resumeId) + '</span><br>');
      // Server
      if (d.server) parts.push('<span class="ai-label">server</span><span class="ai-val">' + esc(d.server) + '</span>');
      // Model / extra args
      if (d.model) parts.push(' <span class="ai-label">model</span><span class="ai-val">' + esc(d.model) + '</span>');
      if (d.extraArgs) parts.push(' <span class="ai-label">args</span><span class="ai-val">' + esc(d.extraArgs) + '</span>');
      if (d.server || d.model || d.extraArgs) parts.push('<br>');
      // Groups
      if (d.groups && d.groups.length) {
        parts.push('<span class="ai-label">groups</span><span class="ai-groups">' + d.groups.map(g => esc(g)).join(', ') + '</span>');
      }
      parts.push('<div class="ai-unread-wrap">');
      parts.push('<div class="ai-unread-head">'
        + '<span class="ai-unread-title">UNREAD FOR DELIVERY</span>'
        + '<span class="ai-unread-meta">' + esc(String(unreadData.unread_total || 0)) + ' total</span>'
        + '</div>');
      const unreadRows = Array.isArray(unreadData.messages) ? unreadData.messages : [];
      if (unreadRows.length === 0) {
        parts.push('<div class="ai-unread-empty">No unread messages.</div>');
      } else {
        parts.push('<div class="ai-unread-list">');
        for (const msg of unreadRows) {
          const msgId = String(msg?.id || '').trim();
          const route = msg?.group
            ? ('Group #' + String(msg.group) + ' · @' + String(msg.from || 'unknown'))
            : ('DM from @' + String(msg.from || 'unknown'));
          const previewRaw = String(msg?.summary || msg?.full || '(no summary)').replace(/\s+/g, ' ').trim();
          const preview = previewRaw.length > 120 ? (previewRaw.slice(0, 120) + '...') : previewRaw;
          const typeText = String(msg?.type || 'inform');
          const atText = String(msg?.time || '');
          const canCancel = /^msg_[0-9]+$/.test(msgId);
          parts.push('<div class="ai-unread-item">'
            + '<div class="ai-unread-route">' + esc(route) + '</div>'
            + '<div class="ai-unread-summary">' + esc(preview) + '</div>'
            + '<div class="ai-unread-sub">' + esc(typeText) + (atText ? (' · ' + esc(atText)) : '') + '</div>'
            + '<div class="ai-unread-actions">'
            + (canCancel
              ? '<button class="ai-unread-cancel" data-agent="' + esc(targetName) + '" data-msg="' + esc(msgId) + '" onclick="cancelUnreadMessage(this.dataset.agent,this.dataset.msg)">CANCEL DELIVERY</button>'
              : '')
            + '</div></div>');
        }
        parts.push('</div>');
      }
      parts.push('</div>');
      // Delete button with two-step confirmation
      parts.push('<div class="ai-delete-row"><button class="ai-delete-btn" id="ai-delete-btn" onclick="deleteAgent()">Delete Agent</button></div>');
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;
      agentInfoEl.innerHTML = parts.join('');
      agentInfoEl.classList.add('visible');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    } finally {
      if (requestSeq === agentDetailRequestSeq && agentDetailAbortController === controller) {
        agentDetailAbortController = null;
      }
    }
  }

  window.cancelUnreadMessage = async function(agentName, msgId) {
    const agent = String(agentName || '').trim();
    const mid = String(msgId || '').trim();
    if (!agent || !mid) return;
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/unread-messages/' + encodeURIComponent(mid) + '/cancel', {
        method: 'POST'
      });
      if (!res.ok) throw new Error('cancel failed');
    } catch {}
    if (monitoredAgent && monitoredAgent.name === agent) {
      fetchAgentDetail(agent, { preserveVisible: true });
    }
  };

  window.editIdentity = function() {
    if (!monitoredAgent) return;
    const textEl = document.getElementById('ai-identity-text');
    if (!textEl) return;
    const current = textEl.textContent === '(no identity)' ? '' : textEl.textContent;
    const row = textEl.parentElement;
    row.innerHTML = '<input class="ai-identity-input" id="ai-identity-input" value="' + esc(current).replace(/"/g, '&quot;') + '" placeholder="Enter identity...">'
      + '<button class="ai-identity-edit" onclick="saveIdentity()" title="Save">&#10003;</button>';
    const inp = document.getElementById('ai-identity-input');
    inp.focus();
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') saveIdentity();
      if (e.key === 'Escape') fetchAgentDetail(monitoredAgent.name);
    });
  };

  window.saveIdentity = async function() {
    if (!monitoredAgent) return;
    const inp = document.getElementById('ai-identity-input');
    if (!inp) return;
    const val = inp.value.trim();
    try {
      await fetch('/api/agents/' + encodeURIComponent(monitoredAgent.name), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: val || null })
      });
    } catch {}
    fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });
  };

  let deleteConfirmTimer = null;
  function showDeleteToast(name) {
    const toast = document.getElementById('delete-toast');
    toast.textContent = 'DELETED: ' + name;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  }
  window.deleteAgent = function() {
    if (!monitoredAgent) return;
    const btn = document.getElementById('ai-delete-btn');
    if (!btn) return;
    if (btn.classList.contains('confirm')) {
      // Second click — actually delete
      clearTimeout(deleteConfirmTimer);
      btn.classList.add('deleting');
      btn.textContent = 'Deleting...';
      const name = monitoredAgent.name;
      fetch('/api/agents/' + encodeURIComponent(name) + '?force=true', { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            showDeleteToast(name);
            monitoredAgent = null;
            monitorPaused = true;
            monitorLabelEl.textContent = '';
            monitorEmptyEl.style.display = '';
            terminalWrapEl.classList.add('hidden');
            btnPause.style.display = 'none';
            if (btnSpeed) btnSpeed.style.display = 'none';
            btnScrollBottom.style.display = 'none';
            agentInfoEl.classList.remove('visible');
            agentInfoEl.innerHTML = '';
            fetchAgentStatus();
          }
        }).catch(() => {
          btn.classList.remove('deleting', 'confirm');
          btn.textContent = 'Delete Agent';
        });
    } else {
      // First click — show confirmation
      btn.classList.add('confirm');
      btn.textContent = 'Confirm Delete?';
      deleteConfirmTimer = setTimeout(() => {
        btn.classList.remove('confirm');
        btn.textContent = 'Delete Agent';
      }, 3000);
    }
  };

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
    const html = agents.map(a => {
      const isRemote = a.remote;
      const isActive = typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active;
      const dot = isRemote ? '&#9826;' : (isActive ? '&#9679;' : '&#9675;');
      const cls = ['agent-btn', isRemote ? 'remote-agent' : (isActive ? 'active-agent' : 'inactive-agent'), isRemote && a.alive ? 'alive' : '', a.name === selectedName ? 'selected' : ''].filter(Boolean).join(' ');
      return '<button class="' + cls + '" data-name="' + esc(a.name) + '" data-tmux="' + esc(a.tmux || '') + '">'
        + '<span class="dot">' + dot + '</span>' + esc(a.name) + '</button>';
    }).join('');
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
    } catch {}
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
      try { addLogEntry(JSON.parse(e.data)); } catch {}
    };
    evtSource.addEventListener('queue', (e) => {
      try { queueItems = JSON.parse(e.data); requestQueueRender(false); } catch {}
    });
    evtSource.addEventListener('reminders', (e) => {
      try { reminderItems = JSON.parse(e.data); renderReminderPanel(); } catch {}
    });
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
    try { const r = await fetch('/api/queue'); queueItems = await r.json(); requestQueueRender(true); } catch {}
    try { const r = await fetch('/api/reminders'); reminderItems = await r.json(); renderReminderPanel(); } catch {}
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
