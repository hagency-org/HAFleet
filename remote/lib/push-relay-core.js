import { execFileSync, execFile } from 'child_process';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { BLOCK_PATTERNS } from './blocked-patterns.js';
import EventSource from './eventsource-mini.js';

const __filename = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
let execFileAsyncImpl = execFileAsync;

const PUSH_RELAY_MODE = (process.env.PUSH_RELAY_MODE || 'local').trim().toLowerCase();
const PUSH_RELAY_REMOTE_MODE = PUSH_RELAY_MODE === 'remote';
const DEFAULT_IDLE_THRESHOLD_MS = PUSH_RELAY_REMOTE_MODE ? 20000 : 15000;
const PUSH_RELAY_INCLUDE_LEASE_FIELDS = (process.env.PUSH_RELAY_INCLUDE_LEASE_FIELDS ?? (PUSH_RELAY_REMOTE_MODE ? '1' : '0')) === '1';
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const API_BASE = (process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).replace(/\/$/, '');
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const SERVER_ID = (process.env.AGENT_CHAT_SERVER || os.hostname()).trim();
const SCAN_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_SCAN_INTERVAL_MS || '30000', 10);
const RECONNECT_MS = Number.parseInt(process.env.PUSH_RELAY_RECONNECT_MS || '5000', 10);
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_HEARTBEAT_INTERVAL_MS || '15000', 10);
const INJECT_DELAY_MS = Number.parseInt(process.env.PUSH_RELAY_INJECT_DELAY_MS || '300', 10);
const BLOCK_SCAN_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_BLOCK_SCAN_INTERVAL_MS || '5000', 10);
const BLOCK_TAIL_LINES = Number.parseInt(process.env.PUSH_RELAY_BLOCK_TAIL_LINES || '40', 10);
const BLOCK_RECENT_LINES = Number.parseInt(process.env.PUSH_RELAY_BLOCK_RECENT_LINES || '14', 10);
const COMPACT_RECENT_LINES = Number.parseInt(process.env.PUSH_RELAY_COMPACT_RECENT_LINES || '30', 10);
const SKIP_LOG_THROTTLE_MS = Number.parseInt(process.env.PUSH_RELAY_SKIP_LOG_THROTTLE_MS || '30000', 10);
const IDLE_THRESHOLD_MS = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || String(DEFAULT_IDLE_THRESHOLD_MS), 10);
const IDLE_THRESHOLD_SEC = Math.max(1, Math.floor((IDLE_THRESHOLD_MS + 999) / 1000));
const MCP_SESSION_CACHE_TTL_MS = Number.parseInt(process.env.PUSH_RELAY_MCP_SESSION_CACHE_TTL_MS || '1000', 10);
const RELAY_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const RELAY_BOOT_TS = Date.now();
const RELAY_VERSION = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(__filename), timeout: 3000 }).toString().trim(); }
  catch { return null; }
})();

const authHeaders = API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
const localAgents = new Set();
const agentsByName = new Map();
const delivered = new Set();
const deliveredOrder = [];
const DELIVERED_CAP = 10000;
let reconnectTimer = null;
let heartbeatTimer = null;
let warnedMissingTmux = false;
const blockedState = new Map();
const compactState = new Map();
const activityState = new Map();
const runtimeReportDigest = new Map();
const skipReasonLastLog = new Map();
const autoClearLastTs = new Map();
const AUTO_CLEAR_COOLDOWN_MS = parseInt(process.env.AGENT_AUTO_CLEAR_COOLDOWN_MS || '300000', 10);
let mcpSessionCacheAt = 0;
let mcpSessionCache = new Set();
const mcpMissCount = new Map(); // per-agent consecutive MCP-absent scan count
const MCP_MISS_THRESHOLD = 6;  // report mcpPresent=false after 6 consecutive misses (30s at 5s scan)

