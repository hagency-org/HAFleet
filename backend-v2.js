import express from 'express';
import { appendFileSync, writeFileSync, mkdirSync, renameSync, statSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createSupervisorService } from './supervisor/index.js';
import {
  buildUpstreamClaudeSubconsciousPaths,
  bootstrapUpstreamClaudeSubconsciousAgent,
  readUpstreamClaudeSubconsciousState,
  startUpstreamClaudeSubconsciousSession,
  syncUpstreamClaudeSubconsciousPreTool,
  syncUpstreamClaudeSubconsciousStop,
  syncUpstreamClaudeSubconsciousUserPrompt,
} from './lib/upstream-claude-subconscious.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.AGENT_CHAT_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const DEFAULT_WEB_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_WEB_PORT || '8084', 10);
const DEFAULT_WEB_PORT = Number.isFinite(DEFAULT_WEB_PORT_RAW) && DEFAULT_WEB_PORT_RAW > 0
  ? DEFAULT_WEB_PORT_RAW
  : 8084;
const DATA_DIR = path.join(RUNTIME_ROOT, 'data');
const WEB_BASE_URL = (process.env.AGENT_CHAT_WEB_URL || `http://127.0.0.1:${DEFAULT_WEB_PORT}`).trim().replace(/\/$/, '');
const PUSH_QUEUE_URL = (process.env.AGENT_CHAT_QUEUE_URL || `${WEB_BASE_URL}/api/queue`).trim().replace(/\/$/, '');
const WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.AGENT_CHAT_WEB_BRIDGE_FETCH_TIMEOUT_MS || '5000', 10);
const WEB_BRIDGE_FETCH_TIMEOUT_MS = Number.isFinite(WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW) && WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW > 0
  ? WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW
  : 5000;
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_SERVER_ID = (process.env.AGENT_CHAT_SERVER || 'local').trim();
const USER_UID = (typeof process.getuid === 'function') ? process.getuid() : null;
const USER_RUNTIME_DIR = Number.isFinite(USER_UID) ? `/run/user/${USER_UID}` : null;
const USER_DBUS_SESSION_BUS = USER_RUNTIME_DIR ? `unix:path=${USER_RUNTIME_DIR}/bus` : null;
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
const AGENT_TMUX_MISSING_ALERT_GRACE_MS = Number.parseInt(process.env.AGENT_TMUX_MISSING_ALERT_GRACE_MS || '15000', 10);
const AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS = Number.parseInt(process.env.AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS || '900000', 10);
const AGENT_COMPACT_SUMMARY_MAX = Number.parseInt(process.env.AGENT_COMPACT_SUMMARY_MAX || '180', 10);
const AGENT_COMPACT_RUNTIME_DEDUPE_MS = Number.parseInt(process.env.AGENT_COMPACT_RUNTIME_DEDUPE_MS || '120000', 10);
const SUBCONSCIOUS_EVENT_HISTORY_LIMIT = Number.parseInt(process.env.SUBCONSCIOUS_EVENT_HISTORY_LIMIT || '2000', 10);
const SUBCONSCIOUS_EVENT_AGENT_LIMIT = Number.parseInt(process.env.SUBCONSCIOUS_EVENT_AGENT_LIMIT || '500', 10);
const SERVER_MAINTENANCE_IDS = new Set(
  String(process.env.AGENT_SERVER_MAINTENANCE_IDS ?? 'kamico-MBP')
    .split(',')
    .map(normalizeServer)
    .filter(Boolean)
);
const SERVER_MAINTENANCE_LAST_SEEN_UPDATE_MS = Number.parseInt(process.env.AGENT_SERVER_MAINTENANCE_LAST_SEEN_UPDATE_MS || '60000', 10);
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
const LOCAL_BLOCK_TAIL_LINES = Number.parseInt(process.env.AGENT_LOCAL_BLOCK_TAIL_LINES || '40', 10);
const LOCAL_BLOCK_RECENT_LINES = Number.parseInt(process.env.AGENT_LOCAL_BLOCK_RECENT_LINES || '14', 10);
const LOCAL_MCP_SESSION_CACHE_TTL_MS = Number.parseInt(process.env.AGENT_LOCAL_MCP_SESSION_CACHE_TTL_MS || '1000', 10);
const LOCAL_BLOCK_PATTERNS = [
  { reason: 'select-mode', re: /(?:^|\n)\s*(?:select mode|choose (?:an?\s+)?mode)\s*(?:\n|$)/i },
  { reason: 'plan-mode', re: /(?:^|\n)\s*(?:[0-9]+[.)]\s*)?plan mode\s*(?:\n|$)/i },
  { reason: 'approval-mode-toggle', re: /bypass permissions on \(shift\+tab to cycle\)/i },
  { reason: 'update-required', re: /updates?\s+available:|update available.*agent-update|run ['"`]?agent-update/i },
  { reason: 'interactive-confirm', re: /choose (an )?option|press (enter|return) to continue|confirm .*continue/i },
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
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, target);
    return true;
  } catch (e) {
    const code = e?.code || 'unknown';
    const msg = e?.message || 'unknown error';
    console.error(`Failed to save JSON ${target}: [${code}] ${msg}`);
    return false;
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

function normalizeServer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
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

function normalizeAgentModelVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 32) return null;
  return trimmed;
}

function normalizeLayoutVersion(value) {
  if (value === null || value === undefined) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeAgentId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeOptionalText(value, maxLen = 4000) {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

function normalizeBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(trimmed)) return true;
    if (['0', 'false', 'no', 'off'].includes(trimmed)) return false;
  }
  return null;
}

function normalizePositiveInt(value, fallback, min = 1) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(raw)) return raw;
  return 'deepseek';
}

function normalizeProviderOrNull(value) {
  const raw = normalizeOptionalText(value, 64);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(lower)) return lower;
  return null;
}

function defaultCompatibleEndpoint(provider) {
  switch (provider) {
    case 'deepseek':
      return 'https://api.deepseek.com/v1/chat/completions';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    default:
      return 'https://api.deepseek.com/v1/chat/completions';
  }
}

function defaultCompatibleModel(provider) {
  switch (provider) {
    case 'deepseek':
      return 'deepseek-chat';
    case 'qwen':
      return 'qwen-plus';
    case 'openai':
      return 'gpt-4.1-mini';
    default:
      return 'deepseek-chat';
  }
}

function normalizeCompatibleEndpoint(baseOrEndpoint, defaultEndpoint) {
  const raw = normalizeOptionalText(baseOrEndpoint, 2048);
  if (!raw) return defaultEndpoint;
  if (raw.endsWith('/chat/completions')) return raw;
  if (raw.endsWith('/')) return `${raw}chat/completions`;
  return `${raw}/chat/completions`;
}

function normalizeCompatibleEndpointOrNull(baseOrEndpoint) {
  const raw = normalizeOptionalText(baseOrEndpoint, 2048);
  if (!raw) return null;
  return normalizeCompatibleEndpoint(raw, raw);
}

