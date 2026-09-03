import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { resolveLocalServerId } from './server-identity.js';
import {
  claudeChannelServerOptions,
  failClosedRuntimeApproval,
  resolveAndConsumeRuntimeApproval,
} from './runtime-approval-client.js';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
}

function detectAgentName() {
  // Highest priority: explicit launcher injection (hafleet-up sets this).
  // This avoids cross-agent identity bleed when tmux client context is ambiguous.
  const envAgent = (process.env.AGENT_NAME || '').trim();
  if (envAgent) return envAgent;

  const envPane = (process.env.TMUX_PANE || '').trim();
  if (envPane) {
    try {
      const fromPane = run(`tmux display-message -p -t ${JSON.stringify(envPane)} "#{session_name}"`);
      if (fromPane) return fromPane;
    } catch {}
  }

  // Fallback for clients that don't pass TMUX/TMUX_PANE to MCP subprocesses:
  // map this process TTY back to tmux pane -> session.
  try {
    const tty = run(`ps -o tty= -p ${process.pid}`);
    if (tty) {
      const paneLines = run('tmux list-panes -a -F "#{pane_tty} #{session_name}"');
      const expected = `/dev/${tty}`;
      for (const line of paneLines.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const paneTty = line.slice(0, sp).trim();
        const session = line.slice(sp + 1).trim();
        if (paneTty === expected && session) return session;
      }
    }
  } catch {}

  try {
    const fromClient = run('tmux display-message -p "#{session_name}"');
    if (fromClient) return fromClient;
  } catch {}

  return null;
}

// Auto-detect agent name reliably.
const AGENT_NAME = detectAgentName();
if (!AGENT_NAME) {
  process.stderr.write('Error: Cannot determine agent name. Run inside tmux or set AGENT_NAME.\n');
  process.exit(1);
}

const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.HAFLEET_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const API = process.env.HAFLEET_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const EPHEMERAL_RUNNER = process.env.HAFLEET_EPHEMERAL_RUNNER === '1';
const DISPATCH_CAPABILITY = (process.env.HAFLEET_DISPATCH_CAPABILITY || '').trim();
const DISPATCH_ID = (process.env.HAFLEET_DISPATCH_ID || '').trim();
const RUNNER_ID = (process.env.HAFLEET_RUNNER_ID || '').trim();
const FENCE_GENERATION = (process.env.HAFLEET_FENCE_GENERATION || '').trim();
const AGENT_SERVER = resolveLocalServerId();
const AGENT_TOKEN = (() => {
  const injected = (process.env.AGENT_TOKEN || '').trim();
  if (injected) return injected;
  const stateDir = (process.env.HAFLEET_AGENT_STATE_DIR || '').trim();
  if (!stateDir) return '';
  /*
   * B11 (12-r2): FAIL-CLOSED. A state dir that names no token file is a
   * provisioning failure: under audit-mode auth every call ships without a
   * credential, and under enforce-mode every call 403s — either way the MCP
   * server "runs" while nothing it does counts as the agent. Refuse to start,
   * naming the file, with a non-zero exit.
   */
  const tokenFile = path.join(stateDir, 'agent-token');
  let value = '';
  try {
    value = readFileSync(tokenFile, 'utf-8').trim();
  } catch (err) {
    process.stderr.write(`[mcp] agent-token file missing (${err.code || err.message}): ${tokenFile} — refusing to start; every backend call would fail agent-token auth\n`);
    process.exit(3);
  }
  if (!value) {
    process.stderr.write(`[mcp] agent-token file is empty: ${tokenFile} — refusing to start; every backend call would fail agent-token auth\n`);
    process.exit(3);
  }
  return value;
})();
const CLAUDE_PERMISSION_CHANNEL_ENABLED = Boolean(AGENT_TOKEN)
  && (process.env.HAFLEET_CLAUDE_PERMISSION_CHANNEL || 'true').trim().toLowerCase() !== 'false';
const APPROVAL_POLL_INTERVAL_MS_RAW = Number.parseInt(process.env.HAFLEET_APPROVAL_POLL_INTERVAL_MS || '1000', 10);
const APPROVAL_POLL_INTERVAL_MS = Number.isFinite(APPROVAL_POLL_INTERVAL_MS_RAW) && APPROVAL_POLL_INTERVAL_MS_RAW > 0
  ? Math.max(250, APPROVAL_POLL_INTERVAL_MS_RAW)
  : 1000;
const ATTACHMENT_MAX_BYTES = Number.parseInt(process.env.HAFLEET_ATTACHMENT_MAX_BYTES || String(20 * 1024 * 1024), 10);
const ATTACHMENT_MAX_ITEMS = Number.parseInt(process.env.HAFLEET_ATTACHMENT_MAX_ITEMS || '8', 10);

function envPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? path.resolve(raw) : null;
}

function safePathSegment(value, fallback = 'agent') {
  const raw = typeof value === 'string' ? value.trim() : '';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '');
  return safe || fallback;
}

function defaultAgentchatHome(env = process.env) {
  return envPath(env.HAFLEET_HOMEDIR) || path.join(os.homedir(), '.hafleet');
}

function resolveAgentStateDir(agentName, env = process.env) {
  const stateDir = (env.HAFLEET_AGENT_STATE_DIR || '').trim();
  if (stateDir) return stateDir;
  return path.join(defaultAgentchatHome(env), 'agents', `agent_${agentName}`, 'state');
}

function resolveMediaFetchCacheDir(agentName, env = process.env) {
  const agentSegment = safePathSegment(agentName);
  const stateDir = envPath(env.HAFLEET_AGENT_STATE_DIR);
  if (stateDir) return path.join(stateDir, 'mcp-media-cache');

  const runtimeDir = envPath(env.HAFLEET_RUNTIME_DIR);
  if (runtimeDir) return path.join(runtimeDir, 'data', 'mcp-media-cache', agentSegment);

  return path.join(defaultAgentchatHome(env), 'data', 'mcp-media-cache', agentSegment);
}

const MEDIA_FETCH_CACHE_DIR = resolveMediaFetchCacheDir(AGENT_NAME);
mkdirSync(MEDIA_FETCH_CACHE_DIR, { recursive: true });

if (process.env.HAFLEET_MCP_MEDIA_CACHE_SMOKE === '1') {
  process.stdout.write(`${MEDIA_FETCH_CACHE_DIR}\n`);
  process.exit(0);
}

