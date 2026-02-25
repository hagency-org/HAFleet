import express from 'express';
import { appendFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { createHash } from 'crypto';

const PORT = 8090;
const DATA_DIR = path.resolve('data');
const PUSH_QUEUE_URL = 'http://127.0.0.1:8084/api/queue';
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_SERVER_ID = (process.env.AGENT_CHAT_SERVER || 'local').trim();
const CORS_ALLOWED_ORIGIN = (process.env.FRP_API_ORIGIN || 'https://agentchat.ananthe.party').trim();
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.AGENT_HEARTBEAT_TTL_MS || '90000', 10);
const SERVER_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_SERVER_SWEEP_INTERVAL_MS || '15000', 10);
const HUMAN_SUMMARY_LIMIT = Number.parseInt(process.env.HUMAN_SUMMARY_LIMIT || '50', 10);
const RULE_PUSH_ACK_TIMEOUT_MS = Number.parseInt(process.env.AGENT_RULE_PUSH_ACK_TIMEOUT_MS || '90000', 10);
const RULE_REPLY_TIMEOUT_MS = Number.parseInt(process.env.AGENT_RULE_REPLY_TIMEOUT_MS || '180000', 10);
const RULE_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_RULE_SWEEP_INTERVAL_MS || '15000', 10);
const IDLE_THRESHOLD_MS = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || '20000', 10);
const IDLE_THRESHOLD_SEC = Math.max(1, Math.floor((IDLE_THRESHOLD_MS + 999) / 1000));
const LOCAL_ACTIVITY_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_LOCAL_ACTIVITY_SWEEP_MS || '5000', 10);
const SWAP_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_SWAP_SWEEP_INTERVAL_MS || '5000', 10);
const SWAP_ALERT_THRESHOLD_PCT_RAW = Number.parseFloat(process.env.AGENT_SWAP_ALERT_THRESHOLD_PCT || '80');
const SWAP_ALERT_THRESHOLD_PCT = Number.isFinite(SWAP_ALERT_THRESHOLD_PCT_RAW)
  ? Math.min(99.9, Math.max(1, SWAP_ALERT_THRESHOLD_PCT_RAW))
  : 80;
const SWAP_ALERT_CLEAR_PCT_RAW = Number.parseFloat(process.env.AGENT_SWAP_ALERT_CLEAR_PCT || String(Math.max(1, SWAP_ALERT_THRESHOLD_PCT - 5)));
const SWAP_ALERT_CLEAR_PCT = Number.isFinite(SWAP_ALERT_CLEAR_PCT_RAW)
  ? Math.max(0, Math.min(SWAP_ALERT_THRESHOLD_PCT - 0.1, SWAP_ALERT_CLEAR_PCT_RAW))
  : Math.max(0, SWAP_ALERT_THRESHOLD_PCT - 5);
const AGENT_SCOPE_MONITOR_ENABLED = (process.env.AGENT_SCOPE_MONITOR_ENABLED || 'true').trim().toLowerCase() !== 'false';
const AGENT_SCOPE_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_SCOPE_SWEEP_INTERVAL_MS || '5000', 10);
const AGENT_SCOPE_ALERT_COOLDOWN_MS = Number.parseInt(process.env.AGENT_SCOPE_ALERT_COOLDOWN_MS || '60000', 10);
const AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW = Number.parseFloat(process.env.AGENT_SCOPE_ALERT_CLEAR_RATIO || '0.85');
const AGENT_SCOPE_ALERT_CLEAR_RATIO = Number.isFinite(AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW)
  ? Math.min(0.99, Math.max(0.1, AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW))
  : 0.85;
const OFFLINE_CATCHUP_LIST_LIMIT = Number.parseInt(process.env.OFFLINE_CATCHUP_LIST_LIMIT || '50', 10);
const MESSAGE_ATTACHMENT_MAX_ITEMS = Number.parseInt(process.env.MESSAGE_ATTACHMENT_MAX_ITEMS || '8', 10);
const MESSAGE_ATTACHMENT_MAX_BYTES = Number.parseInt(process.env.MESSAGE_ATTACHMENT_MAX_BYTES || String(20 * 1024 * 1024), 10);
const MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT = (process.env.MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT || '30mb').trim() || '30mb';
const UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS = Number.parseInt(process.env.UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS || '120000', 10);
const AGENT_COMPACT_SUMMARY_MAX = Number.parseInt(process.env.AGENT_COMPACT_SUMMARY_MAX || '180', 10);
const AGENT_COMPACT_RUNTIME_DEDUPE_MS = Number.parseInt(process.env.AGENT_COMPACT_RUNTIME_DEDUPE_MS || '120000', 10);
const AGENT_COMPACT_HOOK_PATTERNS = [
  /\[(?:agent[_-]?compact|compact(?:ion)?)\]/i,
  /\bagent[_-]?compact(?:ion)?\s*:/i,
  /\bcompact[_-]?hook\b/i,
];
const AGENT_COMPACT_FALLBACK_PATTERNS = [
  { marker: 'codex-context-compacted', re: /(?:^|\n)\s*(?:•\s*)?Context compacted\s*(?:\n|$)/i },
  { marker: 'claude-conversation-compacted', re: /(?:^|\n)\s*(?:✻\s*)?Conversation compacted \(ctrl\+o for history\)\s*(?:\n|$)/i },
  { marker: 'claude-compacted-summary', re: /(?:^|\n)\s*(?:⎿\s*)?Compacted \(ctrl\+o to see full summary\)\s*(?:\n|$)/i },
];

mkdirSync(DATA_DIR, { recursive: true });
const MESSAGE_ATTACHMENT_DIR = path.join(DATA_DIR, 'message-attachments');
mkdirSync(MESSAGE_ATTACHMENT_DIR, { recursive: true });
const MATRIX_MEDIA_DIR = path.join(DATA_DIR, 'matrix', 'media');
mkdirSync(MATRIX_MEDIA_DIR, { recursive: true });
const MEDIA_FETCH_ALLOWED_ROOTS = [
  path.resolve(MESSAGE_ATTACHMENT_DIR),
  path.resolve(MATRIX_MEDIA_DIR),
];

// ── Storage helpers ───────────────────────────────────────────────────
function dataPath(name) { return path.join(DATA_DIR, name); }

// We need sync read at startup — use a simple approach
import { readFileSync } from 'fs';

function backupUnreadableJson(filePath) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    console.error(`Backed up unreadable JSON file: ${filePath} -> ${backupPath}`);
  } catch (backupErr) {
    console.error(`Failed to backup unreadable JSON file ${filePath}: ${backupErr.message}`);
  }
}

function loadJsonSync(name, fallback) {
  const filePath = dataPath(name);
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      console.error(`Failed to load JSON ${filePath}: ${e.message}. Using fallback value.`);
      backupUnreadableJson(filePath);
    }
    return fallback;
  }
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
  if (!trimmed) return null;
  // Case-insensitive lookup: return the canonical (stored) name if it exists
  if (agents[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(agents)) {
    if (key.toLowerCase() === lower) return key;
  }
  return trimmed;
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

function makeCompactPreview(text, maxChars = AGENT_COMPACT_SUMMARY_MAX) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = [...normalized];
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join('')}...`;
}

function detectAgentCompactSignal(summary, full) {
  const raw = [summary || '', full || ''].filter(Boolean).join('\n').trim();
  if (!raw) return null;

  for (const re of AGENT_COMPACT_HOOK_PATTERNS) {
    if (re.test(raw)) return { mode: 'hook', marker: 'explicit-hook' };
  }
  for (const pattern of AGENT_COMPACT_FALLBACK_PATTERNS) {
    if (pattern.re.test(raw)) return { mode: 'pattern', marker: pattern.marker };
  }
  return null;
}

function buildAgentCompactEvent(msg, senderIsAgent) {
  if (!senderIsAgent) return null;
  if (!msg || msg.type === 'human' || msg.from === 'system') return null;
  const signal = detectAgentCompactSignal(msg.summary, msg.full);
  if (!signal) return null;

  const summary = makeCompactPreview(msg.summary || msg.full || '', AGENT_COMPACT_SUMMARY_MAX);
  return {
    id: `compact_${msg.id}`,
    ts: msg.ts || Date.now(),
    messageId: msg.id,
    agent: msg.from,
    mode: signal.mode,
    marker: signal.marker || null,
    source: 'message',
    summary,
  };
}

function normalizeCompactMarker(value) {
  const marker = (typeof value === 'string' && value.trim()) ? value.trim().toLowerCase() : '';
  if (!marker) return 'unknown';
  if (marker === 'explicit-hook') return marker;
  if (AGENT_COMPACT_FALLBACK_PATTERNS.some(p => p.marker === marker)) return marker;
  return 'unknown';
}

function pruneCompactRuntimeDedupState(now = Date.now()) {
  if (compactRuntimeAlertAt.size < 2000) return;
  const cutoff = now - Math.max(AGENT_COMPACT_RUNTIME_DEDUPE_MS * 4, 60_000);
  for (const [key, ts] of compactRuntimeAlertAt.entries()) {
    if ((Number(ts) || 0) < cutoff) compactRuntimeAlertAt.delete(key);
  }
}

function buildRuntimeCompactEvent(agentName, payload = {}) {
  const now = Date.now();
  const modeRaw = (typeof payload.mode === 'string' && payload.mode.trim()) ? payload.mode.trim().toLowerCase() : 'pattern';
  const mode = modeRaw === 'hook' ? 'hook' : 'pattern';
  const marker = normalizeCompactMarker(payload.marker);
  const summaryInput = (typeof payload.summary === 'string' && payload.summary.trim())
    ? payload.summary.trim()
    : marker.replace(/-/g, ' ');
  const source = (typeof payload.source === 'string' && payload.source.trim())
    ? payload.source.trim()
    : 'runtime';

  return {
    id: `compact_runtime_${agentName}_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    messageId: null,
    agent: agentName,
    mode,
    marker,
    source,
    summary: makeCompactPreview(summaryInput, AGENT_COMPACT_SUMMARY_MAX),
  };
}

function normalizeAttachmentName(value, fallback = 'file') {
  let name = typeof value === 'string' ? value.trim() : '';
  if (!name) name = fallback;
  name = path.basename(name);
  name = name.replace(/[^\w.\-()[\] ]+/g, '_');
  if (!name) name = fallback;
  if (name.length > 120) {
    const ext = path.extname(name);
    const stem = name.slice(0, Math.max(1, 120 - ext.length));
    name = `${stem}${ext}`;
  }
  return name;
}

function normalizeAttachmentMime(value) {
  if (typeof value !== 'string') return null;
  const mime = value.trim().toLowerCase();
  if (!mime) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return null;
  return mime;
}

function inferAttachmentKind(rawKind, mime, name) {
  if (rawKind === 'image' || rawKind === 'file') return rawKind;
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  const lower = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/.test(lower)) return 'image';
  return 'file';
}

