import express from 'express';
import { readFile } from 'fs/promises';
import { writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const PORT = 8090;
const DATA_DIR = path.resolve('data');
const PUSH_QUEUE_URL = 'http://127.0.0.1:8084/api/queue';
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_SERVER_ID = (process.env.AGENT_CHAT_SERVER || 'local').trim();
const CORS_ALLOWED_ORIGIN = (process.env.FRP_API_ORIGIN || 'https://agentchat.ananthe.party').trim();

mkdirSync(DATA_DIR, { recursive: true });

// ── Storage helpers ───────────────────────────────────────────────────
function dataPath(name) { return path.join(DATA_DIR, name); }

function loadJson(name, fallback) {
  try {
    return JSON.parse(readFileSync_safe(dataPath(name)));
  } catch { return fallback; }
}

function readFileSync_safe(p) {
  const { readFileSync } = await_import_fs();
  return readFileSync(p, 'utf-8');
}

// We need sync read at startup — use a simple approach
import { readFileSync } from 'fs';

function loadJsonSync(name, fallback) {
  try {
    return JSON.parse(readFileSync(dataPath(name), 'utf-8'));
  } catch { return fallback; }
}

function saveJson(name, data) {
  const target = dataPath(name);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, target);
}

function normalizeServer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isLocalRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress;
  return LOCALHOST_IPS.has(ip);
}

// ── In-memory state ───────────────────────────────────────────────────
const agents = loadJsonSync('agents.json', {});
const groups = loadJsonSync('groups.json', {});
const messages = loadJsonSync('messages.json', []);
const cursors = loadJsonSync('cursors.json', {});
let msgCounter = loadJsonSync('.msg_counter', 0);

for (const agent of Object.values(agents)) {
  if (!Object.prototype.hasOwnProperty.call(agent, 'server')) {
    agent.server = null;
  } else {
    agent.server = normalizeServer(agent.server);
  }
}

function nextMsgId() {
  msgCounter++;
  saveJson('.msg_counter', msgCounter);
  return `msg_${String(msgCounter).padStart(4, '0')}`;
}

function saveAgents() { saveJson('agents.json', agents); }
function saveGroups() { saveJson('groups.json', groups); }
function saveMessages() { saveJson('messages.json', messages); }
function saveCursors() { saveJson('cursors.json', cursors); }

// ── SSE: live stream of new messages ──────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(frame);
}

// ── Helpers ───────────────────────────────────────────────────────────
function relativeTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function summarizeMsg(m) {
  return {
    id: m.id,
    from: m.from,
    type: m.type,
    summary: m.summary,
    full: m.full || '',
    mentions: m.mentions || [],
    time: relativeTime(m.ts),
    reply_to: m.reply_to || null,
    group: m.group || null,
  };
}

function ensureCursor(agentName) {
  if (!cursors[agentName]) cursors[agentName] = { inbox: 0, groups: {} };
  return cursors[agentName];
}

function getUnreadInboxMessages(agentName) {
  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;
  const unreadById = new Map();

  for (const m of messages) {
    if (m.to === agentName && m.ts > inboxTs) unreadById.set(m.id, m);
  }
  for (const m of messages) {
    if (!m.group || m.ts <= inboxTs) continue;
    if (Array.isArray(m.mentions) && m.mentions.includes(agentName)) unreadById.set(m.id, m);
  }

  const unread = [...unreadById.values()].sort((a, b) => a.ts - b.ts);
  return { inboxTs, unread };
}