// ── Fetch timeout + retry ─────────────────────────────────────────────
function parsePositiveInt(value, fallback, min = 1) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseBackoffList(value, fallback = [500, 1500]) {
  const parsed = String(value || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

const MCP_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.MCP_FETCH_TIMEOUT_MS || '10000', 10);
const MCP_FETCH_TIMEOUT_MS = Number.isFinite(MCP_FETCH_TIMEOUT_MS_RAW) && MCP_FETCH_TIMEOUT_MS_RAW > 0
  ? MCP_FETCH_TIMEOUT_MS_RAW
  : 10000;
const MCP_MEDIA_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.MCP_MEDIA_FETCH_TIMEOUT_MS || '15000', 10);
const MCP_MEDIA_FETCH_TIMEOUT_MS = Number.isFinite(MCP_MEDIA_FETCH_TIMEOUT_MS_RAW) && MCP_MEDIA_FETCH_TIMEOUT_MS_RAW > 0
  ? MCP_MEDIA_FETCH_TIMEOUT_MS_RAW
  : 15000;
const MCP_FETCH_RETRIES = parsePositiveInt(process.env.MCP_FETCH_RETRIES, 3);
const MCP_FETCH_BACKOFF = parseBackoffList(process.env.MCP_FETCH_BACKOFF_MS, [500, 1500]);
const MCP_HEARTBEAT_INTERVAL_MS = parseNonNegativeInt(process.env.MCP_HEARTBEAT_INTERVAL_MS, 30000);

let backendHealthy = null;
let heartbeatTimer = null;
let heartbeatInFlight = null;
let heartbeatStarted = false;

function markBackendDisconnected(label, detail) {
  if (backendHealthy === false) return false;
  backendHealthy = false;
  const suffix = detail ? `: ${detail}` : '';
  process.stderr.write(`[mcp] backend disconnected (${label || 'request'}${suffix})\n`);
  return true;
}

function markBackendConnected(label) {
  const recovered = backendHealthy === false;
  backendHealthy = true;
  if (recovered) {
    process.stderr.write(`[mcp] backend reconnected (${label || 'request'})\n`);
  }
  return recovered;
}

function isMcpHeartbeatPath(apiPath) {
  return /\/api\/agents\/[^/]+\/heartbeat$/.test(String(apiPath || ''));
}

