import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';
import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import EventSource from './lib/eventsource-mini.js';
import BotCommands from './lib/bot-commands.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.AGENT_CHAT_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
// ── Configuration ─────────────────────────────────────────────────────
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.ananthe.party';
const REGISTRATION_TOKEN = (process.env.MATRIX_REG_TOKEN || '').trim();
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const BACKEND_URL = (process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).trim().replace(/\/$/, '');
const BACKEND_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_FETCH_TIMEOUT_MS || '12000', 10);
const BACKEND_FETCH_TIMEOUT_MS = Number.isFinite(BACKEND_FETCH_TIMEOUT_MS_RAW) && BACKEND_FETCH_TIMEOUT_MS_RAW > 0
  ? BACKEND_FETCH_TIMEOUT_MS_RAW
  : 12000;
const BACKEND_FETCH_RETRY_DELAY_MS_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_FETCH_RETRY_DELAY_MS || '2500', 10);
const BACKEND_FETCH_RETRY_DELAY_MS = Number.isFinite(BACKEND_FETCH_RETRY_DELAY_MS_RAW) && BACKEND_FETCH_RETRY_DELAY_MS_RAW > 0
  ? BACKEND_FETCH_RETRY_DELAY_MS_RAW
  : 2500;
const MSG_BASE_URL = process.env.MSG_BASE_URL || 'https://agent.ananthe.party/msg';
const BOT_USERNAME = (process.env.MATRIX_BOT_USERNAME || 'agent-bridge').trim();
const BOT_PASSWORD = (process.env.MATRIX_BOT_PASSWORD || '').trim();
const AGENT_PREFIX = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim(); // Matrix usernames: ac_agentname
const MATRIX_SERVER_NAME = (process.env.MATRIX_SERVER_NAME || new URL(HOMESERVER).host).trim();
const AGENT_PASSWORD_SECRET = (process.env.MATRIX_AGENT_PASSWORD_SECRET || '').trim();
const AGENT_PASSWORD_TEMPLATE = (process.env.MATRIX_AGENT_PASSWORD_TEMPLATE || '').trim();
const ALLOW_LEGACY_AGENT_PASSWORD = (process.env.MATRIX_ALLOW_LEGACY_AGENT_PASSWORD || 'false').trim().toLowerCase() === 'true';
const AUTO_AVATAR_ENABLED = (process.env.MATRIX_AUTO_AVATAR || 'false').trim().toLowerCase() === 'true';
const DATA_DIR = path.join(RUNTIME_ROOT, 'data', 'matrix');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const AGENT_META_ROOT = path.join(RUNTIME_ROOT, 'data', 'agents');
const AGENT_AVATAR_STYLE_VERSION = 2;
const OWNER_LOCK_PATH = path.join(DATA_DIR, 'bridge-owner.lock');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(MEDIA_DIR, { recursive: true });

function safeReadJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function detectLauncherTag() {
  if (String(process.env.TMUX || '').trim()) return 'tmux';
  if (String(process.env.JOURNAL_STREAM || '').trim() || String(process.env.INVOCATION_ID || '').trim()) return 'systemd';
  return 'unknown';
}

function readProcCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\u0000/g, ' ').trim();
  } catch {
    return null;
  }
}

function readProcCwd(pid) {
  try {
    return path.resolve(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return null;
  }
}

function isLiveBridgeOwner(meta) {
  const pid = Number(meta?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const cmdline = readProcCmdline(pid);
  if (!cmdline || !cmdline.includes('bridge-matrix.js')) return false;
  const ownerRuntimeRoot = typeof meta?.runtimeRoot === 'string' ? path.resolve(meta.runtimeRoot) : null;
  return !ownerRuntimeRoot || ownerRuntimeRoot === RUNTIME_ROOT;
}

function summarizeOwner(meta) {
  if (!meta || typeof meta !== 'object') return 'unknown owner';
  const pid = Number.isInteger(Number(meta.pid)) ? Number(meta.pid) : null;
  const launcher = typeof meta.launcher === 'string' ? meta.launcher : 'unknown';
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : 'unknown';
  const startedAt = typeof meta.startedAt === 'string' ? meta.startedAt : 'unknown';
  return `pid=${pid ?? 'unknown'} launcher=${launcher} cwd=${cwd} startedAt=${startedAt}`;
}

function writeOwnerLock(fd, meta) {
  writeFileSync(fd, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

function buildOwnerLockMeta() {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    procCwd: readProcCwd(process.pid),
    runtimeRoot: RUNTIME_ROOT,
    hostname: os.hostname(),
    launcher: detectLauncherTag(),
  };
}

function acquireBridgeOwnership() {
  const ownerMeta = buildOwnerLockMeta();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = openSync(OWNER_LOCK_PATH, 'wx');
      writeOwnerLock(fd, ownerMeta);
      closeSync(fd);
      return ownerMeta;
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      const existing = safeReadJsonFile(OWNER_LOCK_PATH, null);
      if (isLiveBridgeOwner(existing)) {
        throw new Error(`duplicate bridge owner for runtime root ${RUNTIME_ROOT}; existing ${summarizeOwner(existing)}`);
      }
      try {
        unlinkSync(OWNER_LOCK_PATH);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
      console.warn(`[bridge-owner-lock] recovered stale owner lock for runtime root ${RUNTIME_ROOT}`);
    }
  }
  throw new Error(`failed to acquire bridge owner lock for runtime root ${RUNTIME_ROOT}`);
}

function releaseBridgeOwnership(expectedMeta) {
  const existing = safeReadJsonFile(OWNER_LOCK_PATH, null);
  if (!existing || Number(existing?.pid) !== process.pid) return;
  if (expectedMeta && String(existing.runtimeRoot || '') !== String(expectedMeta.runtimeRoot || '')) return;
  try {
    unlinkSync(OWNER_LOCK_PATH);
  } catch {}
}

let bridgeOwnerMeta = null;
try {
  bridgeOwnerMeta = acquireBridgeOwnership();
} catch (error) {
  console.error(`[bridge-owner-lock] startup rejected: ${error?.message || error}`);
  process.exit(1);
}
process.on('exit', () => releaseBridgeOwnership(bridgeOwnerMeta));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseBridgeOwnership(bridgeOwnerMeta);
    process.exit(0);
  });
}

// ── State persistence ─────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, 'bridge-state.json'), 'utf-8'));
  } catch {
    return { botToken: null, agentTokens: {}, roomGroupMap: {}, groupRoomMap: {} };
  }
}
function saveState() {
  writeFileSync(path.join(DATA_DIR, 'bridge-state.json'), JSON.stringify(state, null, 2));
}
const state = loadState();
if (!state.agentAvatars) state.agentAvatars = {};
if (!state.roomAvatars) state.roomAvatars = {};
if (!state.agentAvatarMeta) state.agentAvatarMeta = {};

function normalizeNameKey(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

function findCaseInsensitiveKey(record, name) {
  const key = normalizeNameKey(name);
  if (!key) return null;
  for (const existing of Object.keys(record || {})) {
    if (normalizeNameKey(existing) === key) return existing;
  }
  return null;
}

function resolveStoredAgentTokenName(agentName) {
  if (typeof agentName !== 'string') return null;
  const trimmed = agentName.trim();
  if (!trimmed) return null;
  if (Object.prototype.hasOwnProperty.call(state.agentTokens, trimmed)) return trimmed;
  return findCaseInsensitiveKey(state.agentTokens || {}, trimmed);
}

function isTimeoutAbortError(error) {
  const message = String(error?.message || '');
  return error?.name === 'TimeoutError'
    || (error?.name === 'AbortError' && /timeout/i.test(message))
    || /aborted due to timeout/i.test(message);
}

async function getJoinedRoomMembersWithTrace(botClient, roomId, contextLabel) {
  const startedAt = Date.now();
  try {
    return await botClient.getJoinedRoomMembers(roomId);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const prefix = isTimeoutAbortError(error) ? '[bridge-matrix-timeout]' : '[bridge-matrix-fetch-failed]';
    console.error(`${prefix} ${contextLabel} room=${roomId} after ${elapsedMs}ms: ${error?.message || error}`);
    throw error;
  }
}

function getStoredAgentToken(agentName) {
  const key = resolveStoredAgentTokenName(agentName);
  return key ? (state.agentTokens[key] || null) : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENT_PREFIX_RE = escapeRegex(AGENT_PREFIX);

if (!BOT_PASSWORD) {
  console.warn('MATRIX_BOT_PASSWORD is not set. Bridge can run with cached token, but re-login will fail if token expires.');
}
if (!AGENT_PASSWORD_SECRET && !ALLOW_LEGACY_AGENT_PASSWORD) {
  console.warn('MATRIX_AGENT_PASSWORD_SECRET is not set and legacy fallback is disabled. New agent account login/register will fail.');
}
if (ALLOW_LEGACY_AGENT_PASSWORD) {
  if (!AGENT_PASSWORD_TEMPLATE) {
    console.warn('MATRIX_ALLOW_LEGACY_AGENT_PASSWORD=true but MATRIX_AGENT_PASSWORD_TEMPLATE is empty. Legacy fallback is effectively disabled.');
  } else {
    console.warn('MATRIX_ALLOW_LEGACY_AGENT_PASSWORD=true enabled. This keeps compatibility but is less secure.');
  }
}
if (!AUTO_AVATAR_ENABLED) {
  console.warn('MATRIX_AUTO_AVATAR is disabled. Automatic avatar generation/sync is off; use agent-chat-cli avatar <name> <image-file> for manual updates.');
}

function makeUserId(localpart) {
  return `@${localpart}:${MATRIX_SERVER_NAME}`;
}

function agentUserId(name) {
  return makeUserId(`${AGENT_PREFIX}${name}`);
}

function humanUserId(name) {
  return makeUserId(name);
}

function deriveAgentPassword(agentName) {
  if (!AGENT_PASSWORD_SECRET) return null;
  return createHash('sha256')
    .update(`${AGENT_PASSWORD_SECRET}:${agentName}`)
    .digest('hex');
}

function legacyAgentPassword(agentName) {
  if (!AGENT_PASSWORD_TEMPLATE) return null;
  return AGENT_PASSWORD_TEMPLATE
    .replace(/\{name\}/g, agentName)
    .replace(/\$\{name\}/g, agentName);
}

function agentPasswordCandidates(agentName) {
  const out = [];
  const derived = deriveAgentPassword(agentName);
  if (derived) out.push(derived);
  if (ALLOW_LEGACY_AGENT_PASSWORD) out.push(legacyAgentPassword(agentName));
  return [...new Set(out.filter(Boolean))];
}

async function tryMatrixLogin(username, passwords) {
  let lastErr = null;
  for (const pwd of passwords) {
    try {
      const data = await matrixLogin(username, pwd);
      return { data, password: pwd };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`No usable password candidates for Matrix account '${username}'.`);
}

// ── Matrix account management ─────────────────────────────────────────
async function matrixRegister(username, password) {
  if (!REGISTRATION_TOKEN) {
    throw new Error('MATRIX_REG_TOKEN is required to register Matrix accounts.');
  }
  // Step 1: get session
  const probe = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const probeData = await probe.json();
  const session = probeData.session;
  if (!session) throw new Error(`No session in registration probe: ${JSON.stringify(probeData)}`);

  // Step 2: register with token
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      auth: { type: 'm.login.registration_token', token: REGISTRATION_TOKEN, session },
    }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Registration failed for ${username}: ${JSON.stringify(data)}`);
}

async function matrixLogin(username, password) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Login failed for ${username}: ${JSON.stringify(data)}`);
}

async function ensureBotAccount() {
  if (state.botToken) {
    try {
      const client = new MatrixClient(HOMESERVER, state.botToken, new SimpleFsStorageProvider(path.join(DATA_DIR, 'bot-store.json')));
      await client.getUserId();
      return state.botToken;
    } catch { /* token expired, re-login */ }
  }
  if (!BOT_PASSWORD) {
    throw new Error('MATRIX_BOT_PASSWORD is required to login/register bridge bot account.');
  }
  try {
    const data = await matrixLogin(BOT_USERNAME, BOT_PASSWORD);
    state.botToken = data.access_token;
    saveState();
    console.log(`Bot logged in as ${data.user_id}`);
    return data.access_token;
  } catch {
    const data = await matrixRegister(BOT_USERNAME, BOT_PASSWORD);
    state.botToken = data.access_token;
    saveState();
    console.log(`Bot registered as ${data.user_id}`);
    return data.access_token;
  }
}

async function ensureAgentAccount(agentName) {
  const canonicalAgentName = resolveStoredAgentTokenName(agentName) || agentName;
  const matrixUsername = `${AGENT_PREFIX}${canonicalAgentName}`;

  const existingToken = getStoredAgentToken(canonicalAgentName);
  if (existingToken) {
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${existingToken}` },
      });
      if (res.ok) return existingToken;
    } catch { /* re-login */ }
  }

  const passwords = agentPasswordCandidates(canonicalAgentName);
  if (passwords.length === 0) {
    throw new Error(`No agent password configured for '${canonicalAgentName}'. Set MATRIX_AGENT_PASSWORD_SECRET (recommended), or enable MATRIX_ALLOW_LEGACY_AGENT_PASSWORD=true for migration.`);
  }

  try {
    const { data } = await tryMatrixLogin(matrixUsername, passwords);
    state.agentTokens[canonicalAgentName] = data.access_token;
    saveState();
    return data.access_token;
  } catch {
    const data = await matrixRegister(matrixUsername, passwords[0]);
    state.agentTokens[canonicalAgentName] = data.access_token;
    saveState();
    console.log(`Registered Matrix account for agent: ${canonicalAgentName} → ${agentUserId(canonicalAgentName)}`);
    // Set display name
    await setDisplayName(data.access_token, canonicalAgentName);
    return data.access_token;
  }
}

async function setDisplayName(token, agentName) {
  const userId = await getUserId(token);
  await fetch(`${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayname: `🤖 ${agentName}` }),
  });
}