function normalizeJsonText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function normalizeManagedProjects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const name = normalizeOptionalText(row.name, 128);
    const projectPath = normalizeWorkspacePath(row.path);
    if (!name || !projectPath) continue;
    const source = normalizeOptionalText(row.source, 64) || 'unknown';
    const originPath = normalizeWorkspacePath(row.originPath) || null;
    const key = `${name}\n${projectPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path: projectPath, source, originPath });
  }
  return out;
}

function normalizeHumanMeta(value) {
  const raw = (value && typeof value === 'object') ? value : {};
  return {
    owner: normalizeOptionalText(raw.owner, 256),
    notes: normalizeOptionalText(raw.notes, 8000) || '',
    projectScope: normalizeOptionalText(raw.projectScope, 4000) || '',
  };
}

function normalizeIsoTimestamp(value) {
  const raw = normalizeOptionalText(value, 128);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTaskStatus(value) {
  const raw = normalizeOptionalText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['active', 'waiting', 'blocked', 'done'].includes(lower)) return lower;
  return null;
}

function normalizeAgentTask(value, fallbackOwner = null) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const status = normalizeTaskStatus(value.status);
  if (!status) return null;
  const owner = normalizeAgentName(value.owner) || normalizeAgentName(fallbackOwner) || normalizeOptionalText(value.owner, 128);
  const updatedAt = normalizeIsoTimestamp(value.updated_at);
  const heartbeatAt = normalizeIsoTimestamp(value.heartbeat_at);
  const waitingReason = normalizeOptionalText(value.waiting_reason, 2000);
  const waitingUntil = normalizeIsoTimestamp(value.waiting_until);
  const id = normalizeOptionalText(value.id, 256);
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
  const framework = normalizeOptionalText(value.framework, 32);
  const provider = normalizeOptionalText(value.provider, 64);
  const model = normalizeOptionalText(value.model, 256);
  const reasoning = normalizeOptionalText(value.reasoning, 64);
  const extraArgs = normalizeOptionalText(value.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
  };
}

function normalizeRuntimeProfile(value) {
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

function normalizeLooseAgentName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return normalizeAgentName(trimmed);
}

function normalizeSubconsciousHook(value) {
  const hook = normalizeOptionalText(value, 120);
  if (!hook) return null;
  return hook;
}

function normalizeEventTs(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n;
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

function recentTailWindow(tail, maxLines = LOCAL_BLOCK_RECENT_LINES) {
  const lines = String(tail || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/g, ''))
    .filter(line => line.trim().length > 0);
  if (lines.length === 0) return '';
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

function detectLocalBlockedReason(tail, paneCmd = '') {
  if (!tail) return null;
  const cmd = String(paneCmd || '').toLowerCase();
  if (cmd && !cmd.includes('claude') && !cmd.includes('codex')) return null;
  const window = recentTailWindow(tail, LOCAL_BLOCK_RECENT_LINES);
  if (!window) return null;
  if (/tip:\s*use plan mode\b/i.test(window)) return null;

  for (const p of LOCAL_BLOCK_PATTERNS) {
    if (p.re.test(window)) return p.reason;
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

function emitRuntimeCompactEvent(agentName, payload = {}) {
  const marker = normalizeCompactMarker(payload?.marker);
  const modeRaw = (typeof payload?.mode === 'string' && payload.mode.trim())
    ? payload.mode.trim().toLowerCase()
    : 'pattern';
  const mode = modeRaw === 'hook' ? 'hook' : 'pattern';
  const key = `${agentName}:${marker}:${mode}`;
  const now = Date.now();
  const prevTs = Number(compactRuntimeAlertAt.get(key)) || 0;
  if ((now - prevTs) < AGENT_COMPACT_RUNTIME_DEDUPE_MS) {
    return { ok: true, suppressed: 'dedupe', agent: agentName, marker, mode };
  }
  compactRuntimeAlertAt.set(key, now);
  pruneCompactRuntimeDedupState(now);

  const event = buildRuntimeCompactEvent(agentName, {
    ...payload,
    mode,
    marker,
  });
  broadcastSSE('agent_compact', event);
  return { ok: true, event };
}

function buildSubconsciousEvent(body = {}) {
  const agent = normalizeLooseAgentName(body.agent);
  if (!agent) return null;
  const ts = normalizeEventTs(body.ts);
  return {
    id: `subconscious_${ts}_${agent}_${Math.random().toString(36).slice(2, 8)}`,
    ts,
    source: normalizeOptionalText(body.source, 120) || 'claude-subconscious-v1',
    agent,
    hook: normalizeSubconsciousHook(body.hook),
    hookEventName: normalizeSubconsciousHook(body.hookEventName),
    sessionId: normalizeOptionalText(body.sessionId, 256),
    transcriptPath: normalizeOptionalText(body.transcriptPath, 4096),
    toolName: normalizeOptionalText(body.toolName, 128),
    promptPreview: normalizeOptionalText(body.promptPreview, 1200),
    summary: normalizeOptionalText(body.summary, 600),
    lettaAgentId: normalizeOptionalText(body.lettaAgentId, 256),
    lettaStateFile: normalizeWorkspacePath(body.lettaStateFile),
    resolutionSource: normalizeOptionalText(body.resolutionSource, 64),
    backendMode: normalizeOptionalText(body.backendMode, 64),
    subconsciousEnabled: body.subconsciousEnabled === true
      ? true
      : (body.subconsciousEnabled === false ? false : null),
    guidancePresent: body.guidancePresent === true
      ? true
      : (body.guidancePresent === false ? false : null),
    guidanceConfigured: body.guidanceConfigured === true
      ? true
      : (body.guidanceConfigured === false ? false : null),
    guidanceInjected: body.guidanceInjected === true
      ? true
      : (body.guidanceInjected === false ? false : null),
    guidanceSource: normalizeOptionalText(body.guidanceSource, 64),
    guidancePreview: normalizeOptionalText(body.guidancePreview, 320),
    runtimeInvoked: body.runtimeInvoked === true
      ? true
      : (body.runtimeInvoked === false ? false : null),
    runtimeProvider: normalizeOptionalText(body.runtimeProvider, 64),
    runtimeModel: normalizeOptionalText(body.runtimeModel, 128),
    runtimeLatencyMs: normalizePositiveInt(body.runtimeLatencyMs, null),
    runtimeError: normalizeOptionalText(body.runtimeError, 600),
    upstreamUserPromptAttempted: body.upstreamUserPromptAttempted === true
      ? true
      : (body.upstreamUserPromptAttempted === false ? false : null),
    upstreamUserPromptStatus: normalizeOptionalText(body.upstreamUserPromptStatus, 64),
    upstreamUserPromptBlockedReason: normalizeOptionalText(body.upstreamUserPromptBlockedReason, 600),
    upstreamUserPromptMessageSent: body.upstreamUserPromptMessageSent === true
      ? true
      : (body.upstreamUserPromptMessageSent === false ? false : null),
    upstreamUserPromptConversationId: normalizeOptionalText(body.upstreamUserPromptConversationId, 256),
    upstreamUserPromptTranscriptPath: normalizeWorkspacePath(body.upstreamUserPromptTranscriptPath),
    upstreamUserPromptSyncStateFile: normalizeWorkspacePath(body.upstreamUserPromptSyncStateFile),
    upstreamUserPromptScriptPath: normalizeWorkspacePath(body.upstreamUserPromptScriptPath),
    upstreamUserPromptTranscriptLineCount: normalizeNonNegativeInt(body.upstreamUserPromptTranscriptLineCount, null),
    upstreamUserPromptLastProcessedIndexBefore: normalizeNonNegativeInt(body.upstreamUserPromptLastProcessedIndexBefore, null),
    upstreamUserPromptLastProcessedIndexAfter: normalizeNonNegativeInt(body.upstreamUserPromptLastProcessedIndexAfter, null),
    upstreamPreToolAttempted: body.upstreamPreToolAttempted === true
      ? true
      : (body.upstreamPreToolAttempted === false ? false : null),
    upstreamPreToolStatus: normalizeOptionalText(body.upstreamPreToolStatus, 64),
    upstreamPreToolBlockedReason: normalizeOptionalText(body.upstreamPreToolBlockedReason, 600),
    upstreamPreToolInjected: body.upstreamPreToolInjected === true
      ? true
      : (body.upstreamPreToolInjected === false ? false : null),
    upstreamPreToolConversationId: normalizeOptionalText(body.upstreamPreToolConversationId, 256),
    upstreamPreToolSyncStateFile: normalizeWorkspacePath(body.upstreamPreToolSyncStateFile),
    upstreamPreToolScriptPath: normalizeWorkspacePath(body.upstreamPreToolScriptPath),
    upstreamPreToolNewMessageCount: normalizeNonNegativeInt(body.upstreamPreToolNewMessageCount, null),
    upstreamPreToolChangedBlockCount: normalizeNonNegativeInt(body.upstreamPreToolChangedBlockCount, null),
    upstreamPreToolLastSeenMessageIdBefore: normalizeOptionalText(body.upstreamPreToolLastSeenMessageIdBefore, 256),
    upstreamPreToolLastSeenMessageIdAfter: normalizeOptionalText(body.upstreamPreToolLastSeenMessageIdAfter, 256),
    upstreamPreToolBlockLabelCount: normalizeNonNegativeInt(body.upstreamPreToolBlockLabelCount, null),
    upstreamStopAttempted: body.upstreamStopAttempted === true
      ? true
      : (body.upstreamStopAttempted === false ? false : null),
    upstreamStopStatus: normalizeOptionalText(body.upstreamStopStatus, 64),
    upstreamStopBlockedReason: normalizeOptionalText(body.upstreamStopBlockedReason, 600),
    upstreamStopMessageSent: body.upstreamStopMessageSent === true
      ? true
      : (body.upstreamStopMessageSent === false ? false : null),
    upstreamStopConversationId: normalizeOptionalText(body.upstreamStopConversationId, 256),
    upstreamStopTranscriptPath: normalizeWorkspacePath(body.upstreamStopTranscriptPath),
    upstreamStopSyncStateFile: normalizeWorkspacePath(body.upstreamStopSyncStateFile),
    upstreamStopScriptPath: normalizeWorkspacePath(body.upstreamStopScriptPath),
    upstreamStopTranscriptMessageCount: normalizeNonNegativeInt(body.upstreamStopTranscriptMessageCount, null),
    upstreamStopNewMessageCount: normalizeNonNegativeInt(body.upstreamStopNewMessageCount, null),
  };
}

function appendSubconsciousEvent(event) {
  const list = subconsciousEventsByAgent.get(event.agent) || [];
  list.push(event);
  if (list.length > SUBCONSCIOUS_EVENT_AGENT_LIMIT) {
    subconsciousEventsByAgent.set(event.agent, list.slice(list.length - SUBCONSCIOUS_EVENT_AGENT_LIMIT));
  } else {
    subconsciousEventsByAgent.set(event.agent, list);
  }
  try {
    appendFileSync(SUBCONSCIOUS_EVENT_LOG, JSON.stringify(event) + '\n');
  } catch (e) {
    console.error(`Failed to append subconscious event log: ${e.message}`);
  }
  broadcastSSE('subconscious_event', event);
}

function getSubconsciousEvents(agentName, limit = 120) {
  const rows = subconsciousEventsByAgent.get(agentName) || [];
  const n = Math.max(1, Math.min(Number(limit) || 120, SUBCONSCIOUS_EVENT_AGENT_LIMIT));
  return rows.slice(-n);
}

const SUBCONSCIOUS_RUNTIME_HOOKS = ['UserPromptSubmit', 'PreToolUse'];

function safeReadJsonFile(filePath, fallback = {}) {
  try {
    if (!filePath || !existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeWriteJsonFile(filePath, payload) {
  if (!filePath) return false;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function detectInstalledSubconsciousHooks(settingsPath) {
  if (!settingsPath || !existsSync(settingsPath)) return [];
  const settings = safeReadJsonFile(settingsPath, {});
  const hooksRoot = (settings && typeof settings.hooks === 'object' && settings.hooks) ? settings.hooks : {};
  const installed = [];
  for (const hookName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const rows = Array.isArray(hooksRoot[hookName]) ? hooksRoot[hookName] : [];
    const hasManagedEntry = rows.some((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return hooks.some((row) => typeof row?.command === 'string' && row.command.includes('hook-entry.mjs'));
    });
    if (hasManagedEntry) installed.push(hookName);
  }
  return installed;
}

function defaultSubconsciousMemoryStore(agentName) {
  return {
    schemaVersion: 1,
    kind: 'local-episodic-journal',
    retrievalStrategy: 'keyword-overlap-recency',
    agent: agentName,
    entryLimit: 80,
    retrievalLimit: 4,
    episodes: [],
    lastStoredAt: null,
    lastStoredEpisodeId: null,
    lastRetrievedAt: null,
    lastRetrievedQuery: null,
    lastRetrievedIds: [],
    updatedAt: null,
  };
}

function defaultSubconsciousConversationStore(agentName) {
  return {
    schemaVersion: 1,
    kind: 'claude-jsonl-session-journal',
    agent: agentName,
    sessionLimit: 24,
    currentSessionId: null,
    currentTranscriptPath: null,
    currentConversationUpdatedAt: null,
    lastSyncedAt: null,
    sessions: [],
    updatedAt: null,
  };
}

function normalizeSubconsciousMemoryEpisode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeOptionalText(raw.id, 128);
  const at = normalizeOptionalText(raw.at, 128);
  const hook = normalizeOptionalText(raw.hook, 120);
  const promptPreview = normalizeOptionalText(raw.promptPreview, 320);
  const toolName = normalizeOptionalText(raw.toolName, 120);
  const summary = normalizeOptionalText(raw.summary, 600);
  const guidance = normalizeOptionalText(raw.guidance, 2000);
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
      .map((item) => normalizeOptionalText(item, 64))
      .filter(Boolean)
      .slice(0, 32)
    : [];
  if (!id || !at) return null;
  return {
    id,
    at,
    hook: hook || null,
    promptPreview: promptPreview || '',
    toolName: toolName || null,
    summary: summary || '',
    guidance: guidance || '',
    keywords,
  };
}

function normalizeSubconsciousConversationTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = normalizeOptionalText(raw.role, 32);
  const at = normalizeOptionalText(raw.at, 128);
  const preview = normalizeOptionalText(raw.preview, 320);
  if (!role || !preview) return null;
  return {
    role,
    at: at || null,
    preview,
  };
}

function normalizeSubconsciousConversationSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = normalizeOptionalText(raw.sessionId, 200);
  const transcriptPath = normalizeWorkspacePath(raw.transcriptPath);
  if (!sessionId && !transcriptPath) return null;
  return {
    sessionId: sessionId || null,
    transcriptPath: transcriptPath || null,
    transcriptExists: raw.transcriptExists === true,
    transcriptLineCount: normalizeNonNegativeInt(raw.transcriptLineCount, 0),
    eventCount: normalizeNonNegativeInt(raw.eventCount, 0),
    userTurnCount: normalizeNonNegativeInt(raw.userTurnCount, 0),
    assistantTurnCount: normalizeNonNegativeInt(raw.assistantTurnCount, 0),
    startedAt: normalizeOptionalText(raw.startedAt, 128),
    updatedAt: normalizeOptionalText(raw.updatedAt, 128),
    lastEventAt: normalizeOptionalText(raw.lastEventAt, 128),
    lastHook: normalizeOptionalText(raw.lastHook, 120),
    lastToolName: normalizeOptionalText(raw.lastToolName, 120),
    lastRuntimeAt: normalizeOptionalText(raw.lastRuntimeAt, 128),
    lastRuntimeProvider: normalizeOptionalText(raw.lastRuntimeProvider, 64),
    lastRuntimeModel: normalizeOptionalText(raw.lastRuntimeModel, 128),
    latestUserText: normalizeOptionalText(raw.latestUserText, 320) || '',
    latestAssistantText: normalizeOptionalText(raw.latestAssistantText, 320) || '',
    latestGuidancePreview: normalizeOptionalText(raw.latestGuidancePreview, 320) || '',
    latestGuidanceAt: normalizeOptionalText(raw.latestGuidanceAt, 128),
    latestGuidanceSource: normalizeOptionalText(raw.latestGuidanceSource, 64),
    recentTurns: Array.isArray(raw.recentTurns)
      ? raw.recentTurns.map((row) => normalizeSubconsciousConversationTurn(row)).filter(Boolean).slice(-8)
      : [],
  };
}

function resolveSubconsciousMemoryState(agentName, stateDir, runtimeMeta) {
  if (!stateDir) return { path: null, store: defaultSubconsciousMemoryStore(agentName) };
  const configuredPath = normalizeWorkspacePath(runtimeMeta?.memoryStore?.path);
  const memoryPath = configuredPath || path.join(stateDir, 'subconscious', 'memory.json');
  const base = defaultSubconsciousMemoryStore(agentName);
  const raw = safeReadJsonFile(memoryPath, {});
  const entryLimit = normalizePositiveInt(raw?.entryLimit, base.entryLimit);
  const retrievalLimit = normalizePositiveInt(raw?.retrievalLimit, base.retrievalLimit);
  const episodes = Array.isArray(raw?.episodes)
    ? raw.episodes
      .map((row) => normalizeSubconsciousMemoryEpisode(row))
      .filter(Boolean)
      .slice(-entryLimit)
    : [];
  const store = {
    schemaVersion: 1,
    kind: normalizeOptionalText(raw?.kind, 128) || base.kind,
    retrievalStrategy: normalizeOptionalText(raw?.retrievalStrategy, 128) || base.retrievalStrategy,
    agent: normalizeOptionalText(raw?.agent, 128) || agentName,
    entryLimit,
    retrievalLimit,
    episodes,
    lastStoredAt: normalizeOptionalText(raw?.lastStoredAt, 128),
    lastStoredEpisodeId: normalizeOptionalText(raw?.lastStoredEpisodeId, 128),
    lastRetrievedAt: normalizeOptionalText(raw?.lastRetrievedAt, 128),
    lastRetrievedQuery: normalizeOptionalText(raw?.lastRetrievedQuery, 600),
    lastRetrievedIds: Array.isArray(raw?.lastRetrievedIds)
      ? raw.lastRetrievedIds.map((item) => normalizeOptionalText(item, 128)).filter(Boolean).slice(0, retrievalLimit)
      : [],
    updatedAt: normalizeOptionalText(raw?.updatedAt, 128),
  };
  if (!existsSync(memoryPath)) safeWriteJsonFile(memoryPath, store);
  return { path: memoryPath, store };
}

function resolveSubconsciousConversationState(agentName, stateDir, runtimeMeta) {
  if (!stateDir) return { path: null, store: defaultSubconsciousConversationStore(agentName) };
  const configuredPath = normalizeWorkspacePath(runtimeMeta?.conversationStore?.path);
  const conversationPath = configuredPath || path.join(stateDir, 'subconscious', 'conversations.json');
  const base = defaultSubconsciousConversationStore(agentName);
  const raw = safeReadJsonFile(conversationPath, {});
  const sessionLimit = normalizePositiveInt(raw?.sessionLimit, base.sessionLimit);
  const sessions = Array.isArray(raw?.sessions)
    ? raw.sessions
      .map((row) => normalizeSubconsciousConversationSession(row))
      .filter(Boolean)
      .slice(-sessionLimit)
    : [];
  const store = {
    schemaVersion: 1,
    kind: normalizeOptionalText(raw?.kind, 128) || base.kind,
    agent: normalizeOptionalText(raw?.agent, 128) || agentName,
    sessionLimit,
    currentSessionId: normalizeOptionalText(raw?.currentSessionId, 200)
      || sessions[sessions.length - 1]?.sessionId
      || null,
    currentTranscriptPath: normalizeWorkspacePath(raw?.currentTranscriptPath)
      || sessions[sessions.length - 1]?.transcriptPath
      || null,
    currentConversationUpdatedAt: normalizeOptionalText(raw?.currentConversationUpdatedAt, 128)
      || sessions[sessions.length - 1]?.updatedAt
      || null,
    lastSyncedAt: normalizeOptionalText(raw?.lastSyncedAt, 128),
    sessions,
    updatedAt: normalizeOptionalText(raw?.updatedAt, 128),
  };
  if (!existsSync(conversationPath)) safeWriteJsonFile(conversationPath, store);
  return { path: conversationPath, store };
}

function writeSubconsciousMemoryStore(memoryState) {
  if (!memoryState?.path || !memoryState?.store) return false;
  memoryState.store.updatedAt = new Date().toISOString();
  return safeWriteJsonFile(memoryState.path, memoryState.store);
}

function writeSubconsciousConversationStore(conversationState) {
  if (!conversationState?.path || !conversationState?.store) return false;
  conversationState.store.updatedAt = new Date().toISOString();
  return safeWriteJsonFile(conversationState.path, conversationState.store);
}

function mergeUpstreamDirectReuse(existing = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [
    ...(Array.isArray(existing) ? existing : []),
    'Subconscious.af prompt source',
    'agent_config.ts Letta bootstrap/config',
    'conversation_utils.ts durable conversation bookkeeping',
    'conversation_utils.ts real session/conversation lifecycle',
    'sync_letta_memory.ts UserPromptSubmit prompt-send source',
    'pretool_sync.ts PreToolUse mid-workflow sync',
    'send_messages_to_letta.ts Stop transcript/send flow',
    'transcript_utils.ts transcript formatting/parser source',
  ]) {
    const text = normalizeOptionalText(item, 160);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
  }
  return merged;
}

function deriveUpstreamNotifyDecision(blocker, agentId, model) {
  const text = normalizeOptionalText(blocker, 1200);
  if (!text) return null;
  if (/model-unknown/i.test(text)) {
    const bits = [];
    if (agentId) bits.push(`bound Letta agent ${agentId}`);
    if (model) bits.push(`current model ${model}`);
    const scope = bits.length ? `${bits.join(' / ')} ` : '';
    return `Choose a Letta-served model/config for ${scope}that accepts conversation message sends; current notify step returns model-unknown.`;
  }
  return 'Decide the external Letta model/config required for conversation message sends to succeed on the bound agent.';
}

function buildSubconsciousUpstreamContract(stateDir, workdir, runtimeMeta, letta, conversationState = null) {
  const upstreamPaths = buildUpstreamClaudeSubconsciousPaths(stateDir);
  const upstreamMeta = (runtimeMeta?.upstream && typeof runtimeMeta.upstream === 'object') ? runtimeMeta.upstream : {};
  const upstreamState = readUpstreamClaudeSubconsciousState(stateDir);
  const lettaUpstream = (letta?.upstream && typeof letta.upstream === 'object') ? letta.upstream : {};
  const runtimeUpstreamSession = (upstreamMeta.session && typeof upstreamMeta.session === 'object') ? upstreamMeta.session : {};
  const lettaUpstreamSession = (lettaUpstream.session && typeof lettaUpstream.session === 'object') ? lettaUpstream.session : {};
  const runtimeUpstreamUserPrompt = (upstreamMeta.userPrompt && typeof upstreamMeta.userPrompt === 'object') ? upstreamMeta.userPrompt : {};
  const lettaUpstreamUserPrompt = (lettaUpstream.userPrompt && typeof lettaUpstream.userPrompt === 'object') ? lettaUpstream.userPrompt : {};
  const runtimeUpstreamPreTool = (upstreamMeta.preTool && typeof upstreamMeta.preTool === 'object') ? upstreamMeta.preTool : {};
  const lettaUpstreamPreTool = (lettaUpstream.preTool && typeof lettaUpstream.preTool === 'object') ? lettaUpstream.preTool : {};
  const runtimeUpstreamStop = (upstreamMeta.stop && typeof upstreamMeta.stop === 'object') ? upstreamMeta.stop : {};
  const lettaUpstreamStop = (lettaUpstream.stop && typeof lettaUpstream.stop === 'object') ? lettaUpstream.stop : {};
  const conversationStore = (conversationState?.store && typeof conversationState.store === 'object') ? conversationState.store : {};
  const conversationSessions = Array.isArray(conversationStore.sessions) ? conversationStore.sessions : [];
  const directReuse = mergeUpstreamDirectReuse(upstreamMeta.directReuse);
  const config = (upstreamState.config && typeof upstreamState.config === 'object') ? upstreamState.config : {};
  const conversations = (upstreamState.conversations && typeof upstreamState.conversations === 'object') ? upstreamState.conversations : {};
  const readDurableUpstreamSession = (sessionId) => {
    const normalizedSessionId = normalizeOptionalText(sessionId, 200);
    const mappedConversation = normalizedSessionId ? conversations[normalizedSessionId] : null;
    const mappedConversationId = typeof mappedConversation === 'string'
      ? mappedConversation
      : normalizeOptionalText(mappedConversation?.conversationId, 256);
    const sessionStateFile = normalizeWorkspacePath(
      normalizedSessionId && upstreamPaths.durableStateDir
        ? path.join(upstreamPaths.durableStateDir, `session-${normalizedSessionId}.json`)
        : null
    );
    const sessionState = safeReadJsonFile(sessionStateFile, {});
    const lastProcessedIndexRaw = Number(sessionState?.lastProcessedIndex);
    const lastSeenMessageId = normalizeOptionalText(sessionState?.lastSeenMessageId, 256);
    const lastBlockValues = (sessionState?.lastBlockValues && typeof sessionState.lastBlockValues === 'object')
      ? sessionState.lastBlockValues
      : null;
    return {
      sessionId: normalizedSessionId,
      sessionStateFile,
      sessionState,
      conversationId: normalizeOptionalText(sessionState?.conversationId, 256) || mappedConversationId || null,
      lastProcessedIndex: Number.isFinite(lastProcessedIndexRaw) ? lastProcessedIndexRaw : null,
      lastSeenMessageId,
      lastBlockValues,
      hasLastBlockValues: Boolean(lastBlockValues),
      blockLabelCount: lastBlockValues ? Object.keys(lastBlockValues).length : null,
      sessionStartedAt: normalizeOptionalText(sessionState?.startedAt, 128) || null,
    };
  };
  const boundAgentId = normalizeOptionalText(
    letta?.agentId
      || letta?.lettaAgentId
      || lettaUpstream.agentId
      || upstreamMeta.agentId,
    256,
  );
  const importedAgentId = normalizeOptionalText(config.agentId, 256);
  const agentId = boundAgentId || importedAgentId;
  const apiKeyConfigured = Boolean(normalizeOptionalText(process.env.LETTA_API_KEY, 4096));
  const lettaBaseUrl = normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com';
  const conversationCurrentSessionId = normalizeOptionalText(
    conversationStore.currentSessionId
      || conversationSessions[conversationSessions.length - 1]?.sessionId,
    200,
  );
  const currentSessionId = normalizeOptionalText(
    lettaUpstreamSession.sessionId
      || runtimeUpstreamSession.sessionId
      || conversationCurrentSessionId,
    200,
  );
  const currentSessionDurable = readDurableUpstreamSession(currentSessionId);
  const currentSessionStateFile = currentSessionDurable.sessionStateFile
    || normalizeWorkspacePath(lettaUpstreamSession.sessionStateFile)
    || normalizeWorkspacePath(runtimeUpstreamSession.sessionStateFile)
    || null;
  const currentSessionState = currentSessionDurable.sessionState;
  const currentConversationId = normalizeOptionalText(
    currentSessionDurable.conversationId
      || lettaUpstreamSession.conversationId
      || runtimeUpstreamSession.conversationId,
    256,
  );
  const sessionEstablished = Boolean(currentSessionId && currentConversationId);
  const rawNotify = (lettaUpstreamSession.notify && typeof lettaUpstreamSession.notify === 'object')
    ? lettaUpstreamSession.notify
    : ((runtimeUpstreamSession.notify && typeof runtimeUpstreamSession.notify === 'object') ? runtimeUpstreamSession.notify : {});
  const notifyBlockedReason = normalizeOptionalText(rawNotify.blockedReason, 1200);
  const notifyStatus = normalizeOptionalText(rawNotify.status, 64)
    || (normalizeBoolean(rawNotify.messageSent) === true ? 'sent' : null)
    || (notifyBlockedReason ? 'blocked' : null)
    || (normalizeBoolean(rawNotify.attempted) === true ? 'attempted' : null)
    || 'not-attempted';
  const rawUserPrompt = (lettaUpstreamUserPrompt && typeof lettaUpstreamUserPrompt === 'object' && Object.keys(lettaUpstreamUserPrompt).length)
    ? lettaUpstreamUserPrompt
    : ((runtimeUpstreamUserPrompt && typeof runtimeUpstreamUserPrompt === 'object') ? runtimeUpstreamUserPrompt : {});
  const userPromptSessionId = normalizeOptionalText(rawUserPrompt.sessionId, 200) || currentSessionDurable.sessionId || null;
  const userPromptDurable = readDurableUpstreamSession(userPromptSessionId);
  const userPromptBlockedReason = normalizeOptionalText(rawUserPrompt.blockedReason, 1200);
  const userPromptStatus = (userPromptDurable.lastProcessedIndex !== null ? 'sent' : null)
    || normalizeOptionalText(rawUserPrompt.status, 64)
    || (normalizeBoolean(rawUserPrompt.messageSent) === true ? 'sent' : null)
    || (userPromptBlockedReason ? 'blocked' : null)
    || (normalizeBoolean(rawUserPrompt.attempted) === true ? 'attempted' : null)
    || 'not-run';
  const userPromptTranscriptPath = normalizeWorkspacePath(rawUserPrompt.transcriptPath) || null;
  const userPromptSyncStateFile = userPromptDurable.sessionStateFile || normalizeWorkspacePath(rawUserPrompt.syncStateFile) || null;
  const userPromptLastProcessedIndexAfterRaw = userPromptDurable.lastProcessedIndex !== null
    ? userPromptDurable.lastProcessedIndex
    : Number(rawUserPrompt.lastProcessedIndexAfter);
  const rawPreTool = (lettaUpstreamPreTool && typeof lettaUpstreamPreTool === 'object' && Object.keys(lettaUpstreamPreTool).length)
    ? lettaUpstreamPreTool
    : ((runtimeUpstreamPreTool && typeof runtimeUpstreamPreTool === 'object') ? runtimeUpstreamPreTool : {});
  const preToolSessionId = normalizeOptionalText(rawPreTool.sessionId, 200) || currentSessionDurable.sessionId || null;
  const preToolDurable = readDurableUpstreamSession(preToolSessionId);
  const preToolBlockedReason = normalizeOptionalText(rawPreTool.blockedReason, 1200);
  const preToolStatus = (preToolDurable.lastSeenMessageId ? 'seeded-baseline' : null)
    || normalizeOptionalText(rawPreTool.status, 64)
    || (normalizeBoolean(rawPreTool.injected) === true ? 'injected' : null)
    || (preToolBlockedReason ? 'blocked' : null)
    || (normalizeBoolean(rawPreTool.attempted) === true ? 'attempted' : null)
    || 'not-run';
  const preToolSyncStateFile = preToolDurable.sessionStateFile || normalizeWorkspacePath(rawPreTool.syncStateFile) || null;
  const rawStop = (lettaUpstreamStop && typeof lettaUpstreamStop === 'object' && Object.keys(lettaUpstreamStop).length)
    ? lettaUpstreamStop
    : ((runtimeUpstreamStop && typeof runtimeUpstreamStop === 'object') ? runtimeUpstreamStop : {});
  const stopSessionId = normalizeOptionalText(rawStop.sessionId, 200) || currentSessionDurable.sessionId || null;
  const stopDurable = readDurableUpstreamSession(stopSessionId);
  const stopBlockedReason = normalizeOptionalText(rawStop.blockedReason, 1200);
  const stopStatus = normalizeOptionalText(rawStop.status, 64)
    || (normalizeBoolean(rawStop.messageSent) === true ? 'sent' : null)
    || (stopBlockedReason ? 'blocked' : null)
    || (normalizeBoolean(rawStop.attempted) === true ? 'attempted' : null)
    || 'not-run';
  const stopTranscriptPath = normalizeWorkspacePath(rawStop.transcriptPath) || null;
  const stopSyncStateFile = stopDurable.sessionStateFile || normalizeWorkspacePath(rawStop.syncStateFile) || null;
  const stopLastProcessedIndexAfterRaw = stopDurable.lastProcessedIndex !== null
    ? stopDurable.lastProcessedIndex
    : Number(rawStop.lastProcessedIndexAfter);
  let blocker = null;
  if (!upstreamPaths.available) blocker = `missing upstream claude-subconscious root at ${upstreamPaths.root || '-'}`;
  else if (!apiKeyConfigured) blocker = 'missing LETTA_API_KEY';
  const explicitBootstrapStatus = normalizeOptionalText(lettaUpstream.bootstrapStatus, 64)
    || normalizeOptionalText(upstreamMeta.bootstrapStatus, 64);
  const durableUpstreamObserved = Boolean(
    boundAgentId
    || currentSessionId
    || currentConversationId
    || Object.keys(conversations).length > 0
  );
  const bootstrapStatus = durableUpstreamObserved
    ? 'configured'
    : (explicitBootstrapStatus || (agentId ? 'configured' : 'not-run'));
  const bootstrapBlockedReason = bootstrapStatus === 'configured'
    ? (blocker === 'missing LETTA_API_KEY' ? blocker : null)
    : (
      normalizeOptionalText(lettaUpstream.blocker, 240)
      || normalizeOptionalText(upstreamMeta.blocker, 240)
      || blocker
    );
  return {
    classification: 'authoritative',
    available: upstreamPaths.available,
    root: upstreamPaths.root,
    promptFile: upstreamPaths.promptFile,
    scripts: upstreamPaths.scripts,
    durableHome: upstreamPaths.durableHome,
    durableStateDir: upstreamPaths.durableStateDir,
    conversationsFile: upstreamPaths.conversationsFile,
    configPath: upstreamPaths.configPath,
    directReuse,
    transitionalBoundary: [
      'SessionStart lifecycle can now run through the explicit upstream Letta session/conversation entrypoint.',
      'UserPromptSubmit can now send the real user prompt into the bound upstream Letta conversation and advance the durable sync state.',
      'PreToolUse can now read real upstream assistant-message and memory-block deltas from the bound Letta conversation/agent and inject them before tool execution.',
      'Stop transcript/send can now run through the explicit upstream Letta send_messages_to_letta.ts-style path.',
      'Upstream Letta transcript send/checkpoint scripts are only partially live; SessionStart, UserPromptSubmit, PreToolUse, and Stop are cut over, but the full remaining hook flow is not.',
      'Local episodic memory/conversation journals remain transitional until full upstream Letta flow is wired.',
    ],
    bootstrap: {
      supported: upstreamPaths.available,
      status: bootstrapStatus,
      blockedReason: bootstrapBlockedReason,
      apiKeyConfigured,
      lettaBaseUrl,
      agentId,
      importedAt: normalizeOptionalText(config.importedAt, 128)
        || normalizeOptionalText(lettaUpstream.importedAt, 128)
        || normalizeOptionalText(upstreamMeta.importedAt, 128),
      model: normalizeOptionalText(config.model, 256)
        || normalizeOptionalText(lettaUpstream.model, 256)
        || normalizeOptionalText(upstreamMeta.model, 256),
      agentName: normalizeOptionalText(lettaUpstream.agentName, 256)
        || normalizeOptionalText(upstreamMeta.agentName, 256),
      blockCount: normalizeNonNegativeInt(lettaUpstream.blockCount ?? upstreamMeta.blockCount, 0),
      conversationCount: Object.keys(conversations).length,
      workdir: workdir || null,
    },
    session: {
      supported: upstreamPaths.available && apiKeyConfigured && Boolean(agentId),
      established: sessionEstablished,
      status: sessionEstablished
        ? 'started'
        : (
          normalizeOptionalText(lettaUpstreamSession.status, 64)
          || normalizeOptionalText(runtimeUpstreamSession.status, 64)
          || 'not-run'
        ),
      blockedReason: sessionEstablished
        ? null
        : (
          normalizeOptionalText(lettaUpstreamSession.blocker, 240)
          || normalizeOptionalText(runtimeUpstreamSession.blocker, 240)
          || null
        ),
      sessionId: currentSessionId,
      conversationId: currentConversationId,
      conversationStatus: normalizeOptionalText(lettaUpstreamSession.conversationStatus, 64)
        || normalizeOptionalText(runtimeUpstreamSession.conversationStatus, 64)
        || (currentConversationId ? 'recorded' : null),
      sessionStateFile: currentSessionStateFile,
      sessionStartedAt: currentSessionDurable.sessionStartedAt
        || normalizeOptionalText(lettaUpstreamSession.sessionStartedAt, 128)
        || normalizeOptionalText(runtimeUpstreamSession.sessionStartedAt, 128)
        || null,
      messageSent: normalizeBoolean(lettaUpstreamSession.messageSent) === true
        || normalizeBoolean(runtimeUpstreamSession.messageSent) === true,
      cwd: normalizeWorkspacePath(lettaUpstreamSession.cwd || runtimeUpstreamSession.cwd) || workdir || null,
      notify: {
        attempted: notifyStatus !== 'not-attempted',
        status: notifyStatus,
        blockedReason: notifyStatus === 'blocked' ? notifyBlockedReason : null,
        messageSent: normalizeBoolean(rawNotify.messageSent) === true
          || normalizeBoolean(lettaUpstreamSession.messageSent) === true
          || normalizeBoolean(runtimeUpstreamSession.messageSent) === true,
        requiredDecision: notifyStatus === 'blocked'
          ? deriveUpstreamNotifyDecision(
            notifyBlockedReason,
            agentId,
            normalizeOptionalText(config.model, 256)
              || normalizeOptionalText(lettaUpstream.model, 256)
              || normalizeOptionalText(upstreamMeta.model, 256)
          )
          : null,
      },
    },
    userPrompt: {
      supported: upstreamPaths.available && apiKeyConfigured && Boolean(agentId),
      attempted: normalizeBoolean(rawUserPrompt.attempted) === true || userPromptStatus === 'attempted' || userPromptStatus === 'sent' || userPromptStatus === 'blocked',
      status: userPromptStatus,
      blockedReason: userPromptStatus === 'blocked' ? userPromptBlockedReason : null,
      messageSent: normalizeBoolean(rawUserPrompt.messageSent) === true || userPromptDurable.lastProcessedIndex !== null,
      sessionId: userPromptSessionId,
      conversationId: userPromptDurable.conversationId
        || normalizeOptionalText(rawUserPrompt.conversationId, 256)
        || null,
      transcriptPath: userPromptTranscriptPath,
      transcriptExists: userPromptTranscriptPath ? existsSync(userPromptTranscriptPath) : false,
      syncStateFile: userPromptSyncStateFile,
      lastProcessedIndexAfter: Number.isFinite(userPromptLastProcessedIndexAfterRaw) ? userPromptLastProcessedIndexAfterRaw : null,
      scriptPath: normalizeWorkspacePath(rawUserPrompt.scriptPath || upstreamPaths.scripts?.syncMemory) || upstreamPaths.scripts?.syncMemory || null,
    },
    preTool: {
      supported: upstreamPaths.available && apiKeyConfigured && Boolean(agentId),
      attempted: normalizeBoolean(rawPreTool.attempted) === true || preToolStatus === 'attempted' || preToolStatus === 'injected' || preToolStatus === 'blocked' || preToolStatus === 'no-updates' || preToolStatus === 'seeded-baseline',
      status: preToolStatus,
      blockedReason: preToolStatus === 'blocked' ? preToolBlockedReason : null,
      injected: normalizeBoolean(rawPreTool.injected) === true,
      sessionId: preToolSessionId,
      conversationId: preToolDurable.conversationId
        || normalizeOptionalText(rawPreTool.conversationId, 256)
        || null,
      syncStateFile: preToolSyncStateFile,
      lastSeenMessageIdAfter: preToolDurable.lastSeenMessageId
        || normalizeOptionalText(rawPreTool.lastSeenMessageIdAfter, 256)
        || null,
      blockLabelCount: preToolDurable.hasLastBlockValues
        ? preToolDurable.blockLabelCount
        : normalizeNonNegativeInt(rawPreTool.blockLabelCount, 0),
      scriptPath: normalizeWorkspacePath(rawPreTool.scriptPath || upstreamPaths.scripts?.pretoolSync) || upstreamPaths.scripts?.pretoolSync || null,
    },
    stop: {
      supported: upstreamPaths.available && apiKeyConfigured && Boolean(agentId),
      attempted: normalizeBoolean(rawStop.attempted) === true || stopStatus === 'attempted' || stopStatus === 'sent' || stopStatus === 'blocked',
      status: stopStatus,
      blockedReason: stopStatus === 'blocked' ? stopBlockedReason : null,
      messageSent: normalizeBoolean(rawStop.messageSent) === true,
      sessionId: stopSessionId,
      conversationId: stopDurable.conversationId
        || normalizeOptionalText(rawStop.conversationId, 256)
        || null,
      transcriptPath: stopTranscriptPath,
      transcriptExists: stopTranscriptPath ? existsSync(stopTranscriptPath) : false,
      syncStateFile: stopSyncStateFile,
      lastProcessedIndexAfter: Number.isFinite(stopLastProcessedIndexAfterRaw) ? stopLastProcessedIndexAfterRaw : null,
      scriptPath: normalizeWorkspacePath(rawStop.scriptPath || upstreamPaths.scripts?.stopSend) || upstreamPaths.scripts?.stopSend || null,
    },
  };
}

function buildSubconsciousAuthoritySummary({ enabled, upstream, lettaAgentId }) {
  const bootstrap = (upstream && typeof upstream.bootstrap === 'object') ? upstream.bootstrap : {};
  const session = (upstream && typeof upstream.session === 'object') ? upstream.session : {};
  const userPrompt = (upstream && typeof upstream.userPrompt === 'object') ? upstream.userPrompt : {};
  const preTool = (upstream && typeof upstream.preTool === 'object') ? upstream.preTool : {};
  const stop = (upstream && typeof upstream.stop === 'object') ? upstream.stop : {};
  const boundAgentId = normalizeOptionalText(bootstrap.agentId || lettaAgentId, 256);
  const bindingConfigured = Boolean(boundAgentId);
  const sessionEstablished = session.established === true;
  const progress = [
    { key: 'stop', label: 'Stop', status: normalizeOptionalText(stop.status, 64) || 'not-run' },
    { key: 'preTool', label: 'PreToolUse', status: normalizeOptionalText(preTool.status, 64) || 'not-run' },
    { key: 'userPrompt', label: 'UserPromptSubmit', status: normalizeOptionalText(userPrompt.status, 64) || 'not-run' },
    { key: 'session', label: 'SessionStart', status: normalizeOptionalText(session.status, 64) || 'not-run' },
  ];
  const latestProgress = progress.find((row) => row.status && row.status !== 'not-run') || progress[progress.length - 1];
  let status = 'off';
  let reason = enabled === true ? null : 'subconscious disabled';
  if (enabled === true) {
    if (sessionEstablished) {
      status = 'active';
      reason = null;
    } else if (bindingConfigured || normalizeOptionalText(bootstrap.status, 64) === 'configured') {
      status = 'degraded';
      reason = normalizeOptionalText(session.blockedReason, 1200)
        || normalizeOptionalText(session.status, 64) === 'not-run'
        || normalizeOptionalText(session.status, 64) === null
          ? 'authoritative upstream session not established'
          : normalizeOptionalText(bootstrap.blockedReason, 1200)
            || 'authoritative upstream path is configured but not established';
    } else {
      status = 'unconfigured';
      reason = normalizeOptionalText(bootstrap.blockedReason, 1200)
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

function buildSubconsciousFallbackSummary(manualGuidance) {
  const configured = typeof manualGuidance === 'string' && manualGuidance.trim().length > 0;
  return {
    classification: 'fallback',
    status: configured ? 'configured' : 'none',
    configured,
    source: configured ? 'manual-state-file' : 'none',
    note: 'Manual guidance is fallback configuration only; it is not the authoritative subconscious behavior path.',
  };
}

function buildSubconsciousTransitionalSummary(runtime, memoryInfo, conversationInfo) {
  const runtimeDesired = runtime?.desiredEnabled === true;
  let runtimeStatus = 'off';
  if (runtimeDesired && runtime?.invocationConfigured === true) runtimeStatus = 'ready';
  else if (runtimeDesired) runtimeStatus = 'degraded';
  return {
    classification: 'transitional',
    runtimeStatus,
    runtimeDesired,
    runtimeInvocationConfigured: runtime?.invocationConfigured === true,
    runtimeDisabledReason: normalizeOptionalText(runtime?.disabledReason, 1200),
    localMemoryConfigured: normalizeNonNegativeInt(memoryInfo?.entryCount, 0) > 0,
    localConversationConfigured: normalizeNonNegativeInt(conversationInfo?.sessionCount, 0) > 0,
    note: 'Local runtime, memory, and conversation journals are transitional compatibility/debug surfaces only.',
  };
}

function extractTranscriptTextParts(content, out = []) {
  if (typeof content === 'string') {
    const text = normalizeOptionalText(content, 4000);
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(content)) {
    for (const item of content) extractTranscriptTextParts(item, out);
    return out;
  }
  if (!content || typeof content !== 'object') return out;
  if (content.type === 'text') {
    const text = normalizeOptionalText(content.text, 4000);
    if (text) out.push(text);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(content, 'content')) {
    extractTranscriptTextParts(content.content, out);
  }
  if (typeof content.text === 'string') {
    const text = normalizeOptionalText(content.text, 4000);
    if (text) out.push(text);
  }
  return out;
}

function extractTranscriptMessageText(row) {
  const text = extractTranscriptTextParts(row?.message?.content || row?.content || []).join('\n');
  return normalizeOptionalText(text.replace(/\s+/g, ' ').trim(), 4000);
}

function inferTranscriptSessionId(transcriptPath) {
  if (!transcriptPath) return null;
  const base = path.basename(String(transcriptPath), path.extname(String(transcriptPath)));
  return normalizeOptionalText(base, 200);
}

function parseClaudeConversationTranscript(sessionId, transcriptPath) {
  const resolvedPath = normalizeWorkspacePath(transcriptPath);
  const parsedSessionId = normalizeOptionalText(sessionId, 200) || inferTranscriptSessionId(resolvedPath);
  const base = {
    sessionId: parsedSessionId || null,
    transcriptPath: resolvedPath || null,
    transcriptExists: Boolean(resolvedPath && existsSync(resolvedPath)),
    transcriptLineCount: 0,
    eventCount: 0,
    userTurnCount: 0,
    assistantTurnCount: 0,
    startedAt: null,
    updatedAt: null,
    latestUserText: '',
    latestAssistantText: '',
    recentTurns: [],
  };
  if (!resolvedPath || !existsSync(resolvedPath)) return base;
  let text = '';
  try {
    text = readFileSync(resolvedPath, 'utf-8');
  } catch {
    return base;
  }
  const recentTurns = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    base.transcriptLineCount += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const rowSessionId = normalizeOptionalText(row?.sessionId, 200);
    if (parsedSessionId && rowSessionId && rowSessionId !== parsedSessionId) continue;
    if (!base.sessionId && rowSessionId) base.sessionId = rowSessionId;
    base.eventCount += 1;
    const at = normalizeOptionalText(row?.timestamp, 128);
    if (at && !base.startedAt) base.startedAt = at;
    if (at) base.updatedAt = at;
    if (row?.type === 'user' && row?.message?.role === 'user') {
      const preview = extractTranscriptMessageText(row);
      if (preview) {
        base.userTurnCount += 1;
        base.latestUserText = preview.slice(0, 320);
        recentTurns.push({ role: 'user', at: at || null, preview: preview.slice(0, 320) });
      }
      continue;
    }
    if (row?.type === 'assistant' && row?.message?.role === 'assistant') {
      const preview = extractTranscriptMessageText(row);
      if (preview) {
        base.assistantTurnCount += 1;
        base.latestAssistantText = preview.slice(0, 320);
        recentTurns.push({ role: 'assistant', at: at || null, preview: preview.slice(0, 320) });
      }
    }
  }
  base.recentTurns = recentTurns.slice(-8);
  return base;
}

function syncSubconsciousConversationState(state, payload = {}, extra = {}) {
  const conversationState = state?.conversationState;
  const store = conversationState?.store;
  if (!conversationState?.path || !store) return null;
  const transcriptPath = normalizeWorkspacePath(payload?.transcriptPath || extra.transcriptPath);
  const sessionId = normalizeOptionalText(payload?.sessionId || extra.sessionId, 200)
    || inferTranscriptSessionId(transcriptPath)
    || store.currentSessionId;
  if (!sessionId && !transcriptPath) return null;
  const parsed = parseClaudeConversationTranscript(sessionId, transcriptPath);
  const key = parsed.sessionId || sessionId || transcriptPath;
  const nowIso = new Date().toISOString();
  const sessions = Array.isArray(store.sessions) ? [...store.sessions] : [];
  const existingIndex = sessions.findIndex((row) => (row.sessionId && row.sessionId === key) || (row.transcriptPath && row.transcriptPath === transcriptPath));
  const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
  const nextGuidancePreview = normalizeOptionalText(extra.guidancePreview, 320);
  const nextGuidanceAt = nextGuidancePreview
    ? (normalizeOptionalText(extra.guidanceAt, 128) || normalizeOptionalText(extra.at, 128) || nowIso)
    : null;
  const nextGuidanceSource = nextGuidancePreview
    ? (normalizeOptionalText(extra.guidanceSource, 64) || existing?.latestGuidanceSource || null)
    : null;
  const nextSession = {
    sessionId: parsed.sessionId || sessionId || existing?.sessionId || null,
    transcriptPath: parsed.transcriptPath || transcriptPath || existing?.transcriptPath || null,
    transcriptExists: parsed.transcriptExists === true,
    transcriptLineCount: parsed.transcriptLineCount || existing?.transcriptLineCount || 0,
    eventCount: parsed.eventCount || existing?.eventCount || 0,
    userTurnCount: parsed.userTurnCount || existing?.userTurnCount || 0,
    assistantTurnCount: parsed.assistantTurnCount || existing?.assistantTurnCount || 0,
    startedAt: parsed.startedAt || existing?.startedAt || normalizeOptionalText(extra.at, 128) || nowIso,
    updatedAt: parsed.updatedAt || normalizeOptionalText(extra.at, 128) || existing?.updatedAt || nowIso,
    lastEventAt: normalizeOptionalText(extra.at, 128) || parsed.updatedAt || existing?.lastEventAt || nowIso,
    lastHook: normalizeOptionalText(extra.hook, 120) || existing?.lastHook || null,
    lastToolName: normalizeOptionalText(extra.toolName, 120) || existing?.lastToolName || null,
    lastRuntimeAt: extra.runtimeInvoked === true
      ? (normalizeOptionalText(extra.at, 128) || nowIso)
      : (existing?.lastRuntimeAt || null),
    lastRuntimeProvider: extra.runtimeInvoked === true
      ? (normalizeOptionalText(extra.runtimeProvider, 64) || existing?.lastRuntimeProvider || null)
      : (existing?.lastRuntimeProvider || null),
    lastRuntimeModel: extra.runtimeInvoked === true
      ? (normalizeOptionalText(extra.runtimeModel, 128) || existing?.lastRuntimeModel || null)
      : (existing?.lastRuntimeModel || null),
    latestUserText: parsed.latestUserText || existing?.latestUserText || '',
    latestAssistantText: parsed.latestAssistantText || existing?.latestAssistantText || '',
    latestGuidancePreview: nextGuidancePreview || existing?.latestGuidancePreview || '',
    latestGuidanceAt: nextGuidanceAt || existing?.latestGuidanceAt || null,
    latestGuidanceSource: nextGuidanceSource || existing?.latestGuidanceSource || null,
    recentTurns: parsed.recentTurns.length ? parsed.recentTurns : (existing?.recentTurns || []),
  };
  if (existingIndex >= 0) sessions.splice(existingIndex, 1);
  sessions.push(nextSession);
  sessions.sort((a, b) => String(a.lastEventAt || a.updatedAt || '').localeCompare(String(b.lastEventAt || b.updatedAt || '')));
  store.sessions = sessions.slice(-normalizePositiveInt(store.sessionLimit, 24));
  store.currentSessionId = nextSession.sessionId || store.currentSessionId || null;
  store.currentTranscriptPath = nextSession.transcriptPath || store.currentTranscriptPath || null;
  store.currentConversationUpdatedAt = nextSession.updatedAt || store.currentConversationUpdatedAt || null;
  store.lastSyncedAt = nowIso;
  writeSubconsciousConversationStore(conversationState);
  return nextSession;
}

function applyConversationSnapshotToContract(state, sessionSnapshot = null) {
  const contract = state?.contract;
  const conversationState = state?.conversationState;
  const store = conversationState?.store;
  if (!contract?.conversation || !store) return sessionSnapshot || null;
  const sessions = Array.isArray(store.sessions) ? store.sessions : [];
  const current = sessionSnapshot
    || sessions.find((row) => row.sessionId && row.sessionId === store.currentSessionId)
    || sessions.find((row) => row.transcriptPath && row.transcriptPath === store.currentTranscriptPath)
    || sessions[sessions.length - 1]
    || null;
  contract.conversation.kind = store.kind || 'claude-jsonl-session-journal';
  contract.conversation.path = conversationState?.path || null;
  contract.conversation.sessionCount = sessions.length;
  contract.conversation.sessionLimit = normalizePositiveInt(store.sessionLimit, 24);
  contract.conversation.currentSessionId = store.currentSessionId || current?.sessionId || null;
  contract.conversation.currentTranscriptPath = store.currentTranscriptPath || current?.transcriptPath || null;
  contract.conversation.lastSyncedAt = store.lastSyncedAt || null;
  contract.conversation.updatedAt = store.updatedAt || null;
  contract.conversation.current = current
    ? {
        sessionId: current.sessionId || null,
        transcriptPath: current.transcriptPath || null,
        transcriptExists: current.transcriptExists === true,
        transcriptLineCount: current.transcriptLineCount || 0,
        eventCount: current.eventCount || 0,
        userTurnCount: current.userTurnCount || 0,
        assistantTurnCount: current.assistantTurnCount || 0,
        startedAt: current.startedAt || null,
        updatedAt: current.updatedAt || null,
        lastEventAt: current.lastEventAt || null,
        lastHook: current.lastHook || null,
        lastToolName: current.lastToolName || null,
        lastRuntimeAt: current.lastRuntimeAt || null,
        lastRuntimeProvider: current.lastRuntimeProvider || null,
        lastRuntimeModel: current.lastRuntimeModel || null,
        latestUserText: current.latestUserText || '',
        latestAssistantText: current.latestAssistantText || '',
        recentTurns: Array.isArray(current.recentTurns) ? current.recentTurns : [],
      }
    : null;
  return current;
}

function tokenizeSubconsciousMemoryText(...parts) {
  const seen = new Set();
  for (const part of parts) {
    const text = String(part || '').toLowerCase();
    for (const token of text.match(/[a-z0-9][a-z0-9_-]{1,31}/g) || []) {
      if (token.length < 3) continue;
      seen.add(token);
    }
  }
  return [...seen];
}

function retrieveSubconsciousMemories(memoryState, payload) {
  const store = memoryState?.store;
  const episodes = Array.isArray(store?.episodes) ? store.episodes : [];
  const queryText = [
    normalizeOptionalText(payload?.promptPreview, 320),
    normalizeOptionalText(payload?.summary, 600),
    normalizeOptionalText(payload?.toolName, 120),
    normalizeOptionalText(payload?.hook, 120),
  ].filter(Boolean).join(' | ');
  const queryTokens = tokenizeSubconsciousMemoryText(queryText);
  if (!queryTokens.length || !episodes.length) {
    return { queryText, queryTokens, matches: [] };
  }
  const scored = episodes.map((episode, index) => {
    const episodeKeywords = Array.isArray(episode.keywords) ? episode.keywords : [];
    const overlap = episodeKeywords.filter((token) => queryTokens.includes(token));
    if (!overlap.length) return null;
    const recency = (index + 1) / episodes.length;
    return {
      episode,
      overlap,
      score: overlap.length * 10 + recency,
    };
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score || String(b.episode.at || '').localeCompare(String(a.episode.at || '')));
  const limit = normalizePositiveInt(store?.retrievalLimit, 4);
  return {
    queryText,
    queryTokens,
    matches: scored.slice(0, limit).map((row) => ({
      id: row.episode.id,
      at: row.episode.at,
      hook: row.episode.hook || null,
      summary: row.episode.summary || '',
      guidancePreview: row.episode.guidance || '',
      overlapKeywords: row.overlap.slice(0, 8),
      score: Number(row.score.toFixed(2)),
    })),
  };
}

function appendSubconsciousMemoryEpisode(memoryState, promptPayload, parsed) {
  const store = memoryState?.store;
  if (!memoryState?.path || !store) return null;
  const nowIso = new Date().toISOString();
  const guidance = normalizeOptionalText(parsed?.guidance, 4000) || '';
  const summary = normalizeOptionalText(parsed?.summary, 600) || 'runtime guidance';
  const episode = {
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowIso,
    hook: normalizeOptionalText(promptPayload?.hook, 120),
    promptPreview: normalizeOptionalText(promptPayload?.promptPreview, 320) || '',
    toolName: normalizeOptionalText(promptPayload?.toolName, 120),
    summary,
    guidance: guidance ? guidance.slice(0, 600) : '',
    keywords: tokenizeSubconsciousMemoryText(
      promptPayload?.hook,
      promptPayload?.toolName,
      promptPayload?.promptPreview,
      promptPayload?.summary,
      summary,
      guidance
    ).slice(0, 32),
  };
  const entryLimit = normalizePositiveInt(store.entryLimit, 80);
  const nextEpisodes = Array.isArray(store.episodes) ? [...store.episodes, episode] : [episode];
  store.episodes = nextEpisodes.slice(-entryLimit);
  store.lastStoredAt = nowIso;
  store.lastStoredEpisodeId = episode.id;
  writeSubconsciousMemoryStore(memoryState);
  return episode;
}

function resolveSubconsciousState(agentName) {
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return null;
  const stateDir = normalizeWorkspacePath(agent.stateDir);
  const workdir = normalizeWorkspacePath(agent.workdir);
  const lettaPath = stateDir ? path.join(stateDir, 'letta.json') : null;
  const runtimeMetaPath = stateDir ? path.join(stateDir, 'subconscious', 'runtime.json') : null;
  const letta = safeReadJsonFile(lettaPath, {});
  const runtimeMeta = safeReadJsonFile(runtimeMetaPath, {});
  const settingsPath = normalizeWorkspacePath(runtimeMeta?.settingsPath) || (workdir ? path.join(workdir, '.claude', 'settings.json') : null);
  const pluginRoot = normalizeWorkspacePath(runtimeMeta?.pluginRoot) || (stateDir ? path.join(stateDir, 'subconscious', 'claude-agentchat') : null);
  const installedHooks = detectInstalledSubconsciousHooks(settingsPath);
  const runtimeCfg = (letta?.runtime && typeof letta.runtime === 'object') ? letta.runtime : {};
  const stateProvider = normalizeProviderOrNull(runtimeCfg.provider);
  const envProvider = normalizeProviderOrNull(process.env.SUBCONSCIOUS_LLM_PROVIDER);
  const provider = stateProvider || envProvider || 'deepseek';
  const providerSource = stateProvider ? 'state' : (envProvider ? 'subconscious-env' : 'default');
  const stateModel = normalizeOptionalText(runtimeCfg.model, 256);
  const envModel = normalizeOptionalText(process.env.SUBCONSCIOUS_LLM_MODEL, 256);
  const model = stateModel || envModel || defaultCompatibleModel(provider);
  const modelSource = stateModel ? 'state' : (envModel ? 'subconscious-env' : 'default');
  const stateEndpoint = normalizeCompatibleEndpointOrNull(runtimeCfg.endpoint);
  const envEndpoint = normalizeCompatibleEndpointOrNull(process.env.SUBCONSCIOUS_LLM_ENDPOINT);
  const endpoint = stateEndpoint || envEndpoint || defaultCompatibleEndpoint(provider);
  const endpointSource = stateEndpoint ? 'state' : (envEndpoint ? 'subconscious-env' : 'default');
  const stateKeyEnv = normalizeOptionalText(runtimeCfg.keyEnv, 128);
  const envKeyEnv = normalizeOptionalText(process.env.SUBCONSCIOUS_LLM_KEY_ENV, 128);
  const keyEnv = stateKeyEnv || envKeyEnv || 'SUBCONSCIOUS_LLM_KEY';
  const keyEnvSource = stateKeyEnv ? 'state' : (envKeyEnv ? 'subconscious-env' : 'default');
  const apiKey = normalizeOptionalText(process.env[keyEnv], 4096);
  const timeoutMs = normalizePositiveInt(runtimeCfg.timeoutMs, 8000);
  const maxTokens = normalizePositiveInt(runtimeCfg.maxTokens, 220);
  const temperatureRaw = Number.parseFloat(String(runtimeCfg.temperature ?? process.env.SUBCONSCIOUS_LLM_TEMPERATURE ?? '0.2').trim());
  const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : 0.2;
  const desiredEnabled = normalizeBoolean(runtimeCfg.enabled);
  const runtimeDesired = desiredEnabled !== false;
  const invokeUrl = normalizeOptionalText(runtimeMeta?.invokeUrl, 2048)
    || `${process.env.AGENT_CHAT_API || `http://127.0.0.1:${PORT}`}/api/subconscious/runtime/invoke`;
  const eventUrl = normalizeOptionalText(runtimeMeta?.eventUrl, 2048)
    || `${process.env.AGENT_CHAT_API || `http://127.0.0.1:${PORT}`}/api/subconscious/events`;
  let disabledReason = null;
  if (!agent.stateDir) disabledReason = 'missing agent stateDir';
  else if (!runtimeDesired) disabledReason = 'runtime disabled in subconscious contract';
  else if (!apiKey) disabledReason = `missing API key env ${keyEnv}`;

  const invocationConfigured = disabledReason === null;
  const generatedGuidance = (letta?.lastRuntimeGuidance && typeof letta.lastRuntimeGuidance === 'object') ? letta.lastRuntimeGuidance : null;
  const lastInvocation = (letta?.lastInvocation && typeof letta.lastInvocation === 'object') ? letta.lastInvocation : null;
  const manualGuidance = normalizeOptionalText(letta?.guidance, 6000) || '';
  const memoryState = resolveSubconsciousMemoryState(agentName, stateDir, runtimeMeta);
  const conversationState = resolveSubconsciousConversationState(agentName, stateDir, runtimeMeta);
  const memoryStore = memoryState.store || defaultSubconsciousMemoryStore(agentName);
  const conversationStore = conversationState.store || defaultSubconsciousConversationStore(agentName);
  const upstream = buildSubconsciousUpstreamContract(stateDir, workdir, runtimeMeta, letta, conversationState);
  const currentConversation = Array.isArray(conversationStore.sessions)
    ? conversationStore.sessions.find((row) => row.sessionId && row.sessionId === conversationStore.currentSessionId)
      || conversationStore.sessions[conversationStore.sessions.length - 1]
      || null
    : null;
  const memoryInfo = {
    classification: 'transitional',
    kind: normalizeOptionalText(memoryStore.kind, 128) || 'local-episodic-journal',
    path: memoryState.path,
    retrievalStrategy: normalizeOptionalText(memoryStore.retrievalStrategy, 128) || 'keyword-overlap-recency',
    entryCount: Array.isArray(memoryStore.episodes) ? memoryStore.episodes.length : 0,
    entryLimit: normalizePositiveInt(memoryStore.entryLimit, 80),
    retrievalLimit: normalizePositiveInt(memoryStore.retrievalLimit, 4),
    lastStoredAt: normalizeOptionalText(memoryStore.lastStoredAt, 128),
    lastStoredEpisodeId: normalizeOptionalText(memoryStore.lastStoredEpisodeId, 128),
    lastRetrievedAt: normalizeOptionalText(memoryStore.lastRetrievedAt, 128),
    lastRetrievedQuery: normalizeOptionalText(memoryStore.lastRetrievedQuery, 600),
    lastRetrievedIds: Array.isArray(memoryStore.lastRetrievedIds) ? memoryStore.lastRetrievedIds.slice(0, 12) : [],
  };
  const conversationContract = {
    classification: 'transitional',
    kind: conversationStore.kind || 'claude-jsonl-session-journal',
    path: conversationState.path,
    sessionCount: Array.isArray(conversationStore.sessions) ? conversationStore.sessions.length : 0,
    sessionLimit: normalizePositiveInt(conversationStore.sessionLimit, 24),
    currentSessionId: conversationStore.currentSessionId || null,
    currentTranscriptPath: conversationStore.currentTranscriptPath || null,
    lastSyncedAt: conversationStore.lastSyncedAt || null,
    updatedAt: conversationStore.updatedAt || null,
    current: currentConversation
      ? {
          sessionId: currentConversation.sessionId || null,
          transcriptPath: currentConversation.transcriptPath || null,
          transcriptExists: currentConversation.transcriptExists === true,
          transcriptLineCount: currentConversation.transcriptLineCount || 0,
          eventCount: currentConversation.eventCount || 0,
          userTurnCount: currentConversation.userTurnCount || 0,
          assistantTurnCount: currentConversation.assistantTurnCount || 0,
          startedAt: currentConversation.startedAt || null,
          updatedAt: currentConversation.updatedAt || null,
          lastEventAt: currentConversation.lastEventAt || null,
          lastHook: currentConversation.lastHook || null,
          lastToolName: currentConversation.lastToolName || null,
          lastRuntimeAt: currentConversation.lastRuntimeAt || null,
          lastRuntimeProvider: currentConversation.lastRuntimeProvider || null,
          lastRuntimeModel: currentConversation.lastRuntimeModel || null,
          latestUserText: currentConversation.latestUserText || '',
          latestAssistantText: currentConversation.latestAssistantText || '',
          recentTurns: Array.isArray(currentConversation.recentTurns) ? currentConversation.recentTurns : [],
        }
      : null,
  };
  const runtimeContract = {
    classification: 'transitional',
    desiredEnabled: runtimeDesired,
    invocationConfigured,
    disabledReason,
    provider,
    model,
    endpoint,
    keyEnv,
    configFamily: 'SUBCONSCIOUS_LLM_*',
    configSources: {
      provider: providerSource,
      model: modelSource,
      endpoint: endpointSource,
      keyEnv: keyEnvSource,
    },
    keyAvailable: Boolean(apiKey),
    timeoutMs,
    maxTokens,
    temperature,
    allowedHooks: Array.isArray(runtimeCfg.allowedHooks) && runtimeCfg.allowedHooks.length
      ? runtimeCfg.allowedHooks
      : [...SUBCONSCIOUS_RUNTIME_HOOKS],
    hookRuntimeInstalled: Boolean(pluginRoot && existsSync(path.join(pluginRoot, 'scripts', 'hook-entry.mjs'))),
    hookBindingsInstalled: installedHooks.length === 4,
    installedHooks,
    settingsPath: settingsPath || null,
    pluginRoot: pluginRoot || null,
    eventSinkConfigured: Boolean(eventUrl),
    eventUrl: eventUrl || null,
    invokeUrl,
    runtimeMetaPath: runtimeMetaPath || null,
    updatedAt: normalizeOptionalText(runtimeMeta?.updatedAt, 128),
  };
  const providerContract = {
    provider: normalizeOptionalText(letta?.provider, 128) || 'letta',
    mode: normalizeOptionalText(letta?.mode, 128) || 'claude-subconscious',
    lettaAgentId: normalizeOptionalText(letta?.agentId || letta?.lettaAgentId, 256),
    resolutionSource: normalizeOptionalText(letta?.resolutionSource, 64),
    lettaStateFile: lettaPath || null,
    backendRuntimeConfigured: invocationConfigured,
    modelConfigConfigured: Boolean(model && endpoint),
    memoryStoreConfigured: Boolean(memoryInfo.path && memoryInfo.kind === 'local-episodic-journal'),
    invocationConfigured,
    upstreamBootstrapConfigured: upstream.bootstrap.status === 'configured',
    upstreamSessionConfigured: upstream.session?.established === true,
  };
  const authority = buildSubconsciousAuthoritySummary({
    enabled: agent.subconsciousEnabled === true,
    upstream,
    lettaAgentId: providerContract.lettaAgentId,
  });
  const fallback = buildSubconsciousFallbackSummary(manualGuidance);
  const transitional = buildSubconsciousTransitionalSummary(runtimeContract, memoryInfo, conversationContract);
  const missingBackendPieces = [];
  if (!invocationConfigured) {
    missingBackendPieces.push(disabledReason
      ? `Runtime invocation unavailable: ${disabledReason}.`
      : 'Runtime invocation is not configured.');
  }
  if (!upstream.bootstrap.apiKeyConfigured) {
    missingBackendPieces.push('Direct upstream Letta bootstrap is wired but blocked by missing LETTA_API_KEY in the running process.');
  }
  if (upstream.preTool?.status && upstream.preTool.status !== 'not-run') {
    missingBackendPieces.push(
      'SessionStart lifecycle, UserPromptSubmit prompt send, PreToolUse read-and-inject, and Stop transcript/send are cut over to upstream Letta; local runtime guidance and local journals remain transitional.'
    );
  } else if (upstream.userPrompt?.status && upstream.userPrompt.status !== 'not-run') {
    missingBackendPieces.push(
      'SessionStart lifecycle, UserPromptSubmit prompt send, and Stop transcript/send are cut over to upstream Letta; PreToolUse still has not recorded an upstream-backed result yet.'
    );
  } else if (upstream.session?.established === true) {
    missingBackendPieces.push(
      'SessionStart lifecycle and the Stop transcript/send path are cut over to upstream Letta, and an explicit UserPromptSubmit upstream send path is wired, but no prompt-send state has been recorded yet; PreToolUse has not been exercised through the upstream-backed path yet.'
    );
  } else {
    missingBackendPieces.push(
      'Explicit upstream SessionStart, UserPromptSubmit, PreToolUse, and Stop routes are wired, but the broader hook flow still carries local transitional runtime and journal paths.'
    );
  }
  missingBackendPieces.push(
    'Full Letta-style semantic or relational memory is not implemented; current memory is a local episodic journal with keyword-overlap retrieval only.'
  );
  missingBackendPieces.push(
    'Conversation bookkeeping is transcript-backed session state, not full multi-session semantic orchestration or relational memory.'
  );
  if (upstream.session?.notify?.status === 'blocked') {
    missingBackendPieces.push(
      `Upstream SessionStart notify/send is separately blocked by Letta: ${upstream.session.notify.blockedReason || 'unknown constraint'}.`
    );
  }
  if (upstream.stop?.status === 'blocked') {
    missingBackendPieces.push(
      `Upstream Stop transcript/send is separately blocked by Letta: ${upstream.stop.blockedReason || 'unknown constraint'}.`
    );
  }
  if (upstream.userPrompt?.status === 'blocked') {
    missingBackendPieces.push(
      `Upstream UserPromptSubmit send is separately blocked by Letta: ${upstream.userPrompt.blockedReason || 'unknown constraint'}.`
    );
  }
  if (upstream.preTool?.status === 'blocked') {
    missingBackendPieces.push(
      `Upstream PreToolUse read/inject is separately blocked: ${upstream.preTool.blockedReason || 'unknown constraint'}.`
    );
  }

  return {
    agentName,
    agent,
    stateDir,
    lettaPath,
    runtimeMetaPath,
    letta,
    runtimeMeta,
    settingsPath,
    pluginRoot,
    installedHooks,
    memoryState,
    conversationState,
    contract: {
      ok: true,
      agent: agentName,
      stage: upstream.preTool?.status && upstream.preTool.status !== 'not-run'
        ? 'upstream-pretool-lifecycle'
        : (upstream.userPrompt?.status && upstream.userPrompt.status !== 'not-run'
        ? 'upstream-user-prompt-lifecycle'
        : (upstream.session?.established === true
          ? 'upstream-session-lifecycle'
          : (invocationConfigured ? 'conversation-aware-runtime' : 'scaffold'))),
      writable: Boolean(stateDir),
      enabled: agent.subconsciousEnabled === true,
      authority,
      fallback,
      manualGuidance: {
        classification: 'fallback',
        configured: manualGuidance.length > 0,
        source: manualGuidance ? 'manual-state-file' : 'none',
        role: 'fallback',
        text: manualGuidance,
        preview: manualGuidance.length > 240 ? `${manualGuidance.slice(0, 240)}...` : manualGuidance,
        updatedAt: normalizeOptionalText(letta?.updatedAt, 128),
      },
      runtime: runtimeContract,
      transitional,
      provider: providerContract,
      upstream,
      memory: memoryInfo,
      conversation: conversationContract,
      lastInvocation: lastInvocation || null,
      lastRuntimeGuidance: generatedGuidance
        ? {
            ...generatedGuidance,
            preview: normalizeOptionalText(generatedGuidance.preview, 600)
              || (normalizeOptionalText(generatedGuidance.text, 600) || null),
            text: normalizeOptionalText(generatedGuidance.text, 4000) || '',
          }
        : null,
      missingBackendPieces,
    },
    runtimeConfig: {
      provider,
      model,
      endpoint,
      apiKey,
      keyEnv,
      timeoutMs,
      maxTokens,
      temperature,
      allowedHooks: Array.isArray(runtimeCfg.allowedHooks) && runtimeCfg.allowedHooks.length
        ? runtimeCfg.allowedHooks
        : [...SUBCONSCIOUS_RUNTIME_HOOKS],
      invocationConfigured,
      disabledReason,
    },
  };
}

function buildSubconsciousInvokePrompt(agentName, payload, state, recentEvents, retrievedMemories = null) {
  const recent = (Array.isArray(recentEvents) ? recentEvents.slice(-6) : []).map((ev) => ({
    ts: ev?.ts || null,
    hook: ev?.hook || ev?.hookEventName || null,
    summary: ev?.summary || null,
    guidanceSource: ev?.guidanceSource || null,
    runtimeInvoked: ev?.runtimeInvoked === true,
  }));
  const memories = Array.isArray(retrievedMemories?.matches)
    ? retrievedMemories.matches.map((row) => ({
      id: row.id,
      at: row.at,
      hook: row.hook,
      summary: row.summary,
      guidancePreview: row.guidancePreview,
      overlapKeywords: row.overlapKeywords,
    }))
    : [];
  const conversation = state?.contract?.conversation?.current && typeof state.contract.conversation.current === 'object'
    ? state.contract.conversation.current
    : null;
  return [
    'You are the agentchat subconscious runtime for one agent.',
    'Generate a short, concrete internal guidance snippet for the next Claude hook step.',
    'Do not claim long-term memory or external facts you do not have.',
    'Base your output only on the supplied hook payload, recent subconscious events, retrieved local episodic memories, and optional human manual guidance.',
    'Return JSON only: {"guidance":"...", "summary":"..."}',
    'If no useful guidance should be injected, return {"guidance":"","summary":"no guidance"}',
    '',
    `Agent: ${agentName}`,
    `Hook: ${payload.hook || payload.hookEventName || 'Unknown'}`,
    `Prompt preview: ${payload.promptPreview || '-'}`,
    `Tool: ${payload.toolName || '-'}`,
    `Manual guidance: ${state.contract.manualGuidance.text || '-'}`,
    `Conversation session: ${conversation?.sessionId || payload?.sessionId || '-'}`,
    `Conversation transcript: ${conversation?.transcriptPath || payload?.transcriptPath || '-'}`,
    `Conversation turn counts: user=${conversation?.userTurnCount ?? 0} assistant=${conversation?.assistantTurnCount ?? 0}`,
    `Recent conversation turns: ${JSON.stringify(Array.isArray(conversation?.recentTurns) ? conversation.recentTurns : [])}`,
    `Recent events: ${JSON.stringify(recent)}`,
    `Retrieved local episodic memories: ${JSON.stringify(memories)}`,
  ].join('\n');
}

function parseSubconsciousInvokeResponse(raw) {
  const cleaned = normalizeJsonText(raw);
  const parsed = JSON.parse(cleaned);
  return {
    guidance: normalizeOptionalText(parsed?.guidance, 4000) || '',
    summary: normalizeOptionalText(parsed?.summary, 600) || 'runtime guidance',
  };
}

async function callSubconsciousRuntimeLlm(state, prompt) {
  const body = {
    model: state.runtimeConfig.model,
    temperature: state.runtimeConfig.temperature,
    max_tokens: state.runtimeConfig.maxTokens,
    messages: [
      { role: 'system', content: 'You are a strict JSON generator. Output only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.runtimeConfig.timeoutMs);
  try {
    const resp = await fetch(state.runtimeConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.runtimeConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`llm http ${resp.status}: ${errText.slice(0, 220)}`);
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('llm response missing choices[0].message.content');
    return { content, usage: json?.usage || null };
  } finally {
    clearTimeout(timer);
  }
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

function getBearerToken(req) {
  const raw = typeof req?.headers?.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasApiTokenAccess(req) {
  const expectedToken = normalizeOptionalText(process.env.API_TOKEN, 512);
  if (!expectedToken) return false;
  return getBearerToken(req) === expectedToken;
}

function authorizeSubconsciousEventIngest(req) {
  if (isLocalRequest(req)) {
    return { ok: true, mode: 'local' };
  }
  const expectedToken = normalizeOptionalText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (!expectedToken) {
    return {
      ok: false,
      status: 403,
      error: 'subconscious event ingest is local-only unless AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN is configured',
      mode: 'local-only',
    };
  }
  const providedToken = getBearerToken(req);
  if (providedToken === expectedToken) {
    return { ok: true, mode: 'token' };
  }
  return {
    ok: false,
    status: 401,
    error: 'invalid subconscious event token',
    mode: 'token-required',
  };
}

function canAccessPrivilegedSubconsciousDetail(req) {
  return isLocalRequest(req) || hasApiTokenAccess(req);
}

function redactPathLikeText(value, maxLen = 1200) {
  const text = normalizeOptionalText(value, maxLen);
  if (!text) return null;
  return text.replace(/(^|[\s(])((?:\/[^/\s)]+)+\/?[^)\s]*)/g, '$1[path removed]');
}

function cloneJsonValue(value) {
  if (value === null || value === undefined) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function buildPersistedUpstreamRecord(kind, record) {
  const safe = cloneJsonValue(record);
  if (!safe || typeof safe !== 'object') return {};

  delete safe.checkedAt;

  if (kind === 'session') {
    delete safe.messageSentAt;
    if (safe.notify && typeof safe.notify === 'object') {
      delete safe.notify.attemptedAt;
      delete safe.notify.messageSentAt;
    }
    return safe;
  }

  if (kind === 'userPrompt') {
    delete safe.attemptedAt;
    delete safe.messageSentAt;
    delete safe.transcriptLineCount;
    delete safe.lastProcessedIndexBefore;
    return safe;
  }

  if (kind === 'preTool') {
    delete safe.attemptedAt;
    delete safe.injectedAt;
    delete safe.newMessageCount;
    delete safe.changedBlockCount;
    delete safe.lastSeenMessageIdBefore;
    delete safe.toolName;
    return safe;
  }

  if (kind === 'stop') {
    delete safe.attemptedAt;
    delete safe.messageSentAt;
    delete safe.transcriptMessageCount;
    delete safe.newMessageCount;
    delete safe.lastProcessedIndexBefore;
    return safe;
  }

  return safe;
}

function buildPersistedUpstreamState(upstream) {
  const safe = cloneJsonValue(upstream);
  if (!safe || typeof safe !== 'object') return {};

  delete safe.checkedAt;
  if (safe.session && typeof safe.session === 'object') safe.session = buildPersistedUpstreamRecord('session', safe.session);
  if (safe.userPrompt && typeof safe.userPrompt === 'object') safe.userPrompt = buildPersistedUpstreamRecord('userPrompt', safe.userPrompt);
  if (safe.preTool && typeof safe.preTool === 'object') safe.preTool = buildPersistedUpstreamRecord('preTool', safe.preTool);
  if (safe.stop && typeof safe.stop === 'object') safe.stop = buildPersistedUpstreamRecord('stop', safe.stop);
  return safe;
}

function buildOperationalSubconsciousContract(contract) {
  const safe = cloneJsonValue(contract);
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
      delete safe.upstream.bootstrap.checkedAt;
      if (safe.upstream.bootstrap.blockedReason) {
        safe.upstream.bootstrap.blockedReason = redactPathLikeText(safe.upstream.bootstrap.blockedReason, 1200);
      }
    }
    if (safe.upstream.session && typeof safe.upstream.session === 'object') {
      delete safe.upstream.session.sessionStateFile;
      delete safe.upstream.session.cwd;
      delete safe.upstream.session.checkedAt;
      delete safe.upstream.session.messageSentAt;
      if (safe.upstream.session.blockedReason) {
        safe.upstream.session.blockedReason = redactPathLikeText(safe.upstream.session.blockedReason, 1200);
      }
      if (safe.upstream.session.notify && typeof safe.upstream.session.notify === 'object') {
        delete safe.upstream.session.notify.attemptedAt;
        delete safe.upstream.session.notify.messageSentAt;
        if (safe.upstream.session.notify.blockedReason) {
          safe.upstream.session.notify.blockedReason = redactPathLikeText(safe.upstream.session.notify.blockedReason, 1200);
        }
      }
    }
    if (safe.upstream.userPrompt && typeof safe.upstream.userPrompt === 'object') {
      delete safe.upstream.userPrompt.transcriptPath;
      delete safe.upstream.userPrompt.transcriptExists;
      delete safe.upstream.userPrompt.syncStateFile;
      delete safe.upstream.userPrompt.scriptPath;
      delete safe.upstream.userPrompt.checkedAt;
      delete safe.upstream.userPrompt.attemptedAt;
      delete safe.upstream.userPrompt.messageSentAt;
      delete safe.upstream.userPrompt.transcriptLineCount;
      delete safe.upstream.userPrompt.lastProcessedIndexBefore;
      if (safe.upstream.userPrompt.blockedReason) {
        safe.upstream.userPrompt.blockedReason = redactPathLikeText(safe.upstream.userPrompt.blockedReason, 1200);
      }
    }
    if (safe.upstream.preTool && typeof safe.upstream.preTool === 'object') {
      delete safe.upstream.preTool.syncStateFile;
      delete safe.upstream.preTool.scriptPath;
      delete safe.upstream.preTool.checkedAt;
      delete safe.upstream.preTool.attemptedAt;
      delete safe.upstream.preTool.injectedAt;
      delete safe.upstream.preTool.newMessageCount;
      delete safe.upstream.preTool.changedBlockCount;
      delete safe.upstream.preTool.lastSeenMessageIdBefore;
      delete safe.upstream.preTool.toolName;
      if (safe.upstream.preTool.blockedReason) {
        safe.upstream.preTool.blockedReason = redactPathLikeText(safe.upstream.preTool.blockedReason, 1200);
      }
    }
    if (safe.upstream.stop && typeof safe.upstream.stop === 'object') {
      delete safe.upstream.stop.transcriptPath;
      delete safe.upstream.stop.transcriptExists;
      delete safe.upstream.stop.syncStateFile;
      delete safe.upstream.stop.scriptPath;
      delete safe.upstream.stop.checkedAt;
      delete safe.upstream.stop.attemptedAt;
      delete safe.upstream.stop.messageSentAt;
      delete safe.upstream.stop.transcriptMessageCount;
      delete safe.upstream.stop.newMessageCount;
      delete safe.upstream.stop.lastProcessedIndexBefore;
      if (safe.upstream.stop.blockedReason) {
        safe.upstream.stop.blockedReason = redactPathLikeText(safe.upstream.stop.blockedReason, 1200);
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

  if (safe.manualGuidance && typeof safe.manualGuidance === 'object') {
    delete safe.manualGuidance.text;
    delete safe.manualGuidance.preview;
  }

  if (Object.prototype.hasOwnProperty.call(safe, 'lastRuntimeGuidance')) delete safe.lastRuntimeGuidance;
  if (Object.prototype.hasOwnProperty.call(safe, 'lastInvocation')) delete safe.lastInvocation;

  if (Array.isArray(safe.missingBackendPieces)) {
    safe.missingBackendPieces = safe.missingBackendPieces.map((item) => redactPathLikeText(item, 1200) || item);
  }

  return safe;
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
const localTmuxMissingState = new Map(); // agent -> { since:number, alerted:boolean }
const localCompactState = new Map(); // agent -> marker
const localRuntimeSignalDigest = new Map(); // agent -> digest of blocked/mcp/workspace
const SYSTEM_INFO_LOG = dataPath('system-info.jsonl');
const SUBCONSCIOUS_EVENT_LOG = dataPath('subconscious-events.jsonl');
const subconsciousEventsByAgent = new Map(); // agent -> event[]
const unexpectedOfflineAlertAt = new Map(); // key(agent:reason) -> ts
const compactRuntimeAlertAt = new Map(); // key(agent:marker:mode) -> ts
const swapAlertState = {
  active: false,
  lastPct: 0,
  lastAlertAt: 0,
};
const scopePressureState = new Map(); // agent -> { high:bool, lastAlertAt:number }
let localMcpSessionCacheAt = 0;
let localMcpSessionCache = new Set();
const agentsBeforeNormalization = JSON.stringify(agents);

for (const ev of loadJsonlTailSync(SUBCONSCIOUS_EVENT_LOG, SUBCONSCIOUS_EVENT_HISTORY_LIMIT)) {
  const agent = normalizeLooseAgentName(ev?.agent);
  if (!agent) continue;
  const row = {
    ...ev,
    agent,
    ts: normalizeEventTs(ev?.ts),
  };
  const list = subconsciousEventsByAgent.get(agent) || [];
  list.push(row);
  if (list.length > SUBCONSCIOUS_EVENT_AGENT_LIMIT) {
    subconsciousEventsByAgent.set(agent, list.slice(list.length - SUBCONSCIOUS_EVENT_AGENT_LIMIT));
  } else {
    subconsciousEventsByAgent.set(agent, list);
  }
}

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
  agent.agentModelVersion = normalizeAgentModelVersion(agent.agentModelVersion) || null;
  agent.layoutVersion = normalizeLayoutVersion(agent.layoutVersion) || null;
  agent.agentId = normalizeAgentId(agent.agentId) || null;
  agent.homeDir = normalizeWorkspacePath(agent.homeDir) || null;
  agent.workdir = normalizeWorkspacePath(agent.workdir) || null;
  agent.stateDir = normalizeWorkspacePath(agent.stateDir) || null;
  agent.subconsciousEnabled = agent.subconsciousEnabled === true
    ? true
    : (agent.subconsciousEnabled === false ? false : null);
  agent.managedProjects = normalizeManagedProjects(agent.managedProjects);
  agent.human = normalizeHumanMeta(agent.human);
  agent.task = normalizeAgentTask(agent.task, agent.name);
  agent.runtimeProfile = normalizeRuntimeProfile(agent.runtimeProfile);
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
      maintenance: SERVER_MAINTENANCE_IDS.has(serverId),
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
  if (!Object.prototype.hasOwnProperty.call(server, 'maintenance')) {
    server.maintenance = SERVER_MAINTENANCE_IDS.has(serverId);
  } else {
    server.maintenance = server.maintenance === true;
  }
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
  runtime.inboxGate = normalizeInboxGate(runtime.inboxGate);
  runtime.inboxReadAck = normalizeInboxReadAck(runtime.inboxReadAck);
  runtime.lastBlockedTail = (typeof runtime.lastBlockedTail === 'string') ? runtime.lastBlockedTail : '';
  runtime.lastBlockedCommand = (typeof runtime.lastBlockedCommand === 'string') ? runtime.lastBlockedCommand : '';
  runtime.lastBlockedServer = normalizeServer(runtime.lastBlockedServer);
  runtime.activeNow = runtime.activeNow === true;
  runtime.activeDurationSec = Number(runtime.activeDurationSec) || 0;
  runtime.idleDurationSec = Number(runtime.idleDurationSec) || 0;
  runtime.lastTmuxActivitySec = Number(runtime.lastTmuxActivitySec) || null;
  runtime.workspacePath = normalizeWorkspacePath(runtime.workspacePath);
  runtime.mcpPresent = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);
  runtime.mcpMissingSince = Number(runtime.mcpMissingSince) || null;
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
    agentModelVersion: normalizeAgentModelVersion(defaults.agentModelVersion) || null,
    layoutVersion: normalizeLayoutVersion(defaults.layoutVersion) || null,
    agentId: normalizeAgentId(defaults.agentId) || null,
    homeDir: normalizeWorkspacePath(defaults.homeDir) || null,
    workdir: normalizeWorkspacePath(defaults.workdir) || null,
    stateDir: normalizeWorkspacePath(defaults.stateDir) || null,
    subconsciousEnabled: defaults.subconsciousEnabled === true
      ? true
      : (defaults.subconsciousEnabled === false ? false : null),
    managedProjects: normalizeManagedProjects(defaults.managedProjects),
    human: normalizeHumanMeta(defaults.human),
    task: normalizeAgentTask(defaults.task, agentName),
    runtimeProfile: normalizeRuntimeProfile(defaults.runtimeProfile),
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
    || text.startsWith('agent-down')
    || text.startsWith('server-maintenance:');
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

const supervisorService = createSupervisorService({
  getAgents: () => Object.values(agents).filter(isAgentRecord).map(serializeAgent),
  getRuntime: (agentName) => ensureAgentRuntimeRecord(agentName),
  emitSystemInfo: (summary, full) => emitSystemInfo(summary, full),
  broadcastSSE,
});

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

function normalizeInboxGateReason(value) {
  const raw = (typeof value === 'string') ? value.trim() : '';
  if (raw === 'actionable_notification' || raw === 'merged_actionable_unread') return raw;
  return null;
}

function normalizeInboxGate(value) {
  if (!value || typeof value !== 'object') {
    return {
      requiresInboxCheck: false,
      sourceMsgId: null,
      raisedAt: null,
      reason: null,
    };
  }
  const sourceMsgId = (typeof value.sourceMsgId === 'string' && value.sourceMsgId.trim())
    ? value.sourceMsgId.trim()
    : null;
  const raisedAt = Number(value.raisedAt) || null;
  return {
    requiresInboxCheck: value.requiresInboxCheck === true,
    sourceMsgId,
    raisedAt,
    reason: normalizeInboxGateReason(value.reason),
  };
}

function normalizeInboxReadAck(value) {
  if (!value || typeof value !== 'object') {
    return {
      sourceMsgId: null,
      ackedAt: null,
    };
  }
  return {
    sourceMsgId: (typeof value.sourceMsgId === 'string' && value.sourceMsgId.trim())
      ? value.sourceMsgId.trim()
      : null,
    ackedAt: Number(value.ackedAt) || null,
  };
}

function buildInboxGateFromPushMeta(meta, deliveredAt) {
  if (!meta?.requiresInboxCheck) return normalizeInboxGate(null);
  const reason = meta.kind === 'merged_unread_actionable'
    ? 'merged_actionable_unread'
    : 'actionable_notification';
  return normalizeInboxGate({
    requiresInboxCheck: true,
    sourceMsgId: meta.sourceMsgId || null,
    raisedAt: Number(deliveredAt) || Date.now(),
    reason,
  });
}

function getPendingInboxGate(runtime) {
  const gate = normalizeInboxGate(runtime?.inboxGate);
  return gate.requiresInboxCheck ? gate : null;
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
      workspacePath: null,
      mcpPresent: null,
      mcpMissingSince: null,
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
      inboxGate: normalizeInboxGate(null),
      inboxReadAck: normalizeInboxReadAck(null),
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
    runtime.inboxGate = buildInboxGateFromPushMeta(meta, deliveredAt);
  }
  if (meta.requiresInboxCheck) {
    runtime.lastActionablePushAt = deliveredAt;
  }
  runtime.lastSeen = deliveredAt;
  runtime.updatedAt = deliveredAt;
  saveAgentRuntime();
}

function markAgentInboxChecked(agentName, details = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  const now = Date.now();
  runtime.lastInboxCheckAt = now;
  const ackSourceMsgId = (typeof details.sourceMsgId === 'string' && details.sourceMsgId.trim())
    ? details.sourceMsgId.trim()
    : null;
  const clearInboxGate = details.clearInboxGate === true;
  if (clearInboxGate) {
    runtime.inboxGate = normalizeInboxGate(null);
    runtime.inboxReadAck = normalizeInboxReadAck({
      sourceMsgId: ackSourceMsgId,
      ackedAt: now,
    });
  }
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

function setRuntimeMcpFields(runtime, payload = {}, now = Date.now()) {
  if (!runtime || typeof runtime !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'mcpPresent')) return false;
  if (payload.mcpPresent === undefined) return false;

  let changed = false;
  const mcpNow = payload.mcpPresent === true
    ? true
    : (payload.mcpPresent === false ? false : null);
  const prevMcp = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);

  if (prevMcp !== mcpNow) {
    runtime.mcpPresent = mcpNow;
    changed = true;
  }

  if (mcpNow === false) {
    const nextMissingSince = prevMcp === false
      ? (Number(runtime.mcpMissingSince) || now)
      : now;
    if (runtime.mcpMissingSince !== nextMissingSince) {
      runtime.mcpMissingSince = nextMissingSince;
      changed = true;
    }
  } else if (runtime.mcpMissingSince !== null) {
    runtime.mcpMissingSince = null;
    changed = true;
  }

  return changed;
}

function setRuntimeWorkspacePath(runtime, payload = {}) {
  if (!runtime || typeof runtime !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'workspacePath')) return false;
  const normalized = normalizeWorkspacePath(payload.workspacePath);
  if ((runtime.workspacePath || null) === (normalized || null)) return false;
  runtime.workspacePath = normalized;
  return true;
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

function getAgentInboxGateBlock(agentName) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return null;
  const gate = getPendingInboxGate(runtime);
  if (!gate) return null;
  return {
    agent: agentName,
    inboxGate: gate,
    error: 'inbox_check_required',
    hint: 'Call check_inbox() first to acknowledge the pending actionable notification before sending outbound progress or replies.',
  };
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
  const prevMcpPresent = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);
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
  if (setRuntimeWorkspacePath(runtime, payload)) changed = true;
  if (setRuntimeMcpFields(runtime, payload, now)) changed = true;
  if (changed) saveAgentRuntime();

  const mcpNow = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);
  const mcpBecameMissing = prevMcpPresent !== false && mcpNow === false;
  const mcpRecovered = prevMcpPresent === false && mcpNow === true;

  const agent = agents[agentName];
  let agentChanged = false;
  let shouldCatchup = false;
  if (isAgentRecord(agent) && agent.kind !== 'human') {
    const wasOnline = agent.online === true;
    const wasManualDown = agent.manualDown === true;

    if (mcpNow === false && !wasManualDown) {
      if (!agent.tmux || !String(agent.tmux).trim()) { agent.tmux = `${agentName}:0.0`; agentChanged = true; }
      if (agent.online !== false) { agent.online = false; agentChanged = true; }
      if (agent.offlineReason !== 'mcp-missing:auto') { agent.offlineReason = 'mcp-missing:auto'; agentChanged = true; }
      if (agent.manualDown !== false) { agent.manualDown = false; agentChanged = true; }
      if (agent.lastSeen !== now) { agent.lastSeen = now; agentChanged = true; }
    } else if (mcpNow === true) {
      const recoverable = agent.offlineReason === 'mcp-missing:auto' || agent.online !== true;
      if (!agent.tmux || !String(agent.tmux).trim()) { agent.tmux = `${agentName}:0.0`; agentChanged = true; }
      if (agent.online !== true) { agent.online = true; agentChanged = true; }
      if (agent.offlineReason === 'mcp-missing:auto') { agent.offlineReason = null; agentChanged = true; }
      if (agent.manualDown !== false) { agent.manualDown = false; agentChanged = true; }
      if (agent.lastSeen !== now) { agent.lastSeen = now; agentChanged = true; }
      if (!wasOnline && !wasManualDown && recoverable) shouldCatchup = true;
    }
  }
  if (agentChanged) saveAgents();
  if (shouldCatchup) notifyAgentCatchup(agentName, 'mcp-restored');

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

  if (mcpBecameMissing) {
    const full = [
      `Agent: ${agentName}`,
      `Server: ${normalizeServer(payload.server) || normalizeServer(agent?.server) || 'local'}`,
      'State: tmux session present but mcp-server.js process not detected.',
      'Offline reason set to: mcp-missing:auto',
    ].join('\n');
    emitSystemInfo(`Agent '${agentName}' missing MCP process`, full);
    broadcastSSE('agent_mcp_missing', {
      agent: agentName,
      missingSince: runtime.mcpMissingSince || now,
      server: normalizeServer(payload.server) || normalizeServer(agent?.server) || null,
    });
  } else if (mcpRecovered) {
    emitSystemInfo(`Agent '${agentName}' MCP process recovered`, `Agent '${agentName}' now has mcp-server.js running inside tmux.`);
    broadcastSSE('agent_mcp_recovered', {
      agent: agentName,
      recoveredAt: now,
      server: normalizeServer(payload.server) || normalizeServer(agent?.server) || null,
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
      maintenance: SERVER_MAINTENANCE_IDS.has(serverId),
    };
  }
  return servers[serverId];
}

function isServerInMaintenance(serverId, serverRecord = null) {
  const id = normalizeServer(serverId);
  if (!id) return false;
  const server = (serverRecord && typeof serverRecord === 'object') ? serverRecord : servers[id];
  if (server && typeof server.maintenance === 'boolean') return server.maintenance === true;
  return SERVER_MAINTENANCE_IDS.has(id);
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

function enforceServerMaintenanceOffline(serverId, server, now = Date.now()) {
  if (!server || typeof server !== 'object') return { serverChanged: false, agentsChanged: false };
  let serverChanged = false;
  const shouldTouchUpdatedAt = server.online !== false
    || !Array.isArray(server.sessions) || server.sessions.length !== 0
    || !Array.isArray(server.agents) || server.agents.length !== 0
    || (Number(server.agentCount) || 0) !== 0
    || server.relayInstanceId !== null
    || (Number(server.relayBootTs) || 0) !== 0
    || (Number(server.heartbeatAt) || 0) !== 0;
  const targetUpdatedAt = shouldTouchUpdatedAt ? now : (Number(server.updatedAt) || now);
  if ((Number(server.heartbeatAt) || 0) !== 0) { server.heartbeatAt = 0; serverChanged = true; }
  if (clearServerLiveState(server, targetUpdatedAt)) serverChanged = true;
  const agentsChanged = markAgentsOfflineForServer(serverId, `server-maintenance:${serverId}`, true);
  return { serverChanged, agentsChanged };
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
    if (isServerInMaintenance(serverId, server)) {
      const maintenance = enforceServerMaintenanceOffline(serverId, server, now);
      if (maintenance.serverChanged) serversChanged = true;
      if (maintenance.agentsChanged) agentsChanged = true;
      continue;
    }
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

function captureLocalPaneContent(tmuxTarget) {
  if (!tmuxTarget) return null;
  try {
    const raw = execSync(`tmux capture-pane -p -t ${JSON.stringify(tmuxTarget)} 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf-8',
    });
    return {
      text: raw,
      hash: createHash('md5').update(raw).digest('hex'),
    };
  } catch {
    return null;
  }
}

