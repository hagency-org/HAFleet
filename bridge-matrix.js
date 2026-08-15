import {
  EncryptedRoomEvent,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';
import { createHash } from 'crypto';
import { createAppserviceRouter } from './lib/appservice-receiver.js';
import { createRoomOnSide, sendToRoomOnSide } from './lib/matrix-representative.js';
import { resolveAppserviceListenerConfig, startAppserviceListener } from './lib/appservice-listener.js';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
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
import {
  normalizeEd25519PublicJwk,
  verifyMatrixDeviceSelfSignature,
} from './lib/agent-ops-client-auth.js';

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

  /**
   * Ask the homeserver for the current one-time-key count, at most once per interval.
   *
   * THE THROTTLE COUNTS ATTEMPTS, NOT SUCCESSES, and that is the fix. The stamp used to be
   * written after both awaits, so a probe that THREW never recorded anything — and
   * `processSync` swallows the error, so the next sync round found the throttle unset and
   * probed again. Measured against the real class: with a failing probe, five rounds one
   * millisecond apart produced five POSTs and left the stamp at 0.
   *
   * The consequence was the opposite of the intent. `syncingTimeout` defaults to 30s, so a
   * homeserver returning 429 or 5xx got one empty `/keys/upload` per sync round — roughly ten
   * times the interval this method exists to enforce, for as long as the failure lasted, and
   * hardest on a server that was already struggling. It also refuted ADR-006's own Consequence
   * that "affected homeservers require one additional bounded count probe".
   *
   * Stamping first is safe because the probe body is `{}` — no keys are uploaded, and the call
   * that makes the crypto layer generate keys (`updateSyncData`) is not reached on the failure
   * path. So the cost of a skipped interval after a failure is one stale count for five
   * minutes, against a retry storm; and the count is only ever a hint the crypto state machine
   * uses to decide whether to top up.
   */
  async reconcileSignedCurve25519CountIfDue(now = Date.now()) {
    if (!this.crypto || now - this._lastOtkCountReconciliationAt < MATRIX_OTK_COUNT_RECONCILE_MS) {
      return null;
    }
    // Before the awaits: an attempt has been made, whether or not it lands.
    this._lastOtkCountReconciliationAt = now;
    const count = await this.probeSignedCurve25519Count();
    await this.crypto.updateSyncData([], { signed_curve25519: count }, [], [], []);
    console.log(`[matrix-e2ee] reconciled signed_curve25519 count=${count}`);
    return count;
  }

  async processSync(raw, emitFn) {
    const result = await super.processSync(raw, emitFn);
    const changedDeviceOwners = [...new Set([
      ...(Array.isArray(raw?.device_lists?.changed) ? raw.device_lists.changed : []),
      ...(Array.isArray(raw?.device_lists?.left) ? raw.device_lists.left : []),
    ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
    if (changedDeviceOwners.length > 0) {
      const notify = emitFn || ((eventName, ...payload) => Promise.resolve(this.emit(eventName, ...payload)));
      await notify('device_lists.changed', changedDeviceOwners);
    }
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
const AGENT_OPS_EVENT_KEY = 'com.hafleet.agent_ops';
const AGENT_OPS_SESSION_REQUEST_MSGTYPE = 'com.hafleet.agent_ops.client_session.request.v1';
const AGENT_OPS_SESSION_GRANT_MSGTYPE = 'com.hafleet.agent_ops.client_session.grant.v1';
const AGENT_OPS_SESSION_REVOKE_MSGTYPE = 'com.hafleet.agent_ops.client_session.revoke.v1';
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
const THREAD_SESSIONS_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.HAFLEET_THREAD_SESSIONS || '').trim().toLowerCase(),
);
const ROUTER_OUTBOX_POLL_MS_RAW = Number.parseInt(process.env.HAFLEET_ROUTER_OUTBOX_POLL_MS || '1000', 10);
const ROUTER_OUTBOX_POLL_MS = Number.isFinite(ROUTER_OUTBOX_POLL_MS_RAW)
  ? Math.max(250, ROUTER_OUTBOX_POLL_MS_RAW)
  : 1000;
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

  /*
   * THE BACKEND, not the retired portal on 8084.
   *
   * These links go into Matrix messages and outlive the process that answered them, so the default has
   * to point at something that will still be there. `backend-v2.js` serves `/msg/:id` itself — it has
   * all along — while the copy on the old web portal existed only for that portal's own pages, which
   * are now deleted. `HAFLEET_WEB_URL` and `MSG_BASE_URL` above still override, so a deployment that
   * put the viewer somewhere else keeps working.
   *
   * LINKS ALREADY SENT still say 8084. Nothing can rewrite a message that has been delivered, so those
   * break when that process stops — which is the cost of retiring it, stated rather than discovered.
   */
  const backendPortRaw = Number.parseInt(env.HAFLEET_BACKEND_PORT || '8090', 10);
  const backendPort = Number.isFinite(backendPortRaw) && backendPortRaw > 0 ? backendPortRaw : 8090;
  return `http://127.0.0.1:${backendPort}/msg`;
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
/*
 * Liveness signals for a borrower waiting on an agent. See beginAgentWork().
 *
 * The timeout is what the homeserver is told; the refresh is how often it is re-asserted while
 * work is outstanding; the cap is when this stops lying. Refresh must be comfortably under the
 * timeout or the notification flickers off between refreshes.
 */
const AGENT_TYPING_TIMEOUT_MS = 45_000;
const AGENT_TYPING_REFRESH_MS = 30_000;
/*
 * Past this, the notification lapses. TWO MINUTES, not the twenty it shipped with.
 *
 * An operator reported BigLittle showing "typing" continuously in their client, and they were right
 * to call it a bug. The stop hook only fires when the agent REPLIES, so an agent that is working
 * for a long time — or stuck — kept the indicator refreshed for the whole cap. I justified twenty
 * minutes as "an agent silent that long may be stuck"; the correct conclusion from that same
 * observation is the opposite one, that a typing indicator is only honest for a short window. Past
 * a couple of minutes it conveys nothing and misleads, and the 👀 reaction is already the durable
 * record that the message was received.
 */
const AGENT_TYPING_MAX_MS = 2 * 60_000;
/* 👀 — "seen, and being worked on". One event, no work product. */
const AGENT_ACK_REACTION = '\u{1F440}';

const AGENT_PREFIX = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim(); // Matrix usernames: ac_agentname
const MATRIX_SERVER_NAME = (process.env.MATRIX_SERVER_NAME || new URL(HOMESERVER).host).trim();
/*
 * MATRIX_AGENT_PASSWORD_SECRET, MATRIX_AGENT_PASSWORD_TEMPLATE and
 * MATRIX_ALLOW_LEGACY_AGENT_PASSWORD are GONE (ADR-014 decision 3, 2026-08-11).
 *
 * An agent's Matrix password used to be derived: sha256(secret + ':' + agentName), one operator
 * secret behind every agent identity. Three properties condemned it, and they compound:
 *
 *   THE SECRET COULD NEVER BE ROTATED. Change it and every derived password changes at once, so
 *   the bridge can no longer log in to any existing account — and it cannot re-register them
 *   either, because the usernames are taken. The whole fleet locks out. (The now-deleted
 *   MATRIX_ALLOW_LEGACY_AGENT_PASSWORD existed to migrate off an even earlier template scheme,
 *   so this class of trap had already been hit once; rotating the secret itself never had a path.)
 *
 *   THE CREDENTIALS WERE NOT REVOCABLE. Revoking every access token achieved nothing: the
 *   password is re-derivable, so anyone holding .env logs straight back in. A leak was permanent,
 *   recoverable only by renaming the agents.
 *
 *   IT REQUIRED ACCOUNT-CREATION PRIVILEGE on the homeserver (MATRIX_REG_TOKEN or open
 *   registration) — a far larger grant than acting as a few existing accounts, and one no
 *   third-party project gives an external bridge. So the model structurally could not put an
 *   agent on a homeserver we do not administer, which is exactly what ADR-013's contribution
 *   persona meets.
 *
 * Replaced by the credential the operator supplies: see ensureAgentAccount below.
 */
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
// Bounds on walking back for the invite that delimits the window. Both are needed:
// pages caps the requests made, events caps what a server returning huge pages can
// cost. Exhausting either fails closed, which is the same answer as not finding it.
const MATRIX_JOIN_BACKFILL_PAGES = Math.max(1, Number.parseInt(process.env.MATRIX_JOIN_BACKFILL_PAGES || '5', 10) || 5);
const MATRIX_JOIN_BACKFILL_MAX_EVENTS = Math.max(
  MATRIX_JOIN_BACKFILL_LIMIT,
  Number.parseInt(process.env.MATRIX_JOIN_BACKFILL_MAX_EVENTS || '500', 10) || 500,
);

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
/*
 * Set when `bridge-state.json` existed but could not be read or parsed. While it is set, the
 * in-memory state is NOT a picture of the file, and writing it out would replace real credentials
 * with an empty object.
 *
 * This distinction did not matter before ADR-014 decision 3: an erased agent token was re-derived
 * from the master secret on the next startup, so an empty-state overwrite cost one login. Nothing
 * can re-mint a token now, so the same overwrite is permanent and needs a human per agent — which
 * turns "degrade to empty and carry on" from a robustness feature into the most destructive path
 * in the file.
 */
let stateWritesBlockedReason = null;

function loadState() {
  const statePath = path.join(DATA_DIR, 'bridge-state.json');
  const fresh = { botToken: null, agentTokens: {}, roomGroupMap: {}, groupRoomMap: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    /*
     * Credentials are normalized ON LOAD, so every later reader sees one shape and the migration
     * from bare strings happens exactly once per process rather than being re-guessed at each use
     * site. `normalizeAgentCredentialMap` is total: it always returns an object, so a missing or
     * malformed `agentTokens` yields `{}` here and cannot make the whole load fail — that path is
     * reserved for bytes this process could not parse at all, which is handled below.
     */
    return { ...parsed, agentTokens: normalizeAgentCredentialMap(parsed?.agentTokens) };
  } catch (error) {
    /*
     * ENOENT is the ONLY safe reason to start empty — there is no file, so there is nothing to
     * lose and the empty state is literally accurate. Every other failure (EACCES, EIO, a torn or
     * truncated write, trailing bytes) means the file EXISTS and holds something this process
     * failed to understand. Those bytes may be the only copy of every agent credential.
     */
    if (error?.code === 'ENOENT') return fresh;

    /*
     * Preserve the bytes before anything can overwrite them. If the copy lands, the data is safe
     * elsewhere and the bridge may continue writing a fresh file; if it does not, writes are
     * BLOCKED, because running degraded is recoverable and overwriting the only copy is not.
     */
    const sidecar = `${statePath}.unreadable-${Date.now()}`;
    let preserved = false;
    try {
      copyFileSync(statePath, sidecar);
      chmodSync(sidecar, 0o600);
      preserved = true;
    } catch (copyError) {
      console.error(`[bridge] could not preserve unreadable ${statePath}: ${copyError.message}`);
    }

    if (preserved) {
      console.error(
        `[bridge] ${statePath} was unreadable (${error.message}). Its bytes are preserved at `
        + `${sidecar} — recover any agent tokens from there. Starting from an empty state.`,
      );
    } else {
      stateWritesBlockedReason = `${statePath} was unreadable (${error.message}) and could not be copied aside`;
      console.error(
        `[bridge] REFUSING to persist state: ${stateWritesBlockedReason}. The file may hold the only `
        + 'copy of every agent Matrix token, and nothing can re-mint them (ADR-014 decision 3). '
        + 'Fix the file or move it aside by hand, then restart.',
      );
    }
    return fresh;
  }
}
/*
 * Owner-only, because this file is a credential store.
 *
 * `bridge-state.json` holds `botToken` and every entry of `agentTokens` — see loadState's own
 * fallback shape above. A Matrix access token is the identity: whoever reads one can post as
 * that agent and read every room it is in. The file was being written with
 * `writeFileSync(path, data)` and no mode, which is 0644 on this platform, so it was readable by
 * every other account on the host. Verified on the live deployment:
 * `-rw-r--r-- data/matrix/bridge-state.json`.
 *
 * An omission rather than a decision, and the same file proves it: the crypto store directory
 * beside it is explicitly chmod 0700, `.env` is 0600, and the backend's JSON writer opens its
 * temp file 0600. This was the one credential-bearing path left on the default.
 *
 * The chmod is separate from the mode option and not redundant: `mode` applies only when the
 * file is CREATED, so every deployment that already has a 0644 file would keep it forever
 * without this line.
 */
/*
 * Written atomically, because a torn write here loses every credential.
 *
 * `loadState` above returns `{ botToken: null, agentTokens: {}, … }` on ANY parse failure. That
 * is a reasonable first-boot default and a catastrophic recovery: a half-written file reads as
 * "no credentials", and the bridge proceeds as though this were a fresh install.
 *
 * Under the model this file has today that was survivable — a derived password can always
 * re-login, so the tokens regenerate. Under ADR-014 it is not: an appservice `as_token` or a
 * project-issued access token CANNOT be re-minted by software, and this file is their only copy.
 * A single interrupted write would mean re-provisioning every agent identity by hand, and the
 * symptom would be a bridge that came up looking healthy with an empty state.
 *
 * temp-in-the-same-directory → fsync → rename, so a reader sees either the whole old file or the
 * whole new one. The temp file is created 0600 so there is no window in which credentials sit in
 * a world-readable file, and the rename replaces the inode, which is also what keeps the mode at
 * 0600 rather than inheriting a loose mode from an older release.
 */
function saveState() {
  /*
   * Refused, not silently skipped: see `stateWritesBlockedReason`. Throwing keeps saveState's
   * existing contract — every caller has just changed something it believes became durable, and the
   * one thing worse than failing to persist is reporting that it persisted.
   */
  if (stateWritesBlockedReason) {
    throw new Error(`bridge state writes are blocked: ${stateWritesBlockedReason}`);
  }
  const statePath = path.join(DATA_DIR, 'bridge-state.json');
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  const payload = JSON.stringify(state, null, 2);
  let fd = null;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, statePath);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmpPath); } catch { /* nothing to clean */ }
    /*
     * Loud and rethrown rather than swallowed. Every caller of saveState has just changed
     * something it believes is now durable — a new agent token, a room binding, an accepted
     * invitation — and continuing as if it were persisted is how memory and disk diverge.
     */
    console.error(`[bridge] FAILED to persist ${statePath}: ${error.message}`);
    throw error;
  }
  /*
   * Belt and braces for a file that predates this function: `renameSync` carries the temp
   * file's 0600, so this only matters if the target somehow survives with a looser mode.
   */
  try {
    chmodSync(statePath, 0o600);
  } catch (error) {
    console.warn(`[bridge] could not restrict ${statePath} to 0600: ${error.message}`);
  }
}
const state = loadState();
if (!state.agentAvatars) state.agentAvatars = {};
if (!state.roomAvatars) state.roomAvatars = {};
if (!state.agentAvatarMeta) state.agentAvatarMeta = {};
if (!state.agentRoomBackfillCursors) state.agentRoomBackfillCursors = {};
if (!state.approvalDmRooms) state.approvalDmRooms = {};
if (!state.roomAgentBindings) state.roomAgentBindings = {};
// ADR-014: invitations awaiting the contributor's decision, keyed [roomId][agentName].
if (!state.pendingInvites) state.pendingInvites = {};
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

/**
 * An agent's Matrix credential as a RECORD, not a bare token string.
 *
 * ADR-014 decision 4, whose status line has read "decided, not built" with the evidence
 * "`state.agentTokens[name]` is a bare access-token string, not `{ homeserver, accessToken }`".
 * ADR-016 then made it load-bearing rather than tidy: once project homeservers are not assumed to
 * federate, a token is only meaningful against the server that issued it, and a map of bare strings
 * cannot say which server that is.
 *
 * `serverName` is carried BESIDE `homeserver` rather than derived from it. They answer different
 * questions — the base URL is where to send a request, the server name is the domain in an MXID and
 * in a room id — and `.well-known` delegation is allowed to make them disagree. `setRoomAvatar`'s
 * retry ladder needs the name, because what it must compare against is a ROOM's origin server.
 *
 * MIGRATION: a bare string becomes a record pointed at this deployment's own homeserver. That is
 * not a guess — under the model this replaces, every token was minted against `HOMESERVER`, so it is
 * the only server the value could have belonged to.
 *
 * `.token` is accepted as an alias for `.accessToken` on the way in because `endAgentWorkForToken`
 * already contained `typeof stored === 'string' ? stored : stored?.token` — someone anticipated a
 * record and guessed that name. Reading both costs one line and means a state file written by any
 * such intermediate is not silently treated as credential-less.
 */
function normalizeAgentCredential(value) {
  if (typeof value === 'string') {
    const token = value.trim();
    return token
      ? { homeserver: HOMESERVER, serverName: MATRIX_SERVER_NAME, mxid: null, accessToken: token }
      : null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = typeof value.accessToken === 'string' ? value.accessToken
    : (typeof value.token === 'string' ? value.token : '');
  const token = raw.trim();
  if (!token) return null;
  const homeserver = typeof value.homeserver === 'string' && value.homeserver.trim()
    ? value.homeserver.trim().replace(/\/+$/, '')
    : HOMESERVER;
  const serverName = typeof value.serverName === 'string' && value.serverName.trim()
    ? value.serverName.trim().toLowerCase()
    : MATRIX_SERVER_NAME;
  const mxid = typeof value.mxid === 'string' && value.mxid.trim() ? value.mxid.trim() : null;
  return { homeserver, serverName, mxid, accessToken: token };
}

/**
 * Normalize every stored credential, and say what was dropped.
 *
 * An entry that yields no token carries no credential, so dropping it loses nothing — but it is
 * named in the log rather than discarded quietly, because this file is the one place where a wrong
 * assumption about what is droppable costs a token nothing can re-mint (ADR-014 decision 3).
 */
function normalizeAgentCredentialMap(raw) {
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const record = normalizeAgentCredential(value);
    if (record) out[name] = record;
    else dropped.push(name);
  }
  if (dropped.length) {
    console.warn(
      `[bridge] ${dropped.length} stored agent credential entr(ies) carried no token and were not `
      + `loaded: ${dropped.join(', ')}. Nothing was lost — an entry with no token is not a credential `
      + '— but the names are listed so an unexpected one is visible rather than inferred.',
    );
  }
  return out;
}

/**
 * The credential a raw access token belongs to.
 *
 * For the two send paths that receive a TOKEN rather than an agent name — `sendAsAgentContent` and
 * `sendAttachmentAsAgent` — which therefore cannot resolve a homeserver by name. The token is the
 * identity, so its record is well defined; `endAgentWorkForToken` already scans the same map for the
 * same reason. Returns null for the bot's own token, whose server is this deployment's.
 */