async function getUserId(token) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.user_id;
}

// ── Avatar generation & upload ────────────────────────────────────────
function nameToHue(name) {
  const hash = createHash('md5').update(name).digest();
  return (hash[0] + hash[1] * 256) % 360;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadAgentMeta(agentName) {
  const metaPath = path.join(AGENT_META_ROOT, agentName, 'meta.json');
  if (!existsSync(metaPath)) return null;
  return safeReadJson(metaPath);
}

function resolveAgentProjectIcon(agentName) {
  const meta = loadAgentMeta(agentName);
  const rawPath = (typeof meta?.path === 'string') ? meta.path.trim() : '';
  if (!rawPath) return { meta, iconPath: null };

  const projectPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
  const candidates = [
    'favicon.ico',
    'favicon.png',
    'favicon.svg',
    'public/favicon.ico',
    'public/favicon.png',
    'public/favicon.svg',
    'public/icon.png',
    'public/icon.svg',
    'app/favicon.ico',
    'app/icon.png',
    'app/icon.svg',
    'src/assets/favicon.png',
    'src/assets/favicon.svg',
    'static/favicon.ico',
    'static/favicon.png',
  ];
  for (const rel of candidates) {
    const fp = path.join(projectPath, rel);
    if (existsSync(fp)) return { meta, iconPath: fp };
  }
  return { meta, iconPath: null };
}

function normalizeBadge(text, fallback = 'AGENT') {
  const raw = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw ? raw.slice(0, 8) : fallback;
}

function deriveAgentBadge(agentName, agentInfo, meta) {
  const hint = [agentName, agentInfo?.role, agentInfo?.identity].filter(Boolean).join(' ');
  if (/\bweb\b/i.test(hint)) return 'WEB';
  if (/\bbacktest\b/i.test(hint)) return 'BT';
  if (/\bworker\b/i.test(hint)) return 'WORKER';
  if (/\bdev(eloper)?\b/i.test(hint)) return 'DEV';

  const typeHint = String(meta?.type || agentInfo?.type || '').toLowerCase();
  if (typeHint.includes('codex')) return 'CODEX';
  if (typeHint.includes('claude')) return 'CLAUDE';
  return 'AGENT';
}

async function fetchAgentInfo(agentName) {
  try {
    const info = await backendApi('GET', `/api/agents/${encodeURIComponent(agentName)}`);
    if (info && !info.error) return info;
  } catch {}
  return null;
}

function renderAvatarBaseSvg(name, badge) {
  const hue = nameToHue(name);
  const hue2 = (hue + 38) % 360;
  const letter = escapeXml((name.match(/[a-zA-Z0-9]/) || ['?'])[0].toUpperCase());
  const badgeText = escapeXml(normalizeBadge(badge));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 74%, 46%)"/>
      <stop offset="100%" stop-color="hsl(${hue2}, 72%, 34%)"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="42" fill="url(#bg)"/>
  <circle cx="128" cy="104" r="74" fill="rgba(255,255,255,0.20)"/>
  <circle cx="128" cy="104" r="68" fill="rgba(255,255,255,0.94)"/>
  <text x="128" y="104" dy="0.36em" text-anchor="middle"
    font-family="Arial,Helvetica,sans-serif" font-weight="700"
    font-size="88" fill="rgba(0,0,0,0.42)">${letter}</text>
  <rect x="44" y="188" width="168" height="40" rx="20" fill="rgba(0,0,0,0.36)"/>
  <text x="128" y="208" dy="0.36em" text-anchor="middle"
    font-family="Arial,Helvetica,sans-serif" font-weight="700"
    font-size="24" fill="rgba(255,255,255,0.97)">${badgeText}</text>
</svg>`;
}

function generateAvatarPng(name, options = {}) {
  const badge = options.badge || 'AGENT';
  const iconPath = options.iconPath || null;
  const baseSvg = renderAvatarBaseSvg(name, badge);
  if (!iconPath) {
    return execFileSync('convert', ['svg:-', '-resize', '256x256', 'png:-'], {
      input: Buffer.from(baseSvg),
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  try {
    return execFileSync(
      'convert',
      [
        'svg:-',
        '(',
        `${iconPath}[0]`,
        '-resize', '124x124',
        '-background', 'none',
        '-gravity', 'center',
        '-extent', '124x124',
        ')',
        '-gravity', 'center',
        '-geometry', '+0-22',
        '-compose', 'over',
        '-composite',
        'png:-',
      ],
      {
        input: Buffer.from(baseSvg),
        maxBuffer: 8 * 1024 * 1024,
      }
    );
  } catch (e) {
    console.warn(`Icon avatar render failed for ${name} (${iconPath}): ${e.message}`);
    return execFileSync('convert', ['svg:-', '-resize', '256x256', 'png:-'], {
      input: Buffer.from(baseSvg),
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

async function uploadMedia(token, buffer, mimeType) {
  const res = await fetch(`${HOMESERVER}/_matrix/media/v3/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Media upload failed: ${res.status}`);
  const data = await res.json();
  return data.content_uri;
}

async function setUserAvatar(token, mxcUri) {
  const userId = await getUserId(token);
  await fetch(`${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/avatar_url`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar_url: mxcUri }),
  });
}

async function setRoomAvatar(roomId, mxcUri, token) {
  const useToken = token || state.botToken;
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: mxcUri }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // If forbidden with bot token, retry with any agent token that might have power
    if (err.errcode === 'M_FORBIDDEN' && useToken === state.botToken) {
      for (const agentToken of Object.values(state.agentTokens)) {
        const retry = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: mxcUri }),
        });
        if (retry.ok) return;
      }
    }
    throw new Error(`setRoomAvatar failed: ${err.errcode || res.status}`);
  }
}

function parseDmAgentName(roomName) {
  if (typeof roomName !== 'string') return null;
  const m = roomName.match(/^DM:\s*(.+)$/);
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}

async function ensureAgentAvatar(agentName) {
  if (!AUTO_AVATAR_ENABLED) return;
  const canonicalAgentName = resolveStoredAgentTokenName(agentName) || agentName;
  const token = getStoredAgentToken(canonicalAgentName);
  if (!token) return;

  const cached = state.agentAvatarMeta[canonicalAgentName];
  const hasFreshCache = Boolean(state.agentAvatars[canonicalAgentName]) && cached?.style === AGENT_AVATAR_STYLE_VERSION;
  if (hasFreshCache) return;

  try {
    const [agentInfo, iconResult] = await Promise.all([
      fetchAgentInfo(canonicalAgentName),
      Promise.resolve(resolveAgentProjectIcon(canonicalAgentName)),
    ]);
    const badge = normalizeBadge(deriveAgentBadge(canonicalAgentName, agentInfo, iconResult.meta), 'AGENT');
    const png = generateAvatarPng(canonicalAgentName, { badge, iconPath: iconResult.iconPath });
    const mxcUri = await uploadMedia(token, png, 'image/png');
    await setUserAvatar(token, mxcUri);
    state.agentAvatars[canonicalAgentName] = mxcUri;
    state.agentAvatarMeta[canonicalAgentName] = {
      style: AGENT_AVATAR_STYLE_VERSION,
      badge,
      source: iconResult.iconPath ? `project-icon:${path.basename(iconResult.iconPath)}` : 'fallback-letter',
      updatedAt: Date.now(),
    };
    saveState();
    const sourceLabel = state.agentAvatarMeta[canonicalAgentName].source;
    console.log(`Set avatar for agent ${canonicalAgentName}: ${mxcUri} (${sourceLabel}, badge=${badge})`);
    await syncAgentAvatarToDmRooms(canonicalAgentName);
  } catch (e) {
    console.warn(`Failed to set avatar for agent ${canonicalAgentName}: ${e.message}`);
  }
}

async function ensureRoomAvatar(roomId, name) {
  if (!AUTO_AVATAR_ENABLED) return;
  if (!state.botToken) return;

  const dmAgentName = parseDmAgentName(name);
  if (dmAgentName) {
    try {
      await ensureAgentAvatar(dmAgentName);
      const agentAvatar = state.agentAvatars[dmAgentName] || null;
      if (agentAvatar) {
        if (state.roomAvatars[roomId] === agentAvatar) return;
        await setRoomAvatar(roomId, agentAvatar);
        state.roomAvatars[roomId] = agentAvatar;
        saveState();
        console.log(`Set avatar for DM room ${roomId} from agent ${dmAgentName}: ${agentAvatar}`);
        return;
      }
    } catch (e) {
      console.warn(`Failed to sync DM room avatar from agent ${dmAgentName}: ${e.message}`);
    }
  }

  if (state.roomAvatars[roomId]) return;
  try {
    const displayName = name.replace(/^DM:\s*/, '');
    const png = generateAvatarPng(displayName);
    const mxcUri = await uploadMedia(state.botToken, png, 'image/png');
    await setRoomAvatar(roomId, mxcUri);
    state.roomAvatars[roomId] = mxcUri;
    saveState();
    console.log(`Set avatar for room ${roomId} (${name}): ${mxcUri}`);
  } catch (e) {
    console.warn(`Failed to set avatar for room ${roomId} (${name}): ${e.message}`);
  }
}

async function syncAgentAvatarToDmRooms(agentName) {
  const canonicalAgentName = resolveStoredAgentTokenName(agentName) || agentName;
  const mxcUri = state.agentAvatars[canonicalAgentName];
  if (!mxcUri) return;
  const agentToken = getStoredAgentToken(canonicalAgentName);
  const dmRooms = state.dmRooms || {};
  for (const [key, roomId] of Object.entries(dmRooms)) {
    if (!roomId) continue;
    // Match human DM rooms: dm:agentname (new format) or agentname:human (old format)
    if (normalizeNameKey(key) === normalizeNameKey(`dm:${canonicalAgentName}`)) { /* match */ }
    else if (normalizeNameKey(key).startsWith(`${normalizeNameKey(canonicalAgentName)}:`) || normalizeNameKey(key).endsWith(`:${normalizeNameKey(canonicalAgentName)}`)) {
      const parts = key.split(':');
      const other = normalizeNameKey(parts[0]) === normalizeNameKey(canonicalAgentName) ? parts[1] : parts[0];
      if (getStoredAgentToken(other)) continue; // skip agent-to-agent rooms
    } else {
      continue;
    }
    if (state.roomAvatars[roomId] === mxcUri) continue;
    try {
      // Use agent token (room creator has power), fall back to bot
      await setRoomAvatar(roomId, mxcUri, agentToken);
      state.roomAvatars[roomId] = mxcUri;
      console.log(`Synced DM room ${roomId} (${key}) avatar to agent ${canonicalAgentName}`);
    } catch (e) {
      console.warn(`Failed to sync DM room ${roomId} avatar: ${e.message}`);
    }
  }
  saveState();
}

async function setCustomAgentAvatar(agentName, imageBuffer, mimeType) {
  const canonicalAgentName = resolveStoredAgentTokenName(agentName) || agentName;
  const token = getStoredAgentToken(canonicalAgentName);
  if (!token) { console.warn(`No token for agent ${canonicalAgentName}, cannot set custom avatar`); return; }
  try {
    const mxcUri = await uploadMedia(token, imageBuffer, mimeType);
    await setUserAvatar(token, mxcUri);
    state.agentAvatars[canonicalAgentName] = mxcUri;
    saveState();
    console.log(`Set custom avatar for agent ${canonicalAgentName}: ${mxcUri}`);
    await syncAgentAvatarToDmRooms(canonicalAgentName);
  } catch (e) {
    console.warn(`Failed to set custom avatar for agent ${canonicalAgentName}: ${e.message}`);
  }
}

// ── Backend API helpers ───────────────────────────────────────────────
async function backendApi(method, path, body, contextLabel = '') {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS) };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, opts);
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = text ? ` body=${text}` : '';
      throw new Error(`backend API ${method} ${path} failed with HTTP ${res.status}${detail}`);
    }
    return parsed;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const prefix = isTimeoutAbortError(error) ? '[bridge-backend-timeout]' : '[bridge-backend-fetch-failed]';
    const suffix = contextLabel ? ` ${contextLabel}` : '';
    console.error(`${prefix} ${method} ${path}${suffix} after ${elapsedMs}ms: ${error?.message || error}`);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeAgentNameList(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  const seen = new Set();
  for (const row of payload) {
    const name = typeof row === 'string'
      ? row.trim()
      : (typeof row?.name === 'string' ? row.name.trim() : '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ── Room ↔ Group mapping ─────────────────────────────────────────────
function mapRoom(roomId, groupName) {
  const prevGroup = state.roomGroupMap[roomId];
  if (prevGroup && prevGroup !== groupName && state.groupRoomMap[prevGroup] === roomId) {
    delete state.groupRoomMap[prevGroup];
  }
  const prevRoom = state.groupRoomMap[groupName];
  if (prevRoom && prevRoom !== roomId && state.roomGroupMap[prevRoom] === groupName) {
    delete state.roomGroupMap[prevRoom];
  }
  state.roomGroupMap[roomId] = groupName;
  state.groupRoomMap[groupName] = roomId;
  saveState();
}

function groupForRoom(roomId) { return state.roomGroupMap[roomId] || null; }
function roomForGroup(groupName) { return state.groupRoomMap[groupName] || null; }

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value);
}

function normalizeMessageText(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function renderMarkdownInline(raw) {
  let text = escapeHtml(normalizeMessageText(raw));
  const codeTokens = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = codeTokens.push(`<code>${code}</code>`) - 1;
    return `@@INL${idx}@@`;
  });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const safeUrl = escapeHtmlAttr(url);
    return `<a href="${safeUrl}">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  return text.replace(/@@INL(\d+)@@/g, (_m, idx) => codeTokens[Number(idx)] || '');
}

function renderMarkdownToMatrixHtml(raw) {
  const normalized = normalizeMessageText(raw);
  const codeBlocks = [];
  const withCodePlaceholders = normalized.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const safeCode = escapeHtml(code).replace(/\n$/, '');
    const langLabel = lang ? `${escapeHtml(lang)}<br>` : '';
    // Mobile Matrix clients can render <code>/<pre> with aggressive colors.
    // Keep fenced blocks as plain escaped lines to preserve readability.
    const html = `${langLabel}${safeCode.replace(/\n/g, '<br>')}`;
    const idx = codeBlocks.push(html) - 1;
    return `@@BLOCK${idx}@@`;
  });

  const lines = withCodePlaceholders.split('\n');
  const out = [];

  for (const line of lines) {
    const blockMatch = line.match(/^@@BLOCK(\d+)@@$/);
    if (blockMatch) {
      out.push(codeBlocks[Number(blockMatch[1])] || '');
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (line.trim().length === 0) {
      out.push('');
      continue;
    }
    if (headingMatch) {
      out.push(`<strong>${renderMarkdownInline(headingMatch[2])}</strong>`);
      continue;
    }
    if (unorderedMatch) {
      out.push(`• ${renderMarkdownInline(unorderedMatch[1])}`);
      continue;
    }
    if (orderedMatch) {
      out.push(`1. ${renderMarkdownInline(orderedMatch[1])}`);
      continue;
    }
    if (quoteMatch) {
      out.push(`&gt; ${renderMarkdownInline(quoteMatch[1])}`);
      continue;
    }
    out.push(renderMarkdownInline(line));
  }

  return out.join('<br>');
}