function formatSenderList(names) {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`;
}

// ── Push notification relay ───────────────────────────────────────────
function agentHasMcp(agentName) {
  try {
    const paneOut = execSync('tmux list-panes -a -F "#{pane_tty} #{session_name}" 2>/dev/null', { timeout: 3000, encoding: 'utf-8' }).trim();
    const ptsMap = {};
    for (const line of paneOut.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const tty = line.slice(0, sp);
      const sess = line.slice(sp + 1);
      if (tty && sess) ptsMap[tty.replace('/dev/', '')] = sess;
    }
    let pids;
    try {
      pids = execSync('pgrep -f "node.*mcp-server.js" 2>/dev/null', { timeout: 3000, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { return false; }
    for (const pid of pids) {
      try {
        const pts = execSync(`ps -o tty= -p ${pid} 2>/dev/null`, { timeout: 3000, encoding: 'utf-8' }).trim();
        if (ptsMap[pts] === agentName) return true;
      } catch { /* pid vanished, skip */ }
    }
  } catch { /* no tmux */ }
  return false;
}

const mergedPushInboxCursor = new Map();

async function pushNotify(agentName, msg) {
  const agent = agents[agentName];
  if (!agent?.tmux) return;
  const agentServer = normalizeServer(agent.server);
  if (agentServer && agentServer !== 'local' && agentServer !== LOCAL_SERVER_ID) return;
  const isHumanMsg = msg.type === 'human';
  const hasMcp = agentHasMcp(agentName);
  const { inboxTs, unread } = getUnreadInboxMessages(agentName);
  const unreadCount = unread.length;
  const latestUnread = unread[unread.length - 1] || msg;
  const replyTo = latestUnread.from || msg.from;

  // Determine if reply is expected based on message type
  const needsReply = msg.type === 'human' || msg.type === 'request';

  let notification;
  if (unreadCount > 1) {
    if (!isHumanMsg && mergedPushInboxCursor.get(agentName) === inboxTs) return;
    mergedPushInboxCursor.set(agentName, inboxTs);

    const senderNames = [...new Set(unread.map(m => m.from).filter(Boolean))];
    const senderText = senderNames.length ? ` (from ${formatSenderList(senderNames)})` : '';
    const hasHuman = unread.some(m => m.type === 'human');
    const hasRequest = unread.some(m => m.type === 'request');
    const humanHint = hasHuman ? ' This includes messages from your human operator.' : '';
    const mergedNeedsReply = hasHuman || hasRequest;

    if (hasMcp) {
      const replyPart = mergedNeedsReply
        ? ` Reply after everything is done, using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply").`
        : '';
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}. Use check_inbox() in agent-chat MCP to read all.${humanHint}${replyPart}`;
    } else {
      const senderAgent = agents[replyTo];
      const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
      const replyPart = mergedNeedsReply
        ? ` Reply after everything is done, using /agent-message skill or: agent-send ${senderTmux} "<your reply>".`
        : '';
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}.${humanHint}${replyPart}`;
    }
  } else {
    const isHuman = msg.type === 'human';
    const isGroup = !!msg.group;

    if (hasMcp) {
      const checkHint = `Use check_inbox() in agent-chat MCP for full context.`;
      let actionHint;
      if (needsReply && isGroup) {
        actionHint = `Reply after everything is done, using the agent-chat MCP tool: post(group="${msg.group}", summary="your reply", full="detailed reply")`;
      } else if (needsReply) {
        actionHint = `Reply after everything is done, using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply")`;
      }
      notification = isHuman
        ? `[NOTIFICATION] From ${msg.from} (human): "${msg.summary}". This is your human operator. ${checkHint} ${actionHint}.`
        : needsReply
          ? `[NOTIFICATION] From ${msg.from}: "${msg.summary}". ${checkHint} ${actionHint}.`
          : `[NOTIFICATION] From ${msg.from}: "${msg.summary}".`;
    } else {
      const senderAgent = agents[replyTo];
      const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
      let actionHint;
      if (needsReply) {
        actionHint = `Reply after everything is done, using /agent-message skill or: agent-send ${senderTmux} "<your reply>"`;
      }
      notification = isHuman
        ? `[NOTIFICATION] From ${msg.from} (human): "${msg.summary}". This is your human operator. ${actionHint}.`
        : needsReply
          ? `[NOTIFICATION] From ${msg.from}: "${msg.summary}". ${actionHint}.`
          : `[NOTIFICATION] From ${msg.from}: "${msg.summary}".`;
    }
  }

  try {
    await fetch(PUSH_QUEUE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent-chat-v2', to: agent.tmux, payload: notification }),
    });
  } catch (e) {
    console.error(`Push notify failed for ${agentName}:`, e.message);
  }
}

// ── Express app ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 'loopback');  // trust nginx on localhost, use X-Forwarded-For for real IP
const API_TOKEN = process.env.API_TOKEN;
app.use(express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ALLOWED_ORIGIN && origin === CORS_ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  const ip = req.ip || req.connection?.remoteAddress;
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ── Health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, agents: Object.keys(agents).length, messages: messages.length }));