function captureLocalPaneCommand(tmuxTarget) {
  if (!tmuxTarget) return '';
  try {
    const raw = execSync(`tmux list-panes -t ${JSON.stringify(tmuxTarget)} -F "#{pane_current_command}" 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();
    return raw.split('\n')[0] || '';
  } catch {
    return '';
  }
}

function captureLocalPanePath(tmuxTarget) {
  if (!tmuxTarget) return null;
  try {
    const raw = execSync(`tmux list-panes -t ${JSON.stringify(tmuxTarget)} -F "#{pane_current_path}" 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();
    return normalizeWorkspacePath((raw.split('\n')[0] || '').trim());
  } catch {
    return null;
  }
}

function normalizeMcpPresence(value) {
  return value === true
    ? true
    : (value === false ? false : null);
}

function applyLocalRuntimeSignals(agentName, payload = {}) {
  const blocked = payload.blocked === true;
  const reason = blocked && typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : null;
  const workspacePath = normalizeWorkspacePath(payload.workspacePath);
  const mcpPresent = normalizeMcpPresence(payload.mcpPresent);
  const digest = JSON.stringify({
    blocked,
    reason,
    workspacePath: workspacePath || null,
    mcpPresent,
  });
  if (localRuntimeSignalDigest.get(agentName) === digest) return;
  localRuntimeSignalDigest.set(agentName, digest);
  applyAgentBlockedRuntime(agentName, {
    blocked,
    reason,
    tail: blocked && typeof payload.tail === 'string' ? payload.tail : '',
    command: typeof payload.command === 'string' ? payload.command : '',
    workspacePath,
    mcpPresent,
    server: 'local',
  });
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
  const nowMs = Date.now();
  let runtimeChanged = false;
  let agentsChanged = false;
  const pruneCandidates = new Set();
  const localRuntimeAgents = new Set();
  const mcpSessions = getLocalMcpSessionSet(true);

  for (const agent of Object.values(agents)) {
    if (!isAgentRecord(agent)) continue;
    const serverId = normalizeServer(agent.server);
    const isLocalAgent = !serverId || serverId === 'local' || serverId === LOCAL_SERVER_ID;
    if (!isLocalAgent) continue;
    localRuntimeAgents.add(agent.name);

    const manualDown = agent.manualDown === true;
    const configuredTmux = (typeof agent.tmux === 'string' && agent.tmux.trim()) ? agent.tmux.trim() : null;
    const tmuxTarget = configuredTmux || (manualDown ? null : `${agent.name}:0.0`);
    const runtime = ensureAgentRuntimeRecord(agent.name);
    if (!runtime) continue;
    if (!tmuxTarget) {
      localTmuxMissingState.delete(agent.name);
      localActivityState.delete(agent.name);
      localCompactState.delete(agent.name);
      applyLocalRuntimeSignals(agent.name, {
        blocked: false,
        reason: null,
        tail: '',
        command: '',
        workspacePath: null,
        mcpPresent: null,
      });
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
      continue;
    }

    const paneCapture = captureLocalPaneContent(tmuxTarget);
    if (!paneCapture?.hash) {
      const hasSession = localTmuxSessionExists(tmuxTarget);
      const paneCmd = captureLocalPaneCommand(tmuxTarget);
      const workspacePath = hasSession ? captureLocalPanePath(tmuxTarget) : null;
      const mcpPresent = hasSession ? mcpSessions.has(agent.name) : null;
      applyLocalRuntimeSignals(agent.name, {
        blocked: false,
        reason: null,
        tail: '',
        command: paneCmd,
        workspacePath,
        mcpPresent,
      });
      if (hasSession) {
        localTmuxMissingState.delete(agent.name);
      }
      localActivityState.delete(agent.name);
      localCompactState.delete(agent.name);
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
        let missing = localTmuxMissingState.get(agent.name);
        if (!missing) {
          missing = { since: nowMs, alerted: false };
          localTmuxMissingState.set(agent.name, missing);
        }
        const missingForMs = Math.max(0, nowMs - (Number(missing.since) || nowMs));
        const wasOnline = agent.online === true;
        const prevLastSeenMs = Number(agent.lastSeen) || 0;
        const seenAgeMs = prevLastSeenMs > 0 ? Math.max(0, nowMs - prevLastSeenMs) : 0;
        const recentEnough = prevLastSeenMs <= 0 || seenAgeMs <= AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS;
        const wasManualDown = manualDown;
        let transitioned = false;
        if (agent.online !== false) { agent.online = false; agentsChanged = true; transitioned = true; }
        if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; transitioned = true; }
        if (!wasManualDown && agent.offlineReason !== 'tmux-missing:auto') {
          agent.offlineReason = 'tmux-missing:auto';
          agentsChanged = true;
          transitioned = true;
        }
        if (transitioned) {
          agent.lastSeen = nowMs;
        }
        if (!wasManualDown
          && wasOnline
          && recentEnough
          && !missing.alerted
          && missingForMs >= AGENT_TMUX_MISSING_ALERT_GRACE_MS) {
          missing.alerted = true;
          localTmuxMissingState.set(agent.name, missing);
          if (agent.offlineReason === 'tmux-missing:auto') {
            maybeEmitUnexpectedOfflineAlert(agent.name, 'tmux-missing:auto', { server: 'local', detail: `tmux target ${tmuxTarget} not found` });
          }
        }
        if (isEphemeralAuditAgentName(agent.name)) pruneCandidates.add(agent.name);
      }
      continue;
    }
    const paneHash = paneCapture.hash;
    const paneCmd = captureLocalPaneCommand(tmuxTarget);
    const workspacePath = captureLocalPanePath(tmuxTarget);
    const blockedReason = detectLocalBlockedReason(paneCapture.text, paneCmd);
    const blocked = Boolean(blockedReason);
    applyLocalRuntimeSignals(agent.name, {
      blocked,
      reason: blockedReason,
      tail: blocked ? recentTailWindow(paneCapture.text, LOCAL_BLOCK_TAIL_LINES) : '',
      command: paneCmd,
      workspacePath,
      mcpPresent: mcpSessions.has(agent.name),
    });
    localTmuxMissingState.delete(agent.name);
    const compactSignal = detectAgentCompactSignal('', paneCapture.text);
    if (compactSignal) {
      const marker = normalizeCompactMarker(compactSignal.marker);
      const prevMarker = localCompactState.get(agent.name) || null;
      if (prevMarker !== marker) {
        emitRuntimeCompactEvent(agent.name, {
          mode: compactSignal.mode,
          marker,
          source: 'local-sweep',
          summary: marker.replace(/-/g, ' '),
        });
      }
      localCompactState.set(agent.name, marker);
    } else {
      localCompactState.delete(agent.name);
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
    const mcpMissing = runtime.mcpPresent === false;
    if ((!agent.tmux || !String(agent.tmux).trim()) && !manualDown) {
      agent.tmux = tmuxTarget;
      onlineChanged = true;
    }
    if (manualDown) {
      if (agent.online !== false) {
        agent.online = false;
        onlineChanged = true;
      }
    } else if (mcpMissing) {
      if (agent.online !== false) {
        agent.online = false;
        onlineChanged = true;
      }
      if (agent.offlineReason !== 'mcp-missing:auto') {
        agent.offlineReason = 'mcp-missing:auto';
        onlineChanged = true;
      }
    } else {
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
    }
    if (onlineChanged) {
      agent.lastSeen = Date.now();
      agentsChanged = true;
    }
  }

  if (runtimeChanged) saveAgentRuntime();
  if (agentsChanged) saveAgents();
  for (const name of [...localRuntimeSignalDigest.keys()]) {
    if (!localRuntimeAgents.has(name)) {
      localRuntimeSignalDigest.delete(name);
    }
  }
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

function scopeUnitFromCgroupPath(cgroupPath) {
  const text = String(cgroupPath || '').trim();
  if (!text) return null;
  const leaf = text.split('/').filter(Boolean).pop() || '';
  return leaf.endsWith('.scope') ? leaf : null;
}

function scopeUnitForPid(pid) {
  const n = Number.parseInt(pid, 10);
  if (!Number.isFinite(n) || n <= 1) return null;
  try {
    const raw = readFileSync(`/proc/${n}/cgroup`, 'utf-8');
    for (const line of String(raw || '').split('\n')) {
      if (!line) continue;
      const idx = line.indexOf(':');
      const idx2 = idx >= 0 ? line.indexOf(':', idx + 1) : -1;
      if (idx2 < 0) continue;
      const pathPart = line.slice(idx2 + 1).trim();
      const unit = scopeUnitFromCgroupPath(pathPart);
      if (unit) return unit;
    }
  } catch {
    return null;
  }
  return null;
}

function buildLocalPanePidMap() {
  const out = new Map();
  try {
    const raw = execSync('tmux list-panes -a -F "#{session_name} #{pane_pid}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (!raw) return out;
    for (const line of raw.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const session = line.slice(0, sp).trim();
      const panePid = Number.parseInt(line.slice(sp + 1).trim(), 10);
      if (!session || !Number.isFinite(panePid) || panePid <= 1) continue;
      if (!out.has(session)) out.set(session, panePid);
    }
  } catch {
    // best effort map
  }
  return out;
}

function parseSystemdMemoryValue(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'infinity' || text === 'max') return 0;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readAgentScopeMemory(agentName, panePidMap = null) {
  const agent = agents[agentName];
  const tmuxTarget = (typeof agent?.tmux === 'string' && agent.tmux.trim())
    ? agent.tmux.trim()
    : `${agentName}:0.0`;
  const sessionName = tmuxTarget.split(':', 1)[0].trim() || agentName;
  const panePid = (panePidMap instanceof Map) ? panePidMap.get(sessionName) : null;
  const unit = scopeUnitForPid(panePid) || scopeUnitForAgent(agentName);
  if (!unit) return null;
  try {
    const env = USER_RUNTIME_DIR && USER_DBUS_SESSION_BUS
      ? { ...process.env, XDG_RUNTIME_DIR: USER_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: USER_DBUS_SESSION_BUS }
      : process.env;
    const out = execSync(
      `systemctl --user show ${JSON.stringify(unit)} --property=ActiveState --property=MemoryCurrent --property=MemoryHigh --value --no-pager`,
      { encoding: 'utf-8', timeout: 3000, env }
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
    signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
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
  const panePidMap = buildLocalPanePidMap();
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
    const scope = readAgentScopeMemory(agentName, panePidMap);
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
    agentModelVersion: normalizeAgentModelVersion(agent.agentModelVersion) || null,
    layoutVersion: normalizeLayoutVersion(agent.layoutVersion) || null,
    agentId: normalizeAgentId(agent.agentId) || null,
    homeDir: normalizeWorkspacePath(agent.homeDir) || null,
    workdir: normalizeWorkspacePath(agent.workdir) || null,
    stateDir: normalizeWorkspacePath(agent.stateDir) || null,
    subconsciousEnabled: agent.subconsciousEnabled === true
      ? true
      : (agent.subconsciousEnabled === false ? false : null),
    managedProjects: normalizeManagedProjects(agent.managedProjects),
    human: normalizeHumanMeta(agent.human),
    task: normalizeAgentTask(agent.task, agent.name),
    runtimeProfile: normalizeRuntimeProfile(agent.runtimeProfile),
    activeNow: runtime?.activeNow === true,
    activeDurationSec: Number(runtime?.activeDurationSec) || 0,
    idleDurationSec: Number(runtime?.idleDurationSec) || 0,
    lastTmuxActivitySec: Number(runtime?.lastTmuxActivitySec) || null,
    workspacePath: runtime?.workspacePath || null,
    mcpPresent: runtime?.mcpPresent === true
      ? true
      : (runtime?.mcpPresent === false ? false : null),
    mcpMissingSince: Number(runtime?.mcpMissingSince) || null,
  };
}

function applyServerHeartbeat(serverId, payload = {}, sourceIp = null) {
  const now = Date.now();
  const server = ensureServerRecord(serverId);
  if (isServerInMaintenance(serverId, server)) {
    let serversChanged = false;
    let agentsChanged = false;
    const lastSeen = Number(server.lastSeen) || 0;
    if (!lastSeen || (now - lastSeen) >= SERVER_MAINTENANCE_LAST_SEEN_UPDATE_MS) {
      server.lastSeen = now;
      serversChanged = true;
    }
    const nextSourceIp = sourceIp || null;
    if (server.sourceIp !== nextSourceIp) {
      server.sourceIp = nextSourceIp;
      serversChanged = true;
    }
    const maintenance = enforceServerMaintenanceOffline(serverId, server, now);
    if (maintenance.serverChanged) serversChanged = true;
    if (maintenance.agentsChanged) agentsChanged = true;
    if (serversChanged) saveServers();
    if (agentsChanged) saveAgents();
    return { ok: true, leaseAccepted: true, leaseReason: 'maintenance', maintenance: true, ignored: true };
  }
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
    const runtime = ensureAgentRuntimeRecord(name);
    const mcpMissing = runtime?.mcpPresent === false && agent.manualDown !== true;
    const nextOnline = !mcpMissing;
    if (!wasAgentOnline && nextOnline) becameOnline.push(name);
    if (agent.online !== nextOnline) { agent.online = nextOnline; agentsChanged = true; }
    if (nextOnline) {
      if (agent.offlineReason !== null) { agent.offlineReason = null; agentsChanged = true; }
      if (agent.manualDown !== false) { agent.manualDown = false; agentsChanged = true; }
    } else if (agent.offlineReason !== 'mcp-missing:auto') {
      agent.offlineReason = 'mcp-missing:auto';
      agentsChanged = true;
    }
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
function collectLocalMcpSessions() {
  try {
    const paneOut = execSync('tmux list-panes -a -F "#{pane_tty} #{session_name}" 2>/dev/null', { timeout: 3000, encoding: 'utf-8' }).trim();
    if (!paneOut) return new Set();
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
    } catch { return new Set(); }
    const matched = new Set();
    for (const pid of pids) {
      try {
        const pts = execSync(`ps -o tty= -p ${pid} 2>/dev/null`, { timeout: 3000, encoding: 'utf-8' }).trim();
        const session = ptsMap[pts];
        if (session) matched.add(session);
      } catch { /* pid vanished, skip */ }
    }
    return matched;
  } catch { /* no tmux */ }
  return new Set();
}

function getLocalMcpSessionSet(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && (now - localMcpSessionCacheAt) <= LOCAL_MCP_SESSION_CACHE_TTL_MS) {
    return localMcpSessionCache;
  }
  localMcpSessionCache = collectLocalMcpSessions();
  localMcpSessionCacheAt = now;
  return localMcpSessionCache;
}

function agentHasMcp(agentName) {
  if (!agentName) return false;
  return getLocalMcpSessionSet(false).has(agentName);
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
  fetch(`${WEB_BASE_URL}/api/queue/agents/${encodeURIComponent(agentName)}/notifications`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
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
      ? ' FIRST ACTION: call check_inbox() now. Read ALL messages there before doing anything else. DO ALL JOBS before replying. After ALL WORK is done, send required replies.'
      : ' Read ALL messages first. DO ALL JOBS before replying. After ALL WORK is done, send required replies.';

    if (hasMcp) {
      notification = `[NOTIFICATION] FIRST ACTION: call check_inbox() now. You have ${unreadCount} unread messages${senderText}.${humanHint}${processHint}`;
    } else {
      notification = `[NOTIFICATION] You have ${unreadCount} unread messages${senderText}.${humanHint}${processHint}`;
    }
  } else {
    const isHuman = msg.type === 'human';
    const isGroup = !!msg.group;

    if (hasMcp) {
      const checkHint = `FIRST ACTION: call check_inbox() now. Use check_inbox() in agent-chat MCP for full context before acting.`;
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
      signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
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
const SUBCONSCIOUS_EVENT_TOKEN = normalizeOptionalText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
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
  const apiPath = typeof req.path === 'string' ? req.path : '';
  if (req.method === 'POST' && apiPath.endsWith('/subconscious/events') && SUBCONSCIOUS_EVENT_TOKEN && auth === `Bearer ${SUBCONSCIOUS_EVENT_TOKEN}`) {
    return next();
  }
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

// ── Supervisor audit ──────────────────────────────────────────────────
app.get('/api/supervisor/status', (_req, res) => {
  res.json(supervisorService.getStatus());
});

app.get('/api/supervisor/agents', (_req, res) => {
  res.json({
    status: supervisorService.getStatus(),
    agents: supervisorService.getAgentSummaries(),
  });
});

app.get('/api/supervisor/agents/:name', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
  const payload = supervisorService.getAgentDetail(agentName, limit);
  return res.json(payload);
});

app.get('/api/supervisor/control', (_req, res) => {
  return res.json(supervisorService.getControl());
});

app.post('/api/supervisor/control', (req, res) => {
  const body = req.body || {};
  const patch = {};
  let hasPatch = false;

  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }
    patch.enabled = body.enabled;
    hasPatch = true;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'allowedAgents')) {
    const raw = body.allowedAgents;
    if (raw !== null && !Array.isArray(raw)) {
      return res.status(400).json({ error: 'allowedAgents must be array or null' });
    }
    if (Array.isArray(raw)) {
      const normalized = [];
      const seen = new Set();
      for (const item of raw) {
        const name = normalizeAgentName(item);
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        normalized.push(name);
      }
      patch.allowedAgents = normalized;
    } else {
      patch.allowedAgents = null;
    }
    hasPatch = true;
  }

  if (!hasPatch) {
    return res.status(400).json({ error: 'no control fields provided' });
  }

  const result = supervisorService.updateControl(patch);
  if (!result || result.ok !== true) {
    return res.status(400).json({ error: result?.error || 'failed to update supervisor control' });
  }
  return res.json(result);
});

// ── Server heartbeats ─────────────────────────────────────────────────
app.post('/api/servers/heartbeat', (req, res) => {
  const serverId = normalizeServer(req.body?.server);
  if (!serverId) return res.status(400).json({ error: 'server required' });
  const heartbeatResult = applyServerHeartbeat(serverId, req.body || {}, req.ip || req.connection?.remoteAddress || null);
  refreshServerLiveness();
  const state = servers[serverId];
  const maintenance = isServerInMaintenance(serverId, state);
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
        maintenance,
      },
    });
  }
  return res.json({
    ok: true,
    maintenance,
    ignored: heartbeatResult?.ignored === true,
    server: {
      id: state.id,
      online: Boolean(state.online),
      lastSeen: state.lastSeen || null,
      updatedAt: state.updatedAt || null,
      agentCount: state.agentCount || 0,
      sourceIp: state.sourceIp || null,
      maintenance,
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
  const maintenance = isServerInMaintenance(serverId, server);
  const reason = maintenance ? `server-maintenance:${serverId}` : `server-offline:${serverId}`;
  if (markAgentsOfflineForServer(serverId, reason, true)) saveAgents();
  saveServers();
  if (wasOnline && !maintenance) {
    const detail = (typeof req.body?.reason === 'string' && req.body.reason.trim()) ? req.body.reason.trim() : 'offline';
    emitSystemInfo(`Remote server '${serverId}' offline`, `Server '${serverId}' reported offline (${detail}).`);
  }
  res.json({
    ok: true,
    server: {
      id: serverId,
      online: false,
      maintenance,
      lastSeen: server.lastSeen,
    },
  });
});

app.post('/api/servers/:id/maintenance', (req, res) => {
  const serverId = normalizeServer(req.params.id);
  if (!serverId) return res.status(400).json({ error: 'server required' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled boolean required' });
  }

  const server = ensureServerRecord(serverId);
  server.maintenance = enabled;
  let serversChanged = true;
  let agentsChanged = false;
  if (enabled) {
    const maintenance = enforceServerMaintenanceOffline(serverId, server, Date.now());
    if (maintenance.serverChanged) serversChanged = true;
    if (maintenance.agentsChanged) agentsChanged = true;
  } else {
    const now = Date.now();
    if ((Number(server.updatedAt) || 0) !== now) {
      server.updatedAt = now;
      serversChanged = true;
    }
  }

  if (serversChanged) saveServers();
  if (agentsChanged) saveAgents();
  refreshServerLiveness();

  const state = servers[serverId];
  const maintenance = isServerInMaintenance(serverId, state);
  return res.json({
    ok: true,
    server: {
      id: state.id,
      online: Boolean(state.online),
      maintenance,
      lastSeen: state.lastSeen || null,
      updatedAt: state.updatedAt || null,
      agentCount: state.agentCount || 0,
      sourceIp: state.sourceIp || null,
    },
  });
});

app.get('/api/servers', (_req, res) => {
  refreshServerLiveness();
  const rows = Object.values(servers)
    .map(s => ({
      id: s.id,
      online: Boolean(s.online),
      maintenance: isServerInMaintenance(s.id, s),
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
  const {
    name,
    role,
    tmux,
    type: agentType,
    identity,
    server,
    agentModelVersion,
    layoutVersion,
    agentId,
    homeDir,
    workdir,
    stateDir,
    subconsciousEnabled,
    managedProjects,
    human,
    task,
    runtimeProfile,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (task !== undefined && task !== null && !normalizeAgentTask(task, normalizeAgentName(name) || String(name || '').trim())) {
    return res.status(400).json({ error: 'invalid task payload' });
  }
  if (runtimeProfile !== undefined && runtimeProfile !== null && !normalizeRuntimeProfile(runtimeProfile)) {
    return res.status(400).json({ error: 'invalid runtimeProfile payload' });
  }
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
    agentModelVersion: normalizeAgentModelVersion(agentModelVersion)
      || normalizeAgentModelVersion(existing.agentModelVersion)
      || null,
    layoutVersion: normalizeLayoutVersion(layoutVersion)
      || normalizeLayoutVersion(existing.layoutVersion)
      || null,
    agentId: normalizeAgentId(agentId) || normalizeAgentId(existing.agentId) || null,
    homeDir: normalizeWorkspacePath(homeDir) || normalizeWorkspacePath(existing.homeDir) || null,
    workdir: normalizeWorkspacePath(workdir) || normalizeWorkspacePath(existing.workdir) || null,
    stateDir: normalizeWorkspacePath(stateDir) || normalizeWorkspacePath(existing.stateDir) || null,
    subconsciousEnabled: subconsciousEnabled === true
      ? true
      : (subconsciousEnabled === false
        ? false
        : (existing.subconsciousEnabled === true
          ? true
          : (existing.subconsciousEnabled === false ? false : null))),
    managedProjects: Array.isArray(managedProjects)
      ? normalizeManagedProjects(managedProjects)
      : normalizeManagedProjects(existing.managedProjects),
    human: human !== undefined
      ? normalizeHumanMeta(human)
      : normalizeHumanMeta(existing.human),
    task: task !== undefined
      ? normalizeAgentTask(task, agentName)
      : normalizeAgentTask(existing.task, agentName),
    runtimeProfile: runtimeProfile !== undefined
      ? normalizeRuntimeProfile(runtimeProfile)
      : normalizeRuntimeProfile(existing.runtimeProfile),
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
  const {
    role,
    identity,
    tmux,
    online,
    offlineReason,
    manualDown,
    agentModelVersion,
    layoutVersion,
    agentId,
    homeDir,
    workdir,
    stateDir,
    subconsciousEnabled,
    managedProjects,
    human,
    task,
    runtimeProfile,
  } = req.body;
  if (task !== undefined && task !== null && !normalizeAgentTask(task, agentName)) {
    return res.status(400).json({ error: 'invalid task payload' });
  }
  if (runtimeProfile !== undefined && runtimeProfile !== null && !normalizeRuntimeProfile(runtimeProfile)) {
    return res.status(400).json({ error: 'invalid runtimeProfile payload' });
  }
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
  if (agentModelVersion !== undefined) {
    agent.agentModelVersion = normalizeAgentModelVersion(agentModelVersion) || null;
  }
  if (layoutVersion !== undefined) {
    agent.layoutVersion = normalizeLayoutVersion(layoutVersion) || null;
  }
  if (agentId !== undefined) {
    agent.agentId = normalizeAgentId(agentId) || null;
  }
  if (homeDir !== undefined) {
    agent.homeDir = normalizeWorkspacePath(homeDir) || null;
  }
  if (workdir !== undefined) {
    agent.workdir = normalizeWorkspacePath(workdir) || null;
  }
  if (stateDir !== undefined) {
    agent.stateDir = normalizeWorkspacePath(stateDir) || null;
  }
  if (subconsciousEnabled !== undefined) {
    agent.subconsciousEnabled = subconsciousEnabled === true
      ? true
      : (subconsciousEnabled === false ? false : null);
  }
  if (managedProjects !== undefined) {
    agent.managedProjects = normalizeManagedProjects(managedProjects);
  }
  if (human !== undefined) {
    agent.human = normalizeHumanMeta(human);
  }
  if (task !== undefined) {
    agent.task = normalizeAgentTask(task, agentName);
  }
  if (runtimeProfile !== undefined) {
    agent.runtimeProfile = normalizeRuntimeProfile(runtimeProfile);
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
  const activeNow = req.body?.activeNow === true ? true : (req.body?.activeNow === false ? false : null);
  const activeDurationSec = req.body?.activeDurationSec;
  const idleDurationSec = req.body?.idleDurationSec;
  const lastTmuxActivitySec = req.body?.lastTmuxActivitySec;
  const workspacePath = Object.prototype.hasOwnProperty.call(req.body || {}, 'workspacePath')
    ? req.body.workspacePath
    : undefined;
  const mcpPresent = Object.prototype.hasOwnProperty.call(req.body || {}, 'mcpPresent')
    ? (req.body.mcpPresent === true ? true : (req.body.mcpPresent === false ? false : null))
    : undefined;

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
    activeNow,
    activeDurationSec,
    idleDurationSec,
    lastTmuxActivitySec,
    workspacePath,
    mcpPresent,
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
      workspacePath: runtime.workspacePath || null,
      mcpPresent: runtime.mcpPresent === true
        ? true
        : (runtime.mcpPresent === false ? false : null),
      mcpMissingSince: Number(runtime.mcpMissingSince) || null,
      updatedAt: runtime.updatedAt || Date.now(),
    },
  });
});

app.post('/api/runtime/compact', (req, res) => {
  const agentName = normalizeAgentName(req.body?.agent);
  if (!agentName) return res.status(400).json({ error: 'agent required' });

  const agent = agents[agentName];
  if (!isAgentRecord(agent)) {
    return res.json({ ok: true, ignored: 'agent-not-found', agent: agentName });
  }

  const result = emitRuntimeCompactEvent(agentName, {
    mode: req.body?.mode,
    marker: req.body?.marker,
    source: req.body?.source,
    summary: req.body?.summary,
  });
  res.json(result);
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

app.post('/api/subconscious/events', (req, res) => {
  const authz = authorizeSubconsciousEventIngest(req);
  if (!authz.ok) {
    return res.status(authz.status).json({
      error: authz.error,
      ingestBoundary: authz.mode,
    });
  }
  const body = req.body || {};
  const event = buildSubconsciousEvent({
    ...body,
    hookEventName: body.hookEventName ?? body.hook_event_name,
    sessionId: body.sessionId ?? body.session_id,
    transcriptPath: body.transcriptPath ?? body.transcript_path,
    toolName: body.toolName ?? body.tool_name,
    promptPreview: body.promptPreview ?? body.prompt_preview,
    lettaAgentId: body.lettaAgentId ?? body.letta_agent_id,
    lettaStateFile: body.lettaStateFile ?? body.letta_state_file,
    guidancePresent: body.guidancePresent ?? body.guidance_present,
    guidanceConfigured: body.guidanceConfigured ?? body.guidance_configured,
    guidanceInjected: body.guidanceInjected ?? body.guidance_injected,
    guidanceSource: body.guidanceSource ?? body.guidance_source,
    guidancePreview: body.guidancePreview ?? body.guidance_preview,
    runtimeInvoked: body.runtimeInvoked ?? body.runtime_invoked,
    runtimeProvider: body.runtimeProvider ?? body.runtime_provider,
    runtimeModel: body.runtimeModel ?? body.runtime_model,
    runtimeLatencyMs: body.runtimeLatencyMs ?? body.runtime_latency_ms,
    runtimeError: body.runtimeError ?? body.runtime_error,
    upstreamUserPromptAttempted: body.upstreamUserPromptAttempted ?? body.upstream_user_prompt_attempted,
    upstreamUserPromptStatus: body.upstreamUserPromptStatus ?? body.upstream_user_prompt_status,
    upstreamUserPromptBlockedReason: body.upstreamUserPromptBlockedReason ?? body.upstream_user_prompt_blocked_reason,
    upstreamUserPromptMessageSent: body.upstreamUserPromptMessageSent ?? body.upstream_user_prompt_message_sent,
    upstreamUserPromptConversationId: body.upstreamUserPromptConversationId ?? body.upstream_user_prompt_conversation_id,
    upstreamUserPromptTranscriptPath: body.upstreamUserPromptTranscriptPath ?? body.upstream_user_prompt_transcript_path,
    upstreamUserPromptSyncStateFile: body.upstreamUserPromptSyncStateFile ?? body.upstream_user_prompt_sync_state_file,
    upstreamUserPromptScriptPath: body.upstreamUserPromptScriptPath ?? body.upstream_user_prompt_script_path,
    upstreamUserPromptTranscriptLineCount: body.upstreamUserPromptTranscriptLineCount ?? body.upstream_user_prompt_transcript_line_count,
    upstreamUserPromptLastProcessedIndexBefore: body.upstreamUserPromptLastProcessedIndexBefore ?? body.upstream_user_prompt_last_processed_index_before,
    upstreamUserPromptLastProcessedIndexAfter: body.upstreamUserPromptLastProcessedIndexAfter ?? body.upstream_user_prompt_last_processed_index_after,
    upstreamPreToolAttempted: body.upstreamPreToolAttempted ?? body.upstream_pre_tool_attempted,
    upstreamPreToolStatus: body.upstreamPreToolStatus ?? body.upstream_pre_tool_status,
    upstreamPreToolBlockedReason: body.upstreamPreToolBlockedReason ?? body.upstream_pre_tool_blocked_reason,
    upstreamPreToolInjected: body.upstreamPreToolInjected ?? body.upstream_pre_tool_injected,
    upstreamPreToolConversationId: body.upstreamPreToolConversationId ?? body.upstream_pre_tool_conversation_id,
    upstreamPreToolSyncStateFile: body.upstreamPreToolSyncStateFile ?? body.upstream_pre_tool_sync_state_file,
    upstreamPreToolScriptPath: body.upstreamPreToolScriptPath ?? body.upstream_pre_tool_script_path,
    upstreamPreToolNewMessageCount: body.upstreamPreToolNewMessageCount ?? body.upstream_pre_tool_new_message_count,
    upstreamPreToolChangedBlockCount: body.upstreamPreToolChangedBlockCount ?? body.upstream_pre_tool_changed_block_count,
    upstreamPreToolLastSeenMessageIdBefore: body.upstreamPreToolLastSeenMessageIdBefore ?? body.upstream_pre_tool_last_seen_message_id_before,
    upstreamPreToolLastSeenMessageIdAfter: body.upstreamPreToolLastSeenMessageIdAfter ?? body.upstream_pre_tool_last_seen_message_id_after,
    upstreamPreToolBlockLabelCount: body.upstreamPreToolBlockLabelCount ?? body.upstream_pre_tool_block_label_count,
    upstreamStopAttempted: body.upstreamStopAttempted ?? body.upstream_stop_attempted,
    upstreamStopStatus: body.upstreamStopStatus ?? body.upstream_stop_status,
    upstreamStopBlockedReason: body.upstreamStopBlockedReason ?? body.upstream_stop_blocked_reason,
    upstreamStopMessageSent: body.upstreamStopMessageSent ?? body.upstream_stop_message_sent,
    upstreamStopConversationId: body.upstreamStopConversationId ?? body.upstream_stop_conversation_id,
    upstreamStopTranscriptPath: body.upstreamStopTranscriptPath ?? body.upstream_stop_transcript_path,
    upstreamStopSyncStateFile: body.upstreamStopSyncStateFile ?? body.upstream_stop_sync_state_file,
    upstreamStopScriptPath: body.upstreamStopScriptPath ?? body.upstream_stop_script_path,
    upstreamStopTranscriptMessageCount: body.upstreamStopTranscriptMessageCount ?? body.upstream_stop_transcript_message_count,
    upstreamStopNewMessageCount: body.upstreamStopNewMessageCount ?? body.upstream_stop_new_message_count,
  });
  if (!event) return res.status(400).json({ error: 'agent required' });
  appendSubconsciousEvent(event);
  const state = resolveSubconsciousState(event.agent);
  const at = new Date(event.ts || Date.now()).toISOString();
  const conversation = state
    ? syncSubconsciousConversationState(state, event, {
        at,
        hook: event.hook || event.hookEventName,
        toolName: event.toolName,
        runtimeInvoked: event.runtimeInvoked === true,
        runtimeProvider: event.runtimeProvider,
        runtimeModel: event.runtimeModel,
      })
    : null;
  if (state && conversation) applyConversationSnapshotToContract(state, conversation);
  return res.json({
    ok: true,
    ingestBoundary: authz.mode,
    event,
    conversation,
  });
});

app.get('/api/subconscious/detail/:name', (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });
  const wantsDebug = normalizeBoolean(req.query?.debug) === true || normalizeBoolean(req.query?.privileged) === true;
  if (wantsDebug && !canAccessPrivilegedSubconsciousDetail(req)) {
    return res.status(403).json({ error: 'privileged debug access required' });
  }
  return res.json(wantsDebug ? state.contract : buildOperationalSubconsciousContract(state.contract));
});

app.post('/api/subconscious/upstream/bootstrap/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  const now = new Date().toISOString();
  const existingUpstream = (state.letta?.upstream && typeof state.letta.upstream === 'object') ? state.letta.upstream : {};
  const existingRuntimeUpstream = (state.runtimeMeta?.upstream && typeof state.runtimeMeta.upstream === 'object')
    ? state.runtimeMeta.upstream
    : {};
  const requestedAgentId = normalizeOptionalText(req.body?.lettaAgentId, 256);
  const configuredAgentId = normalizeOptionalText(process.env.LETTA_AGENT_ID, 256);
  const result = await bootstrapUpstreamClaudeSubconsciousAgent({
    stateDir: state.stateDir,
    workdir: state.agent.workdir || '',
    apiKey: normalizeOptionalText(process.env.LETTA_API_KEY, 4096),
    lettaBaseUrl: normalizeOptionalText(process.env.LETTA_BASE_URL, 2048),
    lettaAgentId: requestedAgentId
      || configuredAgentId
      || normalizeOptionalText(existingUpstream.agentId, 256),
    lettaModel: normalizeOptionalText(process.env.LETTA_MODEL, 256),
    lettaContextWindow: normalizeOptionalText(process.env.LETTA_CONTEXT_WINDOW, 64),
  });
  const directReuse = mergeUpstreamDirectReuse(existingRuntimeUpstream.directReuse);
  const persistedRuntimeUpstream = buildPersistedUpstreamState(existingRuntimeUpstream);
  const persistedUpstream = buildPersistedUpstreamState(existingUpstream);
  const nextRuntimeMeta = {
    ...(state.runtimeMeta && typeof state.runtimeMeta === 'object' ? state.runtimeMeta : {}),
    upstream: {
      ...persistedRuntimeUpstream,
      available: result.paths?.available === true,
      root: result.paths?.root || null,
      promptFile: result.paths?.promptFile || null,
      scripts: result.paths?.scripts || null,
      durableHome: result.paths?.durableHome || null,
      durableStateDir: result.paths?.durableStateDir || null,
      conversationsFile: result.paths?.conversationsFile || null,
      configPath: result.paths?.configPath || null,
      directReuse,
      bootstrapStatus: result.ok ? 'configured' : 'blocked',
      blocker: result.blocker || null,
      agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
      importedAt: normalizeOptionalText(result.config?.importedAt, 128) || null,
      model: normalizeOptionalText(result.config?.model, 256) || null,
      agentName: normalizeOptionalText(result.agent?.name, 256) || null,
      blockCount: Array.isArray(result.agent?.blocks) ? result.agent.blocks.length : 0,
    },
    updatedAt: now,
  };
  const nextLetta = {
    ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
    upstream: {
      ...persistedUpstream,
      bootstrapStatus: result.ok ? 'configured' : 'blocked',
      blocker: result.blocker || null,
      agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
      importedAt: normalizeOptionalText(result.config?.importedAt, 128) || null,
      model: normalizeOptionalText(result.config?.model, 256) || null,
      agentName: normalizeOptionalText(result.agent?.name, 256) || null,
      blockCount: Array.isArray(result.agent?.blocks) ? result.agent.blocks.length : 0,
      lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
      configPath: result.paths?.configPath || null,
      conversationsFile: result.paths?.conversationsFile || null,
      promptFile: result.paths?.promptFile || null,
    },
    updatedAt: now,
  };
  safeWriteJsonFile(state.runtimeMetaPath, nextRuntimeMeta);
  safeWriteJsonFile(state.lettaPath, nextLetta);
  const refreshed = resolveSubconsciousState(agent);
  return res.json({
    ok: result.ok,
    blocked: result.blocked === true,
    blocker: result.blocker || null,
    logs: Array.isArray(result.logs) ? result.logs.slice(-20) : [],
    upstream: refreshed?.contract?.upstream || buildSubconsciousUpstreamContract(state.stateDir, state.agent.workdir || null, nextRuntimeMeta, nextLetta, state.conversationState),
  });
});

app.post('/api/subconscious/upstream/session-start/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  try {
    const payload = req.body || {};
    const sessionId = normalizeOptionalText(payload.sessionId || payload.session_id, 200);
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const now = new Date().toISOString();
    const existingUpstream = (state.letta?.upstream && typeof state.letta.upstream === 'object') ? state.letta.upstream : {};
    const existingRuntimeUpstream = (state.runtimeMeta?.upstream && typeof state.runtimeMeta.upstream === 'object')
      ? state.runtimeMeta.upstream
      : {};
    const requestedAgentId = normalizeOptionalText(payload.lettaAgentId, 256);
    const configuredAgentId = normalizeOptionalText(process.env.LETTA_AGENT_ID, 256);
    const result = await startUpstreamClaudeSubconsciousSession({
      stateDir: state.stateDir,
      workdir: state.agent.workdir || '',
      cwd: normalizeWorkspacePath(payload.cwd) || state.agent.workdir || '',
      apiKey: normalizeOptionalText(process.env.LETTA_API_KEY, 4096),
      lettaBaseUrl: normalizeOptionalText(process.env.LETTA_BASE_URL, 2048),
      lettaAgentId: requestedAgentId
        || configuredAgentId
        || normalizeOptionalText(existingUpstream.agentId, 256),
      lettaModel: normalizeOptionalText(process.env.LETTA_MODEL, 256),
      lettaContextWindow: normalizeOptionalText(process.env.LETTA_CONTEXT_WINDOW, 64),
      sessionId,
      sendSessionStartMessage: normalizeBoolean(payload.sendMessage) !== false,
    });
    const directReuse = mergeUpstreamDirectReuse(existingRuntimeUpstream.directReuse);
    const persistedRuntimeUpstream = buildPersistedUpstreamState(existingRuntimeUpstream);
    const persistedUpstream = buildPersistedUpstreamState(existingUpstream);
    const sendMessageRequested = normalizeBoolean(payload.sendMessage) !== false;
    const sessionEstablished = Boolean((result.sessionId || sessionId) && result.conversationId);
    const notifyBlockedReason = sendMessageRequested && result.blocker ? result.blocker : null;
    const notifyRecord = {
      attempted: sendMessageRequested,
      status: result.messageSent === true
        ? 'sent'
        : (sendMessageRequested
          ? (notifyBlockedReason ? 'blocked' : 'attempted')
          : 'not-attempted'),
      blockedReason: notifyBlockedReason,
      messageSent: result.messageSent === true,
      attemptedAt: sendMessageRequested ? now : null,
      messageSentAt: result.messageSent === true ? now : null,
      requiredDecision: notifyBlockedReason
        ? deriveUpstreamNotifyDecision(
          notifyBlockedReason,
          result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
          normalizeOptionalText(result.agent?.llm_config?.handle, 256)
            || normalizeOptionalText(result.agent?.llm_config?.model, 256)
            || normalizeOptionalText(existingUpstream.model, 256)
            || normalizeOptionalText(existingRuntimeUpstream.model, 256)
        )
        : null,
    };
    const sessionRecord = {
      established: sessionEstablished,
      status: sessionEstablished ? 'started' : (result.blocked === true ? 'blocked' : 'not-run'),
      blocker: sessionEstablished ? null : (result.blocker || null),
      checkedAt: now,
      sessionId: result.sessionId || sessionId,
      conversationId: result.conversationId || null,
      conversationStatus: result.conversationStatus || null,
      sessionStateFile: result.sessionStateFile || null,
      sessionStartedAt: normalizeOptionalText(result.sessionState?.startedAt, 128) || now,
      messageSent: result.messageSent === true,
      messageSentAt: result.messageSent === true ? now : null,
      cwd: normalizeWorkspacePath(result.cwd) || state.agent.workdir || null,
      notify: notifyRecord,
    };
    const persistedSessionRecord = buildPersistedUpstreamRecord('session', sessionRecord);
    const nextRuntimeMeta = {
      ...(state.runtimeMeta && typeof state.runtimeMeta === 'object' ? state.runtimeMeta : {}),
      upstream: {
        ...persistedRuntimeUpstream,
        available: result.paths?.available === true,
        root: result.paths?.root || null,
        promptFile: result.paths?.promptFile || null,
        scripts: result.paths?.scripts || null,
        durableHome: result.paths?.durableHome || null,
        durableStateDir: result.paths?.durableStateDir || null,
        conversationsFile: result.paths?.conversationsFile || null,
        configPath: result.paths?.configPath || null,
        directReuse,
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        agentName: normalizeOptionalText(result.agent?.name, 256) || normalizeOptionalText(existingUpstream.agentName, 256) || null,
        blockCount: Array.isArray(result.agent?.blocks) ? result.agent.blocks.length : normalizeNonNegativeInt(existingRuntimeUpstream.blockCount, 0),
        session: persistedSessionRecord,
      },
      updatedAt: now,
    };
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      upstream: {
        ...persistedUpstream,
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        agentName: normalizeOptionalText(result.agent?.name, 256) || normalizeOptionalText(existingUpstream.agentName, 256) || null,
        blockCount: Array.isArray(result.agent?.blocks) ? result.agent.blocks.length : normalizeNonNegativeInt(existingUpstream.blockCount, 0),
        lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
        configPath: result.paths?.configPath || null,
        conversationsFile: result.paths?.conversationsFile || null,
        promptFile: result.paths?.promptFile || null,
        session: persistedSessionRecord,
      },
      updatedAt: now,
    };
    safeWriteJsonFile(state.runtimeMetaPath, nextRuntimeMeta);
    safeWriteJsonFile(state.lettaPath, nextLetta);
    const upstreamResponse = {
      bootstrap: {
        supported: result.paths?.available === true,
        status: 'configured',
        blockedReason: null,
        checkedAt: now,
        apiKeyConfigured: Boolean(normalizeOptionalText(process.env.LETTA_API_KEY, 4096)),
        lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        importedAt: normalizeOptionalText(existingUpstream.importedAt, 128) || null,
        model: normalizeOptionalText(process.env.LETTA_MODEL, 256)
          || normalizeOptionalText(existingUpstream.model, 256)
          || normalizeOptionalText(existingRuntimeUpstream.model, 256)
          || null,
        agentName: normalizeOptionalText(result.agent?.name, 256)
          || normalizeOptionalText(existingUpstream.agentName, 256)
          || null,
        blockCount: Array.isArray(result.agent?.blocks)
          ? result.agent.blocks.length
          : normalizeNonNegativeInt(existingUpstream.blockCount, 0),
        workdir: state.agent.workdir || null,
      },
      session: sessionRecord,
    };
    return res.json({
      ok: sessionEstablished,
      blocked: !sessionEstablished && result.blocked === true,
      blocker: sessionEstablished ? null : (result.blocker || null),
      logs: Array.isArray(result.logs) ? result.logs.slice(-20) : [],
      session: sessionRecord,
      upstream: upstreamResponse,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, blocked: true, blocker: err?.message || String(err) });
  }
});