// ── Extract agent name from Matrix user ID ───────────────────────────
function agentNameFromUserId(userId) {
  // @ac_agentname:<server> → agentname
  const match = userId.match(new RegExp(`^@${AGENT_PREFIX}([^:]+):`));
  return match ? match[1] : null;
}

function humanNameFromUserId(userId) {
  // @overseer:<server> → overseer
  const match = userId.match(/^@([^:]+):/);
  return match ? match[1] : userId;
}

function isAgentUser(userId) {
  return userId.includes(`:`) && userId.startsWith(`@${AGENT_PREFIX}`);
}

// ── Parse mentions from Matrix message ───────────────────────────────
function parseMentions(content, plainBody = null) {
  const mentions = [];

  // 1. Parse m.mentions.user_ids (modern Matrix spec)
  if (content['m.mentions']?.user_ids) {
    for (const userId of content['m.mentions'].user_ids) {
      // @ac_agentname:<server> → agentname
      const agentMatch = userId.match(new RegExp(`^@${AGENT_PREFIX}([^:]+):`));
      if (agentMatch) {
        mentions.push(agentMatch[1]);
      } else {
        // @username:<server> → username (human or other)
        const userMatch = userId.match(/^@([^:]+):/);
        if (userMatch) mentions.push(userMatch[1]);
      }
    }
  }

  // 2. Fallback: parse HTML pills from formatted_body
  if (!mentions.length && content.formatted_body) {
    const hrefRegex = new RegExp(`matrix\\.to/#/@(?:${AGENT_PREFIX_RE})?([a-z0-9_-]+):`, 'gi');
    let match;
    while ((match = hrefRegex.exec(content.formatted_body)) !== null) {
      mentions.push(match[1]);
    }
  }

  // 3. Fallback: plain text @mentions in body
  const body = typeof plainBody === 'string' ? plainBody : content.body;
  if (!mentions.length && body) {
    const atRegex = new RegExp(`@(?:${AGENT_PREFIX_RE})?([a-z0-9_-]+)`, 'gi');
    let match;
    while ((match = atRegex.exec(body)) !== null) {
      mentions.push(match[1]);
    }
  }

  return [...new Set(mentions)];
}

function stripMatrixReplyFallback(body) {
  if (typeof body !== 'string') return '';
  const lines = body.split('\n');
  let idx = 0;
  while (idx < lines.length && lines[idx].startsWith('> ')) idx++;
  if (idx > 0 && idx < lines.length && lines[idx].trim() === '') {
    return lines.slice(idx + 1).join('\n').trim();
  }
  return body.trim();
}

function matrixMxcToHttpUrl(mxcUri) {
  if (typeof mxcUri !== 'string') return null;
  const trimmed = mxcUri.trim();
  if (!trimmed.startsWith('mxc://')) return null;
  const rest = trimmed.slice('mxc://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash >= rest.length - 1) return null;
  const server = rest.slice(0, slash);
  const mediaId = rest.slice(slash + 1);
  return `${HOMESERVER}/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
}

function matrixMxcToClientMediaUrl(mxcUri) {
  if (typeof mxcUri !== 'string') return null;
  const trimmed = mxcUri.trim();
  if (!trimmed.startsWith('mxc://')) return null;
  const rest = trimmed.slice('mxc://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash >= rest.length - 1) return null;
  const server = rest.slice(0, slash);
  const mediaId = rest.slice(slash + 1);
  return `${HOMESERVER}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
}

const EXT_MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

function normalizeMimeType(value) {
  if (typeof value !== 'string') return null;
  const mime = value.trim().toLowerCase();
  if (!mime) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return null;
  return mime;
}

function guessMimeTypeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return EXT_MIME_MAP[ext] || 'application/octet-stream';
}

function inferAttachmentKind(kind, mime, name) {
  if (kind === 'image' || kind === 'file') return kind;
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  const lower = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/.test(lower)) return 'image';
  return 'file';
}

function mediaMetaFromContent(content) {
  const mxc = (typeof content?.url === 'string' && content.url.trim())
    ? content.url.trim()
    : (typeof content?.file?.url === 'string' && content.file.url.trim() ? content.file.url.trim() : null);
  const mime = (typeof content?.info?.mimetype === 'string' && content.info.mimetype.trim())
    ? content.info.mimetype.trim()
    : (typeof content?.filename === 'string' && content.filename.trim() ? content.filename.trim() : null);
  const name = (typeof content?.body === 'string' && content.body.trim()) ? content.body.trim() : 'file';
  const size = Number.parseInt(content?.info?.size, 10);
  return { mxc, mime, name, size };
}

function buildInboundMediaBody(content, label) {
  const { name, mxc, mime, size } = mediaMetaFromContent(content);
  const httpUrl = mxc ? matrixMxcToHttpUrl(mxc) : null;

  const lines = [`[${label}] ${name}`];
  if (mime) lines.push(`MIME: ${mime}`);
  if (Number.isFinite(size) && size > 0) lines.push(`Size: ${size} bytes`);
  if (mxc) lines.push(`MXC: ${mxc}`);
  if (httpUrl) lines.push(`URL (may require Matrix auth): ${httpUrl}`);
  if (content?.file?.url && !httpUrl) {
    lines.push('Note: encrypted Matrix media may require client-side decryption.');
  }
  return lines.join('\n');
}

function buildImageInboundBody(content) {
  return buildInboundMediaBody(content, 'Image');
}

function buildFileInboundBody(content) {
  return buildInboundMediaBody(content, 'File');
}

function parseInboundTextMessage(content) {
  if (!content || typeof content !== 'object') {
    return { skip: true, body: '', replyEventId: null };
  }
  const msgType = typeof content.msgtype === 'string' ? content.msgtype : '';
  const relates = content['m.relates_to'] || {};
  if (relates.rel_type === 'm.replace') {
    // Ignore edit events: they should not create a new agent-chat message.
    return { skip: true, body: '', replyEventId: null };
  }
  const replyEventId = relates?.['m.in_reply_to']?.event_id || null;
  if (msgType === 'm.image') {
    const body = buildImageInboundBody(content);
    return { skip: !body, body, replyEventId };
  }
  if (msgType === 'm.file') {
    const body = buildFileInboundBody(content);
    return { skip: !body, body, replyEventId };
  }
  if (msgType && !['m.text', 'm.notice'].includes(msgType)) {
    return { skip: true, body: '', replyEventId: null };
  }
  const rawBody = typeof content.body === 'string' ? content.body : '';
  const body = replyEventId ? stripMatrixReplyFallback(rawBody) : rawBody.trim();
  return { skip: !body, body, replyEventId };
}

function shouldIgnoreAgentForward(content) {
  const rawBody = typeof content?.body === 'string' ? content.body : '';
  return /^\[agentignore\]/i.test(rawBody);
}

// ── Main bridge class ─────────────────────────────────────────────────
export class MatrixBridge {
  constructor() {
    this.botClient = null;
    this.botUserId = null;
    this.knownAgents = new Set(); // names of known agents
    this.knownAgentIndex = new Map(); // lower-case name -> canonical name
    this.dmRooms = new Map(); // "agent:human" → roomId
    this.upgradedDmRooms = new Set(); // rooms already checked/upgraded this session
    this.recentBridgedIds = new Set(); // prevent echo loops
    this.recentSystemInfoIds = new Set(); // dedupe system_info SSE events
    this.recentAgentCompactIds = new Set(); // dedupe compact SSE events
    this.recentlyCreatedRooms = new Set(); // rooms we just created (suppress echo)
    this.recentMatrixEvents = new Map(); // event_id -> { ts, msgId }
    this.blockedAlertRooms = new Map(); // agent -> Set(roomId)
    this.startupTs = Date.now();
    this.commands = null;
  }

  callBackendApi(method, routePath, body, contextLabel = '') {
    return backendApi(method, routePath, body, contextLabel);
  }

  async fetchKnownAgentNames() {
    const payload = await this.callBackendApi('GET', '/api/agents?view=names');
    return normalizeAgentNameList(payload);
  }

  sleep(ms) {
    return sleep(ms);
  }

  rememberBlockedAlertRoom(agentName, roomId) {
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    const normalizedRoom = (typeof roomId === 'string' && roomId.trim()) ? roomId.trim() : '';
    if (!canonicalAgent || !normalizedRoom) return;
    let rooms = this.blockedAlertRooms.get(canonicalAgent);
    if (!rooms) {
      rooms = new Set();
      this.blockedAlertRooms.set(canonicalAgent, rooms);
    }
    rooms.add(normalizedRoom);
  }

  consumeBlockedAlertRooms(agentName) {
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    if (!canonicalAgent) return [];
    const rooms = this.blockedAlertRooms.get(canonicalAgent);
    this.blockedAlertRooms.delete(canonicalAgent);
    return rooms ? [...rooms] : [];
  }

  normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  nameKey(value) {
    const normalized = this.normalizeName(value);
    return normalized ? normalized.toLowerCase() : '';
  }

  sameName(a, b) {
    const aKey = this.nameKey(a);
    const bKey = this.nameKey(b);
    return Boolean(aKey) && aKey === bKey;
  }

  addKnownAgent(name) {
    const normalized = this.normalizeName(name);
    if (!normalized) return null;
    const key = this.nameKey(normalized);
    const existing = this.knownAgentIndex.get(key);
    if (existing) return existing;
    this.knownAgents.add(normalized);
    this.knownAgentIndex.set(key, normalized);
    return normalized;
  }

  resolveKnownAgentName(name) {
    const normalized = this.normalizeName(name);
    if (!normalized) return null;
    if (this.knownAgents.has(normalized)) return normalized;
    return this.knownAgentIndex.get(this.nameKey(normalized)) || null;
  }

  resolveAgentTokenName(name) {
    const resolvedKnown = this.resolveKnownAgentName(name);
    if (resolvedKnown && Object.prototype.hasOwnProperty.call(state.agentTokens, resolvedKnown)) {
      return resolvedKnown;
    }
    const normalized = this.normalizeName(name);
    if (!normalized) return resolvedKnown;
    if (Object.prototype.hasOwnProperty.call(state.agentTokens, normalized)) return normalized;
    const key = this.nameKey(normalized);
    for (const tokenName of Object.keys(state.agentTokens || {})) {
      if (this.nameKey(tokenName) === key) return tokenName;
    }
    return resolvedKnown;
  }

  // Not a registered agent → human
  isHuman(name) {
    return !this.isKnownAgentName(name);
  }

  // Expose state for bot commands
  getBridgeState() {
    return {
      roomGroupMap: state.roomGroupMap,
      groupRoomMap: state.groupRoomMap,
      dmRooms: state.dmRooms || {},
      agentTokens: Object.fromEntries(Object.keys(state.agentTokens).map(k => [k, '***'])),
    };
  }

  // Expose groupRoomMap for /group command
  get groupRoomMap() { return state.groupRoomMap; }