// ── SSE endpoint ──────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(':\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Agents CRUD ───────────────────────────────────────────────────────
app.post('/api/agents', (req, res) => {
  const { name, role, tmux, type: agentType, identity, server } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = agents[name] || {};
  const normalizedServer = normalizeServer(server);
  const resolvedServer = normalizedServer ?? (isLocalRequest(req) ? 'local' : normalizeServer(existing.server));
  agents[name] = {
    name,
    role: role ?? existing.role ?? null,
    identity: identity ?? existing.identity ?? null,
    tmux: tmux ?? existing.tmux ?? null,
    type: agentType ?? existing.type ?? 'agent',
    server: resolvedServer,
    registeredAt: existing.registeredAt || Date.now(),
  };
  saveAgents();
  res.json({ ok: true, agent: agents[name] });
});

app.patch('/api/agents/:name', (req, res) => {
  const agent = agents[req.params.name];
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const { role, identity, tmux } = req.body;
  if (role !== undefined) agent.role = role;
  if (identity !== undefined) agent.identity = identity;
  if (tmux !== undefined) agent.tmux = tmux;
  saveAgents();
  res.json({ ok: true, agent });
});

app.get('/api/agents', (_req, res) => {
  res.json(Object.values(agents).map(agent => ({ ...agent, server: normalizeServer(agent.server) })));
});

app.get('/api/agents/:name', (req, res) => {
  const agent = agents[req.params.name];
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const memberOf = Object.values(groups).filter(g => g.members.includes(req.params.name)).map(g => g.name);
  res.json({ ...agent, server: normalizeServer(agent.server), groups: memberOf });
});

app.delete('/api/agents/:name', (req, res) => {
  if (!agents[req.params.name]) return res.status(404).json({ error: 'agent not found' });
  delete agents[req.params.name];
  saveAgents();
  res.json({ ok: true });
});

// ── Groups CRUD ───────────────────────────────────────────────────────
app.post('/api/groups', (req, res) => {
  const { name, members } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (groups[name]) return res.status(409).json({ error: 'group already exists' });
  groups[name] = { name, members: members || [], createdAt: Date.now() };
  saveGroups();
  broadcastSSE('group_created', groups[name]);
  res.json({ ok: true, group: groups[name] });
});

app.get('/api/groups', (_req, res) => {
  res.json(Object.values(groups));
});

app.get('/api/groups/:name', (req, res) => {
  const group = groups[req.params.name];
  if (!group) return res.status(404).json({ error: 'group not found' });
  res.json(group);
});

app.post('/api/groups/:name/members', (req, res) => {
  const group = groups[req.params.name];
  if (!group) return res.status(404).json({ error: 'group not found' });
  const { add, remove } = req.body;
  if (add) for (const m of add) { if (!group.members.includes(m)) group.members.push(m); }
  if (remove) group.members = group.members.filter(m => !remove.includes(m));
  saveGroups();
  broadcastSSE('group_members', { name: group.name, members: group.members, added: add || [], removed: remove || [] });
  res.json({ ok: true, group });
});

app.delete('/api/groups/:name', (req, res) => {
  if (!groups[req.params.name]) return res.status(404).json({ error: 'group not found' });
  delete groups[req.params.name];
  saveGroups();
  res.json({ ok: true });
});

// ── Messages ──────────────────────────────────────────────────────────
app.post('/api/messages', (req, res) => {
  const { from, to, group, type, summary, full, mentions, reply_to, source } = req.body;
  if (!from) return res.status(400).json({ error: 'from required' });
  if (!to && !group) return res.status(400).json({ error: 'to or group required' });
  if (!summary) return res.status(400).json({ error: 'summary required' });
  if (!type) return res.status(400).json({ error: 'type required' });

  const msg = {
    id: nextMsgId(),
    ts: Date.now(),
    from,
    to: to || null,
    group: group || null,
    type,
    summary,
    full: full || '',
    mentions: mentions || [],
    reply_to: reply_to || null,
    source: source || 'api',
  };

  messages.push(msg);
  saveMessages();
  broadcastSSE('message', msg);

  // Push notifications
  if (msg.to && msg.to !== msg.from) {
    pushNotify(msg.to, msg);
  }
  if (msg.group && msg.mentions.length > 0) {
    for (const agent of msg.mentions) {
      if (agent !== msg.from) pushNotify(agent, msg);
    }
  }

  res.json({ ok: true, id: msg.id });
});

app.get('/api/messages/:id', (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  res.json({ ...msg, ts: undefined, time: relativeTime(msg.ts) });
});