app.post('/api/subconscious/upstream/user-prompt/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  try {
    const payload = req.body || {};
    const sessionId = normalizeOptionalText(payload.sessionId || payload.session_id, 200);
    const prompt = normalizeOptionalText(payload.prompt, 8000);
    const transcriptPath = normalizeWorkspacePath(payload.transcriptPath || payload.transcript_path);
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const now = new Date().toISOString();
    const existingUpstream = (state.letta?.upstream && typeof state.letta.upstream === 'object') ? state.letta.upstream : {};
    const existingRuntimeUpstream = (state.runtimeMeta?.upstream && typeof state.runtimeMeta.upstream === 'object')
      ? state.runtimeMeta.upstream
      : {};
    const existingUpstreamUserPrompt = (existingUpstream.userPrompt && typeof existingUpstream.userPrompt === 'object')
      ? existingUpstream.userPrompt
      : {};
    const existingRuntimeUpstreamUserPrompt = (existingRuntimeUpstream.userPrompt && typeof existingRuntimeUpstream.userPrompt === 'object')
      ? existingRuntimeUpstream.userPrompt
      : {};
    const persistedRuntimeUpstream = buildPersistedUpstreamState(existingRuntimeUpstream);
    const persistedUpstream = buildPersistedUpstreamState(existingUpstream);
    const requestedAgentId = normalizeOptionalText(payload.lettaAgentId, 256);
    const configuredAgentId = normalizeOptionalText(process.env.LETTA_AGENT_ID, 256);
    const result = await syncUpstreamClaudeSubconsciousUserPrompt({
      stateDir: state.stateDir,
      workdir: state.agent.workdir || '',
      cwd: normalizeWorkspacePath(payload.cwd) || state.agent.workdir || '',
      transcriptPath,
      prompt,
      apiKey: normalizeOptionalText(process.env.LETTA_API_KEY, 4096),
      lettaBaseUrl: normalizeOptionalText(process.env.LETTA_BASE_URL, 2048),
      lettaAgentId: requestedAgentId
        || configuredAgentId
        || normalizeOptionalText(existingUpstream.agentId, 256),
      lettaModel: normalizeOptionalText(process.env.LETTA_MODEL, 256),
      lettaContextWindow: normalizeOptionalText(process.env.LETTA_CONTEXT_WINDOW, 64),
      sessionId,
    });
    const userPromptRecord = {
      attempted: result.sendAttempted === true,
      status: normalizeOptionalText(result.sendStatus, 64)
        || (result.messageSent === true ? 'sent' : (result.blocked === true ? 'blocked' : 'not-run')),
      blockedReason: result.blocker || null,
      checkedAt: now,
      attemptedAt: result.sendAttempted === true ? now : null,
      messageSent: result.messageSent === true,
      messageSentAt: result.messageSent === true ? now : null,
      sessionId: result.sessionId || sessionId,
      conversationId: result.conversationId || null,
      transcriptPath: transcriptPath || null,
      transcriptLineCount: normalizeNonNegativeInt(result.transcriptLineCount, 0),
      syncStateFile: normalizeWorkspacePath(result.syncStateFile) || null,
      lastProcessedIndexBefore: Number.isFinite(Number(result.lastProcessedIndexBefore))
        ? Number(result.lastProcessedIndexBefore)
        : null,
      lastProcessedIndexAfter: Number.isFinite(Number(result.lastProcessedIndexAfter))
        ? Number(result.lastProcessedIndexAfter)
        : null,
      scriptPath: normalizeWorkspacePath(result.paths?.scripts?.syncMemory) || result.paths?.scripts?.syncMemory || null,
    };
    const persistedUserPromptRecord = buildPersistedUpstreamRecord('userPrompt', {
      ...existingRuntimeUpstreamUserPrompt,
      ...userPromptRecord,
    });
    const nextRuntimeMeta = {
      ...(state.runtimeMeta && typeof state.runtimeMeta === 'object' ? state.runtimeMeta : {}),
      upstream: {
        ...persistedRuntimeUpstream,
        available: result.paths?.available === true,
        root: result.paths?.root || null,
        promptFile: result.paths?.promptFile || null,
        scripts: result.paths?.scripts || null,
        durableHome: result.paths?.durableHome || null,
        durableStateDir: result.paths?.durableStateDir || null,
        conversationsFile: result.paths?.conversationsFile || null,
        configPath: result.paths?.configPath || null,
        directReuse: mergeUpstreamDirectReuse(existingRuntimeUpstream.directReuse),
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        model: normalizeOptionalText(existingUpstream.model, 256)
          || normalizeOptionalText(existingRuntimeUpstream.model, 256)
          || null,
        userPrompt: persistedUserPromptRecord,
      },
      updatedAt: now,
    };
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      upstream: {
        ...persistedUpstream,
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
        userPrompt: buildPersistedUpstreamRecord('userPrompt', {
          ...existingUpstreamUserPrompt,
          ...userPromptRecord,
        }),
      },
      updatedAt: now,
    };
    safeWriteJsonFile(state.runtimeMetaPath, nextRuntimeMeta);
    safeWriteJsonFile(state.lettaPath, nextLetta);
    const refreshed = resolveSubconsciousState(agent);
    return res.json({
      ok: result.ok,
      blocked: result.blocked === true,
      blocker: result.blocker || null,
      logs: Array.isArray(result.logs) ? result.logs.slice(-20) : [],
      userPrompt: userPromptRecord,
      upstream: refreshed?.contract?.upstream || buildSubconsciousUpstreamContract(state.stateDir, state.agent.workdir || null, nextRuntimeMeta, nextLetta, state.conversationState),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, blocked: true, blocker: err?.message || String(err) });
  }
});