  getBotToken() { return state.botToken; }
  getAgentToken(name) {
    const tokenName = this.resolveAgentTokenName(name);
    return tokenName ? (state.agentTokens[tokenName] || null) : null;
  }
  isKnownAgentName(name) { return Boolean(this.resolveKnownAgentName(name)); }

  async ensureAgentToken(agentName, context = 'unknown') {
    const normalized = this.normalizeName(agentName);
    if (!normalized) return null;
    const canonical = this.addKnownAgent(normalized) || normalized;
    let token = this.getAgentToken(canonical);
    if (token) return token;
    try {
      await ensureAgentAccount(canonical);
      this.addKnownAgent(canonical);
      token = this.getAgentToken(canonical);
      if (!token) {
        console.warn(`Agent token still missing after ensureAgentAccount for "${canonical}" (context=${context})`);
        return null;
      }
      console.log(`Backfilled Matrix token for agent "${canonical}" (context=${context})`);
      return token;
    } catch (e) {
      console.warn(`Failed to ensure Matrix token for agent "${canonical}" (context=${context}): ${e.message}`);
      return null;
    }
  }

  rememberMatrixEvent(eventId, msgId = null) {
    if (!eventId) return;
    const prev = this.recentMatrixEvents.get(eventId);
    const next = { ts: Date.now(), msgId: msgId || prev?.msgId || null };
    this.recentMatrixEvents.set(eventId, next);

    if (this.recentMatrixEvents.size > 5000) {
      const cutoff = Date.now() - (6 * 60 * 60 * 1000); // 6h
      for (const [eid, meta] of this.recentMatrixEvents.entries()) {
        if (!meta || meta.ts < cutoff) this.recentMatrixEvents.delete(eid);
      }
      if (this.recentMatrixEvents.size > 4500) {
        // Hard cap fallback: drop oldest keys.
        const keep = [...this.recentMatrixEvents.entries()]
          .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
          .slice(0, 3500);
        this.recentMatrixEvents = new Map(keep);
      }
    }
  }

  isDuplicateMatrixEvent(eventId) {
    if (!eventId) return false;
    return this.recentMatrixEvents.has(eventId);
  }

  resolveReplyToMessageId(replyEventId) {
    if (!replyEventId) return null;
    return this.recentMatrixEvents.get(replyEventId)?.msgId || null;
  }

  async cacheInboundMediaToLocal(content) {
    const { mxc, name, mime } = mediaMetaFromContent(content);
    if (!mxc) return null;
    const mediaUrl = matrixMxcToClientMediaUrl(mxc);
    if (!mediaUrl) return null;

    const extByMime = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'image/avif': '.avif',
      'image/heic': '.heic',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/csv': '.csv',
      'application/zip': '.zip',
    };
    const fallbackExt = (() => {
      if (typeof name !== 'string') return '.bin';
      const m = name.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
      return m ? m[0] : '.bin';
    })();
    const ext = extByMime[(mime || '').toLowerCase()] || fallbackExt;

