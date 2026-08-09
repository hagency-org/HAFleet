import {
  EncryptedRoomEvent,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';
import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import EventSource from './lib/eventsource-mini.js';
import BotCommands from './lib/bot-commands.js';
import { assertRuntimeDir } from './lib/runtime-dir-guard.js';
import { NotificationRouter } from './lib/notification-router.js';
import { MatrixEventStore } from './src/matrix-event-store.mjs';
import { MatrixRateLimitGate } from './src/matrix-rate-limit-gate.mjs';
import { getProcessStartIdentity } from './src/process-identity.mjs';
import { writeBridgeHealthRecord } from './src/health-record.mjs';
import { PendingEncryptedEventStore } from './lib/pending-encrypted-event-store.js';
import { MatrixDeliveryJournal } from './lib/matrix-delivery-journal.js';
import {
  assertMatrixCryptoDeviceIdentity,
  reconcileMatrixCryptoStoreIdentity,
} from './lib/matrix-crypto-store-identity.js';

const MATRIX_OTK_COUNT_RECONCILE_MS = 5 * 60_000;

export function signedCurve25519CountFromSync(rawSync) {
  const count = rawSync?.device_one_time_keys_count?.signed_curve25519;
  return Number.isFinite(count) && count >= 0 ? count : null;
}

export function signedCurve25519CountFromKeysUpload(response) {
  const count = response?.one_time_key_counts?.signed_curve25519;
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export class ReliableMatrixClient extends MatrixClient {
  constructor(...args) {
    super(...args);
    this.persistTokenAfterSync = true;
    this.agentChatSyncHandler = null;
    // Task 8: standalone doctor's "last successful Matrix sync" signal. Fired after
    // every successfully-processed /sync round (even an empty one with no room
    // events), which is the earliest point with real evidence the homeserver
    // round-trip succeeded — emitFn only fires per room event, not per round.
    this.onSyncSuccess = null;
    this._lastOtkCountReconciliationAt = 0;
  }

  startSync() {
    return super.startSync(async (eventName, ...payload) => {
      if (this.agentChatSyncHandler) {
        return this.agentChatSyncHandler(eventName, ...payload);
      }
      return this.emit(eventName, ...payload);
    });
  }

  async doRequest(method, endpoint, query = null, body = null, ...rest) {
    const response = await super.doRequest(method, endpoint, query, body, ...rest);
    if (method === 'POST' && endpoint === '/_matrix/client/v3/keys/upload') {
      console.log('[matrix-e2ee] keys/upload', {
        deviceKeys: Boolean(body?.device_keys),
        oneTimeKeys: Object.keys(body?.one_time_keys || {}).length,
        fallbackKeys: Object.keys(body?.fallback_keys || {}).length,
        serverCounts: response?.one_time_key_counts || {},
      });
    }
    return response;
  }

  async probeSignedCurve25519Count() {
    const response = await super.doRequest(
      'POST',
      '/_matrix/client/v3/keys/upload',
      null,
      {},
    );
    return signedCurve25519CountFromKeysUpload(response);
  }

  async reconcileSignedCurve25519CountIfDue(now = Date.now()) {
    if (!this.crypto || now - this._lastOtkCountReconciliationAt < MATRIX_OTK_COUNT_RECONCILE_MS) {
      return null;
    }
    const count = await this.probeSignedCurve25519Count();
    await this.crypto.updateSyncData([], { signed_curve25519: count }, [], [], []);
    this._lastOtkCountReconciliationAt = now;
    console.log(`[matrix-e2ee] reconciled signed_curve25519 count=${count}`);
    return count;
  }

  async processSync(raw, emitFn) {
    const result = await super.processSync(raw, emitFn);
    const reportedCount = signedCurve25519CountFromSync(raw);
    if (reportedCount !== null) {
      this._lastOtkCountReconciliationAt = Date.now();
    } else {
      try {
        await this.reconcileSignedCurve25519CountIfDue();
      } catch (error) {
        console.warn(`[matrix-e2ee] failed to reconcile signed_curve25519 count: ${error.message}`);
      }
    }
    if (typeof this.onSyncSuccess === 'function') await this.onSyncSuccess();
    return result;
  }
}

const __filename = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
let execFileAsyncImpl = execFileAsync;
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.HAFLEET_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
assertRuntimeDir(RUNTIME_ROOT);
// ── Configuration ─────────────────────────────────────────────────────
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.example.com';
const APPROVAL_EVENT_KEY = 'com.hafleet.approval';
const APPROVAL_STATUS_MSGTYPE = 'com.hafleet.approval.status.v1';
const APPROVAL_REQUEST_MSGTYPE = 'com.hafleet.approval.request.v1';
const APPROVAL_VERDICT_MSGTYPE = 'com.hafleet.approval.verdict.v1';
const MATRIX_MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';
const REGISTRATION_TOKEN = (process.env.MATRIX_REG_TOKEN || '').trim();

export function resolveApprovalDmMode(env = process.env) {
  const requested = String(env.HAFLEET_APPROVAL_DM_MODE || 'required').trim().toLowerCase();
  if (requested === 'required') return 'required';
  if (requested !== 'plaintext-test') {
    throw new Error(`unsupported HAFLEET_APPROVAL_DM_MODE: ${requested || '<empty>'}`);
  }
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('plaintext approval diagnostics are forbidden in production');
  }
  if (String(env.HAFLEET_ALLOW_PLAINTEXT_APPROVAL_TEST || '').trim() !== '1') {
    throw new Error('plaintext approval diagnostics require HAFLEET_ALLOW_PLAINTEXT_APPROVAL_TEST=1');
  }
  return 'plaintext-test';
}

const APPROVAL_DM_MODE = resolveApprovalDmMode();
// Agents that get no Matrix puppet (service relays, or teams excluded on a shared/public server).
// Shared by the startup ensure-loop AND the periodic registration poll.
const SKIP_AGENTS = new Set(
  (process.env.MATRIX_BRIDGE_SKIP_AGENTS || 'openfab-bridge')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
// Shared Matrix rate-limit cooldown gate (Task 5: 收敛 Matrix 429). Every Matrix request
// source in this file — agent-invite polling, bot-invite polling, joined-room scan,
// managed-room backfill/history, and matrix-bot-sdk client errors — funnels 429s through
// this ONE gate, so a rate limit hit by any path blocks every other path instead of each
// path backing off independently (which only amplifies the very limit it's dodging).
const rateLimitGate = new MatrixRateLimitGate();

// A homeserver fetch that backs off on M_LIMIT_EXCEEDED, sharing state with every other
// Matrix request source via `rateLimitGate`: it waits out an already-active cooldown
// before firing (even one it didn't cause itself), and honors the server's
// `retry_after_ms` on 429 (default/cap come from the gate).
async function fetchWithRateLimit(url, init, tries = 6) {
  let res;
  for (let i = 0; i < tries; i++) {
    if (!rateLimitGate.beforeRequest()) {
      const waitMs = rateLimitGate.cooldownRemainingMs();
      console.warn(`[rate-limit] ${url.split('/').pop()} shared cooldown active; waiting ${Math.round(waitMs / 1000)}s before try ${i + 1}/${tries}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    res = await fetch(url, init);
    const limited = await rateLimitGate.observeResponse(res);
    if (!limited) return res;
    if (i < tries - 1) {
      const waitMs = rateLimitGate.cooldownRemainingMs();
      console.warn(`[rate-limit] ${url.split('/').pop()} 429; waiting ${Math.round(waitMs / 1000)}s (try ${i + 1}/${tries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return res;
}
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.HAFLEET_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const BACKEND_URL = (process.env.HAFLEET_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).trim().replace(/\/$/, '');
const BACKEND_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.HAFLEET_BACKEND_FETCH_TIMEOUT_MS || '12000', 10);
const BACKEND_FETCH_TIMEOUT_MS = Number.isFinite(BACKEND_FETCH_TIMEOUT_MS_RAW) && BACKEND_FETCH_TIMEOUT_MS_RAW > 0
  ? BACKEND_FETCH_TIMEOUT_MS_RAW
  : 12000;
const BACKEND_FETCH_RETRY_DELAY_MS_RAW = Number.parseInt(process.env.HAFLEET_BACKEND_FETCH_RETRY_DELAY_MS || '2500', 10);
const BACKEND_FETCH_RETRY_DELAY_MS = Number.isFinite(BACKEND_FETCH_RETRY_DELAY_MS_RAW) && BACKEND_FETCH_RETRY_DELAY_MS_RAW > 0
  ? BACKEND_FETCH_RETRY_DELAY_MS_RAW
  : 2500;
function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function appendMsgPath(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  return normalized.endsWith('/msg') ? normalized : `${normalized}/msg`;
}

function resolveMessageBaseUrl(env = process.env) {
  const webBase = normalizeBaseUrl(env.HAFLEET_WEB_URL);
  if (webBase) return appendMsgPath(webBase);

  const legacyMsgBase = normalizeBaseUrl(env.MSG_BASE_URL);
  if (legacyMsgBase) return legacyMsgBase;

  const webPortRaw = Number.parseInt(env.HAFLEET_WEB_PORT || '8084', 10);
  const webPort = Number.isFinite(webPortRaw) && webPortRaw > 0 ? webPortRaw : 8084;
  return `http://127.0.0.1:${webPort}/msg`;
}

const MSG_BASE_URL = resolveMessageBaseUrl();

function buildMessageUrl(messageId, viewToken = null, baseUrl = MSG_BASE_URL) {
  const id = String(messageId || '').trim();
  const base = `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(id)}`;
  const token = String(viewToken || '').trim();
  return token ? `${base}?view=${encodeURIComponent(token)}` : base;
}

const BOT_USERNAME = (process.env.MATRIX_BOT_USERNAME || 'agent-bridge').trim();
const BOT_PASSWORD = (process.env.MATRIX_BOT_PASSWORD || '').trim();
const AGENT_PREFIX = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim(); // Matrix usernames: ac_agentname
const MATRIX_SERVER_NAME = (process.env.MATRIX_SERVER_NAME || new URL(HOMESERVER).host).trim();
const AGENT_PASSWORD_SECRET = (process.env.MATRIX_AGENT_PASSWORD_SECRET || '').trim();
const AGENT_PASSWORD_TEMPLATE = (process.env.MATRIX_AGENT_PASSWORD_TEMPLATE || '').trim();
const ALLOW_LEGACY_AGENT_PASSWORD = (process.env.MATRIX_ALLOW_LEGACY_AGENT_PASSWORD || 'false').trim().toLowerCase() === 'true';
const AUTO_AVATAR_ENABLED = (process.env.MATRIX_AUTO_AVATAR || 'false').trim().toLowerCase() === 'true';
const MATRIX_GREETING_MXIDS = new Set(
  (process.env.MATRIX_GREETING_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const MATRIX_IGNORED_SENDER_MXIDS = new Set(
  (process.env.MATRIX_IGNORED_SENDER_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Default-wake for un-addressed group messages is fail-closed: group rooms are
// mention-only unless a private/single-owner deployment explicitly opts into
// the legacy 'auto' behavior. Shared Matrix rooms can contain several bridges;
// default-wake there would make every instance wake its own coordinator for the
// same human message. Read at call time so tests and operators can flip it
// without a module reload.
export function matrixDefaultWakeEnabled(env = process.env) {
  return String(env.MATRIX_DEFAULT_WAKE || 'off').trim().toLowerCase() === 'auto';
}
const DATA_DIR = path.join(RUNTIME_ROOT, 'data', 'matrix');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const AGENT_META_ROOT = path.join(RUNTIME_ROOT, 'data', 'agents');
const AGENT_AVATAR_STYLE_VERSION = 2;

// ── Warning storm protection ─────────────────────────────────────────
const WARNING_DEDUPE_WINDOW_MS_RAW = Number.parseInt(process.env.BRIDGE_WARNING_DEDUPE_WINDOW_MS || '300000', 10);
const WARNING_DEDUPE_WINDOW_MS = Number.isFinite(WARNING_DEDUPE_WINDOW_MS_RAW) && WARNING_DEDUPE_WINDOW_MS_RAW > 0
  ? WARNING_DEDUPE_WINDOW_MS_RAW
  : 300_000; // 5 minutes default
const WARNING_CB_THRESHOLD = 3;     // consecutive failures before circuit opens
const WARNING_CB_COOLDOWN_MS = 60_000; // 1 minute cooldown when circuit is open
const SYSTEM_INFO_ALERT_SEVERITY_MAP = {
  swap_high: 'critical',
  server_offline: 'critical',
  agent_blocked: 'warning',
  mcp_missing: 'warning',
  agent_offline: 'warning',
  resource_alert: 'warning',
  agent_rule: 'warning',
  bridge_warning: 'warning',
  supervisor_escalation: 'warning',
  mcp_recovered: 'info',
  swap_clear: 'info',
  server_takeover: 'info',
  supervisor_nudge: 'info',
};
const SYSTEM_INFO_WARNING_COOLDOWN_MS_RAW = Number.parseInt(process.env.BRIDGE_SYSTEM_INFO_WARNING_COOLDOWN_MS || '300000', 10);
const SYSTEM_INFO_WARNING_COOLDOWN_MS = Number.isFinite(SYSTEM_INFO_WARNING_COOLDOWN_MS_RAW) && SYSTEM_INFO_WARNING_COOLDOWN_MS_RAW > 0
  ? SYSTEM_INFO_WARNING_COOLDOWN_MS_RAW
  : 300_000;
const OWNER_LOCK_PATH = path.join(DATA_DIR, 'bridge-owner.lock');

// ── Room trust boundary (5.8.1) ─────────────────────────────────────
const MATRIX_TRUST_MODE = (process.env.MATRIX_TRUST_MODE || 'audit').trim().toLowerCase();
const MATRIX_TRUSTED_ROOM_IDS = new Set(
  (process.env.MATRIX_TRUSTED_ROOM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const MATRIX_TRUSTED_INVITER_MXIDS = new Set(
  (process.env.MATRIX_TRUSTED_INVITER_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const MATRIX_OPERATOR_MXIDS = new Set(
  (process.env.MATRIX_OPERATOR_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Agent-invite poll cadence. Clamped to a 5s floor because public homeservers
// (e.g. matrix.palpo.im) rate-limit aggressively; polling faster risks 429s.
// Default raised 15s → 60s (Task 5: 收敛 Matrix 429) — this poll fans out to a
// sync + join + bot-invite request per known agent, then chains into
// pollBotInvites/scanJoinedRooms/backfillAgentManagedRooms, so it is the single
// biggest source of request amplification in the bridge.
function resolveInvitePollMs(env = process.env) {
  const raw = Number(env.MATRIX_INVITE_POLL_MS || 60000);
  const ms = Number.isFinite(raw) ? raw : 60000;
  return Math.max(5000, ms);
}
const MATRIX_INVITE_POLL_MS = resolveInvitePollMs();
// Joined-room scan cadence. Each cycle can issue O(rooms) requests (membership +
// room-state lookups per unmapped room), so it gets a higher floor (30s) than the
// invite poll's 5s floor — a single scan is more expensive than a single invite check.
function resolveRoomScanPollMs(env = process.env) {
  const raw = Number(env.MATRIX_ROOM_SCAN_POLL_MS || 120000);
  const ms = Number.isFinite(raw) ? raw : 120000;
  return Math.max(30000, ms);
}
const MATRIX_ROOM_SCAN_POLL_MS = resolveRoomScanPollMs();
// Task 8: standalone doctor's business-health record write cadence. Deliberately its
// own timer rather than piggybacking on MATRIX_ROOM_SCAN_POLL_MS alone: that poll's
// default (120s) sits right at BRIDGE_HEALTH_MAX_AGE_MS's default staleness threshold
// (also 120s), which would flap the doctor's freshness check at the boundary. A
// shorter, independent write cadence keeps the record comfortably fresh regardless
// of how the room-scan interval is tuned.
function resolveBridgeHealthWriteIntervalMs(env = process.env) {
  const raw = Number(env.BRIDGE_HEALTH_WRITE_INTERVAL_MS || 30000);
  const ms = Number.isFinite(raw) ? raw : 30000;
  return Math.max(5000, ms);
}
const BRIDGE_HEALTH_WRITE_INTERVAL_MS = resolveBridgeHealthWriteIntervalMs();
const MATRIX_AGENT_ROOM_BACKFILL_LIMIT_RAW = Number.parseInt(process.env.MATRIX_AGENT_ROOM_BACKFILL_LIMIT || '25', 10);
const MATRIX_AGENT_ROOM_BACKFILL_LIMIT = Number.isFinite(MATRIX_AGENT_ROOM_BACKFILL_LIMIT_RAW) && MATRIX_AGENT_ROOM_BACKFILL_LIMIT_RAW > 0
  ? MATRIX_AGENT_ROOM_BACKFILL_LIMIT_RAW
  : 25;
// How far back to look when the bot joins a room, for messages sent between the
// invite and the join. Its own knob rather than sharing the agent-room limit: this
// one is a single fetch per join, not a periodic sweep, so it can afford a wider
// window, and tying the two would make tuning one silently retune the other.
const MATRIX_JOIN_BACKFILL_LIMIT_RAW = Number.parseInt(process.env.MATRIX_JOIN_BACKFILL_LIMIT || '50', 10);
const MATRIX_JOIN_BACKFILL_LIMIT = Number.isFinite(MATRIX_JOIN_BACKFILL_LIMIT_RAW) && MATRIX_JOIN_BACKFILL_LIMIT_RAW > 0
  ? MATRIX_JOIN_BACKFILL_LIMIT_RAW
  : 50;
// Lookback used only when the invite carries no usable timestamp at all. 5 minutes
// comfortably covers invite -> join (the realtime handler is immediate and the poll
// backstop runs on MATRIX_INVITE_POLL_MS, with rate-limit cooldowns on top) while
// still refusing to replay a room's older history as if it had just been said.
const MATRIX_JOIN_BACKFILL_WINDOW_MS_RAW = Number.parseInt(process.env.MATRIX_JOIN_BACKFILL_WINDOW_MS || '300000', 10);
const MATRIX_JOIN_BACKFILL_WINDOW_MS = Number.isFinite(MATRIX_JOIN_BACKFILL_WINDOW_MS_RAW) && MATRIX_JOIN_BACKFILL_WINDOW_MS_RAW >= 0
  ? MATRIX_JOIN_BACKFILL_WINDOW_MS_RAW
  : 300000;

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
if (!state.agentRoomBackfillCursors) state.agentRoomBackfillCursors = {};
if (!state.approvalDmRooms) state.approvalDmRooms = {};
if (!state.roomAgentBindings) state.roomAgentBindings = {};
// Seed trustedManagedRooms from existing bridge-created rooms
if (!state.trustedManagedRooms) {
  state.trustedManagedRooms = {};
  for (const [roomId, group] of Object.entries(state.roomGroupMap || {})) {
    state.trustedManagedRooms[roomId] = { group, addedAt: Date.now() };
  }
  for (const [, roomId] of Object.entries(state.dmRooms || {})) {
    if (roomId && !state.trustedManagedRooms[roomId]) {
      state.trustedManagedRooms[roomId] = { dm: true, addedAt: Date.now() };
    }
  }
  saveState();
}
// Always seed botDmRooms into trustedManagedRooms (handles upgrades where
// trustedManagedRooms already existed before botDmRoom seeding was added)
{
  let seeded = false;
  for (const [human, roomId] of Object.entries(state.botDmRooms || {})) {
    if (roomId && !state.trustedManagedRooms[roomId]) {
      state.trustedManagedRooms[roomId] = { botDm: true, human, addedAt: Date.now() };
      seeded = true;
    }
  }
  if (seeded) saveState();
}

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
  console.warn('MATRIX_AUTO_AVATAR is disabled. Automatic avatar generation/sync is off; use hafleet-cli avatar <name> <image-file> for manual updates.');
}

function makeUserId(localpart) {
  return `@${localpart}:${MATRIX_SERVER_NAME}`;
}

function agentUserId(name) {
  return makeUserId(`${AGENT_PREFIX}${name}`);
}

function humanUserId(name) {
  // Accept full MXID (federated users) or localpart (legacy)
  if (typeof name === 'string' && name.startsWith('@') && name.includes(':')) return name;
  return makeUserId(name);
}

/** DM key: federated users key by full MXID, local users by localpart. */
function humanDmKey(name) {
  if (typeof name === 'string' && name.startsWith('@') && name.includes(':')) {
    const homeserver = name.slice(name.indexOf(':') + 1);
    if (homeserver !== MATRIX_SERVER_NAME) return name; // federated → full MXID
    return name.slice(1, name.indexOf(':')); // local → localpart
  }
  return name;
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
  // Step 1: probe for the UIA session + the server's available flows.
  const probe = await fetchWithRateLimit(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const probeData = await probe.json();
  // Some servers register without UIA (no session) — done.
  if (probeData.access_token) return probeData;
  const session = probeData.session;
  if (!session) throw new Error(`No session in registration probe: ${JSON.stringify(probeData)}`);

  // Step 2: complete UIA. Use the registration token when configured; otherwise fall back to
  // open registration (m.login.dummy) when the server offers it.
  const flows = probeData.flows || [];
  const supportsDummy = flows.some(
    (f) => Array.isArray(f.stages) && f.stages.length === 1 && f.stages[0] === 'm.login.dummy',
  );
  let auth;
  if (REGISTRATION_TOKEN) {
    auth = { type: 'm.login.registration_token', token: REGISTRATION_TOKEN, session };
  } else if (supportsDummy) {
    auth = { type: 'm.login.dummy', session };
  } else {
    throw new Error(
      `No usable registration flow for ${username}: set MATRIX_REG_TOKEN or enable open registration. flows=${JSON.stringify(flows)}`,
    );
  }
  const res = await fetchWithRateLimit(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, auth }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Registration failed for ${username}: ${JSON.stringify(data)}`);
}

async function matrixLogin(username, password) {
  const res = await fetchWithRateLimit(`${HOMESERVER}/_matrix/client/v3/login`, {
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
  // Login → if the account doesn't exist yet, register → if it's already taken (e.g. login was
  // transiently rate-limited and we fell through), wait and retry login. This survives a public
  // server's aggressive rate limiter instead of crashing the whole bridge.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await matrixLogin(BOT_USERNAME, BOT_PASSWORD);
      state.botToken = data.access_token;
      saveState();
      console.log(`Bot logged in as ${data.user_id}`);
      return data.access_token;
    } catch (loginErr) {
      try {
        const data = await matrixRegister(BOT_USERNAME, BOT_PASSWORD);
        state.botToken = data.access_token;
        saveState();
        console.log(`Bot registered as ${data.user_id}`);
        return data.access_token;
      } catch (regErr) {
        if (/M_USER_IN_USE/.test(regErr.message)) {
          console.warn(`Bot account exists but login failed (${loginErr.message}); retrying login after backoff…`);
          await new Promise((r) => setTimeout(r, 6000));
          continue;
        }
        throw regErr;
      }
    }
  }
  throw new Error('Bot account: login/register attempts exhausted (rate limited?).');
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

async function getMatrixAccessTokenSession(token) {
  const res = await fetchWithRateLimit(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Matrix whoami failed with HTTP ${res.status}: ${data?.errcode || data?.error || 'unknown error'}`);
  }
  const userId = typeof data?.user_id === 'string' ? data.user_id.trim() : '';
  const deviceId = typeof data?.device_id === 'string' ? data.device_id.trim() : '';
  if (!userId || !deviceId) {
    throw new Error('Matrix whoami did not return both user_id and device_id');
  }
  return { userId, deviceId };
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

async function runAvatarConvert(args, input, maxBuffer) {
  const { stdout } = await execFileAsyncImpl('convert', args, {
    input,
    maxBuffer,
    timeout: 10_000,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function generateAvatarPng(name, options = {}) {
  const badge = options.badge || 'AGENT';
  const iconPath = options.iconPath || null;
  const baseSvg = renderAvatarBaseSvg(name, badge);
  if (!iconPath) {
    return runAvatarConvert(['svg:-', '-resize', '256x256', 'png:-'], Buffer.from(baseSvg), 4 * 1024 * 1024);
  }

  try {
    return await runAvatarConvert(
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
      Buffer.from(baseSvg),
      8 * 1024 * 1024,
    );
  } catch (e) {
    console.warn(`Icon avatar render failed for ${name} (${iconPath}): ${e.message}`);
    return runAvatarConvert(['svg:-', '-resize', '256x256', 'png:-'], Buffer.from(baseSvg), 4 * 1024 * 1024);
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
    const png = await generateAvatarPng(canonicalAgentName, { badge, iconPath: iconResult.iconPath });
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
    const png = await generateAvatarPng(displayName);
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
      if (e.message && e.message.includes('M_FORBIDDEN')) {
        console.debug(`[avatar-sync] Skipping DM room ${roomId} avatar sync — no permission: ${e.message}`);
      } else {
        console.warn(`Failed to sync DM room ${roomId} avatar: ${e.message}`);
      }
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
const MATRIX_BRIDGE_SECRET = (process.env.MATRIX_BRIDGE_SECRET || '').trim();
const BRIDGE_API_TOKEN = (process.env.API_TOKEN || '').trim();

// Task 8: standalone doctor's "last successful backend delivery" signal. backendApi()
// is the single choke point every backend call in this file goes through (directly or
// via MatrixBridge#callBackendApi), so tracking success here covers all of them —
// dominated in practice by POST /api/messages, but honestly labeled as "backend
// delivery" rather than "message delivery" since it is not scoped to just that route.
const bridgeHealthState = { lastSuccessfulBackendDeliveryAtMs: null };

async function backendApi(method, path, body, contextLabel = '') {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS) };
  if (MATRIX_BRIDGE_SECRET) opts.headers['X-Bridge-Secret'] = MATRIX_BRIDGE_SECRET;
  if (BRIDGE_API_TOKEN) opts.headers['Authorization'] = `Bearer ${BRIDGE_API_TOKEN}`;
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
    bridgeHealthState.lastSuccessfulBackendDeliveryAtMs = Date.now();
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
  markRoomTrusted(roomId, { group: groupName });
  saveState();
}

function groupForRoom(roomId) { return state.roomGroupMap[roomId] || null; }
function roomForGroup(groupName) { return state.groupRoomMap[groupName] || null; }

export function isPrivateControlRoomName(name) {
  return typeof name === 'string'
    && (
      name.startsWith('DM: ')
      || name.startsWith('SPY: ')
      || name.startsWith('Approval: ')
      || name.startsWith('Approval Test (UNENCRYPTED): ')
    );
}

function approvalDmKey(agentName, ownerMxid) {
  return `${agentName}\u0000${ownerMxid}`;
}

function roomAgentBindingEntries(roomId) {
  const bindings = state.roomAgentBindings?.[roomId];
  if (!bindings || typeof bindings !== 'object') return [];
  return Object.entries(bindings)
    .filter(([agentName, binding]) => (
      typeof agentName === 'string'
      && agentName.trim()
      && binding
      && typeof binding === 'object'
    ));
}

function findRoomAgentBinding(roomId, agentName) {
  const bindings = state.roomAgentBindings?.[roomId];
  const storedName = findCaseInsensitiveKey(bindings, agentName);
  if (!storedName) return null;
  return { agentName: storedName, binding: bindings[storedName] };
}

function upsertRoomAgentBinding(roomId, agentName, ownerMxid, options = {}) {
  const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
  const normalizedAgent = typeof agentName === 'string' ? agentName.trim() : '';
  const normalizedOwner = typeof ownerMxid === 'string' ? ownerMxid.trim() : '';
  if (!normalizedRoomId || !normalizedAgent || !/^@[^:\s]+:[^\s]+$/.test(normalizedOwner)) {
    return null;
  }
  if (!state.roomAgentBindings[normalizedRoomId]) state.roomAgentBindings[normalizedRoomId] = {};
  const bindings = state.roomAgentBindings[normalizedRoomId];
  const storedName = findCaseInsensitiveKey(bindings, normalizedAgent) || normalizedAgent;
  const existing = bindings[storedName] || {};
  const defaultApprovalRoom = state.approvalDmRooms[approvalDmKey(storedName, normalizedOwner)] || null;
  const approvalDmRoomId = typeof options.approvalDmRoomId === 'string' && options.approvalDmRoomId.trim()
    ? options.approvalDmRoomId.trim()
    : (defaultApprovalRoom || existing.approvalDmRoomId || null);
  bindings[storedName] = {
    inviter: normalizedOwner,
    ownerMxid: normalizedOwner,
    approvalDmRoomId,
    addedAt: Number(existing.addedAt || options.addedAt || Date.now()),
  };
  return { agentName: storedName, binding: bindings[storedName] };
}

function migrateLegacyRoomAgentBindings() {
  let changed = false;
  for (const [roomId, meta] of Object.entries(state.trustedManagedRooms || {})) {
    if (!meta || meta.approvalDm || meta.dm || meta.botDm) continue;
    const ownerMxid = typeof meta.ownerMxid === 'string' ? meta.ownerMxid : meta.inviter;
    if (typeof meta.agent === 'string' && meta.agent.trim() && /^@[^:\s]+:[^\s]+$/.test(ownerMxid || '')) {
      if (!findRoomAgentBinding(roomId, meta.agent)) {
        upsertRoomAgentBinding(roomId, meta.agent, ownerMxid, { addedAt: meta.addedAt });
        changed = true;
      }
    }

    // A previous single-agent record may already have been overwritten by a
    // second agent while retaining the first agent's approval room. Recover
    // that first binding from the content-addressed approval-DM map.
    if (typeof meta.approvalDmRoomId === 'string' && meta.approvalDmRoomId) {
      for (const [key, approvalRoomId] of Object.entries(state.approvalDmRooms || {})) {
        if (approvalRoomId !== meta.approvalDmRoomId) continue;
        const [approvalAgent, approvalOwner] = key.split('\u0000');
        if (!approvalAgent || !/^@[^:\s]+:[^\s]+$/.test(approvalOwner || '')) continue;
        if (!findRoomAgentBinding(roomId, approvalAgent)) {
          upsertRoomAgentBinding(roomId, approvalAgent, approvalOwner, {
            approvalDmRoomId: approvalRoomId,
            addedAt: meta.addedAt,
          });
          changed = true;
        }
      }
    }
  }
  if (changed) saveState();
}

migrateLegacyRoomAgentBindings();

export function approvalRoomPowerLevels(botUserId) {
  if (typeof botUserId !== 'string' || !/^@[^:\s]+:[^\s]+$/.test(botUserId)) {
    throw new Error('valid bridge bot MXID required for approval room power levels');
  }
  return {
    ban: 100,
    events_default: 0,
    invite: 100,
    kick: 100,
    notifications: { room: 100 },
    redact: 100,
    state_default: 100,
    users: { [botUserId]: 100 },
    users_default: 0,
  };
}

export function buildPublicApprovalNotice(approval) {
  const agent = String(approval?.agent || '').trim();
  const project = String(approval?.project || '').trim();
  return {
    msgtype: APPROVAL_STATUS_MSGTYPE,
    body: `Agent ${agent} is waiting for approval from its owner.`,
    [APPROVAL_EVENT_KEY]: {
      version: 1,
      kind: 'status',
      agent,
      project,
      state: 'waiting_for_owner',
    },
  };
}

export function buildOwnerApprovalRequest(approval) {
  const detail = {
    version: 1,
    kind: 'request',
    agent: String(approval?.agent || '').trim(),
    project: String(approval?.project || '').trim(),
    project_room_id: String(approval?.project_room_id || '').trim(),
    request_id: String(approval?.id || '').trim(),
    upstream_request_id: String(approval?.upstream_request_id || '').trim(),
    input_digest: String(approval?.input_digest || '').trim(),
    runtime: String(approval?.runtime || '').trim(),
    tool_name: String(approval?.tool_name || '').trim(),
    description: String(approval?.description || ''),
    input_preview: String(approval?.input_preview || ''),
    expires_at: Number(approval?.expires_at || 0),
    actions: [
      { id: 'approve_once', label: 'Approve once', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
  };
  const lines = [
    `Approval required for ${detail.agent}`,
    `Project: ${detail.project}`,
    `Runtime: ${detail.runtime}`,
    `Tool: ${detail.tool_name}`,
    detail.description ? `Description: ${detail.description}` : null,
    detail.input_preview ? `Input: ${detail.input_preview}` : null,
    `Expires: ${new Date(detail.expires_at).toISOString()}`,
    'Use the Approve once or Deny button. Text replies are not approval.',
  ].filter(Boolean);
  return {
    msgtype: APPROVAL_REQUEST_MSGTYPE,
    body: lines.join('\n'),
    [APPROVAL_EVENT_KEY]: detail,
  };
}

export function parseApprovalVerdictEvent(roomId, event) {
  const content = event?.content;
  if (!content || content.msgtype !== APPROVAL_VERDICT_MSGTYPE) return null;
  const detail = content[APPROVAL_EVENT_KEY];
  if (!detail || detail.version !== 1 || detail.kind !== 'verdict') return null;
  const action = detail.action === 'approve_once' || detail.action === 'deny' ? detail.action : null;
  const senderMxid = typeof event?.sender === 'string' ? event.sender.trim() : '';
  const requestId = typeof detail.request_id === 'string' ? detail.request_id.trim() : '';
  const agent = typeof detail.agent === 'string' ? detail.agent.trim() : '';
  const project = typeof detail.project === 'string' ? detail.project.trim() : '';
  const projectRoomId = typeof detail.project_room_id === 'string' ? detail.project_room_id.trim() : '';
  const inputDigest = typeof detail.input_digest === 'string' ? detail.input_digest.trim() : '';
  if (!action || !/^@[^:\s]+:[^\s]+$/.test(senderMxid)) return null;
  if (!/^approval_[0-9a-f]{32}$/.test(requestId) || !agent || !project) return null;
  if (!/^![^:\s]+:[^\s]+$/.test(projectRoomId) || !/^[0-9a-f]{64}$/.test(inputDigest)) return null;
  return {
    request_id: requestId,
    sender_mxid: senderMxid,
    room_id: roomId,
    agent,
    project,
    project_room_id: projectRoomId,
    input_digest: inputDigest,
    action,
    event_id: typeof event.event_id === 'string' ? event.event_id : null,
  };
}

// ── Inbound routing helpers (pure, unit-testable) ──────────────────────
// Decide how a non-command human message is dispatched. A room that carries a
// group mapping is treated as a group even if only one agent is joined, so the
// group mapping always wins over DM auto-detection (bot-DM still comes first).
export function resolveInboundRoute({ groupName, targetAgent, isBotDm }) {
  if (isBotDm) return 'bot-dm';
  if (groupName) return 'group';
  if (targetAgent) return 'agent-dm';
  return 'ignore';
}

// Pick a default recipient for an un-addressed group message so it still wakes
// someone: prefer a coordinator, else wake the factory coordinator for the
// single-agent mapped-room case, else nobody (let explicit
// mentions decide). `agentUserIds` are Matrix MXIDs; `agentNameFromId` maps one
// to an hafleet name (or null if it is not an agent account).
export function pickDefaultGroupRecipient(agentUserIds, agentNameFromId) {
  const ids = Array.isArray(agentUserIds) ? agentUserIds.filter(Boolean) : [];
  if (ids.length === 0) return null;
  const coordinator = ids.find(id => {
    const name = agentNameFromId(id);
    return name && /coordinator/i.test(name);
  });
  if (coordinator) return agentNameFromId(coordinator);
  if (ids.length === 1) return 'wf_coordinator';
  return null;
}

// Look up the room a human last wrote to an agent from, so an agent→human DM
// reply lands where the human is looking instead of a hidden global DM room.
// Key form mirrors ensureDmRoom exactly: `dm:${agent}:${humanDmKey(human)}`.
export function preferredDmRoom(state, agentName, humanName, humanDmKeyFn) {
  if (!state || !state.lastHumanRoom) return null;
  const key = `dm:${agentName}:${humanDmKeyFn(humanName)}`;
  return state.lastHumanRoom[key] || null;
}

// Decide where an agent→human DM reply should land, given the two candidate
// rooms the caller has already resolved. Preference order:
//   1. reply_thread — the room the replied-to message originated from
//   2. last_room    — the room this human last DM'd the agent from
// Returns { room, source } for the top choice (nulls when neither is known, so
// the caller falls back to the global DM room) plus the ordered, de-duplicated
// candidate list — the caller tries each in turn so a send failure on one level
// falls through to the next.
export function resolveOutboundDmRoom({ replyToRoom, lastRoom } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const [room, source] of [[replyToRoom, 'reply_thread'], [lastRoom, 'last_room']]) {
    if (typeof room === 'string' && room && !seen.has(room)) {
      seen.add(room);
      candidates.push({ room, source });
    }
  }
  const top = candidates[0] || { room: null, source: null };
  return { room: top.room, source: top.source, candidates };
}

function humanIdentityKey(value) {
  const key = humanDmKey(value);
  return typeof key === 'string' ? key.trim().toLowerCase() : '';
}

function sameHumanIdentity(a, b) {
  const aKey = humanIdentityKey(a);
  const bKey = humanIdentityKey(b);
  return Boolean(aKey) && aKey === bKey;
}

// A reply reference is routing context, not authorization to reuse its room.
// Reuse only when persisted backend metadata proves that the source is a
// group-less direct message for this exact agent/human pair.
export function verifiedDirectReplyRoom(message, { agentName, humanName } = {}) {
  if (!message || typeof message !== 'object') return null;
  // Direct messages are persisted with an explicit null group. Missing,
  // malformed, or non-null classification cannot authorize room reuse.
  if (message.group !== null) return null;
  const sourceRoom = message.source_room || message.sourceRoom;
  if (typeof sourceRoom !== 'string' || !sourceRoom.trim()) return null;

  const sameAgent = (value) => {
    if (typeof value !== 'string' || typeof agentName !== 'string') return false;
    return value.trim().toLowerCase() === agentName.trim().toLowerCase();
  };
  const fromAgent = sameAgent(message.from);
  const toAgent = sameAgent(message.to);
  if (fromAgent === toAgent) return null;

  if (fromAgent) {
    return sameHumanIdentity(message.to, humanName) ? sourceRoom.trim() : null;
  }

  // Matrix ingestion records the authenticated full sender MXID. Prefer that
  // identity when present; the display/local name remains a compatibility
  // fallback for older direct-message records.
  const authenticatedHuman = [message.senderMxid, message.fromId]
    .find((value) => typeof value === 'string' && value.startsWith('@') && value.includes(':'));
  const sourceHuman = authenticatedHuman || message.from;
  return sameHumanIdentity(sourceHuman, humanName) ? sourceRoom.trim() : null;
}

// ── Room trust classifier (5.8.1) ───────────────────────────────────
function getRoomTrust(roomId, { inviterMxid = null, requireTrustedInviter = false } = {}) {
  if (requireTrustedInviter) {
    if (!inviterMxid) return { trusted: false, reason: 'missing_inviter' };
    if (!MATRIX_TRUSTED_INVITER_MXIDS.has(inviterMxid)) {
      return { trusted: false, reason: 'untrusted_inviter' };
    }
  }
  if (MATRIX_TRUSTED_ROOM_IDS.has(roomId)) return { trusted: true, reason: 'allowlist' };
  if (state.trustedManagedRooms?.[roomId]) return { trusted: true, reason: 'managed' };
  if (inviterMxid && MATRIX_TRUSTED_INVITER_MXIDS.has(inviterMxid)) return { trusted: true, reason: 'trusted_inviter' };
  return { trusted: false, reason: 'unknown_room' };
}

function markRoomTrusted(roomId, meta = {}) {
  if (!state.trustedManagedRooms) state.trustedManagedRooms = {};
  let changed = false;
  if (!state.trustedManagedRooms[roomId]) {
    state.trustedManagedRooms[roomId] = { ...meta, addedAt: Date.now() };
    changed = true;
  }
  const ownerMxid = typeof meta.ownerMxid === 'string' ? meta.ownerMxid : meta.inviter;
  if (typeof meta.agent === 'string' && /^@[^:\s]+:[^\s]+$/.test(ownerMxid || '')) {
    const existing = findRoomAgentBinding(roomId, meta.agent);
    if (!existing) {
      upsertRoomAgentBinding(roomId, meta.agent, ownerMxid, {
        approvalDmRoomId: meta.approvalDmRoomId,
        addedAt: meta.addedAt,
      });
      changed = true;
    }
  }
  if (changed) saveState();
}

function roomTrustLog(action, roomId, trust, extra = '') {
  const tag = trust.trusted ? 'TRUSTED' : 'UNTRUSTED';
  const detail = extra ? ` ${extra}` : '';
  console.log(`[trust:${MATRIX_TRUST_MODE}] ${action} room=${roomId} ${tag} reason=${trust.reason}${detail}`);
}

/*
 * Which messages in a room the bot has JUST JOINED still need routing.
 *
 * THE DEFECT THIS EXISTS FOR. Sync only delivers events from after the join point,
 * and nothing backfilled a room the bot joined by invite. So anything said between
 * the invite and the join was lost permanently — no engagement, no reply, no error.
 * Reproduced against the live deployment: a `!request` sent at t+0 into a freshly
 * created room, bot joined at t+2s, and 80 seconds later there was still no answer.
 * That window is not exotic; inviting the bot and immediately stating what you want
 * is the obvious way to use it.
 *
 * `backfillAgentManagedRooms()` did not cover this. It only walks rooms that already
 * have an agent BINDING, and a project room asking for its first agent has none —
 * the backfill was gated on the very state the dropped message was trying to create.
 *
 * WHY THE INVITE TIMESTAMP IS THE FLOOR. A room may carry long history the bot can
 * now read, and replaying it would execute commands nobody just issued — including
 * `!request`s from a previous membership if the bot was invited, left, and
 * re-invited. Events at or after THIS invite are the ones addressed to this join.
 *
 * This decides only WHICH events to deliver. Trust, sender filtering and dedup stay
 * in onRoomMessage, so a backfilled event is gated exactly like a synced one.
 */
/*
 * When the bot was invited — the floor for what a fresh join owes a reply to.
 *
 * WHY THIS IS ITS OWN FUNCTION, AND NOT `inviteEvent.origin_server_ts`. That was the
 * first attempt and it silently discarded every message the fix exists for. The
 * invite handed to `room.invite` comes from sync's `invite_state`, which is STRIPPED
 * state: it carries type, sender, state_key and content, and no `origin_server_ts` at
 * all. So the timestamp was always absent, the fallback was `Date.now()`, and a floor
 * of "now" sits AFTER the pre-join message. The live log said it plainly once it was
 * asked to — `fetched=10 eligible=0` on three consecutive runs.
 *
 * Four sources, most precise first. `unsigned.age` is the one that actually fires for
 * a stripped invite, and matrix-bot-sdk reads the same field to pick between
 * competing invites, so it is reliably present.
 */
export function resolveJoinBackfillFloor(chunk, {
  botUserId = null, inviteEvent = null, now = Date.now(), windowMs = 0,
} = {}) {
  const exact = Number(inviteEvent?.origin_server_ts) || 0;
  if (exact > 0) return { floor: exact, source: 'invite-ts' };

  const age = Number(inviteEvent?.unsigned?.age) || 0;
  // Guard against a nonsensical age putting the floor in the future.
  if (age > 0 && age <= now) return { floor: now - age, source: 'invite-age' };

  // The invite is also a real timeline event, so the fetch we already did usually
  // contains it with a true timestamp.
  for (const event of Array.isArray(chunk) ? chunk : []) {
    if (event?.type !== 'm.room.member') continue;
    if (event.state_key !== botUserId) continue;
    if (event.content?.membership !== 'invite') continue;
    const ts = Number(event.origin_server_ts) || 0;
    if (ts > 0) return { floor: ts, source: 'timeline-invite' };
  }

  /*
   * Last resort: a bounded lookback. Deliberately NOT "everything" — a room can carry
   * long history the bot may now read, and replaying it would run commands nobody
   * just issued. Deliberately not "nothing" either, which is the bug this replaces.
   */
  return { floor: Math.max(0, now - windowMs), source: 'window' };
}

export function pendingJoinBackfill(chunk, { inviteTs = 0, botUserId = null, seen = null } = {}) {
  const events = Array.isArray(chunk) ? chunk : [];
  const floor = Number(inviteTs) || 0;
  const out = [];
  for (const event of events) {
    if (event?.type !== 'm.room.message') continue;
    if (!event.event_id) continue;
    // The bot's own messages would loop, and its join notice is not a command.
    if (botUserId && event.sender === botUserId) continue;
    const ts = Number(event.origin_server_ts || 0);
    // No timestamp means the floor cannot be honoured, and replaying an event that
    // might predate the invite is worse than missing it.
    if (!ts || ts < floor) continue;
    if (seen && seen.has(event.event_id)) continue;
    out.push(event);
  }
  // /messages?dir=b returns newest first; commands must run in the order they were
  // said, so oldest first.
  return out.sort((a, b) => Number(a.origin_server_ts) - Number(b.origin_server_ts));
}

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
  let olCounter = 0;

  for (const line of lines) {
    const blockMatch = line.match(/^@@BLOCK(\d+)@@$/);
    if (blockMatch) {
      olCounter = 0;
      out.push(codeBlocks[Number(blockMatch[1])] || '');
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (line.trim().length === 0) {
      olCounter = 0;
      out.push('');
      continue;
    }
    if (headingMatch) {
      olCounter = 0;
      out.push(`<strong>${renderMarkdownInline(headingMatch[2])}</strong>`);
      continue;
    }
    if (unorderedMatch) {
      olCounter = 0;
      out.push(`• ${renderMarkdownInline(unorderedMatch[1])}`);
      continue;
    }
    if (orderedMatch) {
      olCounter++;
      out.push(`${olCounter}. ${renderMarkdownInline(orderedMatch[1])}`);
      continue;
    }
    if (quoteMatch) {
      olCounter = 0;
      out.push(`&gt; ${renderMarkdownInline(quoteMatch[1])}`);
      continue;
    }
    olCounter = 0;
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

export function parseInboundTextMessage(content) {
  if (!content || typeof content !== 'object') {
    return { skip: true, body: '', replyEventId: null, threadRootEventId: null };
  }
  const msgType = typeof content.msgtype === 'string' ? content.msgtype : '';
  const relates = content['m.relates_to'] || {};
  if (relates.rel_type === 'm.replace') {
    // Ignore edit events: they should not create a new hafleet message.
    return { skip: true, body: '', replyEventId: null, threadRootEventId: null };
  }
  const threadRootEventId = relates.rel_type === 'm.thread' && typeof relates.event_id === 'string'
    ? relates.event_id
    : null;
  const replyEventId = relates?.['m.in_reply_to']?.event_id || threadRootEventId || null;
  if (msgType === 'm.image') {
    const body = buildImageInboundBody(content);
    return { skip: !body, body, replyEventId, threadRootEventId };
  }
  if (msgType === 'm.file') {
    const body = buildFileInboundBody(content);
    return { skip: !body, body, replyEventId, threadRootEventId };
  }
  if (msgType && !['m.text', 'm.notice'].includes(msgType)) {
    return { skip: true, body: '', replyEventId: null, threadRootEventId: null };
  }
  const rawBody = typeof content.body === 'string' ? content.body : '';
  const body = replyEventId ? stripMatrixReplyFallback(rawBody) : rawBody.trim();
  return { skip: !body, body, replyEventId, threadRootEventId };
}

export function resolveGroupReplyRelation(metadata, { group, roomId } = {}) {
  if (!metadata) {
    return { kind: 'fallback', relation: null, threadRootEventId: null, reason: 'source_metadata_missing' };
  }
  if (typeof metadata.group !== 'string' || metadata.group !== group) {
    return { kind: 'reject', relation: null, threadRootEventId: null, reason: 'source_group_mismatch' };
  }
  const delivery = metadata.source === 'matrix'
    ? metadata.matrixContext
    : metadata.matrixDelivery;
  if (!delivery || typeof delivery !== 'object') {
    return { kind: 'fallback', relation: null, threadRootEventId: null, reason: 'source_matrix_delivery_missing' };
  }
  if (typeof delivery.roomId !== 'string' || delivery.roomId !== roomId) {
    return { kind: 'reject', relation: null, threadRootEventId: null, reason: 'source_room_mismatch' };
  }
  const targetEventId = metadata.source === 'matrix'
    ? delivery.eventId
    : delivery.primaryEventId;
  if (typeof targetEventId !== 'string' || !targetEventId) {
    return { kind: 'fallback', relation: null, threadRootEventId: null, reason: 'source_primary_event_missing' };
  }
  const threadRootEventId = typeof delivery.threadRootEventId === 'string' && delivery.threadRootEventId
    ? delivery.threadRootEventId
    : null;
  if (threadRootEventId) {
    return {
      kind: 'relation',
      threadRootEventId,
      relation: {
        rel_type: 'm.thread',
        event_id: threadRootEventId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: targetEventId },
      },
    };
  }
  return {
    kind: 'relation',
    threadRootEventId: null,
    relation: {
      'm.in_reply_to': { event_id: targetEventId },
    },
  };
}

function shouldIgnoreAgentForward(content) {
  const rawBody = typeof content?.body === 'string' ? content.body : '';
  return /^\[agentignore\]/i.test(rawBody);
}

// ── Main bridge class ─────────────────────────────────────────────────
export class MatrixBridge {
  constructor({
    eventStore = null,
    matrixDeliveryJournal = null,
    pendingEncryptedEventStore = null,
    approvalDmMode = APPROVAL_DM_MODE,
  } = {}) {
    this.botClient = null;
    this.botUserId = null;
    this.approvalDmMode = approvalDmMode;
    this.knownAgents = new Set(); // names of known agents
    this.knownAgentIndex = new Map(); // lower-case name -> canonical name
    this.dmRooms = new Map(); // "agent:human" → roomId
    this.upgradedDmRooms = new Set(); // rooms already checked/upgraded this session
    this.recentBridgedIds = new Set(); // prevent echo loops
    this.recentSystemInfoIds = new Set(); // dedupe system_info SSE events
    this.recentAgentCompactIds = new Set(); // dedupe compact SSE events
    this.recentlyCreatedRooms = new Set(); // rooms we just created (suppress echo)
    this.recentMatrixEvents = new Map(); // event_id -> { ts, msgId }
    this.eventStore = eventStore || new MatrixEventStore({
      journalPath: path.join(DATA_DIR, 'processed-events.jsonl'),
    });
    this.matrixDeliveryJournal = matrixDeliveryJournal || new MatrixDeliveryJournal({
      journalPath: path.join(DATA_DIR, 'pending-matrix-deliveries.jsonl'),
    });
    this.pendingEncryptedEventStore = pendingEncryptedEventStore || new PendingEncryptedEventStore(
      path.join(DATA_DIR, 'pending-approval-encrypted-events.json'),
    );
    this._retryingPendingApprovalDecryptions = null;
    this.processingMatrixEventIds = new Map();
    this._msgRouteMetadataCache = new Map(); // reply_to message id -> persisted route metadata (capped)
    this.blockedAlertRooms = new Map(); // agent -> Set(roomId)
    this.startupTs = Date.now();
    this.commands = null;
    // Warning storm protection — delegated to NotificationRouter
    this._backendHealthy = true;          // false when backend is unresponsive
    this._reconcileSuspendLogged = false; // log suspension only once
    this._loggedUntrustedRooms = new Set(); // dedup scan-joined trust logs
    this._bridgeCreatedGroups = new Set(); // groups we POST'd — skip SSE echo
    this._recentSystemInfoWarningKeys = new Map(); // alert dedupeKey -> last bridged ts
    this._agentRoomBackfillRunning = false;
    // Task 8: standalone cross-component doctor — business-health record inputs.
    this._lastSuccessfulSyncAtMs = null;
    this._requiredMembershipSummary = new Map(); // roomId -> { roomId, group, requiredAgent, botJoined, agentJoined, joinedAgentNames }
    this._warningRouter = new NotificationRouter({
      warning: {
        cooldownMs: WARNING_DEDUPE_WINDOW_MS,
        dedupeKeyFn: (p) => p.dedupeKey || 'default',
        circuitBreaker: { threshold: WARNING_CB_THRESHOLD, cooldownMs: WARNING_CB_COOLDOWN_MS },
        sinks: ['backend-log'],
      },
    }, {
      'backend-log': (_family, payload) => {
        const body = { summary: payload.summary, full: payload.full || '' };
        if (payload.alertType) body.alertType = payload.alertType;
        if (payload.dedupeKey) body.dedupeKey = payload.dedupeKey;
        return backendApi('POST', '/api/system/info', body).then(() => {
          if (!this._backendHealthy) {
            this._backendHealthy = true;
            this._reconcileSuspendLogged = false;
            console.log('Backend reachable again — resuming reconcile polling');
          }
        }).catch(e => {
          console.error('Failed to post warning:', e.message);
          this._backendHealthy = false;
          throw e; // re-throw so router CB tracks the failure
        });
      },
    });
  }

  callBackendApi(method, routePath, body, contextLabel = '') {
    return backendApi(method, routePath, body, contextLabel);
  }

  // ── Task 8: standalone cross-component doctor — business-health record ──────
  // Coarse pass: refresh which trusted managed rooms the bot currently sits in.
  // Called from scanJoinedRooms(), which already fetches the joined-room list, so
  // this adds zero Matrix API calls. DM/bot-DM rooms are excluded — the health
  // summary exists for the acceptance-room membership check (group and
  // agent-managed rooms), not the per-human DM inventory.
  _syncRequiredMembershipBotPresence(joinedRoomIds) {
    const joinedSet = new Set(joinedRoomIds);
    const next = new Map();
    for (const [roomId, meta] of Object.entries(state.trustedManagedRooms || {})) {
      if (meta?.dm || meta?.botDm || meta?.approvalDm) continue;
      const previous = this._requiredMembershipSummary.get(roomId);
      const boundAgents = roomAgentBindingEntries(roomId).map(([agentName]) => agentName);
      if (boundAgents.length === 0 && typeof meta?.agent === 'string' && meta.agent.trim()) {
        boundAgents.push(meta.agent.trim());
      }
      const requiredAgent = boundAgents.length === 1
        ? boundAgents[0]
        : null;
      next.set(roomId, {
        roomId,
        group: typeof meta?.group === 'string' ? meta.group : null,
        requiredAgent,
        botJoined: joinedSet.has(roomId),
        agentJoined: previous?.agentJoined ?? null,
        joinedAgentNames: previous?.joinedAgentNames || [],
      });
    }
    this._requiredMembershipSummary = next;
  }

  // Detail pass: record which agent-user Matrix members are actually in a given
  // room. Called from reconcileRoomGroupMembership(), which already fetches this
  // room's joined members for backend-group reconciliation — again zero extra
  // Matrix API calls. No-ops for a room _syncRequiredMembershipBotPresence hasn't
  // seen yet (e.g. an untrusted or not-yet-scanned room).
  _recordMembershipDetail(roomId, joinedAgentNames) {
    const entry = this._requiredMembershipSummary.get(roomId);
    if (!entry) return;
    entry.joinedAgentNames = [...joinedAgentNames];
    entry.agentJoined = entry.requiredAgent
      ? joinedAgentNames.some((name) => this.sameName(name, entry.requiredAgent))
      : null;
  }

  // Persists data/health/matrix-bridge.json (0600, atomic). Never throws — a health
  // record write failure must not take down the bridge itself; the standalone
  // doctor already treats a missing/stale record as its own failure signal.
  writeHealthRecord() {
    try {
      writeBridgeHealthRecord(RUNTIME_ROOT, {
        pid: process.pid,
        startedAt: this.startupTs,
        processStartIdentity: getProcessStartIdentity(process.pid),
        lastSuccessfulSyncAt: this._lastSuccessfulSyncAtMs,
        lastSuccessfulBackendDeliveryAt: bridgeHealthState.lastSuccessfulBackendDeliveryAtMs,
        lastObservedRateLimitAt: rateLimitGate.lastObservedAtMs(),
        managedRoomCount: Object.keys(state.trustedManagedRooms || {}).length,
        requiredMembership: [...this._requiredMembershipSummary.values()],
      });
    } catch (e) {
      console.error(`Failed to write bridge health record: ${e.message}`);
    }
  }

  // Load persisted route metadata for a prior message. Authorization decisions
  // are made by the caller for the current agent/human pair; the cache never
  // stores an already-authorized room. Confirmed misses cache as null while
  // transient backend failures remain retryable.
  async lookupMessageRouteMetadata(messageId) {
    if (typeof messageId !== 'string' || !messageId) return null;
    if (this._msgRouteMetadataCache.has(messageId)) return this._msgRouteMetadataCache.get(messageId);
    let metadata = null;
    try {
      const msg = await this.callBackendApi('GET', `/api/messages/${encodeURIComponent(messageId)}`);
      if (msg && !msg.error) {
        metadata = {
          from: msg.from || null,
          to: msg.to || null,
          group: msg.group,
          source: msg.source || null,
          sourceRoom: msg.source_room || msg.sourceRoom || null,
          senderMxid: msg.sender_mxid || msg.senderMxid || null,
          fromId: msg.from_id || msg.fromId || null,
          matrixContext: msg.matrix_context || msg.matrixContext || null,
          matrixDelivery: msg.matrix_delivery || msg.matrixDelivery || null,
        };
      }
    } catch (e) {
      console.warn(`reply_to route metadata lookup failed for ${messageId}: ${e.message}`);
      return null; // transient failure — don't poison the cache
    }
    if (this._msgRouteMetadataCache.size >= 200) {
      this._msgRouteMetadataCache.delete(this._msgRouteMetadataCache.keys().next().value);
    }
    this._msgRouteMetadataCache.set(messageId, metadata);
    return metadata;
  }

  async lookupMessageSourceRoom(messageId) {
    const metadata = await this.lookupMessageRouteMetadata(messageId);
    return metadata?.sourceRoom || null;
  }

  async lookupVerifiedDirectReplyRoom(messageId, { agentName, humanName } = {}) {
    const metadata = await this.lookupMessageRouteMetadata(messageId);
    return verifiedDirectReplyRoom(metadata, { agentName, humanName });
  }

  async persistPendingMatrixDelivery(record) {
    await this.callBackendApi(
      'PUT',
      `/api/messages/${encodeURIComponent(record.messageId)}/matrix-delivery`,
      {
        room_id: record.roomId,
        primary_event_id: record.primaryEventId,
        thread_root_event_id: record.threadRootEventId,
      },
      `context=matrix-delivery message=${record.messageId}`,
    );
    this._msgRouteMetadataCache.delete(record.messageId);
    return this.matrixDeliveryJournal.markCommitted(record.messageId);
  }

  async replayPendingMatrixDeliveries() {
    const pending = this.matrixDeliveryJournal.pending();
    for (const record of pending) {
      try {
        await this.persistPendingMatrixDelivery(record);
        console.log(`[matrix-delivery] recovered message=${record.messageId} event=${record.primaryEventId}`);
      } catch (error) {
        console.warn(`[matrix-delivery] recovery deferred message=${record.messageId}: ${error.message}`);
      }
    }
    return pending.length;
  }

  async resolveOutboundGroupRelation(msg, roomId) {
    if (!msg?.reply_to) {
      return { ok: true, relation: null, threadRootEventId: null };
    }
    const metadata = await this.lookupMessageRouteMetadata(msg.reply_to);
    const resolution = resolveGroupReplyRelation(metadata, { group: msg.group, roomId });
    if (resolution.kind === 'reject') {
      this.postWarning(
        `Blocked Matrix group reply ${msg.id}: ${resolution.reason} (reply_to=${msg.reply_to})`,
        { kind: 'thread-routing', scope: msg.group || roomId },
      );
      return { ok: false, relation: null, threadRootEventId: null, reason: resolution.reason };
    }
    if (resolution.kind === 'fallback') {
      console.warn(`[matrix-thread] top-level compatibility fallback message=${msg.id} reply_to=${msg.reply_to} reason=${resolution.reason}`);
      this.postWarning(
        `Matrix thread context unavailable for ${msg.id}; sent at room top level (${resolution.reason})`,
        { kind: 'thread-compatibility', scope: msg.group || roomId },
      );
      return { ok: true, relation: null, threadRootEventId: null, fallback: true };
    }
    return {
      ok: true,
      relation: resolution.relation,
      threadRootEventId: resolution.threadRootEventId,
    };
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

  managedAgentBotInviteTrust(roomId, inviterMxid) {
    if (!inviterMxid || !isAgentUser(inviterMxid)) return null;

    const inviterAgent = agentNameFromUserId(inviterMxid);
    const canonicalAgent = this.resolveKnownAgentName(inviterAgent);
    const managedBinding = findRoomAgentBinding(roomId, canonicalAgent);
    if (!canonicalAgent || !managedBinding) return null;

    // Do not trust an agent-looking account from another homeserver, nor a
    // different local agent. The room became managed only after a trusted
    // developer invited this exact local puppet and it successfully joined.
    if (inviterMxid !== agentUserId(canonicalAgent)) return null;
    return { trusted: true, reason: 'managed_agent' };
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
      roomAgentBindings: state.roomAgentBindings || {},
      agentTokens: Object.fromEntries(Object.keys(state.agentTokens).map(k => [k, '***'])),
    };
  }

  // Expose groupRoomMap for /group command
  get groupRoomMap() { return state.groupRoomMap; }

  // !bindroom primitive: bind an EXISTING room to an existing backend group
  // (multi-instance shared rooms — no room/group creation). Reuses mapRoom for
  // rebind cleanup, trust marking, and state persistence.
  bindRoom(roomId, groupName) { mapRoom(roomId, groupName); }
  groupForRoom(roomId) { return groupForRoom(roomId); }
  recordRoomAgentBinding(roomId, agentName, ownerMxid, options = {}) {
    const result = upsertRoomAgentBinding(roomId, agentName, ownerMxid, options);
    if (result) saveState();
    return result;
  }
  roomAgentBindings(roomId) {
    return roomAgentBindingEntries(roomId)
      .map(([agentName, binding]) => ({ agentName, ...binding }));
  }

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
    return this.recentMatrixEvents.has(eventId) || this.eventStore.has(eventId);
  }

  checkpointMatrixEvent(eventId, messageId) {
    if (!eventId || !messageId) return null;
    const record = this.eventStore.recordProcessed({ eventId, messageId });
    this.rememberMatrixEvent(eventId, record.messageId);
    return record;
  }

  resolveReplyToMessageId(replyEventId) {
    if (!replyEventId) return null;
    return this.recentMatrixEvents.get(replyEventId)?.msgId
      || this.eventStore.get(replyEventId)?.messageId
      || null;
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

  postWarning(message, { kind = 'general', scope = '' } = {}) {
    const prefix = (message.match(/^[A-Za-z ]+/) || [''])[0].trim();
    const dedupeKey = `bridge_warning:${kind}:${scope}:${prefix}`;
    this._warningRouter.emit('warning', {
      dedupeKey,
      summary: `⚠️ Bridge warning: ${message}`,
      full: '',
      alertType: 'bridge_warning',
    });
  }

  async start() {
    if (!MATRIX_BRIDGE_SECRET) {
      throw new Error('MATRIX_BRIDGE_SECRET is required for reliable Matrix ingestion');
    }
    console.log('=== Agent Chat Matrix Bridge ===');
    console.log(`Homeserver: ${HOMESERVER}`);
    console.log(`Backend: ${BACKEND_URL}`);

    // 0. Wait for backend to be ready
    const STARTUP_MAX_RETRIES = 5;
    const STARTUP_RETRY_DELAY_MS = 2000;
    for (let attempt = 1; attempt <= STARTUP_MAX_RETRIES; attempt++) {
      try {
        await backendApi('GET', '/health', null, 'context=bridge:startup-health-check');
        console.log('Backend health check passed');
        break;
      } catch (e) {
        if (attempt === STARTUP_MAX_RETRIES) {
          console.error(`[FATAL] Backend not reachable after ${STARTUP_MAX_RETRIES} attempts — exiting`);
          process.exit(1);
        }
        console.warn(`Backend not ready (attempt ${attempt}/${STARTUP_MAX_RETRIES}): ${e.message} — retrying in ${STARTUP_RETRY_DELAY_MS}ms`);
        await sleep(STARTUP_RETRY_DELAY_MS);
      }
    }
    await this.replayPendingMatrixDeliveries();

    // 1. Ensure bot account
    const botToken = await ensureBotAccount();
    const botSession = await getMatrixAccessTokenSession(botToken);
    const botCryptoPath = path.join(DATA_DIR, 'bot-crypto');
    const cryptoIdentity = reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: botCryptoPath,
      accessTokenDeviceId: botSession.deviceId,
    });
    if (cryptoIdentity.status === 'rotated') {
      console.warn(
        `[matrix-e2ee] archived stale bot crypto store device=${cryptoIdentity.storedDeviceId} `
        + `token_device=${cryptoIdentity.accessTokenDeviceId} archive=${cryptoIdentity.archivePath}`,
      );
    }
    this.botClient = new ReliableMatrixClient(
      HOMESERVER,
      botToken,
      new SimpleFsStorageProvider(path.join(DATA_DIR, 'bot-store.json')),
      // RustSdkCryptoStoreType.Sqlite is numeric value 0 in matrix-sdk-crypto.
      new RustSdkCryptoStorageProvider(botCryptoPath, 0),
    );
    this.configureReliableBotSync(this.botClient);
    this.botClient.onSyncSuccess = async () => {
      this._lastSuccessfulSyncAtMs = Date.now();
      await this.retryPendingApprovalDecryptions(this.botClient);
    };
    this.botUserId = await this.botClient.getUserId();
    console.log(`Bot: ${this.botUserId}`);

    // 2. Ensure agent accounts for all known agents.
    // Service relays (e.g. OpenFab's `openfab-bridge`) post in-app only and never need a Matrix
    // puppet — skip them. And a single agent's account failure must not crash the whole bridge.
    const agents = await this.fetchKnownAgentNames();
    const validAgentNames = new Set();
    const validAgentKeys = new Set();
    for (const agentName of agents) {
      if (SKIP_AGENTS.has(agentName)) {
        console.log(`Skipping Matrix puppet for service agent: ${agentName}`);
        continue;
      }
      validAgentNames.add(agentName);
      validAgentKeys.add(this.nameKey(agentName));
      try {
        await ensureAgentAccount(agentName);
        this.addKnownAgent(agentName);
      } catch (e) {
        console.warn(`Skipping agent ${agentName} (account setup failed): ${e.message}`);
      }
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

    // 4. Start bot sync. ReliableMatrixClient awaits bridge handlers before
    // persisting the SDK sync token.
    await this.botClient.start();
    assertMatrixCryptoDeviceIdentity(
      this.botClient.crypto?.clientDeviceId,
      botSession.deviceId,
    );
    console.log(`[matrix-e2ee] bot crypto device verified device=${botSession.deviceId}`);
    console.log('Bot syncing...');

    // 6. Listen to backend SSE for hafleet → Matrix
    this.connectSSE();

    // 7. Scan all joined rooms for unmapped groups + backfill avatars
    await this.scanJoinedRooms();
    if (AUTO_AVATAR_ENABLED) {
      await this.backfillAvatars();
    }
    await this.backfillAgentManagedRooms();
    await this.syncApprovalBindings();
    setInterval(() => this.scanJoinedRooms(), MATRIX_ROOM_SCAN_POLL_MS);
    // Task 8: standalone doctor's business-health record. Independent of the room-scan
    // timer above (see BRIDGE_HEALTH_WRITE_INTERVAL_MS) so the record's freshness isn't
    // coupled to how MATRIX_ROOM_SCAN_POLL_MS happens to be tuned.
    this.writeHealthRecord();
    setInterval(() => this.writeHealthRecord(), BRIDGE_HEALTH_WRITE_INTERVAL_MS);

    // 8. Periodically check agent accounts for pending invites
    this.pollAgentInvites();
    setInterval(() => this.pollAgentInvites(), MATRIX_INVITE_POLL_MS);

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
        if (SKIP_AGENTS.has(agentName)) continue;
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
    const candidates = new Map();

    for (const rawUser of MATRIX_GREETING_MXIDS) {
      const userId = humanUserId(rawUser);
      candidates.set(userId, { user_id: userId });
    }

    if (!rateLimitGate.beforeRequest()) {
      console.warn('Human discovery: cooling down (Matrix rate limit), skipping user directory search this round');
    } else {
      try {
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user_directory/search`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ search_term: '', limit: 100 }),
        });
        if (await rateLimitGate.observeResponse(res)) {
          console.warn('Human discovery: 429 from user directory search; shared cooldown updated');
        } else {
          const data = await res.json();
          for (const user of data.results || []) {
            if (user?.user_id) candidates.set(user.user_id, user);
          }
        }
      } catch (e) {
        if (!rateLimitGate.observeError(e)) {
          console.error('Failed to discover humans:', e.message);
        }
      }
    }

    for (const user of candidates.values()) {
      // A 429 from any earlier candidate's createRoom/sendMessage (below) trips the
      // shared gate — abort the rest of this batch rather than keep greeting through
      // it. A busy server's first run (or a freshly-expanded MATRIX_GREETING_MXIDS)
      // can otherwise fan out N greet attempts back-to-back in one tick.
      if (!rateLimitGate.beforeRequest()) {
        console.warn('Human discovery: cooling down (Matrix rate limit), aborting remaining candidates this round');
        break;
      }
      const match = user.user_id.match(/^@([^:]+):/);
      if (!match) continue;
      const name = match[1];

      // Skip agents, bot, system accounts, underscore-prefixed
      if (name.startsWith(AGENT_PREFIX)) continue;
      if (name.startsWith('_')) continue;
      if (SKIP_USERS.has(name)) continue;
      if (state.greetedHumans.includes(humanDmKey(name))) continue;

      // This is an ungreeted human — create DM and greet
      await this.greetHuman(name, user.user_id);
    }
  }

  async ensureBotDmRoom(humanName, matrixUserId) {
    if (!state.botDmRooms) state.botDmRooms = {};
    const dmKey = humanDmKey(humanName);
    if (state.botDmRooms[dmKey]) return state.botDmRooms[dmKey];

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
      if (await rateLimitGate.observeResponse(res)) {
        console.warn(`Bot DM room: 429 creating room for ${humanName}; shared cooldown updated`);
        return null;
      }
      const data = await res.json();
      if (data.room_id) {
        state.botDmRooms[dmKey] = data.room_id;
        saveState();
        return data.room_id;
      }
      console.error(`Failed to create bot DM room for ${humanName}:`, data);
    } catch (e) {
      if (!rateLimitGate.observeError(e)) {
        console.error(`Error creating bot DM room for ${humanName}:`, e.message);
      }
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
      state.greetedHumans.push(humanDmKey(humanName));
      saveState();
      console.log(`Greeted human: ${humanName}`);
    } catch (e) {
      if (!rateLimitGate.observeError(e)) {
        console.error(`Failed to greet ${humanName}:`, e.message);
      }
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
          throw new Error(detail, { cause: retryError });
        }
      }
      const detail = String(e?.message || e);
      await this.sendDeliveryNotice(roomId, `⚠️ Message delivery failed (${detail}).`);
      throw new Error(detail, { cause: e });
    }
  }

  configureReliableBotSync(client) {
    client.persistTokenAfterSync = true;
    client.agentChatSyncHandler = async (eventName, ...payload) => {
      if (eventName === 'room.message') return this.onRoomMessage(...payload);
      if (eventName === 'room.event') {
        if (client.crypto) await client.crypto.onRoomEvent(...payload);
        return this.onRoomEvent(...payload);
      }
      if (eventName === 'room.join' && client.crypto) {
        return client.crypto.onRoomJoin(...payload);
      }
      if (eventName === 'room.failed_decryption') {
        return this.onFailedRoomDecryption(client, ...payload);
      }
      if (eventName === 'room.invite') {
        return this.handleBotInvite(...payload, { source: 'bot-invite' });
      }
      return client.emit(eventName, ...payload);
    };
    return client;
  }

  async onFailedRoomDecryption(client, roomId, event, error) {
    const meta = state.trustedManagedRooms?.[roomId];
    if (!meta?.approvalDm) return client.emit('room.failed_decryption', roomId, event, error);

    try {
      this.pendingEncryptedEventStore.put({ roomId, event });
    } catch (storeError) {
      // Never advance the durable sync token when an approval verdict cannot be
      // durably retained for a later room-key delivery.
      throw new Error(`failed to retain encrypted approval event ${event?.event_id || '<unknown>'}: ${storeError.message}`);
    }
    console.warn(`[approval-e2ee] queued undecryptable event room=${roomId} event=${event?.event_id || '<unknown>'}`);
    return client.emit('room.failed_decryption', roomId, event, error);
  }

  async retryPendingApprovalDecryptions(client = this.botClient) {
    if (this._retryingPendingApprovalDecryptions) return this._retryingPendingApprovalDecryptions;
    this._retryingPendingApprovalDecryptions = this._doRetryPendingApprovalDecryptions(client);
    try {
      return await this._retryingPendingApprovalDecryptions;
    } finally {
      this._retryingPendingApprovalDecryptions = null;
    }
  }

  async _doRetryPendingApprovalDecryptions(client) {
    if (!client?.crypto) return { processed: 0, pending: this.pendingEncryptedEventStore.list().length };
    for (const expired of this.pendingEncryptedEventStore.prune()) {
      console.warn(`[approval-e2ee] discarded stale encrypted event room=${expired.roomId} event=${expired.eventId}`);
    }

    let processed = 0;
    for (const record of this.pendingEncryptedEventStore.list()) {
      const meta = state.trustedManagedRooms?.[record.roomId];
      if (!meta?.approvalDm) {
        this.pendingEncryptedEventStore.remove(record.eventId);
        continue;
      }
      try {
        const decrypted = await client.crypto.decryptRoomEvent(
          new EncryptedRoomEvent(record.event),
          record.roomId,
        );
        const clearEvent = decrypted?.raw;
        if (clearEvent?.type === 'm.room.message') {
          await this.onRoomMessage(record.roomId, clearEvent);
        }
        this.pendingEncryptedEventStore.remove(record.eventId);
        processed += 1;
        console.log(`[approval-e2ee] recovered encrypted event room=${record.roomId} event=${record.eventId}`);
      } catch (retryError) {
        console.warn(`[approval-e2ee] event still awaiting room key room=${record.roomId} event=${record.eventId}: ${retryError.message}`);
      }
    }
    return { processed, pending: this.pendingEncryptedEventStore.list().length };
  }

  // ── Matrix → Agent-chat ───────────────────────────────────────────
  async onRoomMessage(roomId, event) {
    const eventId = event?.event_id || null;
    if (!eventId) {
      console.warn(`[matrix-ingress] ignored event without event_id room=${roomId}`);
      return { ignored: true, reason: 'missing_event_id' };
    }
    if (eventId && this.isDuplicateMatrixEvent(eventId)) return;
    const inFlight = this.processingMatrixEventIds.get(eventId);
    if (inFlight) return inFlight;
    const attempt = this._onRoomMessageClaimed(roomId, event, eventId);
    this.processingMatrixEventIds.set(eventId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.processingMatrixEventIds.get(eventId) === attempt) {
        this.processingMatrixEventIds.delete(eventId);
      }
    }
  }

  async _onRoomMessageClaimed(roomId, event, eventId) {
    const approvalVerdict = parseApprovalVerdictEvent(roomId, event);
    if (approvalVerdict) {
      return this.onApprovalVerdict(approvalVerdict);
    }
    if (shouldIgnoreAgentForward(event?.content)) return;

    const parsed = parseInboundTextMessage(event.content);
    if (parsed.skip) return;

    const senderId = event.sender;

    // Ignore messages from our agent accounts (prevent loops)
    if (isAgentUser(senderId)) return;
    if (senderId === this.botUserId) return;
    if (MATRIX_IGNORED_SENDER_MXIDS.has(senderId)) return;

    // Room trust gate (5.8.1)
    const msgTrust = getRoomTrust(roomId);
    if (!msgTrust.trusted) {
      roomTrustLog('message-ingress', roomId, msgTrust, `sender=${senderId}`);
      if (MATRIX_TRUST_MODE === 'enforce') return;
    }

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
    let effectiveMentions = [...new Set(mentions
      // Matrix rooms may also contain Octos or other external bot pills.
      // Only registered hafleet agents are routable mention targets.
      .map(name => this.resolveKnownAgentName(name))
      .filter(Boolean))];

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
    let agentMembers = [];
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      agentMembers = nonBot.filter(m => isAgentUser(m));
      const humanMembers = nonBot.filter(m => !isAgentUser(m));

      if (agentMembers.length === 1 && humanMembers.length >= 1 && !isAgentUser(senderId)) {
        // 1 agent + 1-2 humans + bot → agent DM
        targetAgent = agentNameFromUserId(agentMembers[0]);
      } else if (agentMembers.length === 0 && humanMembers.length === 1) {
        // Exactly 1 human + bot in room → bot command DM
        isBotDm = true;
      }
    } catch (e) {
      console.warn(`Failed to inspect room members for ${roomId}: ${e.message}`);
    }
    if (!targetAgent && state.trustedManagedRooms?.[roomId]) {
      const managedAgents = roomAgentBindingEntries(roomId)
        .map(([agentName]) => this.resolveKnownAgentName(agentName) || this.normalizeName(agentName))
        .filter(Boolean);
      const explicitlyMentioned = managedAgents
        .filter(agentName => effectiveMentions.some(name => this.sameName(name, agentName)));
      if (explicitlyMentioned.length === 1) {
        [targetAgent] = explicitlyMentioned;
      } else if (!groupName && managedAgents.length > 0) {
        // A trusted agent-managed room is not necessarily a DM. Until the bot
        // has joined and mapped the room, fail closed instead of treating every
        // message in a potentially-public project room as direct agent input.
        console.log(`Matrix managed room ignored unaddressed or ambiguous message: ${humanName} room=${roomId}`);
        this.rememberMatrixEvent(eventId);
        return { ignored: true, reason: 'managed_room_unaddressed' };
      }
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
      const context = {
        groupName,
        targetAgent,
        approvalRoom: state.trustedManagedRooms?.[roomId]?.approvalDm === true,
      };
      console.log(`Bot command from ${humanName} in ${groupName || targetAgent || 'bot-DM'}: ${cmdBody.slice(0, 80)}`);
      await this.commands.handle(roomId, senderId, cmdBody, context);
      if (eventId) this.rememberMatrixEvent(eventId);
      return;
    }

    // Route: group mapping wins over DM auto-detection so a mapped room with a
    // single agent still behaves as a group (bot-DM is still checked first).
    const route = resolveInboundRoute({ groupName, targetAgent, isBotDm });
    if (route === 'bot-dm') {
      // Non-command text in bot DM
      await this.commands.handle(roomId, senderId, body, {});
    } else if (route === 'group') {
      // Group message from human
      // Un-addressed group messages are stored but wake nobody. A private,
      // single-owner deployment may explicitly opt into the legacy default
      // recipient behavior with MATRIX_DEFAULT_WAKE=auto.
      let matrixDefaultRecipient = null;
      if (effectiveMentions.length === 0 && matrixDefaultWakeEnabled()) {
        const defaultRecipient = pickDefaultGroupRecipient(agentMembers, agentNameFromUserId);
        if (defaultRecipient) {
          effectiveMentions = [defaultRecipient];
          matrixDefaultRecipient = defaultRecipient;
        }
      }
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
        ...(eventId ? { source_event_id: eventId } : {}),
        ...(parsed.threadRootEventId ? { thread_root_event_id: parsed.threadRootEventId } : {}),
        ...(matrixDefaultRecipient ? { matrix_default_recipient: matrixDefaultRecipient } : {}),
        sender_mxid: senderId,
        trust_level: MATRIX_OPERATOR_MXIDS.has(senderId) ? 'operator' : 'external',
      });
      if (!result?.id) throw new Error('backend Matrix acceptance did not return a message id');
      this.checkpointMatrixEvent(eventId, result.id);
      return result;
    } else if (route === 'agent-dm') {
      // DM to agent
      console.log(`Matrix DM: ${humanName} → ${targetAgent}: ${body.slice(0, 80)}`);
      // Remember which room this human wrote from so the agent's reply lands
      // here rather than in the global per-(agent,human) DM room (Change 2).
      const lastRoomKey = `dm:${targetAgent}:${humanDmKey(humanName)}`;
      state.lastHumanRoom = state.lastHumanRoom || {};
      if (state.lastHumanRoom[lastRoomKey] !== roomId) {
        state.lastHumanRoom[lastRoomKey] = roomId;
        saveState();
      }
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
        ...(eventId ? { source_event_id: eventId } : {}),
        ...(parsed.threadRootEventId ? { thread_root_event_id: parsed.threadRootEventId } : {}),
        target_type: 'agent',
        sender_mxid: senderId,
        trust_level: MATRIX_OPERATOR_MXIDS.has(senderId) ? 'operator' : 'external',
      });
      if (!result?.id) throw new Error('backend Matrix acceptance did not return a message id');
      this.checkpointMatrixEvent(eventId, result.id);
      return result;
    }
    // else: unknown room, ignore
  }

  async onApprovalVerdict(verdict) {
    try {
      const result = await this.callBackendApi(
        'POST',
        `/api/approvals/${encodeURIComponent(verdict.request_id)}/verdict`,
        verdict,
        `context=approval:verdict request=${verdict.request_id}`,
      );
      if (verdict.event_id) this.rememberMatrixEvent(verdict.event_id, verdict.request_id);
      return result;
    } catch (error) {
      // Authorization, expiry, and replay failures are final for this Matrix
      // event. Transient backend failures remain replayable through the sync
      // token contract.
      const message = String(error?.message || error);
      if (/failed with HTTP (?:400|401|403|404|409|410)\b/.test(message)) {
        if (verdict.event_id) this.rememberMatrixEvent(verdict.event_id, verdict.request_id);
        console.warn(`Approval verdict rejected: request=${verdict.request_id} sender=${verdict.sender_mxid} room=${verdict.room_id}`);
        return { ok: false, rejected: true };
      }
      throw error;
    }
  }

  async onRoomEvent(roomId, event) {
    // Ignore historical events from before bridge startup
    // But always process m.room.name (needed for mapping rooms bot joins after creation)
    if (event.type !== 'm.room.name' && event.origin_server_ts && event.origin_server_ts < this.startupTs) return;

    // Room trust gate (5.8.1)
    const eventTrust = getRoomTrust(roomId);
    if (!eventTrust.trusted) {
      roomTrustLog('room-event', roomId, eventTrust, `type=${event.type}`);
      if (MATRIX_TRUST_MODE === 'enforce') return;
    }

    // Handle room creation, membership changes
    if (event.type === 'm.room.name' && event.content?.name) {
      const name = event.content.name;
      // Skip DM/SPY rooms — these are not groups
      if (isPrivateControlRoomName(name)) {
        // Don't map as group, but update roomGroupMap if it was previously mapped wrong
        const oldGroup = groupForRoom(roomId);
        if (oldGroup && isPrivateControlRoomName(oldGroup)) {
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
          this._bridgeCreatedGroups.add(name);
          await backendApi('POST', '/api/groups', {
            name,
            members: [...members, ...humanMembers],
          });
          console.log(`Created group "${name}" from Matrix room`);
        }
        mapRoom(roomId, name);
        await this.reconcileRoomGroupMembership(roomId, name);
        await this.syncApprovalBindingForRoom(roomId);
      } else {
        const mapped = groupForRoom(roomId);
        if (mapped !== name && !isPrivateControlRoomName(name)) {
          const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
          if (existing.error) {
            const joinedMembers = await this.botClient.getJoinedRoomMembers(roomId);
            const members = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
            const humanMembers = joinedMembers
              .filter(m => !isAgentUser(m) && m !== this.botUserId)
              .map(m => humanNameFromUserId(m))
              .filter(Boolean);
            this._bridgeCreatedGroups.add(name);
            await backendApi('POST', '/api/groups', {
              name,
              members: [...members, ...humanMembers],
            });
            console.log(`Created group "${name}" from Matrix room rename`);
          }
          mapRoom(roomId, name);
          console.log(`Room ${roomId} renamed mapping: "${mapped}" -> "${name}"`);
          await this.reconcileRoomGroupMembership(roomId, name);
          await this.syncApprovalBindingForRoom(roomId);
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
      if (!groupName) {
        const approvalMeta = state.trustedManagedRooms?.[roomId];
        if (approvalMeta?.approvalDm && targetUserId === approvalMeta.ownerMxid) {
          if (membership === 'join') {
            await this.syncApprovalBindings({ agent: approvalMeta.agent, ownerMxid: approvalMeta.ownerMxid });
          } else if (membership === 'leave' || membership === 'ban') {
            await this.removeApprovalBindings({ agent: approvalMeta.agent, ownerMxid: approvalMeta.ownerMxid });
          }
        }
        return;
      }
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
    // If backend was marked unhealthy, probe it before running a full scan
    if (!this._backendHealthy) {
      try {
        await backendApi('GET', '/api/agents?view=names', null, 'context=reconcile:health-probe');
        this._backendHealthy = true;
        this._reconcileSuspendLogged = false;
        console.log('Backend reachable again — resuming reconcile polling');
      } catch {
        if (!this._reconcileSuspendLogged) {
          console.warn('Reconcile suspended — backend is unresponsive');
          this._reconcileSuspendLogged = true;
        }
        return;
      }
    }
    if (!rateLimitGate.beforeRequest()) {
      console.warn('Room scan: cooling down (Matrix rate limit), skipping this round');
      return;
    }
    try {
      const rooms = await this.botClient.getJoinedRooms();
      this._syncRequiredMembershipBotPresence(rooms);
      let trusted = 0, untrusted = 0, newlyDetected = 0;
      for (const roomId of rooms) {
        // A 429 anywhere in this loop (or in tryMapRoom/reconcileRoomGroupMembership below)
        // trips the shared gate — abort the sweep rather than keep walking the room list.
        if (!rateLimitGate.beforeRequest()) {
          console.warn(`Room scan: cooling down (Matrix rate limit), aborting remaining rooms this round`);
          break;
        }
        const trust = getRoomTrust(roomId);
        if (!trust.trusted) {
          untrusted++;
          if (!this._loggedUntrustedRooms.has(roomId)) {
            this._loggedUntrustedRooms.add(roomId);
            newlyDetected++;
            roomTrustLog('scan-joined', roomId, trust);
          }
          if (MATRIX_TRUST_MODE === 'enforce') {
            try { await this.botClient.leaveRoom(roomId); } catch (e) { rateLimitGate.observeError(e); }
            continue;
          }
        } else {
          trusted++;
          this._loggedUntrustedRooms.delete(roomId);
        }
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
      if (untrusted > 0) console.log(`[trust] scan summary: ${trusted} trusted, ${untrusted} untrusted (${newlyDetected} newly detected)`);
      this.writeHealthRecord();
    } catch (e) {
      rateLimitGate.observeError(e);
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
    // Suspend reconcile during backend failure
    if (!this._backendHealthy) {
      if (!this._reconcileSuspendLogged) {
        console.warn('Reconcile suspended — backend is unresponsive');
        this._reconcileSuspendLogged = true;
      }
      return;
    }
    if (!rateLimitGate.beforeRequest()) {
      console.warn(`Reconcile: cooling down (Matrix rate limit), skipping room ${roomId}`);
      return;
    }
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
      this._recordMembershipDetail(roomId, agentMembers);
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
      rateLimitGate.observeError(e);
      console.error(`Failed to reconcile group "${groupName}" from room ${roomId}:`, e.message);
      // Mark backend unhealthy on fetch/timeout errors to suspend further reconcile cycles
      const msg = String(e?.message || '');
      if (/fetch|timeout|ECONNREFUSED|ECONNRESET|abort/i.test(msg)) {
        this._backendHealthy = false;
      }
      this.postWarning(
        `Failed to reconcile Matrix room ${roomId} ↔ group "${groupName}": ${e.message}`,
        { kind: 'reconcile', scope: `${roomId}:${groupName}` }
      );
    }
  }

  async tryMapRoom(roomId) {
    if (groupForRoom(roomId)) return groupForRoom(roomId); // already mapped
    if (!rateLimitGate.beforeRequest()) {
      console.warn(`Room mapping: cooling down (Matrix rate limit), skipping room ${roomId}`);
      return null;
    }
    // Check if this is a DM room or bot-DM (skip those)
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      if (nonBot.length <= 2) return null; // DM or bot-DM, not a group
    } catch (e) {
      rateLimitGate.observeError(e);
      console.warn(`Failed to inspect members while probing room ${roomId}: ${e.message}`);
      return null;
    }

    // Get room name via state event
    try {
      const nameEvent = await this.botClient.getRoomStateEvent(roomId, 'm.room.name', '');
      const name = nameEvent?.name;
      if (!name) return null;

      // Skip DM rooms (name format: "DM: X" or "SPY: X ↔ Y")
      if (isPrivateControlRoomName(name)) return null;

      // Check if group exists in backend, create if not
      let existing = null;
      try {
        existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
      } catch {
        // 404 or other error means group doesn't exist yet — we'll create it below
      }
      if (!existing || existing.error) {
        const joinedMembers = await this.botClient.getJoinedRoomMembers(roomId);
        const agentMembers = joinedMembers.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
        const humanMembers = joinedMembers
          .filter(m => !isAgentUser(m) && m !== this.botUserId)
          .map(m => humanNameFromUserId(m))
          .filter(Boolean);
        this._bridgeCreatedGroups.add(name);
        await backendApi('POST', '/api/groups', {
          name,
          members: [...agentMembers, ...humanMembers],
        });
        console.log(`Created group "${name}" from room bot joined`);
      }
      mapRoom(roomId, name);
      console.log(`Mapped room ${roomId} → group "${name}"`);
      await this.syncApprovalBindingForRoom(roomId);
      return name;
    } catch (e) {
      rateLimitGate.observeError(e);
      const msg = String(e?.message || '');
      const maybeUnnamedRoom = /M_NOT_FOUND|404|room\.name/i.test(msg);
      if (!maybeUnnamedRoom) {
        console.warn(`Failed to map room ${roomId}: ${msg}`);
        this.postWarning(`Failed to map Matrix room ${roomId}: ${msg}`);
      }
      return null;
    }
  }

  async backfillAgentManagedRooms() {
    if (this._agentRoomBackfillRunning) return;
    this._agentRoomBackfillRunning = true;
    try {
      const managedRooms = Object.entries(state.trustedManagedRooms || {})
        .filter(([roomId, meta]) => meta && !meta.approvalDm && roomAgentBindingEntries(roomId).length > 0);
      for (const [roomId, meta] of managedRooms) {
        // A 429 anywhere in this sweep trips the shared gate — abort rather than keep
        // walking the managed-room list (each remaining room would just 429 again).
        if (!rateLimitGate.beforeRequest()) {
          console.warn('Agent room backfill: cooling down (Matrix rate limit), aborting remaining rooms this round');
          break;
        }
        const backfillAgent = roomAgentBindingEntries(roomId)
          .map(([agentName]) => this.resolveKnownAgentName(agentName) || this.normalizeName(agentName))
          .map(agentName => ({ agentName, token: this.getAgentToken(agentName) }))
          .find(candidate => candidate.agentName && candidate.token);
        const agentName = backfillAgent?.agentName || null;
        const token = backfillAgent?.token || null;
        if (!agentName || !token) continue;
        try {
          const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${MATRIX_AGENT_ROOM_BACKFILL_LIMIT}`;
          // Single attempt: a 429 here is registered with the shared gate and the loop
          // guard above aborts the sweep, instead of retrying in place up to 6x per room.
          const res = await fetchWithRateLimit(url, {
            headers: { Authorization: `Bearer ${token}` },
          }, 1);
          if (!res.ok) {
            const errText = (await res.text().catch(() => '')).slice(0, 200);
            console.warn(`Agent room backfill failed for ${roomId} (${agentName}): HTTP ${res.status} ${errText}`);
            continue;
          }
          const data = await res.json().catch(() => ({}));
          const events = Array.isArray(data?.chunk) ? data.chunk.slice().reverse() : [];
          const cursor = state.agentRoomBackfillCursors[roomId] || {};
          const cursorTs = Number(cursor.lastTs || 0);
          const cursorEventIds = new Set(Array.isArray(cursor.eventIds) ? cursor.eventIds : []);
          const initialSinceTs = cursorTs || Number(meta.addedAt || 0) || this.startupTs;
          let nextCursorTs = cursorTs;
          let nextCursorEventIds = new Set(cursorTs ? cursorEventIds : []);
          let cursorChanged = false;
          for (const event of events) {
            if (event?.type !== 'm.room.message') continue;
            const eventTs = Number(event.origin_server_ts || 0);
            if (!eventTs) continue;
            if (cursorTs) {
              if (eventTs < cursorTs) continue;
              if (eventTs === cursorTs && event.event_id && cursorEventIds.has(event.event_id)) continue;
            } else if (initialSinceTs && eventTs < initialSinceTs) {
              continue;
            }
            await this.onRoomMessage(roomId, event);
            if (eventTs > nextCursorTs) {
              nextCursorTs = eventTs;
              nextCursorEventIds = new Set();
            }
            if (eventTs === nextCursorTs && event.event_id) {
              nextCursorEventIds.add(event.event_id);
            }
            cursorChanged = true;
          }
          if (cursorChanged) {
            state.agentRoomBackfillCursors[roomId] = {
              lastTs: nextCursorTs,
              eventIds: [...nextCursorEventIds].slice(-50),
            };
            saveState();
          }
        } catch (e) {
          rateLimitGate.observeError(e);
          console.warn(`Agent room backfill error for ${roomId} (${agentName}): ${e.message}`);
        }
      }
    } finally {
      this._agentRoomBackfillRunning = false;
    }
  }

  // ── Poll agent accounts for pending invites ─────────────────────
  async pollAgentInvites() {
    for (const agentName of this.knownAgents) {
      // A 429 anywhere this round (this agent or an earlier one) trips the shared gate —
      // abort immediately rather than keep working through the rest of the agent list.
      if (!rateLimitGate.beforeRequest()) {
        console.warn('Agent invite poll: cooling down (Matrix rate limit), aborting this round');
        return;
      }
      const token = this.getAgentToken(agentName);
      if (!token) continue;
      try {
        // Sync to get invited rooms
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?filter={"room":{"timeline":{"limit":0}}}&timeout=0`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (await rateLimitGate.observeResponse(res)) {
          console.warn(`Agent invite poll: 429 syncing for ${agentName}; aborting this round`);
          return;
        }
        const data = await res.json();
        const invited = data?.rooms?.invite || {};
        for (const roomId of Object.keys(invited)) {
          // Trust check before agent join (5.8.1)
          const inviteState = invited[roomId]?.invite_state?.events || [];
          const inviter = inviteState.find(e => e.type === 'm.room.member' && e.state_key === `@${AGENT_PREFIX}${agentName}:${MATRIX_SERVER_NAME}`)?.sender || null;
          const trust = getRoomTrust(roomId, { inviterMxid: inviter, requireTrustedInviter: true });
          roomTrustLog('agent-invite', roomId, trust, `agent=${agentName} inviter=${inviter}`);
          if (!trust.trusted && MATRIX_TRUST_MODE === 'enforce') continue;
          // Auto-join
          const joinRes = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (await rateLimitGate.observeResponse(joinRes)) {
            console.warn(`Agent invite poll: 429 joining ${roomId} for ${agentName}; aborting this round`);
            return;
          }
          if ((await joinRes.json()).room_id) {
            console.log(`Agent ${agentName} joined room ${roomId}`);
            if (trust.trusted) {
              markRoomTrusted(roomId, { agent: agentName, inviter });
              const existing = state.trustedManagedRooms[roomId] || {};
              upsertRoomAgentBinding(roomId, agentName, inviter, {
                addedAt: existing.addedAt,
              });
              state.trustedManagedRooms[roomId] = {
                ...existing,
                // Preserve legacy single-agent metadata for compatibility.
                // Authoritative ownership now lives per agent in
                // roomAgentBindings and must never be overwritten by a second
                // agent joining the same project room.
                agent: existing.agent || agentName,
                inviter: existing.inviter || inviter,
                ownerMxid: existing.ownerMxid || inviter,
                addedAt: existing.addedAt || Date.now(),
              };
              saveState();
            }
            // Invite bot so it can monitor messages
            const botInviteRes = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: this.botUserId }),
            });
            if (await rateLimitGate.observeResponse(botInviteRes)) {
              console.warn(`Agent invite poll: 429 inviting bot into ${roomId}; aborting this round`);
              return;
            }
            if (botInviteRes.ok) {
              console.log(`Invited bot into room ${roomId}`);
            } else {
              const errText = (await botInviteRes.text().catch(() => '')).slice(0, 200);
              console.warn(`Bot invite request failed for ${roomId}: HTTP ${botInviteRes.status} ${errText}`);
            }
            // The bot may already be joined because another local agent is in
            // this project room. Approval setup belongs to the newly joined
            // room-agent binding and must not depend on re-inviting the bot.
            if (trust.trusted) await this.syncApprovalBindingForRoom(roomId, agentName);
          }
        }
      } catch (e) {
        if (rateLimitGate.observeError(e)) {
          console.warn(`Agent invite poll rate-limited for ${agentName}; aborting this round`);
          return;
        }
        console.warn(`Invite poll failed for ${agentName}: ${e.message}`);
      }
    }
    // Trailing stages each self-guard too, but checking here avoids even calling into
    // them once this round has already tripped the shared cooldown.
    if (!rateLimitGate.beforeRequest()) return;
    await this.pollBotInvites();
    // Re-scan for any newly joined rooms that need mapping
    if (!rateLimitGate.beforeRequest()) return;
    await this.scanJoinedRooms();
    if (!rateLimitGate.beforeRequest()) return;
    await this.backfillAgentManagedRooms();
  }

  async handleBotInvite(roomId, inviteEvent, { source = 'bot-invite' } = {}) {
    const inviter = inviteEvent?.sender || null;
    // Agent puppets invite this instance's bot after a trusted developer has
    // invited the puppet. Accept only that exact agent/room pair; do not add
    // agent MXIDs to the global trusted-inviter list.
    const trust = this.managedAgentBotInviteTrust(roomId, inviter)
      || getRoomTrust(roomId, { inviterMxid: inviter, requireTrustedInviter: true });
    roomTrustLog(source, roomId, trust, `inviter=${inviter}`);
    if (!trust.trusted && MATRIX_TRUST_MODE === 'enforce') {
      console.log(`[trust:enforce] Rejecting bot invite to untrusted room ${roomId} inviter=${inviter || 'unknown'}`);
      try { await this.botClient.leaveRoom(roomId); } catch (e) { rateLimitGate.observeError(e); }
      return { accepted: false, reason: trust.reason, inviter };
    }
    if (!rateLimitGate.beforeRequest()) {
      console.warn(`Bot invite: cooling down (Matrix rate limit), deferring join for room ${roomId}`);
      return { accepted: false, reason: 'rate_limited', inviter };
    }
    try {
      await this.botClient.joinRoom(roomId);
      if (trust.trusted) markRoomTrusted(roomId, { inviter });
      // Anything said between the invite and this join never arrives by sync. Awaited
      // rather than fired off, so a caller that reports "accepted" has already
      // delivered what was waiting — pollBotInvites and the realtime handler both
      // rely on that to avoid racing each other into the same room.
      const backfilled = await this.backfillJoinedRoom(roomId, inviteEvent);
      return { accepted: true, reason: trust.reason, inviter, backfilled };
    } catch (error) {
      rateLimitGate.observeError(error);
      console.warn(`Failed to join room ${roomId}: ${error.message}`);
      return { accepted: false, reason: 'join_failed', inviter };
    }
  }

  /**
   * Deliver messages that arrived in a just-joined room before the join landed.
   *
   * See pendingJoinBackfill() for why this is needed and why the invite timestamp is
   * the floor. Failure here is logged and swallowed: the join itself succeeded, and
   * turning a missed backfill into a failed join would take the bot out of a room it
   * is now legitimately in.
   */
  async backfillJoinedRoom(roomId, inviteEvent = null) {
    if (!rateLimitGate.beforeRequest()) {
      console.warn(`Join backfill: cooling down (Matrix rate limit), skipping room ${roomId}`);
      return 0;
    }
    let chunk = [];
    try {
      const data = await this.botClient.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
        { dir: 'b', limit: MATRIX_JOIN_BACKFILL_LIMIT },
      );
      chunk = Array.isArray(data?.chunk) ? data.chunk : [];
    } catch (error) {
      rateLimitGate.observeError(error);
      console.warn(`Join backfill failed for ${roomId}: ${error.message}`);
      return 0;
    }
    const { floor: inviteTs, source: floorSource } = resolveJoinBackfillFloor(chunk, {
      botUserId: this.botUserId, inviteEvent, windowMs: MATRIX_JOIN_BACKFILL_WINDOW_MS,
    });
    const pending = pendingJoinBackfill(chunk, { inviteTs, botUserId: this.botUserId });
    let delivered = 0;
    let alreadySeen = 0;
    for (const event of pending) {
      // onRoomMessage dedups by event id, so an event the sync loop also delivers is
      // handled once whichever path gets there first.
      if (this.isDuplicateMatrixEvent(event.event_id)) { alreadySeen += 1; continue; }
      try {
        await this.onRoomMessage(roomId, event);
        delivered += 1;
      } catch (error) {
        console.warn(`Join backfill: failed to route ${event.event_id} in ${roomId}: ${error.message}`);
      }
    }
    /*
     * Logged on EVERY join, including the empty case.
     *
     * This first only logged when it delivered something, which made a no-op
     * indistinguishable from not having run — and that ambiguity immediately misled
     * me: a pre-join `!request` was answered, no backfill line appeared, and the
     * obvious reading ("the fix worked") was wrong. Sync had won the race and the
     * backfill had correctly deduped to zero. Whether this path ran, and what it
     * decided, has to be visible or the live behaviour cannot be attributed.
     */
    console.log(
      `Join backfill ${roomId}: fetched=${chunk.length} eligible=${pending.length} `
      + `delivered=${delivered} already-synced=${alreadySeen} floor=${floorSource}`,
    );
    return delivered;
  }

  installBotInviteHandler() {
    this.botClient.on('room.invite', (roomId, inviteEvent) => (
      this.handleBotInvite(roomId, inviteEvent, { source: 'bot-invite' })
    ));
  }

  // Backstop for the BOT's own pending invites: the realtime room.invite handler can miss
  // events across sync gaps, and a pending invite never surfaces in joined-room scans —
  // without this poll a missed bot invite stays stuck forever. Same trust rules as realtime.
  async pollBotInvites() {
    const token = this.getBotToken();
    if (!token) return;
    if (!rateLimitGate.beforeRequest()) {
      console.warn('Bot invite poll: cooling down (Matrix rate limit), skipping this round');
      return;
    }
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?filter={"room":{"timeline":{"limit":0}}}&timeout=0`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (await rateLimitGate.observeResponse(res)) {
        console.warn('Bot invite poll: 429; aborting this round');
        return;
      }
      const data = await res.json();
      const invited = data?.rooms?.invite || {};
      for (const roomId of Object.keys(invited)) {
        // A 429 handled inside handleBotInvite (below) trips the shared gate; stop
        // walking the invited-room list rather than keep attempting joins.
        if (!rateLimitGate.beforeRequest()) {
          console.warn('Bot invite poll: cooling down mid-round, aborting remaining rooms');
          break;
        }
        const inviteState = invited[roomId]?.invite_state?.events || [];
        const inviter = inviteState.find(e => e.type === 'm.room.member' && e.state_key === this.botUserId)?.sender || null;
        const result = await this.handleBotInvite(roomId, { sender: inviter }, { source: 'bot-invite-poll' });
        if (result.accepted) {
          console.log(`Bot joined room ${roomId} via invite poll`);
        }
      }
    } catch (e) {
      if (rateLimitGate.observeError(e)) {
        console.warn('Bot invite poll rate-limited; aborting this round');
        return;
      }
      console.warn(`Bot invite poll failed: ${e.message}`);
    }
  }

  // ── Agent-chat → Matrix ───────────────────────────────────────────
  connectSSE() {
    const url = `${BACKEND_URL}/api/stream`;
    console.log(`Connecting SSE: ${url}`);
    let currentEs = null;
    let reconnectTimer = null;

    const connect = () => {
      if (currentEs) { try { currentEs.close(); } catch (_) {} currentEs = null; }
      const es = new EventSource(url);
      currentEs = es;
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
          const { agent, human, humanId } = JSON.parse(data);
          console.log(`SSE: dm_ensure request — agent=${agent}, human=${human}${humanId ? ` humanId=${humanId}` : ''}`);
          this.onDmEnsure(agent, human, humanId || null);
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
      es.on('approval_requested', (data) => {
        try {
          const event = JSON.parse(data);
          this.onApprovalRequested(event);
        } catch (e) {
          console.warn(`Failed to parse SSE approval_requested event: ${e.message}`);
        }
      });
      es.on('error', () => {
        if (currentEs === es) { try { es.close(); } catch (_) {} currentEs = null; }
        if (reconnectTimer) return;
        console.error('SSE disconnected, reconnecting in 5s...');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 5000);
      });
    };
    connect();
  }

  async onDmEnsure(agentName, humanName, humanId) {
    // Use humanId (full MXID) when available for federated identity
    const effectiveHuman = humanId || humanName;
    // Dedup lock: prevent concurrent DM creation for the same agent+human pair
    const lockKey = `dm:${agentName}:${humanDmKey(effectiveHuman)}`;
    if (!this._dmEnsureLocks) this._dmEnsureLocks = new Map();
    if (this._dmEnsureLocks.has(lockKey)) {
      console.log(`SSE: dm_ensure skipped (already in progress): ${lockKey}`);
      return this._dmEnsureLocks.get(lockKey);
    }
    const promise = this._doOnDmEnsure(agentName, effectiveHuman);
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

  async ensureApprovalDmEncrypted(roomId) {
    if (!this.botClient?.crypto) {
      throw new Error('Matrix E2EE is unavailable for owner approval rooms');
    }
    let encryption = null;
    try {
      encryption = await this.botClient.getRoomStateEvent(roomId, 'm.room.encryption', '');
    } catch (error) {
      const message = String(error?.message || error);
      if (!/M_NOT_FOUND|404|not found/i.test(message)) throw error;
    }
    if (!encryption) {
      encryption = { algorithm: MATRIX_MEGOLM_ALGORITHM };
      await this.botClient.sendStateEvent(roomId, 'm.room.encryption', '', encryption);
    }
    if (encryption.algorithm !== MATRIX_MEGOLM_ALGORITHM) {
      throw new Error(`unsupported Matrix encryption algorithm in ${roomId}`);
    }
    await this.botClient.crypto.onRoomEvent(roomId, {
      type: 'm.room.encryption',
      state_key: '',
      content: encryption,
    });
    return true;
  }

  async ensureApprovalDmSecurity(roomId) {
    if (this.approvalDmMode !== 'plaintext-test') {
      return this.ensureApprovalDmEncrypted(roomId);
    }
    try {
      await this.botClient.getRoomStateEvent(roomId, 'm.room.encryption', '');
    } catch (error) {
      const message = String(error?.message || error);
      if (/M_NOT_FOUND|404|not found/i.test(message)) return true;
      throw error;
    }
    throw new Error(`plaintext approval test room ${roomId} is already encrypted`);
  }

  async ensureApprovalDmRoom(agentName, ownerMxid) {
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    if (!canonicalAgent || !/^@[^:\s]+:[^\s]+$/.test(ownerMxid) || isAgentUser(ownerMxid)) {
      return { ok: false, ready: false, reason: 'invalid_owner_binding' };
    }
    const baseKey = approvalDmKey(canonicalAgent, ownerMxid);
    const key = this.approvalDmMode === 'plaintext-test'
      ? `${baseKey}\u0000plaintext-test`
      : baseKey;
    let roomId = state.approvalDmRooms[key] || null;
    if (!roomId) {
      const plaintextTest = this.approvalDmMode === 'plaintext-test';
      roomId = await this.botClient.createRoom({
        is_direct: true,
        preset: 'private_chat',
        name: plaintextTest
          ? `Approval Test (UNENCRYPTED): ${canonicalAgent}`
          : `Approval: ${canonicalAgent}`,
        topic: plaintextTest
          ? 'UNENCRYPTED TEST ONLY. Private UI approval diagnostics; text replies do not authorize execution.'
          : 'Private, UI-only coding-agent approval requests. Text replies do not authorize execution.',
        invite: [ownerMxid, agentUserId(canonicalAgent)],
        power_level_content_override: approvalRoomPowerLevels(this.botUserId),
        initial_state: plaintextTest ? [] : [{
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: MATRIX_MEGOLM_ALGORITHM },
        }],
      });
      state.approvalDmRooms[key] = roomId;
      state.trustedManagedRooms[roomId] = {
        approvalDm: true,
        agent: canonicalAgent,
        ownerMxid,
        approvalDmMode: this.approvalDmMode,
        addedAt: Date.now(),
      };
      saveState();
    }

    await this.ensureApprovalDmSecurity(roomId);
    await this.ensureApprovalDmRestricted(roomId);

    // Keep the local agent visibly attached to its approval room. The bridge bot
    // remains the E2EE sender and authorization service; the agent token is never
    // used to submit a verdict.
    const agentMxid = agentUserId(canonicalAgent);
    let members = await this.botClient.getJoinedRoomMembers(roomId);
    if (!members.includes(agentMxid)) {
      try { await this.botClient.inviteUser(agentMxid, roomId); } catch {}
      const agentToken = this.getAgentToken(canonicalAgent);
      if (agentToken) {
        const join = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!join.ok) {
          const detail = await join.text().catch(() => '');
          throw new Error(`agent failed to join approval room: HTTP ${join.status} ${detail.slice(0, 160)}`);
        }
      }
    }

    const invite = await this._inviteHumanToDm(roomId, ownerMxid, { agentName: canonicalAgent });
    if (!invite.ok) return { ok: false, ready: false, roomId, reason: 'owner_invite_failed' };
    members = await this.botClient.getJoinedRoomMembers(roomId);
    const ownerJoined = members.includes(ownerMxid);
    return {
      ok: true,
      ready: ownerJoined,
      roomId,
      reason: ownerJoined ? 'ready' : 'owner_invite_pending',
    };
  }

  async ensureApprovalDmRestricted(roomId) {
    if (!this.botClient || typeof this.botClient.getRoomStateEvent !== 'function'
        || typeof this.botClient.sendStateEvent !== 'function') {
      throw new Error(`approval room ${roomId} cannot be secured: Matrix state-event support is unavailable`);
    }
    const expected = approvalRoomPowerLevels(this.botUserId);
    let current = null;
    try {
      current = await this.botClient.getRoomStateEvent(roomId, 'm.room.power_levels', '');
    } catch {
      // The bridge is the room creator and can install the fail-closed policy.
    }
    const normalizedCurrent = current && typeof current === 'object' ? {
      ban: current.ban,
      events_default: current.events_default,
      invite: current.invite,
      kick: current.kick,
      notifications: current.notifications,
      redact: current.redact,
      state_default: current.state_default,
      users: current.users,
      users_default: current.users_default,
    } : null;
    if (JSON.stringify(normalizedCurrent) === JSON.stringify(expected)) return false;
    await this.botClient.sendStateEvent(roomId, 'm.room.power_levels', '', expected);
    return true;
  }

  async syncApprovalBindingForRoomAgent(projectRoomId, agentName) {
    const meta = state.trustedManagedRooms?.[projectRoomId];
    const stored = findRoomAgentBinding(projectRoomId, agentName);
    if (!meta || meta.approvalDm || !stored) return { ok: false, reason: 'not_agent_project_room' };
    const canonicalAgent = this.resolveKnownAgentName(stored.agentName) || this.normalizeName(stored.agentName);
    const ownerMxid = typeof stored.binding.ownerMxid === 'string'
      ? stored.binding.ownerMxid
      : stored.binding.inviter;
    if (!canonicalAgent || !/^@[^:\s]+:[^\s]+$/.test(ownerMxid || '') || isAgentUser(ownerMxid)) {
      return { ok: false, reason: 'missing_trusted_owner' };
    }
    const dm = await this.ensureApprovalDmRoom(canonicalAgent, ownerMxid);
    if (!dm.ready) return { ok: false, reason: dm.reason, roomId: dm.roomId || null };
    const project = groupForRoom(projectRoomId) || meta.group || projectRoomId;
    const result = await this.callBackendApi('PUT', '/api/approval-bindings', {
      agent: canonicalAgent,
      project,
      project_room_id: projectRoomId,
      owner_mxid: ownerMxid,
      owner_dm_room_id: dm.roomId,
    }, `context=approval:binding agent=${canonicalAgent} room=${projectRoomId}`);
    stored.binding.ownerMxid = ownerMxid;
    stored.binding.approvalDmRoomId = dm.roomId;
    if (this.sameName(meta.agent, canonicalAgent)) {
      meta.ownerMxid = ownerMxid;
      meta.approvalDmRoomId = dm.roomId;
    }
    saveState();
    return result;
  }

  async syncApprovalBindingForRoom(projectRoomId, agentName = null) {
    if (agentName) return this.syncApprovalBindingForRoomAgent(projectRoomId, agentName);
    const bindings = roomAgentBindingEntries(projectRoomId);
    if (bindings.length === 0) return { ok: false, reason: 'not_agent_project_room' };
    const results = [];
    for (const [boundAgent] of bindings) {
      results.push(await this.syncApprovalBindingForRoomAgent(projectRoomId, boundAgent));
    }
    if (results.length === 1) return results[0];
    return {
      ok: results.every(result => result?.ok === true),
      results,
    };
  }

  async syncApprovalBindings(filters = {}) {
    const results = [];
    for (const [roomId, meta] of Object.entries(state.trustedManagedRooms || {})) {
      if (meta?.approvalDm) continue;
      for (const [agentName, binding] of roomAgentBindingEntries(roomId)) {
        if (filters.agent && !this.sameName(agentName, filters.agent)) continue;
        const ownerMxid = binding.ownerMxid || binding.inviter || null;
        if (filters.ownerMxid && ownerMxid !== filters.ownerMxid) continue;
        try {
          results.push(await this.syncApprovalBindingForRoomAgent(roomId, agentName));
        } catch (error) {
          console.warn(`Approval binding sync failed for ${roomId} (${agentName}): ${error.message}`);
          results.push({ ok: false, reason: error.message, roomId, agent: agentName });
        }
      }
    }
    return results;
  }

  async removeApprovalBindings(filters = {}) {
    const results = [];
    for (const [roomId, meta] of Object.entries(state.trustedManagedRooms || {})) {
      if (meta?.approvalDm) continue;
      for (const [agentName, binding] of roomAgentBindingEntries(roomId)) {
        if (filters.agent && !this.sameName(agentName, filters.agent)) continue;
        const ownerMxid = binding.ownerMxid || binding.inviter || null;
        if (filters.ownerMxid && ownerMxid !== filters.ownerMxid) continue;
        try {
          results.push(await this.callBackendApi(
            'DELETE',
            `/api/approval-bindings/${encodeURIComponent(agentName)}/${encodeURIComponent(roomId)}`,
            null,
            `context=approval:binding-remove agent=${agentName} room=${roomId}`,
          ));
        } catch (error) {
          if (!/failed with HTTP 404\b/.test(String(error?.message || error))) throw error;
        }
      }
    }
    return results;
  }

  async onApprovalRequested(event) {
    const requestId = typeof event?.request_id === 'string' ? event.request_id.trim() : '';
    if (!requestId) return { ok: false, reason: 'missing_request_id' };
    let approval = null;
    try {
      const response = await this.callBackendApi(
        'GET',
        `/api/approvals/${encodeURIComponent(requestId)}/matrix`,
        null,
        `context=approval:publish request=${requestId}`,
      );
      approval = response?.approval || null;
      if (!approval || approval.status !== 'pending') return { ok: false, reason: 'request_not_pending' };

      await this.ensureApprovalDmSecurity(approval.owner_dm_room_id);
      const privateEventId = await this.botClient.sendMessage(
        approval.owner_dm_room_id,
        buildOwnerApprovalRequest(approval),
      );
      if (privateEventId) this.rememberMatrixEvent(privateEventId, requestId);

      const token = this.getAgentToken(approval.agent);
      if (!token) throw new Error(`missing Matrix token for approval agent ${approval.agent}`);
      const publicEventId = await this.sendAsAgentContent(
        token,
        approval.project_room_id,
        buildPublicApprovalNotice(approval),
        requestId,
      );
      if (!publicEventId) throw new Error('public approval status delivery failed');
      return { ok: true, requestId, privateEventId, publicEventId };
    } catch (error) {
      console.error(`Approval publish failed for ${requestId}: ${error.message}`);
      try {
        await this.callBackendApi(
          'POST',
          `/api/approvals/${encodeURIComponent(requestId)}/delivery-failed`,
          { reason: 'matrix_approval_delivery_failed' },
          `context=approval:delivery-failed request=${requestId}`,
        );
      } catch (denyError) {
        console.error(`Approval fail-closed update failed for ${requestId}: ${denyError.message}`);
      }
      return { ok: false, reason: error.message, approval };
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
      const humanId = (typeof target?.humanId === 'string' && target.humanId.trim()) ? target.humanId.trim() : '';
      let roomId = (typeof target?.roomId === 'string' && target.roomId.trim()) ? target.roomId.trim() : '';
      if (!roomId && typeof target?.group === 'string' && target.group.trim()) {
        roomId = roomForGroup(target.group.trim()) || '';
      }
      if (!roomId && (humanId || human)) {
        try {
          const ensured = await this.ensureHumanDmRoom(agentName, humanId || human);
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
    const linkLine = msgId ? `\n🔗 ${buildMessageUrl(msgId, event.viewToken)}` : '';
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
    const alertType = (typeof event?.alertType === 'string' && event.alertType.trim()) ? event.alertType.trim() : '';
    let warningCooldownKey = null;
    let warningCooldownAt = 0;
    if (alertType) {
      const severity = SYSTEM_INFO_ALERT_SEVERITY_MAP[alertType] || 'info';
      if (severity === 'info') return;
      if (severity === 'warning') {
        const now = Date.now();
        const dedupeKey = (typeof event?.dedupeKey === 'string' && event.dedupeKey.trim())
          ? event.dedupeKey.trim()
          : `${alertType}:${summary}`;
        const lastSent = this._recentSystemInfoWarningKeys.get(dedupeKey) || 0;
        if ((now - lastSent) < SYSTEM_INFO_WARNING_COOLDOWN_MS) return;
        warningCooldownKey = dedupeKey;
        warningCooldownAt = now;
      }
    }
    const roomId = roomForGroup('info');
    if (!roomId) {
      console.warn(`No Matrix room for group "info"; system_info skipped: ${summary.slice(0, 80)}`);
      return;
    }
    const body = full ? `ℹ️ ${summary}\n\n${full}` : `ℹ️ ${summary}`;
    try {
      await this.botClient.sendMessage(roomId, { msgtype: 'm.text', body });
      if (warningCooldownKey) {
        this._recentSystemInfoWarningKeys.set(warningCooldownKey, warningCooldownAt);
        if (this._recentSystemInfoWarningKeys.size > 1000) {
          const cutoff = warningCooldownAt - SYSTEM_INFO_WARNING_COOLDOWN_MS;
          for (const [key, ts] of this._recentSystemInfoWarningKeys) {
            if (ts < cutoff) this._recentSystemInfoWarningKeys.delete(key);
          }
        }
      }
      console.log(`→ Matrix [info] system: ${summary.slice(0, 60)}`);
    } catch (e) {
      console.error(`Failed to bridge system_info to info room ${roomId}:`, e.message);
    }
  }

  async onGroupCreated(group) {
    // Skip SSE echo — bridge itself created this group
    if (this._bridgeCreatedGroups.delete(group.name)) return;

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
          body: JSON.stringify({ user_id: userId, reason: 'Removed from hafleet group' }),
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
      const msgUrl = buildMessageUrl(msg.id, msg.viewToken);
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
      const thread = await this.resolveOutboundGroupRelation(msg, roomId);
      if (!thread.ok) return;
      const primaryEventId = await this.sendAsAgent(
        senderToken,
        roomId,
        plain,
        html,
        msg.id,
        {
          persistPrimary: true,
          relation: thread.relation,
          threadRootEventId: thread.threadRootEventId,
        },
      );
      if (!primaryEventId) return;
      await this.sendAttachmentsForMessage(senderToken, roomId, msg, thread.relation);
      console.log(`→ Matrix [${msg.group}] ${agentName}: ${msg.summary.slice(0, 60)}`);
    } else if (msg.to) {
      // DM - bridge to Matrix (both agent-to-agent and agent-to-human)
      if (senderIsSystem) {
        console.log(`Skipping Matrix DM bridge for system message ${msg.id}`);
        return;
      }
      // For agent→human replies, resolve the target room with a 3-level
      // preference so a backlogged reply lands in the conversation it belongs to
      // rather than wherever the human last typed:
      //   1. reply_to thread — the room the replied-to message came from
      //   2. lastHumanRoom    — the room this human last wrote the agent from
      //   3. ensureDmRoom      — the global DM room (final fallback, below)
      // A send failure on one level falls through to the next.
      if (this.isHuman(msg.to)) {
        const replyToRoom = msg.reply_to ? await this.lookupVerifiedDirectReplyRoom(msg.reply_to, {
          agentName: canonicalAgentName,
          humanName: msg.to,
        }) : null;
        const lastRoom = preferredDmRoom(state, agentName, msg.to, humanDmKey);
        const { candidates } = resolveOutboundDmRoom({ replyToRoom, lastRoom });
        for (const { room, source } of candidates) {
          try {
            await this.sendAsAgent(senderToken, room, plain, html, msg.id);
            await this.sendAttachmentsForMessage(senderToken, room, msg);
            console.log(`→ Matrix DM ${agentName} → ${msg.to} (${source}): ${msg.summary.slice(0, 60)}`);
            return;
          } catch (e) {
            console.warn(`Preferred DM room ${room} (${source}) send failed, falling through: ${e.message}`);
          }
        }
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
    // Warning emitted by outer caller (_doOnDmEnsure / ensureHumanDmRoom) — no duplicate here
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
      key = `dm:${resolvedFromName}:${humanDmKey(resolvedToName)}`; // human→agent: keyed by agent+human
    } else if (!fromIsAgent && toIsAgent) {
      key = `dm:${resolvedToName}:${humanDmKey(resolvedFromName)}`; // agent→human: keyed by agent+human
    } else {
      key = [resolvedFromName, resolvedToName].sort().join(':'); // agent↔agent: pair key
    }

    // Check in-memory cache
    if (this.dmRooms.has(key)) {
      const existingRoom = this.dmRooms.get(key);
      // If human↔agent, invite the human into existing room (idempotent)
      if (key.startsWith('dm:')) {
        const humanName = fromIsAgent ? resolvedToName : resolvedFromName;
        const agentName = key.split(':')[1];
        const ensured = await this._ensureHumanInviteOrFail(existingRoom, humanName, agentName);
        if (!ensured.ok) return null;
      }
      return existingRoom;
    }

    // Load from persisted state (check multiple key formats for backwards compat)
    const legacyKey = [resolvedFromName, resolvedToName].sort().join(':');
    const altKey = `${resolvedFromName}:${resolvedToName}`;
    const oldDmKey = key.startsWith('dm:') ? `dm:${key.split(':')[1]}` : null; // pre-5.8.4: dm:agentName
    for (const k of [key, oldDmKey, legacyKey, altKey].filter(Boolean)) {
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
          const agentName = key.split(':')[1];
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
        markRoomTrusted(data.room_id, { dm: key });
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
      if (e.message && (e.message.includes('M_FORBIDDEN') || e.message.includes('403'))) {
        console.debug(`[stale-member] Skipping stale member check in ${roomId} — bot not in room`);
      } else {
        console.warn(`Failed to check stale members in ${roomId}: ${e.message}`);
      }
    }
  }

  async sendAsAgentContent(token, roomId, content, sourceMsgId = null, delivery = null) {
    const persistPrimary = delivery?.persistPrimary === true && Boolean(sourceMsgId);
    if (persistPrimary) {
      const existing = this.matrixDeliveryJournal.get(sourceMsgId);
      if (existing) {
        if (existing.roomId !== roomId
          || existing.threadRootEventId !== (delivery?.threadRootEventId || null)) {
          throw new Error(`primary Matrix delivery context changed for ${sourceMsgId}`);
        }
        if (existing.state === 'pending') {
          try {
            await this.persistPendingMatrixDelivery(existing);
          } catch (error) {
            console.warn(`[matrix-delivery] existing delivery remains pending message=${sourceMsgId}: ${error.message}`);
          }
        }
        this.rememberMatrixEvent(existing.primaryEventId, sourceMsgId);
        return existing.primaryEventId;
      }
    }
    const txnSeed = persistPrimary
      ? `primary:${sourceMsgId}`
      : `${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    const txnId = `bridge_${createHash('sha256').update(txnSeed).digest('hex').slice(0, 32)}`;
    const doSend = async () => {
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
    let eventId;
    try {
      eventId = await doSend();
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
          eventId = await doSend();
        } catch (retryErr) {
          console.error(`Auto-join retry failed in ${roomId}:`, retryErr.message);
          this.postWarning(`sendAsAgent failed in room ${roomId} (after auto-join retry): ${retryErr.message}`);
          return null;
        }
      } else {
        console.error(`Failed to send as agent in ${roomId}:`, e.message);
        this.postWarning(`sendAsAgent failed in room ${roomId}: ${e.message}`);
        return null;
      }
    }
    if (persistPrimary && eventId) {
      let record;
      try {
        record = this.matrixDeliveryJournal.recordPending({
          messageId: sourceMsgId,
          roomId,
          primaryEventId: eventId,
          threadRootEventId: delivery?.threadRootEventId || null,
        });
      } catch (error) {
        console.error(`[matrix-delivery] failed to journal message=${sourceMsgId} event=${eventId}: ${error.message}`);
        this.postWarning(
          `Matrix delivery recovery journal failed for ${sourceMsgId}; later thread replies may lose context`,
          { kind: 'thread-durability', scope: roomId },
        );
        return eventId;
      }
      try {
        await this.persistPendingMatrixDelivery(record);
      } catch (error) {
        console.warn(`[matrix-delivery] backend write deferred message=${sourceMsgId}: ${error.message}`);
        this.postWarning(
          `Matrix delivery context for ${sourceMsgId} is pending recovery`,
          { kind: 'thread-durability', scope: roomId },
        );
      }
    }
    return eventId;
  }

  async sendAsAgent(token, roomId, text, html, sourceMsgId = null, delivery = null) {
    const content = { msgtype: 'm.text', body: text };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    if (delivery?.relation) content['m.relates_to'] = delivery.relation;
    return this.sendAsAgentContent(token, roomId, content, sourceMsgId, delivery);
  }

  async sendAttachmentAsAgent(token, roomId, attachment, sourceMsgId = null, relation = null) {
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
    if (relation) content['m.relates_to'] = relation;
    return this.sendAsAgentContent(token, roomId, content, sourceMsgId);
  }

  async sendAttachmentsForMessage(token, roomId, msg, relation = null) {
    const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
    if (attachments.length === 0) return;
    for (const attachment of attachments) {
      try {
        await this.sendAttachmentAsAgent(token, roomId, attachment, msg.id, relation);
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

  // ── Create Matrix room for hafleet group ───────────────────────
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

export async function generateAvatarPngForTest(name, options = {}) {
  return generateAvatarPng(name, options);
}

export function setBridgeMatrixTestHooks({ execFileAsync: overrideExecFileAsync } = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : execFileAsync;
}

export function resetBridgeMatrixTestHooks() {
  execFileAsyncImpl = execFileAsync;
  rateLimitGate.reset();
}

// Test-only handle onto the shared Matrix rate-limit gate singleton, so tests can both
// assert on it directly and simulate a cooldown tripped by some other request source.
export { rateLimitGate as matrixRateLimitGateForTest };

export function resolveMessageBaseUrlForTest(env = {}) {
  return resolveMessageBaseUrl(env);
}

export function resolveInvitePollMsForTest(env = {}) {
  return resolveInvitePollMs(env);
}

export function resolveRoomScanPollMsForTest(env = {}) {
  return resolveRoomScanPollMs(env);
}

export function resolveBridgeHealthWriteIntervalMsForTest(env = {}) {
  return resolveBridgeHealthWriteIntervalMs(env);
}

export function buildMessageUrlForTest(messageId, viewToken = null, baseUrl = MSG_BASE_URL) {
  return buildMessageUrl(messageId, viewToken, baseUrl);
}

// Test exports for 5.8.1 room trust
export { getRoomTrust, markRoomTrusted, MATRIX_TRUST_MODE };

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