app.post('/api/subconscious/upstream/pretool/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  try {
    const payload = req.body || {};
    const sessionId = normalizeOptionalText(payload.sessionId || payload.session_id, 200);
    const toolName = normalizeOptionalText(payload.toolName || payload.tool_name, 120);
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const now = new Date().toISOString();
    const existingUpstream = (state.letta?.upstream && typeof state.letta.upstream === 'object') ? state.letta.upstream : {};
    const existingRuntimeUpstream = (state.runtimeMeta?.upstream && typeof state.runtimeMeta.upstream === 'object')
      ? state.runtimeMeta.upstream
      : {};
    const existingUpstreamPreTool = (existingUpstream.preTool && typeof existingUpstream.preTool === 'object')
      ? existingUpstream.preTool
      : {};
    const existingRuntimeUpstreamPreTool = (existingRuntimeUpstream.preTool && typeof existingRuntimeUpstream.preTool === 'object')
      ? existingRuntimeUpstream.preTool
      : {};
    const persistedRuntimeUpstream = buildPersistedUpstreamState(existingRuntimeUpstream);
    const persistedUpstream = buildPersistedUpstreamState(existingUpstream);
    const requestedAgentId = normalizeOptionalText(payload.lettaAgentId, 256);
    const configuredAgentId = normalizeOptionalText(process.env.LETTA_AGENT_ID, 256);
    const result = await syncUpstreamClaudeSubconsciousPreTool({
      stateDir: state.stateDir,
      workdir: state.agent.workdir || '',
      cwd: normalizeWorkspacePath(payload.cwd) || state.agent.workdir || '',
      toolName,
      apiKey: normalizeOptionalText(process.env.LETTA_API_KEY, 4096),
      lettaBaseUrl: normalizeOptionalText(process.env.LETTA_BASE_URL, 2048),
      lettaAgentId: requestedAgentId
        || configuredAgentId
        || normalizeOptionalText(existingUpstream.agentId, 256),
      lettaModel: normalizeOptionalText(process.env.LETTA_MODEL, 256),
      lettaContextWindow: normalizeOptionalText(process.env.LETTA_CONTEXT_WINDOW, 64),
      sessionId,
    });
    const preToolRecord = {
      attempted: result.sendAttempted === true,
      status: normalizeOptionalText(result.sendStatus, 64)
        || (result.injected === true ? 'injected' : (result.blocked === true ? 'blocked' : 'not-run')),
      blockedReason: result.blocker || null,
      checkedAt: now,
      attemptedAt: result.sendAttempted === true ? now : null,
      injected: result.injected === true,
      injectedAt: result.injected === true ? now : null,
      sessionId: result.sessionId || sessionId,
      conversationId: result.conversationId || null,
      syncStateFile: normalizeWorkspacePath(result.syncStateFile) || null,
      newMessageCount: normalizeNonNegativeInt(result.newMessageCount, 0),
      changedBlockCount: normalizeNonNegativeInt(result.changedBlockCount, 0),
      lastSeenMessageIdBefore: normalizeOptionalText(result.lastSeenMessageIdBefore, 256) || null,
      lastSeenMessageIdAfter: normalizeOptionalText(result.lastSeenMessageIdAfter, 256) || null,
      blockLabelCount: normalizeNonNegativeInt(result.blockLabelCount, 0),
      scriptPath: normalizeWorkspacePath(result.paths?.scripts?.pretoolSync) || result.paths?.scripts?.pretoolSync || null,
      toolName: toolName || null,
    };
    const persistedPreToolRecord = buildPersistedUpstreamRecord('preTool', {
      ...existingRuntimeUpstreamPreTool,
      ...preToolRecord,
    });
    const nextRuntimeMeta = {
      ...(state.runtimeMeta && typeof state.runtimeMeta === 'object' ? state.runtimeMeta : {}),
      upstream: {
        ...persistedRuntimeUpstream,
        available: result.paths?.available === true,
        root: result.paths?.root || null,
        promptFile: result.paths?.promptFile || null,
        scripts: result.paths?.scripts || null,
        durableHome: result.paths?.durableHome || null,
        durableStateDir: result.paths?.durableStateDir || null,
        conversationsFile: result.paths?.conversationsFile || null,
        configPath: result.paths?.configPath || null,
        directReuse: mergeUpstreamDirectReuse(existingRuntimeUpstream.directReuse),
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        model: normalizeOptionalText(existingUpstream.model, 256)
          || normalizeOptionalText(existingRuntimeUpstream.model, 256)
          || null,
        preTool: persistedPreToolRecord,
      },
      updatedAt: now,
    };
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      upstream: {
        ...persistedUpstream,
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
        preTool: buildPersistedUpstreamRecord('preTool', {
          ...existingUpstreamPreTool,
          ...preToolRecord,
        }),
      },
      updatedAt: now,
    };
    safeWriteJsonFile(state.runtimeMetaPath, nextRuntimeMeta);
    safeWriteJsonFile(state.lettaPath, nextLetta);
    const refreshed = resolveSubconsciousState(agent);
    return res.json({
      ok: result.ok,
      blocked: result.blocked === true,
      blocker: result.blocker || null,
      logs: Array.isArray(result.logs) ? result.logs.slice(-20) : [],
      preTool: {
        ...preToolRecord,
        additionalContext: normalizeOptionalText(result.additionalContext, 12000) || null,
      },
      upstream: refreshed?.contract?.upstream || buildSubconsciousUpstreamContract(state.stateDir, state.agent.workdir || null, nextRuntimeMeta, nextLetta, state.conversationState),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, blocked: true, blocker: err?.message || String(err) });
  }
});

