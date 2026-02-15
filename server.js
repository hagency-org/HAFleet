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
const queue = new Map();
let queueIdCounter = 0;

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
  queue.get(actualTo).push(entry);
  saveQueue();
  broadcastQueue();
  res.json({ ok: true, id, position: queue.get(actualTo).length, redirected: redirectedFrom || undefined });
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
app.post('/api/queue/:id/send', (req, res) => {
  const id = Number(req.params.id);
  for (const [target, entries] of queue) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx !== -1) {
      const entry = entries.splice(idx, 1)[0];
      if (entries.length === 0) queue.delete(target);
      saveQueue();
      broadcastQueue();
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
setInterval(() => {
  for (const [target, entries] of queue) {
    if (entries.length === 0) { queue.delete(target); continue; }
    if (delivering.has(target)) continue;

    const idleMs = getPaneIdleMs(target);
    if (idleMs < 0) continue; // pane gone, keep in queue
    if (idleMs < IDLE_THRESHOLD) continue; // not idle enough

    // Deliver first message
    delivering.add(target);
    const entry = entries.shift();
    if (entries.length === 0) queue.delete(target);
    saveQueue();
    broadcastQueue();

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
}, POLL_INTERVAL);

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
<title>Agent Network</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='24' fill='none' stroke='%2300f0ff' stroke-width='3'/><circle cx='32' cy='32' r='6' fill='%2300f0ff'/></svg>"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#060a12;font-family:'SF Mono','Fira Code','Consolas',monospace}
canvas{display:block;width:100%;height:100%}

/* Controls overlay */
#controls{
  position:fixed;top:16px;left:16px;z-index:10;
  display:flex;gap:10px;align-items:center;
}
#controls button,.ctrl-label{
  background:rgba(0,240,255,0.08);
  border:1px solid rgba(0,240,255,0.25);
  color:#00f0ff;padding:6px 14px;border-radius:6px;
  font-family:inherit;font-size:12px;cursor:pointer;
  transition:all .2s;
}
#controls button:hover{background:rgba(0,240,255,0.18);border-color:#00f0ff}
#controls button.active{background:rgba(0,240,255,0.2);border-color:#00f0ff;box-shadow:0 0 12px rgba(0,240,255,0.3)}
.ctrl-label{cursor:default;color:rgba(0,240,255,0.5);border-color:rgba(0,240,255,0.12);font-size:11px}

/* Stats overlay */
#stats{
  position:fixed;top:16px;right:16px;z-index:10;
  color:rgba(0,240,255,0.4);font-size:11px;text-align:right;line-height:1.6;
}

/* Message log */
#msglog{
  position:fixed;bottom:0;left:0;right:0;z-index:10;
  max-height:140px;overflow-y:auto;
  background:linear-gradient(transparent,rgba(6,10,18,0.95) 20%);
  padding:40px 16px 12px;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.15) transparent;
}
.log-entry{
  font-size:11px;line-height:1.5;color:rgba(0,240,255,0.45);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.log-entry .ts{color:rgba(0,240,255,0.25)}
.log-entry .from{color:#00f0ff}
.log-entry .to{color:#a855f7}
.log-entry .arrow{color:rgba(0,240,255,0.3)}
.log-entry .payload{color:rgba(255,255,255,0.3)}

/* Replay slider */
#replay-bar{
  position:fixed;bottom:152px;left:16px;right:16px;z-index:10;
  display:none;align-items:center;gap:12px;
}
#replay-bar.show{display:flex}
#replay-slider{
  flex:1;-webkit-appearance:none;appearance:none;height:3px;
  background:rgba(0,240,255,0.15);border-radius:2px;outline:none;
}
#replay-slider::-webkit-slider-thumb{
  -webkit-appearance:none;width:14px;height:14px;border-radius:50%;
  background:#00f0ff;box-shadow:0 0 10px #00f0ff;cursor:pointer;
}
#replay-time{color:rgba(0,240,255,0.5);font-size:11px;min-width:120px;font-family:inherit}
#replay-speed{color:rgba(0,240,255,0.4);font-size:10px;font-family:inherit;
  background:rgba(0,240,255,0.08);border:1px solid rgba(0,240,255,0.2);
  border-radius:4px;padding:3px 8px;cursor:pointer;color:#00f0ff}