async function fetchWithRetry(url, opts, { timeoutMs, label } = {}) {
  const attempts = MCP_FETCH_RETRIES;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      const fetchOpts = { ...opts };
      if (timeoutMs) fetchOpts.signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(url, fetchOpts);
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT';
      const tag = isTimeout ? 'timeout' : 'network-error';
      if (i < attempts - 1) {
        const delay = MCP_FETCH_BACKOFF[Math.min(i, MCP_FETCH_BACKOFF.length - 1)];
        process.stderr.write(`[mcp] ${label || url} ${tag} (attempt ${i + 1}/${attempts}), retrying in ${delay}ms\n`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      markBackendDisconnected(label || url, `${tag} after ${attempts} attempt(s): ${err.message}`);
      throw new Error(`${label || url} failed after ${attempts} attempts (last: ${tag} — ${err.message})`);
    }
    // Retry on 5xx server errors (not 4xx client errors)
    if (res.status >= 500 && i < attempts - 1) {
      const delay = MCP_FETCH_BACKOFF[Math.min(i, MCP_FETCH_BACKOFF.length - 1)];
      process.stderr.write(`[mcp] ${label || url} HTTP ${res.status} (attempt ${i + 1}/${attempts}), retrying in ${delay}ms\n`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (res.status >= 500) {
      markBackendDisconnected(label || url, `HTTP ${res.status} after ${attempts} attempt(s)`);
    }
    return res;
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────
async function api(method, apiPath, body) {
  if (EPHEMERAL_RUNNER) {
    const selfPath = `/api/agents/${encodeURIComponent(AGENT_NAME)}`;
    const allowed = (method === 'GET' && apiPath === selfPath)
      || (method === 'GET' && apiPath === '/api/agents?view=names')
      || (method === 'GET' && apiPath.startsWith(`/api/inbox/${encodeURIComponent(AGENT_NAME)}`))
      || (method === 'POST' && apiPath === '/api/router/tasks')
      || (method === 'POST' && apiPath === '/api/router/approvals/claude')
      || (method === 'POST' && apiPath === '/api/router/approvals/claude/apply')
      || (method === 'GET' && /^\/api\/approvals\/[^/]+$/.test(apiPath))
      || (method === 'POST' && /^\/api\/approvals\/[^/]+\/consume$/.test(apiPath));
    if (!allowed) throw new Error(`ephemeral runner MCP access is session-scoped; ${method} ${apiPath} is unavailable`);
  }
  const opts = { method, headers: {} };
  if (API_TOKEN) {
    opts.headers.Authorization = `Bearer ${API_TOKEN}`;
  }
  if (AGENT_TOKEN) {
    opts.headers['X-Agent-Token'] = AGENT_TOKEN;
  }
  if (DISPATCH_CAPABILITY || DISPATCH_ID || RUNNER_ID || FENCE_GENERATION) {
    opts.headers['X-HAFleet-Dispatch-Capability'] = DISPATCH_CAPABILITY;
    opts.headers['X-HAFleet-Dispatch-Id'] = DISPATCH_ID;
    opts.headers['X-HAFleet-Runner-Id'] = RUNNER_ID;
    opts.headers['X-HAFleet-Fence-Generation'] = FENCE_GENERATION;
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const url = `${API}${apiPath}`;
  const res = await fetchWithRetry(url, opts, { timeoutMs: MCP_FETCH_TIMEOUT_MS, label: `API ${method} ${apiPath}` });
  if (res.status < 500) {
    const recovered = markBackendConnected(`API ${method} ${apiPath}`);
    if (recovered && !isMcpHeartbeatPath(apiPath)) {
      queueMcpHeartbeat('request-recovered');
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

async function ensureAgentRegistered() {
  try {
    await api('GET', `/api/agents/${encodeURIComponent(AGENT_NAME)}`);
    return;
  } catch (e) {
    const msg = String(e?.message || '');
    if (!/agent not found/i.test(msg)) return;
  }

  try {
    await api('POST', '/api/agents', {
      name: AGENT_NAME,
      type: 'agent',
      tmux: `${AGENT_NAME}:0.0`,
      server: AGENT_SERVER,
    });
  } catch (e) {
    process.stderr.write(`Warning: failed to auto-register agent '${AGENT_NAME}': ${e.message}\n`);
  }
}

function buildMcpHeartbeatBody() {
  return {
    server: AGENT_SERVER,
    mcpPresent: true,
    pid: process.pid,
    workspacePath: process.cwd(),
  };
}

async function sendMcpHeartbeat(reason = 'interval') {
  try {
    const data = await api('POST', `/api/agents/${encodeURIComponent(AGENT_NAME)}/heartbeat`, buildMcpHeartbeatBody());
    if (data?.ok !== true) {
      process.stderr.write(`[mcp] heartbeat returned an unexpected response (${reason})\n`);
    }
    return data;
  } catch (e) {
    markBackendDisconnected(`heartbeat:${reason}`, e.message);
    throw e;
  }
}

function queueMcpHeartbeat(reason = 'interval') {
  if (!heartbeatStarted || MCP_HEARTBEAT_INTERVAL_MS <= 0 || heartbeatInFlight) return;
  heartbeatInFlight = sendMcpHeartbeat(reason)
    .catch((e) => {
      process.stderr.write(`[mcp] heartbeat failed (${reason}): ${e.message}\n`);
    })
    .finally(() => {
      heartbeatInFlight = null;
    });
}

function startMcpHeartbeat() {
  if (MCP_HEARTBEAT_INTERVAL_MS <= 0 || heartbeatStarted) return;
  heartbeatStarted = true;
  queueMcpHeartbeat('startup');
  heartbeatTimer = setInterval(() => queueMcpHeartbeat('interval'), MCP_HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopMcpHeartbeat() {
  heartbeatStarted = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function text(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function normalizeWhoamiIdentity(me) {
  if (!me || typeof me !== 'object') return { name: AGENT_NAME };
  const out = {};
  for (const key of ['name', 'role', 'type', 'agentId', 'layoutVersion', 'agentModelVersion']) {
    const value = me[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  if (!out.name) out.name = AGENT_NAME;
  return out;
}

function normalizeWhoamiGroups(me) {
  if (!Array.isArray(me?.groups)) return [];
  return [...new Set(
    me.groups
      .map(group => (typeof group === 'string' ? group.trim() : ''))
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function normalizeWhoamiAgentNames(allAgents) {
  if (!Array.isArray(allAgents)) return [];
  return [...new Set(
    allAgents
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name.trim();
        return '';
      })
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function normalizeAttachmentName(name, fallback = 'file') {
  let out = typeof name === 'string' ? name.trim() : '';
  if (!out) out = fallback;
  out = path.basename(out);
  out = out.replace(/[^\w.\-()[\] ]+/g, '_');
  if (!out) out = fallback;
  return out;
}

function normalizeAttachmentMime(mime) {
  if (typeof mime !== 'string') return null;
  const normalized = mime.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeAttachmentKind(kind, mime, name) {
  if (kind === 'image' || kind === 'file') return kind;
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(String(name || ''))) return 'image';
  return 'file';
}

function normalizeAttachmentInput(raw) {
  const item = (typeof raw === 'string') ? { path: raw } : raw;
  if (!item || typeof item !== 'object') throw new Error('attachment must be a string path or object');

  const filePath = typeof item.path === 'string' ? item.path.trim() : '';
  if (!filePath) throw new Error('attachment.path required');

  const fallbackName = path.basename(filePath) || 'file';
  const name = normalizeAttachmentName(item.name, fallbackName);
  const mime = normalizeAttachmentMime(item.mime);
  const kind = normalizeAttachmentKind(item.kind, mime, name);
  return { path: filePath, name, mime, kind };
}

async function stageAttachmentForBackend(rawAttachment) {
  const attachment = normalizeAttachmentInput(rawAttachment);
  let stat;
  try {
    stat = statSync(attachment.path);
  } catch (e) {
    throw new Error(`attachment not found: ${attachment.path} (${e.message})`);
  }
  if (!stat.isFile()) throw new Error(`attachment is not a file: ${attachment.path}`);
  if (stat.size <= 0) throw new Error(`attachment is empty: ${attachment.path}`);
  if (stat.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment too large: ${attachment.path} (${stat.size} bytes > ${ATTACHMENT_MAX_BYTES})`);
  }
  const buf = readFileSync(attachment.path);
  const staged = await api('POST', '/api/media/stage', {
    from: AGENT_NAME,
    source_path: attachment.path,
    name: attachment.name,
    mime: attachment.mime,
    kind: attachment.kind,
    content_base64: buf.toString('base64'),
  });
  if (!staged?.attachment?.path) throw new Error(`backend failed to stage attachment: ${attachment.path}`);
  return staged.attachment;
}

async function stageAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];
  if (rawAttachments.length > ATTACHMENT_MAX_ITEMS) {
    throw new Error(`too many attachments (max ${ATTACHMENT_MAX_ITEMS})`);
  }
  const out = [];
  for (const item of rawAttachments) {
    out.push(await stageAttachmentForBackend(item));
  }
  return out;
}

function statReadableFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { path: filePath, size: stat.size };
  } catch {
    return null;
  }
}

function inferMimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
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
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.json': return 'application/json';
    default: return null;
  }
}

function inferExtFromMime(mime) {
  const normalized = normalizeAttachmentMime(mime);
  switch (normalized) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/bmp': return '.bmp';
    case 'image/svg+xml': return '.svg';
    case 'image/avif': return '.avif';
    case 'image/heic': return '.heic';
    case 'image/heif': return '.heif';
    case 'image/tiff': return '.tiff';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    case 'text/markdown': return '.md';
    case 'application/json': return '.json';
    default: return null;
  }
}

function parseContentDispositionFilename(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null;

  const starMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch?.[1]) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      return starMatch[1].trim();
    }
  }

  const quotedMatch = headerValue.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();

  const plainMatch = headerValue.match(/filename=([^;]+)/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();

  return null;
}

function buildMediaCachePath(sourcePath, fallbackName, mime) {
  const source = String(sourcePath || '').trim() || 'media';
  const normalizedName = normalizeAttachmentName(fallbackName || path.basename(source) || 'file');
  const sourceExt = path.extname(source);
  const nameExt = path.extname(normalizedName);
  const ext = nameExt || inferExtFromMime(mime) || sourceExt || '.bin';
  const stem = normalizeAttachmentName(path.basename(normalizedName, nameExt || path.extname(normalizedName)) || 'file');
  const hash = createHash('sha1').update(source).digest('hex').slice(0, 16);
  return path.join(MEDIA_FETCH_CACHE_DIR, `${hash}-${stem}${ext}`);
}

const CLAUDE_SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
const IMAGE_MAX_DIMENSION = 4096;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function sanitizeImageSync(filePath, kind, mime) {
  if (kind !== 'image') return { path: filePath, kind, mime, sanitized: false };
  try {
    const info = execFileSync('identify', ['-format', '%w %h %m', filePath], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const [wStr, hStr, fmt] = info.split(/\s+/);
    const w = Number(wStr) || 0;
    const h = Number(hStr) || 0;
    if (w <= 0 || h <= 0) {
      process.stderr.write(`[hafleet] image sanitize: invalid dimensions ${w}x${h} for ${filePath}, downgrading to file\n`);
      return { path: filePath, kind: 'file', mime, sanitized: true, warning: `Image has invalid dimensions (${w}x${h}), not viewable as image` };
    }
    const needsResize = w > IMAGE_MAX_DIMENSION || h > IMAGE_MAX_DIMENSION;
    const stat = statSync(filePath);
    const needsShrink = stat.size > IMAGE_MAX_BYTES;
    const fmtLower = (fmt || '').toLowerCase();
    const needsConvert = !['png', 'jpeg', 'gif', 'webp'].includes(fmtLower);
    if (!needsResize && !needsShrink && !needsConvert) {
      return { path: filePath, kind, mime, sanitized: false };
    }
    const ext = needsConvert ? '.png' : path.extname(filePath) || '.png';
    const sanitizedPath = filePath.replace(/(\.[^.]+)?$/, `.sanitized${ext}`);
    const args = [filePath];
    if (needsResize) args.push('-resize', `${IMAGE_MAX_DIMENSION}x${IMAGE_MAX_DIMENSION}>`);
    if (needsShrink && !needsResize) args.push('-resize', '75%');
    args.push('-strip', sanitizedPath);
    execFileSync('convert', args, { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    const newStat = statSync(sanitizedPath);
    const newMime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : mime;
    process.stderr.write(`[hafleet] image sanitized: ${filePath} -> ${sanitizedPath} (${stat.size} -> ${newStat.size})\n`);
    return { path: sanitizedPath, kind: 'image', mime: newMime, size: newStat.size, sanitized: true };
  } catch (e) {
    process.stderr.write(`[hafleet] image sanitize failed for ${filePath}: ${e.message}, downgrading to file\n`);
    return { path: filePath, kind: 'file', mime, sanitized: true, warning: `Image could not be validated (${e.message}), attached as file instead of image` };
  }
}

async function fetchMediaPathToLocal(sourcePath, hint = {}) {
  const source = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (!source) throw new Error('media source path required');

  const local = statReadableFile(source);
  if (local) {
    const name = normalizeAttachmentName(hint.name, path.basename(source) || 'file');
    const mime = normalizeAttachmentMime(hint.mime) || inferMimeFromName(name);
    const kind = normalizeAttachmentKind(hint.kind, mime, name);
    return {
      path: source,
      name,
      mime,
      kind,
      size: local.size,
      staged: true,
      source_path: hint.source_path || source,
    };
  }

  const cachedPath = buildMediaCachePath(source, hint.name, hint.mime);
  const cached = statReadableFile(cachedPath);
  if (cached) {
    const name = normalizeAttachmentName(hint.name, path.basename(cachedPath) || 'file');
    const mime = normalizeAttachmentMime(hint.mime) || inferMimeFromName(name);
    const kind = normalizeAttachmentKind(hint.kind, mime, name);
    return {
      path: cachedPath,
      name,
      mime,
      kind,
      size: cached.size,
      staged: true,
      source_path: hint.source_path || source,
    };
  }

  const opts = { method: 'GET', headers: {} };
  if (API_TOKEN) opts.headers.Authorization = `Bearer ${API_TOKEN}`;
  if (AGENT_TOKEN) opts.headers['X-Agent-Token'] = AGENT_TOKEN;
  const query = new URLSearchParams({ path: source });
  const mediaUrl = `${API}/api/media/fetch?${query}`;
  const res = await fetchWithRetry(mediaUrl, opts, { timeoutMs: MCP_MEDIA_FETCH_TIMEOUT_MS, label: `media-fetch ${source}` });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const reason = body?.error || `HTTP ${res.status}`;
    throw new Error(`media fetch failed (${reason})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length <= 0) throw new Error('media fetch returned empty file');
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new Error(`media fetch too large: ${buffer.length} bytes > ${ATTACHMENT_MAX_BYTES}`);
  }

  const headerName = parseContentDispositionFilename(res.headers.get('content-disposition'));
  const name = normalizeAttachmentName(headerName || hint.name, path.basename(source) || 'file');
  const mime = normalizeAttachmentMime(res.headers.get('content-type'))
    || normalizeAttachmentMime(hint.mime)
    || inferMimeFromName(name);
  const kind = normalizeAttachmentKind(hint.kind, mime, name);
  const targetPath = buildMediaCachePath(source, name, mime);
  writeFileSync(targetPath, buffer);
  return {
    path: targetPath,
    name,
    mime,
    kind,
    size: buffer.length,
    staged: true,
    source_path: hint.source_path || source,
  };
}

function mergeAttachmentsByPath(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const p = typeof item.path === 'string' ? item.path.trim() : '';
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(item);
  }
  return out;
}

async function localizeTextLocalPaths(value) {
  if (typeof value !== 'string' || !value.includes('LocalPath:')) {
    return { text: value, attachments: [] };
  }
  const lines = value.split('\n');
  const extraAttachments = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^LocalPath:\s*(.+)$/);
    if (!match?.[1]) continue;
    const sourcePath = match[1].trim();
    if (!sourcePath) continue;
    try {
      const localized = await fetchMediaPathToLocal(sourcePath, { name: path.basename(sourcePath), source_path: sourcePath });
      lines[i] = `LocalPath: ${localized.path}`;
      extraAttachments.push(localized);
    } catch (e) {
      process.stderr.write(`[hafleet/${AGENT_NAME}] failed to localize LocalPath ${sourcePath}: ${e.message}\n`);
    }
  }
  return { text: lines.join('\n'), attachments: extraAttachments };
}

async function localizeMessageMedia(message) {
  if (!message || typeof message !== 'object') return message;
  const out = { ...message };
  const warnings = [];

  const localizedAttachments = [];
  const sourceAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const raw of sourceAttachments) {
    if (!raw || typeof raw !== 'object') continue;
    const sourcePath = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!sourcePath) {
      localizedAttachments.push(raw);
      continue;
    }
    try {
      const localized = await fetchMediaPathToLocal(sourcePath, raw);
      const sanitized = sanitizeImageSync(localized.path, localized.kind, localized.mime);
      const final = { ...raw, ...localized };
      if (sanitized.sanitized) {
        final.path = sanitized.path;
        final.kind = sanitized.kind;
        if (sanitized.mime) final.mime = sanitized.mime;
        if (sanitized.size) final.size = sanitized.size;
        if (sanitized.warning) warnings.push(sanitized.warning);
      }
      localizedAttachments.push(final);
    } catch (e) {
      process.stderr.write(`[hafleet/${AGENT_NAME}] failed to localize attachment ${sourcePath}: ${e.message}\n`);
      localizedAttachments.push(raw);
    }
  }

  const fullRewrite = await localizeTextLocalPaths(out.full);
  if (typeof fullRewrite.text === 'string') out.full = fullRewrite.text;
  const summaryRewrite = await localizeTextLocalPaths(out.summary);
  if (typeof summaryRewrite.text === 'string') out.summary = summaryRewrite.text;
  out.attachments = mergeAttachmentsByPath([
    ...localizedAttachments,
    ...fullRewrite.attachments,
    ...summaryRewrite.attachments,
  ]);
  if (warnings.length > 0) {
    out.full = (out.full || '') + '\n\n[Media warnings: ' + warnings.join('; ') + ']';
  }
  return out;
}

async function localizeInboxData(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  out.dm = await Promise.all((Array.isArray(data.dm) ? data.dm : []).map(localizeMessageMedia));
  out.group = await Promise.all((Array.isArray(data.group) ? data.group : []).map(localizeMessageMedia));
  return out;
}

async function localizeGroupData(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  out.read = await Promise.all((Array.isArray(data.read) ? data.read : []).map(localizeMessageMedia));
  out.unread = await Promise.all((Array.isArray(data.unread) ? data.unread : []).map(localizeMessageMedia));
  return out;
}

// ── MCP Server ────────────────────────────────────────────────────────
const server = new McpServer({
  name: `hafleet-${AGENT_NAME}`,
  version: '2.1.0',
}, claudeChannelServerOptions(CLAUDE_PERMISSION_CHANNEL_ENABLED));

if (CLAUDE_PERMISSION_CHANNEL_ENABLED) {
  const ClaudePermissionRequestSchema = z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  const relayClaudePermissionRequest = async (params) => {
    const outcome = await failClosedRuntimeApproval(async () => {
      if (EPHEMERAL_RUNNER) {
        const parked = await api('POST', '/api/router/approvals/claude', {
          agent: AGENT_NAME,
          request_id: params.request_id,
          tool_name: params.tool_name,
          description: params.description,
          input_preview: params.input_preview,
        });
        if (!parked?.approval || !parked?.router_approval_id || !parked?.operation_digest) {
          throw new Error('router approval endpoint returned an incomplete park result');
        }
        const resolved = await resolveAndConsumeRuntimeApproval({
          api,
          approval: parked.approval,
          agent: AGENT_NAME,
          pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
        });
        const approvalRequestId = resolved?.consumption?.approval?.id;
        if (!approvalRequestId) throw new Error('owner approval was not durably consumed');
        const applied = await api('POST', '/api/router/approvals/claude/apply', {
          agent: AGENT_NAME,
          approval_request_id: approvalRequestId,
          router_approval_id: parked.router_approval_id,
          operation_digest: parked.operation_digest,
        });
        if (applied?.behavior !== resolved.behavior) {
          throw new Error('router approval result does not match the consumed owner verdict');
        }
        return resolved;
      }
      const created = await api('POST', '/api/approvals', {
        agent: AGENT_NAME,
        runtime: 'claude',
        ...((process.env.HAFLEET_PROJECT_ID || '').trim()
          ? { project: process.env.HAFLEET_PROJECT_ID.trim() }
          : {}),
        upstream_request_id: params.request_id,
        tool_name: params.tool_name,
        description: params.description,
        input_preview: params.input_preview,
      });
      const approval = created?.approval;
      if (!approval) throw new Error('approval API returned no request');
      return resolveAndConsumeRuntimeApproval({
        api,
        approval,
        agent: AGENT_NAME,
        pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
      });
    }, {
      onError: error => {
        process.stderr.write(`[mcp] Claude permission relay failed: ${error.message}; denying unattended request\n`);
      },
    });

    await server.server.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: params.request_id,
        behavior: outcome.behavior,
      },
    });
  };

  server.server.setNotificationHandler(ClaudePermissionRequestSchema, ({ params }) => {
    // Notifications have no response channel. Keep the MCP reader free while
    // the approval poll waits, then deliver the verdict asynchronously.
    void relayClaudePermissionRequest(params).catch((error) => {
      process.stderr.write(`[mcp] Claude fail-closed verdict delivery failed: ${error.message}\n`);
    });
  });
}

if (!EPHEMERAL_RUNNER) {
  await ensureAgentRegistered();
  startMcpHeartbeat();
}

// 1. whoami — returns concise identity, groups, and known agent names
server.tool('whoami', 'Returns your agent identity, role, and groups', {}, async () => {
  try {
    const [me, allAgents] = await Promise.all([
      api('GET', `/api/agents/${AGENT_NAME}`),
      api('GET', '/api/agents?view=names'),
    ]);
    return text({
      me: normalizeWhoamiIdentity(me),
      groups: normalizeWhoamiGroups(me),
      agents: normalizeWhoamiAgentNames(allAgents),
    });
  } catch (e) {
    return err(e.message);
  }
});

// 2. send_message
server.tool(
  'send_message',
  'Send a direct message to another agent. type: request (needs response), inform (FYI, no response needed), reply (answering a prior message)',
  {
    to: z.string().describe('Target agent name'),
    summary: z.string().describe('Short summary of the message, less than 50 words'),
    full: z.string().describe('Full message content with all details'),
    attachments: z.array(z.object({
      path: z.string().describe('Local file path on this machine'),
      name: z.string().optional().describe('Optional display filename'),
      mime: z.string().optional().describe('Optional MIME type override, e.g. image/png'),
      kind: z.enum(['image', 'file']).optional().describe('Optional content kind override'),
    })).max(ATTACHMENT_MAX_ITEMS).optional().describe('Optional attachments. Files are staged to backend and bridged to Matrix.'),
    type: z.enum(['request', 'inform', 'reply']).default('inform').describe('Message type: request, inform, or reply'),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal').describe('Message priority. Urgent notifications skip the idle delivery gate; high priority still waits for idle.'),
    reply_to: z.string().optional().describe('Message ID this is replying to'),
    schema: z.object({
      kind: z.string().describe('Structured message kind, e.g. task_request'),
      version: z.number().int().positive().optional().describe('Schema version; defaults to 1'),
      payload: z.unknown().optional().describe('Structured payload for this kind'),
    }).optional().describe('Optional structured message schema'),
  },
  async ({ to, summary, full, attachments, type, priority, reply_to, schema }) => {
    try {
      const stagedAttachments = await stageAttachments(attachments);
      const data = await api('POST', '/api/messages', {
        from: AGENT_NAME, to, type, priority, summary, full, attachments: stagedAttachments, mentions: [], reply_to: reply_to || null, schema,
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 3. post
server.tool(
  'post',
  'Post a message to a group. Use mentions to @notify specific agents (they get push-notified). Agents not mentioned can still see the message when they check the group.',
  {
    group: z.string().describe('Group name'),
    summary: z.string().describe('Short summary of the message, less than 50 words'),
    full: z.string().describe('Full message content with all details'),
    attachments: z.array(z.object({
      path: z.string().describe('Local file path on this machine'),
      name: z.string().optional().describe('Optional display filename'),
      mime: z.string().optional().describe('Optional MIME type override, e.g. image/png'),
      kind: z.enum(['image', 'file']).optional().describe('Optional content kind override'),
    })).max(ATTACHMENT_MAX_ITEMS).optional().describe('Optional attachments. Files are staged to backend and bridged to Matrix.'),
    type: z.enum(['request', 'inform', 'reply']).default('inform').describe('Message type: request, inform, or reply'),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal').describe('Message priority. Urgent notifications skip the idle delivery gate; high priority still waits for idle.'),
    mentions: z.array(z.string()).optional().describe('Agent names to @mention and push-notify'),
    reply_to: z.string().optional().describe('Message ID this is replying to'),
    schema: z.object({
      kind: z.string().describe('Structured message kind, e.g. task_result'),
      version: z.number().int().positive().optional().describe('Schema version; defaults to 1'),
      payload: z.unknown().optional().describe('Structured payload for this kind'),
    }).optional().describe('Optional structured message schema'),
  },
  async ({ group, summary, full, attachments, type, priority, mentions, reply_to, schema }) => {
    try {
      const stagedAttachments = await stageAttachments(attachments);
      const data = await api('POST', '/api/messages', {
        from: AGENT_NAME, group, type, priority, summary, full, attachments: stagedAttachments, mentions: mentions || [], reply_to: reply_to || null, schema,
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 4. check_inbox — returns full message content (no need for separate get_message)
/**
 * Is there anything in this payload that this agent did not say?
 *
 * The question an anchor needs. An agent's own progress lines go into the group like any other message,
 * so a chatty agent's unread slice can be entirely its own output — observed at 10 of 10 — leaving the
 * human's question out of view and no anchor resolvable. That is a feature destroying its own
 * precondition, so the caller uses this to decide whether one wider look is warranted.
 */
function hasForeignMessage(data, agentName) {
  const me = String(agentName).toLowerCase();
  for (const bucket of ['dm', 'group', 'messages', 'unread', 'read']) {
    const list = data?.[bucket];
    if (!Array.isArray(list)) continue;
    if (list.some((m) => m && typeof m.id === 'string' && String(m.from || '').toLowerCase() !== me)) {
      return true;
    }
  }
  return false;
}

/**
 * Remember what this agent was asked, so a progress hook has something to thread under.
 *
 * `bin/hafleet-progress` refuses to post without an anchor — it will not put a step-by-step feed in a
 * shared room's main timeline — and a `PostToolUse` hook has no way to ask the agent which message it
 * is working on. The inbox read is the one moment where that IS known, so it is recorded here.
 *
 * WHICH MESSAGE, and it is a heuristic, not a fact. The newest inbound message wins. An agent woken by
 * a question is answering that question, which is the case this serves; an agent that read three
 * messages and chose the second gets its progress threaded under the third. The cost of being wrong is
 * bounded and stays inside the room — the bridge validates room and group before sending anything, so
 * a wrong anchor moves progress to a neighbouring thread and can never move it to another
 * conversation. Being exact would need the agent to declare its choice, which no hook can observe.
 *
 * IT ONLY EVER ADDS. A read that returns nothing must not clear an anchor set by an earlier read: the
 * agent is usually mid-task when its later polls come back empty, and clearing would silence progress
 * for exactly the long task that needed it. Best-effort throughout, because an inbox read must not
 * fail over a progress convenience.
 */
function rememberProgressAnchor(data, groupHint = null) {
  try {
    const candidates = [];
    /*
     * `unread` IS IN THIS LIST BECAUSE A LIVE RUN SAID SO. The first version read only the inbox
     * buckets, and on the real fleet the anchor was never written: `check_inbox`'s group bucket carries
     * @mentions, and HAFleet's ordinary way of addressing an agent in a room is `name: question`, which
     * is not a mention. That arrives through `check_group`, whose payload is `unread`/`read`. Six unit
     * tests passed while the feature was useless in the deployment it was for.
     */
    /*
     * `read` IS HERE TOO, and its absence caused a failure worth writing down: an agent's OWN progress
     * lines land in the group and fill the unread slice, so on a busy room the newest ten messages can
     * all be the agent's, the human's question is out of view, and no anchor can be resolved. Observed
     * exactly that — 10 of 10 unread were this agent's own reports. Consulting the read history gives
     * the question a second place to be found.
     */
    for (const bucket of ['dm', 'group', 'messages', 'unread', 'read']) {
      const list = data?.[bucket];
      if (Array.isArray(list)) candidates.push(...list);
    }
    const newest = candidates
      .filter((m) => m && typeof m.id === 'string' && m.id)
      /*
       * NOT OUR OWN MESSAGES. A group's unread slice contains everything said in the room, including
       * this agent's last answer and its own previous progress lines. Anchoring on those would thread
       * progress under progress, and each run would nest one level deeper into a conversation nobody
       * asked for.
       */
      .filter((m) => String(m.from || '').toLowerCase() !== String(AGENT_NAME).toLowerCase())
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))[0];
    if (!newest) return;

    /*
     * NOT `os.tmpdir()`, which is where this started and was wrong. The anchor is the question being
     * worked on: it must live as long as the work, and `TMPDIR` is cleaned by the system and by any
     * test that tidies up. The "a later empty read does not erase the anchor" guard was therefore
     * protecting state that could vanish for an unrelated reason. `$HOME` is durable and is on the
     * router's inherited-env allowlist, so a dispatched agent can still reach it.
     */
    const dir = path.join(os.homedir(), '.hafleet', 'progress-anchor');
    const file = path.join(dir, `${String(AGENT_NAME).replace(/[^\w.-]/g, '_')}.json`);
    let state = {};
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* no state yet, or unreadable: either way this write is the state */ }
    if (state.replyTo === newest.id) return;

    mkdirSync(dir, { recursive: true });
    /*
     * A NEW QUESTION RESETS THE WINDOW AND THE COUNTS. Carrying `lastSentAt` over would let the
     * previous task's throttle swallow the new task's first report, which is the one that matters most
     * — it is the "I have started" that tells a borrower the room heard them.
     */
    /*
     * WHERE to report, recorded with WHAT to thread under, because the reporter cannot derive it. A
     * hook knows nothing about rooms; the message does. A group message is answered in its group, and
     * a direct message is answered back to its sender — the same two destinations the agent's own
     * reply would use, so progress never reaches an audience the answer would not.
     */
    writeFileSync(file, JSON.stringify({
      ...state,
      replyTo: newest.id,
      group: (typeof newest.group === 'string' && newest.group) ? newest.group : (groupHint || null),
      to: (!newest.group && !groupHint && typeof newest.from === 'string' && newest.from) ? newest.from : null,
      lastSentAt: 0,
      counts: {},
    }), { mode: 0o600 });
  } catch { /* never let this break an inbox read */ }
}

server.tool(
  'check_inbox',
  'Check your inbox for unread direct messages and @mentions from groups. Returns two arrays: dm (private messages) and group (@mentions). Reading advances your cursor — messages shown here won\'t appear again next time. When filtered by kinds, this becomes a non-destructive preview.',
  {
    kinds: z.array(z.string()).optional().describe('Optional schema.kind filter. When set, only matching unread messages are returned and the inbox cursor is not advanced.'),
  },
  async ({ kinds }) => {
    try {
      const params = new URLSearchParams();
      if (Array.isArray(kinds) && kinds.length > 0) params.set('kinds', kinds.join(','));
      const suffix = params.size ? `?${params}` : '';
      const data = await api('GET', `/api/inbox/${AGENT_NAME}${suffix}`);
      rememberProgressAnchor(data);
      const localized = await localizeInboxData(data);
      return text(localized);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 5. check_group
server.tool(
  'check_group',
  'Read messages from a group. By default, returns only the latest unread slice (preview) plus recent read history without advancing cursor. Set read_all=true to consume all unread and advance cursor.',
  {
    group: z.string().describe('Group name'),
    limit: z.number().default(10).describe('Number of already-read messages to include for context (default 10)'),
    unread_limit: z.number().default(10).describe('Max unread messages to preview when read_all=false (default 10)'),
    read_all: z.boolean().default(false).describe('When true, return all unread and advance group cursor'),
  },
  async ({ group, limit, unread_limit, read_all }) => {
    try {
      const params = new URLSearchParams({ agent: AGENT_NAME });
      if (limit !== undefined) params.set('limit', String(limit));
      if (read_all) {
        params.set('advance', 'all');
      } else {
        if (unread_limit !== undefined) params.set('unread_limit', String(unread_limit));
        params.set('advance', 'none');
      }
      const data = await api('GET', `/api/groups/${group}/messages?${params}`);
      /*
       * ONE WIDER LOOK, and only when the slice the agent asked for contains nothing but the agent's
       * own output. Without it a chatty agent can never recover an anchor it has lost: every message it
       * can see is its own, so there is nothing to thread under, so it reports nothing — permanently.
       *
       * Bounded on purpose. One extra GET, only in that specific dead end, never affecting what the
       * agent is shown, and a failure leaves the original payload in place. The alternative — always
       * asking for a wide window — would make every inbox read more expensive to fix a rare case.
       */
      let anchorSource = data;
      if (!hasForeignMessage(data, AGENT_NAME)) {
        try {
          anchorSource = await api('GET', `/api/groups/${group}/messages?`
            + new URLSearchParams({ agent: AGENT_NAME, limit: '50', unread_limit: '50', advance: 'none' }));
        } catch { /* the wider look is a courtesy; the read itself already succeeded */ }
      }
      // The group is known from the argument here, and the payload's messages may not carry it.
      rememberProgressAnchor(anchorSource, group);
      const localized = await localizeGroupData(data);
      return text(localized);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 6. list_tasks
server.tool(
  'create_task',
  'Create a durable task and Matrix thread from messages in this session. The backend derives the room and thread root from authenticated session inputs.',
  {
    assignee: z.string().describe('Registered worker agent name'),
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task details'),
    root_message_id: z.string().describe('Session message id whose authenticated Matrix event becomes the thread root'),
    input_message_ids: z.array(z.string()).optional().describe('Additional session message ids that contribute to this task'),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p2'),
    granularity: z.enum(['epic', 'task', 'subtask']).default('task'),
    parent_id: z.string().optional(),
    labels: z.array(z.string()).optional(),
    acknowledgement_body: z.string().optional().describe('Short Matrix acknowledgement posted in the new task thread'),
  },
  async ({ assignee, title, description, root_message_id, input_message_ids, priority, granularity, parent_id, labels, acknowledgement_body }, extra) => {
    try {
      if (!DISPATCH_CAPABILITY) throw new Error('create_task requires a thread-session runner capability');
      const data = await api('POST', '/api/router/tasks', {
        agent: AGENT_NAME,
        assignee,
        title,
        description,
        root_message_id,
        input_message_ids: input_message_ids || [],
        priority,
        granularity,
        parent_id: parent_id || null,
        labels: labels || [],
        acknowledgement_body,
        tool_call_id: String(extra.requestId),
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 7. list_tasks
server.tool(
  'list_tasks',
  "List tasks. By default, returns only tasks assigned to you. Pass assignee='*' for all tasks or assignee='<name>' for a specific agent. Filter by status (comma-separated for multiple), priority (p0|p1|p2|p3), or label.",
  {
    assignee: z.string().optional().describe("Filter by assignee. Defaults to yourself. Use '*' for all tasks."),
    status: z.string().optional().describe("Filter by status. Comma-separated for multiple, e.g. 'created,accepted'."),
    priority: z.string().optional().describe('Filter by priority: p0, p1, p2, or p3.'),
    label: z.string().optional().describe('Filter by a label string.'),
    limit: z.number().int().positive().optional().describe('Max number of tasks to return.'),
    offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
  },
  async ({ assignee, status, priority, label, limit, offset }) => {
    try {
      const params = new URLSearchParams();
      const effectiveAssignee = assignee === undefined ? AGENT_NAME : assignee;
      if (effectiveAssignee && effectiveAssignee !== '*') params.set('assignee', effectiveAssignee);
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
      if (label) params.set('label', label);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const suffix = params.toString() ? `?${params}` : '';
      const data = await api('GET', `/api/tasks${suffix}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 7. get_task
server.tool(
  'get_task',
  'Fetch full details for a single task by id, including description, status, assignee, priority, labels, and comments.',
  {
    id: z.string().describe('Task id, e.g. task_1779920622_6p6sr7'),
  },
  async ({ id }) => {
    try {
      const data = await api('GET', `/api/tasks/${encodeURIComponent(id)}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 8. accept_task — sugar for transition created → accepted
server.tool(
  'accept_task',
  "Accept a task assigned to you, transitioning its status from 'created' to 'accepted'. Backend enforces that only the assignee can accept.",
  {
    id: z.string().describe('Task id, e.g. task_1779920622_6p6sr7'),
  },
  async ({ id }) => {
    try {
      const data = await api('POST', `/api/tasks/${encodeURIComponent(id)}/accept`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 9. transition_task — drive a task through the state machine
server.tool(
  'transition_task',
  "Transition a task to a new status. Valid statuses: 'accepted', 'in_progress', 'blocked', 'done'. The state machine is: created→accepted→in_progress→{blocked,done}, and blocked→in_progress. When transitioning to 'blocked', both waiting_reason and waiting_until are required. Backend enforces that only the assignee can transition.",
  {
    id: z.string().describe('Task id'),
    status: z.enum(['accepted', 'in_progress', 'blocked', 'done']).describe('Target status'),
    waiting_reason: z.string().optional().describe("Required when status='blocked'. Free-text reason the task is blocked."),
    waiting_until: z.string().optional().describe("Required when status='blocked'. ISO-8601 timestamp for when to revisit."),
  },
  async ({ id, status, waiting_reason, waiting_until }) => {
    try {
      const body = { status };
      if (waiting_reason !== undefined) body.waiting_reason = waiting_reason;
      if (waiting_until !== undefined) body.waiting_until = waiting_until;
      const data = await api('POST', `/api/tasks/${encodeURIComponent(id)}/transition`, body);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 10. comment_task — append a comment to a task
server.tool(
  'comment_task',
  "Append a comment to a task. Use this to record your work product (the answer, the patch, a link), or to communicate blockers and findings on the task itself. The comment author defaults to your agent name.",
  {
    id: z.string().describe('Task id'),
    text: z.string().describe('Comment body, up to 4096 characters.'),
  },
  async ({ id, text: commentText }) => {
    try {
      const data = await api('POST', `/api/tasks/${encodeURIComponent(id)}/comments`, {
        author: AGENT_NAME,
        text: commentText,
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 11. update_task_execution — self-report heartbeat or waiting metadata mid-flight
server.tool(
  'update_task_execution',
  "Self-report execution state on a task you're working on without changing its status. Use this to refresh a heartbeat on a long-running task, or to set/clear waiting metadata without transitioning to 'blocked'. Backend enforces that only the assignee can update.",
  {
    id: z.string().describe('Task id'),
    heartbeat: z.boolean().optional().describe("When true, refresh heartbeat_at to now."),
    waiting_reason: z.string().optional().describe('Set or clear waiting reason (pass empty string to clear).'),
    waiting_until: z.string().optional().describe('Set or clear waiting until (pass empty string to clear).'),
  },
  async ({ id, heartbeat, waiting_reason, waiting_until }) => {
    try {
      const body = {};
      if (heartbeat === true) body.heartbeat_at = true;
      if (waiting_reason !== undefined) body.waiting_reason = waiting_reason;
      if (waiting_until !== undefined) body.waiting_until = waiting_until;
      const data = await api('PATCH', `/api/tasks/${encodeURIComponent(id)}/execution`, body);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── PID file ──────────────────────────────────────────────────────────
const MCP_PID_FILE = (() => {
  const sd = resolveAgentStateDir(AGENT_NAME);
  if (!sd) return null;
  const p = path.join(sd, 'mcp-server.pid');
  try { mkdirSync(sd, { recursive: true }); } catch { /* dir may already exist */ }
  try { writeFileSync(p, String(process.pid)); } catch { return null; }
  return p;
})();

function removePidFile() {
  if (!MCP_PID_FILE) return;
  try {
    const stored = readFileSync(MCP_PID_FILE, 'utf-8').trim();
    if (stored === String(process.pid)) unlinkSync(MCP_PID_FILE);
  } catch { /* already gone or unreadable */ }
}
process.on('exit', removePidFile);
process.on('SIGTERM', () => { stopMcpHeartbeat(); removePidFile(); process.exit(0); });
process.on('SIGINT', () => { stopMcpHeartbeat(); removePidFile(); process.exit(0); });

// ── Connect ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
