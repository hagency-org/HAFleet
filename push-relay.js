#!/usr/bin/env node
import { execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import EventSource from './lib/eventsource-mini.js';

const API_BASE = (process.env.AGENT_CHAT_API || 'http://127.0.0.1:8090').replace(/\/$/, '');
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const SERVER_ID = (process.env.AGENT_CHAT_SERVER || os.hostname()).trim();
const SCAN_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_SCAN_INTERVAL_MS || '30000', 10);
const RECONNECT_MS = Number.parseInt(process.env.PUSH_RELAY_RECONNECT_MS || '5000', 10);
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_HEARTBEAT_INTERVAL_MS || '15000', 10);
const INJECT_DELAY_MS = Number.parseInt(process.env.PUSH_RELAY_INJECT_DELAY_MS || '300', 10);
const BLOCK_SCAN_INTERVAL_MS = Number.parseInt(process.env.PUSH_RELAY_BLOCK_SCAN_INTERVAL_MS || '5000', 10);
const BLOCK_TAIL_LINES = Number.parseInt(process.env.PUSH_RELAY_BLOCK_TAIL_LINES || '40', 10);
const IDLE_THRESHOLD_MS = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || '15000', 10);
const IDLE_THRESHOLD_SEC = Math.max(1, Math.floor((IDLE_THRESHOLD_MS + 999) / 1000));

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
const activityState = new Map();
const runtimeReportDigest = new Map();

const BLOCK_PATTERNS = [
  { reason: 'select-mode', re: /\bselect mode\b/i },
  { reason: 'plan-mode', re: /\bplan mode\b/i },
  { reason: 'approval-mode-toggle', re: /bypass permissions on \(shift\+tab to cycle\)/i },
  { reason: 'update-required', re: /updates?\s+available:|update available.*agent-update|run ['"`]?agent-update/i },
  { reason: 'interactive-confirm', re: /choose (an )?option|press (enter|return) to continue|confirm .*continue/i },
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

  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(tail)) return p.reason;
  }
  return null;
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

async function scanBlockedStates() {
  const live = new Set(localAgents);

  for (const [agentName, prev] of blockedState.entries()) {
    if (live.has(agentName)) continue;
    blockedState.delete(agentName);
    activityState.delete(agentName);
    runtimeReportDigest.delete(agentName);
    await reportRuntime(agentName, {
      blocked: false,
      reason: null,
      tail: '',
      command: '',
      activeNow: false,
      activeDurationSec: 0,
      idleDurationSec: 0,
      lastTmuxActivitySec: null,
    });
  }

  for (const agentName of live) {
    if (!shouldHandleAgent(agentName)) continue;
    const target = agentsByName.get(agentName)?.tmux || `${agentName}:0.0`;
    const paneCmd = currentPaneCommand(target);
    const tail = captureTail(target, BLOCK_TAIL_LINES);
    const reason = detectBlockedReason(tail, paneCmd);
    const blocked = Boolean(reason);
    const prev = blockedState.get(agentName) || { blocked: false, reason: null };
    blockedState.set(agentName, { blocked, reason });

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
    };
    const digest = JSON.stringify({
      blocked: payload.blocked,
      reason: payload.reason || null,
      activeNow: payload.activeNow,
      activeDurationSec: payload.activeDurationSec,
      idleDurationSec: payload.idleDurationSec,
      lastTmuxActivitySec: payload.lastTmuxActivitySec,
    });
    if (runtimeReportDigest.get(agentName) === digest) continue;
    runtimeReportDigest.set(agentName, digest);
    await reportRuntime(agentName, payload);
  }
}

async function sendHeartbeat() {
  const sessions = [...localAgents];
  try {
    const res = await postJson('/api/servers/heartbeat', {
      server: SERVER_ID,
      sessions,
      agents: sessions,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`status ${res.status} ${body}`.trim());
    }
  } catch (e) {
    console.error(`[push-relay] heartbeat failed: ${e.message}`);
  }
}