#btn-playpause{
  background:rgba(0,240,255,0.08);border:1px solid rgba(0,240,255,0.25);
  color:#00f0ff;width:32px;height:28px;border-radius:6px;
  font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:all .2s;flex-shrink:0;font-family:inherit;
}
#btn-playpause:hover{background:rgba(0,240,255,0.18);border-color:#00f0ff}

/* Queue panel */
#queue-panel{
  position:fixed;top:56px;left:16px;z-index:10;
  width:280px;max-height:calc(100vh - 220px);
  overflow-y:auto;display:none;
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(168,85,247,0.2);
  border-radius:8px;
  backdrop-filter:blur(12px);
  scrollbar-width:thin;scrollbar-color:rgba(168,85,247,0.15) transparent;
}
#queue-panel.has-items{display:block}
.panel-header{
  padding:10px 14px;font-size:10px;letter-spacing:2px;
  color:rgba(168,85,247,0.6);
  border-bottom:1px solid rgba(168,85,247,0.1);
  display:flex;align-items:center;gap:8px;
}
.panel-header .dot{
  width:6px;height:6px;border-radius:50%;
  background:#a855f7;
  animation:pulse-dot 2s infinite;
}
@keyframes pulse-dot{
  0%,100%{opacity:0.4;box-shadow:none}
  50%{opacity:1;box-shadow:0 0 8px #a855f7}
}
.queue-item{
  padding:10px 14px;
  border-bottom:1px solid rgba(168,85,247,0.06);
  transition:background 0.2s;
}
.queue-item:hover{background:rgba(168,85,247,0.05)}
.queue-item:last-child{border-bottom:none}
.qi-route{font-size:11px;margin-bottom:3px}
.qi-from{color:rgba(0,240,255,0.6)}
.qi-arrow{color:rgba(168,85,247,0.3);margin:0 4px}
.qi-target{color:#a855f7}
.qi-payload{
  font-size:10px;color:rgba(255,255,255,0.2);
  margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:250px;
}
.qi-wait{font-size:10px;color:rgba(168,85,247,0.3);margin-top:3px}
.qi-idle{font-size:10px;margin-top:2px}
.qi-idle-busy{color:rgba(251,191,36,0.5)}
.qi-idle-ready{color:rgba(52,211,153,0.6)}
.qi-idle-warn{color:rgba(248,113,113,0.5)}
.qi-redir{color:rgba(251,191,36,0.5);font-size:9px}
.qi-actions{margin-top:6px;display:flex;gap:6px}
.qi-btn{
  font-family:inherit;font-size:9px;letter-spacing:1px;
  padding:3px 10px;border-radius:4px;cursor:pointer;
  border:1px solid;transition:all .2s;background:transparent;
}
.qi-btn-send{color:#34d399;border-color:rgba(52,211,153,0.3)}
.qi-btn-send:hover{background:rgba(52,211,153,0.12);border-color:#34d399}
.qi-btn-cancel{color:#f87171;border-color:rgba(248,113,113,0.3)}
.qi-btn-cancel:hover{background:rgba(248,113,113,0.12);border-color:#f87171}
</style>
</head>
<body>

<canvas id="c"></canvas>

<div id="controls">
  <button id="btn-live" class="active">&#9679; LIVE</button>
  <button id="btn-replay">&#9654; REPLAY</button>
  <span class="ctrl-label" id="agent-count">0 agents</span>
  <span class="ctrl-label" id="msg-count">0 messages</span>
</div>

<div id="stats"></div>

<div id="replay-bar">
  <button id="btn-playpause" title="Play/Pause">&#9654;</button>
  <input type="range" id="replay-slider" min="0" max="1000" value="0"/>
  <span id="replay-time">--:--:--</span>
  <select id="replay-speed">
    <option value="1">1x</option>
    <option value="2">2x</option>
    <option value="5" selected>5x</option>
    <option value="10">10x</option>
    <option value="50">50x</option>
  </select>
</div>

<div id="queue-panel">
  <div class="panel-header"><span class="dot"></span>PENDING QUEUE</div>
  <div id="queue-list"></div>
</div>

<div id="msglog"></div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
(() => {
  // ── Config ──────────────────────────────────
  const DECAY_MS      = 15 * 60 * 1000;
  const BEAM_DURATION = 1200;
  const NODE_RADIUS   = 18;
  const GLOW_RADIUS   = 40;

  // ── State ───────────────────────────────────
  let allMessages = [];
  let nodeMap = new Map();     // id -> node object
  let simNodes = [];           // array ref for d3-force
  let simLinks = [];           // array ref for d3-force
  let linkSet = new Set();     // track unique "from|to" pairs for force links
  let edges = new Map();       // "from|to" -> {lastTs}  (visual decay)
  let beams = [];
  let mode = 'live';
  let replayIndex = 0;
  let replayStartReal = 0;
  let replayStartSim = 0;
  let replaySpeed = 5;
  let replayPaused = false;
  let replayPausedAt = 0;
  let replayMessages = [];
  let dragNode = null;

  // ── Canvas ──────────────────────────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (sim) {
      sim.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2 - 30));
      sim.force('boundsX', d3.forceX(window.innerWidth / 2).strength(0.02));
      sim.force('boundsY', d3.forceY(window.innerHeight / 2 - 30).strength(0.02));
    }
  }
  window.addEventListener('resize', resize);

  // ── D3 Force Simulation ─────────────────────
  const MARGIN = NODE_RADIUS + 20;

  const sim = d3.forceSimulation(simNodes)
    .force('charge', d3.forceManyBody().strength(-400))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2 - 30))
    .force('link', d3.forceLink(simLinks).id(d => d.id).distance(160).strength(0.3))
    .force('collide', d3.forceCollide(NODE_RADIUS * 2.5))
    .force('boundsX', d3.forceX(window.innerWidth / 2).strength(0.02))
    .force('boundsY', d3.forceY(window.innerHeight / 2 - 30).strength(0.02))
    .alphaDecay(0.02)
    .velocityDecay(0.4)
    .on('tick', () => {
      // Clamp nodes to viewport + fix NaN
      const w = window.innerWidth, h = window.innerHeight;
      for (const n of simNodes) {
        if (isNaN(n.x) || isNaN(n.y)) {
          n.x = w / 2 + (Math.random() - 0.5) * 100;
          n.y = h / 2 + (Math.random() - 0.5) * 100;
          n.vx = 0; n.vy = 0;
        }
        n.x = Math.max(MARGIN, Math.min(w - MARGIN, n.x));
        n.y = Math.max(MARGIN, Math.min(h - MARGIN, n.y));
      }
    });

  resize(); // now safe — sim is defined

  function syncSimulation() {
    sim.nodes(simNodes);
    sim.force('link').links(simLinks);
    sim.alpha(0.3).restart();
  }

  // ── Normalize agent ID ──────────────────────
  // "umiki-web:0.0" and "umiki-web" → "umiki-web"
  function normalizeId(id) {
    return id.replace(/:[0-9]+\\.[0-9]+$/, '').replace(/:[0-9]+$/, '');
  }

  // ── Node management ─────────────────────────
  function makeNode(id) {
    return {
      id,
      label: shortLabel(id),
      lastActive: 0,
      pulseT: 0,
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 100,
      y: window.innerHeight / 2 - 30 + (Math.random() - 0.5) * 100,
    };
  }

  // Creates node + immediately syncs d3 (for live single additions)
  function ensureNode(rawId) {
    const id = normalizeId(rawId);
    if (nodeMap.has(id)) return nodeMap.get(id);
    const n = makeNode(id);
    nodeMap.set(id, n);
    simNodes.push(n);
    syncSimulation();
    return n;
  }

  // Creates node without syncing d3 (for batch rebuilds)
  function ensureNodeQuiet(rawId) {
    const id = normalizeId(rawId);
    if (nodeMap.has(id)) return nodeMap.get(id);
    const n = makeNode(id);
    nodeMap.set(id, n);
    simNodes.push(n);
    return n;
  }

  function ensureLinkQuiet(rawFrom, rawTo) {
    const fromId = normalizeId(rawFrom), toId = normalizeId(rawTo);
    const key = fromId + '|' + toId;
    const reverseKey = toId + '|' + fromId;
    if (!linkSet.has(key) && !linkSet.has(reverseKey)) {
      linkSet.add(key);
      simLinks.push({ source: fromId, target: toId });
    }
  }

  function ensureLink(rawFrom, rawTo) {
    ensureLinkQuiet(rawFrom, rawTo);
    syncSimulation();
  }

  function shortLabel(id) {
    // "umiki-web:0.0" → "umiki-web", "claude:1.0" → "claude:1"
    let s = id.replace(/\\.0$/,'');   // strip trailing .0 pane
    s = s.replace(/:0$/,'');          // strip :0 window if it's 0
    return s;
  }

  // ── Drag handling on canvas ─────────────────
  function hitTest(mx, my) {
    for (const n of simNodes) {
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy < (NODE_RADIUS + 8) * (NODE_RADIUS + 8)) return n;
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    const n = hitTest(e.clientX, e.clientY);
    if (!n) return;
    dragNode = n;
    n.fx = n.x;
    n.fy = n.y;
    sim.alphaTarget(0.3).restart();
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', (e) => {
    if (dragNode) {
      dragNode.fx = e.clientX;
      dragNode.fy = e.clientY;
    } else {
      canvas.style.cursor = hitTest(e.clientX, e.clientY) ? 'grab' : 'default';
    }
  });

  window.addEventListener('mouseup', () => {
    if (dragNode) {
      dragNode.fx = null;
      dragNode.fy = null;
      dragNode = null;
      sim.alphaTarget(0);
      canvas.style.cursor = 'default';
    }
  });

  // ── Process message ─────────────────────────
  function processMessage(msg, now) {
    const fid = normalizeId(msg.from), tid = normalizeId(msg.to);
    const prevNodeCount = simNodes.length;
    const prevLinkCount = simLinks.length;
    const fromNode = ensureNodeQuiet(fid);
    const toNode = ensureNodeQuiet(tid);
    ensureLinkQuiet(fid, tid);
    // Only restart simulation if topology changed (new node or link)
    if (simNodes.length !== prevNodeCount || simLinks.length !== prevLinkCount) {
      syncSimulation();
    }
    fromNode.lastActive = now;
    toNode.lastActive = now;
    fromNode.pulseT = now;
    toNode.pulseT = now + BEAM_DURATION;

    edges.set(fid + '|' + tid, { lastTs: now });

    beams.push({
      fromId: fid,
      toId: tid,
      startT: now,
      color: randomBeamColor(),
    });

    addLogEntry(msg);
    updateStats();
  }

  function randomBeamColor() {
    const colors = [
      [0, 240, 255], [168, 85, 247], [96, 165, 250],
      [52, 211, 153], [251, 191, 36],
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // ── Rendering ───────────────────────────────
  function render(now) {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h, now);
    drawBaseLinks();
    drawEdges(now);
    drawBeams(now);
    drawNodes(now);
  }

  // Faint lines for all connected agents (force links), always visible
  function drawBaseLinks() {
    ctx.strokeStyle = 'rgba(0,240,255,0.045)';
    ctx.lineWidth = 0.8;
    for (const link of simLinks) {
      const s = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
      const t = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
      if (!s || !t) continue;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
  }

  function drawGrid(w, h, now) {
    const spacing = 50;
    ctx.strokeStyle = 'rgba(0,240,255,0.03)';
    ctx.lineWidth = 0.5;
    const drift = (now * 0.002) % spacing;
    ctx.beginPath();
    for (let x = -spacing + drift; x < w + spacing; x += spacing) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = -spacing + drift * 0.7; y < h + spacing; y += spacing) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  function drawEdges(now) {
    for (const [key, edge] of edges) {
      const age = now - edge.lastTs;
      if (age > DECAY_MS) { edges.delete(key); continue; }
      const alpha = Math.max(0, 1 - age / DECAY_MS);
      const [fromId, toId] = key.split('|');
      const fn = nodeMap.get(fromId), tn = nodeMap.get(toId);
      if (!fn || !tn) continue;

      ctx.beginPath();
      ctx.moveTo(fn.x, fn.y);
      ctx.lineTo(tn.x, tn.y);
      ctx.strokeStyle = 'rgba(0,240,255,' + (alpha * 0.35).toFixed(3) + ')';
      ctx.lineWidth = 1 + alpha * 2;
      ctx.shadowColor = 'rgba(0,240,255,' + (alpha * 0.5).toFixed(3) + ')';
      ctx.shadowBlur = alpha * 20;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  function drawBeams(now) {
    beams = beams.filter((b) => {
      const t = (now - b.startT) / BEAM_DURATION;
      if (t > 1.3) return false;
      const fn = nodeMap.get(b.fromId), tn = nodeMap.get(b.toId);
      if (!fn || !tn) return false;

      const progress = Math.min(t, 1);
      const x = fn.x + (tn.x - fn.x) * progress;
      const y = fn.y + (tn.y - fn.y) * progress;
      const fade = t > 1 ? 1 - (t - 1) / 0.3 : 1;
      const [r, g, bb] = b.color;

      if (progress > 0.05) {
        const ts = Math.max(0, progress - 0.15);
        const sx = fn.x + (tn.x - fn.x) * ts;
        const sy = fn.y + (tn.y - fn.y) * ts;
        const grad = ctx.createLinearGradient(sx, sy, x, y);
        grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + bb + ',0)');
        grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + bb + ',' + (0.8 * fade).toFixed(2) + ')');
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x, y);
        ctx.strokeStyle = grad; ctx.lineWidth = 3;
        ctx.shadowColor = 'rgba(' + r + ',' + g + ',' + bb + ',' + (fade * 0.8).toFixed(2) + ')';
        ctx.shadowBlur = 15; ctx.stroke(); ctx.shadowBlur = 0;
      }

      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + bb + ',' + fade.toFixed(2) + ')';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 25; ctx.fill(); ctx.shadowBlur = 0;

      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (fade * 0.9).toFixed(2) + ')';
      ctx.fill();

      return true;
    });
  }

  function drawNodes(now) {
    for (const n of simNodes) {
      const timeSinceActive = now - n.lastActive;
      const activity = Math.max(0.35, Math.min(1, 1 - timeSinceActive / DECAY_MS));

      // Outer glow
      const grad = ctx.createRadialGradient(n.x, n.y, NODE_RADIUS * 0.5, n.x, n.y, GLOW_RADIUS);
      grad.addColorStop(0, 'rgba(0,240,255,' + (activity * 0.15).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(0,240,255,0)');
      ctx.beginPath(); ctx.arc(n.x, n.y, GLOW_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();

      // Pulse ring
      const pulseAge = now - n.pulseT;
      if (pulseAge < 800) {
        const pt = pulseAge / 800, pr = NODE_RADIUS + pt * 30;
        ctx.beginPath(); ctx.arc(n.x, n.y, pr, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,240,255,' + ((1 - pt) * 0.4).toFixed(3) + ')';
        ctx.lineWidth = 2 * (1 - pt); ctx.stroke();
      }

      // Highlight dragged node
      const isDragged = dragNode === n;

      // Node circle
      ctx.beginPath(); ctx.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = isDragged ? 'rgba(0,240,255,0.1)' : 'rgba(6,10,18,0.8)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,240,255,' + (0.3 + activity * 0.7).toFixed(3) + ')';
      ctx.lineWidth = isDragged ? 2.5 : 1.5;
      ctx.shadowColor = 'rgba(0,240,255,' + (activity * 0.6).toFixed(3) + ')';
      ctx.shadowBlur = isDragged ? 25 : activity * 15;
      ctx.stroke(); ctx.shadowBlur = 0;

      // Inner dot
      ctx.beginPath(); ctx.arc(n.x, n.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,240,255,' + (0.4 + activity * 0.6).toFixed(3) + ')';
      ctx.fill();

      // Label
      ctx.font = '11px "SF Mono","Fira Code",monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,240,255,' + (0.4 + activity * 0.5).toFixed(3) + ')';
      ctx.fillText(n.label, n.x, n.y + NODE_RADIUS + 16);
    }
  }

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
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function updateStats() {
    document.getElementById('agent-count').textContent = nodeMap.size + ' agents';
    document.getElementById('msg-count').textContent = allMessages.length + ' messages';
  }

  // ── Queue actions (global for inline onclick) ─
  window.queueAction = async function(id, action) {
    try {
      if (action === 'send') {
        await fetch('/api/queue/' + id + '/send', { method: 'POST' });
      } else {
        await fetch('/api/queue/' + id, { method: 'DELETE' });
      }
    } catch {}
  };

  // ── Mode switching ──────────────────────────
  const btnLive = document.getElementById('btn-live');
  const btnReplay = document.getElementById('btn-replay');
  const replayBar = document.getElementById('replay-bar');
  const replaySlider = document.getElementById('replay-slider');
  const replayTimeEl = document.getElementById('replay-time');
  const replaySpeedEl = document.getElementById('replay-speed');
  const btnPlayPause = document.getElementById('btn-playpause');

  btnPlayPause.addEventListener('click', () => {
    if (mode !== 'replay') return;
    if (replayPaused) {
      replayStartReal = Date.now();
      replayStartSim = replayPausedAt;
      replayPaused = false;
      btnPlayPause.innerHTML = '&#9646;&#9646;';
    } else {
      replayPausedAt = currentReplayTime();
      replayPaused = true;
      btnPlayPause.innerHTML = '&#9654;';
    }
  });

  btnLive.addEventListener('click', () => {
    mode = 'live';
    btnLive.classList.add('active');
    btnReplay.classList.remove('active');
    replayBar.classList.remove('show');
    clearAll();
    const now = Date.now();
    for (const msg of allMessages) {
      ensureNodeQuiet(msg.from);
      ensureNodeQuiet(msg.to);
      ensureLinkQuiet(msg.from, msg.to);
      if (now - msg.ts < DECAY_MS) {
        edges.set(normalizeId(msg.from) + '|' + normalizeId(msg.to), { lastTs: msg.ts });
      }
    }
    finishBuild();
    connectSSE();
  });

  btnReplay.addEventListener('click', () => {
    if (allMessages.length === 0) return;
    mode = 'replay';
    btnReplay.classList.add('active');
    btnLive.classList.remove('active');
    replayBar.classList.add('show');
    disconnectSSE();
    startReplay();
  });

  replaySpeedEl.addEventListener('change', () => {
    replaySpeed = Number(replaySpeedEl.value);
    if (mode === 'replay' && !replayPaused) {
      replayStartReal = Date.now();
      replayStartSim = currentReplayTime();
    }
  });

  replaySlider.addEventListener('input', () => {
    if (mode !== 'replay') return;
    const t = Number(replaySlider.value) / 1000;
    const { minTs, maxTs } = replayRange();
    const targetTs = minTs + t * (maxTs - minTs);
    replayStartSim = targetTs;
    replayStartReal = Date.now();
    if (replayPaused) replayPausedAt = targetTs;
    rebuildReplayState(targetTs);
  });

  const MIN_REPLAY_SPAN = 5000; // at least 5s of simulated time

  function startReplay() {
    resetViz();
    replayMessages = [...allMessages].sort((a, b) => a.ts - b.ts);
    replayIndex = 0;
    replayStartReal = Date.now();
    replayStartSim = (replayMessages[0]?.ts || Date.now()) - 500; // 0.5s lead-in
    replaySlider.value = 0;
    replayPaused = false;
    btnPlayPause.innerHTML = '&#9646;&#9646;';
  }

  function replayRange() {
    const minTs = (replayMessages[0]?.ts || 0) - 500;
    const maxTs = (replayMessages[replayMessages.length - 1]?.ts || 0) + 2000;
    return { minTs, maxTs: Math.max(maxTs, minTs + MIN_REPLAY_SPAN) };
  }

  function currentReplayTime() {
    return replayStartSim + (Date.now() - replayStartReal) * replaySpeed;
  }

  function clearAll() {
    nodeMap.clear();
    simNodes.length = 0;
    simLinks.length = 0;
    linkSet.clear();
    edges.clear();
    beams = [];
    msglogEl.innerHTML = '';
    sim.nodes(simNodes);
    sim.force('link').links(simLinks);
    sim.alpha(0).stop();
  }

  function finishBuild() {
    sim.nodes(simNodes);
    sim.force('link').links(simLinks);
    sim.alpha(0.5).restart();
    updateStats();
  }

  function rebuildReplayState(upToTs) {
    clearAll();
    replayIndex = 0;
    for (const msg of replayMessages) {
      if (msg.ts > upToTs) break;
      ensureNodeQuiet(msg.from);
      ensureNodeQuiet(msg.to);
      ensureLinkQuiet(msg.from, msg.to);
      edges.set(normalizeId(msg.from) + '|' + normalizeId(msg.to), { lastTs: msg.ts });
      addLogEntry(msg);
      replayIndex++;
    }
    finishBuild();
  }

  const GAP_SKIP_THRESHOLD = 30000; // skip gaps longer than 30s in sim-time

  function tickReplay() {
    if (mode !== 'replay' || replayMessages.length === 0) return;
    let simNow = replayPaused ? replayPausedAt : currentReplayTime();

    // Auto-skip long gaps: if next message is far away, jump ahead
    if (!replayPaused && replayIndex < replayMessages.length) {
      const nextTs = replayMessages[replayIndex].ts;
      if (nextTs - simNow > GAP_SKIP_THRESHOLD) {
        replayStartSim = nextTs - 1000;
        replayStartReal = Date.now();
        simNow = nextTs - 1000;
      }
    }

    let added = false;
    while (replayIndex < replayMessages.length && replayMessages[replayIndex].ts <= simNow) {
      processMessage(replayMessages[replayIndex], replayMessages[replayIndex].ts);
      added = true;
      replayIndex++;
    }
    if (added) {
      sim.nodes(simNodes);
      sim.force('link').links(simLinks);
      sim.alpha(0.3).restart();
    }
    const { minTs, maxTs } = replayRange();
    const progress = Math.min(1, (simNow - minTs) / (maxTs - minTs));
    replaySlider.value = Math.floor(progress * 1000);
    replayTimeEl.textContent = new Date(simNow).toLocaleTimeString();
    return simNow;
  }

  function resetViz() {
    clearAll();
  }

  // ── Queue panel ─────────────────────────────
  const queuePanel = document.getElementById('queue-panel');
  const queueList = document.getElementById('queue-list');
  let queueItems = [];

  function renderQueuePanel() {
    if (queueItems.length === 0) {
      queuePanel.classList.remove('has-items');
      return;
    }
    queuePanel.classList.add('has-items');
    const now = Date.now();
    queueList.innerHTML = queueItems.map(item => {
      const wait = Math.floor((now - item.queuedAt) / 1000);
      const waitStr = wait < 60 ? wait + 's' : Math.floor(wait / 60) + 'm ' + (wait % 60) + 's';
      const payload = (item.payload || '').slice(0, 80);
      const idleMs = item.targetIdleMs || 0;
      let idleStr, idleClass;
      if (idleMs < 0) {
        idleStr = 'pane not found'; idleClass = 'qi-idle-warn';
      } else if (idleMs >= 30000) {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'idle ' + (s < 60 ? s + 's' : Math.floor(s/60) + 'm' + (s%60) + 's') + ' (delivering soon)';
        idleClass = 'qi-idle-ready';
      } else {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'target active (idle ' + s + 's / 30s)';
        idleClass = 'qi-idle-busy';
      }
      const redir = item.redirectedFrom
        ? ' <span class="qi-redir">(was ' + esc(item.redirectedFrom) + ')</span>' : '';
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
  }

  // Update wait times every second
  setInterval(renderQueuePanel, 1000);

  // ── SSE ─────────────────────────────────────
  let evtSource = null;
  function connectSSE() {
    disconnectSSE();
    evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (e) => {
      if (mode !== 'live') return;
      try {
        const msg = JSON.parse(e.data);
        allMessages.push(msg);
        processMessage(msg, Date.now());
      } catch {}
    };
    evtSource.addEventListener('queue', (e) => {
      try {
        queueItems = JSON.parse(e.data);
        renderQueuePanel();
      } catch {}
    });
  }
  function disconnectSSE() {
    if (evtSource) { evtSource.close(); evtSource = null; }
  }

  // ── Main loop ───────────────────────────────
  function loop() {
    const now = Date.now();
    let renderNow = now;
    if (mode === 'replay') renderNow = tickReplay() || now;
    render(mode === 'replay' ? renderNow : now);
    requestAnimationFrame(loop);
  }

  // ── Init ────────────────────────────────────
  async function init() {
    const res = await fetch('/api/messages');
    allMessages = await res.json();
    const now = Date.now();
    for (const msg of allMessages) {
      ensureNodeQuiet(msg.from);
      ensureNodeQuiet(msg.to);
      ensureLink(msg.from, msg.to);
      if (now - msg.ts < DECAY_MS) {
        edges.set(normalizeId(msg.from) + '|' + normalizeId(msg.to), { lastTs: msg.ts });
      }
    }
    finishBuild();
    connectSSE();
    // Fetch initial queue state
    try {
      const qRes = await fetch('/api/queue');
      queueItems = await qRes.json();
      renderQueuePanel();
    } catch {}
    loop();
  }

  init();
})();
</script>
</body>
</html>`;