app.post('/api/subconscious/upstream/stop/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  try {
    const payload = req.body || {};
    const sessionId = normalizeOptionalText(payload.sessionId || payload.session_id, 200);
    const transcriptPath = normalizeWorkspacePath(payload.transcriptPath || payload.transcript_path);
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!transcriptPath) return res.status(400).json({ error: 'transcriptPath required' });

    const now = new Date().toISOString();
    const existingUpstream = (state.letta?.upstream && typeof state.letta.upstream === 'object') ? state.letta.upstream : {};
    const existingRuntimeUpstream = (state.runtimeMeta?.upstream && typeof state.runtimeMeta.upstream === 'object')
      ? state.runtimeMeta.upstream
      : {};
    const existingUpstreamStop = (existingUpstream.stop && typeof existingUpstream.stop === 'object') ? existingUpstream.stop : {};
    const existingRuntimeUpstreamStop = (existingRuntimeUpstream.stop && typeof existingRuntimeUpstream.stop === 'object')
      ? existingRuntimeUpstream.stop
      : {};
    const persistedRuntimeUpstream = buildPersistedUpstreamState(existingRuntimeUpstream);
    const persistedUpstream = buildPersistedUpstreamState(existingUpstream);
    const requestedAgentId = normalizeOptionalText(payload.lettaAgentId, 256);
    const configuredAgentId = normalizeOptionalText(process.env.LETTA_AGENT_ID, 256);
    const result = await syncUpstreamClaudeSubconsciousStop({
      stateDir: state.stateDir,
      workdir: state.agent.workdir || '',
      cwd: normalizeWorkspacePath(payload.cwd) || state.agent.workdir || '',
      transcriptPath,
      apiKey: normalizeOptionalText(process.env.LETTA_API_KEY, 4096),
      lettaBaseUrl: normalizeOptionalText(process.env.LETTA_BASE_URL, 2048),
      lettaAgentId: requestedAgentId
        || configuredAgentId
        || normalizeOptionalText(existingUpstream.agentId, 256),
      lettaModel: normalizeOptionalText(process.env.LETTA_MODEL, 256),
      lettaContextWindow: normalizeOptionalText(process.env.LETTA_CONTEXT_WINDOW, 64),
      sessionId,
    });
    const stopRecord = {
      attempted: result.sendAttempted === true,
      status: normalizeOptionalText(result.sendStatus, 64)
        || (result.messageSent === true ? 'sent' : (result.blocked === true ? 'blocked' : 'not-run')),
      blockedReason: result.blocker || null,
      checkedAt: now,
      attemptedAt: result.sendAttempted === true ? now : null,
      messageSent: result.messageSent === true,
      messageSentAt: result.messageSent === true ? now : null,
      sessionId: result.sessionId || sessionId,
      conversationId: result.conversationId || null,
      transcriptPath,
      transcriptMessageCount: normalizeNonNegativeInt(result.transcriptMessageCount, 0),
      newMessageCount: normalizeNonNegativeInt(result.newMessageCount, 0),
      syncStateFile: normalizeWorkspacePath(result.syncStateFile) || null,
      lastProcessedIndexBefore: Number.isFinite(Number(result.lastProcessedIndexBefore))
        ? Number(result.lastProcessedIndexBefore)
        : null,
      lastProcessedIndexAfter: Number.isFinite(Number(result.lastProcessedIndexAfter))
        ? Number(result.lastProcessedIndexAfter)
        : null,
      scriptPath: normalizeWorkspacePath(result.paths?.scripts?.stopSend) || result.paths?.scripts?.stopSend || null,
    };
    const persistedStopRecord = buildPersistedUpstreamRecord('stop', {
      ...existingRuntimeUpstreamStop,
      ...stopRecord,
    });
    const nextRuntimeMeta = {
      ...(state.runtimeMeta && typeof state.runtimeMeta === 'object' ? state.runtimeMeta : {}),
      upstream: {
        ...persistedRuntimeUpstream,
        available: result.paths?.available === true,
        root: result.paths?.root || null,
        promptFile: result.paths?.promptFile || null,
        scripts: result.paths?.scripts || null,
        durableHome: result.paths?.durableHome || null,
        durableStateDir: result.paths?.durableStateDir || null,
        conversationsFile: result.paths?.conversationsFile || null,
        configPath: result.paths?.configPath || null,
        directReuse: mergeUpstreamDirectReuse(existingRuntimeUpstream.directReuse),
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        model: normalizeOptionalText(existingUpstream.model, 256)
          || normalizeOptionalText(existingRuntimeUpstream.model, 256)
          || null,
        stop: persistedStopRecord,
      },
      updatedAt: now,
    };
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      upstream: {
        ...persistedUpstream,
        bootstrapStatus: 'configured',
        blocker: null,
        agentId: result.agentId || normalizeOptionalText(existingUpstream.agentId, 256) || null,
        lettaBaseUrl: result.lettaBaseUrl || normalizeOptionalText(process.env.LETTA_BASE_URL, 2048) || 'https://api.letta.com',
        stop: buildPersistedUpstreamRecord('stop', {
          ...existingUpstreamStop,
          ...stopRecord,
        }),
      },
      updatedAt: now,
    };
    safeWriteJsonFile(state.runtimeMetaPath, nextRuntimeMeta);
    safeWriteJsonFile(state.lettaPath, nextLetta);
    const refreshed = resolveSubconsciousState(agent);
    return res.json({
      ok: result.blocked !== true,
      blocked: result.blocked === true,
      blocker: result.blocker || null,
      logs: Array.isArray(result.logs) ? result.logs.slice(-20) : [],
      stop: stopRecord,
      upstream: refreshed?.contract?.upstream || buildSubconsciousUpstreamContract(state.stateDir, state.agent.workdir || null, nextRuntimeMeta, nextLetta, state.conversationState),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, blocked: true, blocker: err?.message || String(err) });
  }
});