function normalizeAttachmentInput(raw) {
  const item = (typeof raw === 'string') ? { path: raw } : (raw && typeof raw === 'object' ? raw : null);
  if (!item) return { error: 'invalid attachment item' };

  const pathValue = typeof item.path === 'string' ? item.path.trim() : '';
  if (!pathValue) return { error: 'attachment.path required' };
  if (pathValue.length > 4096) return { error: 'attachment.path too long' };

  const fallbackName = path.basename(pathValue) || 'file';
  const name = normalizeAttachmentName(item.name, fallbackName);
  const mime = normalizeAttachmentMime(item.mime);
  const kind = inferAttachmentKind(item.kind, mime, name);
  const sizeRaw = Number.parseInt(item.size, 10);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;
  const staged = item.staged === true;
  const sourcePath = (typeof item.source_path === 'string' && item.source_path.trim())
    ? item.source_path.trim().slice(0, 1024)
    : null;

  return {
    value: {
      path: pathValue,
      name,
      mime,
      kind,
      size,
      staged,
      source_path: sourcePath,
    },
  };
}

function isPathWithinRoot(filePath, rootPath) {
  return filePath === rootPath || filePath.startsWith(`${rootPath}${path.sep}`);
}

function resolveReadableMediaPath(rawPath) {
  const requested = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!requested) return { error: 'path required', status: 400 };
  if (requested.length > 4096) return { error: 'path too long', status: 400 };

  const resolved = path.resolve(requested);
  const allowed = MEDIA_FETCH_ALLOWED_ROOTS.some(rootPath => isPathWithinRoot(resolved, rootPath));
  if (!allowed) return { error: 'path not allowed', status: 403 };

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return { error: 'file not found', status: 404 };
  }
  if (!stat.isFile()) return { error: 'path is not a file', status: 400 };
  if (stat.size <= 0) return { error: 'file is empty', status: 400 };
  if (stat.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    return { error: `file exceeds max bytes (${MESSAGE_ATTACHMENT_MAX_BYTES})`, status: 413 };
  }
  return { value: { path: resolved, size: stat.size } };
}

function guessMimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    case '.avif': return 'image/avif';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
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
const agentRuntime = loadJsonSync('agent_runtime.json', {});
let msgCounter = loadJsonSync('.msg_counter', 0);
const localActivityState = new Map(); // agent -> { lastHash, lastChangeSec, burstStartSec, burstLastSec }
const SYSTEM_INFO_LOG = dataPath('system-info.jsonl');
const unexpectedOfflineAlertAt = new Map(); // key(agent:reason) -> ts
const compactRuntimeAlertAt = new Map(); // key(agent:marker:mode) -> ts
const swapAlertState = {
  active: false,
  lastPct: 0,
  lastAlertAt: 0,
};
const scopePressureState = new Map(); // agent -> { high:bool, lastAlertAt:number }
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
  if (!Object.prototype.hasOwnProperty.call(agent, 'manualDown')) {
    agent.manualDown = false;
  } else {
    agent.manualDown = agent.manualDown === true;
  }
  if (!Object.prototype.hasOwnProperty.call(agent, 'discoveredAt')) {
    agent.discoveredAt = agent.registeredAt || agent.lastSeen || Date.now();
  }
  agent.kind = inferRecordKind(agent);
  if (agent.kind === 'human') {
    agent.online = false;
    agent.offlineReason = null;
    agent.manualDown = false;
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
    servers[serverId] = {
      id: serverId,
      lastSeen: 0,
      heartbeatAt: 0,
      relayInstanceId: null,
      relayBootTs: 0,
      online: false,
      updatedAt: Date.now(),
      sessions: [],
      agents: [],
      agentCount: 0,
    };
    continue;
  }
  server.id = server.id || serverId;
  server.lastSeen = Number(server.lastSeen) || 0;
  server.heartbeatAt = Number(server.heartbeatAt) || server.lastSeen || 0;
  server.relayInstanceId = (typeof server.relayInstanceId === 'string' && server.relayInstanceId.trim())
    ? server.relayInstanceId.trim()
    : null;
  server.relayBootTs = Number(server.relayBootTs) || 0;
  server.online = Boolean(server.online);
  server.updatedAt = Number(server.updatedAt) || server.lastSeen || 0;
  if (!Array.isArray(server.sessions)) server.sessions = [];
  if (!Array.isArray(server.agents)) server.agents = [];
  server.agentCount = Number(server.agentCount) || server.agents.length || 0;
}

for (const [agentName, runtime] of Object.entries(agentRuntime)) {
  if (!runtime || typeof runtime !== 'object') {
    delete agentRuntime[agentName];
    continue;
  }
  runtime.agent = agentName;
  runtime.blocked = runtime.blocked === true;
  runtime.blockedReason = (typeof runtime.blockedReason === 'string' && runtime.blockedReason.trim())
    ? runtime.blockedReason.trim()
    : null;
  runtime.blockedSince = Number(runtime.blockedSince) || null;
  runtime.updatedAt = Number(runtime.updatedAt) || 0;
  runtime.lastSeen = Number(runtime.lastSeen) || 0;
  runtime.lastPushNotifyAt = Number(runtime.lastPushNotifyAt) || 0;
  runtime.lastPushQueuedAt = Number(runtime.lastPushQueuedAt) || 0;
  runtime.lastPushDeliveredAt = Number(runtime.lastPushDeliveredAt) || 0;
  runtime.lastPushDeliveryDelayMs = Number(runtime.lastPushDeliveryDelayMs) || 0;
  runtime.lastActionablePushAt = Number(runtime.lastActionablePushAt) || 0;
  runtime.lastPushQueueEntryId = Number(runtime.lastPushQueueEntryId) || 0;
  runtime.lastPushNeedsInboxCheck = runtime.lastPushNeedsInboxCheck === true;
  runtime.lastPushUnreadCount = Number(runtime.lastPushUnreadCount) || 0;
  runtime.lastPushKind = (typeof runtime.lastPushKind === 'string' && runtime.lastPushKind.trim())
    ? runtime.lastPushKind.trim()
    : 'unknown';
  runtime.lastPushSourceMsgId = (typeof runtime.lastPushSourceMsgId === 'string' && runtime.lastPushSourceMsgId.trim())
    ? runtime.lastPushSourceMsgId.trim()
    : null;
  runtime.lastInboxCheckAt = Number(runtime.lastInboxCheckAt) || 0;
  runtime.lastAgentOutboundAt = Number(runtime.lastAgentOutboundAt) || 0;
  runtime.lastBlockedTail = (typeof runtime.lastBlockedTail === 'string') ? runtime.lastBlockedTail : '';
  runtime.lastBlockedCommand = (typeof runtime.lastBlockedCommand === 'string') ? runtime.lastBlockedCommand : '';
  runtime.lastBlockedServer = normalizeServer(runtime.lastBlockedServer);
  runtime.activeNow = runtime.activeNow === true;
  runtime.activeDurationSec = Number(runtime.activeDurationSec) || 0;
  runtime.idleDurationSec = Number(runtime.idleDurationSec) || 0;
  runtime.lastTmuxActivitySec = Number(runtime.lastTmuxActivitySec) || null;
  if (!runtime.rules || typeof runtime.rules !== 'object') runtime.rules = {};
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
function saveAgentRuntime() { saveJson('agent_runtime.json', agentRuntime); }

function ensureAgentRecord(name, defaults = {}) {
  const agentName = normalizeAgentName(name);
  if (!agentName) return null;
  if (agents[agentName]) return { agent: agents[agentName], created: false };

  const now = Date.now();
  const server = defaults.server !== undefined ? normalizeServer(defaults.server) : null;
  const tmux = (typeof defaults.tmux === 'string' && defaults.tmux.trim()) ? defaults.tmux.trim() : null;
  const online = defaults.online === true;
  const manualDown = defaults.manualDown === true && !online;
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
    manualDown,
    discoveredAt: now,
    registeredAt: Number(defaults.registeredAt) > 0 ? Number(defaults.registeredAt) : now,
    kind,
  };
  agents[agentName] = agent;
  return { agent, created: true };
}

function isManualDownReason(reason) {
  const text = (typeof reason === 'string' ? reason.trim().toLowerCase() : '');
  if (!text) return false;
  return text === 'manual-offline'
    || text === 'session-missing'
    || text.startsWith('agent-down');
}

function maybeEmitUnexpectedOfflineAlert(agentName, reason, context = {}) {
  if (!agentName) return;
  if (isManualDownReason(reason)) return;
  const now = Date.now();
  const key = `${agentName}:${reason || 'unknown'}`;
  const prev = unexpectedOfflineAlertAt.get(key) || 0;
  if ((now - prev) < UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS) return;
  unexpectedOfflineAlertAt.set(key, now);

  const lines = [
    `Agent: ${agentName}`,
    `Reason: ${reason || 'unknown'}`,
    `Server: ${context.server || 'local'}`,
    'This looks like an unexpected shutdown/crash. Please intervene manually.',
  ];
  if (context.detail) lines.push(`Detail: ${context.detail}`);
  emitSystemInfo(`Agent '${agentName}' went offline unexpectedly`, lines.join('\n'));
}

function ensureInfoGroup() {
  if (!groups.info) {
    groups.info = { name: 'info', members: [], createdAt: Date.now() };
    saveGroups();
  }
}