function credentialForToken(token) {
  if (!token) return null;
  for (const credential of Object.values(state.agentTokens || {})) {
    if (credential?.accessToken === token) return credential;
  }
  return null;
}

/** The base URL a token should be used against: its own side's, or ours when it is not an agent's. */
function baseUrlForToken(token) {
  return credentialForToken(token)?.homeserver || HOMESERVER;
}

const warnedUnnormalizedCredentials = new Set();

/**
 * The credential record for an agent, resolved through the same name matching as the token lookup.
 *
 * NORMALIZES ON READ, AND SAYS SO. `loadState` normalizes everything it parses and the adoption site
 * writes a record, so in production the map already holds records — but a third writer exists (a test
 * seeding `agentTokenStateForTest()` directly), and there is no way to make an object property
 * assignment enforce a shape.
 *
 * The alternative was a strict accessor that returned null for anything that was not already a
 * record. That is the worse failure: a stray string would read as "this agent has no credential",
 * which raises `AgentCredentialMissingError` and takes the agent silent — the single worst outcome in
 * this file, and one that would look like a revoked token rather than a shape mismatch.
 *
 * So it upgrades in place and warns once per name. A stray writer is then loud instead of either
 * silent-and-broken or silent-and-tolerated.
 */
function agentCredential(agentName) {
  const key = resolveStoredAgentTokenName(agentName);
  if (!key) return null;
  const stored = state.agentTokens[key];
  if (!stored) return null;
  if (typeof stored === 'object' && typeof stored.accessToken === 'string') return stored;
  const record = normalizeAgentCredential(stored);
  if (!warnedUnnormalizedCredentials.has(key)) {
    warnedUnnormalizedCredentials.add(key);
    console.warn(
      `[bridge] agent credential for '${key}' was stored in a pre-ADR-014-decision-4 shape and has `
      + `been upgraded in memory to { homeserver, serverName, mxid, accessToken }`
      + `${record ? '' : ' — but it carried no usable token'}. Loaded state is normalized, so this `
      + 'means something wrote the map directly.',
    );
  }
  if (record) state.agentTokens[key] = record;
  return record;
}