// Idle-gate relay queue: holds messages for agents that are currently active (not idle enough)
const RELAY_QUEUE_DRAIN_INTERVAL_MS = Number.parseInt(process.env.RELAY_QUEUE_DRAIN_INTERVAL_MS || '3000', 10);
const RELAY_QUEUE_MAX_AGE_MS = Number.parseInt(process.env.RELAY_QUEUE_MAX_AGE_MS || '300000', 10);
const relayQueue = new Map(); // Map<agentName, Array<{msg, notification, target, dedupeKey, queuedAt}>>
let relayQueueDrainTimer = null;

const COMPACT_PATTERNS = [
  { marker: 'codex-context-compacted', summary: 'Context compacted', re: /(?:^|\n)\s*(?:•\s*)?Context compacted\s*(?:\n|$)/i },
  { marker: 'claude-conversation-compacted', summary: 'Conversation compacted (ctrl+o for history)', re: /(?:^|\n)\s*(?:✻\s*)?Conversation compacted \(ctrl\+o for history\)\s*(?:\n|$)/i },
  { marker: 'claude-compacted-summary', summary: 'Compacted (ctrl+o to see full summary)', re: /(?:^|\n)\s*(?:⎿\s*)?Compacted \(ctrl\+o to see full summary\)\s*(?:\n|$)/i },
];

function warnMissingTmuxOnce() {
  if (warnedMissingTmux) return;
  warnedMissingTmux = true;
  console.error('[push-relay] tmux binary not found. Set TMUX_BIN or fix PATH (e.g. include /opt/homebrew/bin).');
}

function detectTmuxBin() {
  const envBin = (process.env.TMUX_BIN || '').trim();
  const candidates = [
    envBin || null,
    'tmux',
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (bin.includes('/') && !existsSync(bin)) continue;
      execFileSync(bin, ['-V'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] });
      return bin;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

const TMUX_BIN = detectTmuxBin();
if (!TMUX_BIN) warnMissingTmuxOnce();

function runTmux(args, options = {}) {
  if (!TMUX_BIN) throw new Error('tmux binary not available');
  return execFileSync(TMUX_BIN, args, options);
}

function normalizeServer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function api(path) {
  return fetch(`${API_BASE}${path}`, { headers: authHeaders });
}

async function postJson(path, body) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders };
  return fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function reportRuntime(agentName, payload) {
  try {
    const res = await postJson(`/api/agents/${encodeURIComponent(agentName)}/runtime`, {
      server: SERVER_ID,
      ...payload,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`status ${res.status} ${body}`.trim());
    }
  } catch (e) {
    console.error(`[push-relay] runtime report failed for ${agentName}: ${e.message}`);
  }
}

