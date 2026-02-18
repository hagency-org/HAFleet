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
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.AGENT_HEARTBEAT_TTL_MS || '90000', 10);
const SERVER_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_SERVER_SWEEP_INTERVAL_MS || '15000', 10);
const HUMAN_SUMMARY_LIMIT = Number.parseInt(process.env.HUMAN_SUMMARY_LIMIT || '50', 10);

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

function normalizeAgentName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function msgSeq(id) {
  if (typeof id !== 'string') return 0;
  const n = Number.parseInt(id.replace(/^msg_/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function compareMsgOrder(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  const aSeq = msgSeq(a.id);
  const bSeq = msgSeq(b.id);
  if (aSeq !== bSeq) return aSeq - bSeq;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function makeHumanSummaryPreview(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = [...normalized];
  if (chars.length <= HUMAN_SUMMARY_LIMIT) return normalized;
  return chars.slice(0, HUMAN_SUMMARY_LIMIT).join('') + '...';
}

function inferRecordKind(record) {
  const explicit = typeof record?.kind === 'string' ? record.kind.trim().toLowerCase() : '';
  if (explicit === 'agent' || explicit === 'human') return explicit;

  const hasRegisteredAt = Number(record?.registeredAt) > 0;
  const hasTmux = typeof record?.tmux === 'string' && record.tmux.trim().length > 0;
  const hasServer = Boolean(normalizeServer(record?.server));
  const hasRole = typeof record?.role === 'string' && record.role.trim().length > 0;
  const hasIdentity = typeof record?.identity === 'string' && record.identity.trim().length > 0;
  return (hasRegisteredAt || hasTmux || hasServer || hasRole || hasIdentity) ? 'agent' : 'human';
}

function isAgentRecord(record) {
  return Boolean(record) && inferRecordKind(record) === 'agent';
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
const servers = loadJsonSync('servers.json', {});
let msgCounter = loadJsonSync('.msg_counter', 0);
const agentsBeforeNormalization = JSON.stringify(agents);

for (const agent of Object.values(agents)) {
  agent.name = agent.name || null;
  if (!Object.prototype.hasOwnProperty.call(agent, 'server')) {
    agent.server = null;
  } else {
    agent.server = normalizeServer(agent.server);
  }
  if (!Object.prototype.hasOwnProperty.call(agent, 'online')) {
    agent.online = Boolean(agent.tmux);
  } else {
    agent.online = Boolean(agent.online);
  }
  if (!Object.prototype.hasOwnProperty.call(agent, 'lastSeen')) {
    agent.lastSeen = agent.discoveredAt || agent.registeredAt || Date.now();
  }
  if (!Object.prototype.hasOwnProperty.call(agent, 'offlineReason')) {
    agent.offlineReason = null;
  } else if (typeof agent.offlineReason !== 'string' || !agent.offlineReason.trim()) {
    agent.offlineReason = null;
  } else {
    agent.offlineReason = agent.offlineReason.trim();
  }
  if (!Object.prototype.hasOwnProperty.call(agent, 'discoveredAt')) {
    agent.discoveredAt = agent.registeredAt || agent.lastSeen || Date.now();
  }
  agent.kind = inferRecordKind(agent);
  if (agent.kind === 'human') {
    agent.online = false;
    agent.offlineReason = null;
  }
}
if (JSON.stringify(agents) !== agentsBeforeNormalization) {
  saveJson('agents.json', agents);
}

const groupsBeforeNormalization = JSON.stringify(groups);
for (const [groupKey, group] of Object.entries(groups)) {
  if (!group || typeof group !== 'object') {
    delete groups[groupKey];
    continue;
  }
  const canonicalName = (typeof group.name === 'string' ? group.name.trim() : '') || groupKey;
  group.name = canonicalName;
  if (canonicalName !== groupKey) {
    delete groups[groupKey];
    if (!groups[canonicalName]) groups[canonicalName] = group;
  }

  const members = Array.isArray(group.members) ? group.members : [];
  const normalizedMembers = [];
  const seen = new Set();
  for (const raw of members) {
    const memberName = normalizeAgentName(raw);
    if (!memberName) continue;
    const key = memberName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedMembers.push(memberName);
  }
  group.members = normalizedMembers;
  if (!Number.isFinite(group.createdAt)) group.createdAt = Date.now();
}
if (JSON.stringify(groups) !== groupsBeforeNormalization) {
  saveJson('groups.json', groups);
}

const cursorsBeforeNormalization = JSON.stringify(cursors);
for (const [agentName, cursor] of Object.entries(cursors)) {
  if (!cursor || typeof cursor !== 'object') {
    cursors[agentName] = { inbox: 0, inboxId: null, groups: {}, groupIds: {} };
    continue;
  }
  cursor.inbox = Number(cursor.inbox) || 0;
  cursor.inboxId = typeof cursor.inboxId === 'string' ? cursor.inboxId : null;

  if (!cursor.groups || typeof cursor.groups !== 'object') cursor.groups = {};
  for (const [groupName, ts] of Object.entries(cursor.groups)) {
    cursor.groups[groupName] = Number(ts) || 0;
  }

  if (!cursor.groupIds || typeof cursor.groupIds !== 'object') cursor.groupIds = {};
  for (const [groupName, id] of Object.entries(cursor.groupIds)) {
    cursor.groupIds[groupName] = typeof id === 'string' ? id : null;
  }
}
if (JSON.stringify(cursors) !== cursorsBeforeNormalization) {
  saveJson('cursors.json', cursors);
}

for (const [serverId, server] of Object.entries(servers)) {
  if (!server || typeof server !== 'object') {
    servers[serverId] = { id: serverId, lastSeen: 0, online: false, updatedAt: Date.now(), sessions: [], agents: [], agentCount: 0 };
    continue;
  }
  server.id = server.id || serverId;
  server.lastSeen = Number(server.lastSeen) || 0;
  server.online = Boolean(server.online);
  server.updatedAt = Number(server.updatedAt) || server.lastSeen || 0;
  if (!Array.isArray(server.sessions)) server.sessions = [];
  if (!Array.isArray(server.agents)) server.agents = [];
  server.agentCount = Number(server.agentCount) || server.agents.length || 0;
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
function saveServers() { saveJson('servers.json', servers); }

function ensureAgentRecord(name, defaults = {}) {
  const agentName = normalizeAgentName(name);
  if (!agentName) return null;
  if (agents[agentName]) return { agent: agents[agentName], created: false };

  const now = Date.now();
  const server = defaults.server !== undefined ? normalizeServer(defaults.server) : null;
  const tmux = (typeof defaults.tmux === 'string' && defaults.tmux.trim()) ? defaults.tmux.trim() : null;
  const online = defaults.online === true;
  const reason = (typeof defaults.offlineReason === 'string' && defaults.offlineReason.trim())
    ? defaults.offlineReason.trim()
    : (online ? null : 'inactive');
  const type = (typeof defaults.type === 'string' && defaults.type.trim()) ? defaults.type.trim() : 'agent';
  const kind = inferRecordKind({ ...defaults, type, name: agentName });

  const agent = {
    name: agentName,
    role: defaults.role ?? null,
    identity: defaults.identity ?? null,
    tmux,
    type,
    server,
    online,
    lastSeen: now,
    offlineReason: reason,
    discoveredAt: now,
    registeredAt: Number(defaults.registeredAt) > 0 ? Number(defaults.registeredAt) : now,
    kind,
  };
  agents[agentName] = agent;
  return { agent, created: true };
}

function ensureInfoGroup() {
  if (!groups.info) {
    groups.info = { name: 'info', members: [], createdAt: Date.now() };
    saveGroups();
  }
}

function emitSystemInfo(summary, full = '') {
  ensureInfoGroup();
  const msg = {
    id: nextMsgId(),
    ts: Date.now(),
    from: 'system',
    to: null,
    group: 'info',
    type: 'inform',
    summary,
    full: full || '',
    mentions: [],
    reply_to: null,
    source: 'system',
  };
  messages.push(msg);
  saveMessages();
  broadcastSSE('message', msg);
}

function isSuppressedForAgent(msg, agentName) {
  return Array.isArray(msg?.suppressedRecipients) && msg.suppressedRecipients.includes(agentName);
}

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
    ts: m.ts,
    at: new Date(m.ts).toISOString(),
    time: relativeTime(m.ts),
    reply_to: m.reply_to || null,
    group: m.group || null,
  };
}

function ensureCursor(agentName) {
  if (!cursors[agentName]) {
    cursors[agentName] = { inbox: 0, inboxId: null, groups: {}, groupIds: {} };
  }
  if (!cursors[agentName].groups || typeof cursors[agentName].groups !== 'object') {
    cursors[agentName].groups = {};
  }
  if (!cursors[agentName].groupIds || typeof cursors[agentName].groupIds !== 'object') {
    cursors[agentName].groupIds = {};
  }
  if (!Object.prototype.hasOwnProperty.call(cursors[agentName], 'inbox')) cursors[agentName].inbox = 0;
  if (!Object.prototype.hasOwnProperty.call(cursors[agentName], 'inboxId')) cursors[agentName].inboxId = null;
  return cursors[agentName];
}

function isAfterCursor(msg, ts, id) {
  if (!msg) return false;
  const cursorTs = Number(ts) || 0;
  const cursorId = typeof id === 'string' ? id : null;
  if (msg.ts > cursorTs) return true;
  if (msg.ts < cursorTs) return false;
  if (!cursorId) return false;
  return compareMsgOrder(msg, { ts: cursorTs, id: cursorId }) > 0;
}

function advanceInboxCursor(cursor, unread) {
  if (!Array.isArray(unread) || unread.length === 0) return false;
  const last = unread[unread.length - 1];
  cursor.inbox = last.ts;
  cursor.inboxId = last.id;
  return true;
}

function getGroupCursor(cursor, groupName) {
  return {
    ts: Number(cursor.groups?.[groupName]) || 0,
    id: typeof cursor.groupIds?.[groupName] === 'string' ? cursor.groupIds[groupName] : null,
  };
}

function advanceGroupCursor(cursor, groupName, unread) {
  if (!Array.isArray(unread) || unread.length === 0) return false;
  const last = unread[unread.length - 1];
  if (!cursor.groups) cursor.groups = {};
  if (!cursor.groupIds) cursor.groupIds = {};
  cursor.groups[groupName] = last.ts;
  cursor.groupIds[groupName] = last.id;
  return true;
}

function getGroupMembers(groupName) {
  return Array.isArray(groups[groupName]?.members) ? groups[groupName].members : [];
}

function findGroupMember(groupName, name) {
  const target = normalizeAgentName(name);
  if (!target) return null;
  const members = getGroupMembers(groupName);
  const exact = members.find(m => normalizeAgentName(m) === target);
  if (exact) return exact;
  const targetLower = target.toLowerCase();
  return members.find(m => normalizeAgentName(m)?.toLowerCase() === targetLower) || null;
}

function isGroupMember(groupName, name) {
  return Boolean(findGroupMember(groupName, name));
}

function getUnreadInboxMessages(agentName) {
  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;
  const inboxId = cursor.inboxId || null;
  const unreadById = new Map();

  for (const m of messages) {
    if (m.to !== agentName) continue;
    if (!isAfterCursor(m, inboxTs, inboxId)) continue;
    if (isSuppressedForAgent(m, agentName)) continue;
    unreadById.set(m.id, m);
  }
  for (const m of messages) {
    if (!m.group) continue;
    if (!isAfterCursor(m, inboxTs, inboxId)) continue;
    if (!isGroupMember(m.group, agentName)) continue;
    if (Array.isArray(m.mentions) && m.mentions.includes(agentName) && !isSuppressedForAgent(m, agentName)) {
      unreadById.set(m.id, m);
    }
  }

  const unread = [...unreadById.values()].sort(compareMsgOrder);
  return { inboxTs, inboxId, unread };
}

function buildUnreadInboxSnapshot(agentName) {
  const { unread } = getUnreadInboxMessages(agentName);
  let unreadDm = 0;
  let unreadGroupMentions = 0;
  for (const m of unread) {
    if (m.to === agentName) unreadDm++;
    else if (m.group) unreadGroupMentions++;
  }
  return {
    agent: agentName,
    unread_total: unread.length,
    unread_dm: unreadDm,
    unread_group_mentions: unreadGroupMentions,
    latest: unread.length > 0 ? summarizeMsg(unread[unread.length - 1]) : null,
  };
}

function formatSenderList(names) {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`;
}

function ensureServerRecord(serverId) {
  if (!serverId) return null;
  if (!servers[serverId] || typeof servers[serverId] !== 'object') {
    servers[serverId] = {
      id: serverId,
      lastSeen: 0,
      online: false,
      updatedAt: Date.now(),
      sessions: [],
      agents: [],
      agentCount: 0,
      sourceIp: null,
    };
  }
  return servers[serverId];
}

function markAgentsOfflineForServer(serverId, reason, clearTmux = false) {
  let changed = false;
  for (const agent of Object.values(agents)) {
    if (normalizeServer(agent.server) !== serverId) continue;
    if (agent.online !== false) { agent.online = false; changed = true; }
    if (agent.offlineReason !== reason) { agent.offlineReason = reason; changed = true; }
    if (clearTmux && agent.tmux !== null) { agent.tmux = null; changed = true; }
  }
  return changed;
}

function refreshServerLiveness() {
  const now = Date.now();
  let serversChanged = false;
  let agentsChanged = false;
  for (const [serverId, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    const wasOnline = Boolean(server.online);
    const isOnline = server.lastSeen > 0 && (now - server.lastSeen) <= HEARTBEAT_TTL_MS;
    if (server.online !== isOnline) {
      server.online = isOnline;
      server.updatedAt = now;
      serversChanged = true;
      if (wasOnline && !isOnline) {
        if (markAgentsOfflineForServer(serverId, `server-offline:${serverId}`, true)) {
          agentsChanged = true;
        }
        emitSystemInfo(`Remote server '${serverId}' offline`, `Server '${serverId}' heartbeat timed out (> ${HEARTBEAT_TTL_MS}ms). Marked related agents offline.`);
      }
    }
  }
  if (serversChanged) saveServers();
  if (agentsChanged) saveAgents();
}

function getAgentDeliveryState(name) {
  const agent = agents[name];
  if (!agent || !isAgentRecord(agent)) {
    return { exists: false, online: false, server: null, serverOnline: false, lastSeen: null, offlineReason: 'not-agent' };
  }
  const serverId = normalizeServer(agent.server);
  let serverOnline = true;
  let serverLastSeen = null;
  if (serverId && serverId !== 'local') {
    const server = servers[serverId];
    if (server) {
      serverOnline = Boolean(server.online);
      serverLastSeen = server.lastSeen || null;
    } else {
      serverOnline = Boolean(agent.online);
    }
  }
  const online = Boolean(agent.online) && serverOnline;
  return {
    exists: true,
    online,
    agentOnline: Boolean(agent.online),
    server: serverId,
    serverOnline,
    lastSeen: agent.lastSeen || null,
    serverLastSeen,
    offlineReason: agent.offlineReason || null,
  };
}

function serializeAgent(agent) {
  const state = getAgentDeliveryState(agent.name);
  return {
    ...agent,
    server: normalizeServer(agent.server),
    online: state.online,
    agentOnline: state.agentOnline,
    serverOnline: state.serverOnline,
    lastSeen: state.lastSeen,
    serverLastSeen: state.serverLastSeen,
    offlineReason: state.offlineReason,
  };
}

function applyServerHeartbeat(serverId, payload = {}, sourceIp = null) {
  const now = Date.now();
  const server = ensureServerRecord(serverId);
  const wasOnline = Boolean(server.online);
  const sessions = Array.isArray(payload.sessions)
    ? [...new Set(payload.sessions.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))]
    : [];
  const heartbeatAgents = Array.isArray(payload.agents) ? payload.agents : sessions;
  const liveAgents = [...new Set(heartbeatAgents.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))];
  const liveSet = new Set(liveAgents);

  server.lastSeen = now;
  server.online = true;
  server.updatedAt = now;
  server.sourceIp = sourceIp || null;
  server.sessions = sessions;
  server.agents = liveAgents;
  server.agentCount = liveAgents.length;

  if (!wasOnline) {
    emitSystemInfo(`Remote server '${serverId}' online`, `Server '${serverId}' heartbeat restored. Active sessions=${sessions.length}, agents=${liveAgents.length}.`);
  }

  let agentsChanged = false;
  const becameOnline = [];
  for (const name of liveSet) {
    const ensured = ensureAgentRecord(name, {
      server: serverId,
      tmux: `${name}:0.0`,
      online: true,
      type: 'agent',
      kind: 'agent',
      offlineReason: null,
      registeredAt: now,
    });
    if (!ensured) continue;
    const agent = ensured.agent;
    if (ensured.created) agentsChanged = true;
    if (!isAgentRecord(agent)) {
      agent.kind = 'agent';
      if (!Number(agent.registeredAt)) agent.registeredAt = now;
      agentsChanged = true;
    }
    if (normalizeServer(agent.server) !== serverId) { agent.server = serverId; agentsChanged = true; }
    if (!agent.tmux) { agent.tmux = `${name}:0.0`; agentsChanged = true; }
    const wasAgentOnline = agent.online === true;
    if (!wasAgentOnline) becameOnline.push(name);
    if (agent.online !== true) { agent.online = true; agentsChanged = true; }
    if (agent.offlineReason !== null) { agent.offlineReason = null; agentsChanged = true; }
    if (agent.lastSeen !== now) { agent.lastSeen = now; agentsChanged = true; }
  }

  for (const agent of Object.values(agents)) {
    if (normalizeServer(agent.server) !== serverId) continue;
    if (liveSet.has(agent.name)) continue;
    if (agent.online !== false) { agent.online = false; agentsChanged = true; }
    const reason = `heartbeat-missing:${serverId}`;
    if (agent.offlineReason !== reason) { agent.offlineReason = reason; agentsChanged = true; }
    if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; }
  }

  saveServers();
  if (agentsChanged) saveAgents();
  for (const name of becameOnline) {
    notifyAgentCatchup(name, `online:${serverId}`);
  }
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
const catchupCursor = new Map();

async function notifyAgentCatchup(agentName, reason = 'online') {
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return;
  const state = getAgentDeliveryState(agentName);
  if (!state.online) return;

  const { unread } = getUnreadInboxMessages(agentName);
  if (!unread.length) return;

  const oldest = unread[0];
  const latest = unread[unread.length - 1];
  const key = `${latest.id}:${unread.length}`;
  if (catchupCursor.get(agentName) === key) return;
  catchupCursor.set(agentName, key);

  const senderNames = [...new Set(unread.map(m => m.from).filter(Boolean))];
  const summary = `Queued while offline: ${unread.length} message(s) (${new Date(oldest.ts).toISOString()} -> ${new Date(latest.ts).toISOString()}).`;
  const full = [
    `You were offline (${reason}).`,
    `Unread count: ${unread.length}`,
    `Senders: ${senderNames.join(', ') || 'unknown'}`,
    'These messages may be time-sensitive. Review timestamps and decide whether a reply is still needed.',
    'Use check_inbox() in agent-chat MCP for full context.',
  ].join('\n');

  const msg = {
    id: nextMsgId(),
    ts: Date.now(),
    from: 'system',
    to: agentName,
    group: null,
    type: 'inform',
    summary,
    full,
    mentions: [],
    reply_to: null,
    source: 'system',
  };
  messages.push(msg);
  saveMessages();
  broadcastSSE('message', msg);
  await pushNotify(agentName, msg);
}

async function pushNotify(agentName, msg) {
  const agent = agents[agentName];
  if (!agent?.tmux) return;
  const agentServer = normalizeServer(agent.server);
  if (agentServer && agentServer !== 'local' && agentServer !== LOCAL_SERVER_ID) return;
  // If server is unknown (null), verify the tmux session exists locally before queueing
  if (!agentServer) {
    try {
      const sess = agent.tmux.split(':')[0];
      execSync(`tmux has-session -t ${JSON.stringify(sess)} 2>/dev/null`, { timeout: 2000 });
    } catch {
      return; // tmux session doesn't exist locally — likely a remote agent not yet heartbeated
    }
  }
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
    const dedupeKey = `${inboxTs}:${latestUnread.id || 'none'}:${unreadCount}`;
    if (!isHumanMsg && mergedPushInboxCursor.get(agentName) === dedupeKey) return;
    mergedPushInboxCursor.set(agentName, dedupeKey);

    const senderNames = [...new Set(unread.map(m => m.from).filter(Boolean))];
    const senderText = senderNames.length ? ` (from ${formatSenderList(senderNames)})` : '';
    const hasHuman = unread.some(m => m.type === 'human');
    const hasRequest = unread.some(m => m.type === 'request');
    const humanHint = hasHuman ? ' This includes messages from your human operator.' : '';
    const mergedNeedsReply = hasHuman || hasRequest;

    if (hasMcp) {
      const replyPart = mergedNeedsReply
        ? ` Reply after ALL WORK is done, using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply").`
        : '';
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}. Use check_inbox() in agent-chat MCP to read all.${humanHint}${replyPart}`;
    } else {
      const senderAgent = agents[replyTo];
      const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
      const replyPart = mergedNeedsReply
        ? ` Reply after ALL WORK is done, using /agent-message skill or: agent-send ${senderTmux} "<your reply>".`
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
        actionHint = `Reply after ALL WORK is done, using the agent-chat MCP tool: post(group="${msg.group}", summary="your reply", full="detailed reply")`;
      } else if (needsReply) {
        actionHint = `Reply after ALL WORK is done, using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply")`;
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
        actionHint = `Reply after ALL WORK is done, using /agent-message skill or: agent-send ${senderTmux} "<your reply>"`;
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
app.get('/health', (_req, res) => {
  refreshServerLiveness();
  const serverRows = Object.values(servers);
  const onlineServers = serverRows.filter(s => s.online).length;
  const agentNames = Object.keys(agents).filter(name => isAgentRecord(agents[name]));
  const onlineAgents = agentNames.filter(name => getAgentDeliveryState(name).online).length;
  res.json({
    ok: true,
    agents: agentNames.length,
    onlineAgents,
    servers: serverRows.length,
    onlineServers,
    messages: messages.length,
  });
});

// ── Server heartbeats ─────────────────────────────────────────────────
app.post('/api/servers/heartbeat', (req, res) => {
  const serverId = normalizeServer(req.body?.server);
  if (!serverId) return res.status(400).json({ error: 'server required' });
  applyServerHeartbeat(serverId, req.body || {}, req.ip || req.connection?.remoteAddress || null);
  refreshServerLiveness();
  const state = servers[serverId];
  return res.json({
    ok: true,
    server: {
      id: state.id,
      online: Boolean(state.online),
      lastSeen: state.lastSeen || null,
      updatedAt: state.updatedAt || null,
      agentCount: state.agentCount || 0,
      sourceIp: state.sourceIp || null,
    },
  });
});

app.post('/api/servers/:id/offline', (req, res) => {
  const serverId = normalizeServer(req.params.id);
  if (!serverId) return res.status(400).json({ error: 'server required' });
  const server = ensureServerRecord(serverId);
  const wasOnline = Boolean(server.online);
  server.lastSeen = Date.now();
  server.online = false;
  server.updatedAt = Date.now();
  if (markAgentsOfflineForServer(serverId, `server-offline:${serverId}`, true)) saveAgents();
  saveServers();
  if (wasOnline) {
    const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim()) ? req.body.reason.trim() : 'offline';
    emitSystemInfo(`Remote server '${serverId}' offline`, `Server '${serverId}' reported offline (${reason}).`);
  }
  res.json({ ok: true, server: { id: serverId, online: false, lastSeen: server.lastSeen } });
});

app.get('/api/servers', (_req, res) => {
  refreshServerLiveness();
  const rows = Object.values(servers)
    .map(s => ({
      id: s.id,
      online: Boolean(s.online),
      lastSeen: s.lastSeen || null,
      updatedAt: s.updatedAt || null,
      agentCount: Number(s.agentCount) || 0,
      sourceIp: s.sourceIp || null,
    }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json(rows);
});

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
  refreshServerLiveness();
  const agentName = normalizeAgentName(name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const existing = agents[agentName] || {};
  const existingOnline = Boolean(existing.online);
  const normalizedServer = normalizeServer(server);
  const resolvedServer = normalizedServer ?? (isLocalRequest(req) ? 'local' : normalizeServer(existing.server));
  const resolvedTmux = tmux ?? existing.tmux ?? null;
  const resolvedOnline = resolvedTmux ? true : Boolean(existing.online);
  agents[agentName] = {
    name: agentName,
    role: role ?? existing.role ?? null,
    identity: identity ?? existing.identity ?? null,
    tmux: resolvedTmux,
    type: agentType ?? existing.type ?? 'agent',
    kind: 'agent',
    server: resolvedServer,
    online: resolvedOnline,
    lastSeen: resolvedOnline ? Date.now() : (existing.lastSeen || Date.now()),
    offlineReason: resolvedOnline ? null : (existing.offlineReason || 'offline'),
    registeredAt: existing.registeredAt || Date.now(),
    discoveredAt: existing.discoveredAt || existing.registeredAt || Date.now(),
  };
  saveAgents();
  if (!existingOnline && resolvedOnline) {
    notifyAgentCatchup(agentName, 'agent-online-update').catch((e) => {
      console.error(`catchup notify failed for ${agentName}:`, e.message);
    });
  }
  res.json({ ok: true, agent: serializeAgent(agents[agentName]) });
});

app.patch('/api/agents/:name', (req, res) => {
  refreshServerLiveness();
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const wasOnline = Boolean(agent.online);
  const { role, identity, tmux, online, offlineReason } = req.body;
  if (role !== undefined) agent.role = role;
  if (identity !== undefined) agent.identity = identity;
  if (tmux !== undefined) {
    agent.tmux = tmux;
    if (tmux) {
      agent.online = true;
      agent.offlineReason = null;
      agent.lastSeen = Date.now();
    } else if (online === undefined) {
      agent.online = false;
      agent.offlineReason = agent.offlineReason || 'tmux-cleared';
    }
  }
  if (online !== undefined) {
    agent.online = Boolean(online);
    if (agent.online) {
      agent.lastSeen = Date.now();
      agent.offlineReason = null;
    }
  }
  if (offlineReason !== undefined) {
    agent.offlineReason = (typeof offlineReason === 'string' && offlineReason.trim()) ? offlineReason.trim() : null;
  }
  saveAgents();
  if (!wasOnline && agent.online === true) {
    notifyAgentCatchup(agentName, 'agent-online-patch').catch((e) => {
      console.error(`catchup notify failed for ${agentName}:`, e.message);
    });
  }
  res.json({ ok: true, agent: serializeAgent(agent) });
});

app.get('/api/agents', (_req, res) => {
  refreshServerLiveness();
  res.json(Object.values(agents).filter(isAgentRecord).map(serializeAgent));
});

app.get('/api/agents/:name', (req, res) => {
  refreshServerLiveness();
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const memberOf = Object.values(groups).filter(g => g.members.includes(agent.name)).map(g => g.name);
  res.json({ ...serializeAgent(agent), groups: memberOf });
});

app.delete('/api/agents/:name', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  agent.online = false;
  agent.tmux = null;
  agent.lastSeen = Date.now();
  if (!agent.offlineReason) agent.offlineReason = 'inactive';
  saveAgents();
  res.json({
    ok: true,
    deprecated: true,
    message: 'unregister is disabled; agent marked inactive',
    agent: serializeAgent(agent),
  });
});

app.post('/api/agents/:name/offline', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim())
    ? req.body.reason.trim()
    : 'manual-offline';
  const clearTmux = req.body?.clearTmux !== false;
  agent.online = false;
  agent.lastSeen = Date.now();
  agent.offlineReason = reason;
  if (clearTmux) agent.tmux = null;
  saveAgents();
  res.json({ ok: true, agent: serializeAgent(agent) });
});

// ── Groups CRUD ───────────────────────────────────────────────────────
app.post('/api/groups', (req, res) => {
  const { name, members } = req.body;
  const groupName = (typeof name === 'string' ? name.trim() : '');
  if (!groupName) return res.status(400).json({ error: 'name required' });
  if (groups[groupName]) return res.status(409).json({ error: 'group already exists' });
  const normalizedMembers = [];
  const seen = new Set();
  for (const raw of (Array.isArray(members) ? members : [])) {
    const memberName = normalizeAgentName(raw);
    if (!memberName) continue;
    const key = memberName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedMembers.push(memberName);
  }
  groups[groupName] = { name: groupName, members: normalizedMembers, createdAt: Date.now() };
  saveGroups();
  broadcastSSE('group_created', groups[groupName]);
  res.json({ ok: true, group: groups[groupName] });
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
  const addList = [];
  const addSeen = new Set();
  if (Array.isArray(add)) {
    for (const raw of add) {
      const memberName = normalizeAgentName(raw);
      if (!memberName) continue;
      const key = memberName.toLowerCase();
      if (addSeen.has(key)) continue;
      addSeen.add(key);
      addList.push(memberName);
    }
  }
  const removeKeys = new Set();
  const removeList = [];
  const removeSeen = new Set();
  if (Array.isArray(remove)) {
    for (const raw of remove) {
      const memberName = normalizeAgentName(raw);
      if (!memberName) continue;
      const key = memberName.toLowerCase();
      if (removeSeen.has(key)) continue;
      removeSeen.add(key);
      removeKeys.add(key);
      removeList.push(memberName);
    }
  }

  if (!Array.isArray(group.members)) group.members = [];
  const existingKeys = new Set(group.members.map(m => String(m).toLowerCase()));
  for (const memberName of addList) {
    const key = memberName.toLowerCase();
    if (!existingKeys.has(key)) {
      group.members.push(memberName);
      existingKeys.add(key);
    }
  }
  if (removeKeys.size > 0) {
    group.members = group.members.filter(m => !removeKeys.has(String(m).toLowerCase()));
  }
  saveGroups();
  broadcastSSE('group_members', { name: group.name, members: group.members, added: addList, removed: removeList });
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
  const { from, to, group, type, summary, full, mentions, reply_to, source, target_type } = req.body;
  const fromName = normalizeAgentName(from) || from;
  const toName = to ? normalizeAgentName(to) : null;
  const sourceType = typeof source === 'string' ? source.trim().toLowerCase() : 'api';
  const targetType = typeof target_type === 'string' ? target_type.trim().toLowerCase() : 'auto';
  // Normalize literal \n (two chars) to actual newlines — some agents double-escape them
  const normNl = s => s.replace(/\\n/g, '\n');
  const rawSummary = typeof summary === 'string' ? normNl(summary) : '';
  const rawFull = typeof full === 'string' ? normNl(full) : '';
  const isHumanMessage = type === 'human';
  const canonicalHumanFull = isHumanMessage ? (rawFull || rawSummary).trim() : '';
  const canonicalSummary = isHumanMessage ? makeHumanSummaryPreview(canonicalHumanFull) : rawSummary;
  const canonicalFull = isHumanMessage ? canonicalHumanFull : rawFull;

  if (!fromName) return res.status(400).json({ error: 'from required' });
  if (!toName && !group) return res.status(400).json({ error: 'to or group required' });
  if (toName && group) return res.status(400).json({ error: 'to and group are mutually exclusive' });
  if (!type) return res.status(400).json({ error: 'type required' });
  if (isHumanMessage && !canonicalFull) {
    return res.status(400).json({ error: 'human message requires summary or full' });
  }
  if (!isHumanMessage && !canonicalSummary) {
    return res.status(400).json({ error: 'summary required' });
  }
  if (!['auto', 'agent', 'human'].includes(targetType)) {
    return res.status(400).json({ error: 'target_type must be one of: auto, agent, human' });
  }
  let directTargetKind = null;
  let assumedHumanTarget = false;
  const senderRecord = agents[fromName] || null;
  const senderIsAgent = isAgentRecord(senderRecord);
  if (sourceType === 'api' && fromName !== 'system' && !senderIsAgent) {
    return res.status(403).json({ error: `sender agent not registered: ${fromName}` });
  }
  if (toName) {
    const targetRecord = agents[toName];
    const knownAgentTarget = isAgentRecord(targetRecord);
    if (targetType === 'agent') {
      if (!knownAgentTarget) return res.status(404).json({ error: `target agent not found: ${toName}` });
      directTargetKind = 'agent';
    } else if (targetType === 'human') {
      directTargetKind = 'human';
    } else if (knownAgentTarget) {
      directTargetKind = 'agent';
    } else if (sourceType === 'matrix') {
      return res.status(404).json({ error: `target agent not found: ${toName}` });
    } else {
      directTargetKind = 'human';
      assumedHumanTarget = targetType === 'auto';
    }
  }
  if (group && !groups[group]) {
    if (group === 'info') {
      ensureInfoGroup();
    } else {
      return res.status(404).json({ error: `group not found: ${group}` });
    }
  }
  if (group && senderIsAgent && fromName !== 'system') {
    const matchedMember = findGroupMember(group, fromName);
    if (!matchedMember) {
      return res.status(403).json({ error: `sender '${fromName}' is not a member of group '${group}'` });
    }
    if (matchedMember !== fromName) {
      const members = getGroupMembers(group);
      const idx = members.indexOf(matchedMember);
      if (idx >= 0) {
        members[idx] = fromName;
        saveGroups();
      }
    }
  }
  refreshServerLiveness();

  // Auto-extract @mentions from text and merge with explicit mentions
  // Build set of all known names (agents + group members including humans)
  const knownNames = new Set(Object.keys(agents));
  for (const g of Object.values(groups)) {
    for (const m of g.members) knownNames.add(m);
  }
  const explicitMentions = mentions || [];
  const textMentions = new Set(explicitMentions);
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentionScanTexts = isHumanMessage ? [canonicalFull] : [canonicalSummary || '', canonicalFull || ''];
  for (const text of mentionScanTexts) {
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      const name = match[1];
      if (knownNames.has(name) && name !== fromName) textMentions.add(name);
    }
  }

  const msg = {
    id: nextMsgId(),
    ts: Date.now(),
    from: fromName,
    to: toName || null,
    group: group || null,
    type,
    summary: canonicalSummary,
    full: canonicalFull,
    mentions: [...textMentions],
    reply_to: reply_to || null,
    source: source || 'api',
  };

  const warnings = [];
  if (msg.to && directTargetKind === 'human' && assumedHumanTarget) {
    warnings.push({
      code: 'target_assumed_human',
      target: msg.to,
      reason: 'unknown-target-treated-as-human',
    });
  }
  const suppressedRecipients = new Set();
  if (msg.to && directTargetKind === 'agent') {
    const state = getAgentDeliveryState(msg.to);
    if (!state.online) {
      warnings.push({
        code: 'target_offline',
        target: msg.to,
        server: state.server,
        reason: state.offlineReason || 'offline',
        queued: true,
      });
    }
  }
  if (msg.group && msg.mentions.length > 0) {
    const groupMemberSet = new Set(getGroupMembers(msg.group).map(n => n.toLowerCase()));
    const mentionStates = msg.mentions
      .filter(name => name !== msg.from)
      .map(name => ({
        name,
        state: getAgentDeliveryState(name),
        isGroupMember: groupMemberSet.has(String(name).toLowerCase()),
      }));

    const offlineMentions = mentionStates
      .filter(item => item.state.exists && !item.state.online)
      .map(item => ({
        target: item.name,
        server: item.state.server,
        reason: item.state.offlineReason || 'offline',
      }));
    if (offlineMentions.length) {
      warnings.push({ code: 'mentions_offline', targets: offlineMentions });
      for (const item of offlineMentions) suppressedRecipients.add(item.target);
    }

    const unknownMentions = mentionStates
      .filter(item => !item.state.exists && !item.isGroupMember)
      .map(item => ({ target: item.name, reason: 'not-found' }));
    if (unknownMentions.length) {
      warnings.push({ code: 'mentions_unknown', targets: unknownMentions });
    }

    const outOfGroupMentions = mentionStates
      .filter(item => item.state.exists && !item.isGroupMember)
      .map(item => ({ target: item.name, reason: 'not-in-group' }));
    if (outOfGroupMentions.length) {
      warnings.push({ code: 'mentions_not_in_group', targets: outOfGroupMentions });
      for (const item of outOfGroupMentions) suppressedRecipients.add(item.target);
    }
  }
  if (suppressedRecipients.size > 0) {
    msg.suppressedRecipients = [...suppressedRecipients];
  }

  messages.push(msg);
  saveMessages();
  broadcastSSE('message', msg);

  // Push notifications
  if (msg.to && directTargetKind === 'agent' && msg.to !== msg.from && !isSuppressedForAgent(msg, msg.to)) {
    const state = getAgentDeliveryState(msg.to);
    if (state.online) pushNotify(msg.to, msg);
  }
  if (msg.group && msg.mentions.length > 0) {
    for (const agent of msg.mentions) {
      if (agent === msg.from || isSuppressedForAgent(msg, agent)) continue;
      const state = getAgentDeliveryState(agent);
      if (state.online) pushNotify(agent, msg);
    }
  }

  res.json({
    ok: true,
    id: msg.id,
    warnings,
    delivery: { suppressed: msg.suppressedRecipients || [], targetKind: directTargetKind || null },
  });
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
  // JSON-encode full text for safe embedding in <script>
  const fullJson = JSON.stringify(msg.full || '');
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message ${escape(msg.id)}</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
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
  .full { font-size: 0.9rem; padding: 1rem; background: #151520; border-radius: 6px; line-height: 1.6; }
  .full h1,.full h2,.full h3,.full h4 { color: #4dabf7; margin-top: 1.2em; margin-bottom: 0.5em; border-bottom: 1px solid #222; padding-bottom: 0.3em; }
  .full h1 { font-size: 1.4em; } .full h2 { font-size: 1.2em; } .full h3 { font-size: 1.05em; }
  .full code { background: #1a1a2e; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Monaco, monospace; font-size: 0.9em; color: #69db7c; }
  .full pre { background: #0d0d1a; padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid #222; }
  .full pre code { background: none; padding: 0; color: #e0e0e0; }
  .full ul,.full ol { padding-left: 1.5em; margin: 0.5em 0; }
  .full li { margin: 0.3em 0; }
  .full blockquote { border-left: 3px solid #4dabf7; margin: 0.8em 0; padding: 0.5em 1em; color: #aaa; background: #0d0d1a; }
  .full table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
  .full th,.full td { border: 1px solid #333; padding: 6px 10px; text-align: left; }
  .full th { background: #1a1a2e; color: #4dabf7; }
  .full strong { color: #ffd43b; }
  .full a { color: #4dabf7; }
  .full p { margin: 0.5em 0; }
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
${msg.reply_to ? '<div class="meta">Reply to: <a href="/msg/' + escape(msg.reply_to) + '" style="color:#4dabf7">' + escape(msg.reply_to) + '</a></div>' : ''}
<div class="summary">${escape(msg.summary).replace(/\\n/g, '<br>').replace(/\n/g, '<br>')}</div>
<h3>Full Message</h3>
<div class="full" id="full-content"></div>
<script>
  const raw = ${fullJson}.replace(/\\\\n/g, '\\n');
  try {
    document.getElementById('full-content').innerHTML = marked.parse(raw);
  } catch(e) {
    document.getElementById('full-content').textContent = raw;
  }
<\/script>
</body></html>`);
});

// ── Inbox ─────────────────────────────────────────────────────────────
app.get('/api/inbox/:agent/unread', (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const snapshot = buildUnreadInboxSnapshot(agentName);
  res.json(snapshot);
});

app.get('/api/inbox/:agent', (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });

  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;
  const inboxId = cursor.inboxId || null;

  const dmRaw = messages
    .filter(m => m.to === agentName && isAfterCursor(m, inboxTs, inboxId) && !isSuppressedForAgent(m, agentName))
    .sort(compareMsgOrder);
  const dm = dmRaw.map(summarizeMsg);

  const groupRaw = messages
    .filter(m => m.group && isGroupMember(m.group, agentName))
    .filter(m => m.mentions.includes(agentName) && isAfterCursor(m, inboxTs, inboxId) && !isSuppressedForAgent(m, agentName))
    .sort(compareMsgOrder);
  const group = groupRaw.map(summarizeMsg);

  // Advance cursor only to the latest delivered message.
  const unread = [...dmRaw, ...groupRaw].sort(compareMsgOrder);
  if (advanceInboxCursor(cursor, unread)) {
    saveCursors();
  }

  res.json({ dm, group });
});

// ── Group messages (unread + read split) ──────────────────────────────
app.get('/api/groups/:name/messages', (req, res) => {
  const groupName = req.params.name;
  if (!groups[groupName]) return res.status(404).json({ error: 'group not found' });

  const agentName = req.query.agent;
  if (!agentName) return res.status(400).json({ error: 'agent query param required' });
  const resolvedAgentName = normalizeAgentName(agentName);
  if (!resolvedAgentName) return res.status(400).json({ error: 'invalid agent query param' });
  if (!isAgentRecord(agents[resolvedAgentName])) return res.status(404).json({ error: 'agent not found' });
  if (!isGroupMember(groupName, resolvedAgentName)) {
    return res.status(403).json({ error: `agent '${resolvedAgentName}' is not a member of group '${groupName}'` });
  }

  const limit = parseInt(req.query.limit) || 10;
  const cursor = ensureCursor(resolvedAgentName);
  const groupCursor = getGroupCursor(cursor, groupName);
  const groupTs = groupCursor.ts;
  const groupId = groupCursor.id;

  const groupMsgs = messages
    .filter(m => m.group === groupName)
    .filter(m => !isSuppressedForAgent(m, resolvedAgentName))
    .sort(compareMsgOrder);
  const unreadRaw = groupMsgs.filter(m => isAfterCursor(m, groupTs, groupId));
  const unread = unreadRaw.map(summarizeMsg);
  const read = groupMsgs.filter(m => !isAfterCursor(m, groupTs, groupId)).slice(-limit).map(summarizeMsg);

  // Advance group cursor only to the last delivered unread message.
  if (advanceGroupCursor(cursor, groupName, unreadRaw)) {
    saveCursors();
  }

  res.json({ group: groupName, unread, read });
});

// ── Agent's groups with unread counts ─────────────────────────────────
app.get('/api/agents/:name/groups', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });

  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;
  const inboxId = cursor.inboxId || null;

  const result = Object.values(groups)
    .filter(g => isGroupMember(g.name, agentName))
    .map(g => {
      const groupMsgs = messages
        .filter(m => m.group === g.name)
        .filter(m => !isSuppressedForAgent(m, agentName))
        .sort(compareMsgOrder);
      const { ts: groupTs, id: groupId } = getGroupCursor(cursor, g.name);

      const unread_messages = groupMsgs.filter(m => isAfterCursor(m, groupTs, groupId)).length;
      const unread_mentions = groupMsgs.filter(m => m.mentions.includes(agentName) && isAfterCursor(m, inboxTs, inboxId)).length;

      return { name: g.name, members: g.members, unread_mentions, unread_messages };
    });

  res.json(result);
});

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown() {
  console.log('Shutting down, saving data...');
  refreshServerLiveness();
  saveAgents();
  saveGroups();
  saveMessages();
  saveCursors();
  saveServers();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

setInterval(() => {
  refreshServerLiveness();
}, SERVER_SWEEP_INTERVAL_MS);

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Chat v2 backend listening on http://127.0.0.1:${PORT}`);
  const agentCount = Object.values(agents).filter(isAgentRecord).length;
  console.log(`  Agents: ${agentCount}, Messages: ${messages.length}, Groups: ${Object.keys(groups).length}`);
});