function emitSystemInfo(summary, full = '') {
  ensureInfoGroup();
  const event = {
    id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    summary,
    full: full || '',
    source: 'system',
    group: 'info',
    type: 'inform',
  };
  try {
    appendFileSync(SYSTEM_INFO_LOG, JSON.stringify(event) + '\n');
  } catch (e) {
    console.error(`Failed to append system info log: ${e.message}`);
  }
  broadcastSSE('system_info', event);
  return event;
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
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
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

function messageTargetsAgent(msg, agentName) {
  if (!msg || !agentName) return false;
  if (msg.to === agentName) return true;
  if (!msg.group) return false;
  if (!isGroupMember(msg.group, agentName)) return false;
  return Array.isArray(msg.mentions) && msg.mentions.includes(agentName);
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

function ensureAgentRuntimeRecord(name) {
  const agentName = normalizeAgentName(name);
  if (!agentName) return null;
  if (!agentRuntime[agentName] || typeof agentRuntime[agentName] !== 'object') {
    agentRuntime[agentName] = {
      agent: agentName,
      blocked: false,
      blockedReason: null,
      blockedSince: null,
      activeNow: false,
      activeDurationSec: 0,
      idleDurationSec: 0,
      lastTmuxActivitySec: null,
      updatedAt: 0,
      lastSeen: 0,
      lastPushNotifyAt: 0,
      lastPushQueuedAt: 0,
      lastPushDeliveredAt: 0,
      lastPushDeliveryDelayMs: 0,
      lastActionablePushAt: 0,
      lastPushQueueEntryId: 0,
      lastPushNeedsInboxCheck: false,
      lastPushUnreadCount: 0,
      lastPushKind: 'unknown',
      lastPushSourceMsgId: null,
      lastInboxCheckAt: 0,
      lastAgentOutboundAt: 0,
      lastBlockedTail: '',
      lastBlockedCommand: '',
      lastBlockedServer: null,
      rules: {},
    };
  }
  return agentRuntime[agentName];
}

function normalizePushMeta(meta = {}) {
  const pushMeta = (meta && typeof meta === 'object') ? meta : {};
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
    kind: safeStr(pushMeta.kind, 'unknown'),
    requiresInboxCheck: safeBool(pushMeta.requiresInboxCheck),
    sourceMsgId: safeStr(pushMeta.sourceMsgId, null),
    unreadCount: safeInt(pushMeta.unreadCount),
    hasHumanUnread: safeBool(pushMeta.hasHumanUnread),
    hasRequestUnread: safeBool(pushMeta.hasRequestUnread),
    needsReply: safeBool(pushMeta.needsReply),
    hasMcp: safeBool(pushMeta.hasMcp),
  };
}

function markAgentPushNotified(agentName, details = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  const now = Date.now();
  const queuedAt = Number(details.queuedAt) || now;
  const queueEntryId = Number(details.queueEntryId) || 0;
  const meta = normalizePushMeta(details);
  runtime.lastPushNotifyAt = now;
  runtime.lastPushQueuedAt = queuedAt;
  runtime.lastPushQueueEntryId = queueEntryId;
  runtime.lastPushKind = meta.kind;
  runtime.lastPushNeedsInboxCheck = meta.requiresInboxCheck;
  runtime.lastPushUnreadCount = meta.unreadCount;
  runtime.lastPushSourceMsgId = meta.sourceMsgId;
  runtime.lastSeen = now;
  runtime.updatedAt = now;
  saveAgentRuntime();
}

function markAgentPushDelivered(agentName, details = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  const now = Date.now();
  const deliveredAt = Number(details.deliveredAt) || now;
  const queuedAt = Number(details.queuedAt) || runtime.lastPushQueuedAt || deliveredAt;
  const meta = normalizePushMeta(details);
  const delay = Math.max(0, deliveredAt - queuedAt);

  runtime.lastPushDeliveredAt = deliveredAt;
  runtime.lastPushQueuedAt = queuedAt;
  runtime.lastPushDeliveryDelayMs = delay;
  runtime.lastPushKind = meta.kind;
  runtime.lastPushNeedsInboxCheck = meta.requiresInboxCheck;
  runtime.lastPushUnreadCount = meta.unreadCount;
  runtime.lastPushSourceMsgId = meta.sourceMsgId;
  if (meta.requiresInboxCheck) {
    runtime.lastActionablePushAt = deliveredAt;
  }
  runtime.lastSeen = deliveredAt;
  runtime.updatedAt = deliveredAt;
  saveAgentRuntime();
}

function markAgentInboxChecked(agentName) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  const now = Date.now();
  runtime.lastInboxCheckAt = now;
  runtime.lastSeen = now;
  runtime.updatedAt = now;
  saveAgentRuntime();
}

function markAgentOutbound(agentName) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  const now = Date.now();
  runtime.lastAgentOutboundAt = now;
  runtime.lastSeen = now;
  runtime.updatedAt = now;
  saveAgentRuntime();
}

function setRuntimeActivityFields(runtime, payload = {}) {
  let changed = false;
  if (!runtime || typeof runtime !== 'object') return false;

  const hasActiveNow = payload.activeNow === true || payload.activeNow === false;
  if (hasActiveNow && runtime.activeNow !== payload.activeNow) {
    runtime.activeNow = payload.activeNow;
    changed = true;
  }
  if (payload.activeDurationSec !== undefined && payload.activeDurationSec !== null) {
    const activeDurationSec = Math.max(0, Number.parseInt(payload.activeDurationSec, 10) || 0);
    if (runtime.activeDurationSec !== activeDurationSec) {
      runtime.activeDurationSec = activeDurationSec;
      changed = true;
    }
  }
  if (payload.idleDurationSec !== undefined && payload.idleDurationSec !== null) {
    const idleDurationSec = Math.max(0, Number.parseInt(payload.idleDurationSec, 10) || 0);
    if (runtime.idleDurationSec !== idleDurationSec) {
      runtime.idleDurationSec = idleDurationSec;
      changed = true;
    }
  }
  if (payload.lastTmuxActivitySec !== undefined) {
    const v = Number.parseInt(payload.lastTmuxActivitySec, 10);
    const normalized = Number.isFinite(v) && v > 0 ? v : null;
    if ((runtime.lastTmuxActivitySec || null) !== normalized) {
      runtime.lastTmuxActivitySec = normalized;
      changed = true;
    }
  }
  return changed;
}

function isHumanMessageToAgent(msg, agentName) {
  if (!msg || msg.type !== 'human') return false;
  if (msg.to === agentName) return true;
  if (msg.group && Array.isArray(msg.mentions) && msg.mentions.includes(agentName)) return true;
  return false;
}

function didAgentAcknowledgeActionablePush(agentName, runtime, actionablePushAt, latestActionableMsg) {
  if (!runtime || (Number(runtime.lastAgentOutboundAt) || 0) < actionablePushAt) return false;
  if (!latestActionableMsg) return true;

  const sourceId = typeof latestActionableMsg.id === 'string' ? latestActionableMsg.id : null;
  const sourceFrom = typeof latestActionableMsg.from === 'string' ? latestActionableMsg.from : null;
  const sourceGroup = typeof latestActionableMsg.group === 'string' ? latestActionableMsg.group : null;

  let scanned = 0;
  const maxScan = 400;
  for (let i = messages.length - 1; i >= 0 && scanned < maxScan; i--) {
    const msg = messages[i];
    if (!msg || msg.from !== agentName) continue;
    scanned++;

    const ts = Number(msg.ts) || 0;
    if (ts < actionablePushAt) break;
    if (sourceId && msg.reply_to === sourceId) return true;
    if (sourceGroup && msg.group === sourceGroup) return true;
    if (!sourceGroup && sourceFrom && msg.to === sourceFrom) return true;
  }
  return false;
}

function collectBlockedHumanTargets(agentName) {
  const unreadHuman = getUnreadInboxMessages(agentName).unread
    .filter(m => m.type === 'human' && m.from && m.from !== agentName);
  const selected = new Map();
  const unreadIds = new Set(unreadHuman.map(m => m.id));

  for (const msg of unreadHuman) {
    const prev = selected.get(msg.from);
    if (!prev || compareMsgOrder(msg, prev) > 0) {
      selected.set(msg.from, msg);
    }
  }

  if (selected.size === 0) {
    let latest = null;
    for (const msg of messages) {
      if (!isHumanMessageToAgent(msg, agentName)) continue;
      if (msg.from === agentName) continue;
      if (!latest || compareMsgOrder(msg, latest) > 0) latest = msg;
    }
    if (latest) selected.set(latest.from, latest);
  }

  const targets = [...selected.values()]
    .sort(compareMsgOrder)
    .map(msg => ({
      human: msg.from,
      roomId: (typeof msg.sourceRoom === 'string' && msg.sourceRoom.trim()) ? msg.sourceRoom.trim() : null,
      group: msg.group || null,
      messageId: msg.id,
      pending: unreadIds.has(msg.id),
      ts: msg.ts,
    }));

  return {
    hasPendingHuman: unreadHuman.length > 0,
    targets,
  };
}

function applyAgentBlockedRuntime(agentName, payload = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return null;

  const now = Date.now();
  const blockedNow = payload.blocked === true;
  const reasonNow = blockedNow && typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : null;
  const tailNow = blockedNow && typeof payload.tail === 'string' ? payload.tail : '';
  const cmdNow = blockedNow && typeof payload.command === 'string' ? payload.command : '';
  const serverNow = blockedNow ? normalizeServer(payload.server) : null;

  const prevBlocked = runtime.blocked === true;
  const prevReason = runtime.blockedReason || null;
  let changed = false;

  if (runtime.blocked !== blockedNow) { runtime.blocked = blockedNow; changed = true; }
  if ((runtime.blockedReason || null) !== reasonNow) { runtime.blockedReason = reasonNow; changed = true; }
  if (runtime.lastSeen !== now) { runtime.lastSeen = now; changed = true; }
  if (runtime.updatedAt !== now) { runtime.updatedAt = now; changed = true; }
  if (blockedNow) {
    const blockedSince = prevBlocked ? (runtime.blockedSince || now) : now;
    if (runtime.blockedSince !== blockedSince) { runtime.blockedSince = blockedSince; changed = true; }
    if (runtime.lastBlockedTail !== tailNow) { runtime.lastBlockedTail = tailNow; changed = true; }
    if (runtime.lastBlockedCommand !== cmdNow) { runtime.lastBlockedCommand = cmdNow; changed = true; }
    if ((runtime.lastBlockedServer || null) !== (serverNow || null)) { runtime.lastBlockedServer = serverNow; changed = true; }
  } else {
    if (runtime.blockedSince !== null) { runtime.blockedSince = null; changed = true; }
    if (runtime.lastBlockedTail !== '') { runtime.lastBlockedTail = ''; changed = true; }
    if (runtime.lastBlockedCommand !== '') { runtime.lastBlockedCommand = ''; changed = true; }
    if (runtime.lastBlockedServer !== null) { runtime.lastBlockedServer = null; changed = true; }
  }

  if (setRuntimeActivityFields(runtime, payload)) changed = true;
  if (changed) saveAgentRuntime();

  const becameBlocked = !prevBlocked && blockedNow;
  const reasonChanged = prevBlocked && blockedNow && reasonNow && reasonNow !== prevReason;
  const recovered = prevBlocked && !blockedNow;

  if (becameBlocked || reasonChanged) {
    const blockedSummary = `Agent '${agentName}' entered blocked state`;
    const { hasPendingHuman, targets } = collectBlockedHumanTargets(agentName);
    const fullLines = [
      `Agent: ${agentName}`,
      `Reason: ${reasonNow || 'unknown'}`,
      `Server: ${serverNow || 'local'}`,
      `Pending human messages: ${hasPendingHuman ? 'yes' : 'no'}`,
      `Target humans: ${targets.map(t => t.human).join(', ') || 'none'}`,
    ];
    if (tailNow) {
      fullLines.push('');
      fullLines.push('Tail sample:');
      fullLines.push(tailNow);
    }
    emitSystemInfo(blockedSummary, fullLines.join('\n'));
    broadcastSSE('agent_blocked', {
      agent: agentName,
      reason: reasonNow || 'unknown',
      blockedSince: runtime.blockedSince || now,
      server: serverNow || null,
      hasPendingHuman,
      targets,
    });
  } else if (recovered) {
    emitSystemInfo(`Agent '${agentName}' recovered from blocked state`, `Agent '${agentName}' is no longer blocked.`);
    broadcastSSE('agent_recovered', {
      agent: agentName,
      recoveredAt: now,
    });
  }

  return runtime;
}