app.post('/api/subconscious/runtime/invoke/:name', async (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const state = resolveSubconsciousState(agent);
  if (!state) return res.status(404).json({ error: 'agent not found' });

  const payload = req.body || {};
  const hook = normalizeOptionalText(payload.hook, 120) || normalizeOptionalText(payload.hookEventName, 120) || null;
  if (!hook) return res.status(400).json({ error: 'hook required' });

  const promptPayload = {
    hook,
    hookEventName: normalizeOptionalText(payload.hookEventName, 120) || hook,
    sessionId: normalizeOptionalText(payload.sessionId, 200),
    transcriptPath: normalizeWorkspacePath(payload.transcriptPath),
    toolName: normalizeOptionalText(payload.toolName, 120),
    promptPreview: normalizeOptionalText(payload.promptPreview, 320),
    summary: normalizeOptionalText(payload.summary, 600),
  };
  const invokeStartedAt = new Date().toISOString();
  const conversationBefore = syncSubconsciousConversationState(state, promptPayload, {
    at: invokeStartedAt,
    hook,
    toolName: promptPayload.toolName,
    runtimeInvoked: false,
  });
  if (conversationBefore) applyConversationSnapshotToContract(state, conversationBefore);

  if (!state.runtimeConfig.invocationConfigured) {
    return res.json({
      ok: true,
      invoked: false,
      guidance: null,
      guidanceSource: state.contract.manualGuidance.configured ? 'manual-state-file' : 'none',
      disabledReason: state.runtimeConfig.disabledReason,
      provider: state.runtimeConfig.provider,
      model: state.runtimeConfig.model,
      conversation: state.contract.conversation,
    });
  }

  if (!state.runtimeConfig.allowedHooks.includes(hook)) {
    return res.json({
      ok: true,
      invoked: false,
      guidance: null,
      guidanceSource: state.contract.manualGuidance.configured ? 'manual-state-file' : 'none',
      disabledReason: `hook ${hook} is not eligible for runtime guidance`,
      provider: state.runtimeConfig.provider,
      model: state.runtimeConfig.model,
      conversation: state.contract.conversation,
    });
  }
  const recentEvents = getSubconsciousEvents(agent, 12);
  const retrievedMemories = retrieveSubconsciousMemories(state.memoryState, promptPayload);
  if (state.memoryState?.store) {
    state.memoryState.store.lastRetrievedAt = new Date().toISOString();
    state.memoryState.store.lastRetrievedQuery = retrievedMemories.queryText || null;
    state.memoryState.store.lastRetrievedIds = retrievedMemories.matches.map((row) => row.id);
    writeSubconsciousMemoryStore(state.memoryState);
  }
  const prompt = buildSubconsciousInvokePrompt(agent, promptPayload, state, recentEvents, retrievedMemories);
  const started = Date.now();

  try {
    const llm = await callSubconsciousRuntimeLlm(state, prompt);
    const parsed = parseSubconsciousInvokeResponse(llm.content);
    const guidance = parsed.guidance || '';
    const nowIso = new Date().toISOString();
    const storedEpisode = appendSubconsciousMemoryEpisode(state.memoryState, promptPayload, parsed);
    const conversationAfter = syncSubconsciousConversationState(state, promptPayload, {
      at: nowIso,
      hook,
      toolName: promptPayload.toolName,
      runtimeInvoked: true,
      runtimeProvider: state.runtimeConfig.provider,
      runtimeModel: state.runtimeConfig.model,
      guidancePreview: guidance ? guidance.slice(0, 320) : '',
      guidanceAt: guidance ? nowIso : null,
      guidanceSource: guidance ? 'runtime-llm' : 'none',
    });
    const currentConversation = applyConversationSnapshotToContract(state, conversationAfter);
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      lastInvocation: {
        ok: true,
        hook,
        ts: Date.now(),
        at: nowIso,
        provider: state.runtimeConfig.provider,
        model: state.runtimeConfig.model,
        latencyMs: Date.now() - started,
        guidancePreview: guidance ? guidance.slice(0, 240) : '',
        error: null,
        summary: parsed.summary,
        memoryRetrieval: {
          query: retrievedMemories.queryText || '',
          matchCount: retrievedMemories.matches.length,
          matchIds: retrievedMemories.matches.map((row) => row.id),
          storedEpisodeId: storedEpisode?.id || null,
        },
        conversation: {
          sessionId: currentConversation?.sessionId || promptPayload.sessionId || null,
          transcriptPath: currentConversation?.transcriptPath || promptPayload.transcriptPath || null,
          userTurnCount: currentConversation?.userTurnCount ?? 0,
          assistantTurnCount: currentConversation?.assistantTurnCount ?? 0,
        },
      },
      lastRuntimeGuidance: {
        text: guidance,
        preview: guidance ? guidance.slice(0, 600) : '',
        updatedAt: nowIso,
        hook,
        summary: parsed.summary,
        guidanceSource: guidance ? 'runtime-llm' : 'none',
        sessionId: currentConversation?.sessionId || promptPayload.sessionId || null,
        transcriptPath: currentConversation?.transcriptPath || promptPayload.transcriptPath || null,
      },
      updatedAt: nowIso,
    };
    safeWriteJsonFile(state.lettaPath, nextLetta);
    return res.json({
      ok: true,
      invoked: true,
      guidance,
      guidanceSource: guidance ? 'runtime-llm' : 'none',
      provider: state.runtimeConfig.provider,
      model: state.runtimeConfig.model,
      latencyMs: Date.now() - started,
      usage: llm.usage || null,
      summary: parsed.summary,
      memoryRetrieval: {
        query: retrievedMemories.queryText || '',
        matchCount: retrievedMemories.matches.length,
        matches: retrievedMemories.matches,
        storedEpisodeId: storedEpisode?.id || null,
      },
      conversation: state.contract.conversation,
    });
  } catch (e) {
    const nowIso = new Date().toISOString();
    const conversationAfter = syncSubconsciousConversationState(state, promptPayload, {
      at: nowIso,
      hook,
      toolName: promptPayload.toolName,
      runtimeInvoked: false,
      runtimeProvider: state.runtimeConfig.provider,
      runtimeModel: state.runtimeConfig.model,
    });
    applyConversationSnapshotToContract(state, conversationAfter);
    const nextLetta = {
      ...(state.letta && typeof state.letta === 'object' ? state.letta : {}),
      lastInvocation: {
        ok: false,
        hook,
        ts: Date.now(),
        at: nowIso,
        provider: state.runtimeConfig.provider,
        model: state.runtimeConfig.model,
        latencyMs: Date.now() - started,
        guidancePreview: '',
        error: String(e?.message || e),
        summary: 'runtime invocation failed',
      },
      updatedAt: nowIso,
    };
    safeWriteJsonFile(state.lettaPath, nextLetta);
    return res.status(502).json({
      ok: false,
      error: 'runtime invocation failed',
      detail: String(e?.message || e),
      provider: state.runtimeConfig.provider,
      model: state.runtimeConfig.model,
      conversation: state.contract.conversation,
    });
  }
});