function listLocalTmuxSessions() {
  if (!TMUX_BIN) return new Set();
  try {
    const raw = runTmux(['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return new Set(raw ? raw.split('\n').filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function captureTail(target, lines = BLOCK_TAIL_LINES) {
  if (!TMUX_BIN) return '';
  try {
    return runTmux(['capture-pane', '-t', target, '-p', '-S', `-${Math.max(10, lines)}`], {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return '';
  }
}

function currentPaneCommand(target) {
  if (!TMUX_BIN) return '';
  try {
    return runTmux(['list-panes', '-t', target, '-F', '#{pane_current_command}'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim().split('\n')[0] || '';
  } catch {
    return '';
  }
}

function currentPanePath(target) {
  if (!TMUX_BIN) return null;
  try {
    const raw = runTmux(['list-panes', '-t', target, '-F', '#{pane_current_path}'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim().split('\n')[0] || '';
    if (!raw || raw.length > 4096) return null;
    if (!path.isAbsolute(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function currentSessionActivitySec(targetOrSession) {
  if (!TMUX_BIN) return null;
  const session = String(targetOrSession || '').split(':', 1)[0];
  if (!session) return null;
  try {
    const raw = runTmux(['display-message', '-p', '-t', session, '#{session_activity}'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

function recentTailWindow(tail, maxLines = BLOCK_RECENT_LINES) {
  const lines = String(tail || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/g, ''))
    .filter(line => line.trim().length > 0);
  if (lines.length === 0) return '';
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

function computeActivityMetrics(agentName, target) {
  const nowSec = Math.floor(Date.now() / 1000);
  const activitySec = currentSessionActivitySec(target);
  if (!activitySec) return null;

  let st = activityState.get(agentName);
  if (!st) {
    st = {
      lastActivitySec: activitySec,
      burstStartSec: activitySec,
      burstLastSec: activitySec,
    };
    activityState.set(agentName, st);
  } else if (activitySec < st.lastActivitySec) {
    // tmux/server restarted, reset baseline.
    st.lastActivitySec = activitySec;
    st.burstStartSec = activitySec;
    st.burstLastSec = activitySec;
  } else if (activitySec > st.lastActivitySec) {
    const gap = activitySec - st.lastActivitySec;
    if (gap > IDLE_THRESHOLD_SEC) {
      st.burstStartSec = activitySec;
      st.burstLastSec = activitySec;
    } else {
      st.burstLastSec = activitySec;
    }
    st.lastActivitySec = activitySec;
  }

  const rawIdleSec = Math.max(0, nowSec - st.lastActivitySec);
  const activeNow = rawIdleSec < IDLE_THRESHOLD_SEC;
  const activeDurationSec = activeNow ? Math.max(0, st.burstLastSec - st.burstStartSec) : 0;
  const idleDurationSec = activeNow ? 0 : Math.max(0, rawIdleSec - IDLE_THRESHOLD_SEC);

  return {
    activeNow,
    activeDurationSec,
    idleDurationSec,
    lastTmuxActivitySec: st.lastActivitySec,
  };
}

function detectBlockedReason(tail, paneCmd = '') {
  if (!tail) return null;
  const cmd = String(paneCmd || '').toLowerCase();
  // Only check interactive AI clients to avoid false positives from shell output.
  if (cmd && !cmd.includes('claude') && !cmd.includes('codex')) return null;
  const window = recentTailWindow(tail, BLOCK_RECENT_LINES);
  if (!window) return null;
  // Common benign suggestion in Claude output; not an actual interaction block.
  if (/tip:\s*use plan mode\b/i.test(window)) return null;

  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(window)) return p.reason;
  }
  return null;
}

function detectCompactSignal(tail, paneCmd = '') {
  if (!tail) return null;
  const cmd = String(paneCmd || '').toLowerCase();
  if (cmd && !cmd.includes('claude') && !cmd.includes('codex')) return null;
  const window = recentTailWindow(tail, COMPACT_RECENT_LINES);
  if (!window) return null;
  const signature = createHash('md5').update(window).digest('hex');
  for (const pattern of COMPACT_PATTERNS) {
    if (pattern.re.test(window)) {
      return { mode: 'pattern', marker: pattern.marker, summary: pattern.summary, signature };
    }
  }
  return null;
}

async function reportCompact(agentName, compact, tail, paneCmd = '') {
  if (!compact?.marker) return;
  try {
    const res = await postJson('/api/runtime/compact', {
      agent: agentName,
      server: SERVER_ID,
      source: 'tmux-tail',
      mode: compact.mode || 'pattern',
      marker: compact.marker,
      summary: compact.summary || compact.marker,
      tail: recentTailWindow(tail, COMPACT_RECENT_LINES),
      command: paneCmd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`status ${res.status} ${body}`.trim());
    }
  } catch (e) {
    console.error(`[push-relay] compact report failed for ${agentName}: ${e.message}`);
  }
}

async function refreshAgentsSnapshot() {
  const sessions = listLocalTmuxSessions();
  localAgents.clear();
  for (const s of sessions) localAgents.add(s);

  try {
    const res = await api('/api/agents');
    if (!res.ok) throw new Error(`agents API status ${res.status}`);
    const rows = await res.json();
    agentsByName.clear();
    for (const row of rows) agentsByName.set(row.name, row);
  } catch (e) {
    console.error(`[push-relay] refresh agents failed: ${e.message}`);
  }
}

function injectSlashClear(target) {
  if (!TMUX_BIN) return false;
  const opts = { timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] };
  try {
    // Escape any partial input first, then send /clear
    runTmux(['send-keys', '-t', target, 'C-c'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'C-u'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-l', '-t', target, '/clear'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'Enter'], opts);
    return true;
  } catch (e) {
    console.error(`[push-relay] auto-clear inject failed for ${target}: ${e.message}`);
    return false;
  }
}

async function scanBlockedStates() {
  const live = new Set(localAgents);
  const mcpSessions = await getMcpSessionSet(true);

  for (const [agentName, prev] of blockedState.entries()) {
    if (live.has(agentName)) continue;
    blockedState.delete(agentName);
    compactState.delete(agentName);
    activityState.delete(agentName);
    runtimeReportDigest.delete(agentName);
    mcpMissCount.delete(agentName);
    await reportRuntime(agentName, {
      blocked: false,
      reason: null,
      tail: '',
      command: '',
      activeNow: false,
      activeDurationSec: 0,
      idleDurationSec: 0,
      lastTmuxActivitySec: null,
      mcpPresent: null,
    });
  }

  for (const agentName of live) {
    if (!shouldHandleAgent(agentName)) continue;
    const target = agentsByName.get(agentName)?.tmux || `${agentName}:0.0`;
    const paneCmd = currentPaneCommand(target);
    const panePath = currentPanePath(target);
    const tail = captureTail(target, BLOCK_TAIL_LINES);
    const reason = detectBlockedReason(tail, paneCmd);
    const compact = detectCompactSignal(tail, paneCmd);
    const blocked = Boolean(reason);
    const prev = blockedState.get(agentName) || { blocked: false, reason: null };
    blockedState.set(agentName, { blocked, reason });

    // Auto-clear: when api-image-error is newly detected, inject /clear to recover
    if (reason === 'api-image-error' && prev.reason !== 'api-image-error') {
      const now = Date.now();
      const lastClear = autoClearLastTs.get(agentName) || 0;
      if ((now - lastClear) > AUTO_CLEAR_COOLDOWN_MS) {
        console.warn(`[push-relay] auto-clear: agent ${agentName} stuck on api-image-error, injecting /clear`);
        if (injectSlashClear(target)) {
          autoClearLastTs.set(agentName, now);
        }
      } else {
        console.warn(`[push-relay] auto-clear: agent ${agentName} still stuck on api-image-error (cooldown active, last clear ${Math.round((now - lastClear) / 1000)}s ago)`);
      }
    }

    const prevCompact = compactState.get(agentName) || null;
    if (compact) {
      if (!prevCompact || prevCompact.marker !== compact.marker || prevCompact.signature !== compact.signature) {
        compactState.set(agentName, { marker: compact.marker, signature: compact.signature || '' });
        await reportCompact(agentName, compact, tail, paneCmd);
      }
    } else if (prevCompact) {
      compactState.delete(agentName);
    }

    // Debounce MCP detection — only report absent after consecutive misses
    const mcpDetected = mcpSessions.has(agentName);
    let mcpPresent;
    if (mcpDetected) {
      mcpMissCount.delete(agentName);
      mcpPresent = true;
    } else {
      const misses = (mcpMissCount.get(agentName) || 0) + 1;
      mcpMissCount.set(agentName, misses);
      mcpPresent = misses < MCP_MISS_THRESHOLD; // grace period: assume present until threshold
    }

    const metrics = computeActivityMetrics(agentName, target);
    const payload = {
      blocked,
      reason,
      tail,
      command: paneCmd,
      activeNow: metrics?.activeNow ?? null,
      activeDurationSec: metrics?.activeDurationSec ?? 0,
      idleDurationSec: metrics?.idleDurationSec ?? 0,
      lastTmuxActivitySec: metrics?.lastTmuxActivitySec ?? null,
      workspacePath: panePath,
      mcpPresent,
    };
    const digest = JSON.stringify({
      blocked: payload.blocked,
      reason: payload.reason || null,
      activeNow: payload.activeNow,
      activeDurationSec: payload.activeDurationSec,
      idleDurationSec: payload.idleDurationSec,
      lastTmuxActivitySec: payload.lastTmuxActivitySec,
      workspacePath: payload.workspacePath || null,
      mcpPresent: payload.mcpPresent,
    });
    if (runtimeReportDigest.get(agentName) === digest) continue;
    runtimeReportDigest.set(agentName, digest);
    await reportRuntime(agentName, payload);
  }
}

async function sendHeartbeat() {
  const sessions = [...localAgents];
  const body = {
    server: SERVER_ID,
    sessions,
    agents: sessions,
  };
  if (PUSH_RELAY_INCLUDE_LEASE_FIELDS) {
    body.instanceId = RELAY_INSTANCE_ID;
    body.bootTs = RELAY_BOOT_TS;
  }
  if (RELAY_VERSION) body.version = RELAY_VERSION;
  try {
    const res = await postJson('/api/servers/heartbeat', body);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (PUSH_RELAY_INCLUDE_LEASE_FIELDS && res.status === 409) {
        console.error(`[push-relay] heartbeat lease rejected for server=${SERVER_ID}, instance=${RELAY_INSTANCE_ID}: ${body}`);
        return;
      }
      throw new Error(`status ${res.status} ${body}`.trim());
    }
  } catch (e) {
    console.error(`[push-relay] heartbeat failed: ${e.message}`);
  }
}

async function sendOfflineNotice(reason = 'push-relay-shutdown') {
  const body = { reason };
  if (PUSH_RELAY_INCLUDE_LEASE_FIELDS) {
    body.instanceId = RELAY_INSTANCE_ID;
    body.bootTs = RELAY_BOOT_TS;
  }
  try {
    await postJson(`/api/servers/${encodeURIComponent(SERVER_ID)}/offline`, body);
  } catch (e) {
    console.error(`[push-relay] offline notice failed: ${e.message}`);
  }
}

async function collectMcpSessions() {
  if (!TMUX_BIN) return new Set();
  try {
    const paneOut = runTmux(['list-panes', '-a', '-F', '#{pane_tty} #{session_name}'], { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
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
      const { stdout } = await execFileAsyncImpl('pgrep', ['-f', 'node.*mcp-server.js'], {
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      pids = stdout.trim().split('\n').filter(Boolean);
    } catch {
      return new Set();
    }
    const matched = new Set();
    if (!pids.length) return matched;
    try {
      const { stdout } = await execFileAsyncImpl('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], {
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const session = ptsMap[match[2].trim()];
        if (session) matched.add(session);
      }
    } catch {
      // pid batch vanished
    }
    return matched;
  } catch {
    // tmux unavailable
    return new Set();
  }
}

async function getMcpSessionSet(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && (now - mcpSessionCacheAt) <= MCP_SESSION_CACHE_TTL_MS) return mcpSessionCache;
  mcpSessionCache = await collectMcpSessions();
  mcpSessionCacheAt = now;
  return mcpSessionCache;
}

async function agentHasMcp(agentName) {
  if (!agentName) return false;
  return (await getMcpSessionSet(false)).has(agentName);
}

function sanitizeForDisplay(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

async function buildNotification(agentName, msg) {
  const hasMcp = await agentHasMcp(agentName);
  const replyTo = msg.from;
  const isHuman = msg.type === 'human';
  const needsReply = msg.type === 'human' || msg.type === 'request';
  const safeSummary = sanitizeForDisplay(msg.summary);
  const isMatrix = msg.source === 'matrix';
  const isOperator = msg.trustLevel === 'operator';
  const humanTag = isHuman ? (isMatrix && !isOperator ? ' (via Matrix)' : ' (human)') : '';
  const operatorHint = isHuman && (isOperator || !isMatrix) ? ' This is your human operator.' : '';
  if (hasMcp) {
    const checkHint = 'FIRST ACTION: call check_inbox() now. Use check_inbox() in agent-chat MCP for full context before acting.';
    const sendHint = `Reply using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply")`;
    const actionHint = needsReply ? ` ${sendHint}.` : '';
    return isHuman
      ? `[NOTIFICATION] From ${msg.from}${humanTag}: "${safeSummary}".${operatorHint} ${checkHint}${actionHint}`
      : `[NOTIFICATION] From ${msg.from}: "${safeSummary}". ${checkHint}${actionHint}`;
  }

  const senderAgent = agentsByName.get(replyTo);
  const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
  const replyHint = `Reply using /agent-message skill or: agent-send ${senderTmux} "<your reply>"`;
  const actionHint = needsReply ? ` ${replyHint}.` : '';
  return isHuman
    ? `[NOTIFICATION] From ${msg.from}${humanTag}: "${safeSummary}".${operatorHint}${actionHint}`
    : `[NOTIFICATION] From ${msg.from}: "${safeSummary}".${actionHint}`;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pushToTmux(target, payload) {
  if (!TMUX_BIN) return false;
  const safePayload = sanitizeForDisplay(payload);
  const opts = { timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] };
  const sendSequence = (resolvedTarget) => {
    runTmux(['send-keys', '-l', '-t', resolvedTarget, safePayload], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', resolvedTarget, 'Tab'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', resolvedTarget, 'Enter'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', resolvedTarget, 'Enter'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', resolvedTarget, 'C-m'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', resolvedTarget, 'C-m'], opts);
  };
  const sessionFallback = String(target || '').split(':', 1)[0];
  try {
    sendSequence(target);
    return true;
  } catch (e) {
    if (sessionFallback && sessionFallback !== target) {
      try {
        sendSequence(sessionFallback);
        console.warn(`[push-relay] tmux inject fallback ${target} -> ${sessionFallback}`);
        return true;
      } catch (fallbackErr) {
        const preview = String(safePayload || '').replace(/\s+/g, ' ').slice(0, 120);
        console.error(`[push-relay] tmux inject failed for ${target} (fallback ${sessionFallback} failed: ${fallbackErr.message}) payload="${preview}"`);
        return false;
      }
    }
    const preview = String(safePayload || '').replace(/\s+/g, ' ').slice(0, 120);
    console.error(`[push-relay] tmux inject failed for ${target}: ${e.message} payload="${preview}"`);
    return false;
  }
}

let pushToTmuxImpl = pushToTmux;

function logDeliverySkip(agentName, msg, reason, extra = {}) {
  const key = `${agentName}:${reason}`;
  const now = Date.now();
  const prev = skipReasonLastLog.get(key) || 0;
  if ((now - prev) < SKIP_LOG_THROTTLE_MS) return;
  skipReasonLastLog.set(key, now);
  const parts = [
    `[push-relay] skip ${msg?.id || 'unknown'} -> ${agentName}`,
    `reason=${reason}`,
  ];
  if (msg?.group) parts.push(`group=${msg.group}`);
  if (msg?.from) parts.push(`from=${msg.from}`);
  if (extra.server) parts.push(`agentServer=${extra.server}`);
  if (extra.target) parts.push(`target=${extra.target}`);
  if (extra.note) parts.push(extra.note);
  console.warn(parts.join(' | '));
}

function evaluateAgentRouting(agentName) {
  if (!localAgents.has(agentName)) return { ok: false, reason: 'local-session-missing', target: `${agentName}:0.0` };
  const registered = agentsByName.get(agentName);
  if (!registered) {
    return { ok: true, reason: 'unregistered-session-compat', server: null, target: `${agentName}:0.0` };
  }
  const agentServer = normalizeServer(registered?.server);
  const target = registered?.tmux || `${agentName}:0.0`;
  if (!agentServer) return { ok: true, reason: 'legacy-no-server', server: null, target };
  if (agentServer === 'local') {
    return { ok: SERVER_ID === 'local', reason: SERVER_ID === 'local' ? 'ok' : 'server-mismatch', server: agentServer, target };
  }
  return { ok: agentServer === SERVER_ID, reason: agentServer === SERVER_ID ? 'ok' : 'server-mismatch', server: agentServer, target };
}

function shouldHandleAgent(agentName) {
  if (!agentName || !localAgents.has(agentName)) return false;
  const route = evaluateAgentRouting(agentName);
  return route.ok === true;
}

function messageRecipients(msg) {
  const recipients = new Set();
  if (msg.to && msg.to !== msg.from) recipients.add(msg.to);
  if (msg.group && Array.isArray(msg.mentions)) {
    for (const m of msg.mentions) {
      if (m && m !== msg.from) recipients.add(m);
    }
  }
  return [...recipients];
}

function markDelivered(key) {
  delivered.add(key);
  deliveredOrder.push(key);
  if (deliveredOrder.length > DELIVERED_CAP) {
    const old = deliveredOrder.shift();
    if (old) delivered.delete(old);
  }
}

function normalizeRelayPriority(msg) {
  const val = msg?.priority;
  if (typeof val !== 'string') return 'normal';
  const p = val.trim().toLowerCase();
  if (p === 'high' || p === 'urgent') return p;
  return 'normal';
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || !msg.id) return;

  for (const agentName of messageRecipients(msg)) {
    const route = evaluateAgentRouting(agentName);
    if (!route.ok) {
      logDeliverySkip(agentName, msg, route.reason, { server: route.server, target: route.target });
      continue;
    }
    const dedupeKey = `${msg.id}:${agentName}`;
    if (delivered.has(dedupeKey)) continue;

    const target = route.target || `${agentName}:0.0`;

    // Idle gate: hold message if agent is actively working (not idle enough)
    const priority = normalizeRelayPriority(msg);
    const bypassIdleGate = priority === 'high' || priority === 'urgent';
    if (!bypassIdleGate) {
      const metrics = computeActivityMetrics(agentName, target);
      if (metrics && metrics.activeNow) {
        // Agent is active — queue for later delivery
        const notification = await buildNotification(agentName, msg);
        if (!relayQueue.has(agentName)) relayQueue.set(agentName, []);
        relayQueue.get(agentName).push({ msg, notification, target, dedupeKey, queuedAt: Date.now() });
        console.log(`[push-relay] queued ${msg.id} -> ${agentName} (agent active, priority=${priority})`);
        continue;
      }
    }

    const notification = await buildNotification(agentName, msg);
    if (pushToTmuxImpl(target, notification)) {
      markDelivered(dedupeKey);
      console.log(`[push-relay] delivered ${msg.id} -> ${agentName}`);
    } else {
      logDeliverySkip(agentName, msg, 'tmux-inject-failed', { server: route.server, target });
    }
  }
}

function drainRelayQueue() {
  const now = Date.now();
  for (const [agentName, entries] of relayQueue) {
    // Drop stale entries first
    while (entries.length > 0 && (now - entries[0].queuedAt) > RELAY_QUEUE_MAX_AGE_MS) {
      const stale = entries.shift();
      console.log(`[push-relay] dropped stale queued ${stale.msg.id} -> ${agentName} (age=${now - stale.queuedAt}ms)`);
    }
    if (entries.length === 0) { relayQueue.delete(agentName); continue; }

    // Check if agent is now idle enough
    const { target } = entries[0];
    const metrics = computeActivityMetrics(agentName, target);
    if (metrics && metrics.activeNow) continue; // still active, keep holding

    // Agent is idle (or metrics unavailable) — deliver all queued messages
    while (entries.length > 0) {
      const entry = entries.shift();
      if (delivered.has(entry.dedupeKey)) continue;
      if (pushToTmuxImpl(entry.target, entry.notification)) {
        markDelivered(entry.dedupeKey);
        console.log(`[push-relay] delivered queued ${entry.msg.id} -> ${agentName} (held ${now - entry.queuedAt}ms)`);
      } else {
        console.log(`[push-relay] queued delivery failed ${entry.msg.id} -> ${agentName}`);
      }
    }
    relayQueue.delete(agentName);
  }
}

let currentEs = null;
function connectSse() {
  // Clean up previous connection (timers, socket)
  if (currentEs) { try { currentEs.close(); } catch (_) {} currentEs = null; }
  const streamUrl = `${API_BASE}/api/stream`;
  console.log(`[push-relay] connecting ${streamUrl} (server=${SERVER_ID})`);
  const es = new EventSource(streamUrl, { headers: authHeaders });
  currentEs = es;
  es.on('message', (raw) => {
    handleMessage(raw).catch((e) => console.error(`[push-relay] message handling failed: ${e.message}`));
  });
  es.on('error', (e) => {
    console.error(`[push-relay] SSE error: ${e.message}`);
    if (currentEs === es) { try { es.close(); } catch (_) {} currentEs = null; }
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSse();
    }, RECONNECT_MS);
  });
}

async function main() {
  await refreshAgentsSnapshot();
  await sendHeartbeat();
  await scanBlockedStates();
  setInterval(() => {
    refreshAgentsSnapshot()
      .then(() => scanBlockedStates())
      .catch((e) => console.error(`[push-relay] refresh failed: ${e.message}`));
  }, SCAN_INTERVAL_MS);
  heartbeatTimer = setInterval(() => {
    refreshAgentsSnapshot()
      .then(() => sendHeartbeat())
      .catch((e) => console.error(`[push-relay] heartbeat loop failed: ${e.message}`));
  }, HEARTBEAT_INTERVAL_MS);
  setInterval(() => {
    scanBlockedStates()
      .catch((e) => console.error(`[push-relay] block scan failed: ${e.message}`));
  }, BLOCK_SCAN_INTERVAL_MS);
  relayQueueDrainTimer = setInterval(() => {
    try { drainRelayQueue(); } catch (e) { console.error(`[push-relay] queue drain failed: ${e.message}`); }
  }, RELAY_QUEUE_DRAIN_INTERVAL_MS);
  connectSse();
}

let bootstrapRetryTimer = null;
function scheduleBootstrapRetry(reason = 'unknown') {
  if (bootstrapRetryTimer) return;
  console.error(`[push-relay] bootstrap failed (${reason}); retrying in ${RECONNECT_MS}ms`);
  bootstrapRetryTimer = setTimeout(() => {
    bootstrapRetryTimer = null;
    main().catch((e) => scheduleBootstrapRetry(e?.message || 'bootstrap-error'));
  }, RECONNECT_MS);
}

async function gracefulExit(signal) {
  if (relayQueueDrainTimer) clearInterval(relayQueueDrainTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.log(`[push-relay] received ${signal}, marking server offline`);
  await sendOfflineNotice(signal);
  process.exit(0);
}

function resetRelayState() {
  localAgents.clear();
  agentsByName.clear();
  delivered.clear();
  deliveredOrder.length = 0;
  blockedState.clear();
  compactState.clear();
  activityState.clear();
  runtimeReportDigest.clear();
  skipReasonLastLog.clear();
  autoClearLastTs.clear();
  mcpMissCount.clear();
  mcpSessionCacheAt = 0;
  mcpSessionCache = new Set();
  relayQueue.clear();
  execFileAsyncImpl = execFileAsync;
  pushToTmuxImpl = pushToTmux;
}

function seedRelayState({ localAgentNames = [], agents = [], mcpSessions = [] } = {}) {
  localAgents.clear();
  for (const name of localAgentNames) localAgents.add(name);
  agentsByName.clear();
  for (const agent of agents) {
    if (agent?.name) agentsByName.set(agent.name, agent);
  }
  mcpSessionCache = new Set(mcpSessions);
  mcpSessionCacheAt = Date.now();
}

function setPushToTmuxForTest(fn) {
  pushToTmuxImpl = typeof fn === 'function' ? fn : pushToTmux;
}

function setPushRelayTestHooks({ execFileAsync: overrideExecFileAsync } = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : execFileAsync;
  mcpSessionCacheAt = 0;
}

export {
  BLOCK_PATTERNS,
  buildNotification,
  detectBlockedReason,
  drainRelayQueue,
  evaluateAgentRouting,
  handleMessage,
  main,
  messageRecipients,
  normalizeRelayPriority,
  relayQueue,
  resetRelayState,
  scanBlockedStates,
  seedRelayState,
  setPushRelayTestHooks,
  setPushToTmuxForTest,
};

process.on('SIGTERM', () => { gracefulExit('SIGTERM'); });
process.on('SIGINT', () => { gracefulExit('SIGINT'); });
process.on('unhandledRejection', (reason) => {
  const msg = reason && typeof reason === 'object' && 'message' in reason
    ? reason.message
    : String(reason);
  console.error(`[push-relay] unhandled rejection: ${msg}`);
});

if (process.argv[1] === __filename) {
  main().catch((e) => scheduleBootstrapRetry(e?.message || 'startup-error'));
}