function setAgentRuleState(agentName, code, active, buildDetail) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  if (!runtime.rules || typeof runtime.rules !== 'object') runtime.rules = {};
  const now = Date.now();
  const prev = runtime.rules[code] || { active: false, changedAt: 0, firedAt: 0 };
  if (prev.active === active) return;

  runtime.rules[code] = {
    active,
    changedAt: now,
    firedAt: active ? now : prev.firedAt || 0,
  };
  runtime.updatedAt = now;
  saveAgentRuntime();

  if (active) {
    const detail = typeof buildDetail === 'function' ? buildDetail() : '';
    emitSystemInfo(
      `Agent '${agentName}' rule alert: ${code}`,
      detail || `Rule ${code} triggered for agent '${agentName}'.`
    );
  }
}

function sweepAgentRules() {
  const now = Date.now();
  for (const [agentName, agent] of Object.entries(agents)) {
    if (!isAgentRecord(agent)) continue;
    const state = getAgentDeliveryState(agentName);
    const runtime = ensureAgentRuntimeRecord(agentName);
    if (!runtime) continue;

    if (!state.online || runtime.blocked === true) {
      setAgentRuleState(agentName, 'no_inbox_check_after_push', false);
      setAgentRuleState(agentName, 'inbox_checked_no_reply', false);
      continue;
    }

    const unread = getUnreadInboxMessages(agentName).unread;
    const unreadHuman = unread.filter(m => m.type === 'human');
    const unreadActionable = unread.filter(m => m.type === 'human' || m.type === 'request');
    const actionablePushAt = Number(runtime.lastActionablePushAt) || 0;
    const latestActionableUnread = unreadActionable[unreadActionable.length - 1] || null;
    const activeNow = runtime.activeNow === true;
    const idleDurationSec = Math.max(0, Number(runtime.idleDurationSec) || 0);
    const idleGateReady = !activeNow && idleDurationSec >= 1;
    const outboundAcked = didAgentAcknowledgeActionablePush(
      agentName,
      runtime,
      actionablePushAt,
      latestActionableUnread
    );
    const needsInboxCheck = actionablePushAt > 0
      && runtime.lastInboxCheckAt < actionablePushAt
      && !outboundAcked
      && idleGateReady
      && (now - actionablePushAt) >= RULE_PUSH_ACK_TIMEOUT_MS;
    setAgentRuleState(agentName, 'no_inbox_check_after_push', needsInboxCheck, () => {
      return [
        `Agent: ${agentName}`,
        `lastPushNotifyAt: ${runtime.lastPushNotifyAt ? new Date(runtime.lastPushNotifyAt).toISOString() : 'n/a'}`,
        `lastPushQueuedAt: ${runtime.lastPushQueuedAt ? new Date(runtime.lastPushQueuedAt).toISOString() : 'n/a'}`,
        `lastPushDeliveredAt: ${runtime.lastPushDeliveredAt ? new Date(runtime.lastPushDeliveredAt).toISOString() : 'n/a'}`,
        `lastActionablePushAt: ${actionablePushAt ? new Date(actionablePushAt).toISOString() : 'n/a'}`,
        `lastPushKind: ${runtime.lastPushKind || 'unknown'}`,
        `lastPushNeedsInboxCheck: ${runtime.lastPushNeedsInboxCheck === true ? 'yes' : 'no'}`,
        `lastPushDeliveryDelayMs: ${Number(runtime.lastPushDeliveryDelayMs) || 0}`,
        `lastInboxCheckAt: ${runtime.lastInboxCheckAt ? new Date(runtime.lastInboxCheckAt).toISOString() : 'n/a'}`,
        `lastAgentOutboundAt: ${runtime.lastAgentOutboundAt ? new Date(runtime.lastAgentOutboundAt).toISOString() : 'n/a'}`,
        `activeNow: ${activeNow ? 'yes' : 'no'}`,
        `idleDurationSec: ${idleDurationSec}`,
        `idleGateReady: ${idleGateReady ? 'yes' : 'no'} (requires activeNow=no and idleDurationSec>=1)`,
        `idleThresholdMs: ${IDLE_THRESHOLD_MS}`,
        `outboundAcked: ${outboundAcked ? 'yes' : 'no'}`,
        `latestActionableUnreadId: ${latestActionableUnread?.id || 'n/a'}`,
        `timeoutMs: ${RULE_PUSH_ACK_TIMEOUT_MS}`,
      ].join('\n');
    });

    const checkedButNoReply = actionablePushAt > 0
      && runtime.lastInboxCheckAt >= actionablePushAt
      && runtime.lastAgentOutboundAt < runtime.lastInboxCheckAt
      && unreadHuman.filter(m => (Number(m.ts) || 0) <= runtime.lastInboxCheckAt).length > 0
      && (now - runtime.lastInboxCheckAt) >= RULE_REPLY_TIMEOUT_MS;
    setAgentRuleState(agentName, 'inbox_checked_no_reply', checkedButNoReply, () => {
      const unreadHumanBeforeCheck = unreadHuman.filter(m => (Number(m.ts) || 0) <= runtime.lastInboxCheckAt);
      const unreadHumanAfterCheck = unreadHuman.filter(m => (Number(m.ts) || 0) > runtime.lastInboxCheckAt);
      const humans = [...new Set(unreadHuman.map(m => m.from).filter(Boolean))];
      return [
        `Agent: ${agentName}`,
        `lastInboxCheckAt: ${new Date(runtime.lastInboxCheckAt).toISOString()}`,
        `lastAgentOutboundAt: ${runtime.lastAgentOutboundAt ? new Date(runtime.lastAgentOutboundAt).toISOString() : 'n/a'}`,
        `unreadHuman: ${unreadHuman.length}`,
        `unreadHumanBeforeCheck: ${unreadHumanBeforeCheck.length}`,
        `unreadHumanAfterCheck: ${unreadHumanAfterCheck.length}`,
        `senders: ${humans.join(', ') || 'none'}`,
        `timeoutMs: ${RULE_REPLY_TIMEOUT_MS}`,
      ].join('\n');
    });
  }
}