async function sendOfflineNotice(reason = 'push-relay-shutdown') {
  try {
    await postJson(`/api/servers/${encodeURIComponent(SERVER_ID)}/offline`, { reason });
  } catch (e) {
    console.error(`[push-relay] offline notice failed: ${e.message}`);
  }
}

function agentHasMcp(agentName) {
  if (!TMUX_BIN) return false;
  try {
    const paneOut = runTmux(['list-panes', '-a', '-F', '#{pane_tty} #{session_name}'], { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
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
      } catch {
        // pid vanished
      }
    }
  } catch {
    // tmux unavailable
  }
  return false;
}

function buildNotification(agentName, msg) {
  const hasMcp = agentHasMcp(agentName);
  const replyTo = msg.from;
  const isHuman = msg.type === 'human';
  const needsReply = msg.type === 'human' || msg.type === 'request';
  if (hasMcp) {
    const checkHint = 'Use check_inbox() in agent-chat MCP for full context.';
    const sendHint = `Reply using the agent-chat MCP tool: send_message(to="${replyTo}", summary="your reply", full="detailed reply")`;
    const actionHint = needsReply ? ` ${sendHint}.` : '';
    return isHuman
      ? `[NOTIFICATION] From ${msg.from} (human): "${msg.summary}". This is your human operator. ${checkHint}${actionHint}`
      : `[NOTIFICATION] From ${msg.from}: "${msg.summary}". ${checkHint}${actionHint}`;
  }

  const senderAgent = agentsByName.get(replyTo);
  const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
  const replyHint = `Reply using /agent-message skill or: agent-send ${senderTmux} "<your reply>"`;
  const actionHint = needsReply ? ` ${replyHint}.` : '';
  return isHuman
    ? `[NOTIFICATION] From ${msg.from} (human): "${msg.summary}". This is your human operator.${actionHint}`
    : `[NOTIFICATION] From ${msg.from}: "${msg.summary}".${actionHint}`;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pushToTmux(target, payload) {
  if (!TMUX_BIN) return false;
  const opts = { timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] };
  try {
    runTmux(['send-keys', '-l', '-t', target, payload], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'Tab'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'Enter'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'Enter'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'C-m'], opts);
    sleepMs(INJECT_DELAY_MS);
    runTmux(['send-keys', '-t', target, 'C-m'], opts);
    return true;
  } catch (e) {
    console.error(`[push-relay] tmux inject failed for ${target}: ${e.message}`);
    return false;
  }
}

function shouldHandleAgent(agentName) {
  if (!localAgents.has(agentName)) return false;
  const registered = agentsByName.get(agentName);
  const agentServer = normalizeServer(registered?.server);
  if (!agentServer) return true; // compatibility for old registrations
  if (agentServer === 'local') return SERVER_ID === 'local';
  return agentServer === SERVER_ID;
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

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || !msg.id) return;

  for (const agentName of messageRecipients(msg)) {
    if (!shouldHandleAgent(agentName)) continue;
    const dedupeKey = `${msg.id}:${agentName}`;
    if (delivered.has(dedupeKey)) continue;

    const target = agentsByName.get(agentName)?.tmux || `${agentName}:0.0`;
    const notification = buildNotification(agentName, msg);
    if (pushToTmux(target, notification)) {
      markDelivered(dedupeKey);
      console.log(`[push-relay] delivered ${msg.id} -> ${agentName}`);
    }
  }
}

function connectSse() {
  const streamUrl = `${API_BASE}/api/stream`;
  console.log(`[push-relay] connecting ${streamUrl} (server=${SERVER_ID})`);
  const es = new EventSource(streamUrl, { headers: authHeaders });
  es.on('message', handleMessage);
  es.on('error', (e) => {
    console.error(`[push-relay] SSE error: ${e.message}`);
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
  connectSse();
}

async function gracefulExit(signal) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.log(`[push-relay] received ${signal}, marking server offline`);
  await sendOfflineNotice(signal);
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulExit('SIGTERM'); });
process.on('SIGINT', () => { gracefulExit('SIGINT'); });

main().catch((e) => {
  console.error(`[push-relay] fatal: ${e.message}`);
  process.exit(1);
});