function getStoredAgentToken(agentName) {
  return agentCredential(agentName)?.accessToken ?? null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENT_PREFIX_RE = escapeRegex(AGENT_PREFIX);

if (!BOT_PASSWORD) {
  console.warn('MATRIX_BOT_PASSWORD is not set. Bridge can run with cached token, but re-login will fail if token expires.');
}

if (!AUTO_AVATAR_ENABLED) {
  console.warn('MATRIX_AUTO_AVATAR is disabled. Automatic avatar generation/sync is off; use hafleet-cli avatar <name> <image-file> for manual updates.');
}

function makeUserId(localpart) {
  return `@${localpart}:${MATRIX_SERVER_NAME}`;
}

/**
 * The agent's MXID, with a LOWERCASE localpart.
 *
 * Matrix requires it: a user ID localpart must be lowercase, and uppercase survives only in
 * historical IDs. Homeservers therefore normalise on registration — Palpo accepted `ac_BigLittle`
 * and handed back `@ac_biglittle:palpo.test`.
 *
 * Composing with the agent's own casing produced an ID that could never exist. It went unnoticed
 * while every agent happened to be named in lower case, and surfaced the moment one was not: the
 * identity check in `ensureAgentAccount` compared `/whoami`'s `@ac_biglittle` against a composed
 * `@ac_BigLittle` and correctly refused a perfectly good credential. The check was right; this was
 * the bug.
 *
 * ADR-014 decision 5 says an MXID should be DISCOVERED rather than composed, which would remove this
 * function's reason to exist. Until then it must at least compose something the server can hold.
 */
/**
 * The MXID an agent WOULD have on this deployment's own homeserver.
 *
 * A SPECIFICATION, NOT AN OBSERVATION, and separating the two is the point of `agentMxid` below.
 * ADR-014 decision 5 says an agent's MXID must be DISCOVERED rather than constructed — but auditing
 * every caller showed that composition is not uniformly wrong. It is correct wherever the composed
 * value is what we are ASKING FOR rather than what we believe to be true:
 *
 *   - telling an operator which account to create, and which token to issue for it;
 *   - the expected side of the identity check in `ensureAgentAccount`, where by definition no
 *     discovered value exists yet — that check is what produces one;
 *   - constructing the name of an account to look for and remove, including the `@ac_<human>` that
 *     should never have existed.
 *
 * It is wrong wherever it asserts an identity for an agent that is already operating, because such an
 * agent may live on a project side's homeserver. Those callers use `agentMxid`.
 */
function agentUserId(name) {
  return makeUserId(`${AGENT_PREFIX}${String(name || '')}`.toLowerCase());
}

/**
 * The MXID an operating agent ACTUALLY has: discovered if we know it, composed if we do not.
 *
 * ADR-014 decision 5. The discovered value comes from `/whoami` at credential adoption and is stored
 * on the credential record (decision 4), so this reads a fact rather than rebuilding a guess.
 *
 * WHY THE FALLBACK IS SAFE HERE, rather than the silent default this project keeps finding defects in:
 * every caller of this function concerns an agent that is operating — deriving an inviter, matching an
 * invite's `state_key`, checking approval-room membership, addressing a DM, sending a typing
 * notification. An agent with no credential record has no token, so it cannot have acted and cannot
 * have been invited as anything worth comparing. The fallback therefore covers a case that does not
 * arise, and preserves today's behaviour exactly on a single-homeserver deployment.
 *
 * THE COST OF GETTING THIS WRONG IS ALREADY RECORDED IN THIS FILE. The invite poll once composed a
 * `state_key` inline and missed the lowercasing the homeserver applies: it looked for
 * `@ac_BigLittle:…` while the event carried `@ac_biglittle:…`, found nothing, and reported a null
 * inviter. Owner IS the inviter (ADR-002), so a null inviter meant the room was untrusted, no
 * ownership was recorded, and every later approval failed `owner_binding_missing`. That was a
 * case difference. A wrong SERVER is the same mechanism with a larger error.
 */
function agentMxid(name) {
  return agentCredential(name)?.mxid || agentUserId(name);
}

function humanUserId(name) {
  // Accept full MXID (federated users) or localpart (legacy)
  if (typeof name === 'string' && name.startsWith('@') && name.includes(':')) return name;
  return makeUserId(name);
}

/** DM key: federated users key by full MXID, local users by localpart. */
/*
 * Which of the bot's DM rooms are DEAD, and therefore reapable.
 *
 * WHY THIS EXISTS. The bridge opens a DM with each new human it discovers and never
 * closes one. `ensureBotDmRoom` reuses per human, so it is one room per person rather
 * than per encounter — but nothing removes the room when the person is gone, and
 * `botDmRooms` grows beside it. A 50-minute soak that registered 48 throwaway
 * projects left the bot sitting alone in 52 DMs, and in production that is one
 * permanent room per user who ever appeared.
 *
 * THE DISTINCTION THAT MATTERS: a DM the human has not ACCEPTED yet also shows the
 * bot as the only joined member. Reaping on "nobody else joined" would cancel every
 * greeting still in flight — the invitation would vanish before it was seen. Only
 * membership `leave` (or `ban`) means gone. Absence of a join is not evidence of
 * departure, it is usually evidence of not having looked yet.
 *
 * TWO OUTCOMES, NOT ONE. A room the bot is still in but the human has left needs
 * leaving. A room the bot is ALREADY out of needs nothing but the stale pointer
 * removed — and those entries were accumulating unnoticed, because the first version
 * tried to read the room's joined members, got M_FORBIDDEN (the bot is not in it),
 * treated that as an unknown, and kept the entry forever. Verified against the live
 * homeserver: `/members?membership=leave` still answers for a room you have left,
 * `/joined_members` does not.
 *
 * `bot-absent` is durable — not a member is not a transient condition — whereas a
 * rate limit or a network error leaves the entry `null` and is skipped, because a
 * failed lookup must never become a deletion.
 *
 * @param dmRooms   state.botDmRooms — { humanKey: roomId }
 * @param membership { roomId: 'join' | 'invite' | 'leave' | 'ban' | 'bot-absent' |
 *                   null }. `null` means unknown, which is never treated as gone.
 * @returns [{ humanKey, roomId, reason, action: 'leave' | 'drop' }]
 */
/**
 * Should reaping this room also forget that the human was greeted?
 *
 * SEPARATED OUT BECAUSE THIS IS WHERE THE BUG WAS, and no test could see it. The
 * decision above (which rooms are dead) was well covered; this — what state to delete
 * as a consequence — was inline in the caller, and getting it wrong turned a bounded
 * leak into an unbounded churn loop: forget the greeting, re-greet, create a DM, reap
 * it, forget again. Observed live, 39 -> 45 rooms in forty-five seconds. A pure
 * function over the decision cannot catch a mistake in the consequence, so the
 * consequence is a pure function too.
 *
 * `greetedHumans` means "this person has already been greeted". Tidying a room the bot
 * stepped out of says nothing about the person, so the memory stays. An actual
 * departure does mean a future arrival deserves a greeting.
 */
export function forgetGreetingOnReap(reason) {
  return reason === 'leave' || reason === 'ban';
}

export function reapableBotDms(dmRooms = {}, membership = {}) {
  const out = [];
  for (const [humanKey, roomId] of Object.entries(dmRooms || {})) {
    if (typeof roomId !== 'string' || !roomId) continue;
    const state = membership[roomId] ?? null;
    if (state === 'leave' || state === 'ban') {
      out.push({ humanKey, roomId, reason: state, action: 'leave' });
    } else if (state === 'bot-absent') {
      out.push({ humanKey, roomId, reason: state, action: 'drop' });
    }
  }
  return out;
}

function humanDmKey(name) {
  if (typeof name === 'string' && name.startsWith('@') && name.includes(':')) {
    const homeserver = name.slice(name.indexOf(':') + 1);
    if (homeserver !== MATRIX_SERVER_NAME) return name; // federated → full MXID
    return name.slice(1, name.indexOf(':')); // local → localpart
  }
  return name;
}

// ── Matrix account management ─────────────────────────────────────────
async function matrixRegister(username, password, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'matrixRegister');
  // Step 1: probe for the UIA session + the server's available flows.
  const probe = await fetchWithRateLimit(`${base}/_matrix/client/v3/register`, {
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
  const res = await fetchWithRateLimit(`${base}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, auth }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Registration failed for ${username}: ${JSON.stringify(data)}`);
}

async function matrixLogin(username, password, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'matrixLogin');
  const res = await fetchWithRateLimit(`${base}/_matrix/client/v3/login`, {
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
      const data = await matrixLogin(BOT_USERNAME, BOT_PASSWORD, HOMESERVER);
      state.botToken = data.access_token;
      saveState();
      console.log(`Bot logged in as ${data.user_id}`);
      return data.access_token;
    } catch (loginErr) {
      try {
        const data = await matrixRegister(BOT_USERNAME, BOT_PASSWORD, HOMESERVER);
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

/**
 * Thrown when an agent has no usable Matrix credential.
 *
 * A distinct type rather than a bare Error because callers must be able to tell "this agent needs
 * a human to provision it" from a transient network failure — the first is a standing condition
 * that no amount of retrying fixes, and ADR-014 decision 6 requires it to be visible as such
 * rather than absorbed into a retry loop.
 */
class AgentCredentialMissingError extends Error {
  constructor(agentName, detail) {
    super(`agent '${agentName}' has no usable Matrix credential: ${detail}`);
    this.name = 'AgentCredentialMissingError';
    this.agentName = agentName;
    this.detail = detail;
    this.needsProvisioning = true;
  }
}

/**
 * The agent's Matrix credential — supplied, never minted.
 *
 * ADR-014 decision 3 deleted the derived-password path this used to fall back on. What remains is
 * the stored access token and a check that it still works, which is the whole of the BYO model:
 * a human creates the account on whichever homeserver the project lives on and hands over a
 * token, so the credential is REVOCABLE (server-side, per agent) and needs no account-creation
 * privilege from us.
 *
 * WHAT CHANGES FOR AN EXISTING DEPLOYMENT: nothing, until a token stops working. Tokens already in
 * bridge-state.json keep being used exactly as before — the /whoami check is unchanged — so a
 * running fleet does not notice this commit. What no longer happens silently is REPLACEMENT: a
 * missing or dead credential used to be re-minted from the master secret, and now it stops and
 * says so. That is the point rather than a regression: re-minting is what made the credential
 * unrevocable, because revoking a token achieved nothing while the password could be re-derived.
 *
 * Refuses rather than returning null so no caller can mistake "no credential" for "no agent" and
 * carry on with an undefined token — the class of bug where an unauthenticated request looks like
 * an empty result.
 */
/**
 * The operator-supplied Matrix access token for one agent, or null.
 *
 * `MATRIX_AGENT_TOKEN_<AGENT>`, with the agent name upper-cased and every character outside
 * [A-Z0-9] turned into `_` (so `wf_coordinator` reads MATRIX_AGENT_TOKEN_WF_COORDINATOR). Env
 * because that is already how every other bridge credential arrives — BOT_PASSWORD, the bridge
 * secret, the registration token — so this needs no new file format, no new parser, and inherits
 * the 0600 .env the deployment already protects.
 *
 * Per agent, deliberately, since the whole point of ADR-014 decision 3 is that no single value may
 * stand behind every agent identity: one variable can be replaced without touching any other
 * agent, and revoking one token server-side ends exactly one agent's access.
 */
/** The env var name an agent's token is read from. Exported shape of the mangling, so the
 *  collision check below and the error messages cannot drift from the actual lookup. */
function agentTokenEnvVarName(agentName) {
  const suffix = String(agentName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return suffix ? `MATRIX_AGENT_TOKEN_${suffix}` : null;
}

function agentTokenFromEnv(agentName) {
  const varName = agentTokenEnvVarName(agentName);
  if (!varName) return null;
  const raw = process.env[varName];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || null;
}

async function ensureAgentAccount(agentName) {
  const canonicalAgentName = resolveStoredAgentTokenName(agentName) || agentName;
  const envVarName = agentTokenEnvVarName(canonicalAgentName);

  /*
   * Stored first, operator-supplied second. The stored token is the one already in use, so trying
   * it first keeps the steady state at a single whoami and makes this function idempotent; the env
   * value is the REPLACEMENT path, consulted when the stored one is absent or has been rejected.
   * That ordering is what lets an operator rotate by editing one variable: the dead stored token
   * fails, the fresh env token is adopted, and no other agent is touched.
   */
  const candidates = [];
  const stored = getStoredAgentToken(canonicalAgentName);
  if (stored) candidates.push({ token: stored, source: 'stored' });
  const supplied = agentTokenFromEnv(canonicalAgentName);
  // Deduplicated: after adoption the stored and env values are normally IDENTICAL, and while that
  // costs nothing on the success path (the loop returns on the first hit), a dead token would
  // otherwise be presented to the homeserver twice and reported as two separate rejections.
  if (supplied && supplied !== stored) candidates.push({ token: supplied, source: 'env' });

  if (candidates.length === 0) {
    throw new AgentCredentialMissingError(
      canonicalAgentName,
      `no Matrix access token is stored for it and ${envVarName} is unset. Create or claim an `
      + `account for ${agentUserId(canonicalAgentName)} on ${MATRIX_SERVER_NAME}, then put its `
      + `access token in ${envVarName}. Agent passwords are no longer derived (ADR-014 `
      + 'decision 3), so the bridge cannot mint this credential itself.',
    );
  }

  /*
   * Validated, not trusted. A token can be revoked server-side, expired by policy, or invalidated
   * by deleting its device — and nothing here can re-mint it, so "works" has to be ESTABLISHED
   * before the token is handed to a caller that will send messages as that agent. The alternative,
   * returning it unchecked, converts a dead credential into a failure at some later send, attached
   * to whatever unrelated action happened to be first.
   */
  let lastAuthFailure = null;
  for (const candidate of candidates) {
    let session;
    try {
      session = await getMatrixAccessTokenSession(candidate.token, HOMESERVER);
    } catch (error) {
      /*
       * A network failure is NOT a dead credential and must not be reported as one — telling an
       * operator to re-provision because the homeserver blinked sends them to replace a token that
       * was fine, and here replacing means a human doing account work. Rethrown unchanged so the
       * caller's own retry sees a transport error, and NOT swallowed into the next candidate:
       * during an outage every candidate would fail this way and the loop would end by declaring
       * the credentials dead.
       */
      if (!isMatrixAuthFailure(error)) throw error;
      lastAuthFailure = error;
      console.warn(`[agent-credential] ${candidate.source} token for '${canonicalAgentName}' was rejected: ${error.errcode || error.status}`);
      continue;
    }

    /*
     * IDENTITY, not just validity. A valid token proves someone's account exists; it does not prove
     * it is THIS agent's. Paste agent A's token into agent B's variable — trivial with one line per
     * agent, and the mangled variable names are not injective (`octos-agent` and `octos_agent` both
     * read MATRIX_AGENT_TOKEN_OCTOS_AGENT) — and without this check the bridge would send B's
     * messages as A, and rename A's profile to `🤖 B` on the way. Both are silent: A's traffic
     * simply grows.
     *
     * Compared against the composed MXID because that is what every other path in this file uses
     * today. When decision 4 gives an agent its own homeserver and decision 5 records a discovered
     * MXID, this becomes a comparison against the recorded value — the check stays, its right-hand
     * side moves.
     */
    const expectedUserId = agentUserId(canonicalAgentName);
    if (session.userId !== expectedUserId) {
      console.error(`[agent-credential] REFUSING ${candidate.source} token for '${canonicalAgentName}': it belongs to ${session.userId}, not ${expectedUserId}`);
      throw new AgentCredentialMissingError(
        canonicalAgentName,
        `the ${candidate.source} Matrix token belongs to ${session.userId}, not ${expectedUserId}. `
        + `Supply a token issued for ${expectedUserId} in ${envVarName}. Note that variable names `
        + 'collapse non-alphanumerics, so two similarly named agents can map to the same variable.',
      );
    }

    /*
     * Adopted into state so the next call is one whoami against the token that works. Written only
     * after the homeserver accepted it AND proved it is this agent's, so neither a typo nor another
     * agent's credential can displace a working one.
     */
    if (state.agentTokens[canonicalAgentName]?.accessToken !== candidate.token) {
      /*
       * Stored as a record, with the MXID the homeserver just reported in `session.userId`.
       *
       * This does NOT settle ADR-014 decision 5. That decision is that an agent's MXID becomes
       * DISCOVERED rather than constructed, and `agentUserId()` still composes
       * `@${AGENT_PREFIX}${name}:${MATRIX_SERVER_NAME}` for every other caller. Recording the
       * discovered value where we already have it makes decision 5 cheaper to build later; it does
       * not make it built, and the ADR is explicit that settling it as a side effect of a credential
       * change would decide it without deciding it.
       */
      state.agentTokens[canonicalAgentName] = normalizeAgentCredential({
        homeserver: HOMESERVER,
        serverName: MATRIX_SERVER_NAME,
        mxid: session.userId,
        accessToken: candidate.token,
      });
      saveState();
      console.log(`[agent-credential] adopted ${candidate.source} Matrix token for '${canonicalAgentName}' (${session.userId})`);

      /*
       * Keep the display name the old register path used to set. An operator-created account
       * arrives with whatever profile they gave it — often none — and an agent showing as a raw
       * `@ac_foo:server` in every client is a regression this change would otherwise ship.
       *
       * Best-effort: the credential is already validated and usable, so failing to pretty up a
       * profile must not deny the agent its token. Setting one's own display name is a privilege
       * every account has over itself, so this needs nothing beyond the token in hand.
       */
      await setDisplayName(candidate.token, canonicalAgentName, session.userId, HOMESERVER)
        .catch((e) => console.warn(`[agent-credential] could not set display name for '${canonicalAgentName}': ${e.message}`));
    }

    /*
     * session.userId is the agent's real MXID and is deliberately NOT persisted here: that is
     * ADR-014 decision 5 (identity discovery), still open. Settling it as a side effect of a
     * credential change would decide an open design question in a commit about something else.
     */
    return candidate.token;
  }

  throw new AgentCredentialMissingError(
    canonicalAgentName,
    `every Matrix token available for it was rejected by the homeserver (${lastAuthFailure?.errcode || lastAuthFailure?.status}). `
    + `Issue a new access token for ${agentUserId(canonicalAgentName)} and set ${envVarName}. `
    + 'Nothing can re-mint it: agent passwords are no longer derived (ADR-014 decision 3).',
  );
}

async function setDisplayName(token, agentName, knownUserId = null, baseUrl = undefined) {
  const base = requireBaseUrl(baseUrl, 'setDisplayName');
  // The MXID is passed in where the caller already has it: adoption just ran whoami, and repeating
  // it here would be a second round trip for an answer already in hand.
  const userId = knownUserId || await getUserId(token, base);
  await fetch(`${base}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayname: `🤖 ${agentName}` }),
  });
}

/**
 * The base URL every token-taking primitive must be handed.
 *
 * REQUIRED, not defaulted to `HOMESERVER`, and that is the whole point of ADR-016's third first-pass
 * shape. A default would let a caller that has an agent's credential in hand silently send it to this
 * deployment's own server instead of the agent's — which, once project homeservers are not assumed to
 * federate, is a request that fails at best and lands one side's token on another side's server at
 * worst. JavaScript cannot enforce a required parameter, so it is enforced here: an omission is a
 * throw naming the function, rather than `undefined/_matrix/...` failing obscurely several frames away.
 */
function requireBaseUrl(baseUrl, fnName) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error(`${fnName} requires a Matrix base URL (ADR-016: every call takes it from its side)`);
  }
  return baseUrl.replace(/\/+$/, '');
}

async function getUserId(token, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'getUserId');
  const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.user_id;
}

/**
 * Did the homeserver REJECT this credential, as opposed to failing to answer?
 *
 * Only 401 (M_UNKNOWN_TOKEN and friends) and 403 mean the token itself is no good. Everything
 * else — a 5xx, a timeout, DNS failure, a rate limit — says nothing about the credential, and
 * must not be reported as "your token was revoked": that sends an operator to replace a token
 * that was fine, and on this path replacing means a human doing account work on a homeserver.
 * Unknown shapes therefore answer FALSE, so an unrecognised failure is treated as transient
 * rather than as a verdict on the credential.
 */
function isMatrixAuthFailure(error) {
  return error?.status === 401 || error?.status === 403;
}

async function getMatrixAccessTokenSession(token, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'getMatrixAccessTokenSession');
  const res = await fetchWithRateLimit(`${base}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  /*
   * Body parsed DEFENSIVELY and after the status is in hand. `await res.json()` on a 401 whose body
   * is empty or HTML — a proxy, or a non-conforming homeserver — throws a SyntaxError that carries
   * no `.status`, so the rejection would be classified transient and retried forever while the
   * fresh credential sitting in the environment is never tried. The status is the reliable signal;
   * the body only enriches the message.
   */
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    /*
     * The status travels on the error, not just inside its message. A caller has to tell a
     * REJECTED credential from an UNREACHABLE homeserver, and recovering that by matching
     * /HTTP 401/ against a human-readable string is a check that breaks the next time anyone
     * rewords the message — silently, and in the direction of calling an outage a dead token.
     */
    const error = new Error(`Matrix whoami failed with HTTP ${res.status}: ${data?.errcode || data?.error || 'unknown error'}`);
    error.status = res.status;
    error.errcode = typeof data?.errcode === 'string' ? data.errcode : undefined;
    throw error;
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

async function uploadMedia(token, buffer, mimeType, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'uploadMedia');
  const res = await fetch(`${base}/_matrix/media/v3/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Media upload failed: ${res.status}`);
  const data = await res.json();
  return data.content_uri;
}

async function setUserAvatar(token, mxcUri, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'setUserAvatar');
  const userId = await getUserId(token, base);
  await fetch(`${base}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/avatar_url`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar_url: mxcUri }),
  });
}

/**
 * Set a room's avatar, retrying with an agent's credential if the bot lacks the power level.
 *
 * `baseUrl` is a parameter rather than the module constant: ADR-016's first pass requires every
 * Matrix call to take its base URL from the side it is talking to, and this function is one of the
 * ten ADR-014 decision 4 classified as "takes whichever token its caller holds".
 *
 * THE RETRY LADDER ONLY CONSIDERS CREDENTIALS FOR THIS ROOM'S OWN SERVER, and that is a fix rather
 * than a tightening. It used to iterate `Object.values(state.agentTokens)` and send each one to
 * `HOMESERVER`. Under a single homeserver that is a sane fallback — the bot may not have power to set
 * a room avatar while some agent in the room does. Once ADR-016 stops assuming federation, that map
 * holds one credential per agent ACROSS DIFFERENT HOMESERVERS, so the loop would offer every project
 * side's access token to whichever server this call is aimed at: a credential disclosure across
 * project sides, caused by a cosmetic feature, and one that appears the moment a second project side
 * exists rather than when anyone edits this function.
 *
 * The comparison is against the ROOM's origin server (`!opaque:origin-server`) rather than against
 * `baseUrl`, because a base URL may be a delegated address while the room id always names the server
 * that owns the room — which is the server the token must belong to.
 */
async function setRoomAvatar(roomId, mxcUri, token, baseUrl) {
  const base = requireBaseUrl(baseUrl, 'setRoomAvatar');
  const useToken = token || state.botToken;
  const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: mxcUri }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (err.errcode === 'M_FORBIDDEN' && useToken === state.botToken) {
      const targetServer = projectServerFromRoomId(roomId);
      for (const credential of Object.values(state.agentTokens)) {
        /*
         * Skipped silently rather than logged: on a deployment with several project sides this would
         * be the common case, not an anomaly, and a warning per agent per avatar refresh would bury
         * the log. What IS worth saying is when the ladder finds nothing to try at all — see below.
         */
        if (!targetServer || credential?.serverName !== targetServer) continue;
        const retry = await fetch(url, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json' },
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
    const agentBase = agentCredential(canonicalAgentName)?.homeserver || HOMESERVER;
    const mxcUri = await uploadMedia(token, png, 'image/png', agentBase);
    await setUserAvatar(token, mxcUri, agentBase);
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
        await setRoomAvatar(roomId, agentAvatar, null, HOMESERVER);
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
    const mxcUri = await uploadMedia(state.botToken, png, 'image/png', HOMESERVER);
    await setRoomAvatar(roomId, mxcUri, null, HOMESERVER);
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
      await setRoomAvatar(roomId, mxcUri, agentToken, HOMESERVER);
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
    const agentBase = agentCredential(canonicalAgentName)?.homeserver || HOMESERVER;
    const mxcUri = await uploadMedia(token, imageBuffer, mimeType, agentBase);
    await setUserAvatar(token, mxcUri, agentBase);
    state.agentAvatars[canonicalAgentName] = mxcUri;
    saveState();
    console.log(`Set custom avatar for agent ${canonicalAgentName}: ${mxcUri}`);
    await syncAgentAvatarToDmRooms(canonicalAgentName);
  } catch (e) {
    console.warn(`Failed to set custom avatar for agent ${canonicalAgentName}: ${e.message}`);
  }
}

// ── Backend API helpers ───────────────────────────────────────────────
/*
 * How often the bridge re-reads which project sides it serves. Slow on purpose: adding a side is an
 * operator action measured in minutes, and each refresh is an authenticated call to the backend. The
 * router preserves receivers whose token has not changed, so a refresh is cheap and does not disturb
 * deduplication.
 */
const APPSERVICE_SIDE_REFRESH_MS = Number.parseInt(process.env.HAFLEET_APPSERVICE_REFRESH_MS || '60000', 10) || 60_000;
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

/*
 * ── Pending project invitations (ADR-014 amendment 2026-08-11) ────────────────────────────
 *
 * An invitation from an inviter we do not already trust is a DECISION for the contributor, not
 * an error and not an auto-join. The record exists so the decision can be presented: which room,
 * which server, who invited, and which agent they invited.
 *
 * Keyed `[roomId][agentName]` for the same reason ownership is (ADR-002): one project room can
 * hold several of the contributor's agents, each invited separately and each owned by whoever
 * invited THAT one. A room-only key would let a second agent's invitation overwrite the first's
 * inviter, which is precisely the ownership confusion ADR-002 exists to prevent.
 */
function pendingInviteKey(roomId, agentName) {
  if (!state.pendingInvites[roomId]) state.pendingInvites[roomId] = {};
  return state.pendingInvites[roomId];
}

/**
 * The project's homeserver, read off the room id rather than configured.
 *
 * A Matrix room id is `!opaque:origin-server`, so the server hosting a project room is already
 * in the id every engagement and whitelist entry carries. ADR-014 originally had an operator type
 * this; deriving it removes a field that could be typed wrong.
 *
 * This is the room's ORIGIN server, which is where the project lives — not necessarily the server
 * an agent's account must live on. With federation those differ and that is fine; the amendment
 * records that non-federating servers are out of scope.
 */
function projectServerFromRoomId(roomId) {
  if (typeof roomId !== 'string') return null;
  const at = roomId.indexOf(':');
  return at > 0 ? roomId.slice(at + 1) : null;
}

/**
 * Record an invitation as awaiting a decision.
 *
 * @returns true only when this is NEW information. The invite poll runs on a timer, so returning
 * true unconditionally would re-log and re-notify every few seconds for as long as the invitation
 * sits there. A previously DECLINED invitation also returns false: the contributor already
 * answered, and re-asking would make "no" impossible to express.
 */
/**
 * Fill in an inviter the first observation could not read.
 *
 * The inviter IS the owner (ADR-002), so a pending record frozen at null yields an invitation that
 * cannot be accepted — /projects disables Accept precisely because storing a null owner would look
 * accepted and work for nothing. Observed: poll 1 recorded null, poll 2 resolved
 * `@yue:palpo.test`, and the record kept the null because the resolving poll took the join path.
 *
 * Only ever fills a null. Never replaces a known inviter — that would be ownership changing hands
 * silently, which is the one thing this record exists to prevent.
 */
function backfillPendingInviteInviter(roomId, agentName, inviter) {
  if (!inviter) return false;
  const existing = (state.pendingInvites?.[roomId] || {})[agentName];
  if (!existing || existing.state !== 'pending' || existing.inviter) return false;
  existing.inviter = inviter;
  saveState();
  console.log(`[invite] backfilled inviter for ${agentName} in ${roomId}: ${inviter}`);
  return true;
}

function rememberPendingInvite(roomId, agentName, inviter) {
  const byAgent = pendingInviteKey(roomId, agentName);
  const existing = byAgent[agentName];
  if (existing && (existing.state === 'pending' || existing.state === 'declined')) return false;
  byAgent[agentName] = {
    roomId,
    agentName,
    // May be null when the invite state does not name the sender; surfaced rather than guessed,
    // because the inviter IS the owner under ADR-002 and inventing one would forge ownership.
    inviter: inviter ?? null,
    projectServer: projectServerFromRoomId(roomId),
    state: 'pending',
    seenAt: Date.now(),
  };
  saveState();
  return true;
}

/**
 * Clear all pending-invite state. Test-only: the store is module-global, so a suite that seeds
 * invitations leaks them into the next test's `listPendingInvites()` unless it resets between
 * cases. Named `...ForTest` and exported beside the other test seams.
 */
function resetPendingInvitesForTest() {
  state.pendingInvites = {};
}

/** Every invitation still awaiting a decision, newest first. */
function listPendingInvites() {
  const out = [];
  for (const byAgent of Object.values(state.pendingInvites || {})) {
    for (const record of Object.values(byAgent || {})) {
      if (record?.state === 'pending') out.push(record);
    }
  }
  return out.sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
}

/** The record for one (room, agent), whatever its state. */
function getPendingInvite(roomId, agentName) {
  return state.pendingInvites?.[roomId]?.[agentName] ?? null;
}

/**
 * Mark a decision. `accepted` records that the join has happened; `declined` is remembered so the
 * poll does not resurrect it.
 */
function settlePendingInvite(roomId, agentName, decision, by = 'operator') {
  const record = getPendingInvite(roomId, agentName);
  if (!record) return null;
  record.state = decision;
  record.decidedAt = Date.now();
  record.decidedBy = by;
  saveState();
  return record;
}

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
  /*
   * An ownership TRANSFER is logged. ADR-002's Consequences claim "transferring ownership
   * requires an explicit, audited transition", and this function rewrote `inviter`/`ownerMxid`
   * wholesale with no trace — so a re-invite by a different human silently moved who may approve
   * this agent's work in this room. The backend half of the audit exists (approval-store records
   * `owner_binding_changed` and denies in-flight requests), but nothing recorded the bridge-side
   * change that caused it, which left the two halves of one event impossible to correlate.
   *
   * A log line, not a refusal: a genuine transfer is legitimate — a project's maintainer changes
   * — and blocking it here would strand the agent. What was missing was the record.
   */
  const previousOwner = typeof existing.ownerMxid === 'string' ? existing.ownerMxid : null;
  if (previousOwner && previousOwner !== normalizedOwner) {
    console.warn(
      `[room-agent] ownership transfer for ${storedName} in ${normalizedRoomId}: `
      + `${previousOwner} -> ${normalizedOwner}`,
    );
  }
  bindings[storedName] = {
    inviter: normalizedOwner,
    ownerMxid: normalizedOwner,
    approvalDmRoomId,
    addedAt: Number(existing.addedAt || options.addedAt || Date.now()),
    ...(previousOwner && previousOwner !== normalizedOwner
      ? { previousOwnerMxid: previousOwner, ownerChangedAt: Date.now() }
      : {}),
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

function agentOpsClientFeatureEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.HAFLEET_AGENT_OPS_CLIENT || '').trim().toLowerCase());
}

export function parseAgentOpsClientControlEvent(roomId, event) {
  const content = event?.content;
  if (!content || ![AGENT_OPS_SESSION_REQUEST_MSGTYPE, AGENT_OPS_SESSION_REVOKE_MSGTYPE].includes(content.msgtype)) {
    return null;
  }
  const detail = content[AGENT_OPS_EVENT_KEY];
  const senderMxid = typeof event?.sender === 'string' ? event.sender.trim() : '';
  const eventId = typeof event?.event_id === 'string' ? event.event_id.trim() : '';
  if (!detail || detail.schema !== 'com.hafleet.agent_ops.v1' || !/^@[^:\s]+:[^\s]+$/.test(senderMxid) || !eventId) {
    return { invalid: true, eventId: eventId || null };
  }
  if (content.msgtype === AGENT_OPS_SESSION_REVOKE_MSGTYPE) {
    if (Object.keys(detail).sort().join(',') !== 'schema,scope_id') return { invalid: true, eventId };
    const scopeId = typeof detail.scope_id === 'string' ? detail.scope_id.trim() : '';
    if (!scopeId) return { invalid: true, eventId };
    return { kind: 'revoke', roomId, eventId, senderMxid, scopeId };
  }
  if (Object.keys(detail).sort().join(',') !== 'agent,client_nonce,client_public_jwk,project_room_id,schema') {
    return { invalid: true, eventId };
  }
  const agent = typeof detail.agent === 'string' ? detail.agent.trim() : '';
  const projectRoomId = typeof detail.project_room_id === 'string' ? detail.project_room_id.trim() : '';
  const clientNonce = typeof detail.client_nonce === 'string' ? detail.client_nonce.trim() : '';
  let clientPublicJwk;
  try {
    clientPublicJwk = normalizeEd25519PublicJwk(detail.client_public_jwk);
  } catch {
    return { invalid: true, eventId };
  }
  if (!agent || !/^![^:\s]+:[^\s]+$/.test(projectRoomId) || !clientNonce || clientNonce.length > 255) {
    return { invalid: true, eventId };
  }
  return {
    kind: 'request',
    roomId,
    eventId,
    senderMxid,
    agent,
    projectRoomId,
    clientNonce,
    clientPublicJwk,
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
 * Which messages in a room the bot has JUST JOINED still need routing.
 *
 * THE DEFECT THIS EXISTS FOR. Sync delivers only events from after the join point,
 * and nothing backfilled a room the bot joined by invite. So anything said between
 * the invite and the join was lost permanently — no engagement, no reply, no error.
 * Reproduced against the live deployment: a `!request` sent at t+0 into a freshly
 * created room, bot joined at t+2s, and 80 seconds later there was still no answer.
 *
 * `backfillAgentManagedRooms()` did not cover this: it only walks rooms that already
 * have an agent BINDING, so the backfill was gated on the very state the dropped
 * message was trying to create.
 *
 * SELECTION IS BY POSITION, NOT BY TIMESTAMP, and the first version got that wrong.
 * It computed a time "floor" from the invite and admitted anything newer. Matrix does
 * not order by wall clock: `/messages` order is server-defined, `origin_server_ts`
 * can be set by an application service without changing DAG order, and clocks skew.
 * A counterexample runs cleanly against the timestamp version — an older-in-timeline
 * `!request` carrying a newer timestamp than the invite is admitted and executed. The
 * same flaw reversed command order whenever two events shared a millisecond, because
 * a stable sort with a zero comparator preserved the newest-first fetch order and
 * turned `!request` then `!cancel` into cancel-then-request.
 *
 * So the window is delimited by the membership events themselves: everything after
 * the bot's CURRENT invite and before its join. Those are the two events that define
 * the gap, they are in the timeline the server just returned, and their relative
 * position is authoritative in a way their timestamps are not.
 *
 * IT FAILS CLOSED. If the current invite is not in the fetched page, no boundary can
 * be proven and NOTHING is routed — commands are executable, and replaying one nobody
 * just issued is worse than missing it. The previous bounded-window fallback was
 * fail-open by construction: it admitted a four-minute-old `!request` on a re-invite.
 *
 * This decides only WHICH events to deliver. Trust, sender filtering and dedup stay
 * in onRoomMessage, so a backfilled event is gated exactly like a synced one.
 */
export function pendingJoinBackfill(chunk, { botUserId = null, seen = null } = {}) {
  if (!Array.isArray(chunk) || !botUserId) return { events: [], boundary: 'no-input' };
  // /messages?dir=b is newest-first; every index below is in timeline order.
  const timeline = [...chunk].reverse();

  /*
   * The LAST invite, and the join that follows it. A room the bot was invited to,
   * left, and re-invited to carries several — anchoring on an older one is how a
   * previous membership's commands get replayed.
   */
  let inviteIdx = -1;
  let joinIdx = -1;
  for (let i = 0; i < timeline.length; i += 1) {
    const e = timeline[i];
    if (e?.type !== 'm.room.member' || e.state_key !== botUserId) continue;
    const membership = e.content?.membership;
    if (membership === 'invite') { inviteIdx = i; joinIdx = -1; }
    else if (membership === 'join' && inviteIdx >= 0 && joinIdx < 0) { joinIdx = i; }
  }
  if (inviteIdx < 0) return { events: [], boundary: 'unproven' };

  // No join in the page means we joined after everything it contains; the window is
  // the rest of the page.
  const end = joinIdx >= 0 ? joinIdx : timeline.length;
  const events = [];
  for (let i = inviteIdx + 1; i < end; i += 1) {
    const e = timeline[i];
    if (e?.type !== 'm.room.message') continue;
    if (!e.event_id) continue;
    // The bot's own messages would loop back into it.
    if (e.sender === botUserId) continue;
    if (seen && seen.has(e.event_id)) continue;
    events.push(e);
  }
  return { events, boundary: joinIdx >= 0 ? 'invite..join' : 'invite..end' };
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
    this.agentOpsEncryptedEnvelopes = new Map(); // event id -> verified original m.room.encrypted metadata
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
    this._routerOutboxPolling = false;
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
        // ADR-014 decision 6: which agents need a human to issue a Matrix token. Names only.
        unprovisionedAgents: this.unprovisionedAgentNames(),
      });
    } catch (e) {
      console.error(`Failed to write bridge health record: ${e.message}`);
    }
  }

  // Load persisted route metadata for a prior message. Authorization decisions
  // are made by the caller for the current agent/human pair; the cache never
  // stores an already-authorized room. Confirmed misses cache as null while
  // transient backend failures remain retryable.
  /**
   * Look up a message's route metadata, DISTINGUISHING "found nothing" from "could not look".
   *
   * Returns `{ ok, metadata }`. `ok: true, metadata: null` means the message genuinely carries
   * no metadata — a message written before threading existed, a legitimate compatibility miss.
   * `ok: false` means the backend lookup THREW — a transient failure, where the metadata
   * probably exists and simply could not be read right now.
   *
   * The two used to be the same `null`, and that conflation was the defect: a backend blip fed
   * `resolveGroupReplyRelation(null)` → `source_metadata_missing` → top-level fallback, silently
   * and permanently dropping the thread context of a LIVE reply, indistinguishable from a legacy
   * message that never had any. `lookupMessageRouteMetadata` below preserves the old
   * null-for-both contract for the callers that only want the value; the group-reply path uses
   * this result form so it can tell a blip from a blank.
   */
  async lookupMessageRouteMetadataResult(messageId) {
    if (typeof messageId !== 'string' || !messageId) return { ok: true, metadata: null };
    if (this._msgRouteMetadataCache.has(messageId)) {
      return { ok: true, metadata: this._msgRouteMetadataCache.get(messageId) };
    }
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
      // Transient — not cached (don't poison), and reported as a FAILURE, not as absence.
      return { ok: false, metadata: null };
    }
    if (this._msgRouteMetadataCache.size >= 200) {
      this._msgRouteMetadataCache.delete(this._msgRouteMetadataCache.keys().next().value);
    }
    this._msgRouteMetadataCache.set(messageId, metadata);
    return { ok: true, metadata };
  }

  /**
   * The value-only wrapper, unchanged in contract: null for both absence and failure.
   *
   * Kept because three callers — `lookupMessageSourceRoom`, `lookupVerifiedDirectReplyRoom`,
   * and the DM-routing path — genuinely do not care which null they got; a fail-closed DM
   * fallback is correct either way. Only the group-reply path, which can permanently lose thread
   * context, needs the distinction, and it calls the result form directly.
   */
  async lookupMessageRouteMetadata(messageId) {
    return (await this.lookupMessageRouteMetadataResult(messageId)).metadata;
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
    /*
     * A transient lookup failure is NOT a compatibility miss, and must not be sent top-level as
     * though it were: the message is about to go out and cannot be recalled, so a wrong fallback
     * here loses thread context that actually exists, forever.
     *
     * One retry, because the common transient — a backend momentarily busy — clears immediately,
     * and catching it keeps a live thread intact. It is a retry, not a loop: if the backend is
     * genuinely down the second call fails too and we fall through. No delay, so nothing to hang
     * a test on; the value is the "one call happened to lose the race" case, not waiting out an
     * outage.
     */
    let result = await this.lookupMessageRouteMetadataResult(msg.reply_to);
    if (!result.ok) result = await this.lookupMessageRouteMetadataResult(msg.reply_to);
    if (!result.ok) {
      /*
       * Still failing after the retry. ADR-007 chose fallback over blocking so one failed lookup
       * cannot wedge all later workflow — that choice stands, and this does NOT block. What it
       * does differently from a compatibility miss is SAY SO: a distinct reason and a distinct
       * warning kind, so an operator sees "the thread context could not be read" rather than "this
       * message had none", and a monitor can tell a backend problem from a legacy reply.
       *
       * Whether a transient failure should instead HOLD the reply for later delivery is a policy
       * question ADR-007 did not address — it reasoned about compatibility misses, not backend
       * outages — and is deliberately left to a future amendment rather than decided here.
       */
      console.warn(`[matrix-thread] top-level fallback on lookup FAILURE message=${msg.id} reply_to=${msg.reply_to}`);
      this.postWarning(
        `Matrix thread context could not be read for ${msg.id} (backend lookup failed); sent at `
        + 'room top level. This is a transient failure, not a legacy message — the thread link '
        + 'is lost for this reply only.',
        { kind: 'thread-lookup-failed', scope: msg.group || roomId },
      );
      return { ok: true, relation: null, threadRootEventId: null, fallback: true, reason: 'source_lookup_failed' };
    }
    const resolution = resolveGroupReplyRelation(result.metadata, { group: msg.group, roomId });
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
    /*
     * Whether the payload was WELL-FORMED is recorded separately, because
     * `normalizeAgentNameList` maps every unusable shape to `[]` — and an empty roster is the input
     * that makes the pruning loops below delete every credential. A 200 carrying `{}`, an error
     * object, or an HTML error page is therefore indistinguishable from "this fleet has no agents"
     * unless the distinction is kept here.
     */
    this._rosterWasArray = Array.isArray(payload);
    if (!this._rosterWasArray) {
      console.error(`[roster] /api/agents?view=names returned ${typeof payload}, not an array — treating the roster as untrusted`);
    }
    return normalizeAgentNameList(payload);
  }

  /**
   * May a roster observation be used to DELETE credentials?
   *
   * No, unless it is a well-formed non-empty array. The two costs are not symmetric: a stale token
   * left in state is inert — it belongs to no agent, is never looked up, and costs a few bytes —
   * whereas deleting a live agent's token is permanent, because ADR-014 decision 3 removed the
   * derivation that used to re-mint it. So pruning, which is only housekeeping, must never run on
   * evidence it cannot trust.
   *
   * Empty is refused as well as malformed. A genuinely empty fleet then keeps its orphaned entries
   * forever, which is the correct trade against one bad observation wiping a working fleet.
   */
  _mayPruneAgentTokens(agents) {
    if (this._rosterWasArray === false) return false;
    if (!Array.isArray(agents) || agents.length === 0) {
      const held = Object.keys(state.agentTokens || {}).length;
      if (held > 0) {
        console.warn(`[roster] refusing to prune ${held} Matrix token(s) against an empty agent roster — nothing can re-mint them`);
      }
      return false;
    }
    return true;
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
    if (inviterMxid !== agentMxid(canonicalAgent)) return null;
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
    return tokenName ? (state.agentTokens[tokenName]?.accessToken ?? null) : null;
  }

  /** The whole credential record, for a caller that needs the agent's homeserver and not just its token. */
  getAgentCredential(name) {
    const tokenName = this.resolveAgentTokenName(name);
    return tokenName ? (state.agentTokens[tokenName] || null) : null;
  }
  isKnownAgentName(name) { return Boolean(this.resolveKnownAgentName(name)); }

  /*
   * The live set of agents with no usable Matrix credential.
   *
   * A SET maintained as things happen, not a snapshot taken at startup. A snapshot goes stale in
   * both directions — an agent provisioned after boot stays listed, and one whose token is revoked
   * at runtime never appears — which would make the health record confidently wrong, the one
   * failure mode worse than having no record.
   */
  markAgentUnprovisioned(agentName) {
    if (!this._unprovisionedAgents) this._unprovisionedAgents = new Set();
    const name = this.normalizeName(agentName) || agentName;
    if (name) this._unprovisionedAgents.add(name);
  }

  clearAgentUnprovisioned(agentName) {
    if (!this._unprovisionedAgents) return;
    const name = this.normalizeName(agentName) || agentName;
    if (name) this._unprovisionedAgents.delete(name);
  }

  unprovisionedAgentNames() {
    return this._unprovisionedAgents ? [...this._unprovisionedAgents].sort() : [];
  }

  async ensureAgentToken(agentName, context = 'unknown') {
    const normalized = this.normalizeName(agentName);
    if (!normalized) return null;
    const canonical = this.addKnownAgent(normalized) || normalized;
    let token = this.getAgentToken(canonical);
    if (token) {
      this.clearAgentUnprovisioned(canonical);
      return token;
    }
    try {
      await ensureAgentAccount(canonical);
      this.addKnownAgent(canonical);
      token = this.getAgentToken(canonical);
      if (token) this.clearAgentUnprovisioned(canonical);
      if (!token) {
        console.warn(`Agent token still missing after ensureAgentAccount for "${canonical}" (context=${context})`);
        return null;
      }
      console.log(`Backfilled Matrix token for agent "${canonical}" (context=${context})`);
      return token;
    } catch (e) {
      /*
       * A missing credential is a STANDING condition, not a failure to retry: it ends only when a
       * human issues a token. Labelled distinctly so it reads as an action item in the log rather
       * than as one more transient Matrix error scrolling past (ADR-014 decision 6).
       */
      if (e?.needsProvisioning) {
        this.markAgentUnprovisioned(canonical);
        console.warn(`[agent-credential] NEEDS PROVISIONING — agent "${canonical}" cannot act on Matrix (context=${context}): ${e.message}`);
      } else {
        console.warn(`Failed to ensure Matrix token for agent "${canonical}" (context=${context}): ${e.message}`);
      }
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
    const botSession = await getMatrixAccessTokenSession(botToken, HOMESERVER);
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
        if (e?.needsProvisioning) {
          this.markAgentUnprovisioned(agentName);
          console.warn(`[agent-credential] NEEDS PROVISIONING — ${agentName}: ${e.message}`);
        } else {
          console.warn(`Skipping agent ${agentName} (account setup failed): ${e.message}`);
        }
      }
    }
    /*
     * One summary line, because the per-agent warnings above are individually easy to miss and the
     * thing an operator needs is the LIST — how many agents are inert and which. The same list goes
     * into the health record (see writeHealthRecord), so the log is not the only witness.
     */
    /*
     * Two agent names can mangle to ONE variable — the mangling collapses every non-alphanumeric
     * to `_`, so `octos-agent` and `octos_agent` both read MATRIX_AGENT_TOKEN_OCTOS_AGENT. Then one
     * variable would have to serve two identities, and only one of them can be right.
     *
     * Reported rather than resolved, because there is no safe automatic answer: renaming an agent
     * is a decision with consequences elsewhere. It is not silent either — the identity check in
     * ensureAgentAccount refuses a token whose /whoami MXID is not the requested agent's, so the
     * collision fails closed. This warning exists so an operator learns why, before the refusal.
     */
    const envVarOwners = new Map();
    for (const agentName of validAgentNames) {
      const varName = agentTokenEnvVarName(agentName);
      if (!varName) continue;
      if (!envVarOwners.has(varName)) envVarOwners.set(varName, []);
      envVarOwners.get(varName).push(agentName);
    }
    for (const [varName, owners] of envVarOwners) {
      if (owners.length > 1) {
        console.error(`[agent-credential] NAME COLLISION — ${owners.join(', ')} all read ${varName}; at most one of them can be provisioned from it. Rename an agent, or supply the others' tokens some other way.`);
      }
    }

    const unprovisioned = this.unprovisionedAgentNames();
    if (unprovisioned.length > 0) {
      console.warn(
        `[agent-credential] ${unprovisioned.length} agent(s) have no usable Matrix credential `
        + `and cannot send or receive: ${unprovisioned.join(', ')}. `
        + 'Set MATRIX_AGENT_TOKEN_<AGENT> for each.',
      );
    }

    // Drop stale tokens that were created for non-agent users — only on a roster we can trust.
    let cleanedTokenCount = 0;
    const mayPrune = this._mayPruneAgentTokens(agents);
    for (const name of mayPrune ? Object.keys(state.agentTokens || {}) : []) {
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
    /*
     * ADR-014: replay invitations recorded while the backend was unreachable. Placed after
     * syncApprovalBindings for the same reason that exists — bridge-owned facts have to be
     * pushed to the backend for the console to see them, and a restart is the only chance to
     * catch up on what was missed. `rememberPendingInvite` will not re-notify for an invite it
     * has already seen, so without this an invitation reported during a backend outage would
     * stay invisible until the project gave up and invited again.
     */
    await this.resyncPendingInvites();
    if (THREAD_SESSIONS_ENABLED) {
      await this.pollRouterOutboxes();
      setInterval(() => this.pollRouterOutboxes(), ROUTER_OUTBOX_POLL_MS);
    }
    setInterval(() => this.scanJoinedRooms(), MATRIX_ROOM_SCAN_POLL_MS);
    // Reaped on the room-scan cadence rather than its own timer: it walks the same
    // rooms, on a deliberately slow interval, behind the same rate-limit gate.
    setInterval(() => this.reapDeadBotDms(), MATRIX_ROOM_SCAN_POLL_MS);
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

    // 9. Acting credentials, so an approval can be delivered to a decider on a project side.
    await this.refreshActingCredentials();
    setInterval(() => this.refreshActingCredentials(), APPSERVICE_SIDE_REFRESH_MS);

    // 10. Inbound appservice traffic, if this deployment exposes a socket for it (ADR-016).
    await this.startAppserviceIntake();

    console.log('Bridge running.');
  }

  /**
   * Feed one appservice transaction into the SAME inbound path a synced event takes.
   *
   * The whole reason for routing through `onRoomMessage` / `onRoomEvent` rather than handling these
   * separately: those two carry gates that an appservice event needs just as much as a synced one —
   * `onRoomMessage`'s event-id deduplication and in-flight coalescing, `onRoomEvent`'s
   * historical-event cutoff and the room trust gate. A parallel path would be a second place for each
   * of those to be got right, and the ones it forgot would be invisible until a project side sent
   * something unusual.
   *
   * TWO INDEPENDENT DEDUPLICATION LAYERS FALL OUT OF THAT, which is worth stating because it is the
   * property that makes retries safe: the router drops a repeated `txnId`, and `onRoomMessage` drops a
   * repeated `event_id`. A transaction replayed after it has aged out of the router's window is still
   * not delivered twice.
   */
  async handleAppserviceEvents(sideId, events, meta) {
    for (const event of events) {
      const roomId = event?.room_id;
      if (!roomId) {
        console.warn(`[appservice] ${sideId}: event with no room_id in txn=${meta?.txnId} type=${event?.type}`);
        continue;
      }
      try {
        if (event.type === 'm.room.encrypted') {
          /*
           * Named rather than dropped silently. ADR-016 settled that intake rooms are PLAINTEXT, and
           * the bridge's decryption path belongs to the bot's crypto store on its own homeserver — so
           * an encrypted event arriving over an appservice cannot be read here. Left as a warning
           * because the failure it produces otherwise is a borrower whose message vanished.
           */
          /*
           * RAISED, NOT ONLY LOGGED. This warning sat in a log nobody reads while the first live run
           * succeeded only because the BOT could read the room — the appservice channel was blind and
           * nothing said so anywhere an operator looks. The dedupe scope is the ROOM: one alert per
           * blind room, not one per event, so a chatty room does not bury the fact it is trying to
           * report. It rides postWarning into the backend's alert store like every other bridge
           * condition, and the remedy is stated because there are exactly two.
           */
          this.postWarning(
            `appservice intake is BLIND to ${roomId} on ${sideId}: the room is encrypted and an `
            + 'appservice has no crypto store. Messages there are only seen if the bot is a member '
            + 'with working E2EE. Remedy: create intake rooms unencrypted (ADR-016 plaintext-intake '
            + 'rule; encryption cannot be removed from an existing room), or keep relying on the bot.',
            { kind: 'appservice-encrypted-intake', scope: roomId },
          );
          continue;
        }
        if (event.type === 'm.room.message') await this.onRoomMessage(roomId, event);
        else await this.onRoomEvent(roomId, event);
      } catch (error) {
        /*
         * Re-thrown, because the receiver turns a throw into a 500 and a 500 makes the homeserver
         * RETRY. Swallowing here would answer 200 for a transaction that was not processed, and the
         * homeserver would never send it again.
         */
        console.error(`[appservice] ${sideId}: failed on ${event.type} in ${roomId}: ${error?.message || error}`);
        throw error;
      }
    }
  }

  /**
   * The credentials that let this bridge ACT as a representative, by side.
   *
   * A second, wider grant than the inbound one and fetched from its own endpoint — see
   * `/api/project-sides/acting-credentials`. Held in memory only: it is the most powerful credential
   * this process handles for a foreign homeserver, and persisting a copy beside the ones it already
   * stores would widen the blast radius of `bridge-state.json` for no gain.
   */
  async refreshActingCredentials() {
    let payload;
    try {
      payload = await backendApi('GET', '/api/project-sides/acting-credentials', null, 'context=bridge:acting-credentials');
    } catch (error) {
      /*
       * Keep what we had, for the same reason the inbound refresh does: a backend restart must not
       * take every project side's approval delivery down with it.
       */
      console.warn(`[project-side] could not refresh acting credentials: ${error?.message || error}`);
      return;
    }
    const next = new Map();
    for (const side of Array.isArray(payload?.sides) ? payload.sides : []) {
      if (side?.sideId) next.set(side.sideId, side);
    }
    this.actingCredentials = next;
  }

  /** The acting credential for a homeserver, in the shape the representative helpers take. */
  actingSideFor(serverNameValue) {
    const row = this.actingCredentials?.get(String(serverNameValue || '').toLowerCase());
    if (!row) return null;
    return {
      side: { apiBaseUrl: row.apiBaseUrl, serverName: row.serverName },
      credential: row.kind === 'appservice'
        ? { kind: 'appservice', asToken: row.asToken, senderLocalpart: row.senderLocalpart, namespace: row.namespace }
        : { kind: 'registrationToken', representativeToken: row.representativeToken, registrationToken: null },
    };
  }

  /**
   * An approval room on the BORROWER's homeserver, created by the representative.
   *
   * ADR-016's resolved collision: the operator settled that an execution approval is the borrower's
   * decision, and a borrower on a project side cannot enter a room the bot created on ours. So the room
   * goes where the decider is.
   *
   * THE BOT PATH IS NOT REUSED, and that is not duplication for its own sake. Everything that follows
   * room creation there — `ensureApprovalDmSecurity`, `ensureApprovalDmRestricted`,
   * `getJoinedRoomMembers`, the decorative agent join — is a bot-side call against a homeserver the bot
   * has no account on. Reusing the tail would fail on every line of it.
   *
   * NO ACTING CREDENTIAL IS AN EXPLICIT REFUSAL, never a fallback to our own server. Creating it here
   * instead would produce a room the borrower cannot enter, which is precisely the defect this path
   * exists to remove — and it would look like success.
   *
   * THE ROOM IS PLAINTEXT, and that is forced rather than chosen: the representative holds no crypto
   * store, so an encrypted room would be one it cannot read. `createRoomOnSide` refuses to create one.
   * What protects the content is that the content is the BORROWER's own command against their own
   * repository, and an invite-only room controls who else in their organisation sees it.
   */
  async ensureApprovalDmRoomOnSide(canonicalAgent, ownerMxid, ownerServer, key) {
    const acting = this.actingSideFor(ownerServer);
    if (!acting) {
      return {
        ok: false, ready: false, reason: 'no_acting_credential_for_owner_server',
        detail: `the approval decider ${ownerMxid} is on ${ownerServer}, and this deployment holds no `
          + 'acting credential for that project side — configure and verify it before approvals can be delivered',
      };
    }
    let roomId = state.approvalDmRooms[key] || null;
    if (!roomId) {
      const created = await createRoomOnSide({
        ...acting,
        name: `Approval: ${canonicalAgent}`,
        topic: 'UI-only coding-agent approval requests. Text replies do not authorize execution.',
        invite: [ownerMxid],
        isDirect: true,
        encrypted: false,
      });
      if (!created.created) {
        return { ok: false, ready: false, reason: 'approval_room_creation_failed', detail: created.reason };
      }
      roomId = created.roomId;
      state.approvalDmRooms[key] = roomId;
      state.trustedManagedRooms[roomId] = {
        approvalDm: true,
        agent: canonicalAgent,
        ownerMxid,
        /*
         * A DISTINCT mode, not the deployment's. `plaintext-test` means an operator deliberately
         * disabled encryption for diagnostics and the bridge refuses it in production; this is a
         * structurally plaintext room on someone else's server. Recording them as the same thing would
         * make an audit unable to tell a diagnostic room from a project-side one.
         */
        approvalDmMode: 'project-side-plaintext',
        projectSide: ownerServer,
        addedAt: Date.now(),
      };
      saveState();
    }
    /*
     * `ready` is the invite being out, not the owner having joined. On our own server the bot can read
     * membership; here it cannot, and waiting for a join we cannot observe would block every approval
     * on a fact nothing reports.
     */
    return { ok: true, ready: true, roomId, projectSide: ownerServer };
  }

  /**
   * Fetch the inbound credentials and hand them to the router.
   *
   * `setSides` preserves the receiver of any side whose token is unchanged, so refreshing does not
   * reset a deduplication window — which matters because this runs on a timer and a refresh landing
   * between a transaction and its retry would otherwise double-deliver it.
   */
  async refreshAppserviceSides() {
    if (!this.appserviceRouter) return;
    let payload;
    try {
      payload = await backendApi('GET', '/api/project-sides/inbound-credentials', null, 'context=bridge:appservice-sides');
    } catch (error) {
      /*
       * The listener stays up with whatever it already had. Tearing sides down because the backend
       * blinked would turn a backend restart into refused deliveries on every project side, and the
       * homeserver's retries would expire while we were the ones that were broken.
       */
      console.warn(`[appservice] could not refresh project sides: ${error?.message || error}`);
      return;
    }
    const sides = Array.isArray(payload?.sides) ? payload.sides : [];
    this.appserviceRouter.setSides(sides.map((side) => ({
      sideId: side.sideId,
      hsToken: side.hsToken,
      onEvents: (events, meta) => this.handleAppserviceEvents(side.sideId, events, meta),
      onUserQuery: async (userId) => Boolean(findCaseInsensitiveKey(state.agentTokens || {}, String(userId))) || String(userId).startsWith(`@${AGENT_PREFIX}`),
    })));
    const ids = this.appserviceRouter.sideIds();
    console.log(`[appservice] serving ${ids.length} project side(s)${ids.length ? `: ${ids.join(', ')}` : ''}`);
  }

  /**
   * Bring up the inbound socket, if this deployment has decided to expose one.
   *
   * Silent-by-default is the point: with no `HAFLEET_APPSERVICE_PORT` there is no socket and no
   * warning, because a deployment using registration-token sides has no reason to expose one. The
   * reason is logged rather than hidden so `doctor`-style questions have an answer.
   */
  async startAppserviceIntake() {
    const config = resolveAppserviceListenerConfig(process.env);
    if (!config.enabled) {
      console.log(`[appservice] inbound listener disabled (${config.reason})`);
      return;
    }
    this.appserviceRouter = createAppserviceRouter();
    await this.refreshAppserviceSides();
    try {
      this.appserviceListener = await startAppserviceListener({
        receiver: this.appserviceRouter, port: config.port, host: config.host,
      });
    } catch (error) {
      /*
       * NOT fatal. The bridge's outbound work — every registration-token side, every DM, every
       * approval — does not depend on this socket, and exiting would take all of it down because one
       * port was busy. Reported loudly instead.
       */
      console.error(`[appservice] could not listen on ${config.host}:${config.port}: ${error?.message || error}`);
      this.appserviceRouter = null;
      return;
    }
    if (config.exposedBeyondLoopback) {
      console.warn(
        `[appservice] bound to ${config.host} — reachable beyond loopback. This is required for a `
        + 'homeserver on another machine and is stated here so it is a decision rather than a discovery.',
      );
    }
    setInterval(() => this.refreshAppserviceSides(), APPSERVICE_SIDE_REFRESH_MS);
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
      for (const name of this._mayPruneAgentTokens(agents) ? Object.keys(state.agentTokens || {}) : []) {
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

  routerThreadRelation(threadRootEventId) {
    return {
      rel_type: 'm.thread',
      event_id: threadRootEventId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: threadRootEventId },
    };
  }

  async deliverRouterCommand(kind, command) {
    const agentName = this.normalizeName(command?.senderAgentName);
    if (!agentName) throw new Error('router command has no valid sender agent');
    let token = this.getAgentToken(agentName);
    if (!token) token = await this.ensureAgentToken(agentName, 'router_outbox');
    if (!token) throw new Error(`Matrix puppet token unavailable for ${agentName}`);
    const root = typeof command.threadRootEventId === 'string' && command.threadRootEventId.trim()
      ? command.threadRootEventId.trim()
      : null;
    const content = { msgtype: 'm.text', body: String(command.body || '') };
    if (root) content['m.relates_to'] = this.routerThreadRelation(root);
    const eventId = await this.sendAsAgentContent(token, command.roomId, content, null, {
      transactionId: command.transactionId,
      throwOnFailure: true,
    });
    if (!eventId) throw new Error('Matrix send returned no event id');
    await this.callBackendApi(
      'POST',
      `/api/router/${kind}-outbox/${encodeURIComponent(command.commandId)}/delivered`,
      { claim_token: command.claimToken, event_id: eventId },
      `context=router-${kind}-delivery`,
    );
  }

  isPermanentRouterMatrixFailure(error) {
    const text = String(error?.message || error);
    return /M_FORBIDDEN|M_BAD_JSON|M_NOT_FOUND|HTTP 40[013456789]\b/i.test(text);
  }

  async pollOneRouterOutbox(kind) {
    const claimed = await this.callBackendApi(
      'POST',
      `/api/router/${kind}-outbox/claim`,
      { claim_ms: Math.max(30_000, ROUTER_OUTBOX_POLL_MS * 10) },
      `context=router-${kind}-claim`,
    );
    const command = claimed?.command;
    if (!command) return false;
    try {
      await this.deliverRouterCommand(kind, command);
    } catch (error) {
      if (this.isPermanentRouterMatrixFailure(error)) {
        await this.callBackendApi(
          'POST',
          `/api/router/${kind}-outbox/${encodeURIComponent(command.commandId)}/failed`,
          { claim_token: command.claimToken, error_code: 'matrix_permanent_rejection' },
          `context=router-${kind}-failure`,
        );
      } else {
        console.warn(`[router-outbox] ${kind} command ${command.commandId} remains retryable: ${error?.message || error}`);
      }
    }
    return true;
  }

  async pollRouterOutboxes() {
    if (!THREAD_SESSIONS_ENABLED || this._routerOutboxPolling) return;
    this._routerOutboxPolling = true;
    try {
      for (let delivered = 0; delivered < 20; delivered += 1) {
        const task = await this.pollOneRouterOutbox('matrix');
        const reply = await this.pollOneRouterOutbox('reply');
        if (!task && !reply) break;
      }
    } catch (error) {
      console.warn(`[router-outbox] poll failed: ${error?.message || error}`);
    } finally {
      this._routerOutboxPolling = false;
    }
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

  /**
   * Leave DM rooms whose human has gone, and forget the state that pointed at them.
   *
   * See reapableBotDms() for what counts as gone and why a pending invitation does
   * not. Failure is logged and skipped: a DM that cannot be left is a room to try
   * again next scan, not a reason to abort the sweep — and every removal is reported,
   * because the leak this fixes was invisible precisely because nothing said anything.
   */
  async reapDeadBotDms() {
    if (this._reapingBotDms) return 0;
    const dmRooms = state.botDmRooms || {};
    const roomIds = Object.values(dmRooms).filter((r) => typeof r === 'string' && r);
    if (roomIds.length === 0) return 0;
    this._reapingBotDms = true;
    try {
      const membership = {};

      /*
       * BOT PRESENCE FIRST, AND FROM ONE CALL.
       *
       * Whether the bot is in a room is a fact about the BOT, not about the human, and
       * nesting it inside "has the human left" made it unreachable: these entries'
       * humans were `invite` — invited and never accepted — so the human-left check
       * was correctly false and the bot-absent branch never ran. 50 entries, 8
       * examined, 0 classified, every pass.
       *
       * Asking `/joined_rooms` once answers it for every entry with no per-room
       * request at all, which also means a backlog of stale pointers costs one call to
       * clear rather than one per room. An earlier probe of
       * `/members?membership=leave` looked like it answered this and did not: for a
       * room the bot has left, that list contains the BOT's own leave event and
       * nothing about the human.
       */
      let joinedRooms = null;
      if (rateLimitGate.beforeRequest()) {
        try {
          joinedRooms = new Set(await this.botClient.getJoinedRooms());
        } catch (error) {
          // Unknown, not absent. Without this list nothing is classified as stale.
          rateLimitGate.observeError(error);
        }
      }

      /*
       * Bounded work per pass, and never an abort. This was
       * `if (!rateLimitGate.beforeRequest()) return 0;` — with a gate that trips
       * constantly it aborted on the FIRST room every pass and classified nothing,
       * and the return jumped over the reporting too. `break` keeps what this pass
       * managed and reports it; the backlog clears over successive passes.
       */
      const budget = Math.max(1, Number(process.env.MATRIX_DM_REAP_PER_PASS || '8'));
      let examined = 0;
      for (const roomId of roomIds) {
        // Free: no request needed, so a stale backlog is not rate-limited.
        if (joinedRooms && !joinedRooms.has(roomId)) {
          membership[roomId] = 'bot-absent';
          continue;
        }
        if (examined >= budget) break;
        if (!rateLimitGate.beforeRequest()) break;
        examined += 1;
        try {
          const members = await this.botClient.getRoomMembers(roomId, undefined, ['leave', 'ban']);
          // The bot's own leave event appears in this list; only a COUNTERPARTY
          // having gone means the DM is dead.
          const gone = (members ?? []).some((m) => {
            const who = m?.membershipFor ?? m?.stateKey ?? m?.state_key;
            return who && who !== this.botUserId;
          });
          if (!gone) continue;
          const joined = await this.botClient.getJoinedRoomMembers(roomId);
          // A DM that gained a second human is not dead because the first one left.
          const others = (joined ?? []).filter((m) => m !== this.botUserId);
          membership[roomId] = others.length === 0 ? 'leave' : null;
        } catch (error) {
          rateLimitGate.observeError(error);
        }
      }

      const dead = reapableBotDms(dmRooms, membership);
      let reaped = 0;
      for (const { humanKey, roomId, reason, action } of dead) {
        try {
          if (action === 'leave') {
            await this.botClient.leaveRoom(roomId);
            try { await this.botClient.forgetRoom(roomId); } catch { /* older homeservers */ }
          }
          delete state.botDmRooms[humanKey];
          /*
           * FORGETTING THE GREETING IS NOT PART OF CLEANING UP THE ROOM.
           *
           * Dropping `greetedHumans` alongside every reap turned a bounded leak into
           * an unbounded churn loop: the bridge forgot it had greeted the person,
           * greeted them again, created a fresh DM, and the reaper reaped that too.
           * Observed on the live host — 50 reaped, 38 immediately re-greeted, and the
           * count climbing 39 -> 45 in forty-five seconds. Strictly worse than the
           * leak it replaced, because a leak is finite and this spends rate limit
           * forever.
           *
           * `greetedHumans` means "this person has already been greeted", and that
           * stays true after the room is tidied. It is only forgotten when the person
           * has actually LEFT or been banned — then a future greeting is the right
           * thing, because they would be arriving again. A stale pointer to a room
           * the bot merely stepped out of says nothing about the person at all.
           */
          if (forgetGreetingOnReap(reason) && Array.isArray(state.greetedHumans)) {
            state.greetedHumans = state.greetedHumans.filter((h) => h !== humanKey);
          }
          reaped += 1;
          console.log(`Reaped dead bot DM for ${humanKey} (${reason}): ${roomId}`);
        } catch (error) {
          rateLimitGate.observeError(error);
          console.warn(`Could not reap bot DM ${roomId} for ${humanKey}: ${error.message}`);
        }
      }
      if (reaped > 0) saveState();
      /*
       * LOGGED UNCONDITIONALLY, including the nothing-to-do case.
       *
       * This first logged only on a reap or a failure, and that is exactly how the
       * previous round wasted a deploy: 50 stale entries, zero reaped, zero failed,
       * and no way to tell whether the sweep had run, found nothing, or never fired.
       * The join backfill had the identical blind spot and the identical cost. A
       * no-op has to be as visible as an action or it cannot be attributed.
       */
      console.log(
        `Bot DM reap: entries=${roomIds.length} examined=${examined} `
        + `classified=${Object.keys(membership).length} dead=${dead.length} reaped=${reaped}`,
      );
      return reaped;
    } finally {
      this._reapingBotDms = false;
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
      if (eventName === 'device_lists.changed') return this.onAgentOpsDeviceListsChanged(...payload);
      if (eventName === 'room.message') return this.onRoomMessage(...payload);
      if (eventName === 'room.encrypted_event') {
        this.rememberAgentOpsEncryptedEnvelope(...payload);
        return client.emit(eventName, ...payload);
      }
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

  async onAgentOpsDeviceListsChanged(changedOwnerMxids) {
    if (!agentOpsClientFeatureEnabled()) return { revoked: 0 };
    const approvalOwners = new Set(Object.values(state.trustedManagedRooms || {})
      .filter((meta) => meta?.approvalDm && typeof meta.ownerMxid === 'string')
      .map((meta) => meta.ownerMxid));
    const affected = [...new Set((Array.isArray(changedOwnerMxids) ? changedOwnerMxids : [])
      .filter((ownerMxid) => approvalOwners.has(ownerMxid)))];
    let revoked = 0;
    for (const ownerMxid of affected) {
      const result = await this.callBackendApi('POST', '/api/agent-ops/v1/control/revoke', {
        owner_mxid: ownerMxid,
        clear_device: true,
      }, `context=agent-ops:device-list-revoke owner=${ownerMxid}`);
      revoked += Number.isSafeInteger(result?.revoked_scope_count) ? result.revoked_scope_count : 0;
    }
    return { revoked };
  }

  rememberAgentOpsEncryptedEnvelope(roomId, event) {
    const eventId = typeof event?.event_id === 'string' ? event.event_id.trim() : '';
    const sender = typeof event?.sender === 'string' ? event.sender.trim() : '';
    const content = event?.content;
    if (!eventId || !sender || content?.algorithm !== 'm.megolm.v1.aes-sha2') return false;
    const deviceId = typeof content.device_id === 'string' ? content.device_id.trim() : '';
    const senderKey = typeof content.sender_key === 'string' ? content.sender_key.trim() : '';
    if (!deviceId || !senderKey) return false;
    this.agentOpsEncryptedEnvelopes.set(eventId, {
      roomId,
      sender,
      deviceId,
      senderKey,
      algorithm: content.algorithm,
      observedAt: Date.now(),
    });
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, value] of this.agentOpsEncryptedEnvelopes) {
      if (value.observedAt < cutoff) this.agentOpsEncryptedEnvelopes.delete(id);
    }
    if (this.agentOpsEncryptedEnvelopes.size > 2000) {
      const keep = [...this.agentOpsEncryptedEnvelopes.entries()].slice(-1000);
      this.agentOpsEncryptedEnvelopes = new Map(keep);
    }
    return true;
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
        // The original encrypted envelope is part of Agent Operations device
        // authentication. Rebuild its in-memory attestation before routing a
        // clear event recovered after a bridge restart or delayed room key.
        this.rememberAgentOpsEncryptedEnvelope(record.roomId, record.event);
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
    const agentOpsControl = parseAgentOpsClientControlEvent(roomId, event);
    if (agentOpsControl) {
      if (agentOpsControl.invalid || !agentOpsClientFeatureEnabled()) {
        this.rememberMatrixEvent(eventId);
        return { ignored: true, reason: agentOpsControl.invalid ? 'invalid_agent_ops_control' : 'agent_ops_client_disabled' };
      }
      return this.onAgentOpsClientControl(agentOpsControl);
    }
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
        // The request id for anything that creates a record: stable, shared with the
        // sender, and not forgeable by them. See cmdRequest.
        eventId,
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
      /*
       * Acknowledge and start appearing busy, AFTER acceptance. In a group the recipient is
       * whoever the backend will wake, which is the default recipient when nobody was named.
       */
      const groupRecipient = effectiveMentions?.[0] || matrixDefaultRecipient || null;
      if (groupRecipient) this.beginAgentWork(groupRecipient, roomId, eventId);
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
      // The DM case, where the wait is most visible: one human, one agent, and nothing in
      // between until the work lands.
      this.beginAgentWork(targetAgent, roomId, eventId);
      return result;
    }
    // else: unknown room, ignore
  }

  async onAgentOpsClientControl(control) {
    const approvalMeta = state.trustedManagedRooms?.[control.roomId];
    if (!approvalMeta?.approvalDm || approvalMeta.ownerMxid !== control.senderMxid) {
      this.rememberMatrixEvent(control.eventId);
      return { ok: false, rejected: true, reason: 'not_bound_owner_dm' };
    }
    const envelope = this.agentOpsEncryptedEnvelopes.get(control.eventId);
    if (!envelope || envelope.roomId !== control.roomId || envelope.sender !== control.senderMxid) {
      this.rememberMatrixEvent(control.eventId);
      return { ok: false, rejected: true, reason: 'encrypted_envelope_missing' };
    }
    const canonicalAgent = this.resolveKnownAgentName(control.agent || approvalMeta.agent)
      || this.normalizeName(control.agent || approvalMeta.agent);
    if (!canonicalAgent || !this.sameName(canonicalAgent, approvalMeta.agent)) {
      this.rememberMatrixEvent(control.eventId);
      return { ok: false, rejected: true, reason: 'approval_agent_mismatch' };
    }
    let projectRoomId = null;
    if (control.kind === 'request') {
      const projectBinding = findRoomAgentBinding(control.projectRoomId, canonicalAgent);
      const bindingOwner = projectBinding?.binding?.ownerMxid || projectBinding?.binding?.inviter || null;
      const approvalRoom = projectBinding?.binding?.approvalDmRoomId || null;
      if (!projectBinding || bindingOwner !== control.senderMxid || approvalRoom !== control.roomId) {
        this.rememberMatrixEvent(control.eventId);
        return { ok: false, rejected: true, reason: 'project_scope_binding_mismatch' };
      }
      projectRoomId = control.projectRoomId;
    }
    const expectedMembers = new Set([this.botUserId, control.senderMxid, agentUserId(canonicalAgent)]);
    const joinedMembers = await this.botClient.getJoinedRoomMembers(control.roomId);
    if (joinedMembers.length !== expectedMembers.size || joinedMembers.some((member) => !expectedMembers.has(member))) {
      this.rememberMatrixEvent(control.eventId);
      return { ok: false, rejected: true, reason: 'approval_room_membership_mismatch' };
    }
    const deviceResponse = await this.botClient.getUserDevices([control.senderMxid]);
    const device = deviceResponse?.device_keys?.[control.senderMxid]?.[envelope.deviceId] || null;
    const verifiedDevice = verifyMatrixDeviceSelfSignature({
      device,
      ownerMxid: control.senderMxid,
      deviceId: envelope.deviceId,
      curve25519Key: envelope.senderKey,
    });
    if (!verifiedDevice) {
      this.rememberMatrixEvent(control.eventId);
      return { ok: false, rejected: true, reason: 'matrix_device_signature_invalid' };
    }
    if (control.kind === 'revoke') {
      const result = await this.callBackendApi('POST', '/api/agent-ops/v1/control/revoke', {
        scope_id: control.scopeId,
        clear_device: false,
      }, `context=agent-ops:revoke scope=${control.scopeId}`);
      this.rememberMatrixEvent(control.eventId);
      return result;
    }
    const result = await this.callBackendApi('POST', '/api/agent-ops/v1/control/bootstrap', {
      schema: 'com.hafleet.agent_ops.v1',
      agent: canonicalAgent,
      project_room_id: projectRoomId,
      owner_mxid: control.senderMxid,
      owner_dm_room_id: control.roomId,
      matrix_event_id: control.eventId,
      matrix_device_id: verifiedDevice.deviceId,
      matrix_device_ed25519: verifiedDevice.ed25519,
      matrix_device_curve25519: verifiedDevice.curve25519,
      client_nonce: control.clientNonce,
      client_public_jwk: control.clientPublicJwk,
      was_encrypted: true,
      device_self_signature_verified: true,
      room_members_verified: true,
    }, `context=agent-ops:bootstrap agent=${canonicalAgent} room=${projectRoomId}`);
    await this.botClient.sendMessage(control.roomId, {
      msgtype: AGENT_OPS_SESSION_GRANT_MSGTYPE,
      body: `Agent Operations session grant for ${canonicalAgent}. This control event is not a chat instruction.`,
      [AGENT_OPS_EVENT_KEY]: result,
    });
    this.rememberMatrixEvent(control.eventId);
    return result;
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
      const approvalMetaForRevocation = state.trustedManagedRooms?.[roomId];
      if (agentOpsClientFeatureEnabled() && approvalMetaForRevocation?.approvalDm) {
        await this.callBackendApi('POST', '/api/agent-ops/v1/control/revoke', {
          owner_dm_room_id: roomId,
          clear_device: false,
        }, `context=agent-ops:membership-revoke room=${roomId}`);
      }

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
    /** agentName -> Set(joined room ids), filled per agent and reconciled once at the end. */
    const joinedByAgent = new Map();
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

        /*
         * RECONCILE STALE PENDING RECORDS AGAINST THIS AGENT'S OWN MEMBERSHIP.
         *
         * A pending record can outlive the invitation that made it. Once the agent joins, the room
         * leaves `rooms.invite` — so a record written while the inviter was unreadable is frozen
         * with `inviter: null`, which /projects renders as 「读不到发起人」 with Accept disabled, for
         * a room the agent is demonstrably in. Nothing in the invite path can clear it, because
         * that path only sees invitations and there is no longer one to see.
         *
         * IT LIVES HERE, and the first version did not. It was written inside pollBotInvites(),
         * which has no `agentName` in scope — so it threw ReferenceError on every cycle and took
         * the whole bot invite poll down with it: 490 occurrences of "Bot invite poll failed:
         * agentName is not defined" in one log before anyone read it. `node --check` cannot see an
         * undefined reference and the tests never invoke this method, so it shipped.
         *
         * The move also fixes a second error the first version made. The bot's `rooms.join` says
         * the BOT is in the room, which is no evidence at all about the AGENT. This sync is the
         * agent's own, so `rooms.join` here is the authority on the membership being claimed —
         * and it costs nothing, because the request already returned it.
         */
        const joinedRoomIds = Object.keys(data?.rooms?.join || {});
        for (const joinedRoomId of joinedRoomIds) {
          const record = (state.pendingInvites?.[joinedRoomId] || {})[agentName];
          if (record?.state !== 'pending') continue;
          /*
           * `accepted`, attributed to the policy rather than to a person: the agent is in the room,
           * so the invitation WAS answered — by the trusted-inviter rule, with no human at a
           * screen. Recording it as an operator decision would credit someone who never decided.
           */
          settlePendingInvite(joinedRoomId, agentName, 'accepted', 'trusted-inviter');
          console.log(`[invite] reconciled: ${agentName} is already joined to ${joinedRoomId}, settling the stale pending record`);
        }

        /*
         * B1: remember this agent's membership; the comparison happens once after the loop.
         *
         * Collected here because this sync already returned it, and reconciled afterwards rather
         * than inline. Inline was the first version and it was wrong twice: it issued one
         * `GET /api/contributions` per agent per cycle, and being fire-and-forget it interleaved
         * with the poll's own requests — nondeterministic ordering in production, and a test that
         * mocks fetch as an ordered sequence broke immediately.
         */
        joinedByAgent.set(agentName, new Set(joinedRoomIds));

        const invited = data?.rooms?.invite || {};
        for (const roomId of Object.keys(invited)) {
          // Trust check before agent join (5.8.1)
          const inviteState = invited[roomId]?.invite_state?.events || [];
          /*
           * `agentUserId()`, not a hand-composed key. This line built the state_key inline and so
           * missed the lowercasing the homeserver applies: for an agent named `BigLittle` it looked
           * for `@ac_BigLittle:…` while the invite event carried `@ac_biglittle:…`, found nothing,
           * and reported `inviter = null`. The consequence is not cosmetic — owner IS the inviter
           * (ADR-002), so a null inviter means the room is untrusted, no ownership is recorded, and
           * every later approval fails `owner_binding_missing`. Fixing agentUserId() alone did not
           * help while this copy existed, which is the argument for having one.
           */
          const expectedStateKey = agentMxid(agentName);
          const inviter = inviteState.find(e => e.type === 'm.room.member' && e.state_key === expectedStateKey)?.sender || null;
          const trust = getRoomTrust(roomId, { inviterMxid: inviter, requireTrustedInviter: true });
          roomTrustLog('agent-invite', roomId, trust, `agent=${agentName} inviter=${inviter}`);
          /*
           * AN UNTRUSTED INVITE BECOMES A PENDING DECISION, NOT A JOIN AND NOT A LOG LINE.
           *
           * ADR-014's 2026-08-11 amendment. What this replaces was wrong in both directions:
           *
           *   MATRIX_TRUST_MODE defaults to `audit`, so the old `if (!trust.trusted && MODE ===
           *   'enforce') continue` did NOT stop the join — the agent joined any room anyone
           *   invited it to, while `markRoomTrusted` and `upsertRoomAgentBinding` below were
           *   skipped. Present, messageable, and permanently unengageable: with no ownership
           *   binding every approval for that room later fails `owner_binding_missing`. A dead
           *   end that looks like presence.
           *
           *   Under `enforce` the invite was skipped silently. `untrusted_inviter` appears
           *   exactly once in this repository — the line that produces it. No record, no API, no
           *   pending state, so the contributor never learned they had been invited.
           *
           * And joining is not free: lending an agent spends the contributor's tokens, which is
           * where the Discord invite-link analogy stops applying. So the invitation is recorded
           * and the decision waits for a human — deliberate, like accepting it always should
           * have been, but no longer requiring an MXID typed into `.env` and a bridge restart.
           *
           * `rememberPendingInvite` returns false when this invite is already recorded or was
           * already declined, so a poll every few seconds does not re-notify.
           */
          /*
           * Backfill BEFORE the trust branch, because the two branches disagree about which poll
           * carries the inviter. A poll that cannot read the invite's state events records
           * `inviter: null` and lands here as untrusted; the next poll resolves the sender and, being
           * trusted, takes the join path and never touches the record. The row then sits on
           * /projects forever with 「无邀请人」 and a disabled Accept — for a room the agent has
           * already joined.
           *
           * Placed at the top so it runs whichever way the poll goes. It only ever fills a null.
           */
          backfillPendingInviteInviter(roomId, agentName, inviter);

          if (!trust.trusted) {
            if (rememberPendingInvite(roomId, agentName, inviter)) {
              console.log(
                `[invite] pending: ${agentName} invited to ${roomId} by ${inviter ?? 'unknown'}`
                + ' — awaiting the contributor\'s decision',
              );
              await this.reportPendingInvite(roomId, agentName, inviter);
            }
            continue;
          }
          // Auto-join
          const joinRes = await fetch(`${baseUrlForToken(token)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
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
            /*
             * SETTLE the record, because the invitation has just been answered — by policy rather
             * than by a human, but answered. Without this the auto-join left a `pending` row on
             * /projects for a room the agent was already in, with 「无邀请人」 and a disabled Accept,
             * and nothing could ever clear it: once joined, the invite leaves `rooms.invite`, so the
             * poll that would have filled in the inviter has nothing left to observe. The stale row
             * pointed at an invitation that no longer existed in Matrix.
             *
             * `by: 'trusted-inviter'` rather than an operator name, so the audit trail says who
             * actually decided: the trusted-inviter policy, not a person at a screen.
             */
            settlePendingInvite(roomId, agentName, 'accepted', 'trusted-inviter');
            /*
             * The same guard `acceptPendingInvite` applies, so the two ownership writers agree.
             * Reaching here already requires the inviter to be in MATRIX_TRUSTED_INVITER_MXIDS,
             * so a non-human owner needs an operator to have put an agent's MXID in that list —
             * but the consequence of that misconfiguration is severe and silent:
             * `upsertRoomAgentBinding` returns null for a non-human owner without saying so, so
             * the agent would join with NO binding and every later approval would fail
             * `owner_binding_missing`. Refusing the trust promotion says so instead.
             */
            if (trust.trusted && isAgentUser(inviter)) {
              console.warn(
                `Agent invite poll: refusing to bind ${agentName} in ${roomId} — inviter `
                + `${inviter} is an agent, not a human owner`,
              );
            } else if (trust.trusted) {
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
            if (await this.inviteBotIntoAgentRoom(roomId, token, 'Agent invite poll') === 'rate-limited') {
              return;
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

    /*
     * B1: reconcile every binding against the membership observed above — ONE pass, at the end.
     *
     * Last, and awaited, so it neither interleaves with the poll's own requests nor delays
     * answering an invitation. It reads all bindings once instead of once per agent, and it cannot
     * throw into this method: a reachability observation must not stop the bridge from working.
     */
    if (joinedByAgent.size > 0) {
      try {
        await this.reportBindingMembership(joinedByAgent);
      } catch (error) {
        console.warn(`[binding] membership reconciliation failed: ${error?.message ?? error}`);
      }
    }
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
      /*
       * Anything said between the invite and this join never arrives by sync.
       *
       * Awaited so a caller that reports `accepted` has already delivered what was
       * waiting. That is sequencing, NOT mutual exclusion — an earlier comment here
       * claimed awaiting stopped the realtime handler and pollBotInvites racing into
       * the same room, and there is no per-room lock to make that true. The guard is
       * the one below plus onRoomMessage's own event-id dedup, which make a
       * concurrent second pass a no-op rather than a double-handle.
       */
      if (this._joinBackfillInFlight?.has(roomId)) return { accepted: true, reason: trust.reason, inviter, backfilled: 0 };
      if (!this._joinBackfillInFlight) this._joinBackfillInFlight = new Set();
      this._joinBackfillInFlight.add(roomId);
      let backfilled = 0;
      try {
        backfilled = await this.backfillJoinedRoom(roomId, inviteEvent);
      } finally {
        this._joinBackfillInFlight.delete(roomId);
      }
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
    /*
     * PAGINATE UNTIL THE BOUNDARY IS FOUND, rather than give up after one page.
     *
     * Selection needs the bot's own invite to be IN the fetched events; without it
     * the window cannot be delimited and nothing is routed. A single 50-event page
     * made that outcome depend on how chatty the room had been just beforehand — a
     * busy room silently swallowed the request the backfill exists to deliver, and
     * "fails closed" turned into "usually fails".
     *
     * Bounded on both pages and events, because /messages will happily walk a room
     * back to its creation. An exhausted budget is reported as unproven, which is
     * the same fail-closed answer, not a guess.
     */
    let chunk = [];
    let from = null;
    let pages = 0;
    while (pages < MATRIX_JOIN_BACKFILL_PAGES && chunk.length < MATRIX_JOIN_BACKFILL_MAX_EVENTS) {
      if (pages > 0 && !rateLimitGate.beforeRequest()) {
        console.warn(`Join backfill: cooling down mid-pagination in ${roomId}; stopping with what was fetched`);
        break;
      }
      let data;
      try {
        data = await this.botClient.doRequest(
          'GET',
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
          { dir: 'b', limit: MATRIX_JOIN_BACKFILL_LIMIT, ...(from ? { from } : {}) },
        );
      } catch (error) {
        rateLimitGate.observeError(error);
        console.warn(`Join backfill failed for ${roomId} on page ${pages + 1}: ${error.message}`);
        break;
      }
      const page = Array.isArray(data?.chunk) ? data.chunk : [];
      chunk = chunk.concat(page);
      pages += 1;
      // The boundary is what we are paginating FOR; stop as soon as it is in hand.
      if (pendingJoinBackfill(chunk, { botUserId: this.botUserId }).boundary !== 'unproven') break;
      // No further pages, or the server stopped moving: walking again would repeat.
      if (!page.length || !data?.end || data.end === from) break;
      from = data.end;
    }
    const { events: pending, boundary } = pendingJoinBackfill(chunk, { botUserId: this.botUserId });
    let delivered = 0;
    let alreadySeen = 0;
    for (const event of pending) {
      /*
       * Count only what THIS path claimed.
       *
       * onRoomMessage returns the in-flight promise when another path is already
       * handling an event, so awaiting it and incrementing `delivered` credited the
       * backfill with sync's work. That mattered: `already-synced=0` was the evidence
       * used to claim the backfill — not sync — had delivered a pre-join message, and
       * a counter that cannot tell them apart cannot support that claim. Checking the
       * in-flight map first narrows it to events the backfill actually took on. It is
       * still not a lock, so the name says "claimed", not "delivered by us".
       */
      if (this.isDuplicateMatrixEvent(event.event_id)) { alreadySeen += 1; continue; }
      if (this.processingMatrixEventIds.has(event.event_id)) { alreadySeen += 1; continue; }
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
    if (boundary === 'unproven') {
      /*
       * The bot's current invite was not in the page, so the invite->join window
       * cannot be delimited and nothing is routed. Warned rather than logged at
       * info: a project's request really may have been dropped, and the operator
       * should be able to find out why. Raising MATRIX_JOIN_BACKFILL_LIMIT covers a
       * room whose recent history is busier than the page.
       */
      console.warn(
        `Join backfill ${roomId}: could not locate this invite within ${chunk.length} events `
        + `over ${pages} page(s); routed nothing rather than guess a boundary. `
        + 'Raise MATRIX_JOIN_BACKFILL_PAGES or MATRIX_JOIN_BACKFILL_MAX_EVENTS for a busier room.',
      );
    }
    console.log(
      `Join backfill ${roomId}: fetched=${chunk.length} eligible=${pending.length} `
      + `delivered=${delivered} already-claimed=${alreadySeen} boundary=${boundary} pages=${pages}`,
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
          this.onAgentMessage(msg).catch((err) => {
            console.error(`Failed to handle agent_message (${msg?.id}): ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE message event: ${e.message}`);
        }
      });
      /*
       * Every handler below is async and deliberately NOT awaited — the SSE reader must keep
       * consuming events rather than block on room creation or a Matrix send. The consequence is
       * that each call returns a floating promise, and a floating promise that rejects is an
       * UNHANDLED REJECTION, which modern Node treats as fatal. The enclosing try/catch cannot help:
       * it is synchronous and returns before the handler resolves. Hence a .catch on every one.
       */
      es.on('group_created', (data) => {
        try {
          const group = JSON.parse(data);
          console.log(`SSE: group created "${group.name}" with members: ${group.members.join(', ')}`);
          /*
           * .catch() because this try only guards JSON.parse — it is synchronous, and the handler
           * is not awaited, so without this an async rejection escapes as an UNHANDLED REJECTION,
           * which modern Node treats as fatal. Not awaited deliberately (the SSE reader must not
           * block on room creation), which is exactly why the rejection needs a home.
           */
          this.onGroupCreated(group).catch((err) => {
            console.error(`Failed to handle group_created "${group?.name}": ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE group_created event: ${e.message}`);
        }
      });
      /*
       * The contributor answered a project's invitation (ADR-014). Only the bridge can act on it:
       * joining a room, trusting it, and writing the ownership binding are all Matrix operations.
       * The backend recorded the decision and said "queued" rather than "joined" precisely
       * because this step is the one that makes it true.
       */
      es.on('matrix_invite_decision', (data) => {
        (async () => {
          try {
            const { projectRoomId, agent, accept } = JSON.parse(data);
            if (!projectRoomId || !agent) {
              console.warn('SSE: matrix_invite_decision missing projectRoomId or agent');
              return;
            }
            const outcome = accept
              ? await this.acceptPendingInvite(projectRoomId, agent)
              : await this.rejectPendingInvite(projectRoomId, agent);
            if (!outcome.ok) {
              /*
               * Loud, and left for the operator to see rather than retried silently. Every
               * refusal reason here is something a human has to resolve — an invitation naming
               * no human inviter, an agent with no Matrix credential, a rate limit — and a
               * background retry loop would turn "needs you" into "mysteriously quiet".
               */
              console.warn(
                `SSE: matrix_invite_decision ${accept ? 'accept' : 'decline'} failed for `
                + `${agent}@${projectRoomId}: ${outcome.reason}`,
              );
              this.postWarning(
                `Could not ${accept ? 'accept' : 'decline'} the invitation for ${agent} in `
                + `${projectRoomId}: ${outcome.reason}`,
                { kind: 'invite-decision', scope: projectRoomId },
              );
            }
          } catch (e) {
            console.warn(`Failed to handle SSE matrix_invite_decision: ${e.message}`);
          }
        })();
      });
      es.on('group_members', (data) => {
        try {
          const update = JSON.parse(data);
          console.log(`SSE: group "${update.name}" members updated — added: [${update.added}], removed: [${update.removed}]`);
          // See group_created above: not awaited, so the rejection needs an explicit home.
          this.onGroupMembersChanged(update).catch((err) => {
            console.error(`Failed to handle group_members "${update?.name}": ${err.message}`);
          });
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
          this.onAgentBlocked(event).catch((err) => {
            console.error(`Failed to handle agent_blocked (${event?.agent}): ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE agent_blocked event: ${e.message}`);
        }
      });
      es.on('agent_recovered', (data) => {
        try {
          const event = JSON.parse(data);
          this.onAgentRecovered(event).catch((err) => {
            console.error(`Failed to handle agent_recovered (${event?.agent}): ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE agent_recovered event: ${e.message}`);
        }
      });
      es.on('system_info', (data) => {
        try {
          const event = JSON.parse(data);
          this.onSystemInfo(event).catch((err) => {
            console.error(`Failed to handle system_info (${event?.agent}): ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE system_info event: ${e.message}`);
        }
      });
      es.on('agent_compact', (data) => {
        try {
          const event = JSON.parse(data);
          this.onAgentCompact(event).catch((err) => {
            console.error(`Failed to handle agent_compact (${event?.agent}): ${err.message}`);
          });
        } catch (e) {
          console.warn(`Failed to parse SSE agent_compact event: ${e.message}`);
        }
      });
      es.on('approval_requested', (data) => {
        try {
          const event = JSON.parse(data);
          this.onApprovalRequested(event).catch((err) => {
            console.error(`Failed to handle approval_requested (${event?.request_id}): ${err.message}`);
          });
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
    /*
     * THE OWNER'S SERVER DECIDES WHERE THE ROOM LIVES. Not a setting: the decider has to be able to
     * enter it, and without federation a borrower on a project side cannot enter a room on ours.
     */
    const ownerServer = ownerMxid.slice(ownerMxid.indexOf(':') + 1).toLowerCase();
    if (ownerServer !== MATRIX_SERVER_NAME) {
      return this.ensureApprovalDmRoomOnSide(canonicalAgent, ownerMxid, ownerServer, key);
    }
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
        invite: [ownerMxid, agentMxid(canonicalAgent)],
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
    const agentRoomMxid = agentMxid(canonicalAgent);
    let members = await this.botClient.getJoinedRoomMembers(roomId);
    if (!members.includes(agentRoomMxid)) {
      try { await this.botClient.inviteUser(agentRoomMxid, roomId); } catch {}
      /*
       * BEST-EFFORT, and it used to throw. This step is cosmetic by its own design — the comment
       * above says the bot remains the E2EE sender and authorization service and the agent token is
       * never used to submit a verdict — so the agent's presence is for a human's benefit, not for
       * the approval to work.
       *
       * Making it fatal breaks something real under ADR-016. An approval room is created by the BOT,
       * on the CONTRIBUTOR's homeserver (`this.botClient.createRoom`), while an agent minted for a
       * project side has an account on THAT side's server. Without federation it cannot join a room
       * on ours — so the very first approval request for a project-side agent would fail here, and
       * the failure would be attributed to approval rather than to a decorative join.
       *
       * Passing the agent's own base URL would not help: the room does not exist on the agent's
       * server. The collision is architectural (see ADR-016), and this is only the part that must
       * not take the approval down with it.
       */
      const agentToken = this.getAgentToken(canonicalAgent);
      if (agentToken) {
        try {
          const join = await fetch(`${baseUrlForToken(agentToken)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!join.ok) {
            const detail = await join.text().catch(() => '');
            console.warn(
              `[approval-room] ${canonicalAgent} could not join ${roomId} (HTTP ${join.status} `
              + `${detail.slice(0, 120)}). The approval still works — the bot is the authorization `
              + 'service and the agent token never submits a verdict. Expected when the agent lives '
              + 'on a project side and the room is on this deployment\'s server.',
            );
          }
        } catch (error) {
          console.warn(`[approval-room] ${canonicalAgent} join attempt failed for ${roomId}: ${error?.message || error}`);
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

  /**
   * Make a pending invitation visible to the operator's surfaces.
   *
   * The bridge owns the Matrix state; the console reads the backend. Same shape as
   * `PUT /api/approval-bindings` — the bridge pushes, the backend stores, the console reads —
   * because that is the established way a bridge-owned fact reaches the console here.
   *
   * Failure is logged, never thrown. The invitation is already recorded in bridge state, so a
   * backend that is down or restarting delays the notification rather than losing the decision;
   * `resyncPendingInvites` replays the list when the bridge next starts.
   */
  /**
   * Push this agent's membership in each of its bound rooms to the backend.
   *
   * Both directions matter, and only one of them is knowable here: a binding whose room the agent
   * is NOT in is a claim the console should stop making, while an agent joined to a room with no
   * binding is ordinary — DMs and the approval room are exactly that, so joined-without-binding is
   * deliberately not reported as a fault.
   *
   * Failure is logged at most once per cycle and never thrown. The observation is refreshed every
   * poll, so a backend that is down delays the figure rather than losing it.
   */
  async reportBindingMembership(joinedByAgent) {
    let bindings;
    try {
      const list = await this.callBackendApi('GET', '/api/contributions');
      bindings = list?.contributions ?? [];
    } catch {
      return 0;
    }
    // Only agents this round actually synced. A binding for an agent whose sync failed must stay
    // at its previous value rather than be reported as unreachable on no evidence.
    bindings = bindings.filter((b) => joinedByAgent.has(b.agent));
    if (!bindings.length) return 0;

    let reported = 0;
    for (const binding of bindings) {
      const agentName = binding.agent;
      const joined = joinedByAgent.get(agentName).has(binding.projectRoomId);
      // Only on a CHANGE or a first observation, so a steady state costs one GET per cycle rather
      // than a write per binding per cycle.
      if (binding.agentJoined === joined) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await this.callBackendApi('PUT', '/api/approval-bindings/membership', {
        agent: agentName,
        project_room_id: binding.projectRoomId,
        agent_joined: joined,
      }, `binding-membership ${agentName}@${binding.projectRoomId}`);
      if (result?.error) {
        console.warn(`[binding] could not report membership for ${agentName}@${binding.projectRoomId}: ${result.error}`);
        continue;
      }
      reported += 1;
      if (!joined) {
        console.warn(`[binding] ${agentName} is NOT joined to ${binding.projectRoomId}, which a binding says can reach it`);
      }
    }
    return reported;
  }

  async reportPendingInvite(roomId, agentName, inviter) {
    const record = getPendingInvite(roomId, agentName);
    if (!record) return { ok: false, reason: 'not_recorded' };
    const result = await this.callBackendApi('PUT', '/api/matrix/pending-invites', {
      project_room_id: roomId,
      agent: agentName,
      inviter: record.inviter,
      project_server: record.projectServer,
      seen_at: record.seenAt,
    }, `pending-invite ${agentName}@${roomId}`);
    if (result?.error) {
      console.warn(`[invite] could not report ${agentName}@${roomId} to the backend: ${result.error}`);
      return { ok: false, reason: 'backend_unavailable' };
    }
    return { ok: true };
  }

  /**
   * Replay every still-pending invitation to the backend on startup.
   *
   * Without this, an invitation recorded while the backend was down would stay invisible until
   * the inviting party gave up and invited again — and `rememberPendingInvite` deliberately does
   * not re-notify for an invite it has already seen, so the poll alone would never surface it.
   */
  async resyncPendingInvites() {
    const pending = listPendingInvites();
    if (!pending.length) return 0;
    let reported = 0;
    for (const record of pending) {
      const outcome = await this.reportPendingInvite(record.roomId, record.agentName, record.inviter);
      if (outcome.ok) reported += 1;
    }
    console.log(`[invite] resynced ${reported}/${pending.length} pending invitation(s) to the backend`);
    return reported;
  }

  /**
   * Invite the bridge bot into a room an agent has just joined.
   *
   * WHY THIS IS A SHARED METHOD AND NOT A COPIED BLOCK. The bot is the only syncing client —
   * agents are token-only puppets, and `pollBotInvites` only joins rooms the bot is itself
   * invited to. So without this step a project room has the agent present and its ownership
   * bound, approvals still work, and yet **project-room messages, commands and mention routing
   * are dead** until a human invites the bot by hand. Present but unusable: the exact shape of
   * dead end the pending-invite work was written to remove.
   *
   * `acceptPendingInvite` shipped without it while the auto-join path had it inline. Two writers
   * of the same sequence, one missing a step — which is the drift this audit round kept finding
   * (two ownership-binding writers, two `expected`-field lists). Extracting it means the next
   * person to add a third join path gets the step by calling one method, and a future change to
   * it lands in both places at once.
   *
   * Returns `'rate-limited'` so a caller inside a polling loop can abort its round, `'invited'`
   * on success, and `'failed'` otherwise — a failed invite is reported, never thrown: the agent
   * has already joined, and unwinding that is neither possible nor desirable.
   */
  async inviteBotIntoAgentRoom(roomId, agentToken, context = 'bot invite') {
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: this.botUserId }),
      },
    );
    if (await rateLimitGate.observeResponse(res)) {
      console.warn(`${context}: 429 inviting bot into ${roomId}; aborting this round`);
      return 'rate-limited';
    }
    if (res.ok) {
      console.log(`Invited bot into room ${roomId}`);
      return 'invited';
    }
    /*
     * M_FORBIDDEN here is usually benign and common: the bot is already in the room because
     * another of this contributor's agents is serving the same project. Logged rather than
     * escalated, and deliberately not treated as failure by the caller.
     */
    const errText = (await res.text().catch(() => '')).slice(0, 200);
    console.warn(`Bot invite request failed for ${roomId}: HTTP ${res.status} ${errText}`);
    return 'failed';
  }

  /**
   * Accept an invitation: join, trust the room, and record who owns the agent in it.
   *
   * The three are one act. ADR-002 derives ownership from the inviter, so **accepting the
   * invitation is how ownership is established** — there is no separate step and no place for a
   * human to supply an owner by hand.
   *
   * It deliberately does NOT whitelist the project. The whitelist decides who may skip approval
   * (ADR-013 decision 4), which is a stronger statement than "this agent may be in this project".
   * An earlier draft had accept do both; conflating them would have granted auto-join on the
   * strength of an invitation from someone the contributor had just met.
   */
  async acceptPendingInvite(roomId, agentName, by = 'operator') {
    const record = getPendingInvite(roomId, agentName);
    if (!record) return { ok: false, reason: 'unknown_invite' };
    if (record.state !== 'pending') return { ok: false, reason: `already_${record.state}` };
    /*
     * Refused rather than accepted with a null owner. `upsertRoomAgentBinding` would store the
     * null, and a room-agent binding with no owner is exactly the `owner_binding_missing` dead
     * end this whole change exists to remove — it would look accepted and work for nothing.
     */
    if (!record.inviter || !/^@[^:\s]+:[^\s]+$/.test(record.inviter) || isAgentUser(record.inviter)) {
      return { ok: false, reason: 'invite_names_no_human_inviter' };
    }
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    if (!canonicalAgent) return { ok: false, reason: 'unknown_agent' };
    const token = this.getAgentToken(canonicalAgent);
    if (!token) return { ok: false, reason: 'agent_has_no_matrix_credential' };

    const joinRes = await fetch(`${baseUrlForToken(token)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (await rateLimitGate.observeResponse(joinRes)) {
      // Left pending on purpose: a 429 is "not yet", not "no".
      return { ok: false, reason: 'rate_limited' };
    }
    const joined = await joinRes.json();
    if (!joined?.room_id) {
      return { ok: false, reason: `join_failed: ${joined?.error || joinRes.status}` };
    }

    markRoomTrusted(roomId, { agent: canonicalAgent, inviter: record.inviter });
    const existing = state.trustedManagedRooms[roomId] || {};
    upsertRoomAgentBinding(roomId, canonicalAgent, record.inviter, { addedAt: existing.addedAt });
    state.trustedManagedRooms[roomId] = {
      ...existing,
      // Legacy single-agent metadata, preserved exactly as the auto-join path does: per-agent
      // ownership is authoritative in roomAgentBindings and must not be overwritten by a second
      // agent joining the same project room.
      agent: existing.agent || canonicalAgent,
      inviter: existing.inviter || record.inviter,
      ownerMxid: existing.ownerMxid || record.inviter,
      addedAt: existing.addedAt || Date.now(),
    };
    settlePendingInvite(roomId, canonicalAgent, 'accepted', by);
    if (canonicalAgent !== agentName) settlePendingInvite(roomId, agentName, 'accepted', by);
    saveState();
    console.log(`[invite] accepted: ${canonicalAgent} joined ${roomId}, owner=${record.inviter}`);
    /*
     * The bot has to be in the room too, or the accept produces a project room the agent is
     * present in and nothing can read: the bot is the only syncing client, so message ingress,
     * commands and mention routing all depend on it. This step was missing when
     * acceptPendingInvite shipped — the auto-join path had it inline — which made accepting an
     * invitation a milder rerun of the "present but unengageable" dead end this whole feature
     * exists to remove.
     *
     * Its outcome does not gate the result. The agent has joined and the ownership binding is
     * written, so those are true regardless; a failed or rate-limited invite is reported and
     * returned as `botInvited` for the caller to surface rather than silently swallowed. Most
     * failures here are the benign case — the bot is already in the room because another of
     * this contributor's agents serves the same project.
     */
    const botInvited = await this.inviteBotIntoAgentRoom(roomId, token, '[invite] accept');
    await this.syncApprovalBindingForRoomAgent(roomId, canonicalAgent);
    return { ok: true, roomId, agent: canonicalAgent, ownerMxid: record.inviter, botInvited };
  }

  /**
   * Decline an invitation: leave the invite and remember the answer.
   *
   * The record is kept rather than deleted so the invite poll cannot resurrect it — without that,
   * "no" is unexpressible, because the invitation is still in Matrix state and would be seen
   * again on the next round.
   */
  async rejectPendingInvite(roomId, agentName, by = 'operator') {
    const record = getPendingInvite(roomId, agentName);
    if (!record) return { ok: false, reason: 'unknown_invite' };
    if (record.state !== 'pending') return { ok: false, reason: `already_${record.state}` };
    const canonicalAgent = this.resolveKnownAgentName(agentName) || this.normalizeName(agentName);
    const token = canonicalAgent ? this.getAgentToken(canonicalAgent) : null;
    if (token) {
      // Best-effort: declining in Matrix is courtesy. The decision is the record, so a failed
      // leave must not leave the contributor unable to say no.
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch (error) {
        console.warn(`[invite] declined ${agentName}@${roomId} but could not leave: ${error.message}`);
      }
    }
    settlePendingInvite(roomId, agentName, 'declined', by);
    console.log(`[invite] declined: ${agentName} for ${roomId}`);
    return { ok: true, roomId, agent: agentName };
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

      /*
       * THE PRIVATE REQUEST GOES WHERE ITS ROOM IS, and only the bot's own rooms are on our server.
       *
       * `botClient.sendMessage` cannot reach a room on a project side — the bot holds an account on one
       * homeserver (ADR-014 decision 4). So a room whose origin is not ours is sent by the
       * REPRESENTATIVE instead, with that side's acting credential.
       *
       * `ensureApprovalDmSecurity` is skipped on that branch rather than made to fail: it asserts the
       * room is encrypted, and a representative-created room is structurally plaintext because the
       * representative holds no crypto store. Calling it would refuse a room this deployment
       * deliberately created that way.
       */
      const dmServer = String(approval.owner_dm_room_id || '')
        .slice(String(approval.owner_dm_room_id || '').indexOf(':') + 1).toLowerCase();
      let privateEventId;
      if (dmServer && dmServer !== MATRIX_SERVER_NAME) {
        const acting = this.actingSideFor(dmServer);
        if (!acting) {
          throw new Error(
            `approval room ${approval.owner_dm_room_id} is on ${dmServer} and this deployment holds no `
            + 'acting credential for that project side',
          );
        }
        /*
         * The transaction seed is the REQUEST ID, so a retry of this publish reuses it. Matrix
         * deduplicates on the derived transaction id, and a clock-derived one would post the approval
         * request twice — to a human who then has two sets of buttons for one decision.
         */
        const sent = await sendToRoomOnSide({
          ...acting,
          roomId: approval.owner_dm_room_id,
          content: buildOwnerApprovalRequest(approval),
          txnSeed: `approval-private:${requestId}`,
        });
        if (!sent.sent) throw new Error(`private approval delivery failed: ${sent.reason}`);
        privateEventId = sent.eventId;
      } else {
        await this.ensureApprovalDmSecurity(approval.owner_dm_room_id);
        privateEventId = await this.botClient.sendMessage(
          approval.owner_dm_room_id,
          buildOwnerApprovalRequest(approval),
        );
      }
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

    /*
     * Ensure agent accounts exist for agent members. Per agent, and NON-FATAL: since ADR-014
     * decision 3 a missing credential is an expected standing state, so one unprovisioned agent
     * must not abort room creation for the rest of the group — the old derived-password path could
     * always mint one, and this loop was written when a throw here was nearly impossible.
     */
    for (const m of group.members) {
      const canonicalAgent = this.resolveKnownAgentName(m);
      if (canonicalAgent && !this.getAgentToken(canonicalAgent)) {
        try {
          await ensureAgentAccount(canonicalAgent);
        } catch (e) {
          console.warn(`[agent-credential] group "${group.name}": ${canonicalAgent} joins without a Matrix identity: ${e.message}`);
        }
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

      // Ensure agent has a Matrix account. Non-fatal for the same reason as onGroupCreated: an
      // unprovisioned agent is an expected state and must not abort the whole membership update.
      if (isAgent) {
        const ensuredName = canonicalAgent || this.normalizeName(m);
        if (ensuredName && !this.getAgentToken(ensuredName)) {
          try {
            await ensureAgentAccount(ensuredName);
            canonicalAgent = this.addKnownAgent(ensuredName) || ensuredName;
          } catch (e) {
            console.warn(`[agent-credential] group "${update.name}": ${ensuredName} has no Matrix identity: ${e.message}`);
          }
        }
      }

      let userId;
      if (isAgent) {
        const credential = this.getAgentCredential(canonicalAgent || m);
        const token = credential?.accessToken || null;
        if (token) {
          userId = await getUserId(token, credential.homeserver);
          if (currentMembers.has(userId)) continue; // already in room
          // Also auto-join with agent token
          await fetch(`${baseUrlForToken(token)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
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
      const credential = this.isKnownAgentName(m) ? this.getAgentCredential(m) : null;
      const token = credential?.accessToken || null;
      if (token) {
        userId = await getUserId(token, credential.homeserver);
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
      // The reply is the end of the wait, so the typing notification ends with it.
      this.endAgentWork(agentName, roomId);
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
            this.endAgentWork(agentName, room);
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
        this.endAgentWork(agentName, roomId);
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
      ? agentMxid(otherName)
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
            await setRoomAvatar(data.room_id, state.agentAvatars[agentName], fromToken, baseUrlForToken(fromToken));
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
        /*
         * NEVER evict a known agent. This routine exists to remove an `@ac_`-prefixed account that
         * belongs to a HUMAN, so if `humanName` resolves to a real agent the account is legitimate
         * and its presence in the room is the normal case.
         *
         * Reachable, not theoretical: `ensureHumanDmRoom` passes `forceAgentName`, which sets
         * `toIsAgent = false` WITHOUT checking whether that side is an agent, so an agent name
         * arriving as `humanName` produces a `dm:`-keyed room and lands here.
         *
         * This guard is new with the token change, and deliberately so. Under the derived password
         * the eviction was equally possible in principle but dormant in practice — deriving needed
         * MATRIX_AGENT_PASSWORD_SECRET, and with it unset `agentPasswordCandidates` returned an
         * empty list and this block bailed out. Stored tokens are not optional in the same way:
         * every live agent has one, so switching to them would have re-armed a path that can make
         * a working agent leave a room it belongs in.
         */
        if (this.isKnownAgentName(humanName)) {
          console.warn(`Refusing to remove ${staleUserId} from ${roomId}: '${humanName}' is a known agent, not a human with a stale agent account`);
          return;
        }

        /*
         * Self-leave needs a credential for the stale account, and since ADR-014 decision 3 the
         * bridge cannot derive one — so this works only if that account happens to have a stored
         * token (it was a real agent once), and otherwise reports what a human has to do.
         *
         * Deliberately NOT escalated to a kick: the surrounding comment records that the stale
         * account holds a power level equal to the bot's, so a kick would fail anyway, and raising
         * the bot's power to win that fight is a privilege change to make deliberately rather than
         * inside a cleanup routine. A leftover member in a legacy DM is cosmetic; it holds no
         * token and receives nothing, so leaving it in place costs correctness nothing.
         */
        const staleToken = getStoredAgentToken(humanName);
        if (!staleToken) {
          console.warn(
            `Cannot remove stale ${staleUserId} from room ${roomId}: no stored Matrix token for `
            + `'${humanName}', and agent passwords are no longer derivable (ADR-014). Remove that `
            + 'member with homeserver admin rights if it matters.',
          );
          return;
        }
        try {
          const leaveRes = await fetch(
            `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${staleToken}`, 'Content-Type': 'application/json' },
              body: '{}',
            }
          );
          if (leaveRes.ok) {
            console.log(`Removed stale ${staleUserId} from room ${roomId} (self-leave)`);
          } else {
            console.warn(`Could not remove stale ${staleUserId}: HTTP ${leaveRes.status}`);
          }
          /*
           * No logout. The old code opened a throwaway login and closed it; this token is the
           * agent's stored credential, and logging out would invalidate it fleet-wide — under the
           * new model nothing can re-mint it, so that single call would take a working agent
           * offline until a human re-provisioned it.
           */
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

  /*
   * LIVENESS, WITHOUT PUTTING THE AGENT'S SCREEN IN THE ROOM.
   *
   * A borrower sends a request and then sees nothing at all until the finished work arrives —
   * for the session that produced this code, 203 tool calls of silence. Delivery here is
   * message-based: the agent posts once, when it has finished a turn, by calling
   * POST /api/messages itself. Nothing observed it in between, and no typing notification,
   * read receipt or reaction was ever sent, so "working" and "never heard you" looked
   * identical. That ambiguity is what an operator actually reported.
   *
   * WHY NOT RELAY THE PANE. HAFleet can read it (GET /api/agents/:name/pane), and it is the
   * wrong thing to send. It carries ANSI, tool output and reasoning; a message per second
   * would flood the room and hit the rate limits this bridge already backs off from; and the
   * pane is the agent's whole screen, which may hold another project's content or a token in
   * argv. Streaming it into a project room is a disclosure decision, not a feature — ADR-013
   * is explicit about what may face outward.
   *
   * So: an ephemeral typing notification, and one reaction. Neither carries work product.
   */

  /** Rooms an agent is currently working for: `${agent}\u0000${roomId}` -> startedAt. */
  agentTypingKey(agentName, roomId) {
    return `${this.normalizeName(agentName)}\u0000${roomId}`;
  }

  /**
   * Tell the room the agent is working, as the AGENT rather than as the bot.
   *
   * The borrower is waiting on the agent, so the agent is who must appear busy — a bot typing
   * on its behalf would be a different claim.
   *
   * Ephemeral by design: `m.typing` is not a room event, so this adds nothing to history, costs
   * no rate-limit budget against message sends, and cannot be the thing that fills a room.
   */
  async setAgentTyping(agentName, roomId, typing) {
    if (!roomId || !agentName) return false;
    let token;
    try {
      token = await ensureAgentAccount(agentName);
    } catch {
      // No usable credential is already reported elsewhere (ADR-014 decision 6). A typing
      // notification is not the place to surface it, and must not become a second alarm.
      return false;
    }
    if (!token) return false;
    const userId = agentMxid(agentName);
    try {
      const res = await fetch(
        `${baseUrlForToken(token)}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          /*
           * A TIMEOUT, so a crash cannot leave the agent typing forever. The homeserver
           * expires the notification on its own if nothing refreshes it, which makes the
           * failure mode silence rather than a permanent false "still working".
           */
          body: JSON.stringify(typing
            ? { typing: true, timeout: AGENT_TYPING_TIMEOUT_MS }
            : { typing: false }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * React to the human's own message the moment it has been handed to the agent.
   *
   * One event, and it answers the question a blank room cannot: was this received, and by
   * whom. It is deliberately separate from typing — a delivery that failed at the backend
   * (the 503 an operator hit on a wake-queue error) must not produce an acknowledgement.
   */
  async ackAgentReceipt(agentName, roomId, eventId) {
    if (!roomId || !eventId || !agentName) return false;
    let token;
    try {
      token = await ensureAgentAccount(agentName);
    } catch {
      return false;
    }
    if (!token) return false;
    // Derived from the event id, so a retry of the same handoff cannot double-react.
    const txnId = `ack_${createHash('sha256').update(`ack:${eventId}:${agentName}`).digest('hex').slice(0, 24)}`;
    try {
      const res = await fetch(
        `${baseUrlForToken(token)}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: AGENT_ACK_REACTION },
          }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Handed off to the agent: acknowledge, and start appearing busy.
   *
   * Called only after the backend ACCEPTED the message, so neither signal can claim a
   * delivery that did not happen. Never awaited by the caller and never able to reject —
   * a failed typing notification must not fail a delivered message.
   */
  beginAgentWork(agentName, roomId, eventId) {
    if (!agentName || !roomId) return;
    const key = this.agentTypingKey(agentName, roomId);
    this.agentWork = this.agentWork || new Map();
    this.agentWork.set(key, { agentName, roomId, startedAt: Date.now() });
    this.ackAgentReceipt(agentName, roomId, eventId).catch(() => {});
    this.setAgentTyping(agentName, roomId, true).catch(() => {});
    this.ensureTypingRefresh();
  }

  /**
   * End the wait using the credential the message was sent with.
   *
   * `sendAsAgentContent` receives a token, not a name, and this is the only fact available at the
   * choke point. Resolved against the live token map rather than by clearing every entry for the
   * room, because two agents can share a room and one replying says nothing about the other.
   */
  endAgentWorkForToken(token, roomId) {
    if (!token || !roomId || !this.agentWork?.size) return;
    for (const [name, stored] of Object.entries(state.agentTokens || {})) {
      // `stored` is a credential record since ADR-014 decision 4 was built; the string branch this
      // line used to carry is gone because `loadState` now normalizes on the way in.
      const value = stored?.accessToken;
      if (value && value === token) {
        this.endAgentWork(name, roomId);
        return;
      }
    }
  }

  /** The agent spoke, so it is no longer working for this room. */
  endAgentWork(agentName, roomId) {
    if (!agentName || !roomId) return;
    const key = this.agentTypingKey(agentName, roomId);
    if (!this.agentWork?.has(key)) return;
    this.agentWork.delete(key);
    this.setAgentTyping(agentName, roomId, false).catch(() => {});
  }

  /**
   * Re-assert typing while work is outstanding, and STOP after a cap.
   *
   * `m.typing` expires, so a long turn needs refreshing. The cap is the honest part: past it
   * the notification is allowed to lapse, because an agent that has been silent for that long
   * may be stuck, and continuing to claim it is typing would be a lie the room cannot check.
   */
  ensureTypingRefresh() {
    if (this.typingRefreshTimer || !this.agentWork?.size) return;
    this.typingRefreshTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of [...(this.agentWork?.entries() ?? [])]) {
        if (now - entry.startedAt > AGENT_TYPING_MAX_MS) {
          this.agentWork.delete(key);
          this.setAgentTyping(entry.agentName, entry.roomId, false).catch(() => {});
          continue;
        }
        this.setAgentTyping(entry.agentName, entry.roomId, true).catch(() => {});
      }
      if (!this.agentWork?.size) {
        clearInterval(this.typingRefreshTimer);
        this.typingRefreshTimer = null;
      }
    }, AGENT_TYPING_REFRESH_MS);
    // Never hold the process open for a cosmetic signal.
    this.typingRefreshTimer.unref?.();
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
    const suppliedTxnId = typeof delivery?.transactionId === 'string' ? delivery.transactionId.trim() : '';
    if (suppliedTxnId && !/^[A-Za-z0-9._~-]{1,128}$/.test(suppliedTxnId)) {
      throw new Error('invalid explicit Matrix transaction id');
    }
    const txnSeed = persistPrimary
      ? `primary:${sourceMsgId}`
      : `${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    const txnId = suppliedTxnId || `bridge_${createHash('sha256').update(txnSeed).digest('hex').slice(0, 32)}`;
    const doSend = async () => {
      /*
       * The token's OWN side, not this deployment's server. `sendAsAgentContent` is the choke point for
       * every outbound agent message, so reading the constant here sent a project side's token to our
       * homeserver on every send.
       *
       * AN INCONSISTENCY I INTRODUCED, recorded because it is the shape worth noticing: this same
       * method already resolved `baseUrlForToken(token)` sixteen lines below, for the auto-join
       * invite's whoami. One call in the method used the token's side and the other used the constant.
       * Threading seven named primitives left the method that CALLS them still reading the constant
       * itself, and the audit that produced the "twelve remaining decision points" figure never counted
       * the agent-send paths at all.
       */
      const res = await fetch(`${baseUrlForToken(token)}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const matrixCode = typeof data?.errcode === 'string' ? data.errcode : null;
        const matrixDetail = typeof data?.error === 'string' ? data.error : null;
        throw new Error([matrixCode, `HTTP ${res.status}`, matrixDetail].filter(Boolean).join(': '));
      }
      if (data?.event_id) {
        this.rememberMatrixEvent(data.event_id, sourceMsgId);
      }
      /*
       * THE AGENT SPOKE HERE, so the wait ends here.
       *
       * Every outbound agent message converges on this function — text, attachments, threaded
       * replies — so this is the one place that cannot be forgotten. The first version hooked three
       * CALLERS instead, which left any path that did not go through them (an attachment-only
       * reply, anything added later) refreshing the indicator until the cap.
       */
      this.endAgentWorkForToken(token, roomId);
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
            body: JSON.stringify({ user_id: await getUserId(token, baseUrlForToken(token)) }),
          });
          await fetch(`${baseUrlForToken(token)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          eventId = await doSend();
        } catch (retryErr) {
          console.error(`Auto-join retry failed in ${roomId}:`, retryErr.message);
          this.postWarning(`sendAsAgent failed in room ${roomId} (after auto-join retry): ${retryErr.message}`);
          if (delivery?.throwOnFailure === true) throw retryErr;
          return null;
        }
      } else {
        console.error(`Failed to send as agent in ${roomId}:`, e.message);
        this.postWarning(`sendAsAgent failed in room ${roomId}: ${e.message}`);
        if (delivery?.throwOnFailure === true) throw e;
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
    const mxcUri = await uploadMedia(token, bodyBytes, mime, baseUrlForToken(token));
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
      const credential = this.isKnownAgentName(m) ? this.getAgentCredential(m) : null;
      const token = credential?.accessToken || null;
      if (token) {
        const userId = await getUserId(token, credential.homeserver);
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

/*
 * ── The token-taking Matrix primitives, exported so they can be EXECUTED ──────────────────────
 *
 * ADR-014 decision 4 classified this file's `HOMESERVER` references into three buckets, and named
 * the third as the expensive one: functions that "take whichever token their caller holds", which
 * therefore need a base URL passed in beside the token rather than reading a module constant. These
 * are those functions. Threading a base URL through them is a signature change, and this file had
 * no test that ran a single one of them — every existing bridge test asserts against its SOURCE
 * TEXT, which cannot tell a working refactor from a broken one.
 *
 * They are exported rather than moved because moving them is the larger change and this is the
 * safety net for it. `MATRIX_HOMESERVER` is read at module evaluation, so a test that sets it to a
 * fake homeserver before importing this module gets real HTTP against a server it controls — which
 * is how `tests/bridge-matrix-http-primitives.test.js` exercises them.
 *
 * Worth knowing before changing any of them: they are NOT uniformly careful. `getUserId` parses its
 * body with no status check at all, which is precisely the defect
 * `getMatrixAccessTokenSession`'s own comment warns about; `setUserAvatar` ignores its PUT's
 * response entirely. The tests pin that behaviour as it is, so a refactor is judged against what the
 * code does rather than against what it ought to do.
 */
export {
  agentMxid as agentMxidForTest,
  baseUrlForToken as baseUrlForTokenForTest,
  matrixLogin as matrixLoginForTest,
  matrixRegister as matrixRegisterForTest,
  getUserId as getUserIdForTest,
  getMatrixAccessTokenSession as getMatrixAccessTokenSessionForTest,
  uploadMedia as uploadMediaForTest,
  setUserAvatar as setUserAvatarForTest,
  setRoomAvatar as setRoomAvatarForTest,
};

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
/*
 * The pending-invite helpers, exported so a test can seed and inspect the record without a
 * homeserver. Same pattern as the line above and as `matrixRateLimitGateForTest`.
 *
 * Worth exporting rather than testing only through the backend projection: the backend store has
 * its own 15 tests, but none of them execute the BRIDGE-side writer — and the bridge is where the
 * join, the trust promotion and the ownership binding actually happen. A missing bot invite in
 * `acceptPendingInvite` was found by reading, not by a failing test, precisely because nothing
 * reached that code.
 */
export {
  rememberPendingInvite,
  listPendingInvites,
  getPendingInvite,
  settlePendingInvite,
  resetPendingInvitesForTest,
  projectServerFromRoomId,
  upsertRoomAgentBinding,
  findRoomAgentBinding,
};

/*
 * The supplied-credential path (ADR-014 decision 3). Exported because this is the seam where the
 * derived-password mechanism used to live, and the properties that replaced it are exactly the
 * kind that rot silently: that a transient homeserver failure is NOT reported as a dead token,
 * that a bad env value never displaces a working stored one, and that a missing credential REFUSES
 * instead of returning something falsy a caller might send with.
 */
export {
  ensureAgentAccount as ensureAgentAccountForTest,
  agentTokenFromEnv as agentTokenFromEnvForTest,
  agentTokenEnvVarName as agentTokenEnvVarNameForTest,
  agentUserId as agentUserIdForTest,
  isMatrixAuthFailure as isMatrixAuthFailureForTest,
  AgentCredentialMissingError,
};

/** The live `state.agentTokens`, so a test can seed a stored credential and read back adoption. */
export function agentTokenStateForTest() {
  return state.agentTokens;
}

/** Persist the live state, so a durability test can assert what reaches disk. */
export function saveStateForTest() {
  return saveState();
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