function ensureServerRecord(serverId) {
  if (!serverId) return null;
  if (!servers[serverId] || typeof servers[serverId] !== 'object') {
    servers[serverId] = {
      id: serverId,
      lastSeen: 0,
      heartbeatAt: 0,
      relayInstanceId: null,
      relayBootTs: 0,
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
    if (agent.manualDown === true) {
      if (clearTmux && agent.tmux !== null) { agent.tmux = null; changed = true; }
      continue;
    }
    if (agent.offlineReason !== reason) { agent.offlineReason = reason; changed = true; }
    if (agent.manualDown !== false) { agent.manualDown = false; changed = true; }
    if (clearTmux && agent.tmux !== null) { agent.tmux = null; changed = true; }
  }
  return changed;
}

function clearServerLiveState(server, now = Date.now()) {
  if (!server || typeof server !== 'object') return false;
  let changed = false;
  if (server.online !== false) { server.online = false; changed = true; }
  if (!Array.isArray(server.sessions) || server.sessions.length !== 0) { server.sessions = []; changed = true; }
  if (!Array.isArray(server.agents) || server.agents.length !== 0) { server.agents = []; changed = true; }
  if ((Number(server.agentCount) || 0) !== 0) { server.agentCount = 0; changed = true; }
  if (server.relayInstanceId !== null) { server.relayInstanceId = null; changed = true; }
  if ((Number(server.relayBootTs) || 0) !== 0) { server.relayBootTs = 0; changed = true; }
  if ((Number(server.updatedAt) || 0) !== now) { server.updatedAt = now; changed = true; }
  return changed;
}

function normalizeRelayInstanceId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRelayBootTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function evaluateHeartbeatLease(server, incomingInstanceId, incomingBootTs, now) {
  const currentInstanceId = normalizeRelayInstanceId(server?.relayInstanceId);
  const currentBootTs = normalizeRelayBootTs(server?.relayBootTs);
  const hasActiveLease = Boolean(server?.online)
    && Number(server?.heartbeatAt) > 0
    && (now - Number(server.heartbeatAt)) <= HEARTBEAT_TTL_MS
    && Boolean(currentInstanceId);

  // Backward compatibility: old relays without lease metadata.
  if (!incomingInstanceId) {
    if (!hasActiveLease) return { accept: true, takeover: false, reason: 'no-instance-id' };
    return { accept: false, takeover: false, reason: 'missing-instance-id-while-lease-active' };
  }
  if (!currentInstanceId) return { accept: true, takeover: false, reason: 'lease-empty' };
  if (incomingInstanceId === currentInstanceId) return { accept: true, takeover: false, reason: 'same-instance' };
  if (!hasActiveLease) return { accept: true, takeover: true, reason: 'stale-lease' };

  if (incomingBootTs > 0 && currentBootTs > 0) {
    if (incomingBootTs > currentBootTs) return { accept: true, takeover: true, reason: 'newer-boot' };
    return { accept: false, takeover: false, reason: 'older-boot' };
  }
  if (incomingBootTs > 0 && currentBootTs === 0) return { accept: true, takeover: true, reason: 'boot-present-over-empty' };
  if (incomingBootTs === 0 && currentBootTs > 0) return { accept: false, takeover: false, reason: 'missing-boot-ts' };
  return { accept: false, takeover: false, reason: 'different-instance-active' };
}

function refreshServerLiveness() {
  const now = Date.now();
  let serversChanged = false;
  let agentsChanged = false;
  for (const [serverId, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    const wasOnline = Boolean(server.online);
    const heartbeatAt = Number(server.heartbeatAt) || 0;
    const isOnline = heartbeatAt > 0 && (now - heartbeatAt) <= HEARTBEAT_TTL_MS;
    if (server.online !== isOnline) {
      if (!isOnline) {
        if (clearServerLiveState(server, now)) serversChanged = true;
      } else {
        server.online = true;
        server.updatedAt = now;
        serversChanged = true;
      }
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

function getLocalPaneContentHash(tmuxTarget) {
  if (!tmuxTarget) return null;
  try {
    const raw = execSync(`tmux capture-pane -p -t ${JSON.stringify(tmuxTarget)} 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf-8',
    });
    return createHash('md5').update(raw).digest('hex');
  } catch {
    return null;
  }
}

function localTmuxSessionExists(tmuxTarget) {
  if (!tmuxTarget) return false;
  const sessionName = String(tmuxTarget).split(':')[0].trim();
  if (!sessionName) return false;
  try {
    execSync(`tmux has-session -t ${JSON.stringify(sessionName)} 2>/dev/null`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function isEphemeralAuditAgentName(name) {
  return typeof name === 'string' && /-system_audit-[a-z0-9]+$/i.test(name);
}

function pruneEphemeralAgents(names = [], reason = 'ephemeral-prune') {
  const unique = [...new Set((Array.isArray(names) ? names : []).filter(Boolean))];
  if (unique.length === 0) return;

  let agentsChanged = false;
  let runtimeChanged = false;
  let cursorsChanged = false;
  let groupsChanged = false;
  const removed = [];

  for (const name of unique) {
    const agent = agents[name];
    if (!isAgentRecord(agent)) continue;
    if (!isEphemeralAuditAgentName(name)) continue;

    delete agents[name];
    agentsChanged = true;
    removed.push(name);

    if (agentRuntime[name] !== undefined) {
      delete agentRuntime[name];
      runtimeChanged = true;
    }
    if (cursors[name] !== undefined) {
      delete cursors[name];
      cursorsChanged = true;
    }
    for (const group of Object.values(groups)) {
      if (!Array.isArray(group?.members)) continue;
      const nextMembers = group.members.filter(m => m !== name);
      if (nextMembers.length !== group.members.length) {
        group.members = nextMembers;
        groupsChanged = true;
      }
    }
  }

  if (agentsChanged) saveAgents();
  if (runtimeChanged) saveAgentRuntime();
  if (cursorsChanged) saveCursors();
  if (groupsChanged) saveGroups();

  // Intentionally silent: ephemeral audit agent pruning is routine housekeeping.
}

function sweepLocalActivityDurations() {
  const nowSec = Math.floor(Date.now() / 1000);
  let runtimeChanged = false;
  let agentsChanged = false;
  const pruneCandidates = new Set();

  for (const agent of Object.values(agents)) {
    if (!isAgentRecord(agent)) continue;
    const serverId = normalizeServer(agent.server);
    const isLocalAgent = !serverId || serverId === 'local' || serverId === LOCAL_SERVER_ID;
    if (!isLocalAgent) continue;

    const tmuxTarget = (typeof agent.tmux === 'string' && agent.tmux.trim()) ? agent.tmux.trim() : `${agent.name}:0.0`;
    const runtime = ensureAgentRuntimeRecord(agent.name);
    if (!runtime) continue;

    const paneHash = getLocalPaneContentHash(tmuxTarget);
    if (!paneHash) {
      const hasSession = localTmuxSessionExists(tmuxTarget);
      localActivityState.delete(agent.name);
      const resetChanged = setRuntimeActivityFields(runtime, {
        activeNow: false,
        activeDurationSec: 0,
        idleDurationSec: 0,
        lastTmuxActivitySec: null,
      });
      if (resetChanged) {
        runtime.updatedAt = Date.now();
        runtimeChanged = true;
      }
      if (!hasSession) {
        const wasManualDown = agent.manualDown === true;
        let transitioned = false;
        if (agent.online !== false) { agent.online = false; agentsChanged = true; transitioned = true; }
        if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; transitioned = true; }
        if (agent.offlineReason !== 'tmux-missing:auto') { agent.offlineReason = 'tmux-missing:auto'; agentsChanged = true; transitioned = true; }
        if (agent.manualDown !== false) { agent.manualDown = false; agentsChanged = true; transitioned = true; }
        if (transitioned) {
          agent.lastSeen = Date.now();
          if (!wasManualDown) {
            maybeEmitUnexpectedOfflineAlert(agent.name, 'tmux-missing:auto', { server: 'local', detail: `tmux target ${tmuxTarget} not found` });
          }
        }
        if (isEphemeralAuditAgentName(agent.name)) pruneCandidates.add(agent.name);
      }
      continue;
    }

    let st = localActivityState.get(agent.name);
    if (!st) {
      st = {
        lastHash: paneHash,
        lastChangeSec: nowSec,
        burstStartSec: nowSec,
        burstLastSec: nowSec,
      };
      localActivityState.set(agent.name, st);
    } else if (paneHash !== st.lastHash) {
      const gap = nowSec - st.lastChangeSec;
      if (gap > IDLE_THRESHOLD_SEC) {
        st.burstStartSec = nowSec;
        st.burstLastSec = nowSec;
      } else {
        st.burstLastSec = nowSec;
      }
      st.lastHash = paneHash;
      st.lastChangeSec = nowSec;
    }

    const rawIdleSec = Math.max(0, nowSec - st.lastChangeSec);
    const activeNow = rawIdleSec < IDLE_THRESHOLD_SEC;
    const activeDurationSec = activeNow ? Math.max(0, nowSec - st.burstStartSec) : 0;
    const idleDurationSec = activeNow ? 0 : Math.max(0, rawIdleSec - IDLE_THRESHOLD_SEC);

    const changed = setRuntimeActivityFields(runtime, {
      activeNow,
      activeDurationSec,
      idleDurationSec,
      lastTmuxActivitySec: st.lastChangeSec,
    });
    if (changed) {
      runtime.updatedAt = Date.now();
      runtimeChanged = true;
    }

    // Self-heal local mapping: if tmux session exists and emits pane content,
    // keep backend routing state aligned even after stale/offline cleanup.
    let onlineChanged = false;
    if (!agent.tmux || !String(agent.tmux).trim()) {
      agent.tmux = tmuxTarget;
      onlineChanged = true;
    }
    if (agent.online !== true) {
      agent.online = true;
      onlineChanged = true;
    }
    if (agent.offlineReason !== null) {
      agent.offlineReason = null;
      onlineChanged = true;
    }
    if (agent.manualDown !== false) {
      agent.manualDown = false;
      onlineChanged = true;
    }
    if (onlineChanged) {
      agent.lastSeen = Date.now();
      agentsChanged = true;
    }
  }

  if (runtimeChanged) saveAgentRuntime();
  if (agentsChanged) saveAgents();
  if (pruneCandidates.size > 0) {
    pruneEphemeralAgents([...pruneCandidates], 'tmux-missing:auto');
  }
}

function readLocalSwapUsageSnapshot() {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf-8');
    const fields = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/);
      if (!m) continue;
      fields[m[1]] = Number.parseInt(m[2], 10);
    }
    const totalKb = Number(fields.SwapTotal) || 0;
    const freeKb = Number(fields.SwapFree) || 0;
    if (totalKb <= 0) return null;
    const usedKb = Math.max(0, totalKb - freeKb);
    const usagePct = (usedKb / totalKb) * 100;
    return { totalKb, freeKb, usedKb, usagePct };
  } catch {
    return null;
  }
}

function sweepLocalSwapPressure() {
  const snap = readLocalSwapUsageSnapshot();
  if (!snap) return;

  swapAlertState.lastPct = snap.usagePct;
  const usagePctText = snap.usagePct.toFixed(1);
  const usedGb = (snap.usedKb / (1024 * 1024)).toFixed(2);
  const totalGb = (snap.totalKb / (1024 * 1024)).toFixed(2);

  if (snap.usagePct >= SWAP_ALERT_THRESHOLD_PCT) {
    if (!swapAlertState.active) {
      swapAlertState.active = true;
      swapAlertState.lastAlertAt = Date.now();
      emitSystemInfo(
        `OOM warning: swap usage ${usagePctText}% (>= ${SWAP_ALERT_THRESHOLD_PCT}%)`,
        [
          `Swap used: ${usedGb} GiB / ${totalGb} GiB (${usagePctText}%)`,
          `Threshold: ${SWAP_ALERT_THRESHOLD_PCT}%`,
          'System memory pressure is high. Please intervene manually to avoid OOM killing agents.',
        ].join('\n')
      );
    }
    return;
  }

  if (swapAlertState.active && snap.usagePct <= SWAP_ALERT_CLEAR_PCT) {
    swapAlertState.active = false;
    emitSystemInfo(
      `OOM warning cleared: swap usage back to ${usagePctText}%`,
      [
        `Swap used: ${usedGb} GiB / ${totalGb} GiB (${usagePctText}%)`,
        `Clear threshold: ${SWAP_ALERT_CLEAR_PCT.toFixed(1)}%`,
      ].join('\n')
    );
  }
}

function scopeUnitForAgent(agentName) {
  const base = String(agentName || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return null;
  return `agent-${base}.scope`;
}

function parseSystemdMemoryValue(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'infinity' || text === 'max') return 0;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readAgentScopeMemory(agentName) {
  const unit = scopeUnitForAgent(agentName);
  if (!unit) return null;
  try {
    const out = execSync(
      `systemctl --user show ${JSON.stringify(unit)} --property=ActiveState --property=MemoryCurrent --property=MemoryHigh --value --no-pager`,
      { encoding: 'utf-8', timeout: 3000 }
    );
    const [activeStateRaw, currentRaw, highRaw] = String(out || '').split('\n');
    const activeState = String(activeStateRaw || '').trim().toLowerCase();
    if (activeState !== 'active') return null;
    const memoryCurrent = parseSystemdMemoryValue(currentRaw);
    const memoryHigh = parseSystemdMemoryValue(highRaw);
    if (memoryCurrent <= 0 || memoryHigh <= 0) return null;
    return { unit, memoryCurrent, memoryHigh };
  } catch {
    return null;
  }
}

function pushResourceAlertToAgent(agentName, summary) {
  const agent = agents[agentName];
  if (!isAgentRecord(agent) || !agent.tmux) return;
  const state = getAgentDeliveryState(agentName);
  if (!state.online) return;

  const payload = `[RESOURCE ALERT] ${summary}\nPlease pause heavy tasks, checkpoint progress, and reduce memory usage immediately.`;
  fetch(PUSH_QUEUE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'agent-chat-v2',
      to: agent.tmux,
      payload,
      notifyMeta: {
        kind: 'resource_alert',
        requiresInboxCheck: false,
        sourceMsgId: null,
        unreadCount: 0,
        hasHumanUnread: false,
        hasRequestUnread: false,
        needsReply: false,
        hasMcp: false,
      },
    }),
  }).catch((e) => {
    console.warn(`[scope-alert] queue push failed for ${agentName}: ${e.message}`);
  });
}

function formatBytesGiB(bytes) {
  return (bytes / (1024 ** 3)).toFixed(2);
}

function sweepAgentScopePressure() {
  if (!AGENT_SCOPE_MONITOR_ENABLED) return;
  const now = Date.now();
  const localAgentNames = Object.values(agents)
    .filter(isAgentRecord)
    .filter(agent => {
      const serverId = normalizeServer(agent.server);
      return !serverId || serverId === 'local' || serverId === LOCAL_SERVER_ID;
    })
    .map(agent => agent.name);

  const activeSet = new Set(localAgentNames);
  for (const key of [...scopePressureState.keys()]) {
    if (!activeSet.has(key)) scopePressureState.delete(key);
  }

  for (const agentName of localAgentNames) {
    const scope = readAgentScopeMemory(agentName);
    const prev = scopePressureState.get(agentName) || { high: false, lastAlertAt: 0 };
    if (!scope) {
      if (prev.high) {
        scopePressureState.set(agentName, { high: false, lastAlertAt: prev.lastAlertAt });
      }
      continue;
    }

    const ratio = scope.memoryCurrent / scope.memoryHigh;
    const highNow = ratio >= 1;

    if (highNow) {
      const shouldAlert = !prev.high || (now - prev.lastAlertAt) >= AGENT_SCOPE_ALERT_COOLDOWN_MS;
      if (shouldAlert) {
        const summary = `agent=${agentName} unit=${scope.unit} memoryHigh exceeded (${formatBytesGiB(scope.memoryCurrent)}GiB / ${formatBytesGiB(scope.memoryHigh)}GiB, ${(ratio * 100).toFixed(1)}%)`;
        emitSystemInfo(`Agent '${agentName}' memory high exceeded`, summary);
        pushResourceAlertToAgent(agentName, summary);
        scopePressureState.set(agentName, { high: true, lastAlertAt: now });
      } else if (!prev.high) {
        scopePressureState.set(agentName, { high: true, lastAlertAt: prev.lastAlertAt });
      }
      continue;
    }

    const clearNow = ratio <= AGENT_SCOPE_ALERT_CLEAR_RATIO;
    if (prev.high && clearNow) {
      emitSystemInfo(
        `Agent '${agentName}' memory pressure recovered`,
        `agent=${agentName} unit=${scope.unit} current=${formatBytesGiB(scope.memoryCurrent)}GiB high=${formatBytesGiB(scope.memoryHigh)}GiB (${(ratio * 100).toFixed(1)}%)`
      );
      scopePressureState.set(agentName, { high: false, lastAlertAt: prev.lastAlertAt });
    } else if (prev.high) {
      scopePressureState.set(agentName, { high: true, lastAlertAt: prev.lastAlertAt });
    }
  }
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
  const runtime = ensureAgentRuntimeRecord(agent.name);
  return {
    ...agent,
    server: normalizeServer(agent.server),
    online: state.online,
    agentOnline: state.agentOnline,
    serverOnline: state.serverOnline,
    lastSeen: state.lastSeen,
    serverLastSeen: state.serverLastSeen,
    offlineReason: state.offlineReason,
    manualDown: agent.manualDown === true,
    blocked: runtime?.blocked === true,
    blockedReason: runtime?.blockedReason || null,
    blockedSince: runtime?.blockedSince || null,
    activeNow: runtime?.activeNow === true,
    activeDurationSec: Number(runtime?.activeDurationSec) || 0,
    idleDurationSec: Number(runtime?.idleDurationSec) || 0,
    lastTmuxActivitySec: Number(runtime?.lastTmuxActivitySec) || null,
  };
}

function applyServerHeartbeat(serverId, payload = {}, sourceIp = null) {
  const now = Date.now();
  const server = ensureServerRecord(serverId);
  const wasOnline = Boolean(server.online);
  const incomingInstanceId = normalizeRelayInstanceId(payload.instanceId);
  const incomingBootTs = normalizeRelayBootTs(payload.bootTs);
  const lease = evaluateHeartbeatLease(server, incomingInstanceId, incomingBootTs, now);
  if (!lease.accept) {
    return { ok: false, leaseAccepted: false, leaseReason: lease.reason };
  }
  const sessions = Array.isArray(payload.sessions)
    ? [...new Set(payload.sessions.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))]
    : [];
  const heartbeatAgents = Array.isArray(payload.agents) ? payload.agents : sessions;
  const liveAgents = [...new Set(heartbeatAgents.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))];
  const liveSet = new Set(liveAgents);

  server.lastSeen = now;
  server.heartbeatAt = now;
  server.relayInstanceId = incomingInstanceId;
  server.relayBootTs = incomingBootTs;
  server.online = true;
  server.updatedAt = now;
  server.sourceIp = sourceIp || null;
  server.sessions = sessions;
  server.agents = liveAgents;
  server.agentCount = liveAgents.length;

  if (!wasOnline) {
    emitSystemInfo(`Remote server '${serverId}' online`, `Server '${serverId}' heartbeat restored. Active sessions=${sessions.length}, agents=${liveAgents.length}.`);
  }
  if (lease.takeover) {
    emitSystemInfo(
      `Remote server '${serverId}' heartbeat instance switched`,
      `Server '${serverId}' lease takeover: reason=${lease.reason}, instanceId=${incomingInstanceId || 'unknown'}, bootTs=${incomingBootTs || 0}.`
    );
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
    if (agent.manualDown !== false) { agent.manualDown = false; agentsChanged = true; }
    if (agent.lastSeen !== now) { agent.lastSeen = now; agentsChanged = true; }
  }

  for (const agent of Object.values(agents)) {
    if (normalizeServer(agent.server) !== serverId) continue;
    if (liveSet.has(agent.name)) continue;
    const wasOnline = agent.online === true;
    const wasManualDown = agent.manualDown === true;
    if (agent.online !== false) { agent.online = false; agentsChanged = true; }
    const reason = `heartbeat-missing:${serverId}`;
    if (agent.offlineReason !== reason) { agent.offlineReason = reason; agentsChanged = true; }
    if (agent.manualDown !== false) { agent.manualDown = false; agentsChanged = true; }
    if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; }
    if (wasOnline && !wasManualDown) {
      maybeEmitUnexpectedOfflineAlert(agent.name, reason, { server: serverId, detail: 'Missing in remote heartbeat snapshot' });
    }
  }

  saveServers();
  if (agentsChanged) saveAgents();
  for (const name of becameOnline) {
    notifyAgentCatchup(name, `online:${serverId}`);
  }
  return { ok: true, leaseAccepted: true, leaseReason: lease.reason };
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
const pushNotifySkipLog = new Map();

function logPushNotifySkip(agentName, reason, detail = '') {
  const key = `${agentName}:${reason}`;
  const now = Date.now();
  const prev = pushNotifySkipLog.get(key) || 0;
  if ((now - prev) < 30_000) return;
  pushNotifySkipLog.set(key, now);
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[push-notify] skip ${agentName}: ${reason}${suffix}`);
}

function clearQueuedNotificationsForAgent(agentName) {
  if (!agentName) return;
  fetch(`http://127.0.0.1:8084/api/queue/agents/${encodeURIComponent(agentName)}/notifications`, {
    method: 'DELETE',
  })
    .then((r) => {
      if (!r.ok) {
        console.warn(`[push-notify] queue clear failed for ${agentName}: status ${r.status}`);
      }
    })
    .catch((e) => {
      console.warn(`[push-notify] queue clear failed for ${agentName}: ${e.message}`);
    });
}

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
  const replayLimit = Math.max(1, OFFLINE_CATCHUP_LIST_LIMIT);
  const replay = unread.slice(-replayLimit);
  const omitted = Math.max(0, unread.length - replay.length);
  const replayLines = replay.map((m, idx) => {
    const summaryText = String(m.summary || '').replace(/\s+/g, ' ').trim() || '(no summary)';
    const channel = m.group ? `group:${m.group}` : 'dm';
    return `${idx + 1}. [${new Date(m.ts).toISOString()}] (${channel}/${m.type}) ${m.from}: ${summaryText}`;
  });
  const full = [
    `You were offline (${reason}).`,
    `Unread count: ${unread.length}`,
    `Window: ${new Date(oldest.ts).toISOString()} -> ${new Date(latest.ts).toISOString()}`,
    `Senders: ${senderNames.join(', ') || 'unknown'}`,
    `Offline replay list (latest ${replay.length}):`,
    ...replayLines,
    omitted > 0 ? `... ${omitted} older message(s) omitted from replay list.` : null,
    'These messages may be time-sensitive. Review timestamps and decide whether a reply is still needed.',
    'check_inbox() returns per-message time fields: ts / at / time.',
    'Use check_inbox() in agent-chat MCP for full context.',
  ].filter(Boolean).join('\n');

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
  if (!agent?.tmux) {
    logPushNotifySkip(agentName, 'missing-tmux-target');
    return;
  }
  const agentServer = normalizeServer(agent.server);
  if (agentServer && agentServer !== 'local' && agentServer !== LOCAL_SERVER_ID) {
    logPushNotifySkip(agentName, 'remote-relay-expected', `(server=${agentServer})`);
    return;
  }
  // If server is unknown (null), verify the tmux session exists locally before queueing
  if (!agentServer) {
    try {
      const sess = agent.tmux.split(':')[0];
      execSync(`tmux has-session -t ${JSON.stringify(sess)} 2>/dev/null`, { timeout: 2000 });
    } catch {
      logPushNotifySkip(agentName, 'local-session-not-found', `(tmux=${agent.tmux})`);
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
  let notificationKind = 'single_inform';
  let requiresInboxCheck = false;
  let hasHumanUnread = false;
  let hasRequestUnread = false;

  let notification;
  if (unreadCount > 1) {
    const dedupeKey = `${inboxTs}:${latestUnread.id || 'none'}:${unreadCount}`;
    if (!isHumanMsg && mergedPushInboxCursor.get(agentName) === dedupeKey) return;
    mergedPushInboxCursor.set(agentName, dedupeKey);

    const senderNames = [...new Set(unread.map(m => m.from).filter(Boolean))];
    const senderText = senderNames.length ? ` (from ${formatSenderList(senderNames)})` : '';
    const hasHuman = unread.some(m => m.type === 'human');
    const hasRequest = unread.some(m => m.type === 'request');
    const actionableUnread = hasHuman || hasRequest;
    hasHumanUnread = hasHuman;
    hasRequestUnread = hasRequest;
    notificationKind = actionableUnread ? 'merged_unread_actionable' : 'merged_unread_inform';
    requiresInboxCheck = hasMcp && actionableUnread;
    const humanHint = hasHuman ? ' This includes messages from your human operator.' : '';
    const processHint = hasMcp
      ? ' Read ALL messages via check_inbox() first. DO ALL JOBS before replying. After ALL WORK is done, send required replies.'
      : ' Read ALL messages first. DO ALL JOBS before replying. After ALL WORK is done, send required replies.';

    if (hasMcp) {
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}. Use check_inbox() in agent-chat MCP to read all.${humanHint}${processHint}`;
    } else {
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}.${humanHint}${processHint}`;
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
      notificationKind = needsReply ? 'single_actionable' : 'single_inform';
      requiresInboxCheck = needsReply;
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
      notificationKind = needsReply ? 'single_actionable' : 'single_inform';
      requiresInboxCheck = false;
      notification = isHuman
        ? `[NOTIFICATION] From ${msg.from} (human): "${msg.summary}". This is your human operator. ${actionHint}.`
        : needsReply
          ? `[NOTIFICATION] From ${msg.from}: "${msg.summary}". ${actionHint}.`
          : `[NOTIFICATION] From ${msg.from}: "${msg.summary}".`;
    }
  }

  try {
    const notifyMeta = {
      kind: notificationKind,
      requiresInboxCheck,
      sourceMsgId: latestUnread?.id || msg?.id || null,
      unreadCount,
      hasHumanUnread,
      hasRequestUnread,
      needsReply,
      hasMcp,
    };
    const resp = await fetch(PUSH_QUEUE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent-chat-v2', to: agent.tmux, payload: notification, notifyMeta }),
    });
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      markAgentPushNotified(agentName, {
        queueEntryId: body?.id,
        queuedAt: body?.queuedAt,
        ...notifyMeta,
      });
    }
  } catch (e) {
    console.error(`Push notify failed for ${agentName}:`, e.message);
  }
}

// ── Express app ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 'loopback');  // trust nginx on localhost, use X-Forwarded-For for real IP
const API_TOKEN = process.env.API_TOKEN;
app.use((req, res, next) => {
  // Skip global JSON parser for large-upload routes (they have route-specific limits).
  if (req.method === 'POST' && (req.path.endsWith('/avatar') || req.path === '/api/media/stage')) return next();
  express.json({ limit: '100kb' })(req, res, next);
});
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
  const heartbeatResult = applyServerHeartbeat(serverId, req.body || {}, req.ip || req.connection?.remoteAddress || null);
  refreshServerLiveness();
  const state = servers[serverId];
  if (heartbeatResult && heartbeatResult.leaseAccepted === false) {
    return res.status(409).json({
      ok: false,
      error: 'heartbeat_lease_rejected',
      reason: heartbeatResult.leaseReason || 'unknown',
      server: {
        id: state.id,
        online: Boolean(state.online),
        lastSeen: state.lastSeen || null,
        updatedAt: state.updatedAt || null,
        agentCount: state.agentCount || 0,
        sourceIp: state.sourceIp || null,
      },
    });
  }
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
  const requestInstanceId = normalizeRelayInstanceId(req.body?.instanceId);
  const activeInstanceId = normalizeRelayInstanceId(server.relayInstanceId);
  if (requestInstanceId && activeInstanceId && requestInstanceId !== activeInstanceId && server.online) {
    return res.status(409).json({
      ok: false,
      error: 'offline_lease_rejected',
      reason: 'different-instance-active',
      activeInstanceId,
      requestInstanceId,
    });
  }
  const wasOnline = Boolean(server.online);
  const now = Date.now();
  server.heartbeatAt = 0;
  clearServerLiveState(server, now);
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
      heartbeatAt: Number(s.heartbeatAt) || null,
      updatedAt: s.updatedAt || null,
      agentCount: Number(s.agentCount) || 0,
      sourceIp: s.sourceIp || null,
      relayInstanceId: normalizeRelayInstanceId(s.relayInstanceId),
      relayBootTs: normalizeRelayBootTs(s.relayBootTs) || null,
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
    manualDown: resolvedOnline ? false : (existing.manualDown === true),
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
  const { role, identity, tmux, online, offlineReason, manualDown } = req.body;
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
  if (manualDown !== undefined) {
    agent.manualDown = manualDown === true;
  }
  if (agent.online === true && agent.manualDown !== false) {
    agent.manualDown = false;
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
  if (req.query.force === 'true') {
    delete agents[agentName];
    saveAgents();
    console.log(`Agent '${agentName}' permanently deleted`);
    return res.json({ ok: true, deleted: true, name: agentName });
  }
  agent.online = false;
  agent.tmux = null;
  agent.lastSeen = Date.now();
  if (!agent.offlineReason) agent.offlineReason = 'inactive';
  agent.manualDown = true;
  saveAgents();
  res.json({
    ok: true,
    deprecated: true,
    message: 'unregister is disabled; agent marked inactive. Use ?force=true to permanently delete.',
    agent: serializeAgent(agent),
  });
});

app.post('/api/agents/:name/offline', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const wasOnline = agent.online === true;
  const wasManualDown = agent.manualDown === true;
  const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim())
    ? req.body.reason.trim()
    : 'manual-offline';
  const clearTmux = req.body?.clearTmux !== false;
  const manualDown = req.body?.manualDown === undefined
    ? isManualDownReason(reason)
    : req.body.manualDown === true;
  agent.online = false;
  agent.lastSeen = Date.now();
  agent.offlineReason = reason;
  agent.manualDown = manualDown;
  if (clearTmux) agent.tmux = null;
  saveAgents();
  if (wasOnline && !manualDown && !wasManualDown) {
    maybeEmitUnexpectedOfflineAlert(agentName, reason, { server: normalizeServer(agent.server) || 'local', detail: 'Marked offline via API' });
  }
  res.json({ ok: true, agent: serializeAgent(agent) });
});

app.post('/api/agents/:name/runtime', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });

  const blocked = req.body?.blocked === true;
  const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim())
    ? req.body.reason.trim()
    : null;
  const tail = (typeof req.body?.tail === 'string') ? req.body.tail : '';
  const command = (typeof req.body?.command === 'string') ? req.body.command : '';
  const server = normalizeServer(req.body?.server);

  let agent = agents[agentName];
  if (!isAgentRecord(agent)) {
    const ensured = ensureAgentRecord(agentName, {
      server,
      tmux: `${agentName}:0.0`,
      online: true,
      type: 'agent',
      kind: 'agent',
      offlineReason: null,
    });
    if (!ensured) return res.status(400).json({ error: 'invalid agent name' });
    agent = ensured.agent;
    saveAgents();
  }

  const runtime = applyAgentBlockedRuntime(agentName, {
    blocked,
    reason,
    tail,
    command,
    server,
  });
  if (!runtime) return res.status(500).json({ error: 'runtime update failed' });
  res.json({
    ok: true,
    runtime: {
      agent: agentName,
      blocked: runtime.blocked === true,
      blockedReason: runtime.blockedReason || null,
      blockedSince: runtime.blockedSince || null,
      activeNow: runtime.activeNow === true,
      activeDurationSec: Number(runtime.activeDurationSec) || 0,
      idleDurationSec: Number(runtime.idleDurationSec) || 0,
      lastTmuxActivitySec: Number(runtime.lastTmuxActivitySec) || null,
      updatedAt: runtime.updatedAt || Date.now(),
    },
  });
});