// ── Full message HTML page (for Matrix links) ────────────────────────
app.get('/msg/:id', (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).send('<h1>Message not found</h1>');
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message ${escape(msg.id)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 700px; margin: 2rem auto; padding: 0 1rem; background: #0a0a0f; color: #e0e0e0; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 1rem; }
  .meta span { margin-right: 1rem; }
  .type { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
  .type-request { background: #1a3a5c; color: #4dabf7; }
  .type-inform { background: #1a3c1a; color: #69db7c; }
  .type-reply { background: #3a3a1a; color: #ffd43b; }
  .type-human { background: #3a1a3a; color: #da77f2; }
  .summary { font-size: 1.1rem; font-weight: 500; margin: 1rem 0; padding: 0.8rem; background: #151520; border-radius: 6px; border-left: 3px solid #4dabf7; }
  .full { white-space: pre-wrap; font-family: 'SF Mono', Monaco, monospace; font-size: 0.9rem; padding: 1rem; background: #151520; border-radius: 6px; line-height: 1.5; }
  .mentions { color: #da77f2; }
</style></head><body>
<h2>Agent Chat Message</h2>
<div class="meta">
  <span class="type type-${escape(msg.type)}">${escape(msg.type)}</span>
  <span>From: <strong>${escape(msg.from)}</strong></span>
  <span>${msg.to ? 'To: <strong>' + escape(msg.to) + '</strong>' : 'Group: <strong>' + escape(msg.group) + '</strong>'}</span>
  <span>${relativeTime(msg.ts)}</span>
</div>
${msg.mentions.length ? '<div class="mentions">Mentions: ' + msg.mentions.map(m => '@' + escape(m)).join(' ') + '</div>' : ''}
${msg.reply_to ? '<div class="meta">Reply to: ' + escape(msg.reply_to) + '</div>' : ''}
<div class="summary">${escape(msg.summary)}</div>
<h3>Full Message</h3>
<div class="full">${escape(msg.full)}</div>
</body></html>`);
});

// ── Inbox ─────────────────────────────────────────────────────────────
app.get('/api/inbox/:agent', (req, res) => {
  const agentName = req.params.agent;
  if (!agents[agentName]) return res.status(404).json({ error: 'agent not found' });

  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;

  const dm = messages
    .filter(m => m.to === agentName && m.ts > inboxTs)
    .map(summarizeMsg);

  const group = messages
    .filter(m => m.group && m.mentions.includes(agentName) && m.ts > inboxTs)
    .map(summarizeMsg);

  // Advance cursor
  cursor.inbox = Date.now();
  saveCursors();

  res.json({ dm, group });
});

// ── Group messages (unread + read split) ──────────────────────────────
app.get('/api/groups/:name/messages', (req, res) => {
  const groupName = req.params.name;
  if (!groups[groupName]) return res.status(404).json({ error: 'group not found' });

  const agentName = req.query.agent;
  if (!agentName) return res.status(400).json({ error: 'agent query param required' });

  const limit = parseInt(req.query.limit) || 10;
  const cursor = ensureCursor(agentName);
  const groupTs = cursor.groups?.[groupName] || 0;

  const groupMsgs = messages.filter(m => m.group === groupName);
  const unread = groupMsgs.filter(m => m.ts > groupTs).map(summarizeMsg);
  const read = groupMsgs.filter(m => m.ts <= groupTs).slice(-limit).map(summarizeMsg);

  // Advance group cursor
  if (!cursor.groups) cursor.groups = {};
  cursor.groups[groupName] = Date.now();
  saveCursors();

  res.json({ group: groupName, unread, read });
});

// ── Agent's groups with unread counts ─────────────────────────────────
app.get('/api/agents/:name/groups', (req, res) => {
  const agentName = req.params.name;
  if (!agents[agentName]) return res.status(404).json({ error: 'agent not found' });

  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;

  const result = Object.values(groups)
    .filter(g => g.members.includes(agentName))
    .map(g => {
      const groupMsgs = messages.filter(m => m.group === g.name);
      const groupTs = cursor.groups?.[g.name] || 0;

      const unread_messages = groupMsgs.filter(m => m.ts > groupTs).length;
      const unread_mentions = groupMsgs.filter(m => m.mentions.includes(agentName) && m.ts > inboxTs).length;

      return { name: g.name, members: g.members, unread_mentions, unread_messages };
    });

  res.json(result);
});

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown() {
  console.log('Shutting down, saving data...');
  saveAgents();
  saveGroups();
  saveMessages();
  saveCursors();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Chat v2 backend listening on http://127.0.0.1:${PORT}`);
  console.log(`  Agents: ${Object.keys(agents).length}, Messages: ${messages.length}, Groups: ${Object.keys(groups).length}`);
});
