import express from 'express';
import { readFile as readFileAsync, open, stat as statAsync, appendFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import path from 'path';

const PORT = 8084;
const LOG_FILE = path.resolve('logs/messages.jsonl');

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
const IDLE_THRESHOLD = 30_000; // 30s idle before delivery
const POLL_INTERVAL  = 1_000;  // check every 1s

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

async function isStaleNotificationEntry(entry) {
  if (!isBackendNotificationEntry(entry)) return false;
  const agentName = targetSessionName(entry.to);
  if (!agentName) return false;
  try {
    const res = await fetch(`http://127.0.0.1:8090/api/inbox/${encodeURIComponent(agentName)}/unread`);
    if (!res.ok) return false;
    const data = await res.json();
    return Number(data?.unread_total || 0) === 0;
  } catch {
    return false;
  }
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
  console.log(`Restored ${data.items?.length || 0} queued messages from disk`);
} catch { /* no queue file or parse error, start fresh */ }

// Accept queued message from agent-send
app.post('/api/queue', (req, res) => {
  const { from, to, payload } = req.body;
  if (!to || !payload) return res.status(400).json({ error: 'missing to or payload' });
  const id = ++queueIdCounter;
  // Apply redirect if target was renamed
  let actualTo = to;
  let redirectedFrom = null;
  if (redirects.has(to)) {
    actualTo = redirects.get(to);
    redirectedFrom = to;
  }
  const entry = { id, from: from || 'unknown', to: actualTo, payload, queuedAt: Date.now() };
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
  res.json({ ok: true, id, position: bucket.length, redirected: redirectedFrom || undefined });
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
      return res.json({ ok, delivered: id });
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
        return { name: a.name, tmux: a.tmux, idleMs, active: alive && idleMs < 30_000, alive, remote: !!isRemote, type: a.type || 'agent', server: a.server || null };
      });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'backend-v2 unreachable', detail: e.message });
  }
});