app.get('/api/subconscious/events', (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, SUBCONSCIOUS_EVENT_HISTORY_LIMIT)
    : 120;
  const agent = normalizeLooseAgentName(req.query.agent);
  if (agent) {
    return res.json({ ok: true, agent, events: getSubconsciousEvents(agent, limit) });
  }
  const merged = [];
  for (const rows of subconsciousEventsByAgent.values()) {
    merged.push(...rows);
  }
  merged.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  return res.json({ ok: true, events: merged.slice(-limit) });
});

app.get('/api/subconscious/events/:name', (req, res) => {
  const agent = normalizeLooseAgentName(req.params.name);
  if (!agent) return res.status(400).json({ error: 'invalid agent name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, SUBCONSCIOUS_EVENT_HISTORY_LIMIT)
    : 120;
  return res.json({ ok: true, agent, events: getSubconsciousEvents(agent, limit) });
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
  if (senderIsAgent) {
    const block = getAgentInboxGateBlock(fromName);
    if (block) {
      return res.status(409).json(block);
    }
  }
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
  const runtime = ensureAgentRuntimeRecord(agentName);
  const pendingGate = getPendingInboxGate(runtime);
  const consumedPendingSource = Boolean(
    pendingGate
    && pendingGate.sourceMsgId
    && unread.some((msg) => msg?.id === pendingGate.sourceMsgId)
  );
  if (advanceInboxCursor(cursor, unread)) {
    saveCursors();
  }
  markAgentInboxChecked(agentName, {
    clearInboxGate: consumedPendingSource,
    sourceMsgId: consumedPendingSource ? pendingGate.sourceMsgId : null,
  });
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
  supervisorService.stop();
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
  supervisorService.start();
  console.log(`Agent Chat v2 backend listening on http://127.0.0.1:${PORT}`);
  const agentCount = Object.values(agents).filter(isAgentRecord).length;
  console.log(`  Agents: ${agentCount}, Messages: ${messages.length}, Groups: ${Object.keys(groups).length}`);
});
