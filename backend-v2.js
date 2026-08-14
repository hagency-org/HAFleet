import express from 'express';
import { buildReplyHint } from './lib/reply-hint.js';
import { meterFleet } from './lib/metering/reader.js';
import { meteringSupport, CEILING_KINDS } from './lib/metering/parsers.js';
import { createUsageLedger } from './lib/metering/ledger.js';
import { createPendingInviteStore, PendingInviteError } from './lib/pending-invite-store.js';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { readFile as readFileAsync } from 'fs/promises';
import { homedir, hostname } from 'os';
import { execFile, execFileSync, execSync, spawn } from 'child_process';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { BLOCK_PATTERNS as LOCAL_BLOCK_PATTERNS, BLOCK_TIER_HARD, BLOCK_TIER_SOFT, BLOCK_TIER_TRANSIENT } from './lib/blocked-patterns.js';
import { createTmuxRuntime } from './lib/runtime/tmux.js';
import { sessionPolicyFromEnv } from './lib/session-policy.js';
import { getFramework, listFrameworks } from './lib/frameworks/index.js';
import roleCapacity from './lib/role-capacity.json' with { type: 'json' };
import { buildSeats, normalizeDeclaration, seatIdentity } from './lib/seat-store.js';
import { createEngagementStore, routeRequest, EngagementError } from './lib/engagement-store.js';
import { ProjectSideStore, ProjectSideStoreError } from './lib/project-side-store.js';
import { ensureRepresentative } from './lib/matrix-representative.js';
import { generateRegistration, renderRegistrationYaml } from './lib/appservice-receiver.js';
import { createTaskGraphStore } from './lib/task-graph.js';
import { createTaskStore } from './lib/task-store.js';
import {
  indexPool, agentRole, agentCapability, selectAgent, resolveTier, TIER_RUNTIME,
  modelTier, modelFamily, ROLES, CAPABILITY_TIERS, ROLE_DEFAULT_TIER,
} from './lib/matrix-agent.js';
import { DispatchLeaseStore } from './src/dispatch-lease-store.mjs';
import { createSupervisorSnapshotStore } from './lib/supervisor-snapshot-store.js';
import { createSupervisorActionEngine } from './lib/supervisor-action-engine.js';
import { createAlertStore, RECOVERY_MAP as ALERT_RECOVERY_MAP } from './lib/alert-store.js';
import { ApprovalStore, ApprovalStoreError } from './lib/approval-store.js';
import {
  authorizeAgentCredential as authorizeAgentCredentialAdapter,
  buildAgentTokenReadiness as buildAgentTokenReadinessAdapter,
  buildServerCredentialReadiness as buildServerCredentialReadinessAdapter,
  checkAgentToken as checkAgentTokenAdapter,
  createApiAuthMiddleware,
  createRequireAgentToken,
  createRequireBearer,
  createRequireBridgeSecret,
  getBearerToken,
  getBridgeSecret,
  getRequestAgentName as getRequestAgentNameAdapter,
  hasApiTokenAccess as hasApiTokenAccessAdapter,
  loadAgentTokensFromHomes,
  resolveAgentTokenMode,
} from './lib/backend/auth-adapter.js';
import { buildFlowHealth } from './lib/backend/flow-health.js';
import { buildFleetInventory } from './lib/backend/fleet-classifier.js';
import { createSseAdapter } from './lib/backend/sse-adapter.js';
import { createJsonStorage } from './lib/backend/storage-adapter.js';
import { createSupervisorLifecycleManager, killTmuxSession as killSupervisorTmux } from './lib/supervisor-lifecycle-manager.js';
import { provisionSupervisorAgent, buildSupervisorAgentRecord } from './lib/supervisor-provisioning.js';
import { AgentStateMachine, deriveStateFromLegacy, agentExpectsMcp } from './lib/agent-state.js';
import { assertRuntimeDir, isLocalAgentServer, resolveLocalServerId } from './lib/runtime-dir-guard.js';
import { enforceStartupConfig, resolveBindHost } from './lib/startup-config.js';
import { NotificationRouter } from './lib/notification-router.js';
import {
  readV1AgentManifest,
  defaultAgentchatHomeDir,
  allAgentHomeRoots,
  findV1ManifestByName,
} from './lib/agent-home-v1.js';
import { resolveApprovalTtlMs } from './lib/runtime-approval-client.js';
import { buildProjectBoardSnapshot } from './lib/project-board.js';
import { createProjectInspector } from './lib/project-inspector.js';
import { MatrixDispatchStore } from './src/matrix-dispatch-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.HAFLEET_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
assertRuntimeDir(RUNTIME_ROOT);
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.HAFLEET_BACKEND_PORT || '8090', 10);
const PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const DEFAULT_WEB_PORT_RAW = Number.parseInt(process.env.HAFLEET_WEB_PORT || '8084', 10);
const DEFAULT_WEB_PORT = Number.isFinite(DEFAULT_WEB_PORT_RAW) && DEFAULT_WEB_PORT_RAW > 0
  ? DEFAULT_WEB_PORT_RAW
  : 8084;
const DATA_DIR = path.join(RUNTIME_ROOT, 'data');
const WEB_BASE_URL = (process.env.HAFLEET_WEB_URL || `http://127.0.0.1:${DEFAULT_WEB_PORT}`).trim().replace(/\/$/, '');
const PUSH_QUEUE_URL = (process.env.HAFLEET_QUEUE_URL || `${WEB_BASE_URL}/api/queue`).trim().replace(/\/$/, '');
const WEB_BRIDGE_DASHBOARD_TOKEN = (process.env.HAFLEET_DASHBOARD_TOKEN || '').trim();
const WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.HAFLEET_WEB_BRIDGE_FETCH_TIMEOUT_MS || '5000', 10);
const WEB_BRIDGE_FETCH_TIMEOUT_MS = Number.isFinite(WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW) && WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW > 0
  ? WEB_BRIDGE_FETCH_TIMEOUT_MS_RAW
  : 5000;
const execFileAsync = promisify(execFile);
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_SERVER_ID = resolveLocalServerId();
const RECORD_LOCAL_SERVER = normalizeBoolean(process.env.HAFLEET_RECORD_LOCAL_SERVER) === true;
const LOCAL_GIT_VERSION = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 5000 }).trim(); } catch { return null; } })();
// How this host reaches its agents. Every platform-specific operation — pane
// enumeration, output capture, keystroke delivery, session existence — goes
// through here rather than shelling out to tmux inline, which is what allows a
// non-tmux runtime to be added without touching the backend. See lib/runtime/.
const hostRuntime = createTmuxRuntime();
// Which sessions this host may manage. The relay applies the same policy when it
// enumerates sessions, but the backend enumerates panes itself in local mode and
// can still hold agent records registered before a policy was configured — so it
// has to enforce independently rather than trust the relay to have filtered.
const sessionPolicy = sessionPolicyFromEnv();
for (const warning of sessionPolicy.warnings) console.warn(`[backend] ${warning}`);

const USER_UID = (typeof process.getuid === 'function') ? process.getuid() : null;
const USER_RUNTIME_DIR = Number.isFinite(USER_UID) ? `/run/user/${USER_UID}` : null;
const USER_DBUS_SESSION_BUS = USER_RUNTIME_DIR ? `unix:path=${USER_RUNTIME_DIR}/bus` : null;
const CORS_ALLOWED_ORIGIN = (process.env.FRP_API_ORIGIN || 'https://hafleet.example.com').trim();
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.AGENT_HEARTBEAT_TTL_MS || '90000', 10);
const SERVER_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_SERVER_SWEEP_INTERVAL_MS || '15000', 10);
const HUMAN_SUMMARY_LIMIT = Number.parseInt(process.env.HUMAN_SUMMARY_LIMIT || '50', 10);
const RULE_PUSH_ACK_TIMEOUT_MS = Number.parseInt(process.env.AGENT_RULE_PUSH_ACK_TIMEOUT_MS || '90000', 10);
const RULE_REPLY_TIMEOUT_MS = Number.parseInt(process.env.AGENT_RULE_REPLY_TIMEOUT_MS || '180000', 10);
const RULE_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_RULE_SWEEP_INTERVAL_MS || '15000', 10);
const IDLE_THRESHOLD_MS = Number.parseInt(process.env.AGENT_IDLE_THRESHOLD_MS || '20000', 10);
const IDLE_THRESHOLD_SEC = Math.max(1, Math.floor((IDLE_THRESHOLD_MS + 999) / 1000));
const PROJECT_BOARD_STALE_AFTER_MS = Number.parseInt(
  process.env.AGENT_PROJECT_BOARD_STALE_AFTER_MS || '300000',
  10,
);
const MCP_HEARTBEAT_AUTHORITY_WINDOW_MS = 90_000;
const LOCAL_ACTIVITY_SWEEP_INTERVAL_MS = Number.parseInt(process.env.AGENT_LOCAL_ACTIVITY_SWEEP_MS || '5000', 10);
const LOCAL_ACTIVITY_CAPTURE_BUDGET_RAW = Number.parseInt(process.env.AGENT_LOCAL_ACTIVITY_CAPTURE_BUDGET || '0', 10);
const LOCAL_ACTIVITY_CAPTURE_BUDGET = Number.isFinite(LOCAL_ACTIVITY_CAPTURE_BUDGET_RAW)
  ? Math.max(0, LOCAL_ACTIVITY_CAPTURE_BUDGET_RAW)
  : 0;
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
const SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS = Number.parseInt(process.env.SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS || '60000', 10);
const AGENT_SCOPE_ALERT_COOLDOWN_MS = Number.parseInt(process.env.AGENT_SCOPE_ALERT_COOLDOWN_MS || '60000', 10);
const AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW = Number.parseFloat(process.env.AGENT_SCOPE_ALERT_CLEAR_RATIO || '0.85');
const AGENT_SCOPE_ALERT_CLEAR_RATIO = Number.isFinite(AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW)
  ? Math.min(0.99, Math.max(0.1, AGENT_SCOPE_ALERT_CLEAR_RATIO_RAW))
  : 0.85;
// Task 7: matrix-Agent dispatch lease TTL. Floor-validated — below this, a renew round-trip
// under real process/network latency has no realistic chance of landing before expiry, so a
// smaller configured value is almost certainly a misconfiguration and gets clamped up rather
// than honored.
const DISPATCH_LEASE_TTL_DEFAULT_MS = 15 * 60 * 1000; // 15 minutes
const DISPATCH_LEASE_TTL_FLOOR_MS = 1000; // 1 second
const DISPATCH_LEASE_TTL_MS_RAW = Number.parseInt(process.env.HAFLEET_DISPATCH_LEASE_TTL_MS || String(DISPATCH_LEASE_TTL_DEFAULT_MS), 10);
const DISPATCH_LEASE_TTL_MS = Number.isFinite(DISPATCH_LEASE_TTL_MS_RAW) && DISPATCH_LEASE_TTL_MS_RAW > 0
  ? Math.max(DISPATCH_LEASE_TTL_FLOOR_MS, DISPATCH_LEASE_TTL_MS_RAW)
  : DISPATCH_LEASE_TTL_DEFAULT_MS;
// Owner assigned to a lease when the caller doesn't supply one on POST /api/dispatch — dispatch
// itself never rejects a missing owner (only renew/release do), so a lease always exists to
// return a leaseId for.
const DISPATCH_LEASE_DEFAULT_OWNER = 'unspecified';
// POST /api/dispatch/release defaults to REJECTING the legacy {agent}-only shape (no leaseId,
// no owner): letting ownership be skipped just by omitting fields would defeat the whole point
// of "owner mismatch must fail" (a caller could always dodge the check by not claiming an
// owner). HAFLEET_ALLOW_LEGACY_RELEASE=1 is an explicit, off-by-default escape hatch for a
// caller that predates ownership (e.g. a reintroduced OpenFab Bridge — the version live at the
// time this lease system was built has since been descoped/stopped, so nothing needs it today).
const DISPATCH_ALLOW_LEGACY_RELEASE = normalizeBoolean(process.env.HAFLEET_ALLOW_LEGACY_RELEASE) === true;
const OFFLINE_CATCHUP_LIST_LIMIT = Number.parseInt(process.env.OFFLINE_CATCHUP_LIST_LIMIT || '50', 10);
const MESSAGE_ATTACHMENT_MAX_ITEMS = Number.parseInt(process.env.MESSAGE_ATTACHMENT_MAX_ITEMS || '8', 10);
const MESSAGE_ATTACHMENT_MAX_BYTES = Number.parseInt(process.env.MESSAGE_ATTACHMENT_MAX_BYTES || String(20 * 1024 * 1024), 10);
const MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT = (process.env.MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT || '30mb').trim() || '30mb';
const MESSAGE_RETENTION_LIMIT = Math.max(100, Number.parseInt(process.env.AGENT_MESSAGE_RETENTION_LIMIT || '5000', 10) || 5000);
const JSON_WRITE_BATCH_WINDOW_MS_RAW = Number.parseInt(process.env.AGENT_JSON_WRITE_BATCH_MS || '1000', 10);
const JSON_WRITE_BATCH_WINDOW_MS = Number.isFinite(JSON_WRITE_BATCH_WINDOW_MS_RAW)
  ? Math.max(0, JSON_WRITE_BATCH_WINDOW_MS_RAW)
  : 1000;
const UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS = Number.parseInt(process.env.UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS || '120000', 10);
const AGENT_TMUX_MISSING_ALERT_GRACE_MS = Number.parseInt(process.env.AGENT_TMUX_MISSING_ALERT_GRACE_MS || '15000', 10);
const AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS = Number.parseInt(process.env.AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS || '900000', 10);
const AGENT_TMUX_MISSING_THRESHOLD_RAW = Number.parseInt(process.env.AGENT_TMUX_MISSING_THRESHOLD || '3', 10);
const AGENT_TMUX_MISSING_THRESHOLD = Number.isFinite(AGENT_TMUX_MISSING_THRESHOLD_RAW)
  ? Math.max(3, AGENT_TMUX_MISSING_THRESHOLD_RAW)
  : 3;
const AGENT_COMPACT_SUMMARY_MAX = Number.parseInt(process.env.AGENT_COMPACT_SUMMARY_MAX || '180', 10);
const AGENT_COMPACT_RUNTIME_DEDUPE_MS = Number.parseInt(process.env.AGENT_COMPACT_RUNTIME_DEDUPE_MS || '120000', 10);
const BACKEND_STARTUP_OPTIONAL_ENV = [
  {
    name: 'HAFLEET_DASHBOARD_TOKEN',
    description: 'Non-local dashboard mutations will remain unavailable unless this token is configured.',
  },
  ];
const SERVER_MAINTENANCE_IDS = new Set(
  String(process.env.AGENT_SERVER_MAINTENANCE_IDS ?? '')
    .split(',')
    .map(normalizeServer)
    .filter(Boolean)
);
const SERVER_MAINTENANCE_ENV_CONFIGURED = Object.prototype.hasOwnProperty.call(
  process.env,
  'AGENT_SERVER_MAINTENANCE_IDS'
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
const AGENT_SWEEP_INTERVAL_PER_AGENT_MS_RAW = Number.parseInt(process.env.AGENT_SWEEP_INTERVAL_PER_AGENT_MS || '500', 10);
const AGENT_SWEEP_INTERVAL_PER_AGENT_MS = Number.isFinite(AGENT_SWEEP_INTERVAL_PER_AGENT_MS_RAW)
  ? Math.max(1, AGENT_SWEEP_INTERVAL_PER_AGENT_MS_RAW)
  : 500;
const BLOCKED_NOTIFICATION_COOLDOWN_MS_RAW = Number.parseInt(process.env.AGENT_BLOCKED_NOTIFICATION_COOLDOWN_MS || '60000', 10);
const BLOCKED_NOTIFICATION_COOLDOWN_MS = Number.isFinite(BLOCKED_NOTIFICATION_COOLDOWN_MS_RAW)
  ? Math.max(0, BLOCKED_NOTIFICATION_COOLDOWN_MS_RAW)
  : 60000;
const BLOCKED_INFO_AGGREGATE_WINDOW_MS_RAW = Number.parseInt(process.env.AGENT_BLOCKED_INFO_AGGREGATE_WINDOW_MS || '30000', 10);
const BLOCKED_INFO_AGGREGATE_WINDOW_MS = Number.isFinite(BLOCKED_INFO_AGGREGATE_WINDOW_MS_RAW) && BLOCKED_INFO_AGGREGATE_WINDOW_MS_RAW >= 0
  ? BLOCKED_INFO_AGGREGATE_WINDOW_MS_RAW
  : 30_000;
// agent_blocked aggregation is handled by notificationRouter (initialized after emitSystemInfo)

const AUTO_CLEAR_COOLDOWN_MS = Number.parseInt(process.env.AGENT_AUTO_CLEAR_COOLDOWN_MS || '300000', 10);
const APPROVAL_TTL_MS = resolveApprovalTtlMs(process.env);
const autoClearLastTs = new Map();
const autoClearPrevReason = new Map();

mkdirSync(DATA_DIR, { recursive: true });
const MESSAGE_ATTACHMENT_DIR = path.join(DATA_DIR, 'message-attachments');
mkdirSync(MESSAGE_ATTACHMENT_DIR, { recursive: true });
const MATRIX_MEDIA_DIR = path.join(DATA_DIR, 'matrix', 'media');
mkdirSync(MATRIX_MEDIA_DIR, { recursive: true });
const MATRIX_OPERATOR_MXIDS = new Set(
  (process.env.MATRIX_OPERATOR_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const MATRIX_ADMIN_MXIDS = new Set(
  (process.env.MATRIX_ADMIN_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Reads bridge secret fresh from env on each call (tests toggle process.env between cases).
const requireBridgeSecret = createRequireBridgeSecret({ env: process.env });
// ── Per-agent token authentication (5.8.6) ───────────────────────────
const { mode: AGENT_TOKEN_MODE, configuredMode: AGENT_TOKEN_CONFIGURED_MODE } = resolveAgentTokenMode(process.env);
const agentTokens = new Map(); // agentName → token string
function loadAgentTokens() {
  return loadAgentTokensFromHomes({
    agentTokens,
    agents,
    allAgentHomeRoots,
    mode: AGENT_TOKEN_MODE,
  });
}
function checkAgentToken(agentName, req) {
  return checkAgentTokenAdapter(agentName, req, { agentTokens });
}
function buildAgentTokenReadiness() {
  return buildAgentTokenReadinessAdapter({
    agents,
    agentTokens,
    agentTokenMode: AGENT_TOKEN_MODE,
    configuredMode: AGENT_TOKEN_CONFIGURED_MODE,
    isAgentRecord,
  });
}

function buildServerCredentialReadiness() {
  return buildServerCredentialReadinessAdapter({ env: process.env });
}
const requireAgentToken = createRequireAgentToken({ agentTokens, agentTokenMode: AGENT_TOKEN_MODE });
const VALID_ENVIRONMENTS = new Set(['live', 'dev', 'benchmark', 'ephemeral']);
function classifyEnvironment(name) {
  const n = String(name).toLowerCase();
  if (/(?:^|[-_])(?:test|tmp|scratch|smoke|e2e)(?:[-_]|$)/.test(n)) return 'ephemeral';
  if (/(?:^|[-_])(?:bench|benchmark)(?:[-_]|$)/.test(n)) return 'benchmark';
  if (/(?:^|[-_])(?:dev|debug)(?:[-_]|$)/.test(n)) return 'dev';
  return 'live';
}
const MEDIA_FETCH_ALLOWED_ROOTS = [
  path.resolve(MESSAGE_ATTACHMENT_DIR),
  path.resolve(MATRIX_MEDIA_DIR),
];

function isTimeoutAbortError(error) {
  const message = String(error?.message || '');
  return error?.name === 'TimeoutError'
    || (error?.name === 'AbortError' && /timeout/i.test(message))
    || /aborted due to timeout/i.test(message);
}

async function fetchWebBridge(url, init, contextLabel) {
  const startedAt = Date.now();
  try {
    const nextInit = init ? { ...init } : {};
    if (WEB_BRIDGE_DASHBOARD_TOKEN) {
      const headers = { ...(nextInit.headers || {}) };
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${WEB_BRIDGE_DASHBOARD_TOKEN}`;
      }
      nextInit.headers = headers;
    }
    return await fetch(url, nextInit);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const prefix = isTimeoutAbortError(error) ? '[web-bridge-timeout]' : '[web-bridge-fetch-failed]';
    console.warn(`${prefix} ${contextLabel} after ${elapsedMs}ms: ${error?.message || error}`);
    throw error;
  }
}

// ── Storage helpers ───────────────────────────────────────────────────
const jsonStorage = createJsonStorage({
  dataDir: DATA_DIR,
  jsonWriteBatchWindowMs: JSON_WRITE_BATCH_WINDOW_MS,
  batchedFiles: ['agents.json', 'agent_runtime.json'],
});
const {
  dataPath,
  agentDataPath,
  loadJsonSync,
  saveJson: storageSaveJson,
  flushAllPendingJsonWrites,
  loadJsonlTailSync,
} = jsonStorage;
const forcedJsonSaveFailures = new Map();

function saveJson(name, data, options = {}) {
  const forcedFailure = forcedJsonSaveFailures.get(name);
  if (forcedFailure) {
    if (forcedFailure && typeof forcedFailure === 'object' && !Array.isArray(forcedFailure)) {
      const after = Math.max(0, Number(forcedFailure.after) || 0);
      if (after > 0) {
        forcedJsonSaveFailures.set(name, { ...forcedFailure, after: after - 1 });
      } else {
        const count = Math.max(1, Number(forcedFailure.count) || 1);
        if (count <= 1) forcedJsonSaveFailures.delete(name);
        else forcedJsonSaveFailures.set(name, { ...forcedFailure, count: count - 1 });
        console.error(`Forced JSON save failure for ${dataPath(name)}`);
        return false;
      }
    } else {
      console.error(`Forced JSON save failure for ${dataPath(name)}`);
      return false;
    }
  }
  return storageSaveJson(name, data, options);
}

function setJsonSaveFailureForTest(name, enabled = true) {
  if (typeof name !== 'string' || !name.trim()) return;
  if (enabled === false) {
    forcedJsonSaveFailures.delete(name);
  } else if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
    forcedJsonSaveFailures.set(name, {
      after: Math.max(0, Number(enabled.after) || 0),
      count: Math.max(1, Number(enabled.count) || 1),
    });
  } else {
    forcedJsonSaveFailures.set(name, true);
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

function normalizeRuntimeActiveNow(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
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

function normalizeRuntimeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const observerSource = normalizeOptionalText(value.observerSource, 64);
  if (!observerSource) return null;
  const observerServer = normalizeServer(value.observerServer);
  const observedAt = Math.max(0, Number(value.observedAt) || 0);
  if (!observedAt) return null;
  return {
    observerSource,
    observerServer,
    observedAt,
  };
}

function buildRuntimeObservation({ observerSource, observerServer, observedAt } = {}) {
  const source = normalizeOptionalText(observerSource, 64);
  if (!source) return null;
  return {
    observerSource: source,
    observerServer: normalizeServer(observerServer),
    observedAt: Math.max(0, Number(observedAt) || Date.now()),
  };
}

function serializeRuntimeObservation(runtime) {
  return normalizeRuntimeObservation(runtime?.observation);
}

function runtimeObservationEquals(left, right) {
  const a = normalizeRuntimeObservation(left);
  const b = normalizeRuntimeObservation(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.observerSource === b.observerSource
    && (a.observerServer || null) === (b.observerServer || null)
    && a.observedAt === b.observedAt;
}

function setRuntimeObservation(runtime, details = {}) {
  if (!runtime || typeof runtime !== 'object') return false;
  const next = buildRuntimeObservation(details);
  if (!next) return false;
  const prev = normalizeRuntimeObservation(runtime.observation);
  if (runtimeObservationEquals(prev, next)) return false;
  runtime.observation = next;
  return true;
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

function normalizeBlockedTier(value, fallback = null) {
  const n = Number.parseInt(value, 10);
  if (n === BLOCK_TIER_TRANSIENT || n === BLOCK_TIER_SOFT || n === BLOCK_TIER_HARD) return n;
  return fallback;
}

function blockedTierFromReason(reason) {
  const normalizedReason = normalizeOptionalText(reason, 256);
  if (!normalizedReason) return null;
  const matched = LOCAL_BLOCK_PATTERNS.find((pattern) => pattern.reason === normalizedReason);
  return normalizeBlockedTier(matched?.tier, BLOCK_TIER_HARD);
}

function blockedTierDebounceThreshold(tier) {
  switch (normalizeBlockedTier(tier, BLOCK_TIER_HARD)) {
    case BLOCK_TIER_TRANSIENT:
      return Number.POSITIVE_INFINITY;
    case BLOCK_TIER_SOFT:
      return 6;
    default:
      return 2;
  }
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

function normalizeHumanMeta(value, options = {}) {
  const raw = (value && typeof value === 'object') ? value : {};
  const preserveLegacy = options && options.preserveLegacy === true;
  const out = {
    owner: normalizeOptionalText(raw.owner, 256),
  };
  if (preserveLegacy) {
    if (Object.prototype.hasOwnProperty.call(raw, 'notes')) {
      out.notes = normalizeOptionalText(raw.notes, 8000) || '';
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'projectScope')) {
      out.projectScope = normalizeOptionalText(raw.projectScope, 4000) || '';
    }
  }
  return out;
}

function mergeHumanMeta(existingValue, nextValue) {
  const existing = normalizeHumanMeta(existingValue, { preserveLegacy: true });
  if (nextValue === undefined) return existing;
  const raw = (nextValue && typeof nextValue === 'object') ? nextValue : {};
  const out = {
    ...existing,
    owner: Object.prototype.hasOwnProperty.call(raw, 'owner')
      ? normalizeOptionalText(raw.owner, 256)
      : existing.owner,
  };
  return out;
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

const SHELL_METACHAR_RE = /[;&|`$(){}!\\<>]/;

function normalizeRuntimeProfileRole(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const framework = normalizeOptionalText(value.framework, 32);
  const provider = normalizeOptionalText(value.provider, 64);
  const rawModel = normalizeOptionalText(value.model, 256);
  const model = rawModel && SHELL_METACHAR_RE.test(rawModel) ? null : rawModel;
  const reasoning = normalizeOptionalText(value.reasoning, 64);
  const rawExtraArgs = normalizeOptionalText(value.extraArgs, 4000);
  const extraArgs = rawExtraArgs && SHELL_METACHAR_RE.test(rawExtraArgs) ? null : rawExtraArgs;
  const rawApiBaseUrl = normalizeOptionalText(value.apiBaseUrl, 512);
  let apiBaseUrl = null;
  if (rawApiBaseUrl) {
    try {
      const parsed = new URL(rawApiBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http(s)');
      if (parsed.username || parsed.password) throw new Error('credentials in URL');
      apiBaseUrl = rawApiBaseUrl;
    } catch { apiBaseUrl = null; }
  }
  const apiKey = normalizeOptionalText(value.apiKey, 256);
  if (!framework && !provider && !model && !reasoning && !extraArgs && !apiBaseUrl && !apiKey) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
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

function mergeRuntimeProfileApiKeys(newProfile, existingProfile) {
  if (!newProfile) return newProfile;
  for (const role of ['primary', 'supervisor']) {
    if (newProfile[role] && !newProfile[role].apiKey && existingProfile && existingProfile[role] && existingProfile[role].apiKey) {
      newProfile[role] = { ...newProfile[role], apiKey: existingProfile[role].apiKey };
    }
  }
  return newProfile;
}

function redactRuntimeProfileSecrets(profile) {
  if (!profile) return profile;
  const redacted = { ...profile };
  for (const role of ['primary', 'supervisor']) {
    if (redacted[role] && redacted[role].apiKey) {
      redacted[role] = { ...redacted[role], apiKey: true };
    }
  }
  return redacted;
}

function normalizeLooseAgentName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return normalizeAgentName(trimmed);
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
    viewToken: msg.viewToken || null,
  };
}

function normalizeCompactMarker(value) {
  const marker = (typeof value === 'string' && value.trim()) ? value.trim().toLowerCase() : '';
  if (!marker) return 'unknown';
  if (marker === 'explicit-hook') return marker;
  if (AGENT_COMPACT_FALLBACK_PATTERNS.some(p => p.marker === marker)) return marker;
  return 'unknown';
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

  const event = buildRuntimeCompactEvent(agentName, { ...payload, mode, marker });
  const result = notificationRouter.emit('agent_compact', {
    agentName, marker, mode, sseEvent: 'agent_compact', sseData: event,
  });
  if (!result.accepted) {
    return { ok: true, suppressed: 'dedupe', agent: agentName, marker, mode };
  }
  return { ok: true, event };
}





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
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    try { unlinkSync(tmpPath); } catch {}
    console.warn(`Failed to write JSON ${filePath}: ${error?.message || error}`);
    return false;
  }
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

function hasApiTokenAccess(req) {
  return hasApiTokenAccessAdapter(req, { env: process.env });
}

function getRequestAgentName(req) {
  return getRequestAgentNameAdapter(req, { normalizeAgentName });
}

function authorizeAgentCredential(req, agentName) {
  return authorizeAgentCredentialAdapter(req, agentName, {
    agentTokens,
    normalizeAgentName,
    env: process.env,
  });
}



const requireBearer = createRequireBearer({ env: process.env });

function redactPathLikeText(value, maxLen = 1200) {
  const text = normalizeOptionalText(value, maxLen);
  if (!text) return null;
  return text.replace(/(^|[\s(])((?:\/[^/\s)]+)+\/?[^)\s]*)/g, '$1[path removed]');
}

function cloneJsonValue(value) {
  if (value === null || value === undefined) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeDeliveryEvent(raw = {}) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  const now = Date.now();
  const type = normalizeOptionalText(input.type, 128);
  if (!type) return { error: 'type required' };
  const notifyMeta = (input.notifyMeta && typeof input.notifyMeta === 'object' && !Array.isArray(input.notifyMeta))
    ? cloneJsonValue(input.notifyMeta)
    : null;
  const messageId = normalizeOptionalText(
    input.messageId ?? input.message_id ?? input.sourceMsgId ?? notifyMeta?.sourceMsgId,
    255
  );
  const agent = normalizeAgentName(input.agent) || normalizeOptionalText(input.agent, 255);
  const target = normalizeOptionalText(input.target, 255);
  const queueEntryIdRaw = Number(input.queueEntryId ?? input.queue_entry_id);
  const queueEntryId = Number.isFinite(queueEntryIdRaw) && queueEntryIdRaw > 0 ? queueEntryIdRaw : null;
  const queuedAtRaw = Number(input.queuedAt ?? input.queued_at);
  const queuedAt = Number.isFinite(queuedAtRaw) && queuedAtRaw > 0 ? queuedAtRaw : null;
  const tsRaw = Number(input.ts);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now;
  const attemptId = normalizeOptionalText(input.attemptId ?? input.attempt_id, 512)
    || [messageId || 'unknown-message', agent || target || 'unknown-target', queueEntryId || queuedAt || ts].join(':');
  const rawMessageIds = Array.isArray(input.messageIds)
    ? input.messageIds
    : (Array.isArray(notifyMeta?.messageIds) ? notifyMeta.messageIds : []);
  const messageIds = rawMessageIds.map((id) => normalizeOptionalText(id, 255)).filter(Boolean);
  const targetAgents = Array.isArray(input.targetAgents)
    ? input.targetAgents.map((name) => normalizeAgentName(name) || normalizeOptionalText(name, 255)).filter(Boolean)
    : [];
  const row = {
    id: `devt_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    ts,
    type,
    source: normalizeOptionalText(input.source, 128) || 'backend',
  };
  if (messageId) row.messageId = messageId;
  if (messageIds.length) row.messageIds = messageIds;
  if (agent) row.agent = agent;
  if (targetAgents.length) row.targetAgents = targetAgents;
  if (target) row.target = target;
  if (queueEntryId !== null) row.queueEntryId = queueEntryId;
  if (queuedAt !== null) row.queuedAt = queuedAt;
  const deliveredAtRaw = Number(input.deliveredAt ?? input.delivered_at);
  if (Number.isFinite(deliveredAtRaw) && deliveredAtRaw > 0) row.deliveredAt = deliveredAtRaw;
  const ackedAtRaw = Number(input.ackedAt ?? input.acked_at);
  if (Number.isFinite(ackedAtRaw) && ackedAtRaw > 0) row.ackedAt = ackedAtRaw;
  row.attemptId = attemptId;
  const priority = normalizeMessagePriority(input.priority, null);
  if (priority) row.priority = priority;
  const reason = normalizeOptionalText(input.reason, 512);
  if (reason) row.reason = reason;
  const result = normalizeOptionalText(input.result, 128);
  if (result) row.result = result;
  const pathLabel = normalizeOptionalText(input.path, 128);
  if (pathLabel) row.path = pathLabel;
  const stage = normalizeOptionalText(input.stage, 128);
  if (stage) row.stage = stage;
  const statusRaw = Number(input.status);
  if (Number.isFinite(statusRaw) && statusRaw > 0) row.status = statusRaw;
  if (notifyMeta) row.notifyMeta = notifyMeta;
  if (input.cursor && typeof input.cursor === 'object' && !Array.isArray(input.cursor)) {
    row.cursor = cloneJsonValue(input.cursor);
  }
  if (input.context && typeof input.context === 'object' && !Array.isArray(input.context)) {
    row.context = cloneJsonValue(input.context);
  }
  return { row };
}

function appendDeliveryEvent(raw = {}) {
  const normalized = normalizeDeliveryEvent(raw);
  if (normalized.error) return { ok: false, error: normalized.error };
  const row = normalized.row;
  let fd = null;
  try {
    const created = !existsSync(DELIVERY_EVENT_LOG);
    fd = openSync(DELIVERY_EVENT_LOG, 'a', 0o600);
    chmodSync(DELIVERY_EVENT_LOG, 0o600);
    appendFileSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
    if (created) fsyncParentDirectory(DELIVERY_EVENT_LOG);
    if (row.attemptId) deliveryEventAttemptIds.add(row.attemptId);
    return { ok: true, event: row };
  } catch (error) {
    console.warn(`Failed to append delivery event: ${error?.message || error}`);
    return { ok: false, error: error?.message || 'append failed' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const DELIVERY_EVENT_READ_CHUNK_BYTES = 64 * 1024;

function deliveryEventMatches(row, { normalizedMessageId, normalizedAgent }) {
  if (normalizedMessageId) {
    const ids = new Set();
    if (typeof row.messageId === 'string') ids.add(row.messageId);
    if (Array.isArray(row.messageIds)) {
      for (const id of row.messageIds) {
        if (typeof id === 'string') ids.add(id);
      }
    }
    if (!ids.has(normalizedMessageId)) return false;
  }
  if (normalizedAgent) {
    const agentsForRow = new Set();
    if (typeof row.agent === 'string') agentsForRow.add(row.agent);
    if (Array.isArray(row.targetAgents)) {
      for (const name of row.targetAgents) {
        if (typeof name === 'string') agentsForRow.add(name);
      }
    }
    if (!agentsForRow.has(normalizedAgent)) return false;
  }
  return true;
}

function parseDeliveryEventLine(line, filters) {
  if (!line.trim()) return null;
  try {
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object') return null;
    return deliveryEventMatches(row, filters) ? row : null;
  } catch {
    return null;
  }
}

function readDeliveryEvents({ messageId = null, agent = null, limit = 100 } = {}) {
  if (!existsSync(DELIVERY_EVENT_LOG)) return [];
  const normalizedMessageId = normalizeOptionalText(messageId, 255);
  const normalizedAgent = normalizeAgentName(agent) || normalizeOptionalText(agent, 255);
  const boundedLimit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100));
  const filters = { normalizedMessageId, normalizedAgent };
  const matches = [];
  let fd = null;
  try {
    fd = openSync(DELIVERY_EVENT_LOG, 'r');
    const { size } = statSync(DELIVERY_EVENT_LOG);
    let offset = size;
    let carry = Buffer.alloc(0);
    while (offset > 0 && matches.length < boundedLimit) {
      const bytesToRead = Math.min(DELIVERY_EVENT_READ_CHUNK_BYTES, offset);
      offset -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      const chunk = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      const lineBuffers = [];
      let lineStart = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        lineBuffers.push(chunk.subarray(lineStart, i));
        lineStart = i + 1;
      }
      carry = chunk.subarray(lineStart);
      for (let i = lineBuffers.length - 1; i >= 0 && matches.length < boundedLimit; i -= 1) {
        const row = parseDeliveryEventLine(lineBuffers[i].toString('utf-8'), filters);
        if (row) matches.push(row);
      }
    }
    if (matches.length < boundedLimit && carry.length > 0) {
      const row = parseDeliveryEventLine(carry.toString('utf-8'), filters);
      if (row) matches.push(row);
    }
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
  return matches.reverse();
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


// ── In-memory state ───────────────────────────────────────────────────
const sseAdapter = createSseAdapter();
const broadcastSSE = sseAdapter.broadcast;
const agents = loadJsonSync('agents.json', {});
// Migrate agents missing environment field
{ let migrated = 0;
  for (const a of Object.values(agents)) {
    if (a && typeof a === 'object' && !a.environment) { a.environment = classifyEnvironment(a.name); migrated++; }
  }
  if (migrated > 0) { saveJson('agents.json', agents, { immediate: true }); console.log(`[startup] migrated environment for ${migrated} agent(s)`); }
}
loadAgentTokens();
const deletedAgentTombstones = loadJsonSync('deleted_agents.json', {});
const groups = loadJsonSync('groups.json', {});
const workflowBindings = loadJsonSync('workflow_bindings.json', {});
const messages = loadJsonSync('messages.json', []);
let unreadMessageIndexVersion = 0;
const unreadMessageIndex = {
  version: -1,
  directByAgent: new Map(),
  groupByName: new Map(),
  groupMentionsByAgent: new Map(),
};
const cursors = loadJsonSync('cursors.json', {});
const servers = loadJsonSync('servers.json', {});
const agentRuntime = loadJsonSync('agent_runtime.json', {});
const taskGraphs = loadJsonSync('task_graphs.json', {});
const frameworkPresets = loadJsonSync('framework-presets.json', []);
function saveFrameworkPresets() { return saveJson('framework-presets.json', frameworkPresets); }

/*
 * Operator declarations about seats, keyed by derived seat id.
 *
 * Only the QUOTA is stored. Which agents share a seat is derived from how they
 * were launched (lib/seat-store.js), so persisting that would be persisting a
 * cache of a fact. What cannot be derived is how many tokens a subscription
 * includes — no provider exposes it and nothing here meters — so that is a
 * declaration, recorded as one.
 */
const seatDeclarations = loadJsonSync('seats.json', {});
function saveSeatDeclarations() { return saveJson('seats.json', seatDeclarations); }

/*
 * Engagements, offers and the whitelist, in one store because they are one
 * decision: whether a project may draw on this contributor's capacity, and for how
 * much. Splitting them would put the routing rule — which reads all three — outside
 * whatever holds the data.
 */
const engagementStore = createEngagementStore({
  load: () => loadJsonSync('engagements.json', {}),
  persist: (state) => saveJson('engagements.json', state),
});

/*
 * Measured consumption, persisted, because the transcripts it is read from are not ours.
 *
 * The coding CLIs rotate, prune and delete their own session files. Computing usage on
 * demand means a figure that silently drops when one goes away, while the ceiling was
 * still spent by that work. The ledger keeps a high-water mark per session, so the total
 * survives a source disappearing and is idempotent under re-reading — see
 * lib/metering/ledger.js for why an appended snapshot would have double-counted.
 */
const usageLedger = createUsageLedger({
  load: () => loadJsonSync('usage-ledger.json', {}),
  persist: (state) => saveJson('usage-ledger.json', state),
});

/*
 * Invitations a project has extended that the contributor has not answered (ADR-014).
 *
 * The bridge owns the Matrix state and pushes here; this is the copy the console reads. Same
 * shape as approval-bindings, for the same reason: the console talks to the backend, and a
 * bridge-owned fact has to cross that line somewhere.
 */
const pendingInviteStore = createPendingInviteStore({
  load: () => loadJsonSync('pending-invites.json', {}),
  persist: (state) => saveJson('pending-invites.json', state),
});

/*
 * Deployment-local key material for the seat digest, and its key id for rotation.
 *
 * Absent by default, and the digest says so in its own key id rather than
 * pretending to be keyed. An unkeyed hash over (server, framework, authMode) is
 * trivially reversible — the input set is tiny — so an unkeyed value must never be
 * mistaken for one that protects anything.
 */
const SEAT_KEY_SECRET = String(process.env.HAFLEET_SEAT_KEY || '').trim();
const SEAT_KEY_ID = String(process.env.HAFLEET_SEAT_KEY_ID || 'default').trim() || 'default';

/** Ceiling on a preset: the field the contributor is actually deciding. */
function normalizeCeiling(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const tokens = n(value.tokens);
  if (tokens === null) return null;
  const period = ['daily', 'monthly'].includes(value.period) ? value.period : 'monthly';
  return {
    tokens,
    period,
    // Null and 0 are different: "no rate cap set" versus "nothing per day".
    rateCapPerDay: n(value.rateCapPerDay),
    /*
     * Always false, and stored rather than assumed by the reader. Nothing meters
     * tokens at any granularity, so this ceiling is a declaration of intent. A
     * client that treats it as a guard rail will over-promise and learn about it
     * from an exhausted plan. When metering lands, this flips at the store rather
     * than in every caller.
     */
    enforced: false,
  };
}
const taskStoreData = loadJsonSync('tasks.json', []);
const taskStore = createTaskStore({
  initialData: taskStoreData,
  save: (data) => saveJson('tasks.json', data),
});
const projectInspector = createProjectInspector();
const supervisorSnapshotData = loadJsonSync('supervisor_snapshots.json', {});
const supervisorSnapshotStore = createSupervisorSnapshotStore({
  initialData: supervisorSnapshotData,
  save: (data) => saveJson('supervisor_snapshots.json', data),
});
const alertStoreData = loadJsonSync('alerts.json', []);
const alertStore = createAlertStore({
  initialData: alertStoreData,
  save: (data) => saveJson('alerts.json', data),
  emitEvent: (eventName, alert) => broadcastSSE(eventName, alert),
});
const approvalStore = new ApprovalStore(path.join(DATA_DIR, 'approvals.json'), {
  ttlMs: APPROVAL_TTL_MS,
});
/*
 * 项目方 — the project sides HAFleet is registered with (ADR-016 decision 1).
 *
 * Separate from `approvals.json` rather than a section inside it, because this file holds
 * CREDENTIALS: an `as_token` granting a whole namespace on a homeserver we do not administer.
 * A distinct file keeps that surface small enough to reason about, and the store writes it 0600.
 */
const projectSideStore = new ProjectSideStore(path.join(DATA_DIR, 'project-sides.json'));
/*
 * The namespace an appservice registration claims by default. Formalises the existing
 * MATRIX_AGENT_PREFIX rather than changing it (ADR-014 decision 2) — the bridge already names agent
 * accounts `ac_<name>`, so `@ac_.*` describes today's fleet instead of requiring a rename.
 */
const MATRIX_AGENT_PREFIX_FOR_REGISTRATION = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim();
const localActivitySweepState = loadJsonSync('local_activity_sweep.json', { selectionCursor: 0 });
let msgCounter = loadJsonSync('.msg_counter', 0);
const localActivityState = new Map(); // agent -> { lastHash, lastChangeSec, burstStartSec, burstLastSec }
const localTmuxMissingState = new Map(); // agent -> { since:number, alerted:boolean, misses:number, wasOnline:boolean }
const localCompactState = new Map(); // agent -> marker
const localRuntimeSignalDigest = new Map(); // agent -> digest of blocked/mcp/workspace
let localActivitySweepRunning = false;
let localSwapSweepRunning = false;
let agentScopeSweepRunning = false;
let supervisorLifecycleSweepRunning = false;
/*
 * Declared even though the project-side sweep runs once at startup, because `runAsyncSweep`'s
 * reentrancy guard is a hardcoded ladder of `stateKey` comparisons: an unrecognised key gets NO
 * guard, silently. A one-shot call does not need one, but the next person to put this sweep on a
 * timer would inherit overlapping runs against foreign homeservers and nothing would say why.
 */
let projectSideSweepRunning = false;
let localTmuxSnapshotWarnAt = 0;
const SYSTEM_INFO_LOG = dataPath('system-info.jsonl');
const AUDIT_LOG = dataPath('audit.jsonl');
const MESSAGE_ARCHIVE_LOG = dataPath('messages-archive.jsonl');
const DELIVERY_EVENT_LOG = dataPath('message-delivery-events.jsonl');
repairJsonlTornTail(DELIVERY_EVENT_LOG);
repairJsonlTornTail(MESSAGE_ARCHIVE_LOG);
const deliveryEventAttemptIds = new Set();
if (existsSync(DELIVERY_EVENT_LOG)) {
  for (const line of readFileSync(DELIVERY_EVENT_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const attemptId = JSON.parse(line)?.attemptId;
      if (attemptId) deliveryEventAttemptIds.add(attemptId);
    } catch {}
  }
}
const matrixDispatchStore = new MatrixDispatchStore({
  journalPath: dataPath('matrix/source-events.jsonl'),
});
let matrixDispatchFailureStageForTest = null;
const pendingHumanTargetCache = new Map(); // agent -> { hasPendingHuman, targets }
const swapAlertState = {
  active: false,
  lastPct: 0,
  lastAlertAt: 0,
};
// scopePressureState tracks the high/low state for resource alerts (state-based, not just cooldown)
const scopePressureState = new Map(); // agent -> { high:bool }
let localMcpSessionCacheAt = 0;

function messageCounterFromId(id) {
  if (typeof id !== 'string') return 0;
  const match = /^msg_(\d+)$/.exec(id.trim());
  if (!match) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function maxPersistedMessageCounter(rows = messages) {
  if (!Array.isArray(rows)) return 0;
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, messageCounterFromId(row?.id));
  }
  return max;
}

{
  const loadedCounter = Number.isFinite(Number(msgCounter)) ? Math.max(0, Math.floor(Number(msgCounter))) : 0;
  const reconciledCounter = Math.max(loadedCounter, maxPersistedMessageCounter(messages));
  msgCounter = reconciledCounter;
  if (reconciledCounter !== loadedCounter) {
    saveJson('.msg_counter', msgCounter, { immediate: true });
  }
}
let localMcpSessionCache = new Set();
const agentMachines = new Map(); // agentName -> AgentStateMachine

function createAgentMachine(agentName, initialState, snapshot = null) {
  const m = new AgentStateMachine(initialState);
  m.onGraceExpired(() => {
    const a = agents[agentName];
    if (a) { a.state = m.state; saveAgents(); }
  });
  if (snapshot) m.restore(snapshot);
  agentMachines.set(agentName, m);
  return m;
}

function resetAgentMachine(agentName, snapshot = null) {
  const existing = agentMachines.get(agentName);
  if (existing) existing.destroy();
  agentMachines.delete(agentName);
  if (snapshot) createAgentMachine(agentName, snapshot.state, snapshot);
}

function snapshotAgentPersistenceState(agentName) {
  const hadAgent = Object.prototype.hasOwnProperty.call(agents, agentName);
  const machine = agentMachines.get(agentName);
  return {
    hadAgent,
    agent: hadAgent ? cloneJsonValue(agents[agentName]) : null,
    hadMachine: Boolean(machine),
    machineSnapshot: machine?.snapshot() || null,
  };
}

function snapshotAgentRuntimeState(agentName) {
  const hadRuntime = Object.prototype.hasOwnProperty.call(agentRuntime, agentName);
  return {
    hadRuntime,
    runtime: hadRuntime ? cloneJsonValue(agentRuntime[agentName]) : null,
  };
}

function restoreAgentPersistenceState(agentName, snapshot) {
  if (snapshot?.hadAgent) agents[agentName] = cloneJsonValue(snapshot.agent);
  else delete agents[agentName];
  resetAgentMachine(agentName, snapshot?.hadMachine ? snapshot.machineSnapshot : null);
}

function restoreAgentRuntimeState(agentName, snapshot) {
  if (snapshot?.hadRuntime) agentRuntime[agentName] = cloneJsonValue(snapshot.runtime);
  else delete agentRuntime[agentName];
}

function saveAgentsOrRollback(agentName, snapshot) {
  if (saveAgents(true)) return true;
  restoreAgentPersistenceState(agentName, snapshot);
  return false;
}

function getAgentMachine(agentName) {
  let m = agentMachines.get(agentName);
  if (m) return m;
  const agent = agents[agentName];
  const runtime = agentRuntime[agentName] || null;
  const initial = deriveStateFromLegacy(agent || null, runtime);
  return createAgentMachine(agentName, initial);
}

function transitionAgent(agentName, event) {
  const m = getAgentMachine(agentName);
  const newState = m.transition(event);
  const agent = agents[agentName];
  if (agent) {
    agent.state = newState;
    agent.online = m.online;
    agent.manualDown = m.manualDown;
  }
  return newState;
}

function syncAgentMachine(agentName, signals) {
  if (!agentName) return;
  const m = getAgentMachine(agentName);

  if (signals.manualDown === true) {
    transitionAgent(agentName, 'manual_down');
    return;
  }
  if (signals.manualDown === false && m.state === 'manual_down') {
    transitionAgent(agentName, 'manual_up');
  }

  if (signals.serverOffline) {
    transitionAgent(agentName, 'server_offline');
    return;
  }
  if (signals.tmuxMissing) {
    transitionAgent(agentName, 'tmux_missing');
    return;
  }
  if (signals.heartbeatMissing) {
    transitionAgent(agentName, 'heartbeat_missing');
    return;
  }

  if (signals.heartbeatPresent) {
    transitionAgent(agentName, 'heartbeat_present');
  } else if (signals.tmuxPresent && m.state === 'offline') {
    transitionAgent(agentName, 'tmux_detected');
  }

  const agent = agents[agentName];
  if (signals.mcpPresent === true) {
    transitionAgent(agentName, 'mcp_confirmed');
  } else if (signals.mcpPresent === false) {
    if (m.state !== 'starting') transitionAgent(agentName, 'mcp_missing_debounced');
  } else if (agent && !agentExpectsMcp(agent)) {
    transitionAgent(agentName, 'mcp_not_applicable');
  }
}

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
  agent.agentModelVersion = normalizeAgentModelVersion(agent.agentModelVersion) || null;
  agent.layoutVersion = normalizeLayoutVersion(agent.layoutVersion) || null;
  agent.agentId = normalizeAgentId(agent.agentId) || null;
  agent.homeDir = normalizeWorkspacePath(agent.homeDir) || null;
  agent.workdir = normalizeWorkspacePath(agent.workdir) || null;
  agent.stateDir = normalizeWorkspacePath(agent.stateDir) || null;
  agent.managedProjects = normalizeManagedProjects(agent.managedProjects);
  agent.human = normalizeHumanMeta(agent.human, { preserveLegacy: true });
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
for (const agent of Object.values(agents)) {
  if (!agent.name) continue;
  const m = getAgentMachine(agent.name);
  agent.state = m.state;
}

// ── Startup reconciliation: agent home manifests ──────────────────────
{
  let reconciled = 0;
  for (const agent of Object.values(agents)) {
    if (!agent.name || !agent.homeDir) continue;
    if (!isLocalAgentServer(normalizeServer(agent.server), LOCAL_SERVER_ID)) continue;
    const manifestPath = path.join(agent.homeDir, 'agent.json');
    try {
      const manifest = readV1AgentManifest(manifestPath);
      if (!manifest) continue;
      let changed = false;
      if (manifest.task && typeof manifest.task === 'object') {
        const diskTs = Date.parse(manifest.task.updated_at) || 0;
        const memTs = Date.parse(agent.task?.updated_at) || 0;
        if (diskTs > memTs) {
          agent.task = normalizeAgentTask(manifest.task, agent.name);
          changed = true;
        }
      }
      if (manifest.runtimeProfile && !agent.runtimeProfile) {
        agent.runtimeProfile = normalizeRuntimeProfile(manifest.runtimeProfile);
        if (agent.runtimeProfile) changed = true;
      }
      if (changed) reconciled++;
    } catch { /* skip unreadable manifests */ }
  }
  if (reconciled > 0) {
    saveJson('agents.json', agents);
    console.log(`[startup] reconciled ${reconciled} agent(s) from home manifests`);
  }
}

// ── Startup reconciliation: orphaned agent homes ──────────────────────
{
  let orphans = 0;
  try {
    for (const homeRoot of allAgentHomeRoots()) {
      const agentsDir = path.join(homeRoot, 'agents');
      if (!existsSync(agentsDir)) continue;
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(agentsDir, entry.name, 'agent.json');
        const manifest = readV1AgentManifest(manifestPath);
        if (!manifest || !manifest.name) continue;
        if (agents[manifest.name]) continue;
        const result = ensureAgentRecord(manifest.name, {
          type: manifest.type || 'agent',
          homeDir: manifest.homeDir,
          workdir: manifest.workdir,
          stateDir: manifest.stateDir,
          agentModelVersion: manifest.agentModelVersion,
          layoutVersion: manifest.layoutVersion,
          agentId: manifest.id,
          online: false,
          offlineReason: 'orphan-discovered',
          task: manifest.task,
          runtimeProfile: manifest.runtimeProfile,
          identity: manifest.identity || null,
          role: manifest.role || null,
        });
        if (!result) continue; // tombstoned — skip
        const { agent: created } = result;
        if (created) {
          const m = getAgentMachine(manifest.name);
          created.state = m.state;
          orphans++;
        }
      }
    }
    if (orphans > 0) {
      saveJson('agents.json', agents);
      console.log(`[startup] discovered ${orphans} orphaned agent home(s)`);
    }
  } catch (e) {
    console.error(`[startup] orphan scan failed: ${e.message}`);
  }
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

let serverMaintenanceChanged = false;
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
    serverMaintenanceChanged = true;
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
  const hadMaintenance = Object.prototype.hasOwnProperty.call(server, 'maintenance');
  const previousMaintenance = server.maintenance;
  const configuredMaintenance = SERVER_MAINTENANCE_IDS.has(normalizeServer(server.id) || serverId);
  server.maintenance = SERVER_MAINTENANCE_ENV_CONFIGURED || !hadMaintenance
    ? configuredMaintenance
    : server.maintenance === true;
  if (!hadMaintenance || previousMaintenance !== server.maintenance) serverMaintenanceChanged = true;
  if (!Array.isArray(server.sessions)) server.sessions = [];
  if (!Array.isArray(server.agents)) server.agents = [];
  server.agentCount = Number(server.agentCount) || server.agents.length || 0;
}
if (serverMaintenanceChanged) saveJson('servers.json', servers);

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
  runtime.blockedConsecutiveScans = Math.max(0, Number(runtime.blockedConsecutiveScans) || 0);
  runtime.blockedNotificationSent = runtime.blockedNotificationSent === true;
  runtime.lastBlockedNotificationTs = Math.max(0, Number(runtime.lastBlockedNotificationTs) || 0);
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
  runtime.activeNow = normalizeRuntimeActiveNow(runtime.activeNow);
  runtime.activeDurationSec = Number(runtime.activeDurationSec) || 0;
  runtime.idleDurationSec = Number(runtime.idleDurationSec) || 0;
  runtime.lastTmuxActivitySec = Number(runtime.lastTmuxActivitySec) || null;
  runtime.workspacePath = normalizeWorkspacePath(runtime.workspacePath);
  runtime.observation = normalizeRuntimeObservation(runtime.observation);
  runtime.mcpPresent = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);
  runtime.mcpMissingSince = Number(runtime.mcpMissingSince) || null;
  runtime.mcpHeartbeatAt = Number(runtime.mcpHeartbeatAt) || null;
  if (!runtime.rules || typeof runtime.rules !== 'object') runtime.rules = {};
}
localActivitySweepState.selectionCursor = Math.max(0, Number(localActivitySweepState.selectionCursor) || 0);

function reserveNextMsgId() {
  const nextCounter = msgCounter + 1;
  if (!saveJson('.msg_counter', nextCounter, { immediate: true })) {
    return { ok: false, error: 'msg_counter persistence failed' };
  }
  msgCounter = nextCounter;
  return { ok: true, id: `msg_${String(msgCounter).padStart(4, '0')}` };
}

function saveAgents(immediate = false) { return saveJson('agents.json', agents, { immediate }); }

function writeThruAgentHome(agentName) {
  const agent = agents[agentName];
  if (!agent || !agent.homeDir) return;
  const serverId = normalizeServer(agent.server);
  if (!isLocalAgentServer(serverId, LOCAL_SERVER_ID)) return;
  const agentJsonPath = path.join(agent.homeDir, 'agent.json');
  try {
    if (!existsSync(agent.homeDir)) return;
    let disk = {};
    try { disk = JSON.parse(readFileSync(agentJsonPath, 'utf-8')); } catch { /* new file */ }
    let changed = false;
    for (const field of ['task', 'runtimeProfile', 'identity', 'role']) {
      const next = agent[field] ?? null;
      const prev = disk[field] ?? null;
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        disk[field] = next;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(agentJsonPath, `${JSON.stringify(disk, null, 2)}\n`, 'utf-8');
    }
  } catch (e) {
    console.error(`writeThruAgentHome(${agentName}): ${e.message}`);
  }
}

function saveGroups() { return saveJson('groups.json', groups); }

function invalidateUnreadMessageIndex() {
  unreadMessageIndexVersion += 1;
  unreadMessageIndex.version = -1;
}

function addIndexedMessage(map, key, msg) {
  if (typeof key !== 'string' || !key) return;
  let rows = map.get(key);
  if (!rows) {
    rows = [];
    map.set(key, rows);
  }
  rows.push(msg);
}

function getUnreadMessageIndex() {
  if (unreadMessageIndex.version === unreadMessageIndexVersion) return unreadMessageIndex;
  const directByAgent = new Map();
  const groupByName = new Map();
  const groupMentionsByAgent = new Map();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    addIndexedMessage(directByAgent, msg.to, msg);
    addIndexedMessage(groupByName, msg.group, msg);
    if (!msg.group || !Array.isArray(msg.mentions)) continue;
    const seenMentions = new Set();
    for (const mention of msg.mentions) {
      if (typeof mention !== 'string' || !mention || seenMentions.has(mention)) continue;
      seenMentions.add(mention);
      addIndexedMessage(groupMentionsByAgent, mention, msg);
    }
  }
  for (const rows of [...directByAgent.values(), ...groupByName.values(), ...groupMentionsByAgent.values()]) {
    rows.sort(compareMsgOrder);
  }
  unreadMessageIndex.directByAgent = directByAgent;
  unreadMessageIndex.groupByName = groupByName;
  unreadMessageIndex.groupMentionsByAgent = groupMentionsByAgent;
  unreadMessageIndex.version = unreadMessageIndexVersion;
  return unreadMessageIndex;
}

function collectUnreadRetainedMessageIds() {
  const keep = new Set();
  for (const [agentName, agent] of Object.entries(agents)) {
    if (!isAgentRecord(agent) || agent.kind === 'human') continue;
    for (const msg of getUnreadInboxMessages(agentName).unread) {
      if (typeof msg?.id === 'string' && msg.id) keep.add(msg.id);
    }
  }
  return keep;
}

function planMessagePrune(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= MESSAGE_RETENTION_LIMIT) {
    return { retained: list, pruned: [] };
  }
  const retainFrom = Math.max(0, list.length - MESSAGE_RETENTION_LIMIT);
  const unreadKeepIds = collectUnreadRetainedMessageIds();
  const retained = [];
  const pruned = [];

  for (let i = 0; i < list.length; i += 1) {
    const msg = list[i];
    const keep = i >= retainFrom || (typeof msg?.id === 'string' && unreadKeepIds.has(msg.id));
    if (keep) retained.push(msg);
    else pruned.push(msg);
  }
  return { retained, pruned };
}

function archivePrunedMessages(pruned) {
  if (!Array.isArray(pruned) || pruned.length === 0) return 0;
  let fd = null;
  try {
    const created = !existsSync(MESSAGE_ARCHIVE_LOG);
    fd = openSync(MESSAGE_ARCHIVE_LOG, 'a', 0o600);
    chmodSync(MESSAGE_ARCHIVE_LOG, 0o600);
    appendFileSync(fd, `${pruned.map((msg) => JSON.stringify(msg)).join('\n')}\n`);
    fsyncSync(fd);
    if (created) fsyncParentDirectory(MESSAGE_ARCHIVE_LOG);
    return pruned.length;
  } catch (e) {
    console.error(`Failed to archive pruned messages to ${MESSAGE_ARCHIVE_LOG}: ${e?.message || e}`);
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncParentDirectory(filePath) {
  const fd = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function repairJsonlTornTail(filePath) {
  if (!existsSync(filePath)) return false;
  const bytes = readFileSync(filePath);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return false;
  const completeLength = bytes.lastIndexOf(0x0a) + 1;
  truncateSync(filePath, completeLength);
  const fd = openSync(filePath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(filePath);
  return true;
}

function pruneMessagesInMemory() {
  if (!Array.isArray(messages) || messages.length <= MESSAGE_RETENTION_LIMIT) {
    return { pruned: 0, archived: 0 };
  }
  const { retained, pruned } = planMessagePrune(messages);

  if (pruned.length === 0) return { pruned: 0, archived: 0 };
  const archived = archivePrunedMessages(pruned);
  if (archived !== pruned.length) return { pruned: 0, archived: 0 };
  messages.splice(0, messages.length, ...retained);
  return { pruned: pruned.length, archived };
}

function saveMessages() {
  invalidateUnreadMessageIndex();
  const { retained, pruned } = planMessagePrune(messages);
  const nextMessages = pruned.length > 0 ? retained : messages;
  if (pruned.length > 0 && archivePrunedMessages(pruned) !== pruned.length) {
    invalidateUnreadMessageIndex();
    return false;
  }
  if (!saveJson('messages.json', nextMessages)) {
    invalidateUnreadMessageIndex();
    return false;
  }
  if (pruned.length > 0) {
    messages.splice(0, messages.length, ...retained);
  }
  invalidateUnreadMessageIndex();
  return true;
}
function saveCursors() { return saveJson('cursors.json', cursors); }
function saveServers() { saveJson('servers.json', servers); }
function saveAgentRuntime(immediate = false) { return saveJson('agent_runtime.json', agentRuntime, { immediate }); }
function saveTaskGraphs(next = taskGraphStore.dump()) { return saveJson('task_graphs.json', next); }
function saveLocalActivitySweepState() { saveJson('local_activity_sweep.json', localActivitySweepState); }

function ensureAgentRecord(name, defaults = {}) {
  const agentName = normalizeAgentName(name);
  if (!agentName) return null;
  if (deletedAgentTombstones[agentName]) return null;
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
    managedProjects: normalizeManagedProjects(defaults.managedProjects),
    human: normalizeHumanMeta(defaults.human, { preserveLegacy: true }),
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
    || text.startsWith('hafleet-down')
    || text.startsWith('server-maintenance:');
}

function maybeEmitUnexpectedOfflineAlert(agentName, reason, context = {}) {
  if (!agentName) return;
  if (isManualDownReason(reason)) return;
  const lines = [
    `Agent: ${agentName}`,
    `Reason: ${reason || 'unknown'}`,
    `Server: ${context.server || 'local'}`,
    'This looks like an unexpected shutdown/crash. Please intervene manually.',
  ];
  if (context.detail) lines.push(`Detail: ${context.detail}`);
  const result = notificationRouter.emit('agent_offline', {
    agentName, reason: reason || 'unknown',
    summary: `Agent '${agentName}' went offline unexpectedly`,
    full: lines.join('\n'),
  });
  if (!result.accepted) return;
}

function ensureInfoGroup() {
  if (groups.info) return true;
  groups.info = { name: 'info', members: [], createdAt: Date.now() };
  if (saveGroups()) return true;
  delete groups.info;
  return false;
}

function auditLog(req, { agent = null, summary = null, status = 200 } = {}) {
  try {
    appendFileSync(AUDIT_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      ip: req.ip || req.connection?.remoteAddress || null,
      method: req.method,
      route: req.originalUrl || req.url,
      agent,
      summary,
      status,
    }) + '\n');
  } catch (e) {
    console.error(`Failed to append audit log: ${e.message}`);
  }
}

function appendSystemInfoLog(event) {
  try {
    appendFileSync(SYSTEM_INFO_LOG, JSON.stringify(event) + '\n');
  } catch (e) {
    console.error(`Failed to append system info log: ${e.message}`);
  }
}

// Severity classification for alert types
const ALERT_SEVERITY_MAP = {
  swap_high: 'critical', server_offline: 'critical',
  agent_blocked: 'warning', mcp_missing: 'warning', agent_offline: 'warning',
  resource_alert: 'warning', agent_rule: 'warning', bridge_warning: 'warning',
  mcp_recovered: 'info', swap_clear: 'info',
  server_takeover: 'info', supervisor_nudge: 'info', supervisor_escalation: 'warning',
};
const SYSTEM_INFO_RECOVERY_DAMPENER_MS_RAW = Number.parseInt(process.env.SYSTEM_INFO_RECOVERY_DAMPENER_MS || '300000', 10);
const SYSTEM_INFO_RECOVERY_DAMPENER_MS = Number.isFinite(SYSTEM_INFO_RECOVERY_DAMPENER_MS_RAW) && SYSTEM_INFO_RECOVERY_DAMPENER_MS_RAW > 0
  ? SYSTEM_INFO_RECOVERY_DAMPENER_MS_RAW
  : 0;
const recentlyResolvedAlertKeys = new Map();

const ALERT_ACTION_FIELD_KEYS = ['owner', 'assignee', 'runbook', 'impact', 'recoveryCondition', 'exitCondition', 'correlation'];

function mergeAlertCorrelation(base = null, override = null) {
  const result = {};
  if (base && typeof base === 'object' && !Array.isArray(base)) Object.assign(result, base);
  if (override && typeof override === 'object' && !Array.isArray(override)) Object.assign(result, override);
  return Object.keys(result).length ? result : null;
}

function defaultAlertActionFields(alertType, opts = {}) {
  const sourceAgent = normalizeOptionalText(opts.sourceAgent, 128);
  const dedupeKey = normalizeOptionalText(opts.dedupeKey, 255) || alertType;
  if (alertType === 'server_offline') {
    const serverId = sourceAgent || String(dedupeKey || '').replace(/^server_offline:/, '') || null;
    return {
      owner: 'remote-runtime',
      runbook: 'docs/runbooks/remote-server-offline.md',
      impact: 'remote agents on this server are marked offline and direct push delivery is unavailable until the relay recovers',
      recoveryCondition: 'the next accepted heartbeat from this server auto-resolves this alert',
      correlation: {
        dedupeKey,
        serverId,
      },
    };
  }
  if (alertType === 'mcp_missing') {
    return {
      owner: 'agent-runtime',
      runbook: 'docs/runbooks/mcp-missing.md',
      impact: 'the agent cannot receive MCP tool calls until its MCP process is restored',
      recoveryCondition: 'mcp_recovered for this agent auto-resolves this alert',
      correlation: {
        dedupeKey,
        agent: sourceAgent || null,
      },
    };
  }
  if (alertType === 'agent_blocked') {
    return {
      owner: 'agent-runtime',
      runbook: 'docs/runbooks/agent-blocked.md',
      impact: 'the agent may be unable to process pending human or operator messages until the blocked state clears',
      recoveryCondition: 'agent_recovered for this agent auto-resolves this alert',
      correlation: {
        dedupeKey,
        agent: sourceAgent || null,
      },
    };
  }
  if (alertType === 'agent_rule') {
    const parts = String(dedupeKey || '').split(':');
    return {
      owner: 'agent-runtime',
      runbook: 'docs/runbooks/agent-rule.md',
      impact: 'the agent may be violating an operator-facing response or inbox contract until the rule clears',
      recoveryCondition: 'the rule condition becomes false and auto-resolves this alert',
      correlation: {
        dedupeKey,
        agent: sourceAgent || parts[1] || null,
        rule: parts[2] || null,
      },
    };
  }
  if (alertType === 'resource_alert') {
    return {
      owner: 'host-runtime',
      runbook: 'docs/runbooks/resource-alert.md',
      impact: 'the agent process is above its resource budget and may stall or be killed',
      recoveryCondition: 'resource usage falls below the configured clear threshold',
      correlation: {
        dedupeKey,
        agent: sourceAgent || null,
      },
    };
  }
  return {};
}

function buildAlertActionFields(alertType, opts = {}) {
  const defaults = defaultAlertActionFields(alertType, opts);
  const provided = {};
  for (const key of ALERT_ACTION_FIELD_KEYS) {
    if (opts[key] !== undefined) provided[key] = opts[key];
  }
  return {
    ...defaults,
    ...provided,
    correlation: mergeAlertCorrelation(defaults.correlation, provided.correlation),
  };
}

function pruneRecentlyResolvedAlertKeys(now = Date.now()) {
  if (SYSTEM_INFO_RECOVERY_DAMPENER_MS <= 0 || recentlyResolvedAlertKeys.size === 0) return;
  const cutoff = now - SYSTEM_INFO_RECOVERY_DAMPENER_MS;
  for (const [key, ts] of recentlyResolvedAlertKeys) {
    if (ts < cutoff) recentlyResolvedAlertKeys.delete(key);
  }
}

function recordRecentlyResolvedAlertKey(dedupeKey, now = Date.now()) {
  if (SYSTEM_INFO_RECOVERY_DAMPENER_MS <= 0) return;
  const key = normalizeOptionalText(dedupeKey, 255);
  if (!key) return;
  pruneRecentlyResolvedAlertKeys(now);
  recentlyResolvedAlertKeys.set(key, now);
}

function wasRecentlyResolvedAlertKey(dedupeKey, now = Date.now()) {
  if (SYSTEM_INFO_RECOVERY_DAMPENER_MS <= 0) return false;
  const key = normalizeOptionalText(dedupeKey, 255);
  if (!key) return false;
  pruneRecentlyResolvedAlertKeys(now);
  const resolvedAt = recentlyResolvedAlertKeys.get(key);
  if (Number.isFinite(resolvedAt) && (now - resolvedAt) < SYSTEM_INFO_RECOVERY_DAMPENER_MS) return true;
  try {
    for (const alert of alertStore.dump()) {
      if (alert?.dedupeKey !== key || alert.status !== 'resolved') continue;
      const durableResolvedAt = Number(alert.resolvedAt) || 0;
      if (durableResolvedAt && (now - durableResolvedAt) < SYSTEM_INFO_RECOVERY_DAMPENER_MS) {
        recentlyResolvedAlertKeys.set(key, durableResolvedAt);
        return true;
      }
    }
  } catch { /* alert sidecar remains best-effort for system info */ }
  return false;
}

function emitSystemInfo(summary, full = '', alertType = null, opts = {}) {
  const now = Date.now();
  const eventDedupeKey = alertType ? normalizeOptionalText(opts.dedupeKey, 255) : null;
  const dedupeKey = alertType ? (eventDedupeKey || alertType) : null;
  const event = {
    id: `sys_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    summary,
    full: full || '',
    alertType: alertType || null,
    dedupeKey: eventDedupeKey,
    source: 'system',
    group: 'info',
    type: 'inform',
  };

  let suppressSystemInfo = Boolean(opts.suppressSystemInfo);

  // Hook A: alert ingestion
  if (alertType) {
    const recoveryTarget = ALERT_RECOVERY_MAP[alertType];
    if (!recoveryTarget && dedupeKey && wasRecentlyResolvedAlertKey(dedupeKey, now)) {
      suppressSystemInfo = true;
    }
    if (recoveryTarget) {
      // Recovery event — auto-resolve matching alerts
      try {
        if (opts.sourceAgent) {
          const resolved = alertStore.autoResolve(`${recoveryTarget}:${opts.sourceAgent}`);
          if (resolved?.dedupeKey) recordRecentlyResolvedAlertKey(resolved.dedupeKey, now);
        } else {
          const resolved = alertStore.autoResolveByPrefix(recoveryTarget);
          if (Array.isArray(resolved)) {
            for (const alert of resolved) recordRecentlyResolvedAlertKey(alert?.dedupeKey, now);
          }
        }
      } catch { /* alert sidecar remains best-effort for system info */ }
    } else if (!opts.skipAlertIngest) {
      // Non-recovery event — ingest as alert
      try {
        alertStore.ingest({
          alertType,
          dedupeKey,
          severity: ALERT_SEVERITY_MAP[alertType] || 'info',
          source: opts.source || 'backend',
          sourceAgent: opts.sourceAgent || null,
          summary,
          detail: full || null,
          ...buildAlertActionFields(alertType, { ...opts, dedupeKey }),
        });
      } catch { /* ingest validation failure — non-fatal */ }
    }
  }

  if (!suppressSystemInfo) {
    ensureInfoGroup();
    appendSystemInfoLog(event);
    broadcastSSE('system_info', event);
  }

  return event;
}

function isSuppressedForAgent(msg, agentName) {
  return Array.isArray(msg?.suppressedRecipients) && msg.suppressedRecipients.includes(agentName);
}

// ── Notification Router ───────────────────────────────────────────────
const notificationRouter = new NotificationRouter({
  agent_blocked: {
    cooldownMs: BLOCKED_NOTIFICATION_COOLDOWN_MS,
    aggregateWindowMs: BLOCKED_INFO_AGGREGATE_WINDOW_MS,
    dedupeKeyFn: (p) => p.agentName || 'unknown',
    persistedCooldown: {
      read: (key) => {
        const rt = agentRuntime[key];
        return Math.max(0, Number(rt?.lastBlockedNotificationTs) || 0);
      },
      write: (key, ts) => {
        const rt = agentRuntime[key];
        if (rt && (Number(rt.lastBlockedNotificationTs) || 0) !== ts) {
          rt.lastBlockedNotificationTs = ts;
          saveAgentRuntime();
        }
      },
    },
    aggregateFn: (buffer) => {
      const blocked = [];
      const recovered = [];
      for (const [, p] of buffer) {
        if (p.recovered) recovered.push(p.agentName);
        else blocked.push(p);
      }
      // Per-agent alert ingestion (spec §11.4)
      const recentlyRecoveredBlockedKeys = new Set();
      for (const p of blocked) {
        const perAgentDedupeKey = `agent_blocked:${p.agentName}`;
        if (wasRecentlyResolvedAlertKey(perAgentDedupeKey)) {
          recentlyRecoveredBlockedKeys.add(perAgentDedupeKey);
        }
        try {
          alertStore.ingest({
            alertType: 'agent_blocked',
            dedupeKey: perAgentDedupeKey,
            severity: 'warning',
            source: 'backend',
            sourceAgent: p.agentName,
            summary: `Agent '${p.agentName}' blocked (${p.tier === BLOCK_TIER_TRANSIENT ? 'transient' : (p.tier === BLOCK_TIER_SOFT ? 'soft' : 'hard')})`,
            detail: p.full || null,
            owner: 'agent-runtime',
            runbook: 'docs/runbooks/agent-blocked.md',
            impact: 'the agent may be unable to process pending human or operator messages until the blocked state clears',
            recoveryCondition: 'agent_recovered for this agent auto-resolves this alert',
            correlation: {
              dedupeKey: perAgentDedupeKey,
              agent: p.agentName,
              tier: p.tier === BLOCK_TIER_TRANSIENT ? 'transient' : (p.tier === BLOCK_TIER_SOFT ? 'soft' : 'hard'),
            },
          });
        } catch { /* non-fatal */ }
      }
      for (const agentName of recovered) {
        const resolved = alertStore.autoResolve(`agent_blocked:${agentName}`);
        if (resolved?.dedupeKey) recordRecentlyResolvedAlertKey(resolved.dedupeKey);
      }
      const parts = [];
      const fullParts = [];
      if (blocked.length) {
        const entries = blocked.map(p => {
          const label = p.tier === BLOCK_TIER_TRANSIENT ? 'transient' : (p.tier === BLOCK_TIER_SOFT ? 'soft' : 'hard');
          return `${p.agentName} (${label})`;
        });
        parts.push(`${blocked.length} blocked: ${entries.join(', ')}`);
        for (const p of blocked) { if (p.full) fullParts.push(p.full); }
      }
      if (recovered.length) parts.push(`${recovered.length} recovered: ${recovered.join(', ')}`);
      const singleBlocked = blocked.length === 1 && recovered.length === 0 ? blocked[0] : null;
      const singleRecovered = recovered.length === 1 && blocked.length === 0 ? recovered[0] : null;
      return {
        summary: `Agent state summary: ${parts.join('; ')}`,
        full: fullParts.join('\n---\n'),
        alertType: singleRecovered ? 'agent_recovered' : 'agent_blocked',
        agentName: singleBlocked?.agentName || singleRecovered || null,
        dedupeKey: singleBlocked ? `agent_blocked:${singleBlocked.agentName}` : null,
        alertStoreManaged: true,
        suppressSystemInfo: singleBlocked ? recentlyRecoveredBlockedKeys.has(`agent_blocked:${singleBlocked.agentName}`) : false,
      };
    },
    sinks: ['log'],
  },
  agent_compact: {
    cooldownMs: AGENT_COMPACT_RUNTIME_DEDUPE_MS,
    dedupeKeyFn: (p) => `${p.agentName}:${p.marker}:${p.mode}`,
    sinks: ['sse'],
  },
  agent_offline: {
    cooldownMs: UNEXPECTED_OFFLINE_ALERT_THROTTLE_MS,
    dedupeKeyFn: (p) => `${p.agentName}:${p.reason || 'unknown'}`,
    sinks: ['log'],
  },
  resource_alert: {
    cooldownMs: AGENT_SCOPE_ALERT_COOLDOWN_MS,
    dedupeKeyFn: (p) => p.agentName,
    sinks: ['log'],
  },
}, {
  log: (_family, payload) => {
    if (!payload.summary) return;
    const opts = {};
    if (payload.agentName) {
      opts.sourceAgent = payload.agentName;
      opts.dedupeKey = `${_family}:${payload.agentName}:${payload.reason || ''}`.replace(/:$/, '');
    }
    if (payload.dedupeKey) opts.dedupeKey = payload.dedupeKey;
    if (payload.alertStoreManaged) opts.skipAlertIngest = true;
    if (payload.suppressSystemInfo) opts.suppressSystemInfo = true;
    emitSystemInfo(payload.summary, payload.full || '', payload.alertType || _family, opts);
  },
  sse: (_family, payload) => {
    if (payload.sseEvent) broadcastSSE(payload.sseEvent, payload.sseData || payload);
  },
});


const taskGraphStore = createTaskGraphStore({
  initialGraphs: taskGraphs,
  save: (nextGraphs) => saveTaskGraphs(nextGraphs),
  dispatchMessage: (payload) => dispatchTaskGraphMessage(payload),
  emitEvent: (eventName, payload) => broadcastSSE(eventName, payload),
});

function buildTaskGraphDispatchKey(graphId, nodeId) {
  const graphPart = normalizeOptionalText(graphId, 255);
  const nodePart = normalizeOptionalText(nodeId, 255);
  return graphPart && nodePart ? `task_graph_dispatch:${graphPart}:${nodePart}` : null;
}

function findTaskGraphDispatchMessage(graphId, nodeId, dispatchKey = null) {
  const normalizedGraphId = normalizeOptionalText(graphId, 255);
  const normalizedNodeId = normalizeOptionalText(nodeId, 255);
  const normalizedDispatchKey = normalizeOptionalText(dispatchKey, 512)
    || buildTaskGraphDispatchKey(normalizedGraphId, normalizedNodeId);
  if (!normalizedGraphId || !normalizedNodeId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const schema = msg?.schema;
    if (schema?.kind !== 'task_graph_dispatch') continue;
    const payload = schema?.payload && typeof schema.payload === 'object' && !Array.isArray(schema.payload)
      ? schema.payload
      : {};
    const payloadDispatchKey = normalizeOptionalText(payload.dispatchKey ?? payload.dispatch_key, 512);
    const payloadGraphId = normalizeOptionalText(payload.graphId ?? payload.graph_id, 255);
    const payloadNodeId = normalizeOptionalText(payload.nodeId ?? payload.node_id, 255);
    if (normalizedDispatchKey && payloadDispatchKey === normalizedDispatchKey) return msg;
    if (payloadGraphId === normalizedGraphId && payloadNodeId === normalizedNodeId) return msg;
  }
  return null;
}

function dispatchTaskGraphMessage(payload = {}) {
  const schema = payload?.schema && typeof payload.schema === 'object' && !Array.isArray(payload.schema)
    ? payload.schema
    : {};
  const schemaPayload = schema.payload && typeof schema.payload === 'object' && !Array.isArray(schema.payload)
    ? schema.payload
    : {};
  const graphId = normalizeOptionalText(schemaPayload.graphId ?? schemaPayload.graph_id, 255);
  const nodeId = normalizeOptionalText(schemaPayload.nodeId ?? schemaPayload.node_id, 255);
  const dispatchKey = normalizeOptionalText(schemaPayload.dispatchKey ?? schemaPayload.dispatch_key, 512)
    || buildTaskGraphDispatchKey(graphId, nodeId);
  const existing = findTaskGraphDispatchMessage(graphId, nodeId, dispatchKey);
  if (existing) return existing;
  return dispatchInternalDirectMessage({
    ...payload,
    schema: {
      ...schema,
      kind: 'task_graph_dispatch',
      version: Number(schema.version) || 1,
      payload: {
        ...schemaPayload,
        dispatchKey,
        graphId,
        nodeId,
      },
    },
  });
}

function taskGraphErrorStatus(error) {
  switch (error?.code) {
    case 'graph_not_found':
    case 'node_not_found':
      return 404;
    case 'graph_exists':
      return 409;
    case 'graph_persistence_failed':
    case 'graph_dispatch_failed':
      return 503;
    default:
      return 400;
  }
}

function respondTaskGraphError(res, error, fallback = 'task graph error') {
  return res.status(taskGraphErrorStatus(error)).json({ error: error?.message || fallback });
}

function isTaskGraphDurabilityError(error) {
  return error?.code === 'graph_persistence_failed' || error?.code === 'graph_dispatch_failed';
}

function handleTaskGraphMessageHook(msg) {
  const kind = normalizeOptionalText(msg?.schema?.kind, 128);
  if (kind !== 'task_graph_result' && kind !== 'task_graph_failed') return null;
  const payload = (msg?.schema?.payload && typeof msg.schema.payload === 'object' && !Array.isArray(msg.schema.payload))
    ? msg.schema.payload
    : null;
  if (!payload) return null;
  const graphId = normalizeOptionalText(payload.graphId ?? payload.graph_id, 255);
  const nodeId = normalizeOptionalText(payload.nodeId ?? payload.node_id, 255);
  if (!graphId || !nodeId) return null;
  const graph = taskGraphStore.getGraph(graphId);
  const node = taskGraphStore.getNode(graphId, nodeId);
  if (!graph || !node || graph.status !== 'active') return null;
  if (!['pending', 'dispatched', 'active'].includes(node.status)) return null;
  if (String(msg?.from || '').trim().toLowerCase() !== String(node.assignee || '').trim().toLowerCase()) return null;
  if (node.message_id && normalizeOptionalText(msg?.reply_to, 255) !== node.message_id) return null;

  const patch = kind === 'task_graph_result'
    ? {
      status: 'complete',
      result: Object.prototype.hasOwnProperty.call(payload, 'result') ? payload.result : null,
    }
    : {
      status: 'failed',
      error: normalizeOptionalText(payload.error, 4000) || 'task graph node failed',
    };

  try {
    taskGraphStore.updateNode(graphId, nodeId, patch);
    const advanced = taskGraphStore.advanceGraph(graphId) || taskGraphStore.getGraph(graphId);
    return {
      handled: true,
      graphId,
      nodeId,
      status: patch.status,
      graphStatus: advanced?.status || graph.status,
    };
  } catch (error) {
    if (isTaskGraphDurabilityError(error)) throw error;
    console.warn(`task graph message hook ignored (${graphId}/${nodeId}): ${error?.message || error}`);
    return null;
  }
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
  const out = {
    id: m.id,
    from: m.from,
    type: m.type,
    priority: normalizeMessagePriority(m?.priority),
    summary: m.summary,
    full: m.full || '',
    mentions: m.mentions || [],
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    ts: m.ts,
    at: new Date(m.ts).toISOString(),
    time: relativeTime(m.ts),
    reply_to: m.reply_to || null,
    group: m.group || null,
    source: m.source || 'api',
    sourceRoom: m.sourceRoom || null,
    sourceEventId: m.sourceEventId || null,
    senderMxid: m.senderMxid || null,
    trustLevel: m.trustLevel || null,
    fromId: m.fromId || null,
    matrixContext: m.matrixContext || null,
    matrixDelivery: m.matrixDelivery || null,
  };
  const normalizedSchema = normalizeMessageSchema(m?.schema);
  if (normalizedSchema.value) out.schema = normalizedSchema.value;
  return out;
}

function createMessageViewToken() {
  return randomBytes(24).toString('base64url');
}

function constantTimeStringEqual(left, right) {
  const leftBuf = Buffer.from(String(left || ''), 'utf8');
  const rightBuf = Buffer.from(String(right || ''), 'utf8');
  if (leftBuf.length === 0 || leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function normalizeMessagePriority(value, fallback = 'normal') {
  if (value === undefined || value === null) return fallback;
  const raw = normalizeOptionalText(value, 16);
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'normal' || lower === 'high' || lower === 'urgent') return lower;
  return null;
}

function messagePriorityRank(value) {
  const priority = normalizeMessagePriority(value);
  if (priority === 'urgent') return 2;
  if (priority === 'high') return 1;
  return 0;
}

function highestMessagePriority(rows = []) {
  let best = 'normal';
  for (const row of Array.isArray(rows) ? rows : []) {
    if (messagePriorityRank(row?.priority) > messagePriorityRank(best)) {
      best = normalizeMessagePriority(row?.priority) || best;
    }
  }
  return best;
}

function normalizeMessageSchema(value) {
  if (value === undefined) return { value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'schema must be an object' };
  }
  const kind = normalizeOptionalText(value.kind, 128);
  if (!kind) return { error: 'schema.kind required' };
  let version = 1;
  if (Object.prototype.hasOwnProperty.call(value, 'version') && value.version !== undefined && value.version !== null) {
    if (typeof value.version !== 'number') {
      return { error: 'schema.version must be a positive integer' };
    }
    const parsed = value.version;
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: 'schema.version must be a positive integer' };
    }
    version = parsed;
  }
  const out = { kind, version };
  if (Object.prototype.hasOwnProperty.call(value, 'payload')) out.payload = value.payload;
  return { value: out };
}

function parseKindsFilter(value) {
  if (value === undefined || value === null) return [];
  const rawItems = Array.isArray(value)
    ? value.flatMap(item => String(item || '').split(','))
    : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const kind = normalizeOptionalText(raw, 128);
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

function messageMatchesKinds(msg, kinds = null) {
  if (!(kinds instanceof Set) || kinds.size === 0) return true;
  const kind = normalizeOptionalText(msg?.schema?.kind, 128);
  return Boolean(kind && kinds.has(kind));
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

function snapshotCursor(agentName) {
  return Object.prototype.hasOwnProperty.call(cursors, agentName)
    ? cloneJsonValue(cursors[agentName])
    : undefined;
}

function restoreCursor(agentName, snapshot) {
  if (snapshot === undefined) delete cursors[agentName];
  else cursors[agentName] = snapshot;
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

function firstMessageAfterCursorIndex(rows, ts, id) {
  const list = Array.isArray(rows) ? rows : [];
  const cursorTs = Number(ts) || 0;
  const cursorId = typeof id === 'string' ? id : null;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const msg = list[mid];
    const after = cursorId
      ? compareMsgOrder(msg, { ts: cursorTs, id: cursorId }) > 0
      : (Number(msg?.ts) || 0) > cursorTs;
    if (after) high = mid;
    else low = mid + 1;
  }
  return low;
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

function getUnreadInboxMessages(agentName, options = {}) {
  const cursor = ensureCursor(agentName);
  const inboxTs = cursor.inbox || 0;
  const inboxId = cursor.inboxId || null;
  const kinds = Array.isArray(options?.kinds) && options.kinds.length > 0
    ? new Set(options.kinds)
    : null;
  const index = getUnreadMessageIndex();
  const unreadById = new Map();

  const directRows = index.directByAgent.get(agentName) || [];
  for (const m of directRows.slice(firstMessageAfterCursorIndex(directRows, inboxTs, inboxId))) {
    if (isSuppressedForAgent(m, agentName)) continue;
    if (!messageMatchesKinds(m, kinds)) continue;
    unreadById.set(m.id, m);
  }
  const mentionRows = index.groupMentionsByAgent.get(agentName) || [];
  for (const m of mentionRows.slice(firstMessageAfterCursorIndex(mentionRows, inboxTs, inboxId))) {
    if (!isGroupMember(m.group, agentName) && m.matrixDefaultRecipient !== agentName) continue;
    if (!messageMatchesKinds(m, kinds)) continue;
    if (isSuppressedForAgent(m, agentName)) continue;
    unreadById.set(m.id, m);
  }

  const unread = [...unreadById.values()].sort(compareMsgOrder);
  return { inboxTs, inboxId, unread };
}

function invalidatePendingHumanTargets(agentNames = null) {
  if (agentNames === null || agentNames === undefined) {
    pendingHumanTargetCache.clear();
    return;
  }
  const names = Array.isArray(agentNames) ? agentNames : [agentNames];
  for (const raw of names) {
    const name = normalizeAgentName(raw) || (typeof raw === 'string' ? raw.trim() : '');
    if (!name) continue;
    pendingHumanTargetCache.delete(name);
  }
}

function invalidatePendingHumanTargetsForMessage(msg) {
  if (!msg || msg.type !== 'human') return;
  const targets = new Set();
  const directTarget = normalizeAgentName(msg.to) || (typeof msg.to === 'string' ? msg.to.trim() : '');
  if (directTarget) targets.add(directTarget);
  for (const mention of Array.isArray(msg.mentions) ? msg.mentions : []) {
    const name = normalizeAgentName(mention) || (typeof mention === 'string' ? mention.trim() : '');
    if (name) targets.add(name);
  }
  invalidatePendingHumanTargets([...targets]);
}

function snapshotForceDeletePersistenceState(name) {
  return {
    hadAgent: Object.prototype.hasOwnProperty.call(agents, name),
    agent: Object.prototype.hasOwnProperty.call(agents, name) ? cloneJsonValue(agents[name]) : null,
    hadRuntime: Object.prototype.hasOwnProperty.call(agentRuntime, name),
    runtime: Object.prototype.hasOwnProperty.call(agentRuntime, name) ? cloneJsonValue(agentRuntime[name]) : null,
    hadCursor: Object.prototype.hasOwnProperty.call(cursors, name),
    cursor: Object.prototype.hasOwnProperty.call(cursors, name) ? cloneJsonValue(cursors[name]) : null,
    hadTombstone: Object.prototype.hasOwnProperty.call(deletedAgentTombstones, name),
    tombstone: Object.prototype.hasOwnProperty.call(deletedAgentTombstones, name)
      ? cloneJsonValue(deletedAgentTombstones[name])
      : null,
  };
}

function restoreForceDeletePersistenceState(name, snapshot) {
  if (snapshot.hadAgent) agents[name] = cloneJsonValue(snapshot.agent);
  else delete agents[name];
  if (snapshot.hadRuntime) agentRuntime[name] = cloneJsonValue(snapshot.runtime);
  else delete agentRuntime[name];
  if (snapshot.hadCursor) cursors[name] = cloneJsonValue(snapshot.cursor);
  else delete cursors[name];
  if (snapshot.hadTombstone) deletedAgentTombstones[name] = cloneJsonValue(snapshot.tombstone);
  else delete deletedAgentTombstones[name];
}

function rollbackForceDeletePersistenceState(name, snapshot, changed) {
  restoreForceDeletePersistenceState(name, snapshot);
  let rollbackOk = true;
  if (changed.tombstone && !saveJson('deleted_agents.json', deletedAgentTombstones, { immediate: true })) rollbackOk = false;
  if (changed.agents && !saveAgents(true)) rollbackOk = false;
  if (changed.runtime && !saveAgentRuntime(true)) rollbackOk = false;
  if (changed.cursors && !saveCursors()) rollbackOk = false;
  if (!rollbackOk) {
    console.error(`[force-delete] failed to fully roll back persistence state for ${name}`);
  }
}

function persistForceDeletedAgentState(name) {
  const snapshot = snapshotForceDeletePersistenceState(name);
  const changed = {
    agents: agents[name] !== undefined,
    runtime: agentRuntime[name] !== undefined,
    cursors: cursors[name] !== undefined,
    tombstone: true,
  };

  if (changed.agents) delete agents[name];
  if (changed.runtime) delete agentRuntime[name];
  if (changed.cursors) delete cursors[name];
  deletedAgentTombstones[name] = { deletedAt: Date.now(), reason: 'force-delete' };

  if (!saveJson('deleted_agents.json', deletedAgentTombstones, { immediate: true })) {
    restoreForceDeletePersistenceState(name, snapshot);
    return { ok: false, error: 'agent force-delete persistence failed' };
  }
  if (changed.agents && !saveAgents(true)) {
    rollbackForceDeletePersistenceState(name, snapshot, changed);
    return { ok: false, error: 'agent force-delete persistence failed' };
  }
  if (changed.runtime && !saveAgentRuntime(true)) {
    rollbackForceDeletePersistenceState(name, snapshot, changed);
    return { ok: false, error: 'agent force-delete persistence failed' };
  }
  if (changed.cursors && !saveCursors()) {
    rollbackForceDeletePersistenceState(name, snapshot, changed);
    return { ok: false, error: 'agent force-delete persistence failed' };
  }

  return {
    ok: true,
    removed: changed.agents,
    runtimeRemoved: changed.runtime,
    cursorsRemoved: changed.cursors,
  };
}

function cleanupDeletedAgentRuntimeState(name) {
  let agentDataRemoved = false;

  const machine = agentMachines.get(name);
  if (machine) { machine.destroy(); agentMachines.delete(name); }
  invalidatePendingHumanTargets(name);
  localActivityState.delete(name);
  localTmuxMissingState.delete(name);
  localCompactState.delete(name);
  localRuntimeSignalDigest.delete(name);
  scopePressureState.delete(name);
  notificationRouter.clearAgent(name);

  // Clean up supervisor state for the deleted agent after the tombstone is durable.
  try {
    supervisorSnapshotStore.removeTarget(name);
  } catch (error) {
    console.warn(`[supervisor] failed to remove snapshot for deleted agent '${name}': ${error?.message || error}`);
  }
  try { killSupervisorTmux(`supervisor-${name}`); } catch { /* tmux not available */ }

  const agentDataDir = agentDataPath(name);
  if (existsSync(agentDataDir)) {
    try {
      rmSync(agentDataDir, { recursive: true, force: true });
      agentDataRemoved = true;
    } catch (error) {
      console.warn(`failed to remove agent data dir for ${name}: ${error?.message || error}`);
    }
  }

  return { agentDataRemoved };
}

function clearDeletedAgentState(agentName) {
  const name = normalizeAgentName(agentName);
  if (!name) return { ok: false, error: 'invalid agent name' };
  const persisted = persistForceDeletedAgentState(name);
  if (!persisted.ok) return persisted;
  const cleanup = cleanupDeletedAgentRuntimeState(name);
  return { ...persisted, ...cleanup };
}

function messageTargetsAgent(msg, agentName) {
  if (!msg || !agentName) return false;
  if (msg.to === agentName) return true;
  if (!msg.group) return false;
  if (!isGroupMember(msg.group, agentName) && msg.matrixDefaultRecipient !== agentName) return false;
  return Array.isArray(msg.mentions) && msg.mentions.includes(agentName);
}

function messageVisibleToAgent(msg, agentName) {
  const normalized = normalizeAgentName(agentName);
  if (!msg || !normalized) return false;
  if (msg.from === normalized || msg.to === normalized) return true;
  if (msg.matrixDefaultRecipient === normalized) return true;
  if (msg.group && isGroupMember(msg.group, normalized)) return true;
  return false;
}

function deliveryTargetAgentsForMessage(msg, directTargetKind = null) {
  const targets = new Set();
  if (msg?.to && directTargetKind === 'agent' && !isSuppressedForAgent(msg, msg.to)) {
    targets.add(msg.to);
  }
  if (msg?.group && Array.isArray(msg.mentions)) {
    for (const name of msg.mentions) {
      if (!name || name === msg.from || isSuppressedForAgent(msg, name)) continue;
      if (isAgentRecord(agents[name])) targets.add(name);
    }
  }
  if (msg?.matrixDefaultRecipient && isAgentRecord(agents[msg.matrixDefaultRecipient])) {
    targets.add(msg.matrixDefaultRecipient);
  }
  return [...targets];
}

function hasMessageViewTokenAccess(req, msg) {
  const token = normalizeOptionalText(req.query?.view || req.query?.view_token || req.query?.token, 256);
  if (!token || !msg?.viewToken) return false;
  return constantTimeStringEqual(token, msg.viewToken);
}

function authorizeMessageDetailAccess(req, msg, options = {}) {
  if (options.allowViewToken && hasMessageViewTokenAccess(req, msg)) return { ok: true, mode: 'view-token' };
  if (hasApiTokenAccess(req)) return { ok: true, mode: 'bearer' };

  const agentName = getRequestAgentName(req);
  if (!agentName) return { ok: false, status: 401, error: 'agent identity required' };
  if (!isAgentRecord(agents[agentName])) return { ok: false, status: 404, error: 'agent not found' };
  if (!messageVisibleToAgent(msg, agentName)) {
    return { ok: false, status: 403, error: `agent '${agentName}' cannot access message ${msg?.id || ''}`.trim() };
  }
  return authorizeAgentCredential(req, agentName);
}

function buildUnreadInboxSnapshot(agentName, options = {}) {
  const { unread } = getUnreadInboxMessages(agentName, options);
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
    unread_ids: unread.map((m) => m?.id).filter(Boolean),
    latest: unread.length > 0 ? summarizeMsg(unread[unread.length - 1]) : null,
  };
}

function persistNewMessage(msg) {
  const index = messages.length;
  messages.push(msg);
  if (saveMessages()) return { ok: true };
  if (messages[index] === msg) {
    messages.splice(index, 1);
  } else {
    const currentIndex = messages.findIndex((row) => row === msg || row?.id === msg?.id);
    if (currentIndex >= 0) messages.splice(currentIndex, 1);
  }
  invalidateUnreadMessageIndex();
  return { ok: false, error: 'messages persistence failed' };
}

function dispatchStoredMessage(msg, options = {}) {
  const senderIsAgent = options.senderIsAgent === true;
  const directTargetKind = options.directTargetKind || null;
  const persisted = persistNewMessage(msg);
  if (!persisted.ok) {
    return { ok: false, status: 503, error: persisted.error };
  }
  const targetAgents = deliveryTargetAgentsForMessage(msg, directTargetKind);
  appendDeliveryEvent({
    type: 'message.accepted',
    source: 'backend',
    messageId: msg.id,
    agent: targetAgents.length === 1 ? targetAgents[0] : null,
    targetAgents,
    priority: msg.priority,
    context: {
      from: msg.from,
      to: msg.to || null,
      group: msg.group || null,
      type: msg.type,
      targetKind: directTargetKind,
    },
  });
  if (Array.isArray(msg.suppressedRecipients) && msg.suppressedRecipients.length > 0) {
    appendDeliveryEvent({
      type: 'message.suppressed',
      source: 'backend',
      messageId: msg.id,
      targetAgents: msg.suppressedRecipients,
      reason: 'suppressed-recipient',
    });
  }
  emitStoredMessageSideEffects(msg, { senderIsAgent, directTargetKind });
  return { ok: true, msg };
}

function emitStoredMessageSideEffects(msg, { senderIsAgent = false, directTargetKind = null } = {}) {
  invalidatePendingHumanTargetsForMessage(msg);
  const compactEvent = buildAgentCompactEvent(msg, senderIsAgent);
  if (compactEvent) {
    broadcastSSE('agent_compact', compactEvent);
  }
  broadcastSSE('message', { ...msg, deliveryOwner: 'dashboard-queue' });
  if (senderIsAgent) {
    markAgentOutbound(msg.from);
  }

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
}

function deliveryEventAttemptExists(attemptId) {
  return Boolean(attemptId) && deliveryEventAttemptIds.has(attemptId);
}

function appendDeliveryEventOnce(raw, attemptId) {
  if (deliveryEventAttemptExists(attemptId)) return { ok: true, deduped: true };
  return appendDeliveryEvent({ ...raw, attemptId });
}

function archivedMessageExists(messageId) {
  if (!existsSync(MESSAGE_ARCHIVE_LOG)) return false;
  for (const line of readFileSync(MESSAGE_ARCHIVE_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (JSON.parse(line)?.id === messageId) return true;
  }
  return false;
}

async function emitMatrixStoredMessageSideEffects(msg, receipt, { senderIsAgent = false, directTargetKind = null } = {}) {
  invalidatePendingHumanTargetsForMessage(msg);
  const compactEvent = buildAgentCompactEvent(msg, senderIsAgent);
  if (compactEvent) broadcastSSE('agent_compact', compactEvent);
  broadcastSSE('message', { ...msg, deliveryOwner: 'dashboard-queue' });
  if (senderIsAgent) markAgentOutbound(msg.from);

  for (const agentName of deliveryTargetAgentsForMessage(msg, directTargetKind)) {
    const state = getAgentDeliveryState(agentName);
    if (!state.online || !agents[agentName]?.tmux) continue;
    const result = await pushNotify(agentName, msg, {
      idempotencyKey: `matrix:${receipt.eventId}:${agentName}`,
    });
    const durableInboxFallback = result?.reason === 'local-session-not-found'
      || result?.reason === 'missing-tmux-target';
    if (!isCatchupNotificationComplete(result) && !durableInboxFallback) {
      return { ok: false, status: 503, error: `Matrix wake queue failed for ${agentName}: ${result?.reason || 'unknown error'}` };
    }
  }
  return { ok: true };
}

async function completeMatrixDispatch(receipt) {
  const msg = receipt.message;
  const liveMessageExists = messages.some((row) => row?.id === receipt.messageId);
  const durableArchiveExists = receipt.status === 'committed' && !liveMessageExists
    ? archivedMessageExists(receipt.messageId)
    : false;
  if (!liveMessageExists && !durableArchiveExists) {
    const persisted = persistNewMessage(msg);
    if (!persisted.ok) return { ok: false, status: 503, error: persisted.error };
  }
  if (receipt.status === 'committed') {
    return { ok: true, response: { ...(receipt.response || {}), deduped: true }, newlyCommitted: false };
  }
  if (matrixDispatchFailureStageForTest === 'after-message-persist') {
    matrixDispatchFailureStageForTest = null;
    throw new Error('injected Matrix dispatch failure after message persistence');
  }
  const senderIsAgent = receipt.dispatch?.senderIsAgent === true;
  const directTargetKind = receipt.dispatch?.directTargetKind || null;
  if (receipt.status === 'reserved') {
    const targetAgents = deliveryTargetAgentsForMessage(msg, directTargetKind);
    const accepted = appendDeliveryEventOnce({
      type: 'message.accepted',
      source: 'backend',
      messageId: msg.id,
      agent: targetAgents.length === 1 ? targetAgents[0] : null,
      targetAgents,
      priority: msg.priority,
      context: {
        from: msg.from,
        to: msg.to || null,
        group: msg.group || null,
        type: msg.type,
        targetKind: directTargetKind,
      },
    }, `matrix:${receipt.eventId}:accepted`);
    if (!accepted.ok) return { ok: false, status: 503, error: 'delivery event persistence failed' };
    if (Array.isArray(msg.suppressedRecipients) && msg.suppressedRecipients.length > 0) {
      const suppressed = appendDeliveryEventOnce({
        type: 'message.suppressed',
        source: 'backend',
        messageId: msg.id,
        targetAgents: msg.suppressedRecipients,
        reason: 'suppressed-recipient',
      }, `matrix:${receipt.eventId}:suppressed`);
      if (!suppressed.ok) return { ok: false, status: 503, error: 'suppression event persistence failed' };
    }
    receipt = matrixDispatchStore.accept(receipt.eventId, receipt.response);
  }

  const wake = await emitMatrixStoredMessageSideEffects(msg, receipt, { senderIsAgent, directTargetKind });
  if (!wake.ok) return wake;
  if (matrixDispatchFailureStageForTest === 'after-wake-before-commit') {
    matrixDispatchFailureStageForTest = null;
    throw new Error('injected Matrix dispatch failure after wake before commit');
  }
  const committed = matrixDispatchStore.commit(receipt.eventId, receipt.response);
  return { ok: true, response: committed.response || {}, newlyCommitted: true };
}

function dispatchInternalDirectMessage(payload = {}) {
  const fromName = normalizeAgentName(payload.from) || (typeof payload.from === 'string' ? payload.from.trim() : '') || 'system';
  const toName = normalizeAgentName(payload.to) || (typeof payload.to === 'string' ? payload.to.trim() : '');
  if (!toName) throw new Error('to required');
  const type = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : 'inform';
  if (!['inform', 'request', 'reply'].includes(type)) {
    throw new Error('invalid type');
  }
  const priority = normalizeMessagePriority(payload.priority);
  if (!priority) throw new Error('invalid priority');
  const normalizedSchema = normalizeMessageSchema(payload.schema);
  if (normalizedSchema.error) throw new Error(normalizedSchema.error);
  const summary = normalizeOptionalText(payload.summary, 4000);
  const full = typeof payload.full === 'string' ? payload.full.trim() : '';
  if (!summary) throw new Error('summary required');
  const idReservation = reserveNextMsgId();
  if (!idReservation.ok) {
    throw new Error(idReservation.error || 'message id reservation failed');
  }

  const msg = {
    id: idReservation.id,
    ts: Date.now(),
    from: fromName,
    to: toName,
    group: null,
    type,
    priority,
    summary,
    full,
    mentions: [],
    reply_to: null,
    source: 'system',
    sourceRoom: null,
    viewToken: createMessageViewToken(),
  };
  if (normalizedSchema.value) msg.schema = normalizedSchema.value;
  const senderIsAgent = fromName !== 'system' && isAgentRecord(agents[fromName]);
  const directTargetKind = isAgentRecord(agents[toName]) ? 'agent' : 'human';
  const result = dispatchStoredMessage(msg, { senderIsAgent, directTargetKind });
  if (!result.ok) throw new Error(result.error || 'message persistence failed');
  return result.msg;
}

const supervisorActionEngine = createSupervisorActionEngine({
  snapshotStore: supervisorSnapshotStore,
  sendMessage: (payload) => dispatchInternalDirectMessage(payload),
  broadcastSSE,
  alertStore,
});

const supervisorLifecycleManager = createSupervisorLifecycleManager({
  getAgents: () => agents,
  getRuntime: (name) => ensureAgentRuntimeRecord(name),
  snapshotStore: supervisorSnapshotStore,
  isAgentRecord,
  broadcastSSE,
});

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

function sanitizeForDisplay(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

function ensureAgentRuntimeRecord(name) {
  const agentName = normalizeAgentName(name);
  if (!agentName) return null;
  if (!agentRuntime[agentName] || typeof agentRuntime[agentName] !== 'object') {
    agentRuntime[agentName] = {
      agent: agentName,
      blocked: false,
      blockedReason: null,
      blockedTier: null,
      blockedSince: null,
      blockedConsecutiveScans: 0,
      blockedNotificationSent: false,
      blockedNotifiedTier: null,
      lastBlockedNotificationTs: 0,
      activeNow: null,
      activeDurationSec: 0,
      idleDurationSec: 0,
      lastTmuxActivitySec: null,
      workspacePath: null,
      mcpPresent: null,
      mcpMissingSince: null,
      mcpHeartbeatAt: null,
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
      observation: null,
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
  if (!runtime) return { ok: false, ignored: 'agent-not-found' };
  const now = Date.now();
  const deliveredAt = Number(details.deliveredAt) || now;
  const queuedAt = Number(details.queuedAt) || runtime.lastPushQueuedAt || deliveredAt;
  const queueEntryId = Number(details.queueEntryId) || 0;
  const meta = normalizePushMeta(details);
  const currentQueueEntryId = Number(runtime.lastPushQueueEntryId) || 0;
  const currentDeliveredAt = Number(runtime.lastPushDeliveredAt) || 0;
  const currentSourceMsgId = typeof runtime.lastPushSourceMsgId === 'string'
    ? runtime.lastPushSourceMsgId.trim()
    : '';
  const incomingSourceMsgId = typeof meta.sourceMsgId === 'string'
    ? meta.sourceMsgId.trim()
    : '';
  const staleQueueEntry = queueEntryId > 0
    && currentQueueEntryId > 0
    && queueEntryId !== currentQueueEntryId;
  const staleDeliveredAt = currentDeliveredAt > 0 && deliveredAt < currentDeliveredAt;
  const staleSource = incomingSourceMsgId
    && currentSourceMsgId
    && incomingSourceMsgId !== currentSourceMsgId;
  const inboxReadAck = normalizeInboxReadAck(runtime.inboxReadAck);
  const staleReadAck = incomingSourceMsgId
    && inboxReadAck.sourceMsgId === incomingSourceMsgId
    && Number(inboxReadAck.ackedAt) > 0;
  if (staleQueueEntry || staleDeliveredAt || staleSource || staleReadAck) {
    return { ok: true, ignored: 'stale-push-delivered' };
  }
  const delay = Math.max(0, deliveredAt - queuedAt);

  runtime.lastPushDeliveredAt = deliveredAt;
  runtime.lastPushQueuedAt = queuedAt;
  if (queueEntryId > 0) runtime.lastPushQueueEntryId = queueEntryId;
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
  return { ok: true };
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

  const rawActiveNow = payload.activeNow;
  const hasActiveNow = Object.prototype.hasOwnProperty.call(payload, 'activeNow')
    && (rawActiveNow === true || rawActiveNow === false || rawActiveNow === null);
  const effectiveActiveNow = normalizeRuntimeActiveNow(rawActiveNow);
  if (hasActiveNow && runtime.activeNow !== effectiveActiveNow) {
    runtime.activeNow = effectiveActiveNow;
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
  // NAME IS HISTORICAL. This means "when the agent last did something", for any
  // transport. An ACP agent has no tmux and still reports it, derived from
  // session/update counts rather than a pane hash.
  //
  // Not renamed because it is a relay wire field (lib/push-relay-core.js and its
  // remote/ twin) and is persisted in agent_runtime.json, so a rename needs a
  // dual-read compatibility window and a migration — disproportionate to the
  // confusion it causes. If it is renamed, do it as its own change.
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
  const recentHeartbeatAt = Number(runtime.mcpHeartbeatAt) || 0;
  const hasRecentMcpHeartbeat = recentHeartbeatAt > 0
    && now - recentHeartbeatAt >= 0
    && now - recentHeartbeatAt <= MCP_HEARTBEAT_AUTHORITY_WINDOW_MS;

  if (mcpNow === false && hasRecentMcpHeartbeat) {
    return false;
  }

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
  /*
   * TWO FIELDS, TWO QUESTIONS.
   *
   * `workspacePath` answers "where is this agent running now", and the activity sweep
   * correctly clears it when an agent has no pane — a stopped agent is running nowhere.
   *
   * `lastWorkspacePath` answers "where did it last run", and is never cleared. Metering
   * needs that one: consumption is read from transcripts that stay on disk after the
   * agent stops, and clearing the only key to them made a stopped agent's usage
   * unattributable — a monthly ceiling still spent by work that has finished. Reporting
   * an agent as having consumed nothing because it is no longer running would be the
   * wrong answer to a question nobody asked.
   */
  let changed = false;
  if (normalized && runtime.lastWorkspacePath !== normalized) {
    runtime.lastWorkspacePath = normalized;
    changed = true;
  }
  if ((runtime.workspacePath || null) !== (normalized || null)) {
    runtime.workspacePath = normalized;
    changed = true;
  }
  return changed;
}

function syncLocalAgentOnlineState(agent, runtime, tmuxTarget, manualDown) {
  if (!isAgentRecord(agent) || !runtime) return false;
  let changed = false;
  const mcpMissing = runtime.mcpPresent === false;
  if ((!agent.tmux || !String(agent.tmux).trim()) && !manualDown) {
    agent.tmux = tmuxTarget;
    changed = true;
  }
  // Drive online/manualDown through machine (transitionAgent syncs agent.online/manualDown)
  const prevOnline = agent.online;
  const prevManualDown = agent.manualDown;
  syncAgentMachine(agent.name, {
    manualDown,
    tmuxPresent: true,
    mcpPresent: runtime.mcpPresent === true ? true : (runtime.mcpPresent === false ? false : undefined),
  });
  if (agent.online !== prevOnline || agent.manualDown !== prevManualDown) changed = true;
  // offlineReason is not machine-managed
  if (manualDown) {
    // offlineReason stays as-is for manual down
  } else if (mcpMissing && (agent.state === 'degraded' || agent.state === 'offline')) {
    if (agent.offlineReason !== 'mcp-missing:auto') {
      agent.offlineReason = 'mcp-missing:auto';
      changed = true;
    }
  } else if (!manualDown && !mcpMissing) {
    if (agent.offlineReason !== null) {
      agent.offlineReason = null;
      changed = true;
    }
  }
  if (changed) {
    agent.lastSeen = Date.now();
  }
  return changed;
}

function applyLocalMetadataOnlySignals(agentName, payload = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return;
  applyLocalRuntimeSignals(agentName, {
    blocked: runtime.blocked === true,
    reason: runtime.blocked === true ? (runtime.blockedReason || null) : null,
    tail: runtime.blocked === true ? (runtime.lastBlockedTail || '') : '',
    command: runtime.blocked === true ? (runtime.lastBlockedCommand || '') : '',
    workspacePath: payload.workspacePath,
    mcpPresent: payload.mcpPresent,
    blockedObserved: false,
  });
}

function resolveLocalActivityCaptureSelection(agentNames = [], budget = 0) {
  const ordered = [...new Set((Array.isArray(agentNames) ? agentNames : []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const count = ordered.length;
  const currentCursor = Math.max(0, Number(localActivitySweepState.selectionCursor) || 0);
  if (count === 0) {
    if (currentCursor !== 0) {
      localActivitySweepState.selectionCursor = 0;
      saveLocalActivitySweepState();
    }
    return { selected: new Set(), ordered, currentCursor: 0, nextCursor: 0 };
  }
  if (!Number.isFinite(budget) || budget <= 0 || budget >= count) {
    const nextCursor = 0;
    if (currentCursor !== nextCursor) {
      localActivitySweepState.selectionCursor = nextCursor;
      saveLocalActivitySweepState();
    }
    return { selected: new Set(ordered), ordered, currentCursor, nextCursor };
  }

  const normalizedCursor = currentCursor % count;
  const selected = [];
  for (let i = 0; i < budget; i++) {
    selected.push(ordered[(normalizedCursor + i) % count]);
  }
  const nextCursor = (normalizedCursor + budget) % count;
  if (currentCursor !== nextCursor) {
    localActivitySweepState.selectionCursor = nextCursor;
    saveLocalActivitySweepState();
  }
  return { selected: new Set(selected), ordered, currentCursor: normalizedCursor, nextCursor };
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
  const cached = pendingHumanTargetCache.get(agentName);
  if (cached) return cached;

  const unreadHuman = getUnreadInboxMessages(agentName).unread
    .filter(m => m.type === 'human' && m.from && m.from !== agentName);
  const selected = new Map();

  for (const msg of unreadHuman) {
    const prev = selected.get(msg.from);
    if (!prev || compareMsgOrder(msg, prev) > 0) {
      selected.set(msg.from, msg);
    }
  }

  const snapshot = {
    hasPendingHuman: unreadHuman.length > 0,
    targets: [...selected.values()]
      .sort(compareMsgOrder)
      .map(msg => ({
        human: msg.from,
        humanId: msg.fromId || msg.senderMxid || null,
        roomId: (typeof msg.sourceRoom === 'string' && msg.sourceRoom.trim()) ? msg.sourceRoom.trim() : null,
        group: msg.group || null,
        messageId: msg.id,
        pending: true,
        ts: msg.ts,
      })),
  };
  pendingHumanTargetCache.set(agentName, snapshot);
  return snapshot;
}

function applyRuntimeObservation(agentName, payload = {}) {
  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) return null;

  const now = Date.now();
  const blockedNow = payload.blocked === true;
  const blockedObserved = blockedNow && payload.blockedObserved !== false;
  const reasonNow = blockedNow && typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : null;
  const tierNow = blockedNow ? blockedTierFromReason(reasonNow) : null;
  const tailNow = blockedNow && typeof payload.tail === 'string' ? payload.tail : '';
  const cmdNow = blockedNow && typeof payload.command === 'string' ? payload.command : '';
  const serverNow = blockedNow ? normalizeServer(payload.server) : null;

  const prevBlocked = runtime.blocked === true;
  const prevReason = runtime.blockedReason || null;
  const prevBlockedTier = normalizeBlockedTier(runtime.blockedTier, prevBlocked ? blockedTierFromReason(prevReason) : null);
  const prevBlockedConsecutiveScans = Math.max(0, Number(runtime.blockedConsecutiveScans) || 0);
  const prevBlockedNotificationSent = runtime.blockedNotificationSent === true;
  const prevBlockedNotifiedTier = normalizeBlockedTier(
    runtime.blockedNotifiedTier,
    prevBlockedNotificationSent ? prevBlockedTier : null,
  );
  const prevMcpPresent = runtime.mcpPresent === true
    ? true
    : (runtime.mcpPresent === false ? false : null);
  let changed = false;

  if (runtime.blocked !== blockedNow) { runtime.blocked = blockedNow; changed = true; }
  if ((runtime.blockedReason || null) !== reasonNow) { runtime.blockedReason = reasonNow; changed = true; }
  if (normalizeBlockedTier(runtime.blockedTier, null) !== tierNow) { runtime.blockedTier = tierNow; changed = true; }
  if (runtime.lastSeen !== now) { runtime.lastSeen = now; changed = true; }
  if (runtime.updatedAt !== now) { runtime.updatedAt = now; changed = true; }
  if (blockedNow) {
    const sameBlockedSignature = prevBlocked && prevReason === reasonNow && prevBlockedTier === tierNow;
    const blockedConsecutiveScans = blockedObserved
      ? (sameBlockedSignature ? (prevBlockedConsecutiveScans + 1) : 1)
      : (sameBlockedSignature ? prevBlockedConsecutiveScans : 0);
    if (runtime.blockedConsecutiveScans !== blockedConsecutiveScans) {
      runtime.blockedConsecutiveScans = blockedConsecutiveScans;
      changed = true;
    }
    const blockedSince = prevBlocked ? (runtime.blockedSince || now) : now;
    if (runtime.blockedSince !== blockedSince) { runtime.blockedSince = blockedSince; changed = true; }
    if (runtime.lastBlockedTail !== tailNow) { runtime.lastBlockedTail = tailNow; changed = true; }
    if (runtime.lastBlockedCommand !== cmdNow) { runtime.lastBlockedCommand = cmdNow; changed = true; }
    if ((runtime.lastBlockedServer || null) !== (serverNow || null)) { runtime.lastBlockedServer = serverNow; changed = true; }
  } else {
    if (runtime.blockedTier !== null) { runtime.blockedTier = null; changed = true; }
    if (runtime.blockedSince !== null) { runtime.blockedSince = null; changed = true; }
    if (runtime.blockedConsecutiveScans !== 0) { runtime.blockedConsecutiveScans = 0; changed = true; }
    if (runtime.blockedNotificationSent !== false) { runtime.blockedNotificationSent = false; changed = true; }
    if (runtime.blockedNotifiedTier !== null) { runtime.blockedNotifiedTier = null; changed = true; }
    if (runtime.lastBlockedTail !== '') { runtime.lastBlockedTail = ''; changed = true; }
    if (runtime.lastBlockedCommand !== '') { runtime.lastBlockedCommand = ''; changed = true; }
    if (runtime.lastBlockedServer !== null) { runtime.lastBlockedServer = null; changed = true; }
  }

  if (setRuntimeActivityFields(runtime, payload)) changed = true;
  if (setRuntimeWorkspacePath(runtime, payload)) changed = true;
  if (Object.prototype.hasOwnProperty.call(payload, 'observerSource')) {
    const observerServer = Object.prototype.hasOwnProperty.call(payload, 'observerServer')
      ? payload.observerServer
      : payload.server;
    if (setRuntimeObservation(runtime, {
      observerSource: payload.observerSource,
      observerServer,
      observedAt: now,
    })) changed = true;
  }
  const agentForMcp = agents[agentName];
  if (agentForMcp && !agentExpectsMcp(agentForMcp) && payload.mcpPresent !== undefined) payload = { ...payload, mcpPresent: null };
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
      // Paneless agents excluded: this exists to give a tmux agent a target it never
      // registered, and fabricating one for an ACP agent routes it down the pane path.
      if (!agent.tmux && agentTransport(agent) !== 'acp') { agent.tmux = `${agentName}:0.0`; agentChanged = true; }
      // online/manualDown driven by machine below
      if (agent.offlineReason !== 'mcp-missing:auto') { agent.offlineReason = 'mcp-missing:auto'; agentChanged = true; }
      if (agent.lastSeen !== now) { agent.lastSeen = now; agentChanged = true; }
    } else if (mcpNow === true) {
      const recoverable = agent.offlineReason === 'mcp-missing:auto' || !wasOnline;
      // Paneless agents excluded: this exists to give a tmux agent a target it never
      // registered, and fabricating one for an ACP agent routes it down the pane path.
      if (!agent.tmux && agentTransport(agent) !== 'acp') { agent.tmux = `${agentName}:0.0`; agentChanged = true; }
      // online/manualDown driven by machine below
      if (agent.offlineReason === 'mcp-missing:auto') { agent.offlineReason = null; agentChanged = true; }
      if (agent.lastSeen !== now) { agent.lastSeen = now; agentChanged = true; }
      if (!wasOnline && !wasManualDown && recoverable) shouldCatchup = true;
    }
    // Drive online/manualDown through machine
    const prevOnline = agent.online;
    syncAgentMachine(agent.name, {
      mcpPresent: mcpNow === true ? true : (mcpNow === false ? false : undefined),
    });
    if (agent.online !== prevOnline) agentChanged = true;
  }
  if (shouldCatchup) notifyAgentCatchup(agentName, 'mcp-restored');

  if (mcpBecameMissing) {
    const full = [
      `Agent: ${agentName}`,
      `Server: ${normalizeServer(payload.server) || normalizeServer(agent?.server) || 'local'}`,
      'State: tmux session present but mcp-server.js process not detected.',
      'Offline reason set to: mcp-missing:auto',
    ].join('\n');
    emitSystemInfo(`Agent '${agentName}' missing MCP process`, full, 'mcp_missing', { sourceAgent: agentName, dedupeKey: `mcp_missing:${agentName}` });
  } else if (mcpRecovered) {
    emitSystemInfo(`Agent '${agentName}' MCP process recovered`, `Agent '${agentName}' now has mcp-server.js running inside tmux.`, 'mcp_recovered', { sourceAgent: agentName });
  }

  return {
    agentName,
    runtime,
    payload,
    now,
    blockedNow,
    blockedObserved,
    reasonNow,
    tierNow,
    tailNow,
    serverNow,
    prevBlockedNotificationSent,
    prevBlockedNotifiedTier,
  };
}

function dispatchBlockedNotifications(transition) {
  if (!transition || !transition.runtime) return transition?.runtime || null;

  const {
    agentName,
    runtime,
    now,
    blockedNow,
    blockedObserved,
    reasonNow,
    tierNow,
    tailNow,
    serverNow,
    prevBlockedNotificationSent,
    prevBlockedNotifiedTier,
  } = transition;

  const blockedDebounceThreshold = blockedTierDebounceThreshold(tierNow);
  const blockedNotificationReady = blockedNow
    && blockedObserved
    && Number.isFinite(blockedDebounceThreshold)
    && runtime.blockedConsecutiveScans >= blockedDebounceThreshold;
  const becameBlocked = blockedNotificationReady && !prevBlockedNotificationSent;
  const severityIncreased = prevBlockedNotificationSent
    && blockedNotificationReady
    && normalizeBlockedTier(tierNow, null) !== null
    && normalizeBlockedTier(prevBlockedNotifiedTier, null) !== null
    && tierNow > prevBlockedNotifiedTier;
  const recovered = prevBlockedNotificationSent && !blockedNow;

  if (becameBlocked || severityIncreased) {
    const { hasPendingHuman, targets } = collectBlockedHumanTargets(agentName);
    const fullLines = [
      `Agent: ${agentName}`,
      `Reason: ${reasonNow || 'unknown'}`,
      `Tier: ${tierNow === BLOCK_TIER_TRANSIENT ? 'transient' : (tierNow === BLOCK_TIER_SOFT ? 'soft' : 'hard')}`,
      `Server: ${serverNow || 'local'}`,
      `Pending human messages: ${hasPendingHuman ? 'yes' : 'no'}`,
      `Target humans: ${targets.map(t => t.human).join(', ') || 'none'}`,
    ];
    if (tailNow) { fullLines.push('', 'Tail sample:', tailNow); }

    const result = notificationRouter.emit('agent_blocked', {
      agentName, tier: tierNow, full: fullLines.join('\n'),
    }, { bypassCooldown: severityIncreased });
    if (result.accepted) {
      let runtimeChanged = false;
      if (runtime.blockedNotificationSent !== true) {
        runtime.blockedNotificationSent = true;
        runtimeChanged = true;
      }
      if (normalizeBlockedTier(runtime.blockedNotifiedTier, null) !== tierNow) {
        runtime.blockedNotifiedTier = tierNow;
        runtimeChanged = true;
      }
      if (runtimeChanged) saveAgentRuntime();
      broadcastSSE('agent_blocked', {
        agent: agentName,
        reason: reasonNow || 'unknown',
        tier: tierNow,
        blockedSince: runtime.blockedSince || now,
        server: serverNow || null,
        hasPendingHuman,
        targets,
      });
    }
  } else if (recovered) {
    notificationRouter.emit('agent_blocked', {
      agentName, recovered: true,
    }, { bypassCooldown: true, skipPersistedWrite: true });
    broadcastSSE('agent_recovered', { agent: agentName, recoveredAt: now });
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
      detail || `Rule ${code} triggered for agent '${agentName}'.`,
      'agent_rule',
      { sourceAgent: agentName, dedupeKey: `agent_rule:${agentName}:${code}` }
    );
  } else {
    alertStore.autoResolve(`agent_rule:${agentName}:${code}`);
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
    const activeKnown = runtime.activeNow === true || runtime.activeNow === false;
    const activeNow = runtime.activeNow === true;
    const idleDurationSec = Math.max(0, Number(runtime.idleDurationSec) || 0);
    const idleGateReady = activeKnown && !activeNow && idleDurationSec >= 1;
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
        `activeNow: ${activeKnown ? (activeNow ? 'yes' : 'no') : 'unknown'}`,
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
      version: null,
      maintenance: SERVER_MAINTENANCE_IDS.has(serverId),
    };
  }
  return servers[serverId];
}

function stringArrayEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function recordLocalServerObservation(now = Date.now()) {
  if (!RECORD_LOCAL_SERVER) return false;
  const serverId = normalizeServer(LOCAL_SERVER_ID) || 'local';
  const server = ensureServerRecord(serverId);
  if (!server) return false;

  const localAgentRows = Object.values(agents)
    .filter(agent => isAgentRecord(agent))
    .filter(agent => isLocalAgentServer(normalizeServer(agent.server), LOCAL_SERVER_ID))
    .filter(agent => agent.manualDown !== true)
    .filter(agent => typeof agent.tmux === 'string' && agent.tmux.trim())
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const localAgentNames = localAgentRows.map(agent => agent.name);
  const sessions = [...new Set(localAgentRows.map(agent => agent.tmux.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  let changed = false;
  if (server.lastSeen !== now) { server.lastSeen = now; changed = true; }
  if (server.heartbeatAt !== now) { server.heartbeatAt = now; changed = true; }
  if (server.online !== true) { server.online = true; changed = true; }
  if (server.updatedAt !== now) { server.updatedAt = now; changed = true; }
  if (!stringArrayEquals(server.sessions, sessions)) { server.sessions = sessions; changed = true; }
  if (!stringArrayEquals(server.agents, localAgentNames)) { server.agents = localAgentNames; changed = true; }
  if ((Number(server.agentCount) || 0) !== localAgentNames.length) { server.agentCount = localAgentNames.length; changed = true; }
  if (server.sourceIp !== 'local') { server.sourceIp = 'local'; changed = true; }
  if (server.relayInstanceId !== null) { server.relayInstanceId = null; changed = true; }
  if ((Number(server.relayBootTs) || 0) !== 0) { server.relayBootTs = 0; changed = true; }
  if (LOCAL_GIT_VERSION && server.version !== LOCAL_GIT_VERSION) { server.version = LOCAL_GIT_VERSION; changed = true; }
  if (!Object.prototype.hasOwnProperty.call(server, 'maintenance')) {
    server.maintenance = SERVER_MAINTENANCE_IDS.has(serverId);
    changed = true;
  }
  return changed;
}

function isServerInMaintenance(serverId, serverRecord = null) {
  const id = normalizeServer(serverId);
  if (!id) return false;
  const server = (serverRecord && typeof serverRecord === 'object') ? serverRecord : servers[id];
  if (server && typeof server.maintenance === 'boolean') return server.maintenance === true;
  return SERVER_MAINTENANCE_IDS.has(id);
}

function collectServerAffectedAgents(serverId, serverRecord = null) {
  const affected = new Set();
  if (serverRecord && Array.isArray(serverRecord.agents)) {
    for (const name of serverRecord.agents) {
      if (typeof name === 'string' && name.trim()) affected.add(name.trim());
    }
  }
  for (const agent of Object.values(agents)) {
    if (!isAgentRecord(agent)) continue;
    if (normalizeServer(agent.server) !== serverId) continue;
    if (agent.online === true && agent.manualDown !== true) affected.add(agent.name);
  }
  return [...affected].sort((a, b) => a.localeCompare(b));
}

function buildServerOfflineAlertDetail(serverId, reason, serverRecord = null, affectedAgents = []) {
  const now = Date.now();
  const heartbeatAt = Number(serverRecord?.heartbeatAt) || 0;
  const lastSeen = Number(serverRecord?.lastSeen) || 0;
  const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : null;
  return [
    `Server: ${serverId}`,
    `Reason: ${reason || 'server-offline'}`,
    `Last heartbeat: ${heartbeatAt ? new Date(heartbeatAt).toISOString() : 'unknown'}`,
    `Last seen: ${lastSeen ? new Date(lastSeen).toISOString() : 'unknown'}`,
    heartbeatAgeMs !== null ? `Heartbeat age ms: ${heartbeatAgeMs}` : null,
    `Affected agents: ${affectedAgents.length ? affectedAgents.join(', ') : 'none'}`,
    'Impact: remote agents on this server are marked offline and direct push delivery is unavailable until the relay recovers.',
    'Runbook: verify the remote host, relay service, network path, and deployed version; restart the relay or put the server into maintenance if the outage is expected.',
    'Recovery condition: the next accepted heartbeat from this server auto-resolves this alert.',
  ].filter(Boolean).join('\n');
}

function emitServerOfflineAlert(serverId, reason, serverRecord = null, affectedAgents = null) {
  const normalizedServerId = normalizeServer(serverId);
  if (!normalizedServerId) return null;
  if (isLocalAgentServer(normalizedServerId, LOCAL_SERVER_ID)) return null;
  if (isServerInMaintenance(normalizedServerId, serverRecord)) return null;
  const affected = Array.isArray(affectedAgents)
    ? [...new Set(affectedAgents.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))].sort((a, b) => a.localeCompare(b))
    : collectServerAffectedAgents(normalizedServerId, serverRecord);
  try {
    const result = alertStore.ingest({
      alertType: 'server_offline',
      dedupeKey: `server_offline:${normalizedServerId}`,
      severity: 'critical',
      source: 'backend',
      sourceAgent: normalizedServerId,
      summary: `Remote server '${normalizedServerId}' is offline`,
      detail: buildServerOfflineAlertDetail(normalizedServerId, reason, serverRecord, affected),
      owner: 'remote-runtime',
      runbook: 'docs/runbooks/remote-server-offline.md',
      impact: 'remote agents on this server are marked offline and direct push delivery is unavailable until the relay recovers',
      recoveryCondition: 'the next accepted heartbeat from this server auto-resolves this alert',
      correlation: {
        dedupeKey: `server_offline:${normalizedServerId}`,
        serverId: normalizedServerId,
        reason: reason || 'server-offline',
        affectedAgents: affected,
      },
      tags: [
        'server-outage',
        `server:${normalizedServerId}`,
        ...affected.slice(0, 18).map((name) => `agent:${name}`),
      ],
    });
    return result.alert;
  } catch (error) {
    console.warn(`[server-alert] failed to ingest server_offline:${normalizedServerId}: ${error?.message || error}`);
    return null;
  }
}

function resolveServerOfflineAlert(serverId) {
  const normalizedServerId = normalizeServer(serverId);
  if (!normalizedServerId) return null;
  try {
    return alertStore.autoResolve(`server_offline:${normalizedServerId}`);
  } catch (error) {
    console.warn(`[server-alert] failed to resolve server_offline:${normalizedServerId}: ${error?.message || error}`);
    return null;
  }
}

function markAgentsOfflineForServer(serverId, reason, clearTmux = false) {
  let changed = false;
  for (const agent of Object.values(agents)) {
    if (normalizeServer(agent.server) !== serverId) continue;
    const prevOnline = agent.online;
    const prevManualDown = agent.manualDown;
    if (prevManualDown) {
      if (clearTmux && agent.tmux !== null) { agent.tmux = null; changed = true; }
      syncAgentMachine(agent.name, { serverOffline: true });
      if (agent.online !== prevOnline) changed = true;
    } else {
      if (agent.offlineReason !== reason) { agent.offlineReason = reason; changed = true; }
      if (clearTmux && agent.tmux !== null) { agent.tmux = null; changed = true; }
      syncAgentMachine(agent.name, { serverOffline: true });
      if (agent.online !== prevOnline || agent.manualDown !== prevManualDown) changed = true;
    }
    // Reset activity fields so remote agents don't retain stale activeNow: true
    const runtime = ensureAgentRuntimeRecord(agent.name);
    if (runtime) {
      const actReset = setRuntimeActivityFields(runtime, {
        activeNow: false,
        activeDurationSec: 0,
        idleDurationSec: 0,
        lastTmuxActivitySec: null,
      });
      if (actReset) { runtime.updatedAt = Date.now(); changed = true; }
    }
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
  let serversChanged = recordLocalServerObservation(now);
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
    const isLocalServer = isLocalAgentServer(serverId, LOCAL_SERVER_ID);
    const heartbeatAt = Number(server.heartbeatAt) || 0;
    const isOnline = heartbeatAt > 0 && (now - heartbeatAt) <= HEARTBEAT_TTL_MS;
    if (server.online !== isOnline) {
      let affectedAgents = [];
      if (!isOnline) {
        affectedAgents = collectServerAffectedAgents(serverId, server);
        if (clearServerLiveState(server, now)) serversChanged = true;
      } else {
        server.online = true;
        server.updatedAt = now;
        serversChanged = true;
      }
      if (wasOnline && !isOnline && !isLocalServer) {
        if (markAgentsOfflineForServer(serverId, `server-offline:${serverId}`, true)) {
          agentsChanged = true;
        }
        emitServerOfflineAlert(serverId, 'heartbeat-expired', server, affectedAgents);
      }
    }
  }
  if (serversChanged) saveServers();
  if (agentsChanged) saveAgents();
}

// Interrupt, clear the line, type /clear, submit. Inherently an interactive-TUI
// operation, so it is gated on the runtime advertising key support: a headless
// runtime has no prompt to interrupt.
async function injectSlashClear(tmuxTarget) {
  if (!tmuxTarget) return false;
  if (!hostRuntime.capabilities.keys) {
    console.error(`[backend] auto-clear unsupported by the ${hostRuntime.name} runtime`);
    return false;
  }
  // C-c then /clear would interrupt and wipe whatever is in the pane. Refuse
  // outright on a session this install does not own.
  const sessionName = sessionKeyFromTmuxTarget(tmuxTarget);
  const verdict = sessionPolicy.evaluate(sessionName);
  if (!verdict.allowed) {
    console.warn(`[backend] auto-clear refused for ${tmuxTarget}: ${verdict.reason}`);
    return false;
  }
  try {
    const opts = { timeoutMs: 5000 };
    await hostRuntime.sendKeys(tmuxTarget, ['C-c'], opts);
    await new Promise(r => setTimeout(r, 300));
    await hostRuntime.sendKeys(tmuxTarget, ['C-u'], opts);
    await new Promise(r => setTimeout(r, 300));
    await hostRuntime.sendKeys(tmuxTarget, ['/clear'], { ...opts, literal: true });
    await new Promise(r => setTimeout(r, 300));
    await hostRuntime.sendKeys(tmuxTarget, ['Enter'], opts);
    return true;
  } catch (e) {
    console.error(`[backend] auto-clear inject failed for ${tmuxTarget}: ${e.message}`);
    return false;
  }
}

// The runtime returns raw text; hashing is this caller's concern, since the hash
// exists to detect "pane unchanged since last sweep".
async function captureLocalPaneContentAsync(tmuxTarget) {
  if (!tmuxTarget) return null;
  if (!hostRuntime.capabilities.capture) return null;
  const text = await hostRuntime.capturePane(tmuxTarget);
  if (text === null || text === undefined) return null;
  return {
    text,
    hash: createHash('md5').update(text).digest('hex'),
  };
}

// Classification moved to the runtime, since "is this just an idle host?" is a
// per-runtime question. Kept as a named wrapper for readability at the call site.
function isTmuxEmptyServerError(error) {
  return hostRuntime.isEmptyServerError(error);
}

/**
 * Whole-host pane snapshot, indexed the way the liveness sweeps want it.
 *
 * Parsing and the tmux call now live in the runtime; what remains here is
 * backend policy: which fields matter, how paths are normalised, and the
 * session/tty indexes.
 *
 * `runExecFile` is retained as a test seam — passing one builds a runtime around
 * it, so tests can drive this without a live tmux server.
 */
async function buildLocalPaneMetadataSnapshotAsync(runExecFile = null) {
  const runtime = runExecFile ? createTmuxRuntime({ exec: runExecFile }) : hostRuntime;
  const sessions = new Map();
  const ttyToSession = new Map();

  const listing = await runtime.listPanes();
  if (!listing.ok) {
    const error = listing.error;
    return {
      ok: false,
      sessions,
      ttyToSession,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error?.code || null,
        signal: error?.signal || null,
      },
    };
  }

  for (const pane of listing.panes) {
    // A session outside the policy is treated as though it were not on the host:
    // no pane snapshot, so the activity sweep and the dashboard both skip it.
    if (!sessionPolicy.allows(pane.session)) continue;
    ttyToSession.set(pane.tty, pane.session);
    if (sessions.has(pane.session)) continue;
    sessions.set(pane.session, {
      panePid: Number.isFinite(pane.pid) && pane.pid > 1 ? pane.pid : null,
      command: pane.command || '',
      workspacePath: normalizeWorkspacePath(pane.path),
    });
  }
  return {
    ok: true,
    sessions,
    ttyToSession,
    error: null,
    // Propagated so the sweep can tell "tmux was unreachable" from "tmux is idle".
    serverUnavailable: listing.serverUnavailable === true,
    // How many panes tmux reported before the session policy filtered them.
    // Without this an empty snapshot is ambiguous between "tmux returned nothing"
    // and "policy excluded everything", which are very different faults.
    rawPaneCount: listing.panes.length,
  };
}

function buildLocalPaneSnapshotMapFromMetadata(paneMetadataSnapshot) {
  if (paneMetadataSnapshot && paneMetadataSnapshot.sessions instanceof Map) {
    return paneMetadataSnapshot.sessions;
  }
  return new Map();
}

function sessionKeyFromTmuxTarget(tmuxTarget) {
  if (typeof tmuxTarget !== 'string') return '';
  const sessionName = tmuxTarget.split(':', 1)[0].trim();
  if (!sessionName) return '';
  return sessionName.startsWith('=') ? sessionName.slice(1) : sessionName;
}

function readLocalPaneSnapshot(tmuxTarget, paneSnapshotMap = null) {
  if (!tmuxTarget || !(paneSnapshotMap instanceof Map)) return null;
  const sessionName = sessionKeyFromTmuxTarget(String(tmuxTarget));
  if (!sessionName) return null;
  return paneSnapshotMap.get(sessionName) || null;
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
  const blockedObserved = payload.blockedObserved === true;
  const digest = JSON.stringify({
    blocked,
    reason,
    workspacePath: workspacePath || null,
    mcpPresent,
  });
  if (localRuntimeSignalDigest.get(agentName) === digest && !(blocked && blockedObserved)) return;
  localRuntimeSignalDigest.set(agentName, digest);
  const transition = applyRuntimeObservation(agentName, {
    blocked,
    reason,
    tail: blocked && typeof payload.tail === 'string' ? payload.tail : '',
    command: typeof payload.command === 'string' ? payload.command : '',
    workspacePath,
    mcpPresent,
    blockedObserved,
    server: 'local',
    observerSource: 'local-sweep',
    observerServer: 'local',
  });
  dispatchBlockedNotifications(transition);
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


/**
 * How this agent is driven. Recorded on the record at registration; falls back to
 * the framework registry, then to tmux, so records written before transports
 * existed keep their behaviour.
 */
function agentTransport(agent) {
  const declared = typeof agent?.transport === 'string' ? agent.transport.trim().toLowerCase() : '';
  if (declared === 'acp' || declared === 'tmux') return declared;
  return getFramework(agent?.type)?.transport === 'acp' ? 'acp' : 'tmux';
}

/**
 * Liveness for a paneless ACP agent: is the process recorded at launch alive?
 * There is no pane hash to compare and no heartbeat from a relay, because the
 * relay enumerates tmux sessions and this agent has none.
 */
function syncAcpAgentLiveness(agent, runtime) {
  const pid = Number(agent.acpPid) || 0;
  let alive = false;
  if (pid > 1) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }
  let changed = false;
  if (agent.tmux !== null) { agent.tmux = null; changed = true; }
  if (agent.online !== alive) { agent.online = alive; changed = true; }
  const reason = alive ? null : 'acp-process-gone';
  if (agent.offlineReason !== reason) { agent.offlineReason = reason; changed = true; }
  if (changed) agent.lastSeen = Date.now();
  if (runtime && runtime.mcpPresent === undefined) runtime.mcpPresent = null;

  /*
   * FEED THE STATE MACHINE TOO, or the record and the API disagree.
   *
   * `agent.online` above is the persisted record; `serializeAgent` does not read it.
   * It reads getAgentMachine(name), and the tmux sweep is what keeps that machine
   * current — via syncAgentMachine, which this path never called. So a running ACP
   * agent had `online: true` on disk and `online: false` over the API, forever. On a
   * clean host that is the whole picture the console shows: a healthy octos agent,
   * launched and registered and serving a binding, displayed as offline.
   *
   * `heartbeatPresent` is the right signal rather than `tmuxPresent`: an ACP agent
   * has no pane, and its liveness IS the process check just performed. The machine's
   * heartbeat events carry exactly that meaning — the agent is answering — and using
   * the tmux event would make an agent with no pane depend on a pane transition.
   */
  syncAgentMachine(agent.name, alive
    ? { heartbeatPresent: true, manualDown: agent.manualDown === true }
    : { heartbeatMissing: true });

  return changed;
}

async function sweepLocalActivityDurations(paneMetadataSnapshotOverride = null) {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  let runtimeChanged = false;
  let agentsChanged = false;
  const pruneCandidates = new Set();
  const localRuntimeAgents = new Set();
  const paneMetadataSnapshot = paneMetadataSnapshotOverride || await buildLocalPaneMetadataSnapshotAsync();
  if (paneMetadataSnapshot?.ok !== true) {
    if ((nowMs - localTmuxSnapshotWarnAt) >= 60_000) {
      localTmuxSnapshotWarnAt = nowMs;
      const detail = paneMetadataSnapshot?.error?.message || 'unknown tmux query failure';
      console.warn(`[backend] local tmux pane snapshot unavailable; preserving agent state: ${detail}`);
    }
    return;
  }
  const mcpSessions = await getLocalMcpSessionSetAsync(true, paneMetadataSnapshot);
  const paneSnapshotMap = buildLocalPaneSnapshotMapFromMetadata(paneMetadataSnapshot);
  const localRows = [];

  for (const agent of Object.values(agents)) {
    if (!isAgentRecord(agent)) continue;
    const serverId = normalizeServer(agent.server);
    if (!isLocalAgentServer(serverId, LOCAL_SERVER_ID)) continue;
    localRuntimeAgents.add(agent.name);

    const manualDown = agent.manualDown === true;
    const configuredTmux = (typeof agent.tmux === 'string' && agent.tmux.trim()) ? agent.tmux.trim() : null;
    // An ACP agent is a subprocess, not a tmux session: there is no pane to
    // probe, capture or type into. Deriving a pane target for it would mark it
    // tmux-missing on the first sweep and keep it offline forever, which is
    // exactly what "agent equals tmux session" costs once that stops being true.
    const transport = agentTransport(agent);
    const tmuxTarget = transport === 'acp'
      ? null
      : (configuredTmux || (manualDown ? null : `${agent.name}:0.0`));
    const runtime = ensureAgentRuntimeRecord(agent.name);
    if (!runtime) continue;
    if (transport === 'acp') {
      // Liveness for these comes from the process itself, recorded at launch.
      if (syncAcpAgentLiveness(agent, runtime)) agentsChanged = true;
      continue;
    }
    localRows.push({
      agent,
      runtime,
      manualDown,
      tmuxTarget,
    });
  }

  const captureCandidates = localRows
    .filter(row => row.tmuxTarget)
    .map(row => row.agent.name);
  const sampled = resolveLocalActivityCaptureSelection(captureCandidates, LOCAL_ACTIVITY_CAPTURE_BUDGET).selected;

  for (const row of localRows) {
    const { agent, runtime, manualDown, tmuxTarget } = row;
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

    const paneSnapshot = readLocalPaneSnapshot(tmuxTarget, paneSnapshotMap);
    const hasSession = !!paneSnapshot;
    const paneCmd = paneSnapshot?.command || '';
    const workspacePath = paneSnapshot?.workspacePath || null;
    const mcpPresent = hasSession ? mcpSessions.has(agent.name) : null;

    if (!hasSession) {
      let missing = localTmuxMissingState.get(agent.name);
      if (!missing) {
        missing = {
          since: nowMs,
          alerted: false,
          misses: 0,
          wasOnline: agent.online === true,
        };
      }
      missing.misses = Math.max(0, Number(missing.misses) || 0) + 1;
      localTmuxMissingState.set(agent.name, missing);
      if (missing.misses < AGENT_TMUX_MISSING_THRESHOLD) continue;

      applyLocalRuntimeSignals(agent.name, {
        blocked: false,
        reason: null,
        tail: '',
        command: paneCmd,
        workspacePath,
        mcpPresent,
      });
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
      const missingForMs = Math.max(0, nowMs - (Number(missing.since) || nowMs));
      const wasOnline = missing.wasOnline === true;
      const prevLastSeenMs = Number(agent.lastSeen) || 0;
      const seenAgeMs = prevLastSeenMs > 0 ? Math.max(0, nowMs - prevLastSeenMs) : 0;
      const recentEnough = prevLastSeenMs <= 0 || seenAgeMs <= AGENT_TMUX_MISSING_ALERT_MAX_AGE_MS;
      const wasManualDown = manualDown;
      let transitioned = false;
      // online driven by machine via syncAgentMachine below
      const prevOnline = agent.online;
      if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; transitioned = true; }
      if (!wasManualDown && agent.offlineReason !== 'tmux-missing:auto') {
        agent.offlineReason = 'tmux-missing:auto';
        agentsChanged = true;
        transitioned = true;
      }
      syncAgentMachine(agent.name, { tmuxMissing: true });
      if (agent.online !== prevOnline) { agentsChanged = true; transitioned = true; }
      if (transitioned) {
        agent.lastSeen = nowMs;
        // Marking an agent tmux-missing used to be entirely silent, so an agent
        // whose session plainly existed could sit offline with nothing anywhere
        // saying why — the dashboard simply showed an empty fleet. Log the
        // transition once, with what the snapshot actually held, so the next
        // person does not have to reverse-engineer the sweep to find out.
        console.warn(`[backend] agent marked tmux-missing: agent=${agent.name} target=${tmuxTarget} `
          + `rawPanes=${paneMetadataSnapshot.rawPaneCount ?? '?'} `
          + `snapshotSessions=${JSON.stringify([...paneSnapshotMap.keys()])} misses=${missing.misses}`);
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
      autoClearPrevReason.delete(agent.name);
      continue;
    }

    if (!sampled.has(agent.name)) {
      applyLocalMetadataOnlySignals(agent.name, {
        workspacePath,
        mcpPresent,
      });
      localTmuxMissingState.delete(agent.name);
      if (syncLocalAgentOnlineState(agent, runtime, tmuxTarget, manualDown)) {
        agentsChanged = true;
      }
      autoClearPrevReason.delete(agent.name);
      continue;
    }

    const paneCapture = await captureLocalPaneContentAsync(tmuxTarget);
    if (!paneCapture?.hash) {
      applyLocalMetadataOnlySignals(agent.name, {
        workspacePath,
        mcpPresent,
      });
      localTmuxMissingState.delete(agent.name);
      if (syncLocalAgentOnlineState(agent, runtime, tmuxTarget, manualDown)) {
        agentsChanged = true;
      }
      autoClearPrevReason.delete(agent.name);
      continue;
    }

    const paneHash = paneCapture.hash;
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

    // Auto-clear: when api-image-error is newly detected, inject /clear to recover
    const prevBlockedReason = autoClearPrevReason.get(agent.name) || null;
    autoClearPrevReason.set(agent.name, blockedReason);
    if (blockedReason === 'api-image-error' && prevBlockedReason !== 'api-image-error') {
      const now = Date.now();
      const lastClear = autoClearLastTs.get(agent.name) || 0;
      if ((now - lastClear) > AUTO_CLEAR_COOLDOWN_MS) {
        console.warn(`[backend] auto-clear: agent ${agent.name} stuck on api-image-error, injecting /clear to ${tmuxTarget}`);
        injectSlashClear(tmuxTarget).then(ok => {
          if (ok) autoClearLastTs.set(agent.name, Date.now());
        });
      }
    }

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

    if (syncLocalAgentOnlineState(agent, runtime, tmuxTarget, manualDown)) {
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

async function readLocalSwapUsageSnapshot() {
  try {
    const raw = await readFileAsync('/proc/meminfo', 'utf-8');
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

async function sweepLocalSwapPressure() {
  const snap = await readLocalSwapUsageSnapshot();
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
        ].join('\n'),
        'swap_high',
        {
          dedupeKey: 'swap_high',
          owner: 'host-runtime',
          runbook: 'docs/runbooks/swap-high.md',
          impact: 'high swap usage can stall or kill local agent processes',
          recoveryCondition: `swap usage falls to or below ${SWAP_ALERT_CLEAR_PCT.toFixed(1)}% and swap_clear auto-resolves this alert`,
          correlation: {
            dedupeKey: 'swap_high',
            host: 'local',
            thresholdPct: SWAP_ALERT_THRESHOLD_PCT,
            clearPct: SWAP_ALERT_CLEAR_PCT,
          },
        }
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
      ].join('\n'),
      'swap_clear',
      { dedupeKey: 'swap_clear' }
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

async function scopeUnitForPid(pid) {
  const n = Number.parseInt(pid, 10);
  if (!Number.isFinite(n) || n <= 1) return null;
  try {
    const raw = await readFileAsync(`/proc/${n}/cgroup`, 'utf-8');
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

async function buildLocalPanePidMapAsync() {
  const out = new Map();
  const snapshotMap = buildLocalPaneSnapshotMapFromMetadata(await buildLocalPaneMetadataSnapshotAsync());
  for (const [session, snapshot] of snapshotMap.entries()) {
    const panePid = Number(snapshot?.panePid || 0);
    if (!session || !Number.isFinite(panePid) || panePid <= 1) continue;
    if (!out.has(session)) out.set(session, panePid);
  }
  return out;
}

function parseSystemdMemoryValue(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'infinity' || text === 'max') return 0;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readAgentScopeMemory(agentName, panePidMap = null) {
  const agent = agents[agentName];
  const tmuxTarget = (typeof agent?.tmux === 'string' && agent.tmux.trim())
    ? agent.tmux.trim()
    : `${agentName}:0.0`;
  const sessionName = sessionKeyFromTmuxTarget(tmuxTarget) || agentName;
  const panePid = (panePidMap instanceof Map) ? panePidMap.get(sessionName) : null;
  const unit = (await scopeUnitForPid(panePid)) || scopeUnitForAgent(agentName);
  if (!unit) return null;
  try {
    const env = USER_RUNTIME_DIR && USER_DBUS_SESSION_BUS
      ? { ...process.env, XDG_RUNTIME_DIR: USER_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: USER_DBUS_SESSION_BUS }
      : process.env;
    const { stdout: out } = await execFileAsync(
      'systemctl',
      ['--user', 'show', unit, '--property=ActiveState', '--property=MemoryCurrent', '--property=MemoryHigh', '--value', '--no-pager'],
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
  const queuePath = new URL(PUSH_QUEUE_URL).pathname;
  fetchWebBridge(PUSH_QUEUE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      from: 'hafleet-backend',
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
  }, `pushResourceAlertToAgent() POST ${queuePath} agent=${agentName}`).catch((e) => {
    console.warn(`[scope-alert] queue push failed for ${agentName}: ${e.message}`);
  });
}

function formatBytesGiB(bytes) {
  return (bytes / (1024 ** 3)).toFixed(2);
}

async function sweepAgentScopePressure() {
  if (!AGENT_SCOPE_MONITOR_ENABLED) return;
  const now = Date.now();
  const panePidMap = await buildLocalPanePidMapAsync();
  const localAgentNames = Object.values(agents)
    .filter(isAgentRecord)
    .filter(agent => {
      const serverId = normalizeServer(agent.server);
      return isLocalAgentServer(serverId, LOCAL_SERVER_ID);
    })
    .map(agent => agent.name);

  const activeSet = new Set(localAgentNames);
  for (const key of [...scopePressureState.keys()]) {
    if (!activeSet.has(key)) scopePressureState.delete(key);
  }

  for (const agentName of localAgentNames) {
    const scope = await readAgentScopeMemory(agentName, panePidMap);
    const prev = scopePressureState.get(agentName) || { high: false };
    if (!scope) {
      if (prev.high) scopePressureState.set(agentName, { high: false });
      continue;
    }

    const ratio = scope.memoryCurrent / scope.memoryHigh;
    const highNow = ratio >= 1;

    if (highNow) {
      if (!prev.high) scopePressureState.set(agentName, { high: true });
      const summary = `agent=${agentName} unit=${scope.unit} memoryHigh exceeded (${formatBytesGiB(scope.memoryCurrent)}GiB / ${formatBytesGiB(scope.memoryHigh)}GiB, ${(ratio * 100).toFixed(1)}%)`;
      const result = notificationRouter.emit('resource_alert', {
        agentName,
        summary: `Agent '${agentName}' memory high exceeded`,
        full: summary,
      });
      if (result.accepted) pushResourceAlertToAgent(agentName, summary);
      continue;
    }

    const clearNow = ratio <= AGENT_SCOPE_ALERT_CLEAR_RATIO;
    if (prev.high && clearNow) {
      scopePressureState.set(agentName, { high: false });
      notificationRouter.emit('resource_alert', {
        agentName,
        summary: `Agent '${agentName}' memory pressure recovered`,
        full: `agent=${agentName} unit=${scope.unit} current=${formatBytesGiB(scope.memoryCurrent)}GiB high=${formatBytesGiB(scope.memoryHigh)}GiB (${(ratio * 100).toFixed(1)}%)`,
      }, { bypassCooldown: true });
    }
  }
}

function runAsyncSweep(label, fn, stateKey) {
  if (stateKey === 'localActivity' && localActivitySweepRunning) return;
  if (stateKey === 'localSwap' && localSwapSweepRunning) return;
  if (stateKey === 'agentScope' && agentScopeSweepRunning) return;
  if (stateKey === 'supervisorLifecycle' && supervisorLifecycleSweepRunning) return;
  if (stateKey === 'projectSides' && projectSideSweepRunning) return;

  if (stateKey === 'localActivity') localActivitySweepRunning = true;
  if (stateKey === 'localSwap') localSwapSweepRunning = true;
  if (stateKey === 'agentScope') agentScopeSweepRunning = true;
  if (stateKey === 'supervisorLifecycle') supervisorLifecycleSweepRunning = true;
  if (stateKey === 'projectSides') projectSideSweepRunning = true;

  Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.error(`[${label}] ${error?.message || error}`);
    })
    .finally(() => {
      if (stateKey === 'localActivity') localActivitySweepRunning = false;
      if (stateKey === 'localSwap') localSwapSweepRunning = false;
      if (stateKey === 'agentScope') agentScopeSweepRunning = false;
      if (stateKey === 'supervisorLifecycle') supervisorLifecycleSweepRunning = false;
      if (stateKey === 'projectSides') projectSideSweepRunning = false;
    });
}

function countLocalSweepAgents() {
  let count = 0;
  for (const agent of Object.values(agents)) {
    if (!isAgentRecord(agent) || agent.kind === 'human') continue;
    const serverId = normalizeServer(agent.server);
    if (!isLocalAgentServer(serverId, LOCAL_SERVER_ID)) continue;
    count += 1;
  }
  return count;
}

export function computeAdaptiveSweepIntervalMs(baseIntervalMs, agentCount = 0) {
  const normalizedBase = Number.isFinite(Number(baseIntervalMs)) && Number(baseIntervalMs) > 0
    ? Math.floor(Number(baseIntervalMs))
    : 5000;
  const normalizedAgentCount = Math.max(0, Number.parseInt(agentCount, 10) || 0);
  return Math.max(normalizedBase, normalizedAgentCount * AGENT_SWEEP_INTERVAL_PER_AGENT_MS);
}

function scheduleAdaptiveSweepLoop(label, fn, stateKey, baseIntervalMs) {
  const tick = () => {
    if (!backgroundLoopsStarted) return;
    runAsyncSweep(label, fn, stateKey);
    const nextDelay = computeAdaptiveSweepIntervalMs(baseIntervalMs, countLocalSweepAgents());
    trackLifecycleTimeout(tick, nextDelay, { unref: true });
  };
  const initialDelay = computeAdaptiveSweepIntervalMs(baseIntervalMs, countLocalSweepAgents());
  trackLifecycleTimeout(tick, initialDelay, { unref: true });
}

function getAgentDeliveryState(name) {
  const agent = agents[name];
  if (!agent || !isAgentRecord(agent)) {
    return { exists: false, online: false, healthy: false, server: null, serverOnline: false, lastSeen: null, offlineReason: 'not-agent' };
  }
  const machine = getAgentMachine(name);
  const agentOnline = machine.online;
  const serverId = normalizeServer(agent.server);
  let serverOnline = true;
  let serverLastSeen = null;
  if (serverId && !isLocalAgentServer(serverId, LOCAL_SERVER_ID)) {
    const server = servers[serverId];
    if (server) {
      serverOnline = Boolean(server.online);
      serverLastSeen = server.lastSeen || null;
    } else {
      serverOnline = agentOnline;
    }
  }
  const online = agentOnline && serverOnline;
  return {
    exists: true,
    online,
    healthy: machine.healthy && serverOnline,
    agentOnline,
    server: serverId,
    serverOnline,
    lastSeen: agent.lastSeen || null,
    serverLastSeen,
    offlineReason: agent.offlineReason || null,
  };
}

function serializeAgent(agent) {
  const deliveryState = getAgentDeliveryState(agent.name);
  const runtime = ensureAgentRuntimeRecord(agent.name);
  const machine = getAgentMachine(agent.name);
  return {
    ...agent,
    server: normalizeServer(agent.server),
    state: machine.state,
    healthy: machine.healthy,
    online: deliveryState.online,
    agentOnline: deliveryState.agentOnline,
    serverOnline: deliveryState.serverOnline,
    lastSeen: deliveryState.lastSeen,
    serverLastSeen: deliveryState.serverLastSeen,
    offlineReason: deliveryState.offlineReason,
    manualDown: agent.manualDown === true,
    blocked: runtime?.blocked === true,
    blockedReason: runtime?.blockedReason || null,
    blockedTier: normalizeBlockedTier(runtime?.blockedTier, null),
    blockedSince: runtime?.blockedSince || null,
    agentModelVersion: normalizeAgentModelVersion(agent.agentModelVersion) || null,
    layoutVersion: normalizeLayoutVersion(agent.layoutVersion) || null,
    agentId: normalizeAgentId(agent.agentId) || null,
    homeDir: normalizeWorkspacePath(agent.homeDir) || null,
    workdir: normalizeWorkspacePath(agent.workdir) || null,
    stateDir: normalizeWorkspacePath(agent.stateDir) || null,
    managedProjects: normalizeManagedProjects(agent.managedProjects),
    human: normalizeHumanMeta(agent.human),
    task: normalizeAgentTask(agent.task, agent.name),
    runtimeProfile: redactRuntimeProfileSecrets(normalizeRuntimeProfile(agent.runtimeProfile)),
    environment: VALID_ENVIRONMENTS.has(agent.environment) ? agent.environment : classifyEnvironment(agent.name),
    activeNow: normalizeRuntimeActiveNow(runtime?.activeNow),
    activeDurationSec: Number(runtime?.activeDurationSec) || 0,
    idleDurationSec: Number(runtime?.idleDurationSec) || 0,
    lastTmuxActivitySec: Number(runtime?.lastTmuxActivitySec) || null,
    workspacePath: runtime?.workspacePath || null,
    // Where it last ran, retained after it stops. Metering reads this; see
    // setRuntimeWorkspacePath.
    lastWorkspacePath: runtime?.lastWorkspacePath || runtime?.workspacePath || null,
    runtimeObservation: serializeRuntimeObservation(runtime),
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
  server.version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : (server.version || 'unknown-legacy');
  // Version-mismatch detection
  if (LOCAL_GIT_VERSION && server.version && server.version !== 'unknown-legacy' && server.version !== LOCAL_GIT_VERSION) {
    if (!server.versionMismatchSince) { server.versionMismatchSince = now; }
    const mismatchAge = now - server.versionMismatchSince;
    if (mismatchAge > 300_000) { // >5 minutes
      console.warn(`[version] server '${serverId}' version mismatch: remote=${server.version} local=${LOCAL_GIT_VERSION} (${Math.round(mismatchAge / 60_000)}m)`);
    }
  } else {
    if (server.versionMismatchSince) { server.versionMismatchSince = null; }
  }
  server.sessions = sessions;
  server.agents = liveAgents;
  server.agentCount = liveAgents.length;

  if (!wasOnline) {
    resolveServerOfflineAlert(serverId);
  }
  if (lease.takeover) {
    emitSystemInfo(
      `Remote server '${serverId}' heartbeat instance switched`,
      `Server '${serverId}' lease takeover: reason=${lease.reason}, instanceId=${incomingInstanceId || 'unknown'}, bootTs=${incomingBootTs || 0}.`,
      'server_takeover',
      { dedupeKey: `server_takeover:${serverId}` }
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
    if (ensured.created) {
      agentsChanged = true;
      // Adopting a session as an agent was completely silent, so a tmux session
      // that had nothing to do with HAFleet became a permanent agent record with
      // no trace of when or why. A throwaway session created to check something
      // by hand was adopted within one heartbeat and outlived the session itself.
      // Say so, and record it where an operator will actually see it.
      console.warn(`[backend] adopted tmux session as a new agent: ${name} (server=${serverId})`);
      emitSystemInfo(
        `Adopted tmux session '${name}' as an agent`,
        `Server '${serverId}' reported session '${name}', which had no agent record, so one was created. `
          + 'HAFleet can now type into that pane. If it does not belong to HAFleet, add it to '
          + 'HAFLEET_SESSION_DENYLIST (or set HAFLEET_SESSION_ALLOWLIST) and remove the record with '
          + 'bin/hafleet-prune-agents.',
        'agent_adopted',
        { dedupeKey: `agent_adopted:${serverId}:${name}` }
      );
    }
    if (!isAgentRecord(agent)) {
      agent.kind = 'agent';
      if (!Number(agent.registeredAt)) agent.registeredAt = now;
      agentsChanged = true;
    }
    if (normalizeServer(agent.server) !== serverId) { agent.server = serverId; agentsChanged = true; }
    // Never fabricate a pane target for a paneless agent. This backfill exists so a
    // tmux agent that registered without one still gets swept, but it ran before the
    // ACP guard further down and so handed every ACP agent a tmux target it does not
    // have. The dashboard then routed it as a tmux agent and asked getPaneIdleMs for a
    // pane that cannot exist, which reported idleMs -1 forever while the agent was
    // plainly reporting activity.
    if (!agent.tmux && agentTransport(agent) !== 'acp') { agent.tmux = `${name}:0.0`; agentsChanged = true; }
    const wasAgentOnline = agent.online === true;
    const runtime = ensureAgentRuntimeRecord(name);
    // Drive online/manualDown through machine
    syncAgentMachine(name, {
      heartbeatPresent: true,
      manualDown: false,
      mcpPresent: runtime?.mcpPresent === true ? true : (runtime?.mcpPresent === false ? false : undefined),
    });
    if (!wasAgentOnline && agent.online) becameOnline.push(name);
    if (agent.online !== wasAgentOnline) agentsChanged = true;
    // offlineReason (non-machine field)
    const mcpMissing = runtime?.mcpPresent === false;
    if (!mcpMissing) {
      if (agent.offlineReason !== null) { agent.offlineReason = null; agentsChanged = true; }
    } else if (agent.offlineReason !== 'mcp-missing:auto') {
      agent.offlineReason = 'mcp-missing:auto';
      agentsChanged = true;
    }
    if (agent.lastSeen !== now) { agent.lastSeen = now; agentsChanged = true; }
  }

  for (const agent of Object.values(agents)) {
    if (normalizeServer(agent.server) !== serverId) continue;
    if (liveSet.has(agent.name)) continue;
    // The relay builds this list by enumerating tmux sessions, so a paneless ACP
    // agent is never in it. Treating that absence as heartbeat-missing marked
    // every ACP agent offline within one beat, undoing what the sweep had just
    // concluded from its live process. The sweep owns liveness for these.
    if (agentTransport(agent) === 'acp') continue;
    const wasOnline = agent.online === true;
    const wasManualDown = agent.manualDown === true;
    const reason = `heartbeat-missing:${serverId}`;
    if (agent.offlineReason !== reason) { agent.offlineReason = reason; agentsChanged = true; }
    if (agent.tmux !== null) { agent.tmux = null; agentsChanged = true; }
    // online/manualDown driven by machine
    syncAgentMachine(agent.name, { heartbeatMissing: true });
    if (agent.online !== wasOnline || agent.manualDown !== wasManualDown) agentsChanged = true;
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
async function collectLocalMcpSessionsAsync(paneMetadataSnapshot = null) {
  try {
    const ptsMap = (paneMetadataSnapshot && paneMetadataSnapshot.ttyToSession instanceof Map)
      ? paneMetadataSnapshot.ttyToSession
      : (await buildLocalPaneMetadataSnapshotAsync()).ttyToSession;
    if (!ptsMap.size) return new Set();
    let pids;
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', 'node.*mcp-server.js'], { timeout: 3000, encoding: 'utf-8' });
      pids = stdout.trim().split('\n').filter(Boolean);
    } catch {
      return new Set();
    }
    if (!pids.length) return new Set();
    const matched = new Set();
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], {
        timeout: 3000,
        encoding: 'utf-8',
      });
      const psOut = stdout.trim();
      if (!psOut) return matched;
      for (const line of psOut.split('\n')) {
        const parts = line.trim().split(/\s+/, 2);
        if (parts.length < 2) continue;
        const pts = parts[1].trim();
        if (!pts || pts === '?') continue;
        const session = ptsMap.get(pts) || null;
        if (session) matched.add(session);
      }
    } catch {
      return new Set();
    }
    return matched;
  } catch {
    return new Set();
  }
}

async function getLocalMcpSessionSetAsync(forceRefresh = false, paneMetadataSnapshot = null) {
  const now = Date.now();
  if (!forceRefresh && (now - localMcpSessionCacheAt) <= LOCAL_MCP_SESSION_CACHE_TTL_MS) {
    return localMcpSessionCache;
  }
  localMcpSessionCache = await collectLocalMcpSessionsAsync(paneMetadataSnapshot);
  localMcpSessionCacheAt = now;
  return localMcpSessionCache;
}

async function agentHasMcpAsync(agentName) {
  if (!agentName) return false;
  const sessions = await getLocalMcpSessionSetAsync(false);
  return sessions.has(agentName);
}

async function localTmuxSessionExistsAsync(sessionName) {
  if (!hostRuntime.capabilities.sessions) return false;
  return hostRuntime.sessionExists(sessionName);
}

const mergedPushInboxCursor = new Map();
const catchupCursor = new Map();
const catchupPushCursor = new Map();
const pushNotifySkipLog = new Map();
const SYSTEM_CATCHUP_SCHEMA_KIND = 'system_catchup';
const SYSTEM_TASK_ASSIGNED_SCHEMA_KIND = 'system_task_assigned';

function isSystemCatchupMessage(msg) {
  return normalizeOptionalText(msg?.schema?.kind, 128) === SYSTEM_CATCHUP_SCHEMA_KIND;
}

function catchupKeyFromMessage(msg) {
  if (!isSystemCatchupMessage(msg)) return null;
  const latestId = normalizeOptionalText(msg?.schema?.payload?.latestId, 256);
  const sourceUnreadCount = Number(msg?.schema?.payload?.sourceUnreadCount || 0);
  if (!latestId || !Number.isFinite(sourceUnreadCount) || sourceUnreadCount <= 0) return null;
  return `${latestId}:${sourceUnreadCount}`;
}

function findCatchupMessageForKey(agentName, key) {
  const normalizedAgent = normalizeAgentName(agentName);
  if (!normalizedAgent || !key) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.to !== normalizedAgent) continue;
    if (catchupKeyFromMessage(msg) === key) return msg;
  }
  return null;
}

function pushNotifyStatus({ queued = false, terminal = false, deduped = false, reason = null } = {}) {
  return {
    ok: queued || terminal || deduped,
    queued,
    terminal,
    deduped,
    reason,
  };
}

function isCatchupNotificationComplete(result) {
  return result?.queued === true || result?.terminal === true || result?.deduped === true;
}

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
  const queueClearPath = `/api/queue/agents/${encodeURIComponent(agentName)}/notifications`;
  fetchWebBridge(`${WEB_BASE_URL}${queueClearPath}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
  }, `clearQueuedNotificationsForAgent() DELETE ${queueClearPath} agent=${agentName}`)
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

  const { unread: rawUnread } = getUnreadInboxMessages(agentName);
  const unread = rawUnread.filter((msg) => !isSystemCatchupMessage(msg));
  if (!unread.length) return;

  const oldest = unread[0];
  const latest = unread[unread.length - 1];
  const key = `${latest.id}:${unread.length}`;
  if (catchupCursor.get(agentName) === key && catchupPushCursor.get(agentName) === key) return;
  const existingCatchup = findCatchupMessageForKey(agentName, key);
  if (existingCatchup) {
    catchupCursor.set(agentName, key);
    const result = await pushNotify(agentName, existingCatchup);
    if (isCatchupNotificationComplete(result)) catchupPushCursor.set(agentName, key);
    return;
  }
  if (catchupCursor.get(agentName) === key) {
    catchupCursor.delete(agentName);
    catchupPushCursor.delete(agentName);
  }

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
    'FIRST ACTION: call check_inbox() now. Use check_inbox() in hafleet MCP for full context before acting.',
  ].filter(Boolean).join('\n');

  const idReservation = reserveNextMsgId();
  if (!idReservation.ok) {
    console.warn(`[catchup] failed to reserve message id for ${agentName}: ${idReservation.error || 'unknown error'}`);
    return;
  }

  const msg = {
    id: idReservation.id,
    ts: Date.now(),
    from: 'system',
    to: agentName,
    group: null,
    type: 'inform',
    priority: 'normal',
    summary,
    full,
    mentions: [],
    reply_to: null,
    source: 'system',
    viewToken: createMessageViewToken(),
    schema: {
      kind: SYSTEM_CATCHUP_SCHEMA_KIND,
      version: 1,
      payload: {
        reason,
        sourceUnreadCount: unread.length,
        sourceUnreadIds: unread.map((m) => m.id).filter(Boolean),
        oldestId: oldest.id,
        latestId: latest.id,
      },
    },
  };
  const persisted = persistNewMessage(msg);
  if (!persisted.ok) {
    console.warn(`[catchup] failed to persist catchup message for ${agentName}: ${persisted.error || 'unknown error'}`);
    return;
  }
  appendDeliveryEvent({
    type: 'message.accepted',
    source: 'backend',
    messageId: msg.id,
    agent: agentName,
    targetAgents: [agentName],
    priority: msg.priority,
    context: {
      from: msg.from,
      to: msg.to,
      type: msg.type,
      reason,
      catchupUnreadCount: unread.length,
    },
  });
  broadcastSSE('message', { ...msg, deliveryOwner: 'dashboard-queue' });
  catchupCursor.set(agentName, key);
  const result = await pushNotify(agentName, msg);
  if (isCatchupNotificationComplete(result)) catchupPushCursor.set(agentName, key);
}

export function buildMcpReplyActionHint(msg, replyTo = null) {
  // Delegates to lib/reply-hint.js so the ACP host applies the same rule. It did
  // not: it told its agent to reply unconditionally, so one `hafleet tell` task
  // produced silence from claude and codex and a message from octos.
  return buildReplyHint(msg, replyTo);
}

async function pushNotify(agentName, msg, options = {}) {
  const agent = agents[agentName];
  // An ACP agent has no pane, and its session is held by a separate host process
  // (scripts/hafleet-acp-agent.mjs) that this process cannot reach into. So the
  // backend does not push to it — the host pulls, by polling the same inbox
  // endpoint check_inbox uses, and prompts the agent over session/prompt.
  //
  // Reporting this as 'missing-tmux-target' was wrong twice over: it read as a
  // broken tmux agent, and pushNotifyStatus turned it into ok:false while
  // POST /api/messages still answered {"ok":true,"warnings":[]}. A message to an
  // ACP agent looked sent, was never delivered, and nothing said otherwise.
  // 'acp-pull-pending' is terminal-but-fine: the backend's obligation ends here.
  if (!agent?.tmux && agentTransport(agent) === 'acp') {
    appendDeliveryEvent({
      type: 'push.pull_pending',
      source: 'backend',
      messageId: msg?.id,
      messageIds: msg?.id ? [msg.id] : [],
      agent: agentName,
      reason: 'acp-pull-pending',
    });
    return pushNotifyStatus({ terminal: true, reason: 'acp-pull-pending' });
  }
  if (!agent?.tmux) {
    logPushNotifySkip(agentName, 'missing-tmux-target');
    appendDeliveryEvent({
      type: 'push.not_queued',
      source: 'backend',
      messageId: msg?.id,
      messageIds: msg?.id ? [msg.id] : [],
      agent: agentName,
      reason: 'missing-tmux-target',
    });
    return pushNotifyStatus({ reason: 'missing-tmux-target' });
  }
  const agentServer = normalizeServer(agent.server);
  if (agentServer && !isLocalAgentServer(agentServer, LOCAL_SERVER_ID)) {
    logPushNotifySkip(agentName, 'remote-relay-expected', `(server=${agentServer})`);
    appendDeliveryEvent({
      type: 'push.not_queued',
      source: 'backend',
      messageId: msg?.id,
      messageIds: msg?.id ? [msg.id] : [],
      agent: agentName,
      target: agent.tmux,
      reason: 'remote-relay-expected',
      context: { server: agentServer },
    });
    return pushNotifyStatus({ terminal: true, reason: 'remote-relay-expected' });
  }
  // If server is unknown (null), verify the tmux session exists locally before queueing
  if (!agentServer) {
    const sess = agent.tmux.split(':')[0];
    const hasSession = await localTmuxSessionExistsAsync(sess);
    if (!hasSession) {
      logPushNotifySkip(agentName, 'local-session-not-found', `(tmux=${agent.tmux})`);
      appendDeliveryEvent({
        type: 'push.not_queued',
        source: 'backend',
        messageId: msg?.id,
        messageIds: msg?.id ? [msg.id] : [],
        agent: agentName,
        target: agent.tmux,
        reason: 'local-session-not-found',
      });
      // The tmux session may belong to a remote agent before heartbeat attribution catches up.
      return pushNotifyStatus({ reason: 'local-session-not-found' });
    }
  }
  const isHumanMsg = msg.type === 'human';
  const hasMcp = await agentHasMcpAsync(agentName);
  const { inboxTs, unread: rawUnread } = getUnreadInboxMessages(agentName);
  const unread = isSystemCatchupMessage(msg)
    ? rawUnread.filter((item) => !isSystemCatchupMessage(item))
    : rawUnread;
  const unreadCount = unread.length;
  const latestUnread = unread[unread.length - 1] || msg;
  const unreadMessageIds = unread.map((item) => item?.id).filter(Boolean);
  const pushSourceMsgId = latestUnread?.id || msg?.id || null;
  const pushMessageIds = unreadMessageIds.length ? unreadMessageIds : (msg?.id ? [msg.id] : []);
  const replyTo = latestUnread.from || msg.from;
  const notificationPriority = unreadCount > 1 ? highestMessagePriority(unread) : normalizeMessagePriority(msg?.priority);

  // Determine if reply is expected based on message type
  const needsReply = msg.type === 'human' || msg.type === 'request';
  let notificationKind = 'single_inform';
  let requiresInboxCheck = false;
  let hasHumanUnread = false;
  let hasRequestUnread = false;

  let notification;
  let mergedDedupeKeyToCommit = null;
  if (unreadCount > 1) {
    const dedupeKey = `${inboxTs}:${latestUnread.id || 'none'}:${unreadCount}`;
    if (!isHumanMsg && mergedPushInboxCursor.get(agentName) === dedupeKey) {
      return pushNotifyStatus({ deduped: true, reason: 'merged-unread-deduped' });
    }
    mergedDedupeKeyToCommit = dedupeKey;

    const senderNames = [...new Set(unread.map(m => m.from).filter(Boolean))];
    const senderText = senderNames.length ? ` (from ${formatSenderList(senderNames)})` : '';
    const hasHuman = unread.some(m => m.type === 'human');
    const hasRequest = unread.some(m => m.type === 'request');
    const actionableUnread = hasHuman || hasRequest;
    hasHumanUnread = hasHuman;
    hasRequestUnread = hasRequest;
    notificationKind = actionableUnread ? 'merged_unread_actionable' : 'merged_unread_inform';
    requiresInboxCheck = hasMcp && actionableUnread;
    const hasOperatorHuman = unread.some(m => m.type === 'human' && m.trustLevel === 'operator');
    const hasNonMatrixHuman = unread.some(m => m.type === 'human' && m.source !== 'matrix');
    const humanHint = hasHuman
      ? (hasOperatorHuman || hasNonMatrixHuman ? ' This includes messages from your human operator.' : ' This includes human messages (via Matrix).')
      : '';
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
    const safeSummary = sanitizeForDisplay(msg.summary);
    const isMatrix = msg.source === 'matrix';
    const isOperator = msg.trustLevel === 'operator';
    const humanTag = isHuman ? (isMatrix && !isOperator ? ' (via Matrix)' : ' (human)') : '';
    const operatorHint = isHuman && (isOperator || !isMatrix) ? ' This is your human operator.' : '';

    if (hasMcp) {
      const checkHint = `FIRST ACTION: call check_inbox() now. Use check_inbox() in hafleet MCP for full context before acting.`;
      const actionHint = needsReply ? buildMcpReplyActionHint(msg, replyTo) : null;
      notificationKind = needsReply ? 'single_actionable' : 'single_inform';
      requiresInboxCheck = needsReply;
      notification = isHuman
        ? `[NOTIFICATION] From ${msg.from}${humanTag}: "${safeSummary}".${operatorHint} ${checkHint} ${actionHint}.`
        : needsReply
          ? `[NOTIFICATION] From ${msg.from}: "${safeSummary}". ${checkHint} ${actionHint}.`
          : `[NOTIFICATION] From ${msg.from}: "${safeSummary}".`;
    } else {
      const senderAgent = agents[replyTo];
      const senderTmux = senderAgent?.tmux || `${replyTo}:0.0`;
      let actionHint;
      if (needsReply) {
        actionHint = `Reply after ALL WORK is done, using /agent-message skill or: hafleet-send ${senderTmux} "<your reply>"`;
      }
      notificationKind = needsReply ? 'single_actionable' : 'single_inform';
      requiresInboxCheck = false;
      notification = isHuman
        ? `[NOTIFICATION] From ${msg.from}${humanTag}: "${safeSummary}".${operatorHint} ${actionHint}.`
        : needsReply
          ? `[NOTIFICATION] From ${msg.from}: "${safeSummary}". ${actionHint}.`
          : `[NOTIFICATION] From ${msg.from}: "${safeSummary}".`;
    }
  }

  try {
    const notifyMeta = {
      kind: notificationKind,
      priority: notificationPriority || 'normal',
      requiresInboxCheck,
      sourceMsgId: pushSourceMsgId,
      messageIds: pushMessageIds,
      unreadCount,
      hasHumanUnread,
      hasRequestUnread,
      needsReply,
      hasMcp,
    };
    const queuePath = new URL(PUSH_QUEUE_URL).pathname;
    const resp = await fetchWebBridge(PUSH_QUEUE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(WEB_BRIDGE_FETCH_TIMEOUT_MS),
      body: JSON.stringify({ from: 'hafleet-backend', to: agent.tmux, payload: notification, priority: notificationPriority || 'normal', notifyMeta }),
    }, `pushNotify() POST ${queuePath} agent=${agentName}`);
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      appendDeliveryEvent({
        type: 'push.queued',
        source: 'backend',
        messageId: notifyMeta.sourceMsgId,
        messageIds: notifyMeta.messageIds,
        agent: agentName,
        target: agent.tmux,
        queueEntryId: body?.id,
        queuedAt: body?.queuedAt,
        priority: notificationPriority || 'normal',
        notifyMeta,
      });
      markAgentPushNotified(agentName, {
        queueEntryId: body?.id,
        queuedAt: body?.queuedAt,
        ...notifyMeta,
      });
      if (mergedDedupeKeyToCommit) mergedPushInboxCursor.set(agentName, mergedDedupeKeyToCommit);
      return pushNotifyStatus({ queued: true });
    } else {
      appendDeliveryEvent({
        type: 'push.queue_failed',
        source: 'backend',
        messageId: notifyMeta.sourceMsgId,
        messageIds: notifyMeta.messageIds,
        agent: agentName,
        target: agent.tmux,
        priority: notificationPriority || 'normal',
        reason: `status-${resp.status}`,
        status: resp.status,
        notifyMeta,
      });
      return pushNotifyStatus({ reason: `status-${resp.status}` });
    }
  } catch (e) {
    appendDeliveryEvent({
      type: 'push.queue_failed',
      source: 'backend',
      messageId: pushSourceMsgId,
      messageIds: pushMessageIds,
      agent: agentName,
      target: agent.tmux,
      priority: notificationPriority || 'normal',
      reason: e?.message || 'queue request failed',
    });
    console.error(`Push notify failed for ${agentName}:`, e.message);
    return pushNotifyStatus({ reason: e?.message || 'queue request failed' });
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
app.use('/api', createApiAuthMiddleware({
  apiToken: API_TOKEN,
  isLocalRequest,
}));

app.post('/api/delivery-events', (req, res) => {
  const result = appendDeliveryEvent({
    ...(req.body || {}),
    source: normalizeOptionalText(req.body?.source, 128) || 'external',
  });
  if (!result.ok) return res.status(400).json({ error: result.error || 'invalid delivery event' });
  res.json({ ok: true, event: result.event });
});

// ── Health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  refreshServerLiveness();
  const serverRows = Object.values(servers);
  const onlineServers = serverRows.filter(s => s.online).length;
  const agentNames = Object.keys(agents).filter(name => isAgentRecord(agents[name]));
  const onlineAgents = agentNames.filter(name => getAgentDeliveryState(name).online).length;
  const agentTokenReadiness = buildAgentTokenReadiness();
  const serverCredentialReadiness = buildServerCredentialReadiness();
  res.json({
    ok: true,
    agents: agentNames.length,
    onlineAgents,
    servers: serverRows.length,
    onlineServers,
    messages: messages.length,
    auth: {
      agentTokens: agentTokenReadiness,
      serverCredential: serverCredentialReadiness,
    },
    health: buildFlowHealth({
      serverRows,
      agentNames,
      agentTokenReadiness,
      serverCredentialReadiness,
      heartbeatTtlMs: HEARTBEAT_TTL_MS,
      isServerInMaintenance,
      getAgentDeliveryState,
      getAgentRuntime: (name) => agentRuntime[name],
      getAgentRuntimeRows: () => Object.values(agentRuntime).filter(row => row && typeof row === 'object'),
      listAlerts: () => alertStore.dump(),
      readDeliveryEvents,
      messageCount: messages.length,
    }),
  });
});

// ── Supervisor audit (v2 — per-agent supervisor snapshot store) ───────
const _tokenFromSupervisorTarget = r => `supervisor-${r.params?.target || ''}`;
function respondSupervisorSnapshotError(res, error, fallbackMessage) {
  if (error.code === 'snapshot_persistence_failed') return res.status(503).json({ error: error.message });
  if (error.code) return res.status(400).json({ error: error.message });
  return res.status(500).json({ error: fallbackMessage });
}

app.patch('/api/supervisor-state/:target', requireAgentToken(_tokenFromSupervisorTarget), (req, res) => {
  const target = normalizeAgentName(req.params.target);
  if (!target) return res.status(400).json({ error: 'invalid target agent name' });
  const supervisorName = `supervisor-${target}`;
  // Require supervisor agent to be registered
  if (!isAgentRecord(agents[supervisorName])) {
    return res.status(403).json({ error: `supervisor agent '${supervisorName}' is not registered` });
  }
  // Fail closed: require token to be provisioned (not just registered)
  if (!agentTokens.get(supervisorName)) {
    return res.status(403).json({ error: `supervisor agent '${supervisorName}' has no token provisioned` });
  }

  try {
    // Renew lease BEFORE assessment so lifecycleState is accurate
    supervisorSnapshotStore.renewLease(target, supervisorName);
    const { snapshot, event } = supervisorSnapshotStore.updateAssessment(target, supervisorName, req.body || {});
    broadcastSSE('supervisor_audit', event);
    supervisorActionEngine.evaluateAction(target, snapshot);
    return res.json({ ok: true, snapshot });
  } catch (error) {
    return respondSupervisorSnapshotError(res, error, 'failed to update supervisor state');
  }
});

app.post('/api/supervisor-state/:target/heartbeat', requireAgentToken(_tokenFromSupervisorTarget), (req, res) => {
  const target = normalizeAgentName(req.params.target);
  if (!target) return res.status(400).json({ error: 'invalid target agent name' });
  const supervisorName = `supervisor-${target}`;
  if (!isAgentRecord(agents[supervisorName])) {
    return res.status(403).json({ error: `supervisor agent '${supervisorName}' is not registered` });
  }
  if (!agentTokens.get(supervisorName)) {
    return res.status(403).json({ error: `supervisor agent '${supervisorName}' has no token provisioned` });
  }
  supervisorSnapshotStore.renewLease(target, supervisorName);
  return res.json({ ok: true, target, leaseRenewed: true });
});

app.get('/api/supervisor/status', (_req, res) => {
  res.json(supervisorSnapshotStore.getStatus(agents));
});

app.get('/api/supervisor/agents', (_req, res) => {
  // Iterate live candidate set, enrich with snapshot store
  const agentList = Object.values(agents).filter(isAgentRecord);
  const summaries = agentList.map(a => {
    const snapshot = supervisorSnapshotStore.getTarget(a.name);
    return {
      name: a.name,
      online: a.online,
      task: a.task || null,
      state: snapshot ? {
        lastStatus: snapshot.state,
        classification: snapshot.classification,
        consecutiveNegative: snapshot.consecutiveNegative,
        lastReason: snapshot.reason,
        lastJudgedAt: snapshot.assessed_at_ms || null,
        lifecycleState: snapshot.lifecycleState,
      } : null,
    };
  });
  res.json({
    status: supervisorSnapshotStore.getStatus(agents),
    agents: summaries,
  });
});

app.get('/api/supervisor/agents/:name', (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
  const snapshot = supervisorSnapshotStore.getTarget(agentName);
  const agentEvents = supervisorSnapshotStore.getEvents(agentName, limit);
  const agent = agents[agentName];
  return res.json({
    name: agentName,
    task: agent.task || null,
    state: snapshot ? {
      lastStatus: snapshot.state,
      classification: snapshot.classification,
      consecutiveNegative: snapshot.consecutiveNegative,
      lastReason: snapshot.reason,
      lastDomain: snapshot.domain,
      lastPattern: snapshot.pattern,
      lastSuggestion: snapshot.suggested_action,
      lastJudgedAt: snapshot.assessed_at_ms || null,
      lastWarningAt: snapshot.lastWarningAt,
      lastNudgeAt: snapshot.lastNudgeAt,
      lastNudgeCount: snapshot.lastNudgeCount,
      lastEscalationAt: snapshot.lastEscalationAt,
      lastEscalationCount: snapshot.lastEscalationCount,
      lastEventId: snapshot.lastEventId,
      lifecycleState: snapshot.lifecycleState,
    } : null,
    latest: agentEvents.length ? agentEvents[agentEvents.length - 1] : null,
    events: agentEvents,
  });
});

app.get('/api/supervisor/control', (_req, res) => {
  return res.json(supervisorSnapshotStore.getControl(agents));
});

app.post('/api/supervisor/control', requireBearer, (req, res) => {
  const body = req.body || {};

  if (Object.prototype.hasOwnProperty.call(body, 'allowedAgents')) {
    return res.status(400).json({
      error: 'allowedAgents is read-only in per-agent supervisor model — provision/deprovision supervisor agents to change membership',
    });
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    return res.status(400).json({ error: 'no control fields provided' });
  }

  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }

  try {
    supervisorSnapshotStore.setEnabled(body.enabled);
    if (body.enabled) {
      try { supervisorLifecycleManager.sweepAll(); } catch (_) { /* best-effort */ }
    }
    const control = supervisorSnapshotStore.getControl(agents);
    const status = supervisorSnapshotStore.getStatus(agents);
    auditLog(req, { summary: { enabled: body.enabled } });
    return res.json({ ok: true, control, status });
  } catch (error) {
    return respondSupervisorSnapshotError(res, error, 'failed to update supervisor control');
  }
});

// ── Server heartbeats ─────────────────────────────────────────────────
app.post('/api/servers/heartbeat', requireBearer, (req, res) => {
  const serverId = normalizeServer(req.body?.server);
  if (!serverId) return res.status(400).json({ error: 'server required' });
  if (!isLocalRequest(req) && isLocalAgentServer(serverId, LOCAL_SERVER_ID)) {
    return res.status(400).json({
      error: 'remote server id must not be local',
      server: serverId,
    });
  }
  const heartbeatResult = applyServerHeartbeat(serverId, req.body || {}, req.ip || req.connection?.remoteAddress || null);
  refreshServerLiveness();
  const state = servers[serverId];
  auditLog(req, { summary: { server: serverId, agents: state?.agentCount || 0 } });
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

app.post('/api/servers/:id/offline', requireBearer, (req, res) => {
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
  const affectedAgents = collectServerAffectedAgents(serverId, server);
  const previousHeartbeatAt = Number(server.heartbeatAt) || 0;
  const previousLastSeen = Number(server.lastSeen) || 0;
  const now = Date.now();
  server.heartbeatAt = 0;
  clearServerLiveState(server, now);
  const maintenance = isServerInMaintenance(serverId, server);
  const reason = maintenance ? `server-maintenance:${serverId}` : `server-offline:${serverId}`;
  if (markAgentsOfflineForServer(serverId, reason, true)) saveAgents();
  saveServers();
  if (wasOnline && !maintenance) {
    emitServerOfflineAlert(
      serverId,
      'explicit-offline',
      { ...server, heartbeatAt: previousHeartbeatAt, lastSeen: previousLastSeen },
      affectedAgents
    );
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

app.post('/api/servers/:id/maintenance', requireBearer, (req, res) => {
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
      version: s.version || null,
    }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json(rows);
});

app.get('/api/servers/fleet', (req, res) => {
  const expectedVersion = normalizeOptionalText(req.query.expectVersion, 128)
    || normalizeOptionalText(req.query.expectedVersion, 128);
  res.json(buildFleetInventory({
    servers: Object.values(servers),
    expectedVersion,
    localGitVersion: LOCAL_GIT_VERSION,
    heartbeatTtlMs: HEARTBEAT_TTL_MS,
    isServerInMaintenance,
    normalizeRelayInstanceId,
    normalizeRelayBootTs,
  }));
});

// ── SSE endpoint ──────────────────────────────────────────────────────
sseAdapter.installRoute(app, '/api/stream');

// ── Owner-scoped runtime approvals ───────────────────────────────────
function respondApprovalStoreError(res, error, fallback = 'approval operation failed') {
  if (error instanceof ApprovalStoreError) {
    if (error.code === 'bad_request') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'persistence_failed') return res.status(503).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: error?.message || fallback });
}

const _tokenFromApprovalBody = req => req.body?.agent || '';
const _tokenFromApprovalRecord = req => approvalStore.getRequest(req.params?.id)?.agent || '';
const requireApprovalBridgeSecret = (req, res, next) => {
  if (!getBridgeSecret()) {
    return res.status(503).json({ error: 'MATRIX_BRIDGE_SECRET is required for approval authorization' });
  }
  return requireBridgeSecret(req, res, next);
};

// Only the authenticated Matrix bridge can assert room-scoped owner provenance.
/*
 * Whether a bound agent is actually IN the room, as observed against the homeserver.
 *
 * B1: a binding is what lets a project reach an agent, and nothing ever checked it against Matrix
 * membership in either direction. An operator asked why their agent appeared in three projects, and
 * the honest answer required me to go and read the room memberships by hand — the console could not
 * tell them, because the two facts live in different places and never met.
 *
 * Bridge-secret guarded and SEPARATE from the binding upsert beside it: observing membership
 * asserts nothing about permission, and folding it into the governance write would let a routine
 * liveness check carry a decision's authority.
 */
app.put('/api/approval-bindings/membership', requireApprovalBridgeSecret, (req, res) => {
  try {
    const binding = approvalStore.observeBindingMembership(req.body || {});
    // 404 rather than a silent ok: an observation about a binding nobody made is a mismatch worth
    // reporting to the caller, not something to store.
    if (!binding) return res.status(404).json({ error: 'no such binding' });
    return res.json({ ok: true, binding });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to record binding membership');
  }
});

app.put('/api/approval-bindings', requireApprovalBridgeSecret, (req, res) => {
  try {
    const binding = approvalStore.upsertBinding(req.body || {});
    return res.json({ ok: true, binding });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to persist approval binding');
  }
});

app.delete('/api/approval-bindings/:agent/:roomId', requireApprovalBridgeSecret, (req, res) => {
  try {
    const binding = approvalStore.removeBinding(req.params.agent, req.params.roomId);
    if (!binding) return res.status(404).json({ error: 'approval binding not found' });
    return res.json({ ok: true, binding });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to remove approval binding');
  }
});

app.get('/api/approval-bindings', requireApprovalBridgeSecret, (req, res) => {
  try {
    return res.json({
      ok: true,
      bindings: approvalStore.listBindings({ agent: req.query?.agent, project: req.query?.project }),
    });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to list approval bindings');
  }
});

/*
 * ── 项目方 Project sides (ADR-016 decisions 1, 3 and 8) ────────────────────────────────────
 *
 * A project side is one homeserver, the credential HAFleet holds there, and one representative.
 * It is the record that dissolves the circular dependency an operator identified: an agent MXID
 * contains a server name, so an identity cannot be minted before the server is known — and until
 * now `agentUserId()` composed one on HAFleet's OWN server at startup, before any project existed.
 *
 * THE CREDENTIAL IS WRITE-ONLY (decision 8). Every handler below returns the store's `publicSide`
 * projection, which has no credential field by construction. `credentialFor()` is called in exactly
 * one place — the verify handler, which needs it to talk to the homeserver — and its value never
 * reaches a response. The operator can set and replace it; nothing can read it back.
 *
 * Why that is a different rule from `cf.ownSecrets`, which says HAFleet's own secrets are
 * deliberately not editable from a browser: that rule protects HAFleet's own AUTHENTICATION, where a
 * bad value locks the operator out of the console itself. A project side's credential is inbound work
 * capacity — a bad value costs one project side's reachability and locks nobody out.
 */
function respondProjectSideError(res, error, fallback = 'project side operation failed') {
  if (error instanceof ProjectSideStoreError) {
    const status = { bad_request: 400, side_active: 409, persistence_failed: 503 }[error.code] ?? 500;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: error?.message || fallback });
}

app.get('/api/project-sides', requireBearer, (req, res) => {
  try {
    return res.json({
      ok: true,
      sides: projectSideStore.listSides({ activeOnly: req.query?.active === 'true' }),
    });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to list project sides');
  }
});

/*
 * REGISTERED BEFORE `/api/project-sides/:id`, and it has to be.
 *
 * Express matches in registration order, so with the parameterised route first this path resolves as
 * `:id = 'inbound-credentials'`, finds no such project side, and answers 404 — which is how it failed
 * the first time. The 404 looks like a missing route rather than a shadowed one, so a future reordering
 * would break inbound appservice authentication in a way that reads as "not implemented".
 */
/**
 * What a project side has left to spend, and whether it has anything at all.
 *
 * ADR-016's settled question 2 in force: a REAL allocation, not a slice. Returns
 * `{ allocated, committed, remaining }` where `allocated: null` means UNALLOCATED — which is not
 * unlimited. Nothing may be minted against a side with no allocation, so that a side which has been
 * configured and not yet budgeted refuses work instead of drawing on whatever is left.
 */
function sideBudgetFor(sideId) {
  const side = projectSideStore.getSide(sideId);
  if (!side) return null;
  const allocated = side.allocatedTokens ?? null;
  const committed = engagementStore.committedForProjectSide(side.serverName);
  return {
    allocated,
    committed,
    remaining: allocated === null ? null : Math.max(0, allocated - committed),
  };
}

/*
 * Set a side's allocation. The operator's 「真配额」.
 */
app.put('/api/project-sides/:id/allocation', requireBearer, (req, res) => {
  try {
    const raw = req.body?.allocated_tokens ?? req.body?.allocatedTokens;
    const side = projectSideStore.setAllocation(req.params.id, raw === undefined ? null : raw);
    if (!side) return res.status(404).json({ error: 'project side not found' });
    return res.json({ ok: true, side, budget: sideBudgetFor(side.id) });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to set allocation');
  }
});

/*
 * What a side has, has promised, and has left. Separate from GET /:id because it reaches across into
 * the engagement store, and a read of the side record should not silently depend on another store
 * being consistent.
 */
app.get('/api/project-sides/:id/budget', requireBearer, (req, res) => {
  const budget = sideBudgetFor(req.params.id);
  if (!budget) return res.status(404).json({ error: 'project side not found' });
  return res.json({ ok: true, sideId: projectSideStore.getSide(req.params.id).id, ...budget });
});

/*
 * The inbound credentials the BRIDGE needs, and nothing else.
 *
 * A NARROW, DELIBERATE EXCEPTION to ADR-016 decision 8, argued rather than assumed. "Write-only" was
 * decided against the CONSOLE: a browser holding the operator token must not be able to read a
 * credential, because the console renders whatever an API returns and this repository has already
 * shipped API text into a UI nobody meant to show it twice. The bridge is a different principal — it
 * is the component that must authenticate a homeserver's push, and it cannot do that without the
 * token. Refusing it would not protect anything; it would only mean the appservice cannot work.
 *
 * The precedent is exact rather than analogous: `GET /api/approval-bindings` is bridge-secret guarded
 * and returns `ownerDmRoomId`, which is deliberately withheld from the console proxy's projection. A
 * bridge-secret endpoint is already the place where this repository returns what the console must not
 * see.
 *
 * SO THE EXCEPTION IS SCOPED THREE WAYS, and each one is a decision:
 *   - `hsToken` only. The `asToken` acts AS an agent on that homeserver, and inbound authentication
 *     does not need it. When the bridge needs to send as an agent that will be a separate grant with
 *     its own argument.
 *   - appservice sides only. A registration-token side has no inbound push, so it has nothing to
 *     authenticate here. This filter is REDUNDANT today and kept as depth: the store validates
 *     credential fields per kind, so a registration-token credential structurally cannot carry an
 *     `hsToken`, and the `credential?.hsToken` check below already excludes it. Mutation testing
 *     confirms the pair is equivalent — no test can distinguish them, because no credential with a
 *     non-appservice kind and an `hsToken` can be constructed through the store. The filter stays so
 *     that adding such a kind later does not silently widen this endpoint.
 *   - active sides only. A deactivated side is closed to new work, and a listener that still accepted
 *     its pushes would be accepting work from a side the operator has closed.
 */
app.get('/api/project-sides/inbound-credentials', requireApprovalBridgeSecret, (req, res) => {
  try {
    const sides = projectSideStore.listSides({ activeOnly: true })
      .filter((side) => side.credentialKind === 'appservice')
      .map((side) => {
        const credential = projectSideStore.credentialFor(side.id);
        return credential?.hsToken
          ? {
            sideId: side.id,
            serverName: side.serverName,
            apiBaseUrl: side.apiBaseUrl,
            senderLocalpart: credential.senderLocalpart,
            namespace: credential.namespace,
            hsToken: credential.hsToken,
          }
          : null;
      })
      .filter(Boolean);
    return res.json({ ok: true, sides });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to read inbound credentials');
  }
});

app.get('/api/project-sides/:id', requireBearer, (req, res) => {
  const side = projectSideStore.getSide(req.params.id);
  if (!side) return res.status(404).json({ error: 'project side not found' });
  return res.json({ ok: true, side });
});

/*
 * Create or update. The id IS the server name, so this is an upsert on that key and there is no
 * separate POST/PUT split: a homeserver has exactly one credential and one representative, and a
 * create-only route would let a second record claim the same server.
 */
app.post('/api/project-sides', requireBearer, (req, res) => {
  try {
    const side = projectSideStore.upsertSide({
      server_name: req.body?.server_name ?? req.body?.serverName,
      api_base_url: req.body?.api_base_url ?? req.body?.apiBaseUrl,
      label: req.body?.label,
      // Present-but-undefined is CARRIED FORWARD by the store; an explicit null clears. The console
      // can only write this field, so a form that saves a label must not erase it.
      ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, 'credential')
        ? { credential: req.body.credential }
        : {}),
    });
    return res.json({ ok: true, side });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to save project side');
  }
});

/** Replace the credential alone. Write-only: the response is the projection, never the value. */
app.put('/api/project-sides/:id/credential', requireBearer, (req, res) => {
  try {
    const side = projectSideStore.setCredential(req.params.id, req.body?.credential ?? null);
    if (!side) return res.status(404).json({ error: 'project side not found' });
    return res.json({ ok: true, side });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to set credential');
  }
});

/*
 * Ask the homeserver whether our credential works, and record the answer.
 *
 * The verdict is stored rather than only returned, because "accepted" with no age cannot be told
 * apart from "accepted once, months ago, by a process that has since stopped running" — the argument
 * that put `membershipCheckedAt` beside `agentJoined`.
 *
 * A REJECTED credential and an UNREACHABLE homeserver are different answers and this endpoint says
 * which: only 401/403 is a verdict on the token. Reporting an outage as rejected sends an operator to
 * ask a project side for a new credential when theirs is fine, and on this path that means a human
 * doing account work on somebody else's homeserver.
 */
app.post('/api/project-sides/:id/verify', requireBearer, async (req, res) => {
  const existing = projectSideStore.getSide(req.params.id);
  if (!existing) return res.status(404).json({ error: 'project side not found' });
  try {
    const credential = projectSideStore.credentialFor(req.params.id);
    const result = await ensureRepresentative({ side: existing, credential });

    /*
     * A newly minted representative token is stored BEFORE the verdict. If the order were reversed
     * and the process died between the two writes, the token would be lost while the homeserver
     * believed the account existed — and the localpart would then be taken, so re-registering would
     * fail. Storing the credential first makes the worst case a missing verdict, which the next
     * verify recomputes.
     */
    if (result.credentialPatch) {
      projectSideStore.setCredential(req.params.id, { ...credential, ...result.credentialPatch });
    }
    projectSideStore.observeAccess(req.params.id, {
      state: result.accessState,
      detail: result.detail,
    });
    if (result.mxid) {
      /*
       * Guarded: the store refuses an MXID whose server is not this side's, which is the check that
       * stops the federation assumption creeping back in. A refusal here must not turn a successful
       * verification into a 500, so it is recorded as a bad_request against the side rather than
       * discarding the access verdict already written above.
       */
      try {
        projectSideStore.setRepresentative(req.params.id, { mxid: result.mxid });
      } catch (error) {
        return res.status(400).json({
          error: error?.message || 'representative mxid refused',
          code: 'representative_rejected',
          side: projectSideStore.getSide(req.params.id),
        });
      }
    }
    return res.json({ ok: true, side: projectSideStore.getSide(req.params.id) });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to verify project side');
  }
});

/*
 * Generate the appservice registration a project side installs.
 *
 * THE `url` IS AN INPUT AND CANNOT BE DERIVED. HAFleet does not know what address it has in the
 * project side's eyes — a tunnel hostname, a public IP, `host.docker.internal` for a homeserver in a
 * container on the same machine. Guessing one produces a registration that installs cleanly and never
 * delivers anything, which is the failure mode hardest to diagnose from the project side: an
 * appservice that is configured and silent.
 *
 * THE RESPONSE IS THE ONLY TIME THE TOKENS ARE READABLE. ADR-016 decision 8 makes a project side's
 * credential write-only, and this endpoint stores the generated tokens into it — so `GET` will never
 * return them again and there is no second chance to copy the YAML. That is stated in the response
 * rather than left as a surprise, because the recovery is regenerating, which invalidates the
 * registration the project side may already have installed.
 *
 * Replacing an existing credential is therefore refused unless `?replace=true`. The tokens in a
 * registration a homeserver has already loaded stop working the moment new ones are stored, and that
 * takes the project side down until they install the new file and restart.
 */
app.post('/api/project-sides/:id/registration', requireBearer, (req, res) => {
  const side = projectSideStore.getSide(req.params.id);
  if (!side) return res.status(404).json({ error: 'project side not found' });
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) {
    return res.status(400).json({
      error: 'url is required: the address this project side\'s homeserver can reach HAFleet at',
      code: 'bad_request',
    });
  }
  if (side.hasCredential && req.query?.replace !== 'true') {
    return res.status(409).json({
      error: 'this project side already has a credential; pass ?replace=true to issue new tokens',
      code: 'credential_exists',
      detail: 'replacing invalidates the registration the homeserver may already have installed, '
        + 'which stops delivery until the new file is installed and the homeserver restarted',
    });
  }
  try {
    const registration = generateRegistration({
      id: req.body?.registration_id || `hafleet-${side.id}`,
      url,
      senderLocalpart: req.body?.sender_localpart || 'hafleet',
      userNamespaceRegex: req.body?.user_namespace || `@${MATRIX_AGENT_PREFIX_FOR_REGISTRATION}.*`,
    });
    const stored = projectSideStore.setCredential(side.id, {
      kind: 'appservice',
      asToken: registration.as_token,
      hsToken: registration.hs_token,
      namespace: registration.namespaces.users[0].regex,
      senderLocalpart: registration.sender_localpart,
    });
    return res.json({
      ok: true,
      side: stored,
      /*
       * Returned once. Named `registrationYaml` rather than anything matching /credential/, because the
       * health writer's redaction guard drops such keys silently — ADR-014 decision 6 hit that and had
       * to rename a field after it vanished from a record.
       */
      registrationYaml: renderRegistrationYaml(registration),
      installPath: 'the homeserver\'s appservice_registration_dir',
      onlyChance: 'These tokens are not stored in readable form and will never be returned again. '
        + 'Save this file now; regenerating issues new tokens and invalidates this registration.',
      restartRequired: true,
    });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to generate registration');
  }
});

app.post('/api/project-sides/:id/deactivate', requireBearer, (req, res) => {
  try {
    const side = projectSideStore.deactivateSide(req.params.id);
    if (!side) return res.status(404).json({ error: 'project side not found' });
    return res.json({ ok: true, side });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to deactivate project side');
  }
});

app.post('/api/project-sides/:id/reactivate', requireBearer, (req, res) => {
  try {
    const side = projectSideStore.reactivateSide(req.params.id);
    if (!side) return res.status(404).json({ error: 'project side not found' });
    return res.json({ ok: true, side });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to reactivate project side');
  }
});

/*
 * Forget a side. The LAST step of decision 7's cascade, and this endpoint does not perform the rest
 * of it — ending engagements, releasing commitments, deactivating bindings and retiring agent
 * identities are not built yet, and pretending otherwise would be worse than the gap.
 *
 * So the refusal is the honest part: an ACTIVE side is refused (409), because removing it drops the
 * credential that every earlier cascade step still needs — leaving rooms, revoking tokens, telling
 * the borrower. `?force=true` overrides, matching `DELETE /api/agents/:name`, which already answers
 * "unregister is disabled … Use ?force=true".
 */
app.delete('/api/project-sides/:id', requireBearer, (req, res) => {
  try {
    const side = projectSideStore.removeSide(req.params.id, { force: req.query?.force === 'true' });
    if (!side) return res.status(404).json({ error: 'project side not found' });
    return res.json({
      ok: true,
      side,
      // Named rather than implied: the cascade is not built, so a caller must not read this 200 as
      // "everything that depended on this side has been cleaned up".
      cascade: 'not_performed',
      cascadeNote: 'engagements, bindings and agent identities on this side are NOT touched by this endpoint',
    });
  } catch (error) {
    return respondProjectSideError(res, error, 'failed to remove project side');
  }
});

/*
 * Verify every active side once, after the server is listening.
 *
 * NON-BLOCKING and after `listening` deliberately: this makes network calls to homeservers HAFleet
 * does not control, and a slow or unreachable project side must not delay or fail startup. Each side
 * is independent — `ensureRepresentative` returns a state rather than throwing, so one unreachable
 * server cannot stop the others being checked, which is the property that makes a sweep worth having
 * at all.
 */
async function sweepProjectSideRepresentatives() {
  const sides = projectSideStore.listSides({ activeOnly: true });
  if (!sides.length) return;
  for (const side of sides) {
    try {
      const credential = projectSideStore.credentialFor(side.id);
      const result = await ensureRepresentative({ side, credential });
      if (result.credentialPatch) {
        projectSideStore.setCredential(side.id, { ...credential, ...result.credentialPatch });
      }
      projectSideStore.observeAccess(side.id, { state: result.accessState, detail: result.detail });
      if (result.mxid) {
        try { projectSideStore.setRepresentative(side.id, { mxid: result.mxid }); } catch { /* recorded by the verdict */ }
      }
      if (result.accessState !== 'accepted') {
        console.warn(`[project-side] ${side.id}: ${result.accessState}${result.detail ? ` — ${result.detail}` : ''}`);
      }
    } catch (error) {
      // A per-side failure is logged and the sweep continues. Never the whole sweep's problem.
      console.warn(`[project-side] ${side.id}: sweep failed — ${error?.message || 'unknown'}`);
    }
  }
}

/*
 * ── Pending project invitations (ADR-014 amendment 2026-08-11) ─────────────────────────────
 *
 * A project invites one of the contributor's agents into its room. Until this existed the
 * invitation either caused a silent auto-join with no ownership binding — present and
 * permanently unengageable — or was dropped with a log line the contributor never saw.
 *
 * The split of authority below is the point:
 *
 *   the BRIDGE reports (bridge secret). It is the only thing that sees Matrix state.
 *   the OPERATOR decides (bearer). Accepting spends their tokens, so it is their call.
 *
 * Deciding does not happen here. The backend records the answer and broadcasts it; only the
 * bridge can join a Matrix room, mark it trusted, and write the ownership binding. Recording a
 * decision the bridge then failed to carry out would be the "looks accepted, works for nothing"
 * state this replaces — so the endpoints below record and broadcast, and the bridge's own
 * acceptance is what makes it true.
 */
function respondPendingInviteError(res, error, fallback) {
  if (error instanceof PendingInviteError) {
    const status = { bad_request: 400, not_found: 404, conflict: 409 }[error.code] ?? 500;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error(`[pending-invites] ${fallback}:`, error?.message || error);
  return res.status(500).json({ error: fallback });
}

app.put('/api/matrix/pending-invites', requireBridgeSecret, (req, res) => {
  try {
    return res.json({ ok: true, invite: pendingInviteStore.upsert(req.body || {}) });
  } catch (error) {
    return respondPendingInviteError(res, error, 'failed to record pending invitation');
  }
});

app.get('/api/matrix/pending-invites', requireBearer, (req, res) => {
  try {
    const state = normalizeOptionalText(req.query?.state, 16) || 'pending';
    return res.json({
      ok: true,
      invites: pendingInviteStore.list({ state }),
      pending: pendingInviteStore.pendingCount(),
    });
  } catch (error) {
    return respondPendingInviteError(res, error, 'failed to list pending invitations');
  }
});

app.post('/api/matrix/pending-invites/decide', requireBearer, (req, res) => {
  try {
    const b = req.body || {};
    const roomId = normalizeOptionalText(b.projectRoomId ?? b.project_room_id, 256);
    const agent = normalizeOptionalText(b.agent, 64);
    const accept = b.accept === true;
    if (!roomId || !agent) {
      return res.status(400).json({ error: 'projectRoomId and agent are required' });
    }
    const record = pendingInviteStore.settle(
      roomId, agent, accept ? 'accepted' : 'declined',
      getRequestAgentName(req) || 'operator',
    );
    /*
     * Broadcast, because the join can only happen in the bridge. The response says the decision
     * was recorded and queued — deliberately not that the agent has joined, which the backend
     * cannot know. Overstating that is the same class of defect as the binding outcome that used
     * to be omitted from a verdict.
     */
    broadcastSSE('matrix_invite_decision', { projectRoomId: roomId, agent, accept });
    return res.json({ ok: true, queued: true, invite: record });
  } catch (error) {
    return respondPendingInviteError(res, error, 'failed to record the invitation decision');
  }
});

app.post('/api/approvals', requireAgentToken(_tokenFromApprovalBody), (req, res) => {
  try {
    const record = approvalStore.createRequest(req.body || {});
    if (record.status === 'pending') {
      // Tool details never enter the shared SSE stream. The bridge fetches them
      // through the secret-authenticated Matrix endpoint below.
      broadcastSSE('approval_requested', { request_id: record.id, agent: record.agent });
    }
    return res.status(record.status === 'pending' ? 201 : 200).json({ ok: true, approval: record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to create approval request');
  }
});

app.get('/api/approvals/:id', requireAgentToken(_tokenFromApprovalRecord), (req, res) => {
  try {
    const record = approvalStore.getRequest(req.params.id);
    if (!record) return res.status(404).json({ error: 'approval request not found' });
    return res.json({ ok: true, approval: record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to read approval request');
  }
});

app.get('/api/approvals/:id/matrix', requireApprovalBridgeSecret, (req, res) => {
  try {
    const record = approvalStore.getRequest(req.params.id, { matrix: true });
    if (!record) return res.status(404).json({ error: 'approval request not found' });
    return res.json({ ok: true, approval: record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to read Matrix approval request');
  }
});

app.post('/api/approvals/:id/verdict', requireApprovalBridgeSecret, (req, res) => {
  try {
    const result = approvalStore.submitMatrixVerdict(req.params.id, req.body || {});
    if (!result.record && result.code === 'not_found') {
      return res.status(404).json({ error: 'approval request not found', code: result.code });
    }
    if (!result.ok) {
      const status = result.code === 'expired' ? 410 : (result.code === 'not_pending' ? 409 : 403);
      return res.status(status).json({ error: 'approval verdict rejected', code: result.code, approval: result.record });
    }
    broadcastSSE('approval_verdict', {
      request_id: result.record.id,
      agent: result.record.agent,
      status: result.record.status,
    });
    return res.json({ ok: true, approval: result.record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to apply approval verdict');
  }
});

app.post('/api/approvals/:id/delivery-failed', requireApprovalBridgeSecret, (req, res) => {
  try {
    const record = approvalStore.denyPending(req.params.id, req.body?.reason || 'matrix_delivery_failed');
    if (!record) return res.status(404).json({ error: 'approval request not found' });
    broadcastSSE('approval_verdict', { request_id: record.id, agent: record.agent, status: record.status });
    return res.json({ ok: true, approval: record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to deny undeliverable approval');
  }
});

app.post('/api/approvals/:id/consume', requireAgentToken(_tokenFromApprovalRecord), (req, res) => {
  try {
    const result = approvalStore.consumeDecision(
      req.params.id,
      req.body?.agent,
      req.body?.input_digest || null,
    );
    if (!result.record && result.code === 'not_found') {
      return res.status(404).json({ error: 'approval request not found', code: result.code });
    }
    if (!result.ok) {
      const status = result.code === 'pending' ? 202 : (result.code === 'expired' ? 410 : 409);
      return res.status(status).json({ ok: false, code: result.code, approval: result.record });
    }
    return res.json({ ok: true, decision: result.decision, approval: result.record });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to consume approval decision');
  }
});

// ── Agents CRUD ───────────────────────────────────────────────────────
const _tokenFromBody = r => r.body?.from || r.body?.name || '';
const _tokenFromName = r => r.params?.name || '';
const _tokenFromAgent = r => r.body?.agent || r.params?.agent || r.query?.agent || '';
const _tokenFromNodeAssignee = r => { const g = taskGraphStore.getGraph(r.params?.id); return g?.nodes?.[r.params?.nodeId]?.assignee || ''; };
app.post('/api/agents', requireAgentToken(r => r.body?.name || ''), (req, res) => {
  const {
    name,
    role,
    capability,
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
    presetId,
    managedProjects,
    human,
    task,
    runtimeProfile,
    environment,
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
  // Agent tokens were read once at startup, so a token minted afterwards — which
  // is every agent created while the backend is already running — was invisible
  // until a restart, and with HAFLEET_AGENT_TOKEN_MODE=hard every call that
  // agent made was rejected. Registration is exactly when a new token appears.
  // loadAgentTokens keeps already-known entries, so this cannot rotate a live one.
  if (!agentTokens.has(agentName)) loadAgentTokens();
  if (deletedAgentTombstones[agentName]) return res.status(410).json({ error: 'agent permanently deleted', tombstone: deletedAgentTombstones[agentName] });
  const existing = agents[agentName] || {};
  const existingOnline = Boolean(existing.online);
  const normalizedServer = normalizeServer(server);
  const resolvedServer = normalizedServer ?? (isLocalRequest(req) ? 'local' : normalizeServer(existing.server));
  const resolvedTmux = tmux ?? existing.tmux ?? null;
  const resolvedOnline = resolvedTmux ? true : Boolean(existing.online);
  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  // Resolve preset into runtimeProfile if presetId is provided
  let resolvedRuntimeProfile = runtimeProfile;
  let presetFramework = null;
  if (presetId && typeof presetId === 'string') {
    const preset = frameworkPresets.find(p => p.id === presetId);
    if (!preset) return res.status(400).json({ error: `unknown preset: ${presetId}` });
    presetFramework = preset.framework || null;
    resolvedRuntimeProfile = runtimeProfileFromPreset(preset);
  }
  agents[agentName] = {
    name: agentName,
    role: role ?? existing.role ?? null,
    // matrix-Agent capability tier (strong/medium/lightweight); invalid/absent → keep existing.
    capability: (['strong', 'medium', 'lightweight'].includes(capability)
      ? capability
      : (existing.capability ?? null)),
    identity: identity ?? existing.identity ?? null,
    tmux: resolvedTmux,
    type: presetFramework ?? agentType ?? existing.type ?? 'agent',
    // Which named preset produced runtimeProfile. Recorded, not just consumed:
    // the resolved values alone cannot say which reusable configuration an agent
    // is on, so a client could show the model but never the preset behind it,
    // and editing a preset could not identify the agents it affects.
    presetId: normalizeOptionalText(presetId, 128) || existing.presetId || null,
    // Recorded so the sweep does not have to re-derive it, and so a record stays
    // correct even if the registry later changes.
    transport: (() => {
      const fromBody = typeof req.body?.transport === 'string' ? req.body.transport.trim().toLowerCase() : '';
      if (fromBody === 'acp' || fromBody === 'tmux') return fromBody;
      if (existing.transport) return existing.transport;
      return getFramework(presetFramework ?? agentType ?? existing.type)?.transport === 'acp' ? 'acp' : 'tmux';
    })(),
    acpPid: Number(req.body?.acpPid) > 1 ? Number(req.body.acpPid) : (existing.acpPid ?? null),
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
    managedProjects: Array.isArray(managedProjects)
      ? normalizeManagedProjects(managedProjects)
      : normalizeManagedProjects(existing.managedProjects),
    human: mergeHumanMeta(existing.human, human),
    task: task !== undefined
      ? normalizeAgentTask(task, agentName)
      : normalizeAgentTask(existing.task, agentName),
    runtimeProfile: resolvedRuntimeProfile !== undefined
      ? mergeRuntimeProfileApiKeys(normalizeRuntimeProfile(resolvedRuntimeProfile), normalizeRuntimeProfile(existing.runtimeProfile))
      : normalizeRuntimeProfile(existing.runtimeProfile),
    environment: (VALID_ENVIRONMENTS.has(environment) ? environment : null)
      || existing.environment || classifyEnvironment(agentName),
  };
  if (resolvedOnline) {
    const isLocal = isLocalAgentServer(resolvedServer, LOCAL_SERVER_ID);
    if (isLocal && resolvedTmux) {
      // Local registration with tmux → STARTING (grace timer for MCP)
      transitionAgent(agentName, 'api_register_with_tmux');
    } else {
      // Remote or non-tmux → direct ONLINE
      syncAgentMachine(agentName, { heartbeatPresent: true, manualDown: false });
    }
  }
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  writeThruAgentHome(agentName);
  if (!existingOnline && resolvedOnline) {
    notifyAgentCatchup(agentName, 'agent-online-update').catch((e) => {
      console.error(`catchup notify failed for ${agentName}:`, e.message);
    });
  }
  auditLog(req, { agent: agentName, summary: { type: agentType, server: resolvedServer, online: resolvedOnline } });
  res.json({ ok: true, agent: serializeAgent(agents[agentName]) });
});

/**
 * A preset, expressed as the runtimeProfile an agent runs under.
 *
 * Extracted rather than copied, because the two callers must not drift: `POST /api/agents`
 * resolves a preset at registration, and `PUT /api/agents/:name/preset` resolves the same preset
 * when a contributor attaches one later. The first version of the binding route set `presetId`
 * ALONE, and the result was an agent that looked configured and still filled no role —
 * `agentForRole()` reads `modelTier(agent.runtimeProfile)`, not the preset, so a ceiling without a
 * profile is a tierless agent. Nothing failed loudly; the engagement simply came back with
 * `agent: null` and then `no_ceiling`.
 */
function runtimeProfileFromPreset(preset) {
  if (!preset) return null;
  return {
    primary: {
      framework: preset.framework || null,
      provider: preset.provider || null,
      model: preset.model || null,
      reasoning: preset.reasoning || null,
      ...(preset.extraArgs ? { extraArgs: preset.extraArgs } : {}),
      ...(preset.apiBaseUrl ? { apiBaseUrl: preset.apiBaseUrl } : {}),
      ...(preset.apiKey ? { apiKey: preset.apiKey } : {}),
    },
  };
}

/**
 * Bind an agent to a framework preset — the CONTRIBUTOR's act, not the agent's.
 *
 * WHY THIS ROUTE EXISTS. `presetId` is what attaches a CEILING to an agent:
 * `remainingFor()` reads `agents[name].presetId` -> `preset.ceiling.tokens`, and
 * `engagementStore.decide()` refuses to allocate against an agent whose remaining is null
 * ("cannot allocate against an agent with no declared ceiling"). Until this route, the only
 * writers of `presetId` were `POST /api/agents` and the agent PATCH, both guarded by
 * `requireAgentToken` — and no CLI path passes a preset. So a contributor could create a
 * preset with a ceiling, onboard an agent, and never connect them: every engagement was
 * unapprovable, and the console showed the agent under "bare" with no action to fix it.
 * Found by walking the flow end to end rather than by a failing test.
 *
 * WHY `requireBearer` AND NOT `requireAgentToken`. The ceiling is the contributor's
 * declaration about their own resource — how much of their capacity they are willing to lend
 * (ADR-013's L1/L2). Gating it on the agent's own credential makes the resource the authority
 * on its own budget, which is self-authorization: an agent could raise its ceiling by
 * re-registering with a richer preset. The runtimeProfile stays the agent's to report; the
 * budget does not.
 *
 * Unbinding is `presetId: null` rather than a DELETE, so "which preset" and "no preset" travel
 * through one code path and cannot disagree about what the absent case means.
 */
app.put('/api/agents/:name/preset', requireBearer, (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });

  const raw = req.body?.presetId;
  // Absent and explicit-null both mean unbind; anything else must name a real preset.
  const requested = raw === null || raw === undefined || raw === '' ? null : normalizeOptionalText(raw, 128);
  if (requested !== null && !requested) return res.status(400).json({ error: 'invalid presetId' });
  const preset = requested ? frameworkPresets.find((p) => p.id === requested) : null;
  if (requested && !preset) return res.status(400).json({ error: `unknown preset: ${requested}` });

  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  const previous = agent.presetId ?? null;
  agent.presetId = requested;
  /*
   * The PROFILE moves with the preset, not just the id. `agentForRole()` decides whether an agent
   * can fill a role from `modelTier(agent.runtimeProfile)`, so setting `presetId` alone produces an
   * agent with a ceiling, no tier, and no role — which surfaces later as an engagement with
   * `agent: null` and a `no_ceiling` refusal, pointing at the budget rather than at the profile.
   *
   * Unbinding clears it. Leaving the last preset's profile behind would let a contributor detach a
   * resource and have it keep serving on the terms they just withdrew.
   */
  const resolvedProfile = runtimeProfileFromPreset(preset);
  agent.runtimeProfile = resolvedProfile ? normalizeRuntimeProfile(resolvedProfile) : null;
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  auditLog(req, { agent: agentName, summary: { presetId: requested, previousPresetId: previous } });
  /*
   * `remaining` is returned because it is the question the caller actually has — binding a
   * preset with no ceiling leaves the agent just as unapprovable as before, and answering with
   * only `ok: true` would hide that.
   */
  return res.json({
    ok: true,
    agent: serializeAgent(agents[agentName]),
    ceilingTokens: preset?.ceiling?.tokens ?? null,
    remaining: remainingFor(agentName),
    // The tier is what makes the agent fillable at all, so it is reported beside the budget.
    tier: modelTier(agents[agentName].runtimeProfile) ?? null,
  });
});

app.patch('/api/agents/:name', requireAgentToken(_tokenFromName), (req, res) => {
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
    managedProjects,
    human,
    task,
    runtimeProfile,
    environment,
  } = req.body;
  if (task !== undefined && task !== null && !normalizeAgentTask(task, agentName)) {
    return res.status(400).json({ error: 'invalid task payload' });
  }
  if (runtimeProfile !== undefined && runtimeProfile !== null && !normalizeRuntimeProfile(runtimeProfile)) {
    return res.status(400).json({ error: 'invalid runtimeProfile payload' });
  }
  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  if (role !== undefined) agent.role = role;
  if (identity !== undefined) agent.identity = identity;
  if (tmux !== undefined) {
    agent.tmux = tmux;
    if (tmux) {
      // online driven by machine
      syncAgentMachine(agentName, { tmuxPresent: true });
      agent.offlineReason = null;
      agent.lastSeen = Date.now();
    } else if (online === undefined) {
      syncAgentMachine(agentName, { tmuxMissing: true });
      agent.offlineReason = agent.offlineReason || 'tmux-cleared';
    }
  }
  if (online !== undefined) {
    // online:true only clears manualDown — real liveness comes from sweep/heartbeat
    if (Boolean(online)) {
      syncAgentMachine(agentName, { manualDown: false });
      agent.lastSeen = Date.now();
    } else {
      syncAgentMachine(agentName, { tmuxMissing: true });
    }
  }
  if (offlineReason !== undefined) {
    agent.offlineReason = (typeof offlineReason === 'string' && offlineReason.trim()) ? offlineReason.trim() : null;
  }
  if (manualDown !== undefined) {
    syncAgentMachine(agentName, { manualDown: manualDown === true });
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
  if (managedProjects !== undefined) {
    agent.managedProjects = normalizeManagedProjects(managedProjects);
  }
  if (human !== undefined) {
    agent.human = mergeHumanMeta(agent.human, human);
  }
  if (task !== undefined) {
    agent.task = normalizeAgentTask(task, agentName);
  }
  if (runtimeProfile !== undefined) {
    agent.runtimeProfile = mergeRuntimeProfileApiKeys(normalizeRuntimeProfile(runtimeProfile), normalizeRuntimeProfile(agent.runtimeProfile));
  }
  if (environment !== undefined && VALID_ENVIRONMENTS.has(environment)) {
    agent.environment = environment;
  }
  if (agent.online === true && agent.manualDown !== false) {
    agent.manualDown = false;
  }
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  writeThruAgentHome(agentName);
  if (!wasOnline && agent.online === true) {
    notifyAgentCatchup(agentName, 'agent-online-patch').catch((e) => {
      console.error(`catchup notify failed for ${agentName}:`, e.message);
    });
  }
  auditLog(req, { agent: agentName, summary: { fields: Object.keys(req.body) } });
  res.json({ ok: true, agent: serializeAgent(agent) });
});

app.get('/api/agents', (req, res) => {
  refreshServerLiveness();
  const records = Object.values(agents).filter(isAgentRecord);
  if ((String(req.query.view || '').trim().toLowerCase()) === 'names') {
    const names = records
      .map(agent => (typeof agent?.name === 'string' ? agent.name.trim() : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return res.json(names);
  }
  res.json(records.map(serializeAgent));
});

// matrix-Agent pool view (Phase 2): the role×capability grid, for capability-aware dispatch.
// Read-only. Filters: ?role= ?capability= ?state=idle|busy|any (default any).
// matrix-Agent capability scheduler (Phase 3): a reservation/queue over the pool. hafleet
// decides *which* agent staffs a (role, capability); the caller (e.g. the OpenFab Bridge)
// delivers the task to it and calls /release on completion. Busy/queue are in-memory.
//
// Task 7: the reservation is an owner-bound, renewable lease (DispatchLeaseStore), not a bare
// busy flag — a crashed/stuck caller can no longer pin an agent forever. A lease is claimed at
// dispatch time (leaseId + expiresAt in the response), extended via POST /api/dispatch/renew,
// and released via POST /api/dispatch/release; renew/release both require the exact
// (leaseId, agent, owner) tuple and reject otherwise (owner mismatch, unknown/stale leaseId, or
// an already-expired lease — distinct 4xx reasons). POST /api/dispatch/release rejects the
// pre-Task-7 call shape ({agent} only, no leaseId/owner) by default — letting the ownership
// check be skipped just by omitting fields would defeat it — unless HAFLEET_ALLOW_LEGACY_RELEASE=1
// is set, an explicit opt-in compatibility shim for a caller that predates ownership (see the
// Task 7 report for the caller inventory; nothing in this stack needs the shim as of this
// writing). An unrenewed lease is reaped once its TTL lapses (checked lazily on GET /api/pool and
// POST /api/dispatch, mirroring refreshServerLiveness()'s placement): the lease is invalidated
// first, then the agent is freed, so nothing can observe "agent free, lease still valid" mid-
// reap. A reaped lease is requeued at most once, and only if it carries a durable ticket (the
// queue-drain ticket, or one the caller supplied at dispatch time); otherwise the task is
// presumed failed and an alert is raised — never silently retried/duplicated. The dispatch
// queue itself remains process-local (known limitation, unchanged by Task 7): a restart drops
// in-flight leases and queued tickets alike; this is not restart-safe queueing.
const dispatchLeaseStore = new DispatchLeaseStore({ ttlMs: DISPATCH_LEASE_TTL_MS });
const dispatchQueues = new Map();    // `${role}:${tier}` → [{ ticket, role, tier, task, room }]
const provisionReservations = new Map(); // `${role}:${tier}` → count of outstanding provision plans
let dispatchTicketSeq = 0;
const cellKey = (role, tier) => `${role}:${tier}`;
const annotateBusy = (records) => records.map((a) => ({ ...a, busy: dispatchLeaseStore.isBusy(a.name) }));
const poolRecords = () =>
  annotateBusy(Object.values(agents).filter(isAgentRecord).map(serializeAgent));

const DISPATCH_LEASE_ERROR_STATUS = {
  missing_fields: 400,
  owner_mismatch: 403,
  lease_not_found: 404,
  lease_expired: 410,
  agent_busy: 409,
};

function respondDispatchLeaseError(res, error) {
  const reason = error?.reason || 'internal_error';
  const status = DISPATCH_LEASE_ERROR_STATUS[reason] || 500;
  return res.status(status).json({ error: error?.message || 'dispatch lease error', reason });
}

// Reap leases whose TTL lapsed without a renew. For each: invalidate the lease, free the agent,
// then either requeue its ticket (durable tickets only, at most once) or mark it failed and
// raise an alert (no ticket ⇒ never silently duplicate the task). See the Task 7 note above.
function reapDispatchLeases() {
  const reaped = dispatchLeaseStore.reapExpired(Date.now());
  for (const { lease, context, outcome } of reaped) {
    if (outcome === 'requeued') {
      const key = cellKey(context.role, context.tier);
      const q = dispatchQueues.get(key) || [];
      q.push({ ticket: lease.ticket, role: context.role, tier: context.tier, task: context.task, room: context.room });
      dispatchQueues.set(key, q);
      console.warn(`[dispatch-lease] ${lease.agent} lease ${lease.leaseId} expired unrenewed; requeued ticket ${lease.ticket}`);
      continue;
    }
    console.warn(`[dispatch-lease] ${lease.agent} lease ${lease.leaseId} expired unrenewed with no durable ticket; marking failed`);
    try {
      alertStore.ingest({
        alertType: 'dispatch_lease_expired',
        dedupeKey: `dispatch_lease_expired:${lease.agent}:${lease.leaseId}`,
        severity: 'warning',
        source: 'backend',
        sourceAgent: lease.agent,
        summary: `Dispatch lease for '${lease.agent}' expired without renewal and has no durable ticket to requeue`,
        detail: {
          leaseId: lease.leaseId, agent: lease.agent, owner: lease.owner, taskId: lease.taskId,
          role: context.role, tier: context.tier, expiresAt: lease.expiresAt,
        },
        owner: 'matrix-agent-dispatch',
        runbook: 'inspect the dispatch lease + task state for this agent; redispatch manually if the work is still needed',
        impact: 'the in-flight task on this agent is presumed failed; no automatic retry because no durable ticket exists to requeue from',
        recoveryCondition: 'operator investigates and manually redispatches, or explicitly resolves this alert',
        correlation: { dedupeKey: `dispatch_lease_expired:${lease.agent}:${lease.leaseId}`, leaseId: lease.leaseId, agent: lease.agent },
        tags: ['dispatch-lease', `agent:${lease.agent}`],
      });
    } catch (error) {
      console.warn(`[dispatch-lease] failed to ingest expiry alert for ${lease.leaseId}: ${error?.message || error}`);
    }
  }
  return reaped;
}

app.get('/api/pool', (req, res) => {
  refreshServerLiveness();
  reapDispatchLeases();
  let records = poolRecords();
  const state = String(req.query.state || 'any').toLowerCase();
  if (state === 'idle') records = records.filter(a => a.online !== false && a.busy !== true);
  else if (state === 'busy') records = records.filter(a => a.busy === true);
  if (req.query.role) records = records.filter(a => agentRole(a) === String(req.query.role));
  if (req.query.capability) records = records.filter(a => agentCapability(a) === String(req.query.capability));
  const grid = indexPool(records);
  const counts = {};
  for (const [r, byCap] of Object.entries(grid)) {
    counts[r] = Object.fromEntries(Object.entries(byCap).map(([c, list]) => [c, list.length]));
  }
  res.json({
    grid,
    counts,
    total: records.length,
    agents: records.map(a => ({ name: a.name, role: agentRole(a), capability: agentCapability(a), online: a.online !== false, busy: a.busy === true })),
  });
});

// Reserve an agent for (role, capability), or queue when the pool can't staff it. The caller
// delivers the task to the returned agent and calls /api/dispatch/release when it completes.
// Optional body fields `owner`/`ticket`/`taskId` feed the Task 7 lease (see notes above); a
// missing `owner` gets DISPATCH_LEASE_DEFAULT_OWNER so pre-Task-7 callers keep working.
app.post('/api/dispatch', (req, res) => {
  refreshServerLiveness();
  reapDispatchLeases();
  const role = req.body?.role ? String(req.body.role) : null;
  if (!role) return res.status(400).json({ error: 'role required' });
  const tier = resolveTier(role, req.body?.capability ? String(req.body.capability) : undefined);
  const agent = selectAgent(poolRecords(), role, tier); // poolRecords() already carries busy
  if (agent) {
    const owner = req.body?.owner ? String(req.body.owner) : DISPATCH_LEASE_DEFAULT_OWNER;
    const ticket = req.body?.ticket ? String(req.body.ticket) : null;
    const taskId = req.body?.taskId ? String(req.body.taskId) : null;
    const lease = dispatchLeaseStore.create({
      agent: agent.name, owner, taskId, ticket,
      role, tier, task: req.body?.task ?? null, room: req.body?.room ?? null,
    });
    return res.json({ status: 'routed', agent: agent.name, role, tier, leaseId: lease.leaseId, expiresAt: lease.expiresAt });
  }
  // Phase 4: auto-provision. When MATRIX_AGENT_MAX_PER_CELL > 0 and the cell is below the cap,
  // return a `provision` plan (the launcher runs `up-v1` with the tier's runtime) instead of
  // queuing. Default 0 = off (pure queue) — safe. The decision is pure; spawning is the edge.
  // No lease is created here: the named agent doesn't exist yet, so there's nothing to reserve.
  const key = cellKey(role, tier);
  const cap = Number(process.env.MATRIX_AGENT_MAX_PER_CELL || 0);
  if (cap > 0) {
    const inCell = poolRecords().filter((a) => agentRole(a) === role && agentCapability(a) === tier).length;
    const reserved = provisionReservations.get(key) || 0;
    if (inCell + reserved < cap) {
      /*
       * BUDGET ADMISSION, ADR-016 decision 6 — and it applies EXACTLY WHERE A BORROWER EXISTS.
       *
       * The cap above counts AGENTS and never consulted the ledger, so this path would mint against a
       * project side with no budget left, or with none ever allocated. The operator stated the
       * requirement directly: 「如果 token 预算已经超标了…这时候应该报警，说无法创建 agent，需要加预算」.
       *
       * SCOPED BY WHETHER THE REQUEST NAMES A ROOM. A room id carries its origin server, which is the
       * project side whose budget is at stake. A request with NO room is not project-side work — it is
       * the contributor dispatching against their own agents, already governed by each agent's own
       * ceiling — so requiring a side there would break internal dispatch to enforce a budget nobody
       * is spending. A first version of this did exactly that and broke two existing cases; the
       * failure was the scope being wrong, not the gate.
       *
       * THE CONSEQUENCE, STATED: a caller that omits the room escapes this check. That is acceptable
       * only because such a request cannot be attributed to a borrower at all — but note separately
       * that `POST /api/dispatch` carries NO auth guard, so "who can omit the room" is "anyone who can
       * reach the backend". That is pre-existing and is not fixed here; it is recorded because this
       * gate now depends on it.
       *
       * A REFUSAL IS AN ALARM, NOT A QUEUE ENTRY. Falling through to the queue would answer "waiting
       * for capacity" when the truth is "will never be created without more budget", and an agent that
       * was never created cannot be waited for.
       */
      const room = typeof req.body?.room === 'string' ? req.body.room : '';
      const at = room.indexOf(':');
      const sideId = at > 0 ? room.slice(at + 1).toLowerCase() : null;

      if (sideId) {
        const budget = sideBudgetFor(sideId);
        const wanted = Number.isFinite(Number(req.body?.requestedTokens))
          ? Math.max(0, Math.floor(Number(req.body.requestedTokens)))
          : 0;
        if (!budget) {
          return res.status(409).json({
            status: 'refused',
            reason: 'no_project_side',
            error: `no project side is configured for ${sideId}, so no budget can be charged for a new agent`,
            sideId, role, tier,
          });
        }
        if (budget.allocated === null) {
          // UNALLOCATED IS NOT UNLIMITED, so the alarm arrives before the tokens rather than after.
          return res.status(409).json({
            status: 'refused',
            reason: 'no_allocation',
            error: `project side ${sideId} has no token allocation — set one before agents can be created for it`,
            sideId, role, tier,
          });
        }
        if (wanted > budget.remaining) {
          return res.status(409).json({
            status: 'refused',
            reason: 'over_allocation',
            error: `creating this agent needs ${wanted} tokens and project side ${sideId} has `
              + `${budget.remaining} of ${budget.allocated} left (${budget.committed} committed) — raise the allocation`,
            sideId, role, tier,
            allocatedTokens: budget.allocated,
            committedTokens: budget.committed,
            remainingTokens: budget.remaining,
            requestedTokens: wanted,
          });
        }
      }

      provisionReservations.set(key, reserved + 1);
      /*
       * The name carries the SIDE when there is one. `mx_${role}_${tier}_${seq}` is unattributable,
       * and ADR-016 decision 7's cascade needs exactly that attribution to know what to take with a
       * side when it is removed. Without a side the existing format is kept, because that request is
       * not a side's to account for.
       */
      const name = sideId
        ? `mx_${sideId.replace(/[^a-z0-9]+/g, '_')}_${role}_${tier}_${dispatchTicketSeq++}`
        : `mx_${role}_${tier}_${dispatchTicketSeq++}`;
      return res.json({
        status: 'provision', role, tier, name, runtime: TIER_RUNTIME[tier],
        ...(sideId ? { sideId, budget: sideBudgetFor(sideId) } : {}),
      });
    }
  }
  const ticket = `disp-${Date.now()}-${dispatchTicketSeq++}`;
  const q = dispatchQueues.get(key) || [];
  q.push({ ticket, role, tier, task: req.body?.task ?? null, room: req.body?.room ?? null });
  dispatchQueues.set(key, q);
  res.json({ status: 'queued', ticket, role, tier, queueDepth: q.length });
});

// Extend a lease's expiresAt from now (Task 7). Requires the exact (leaseId, agent, owner)
// tuple that POST /api/dispatch handed out; this is how a long task survives past one TTL
// window — the lease is never killed on createdAt age alone as long as it keeps renewing.
app.post('/api/dispatch/renew', (req, res) => {
  const leaseId = req.body?.leaseId ? String(req.body.leaseId) : null;
  const agent = req.body?.agent ? String(req.body.agent) : null;
  const owner = req.body?.owner ? String(req.body.owner) : null;
  if (!leaseId || !agent || !owner) {
    return res.status(400).json({ error: 'leaseId, agent, and owner are required', reason: 'missing_fields' });
  }
  try {
    const lease = dispatchLeaseStore.renew({ leaseId, agent, owner });
    return res.json({ status: 'renewed', agent, leaseId: lease.leaseId, expiresAt: lease.expiresAt });
  } catch (error) {
    return respondDispatchLeaseError(res, error);
  }
});

// Free a reserved agent; if a ticket is waiting for its cell, reserve it again and hand the
// caller the drained ticket to deliver. (Auto-provision of new agents is Phase 4.)
//
// Task 7 ownership: pass {agent, leaseId, owner} to release under the strict lease contract
// (owner mismatch / unknown-or-stale leaseId / already-expired lease → rejected, distinct 4xx
// reasons). {agent} alone (no leaseId, no owner) is the pre-Task-7 legacy shape — rejected by
// default (`missing_fields`, since it can't prove ownership of anything) unless
// HAFLEET_ALLOW_LEGACY_RELEASE=1 is set, in which case it releases whatever lease currently
// holds that agent, no ownership check. Passing exactly one of leaseId/owner (not both, not
// neither) is always a malformed request, rejected as `missing_fields` regardless of the flag.
app.post('/api/dispatch/release', (req, res) => {
  const name = req.body?.agent ? String(req.body.agent) : null;
  if (!name) return res.status(400).json({ error: 'agent required' });
  const leaseId = req.body?.leaseId ? String(req.body.leaseId) : null;
  const owner = req.body?.owner ? String(req.body.owner) : null;
  if (leaseId || owner) {
    if (!leaseId || !owner) {
      return res.status(400).json({ error: 'leaseId and owner must be provided together', reason: 'missing_fields' });
    }
    try {
      dispatchLeaseStore.release({ leaseId, agent: name, owner });
    } catch (error) {
      return respondDispatchLeaseError(res, error);
    }
  } else if (DISPATCH_ALLOW_LEGACY_RELEASE) {
    dispatchLeaseStore.releaseByAgent(name); // shim explicitly enabled — tolerant no-op if nothing to release
  } else {
    return res.status(400).json({
      error: 'leaseId, agent, and owner are required (set HAFLEET_ALLOW_LEGACY_RELEASE=1 to allow legacy {agent}-only release)',
      reason: 'missing_fields',
    });
  }
  const rec = agents[name];
  const role = rec ? agentRole(serializeAgent(rec)) : null;
  const tier = rec ? agentCapability(serializeAgent(rec)) : null;
  if (role && tier) {
    const key = cellKey(role, tier);
    const q = dispatchQueues.get(key) || [];
    const next = q.shift();
    if (next) {
      dispatchQueues.set(key, q);
      // Re-reserve for the drained ticket under a fresh lease. The releasing owner (if any)
      // picks it back up; legacy (ownerless) releases fall back to the default owner.
      const drainedLease = dispatchLeaseStore.create({
        agent: name, owner: owner || DISPATCH_LEASE_DEFAULT_OWNER, taskId: null, ticket: next.ticket,
        role, tier, task: next.task, room: next.room,
      });
      return res.json({ status: 'drained', agent: name, ...next, leaseId: drainedLease.leaseId, expiresAt: drainedLease.expiresAt });
    }
  }
  res.json({ status: 'released', agent: name });
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

app.delete('/api/agents/:name', requireBearer, async (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  if (req.query.force === 'true') {
    /*
     * STOP IT FIRST. Deleting the record left the agent's tmux session and its codex process
     * running: an orphan that keeps spending the contributor's tokens, keeps its MCP server talking
     * to a backend that no longer knows it, and holds the workspace — while the console reports the
     * agent gone. Observed for real: a session from 00:03 still alive after the record was deleted
     * at 07:55.
     *
     * Not conditional on `online`: the record's own liveness can be stale, and the session either
     * exists or it does not — asking tmux is cheaper and more truthful than trusting the flag.
     */
    const sessionName = normalizeOptionalText(String(agent.tmux || '').split(':')[0], 128) || agentName;
    /*
     * Through `hostRuntime`, never a direct shell-out to the tmux binary. The first version of this
     * fix did exactly that and tests/runtime-interface.test.js rejected it: 34 raw invocations were
     * extracted from this file precisely so it does not assume one platform, and adding one back
     * re-couples it. (The invariant is a source grep, so this comment must not spell the forbidden
     * call either — quoting it verbatim tripped the check on the very line explaining the rule.) Gated on the capability for the same reason — a headless ACP runtime has no
     * pane to kill, and it answers for itself rather than being assumed to behave like tmux.
     */
    let stopped = false;
    if (hostRuntime.capabilities.sessions) {
      stopped = await hostRuntime.killSession(sessionName);
      if (stopped) console.log(`Agent '${agentName}': stopped session '${sessionName}' before deleting`);
    } else {
      console.warn(`[backend] ${hostRuntime.name} runtime cannot stop sessions; deleting '${agentName}' may leave its process running`);
    }
    const deletion = clearDeletedAgentState(agentName);
    if (!deletion.ok) return res.status(503).json({ error: deletion.error || 'agent force-delete persistence failed' });
    console.log(`Agent '${agentName}' permanently deleted`);
    auditLog(req, { agent: agentName, summary: { action: 'force-delete', sessionKilled: stopped } });
    return res.json({ ok: true, deleted: true, name: agentName, sessionKilled: stopped });
  }
  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  agent.tmux = null;
  agent.lastSeen = Date.now();
  if (!agent.offlineReason) agent.offlineReason = 'inactive';
  transitionAgent(agentName, 'api_unregister');
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  auditLog(req, { agent: agentName, summary: { action: 'unregister' } });
  res.json({
    ok: true,
    deprecated: true,
    message: 'unregister is disabled; agent marked inactive. Use ?force=true to permanently delete.',
    agent: serializeAgent(agent),
  });
});

app.post('/api/agents/:name/undelete', requireBearer, (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!deletedAgentTombstones[agentName]) return res.status(404).json({ error: 'no tombstone found' });
  delete deletedAgentTombstones[agentName];
  saveJson('deleted_agents.json', deletedAgentTombstones, { immediate: true });
  auditLog(req, { agent: agentName, summary: { action: 'undelete' } });
  console.log(`Agent '${agentName}' tombstone removed — re-registration allowed`);
  res.json({ ok: true, undeleted: true, name: agentName });
});

app.post('/api/agents/:name/supervisor', requireBearer, (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'local-only endpoint' });
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const supervisorName = `supervisor-${agentName}`;
  if (agents[supervisorName] && isAgentRecord(agents[supervisorName])) {
    return res.json({ ok: true, alreadyExists: true, supervisor: supervisorName });
  }
  try {
    provisionSupervisorAgent(agentName);
  } catch (e) {
    console.error(`[supervisor-provision] failed for ${agentName}:`, e.message);
    return res.status(500).json({ error: 'provisioning failed', detail: e.message });
  }
  const record = buildSupervisorAgentRecord(supervisorName, agentName);
  agents[supervisorName] = record;
  saveAgents();
  try { supervisorLifecycleManager.sweepAll(); } catch (_) { /* best-effort */ }
  auditLog(req, { agent: agentName, summary: { action: 'provision-supervisor', supervisor: supervisorName } });
  console.log(`[supervisor-provision] provisioned ${supervisorName} for ${agentName}`);
  res.json({ ok: true, supervisor: supervisorName });
});

app.get('/api/agents/:name/launch-env', requireBearer, (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'local-only endpoint' });
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  const rp = normalizeRuntimeProfile(agent.runtimeProfile);
  res.json({ runtimeProfile: rp || null });
});

/**
 * Provision a NEW agent — the step nothing could do before.
 *
 * THE HOLE THIS FILLS. Every launcher in the system starts an agent that already exists:
 * `/start` 404s on an unknown name, and the supervisor's own comment says it "launches into an
 * already-provisioned home". The only writer of a new agent record is `POST /api/agents`, which is
 * `requireAgentToken` — the agent registers ITSELF. But it cannot authenticate without a token, and
 * the token lives in a provisioned home, and the only thing that provisioned a home was a shell
 * command. So the first launch of any agent had to be typed by a human on the host, and no UI
 * could offer it.
 *
 * WHY local-only, like `/start`. This spawns a process on the machine the backend runs on. A
 * console served from host A cannot provision on contributor host B — that needs an agent-side
 * daemon there, which does not exist. Rather than pretend otherwise, the constraint is enforced
 * here and stated on the page.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: launch. Provisioning writes a home, a token and an offline
 * agent record; `/start` runs it. Kept separate because they fail for unrelated reasons — a
 * provisioning failure is a filesystem or naming problem, a launch failure is tmux or the
 * framework CLI — and a single call would report the second while hiding which one happened.
 */
/**
 * The agent's pane, as text. Read-only.
 *
 * Asked for directly: "why don't you show the live tmux session in the console". Everything needed
 * already existed — `hostRuntime.capturePane` and `captureLocalPaneContentAsync` — but only the old
 * dashboard on its own port exposed it (`GET /api/tmux/capture/:session` in server.js), and the
 * console proxy speaks to this backend alone. So the capability was present and unreachable.
 *
 * Through the runtime, never a direct tmux call: tests/runtime-interface.test.js forbids the latter,
 * and gating on `capabilities.capture` is what keeps this honest on a headless ACP runtime, which
 * has no pane to capture and says so rather than returning an empty string that reads as "idle".
 *
 * `requireBearer` and NOT local-only: capturing is a read, and unlike /start it spawns nothing. But
 * a pane is the agent's raw screen — it can contain anything the agent printed, including secrets it
 * was handed — so it stays behind the operator credential and is never part of any public payload.
 */
app.get('/api/agents/:name/pane', requireBearer, async (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  if (!hostRuntime.capabilities.capture) {
    /*
     * 501, not an empty capture: "this runtime cannot show you a screen" and "the screen is blank"
     * are different answers, and a caller that cannot tell them apart will render the second.
     */
    return res.status(501).json({
      error: `the ${hostRuntime.name} runtime cannot capture a pane`,
      capture: false,
    });
  }
  const target = normalizeOptionalText(agent.tmux, 128);
  if (!target) {
    return res.status(409).json({ error: 'agent has no pane', reason: agent.online ? 'no_tmux_target' : 'offline' });
  }
  try {
    /*
     * `{ text, hash }`, not a bare string — this helper hashes for the change-detection callers, and
     * assuming a string here cost one round trip with `text.split is not a function`.
     */
    const capture = await captureLocalPaneContentAsync(target);
    if (!capture || typeof capture.text !== 'string') {
      // The pane target is recorded but the runtime could not read it — a session that has gone.
      return res.status(409).json({ error: 'pane could not be captured', target, reason: 'capture_failed' });
    }
    const text = capture.text;
    return res.json({
      ok: true,
      agent: agentName,
      target,
      capturedAt: Date.now(),
      // The hash lets a poller skip re-rendering an unchanged pane.
      hash: capture.hash,
      // Line-capped so one enormous paste cannot make this response the biggest thing on the wire.
      text: text.split('\n').slice(-400).join('\n'),
    });
  } catch (error) {
    console.error(`[pane] capture failed for ${agentName}: ${error.message}`);
    return res.status(502).json({ error: 'pane capture failed', detail: error.message });
  }
});

app.post('/api/agents/:name/provision', requireBearer, (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'local-only endpoint' });
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  /*
   * Refused rather than merged. Provisioning re-runs a script that writes a home directory and a
   * token; doing that over a live agent could replace the credential it is currently authenticating
   * with, which would take a working agent offline for no stated reason.
   */
  if (isAgentRecord(agents[agentName])) {
    return res.status(409).json({ error: `agent '${agentName}' already exists` });
  }

  const framework = normalizeOptionalText(req.body?.framework, 32);
  const VALID_FRAMEWORKS = new Set(['claude', 'codex']);
  if (!framework || !VALID_FRAMEWORKS.has(framework)) {
    return res.status(400).json({ error: `framework must be one of: ${[...VALID_FRAMEWORKS].join(', ')}` });
  }

  const presetId = normalizeOptionalText(req.body?.presetId, 128) || null;
  const preset = presetId ? frameworkPresets.find((p) => p.id === presetId) : null;
  if (presetId && !preset) return res.status(400).json({ error: `unknown preset: ${presetId}` });
  /*
   * A preset whose framework disagrees with the requested one would produce an agent whose
   * runtimeProfile says codex while its launcher runs claude. Refused here, where the mismatch is
   * still a sentence, rather than at launch where it is a confusing crash.
   */
  if (preset?.framework && preset.framework !== framework) {
    return res.status(400).json({
      error: `preset '${preset.name}' is for ${preset.framework}, not ${framework}`,
    });
  }

  /*
   * `~/foo` is expanded rather than refused. The onboarding form's own placeholder shows `~/ops-ws`,
   * so the shape it teaches was the shape the API rejected — and `normalizeWorkspacePath` wants an
   * absolute path. The expansion is unambiguous HERE and only here: this endpoint is local-only, so
   * `~` can only mean the home of the user the backend runs as, which is the same user the agent
   * will run as. It would not be well-defined on a remote route, which is why it is not done in the
   * shared helper.
   */
  const rawProject = String(req.body?.project ?? '').trim();
  const tildeExpanded = rawProject === '~' || rawProject.startsWith('~/')
    ? path.join(homedir(), rawProject.slice(1))
    : rawProject;
  const project = normalizeWorkspacePath(tildeExpanded);
  if (rawProject && !project) {
    return res.status(400).json({ error: 'project must be an absolute path (or start with ~/)' });
  }

  /*
   * Created if missing, because the form's own hint promises it ("created automatically if it does
   * not exist") while `provision-v1-agent-home.js` refuses with "project path does not exist". The
   * contradiction is what an operator actually hit: they typed a directory they intended to work in
   * and provisioning failed.
   *
   * Only a directory is created, and only the one named. This is a local-only, operator-authenticated
   * route, so the path is the caller's own filesystem and the caller just asked for it — but it is
   * still a write outside the runtime dir, which is why it is logged.
   */
  if (project && !existsSync(project)) {
    try {
      mkdirSync(project, { recursive: true });
      console.log(`[provision] created project directory ${project}`);
    } catch (error) {
      return res.status(400).json({ error: `could not create project directory ${project}: ${error.message}` });
    }
  }

  const script = path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js');
  const args = [script, '--name', agentName, '--type', framework];
  if (project) args.push('--project', project, '--project-mode', 'symlink');

  let provisioned;
  try {
    // Synchronous on purpose: the caller cannot do anything useful until the home exists, and a
    // detached provision whose failure arrives later is how a UI ends up showing a half-made agent.
    const out = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    provisioned = JSON.parse(out);
  } catch (error) {
    // stderr carries the actual reason (bad name, unreadable project path, template missing).
    const detail = String(error?.stderr || error?.message || 'provisioning failed').trim().slice(0, 400);
    console.error(`[provision] ${agentName} failed: ${detail}`);
    return res.status(500).json({ error: `provisioning failed: ${detail}` });
  }
  if (!provisioned?.ok || !provisioned?.paths) {
    return res.status(500).json({ error: 'provisioning script returned no paths' });
  }

  const paths = provisioned.paths;
  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  agents[agentName] = {
    name: agentName,
    kind: 'agent',
    type: framework,
    presetId,
    runtimeProfile: preset ? normalizeRuntimeProfile(runtimeProfileFromPreset(preset)) : null,
    agentId: normalizeAgentId(provisioned.name ? `agent_${agentName}` : null) || null,
    homeDir: normalizeWorkspacePath(paths.homeDir) || null,
    workdir: normalizeWorkspacePath(paths.workdir) || null,
    stateDir: normalizeWorkspacePath(paths.stateDir) || null,
    server: LOCAL_SERVER_ID,
    tmux: null,
    // Provisioned is NOT running. Said explicitly so the UI shows "ready to start" rather than a
    // bare offline agent indistinguishable from one that crashed.
    online: false,
    offlineReason: 'provisioned',
    manualDown: false,
    registeredAt: Date.now(),
    discoveredAt: Date.now(),
    lastSeen: Date.now(),
  };
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  /*
   * Reload tokens NOW. Provisioning just wrote <state>/agent-token, and until the backend loads it
   * the agent's own calls are checked against a map that has no entry — which under
   * HAFLEET_AGENT_TOKEN_MODE=hard is the difference between an agent that works and one whose every
   * request is rejected with nothing said in its pane.
   */
  loadAgentTokens();
  auditLog(req, { agent: agentName, summary: { action: 'provision', framework, presetId } });
  return res.status(201).json({
    ok: true,
    agent: serializeAgent(agents[agentName]),
    paths: { homeDir: paths.homeDir, workdir: paths.workdir, stateDir: paths.stateDir },
    nextStep: `POST /api/agents/${encodeURIComponent(agentName)}/start`,
  });
});

app.post('/api/agents/:name/start', requireBearer, (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'local-only endpoint' });
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const agent = agents[agentName];
  if (!isAgentRecord(agent)) return res.status(404).json({ error: 'agent not found' });
  if (agent.online) return res.status(409).json({ error: 'agent already online' });
  const VALID_FRAMEWORKS = new Set(['claude', 'codex']);
  const framework = agent.type;
  if (!framework || !VALID_FRAMEWORKS.has(framework)) {
    return res.status(400).json({ error: `agent has no valid framework (type='${agent.type || 'null'}'). Update agent type to claude or codex first.` });
  }
  const hafleetBin = path.join(REPO_ROOT, 'bin', 'hafleet');
  const launchEnv = { ...process.env };
  const rp = agent.runtimeProfile?.primary;
  if (rp?.apiBaseUrl) launchEnv.ANTHROPIC_BASE_URL = rp.apiBaseUrl;
  if (rp?.apiKey) launchEnv.ANTHROPIC_API_KEY = rp.apiKey;
  if (rp?.model) launchEnv.HAFLEET_LAUNCH_MODEL = rp.model;
  if (rp?.extraArgs) launchEnv.HAFLEET_LAUNCH_EXTRA_ARGS = rp.extraArgs;
  try {
    /*
     * The launcher's OUTPUT IS KEPT. This was `stdio: 'ignore'`, so a launch that failed — a
     * missing framework CLI, tmux refusing, an untrusted hook, a bad workdir — produced
     * `{ok: true, pid}` and nothing else: the endpoint reported success because the process had
     * been created, and the reason it then died went to /dev/null. Observed doing exactly that.
     */
    const logDir = path.join(RUNTIME_ROOT, 'data', 'agents', agentName);
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'launch.log');
    const logFd = openSync(logPath, 'a');
    const child = spawn(hafleetBin, ['up-v1', agentName, framework], {
      cwd: REPO_ROOT,
      env: launchEnv,
      // stdin stays closed: a launcher that waits for input from a daemon would hang forever, and
      // the one prompt that exists (codex hook trust) is designed to refuse rather than block.
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    /*
     * Attached BEFORE unref, and it still fires: unref only stops the child keeping the event loop
     * alive, it does not stop the exit event while the backend is running. This is the only place a
     * non-zero exit becomes visible at all, since the response has long since been sent.
     */
    child.on('exit', (code, signal) => {
      try { closeSync(logFd); } catch { /* already closed */ }
      if (code === 0) return;
      console.error(`[start] hafleet up-v1 ${agentName} exited ${signal ? `on ${signal}` : `with code ${code}`} — see ${logPath}`);
      /*
       * Undo the optimistic online. The record was marked running on the assumption the launch
       * would work; leaving it there after a failure claims a tmux session that does not exist,
       * which reads as a live agent that has merely gone quiet.
       */
      const a = agents[agentName];
      if (isAgentRecord(a) && !a.online) return;
      if (isAgentRecord(a)) {
        a.tmux = null;
        a.offlineReason = `launch-failed:exit-${signal || code}`;
        transitionAgent(agentName, 'api_unregister');
        saveAgents();
      }
    });
    child.unref();
    agent.tmux = `${agentName}:0.0`;
    agent.lastSeen = Date.now();
    agent.offlineReason = null;
    transitionAgent(agentName, 'api_register_with_tmux');
    saveAgents();
    auditLog(req, { agent: agentName, summary: { action: 'start', framework, pid: child.pid } });
    console.log(`[start] launched hafleet up-v1 ${agentName} ${framework} (pid=${child.pid}, log=${logPath})`);
    /*
     * `launching`, not `started`. The process exists; whether the agent comes up is decided by the
     * launcher over the next few seconds and reported by its own heartbeat. Saying "ok" alone
     * invited the caller to treat spawn success as agent success, which is the bug above.
     */
    res.json({ ok: true, name: agentName, framework, pid: child.pid, state: 'launching', log: logPath });
  } catch (e) {
    console.error(`[start] failed to launch ${agentName}:`, e.message);
    res.status(500).json({ error: 'launch failed', detail: e.message });
  }
});

app.post('/api/agents/:name/offline', requireAgentToken(_tokenFromName), (req, res) => {
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
  const persistenceSnapshot = snapshotAgentPersistenceState(agentName);
  // online/manualDown driven by machine
  agent.lastSeen = Date.now();
  agent.offlineReason = reason;
  if (clearTmux) agent.tmux = null;
  if (manualDown) syncAgentMachine(agentName, { manualDown: true });
  else syncAgentMachine(agentName, { tmuxMissing: true });
  if (!saveAgentsOrRollback(agentName, persistenceSnapshot)) {
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  if (wasOnline && !manualDown && !wasManualDown) {
    maybeEmitUnexpectedOfflineAlert(agentName, reason, { server: normalizeServer(agent.server) || 'local', detail: 'Marked offline via API' });
  }
  res.json({ ok: true, agent: serializeAgent(agent) });
});

app.post('/api/agents/:name/heartbeat', requireAgentToken(_tokenFromName), (req, res) => {
  refreshServerLiveness();
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });

  const now = Date.now();
  const server = normalizeServer(req.body?.server)
    || normalizeServer(agents[agentName]?.server)
    || (isLocalRequest(req) ? 'local' : null);
  const workspacePath = Object.prototype.hasOwnProperty.call(req.body || {}, 'workspacePath')
    ? req.body.workspacePath
    : undefined;
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const tmux = (typeof req.body?.tmux === 'string' && req.body.tmux.trim())
    ? req.body.tmux.trim()
    : `${agentName}:0.0`;

  const agentSnapshot = snapshotAgentPersistenceState(agentName);
  const runtimeSnapshot = snapshotAgentRuntimeState(agentName);
  let created = false;
  let agent = agents[agentName];
  if (!isAgentRecord(agent)) {
    const ensured = ensureAgentRecord(agentName, {
      server,
      tmux,
      online: true,
      type: 'agent',
      kind: 'agent',
      offlineReason: null,
      workdir: normalizedWorkspacePath,
    });
    if (!ensured) return res.status(410).json({ error: 'agent cannot be registered' });
    agent = ensured.agent;
    created = ensured.created;
  }

  const wasOnline = agent.online === true;
  const wasManualDown = agent.manualDown === true;
  if (server && normalizeServer(agent.server) !== server) agent.server = server;
  // The heartbeat comes from the agent's own mcp-server.js child, which sends a
  // tmux target because historically every agent had one. An ACP agent does not,
  // and accepting it here routes a paneless agent down the pane path: the
  // dashboard then asks getPaneIdleMs about a pane that cannot exist and reports
  // idleMs -1 forever. This only started happening once octos gained MCP support,
  // because before that it never sent a heartbeat at all.
  if (!wasManualDown && (!agent.tmux || !String(agent.tmux).trim())
      && agentTransport(agent) !== 'acp') agent.tmux = tmux;
  if (normalizedWorkspacePath && !normalizeWorkspacePath(agent.workdir)) agent.workdir = normalizedWorkspacePath;
  if (!wasManualDown && (agent.offlineReason === 'mcp-missing:auto' || agent.offlineReason === 'inactive')) {
    agent.offlineReason = null;
  }
  agent.lastSeen = now;
  syncAgentMachine(agentName, {
    heartbeatPresent: true,
    tmuxPresent: !wasManualDown,
    mcpPresent: true,
  });

  const runtime = ensureAgentRuntimeRecord(agentName);
  if (!runtime) {
    restoreAgentPersistenceState(agentName, agentSnapshot);
    restoreAgentRuntimeState(agentName, runtimeSnapshot);
    return res.status(500).json({ error: 'runtime update failed' });
  }
  setRuntimeMcpFields(runtime, { mcpPresent: true }, now);
  runtime.mcpHeartbeatAt = now;
  if (workspacePath !== undefined) setRuntimeWorkspacePath(runtime, { workspacePath });
  setRuntimeObservation(runtime, {
    observerSource: 'mcp-heartbeat',
    observerServer: server,
    observedAt: now,
  });
  runtime.lastSeen = now;
  runtime.updatedAt = now;

  if (!saveAgentsOrRollback(agentName, agentSnapshot)) {
    restoreAgentRuntimeState(agentName, runtimeSnapshot);
    return res.status(503).json({ error: 'agents persistence failed' });
  }
  if (!saveAgentRuntime(true)) {
    restoreAgentPersistenceState(agentName, agentSnapshot);
    restoreAgentRuntimeState(agentName, runtimeSnapshot);
    saveAgents(true);
    return res.status(503).json({ error: 'agent runtime persistence failed' });
  }

  writeThruAgentHome(agentName);
  if (!wasOnline && !wasManualDown && agent.online === true) {
    notifyAgentCatchup(agentName, 'mcp-heartbeat-restored').catch((e) => {
      console.error(`catchup notify failed for ${agentName}:`, e.message);
    });
  }
  auditLog(req, {
    agent: agentName,
    summary: {
      heartbeat: true,
      created,
      server,
      mcpPresent: true,
      observerSource: 'mcp-heartbeat',
    },
  });
  res.json({
    ok: true,
    created,
    agent: serializeAgent(agent),
    runtime: {
      agent: agentName,
      mcpPresent: runtime.mcpPresent === true,
      mcpMissingSince: Number(runtime.mcpMissingSince) || null,
      lastSeen: runtime.lastSeen || now,
      updatedAt: runtime.updatedAt || now,
      workspacePath: runtime.workspacePath || null,
      observation: serializeRuntimeObservation(runtime),
    },
  });
});

app.post('/api/agents/:name/runtime', requireAgentToken(_tokenFromName), (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });

  const blocked = req.body?.blocked === true;
  const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim())
    ? req.body.reason.trim()
    : null;
  const tail = (typeof req.body?.tail === 'string') ? req.body.tail : '';
  const command = (typeof req.body?.command === 'string') ? req.body.command : '';
  const server = normalizeServer(req.body?.server);
  const activeNow = Object.prototype.hasOwnProperty.call(req.body || {}, 'activeNow')
    ? (req.body.activeNow === true ? true : (req.body.activeNow === false ? false : null))
    : undefined;
  const activeDurationSec = req.body?.activeDurationSec;
  const idleDurationSec = req.body?.idleDurationSec;
  const lastTmuxActivitySec = req.body?.lastTmuxActivitySec;
  const workspacePath = Object.prototype.hasOwnProperty.call(req.body || {}, 'workspacePath')
    ? req.body.workspacePath
    : undefined;
  const mcpPresent = Object.prototype.hasOwnProperty.call(req.body || {}, 'mcpPresent')
    ? (req.body.mcpPresent === true ? true : (req.body.mcpPresent === false ? false : null))
    : undefined;
  const blockedObserved = Object.prototype.hasOwnProperty.call(req.body || {}, 'blockedObserved')
    ? req.body.blockedObserved === true
    : true;

  const bodyTransport = typeof req.body?.transport === 'string' ? req.body.transport.trim().toLowerCase() : '';
  let agent = agents[agentName];
  if (!isAgentRecord(agent)) {
    const ensured = ensureAgentRecord(agentName, {
      server,
      // A paneless agent reporting runtime state must not be conjured into existence
      // as a tmux agent. The body declares its transport; honour it.
      tmux: bodyTransport === 'acp' ? null : `${agentName}:0.0`,
      transport: bodyTransport === 'acp' ? 'acp' : undefined,
      online: true,
      type: 'agent',
      kind: 'agent',
      offlineReason: null,
    });
    if (!ensured) return res.status(400).json({ error: 'invalid agent name' });
    agent = ensured.agent;
    saveAgents();
  }

  const transition = applyRuntimeObservation(agentName, {
    blocked,
    reason,
    tail,
    command,
    server,
    activeNow,
    activeDurationSec,
    idleDurationSec,
    lastTmuxActivitySec,
    /*
     * SPREAD, NOT SHORTHAND — the shorthand defeated its own guard downstream.
     *
     * `workspacePath` is `undefined` when the request omitted it, and
     * `workspacePath,` puts the KEY there regardless. setRuntimeWorkspacePath()
     * correctly asks `hasOwnProperty`, sees the key, normalizes `undefined` to null,
     * and erases a path that was already known. So a heartbeat that mentioned nothing
     * about the workspace wiped it, and the next one restored it.
     *
     * Latent until something actually set the field for ACP agents: while it was always
     * null, clearing it was a no-op. It matters now because the workspace is the only
     * link between an agent and the token usage its CLI records, and attribution that
     * flickers with the heartbeat is worse than attribution that is absent.
     */
    ...(workspacePath !== undefined ? { workspacePath } : {}),
    mcpPresent,
    blockedObserved,
    observerSource: 'runtime-api',
    observerServer: server,
  });
  const runtime = dispatchBlockedNotifications(transition);
  if (!runtime) return res.status(500).json({ error: 'runtime update failed' });
  auditLog(req, {
    agent: agentName,
    summary: {
      blocked,
      reason,
      mcpPresent: runtime.mcpPresent ?? null,
      server,
      observerSource: runtime.observation?.observerSource || null,
    },
  });
  res.json({
    ok: true,
    runtime: {
      agent: agentName,
      blocked: runtime.blocked === true,
      blockedReason: runtime.blockedReason || null,
      blockedTier: normalizeBlockedTier(runtime.blockedTier, null),
      blockedSince: runtime.blockedSince || null,
      activeNow: normalizeRuntimeActiveNow(runtime.activeNow),
      activeDurationSec: Number(runtime.activeDurationSec) || 0,
      idleDurationSec: Number(runtime.idleDurationSec) || 0,
      lastTmuxActivitySec: Number(runtime.lastTmuxActivitySec) || null,
      workspacePath: runtime.workspacePath || null,
      observation: serializeRuntimeObservation(runtime),
      mcpPresent: runtime.mcpPresent === true
        ? true
        : (runtime.mcpPresent === false ? false : null),
      mcpMissingSince: Number(runtime.mcpMissingSince) || null,
      updatedAt: runtime.updatedAt || Date.now(),
    },
  });
});

app.post('/api/runtime/compact', requireBearer, (req, res) => {
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
  const result = markAgentPushDelivered(agentName, {
    ...details,
    ...notifyMeta,
  });
  appendDeliveryEvent({
    type: 'push.delivered_ack',
    source: 'backend',
    messageId: notifyMeta.sourceMsgId,
    messageIds: notifyMeta.messageIds,
    agent: agentName,
    queueEntryId: details.queueEntryId,
    queuedAt: details.queuedAt,
    deliveredAt: details.deliveredAt,
    notifyMeta,
    result: result?.ignored ? 'ignored' : 'accepted',
    reason: result?.ignored || null,
  });
  if (result?.ignored) {
    return res.json({ ok: true, agent: agentName, ignored: result.ignored });
  }
  res.json({ ok: true, agent: agentName });
});











// ── Tasks CRUD ───────────────────────────────────────────────────────
const _tokenFromTaskAssignee = r => { const t = taskStore.getTask(r.params?.id); return t?.assignee || ''; };
function parseTaskPageInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function parseTaskPageLimit(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 500);
}

function respondTaskStoreError(res, error, fallbackMessage) {
  if (error.code === 'not_found') return res.status(404).json({ error: error.message });
  if (error.code === 'persistence_failed') return res.status(503).json({ error: error.message });
  if (error.code) return res.status(400).json({ error: error.message });
  return res.status(500).json({ error: fallbackMessage });
}

function notifyTaskAssignee(task) {
  if (!task || !task.assignee) return;
  if (!isAgentRecord(agents[task.assignee])) return;
  const title = (task.title || '').trim() || '(untitled)';
  const desc = (task.description || '').trim();
  const summary = `New task assigned: ${title} (${task.id}, ${task.priority})`;
  const full = [
    `You have been assigned a new task.`,
    `id: ${task.id}`,
    `title: ${title}`,
    `priority: ${task.priority}`,
    `status: ${task.status}`,
    desc ? `description: ${desc}` : 'description: (none)',
  ].join('\n');
  try {
    dispatchInternalDirectMessage({
      from: 'system',
      to: task.assignee,
      type: 'inform',
      priority: 'normal',
      summary,
      full,
      schema: {
        kind: SYSTEM_TASK_ASSIGNED_SCHEMA_KIND,
        version: 1,
        payload: { taskId: task.id, priority: task.priority, title },
      },
    });
  } catch (e) {
    // Best-effort notification: task creation is the primary contract and must
    // succeed even if push-relay/queue isn't healthy. Surface for ops without
    // failing the request.
    console.warn(`[task] failed to notify assignee ${task.assignee} of ${task.id}: ${e.message}`);
  }
}

app.post('/api/tasks', requireBearer, (req, res) => {
  try {
    const task = taskStore.createTask(req.body || {});
    broadcastSSE('task_created', task);
    notifyTaskAssignee(task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to create task');
  }
});

app.get('/api/tasks', (req, res) => {
  const filters = {};
  if (req.query.assignee) filters.assignee = req.query.assignee;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.priority) filters.priority = req.query.priority;
  if (req.query.label) filters.label = req.query.label;
  const offset = parseTaskPageInt(req.query.offset, 0);
  const limit = parseTaskPageLimit(req.query.limit);
  let taskRows = taskStore.listTasks(filters);
  if (offset > 0 || limit !== null) {
    taskRows = taskRows.slice(offset, limit === null ? undefined : offset + limit);
  }
  const tasks = taskRows.map(task => {
    if (!task.assignee) return task;
    const snapshot = supervisorSnapshotStore.getTarget(task.assignee);
    if (!snapshot) return task;
    return { ...task, health: { state: snapshot.state, confidence: snapshot.confidence, reason: snapshot.reason, suggested_action: snapshot.suggested_action, domain: snapshot.domain, pattern: snapshot.pattern, assessed_at: snapshot.assessed_at, assessed_by: snapshot.supervisor } };
  });
  return res.json(tasks);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  // Read-through: enrich health from supervisor snapshot store
  const enriched = { ...task };
  if (task.assignee) {
    const snapshot = supervisorSnapshotStore.getTarget(task.assignee);
    if (snapshot) {
      enriched.health = {
        state: snapshot.state,
        confidence: snapshot.confidence,
        reason: snapshot.reason,
        suggested_action: snapshot.suggested_action,
        domain: snapshot.domain,
        pattern: snapshot.pattern,
        assessed_at: snapshot.assessed_at,
        assessed_by: snapshot.supervisor,
      };
    }
  }
  return res.json(enriched);
});

app.patch('/api/tasks/:id', requireBearer, (req, res) => {
  try {
    const task = taskStore.updateTask(req.params.id, req.body || {});
    broadcastSSE('task_updated', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to update task');
  }
});

app.patch('/api/tasks/:id/execution', requireAgentToken(_tokenFromTaskAssignee), (req, res) => {
  try {
    const task = taskStore.updateTaskExecution(req.params.id, req.body || {});
    broadcastSSE('task_updated', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to update task execution');
  }
});

app.delete('/api/tasks/:id', requireBearer, (req, res) => {
  try {
    const task = taskStore.deleteTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    broadcastSSE('task_deleted', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to delete task');
  }
});

app.post('/api/tasks/:id/accept', requireAgentToken(_tokenFromTaskAssignee), (req, res) => {
  try {
    const task = taskStore.transitionTask(req.params.id, 'accepted');
    broadcastSSE('task_updated', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to accept task');
  }
});

app.post('/api/tasks/:id/transition', requireAgentToken(_tokenFromTaskAssignee), (req, res) => {
  try {
    const status = (typeof req.body?.status === 'string') ? req.body.status.trim() : '';
    if (!status) return res.status(400).json({ error: 'status is required' });
    const task = taskStore.transitionTask(req.params.id, status, req.body);
    broadcastSSE('task_updated', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to transition task');
  }
});

app.post('/api/tasks/:id/comments', requireBearer, (req, res) => {
  try {
    const task = taskStore.addComment(req.params.id, req.body || {});
    broadcastSSE('task_updated', task);
    return res.json({ ok: true, task });
  } catch (error) {
    return respondTaskStoreError(res, error, 'failed to add comment');
  }
});

app.get('/api/agents/:name/tasks', (req, res) => {
  const name = normalizeAgentName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid agent name' });
  const snapshot = supervisorSnapshotStore.getTarget(name);
  const tasks = taskStore.listTasks({ assignee: name }).map(task => {
    if (!snapshot) return task;
    return { ...task, health: { state: snapshot.state, confidence: snapshot.confidence, reason: snapshot.reason, suggested_action: snapshot.suggested_action, domain: snapshot.domain, pattern: snapshot.pattern, assessed_at: snapshot.assessed_at, assessed_by: snapshot.supervisor } };
  });
  return res.json(tasks);
});

// ── Framework manifests ────────────────────────────────────────────────
/*
 * The five adapters, as a client can consume them.
 *
 * listFrameworks() has been available since the registry existed but was never
 * routed, so every caller that needed to know "which frameworks are there, and
 * what will they refuse" had to hardcode the answer. A configuration wizard is
 * the first client that cannot: it has to show the sandbox being lent before the
 * contributor commits to lending it.
 *
 * Projected rather than returned wholesale — a compiled manifest carries RegExp
 * and Set values that JSON.stringify flattens to `{}`, so a bare res.json() would
 * silently ship empty guards and read as "this framework refuses nothing".
 */
function serializeFramework(f) {
  return {
    id: f.id,
    displayName: f.displayName,
    transport: f.transport,
    launchable: f.launchable,
    notLaunchableReason: f.notLaunchableReason,
    command: f.launch?.command ?? null,
    defaultArgs: [...(f.launch?.defaultArgs ?? [])],
    modelFlag: f.launch?.modelFlag ?? null,
    permissionSummary: f.launch?.permissionSummary ?? null,
    // ACP-specific notes. `codex-acp` accepts --model and ignores it; `hermes`
    // dies on it. A wizard that offers a model choice the adapter cannot honour
    // is worse than one that says so, hence these travel with the manifest.
    acpModelFlag: f.launch?.acpModelFlag ?? null,
    acpModelFlagNote: f.launch?.acpModelFlagNote ?? null,
    commandNote: f.launch?.commandNote ?? null,
    // Flattened from the guard's Set/RegExp forms so the client can list what
    // hafleet will refuse without reimplementing the matcher.
    refusedFlags: f.flagGuard
      ? [...f.flagGuard.exact, ...f.flagGuard.prefix].sort()
      : [],
    guardMessage: f.flagGuard?.message ?? null,
  };
}

app.get('/api/frameworks', (_req, res) => {
  return res.json(listFrameworks().map(serializeFramework));
});

/*
 * What this host can actually run — probed, not declared.
 *
 * The distinction from GET /api/frameworks matters and is the reason both exist:
 * that route answers "which adapters does hafleet know", which is a property of the
 * manifests and identical on every machine. This one answers "which of them will
 * start HERE", which is a property of the machine and is the only question an
 * onboarding page can be built on. A console that showed the manifest list as
 * though it were an inventory would invite a contributor to onboard a framework
 * that is not installed, and the failure would surface at launch.
 *
 * WHAT IS PROBED AND WHAT IS NOT:
 *
 *  - **on PATH, and its version** — real, by running the binary's own version flag
 *    with a short timeout. A binary that hangs is reported as present-but-unusable
 *    rather than allowed to hang this request.
 *  - **credential home present** — real, but only that the path EXISTS. Whether the
 *    credential inside it is valid cannot be determined without spending a request
 *    against the provider, so `credentialPresent` means "there is somewhere for a
 *    login to live", never "you are logged in". Conflating those two would be the
 *    worst possible error here: it would tell a contributor they are ready when the
 *    first real task will fail on auth.
 *
 * hafleet does not install frameworks and does not hold their credentials, so the
 * response carries the one command that fixes each gap rather than offering to fix
 * it.
 */
const VERSION_FLAG = { claude: '--version', codex: '--version', 'codex-acp': '--version', octos: '--version', hermes: '--version' };

async function probeFramework(f) {
  const command = f.launch?.command ?? f.id;
  let onPath = false;
  let version = null;
  let probeError = null;
  try {
    // `which` first: a missing binary must be reported as missing, not as a
    // version probe that failed for some unexplained reason.
    await execFileAsync('which', [command], { timeout: 3000 });
    onPath = true;
  } catch {
    onPath = false;
  }
  if (onPath) {
    try {
      const { stdout } = await execFileAsync(command, [VERSION_FLAG[f.id] ?? '--version'], {
        timeout: 5000,
        // Never inherit stdin: a CLI that reads it waits forever, which is how a
        // health probe becomes an outage.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      version = String(stdout).trim().split('\n')[0].slice(0, 80) || null;
    } catch (e) {
      probeError = e?.killed ? 'version probe timed out' : (e?.message ?? 'version probe failed').slice(0, 120);
    }
  }

  /*
   * FOR AN ACP FRAMEWORK, `--version` IS NOT EVIDENCE IT CAN START.
   *
   * The probe used to stop above, so a binary that answered `--version` was
   * reported `state: ready` — and octos 0.1.1 on a fresh machine did exactly that,
   * then `hafleet acp-up` died with `unrecognized subcommand 'acp'`. The console
   * had told the operator the framework was ready for a launch path the installed
   * version does not have. This manifest's own note says it was verified against
   * 2.0.2; nothing checked that.
   *
   * So the subcommand the launch path actually uses is probed too. `--help` on it
   * is cheap, needs no credentials, starts no session and reads no stdin. Any
   * non-zero exit means the launch would fail, which is the thing `ready` claims
   * will not happen.
   */
  const acpSubcommand = f.transport === 'acp' ? (f.launch?.acpArgs ?? [])[0] : null;
  if (onPath && !probeError && acpSubcommand) {
    try {
      await execFileAsync(command, [acpSubcommand, '--help'], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const detail = String(e?.stderr || e?.message || '').split('\n')[0].slice(0, 100);
      probeError = e?.killed
        ? `\`${command} ${acpSubcommand}\` probe timed out`
        : `installed ${command} has no working \`${acpSubcommand}\` subcommand, which is how hafleet starts it: ${detail}`;
    }
  }

  /*
   * Where a login would live. Reported as a path relative to home so the response
   * never contains the operator's absolute directory layout.
   */
  const CRED = {
    claude: '.claude',
    codex: '.codex',
    'codex-acp': '.codex',
    octos: path.join('.config', 'octos'),
    hermes: '.hermes',
  };
  const credRel = CRED[f.id] ?? null;
  const credAbs = credRel ? path.join(homedir(), credRel) : null;
  const credentialPresent = credAbs ? existsSync(credAbs) : null;

  /*
   * `launchable: false` does NOT mean "cannot be started".
   *
   * Every ACP manifest carries it, and every one of their reasons says the same
   * thing: `hafleet up` opens a tmux session and an ACP agent has no pane, so use
   * `hafleet acp-up` instead. That is a different START COMMAND, not an inability —
   * and reporting it as a state alongside `absent` told a contributor their
   * installed, working framework was unusable. The distinction is carried by
   * `startWith`, which already resolves to the right command per transport.
   */
  let state;
  if (!onPath) state = 'absent';
  else if (probeError) state = 'unusable';
  else if (credentialPresent === false) state = 'needs_auth';
  else state = 'ready';

  return {
    id: f.id,
    displayName: f.displayName,
    transport: f.transport,
    command,
    onPath,
    version,
    probeError,
    // `~/.codex`, never `/Users/someone/.codex`.
    credentialHome: credRel ? `~/${credRel}` : null,
    // true / false / null: null means this adapter has no credential home to check,
    // which is not the same as "not present".
    credentialPresent,
    launchable: f.launchable,
    notLaunchableReason: f.notLaunchableReason,
    permissionSummary: f.launch?.permissionSummary ?? null,
    state,
    // The one command that fixes this state, or null when nothing is wrong.
    fix: state === 'absent' ? `install ${command} and put it on PATH`
      : state === 'needs_auth' ? `${command} login`
        : state === 'unusable' ? `check that \`${command} --version\` returns`
          : null,
    startWith: f.transport === 'acp' ? 'hafleet acp-up' : 'hafleet up',
  };
}

app.get('/api/frameworks/detect', requireBearer, async (_req, res) => {
  try {
    const frameworks = await Promise.all(listFrameworks().map(probeFramework));
    return res.json({
      scannedAt: Date.now(),
      host: hostname(),
      frameworks,
      /*
       * Said in the payload, not left to the client to remember: a present
       * credential directory is not a valid session, and nothing short of a real
       * request to the provider can tell the difference.
       */
      caveat: 'credentialPresent means the credential directory exists, not that a valid session is in it',
    });
  } catch (error) {
    console.error('[frameworks/detect] probe failed:', error?.message || error);
    return res.status(500).json({ error: 'framework detection failed' });
  }
});

// ── Role capability ────────────────────────────────────────────────────
/*
 * Which roles this deployment can actually fill, and why not when it cannot.
 *
 * `lib/role-capacity.json` shipped with no consumer at all: the role vocabulary
 * existed as a constant nothing imported, and the enumeration of which
 * (framework, model, reasoning) combinations qualify at each tier existed only as
 * a file. This is its first reader, which means role eligibility is now computed
 * from each agent's RESOLVED MODEL rather than inferred from its name.
 *
 * Two distinctions the response keeps that a headcount would lose:
 *
 *  - **Why a role cannot be filled.** "A model I have not configured" and "an
 *    agent I do not own" are different problems with different fixes, so `unable`
 *    carries a reason per agent rather than a total.
 *  - **What subsumption costs.** A stronger tier fills a weaker role, so an
 *    Opus-only deployment fills everything and pays Opus rates to write
 *    documentation. `overTier` reports that rather than the check refusing it —
 *    it is the operator's trade to make.
 *
 * Read-only, and it deliberately does not decide anything: nothing here staffs,
 * reserves or dispatches. It answers what is possible.
 */
/*
 * Guarded, unlike GET /api/frameworks.
 *
 * It was left open on the reasoning that role capability is the outward-facing layer.
 * But the payload names AGENTS — which agent backs each role, its tier, its family,
 * its online state — and ADR-013's L2 boundary is precisely that a project sees roles
 * and never the raw agents behind them. An open endpoint that publishes the private
 * half of that mapping inverts the boundary it was meant to express. A project-facing
 * projection would have to drop `able`/`unable` entirely; until one exists, this is
 * the contributor's own view and is authenticated as such.
 */
app.get('/api/capability', requireBearer, (_req, res) => {
  refreshServerLiveness();
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const TIER_RANK = Object.fromEntries(
    [...CAPABILITY_TIERS].reverse().map((t, i) => [t, i]),
  );

  const roles = ROLES.map((key) => {
    const def = roleCapacity.roles[key];
    const need = ROLE_DEFAULT_TIER[key];
    const able = [];
    const unable = [];

    for (const a of rows) {
      const tier = modelTier(a.runtimeProfile);
      if (!tier) {
        // Two different absences, and the fix differs: no profile at all versus a
        // profile whose model no tier accepts.
        unable.push({
          agent: a.name,
          reason: a.runtimeProfile?.primary?.model ? 'model-not-accepted' : 'no-model',
          model: a.runtimeProfile?.primary?.model ?? null,
        });
        continue;
      }
      if (TIER_RANK[tier] < TIER_RANK[need]) {
        unable.push({ agent: a.name, reason: 'below-tier', tier, need });
        continue;
      }
      able.push({
        agent: a.name,
        tier,
        family: modelFamily(a.runtimeProfile),
        overTier: TIER_RANK[tier] - TIER_RANK[need],
        online: a.online === true,
      });
    }

    const families = [...new Set(able.map((r) => r.family).filter(Boolean))].sort();
    return {
      role: key,
      displayName: def.displayName,
      defaultTier: need,
      // lib/matrix-agent.js:26 — review must be staffed from two different model
      // families, so one family cannot cover both sides however many agents it
      // has. Reported as a property of the role, not as a warning.
      crossFamily: def.crossFamily === true,
      crossFamilyOk: def.crossFamily === true ? families.length >= 2 : true,
      families,
      /*
       * FILLABLE MEANS STAFFABLE, NOT "MEETS THE TIER BAR".
       *
       * This was `able.length`, which ignores the cross-family rule right above it —
       * so a deployment with one model family reported `review` as
       * `fillable: 1, crossFamilyOk: false`, two fields of the same object
       * contradicting each other. Review needs two different families, so one agent
       * cannot staff it however strong it is, and a caller reading the headline
       * number was told it could.
       *
       * Found on a clean single-agent install; a mixed-family deployment never shows
       * it, which is why it survived. The console already gated on both
       * (mockup/lib/derive.js:170) — this makes the API agree with the surface that
       * was getting it right.
       *
       * `able` still lists every agent that clears the tier, so nothing is hidden:
       * the two fields now answer different questions instead of the same one twice.
       */
      fillable: (def.crossFamily === true && families.length < 2) ? 0 : able.length,
      able,
      unable,
      overTier: able.filter((r) => r.overTier > 0).length,
      excluded: (roleCapacity.excluded ?? []).filter((e) => e.role === key),
    };
  });

  return res.json({
    generatedAt: Date.now(),
    tiers: CAPABILITY_TIERS,
    agents: rows.length,
    // Named so a client cannot mistake a computed judgement for stored state.
    source: 'lib/role-capacity.json',
    roles,
  });
});

// ── Engagements, offers, whitelist ─────────────────────────────────────
/*
 * What replaces dispatch. See lib/engagement-store.js for the routing rules and
 * why each branch is the way it is; this layer supplies the two facts the store
 * deliberately does not know.
 *
 *  - WHICH AGENT would serve a role. That is the capability model's answer, and it
 *    has to be computed BEFORE a decision so an approval form can name whose
 *    ceiling is about to be spent.
 *  - HOW MUCH IS LEFT on that agent. Its declared ceiling minus what active
 *    engagements have already committed against it. Per agent, because an
 *    engagement draws on one agent's ceiling — two projects wanting an architect
 *    served by the same agent share it.
 */

/** The agent that would serve a role: qualified, and with the most headroom. */
/**
 * What is disclosed about the resource serving a role — and what is not.
 *
 * OPERATOR RULING 2026-08-11, inverting ADR-013 decision 2: the coding agent and its model
 * are not hidden from the borrower, they are made TRANSPARENT. See the amendment in
 * `knowledge/decisions/adr-013-resource-contribution-console.md`.
 *
 * The original decision reasoned that hiding the `(agent × model)` mapping is what makes
 * this a resource market rather than a remote-shell directory. The opposite is more likely
 * true, and it is why this reads as a correction rather than a relaxation: a market where
 * model quality is undisclosed is a market where the borrower cannot tell Opus from a cheap
 * model, so they discount every offer to the worst case. For a CONTRIBUTION console that is
 * backwards — a contributor lending their Opus subscription becomes indistinguishable from
 * one lending nothing much, and disclosure is what makes the contribution legible.
 *
 * THE LINE THAT REPLACES THE OLD ONE. Not "everything is public" — the distinction is
 * between the CAPABILITY and the DEPLOYMENT:
 *
 *   disclosed   framework, model, reasoning level, the tier it qualifies at, the agent's
 *               name — everything a borrower needs to judge whether the work will be good
 *               enough, and to attribute it afterwards
 *
 *   private     host, workspace path, credential home, seat, API keys, tmux session, owner
 *               MXID, env var names — the provider's deployment, which tells a borrower
 *               nothing about the work and is a standing invitation to probe
 *
 * The request direction is unchanged: a borrower still asks for a ROLE and cannot pick an
 * agent (`b.agent` is a hint that must independently qualify, refused otherwise). So the
 * provider keeps allocation freedom while the borrower is told what they got. Choosing is
 * still the provider's; knowing is now the borrower's.
 */
function servingConfiguration(agentName) {
  if (!agentName) return null;
  const row = Object.values(agents).filter(isAgentRecord).map(serializeAgent)
    .find((a) => a.name === agentName);
  if (!row) return null;
  const primary = row.runtimeProfile?.primary ?? {};
  return {
    agent: agentName,
    framework: primary.framework ?? row.type ?? null,
    model: primary.model ?? null,
    /*
     * Included because it is load-bearing rather than decorative: the same model at a
     * different reasoning level is a different tier (`lib/role-capacity.json` lists
     * gpt-5.6-sol at both high and medium, qualifying differently), so a model name alone
     * does not tell a borrower what they are getting.
     */
    reasoning: primary.reasoning ?? null,
    tier: modelTier(row.runtimeProfile) ?? null,
  };
}

function agentForRole(role) {
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const TIER_RANK = Object.fromEntries([...CAPABILITY_TIERS].reverse().map((t, i) => [t, i]));
  const need = ROLE_DEFAULT_TIER[role];
  if (!need) return null;
  const qualified = rows
    .map((a) => ({ a, tier: modelTier(a.runtimeProfile) }))
    .filter(({ tier }) => tier && TIER_RANK[tier] >= TIER_RANK[need]);
  if (!qualified.length) return null;
  /*
   * Most headroom first, so a second request for the same role does not pile onto
   * the agent that is already nearly committed. Deliberately NOT round-robin: the
   * point is to keep as many roles fillable as possible, and an agent with nothing
   * left cannot fill anything however fairly it was chosen.
   */
  qualified.sort((x, y) => (remainingFor(y.a.name) ?? -1) - (remainingFor(x.a.name) ?? -1));
  return qualified[0].a.name;
}

/**
 * What is left on the SEAT this agent occupies, or null if no quota is declared.
 *
 * The seat is the accounting root: agents sharing a credential home share one quota
 * however much each of them declares. Without this, the per-agent ceiling was the
 * only constraint and it is the wrong one — verified against a running backend, two
 * agents with 5M ceilings on a seat declared at 6M both took a 4M allocation, for
 * 8M committed against 6M. The seat page reported `overSubscribed: true` afterwards
 * and nothing had stopped it.
 */
function seatRemainingFor(agentName) {
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const target = rows.find((a) => a.name === agentName);
  if (!target) return null;
  const seatId = seatIdentity(target, { keyId: SEAT_KEY_ID, secret: SEAT_KEY_SECRET }).seatId;
  const quota = Number(seatDeclarations[seatId]?.quotaTokens);
  // Undeclared quota is UNKNOWN, not unlimited. Returning null lets the caller
  // decide; returning Infinity here would silently reinstate the bug.
  if (!Number.isFinite(quota) || quota <= 0) return null;

  const sameSeat = rows.filter((a) => (
    seatIdentity(a, { keyId: SEAT_KEY_ID, secret: SEAT_KEY_SECRET }).seatId === seatId
  ));
  const committed = sameSeat.reduce((n, a) => n + engagementStore.committedFor(a.name), 0);
  return Math.max(0, quota - committed);
}

/**
 * How much may still be allocated to this agent: the TIGHTER of its own declared
 * ceiling and what is left on its seat.
 *
 * Both can be null, and null means "not declared" rather than "no limit". A null on
 * either side must not relax the other — so the result is the minimum of whichever
 * limits exist, and null only when neither does.
 */
/*
 * WHAT IS LEFT OF AN AGENT'S CEILING, counting what was SPENT as well as what was promised.
 *
 * This used to subtract only allocations. That was the whole truth while nothing measured
 * consumption: a ceiling could be over-promised but never over-spent, because spending was
 * invisible. Now that lib/metering measures it, the two can disagree in both directions —
 * an engagement allocated 400k and consumed 900k has exceeded the ceiling while its
 * allocation says otherwise, and one allocated 400k that consumed 50k is holding 350k it
 * has not used.
 *
 * `max(reserved, spent)`, not the sum. Consumption largely happens INSIDE an allocation, so
 * adding them double-counts the same tokens; taking the larger is the conservative reading
 * that never under-reports what the ceiling has to cover.
 *
 * SPENT IS PERIOD-SCOPED OR IT IS NOT USED. A ceiling is `{tokens, period}`, and comparing
 * an all-time total to a monthly budget exhausts it permanently. If the ledger has no
 * bucket for the current period, spend is treated as UNKNOWN rather than zero and the
 * allocation figure stands alone — an absent bucket means nobody has measured this period,
 * which is not the same as measuring none.
 */
function ceilingSpendFor(agentName) {
  const agent = Object.values(agents).filter(isAgentRecord).find((a) => a.name === agentName);
  const preset = agent?.presetId ? frameworkPresets.find((p) => p.id === agent.presetId) : null;
  const period = preset?.ceiling?.period === 'daily' ? 'daily' : 'monthly';
  const bucket = usageLedger.currentPeriod(agentName, period);
  return {
    period,
    reserved: engagementStore.committedFor(agentName),
    /*
     * `drawn`, NOT `total`. A ceiling draws against fresh tokens; cache reads are measured
     * and reported but never spend it (CEILING_KINDS, operator ruling 2026-08-12). This
     * read was `bucket.total`, so the first agent to be metered successfully was locked out
     * at 13.6M against a 10M ceiling — of which 12.9M was cache reads and 681k was work.
     */
    spent: bucket ? bucket.drawn : null,
    // Kept so callers can SHOW consumption without enforcing on it. The two figures must
    // never be swapped: one is what the contributor lent, the other what was read.
    consumed: bucket ? bucket.total : null,
    ceilingTokens: Number.isFinite(preset?.ceiling?.tokens) ? preset.ceiling.tokens : null,
    presetName: preset?.name ?? null,
    spendPeriodKey: bucket?.key ?? null,
  };
}

function remainingFor(agentName) {
  const agent = Object.values(agents).filter(isAgentRecord).find((a) => a.name === agentName);
  if (!agent?.presetId) return null;
  const preset = frameworkPresets.find((p) => p.id === agent.presetId);
  const ceiling = preset?.ceiling?.tokens;
  const { reserved, spent } = ceilingSpendFor(agentName);
  // An unknown spend cannot lower the figure; it also must not be read as zero, which is
  // why it falls back to the allocation rather than to `ceiling - 0`.
  const drawn = spent === null ? reserved : Math.max(reserved, spent);
  const byCeiling = Number.isFinite(ceiling) ? Math.max(0, ceiling - drawn) : null;
  const bySeat = seatRemainingFor(agentName);
  const limits = [byCeiling, bySeat].filter((v) => v !== null);
  return limits.length ? Math.min(...limits) : null;
}

/*
 * A REQUESTER IS NOT THE CONTRIBUTOR.
 *
 * `POST /api/engagements` is the one project-facing write on this surface: a project
 * asks to draw on someone's capacity. Every other engagement route — the verdict,
 * the revoke, the whitelist, the offer — is the contributor deciding. They all sat
 * behind the same `requireBearer`, so a project handed the credential it needs to
 * ASK could also approve its own request, whitelist itself for future auto-join, and
 * widen the offer it was measured against.
 *
 * This is the narrow, correct half of the scoped-token problem: the console still
 * has no read-only tier and one shared API_TOKEN still opens the rest of `/api`.
 * What is fixed here is the specific escalation — submitting no longer implies
 * deciding.
 *
 * `HAFLEET_REQUESTER_TOKEN` is a separate secret that authorises submission ONLY.
 * The operator token continues to work, because the console and the local operator
 * legitimately submit too (the seed script and the preview both do).
 */
const REQUESTER_TOKEN = String(process.env.HAFLEET_REQUESTER_TOKEN || '').trim();

function requireRequester(req, res, next) {
  if (!REQUESTER_TOKEN) return requireBearer(req, res, next);
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${REQUESTER_TOKEN}`) return next();
  // The operator may still submit; a requester may do nothing else.
  return requireBearer(req, res, next);
}

/*
 * MAKE THE APPROVAL DO SOMETHING.
 *
 * An engagement going active used to change nothing about the world: it allocated a
 * number, wrote an audit line, and left the agent unattached to the project. Six
 * active engagements existed against zero bindings. `upsertBinding()` at
 * lib/approval-store.js:186 is the record that actually attaches an agent to a
 * project room with an owner, and nothing was calling it from here.
 *
 * WHERE THE OWNER COMES FROM, in order:
 *
 *  1. An existing binding for this agent. If the agent is already bound to some
 *     project, that binding names the human who owns it and the DM room the
 *     approval flow uses — reusing it keeps one owner per agent, which is what the
 *     approval machinery assumes.
 *  2. `HAFLEET_OWNER_MXID` + `HAFLEET_OWNER_DM_ROOM`, for the first binding on a
 *     fresh deployment.
 *
 * There is deliberately no third fallback. `POST /api/dm/ensure` only broadcasts a
 * request to the bridge and returns no room id, so the backend cannot invent one,
 * and `upsertBinding` requires both fields. When neither source has an owner the
 * bind FAILS AND SAYS SO — recorded on the engagement, returned to the caller, and
 * shown in the console. Silently approving without binding is the exact defect this
 * replaces; a silent partial success would be the same defect wearing a hat.
 */
const OWNER_MXID = String(process.env.HAFLEET_OWNER_MXID || '').trim();
const OWNER_DM_ROOM = String(process.env.HAFLEET_OWNER_DM_ROOM || '').trim();

function resolveOwnerFor(agentName) {
  try {
    const existing = approvalStore.listBindings({ agent: agentName })[0];
    if (existing?.ownerMxid && existing?.ownerDmRoomId) {
      return { ownerMxid: existing.ownerMxid, ownerDmRoomId: existing.ownerDmRoomId, from: 'existing binding' };
    }
  } catch { /* store unavailable: fall through to config */ }
  if (OWNER_MXID && OWNER_DM_ROOM) {
    return { ownerMxid: OWNER_MXID, ownerDmRoomId: OWNER_DM_ROOM, from: 'HAFLEET_OWNER_MXID' };
  }
  return null;
}

/** Attach the agent to the project. Returns the outcome; never throws at the caller. */
function bindEngagement(engagement) {
  if (!engagement?.agent) {
    return { bound: false, error: 'engagement names no agent' };
  }
  const owner = resolveOwnerFor(engagement.agent);
  if (!owner) {
    return {
      bound: false,
      error: 'no owner known for this agent: set HAFLEET_OWNER_MXID and HAFLEET_OWNER_DM_ROOM, '
        + 'or let the Matrix bridge create the first binding',
    };
  }
  try {
    approvalStore.upsertBinding({
      agent: engagement.agent,
      project: engagement.project,
      project_room_id: engagement.projectRoomId,
      owner_mxid: owner.ownerMxid,
      owner_dm_room_id: owner.ownerDmRoomId,
    });
    return { bound: true, ownerMxid: owner.ownerMxid, from: owner.from };
  } catch (error) {
    return { bound: false, error: error?.message ?? 'upsertBinding failed' };
  }
}

/**
 * Detach on revoke or rejection — but only when this was the LAST live engagement holding
 * the binding.
 *
 * A binding is keyed on `(agent, projectRoomId)` while engagements are individual, so one
 * binding serves every engagement between that agent and that room. Removing it whenever any
 * one of them ended detached the agent from the project while other engagements were still
 * ACTIVE: the access granted by an approval was revoked by an unrelated refusal.
 *
 * Not hypothetical. The live store holds six concurrent active engagements for a single
 * (agent, project room) pair, each drawing on the ceiling separately, so refusing a seventh
 * request would have cut the access the other six were relying on — a rejection acting as a
 * revocation of work nobody decided to end.
 *
 * Caught by tests/engagement-binding.test.js, and only because that case approves before it
 * rejects. Rejecting without a prior approval cannot tell "the rejection removed nothing"
 * from "nothing was there to remove", which is why the first version of that test passed
 * against this bug.
 */
function unbindEngagement(engagement) {
  if (!engagement?.agent || !engagement?.projectRoomId) return;
  try {
    /*
     * Live means active or pending — anything a project could still be relying on.
     *
     * The `e.id !== engagement.id` term is REDUNDANT TODAY and kept deliberately. The store
     * records the new state before calling here, so this engagement is already `rejected` or
     * `revoked` and the state filter alone excludes it; a mutation removing the id term
     * passes every test, which is the honest description of it. It stays because the
     * alternative failure is silent and total: if that ordering ever changed, the engagement
     * would count itself as still live and NOTHING would ever unbind, leaving standing
     * reachability behind every ended engagement.
     */
    const stillLive = engagementStore.list()
      .filter((e) => e.id !== engagement.id
        && e.agent === engagement.agent
        && e.projectRoomId === engagement.projectRoomId
        && (e.state === 'active' || e.state === 'pending'));
    if (stillLive.length > 0) {
      console.log(
        `[engagements] keeping ${engagement.agent} bound to ${engagement.projectRoomId}: `
        + `${stillLive.length} engagement(s) still live`,
      );
      return;
    }
    approvalStore.removeBinding(engagement.agent, engagement.projectRoomId);
  } catch (error) {
    // A binding that was never created is not an error worth failing the revoke for.
    console.warn(`[engagements] unbind ${engagement.agent}: ${error?.message ?? error}`);
  }
}

function respondEngagementError(res, error, fallback) {
  if (error instanceof EngagementError) {
    const status = { bad_request: 400, not_found: 404, conflict: 409, over_commit: 409, no_ceiling: 409 }[error.code] ?? 500;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error(`[engagements] ${fallback}:`, error?.message || error);
  return res.status(500).json({ error: fallback });
}

app.get('/api/engagements', requireBearer, (req, res) => {
  const state = normalizeOptionalText(req.query.state, 32) || undefined;
  const rows = engagementStore.list({ state }).map((e) => ({
    ...e,
    // What is LEFT on the agent behind it, so the queue can show over-commitment
    // before the decision rather than reporting it afterwards.
    agentRemainingTokens: e.agent ? remainingFor(e.agent) : null,
  }));
  return res.json({ engagements: rows, generatedAt: Date.now() });
});

app.get('/api/engagements/audit', requireBearer, (req, res) => {
  const limit = Number(req.query.limit) || 200;
  return res.json({ audit: engagementStore.listAudit({ limit }) });
});

/*
 * An inbound request. Routed on arrival, and the agent is resolved here so the
 * record names it from the start.
 *
 * Not guarded by requireApprovalBridgeSecret: an engagement request comes from a
 * project, which is a different caller from the bridge that carries per-tool-call
 * approvals. Wiring it behind the bridge secret would have made the console unable
 * to read its own queue, which is the mistake the existing binding endpoint makes.
 */
app.post('/api/engagements', requireRequester, (req, res) => {
  try {
    const b = req.body || {};
    const role = normalizeOptionalText(b.role, 64);
    if (!ROLES.includes(role)) return res.status(400).json({ error: `unknown role: ${role}` });

    /*
     * WHICH AGENT SERVES A ROLE IS NOT THE REQUESTER'S CHOICE.
     *
     * `normalizeOptionalText(b.agent) || agentForRole(role)` let the body override the
     * capability model entirely: posting `{ role: 'architect', agent: 'some-weak-agent' }`
     * produced an architect engagement served by an agent that does not qualify at
     * `strong`, and auto-joined it if that agent had headroom. The tier check was
     * simply skipped.
     *
     * A requested agent is now a HINT, honoured only if it independently qualifies
     * for the role. Anything else falls back to the capability model's own answer.
     */
    const requested = normalizeOptionalText(b.agent, 128);
    let agent = agentForRole(role);
    if (requested) {
      const TIER_RANK = Object.fromEntries([...CAPABILITY_TIERS].reverse().map((t, i) => [t, i]));
      const row = Object.values(agents).filter(isAgentRecord).map(serializeAgent)
        .find((a) => a.name === requested);
      const tier = row ? modelTier(row.runtimeProfile) : null;
      const qualifies = tier && TIER_RANK[tier] >= TIER_RANK[ROLE_DEFAULT_TIER[role]];
      if (qualifies) agent = requested;
      else if (row) {
        // Refused rather than silently reassigned: a caller that named an agent is
        // making a claim, and quietly serving a different one hides that it was wrong.
        return res.status(400).json({
          error: `${requested} does not qualify for ${role} (needs ${ROLE_DEFAULT_TIER[role]}, has ${tier ?? 'no qualifying model'})`,
        });
      } else {
        return res.status(400).json({ error: `unknown agent: ${requested}` });
      }
    }
    const engagement = engagementStore.createRequest({
      project: b.project,
      projectRoomId: b.projectRoomId,
      role,
      requester: b.requester,
      requestedTokens: b.requestedTokens,
      ratePerDay: b.ratePerDay,
      /*
       * PRD A-R0-1: repeating the same request_id and digest yields the same
       * assignment; a different digest is a conflict. The bridge supplies the Matrix
       * event id, which both sides already share and the sender cannot forge.
       *
       * Optional, because requiring it would refuse every existing caller. Its absence
       * is recorded on the engagement rather than replaced with a generated key, so a
       * request that could not be deduped says so.
       */
      requestId: b.requestId,
      agent,
      remainingTokens: agent ? remainingFor(agent) : null,
    });
    /*
     * An auto-join goes straight to active, so it must bind here — the verdict
     * route it would otherwise pass through never runs for it.
     */
    /*
     * `serving` rides with the engagement rather than being looked up separately, so a
     * borrower learns what they got in the same response that tells them they got it —
     * and so a caller cannot end up displaying a role without its fulfilment.
     */
    const serving = servingConfiguration(engagement.agent);
    if (engagement.state === 'active') {
      const outcome = bindEngagement(engagement);
      engagementStore.setBindingOutcome(engagement.id, outcome);
      return res.json({
        ok: true, engagement: engagementStore.get(engagement.id), binding: outcome, serving,
      });
    }
    return res.json({ ok: true, engagement, serving });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to create engagement');
  }
});

app.post('/api/engagements/:id/verdict', requireBearer, (req, res) => {
  try {
    const b = req.body || {};
    const existing = engagementStore.get(req.params.id);
    const e = engagementStore.decide({
      engagementId: req.params.id,
      approve: b.approve === true,
      allocatedTokens: b.allocatedTokens,
      // Recomputed here rather than taken from the request: a client-supplied
      // headroom would let any caller authorise the over-commitment the form
      // prevents.
      remainingTokens: existing?.agent ? remainingFor(existing.agent) : null,
      /*
       * The breakdown behind that number, so a refusal can say which draw is binding —
       * committed allocations or measured spend. Recomputed here for the same reason as
       * `remainingTokens`: it must describe the state the decision was made against.
       */
      spendContext: existing?.agent ? ceilingSpendFor(existing.agent) : null,
      by: getRequestAgentName(req) || 'operator',
      reason: b.reason,
    });
    if (e.state === 'active') {
      const outcome = bindEngagement(e);
      engagementStore.setBindingOutcome(e.id, outcome);
      /*
       * The binding outcome rides back with the verdict rather than being left for
       * the caller to discover. An approval that allocated budget but could not
       * attach the agent is a half-done thing, and the form that pressed Approve is
       * the only place anyone will look.
       */
      /*
       * `serving` rides back here for the same reason it rides with the request, and the argument
       * is stronger at this end: the request only asks, the VERDICT is where the agent is actually
       * granted. Omitting it meant the one response that says "you have it" did not say what you
       * have, so a borrower had to make a second call to learn which agent and model they were
       * given — the exact "role without its fulfilment" the request route refuses to serve.
       * Disclosed, not concealed, per the 2026-08-11 transparency ruling.
       */
      return res.json({
        ok: true,
        engagement: engagementStore.get(e.id),
        binding: outcome,
        serving: servingConfiguration(e.agent),
      });
    }
    // Rejected: nothing to attach, and anything already attached must go. No `serving` either —
    // nothing was granted, and reporting a fulfilment for a refusal would be a lie in the
    // direction that matters.
    unbindEngagement(e);
    return res.json({ ok: true, engagement: e });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to record verdict');
  }
});

app.post('/api/engagements/:id/revoke', requireBearer, (req, res) => {
  try {
    const e = engagementStore.revoke({
      engagementId: req.params.id,
      by: getRequestAgentName(req) || 'operator',
      reason: req.body?.reason,
    });
    // Revoking is the explicit act that ends a contribution, so it is the one that
    // detaches. A whitelist removal deliberately does not — see engagement-store.
    unbindEngagement(e);
    return res.json({ ok: true, engagement: e });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to revoke engagement');
  }
});

/*
 * `GET /api/offer-book?projectRoomId=…` — what a PROJECT may see before it asks.
 *
 * The gap the transparency ruling opened. Once the serving agent and its model are disclosed
 * (see the 2026-08-11 amendment to ADR-013), a borrower will reasonably want to know what is
 * on offer BEFORE committing to a request — and until now the only inbound verb was
 * `!request` itself. `/api/capability`, `/api/offers` and `/api/whitelist` all exist, but they
 * are the PROVIDER's views: every role whether offered or not, every agent including ones
 * that serve nothing, and the whitelist in full. Handing those to a project would disclose
 * the provider's whole posture, which is a different thing from disclosing what serves a role.
 *
 * So this is a separate, narrower projection rather than a relaxation of the existing three:
 *
 *   PUBLISHED OFFERS ONLY. An unpublished offer is not on offer
 *   (REQ-CONTRIBUTION-CONSOLE-ROUTE), and listing it would advertise capacity the provider
 *   has deliberately not advertised. Absent roles are omitted rather than returned as null,
 *   because a project cannot act on the difference between "not offered" and "no such role".
 *
 *   THIS ROOM'S OWN WHITELIST STATE, never the list. Whether YOUR request auto-joins is the
 *   single most actionable fact for you and yours alone; who else is trusted is not yours.
 *
 *   NO CEILINGS. The offer caps are a promise the provider published; remaining ceiling is
 *   internal state that moves with every other project's activity. A request over it still
 *   falls back to approval with `overCeiling` as the stated reason, so the fact is disclosed
 *   when it becomes relevant rather than published as a number that is stale on arrival.
 *
 * Guarded by `requireRequester`, so a project can read it with the submit-only credential —
 * the same scope that may already ask. It grants nothing new: every field is either the
 * provider's own published decision or a fact about the caller's own room.
 */
app.get('/api/offer-book', requireRequester, (req, res) => {
  const room = normalizeOptionalText(req.query.projectRoomId, 256);
  const active = engagementStore.list({ state: 'active' });
  const roles = engagementStore.listOffers()
    .filter((o) => o.published)
    .map((o) => {
      const agent = agentForRole(o.role);
      return {
        role: o.role,
        budgetCapPerEngagement: o.budgetCapPerEngagement ?? null,
        rateCap: o.rateCap ?? null,
        count: o.count ?? null,
        // Named `runningNow` rather than `used`: `count` bounds concurrent engagements, so
        // this is a live figure and not a quota consumed.
        runningNow: active.filter((e) => e.role === o.role).length,
        /*
         * Who would serve it if the request arrived now — deliberately not a reservation.
         * `agentForRole` picks by most remaining headroom, so this answer moves as other
         * projects are served, and a borrower who read it as a promise would be wrong.
         */
        serving: servingConfiguration(agent),
      };
    });
  return res.json({
    roles,
    /*
     * Null rather than false when no room was named: false would assert that the caller's
     * room is not trusted, which is a claim about a room nobody identified.
     */
    whitelisted: room ? engagementStore.isWhitelisted(room) : null,
    projectRoomId: room || null,
  });
});

app.get('/api/offers', requireBearer, (_req, res) => {
  /*
   * Every role, whether or not it has an offer. An absent offer is a real state —
   * capacity configured but not advertised — and returning only the configured ones
   * would make "not offered" indistinguishable from "role does not exist".
   */
  const configured = new Map(engagementStore.listOffers().map((o) => [o.role, o]));
  return res.json({
    offers: ROLES.map((role) => configured.get(role) ?? {
      role, count: null, budgetCapPerEngagement: null, rateCap: null, published: false, updatedAt: null,
    }),
  });
});

app.put('/api/offers/:role', requireBearer, (req, res) => {
  try {
    const role = normalizeOptionalText(req.params.role, 64);
    // Narrow, never invent: the project side has to recognise a role name for any
    // of this to mean anything, so a role outside the vocabulary is refused.
    if (!ROLES.includes(role)) return res.status(400).json({ error: `unknown role: ${role}` });
    const offer = engagementStore.setOffer({
      role,
      count: req.body?.count,
      budgetCapPerEngagement: req.body?.budgetCapPerEngagement,
      rateCap: req.body?.rateCap,
      published: req.body?.published,
      by: getRequestAgentName(req) || 'operator',
    });
    return res.json({ ok: true, offer });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to set offer');
  }
});

app.get('/api/whitelist', requireBearer, (_req, res) => {
  return res.json({ whitelist: engagementStore.listWhitelist() });
});

app.post('/api/whitelist', requireBearer, (req, res) => {
  try {
    const entry = engagementStore.addToWhitelist({
      projectRoomId: req.body?.projectRoomId,
      displayName: req.body?.displayName,
      addedBy: req.body?.addedBy,
    });
    return res.json({ ok: true, entry });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to add to whitelist');
  }
});

app.delete('/api/whitelist/:roomId', requireBearer, (req, res) => {
  try {
    const result = engagementStore.removeFromWhitelist({
      projectRoomId: req.params.roomId,
      by: getRequestAgentName(req) || 'operator',
    });
    /*
     * `stillActive` is returned rather than swallowed: removal affects future
     * requests only, so the caller has to be told what is still running under the
     * trust it just withdrew. Silently leaving them would be correct behaviour
     * reported as if nothing happened.
     */
    return res.json({ ok: true, ...result });
  } catch (e) {
    return respondEngagementError(res, e, 'failed to remove from whitelist');
  }
});

/*
 * A bearer-readable projection of the contribution binding.
 *
 * `GET /api/approval-bindings` is guarded by requireApprovalBridgeSecret — a
 * bridge-only secret — so a console holding the API token cannot read the record
 * that already carries the (agent, project, room, owner) tuple. Widening that guard
 * would hand the console the bridge's authority; this projects instead, and omits
 * `ownerDmRoomId`, which is a private channel the console has no business seeing.
 */
app.get('/api/contributions', requireBearer, (_req, res) => {
  try {
    const bindings = approvalStore.listBindings({});
    return res.json({
      contributions: bindings.map((b) => ({
        agent: b.agent,
        project: b.project,
        projectRoomId: b.projectRoomId,
        ownerMxid: b.ownerMxid,
        active: b.active !== false,
        /*
         * Three states, and the third is the point: true = membership confirmed, false = the agent
         * is NOT in a room this binding says can reach it, null = never checked. Collapsing null
         * into false would accuse every binding of being broken before the first observation.
         */
        agentJoined: b.agentJoined ?? null,
        membershipCheckedAt: b.membershipCheckedAt ?? null,
      })),
    });
  } catch (error) {
    return respondApprovalStoreError(res, error, 'failed to list contributions');
  }
});

/** What a hypothetical request WOULD do, without creating anything. */
app.get('/api/engagements/preview', requireBearer, (req, res) => {
  const role = normalizeOptionalText(req.query.role, 64);
  const projectRoomId = normalizeOptionalText(req.query.projectRoomId, 256);
  const requestedTokens = Number(req.query.requestedTokens) || 0;
  const agent = agentForRole(role);
  const decision = routeRequest({
    request: { requestedTokens, ratePerDay: Number(req.query.ratePerDay) || null },
    whitelisted: engagementStore.isWhitelisted(projectRoomId),
    offer: engagementStore.getOffer(role),
    remainingTokens: agent ? remainingFor(agent) : null,
  });
  return res.json({ ...decision, agent, agentRemainingTokens: agent ? remainingFor(agent) : null });
});

// ── Usage ──────────────────────────────────────────────────────────────
/*
 * What each contributed agent actually did, and — stated rather than implied —
 * which of those signals is measured.
 *
 * THE PARTITION IS THE POINT. Three signals, and they are not equally real:
 *
 *   tasks     MEASURED. lib/task-store.js has five statuses and every task carries
 *             an assignee, so "what did my agent work on" is answerable.
 *   busyTime  MEASURED. The runtime sweep observes each agent's pane or ACP session
 *             and records activeDurationSec / idleDurationSec.
 *   tokens    NOT MEASURED, at any granularity. Every `usage` and `budget` match in
 *             lib/ and backend-v2.js is a CLI help string.
 *
 * WHY TOKENS CANNOT SIMPLY BE ADDED. It is not a missing field. HAFleet launches a
 * coding-agent CLI and that CLI talks to the provider directly — the API traffic
 * never passes through this process, so there is no response to read a usage header
 * from. This holds in API-key mode too, which is worth saying because it is the
 * intuitive place to expect numbers and they are not there either. The two routes
 * that could work are (a) reading each framework's own session log, which is
 * per-framework and best-effort, or (b) becoming a proxy, which changes what
 * HAFleet is. Both are decisions, not omissions.
 *
 * So `tokens` is null with a reason on every row, and the `metering` block below
 * declares availability per signal so a client never has to guess which of its
 * columns is a measurement. A zero here would claim a reading nobody took, and the
 * difference between "this cost me nothing" and "I cannot see what this cost me" is
 * the whole reason a contributor opens this page.
 */
/*
 * Why a framework cannot be metered, when it cannot.
 *
 * No longer a blanket statement. HAFleet still never sees an API response — it launches a
 * CLI that talks to the provider directly — but the CLIs write the provider's own figures
 * to disk, and lib/metering reads them. So the reason is now per framework: Claude Code
 * and Codex record usage, octos records none.
 */
const TOKENS_UNAVAILABLE_REASON =
  'this framework writes no token accounting hafleet can read: hafleet launches a CLI '
  + 'that talks to the provider directly, so no API response passes through it, and this '
  + "CLI does not record the provider's figures to disk either.";

app.get('/api/usage', requireBearer, async (_req, res) => {
  refreshServerLiveness();
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const allTasks = taskStore.listTasks();
  const TASK_STATUSES = ['created', 'accepted', 'in_progress', 'blocked', 'done'];

  /*
   * Measured consumption, from the transcripts the CLIs write themselves.
   *
   * Bounded and cached (lib/metering/reader.js): a scan that opened every transcript on
   * every request would cost seconds and grow with history. Failure here degrades to
   * unavailable-with-a-reason rather than failing the endpoint — usage is a read-only
   * view, and losing the task and busy-time figures because a transcript was unreadable
   * would be the wrong trade.
   */
  let metered = null;
  let meteredError = null;
  try {
    metered = await meterFleet({ agents: rows, homeDir: homedir() });
  } catch (error) {
    meteredError = String(error?.message ?? error).slice(0, 200);
  }
  /*
   * Record what this scan saw, then answer from the LEDGER rather than the scan.
   *
   * The scan only knows what is on disk right now. The ledger knows what was ever
   * observed, which is the honest answer to "what did this agent consume" once a
   * transcript can disappear between two requests.
   */
  if (metered && !metered.cached) {
    try {
      usageLedger.record((metered.agents ?? [])
        .filter((m) => m.available)
        .map((m) => ({
          agent: m.agent,
          framework: m.framework,
          sessions: (m.files ?? []).map((f) => ({ key: f.file, totals: f.totals })),
        })));
    } catch (error) {
      // A ledger write failure must not cost the caller the figures it already has.
      meteredError = meteredError ?? `ledger write failed: ${String(error?.message ?? error).slice(0, 120)}`;
    }
  }
  const meteredByAgent = new Map((metered?.agents ?? []).map((m) => [m.agent, m]));

  const byAgent = rows.map((a) => {
    const mine = allTasks.filter((t) => t.assignee === a.name);
    const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
    for (const t of mine) if (tasksByStatus[t.status] !== undefined) tasksByStatus[t.status] += 1;
    const preset = a.presetId ? frameworkPresets.find((p) => p.id === a.presetId) : null;
    return {
      agent: a.name,
      framework: a.type ?? null,
      model: a.runtimeProfile?.primary?.model ?? null,
      // Measured.
      busySec: Number(a.activeDurationSec) || 0,
      idleSec: Number(a.idleDurationSec) || 0,
      activeNow: a.activeNow === true,
      lastActivitySec: a.lastTmuxActivitySec ?? null,
      tasks: mine.length,
      tasksByStatus,
      // Declared, which is knowable: I know what I promised.
      ceilingTokens: preset?.ceiling?.tokens ?? null,
      /*
       * Measured where the framework records it and the agent's workspace is known;
       * null with the specific reason otherwise. Never 0 — a zero here reads as "this
       * agent consumed nothing", which is a claim rather than an absence.
       */
      /*
       * THE AUTHORITY'S OWN HEADROOM FIGURE, published so nothing has to re-derive it.
       *
       * `remainingFor` is `ceiling - max(committed, measuredSpend)`. The console computed
       * `ceiling - committed` client-side instead, which agreed for as long as spend was
       * always null — and diverged the moment metering worked: the page advertised 9.8M
       * available on an agent an approval would refuse above 9.0M. A contributor reading a
       * number that the decision path does not use is worse than no number.
       *
       * Two figures, not one, because "0 left" and "no ceiling declared" are different
       * answers and only the first is a limit.
       */
      remainingTokens: remainingFor(a.name),
      ...(() => {
        const m = meteredByAgent.get(a.name);
        /*
         * The ledger's figure, which includes sessions whose transcripts are gone. It is
         * never smaller than the live scan, so preferring it cannot understate.
         */
        const ever = usageLedger.totalsFor(a.name);
        if (m?.available || ever) {
          const kinds = ever ? ever.totals : m.totals;
          return {
            tokensUsed: ever ? ever.total : m.total,
            /*
             * WHAT THE CEILING ACTUALLY DRAWS AGAINST, reported next to total consumption
             * rather than instead of it.
             *
             * `tokensUsed` is everything measured; `tokensDrawn` is fresh tokens only, which
             * is what enforcement uses (CEILING_KINDS, operator ruling 2026-08-12). Without
             * both, a console can only render a ceiling percentage from the total — which is
             * how an agent that had used 7% of its ceiling came to be shown at 136% of it and
             * refused every engagement.
             */
            tokensDrawn: CEILING_KINDS.reduce((n, k) => n + (Number(kinds?.[k]) || 0), 0),
            // The kinds stay apart: cache reads run several orders of magnitude above
            // fresh input, so one summed figure hides the only number that matters for
            // comparing two agents.
            tokensByKind: kinds,
            tokensSessions: ever ? ever.sessions + ever.retiredSessions : m.sessions,
            // Non-zero means a transcript reported less than it had before, so the figure
            // rests on a source that changed underneath. Surfaced, not buried.
            tokensSourceRegressions: ever?.regressions ?? 0,
            // True when the figure includes work whose transcript is no longer on disk.
            tokensFromLedger: Boolean(ever && !m?.available),
            tokensReason: null,
          };
        }
        return {
          tokensUsed: null,
          tokensDrawn: null,
          tokensByKind: null,
          tokensReason: m?.reason ?? (meteredError
            ? `metering failed: ${meteredError}`
            : TOKENS_UNAVAILABLE_REASON),
        };
      })(),
    };
  });

  return res.json({
    generatedAt: Date.now(),
    /*
     * Availability per signal, so a client renders a blank-with-a-reason rather
     * than inferring one from an absent key — an absent key is indistinguishable
     * from a zero once it has been through JSON.
     */
    metering: {
      tasks: { available: true, source: 'lib/task-store.js' },
      busyTime: { available: true, source: 'agent runtime observation (tmux pane / ACP session sweep)' },
      tokens: {
        /*
         * True when ANY agent could be metered, and the per-agent rows carry the detail.
         * A global false would deny measurements that exist; a global true would promise
         * ones that do not. REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE requires it per
         * framework, which is what `frameworks` below reports.
         */
        available: (metered?.attributed ?? 0) > 0,
        source: 'lib/metering — the coding CLIs\' own transcripts, which record the '
          + "provider's reported usage rather than an estimate",
        attributed: metered?.attributed ?? 0,
        unattributed: metered?.unattributed ?? null,
        // Two distinct caveats, deliberately not merged: agents that could not be
        // attributed at all, and a scan that stopped early and therefore understates.
        reason: metered?.reason ?? (meteredError ? `metering failed: ${meteredError}` : null),
        boundsReason: metered?.boundsReason ?? null,
        frameworks: [...new Set(rows.map((r) => r.type).filter(Boolean))]
          .map((f) => meteringSupport(f)),
        computedAt: metered?.computedAt ?? null,
        cached: metered?.cached ?? null,
        /*
         * WHAT IS STILL NOT MEASURED, and what would close each gap.
         *
         * This field used to name two ways to obtain token figures at all — CLI session
         * logs, or proxying provider traffic — because at the time neither existed. The
         * first is now BUILT and is the `source` named above, so presenting it as an open
         * option made the console contradict itself: an operator read "measured, from
         * lib/metering" and, three lines lower, that getting real numbers was a pending
         * decision. Same class as a panel reporting a state it never read.
         *
         * What remains genuinely open is narrower and worth naming precisely.
         */
        /*
         * EACH GAP CARRIES A STABLE ID, so a localized console does not have to print this
         * English at a reader. The `detail` stays for non-console consumers (a CLI, a log, an
         * operator reading the raw endpoint) — it is the API's own answer and should not
         * shrink to an opaque key.
         *
         * The id exists because the console echoed these paragraphs verbatim into a Chinese
         * UI, which is the same defect as the provenance line printing `lib/task-store.js`.
         * Twice was enough to make it the API's problem rather than the page's.
         */
        remainingGaps: [
          {
            id: 'per-project',
            detail: 'per-project spend: a transcript records the directory the CLI ran in, not '
              + 'which engagement the work was for, so an agent serving two projects from one '
              + 'workdir produces one undivided total. Closing it needs an engagement-scoped '
              + 'workspace, not a better reader.',
          },
          {
            id: 'no-accounting',
            detail: 'frameworks that write no accounting (octos, codex-acp): nothing is on disk '
              + 'to read, so the only path is hafleet proxying provider traffic — which changes '
              + 'what hafleet is, and is a decision rather than an oversight.',
          },
          {
            id: 'file-budget',
            detail: 'a codex scan competes for its file budget with every workspace on the '
              + 'machine, because sessions are filed by date rather than by workspace. An agent '
              + 'whose transcript is not among the newest reports a bounded scan rather than a '
              + 'figure.',
          },
        ],
      },
    },
    agents: byAgent,
    /*
     * A fleet total that carries its own denominator.
     *
     * `tokensUsed` was unconditionally null here even when per-agent rows were measured,
     * which threw away a real figure. But a bare sum would be worse: with 2 of 7 agents
     * attributable it understates the fleet while looking authoritative, and nothing in the
     * number says so.
     *
     * So the numerator never travels without its denominator, and it stays null when
     * nothing at all was measured — null is "not known", 0 would be the claim that this
     * fleet consumed nothing.
     */
    totals: (() => {
      const measured = byAgent.filter((r) => typeof r.tokensUsed === 'number');
      return {
        agents: byAgent.length,
        busySec: byAgent.reduce((n, r) => n + r.busySec, 0),
        tasks: byAgent.reduce((n, r) => n + r.tasks, 0),
        tokensUsed: measured.length
          ? measured.reduce((n, r) => n + r.tokensUsed, 0)
          : null,
        // The ceiling-drawing part of the same figure, so a consumer never has to
        // re-derive it from tokensByKind and pick the wrong kinds.
        tokensDrawn: measured.length
          ? measured.reduce((n, r) => n + (r.tokensDrawn ?? 0), 0)
          : null,
        // Read these together with the figure above or not at all.
        tokensMeasuredFor: measured.length,
        tokensPartial: measured.length > 0 && measured.length < byAgent.length,
      };
    })(),
  });
});

// ── Seats ──────────────────────────────────────────────────────────────
/*
 * The unit capacity is actually bought in, and the over-subscription it makes
 * visible.
 *
 * A ceiling is declared per agent because that is the unit an operator reasons
 * about. But two Claude agents on one host share one authenticated subscription —
 * `$HOME` is never reassigned in the launch path and bin/hafleet-up:1640-1644 only
 * unsets ANTHROPIC_API_KEY when no per-agent key is set — so their two ceilings are
 * two claims on one quota, not two quotas. Nothing in the product could say that
 * before this route.
 *
 * Identity is derived; quota is declared. See lib/seat-store.js for why the split
 * is that way round and why the seat id is a keyed digest rather than a path.
 */
app.get('/api/seats', requireBearer, (_req, res) => {
  refreshServerLiveness();
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const seats = buildSeats({
    agents: rows,
    presets: frameworkPresets,
    declarations: seatDeclarations,
    keyId: SEAT_KEY_ID,
    secret: SEAT_KEY_SECRET,
  });
  return res.json({
    generatedAt: Date.now(),
    // Surfaced rather than buried: an unkeyed digest protects nothing, and a
    // caller deciding whether a seat id is safe to log needs to know which it is.
    keyed: Boolean(SEAT_KEY_SECRET),
    keyId: SEAT_KEY_ID,
    seats,
  });
});

/*
 * Declare what a seat holds.
 *
 * PUT rather than POST because the seat already exists — it is derived from the
 * agents on it. What is being created is the operator's belief about its quota, and
 * that belief is addressed by the seat's own id.
 */
app.put('/api/seats/:seatId', requireBearer, (req, res) => {
  const seatId = normalizeOptionalText(req.params.seatId, 128);
  if (!seatId) return res.status(400).json({ error: 'seatId is required' });

  // Refuse a declaration about a seat no agent occupies. Otherwise seats.json
  // accumulates beliefs about seats that never existed — usually a typo, and
  // indistinguishable afterwards from a seat whose agents were removed.
  const rows = Object.values(agents).filter(isAgentRecord).map(serializeAgent);
  const known = new Set(rows.map((a) => seatIdentity(a, { keyId: SEAT_KEY_ID, secret: SEAT_KEY_SECRET }).seatId));
  if (!known.has(seatId)) {
    return res.status(404).json({ error: `no agent occupies seat ${seatId}` });
  }

  const declaration = normalizeDeclaration(req.body || {});
  if (!declaration) return res.status(400).json({ error: 'nothing to declare: quotaTokens, period or planLabel required' });

  const previous = seatDeclarations[seatId];
  seatDeclarations[seatId] = {
    ...declaration,
    declaredBy: getRequestAgentName(req) || 'operator',
    declaredAt: Date.now(),
  };
  if (!saveSeatDeclarations()) {
    if (previous === undefined) delete seatDeclarations[seatId];
    else seatDeclarations[seatId] = previous;
    return res.status(503).json({ error: 'seat declaration persistence failed' });
  }
  return res.json({ ok: true, seatId, declaration: seatDeclarations[seatId] });
});

app.delete('/api/seats/:seatId', requireBearer, (req, res) => {
  const seatId = normalizeOptionalText(req.params.seatId, 128);
  const previous = seatDeclarations[seatId];
  if (previous === undefined) return res.status(404).json({ error: 'no declaration for that seat' });
  delete seatDeclarations[seatId];
  if (!saveSeatDeclarations()) {
    seatDeclarations[seatId] = previous;
    return res.status(503).json({ error: 'seat declaration persistence failed' });
  }
  return res.json({ ok: true, seatId });
});

// ── Framework Presets CRUD ─────────────────────────────────────────────
app.get('/api/framework-presets', requireBearer, (_req, res) => {
  return res.json(frameworkPresets.map(p => ({
    ...p,
    apiKey: p.apiKey ? true : null,
  })));
});

app.post('/api/framework-presets', requireBearer, (req, res) => {
  const b = req.body || {};
  const name = normalizeOptionalText(b.name, 128);
  if (!name) return res.status(400).json({ error: 'name is required' });
  let id = 'preset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  for (let i = 0; i < 10 && frameworkPresets.some(p => p.id === id); i++) {
    id = 'preset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }
  if (frameworkPresets.some(p => p.id === id)) return res.status(500).json({ error: 'failed to generate unique preset id' });
  const extraArgs = normalizeOptionalText(b.extraArgs, 4000) || null;
  if (extraArgs && SHELL_METACHAR_RE.test(extraArgs)) {
    return res.status(400).json({ error: 'extraArgs contains disallowed shell characters' });
  }
  const apiBaseUrl = normalizeOptionalText(b.apiBaseUrl, 512) || null;
  if (apiBaseUrl) {
    try {
      const parsed = new URL(apiBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http(s)');
      if (parsed.username || parsed.password) throw new Error('credentials in URL');
    } catch {
      return res.status(400).json({ error: 'apiBaseUrl must be a valid HTTP(S) URL without embedded credentials' });
    }
  }
  const preset = {
    id,
    name,
    framework: normalizeOptionalText(b.framework, 32) || null,
    provider: normalizeOptionalText(b.provider, 64) || null,
    model: normalizeOptionalText(b.model, 256) || null,
    reasoning: normalizeOptionalText(b.reasoning, 64) || null,
    extraArgs,
    apiBaseUrl,
    apiKey: normalizeOptionalText(b.apiKey, 256) || null,
    /*
     * The one field a contributor is really deciding, and until now the only one
     * with nowhere to live: this handler built its record from a closed field
     * list, so a `ceiling` sent by a client was accepted with 200 and dropped.
     * The console had to render every ceiling cell as "no ceiling field upstream".
     */
    ceiling: normalizeCeiling(b.ceiling),
  };
  frameworkPresets.push(preset);
  if (!saveFrameworkPresets()) {
    frameworkPresets.pop();
    return res.status(503).json({ error: 'framework preset persistence failed' });
  }
  return res.json({ ok: true, preset: { ...preset, apiKey: preset.apiKey ? true : null } });
});

app.put('/api/framework-presets/:id', requireBearer, (req, res) => {
  const idx = frameworkPresets.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'preset not found' });
  const b = req.body || {};
  const name = normalizeOptionalText(b.name, 128);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const extraArgs = normalizeOptionalText(b.extraArgs, 4000) || null;
  if (extraArgs && SHELL_METACHAR_RE.test(extraArgs)) {
    return res.status(400).json({ error: 'extraArgs contains disallowed shell characters' });
  }
  const apiBaseUrl = normalizeOptionalText(b.apiBaseUrl, 512) || null;
  if (apiBaseUrl) {
    try {
      const parsed = new URL(apiBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http(s)');
      if (parsed.username || parsed.password) throw new Error('credentials in URL');
    } catch {
      return res.status(400).json({ error: 'apiBaseUrl must be a valid HTTP(S) URL without embedded credentials' });
    }
  }
  const previousPreset = frameworkPresets[idx];
  const nextPreset = {
    ...previousPreset,
    name,
    framework: normalizeOptionalText(b.framework, 32) || null,
    provider: normalizeOptionalText(b.provider, 64) || null,
    model: normalizeOptionalText(b.model, 256) || null,
    reasoning: normalizeOptionalText(b.reasoning, 64) || null,
    extraArgs,
    apiBaseUrl,
    apiKey: normalizeOptionalText(b.apiKey, 256) || previousPreset.apiKey || null,
    /*
     * An omitted `ceiling` KEEPS the stored one, matching how apiKey behaves just
     * above. The alternative — treating absent as "clear it" — would silently
     * unset a contributor's budget every time a client saved the form without
     * re-sending it. An explicit `null` still clears.
     */
    ceiling: b.ceiling === undefined
      ? (previousPreset.ceiling ?? null)
      : normalizeCeiling(b.ceiling),
  };
  frameworkPresets[idx] = nextPreset;
  if (!saveFrameworkPresets()) {
    frameworkPresets[idx] = previousPreset;
    return res.status(503).json({ error: 'framework preset persistence failed' });
  }
  return res.json({ ok: true, preset: { ...frameworkPresets[idx], apiKey: frameworkPresets[idx].apiKey ? true : null } });
});

app.delete('/api/framework-presets/:id', requireBearer, (req, res) => {
  const idx = frameworkPresets.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'preset not found' });
  const removed = frameworkPresets.splice(idx, 1)[0];
  if (!saveFrameworkPresets()) {
    frameworkPresets.splice(idx, 0, removed);
    return res.status(503).json({ error: 'framework preset persistence failed' });
  }
  return res.json({ ok: true, preset: { ...removed, apiKey: removed.apiKey ? true : null } });
});

app.post('/api/task-graphs', requireBearer, (req, res) => {
  try {
    const created = taskGraphStore.createGraph(req.body || {});
    const graph = taskGraphStore.advanceGraph(created.id) || created;
    return res.json({ ok: true, graph });
  } catch (error) {
    return respondTaskGraphError(res, error, 'failed to create task graph');
  }
});

app.get('/api/task-graphs', (req, res) => {
  try {
    const status = normalizeOptionalText(req.query?.status, 32);
    return res.json(taskGraphStore.listGraphs(status ? { status } : {}));
  } catch (error) {
    return respondTaskGraphError(res, error, 'failed to list task graphs');
  }
});

app.get('/api/task-graphs/:id', (req, res) => {
  const graph = taskGraphStore.getGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: 'task graph not found' });
  return res.json(graph);
});

app.delete('/api/task-graphs/:id', requireBearer, (req, res) => {
  try {
    const graph = taskGraphStore.deleteGraph(req.params.id);
    if (!graph) return res.status(404).json({ error: 'task graph not found' });
    return res.json({ ok: true, graph });
  } catch (error) {
    return respondTaskGraphError(res, error, 'failed to delete task graph');
  }
});

app.patch('/api/task-graphs/:id/nodes/:nodeId', requireAgentToken(_tokenFromNodeAssignee), (req, res) => {
  try {
    taskGraphStore.updateNode(req.params.id, req.params.nodeId, req.body || {});
    const graph = taskGraphStore.advanceGraph(req.params.id) || taskGraphStore.getGraph(req.params.id);
    if (!graph) return res.status(404).json({ error: 'task graph not found' });
    const node = taskGraphStore.getNode(req.params.id, req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'task graph node not found' });
    return res.json({ ok: true, graph, node });
  } catch (error) {
    return respondTaskGraphError(res, error, 'failed to update task graph node');
  }
});

// Read-only, privacy-filtered project projection for Dashboard and future
// clients. Group membership is the project boundary; direct/approval messages
// and raw agent records never leave this endpoint.
app.get('/api/project-board', async (req, res) => {
  try {
    const agentRows = await Promise.all(
      Object.values(agents).filter(isAgentRecord).map(async agent => {
        const row = serializeAgent(agent);
        const manifest = findV1ManifestByName(row.name);
        const managedProjects = manifest?.managedProjects?.length
          ? manifest.managedProjects
          : row.managedProjects;
        const projectInspections = await Promise.all(
          normalizeManagedProjects(managedProjects).map(project =>
            projectInspector.inspectManagedProject(project, row.name)),
        );
        return { ...row, projectInspections };
      }),
    );
    const snapshot = buildProjectBoardSnapshot({
      groups,
      bindings: workflowBindings,
      agents: agentRows,
      tasks: taskStore.listTasks(),
      taskGraphs: taskGraphStore.listGraphs(),
      messages,
      staleAfterMs: PROJECT_BOARD_STALE_AFTER_MS,
      activityLimit: req.query?.activity_limit,
    });
    return res.json(snapshot);
  } catch (error) {
    console.error('[project-board] snapshot failed:', error?.message || error);
    return res.status(500).json({ error: 'project board snapshot failed' });
  }
});

// ── Alerts CRUD ───────────────────────────────────────────────────────
function respondAlertStoreError(res, error, fallbackMessage) {
  if (error.code === 'not_found') return res.status(404).json({ error: error.message });
  if (error.code === 'persistence_failed') return res.status(503).json({ error: error.message });
  if (error.code === 'bad_transition' || error.code === 'bad_request') {
    return res.status(400).json({ error: error.message });
  }
  if (error.code) return res.status(400).json({ error: error.message });
  return res.status(500).json({ error: fallbackMessage });
}

app.get('/api/alerts', requireBearer, (req, res) => {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.severity) filters.severity = req.query.severity;
  if (req.query.sourceAgent) filters.sourceAgent = req.query.sourceAgent;
  if (req.query.alertType) filters.alertType = req.query.alertType;
  if (req.query.assignee) filters.assignee = req.query.assignee;
  if (req.query.limit) filters.limit = req.query.limit;
  if (req.query.offset) filters.offset = req.query.offset;
  return res.json(alertStore.listAlerts(filters));
});

app.get('/api/alerts/stats', requireBearer, (_req, res) => {
  return res.json(alertStore.getStats());
});

app.get('/api/alerts/:id', requireBearer, (req, res) => {
  const alert = alertStore.getAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  return res.json(alert);
});

// Accept Bearer OR agent-token (agent can only transition alerts assigned to them)
const _alertTransitionAuth = (req, res, next) => {
  const expectedBearer = normalizeOptionalText(process.env.API_TOKEN, 512);
  // No API_TOKEN configured — pass through (matches requireBearer behavior)
  if (!expectedBearer) return next();
  // Bearer token matches — pass through
  if (getBearerToken(req) === expectedBearer) return next();
  // Fall back to agent-token auth: agent can transition their assigned alerts
  const alert = alertStore.getAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  const assignee = alert.assignee;
  if (!assignee) return res.status(403).json({ error: 'alert has no assignee — bearer token required' });
  const tokenResult = checkAgentToken(assignee, req);
  if (!tokenResult.ok) {
    if (AGENT_TOKEN_MODE === 'audit') { console.warn(`[auth] alert-transition agent-token ${tokenResult.reason}: agent=${assignee}`); return next(); }
    return res.status(403).json({ error: `agent token ${tokenResult.reason}` });
  }
  next();
};
app.post('/api/alerts/:id/transition', _alertTransitionAuth, (req, res) => {
  try {
    const status = (typeof req.body?.status === 'string') ? req.body.status.trim() : '';
    if (!status) return res.status(400).json({ error: 'status is required' });
    const alert = alertStore.transition(req.params.id, status, {
      actor: req.body.actor || 'operator',
      assignee: req.body.assignee || null,
      suppressUntil: req.body.suppressUntil ? Number(req.body.suppressUntil) : undefined,
    });
    return res.json({ ok: true, alert });
  } catch (error) {
    return respondAlertStoreError(res, error, 'failed to transition alert');
  }
});

app.post('/api/alerts/:id/notes', requireBearer, (req, res) => {
  try {
    const alert = alertStore.addNote(req.params.id, {
      author: req.body?.author || 'operator',
      text: req.body?.text || '',
    });
    return res.json({ ok: true, alert });
  } catch (error) {
    return respondAlertStoreError(res, error, 'failed to add note');
  }
});

app.patch('/api/alerts/:id', requireBearer, (req, res) => {
  try {
    const alert = alertStore.updateAlert(req.params.id, req.body || {});
    return res.json({ ok: true, alert });
  } catch (error) {
    return respondAlertStoreError(res, error, 'failed to update alert');
  }
});

app.delete('/api/alerts/:id', requireBearer, (req, res) => {
  try {
    const alert = alertStore.deleteAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'alert not found' });
    broadcastSSE('alert_deleted', alert);
    return res.json({ ok: true, alert });
  } catch (error) {
    return respondAlertStoreError(res, error, 'failed to delete alert');
  }
});

// ── Groups CRUD ───────────────────────────────────────────────────────
app.post('/api/groups', requireBridgeSecret, (req, res) => {
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
  const groupRecord = { name: groupName, members: normalizedMembers, createdAt: Date.now() };
  groups[groupName] = groupRecord;
  if (!saveGroups()) {
    delete groups[groupName];
    return res.status(503).json({ error: 'group persistence failed' });
  }
  broadcastSSE('group_created', groupRecord);
  res.json({ ok: true, group: groupRecord });
});

app.get('/api/groups', (_req, res) => {
  res.json(Object.values(groups));
});

app.get('/api/groups/:name', (req, res) => {
  const group = groups[req.params.name];
  if (!group) return res.status(404).json({ error: 'group not found' });
  res.json(group);
});

app.post('/api/groups/:name/members', requireBridgeSecret, (req, res) => {
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

  const nextMembers = Array.isArray(group.members) ? [...group.members] : [];
  const existingKeys = new Set(nextMembers.map(m => String(m).toLowerCase()));
  for (const memberName of addList) {
    const key = memberName.toLowerCase();
    if (!existingKeys.has(key)) {
      nextMembers.push(memberName);
      existingKeys.add(key);
    }
  }
  if (removeKeys.size > 0) {
    for (let i = nextMembers.length - 1; i >= 0; i--) {
      if (removeKeys.has(String(nextMembers[i]).toLowerCase())) nextMembers.splice(i, 1);
    }
  }
  const nextGroup = { ...group, members: nextMembers };
  groups[req.params.name] = nextGroup;
  if (!saveGroups()) {
    groups[req.params.name] = group;
    return res.status(503).json({ error: 'group persistence failed' });
  }
  broadcastSSE('group_members', { name: nextGroup.name, members: nextGroup.members, added: addList, removed: removeList });
  res.json({ ok: true, group: nextGroup });
});

app.delete('/api/groups/:name', requireBridgeSecret, (req, res) => {
  const previousGroup = groups[req.params.name];
  if (!previousGroup) return res.status(404).json({ error: 'group not found' });
  delete groups[req.params.name];
  if (!saveGroups()) {
    groups[req.params.name] = previousGroup;
    return res.status(503).json({ error: 'group persistence failed' });
  }
  res.json({ ok: true });
});

// ── DM ensure (triggers bridge to create Matrix DM room) ─────────────
app.post('/api/dm/ensure', requireBearer, (req, res) => {
  const { agent, human, humanId } = req.body;
  if (!agent || !human) return res.status(400).json({ error: 'agent and human required' });
  const resolvedHumanId = (typeof humanId === 'string' && humanId.trim()) ? humanId.trim() : null;
  broadcastSSE('dm_ensure', { agent, human, humanId: resolvedHumanId });
  console.log(`[dm/ensure] Requested DM room: agent=${agent}, human=${human}${resolvedHumanId ? ` humanId=${resolvedHumanId}` : ''}`);
  res.json({ ok: true, queued: true, agent, human, humanId: resolvedHumanId });
});

app.post('/api/agents/:name/avatar', express.json({ limit: '10mb' }), requireAgentToken(_tokenFromName), (req, res) => {
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
app.post('/api/system/info', requireBridgeSecret, (req, res) => {
  const summary = (typeof req.body?.summary === 'string') ? req.body.summary.trim() : '';
  const full = (typeof req.body?.full === 'string') ? req.body.full : '';
  if (!summary) return res.status(400).json({ error: 'summary required' });
  const alertType = (typeof req.body?.alertType === 'string') ? req.body.alertType.trim() : null;
  const dedupeKey = (typeof req.body?.dedupeKey === 'string') ? req.body.dedupeKey.trim() : undefined;
  const sourceAgent = (typeof req.body?.sourceAgent === 'string') ? req.body.sourceAgent.trim() : undefined;
  const opts = {};
  if (dedupeKey) opts.dedupeKey = dedupeKey;
  if (sourceAgent) opts.sourceAgent = sourceAgent;
  for (const key of ALERT_ACTION_FIELD_KEYS) {
    if (key === 'correlation') {
      if (req.body?.correlation && typeof req.body.correlation === 'object' && !Array.isArray(req.body.correlation)) {
        opts.correlation = req.body.correlation;
      }
      continue;
    }
    const value = normalizeOptionalText(req.body?.[key], key === 'runbook' ? 512 : 1024);
    if (value) opts[key] = value;
  }
  opts.source = 'bridge';
  const event = emitSystemInfo(summary, full, alertType || null, opts);
  res.json({ ok: true, id: event.id });
});

// ── Media staging for agent attachments ───────────────────────────────
app.post('/api/media/stage', express.json({ limit: MESSAGE_ATTACHMENT_STAGE_JSON_LIMIT }), requireAgentToken(_tokenFromBody), (req, res) => {
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
app.post('/api/messages', requireAgentToken(_tokenFromBody), async (req, res) => {
  const { from, to, group, type, summary, full, mentions, reply_to, source, target_type, source_room, source_event_id, thread_root_event_id, matrix_default_recipient, attachments, schema, priority, sender_mxid, from_id } = req.body;
  const fromName = normalizeAgentName(from) || from;
  const toName = to ? normalizeAgentName(to) : null;
  const sourceType = typeof source === 'string' ? source.trim().toLowerCase() : 'api';
  const targetType = typeof target_type === 'string' ? target_type.trim().toLowerCase() : 'auto';
  const sourceRoom = (typeof source_room === 'string' && source_room.trim() && source_room.length <= 255)
    ? source_room.trim()
    : null;
  // Matrix worker ingestion is accepted only through the authenticated bridge.
  const bridgeSecret = getBridgeSecret();
  const isBridgeAuthenticated = !bridgeSecret || req.headers['x-bridge-secret'] === bridgeSecret;
  const hasAuthenticatedBridgeSecret = Boolean(bridgeSecret)
    && req.headers['x-bridge-secret'] === bridgeSecret;
  let sourceEventId = null;
  let threadRootEventId = null;
  if (sourceType === 'matrix') {
    if (!bridgeSecret) {
      return res.status(503).json({ error: 'MATRIX_BRIDGE_SECRET is required for Matrix ingestion' });
    }
    if (!hasAuthenticatedBridgeSecret) {
      return res.status(401).json({ error: 'invalid Matrix bridge credentials' });
    }
    if (typeof source_event_id !== 'string' || !source_event_id.trim() || source_event_id.trim().length > 255) {
      return res.status(400).json({ error: 'source_event_id must be 1..255 characters' });
    }
    sourceEventId = source_event_id.trim();
    if (thread_root_event_id !== undefined && thread_root_event_id !== null && thread_root_event_id !== '') {
      if (typeof thread_root_event_id !== 'string' || !thread_root_event_id.trim() || thread_root_event_id.trim().length > 255) {
        return res.status(400).json({ error: 'thread_root_event_id must be 1..255 characters' });
      }
      threadRootEventId = thread_root_event_id.trim();
    }
  } else if (thread_root_event_id !== undefined) {
    return res.status(400).json({ error: 'thread_root_event_id is reserved for authenticated Matrix ingestion' });
  }
  const matrixDefaultRecipient = hasAuthenticatedBridgeSecret
    && sourceType === 'matrix'
    && matrix_default_recipient === 'wf_coordinator'
    ? 'wf_coordinator'
    : null;
  if (matrix_default_recipient !== undefined && !matrixDefaultRecipient) {
    return res.status(400).json({ error: 'invalid matrix_default_recipient' });
  }
  const senderMxid = isBridgeAuthenticated && sourceType === 'matrix' && typeof sender_mxid === 'string' && /^@[^:]+:.+/.test(sender_mxid.trim())
    ? sender_mxid.trim().slice(0, 255) : null;
  // Derive trustLevel server-side from validated senderMxid — never trust caller-supplied value
  const trustLevel = senderMxid ? (MATRIX_OPERATOR_MXIDS.has(senderMxid) ? 'operator' : 'external') : null;
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
  const normalizedSchema = normalizeMessageSchema(schema);
  if (normalizedSchema.error) {
    return res.status(400).json({ error: normalizedSchema.error });
  }
  const normalizedPriority = normalizeMessagePriority(priority);
  if (!normalizedPriority) {
    return res.status(400).json({ error: 'priority must be one of: normal, high, urgent' });
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
  if (sourceEventId) {
    const existing = matrixDispatchStore.get(sourceEventId);
    if (existing) {
      try {
        const completed = await completeMatrixDispatch(existing);
        if (!completed.ok) {
          return res.status(completed.status || 503).json({ error: completed.error || 'Matrix dispatch recovery failed' });
        }
        return res.json({ ...completed.response, ok: true, id: existing.messageId, deduped: true });
      } catch (error) {
        return res.status(503).json({ error: `Matrix dispatch recovery failed: ${error.message}` });
      }
    }
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
      if (!ensureInfoGroup()) return res.status(503).json({ error: 'group persistence failed' });
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

  const idReservation = reserveNextMsgId();
  if (!idReservation.ok) {
    return res.status(503).json({ error: idReservation.error || 'message id reservation failed' });
  }

  const msg = {
    id: idReservation.id,
    ts: Date.now(),
    from: fromName,
    to: toName || null,
    group: group || null,
    type,
    priority: normalizedPriority,
    summary: canonicalSummary,
    full: canonicalFull,
    mentions: [...textMentions],
    reply_to: reply_to || null,
    source: source || 'api',
    sourceRoom,
    sourceEventId,
    matrixDefaultRecipient,
    senderMxid,
    trustLevel,
    fromId: isBridgeAuthenticated && (typeof from_id === 'string' && from_id.trim()) ? from_id.trim().slice(0, 255)
      : (senderMxid || null),
    viewToken: createMessageViewToken(),
  };
  if (sourceType === 'matrix' && sourceRoom && sourceEventId) {
    msg.matrixContext = {
      roomId: sourceRoom,
      eventId: sourceEventId,
      threadRootEventId,
    };
  }
  if (normalizedAttachments.length > 0) {
    msg.attachments = normalizedAttachments;
  }
  if (normalizedSchema.value) {
    msg.schema = normalizedSchema.value;
  }

  const warnings = [];
  const notices = [];
  if (msg.to && directTargetKind === 'human' && assumedHumanTarget) {
    notices.push({
      code: 'target_classified_human',
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
    }

    const unknownMentions = mentionStates
      .filter(item => !item.state.exists && !item.isGroupMember)
      .map(item => ({ target: item.name, reason: 'not-found' }));
    if (unknownMentions.length) {
      warnings.push({ code: 'mentions_unknown', targets: unknownMentions });
    }

    const outOfGroupMentions = mentionStates
      .filter(item => item.state.exists && !item.isGroupMember && item.name !== matrixDefaultRecipient)
      .map(item => ({ target: item.name, reason: 'not-in-group' }));
    if (outOfGroupMentions.length) {
      warnings.push({ code: 'mentions_not_in_group', targets: outOfGroupMentions });
      for (const item of outOfGroupMentions) suppressedRecipients.add(item.target);
    }
  }
  if (suppressedRecipients.size > 0) {
    msg.suppressedRecipients = [...suppressedRecipients];
  }

  const responseBase = {
    ok: true,
    id: msg.id,
    warnings,
    notices,
    delivery: { suppressed: msg.suppressedRecipients || [], targetKind: directTargetKind || null },
    taskGraph: null,
  };
  let dispatchResult;
  if (sourceEventId) {
    try {
      const receipt = matrixDispatchStore.reserve({
        eventId: sourceEventId,
        messageId: msg.id,
        message: msg,
        dispatch: { senderIsAgent, directTargetKind },
        response: responseBase,
      });
      dispatchResult = await completeMatrixDispatch(receipt);
    } catch (error) {
      dispatchResult = { ok: false, status: 503, error: `Matrix dispatch persistence failed: ${error.message}` };
    }
  } else {
    dispatchResult = dispatchStoredMessage(msg, { senderIsAgent, directTargetKind });
  }
  if (!dispatchResult.ok) {
    return res.status(dispatchResult.status || 503).json({ error: dispatchResult.error || 'message persistence failed' });
  }
  let taskGraph = null;
  try {
    taskGraph = handleTaskGraphMessageHook(msg);
  } catch (error) {
    return res.status(taskGraphErrorStatus(error)).json({
      error: error?.message || 'task graph hook failed',
      id: msg.id,
      messageAccepted: true,
      warnings,
      notices,
      delivery: { suppressed: msg.suppressedRecipients || [], targetKind: directTargetKind || null },
      taskGraph: null,
    });
  }

  res.json({ ...responseBase, taskGraph });
});

// ── DM history (bearer-authenticated, for web UI) ─────────────────────
app.get('/api/dm/:agent/history', requireBearer, (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  const beforeRaw = Number.parseInt(req.query.before, 10);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : Infinity;
  // Return DMs involving this agent (sent to or from, excluding group messages)
  const dms = messages
    .filter(m => !m.group && (m.to === agentName || m.from === agentName) && m.ts < before)
    .sort((a, b) => a.ts - b.ts);
  const rows = dms.slice(-limit);
  res.json({
    agent: agentName,
    total: dms.length,
    returned: rows.length,
    messages: rows.map(summarizeMsg),
  });
});

app.get('/api/messages/:id', (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  const auth = authorizeMessageDetailAccess(req, msg);
  if (!auth.ok) return res.status(auth.status || 403).json({ error: auth.error || 'message access denied' });
  const normalizedSchema = normalizeMessageSchema(msg?.schema);
  res.json({
    ...msg,
    priority: normalizeMessagePriority(msg?.priority),
    schema: normalizedSchema.value || undefined,
    ts: undefined,
    time: relativeTime(msg.ts),
  });
});

app.put('/api/messages/:id/matrix-delivery', requireBridgeSecret, (req, res) => {
  if (!getBridgeSecret()) {
    return res.status(503).json({ error: 'MATRIX_BRIDGE_SECRET is required for Matrix delivery persistence' });
  }
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  if (!msg.group || msg.source === 'matrix' || msg.type === 'human') {
    return res.status(400).json({ error: 'Matrix delivery persistence is limited to outbound group messages' });
  }

  const normalizeDeliveryId = (value, field, optional = false) => {
    if (optional && (value === undefined || value === null || value === '')) return { value: null };
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
      return { error: `${field} must be 1..255 characters` };
    }
    return { value: value.trim() };
  };
  const room = normalizeDeliveryId(req.body?.room_id ?? req.body?.roomId, 'room_id');
  const primary = normalizeDeliveryId(
    req.body?.primary_event_id ?? req.body?.primaryEventId,
    'primary_event_id',
  );
  const threadRoot = normalizeDeliveryId(
    req.body?.thread_root_event_id ?? req.body?.threadRootEventId,
    'thread_root_event_id',
    true,
  );
  const invalid = room.error || primary.error || threadRoot.error;
  if (invalid) return res.status(400).json({ error: invalid });

  const candidate = {
    roomId: room.value,
    primaryEventId: primary.value,
    threadRootEventId: threadRoot.value,
  };
  const existing = msg.matrixDelivery || null;
  if (existing) {
    const identical = existing.roomId === candidate.roomId
      && existing.primaryEventId === candidate.primaryEventId
      && (existing.threadRootEventId || null) === candidate.threadRootEventId;
    if (!identical) {
      return res.status(409).json({
        error: 'primary Matrix delivery already recorded',
        matrixDelivery: existing,
      });
    }
    return res.json({ ok: true, id: msg.id, deduped: true, matrixDelivery: existing });
  }

  msg.matrixDelivery = candidate;
  if (!saveMessages()) {
    delete msg.matrixDelivery;
    invalidateUnreadMessageIndex();
    return res.status(503).json({ error: 'messages persistence failed' });
  }
  return res.json({ ok: true, id: msg.id, deduped: false, matrixDelivery: candidate });
});

app.get('/api/messages/:id/delivery', (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  const auth = authorizeMessageDetailAccess(req, msg);
  if (!auth.ok) return res.status(auth.status || 403).json({ error: auth.error || 'message access denied' });
  const agent = normalizeAgentName(req.query.agent) || null;
  const limit = Number.parseInt(req.query.limit, 10);
  const events = readDeliveryEvents({
    messageId: msg.id,
    agent,
    limit: Number.isFinite(limit) ? limit : 100,
  });
  res.json({ messageId: msg.id, agent, events });
});

app.get('/api/agents/:name/delivery-events', requireAgentToken(_tokenFromName), (req, res) => {
  const agentName = normalizeAgentName(req.params.name);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const limit = Number.parseInt(req.query.limit, 10);
  res.json({
    agent: agentName,
    events: readDeliveryEvents({
      agent: agentName,
      limit: Number.isFinite(limit) ? limit : 100,
    }),
  });
});

app.post('/api/messages/:id/suppress', requireAgentToken(_tokenFromAgent), (req, res) => {
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
    if (!saveMessages()) {
      msg.suppressedRecipients = msg.suppressedRecipients.filter((name) => name !== agentName);
      if (msg.suppressedRecipients.length === 0) delete msg.suppressedRecipients;
      invalidateUnreadMessageIndex();
      return res.status(503).json({ error: 'messages persistence failed' });
    }
    invalidatePendingHumanTargets(agentName);
    appendDeliveryEvent({
      type: 'message.suppressed',
      source: 'backend',
      messageId: msg.id,
      agent: agentName,
      targetAgents: [agentName],
      reason: normalizeOptionalText(req.body?.reason, 128) || 'explicit-suppress',
      context: {
        wasUnread: before,
      },
    });
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
  const auth = authorizeMessageDetailAccess(req, msg, { allowViewToken: true });
  if (!auth.ok) {
    return res.status(auth.status || 403).type('html').send(`<h1>${auth.status || 403}</h1><p>${String(auth.error || 'message access denied').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`);
  }
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const agentLinkParam = getRequestAgentName(req) ? `?agent=${encodeURIComponent(getRequestAgentName(req))}` : '';
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
${msg.reply_to ? '<div class="meta">Reply to: <a href="/msg/' + escape(msg.reply_to) + agentLinkParam + '" style="color:#4dabf7">' + escape(msg.reply_to) + '</a></div>' : ''}
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
app.get('/api/inbox/:agent/unread', requireAgentToken(_tokenFromAgent), (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const kinds = parseKindsFilter(req.query.kinds);
  const snapshot = buildUnreadInboxSnapshot(agentName, { kinds });
  res.json(snapshot);
});

app.get('/api/inbox/:agent/unread-list', (req, res, next) => {
  // Accept Bearer token (web-tier proxy) OR per-agent token
  const bearerToken = getBearerToken(req);
  const expectedBearer = normalizeOptionalText(process.env.API_TOKEN, 512);
  if (expectedBearer && bearerToken === expectedBearer) return next();
  return requireAgentToken(_tokenFromAgent)(req, res, next);
}, (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });

  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.min(limitRaw, 500) : 50;
  const kinds = parseKindsFilter(req.query.kinds);
  const { unread } = getUnreadInboxMessages(agentName, { kinds });
  const rows = limit === 0 ? unread : unread.slice(-limit);
  res.json({
    agent: agentName,
    unread_total: unread.length,
    unread_returned: rows.length,
    unread_omitted: Math.max(0, unread.length - rows.length),
    messages: rows.map(summarizeMsg),
  });
});

app.get('/api/inbox/:agent', requireAgentToken(_tokenFromAgent), (req, res) => {
  const agentName = normalizeAgentName(req.params.agent);
  if (!agentName) return res.status(400).json({ error: 'invalid agent name' });
  if (!isAgentRecord(agents[agentName])) return res.status(404).json({ error: 'agent not found' });
  const kindsList = parseKindsFilter(req.query.kinds);
  const kinds = kindsList.length > 0 ? new Set(kindsList) : null;

  const cursorSnapshot = snapshotCursor(agentName);
  const cursor = ensureCursor(agentName);
  const { unread } = getUnreadInboxMessages(agentName, { kinds: kindsList });
  const dmRaw = unread.filter(m => m.to === agentName);
  const dm = dmRaw.map(summarizeMsg);

  const groupRaw = unread.filter(m => m.group && m.to !== agentName);
  const group = groupRaw.map(summarizeMsg);

  // Filtered reads are preview-only: a global inbox cursor cannot safely advance over one kind
  // without implicitly skipping unread messages of other kinds.
  const runtime = ensureAgentRuntimeRecord(agentName);
  const pendingGate = getPendingInboxGate(runtime);
  // A full, unfiltered read always satisfies a pending gate: the agent has now seen the entire
  // inbox. This must NOT depend on the gate's sourceMsgId still being present in `unread` --
  // once the cursor advances past it (e.g. from an earlier full read), it can never reappear
  // there, which would otherwise deadlock the agent's send path forever. Empty `unread` counts
  // as a satisfied read too.
  const clearsPendingGate = Boolean(pendingGate) && !kinds;
  if (!kinds && advanceInboxCursor(cursor, unread)) {
    if (!saveCursors()) {
      restoreCursor(agentName, cursorSnapshot);
      return res.status(503).json({ error: 'cursor persistence failed' });
    }
    invalidatePendingHumanTargets(agentName);
  }
  if (!kinds) {
    markAgentInboxChecked(agentName, {
      clearInboxGate: clearsPendingGate,
      sourceMsgId: clearsPendingGate ? pendingGate.sourceMsgId : null,
    });
    if (unread.length > 0 || clearsPendingGate) {
      appendDeliveryEvent({
        type: 'inbox.read_ack',
        source: 'backend',
        agent: agentName,
        messageIds: unread.map((msg) => msg.id).filter(Boolean),
        messageId: clearsPendingGate ? pendingGate.sourceMsgId : null,
        ackedAt: Date.now(),
        cursor: {
          inboxTs: cursor.inbox || 0,
          inboxId: cursor.inboxId || null,
        },
        reason: clearsPendingGate ? 'inbox-gate-consumed' : 'inbox-read',
      });
    }
    // If the agent just consumed inbox, stale queued notifications should be removed immediately.
    clearQueuedNotificationsForAgent(agentName);
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
  const auth = authorizeAgentCredential(req, resolvedAgentName);
  if (!auth.ok) return res.status(auth.status || 403).json({ error: auth.error || 'agent credential required for group messages' });

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
  const cursorSnapshot = snapshotCursor(resolvedAgentName);
  const cursor = ensureCursor(resolvedAgentName);
  const groupCursor = getGroupCursor(cursor, groupName);
  const groupTs = groupCursor.ts;
  const groupId = groupCursor.id;

  const groupMsgs = (getUnreadMessageIndex().groupByName.get(groupName) || [])
    .filter(m => !isSuppressedForAgent(m, resolvedAgentName))
    .sort(compareMsgOrder);
  const unreadStart = firstMessageAfterCursorIndex(groupMsgs, groupTs, groupId);
  const unreadRaw = groupMsgs.slice(unreadStart);
  const unreadTotal = unreadRaw.length;
  const deliveredUnreadRaw = unreadLimit ? unreadRaw.slice(-unreadLimit) : unreadRaw;
  const unread = deliveredUnreadRaw.map(summarizeMsg);
  const unreadReturned = deliveredUnreadRaw.length;
  const unreadOmitted = Math.max(0, unreadTotal - unreadReturned);
  const read = groupMsgs.slice(0, unreadStart).slice(-limit).map(summarizeMsg);

  // Advance group cursor by mode:
  // - all: consume all unread (legacy behavior)
  // - delivered: consume only returned unread subset
  // - none: preview only
  if (advanceMode !== 'none') {
    const cursorSource = advanceMode === 'all' ? unreadRaw : deliveredUnreadRaw;
    if (advanceGroupCursor(cursor, groupName, cursorSource)) {
      if (!saveCursors()) {
        restoreCursor(resolvedAgentName, cursorSnapshot);
        return res.status(503).json({ error: 'cursor persistence failed' });
      }
      const advancedCursor = getGroupCursor(cursor, groupName);
      const advancedIds = unreadRaw
        .filter((msg) => !isAfterCursor(msg, advancedCursor.ts, advancedCursor.id))
        .map((msg) => msg?.id)
        .filter(Boolean);
      const returnedIds = cursorSource.map((msg) => msg?.id).filter(Boolean);
      appendDeliveryEvent({
        type: 'group.read_ack',
        source: 'backend',
        agent: resolvedAgentName,
        messageId: advancedIds[advancedIds.length - 1] || null,
        messageIds: advancedIds,
        ackedAt: Date.now(),
        cursor: {
          group: groupName,
          groupTs: advancedCursor.ts,
          groupId: advancedCursor.id,
        },
        reason: `group-read-${advanceMode}`,
        context: {
          group: groupName,
          unreadTotal,
          unreadReturned,
          returnedMessageIds: returnedIds,
        },
      });
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
  const messageIndex = getUnreadMessageIndex();

  const result = Object.values(groups)
    .filter(g => isGroupMember(g.name, agentName))
    .map(g => {
      const groupMsgs = (messageIndex.groupByName.get(g.name) || [])
        .filter(m => !isSuppressedForAgent(m, agentName))
        .sort(compareMsgOrder);
      const { ts: groupTs, id: groupId } = getGroupCursor(cursor, g.name);

      const unread_messages = groupMsgs.length - firstMessageAfterCursorIndex(groupMsgs, groupTs, groupId);
      const mentionMsgs = (messageIndex.groupMentionsByAgent.get(agentName) || [])
        .filter(m => m.group === g.name && !isSuppressedForAgent(m, agentName))
        .sort(compareMsgOrder);
      const unread_mentions = mentionMsgs.length - firstMessageAfterCursorIndex(mentionMsgs, inboxTs, inboxId);

      return { name: g.name, members: g.members, unread_mentions, unread_messages };
    });

  res.json(result);
});

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown() {
  console.log('Shutting down, saving data...');
  refreshServerLiveness();
  Promise.allSettled([
    sweepLocalActivityDurations(),
    sweepLocalSwapPressure(),
    sweepAgentScopePressure(),
  ]).finally(() => {
    sweepAgentRules();
    flushAllPendingJsonWrites();
    saveAgents(true);
    saveGroups();
    saveMessages();
    saveCursors();
    saveServers();
    saveAgentRuntime(true);
    process.exit(0);
  });
}
let startupHooksInstalled = false;
let backgroundLoopsStarted = false;
let serverInstance = null;
const lifecycleIntervals = new Set();
const lifecycleTimeouts = new Set();

function trackLifecycleInterval(fn, delay) {
  const timer = setInterval(fn, delay);
  lifecycleIntervals.add(timer);
  return timer;
}

function trackLifecycleTimeout(fn, delay, { unref = false } = {}) {
  const timer = setTimeout(() => {
    lifecycleTimeouts.delete(timer);
    fn();
  }, delay);
  lifecycleTimeouts.add(timer);
  if (unref && typeof timer?.unref === 'function') timer.unref();
  return timer;
}

function clearLifecycleHandles() {
  for (const timer of lifecycleIntervals) clearInterval(timer);
  lifecycleIntervals.clear();
  for (const timer of lifecycleTimeouts) clearTimeout(timer);
  lifecycleTimeouts.clear();
}

function endSseClients() {
  for (const client of [...sseAdapter.clients]) {
    try { client.end(); } catch (_) { /* ignore close errors */ }
  }
  sseAdapter.clients.clear();
}

function installStartupHooks() {
  if (startupHooksInstalled) return;
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  startupHooksInstalled = true;
}

function removeStartupHooks() {
  if (!startupHooksInstalled) return;
  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  startupHooksInstalled = false;
}

function startBackgroundLoops() {
  if (backgroundLoopsStarted) return;
  backgroundLoopsStarted = true;

  // SSE keepalive: send comment pings every 30s to prevent proxy idle timeout.
  sseAdapter.startKeepalive(trackLifecycleInterval);

  trackLifecycleInterval(() => {
    refreshServerLiveness();
  }, SERVER_SWEEP_INTERVAL_MS);

  scheduleAdaptiveSweepLoop('sweepLocalActivityDurations', sweepLocalActivityDurations, 'localActivity', LOCAL_ACTIVITY_SWEEP_INTERVAL_MS);

  trackLifecycleInterval(() => {
    sweepAgentRules();
  }, RULE_SWEEP_INTERVAL_MS);

  scheduleAdaptiveSweepLoop('sweepLocalSwapPressure', sweepLocalSwapPressure, 'localSwap', SWAP_SWEEP_INTERVAL_MS);

  scheduleAdaptiveSweepLoop('sweepAgentScopePressure', sweepAgentScopePressure, 'agentScope', AGENT_SCOPE_SWEEP_INTERVAL_MS);

  // Supervisor lifecycle sweep — manages per-agent supervisor tmux sessions
  scheduleAdaptiveSweepLoop('sweepSupervisorLifecycle', () => supervisorLifecycleManager.sweepAll(), 'supervisorLifecycle', SUPERVISOR_LIFECYCLE_SWEEP_INTERVAL_MS);

  // Prune resolved alerts every hour
  trackLifecycleInterval(() => { alertStore.pruneResolved(); }, 3600_000);
}

function stopBackgroundLoops() {
  backgroundLoopsStarted = false;
  clearLifecycleHandles();
  endSseClients();
}

// Bind address. Loopback by default; see lib/startup-config.js resolveBindHost
// for why widening it is opt-in and logged.
function resolvedBindHost() {
  const { host, warning } = resolveBindHost(process.env.HAFLEET_BACKEND_HOST);
  if (warning) console.warn(`[bind] ${warning}`);
  return host;
}

export function startServer({ port = PORT, host = resolvedBindHost() } = {}) {
  if (serverInstance) return serverInstance;
  installStartupHooks();
  startBackgroundLoops();

  const MAX_LISTEN_RETRIES = 10;
  let listenAttempt = 0;

  function tryListen() {
    const server = app.listen(port, host);
    server.on('listening', () => {
      serverInstance = server;
      runAsyncSweep('sweepLocalActivityDurations', sweepLocalActivityDurations, 'localActivity');
      runAsyncSweep('sweepLocalSwapPressure', sweepLocalSwapPressure, 'localSwap');
      runAsyncSweep('sweepAgentScopePressure', sweepAgentScopePressure, 'agentScope');
      runAsyncSweep('sweepSupervisorLifecycle', () => supervisorLifecycleManager.sweepAll(), 'supervisorLifecycle');
      runAsyncSweep('sweepProjectSideRepresentatives', sweepProjectSideRepresentatives, 'projectSides');
      try { const orphans = supervisorLifecycleManager.cleanOrphanSessions(); if (orphans.length) console.log(`  Cleaned ${orphans.length} orphan supervisor session(s): ${orphans.join(', ')}`); } catch { /* tmux not available */ }
      console.log(`Agent Chat v2 backend listening on http://${host}:${port}`);
      const agentCount = Object.values(agents).filter(isAgentRecord).length;
      console.log(`  Agents: ${agentCount}, Messages: ${messages.length}, Groups: ${Object.keys(groups).length}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        listenAttempt++;
        if (listenAttempt >= MAX_LISTEN_RETRIES) {
          console.error(`[FATAL] Port ${port} still in use after ${MAX_LISTEN_RETRIES} retries — exiting`);
          process.exit(1);
        }
        const delay = Math.min(30_000, 1000 * Math.pow(2, listenAttempt - 1));
        console.warn(`[EADDRINUSE] Port ${port} in use — retry ${listenAttempt}/${MAX_LISTEN_RETRIES} in ${delay}ms`);
        trackLifecycleTimeout(tryListen, delay);
      } else {
        console.error(`[FATAL] Server listen error: ${err.message}`);
        process.exit(1);
      }
    });
    return server;
  }

  serverInstance = tryListen();
  return serverInstance;
}

export async function stopServer() {
  stopBackgroundLoops();
  removeStartupHooks();
  flushAllPendingJsonWrites();

  const server = serverInstance;
  serverInstance = null;
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') {
    try { server.closeAllConnections(); } catch (_) { /* ignore close errors */ }
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export { app };
export {
  normalizeAgentName,
  normalizeHumanMeta,
  mergeHumanMeta,
  normalizeAgentTask,
  serializeAgent,
  notificationRouter,
};
export const __backendV2TestInternals = {
  // The directory this module bound to when its body evaluated. RUNTIME_ROOT is
  // read from process.env at import time, and process.env is process-global, so a
  // test that sets it and then awaits import() can have the value changed
  // underneath by any other test doing the same. A module that bound to someone
  // else's directory finds no seeded agents and answers 404 to everything —
  // observed as GET /api/agents/doomed and DELETE /api/agents/deletetest returning
  // 404 for agents that were definitely seeded. Exposed so a caller can check
  // rather than discover it as a mystery failure much later.
  runtimeRootForTest: RUNTIME_ROOT,
  buildLocalPaneMetadataSnapshotForTest: buildLocalPaneMetadataSnapshotAsync,
  injectSlashClearForTest: injectSlashClear,
  sessionPolicyForTest: sessionPolicy,
  notifyAgentCatchupForTest: notifyAgentCatchup,
  pushNotifyForTest: pushNotify,
  sseAdapterForTest: sseAdapter,
  safeWriteJsonFile,
  setJsonSaveFailureForTest,
  setMatrixDispatchFailureForTest(stage = null) {
    matrixDispatchFailureStageForTest = stage;
  },
  dispatchLeaseStoreForTest: dispatchLeaseStore,
  approvalStoreForTest: approvalStore,
  dispatchQueuesForTest: dispatchQueues,
  sweepLocalActivityDurationsForTest: sweepLocalActivityDurations,
  /*
   * The live server store, for tests that need a heartbeat to be OLD.
   *
   * The alternative was what tests/api-server-heartbeat.test.js actually did: set the TTL to
   * 100ms and sleep(200) to make a server stale — which put every assertion after the recovery
   * heartbeat inside a 100ms window that a GC pause under load regularly blew. Specimen (run 2 of
   * the forensic hunt): s1's outage re-opened between the recovery heartbeat and the assertion
   * GET, so `openAfter` read [s1, s2] instead of [s2]. Rewriting servers.json does not work —
   * this store is the in-memory truth and the file is only its persistence.
   */
  serversForTest: servers,
};

if (process.argv[1] === __filename) {
  enforceStartupConfig({
    serviceName: 'Agent Chat v2 backend',
    optional: BACKEND_STARTUP_OPTIONAL_ENV,
  });
  startServer();
}