app.post('/api/runtime/compact', (req, res) => {
  const agentName = normalizeAgentName(req.body?.agent);
  if (!agentName) return res.status(400).json({ error: 'agent required' });

  const server = normalizeServer(req.body?.server);
  let agent = agents[agentName];
  if (!isAgentRecord(agent)) {
    const ensured = ensureAgentRecord(agentName, {
      server,
      tmux: `${agentName}:0.0`,
      online: true,
      type: 'agent',
      kind: 'agent',
      offlineReason: null,
    });
    if (!ensured) return res.status(400).json({ error: 'invalid agent name' });
    agent = ensured.agent;
    saveAgents();
  }

  const marker = normalizeCompactMarker(req.body?.marker);
  const modeRaw = (typeof req.body?.mode === 'string' && req.body.mode.trim())
    ? req.body.mode.trim().toLowerCase()
    : 'pattern';
  const mode = modeRaw === 'hook' ? 'hook' : 'pattern';
  const key = `${agentName}:${marker}:${mode}`;
  const now = Date.now();
  const prevTs = Number(compactRuntimeAlertAt.get(key)) || 0;
  if ((now - prevTs) < AGENT_COMPACT_RUNTIME_DEDUPE_MS) {
    return res.json({ ok: true, suppressed: 'dedupe', agent: agentName, marker, mode });
  }
  compactRuntimeAlertAt.set(key, now);
  pruneCompactRuntimeDedupState(now);

  const event = buildRuntimeCompactEvent(agentName, {
    mode,
    marker,
    source: req.body?.source,
    summary: req.body?.summary,
  });
  broadcastSSE('agent_compact', event);
  res.json({ ok: true, event });
});