    const authToken = this.getBotToken();
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    try {
      const res = await fetch(mediaUrl, { headers });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const digest = createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const filePath = path.join(MEDIA_DIR, `${Date.now()}-${digest}${ext}`);
      writeFileSync(filePath, buf);
      return filePath;
    } catch (e) {
      console.warn(`Failed to cache Matrix media ${mxc}: ${e.message}`);
      return null;
    }
  }

  async inferReplyMention({ groupName, humanName, replyTo, mentions }) {
    if (!groupName || !replyTo) return null;

    const agentMentions = (mentions || []).filter(name => this.isKnownAgentName(name));
    if (agentMentions.length > 0) return null;

    let replied = null;
    try {
      replied = await backendApi('GET', `/api/messages/${encodeURIComponent(replyTo)}`);
    } catch (e) {
      console.warn(`Reply mention inference failed for ${replyTo}: ${e.message}`);
      return null;
    }
    if (!replied || replied.error) return null;
    if (typeof replied.group === 'string' && replied.group !== groupName) return null;

    const choices = [];
    const seen = new Set();
    const pushChoice = (name, reason) => {
      if (typeof name !== 'string') return;
      const n = name.trim();
      if (!n || n === humanName) return;
      const canonical = this.resolveKnownAgentName(n);
      if (!canonical) return;
      if (seen.has(canonical)) return;
      seen.add(canonical);
      choices.push({ name: canonical, reason });
    };

    pushChoice(replied.from, 'reply_author');

    if (Array.isArray(replied.mentions) && replied.mentions.length === 1) {
      pushChoice(replied.mentions[0], 'reply_single_mention');
    }

    pushChoice(replied.to, 'reply_direct_target');

    if (choices.length === 1) return choices[0];
    if (choices.length > 1) {
      console.warn(`Reply mention inference ambiguous for ${replyTo}: ${choices.map(c => c.name).join(', ')}`);
    }
    return null;
  }

  postWarning(message) {
    backendApi('POST', '/api/system/info', {
      summary: `⚠️ Bridge warning: ${message}`,
      full: '',
    }).catch(e => console.error('Failed to post warning:', e.message));
  }

  async start() {
    console.log('=== Agent Chat Matrix Bridge ===');
    console.log(`Homeserver: ${HOMESERVER}`);
    console.log(`Backend: ${BACKEND_URL}`);

    // 1. Ensure bot account
    const botToken = await ensureBotAccount();
    this.botClient = new MatrixClient(HOMESERVER, botToken, new SimpleFsStorageProvider(path.join(DATA_DIR, 'bot-store.json')));
    AutojoinRoomsMixin.setupOnClient(this.botClient);
    this.botUserId = await this.botClient.getUserId();
    console.log(`Bot: ${this.botUserId}`);

    // 2. Ensure agent accounts for all known agents
    const agents = await this.fetchKnownAgentNames();
    const validAgentNames = new Set();
    const validAgentKeys = new Set();
    for (const agentName of agents) {
      validAgentNames.add(agentName);
      validAgentKeys.add(this.nameKey(agentName));
      await ensureAgentAccount(agentName);
      this.addKnownAgent(agentName);
    }
    // Drop stale tokens that were created for non-agent users.
    let cleanedTokenCount = 0;
    for (const name of Object.keys(state.agentTokens || {})) {
      if (!validAgentNames.has(name) && !validAgentKeys.has(this.nameKey(name))) {
        delete state.agentTokens[name];
        cleanedTokenCount++;
      }
    }
    if (cleanedTokenCount > 0) {
      saveState();
      console.log(`Pruned ${cleanedTokenCount} stale Matrix tokens for non-agent users`);
    }
    console.log(`Agent accounts: ${this.knownAgents.size}`);

    // 3. Set up bot commands
    this.commands = new BotCommands({
      botClient: this.botClient,
      bridge: this,
      botUserId: this.botUserId,
    });

    // 4. Set up Matrix event listeners
    this.botClient.on('room.message', this.onRoomMessage.bind(this));
    this.botClient.on('room.event', this.onRoomEvent.bind(this));

    // 5. Start bot sync
    await this.botClient.start();
    console.log('Bot syncing...');

    // 6. Listen to backend SSE for agent-chat → Matrix
    this.connectSSE();

    // 7. Scan all joined rooms for unmapped groups + backfill avatars
    await this.scanJoinedRooms();
    if (AUTO_AVATAR_ENABLED) {
      await this.backfillAvatars();
    }
    setInterval(() => this.scanJoinedRooms(), 120_000);

    // 8. Periodically check agent accounts for pending invites
    this.pollAgentInvites();
    setInterval(() => this.pollAgentInvites(), 30_000);

    // 8. Poll for new agents and humans
    await this.pollRegistrations();
    setInterval(() => this.pollRegistrations(), 30_000);

    console.log('Bridge running.');
  }

  async pollRegistrations() {
    // Poll new agents from backend
    try {
      const agents = await this.fetchKnownAgentNames();
      const validAgentNames = new Set(agents);
      const validAgentKeys = new Set(agents.map(name => this.nameKey(name)));
      for (const agentName of agents) {
        const wasKnown = this.isKnownAgentName(agentName);
        const canonicalName = this.addKnownAgent(agentName) || this.normalizeName(agentName);
        if (canonicalName && !this.getAgentToken(canonicalName)) {
          await this.ensureAgentToken(canonicalName, 'registration_poll');
        }
        if (!wasKnown) {
          console.log(`Discovered new agent: ${agentName}`);
        }
      }
      let pruned = 0;
      for (const name of Object.keys(state.agentTokens || {})) {
        if (!validAgentNames.has(name) && !validAgentKeys.has(this.nameKey(name))) {
          delete state.agentTokens[name];
          pruned++;
        }
      }
      if (pruned > 0) {
        saveState();
        console.log(`Pruned ${pruned} stale Matrix tokens during registration poll`);
      }
    } catch (e) {
      console.error('Failed to poll agents:', e.message);
    }

    // Discover humans from Matrix user directory and greet them
    await this.discoverAndGreetHumans();
  }

  async discoverAndGreetHumans() {
    if (!state.greetedHumans) state.greetedHumans = [];
    const SKIP_USERS = new Set([BOT_USERNAME, 'conduit']);

    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user_directory/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_term: '', limit: 100 }),
      });
      const data = await res.json();
      if (!data.results) return;

      for (const user of data.results) {
        const match = user.user_id.match(/^@([^:]+):/);
        if (!match) continue;
        const name = match[1];

        // Skip agents, bot, system accounts, underscore-prefixed
        if (name.startsWith(AGENT_PREFIX)) continue;
        if (name.startsWith('_')) continue;
        if (SKIP_USERS.has(name)) continue;
        if (state.greetedHumans.includes(name)) continue;

        // This is an ungreeted human — create DM and greet
        await this.greetHuman(name, user.user_id);
      }
    } catch (e) {
      console.error('Failed to discover humans:', e.message);
    }
  }

  async ensureBotDmRoom(humanName, matrixUserId) {
    if (!state.botDmRooms) state.botDmRooms = {};
    if (state.botDmRooms[humanName]) return state.botDmRooms[humanName];

    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_direct: true,
          invite: [matrixUserId],
          preset: 'trusted_private_chat',
        }),
      });
      const data = await res.json();
      if (data.room_id) {
        state.botDmRooms[humanName] = data.room_id;
        saveState();
        return data.room_id;
      }
      console.error(`Failed to create bot DM room for ${humanName}:`, data);
    } catch (e) {
      console.error(`Error creating bot DM room for ${humanName}:`, e.message);
    }
    return null;
  }

  async greetHuman(humanName, matrixUserId) {
    const roomId = await this.ensureBotDmRoom(humanName, matrixUserId);
    if (!roomId) return;

    try {
      await this.botClient.sendMessage(roomId, {
        msgtype: 'm.text',
        body: `Hey ${humanName}! I'm the Agent Bridge bot.\n\nSend !help to see what I can do — manage agents, groups, sessions, and more.`,
        format: 'org.matrix.custom.html',
        formatted_body: `Hey <b>${humanName}</b>! I'm the Agent Bridge bot.<br><br>Send <code>!help</code> to see what I can do — manage agents, groups, sessions, and more.`,
      });

      if (!state.greetedHumans) state.greetedHumans = [];
      state.greetedHumans.push(humanName);
      saveState();
      console.log(`Greeted human: ${humanName}`);
    } catch (e) {
      console.error(`Failed to greet ${humanName}:`, e.message);
    }
  }

  async sendDeliveryNotice(roomId, text) {
    if (!text) return;
    try {
      await this.botClient.sendMessage(roomId, { msgtype: 'm.text', body: text });
    } catch (e) {
      console.error('Failed to send delivery notice:', e.message);
    }
  }

  async handleMessageDeliveryFeedback(roomId, result) {
    if (!result || typeof result !== 'object') return;
    const lines = [];

    if (result.error) {
      lines.push(`⚠️ Message not delivered: ${result.error}`);
    }

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    for (const warning of warnings) {
      if (warning.code === 'target_offline' && warning.target) {
        const reason = warning.reason ? ` (${warning.reason})` : '';
        if (warning.queued) {
          lines.push(`⚠️ @${warning.target} is offline${reason}. Message queued; it will be delivered when the agent is online. It may be time-sensitive.`);
        } else {
          lines.push(`⚠️ @${warning.target} is offline${reason}. Message archived only and was not delivered.`);
        }
        continue;
      }
      if (warning.code === 'mentions_offline' && Array.isArray(warning.targets) && warning.targets.length > 0) {
        const targets = warning.targets
          .filter(t => t?.target)
          .map(t => `@${t.target}${t.reason ? ` (${t.reason})` : ''}`)
          .join(', ');
        if (targets) {
          lines.push(`⚠️ Offline mentions were archived only: ${targets}.`);
        }
        continue;
      }
      if (warning.code === 'mentions_unknown' && Array.isArray(warning.targets) && warning.targets.length > 0) {
        const targets = warning.targets
          .filter(t => t?.target)
          .map(t => `@${t.target}`)
          .join(', ');
        if (targets) {
          lines.push(`⚠️ Mention targets not found in agent registry: ${targets}.`);
        }
        continue;
      }
      if (warning.code === 'mentions_not_in_group' && Array.isArray(warning.targets) && warning.targets.length > 0) {
        const targets = warning.targets
          .filter(t => t?.target)
          .map(t => `@${t.target}`)
          .join(', ');
        if (targets) {
          lines.push(`⚠️ Mentions not delivered because targets are not members of this group: ${targets}.`);
        }
      }
    }

    if (lines.length > 0) {
      await this.sendDeliveryNotice(roomId, lines.join('\n'));
    }
  }

  async submitHumanMessage(roomId, payload) {
    try {
      const result = await this.callBackendApi('POST', '/api/messages', payload);
      await this.handleMessageDeliveryFeedback(roomId, result);
      return result;
    } catch (e) {
      if (isTimeoutAbortError(e)) {
        try {
          await this.sleep(BACKEND_FETCH_RETRY_DELAY_MS);
          const retryResult = await this.callBackendApi('POST', '/api/messages', payload, 'retry=1');
          await this.handleMessageDeliveryFeedback(roomId, retryResult);
          return retryResult;
        } catch (retryError) {
          const detail = isTimeoutAbortError(retryError)
            ? 'timeout'
            : String(retryError?.message || retryError);
          const notice = `⚠️ Message delivery failed after retry (${detail}).`;
          await this.sendDeliveryNotice(roomId, notice);
          return { error: detail };
        }
      }
      const detail = String(e?.message || e);
      await this.sendDeliveryNotice(roomId, `⚠️ Message delivery failed (${detail}).`);
      return { error: detail };
    }
  }

  // ── Matrix → Agent-chat ───────────────────────────────────────────
  async onRoomMessage(roomId, event) {
    const eventId = event?.event_id || null;
    if (eventId && this.isDuplicateMatrixEvent(eventId)) return;
    if (eventId) this.rememberMatrixEvent(eventId);

    if (shouldIgnoreAgentForward(event?.content)) return;

    const parsed = parseInboundTextMessage(event.content);
    if (parsed.skip) return;

    const senderId = event.sender;

    // Ignore messages from our agent accounts (prevent loops)
    if (isAgentUser(senderId)) return;
    if (senderId === this.botUserId) return;

    const groupName = groupForRoom(roomId);
    const humanName = humanNameFromUserId(senderId);
    let body = parsed.body;
    if (event.content?.msgtype === 'm.image' || event.content?.msgtype === 'm.file') {
      const localPath = await this.cacheInboundMediaToLocal(event.content);
      if (localPath) {
        body = `${body}\nLocalPath: ${localPath}`;
      }
    }
    const mentions = parseMentions(event.content, body);
    const replyTo = this.resolveReplyToMessageId(parsed.replyEventId);
    let effectiveMentions = mentions
      .map(name => this.resolveKnownAgentName(name) || name)
      .filter(Boolean);

    if (groupName && replyTo) {
      const inferred = await this.inferReplyMention({
        groupName,
        humanName,
        replyTo,
        mentions: effectiveMentions,
      });
      if (inferred?.name) {
        effectiveMentions = [...new Set([...effectiveMentions, inferred.name])];
        console.log(`Reply mention inferred in ${groupName}: @${inferred.name} (${inferred.reason}, reply_to=${replyTo})`);
      }
    }

    // Check if this is a DM room (bot-DM or agent-DM)
    let targetAgent = null;
    let isBotDm = false;
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      const agentMembers = nonBot.filter(m => isAgentUser(m));
      const humanMembers = nonBot.filter(m => !isAgentUser(m));

      if (agentMembers.length === 1 && humanMembers.length >= 1 && !isAgentUser(senderId)) {
        // 1 agent + 1-2 humans + bot → agent DM
        targetAgent = agentNameFromUserId(agentMembers[0]);
      } else if (agentMembers.length === 0 && humanMembers.length >= 1) {
        // Only humans + bot in room → bot command DM
        isBotDm = true;
      }
    } catch (e) {
      console.warn(`Failed to inspect room members for ${roomId}: ${e.message}`);
    }

    // ! commands work in any room (bot-DM, group, agent-DM)
    // Strip Matrix mention prefix — pills resolve to "display_name: text" in plain body.
    // Use formatted_body to detect: if HTML starts with a mention pill <a href="matrix.to/...">
    // followed by ": !cmd", strip the prefix from plain body to extract the command.
    let cmdBody = body.trim();
    if (!cmdBody.startsWith('!') && event.content?.formatted_body) {
      const fmtBody = event.content.formatted_body;
      if (/^<a\s+href="https:\/\/matrix\.to\/#\/@[^"]+">.*?<\/a>\s*:\s*!/i.test(fmtBody)) {
        const cmdIdx = cmdBody.indexOf('!');
        if (cmdIdx > 0) {
          cmdBody = cmdBody.slice(cmdIdx).trim();
        }
      }
    }
    if (cmdBody.startsWith('!')) {
      const context = { groupName, targetAgent };
      console.log(`Bot command from ${humanName} in ${groupName || targetAgent || 'bot-DM'}: ${cmdBody.slice(0, 80)}`);
      await this.commands.handle(roomId, senderId, cmdBody, context);
      return;
    }

    if (isBotDm) {
      // Non-command text in bot DM
      await this.commands.handle(roomId, senderId, body, {});
    } else if (targetAgent) {
      // DM to agent
      console.log(`Matrix DM: ${humanName} → ${targetAgent}: ${body.slice(0, 80)}`);
      const result = await this.submitHumanMessage(roomId, {
        from: humanName,
        to: targetAgent,
        type: 'human',
        summary: body,
        full: '',
        mentions: [],
        reply_to: replyTo,
        source: 'matrix',
        source_room: roomId,
        target_type: 'agent',
      });
      if (eventId && result?.id) this.rememberMatrixEvent(eventId, result.id);
    } else if (groupName) {
      // Group message from human
      console.log(`Matrix group: ${humanName} → ${groupName}: ${body.slice(0, 80)}`);
      // Ensure @ prefix on mentioned names in body (Matrix pills strip @ in plain text)
      let summary = body;
      for (const name of effectiveMentions) {
        const re = new RegExp(`(?<!@)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        summary = summary.replace(re, '@$&');
      }
      const result = await this.submitHumanMessage(roomId, {
        from: humanName,
        group: groupName,
        type: 'human',
        summary,
        full: '',
        mentions: effectiveMentions,
        reply_to: replyTo,
        source: 'matrix',
        source_room: roomId,
      });
      if (eventId && result?.id) this.rememberMatrixEvent(eventId, result.id);
    }
    // else: unknown room, ignore
  }

  async onRoomEvent(roomId, event) {
    // Ignore historical events from before bridge startup
    // But always process m.room.name (needed for mapping rooms bot joins after creation)
    if (event.type !== 'm.room.name' && event.origin_server_ts && event.origin_server_ts < this.startupTs) return;

    // Handle room creation, membership changes
    if (event.type === 'm.room.name' && event.content?.name) {
      const name = event.content.name;
      // Skip DM/SPY rooms — these are not groups
      if (name.startsWith('DM: ') || name.startsWith('SPY: ')) {
        // Don't map as group, but update roomGroupMap if it was previously mapped wrong
        const oldGroup = groupForRoom(roomId);
        if (oldGroup && (oldGroup.startsWith('SPY: ') || oldGroup.startsWith('DM: '))) {
          // Update the mapping to the new name
          mapRoom(roomId, name);
        }
      } else if (!groupForRoom(roomId)) {
        // New room name set → map to group
        const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
        if (existing.error) {
          // Create group in backend
          const joinedMembers = await this.botClient.getJoinedRoomMembers(roomId);
          const members = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
          const humanMembers = joinedMembers
            .filter(m => !isAgentUser(m) && m !== this.botUserId)
            .map(m => humanNameFromUserId(m))
            .filter(Boolean);
          await backendApi('POST', '/api/groups', {
            name,
            members: [...members, ...humanMembers],
          });
          console.log(`Created group "${name}" from Matrix room`);
        }
        mapRoom(roomId, name);
        await this.reconcileRoomGroupMembership(roomId, name);
      } else {
        const mapped = groupForRoom(roomId);
        if (mapped !== name && !name.startsWith('DM: ') && !name.startsWith('SPY: ')) {
          const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
          if (existing.error) {
            const joinedMembers = await this.botClient.getJoinedRoomMembers(roomId);
            const members = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
            const humanMembers = joinedMembers
              .filter(m => !isAgentUser(m) && m !== this.botUserId)
              .map(m => humanNameFromUserId(m))
              .filter(Boolean);
            await backendApi('POST', '/api/groups', {
              name,
              members: [...members, ...humanMembers],
            });
            console.log(`Created group "${name}" from Matrix room rename`);
          }
          mapRoom(roomId, name);
          console.log(`Room ${roomId} renamed mapping: "${mapped}" -> "${name}"`);
          await this.reconcileRoomGroupMembership(roomId, name);
        } else {
          await this.reconcileRoomGroupMembership(roomId, mapped);
        }
      }
    }

    if (event.type === 'm.room.member') {
      const targetUserId = event.state_key;
      const membership = event.content?.membership;

      // Bot joined a room → check if it needs mapping
      if (targetUserId === this.botUserId && membership === 'join') {
        await this.tryMapRoom(roomId);
        return;
      }

      // Bot kicked/left from a group room → remove group mapping
      if (targetUserId === this.botUserId && (membership === 'leave' || membership === 'ban')) {
        const groupName = groupForRoom(roomId);
        if (groupName) {
          delete state.roomGroupMap[roomId];
          delete state.groupRoomMap[groupName];
          saveState();
          console.log(`Bot removed from room ${roomId}, unmapped group "${groupName}"`);
        }
        return;
      }

      const groupName = groupForRoom(roomId);
      if (!groupName) return;
      // Skip membership events for rooms we just created (prevents echo loop)
      if (this.recentlyCreatedRooms.has(roomId)) return;

      let memberName;
      if (isAgentUser(targetUserId)) {
        memberName = agentNameFromUserId(targetUserId);
      } else if (targetUserId !== this.botUserId) {
        memberName = humanNameFromUserId(targetUserId);
      }

      if (!memberName) return;

      if (membership === 'join') {
        await backendApi('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { add: [memberName] });
        console.log(`Added ${memberName} to group ${groupName}`);
      } else if (membership === 'leave' || membership === 'ban') {
        await backendApi('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { remove: [memberName] });
        console.log(`Removed ${memberName} from group ${groupName}`);
      }
    }

    // Room tombstone → clean up mapping and migrate DM rooms
    if (event.type === 'm.room.tombstone') {
      const replacementRoom = event.content?.replacement_room;
      const groupName = groupForRoom(roomId);
      if (groupName) {
        delete state.roomGroupMap[roomId];
        delete state.groupRoomMap[groupName];
        if (replacementRoom) {
          state.roomGroupMap[replacementRoom] = groupName;
          state.groupRoomMap[groupName] = replacementRoom;
          console.log(`Room ${roomId} tombstoned, migrated group "${groupName}" → ${replacementRoom}`);
        } else {
          console.log(`Room ${roomId} tombstoned, unmapped group "${groupName}"`);
        }
        saveState();
      }
      // Migrate DM room mappings
      if (!state.dmRooms) state.dmRooms = {};
      for (const [key, mappedRoomId] of Object.entries(state.dmRooms)) {
        if (mappedRoomId === roomId) {
          if (replacementRoom) {
            state.dmRooms[key] = replacementRoom;
            this.dmRooms.set(key, replacementRoom);
            console.log(`Room ${roomId} tombstoned, migrated DM "${key}" → ${replacementRoom}`);
          } else {
            delete state.dmRooms[key];
            this.dmRooms.delete(key);
            console.log(`Room ${roomId} tombstoned, unmapped DM "${key}"`);
          }
          // Migrate room avatar mapping
          if (state.roomAvatars?.[roomId]) {
            if (replacementRoom) state.roomAvatars[replacementRoom] = state.roomAvatars[roomId];
            delete state.roomAvatars[roomId];
          }
          saveState();
          break;
        }
      }
    }
  }

  async scanJoinedRooms() {
    try {
      const rooms = await this.botClient.getJoinedRooms();
      for (const roomId of rooms) {
        const mappedGroup = groupForRoom(roomId);
        if (mappedGroup) {
          await this.reconcileRoomGroupMembership(roomId, mappedGroup);
          await ensureRoomAvatar(roomId, mappedGroup);
          continue;
        }
        const discoveredGroup = await this.tryMapRoom(roomId);
        if (discoveredGroup) {
          await this.reconcileRoomGroupMembership(roomId, discoveredGroup);
          await ensureRoomAvatar(roomId, discoveredGroup);
        }
      }
    } catch (e) {
      console.error('Failed to scan joined rooms:', e.message);
    }
  }

  async backfillAvatars() {
    if (!AUTO_AVATAR_ENABLED) return;
    // Agent user avatars
    for (const agentName of Object.keys(state.agentTokens)) {
      await ensureAgentAvatar(agentName);
    }
    // DM room avatars
    for (const [key, roomId] of Object.entries(state.dmRooms || {})) {
      if (!roomId) continue;
      const agentName = key.replace(/^dm:/, '');
      await ensureRoomAvatar(roomId, `DM: ${agentName}`);
    }
  }

  async reconcileRoomGroupMembership(roomId, groupName) {
    if (!groupName || groupName.startsWith('DM: ') || groupName.startsWith('SPY: ')) return;
    // Skip recently created rooms — humans may not have accepted invites yet
    if (this.recentlyCreatedRooms.has(roomId)) return;
    try {
      const joinedMembers = await getJoinedRoomMembersWithTrace(
        this.botClient,
        roomId,
        `reconcile:getJoinedRoomMembers group=${JSON.stringify(groupName)}`
      );
      const agentMembers = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
      const humanMembers = joinedMembers
        .filter(m => !isAgentUser(m) && m !== this.botUserId)
        .map(m => humanNameFromUserId(m))
        .filter(Boolean);
      const matrixMembers = [...new Set([...agentMembers, ...humanMembers].filter(Boolean))];
      const existing = await backendApi(
        'GET',
        `/api/groups/${encodeURIComponent(groupName)}`,
        null,
        `context=reconcile:get-group group=${JSON.stringify(groupName)} room=${roomId}`
      );

      if (existing.error) {
        await backendApi(
          'POST',
          '/api/groups',
          { name: groupName, members: matrixMembers },
          `context=reconcile:create-group group=${JSON.stringify(groupName)} room=${roomId} memberCount=${matrixMembers.length}`
        );
        console.log(`Reconciled by creating missing backend group "${groupName}" with ${matrixMembers.length} members`);
        return;
      }

      const backendMembers = Array.isArray(existing.members) ? existing.members.filter(Boolean) : [];
      const backendKeyMap = new Map(backendMembers.map(name => [String(name).toLowerCase(), name]));
      const matrixKeyMap = new Map(matrixMembers.map(name => [String(name).toLowerCase(), name]));

      // Only add Matrix members missing from backend (Matrix→backend additions).
      // Never remove backend members not in Matrix — they may be invited humans
      // who haven't joined yet. Removals happen via explicit kicks (m.room.member events).
      const add = [];
      for (const [key, name] of matrixKeyMap.entries()) {
        if (!backendKeyMap.has(key)) add.push(name);
      }

      if (add.length > 0) {
        await backendApi(
          'POST',
          `/api/groups/${encodeURIComponent(groupName)}/members`,
          { add },
          `context=reconcile:add-members group=${JSON.stringify(groupName)} room=${roomId} addCount=${add.length}`
        );
        console.log(`Reconciled group "${groupName}" from room ${roomId}: +[${add.join(', ')}]`);
      }
    } catch (e) {
      console.error(`Failed to reconcile group "${groupName}" from room ${roomId}:`, e.message);
      this.postWarning(`Failed to reconcile Matrix room ${roomId} ↔ group "${groupName}": ${e.message}`);
    }
  }

  async tryMapRoom(roomId) {
    if (groupForRoom(roomId)) return groupForRoom(roomId); // already mapped
    // Check if this is a DM room or bot-DM (skip those)
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      if (nonBot.length <= 2) return null; // DM or bot-DM, not a group
    } catch (e) {
      console.warn(`Failed to inspect members while probing room ${roomId}: ${e.message}`);
      return null;
    }

    // Get room name via state event
    try {
      const nameEvent = await this.botClient.getRoomStateEvent(roomId, 'm.room.name', '');
      const name = nameEvent?.name;
      if (!name) return null;

      // Skip DM rooms (name format: "DM: X" or "SPY: X ↔ Y")
      if (name.startsWith('DM: ') || name.startsWith('SPY: ')) return null;

      // Check if group exists in backend, create if not
      const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
      if (existing.error) {
        const joinedMembers = await this.botClient.getJoinedRoomMembers(roomId);
        const agentMembers = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
        const humanMembers = joinedMembers
          .filter(m => !isAgentUser(m) && m !== this.botUserId)
          .map(m => humanNameFromUserId(m))
          .filter(Boolean);
        await backendApi('POST', '/api/groups', {
          name,
          members: [...agentMembers, ...humanMembers],
        });
        console.log(`Created group "${name}" from room bot joined`);
      }
      mapRoom(roomId, name);
      console.log(`Mapped room ${roomId} → group "${name}"`);
      return name;
    } catch (e) {
      const msg = String(e?.message || '');
      const maybeUnnamedRoom = /M_NOT_FOUND|404|room\.name/i.test(msg);
      if (!maybeUnnamedRoom) {
        console.warn(`Failed to map room ${roomId}: ${msg}`);
        this.postWarning(`Failed to map Matrix room ${roomId}: ${msg}`);
      }
      return null;
    }
  }

  // ── Poll agent accounts for pending invites ─────────────────────
  async pollAgentInvites() {
    for (const agentName of this.knownAgents) {
      const token = this.getAgentToken(agentName);
      if (!token) continue;
      try {
        // Sync to get invited rooms
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?filter={"room":{"timeline":{"limit":0}}}&timeout=0`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const invited = data?.rooms?.invite || {};
        for (const roomId of Object.keys(invited)) {
          // Auto-join
          const joinRes = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if ((await joinRes.json()).room_id) {
            console.log(`Agent ${agentName} joined room ${roomId}`);
            // Invite bot so it can monitor messages
            await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: this.botUserId }),
            });
            console.log(`Invited bot into room ${roomId}`);
          }
        }
      } catch (e) {
        console.warn(`Invite poll failed for ${agentName}: ${e.message}`);
      }
    }
    // Re-scan for any newly joined rooms that need mapping
    await this.scanJoinedRooms();
  }

  // ── Agent-chat → Matrix ───────────────────────────────────────────
  connectSSE() {
    const url = `${BACKEND_URL}/api/stream`;
    console.log(`Connecting SSE: ${url}`);

    const connect = () => {
      const es = new EventSource(url);
      es.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.source === 'matrix') return; // prevent loops
          this.onAgentMessage(msg);
        } catch (e) {
          console.warn(`Failed to parse SSE message event: ${e.message}`);
        }
      });
      es.on('group_created', (data) => {
        try {
          const group = JSON.parse(data);
          console.log(`SSE: group created "${group.name}" with members: ${group.members.join(', ')}`);
          this.onGroupCreated(group);
        } catch (e) {
          console.warn(`Failed to parse SSE group_created event: ${e.message}`);
        }
      });
      es.on('group_members', (data) => {
        try {
          const update = JSON.parse(data);
          console.log(`SSE: group "${update.name}" members updated — added: [${update.added}], removed: [${update.removed}]`);
          this.onGroupMembersChanged(update);
        } catch (e) {
          console.warn(`Failed to parse SSE group_members event: ${e.message}`);
        }
      });
      es.on('dm_ensure', (data) => {
        try {
          const { agent, human } = JSON.parse(data);
          console.log(`SSE: dm_ensure request — agent=${agent}, human=${human}`);
          this.onDmEnsure(agent, human);
        } catch (e) {
          console.warn(`Failed to parse SSE dm_ensure event: ${e.message}`);
        }
      });
      es.on('agent_avatar', (data) => {
        try {
          const { name, force, image, mime } = JSON.parse(data);
          if (image) {
            console.log(`SSE: agent_avatar custom upload — ${name} (${mime})`);
            setCustomAgentAvatar(name, Buffer.from(image, 'base64'), mime || 'image/png');
          } else {
            console.log(`SSE: agent_avatar request — ${name}${force ? ' (force)' : ''}`);
            if (!AUTO_AVATAR_ENABLED) {
              console.log(`Auto avatar disabled; skipping generated avatar request for ${name}`);
              return;
            }
            if (force) delete state.agentAvatars[name];
            ensureAgentAvatar(name);
          }
        } catch (e) {
          console.warn(`Failed to parse SSE agent_avatar event: ${e.message}`);
        }
      });
      es.on('agent_blocked', (data) => {
        try {
          const event = JSON.parse(data);
          this.onAgentBlocked(event);
        } catch (e) {
          console.warn(`Failed to parse SSE agent_blocked event: ${e.message}`);
        }
      });
      es.on('agent_recovered', (data) => {
        try {
          const event = JSON.parse(data);
          this.onAgentRecovered(event);
        } catch (e) {
          console.warn(`Failed to parse SSE agent_recovered event: ${e.message}`);
        }
      });
      es.on('system_info', (data) => {
        try {
          const event = JSON.parse(data);
          this.onSystemInfo(event);
        } catch (e) {
          console.warn(`Failed to parse SSE system_info event: ${e.message}`);
        }
      });
      es.on('agent_compact', (data) => {
        try {
          const event = JSON.parse(data);
          this.onAgentCompact(event);
        } catch (e) {
          console.warn(`Failed to parse SSE agent_compact event: ${e.message}`);
        }
      });
      es.on('error', () => {
        console.error('SSE disconnected, reconnecting in 5s...');
        setTimeout(connect, 5000);
      });
    };
    connect();
  }

  async onDmEnsure(agentName, humanName) {
    // Dedup lock: prevent concurrent DM creation for the same agent+human pair
    const lockKey = `dm:${agentName}:${humanName}`;
    if (!this._dmEnsureLocks) this._dmEnsureLocks = new Map();
    if (this._dmEnsureLocks.has(lockKey)) {
      console.log(`SSE: dm_ensure skipped (already in progress): ${lockKey}`);
      return this._dmEnsureLocks.get(lockKey);
    }
    const promise = this._doOnDmEnsure(agentName, humanName);
    this._dmEnsureLocks.set(lockKey, promise);
    try { await promise; } finally { this._dmEnsureLocks.delete(lockKey); }
  }

  async _doOnDmEnsure(agentName, humanName) {
    try {
      const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
      if (!canonicalAgent) return;
      // Ensure agent account exists
      if (!this.getAgentToken(canonicalAgent)) {
        await ensureAgentAccount(canonicalAgent);
        this.addKnownAgent(canonicalAgent);
      }
      const result = await this.ensureHumanDmRoom(canonicalAgent, humanName);
      if (result.ok) {
        console.log(`DM room ensured: agent=${canonicalAgent}, human=${humanName}, room=${result.roomId}, status=${result.humanStatus}`);
      } else {
        console.error(`DM room ensure failed: agent=${canonicalAgent}, human=${humanName}`, result);
        this.postWarning(`Failed to ensure DM room for ${canonicalAgent} ↔ ${humanName}: ${result.invite?.error || 'unknown'}`);
      }
    } catch (e) {
      console.error(`DM ensure error: ${e.message}`);
      this.postWarning(`DM ensure error for ${agentName} ↔ ${humanName}: ${e.message}`);
    }
  }

  async onAgentBlocked(event) {
    const agentName = (typeof event?.agent === 'string' && event.agent.trim()) ? event.agent.trim() : '';
    if (!agentName) return;
    const reason = (typeof event?.reason === 'string' && event.reason.trim()) ? event.reason.trim() : 'unknown';
    const targets = Array.isArray(event?.targets) ? event.targets : [];

    const sentRooms = new Set();
    for (const target of targets) {
      const human = (typeof target?.human === 'string' && target.human.trim()) ? target.human.trim() : '';
      let roomId = (typeof target?.roomId === 'string' && target.roomId.trim()) ? target.roomId.trim() : '';
      if (!roomId && typeof target?.group === 'string' && target.group.trim()) {
        roomId = roomForGroup(target.group.trim()) || '';
      }
      if (!roomId && human) {
        try {
          const ensured = await this.ensureHumanDmRoom(agentName, human);
          if (ensured?.roomId) roomId = ensured.roomId;
        } catch (e) {
          console.warn(`Failed to ensure DM room for blocked alert (${agentName} -> ${human}): ${e.message}`);
        }
      }
      if (!roomId || sentRooms.has(roomId)) continue;
      sentRooms.add(roomId);

      const pendingHint = target?.pending ? ' There are still unread human messages pending for this agent.' : '';
      const text = `⚠️ Agent @${agentName} appears blocked (${reason}). It may not process messages until manually handled.${pendingHint}`;
      await this.sendDeliveryNotice(roomId, text);
      this.rememberBlockedAlertRoom(agentName, roomId);
    }
  }

  findExistingAgentDmRoom(agentName) {
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    if (!canonicalAgent) return null;

    const preferredKey = `dm:${canonicalAgent}`;
    const preferredKeyNorm = this.nameKey(preferredKey);
    const storeFound = (roomId) => {
      const normalizedRoom = (typeof roomId === 'string' && roomId.trim()) ? roomId.trim() : '';
      if (!normalizedRoom) return null;
      this.dmRooms.set(preferredKey, normalizedRoom);
      return normalizedRoom;
    };

    for (const [key, roomId] of this.dmRooms.entries()) {
      if (this.nameKey(key) === preferredKeyNorm) {
        return storeFound(roomId);
      }
    }
    for (const [key, roomId] of Object.entries(state.dmRooms || {})) {
      if (this.nameKey(key) === preferredKeyNorm) {
        return storeFound(roomId);
      }
    }

    // Backward compatibility: detect old "agent:human" key format and reuse it.
    for (const [key, roomId] of Object.entries(state.dmRooms || {})) {
      const parts = String(key || '').split(':');
      if (parts.length !== 2) continue;
      const [left, right] = parts;
      if (!this.sameName(left, canonicalAgent) && !this.sameName(right, canonicalAgent)) continue;
      const other = this.sameName(left, canonicalAgent) ? right : left;
      if (this.isKnownAgentName(other)) continue; // skip agent↔agent rooms
      return storeFound(roomId);
    }
    return null;
  }

  async onAgentCompact(event) {
    const dedupeId = (typeof event?.id === 'string' && event.id.trim())
      ? event.id.trim()
      : ((typeof event?.messageId === 'string' && event.messageId.trim()) ? `compact_${event.messageId.trim()}` : null);
    if (dedupeId) {
      if (this.recentAgentCompactIds.has(dedupeId)) return;
      this.recentAgentCompactIds.add(dedupeId);
      if (this.recentAgentCompactIds.size > 1000) {
        const arr = [...this.recentAgentCompactIds];
        this.recentAgentCompactIds = new Set(arr.slice(-500));
      }
    }

    const agentName = (typeof event?.agent === 'string' && event.agent.trim()) ? event.agent.trim() : '';
    if (!agentName) return;
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    if (!canonicalAgent) return;

    const roomId = this.findExistingAgentDmRoom(canonicalAgent);
    if (!roomId) {
      console.log(`SSE: agent_compact skipped for ${canonicalAgent} (no existing DM room)`);
      return;
    }

    const mode = (typeof event?.mode === 'string' && event.mode.trim().toLowerCase() === 'hook') ? 'hook' : 'pattern';
    const summary = (typeof event?.summary === 'string')
      ? normalizeMessageText(event.summary).replace(/\s+/g, ' ').trim()
      : '';
    const msgId = (typeof event?.messageId === 'string' && event.messageId.trim()) ? event.messageId.trim() : null;
    const linkLine = msgId ? `\n🔗 ${MSG_BASE_URL}/${msgId}` : '';
    const summaryLine = summary ? `\nSummary: ${summary}` : '';
    const confidence = mode === 'hook' ? 'reported' : 'likely';
    const text = `ℹ️ Agent @${canonicalAgent} ${confidence} triggered a context compact event (${mode} detection).${summaryLine}${linkLine}`;

    await this.sendDeliveryNotice(roomId, text);
    console.log(`→ Matrix DM compact notice ${canonicalAgent} (${mode}) in ${roomId}`);
  }

  async onAgentRecovered(event) {
    const agentName = (typeof event?.agent === 'string' && event.agent.trim()) ? event.agent.trim() : '';
    if (!agentName) return;
    console.log(`SSE: agent_recovered — ${agentName}`);
    const rooms = this.consumeBlockedAlertRooms(agentName);
    for (const roomId of rooms) {
      await this.sendDeliveryNotice(roomId, `✅ Agent @${agentName} recovered from blocked state.`);
    }
  }

  async onSystemInfo(event) {
    const eventId = (typeof event?.id === 'string' && event.id.trim()) ? event.id.trim() : null;
    if (eventId) {
      if (this.recentSystemInfoIds.has(eventId)) return;
      this.recentSystemInfoIds.add(eventId);
      if (this.recentSystemInfoIds.size > 1000) {
        const arr = [...this.recentSystemInfoIds];
        this.recentSystemInfoIds = new Set(arr.slice(-500));
      }
    }

    const summary = (typeof event?.summary === 'string' && event.summary.trim()) ? event.summary.trim() : '';
    if (!summary) return;
    const full = (typeof event?.full === 'string') ? event.full : '';
    const roomId = roomForGroup('info');
    if (!roomId) {
      console.warn(`No Matrix room for group "info"; system_info skipped: ${summary.slice(0, 80)}`);
      return;
    }
    const body = full ? `ℹ️ ${summary}\n\n${full}` : `ℹ️ ${summary}`;
    try {
      await this.botClient.sendMessage(roomId, { msgtype: 'm.text', body });
      console.log(`→ Matrix [info] system: ${summary.slice(0, 60)}`);
    } catch (e) {
      console.error(`Failed to bridge system_info to info room ${roomId}:`, e.message);
    }
  }

  async onGroupCreated(group) {
    // Skip if room already exists for this group (e.g. created from Matrix)
    if (roomForGroup(group.name)) return;

    // Ensure agent accounts exist for agent members
    for (const m of group.members) {
      const canonicalAgent = this.resolveKnownAgentName(m);
      if (canonicalAgent && !this.getAgentToken(canonicalAgent)) {
        await ensureAgentAccount(canonicalAgent);
      }
    }
    await this.createRoomForGroup(group.name, group.members);
  }

  async onGroupMembersChanged(update) {
    const roomId = roomForGroup(update.name);
    if (!roomId) return;

    // Get current room members to avoid re-inviting
    let currentMembers = new Set();
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      currentMembers = new Set(members);
    } catch (e) {
      console.warn(`Failed to fetch current room members for ${update.name}/${roomId}: ${e.message}`);
    }

    // Invite newly added members
    for (const m of (update.added || [])) {
      // Check backend API to determine if member is an agent (avoids stale knownAgents race)
      let canonicalAgent = this.resolveKnownAgentName(m);
      let isAgent = Boolean(canonicalAgent);
      if (!isAgent) {
        try {
          const info = await backendApi('GET', `/api/agents/${encodeURIComponent(m)}`);
          if (info && !info.error && info.type === 'agent') {
            isAgent = true;
            canonicalAgent = this.addKnownAgent(info.name || m);
          }
        } catch (e) {
          console.warn(`Agent lookup failed for "${m}" while syncing group "${update.name}": ${e.message}`);
        }
      }

      // Ensure agent has a Matrix account
      if (isAgent) {
        const ensuredName = canonicalAgent || this.normalizeName(m);
        if (ensuredName && !this.getAgentToken(ensuredName)) {
          await ensureAgentAccount(ensuredName);
          canonicalAgent = this.addKnownAgent(ensuredName) || ensuredName;
        }
      }

      let userId;
      if (isAgent) {
        const token = this.getAgentToken(canonicalAgent || m);
        if (token) {
          userId = await getUserId(token);
          if (currentMembers.has(userId)) continue; // already in room
          // Also auto-join with agent token
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        } else {
          // Agent without token (ensureAgentAccount may have failed) — use ac_ prefix
          userId = agentUserId(canonicalAgent || m);
          if (currentMembers.has(userId)) continue;
        }
      } else {
        // Human — use plain name
        userId = humanUserId(m);
        if (currentMembers.has(userId)) continue;
      }
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        });
        console.log(`Invited ${m} (${userId}) to Matrix room for ${update.name}`);
      } catch (e) {
        console.error(`Failed to invite ${m} to ${update.name}:`, e.message);
        // Report to info group
        this.postWarning(`Failed to invite ${m} to Matrix room for group "${update.name}": ${e.message}`);
      }
    }

    // Kick removed members
    for (const m of (update.removed || [])) {
      let userId;
      const token = this.isKnownAgentName(m) ? this.getAgentToken(m) : null;
      if (token) {
        userId = await getUserId(token);
      } else {
        userId = humanUserId(m);
      }
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, reason: 'Removed from agent-chat group' }),
        });
        console.log(`Kicked ${m} (${userId}) from Matrix room for ${update.name}`);
      } catch (e) {
        console.error(`Failed to kick ${m}:`, e.message);
      }
    }
  }

  async onAgentMessage(msg) {
    if (this.recentBridgedIds.has(msg.id)) return;
    this.recentBridgedIds.add(msg.id);
    // Cleanup old IDs
    if (this.recentBridgedIds.size > 500) {
      const arr = [...this.recentBridgedIds];
      this.recentBridgedIds = new Set(arr.slice(-250));
    }

    const agentName = msg.from;
    const canonicalAgentName = this.resolveKnownAgentName(agentName) || agentName;
    const senderIsSystem = agentName === 'system';

    // Don't bridge human messages (they come from Matrix)
    if (msg.type === 'human') return;

    let senderToken = null;
    if (senderIsSystem) {
      senderToken = this.getBotToken();
      if (!senderToken) {
        console.warn(`No Matrix bot token, cannot bridge system message ${msg.id}`);
        return;
      }
    } else {
      senderToken = await this.ensureAgentToken(canonicalAgentName, `outbound:${msg.id}`);
      if (!senderToken) {
        console.warn(`No Matrix token for agent "${canonicalAgentName}", cannot bridge message ${msg.id}`);
        this.postWarning(`No Matrix token for agent "${canonicalAgentName}" — message ${msg.id} not bridged to Matrix`);
        return;
      }
    }

    // Build Matrix message — always show full content when available
    const hasFull = msg.full && msg.full.length > 0;
    const typeBadge = msg.type === 'request' ? '📋' : msg.type === 'reply' ? '↩️' : 'ℹ️';
    const mentionText = msg.mentions?.length ? ` · ${msg.mentions.map(m => '@' + m).join(' ')}` : '';
    const htmlMentions = msg.mentions?.length ? ` · ${msg.mentions.map(m => '<b>@' + escapeHtml(m) + '</b>').join(' ')}` : '';

    let plain, html;
    if (hasFull) {
      const msgUrl = `${MSG_BASE_URL}/${msg.id}`;
      plain = `${typeBadge} ${normalizeMessageText(msg.summary)}${mentionText}\n\n${normalizeMessageText(msg.full)}\n\n🔗 ${msgUrl}`;
      const summaryHtml = renderMarkdownInline(msg.summary);
      const fullHtml = renderMarkdownToMatrixHtml(msg.full);
      html = `${typeBadge} <strong>${summaryHtml}</strong>${htmlMentions}<br><br>${fullHtml}<br><br><a href="${escapeHtmlAttr(msgUrl)}">🔗 View formatted</a>`;
    } else {
      plain = `${typeBadge} ${normalizeMessageText(msg.summary)}${mentionText}`;
      const summaryHtml = renderMarkdownToMatrixHtml(msg.summary);
      html = `${typeBadge} ${summaryHtml}${htmlMentions}`;
    }

    if (msg.group) {
      // Group message
      const roomId = roomForGroup(msg.group);
      if (!roomId) {
        console.log(`No Matrix room for group "${msg.group}", skipping`);
        if (msg.group !== 'info') {
          this.postWarning(`No Matrix room for group "${msg.group}" — message ${msg.id} from ${agentName} not bridged`);
        }
        return;
      }
      await this.sendAsAgent(senderToken, roomId, plain, html, msg.id);
      await this.sendAttachmentsForMessage(senderToken, roomId, msg);
      console.log(`→ Matrix [${msg.group}] ${agentName}: ${msg.summary.slice(0, 60)}`);
    } else if (msg.to) {
      // DM - bridge to Matrix (both agent-to-agent and agent-to-human)
      if (senderIsSystem) {
        console.log(`Skipping Matrix DM bridge for system message ${msg.id}`);
        return;
      }
      const roomId = await this.ensureDmRoom(agentName, msg.to);
      if (roomId) {
        await this.sendAsAgent(senderToken, roomId, plain, html, msg.id);
        await this.sendAttachmentsForMessage(senderToken, roomId, msg);
        console.log(`→ Matrix DM ${agentName} → ${msg.to}: ${msg.summary.slice(0, 60)}`);
      } else {
        const reason = `DM room unavailable or invite failed`;
        console.warn(`${reason}: ${agentName} -> ${msg.to} (${msg.id})`);
        this.postWarning(`${reason}: ${agentName} -> ${msg.to}. Message ${msg.id} not bridged.`);
      }
    }
  }

  async ensureHumanDmRoom(agentName, humanName) {
    const roomId = await this.ensureDmRoom(agentName, humanName, { forceAgentName: agentName });
    if (!roomId) {
      return {
        ok: false,
        roomId: null,
        humanStatus: 'missing_room',
        invite: { ok: false, error: 'dm_room_unavailable' },
      };
    }
    const invite = await this._inviteHumanToDm(roomId, humanName, { agentName });
    if (invite.ok && invite.alreadyJoined) {
      return { ok: true, roomId, humanStatus: 'joined', invite };
    }
    if (invite.ok && invite.invited) {
      return { ok: true, roomId, humanStatus: 'invited', invite };
    }
    return { ok: false, roomId, humanStatus: 'invite_failed', invite };
  }

  async _ensureHumanInviteOrFail(roomId, humanName, agentName) {
    const invite = await this._inviteHumanToDm(roomId, humanName, { agentName });
    if (invite?.ok) return { ok: true, invite };
    const reason = invite?.error || 'invite_failed';
    console.error(`DM invite failed: room=${roomId}, agent=${agentName}, human=${humanName}, reason=${reason}`);
    this.postWarning(`DM invite failed for ${agentName} -> ${humanName} in ${roomId}: ${reason}`);
    return { ok: false, invite: invite || { ok: false, error: reason } };
  }

  async ensureDmRoom(fromName, toName, options = {}) {
    const resolvedFromName = this.resolveKnownAgentName(fromName) || this.normalizeName(fromName);
    const resolvedToName = this.resolveKnownAgentName(toName) || this.normalizeName(toName);
    if (!resolvedFromName || !resolvedToName) return null;

    // Determine which is the agent (for human↔agent DMs, use agent-only key so
    // multiple humans share the same DM room with an agent)
    let fromIsAgent = this.isKnownAgentName(resolvedFromName);
    let toIsAgent = this.isKnownAgentName(resolvedToName);
    const forceAgentName = options.forceAgentName || null;
    if (forceAgentName && this.sameName(forceAgentName, resolvedFromName)) {
      fromIsAgent = true;
      toIsAgent = false;
    } else if (forceAgentName && this.sameName(forceAgentName, resolvedToName)) {
      fromIsAgent = false;
      toIsAgent = true;
    }

    let key;
    if (fromIsAgent && !toIsAgent) {
      key = `dm:${resolvedFromName}`; // human→agent: keyed by agent
    } else if (!fromIsAgent && toIsAgent) {
      key = `dm:${resolvedToName}`; // agent→human: keyed by agent
    } else {
      key = [resolvedFromName, resolvedToName].sort().join(':'); // agent↔agent: pair key
    }

    // Check in-memory cache
    if (this.dmRooms.has(key)) {
      const existingRoom = this.dmRooms.get(key);
      // If human↔agent, invite the human into existing room (idempotent)
      if (key.startsWith('dm:')) {
        const humanName = fromIsAgent ? resolvedToName : resolvedFromName;
        const agentName = key.slice(3);
        const ensured = await this._ensureHumanInviteOrFail(existingRoom, humanName, agentName);
        if (!ensured.ok) return null;
      }
      return existingRoom;
    }

    // Load from persisted state (check multiple key formats for backwards compat)
    const legacyKey = [resolvedFromName, resolvedToName].sort().join(':');
    const altKey = `${resolvedFromName}:${resolvedToName}`;
    for (const k of [key, legacyKey, altKey]) {
      if (state.dmRooms?.[k]) {
        // Guard: don't alias an agent↔agent room as a human DM room
        if (key.startsWith('dm:') && !k.startsWith('dm:')) {
          const parts = k.split(':');
          if (parts.length === 2 && this.isKnownAgentName(parts[0]) && this.isKnownAgentName(parts[1])) {
            continue; // skip — this is an agent↔agent SPY room, not for human DMs
          }
        }
        const roomId = state.dmRooms[k];
        this.dmRooms.set(key, roomId);
        // Normalize: save under new key format too
        if (k !== key) {
          if (!state.dmRooms) state.dmRooms = {};
          state.dmRooms[key] = roomId;
          saveState();
        }
        if (key.startsWith('dm:')) {
          const humanName = fromIsAgent ? resolvedToName : resolvedFromName;
          const agentName = key.slice(3);
          // Ensure room name/members are correct (handles legacy SPY rooms) — once per session
          if (!this.upgradedDmRooms.has(roomId)) {
            this.upgradedDmRooms.add(roomId);
            await this._upgradeLegacyDmRoom(roomId, agentName, humanName);
          }
          const ensured = await this._ensureHumanInviteOrFail(roomId, humanName, agentName);
          if (!ensured.ok) return null;
        }
        return roomId;
      }
    }

    // Create DM room
    const agentName = fromIsAgent ? resolvedFromName : resolvedToName;
    const fromToken = this.getAgentToken(agentName);
    if (!fromToken) return null;

    // Target user ID: agent gets ac_ prefix, human uses plain name
    const otherName = agentName === resolvedFromName ? resolvedToName : resolvedFromName;
    const otherIsAgent = agentName === resolvedFromName ? toIsAgent : fromIsAgent;
    const toUserId = otherIsAgent
      ? agentUserId(otherName)
      : humanUserId(otherName);

    const invite = [toUserId, this.botUserId];
    try {
      const roomName = key.startsWith('dm:')
        ? `DM: ${agentName}`
        : `SPY: ${resolvedFromName} ↔ ${resolvedToName}`;
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fromToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_direct: true,
          invite,
          preset: 'trusted_private_chat',
          name: roomName,
        }),
      });
      const data = await res.json();
      if (data.room_id) {
        this.dmRooms.set(key, data.room_id);
        if (!state.dmRooms) state.dmRooms = {};
        state.dmRooms[key] = data.room_id;
        saveState();
        console.log(`Created DM room ${data.room_id} for ${key}`);

        // Explicitly join bot so it's ready for immediate use (don't rely on async AutojoinRoomsMixin)
        const botToken = this.getBotToken();
        if (botToken) {
          try {
            await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
              body: '{}',
            });
          } catch (e) {
            console.warn(`Bot auto-join to new room ${data.room_id} failed: ${e.message}`);
          }
        }

        // If target is agent, auto-join
        const otherToken = otherIsAgent ? this.getAgentToken(otherName) : null;
        if (otherToken) {
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        }

        // Sync agent's avatar to DM room (use existing agent avatar if set, otherwise generate)
        if (state.agentAvatars[agentName]) {
          try {
            await setRoomAvatar(data.room_id, state.agentAvatars[agentName], fromToken);
            state.roomAvatars[data.room_id] = state.agentAvatars[agentName];
            saveState();
          } catch (e) {
            console.warn(`Failed to sync agent avatar to new DM room: ${e.message}`);
          }
        } else {
          await ensureRoomAvatar(data.room_id, `DM: ${agentName}`);
        }
        if (key.startsWith('dm:')) {
          const humanName = fromIsAgent ? resolvedToName : resolvedFromName;
          const ensured = await this._ensureHumanInviteOrFail(data.room_id, humanName, agentName);
          if (!ensured.ok) return null;
        }
        return data.room_id;
      }
      console.error(`Failed to create DM room for ${key}:`, data);
    } catch (e) {
      console.error(`Error creating DM room for ${key}:`, e.message);
    }
    return null;
  }

  async _inviteHumanToDm(roomId, humanName, options = {}) {
    const humanTargetUserId = humanUserId(humanName);
    const parseJsonSafe = async (res) => {
      try {
        return await res.json();
      } catch {
        return {};
      }
    };
    try {
      // Check if already joined (avoid spam invite)
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      if (members.includes(humanTargetUserId)) {
        return { ok: true, alreadyJoined: true, invited: false, via: 'joined' };
      }
    } catch (e) {
      // Keep going: bot might not be joined, but agent inviter may still succeed.
      console.warn(`Unable to inspect joined members in ${roomId}: ${e.message}`);
    }

    const inviteAttempts = [];
    const botToken = this.getBotToken();
    if (botToken) inviteAttempts.push({ via: 'bot', token: botToken });
    const agentName = options.agentName;
    const agentToken = agentName ? this.getAgentToken(agentName) : null;
    if (agentName && agentToken) {
      inviteAttempts.push({ via: `agent:${agentName}`, token: agentToken });
    }

    let lastErr = null;
    for (const attempt of inviteAttempts) {
      try {
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${attempt.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: humanTargetUserId }),
        });
        const data = await parseJsonSafe(res);
        if (res.ok) {
          console.log(`Invited ${humanName} to DM room ${roomId} via ${attempt.via}`);
          return { ok: true, alreadyJoined: false, invited: true, via: attempt.via };
        }
        // Matrix may reject duplicate invites/joined users with 4xx; treat as success-ish.
        if (data.errcode === 'M_USER_IN_ROOM' || data.errcode === 'M_ALREADY_JOINED') {
          return { ok: true, alreadyJoined: true, invited: false, via: attempt.via };
        }
        lastErr = `${data.errcode || res.status}: ${data.error || 'invite failed'}`;
      } catch (e) {
        lastErr = e.message;
      }
    }

    const err = lastErr || 'invite_failed';
    console.error(`Failed to invite ${humanName} to ${roomId}: ${err}`);
    return { ok: false, alreadyJoined: false, invited: false, error: err };
  }

  // Ensure a DM room has the correct name and no stale agent accounts for humans.
  // Idempotent — skips if room is already correct.
  async _upgradeLegacyDmRoom(roomId, agentName, humanName) {
    const correctName = `DM: ${agentName}`;
    const botToken = this.getBotToken();
    if (!botToken) return;

    // Check current room name — skip rename if already correct
    let needsRename = false;
    try {
      const nameRes = await fetch(
        `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
        { headers: { Authorization: `Bearer ${botToken}` } }
      );
      if (nameRes.ok) {
        const data = await nameRes.json();
        needsRename = data.name !== correctName;
      }
    } catch { needsRename = true; }

    if (needsRename) {
      try {
        let renamed = false;
        for (const token of [botToken, this.getAgentToken(agentName)].filter(Boolean)) {
          const res = await fetch(
            `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: correctName }),
            }
          );
          if (res.ok) {
            console.log(`Upgraded room ${roomId} name to "${correctName}"`);
            renamed = true;
            break;
          }
        }
        if (!renamed) console.warn(`Could not rename room ${roomId} to "${correctName}"`);
      } catch (e) {
        console.warn(`Failed to rename room ${roomId}: ${e.message}`);
      }
    }

    // Remove stale @ac_<humanName> from the room (human shouldn't have an agent account).
    // Can't kick users with equal power level, so login as the stale user and have them leave.
    const staleUserId = agentUserId(humanName);
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      if (members.includes(staleUserId)) {
        const staleUsername = `${AGENT_PREFIX}${humanName}`;
        const passwords = agentPasswordCandidates(humanName);
        if (passwords.length === 0) {
          console.warn(`Cannot remove stale ${staleUserId}: no password candidates configured`);
          return;
        }
        try {
          const { data: loginData } = await tryMatrixLogin(staleUsername, passwords);
          const leaveRes = await fetch(
            `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
              body: '{}',
            }
          );
          if (leaveRes.ok) {
            console.log(`Removed stale ${staleUserId} from room ${roomId} (self-leave)`);
          }
          // Logout the temp session
          await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => {});
        } catch (e) {
          console.warn(`Could not remove stale ${staleUserId}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`Failed to check stale members in ${roomId}: ${e.message}`);
    }
  }

  async sendAsAgentContent(token, roomId, content, sourceMsgId = null) {
    const doSend = async () => {
      const txnId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (data?.event_id) {
        this.rememberMatrixEvent(data.event_id, sourceMsgId);
      }
      return data?.event_id || null;
    };
    try {
      return await doSend();
    } catch (e) {
      // Auto-join and retry if the agent has left the room
      if (e.message.includes('membership') && e.message.includes('leave')) {
        console.log(`Agent not joined in ${roomId}, attempting auto-join…`);
        try {
          // Invite via bot, then join as agent
          await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: await getUserId(token) }),
          });
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          return await doSend();
        } catch (retryErr) {
          console.error(`Auto-join retry failed in ${roomId}:`, retryErr.message);
          this.postWarning(`sendAsAgent failed in room ${roomId} (after auto-join retry): ${retryErr.message}`);
          return null;
        }
      }
      console.error(`Failed to send as agent in ${roomId}:`, e.message);
      this.postWarning(`sendAsAgent failed in room ${roomId}: ${e.message}`);
      return null;
    }
  }

  async sendAsAgent(token, roomId, text, html, sourceMsgId = null) {
    const content = { msgtype: 'm.text', body: text };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    return this.sendAsAgentContent(token, roomId, content, sourceMsgId);
  }

  async sendAttachmentAsAgent(token, roomId, attachment, sourceMsgId = null) {
    const filePath = (typeof attachment?.path === 'string') ? attachment.path.trim() : '';
    if (!filePath) throw new Error('attachment.path required');
    if (!existsSync(filePath)) throw new Error(`attachment path not found: ${filePath}`);
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`attachment path is not a file: ${filePath}`);

    const sourceName = (typeof attachment?.name === 'string' && attachment.name.trim())
      ? attachment.name.trim()
      : path.basename(filePath) || 'file.bin';
    const name = sourceName.replace(/[^\w.\-()[\] ]+/g, '_') || 'file.bin';
    const mime = normalizeMimeType(attachment?.mime) || guessMimeTypeFromName(name);
    const kind = inferAttachmentKind(attachment?.kind, mime, name);
    const bodyBytes = readFileSync(filePath);
    const mxcUri = await uploadMedia(token, bodyBytes, mime);
    const content = {
      msgtype: kind === 'image' ? 'm.image' : 'm.file',
      body: name,
      filename: name,
      url: mxcUri,
      info: {
        mimetype: mime,
        size: Number.isFinite(stat.size) ? stat.size : bodyBytes.length,
      },
    };
    return this.sendAsAgentContent(token, roomId, content, sourceMsgId);
  }

  async sendAttachmentsForMessage(token, roomId, msg) {
    const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
    if (attachments.length === 0) return;
    for (const attachment of attachments) {
      try {
        await this.sendAttachmentAsAgent(token, roomId, attachment, msg.id);
      } catch (e) {
        const pathHint = (typeof attachment?.path === 'string' && attachment.path.trim())
          ? attachment.path.trim()
          : '(unknown path)';
        const text = `⚠️ Attachment not delivered for ${msg.id}: ${pathHint} (${e.message})`;
        await this.sendDeliveryNotice(roomId, text);
        this.postWarning(`Attachment bridge failed for message ${msg.id}: ${pathHint} (${e.message})`);
      }
    }
  }

  // ── Create Matrix room for agent-chat group ───────────────────────
  async createRoomForGroup(groupName, members) {
    const invite = [];
    for (const m of members) {
      const token = this.isKnownAgentName(m) ? this.getAgentToken(m) : null;
      if (token) {
        const userId = await getUserId(token);
        invite.push(userId);
      } else {
        invite.push(humanUserId(m));
      }
    }

    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: groupName,
        topic: `Agent Chat group: ${groupName}`,
        invite,
        preset: 'private_chat',
      }),
    });
    const data = await res.json();
    if (data.room_id) {
      mapRoom(data.room_id, groupName);
      this.recentlyCreatedRooms.add(data.room_id);
      setTimeout(() => this.recentlyCreatedRooms.delete(data.room_id), 30_000);
      console.log(`Created Matrix room ${data.room_id} for group "${groupName}"`);

      // Agent accounts need to join
      for (const m of members) {
        const agentToken = this.isKnownAgentName(m) ? this.getAgentToken(m) : null;
        if (agentToken) {
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        }
      }
      await ensureRoomAvatar(data.room_id, groupName);
      return data.room_id;
    }
    console.error(`Failed to create room for ${groupName}:`, data);
    return null;
  }
}

// ── Minimal SSE client (no external dep) ─────────────────────────────
// We need to create this as a separate mini module

// ── Start ─────────────────────────────────────────────────────────────
export function startBridge() {
  const bridge = new MatrixBridge();
  return bridge.start();
}

const isMainModule = (() => {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === __filename;
})();

if (isMainModule) {
  startBridge().catch(e => {
    console.error('Bridge failed to start:', e);
    process.exit(1);
  });
}