// ── Tmux capture for agent monitor ───────────────────────────────────
app.get('/api/tmux/capture/:session', (req, res) => {
  const session = req.params.session;
  if (!/^[\w\-:.]+$/.test(session)) {
    return res.status(400).type('text').send('invalid session name');
  }
  try {
    const content = execFileSync(
      'tmux', ['capture-pane', '-t', session, '-p', '-S', '-500'],
      { encoding: 'utf-8', timeout: 3000 }
    );
    const etag = '"' + createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.type('text').send(content);
  } catch {
    res.status(404).type('text').send(`[session "${session}" not found]`);
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
    detail.active = detail.idleMs >= 0 && detail.idleMs < 30_000;
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
  try {
    let finalPayload = entry.payload;
    if (entry.redirectedFrom) {
      finalPayload += '\n[REDIRECT NOTICE] This message was originally addressed to "' + entry.redirectedFrom + '" which has been renamed to "' + entry.to + '". Please update your target for future messages.';
    }
    execFileSync('tmux', ['send-keys', '-l', '-t', entry.to, finalPayload], { timeout: 5000 });
    sleepMs(200);
    execFileSync('tmux', ['send-keys', '-t', entry.to, 'Tab'], { timeout: 5000 });
    sleepMs(200);
    execFileSync('tmux', ['send-keys', '-t', entry.to, 'C-m'], { timeout: 5000 });
    sleepMs(200);
    execFileSync('tmux', ['send-keys', '-t', entry.to, 'Enter'], { timeout: 5000 });
    sleepMs(200);
    execFileSync('tmux', ['send-keys', '-t', entry.to, 'Enter'], { timeout: 5000 });

    // Log to messages.jsonl
    const logEntry = JSON.stringify({ ts: Date.now(), from: entry.from, to: entry.to, payload: entry.payload });
    appendFile(LOG_FILE, logEntry + '\n').catch(() => {});
    return true;
  } catch (e) {
    console.error(`Failed to deliver to ${entry.to}:`, e.message);
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
    for (const [target, entries] of queue) {
      if (entries.length === 0) { queue.delete(target); continue; }
      if (delivering.has(target)) continue;

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

      if (await isStaleNotificationEntry(entry)) {
        console.log(`[queue] Dropped stale notification ${entry.id} for ${target} (no unread items left)`);
        archiveDroppedQueueEntries([entry], 'stale-notification-no-unread', target);
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

function fireReminder(reminder) {
  const now = Date.now();
  const elapsed = now - reminder.createdAt;
  const payload = `[Self Time Reminder] From ts:${reminder.createdAt} (${formatRelativeTime(elapsed)}), Now ts:${now}, Msg: ${reminder.msg}`;
  const entry = { id: ++queueIdCounter, from: reminder.target, to: reminder.target, payload, queuedAt: now, isReminder: true };
  if (!queue.has(reminder.target)) queue.set(reminder.target, []);
  queue.get(reminder.target).push(entry);
  saveQueue();
  broadcastQueue();
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
    broadcastReminders();
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
#agent-buttons{
  padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px;
  border-bottom:1px solid rgba(0,240,255,0.08);flex-shrink:0;
}
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
.agent-btn.remote-agent{opacity:0.45}
.agent-btn.remote-agent .dot{color:rgba(180,130,255,0.6);font-size:9px}
.agent-btn.no-tmux{opacity:0.35;cursor:default}
.monitor-bar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 24px;margin:5px 0 0 0;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:11px;color:rgba(0,240,255,0.4);flex-shrink:0;
}
.monitor-bar-name{color:#00f0ff;font-size:12px;text-shadow:0 0 6px rgba(0,240,255,0.2)}
.monitor-bar-btns{display:flex;gap:6px}
#btn-scroll-bottom,#btn-pause{
  padding:4px 14px;border-radius:5px;font-family:inherit;font-size:10px;
  letter-spacing:1px;cursor:pointer;
  border:1px solid rgba(0,240,255,0.25);
  background:rgba(0,240,255,0.06);color:#00f0ff;
  transition:all .2s;
}
#btn-scroll-bottom:hover,#btn-pause:hover{background:rgba(0,240,255,0.15)}
#btn-pause.paused{border-color:rgba(251,191,36,0.4);color:#fbbf24;background:rgba(251,191,36,0.06)}
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
  flex-shrink:0;overflow-y:auto;max-height:50%;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.1) transparent;
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
  #btn-scroll-bottom,#btn-pause{padding:3px 10px;font-size:9px}
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
      <div id="agent-buttons"><span style="color:rgba(0,240,255,0.2);font-size:10px">loading agents...</span></div>
      <div class="monitor-bar">
        <span class="monitor-bar-name" id="monitor-label">Select an agent to monitor</span>
        <span class="monitor-bar-btns">
          <button id="btn-scroll-bottom" style="display:none">&#8615; BOTTOM</button>
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
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Message log ─────────────────────────────
  const msglogEl = document.getElementById('msglog');
  function addLogEntry(msg) {
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
  let lastQueueHtml = '';
  function renderQueuePanel() {
    if (queueActionPending) return;
    if (queueItems.length === 0) { queuePanel.classList.remove('has-items'); queueList.innerHTML = ''; lastQueueHtml = ''; return; }
    queuePanel.classList.add('has-items');
    const now = Date.now();
    const html = queueItems.map(item => {
      const wait = Math.floor((now - item.queuedAt) / 1000);
      const waitStr = wait < 60 ? wait + 's' : Math.floor(wait / 60) + 'm ' + (wait % 60) + 's';
      const payload = (item.payload || '').slice(0, 80);
      const idleMs = item.targetIdleMs || 0;
      let idleStr, idleClass;
      if (idleMs < 0) { idleStr = 'pane not found'; idleClass = 'qi-idle-warn'; }
      else if (idleMs >= 30000) {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'idle ' + (s < 60 ? s + 's' : Math.floor(s/60) + 'm' + (s%60) + 's') + ' (delivering soon)';
        idleClass = 'qi-idle-ready';
      } else {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'target active (idle ' + s + 's / 30s)';
        idleClass = 'qi-idle-busy';
      }
      const redir = item.redirectedFrom ? ' <span class="qi-redir">(was ' + esc(item.redirectedFrom) + ')</span>' : '';
      return '<div class="queue-item">'
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
  setInterval(renderQueuePanel, 1000);

  window.queueAction = async function(id, action) {
    // Optimistic: remove immediately, restore on failure
    const removed = queueItems.find(i => i.id === id);
    queueItems = queueItems.filter(i => i.id !== id);
    queueActionPending = false;
    renderQueuePanel();
    try {
      if (action === 'send') await fetch('/api/queue/' + id + '/send', { method: 'POST' });
      else await fetch('/api/queue/' + id, { method: 'DELETE' });
    } catch {
      if (removed) { queueItems.push(removed); renderQueuePanel(); }
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
  setInterval(renderReminderPanel, 1000);

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
  const monitorLabelEl = document.getElementById('monitor-label');
  const monitorEmptyEl = document.getElementById('monitor-empty');
  const terminalWrapEl = document.getElementById('terminal-wrap');
  const terminalEl     = document.getElementById('terminal');
  const btnPause       = document.getElementById('btn-pause');
  const btnScrollBottom = document.getElementById('btn-scroll-bottom');
  const agentInfoEl    = document.getElementById('agent-info');

  btnScrollBottom.addEventListener('click', () => {
    terminalEl.scrollTop = terminalEl.scrollHeight;
  });

  let monitoredAgent = null;
  let monitorPaused  = false;
  let agentStatusList = [];

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

  function selectAgent(agent) {
    monitoredAgent = agent;
    monitorPaused = false;
    terminalEtag = null;
    btnPause.innerHTML = '&#9646;&#9646; PAUSE';
    btnPause.classList.remove('paused');
    btnPause.style.display = '';
    btnScrollBottom.style.display = '';
    monitorLabelEl.textContent = 'Monitoring: ' + agent.name;
    monitorEmptyEl.style.display = 'none';
    terminalWrapEl.classList.remove('hidden');
    terminalEl.textContent = '';
    for (const btn of agentButtonsEl.querySelectorAll('.agent-btn')) {
      btn.classList.toggle('selected', btn.dataset.name === agent.name);
    }
    fetchAgentDetail(agent.name);
    fetchTerminal().then(() => {
      requestAnimationFrame(() => {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      });
    });
  }

  async function fetchAgentDetail(name) {
    agentInfoEl.classList.remove('visible');
    try {
      const res = await fetch('/api/agents/detail/' + encodeURIComponent(name));
      if (!res.ok) return;
      const d = await res.json();
      const parts = [];
      // Type tag
      if (d.agentType) {
        const cls = d.agentType === 'claude' ? 'ai-tag-claude' : 'ai-tag-codex';
        parts.push('<span class="ai-tag ' + cls + '">' + esc(d.agentType.toUpperCase()) + '</span>');
      }
      // Active tag
      if (d.active !== undefined) {
        parts.push('<span class="ai-tag ' + (d.active ? 'ai-tag-active' : 'ai-tag-inactive') + '">'
          + (d.active ? 'ACTIVE' : 'IDLE') + '</span>');
      }
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
      // Delete button with two-step confirmation
      parts.push('<div class="ai-delete-row"><button class="ai-delete-btn" id="ai-delete-btn" onclick="deleteAgent()">Delete Agent</button></div>');
      agentInfoEl.innerHTML = parts.join('');
      agentInfoEl.classList.add('visible');
    } catch {}
  }

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
    fetchAgentDetail(monitoredAgent.name);
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
      const url = '/api/tmux/capture/' + encodeURIComponent(monitoredAgent.tmux);
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

  // Poll terminal every 100ms (ETag ensures only changed content transfers data)
  setInterval(() => {
    if (monitoredAgent && !monitorPaused) fetchTerminal();
  }, 100);

  const agentLastActive = {};
  function renderAgentButtons(agents) {
    agentStatusList = agents;
    // Hide dead agents entirely
    agents = agents.filter(a => a.alive !== false);
    const selectedName = monitoredAgent?.name;
    if (agents.length === 0) {
      agentButtonsEl.innerHTML = '<span style="color:rgba(0,240,255,0.2);font-size:10px">no known agents</span>';
      return;
    }
    const now = Date.now();
    for (const a of agents) {
      if (a.active) agentLastActive[a.name] = now;
      else if (!agentLastActive[a.name]) agentLastActive[a.name] = 0;
    }
    // Sort: local alive → local idle → remote
    agents.sort((a, b) => {
      const tierOf = x => {
        if (x.remote) return 2;           // remote
        return 0;                         // local alive/idle
      };
      const ta = tierOf(a), tb = tierOf(b);
      if (ta !== tb) return ta - tb;
      return (agentLastActive[b.name] - agentLastActive[a.name]) || a.name.localeCompare(b.name);
    });
    const html = agents.map(a => {
      const isRemote = a.remote;
      const dot = isRemote ? '&#9826;' : (a.active ? '&#9679;' : '&#9675;');
      const cls = ['agent-btn', isRemote ? 'remote-agent' : (a.active ? 'active-agent' : 'inactive-agent'), a.name === selectedName ? 'selected' : ''].filter(Boolean).join(' ');
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
  }

  async function fetchAgentStatus() {
    try {
      const res = await fetch('/api/agents/status');
      if (res.ok) renderAgentButtons(await res.json());
    } catch {}
  }

  // ── SSE ─────────────────────────────────────
  function connectSSE() {
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (e) => {
      try { addLogEntry(JSON.parse(e.data)); } catch {}
    };
    evtSource.addEventListener('queue', (e) => {
      try { queueItems = JSON.parse(e.data); renderQueuePanel(); } catch {}
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
    try { const r = await fetch('/api/queue'); queueItems = await r.json(); renderQueuePanel(); } catch {}
    try { const r = await fetch('/api/reminders'); reminderItems = await r.json(); renderReminderPanel(); } catch {}
    await fetchAgentStatus();
    setInterval(fetchAgentStatus, 5000);
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
    mobileFabQueue.classList.toggle('has-count', queueItems.length > 0);
    mobileFabReminder.classList.toggle('has-count', reminderItems.length > 0);
  }
  setInterval(updateMobileFabs, 2000);

  init();
})();
</script>
</body>
</html>`;