app.post('/api/runtime/push-delivered', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'local only' });
  const agentName = normalizeAgentName(req.body?.agent);
  if (!agentName) return res.status(400).json({ error: 'agent required' });
  if (!isAgentRecord(agents[agentName])) {
    return res.json({ ok: true, ignored: 'agent-not-found', agent: agentName });
  }

  const details = {
    deliveredAt: req.body?.deliveredAt,
    queuedAt: req.body?.queuedAt,
    queueEntryId: req.body?.queueEntryId,
  };
  const notifyMeta = (req.body?.notifyMeta && typeof req.body.notifyMeta === 'object')
    ? req.body.notifyMeta
    : {};
  markAgentPushDelivered(agentName, {
    ...details,
    ...notifyMeta,
  });
  res.json({ ok: true, agent: agentName });
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

// ── DM ensure (triggers bridge to create Matrix DM room) ─────────────
app.post('/api/dm/ensure', (req, res) => {
  const { agent, human } = req.body;
  if (!agent || !human) return res.status(400).json({ error: 'agent and human required' });
  broadcastSSE('dm_ensure', { agent, human });
  console.log(`[dm/ensure] Requested DM room: agent=${agent}, human=${human}`);
  res.json({ ok: true, queued: true, agent, human });
});

app.post('/api/agents/:name/avatar', express.json({ limit: '10mb' }), (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid agent name' });
  const force = req.body?.generate === true || req.query.force === 'true';
  const image = req.body?.image; // base64 encoded image
  const mime = req.body?.mime || 'image/png';
  broadcastSSE('agent_avatar', { name, force, image, mime });
  console.log(`[avatar] Requested avatar ${force ? 'regeneration' : (image ? 'custom upload' : 'ensure')} for: ${name}`);
  res.json({ ok: true, queued: true, name, force, custom: !!image });
});

// ── System info (log-only; does not enter message store) ──────────────
app.post('/api/system/info', (req, res) => {
  const summary = (typeof req.body?.summary === 'string') ? req.body.summary.trim() : '';
  const full = (typeof req.body?.full === 'string') ? req.body.full : '';
  if (!summary) return res.status(400).json({ error: 'summary required' });
  const event = emitSystemInfo(summary, full);
  res.json({ ok: true, id: event.id });
});

// ── Media staging for agent attachments ───────────────────────────────
app.post('/api/media/stage', express.json({ limit: MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT }), (req, res) => {
  const fromName = normalizeAgentName(req.body?.from || '');
  if (!fromName) return res.status(400).json({ error: 'from required' });
  if (!isAgentRecord(agents[fromName])) return res.status(404).json({ error: `agent not found: ${fromName}` });

  const contentBase64 = (typeof req.body?.content_base64 === 'string') ? req.body.content_base64.trim() : '';
  if (!contentBase64) return res.status(400).json({ error: 'content_base64 required' });

  let bytes;
  try {
    bytes = Buffer.from(contentBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid base64 payload' });
  }
  if (!bytes || bytes.length === 0) return res.status(400).json({ error: 'empty attachment payload' });
  if (bytes.length > MESSAGE_ATTACHMENT_MAX_BYTES) {
    return res.status(413).json({ error: `attachment exceeds max bytes (${MESSAGE_ATTACHMENT_MAX_BYTES})` });
  }

  const sourcePath = (typeof req.body?.source_path === 'string' && req.body.source_path.trim())
    ? req.body.source_path.trim()
    : '';
  const requestedName = (typeof req.body?.name === 'string' && req.body.name.trim())
    ? req.body.name.trim()
    : (sourcePath ? path.basename(sourcePath) : 'file.bin');
  const name = normalizeAttachmentName(requestedName, 'file.bin');
  const ext = path.extname(name) || '.bin';
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const filePath = path.join(MESSAGE_ATTACHMENT_DIR, fileName);
  writeFileSync(filePath, bytes);

  const mime = normalizeAttachmentMime(req.body?.mime);
  const kind = inferAttachmentKind(req.body?.kind, mime, name);
  const attachment = {
    path: filePath,
    name,
    mime,
    kind,
    size: bytes.length,
    staged: true,
    source_path: sourcePath || null,
  };
  res.json({ ok: true, attachment });
});

app.get('/api/media/fetch', (req, res) => {
  const resolved = resolveReadableMediaPath(req.query?.path);
  if (resolved.error) {
    return res.status(resolved.status || 400).json({ error: resolved.error });
  }

  const filePath = resolved.value.path;
  const fileName = normalizeAttachmentName(path.basename(filePath), 'file.bin');
  const mime = guessMimeFromPath(filePath);
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (e) {
    return res.status(500).json({ error: `failed to read file: ${e.message}` });
  }
  if (!bytes || bytes.length === 0) return res.status(400).json({ error: 'file is empty' });
  if (bytes.length > MESSAGE_ATTACHMENT_MAX_BYTES) {
    return res.status(413).json({ error: `file exceeds max bytes (${MESSAGE_ATTACHMENT_MAX_BYTES})` });
  }

  const encodedName = encodeURIComponent(fileName);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"; filename*=UTF-8''${encodedName}`);
  return res.send(bytes);
});

// ── Messages ──────────────────────────────────────────────────────────
app.post('/api/messages', (req, res) => {
  const { from, to, group, type, summary, full, mentions, reply_to, source, target_type, source_room, attachments } = req.body;
  const fromName = normalizeAgentName(from) || from;
  const toName = to ? normalizeAgentName(to) : null;
  const sourceType = typeof source === 'string' ? source.trim().toLowerCase() : 'api';
  const targetType = typeof target_type === 'string' ? target_type.trim().toLowerCase() : 'auto';
  const sourceRoom = (typeof source_room === 'string' && source_room.trim() && source_room.length <= 255)
    ? source_room.trim()
    : null;
  // Normalize literal \n (two chars) to actual newlines — some agents double-escape them
  const normNl = s => s.replace(/\\n/g, '\n');
  const rawSummary = typeof summary === 'string' ? normNl(summary) : '';
  const rawFull = typeof full === 'string' ? normNl(full) : '';
  const isHumanMessage = type === 'human';
  const canonicalHumanFull = isHumanMessage ? (rawFull || rawSummary).trim() : '';
  const canonicalSummary = isHumanMessage ? makeHumanSummaryPreview(canonicalHumanFull) : rawSummary;
  const canonicalFull = isHumanMessage ? canonicalHumanFull : rawFull;
  const rawAttachments = Array.isArray(attachments) ? attachments : [];
  if (rawAttachments.length > MESSAGE_ATTACHMENT_MAX_ITEMS) {
    return res.status(400).json({ error: `too many attachments (max ${MESSAGE_ATTACHMENT_MAX_ITEMS})` });
  }
  const normalizedAttachments = [];
  for (let i = 0; i < rawAttachments.length; i++) {
    const normalized = normalizeAttachmentInput(rawAttachments[i]);
    if (normalized.error) {
      return res.status(400).json({ error: `attachments[${i}]: ${normalized.error}` });
    }
    normalizedAttachments.push(normalized.value);
  }

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

  // Auto-extract @mentions from text and merge with explicit mentions.
  // Resolve mentions case-insensitively to canonical stored names.
  const knownNameMap = new Map();
  const rememberKnownName = (raw) => {
    if (typeof raw !== 'string') return;
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!knownNameMap.has(key)) knownNameMap.set(key, name);
  };
  for (const agentName of Object.keys(agents)) rememberKnownName(agentName);
  for (const g of Object.values(groups)) {
    for (const m of (Array.isArray(g?.members) ? g.members : [])) rememberKnownName(m);
  }
  const resolveKnownName = (raw) => {
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    if (!key) return null;
    return knownNameMap.get(key) || null;
  };
  const explicitMentions = Array.isArray(mentions) ? mentions : [];
  const textMentions = new Set();
  for (const explicit of explicitMentions) {
    const canonical = resolveKnownName(explicit) || (typeof explicit === 'string' ? explicit.trim() : '');
    if (canonical && canonical !== fromName) textMentions.add(canonical);
  }
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentionScanTexts = isHumanMessage ? [canonicalFull] : [canonicalSummary || '', canonicalFull || ''];
  for (const text of mentionScanTexts) {
    mentionRegex.lastIndex = 0;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      const canonical = resolveKnownName(match[1]);
      if (canonical && canonical !== fromName) textMentions.add(canonical);
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
    sourceRoom,
  };
  if (normalizedAttachments.length > 0) {
    msg.attachments = normalizedAttachments;
  }

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
  const compactEvent = buildAgentCompactEvent(msg, senderIsAgent);
  if (compactEvent) {
    broadcastSSE('agent_compact', compactEvent);
  }
  broadcastSSE('message', msg);
  if (senderIsAgent) {
    markAgentOutbound(fromName);
  }

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

app.post('/api/messages/:id/suppress', (req, res) => {
  const agentName = normalizeAgentName(req.body?.agent);
  if (!agentName) return res.status(400).json({ error: 'agent required' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });

  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  if (!messageTargetsAgent(msg, agentName)) {
    return res.status(400).json({ error: `message ${msg.id} is not deliverable to ${agentName}` });
  }

  const before = getUnreadInboxMessages(agentName).unread.some(m => m.id === msg.id);
  if (!Array.isArray(msg.suppressedRecipients)) msg.suppressedRecipients = [];
  if (!msg.suppressedRecipients.includes(agentName)) {
    msg.suppressedRecipients.push(agentName);
    saveMessages();
  }
  const after = getUnreadInboxMessages(agentName).unread.some(m => m.id === msg.id);

  res.json({
    ok: true,
    id: msg.id,
    agent: agentName,
    suppressed: true,
    was_unread: before,
    is_unread_now: after,
    suppressedRecipients: msg.suppressedRecipients,
  });
});

// ── Full message HTML page (for Matrix links) ────────────────────────
app.get('/msg/:id', (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).send('<h1>Message not found</h1>');
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attachmentsHtml = Array.isArray(msg.attachments) && msg.attachments.length > 0
    ? '<div class="meta">Attachments:<br>' + msg.attachments
      .map(a => {
        const label = escape(a?.name || path.basename(String(a?.path || 'file')));
        const meta = [a?.kind, a?.mime, a?.size ? `${a.size} bytes` : null].filter(Boolean).join(' · ');
        const pathText = escape(String(a?.path || ''));
        return `• <strong>${label}</strong>${meta ? ` (${escape(meta)})` : ''}<br><code>${pathText}</code>`;
      })
      .join('<br>')
      + '</div>'
    : '';
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
${attachmentsHtml}
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

app.get('/api/inbox/:agent/unread-list', (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });

  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.min(limitRaw, 500) : 50;
  const { unread } = getUnreadInboxMessages(agentName);
  const rows = limit === 0 ? unread : unread.slice(-limit);
  res.json({
    agent: agentName,
    unread_total: unread.length,
    unread_returned: rows.length,
    unread_omitted: Math.max(0, unread.length - rows.length),
    messages: rows.map(summarizeMsg),
  });
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
  markAgentInboxChecked(agentName);
  // If the agent just consumed inbox, stale queued notifications should be removed immediately.
  clearQueuedNotificationsForAgent(agentName);

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

  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.min(limitRaw, 200) : 10;
  const hasAdvanceParam = typeof req.query.advance === 'string';
  const hasUnreadLimitParam = req.query.unread_limit !== undefined;
  const advanceModeRaw = hasAdvanceParam ? req.query.advance.trim().toLowerCase() : '';
  let advanceMode = ['all', 'delivered', 'none'].includes(advanceModeRaw) ? advanceModeRaw : null;
  if (!advanceMode) {
    // Backward-compatible "active read" escape hatch for old MCP schemas:
    // check_group(..., limit=0) => consume all unread.
    advanceMode = (!hasAdvanceParam && !hasUnreadLimitParam && limit === 0) ? 'all' : 'none';
  }
  const unreadLimitRaw = Number.parseInt(req.query.unread_limit, 10);
  let unreadLimit = Number.isFinite(unreadLimitRaw) && unreadLimitRaw > 0
    ? Math.min(unreadLimitRaw, 500)
    : null;
  if (unreadLimit === null && advanceMode !== 'all') {
    unreadLimit = 10; // default preview window
  }
  const cursor = ensureCursor(resolvedAgentName);
  const groupCursor = getGroupCursor(cursor, groupName);
  const groupTs = groupCursor.ts;
  const groupId = groupCursor.id;

  const groupMsgs = messages
    .filter(m => m.group === groupName)
    .filter(m => !isSuppressedForAgent(m, resolvedAgentName))
    .sort(compareMsgOrder);
  const unreadRaw = groupMsgs.filter(m => isAfterCursor(m, groupTs, groupId));
  const unreadTotal = unreadRaw.length;
  const deliveredUnreadRaw = unreadLimit ? unreadRaw.slice(-unreadLimit) : unreadRaw;
  const unread = deliveredUnreadRaw.map(summarizeMsg);
  const unreadReturned = deliveredUnreadRaw.length;
  const unreadOmitted = Math.max(0, unreadTotal - unreadReturned);
  const read = groupMsgs.filter(m => !isAfterCursor(m, groupTs, groupId)).slice(-limit).map(summarizeMsg);

  // Advance group cursor by mode:
  // - all: consume all unread (legacy behavior)
  // - delivered: consume only returned unread subset
  // - none: preview only
  if (advanceMode !== 'none') {
    const cursorSource = advanceMode === 'all' ? unreadRaw : deliveredUnreadRaw;
    if (advanceGroupCursor(cursor, groupName, cursorSource)) {
      saveCursors();
    }
  }

  res.json({
    group: groupName,
    unread,
    read,
    unread_total: unreadTotal,
    unread_returned: unreadReturned,
    unread_omitted: unreadOmitted,
    advance: advanceMode,
  });
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
  sweepLocalActivityDurations();
  sweepAgentRules();
  saveAgents();
  saveGroups();
  saveMessages();
  saveCursors();
  saveServers();
  saveAgentRuntime();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

setInterval(() => {
  refreshServerLiveness();
}, SERVER_SWEEP_INTERVAL_MS);

setInterval(() => {
  sweepLocalActivityDurations();
}, LOCAL_ACTIVITY_SWEEP_INTERVAL_MS);

setInterval(() => {
  sweepAgentRules();
}, RULE_SWEEP_INTERVAL_MS);

setInterval(() => {
  sweepLocalSwapPressure();
}, SWAP_SWEEP_INTERVAL_MS);

setInterval(() => {
  sweepAgentScopePressure();
}, AGENT_SCOPE_SWEEP_INTERVAL_MS);

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  sweepLocalActivityDurations();
  sweepLocalSwapPressure();
  sweepAgentScopePressure();
  console.log(`Agent Chat v2 backend listening on http://127.0.0.1:${PORT}`);
  const agentCount = Object.values(agents).filter(isAgentRecord).length;
  console.log(`  Agents: ${agentCount}, Messages: ${messages.length}, Groups: ${Object.keys(groups).length}`);
});
