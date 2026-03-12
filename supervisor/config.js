import path from 'path';
import { fileURLToPath } from 'url';
import { assertRuntimeDir } from '../lib/runtime-dir-guard.js';

const __filename = fileURLToPath(import.meta.url);
const SUPERVISOR_DIR = path.dirname(__filename);
const REPO_ROOT = path.resolve(SUPERVISOR_DIR, '..');

function resolveRuntimeRoot(env) {
  const raw = String(env?.AGENT_CHAT_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
}

function parseMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseIntStrict(value, fallback, min = 1) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const txt = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(txt)) return true;
  if (['0', 'false', 'no', 'off'].includes(txt)) return false;
  return fallback;
}

function parseAgentAllowlist(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const out = [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? out : null;
}

function normalizeEndpoint(baseOrEndpoint, defaultEndpoint) {
  const raw = String(baseOrEndpoint || '').trim();
  if (!raw) return defaultEndpoint;
  if (raw.endsWith('/chat/completions')) return raw;
  if (raw.endsWith('/')) return `${raw}chat/completions`;
  return `${raw}/chat/completions`;
}

function defaultProviderEndpoint(provider) {
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

function defaultModel(provider) {
  switch (provider) {
    case 'deepseek':
      return 'deepseek-chat';
    case 'qwen':
      return 'qwen3.5-plus';
    case 'openai':
      return 'gpt-4.1-mini';
    default:
      return 'deepseek-chat';
  }
}

function parseRuntimeProfileJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function loadSupervisorConfig(env = process.env) {
  const runtimeRoot = resolveRuntimeRoot(env);
  assertRuntimeDir(runtimeRoot);
  const supervisorProfile = parseRuntimeProfileJson(env.AGENTCHAT_RUNTIME_PROFILE_SUPERVISOR_JSON);
  const primaryProfile = parseRuntimeProfileJson(env.AGENTCHAT_RUNTIME_PROFILE_PRIMARY_JSON);
  const profile = supervisorProfile || primaryProfile || null;
  const profileProvider = String(profile?.provider || '').trim().toLowerCase();
  const providerRaw = String(env.SUPERVISOR_LLM_PROVIDER || 'deepseek').trim().toLowerCase();
  const provider = ['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(profileProvider)
    ? profileProvider
    : (['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(providerRaw)
      ? providerRaw
      : 'deepseek');

  const keyEnv = String(env.SUPERVISOR_LLM_KEY_ENV || 'SUPERVISOR_LLM_KEY').trim() || 'SUPERVISOR_LLM_KEY';
  const apiKey = String(env[keyEnv] || '').trim();
  const endpoint = normalizeEndpoint(
    env.SUPERVISOR_LLM_ENDPOINT || env.SUPERVISOR_LLM_BASE_URL,
    defaultProviderEndpoint(provider)
  );
  const model = String(profile?.model || env.SUPERVISOR_LLM_MODEL || defaultModel(provider)).trim();
  const profileSource = supervisorProfile
    ? 'runtimeProfile.supervisor'
    : (primaryProfile ? 'runtimeProfile.primary-fallback' : 'env/default');

  const enabledBySwitch = parseBool(env.SUPERVISOR_ENABLED, false);
  const enabled = enabledBySwitch;
  const heartbeatTtlMs = parseMs(env.SUPERVISOR_HEARTBEAT_TTL_MS || '120000', 120000);
  const trailingHeartbeatPeriods = parseIntStrict(env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS || '5', 5, 1);

  return {
    repoRoot: REPO_ROOT,
    runtimeRoot,
    enabled,
    disabledReason: enabledBySwitch ? null : 'SUPERVISOR_ENABLED=false',
    intervalMs: parseMs(env.SUPERVISOR_INTERVAL_MS || '30000', 30000),
    heartbeatTtlMs,
    trailingHeartbeatPeriods,
    trailingWindowMs: heartbeatTtlMs * trailingHeartbeatPeriods,
    paneLines: parseIntStrict(env.SUPERVISOR_PANE_LINES || '120', 120, 20),
    maxAgentsPerSweep: parseIntStrict(env.SUPERVISOR_MAX_AGENTS_PER_SWEEP || '12', 12, 1),
    activeOnly: parseBool(env.SUPERVISOR_ACTIVE_ONLY, true),
    skipBlocked: parseBool(env.SUPERVISOR_SKIP_BLOCKED, true),
    warnAfter: parseIntStrict(env.SUPERVISOR_WARN_AFTER || '3', 3, 1),
    warnCooldownMs: parseMs(env.SUPERVISOR_WARN_COOLDOWN_MS || '600000', 600000),
    matrixInfoGroup: String(env.SUPERVISOR_MATRIX_GROUP || 'info').trim() || 'info',
    matrixMentions: String(env.SUPERVISOR_MATRIX_MENTIONS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    agentAllowlist: parseAgentAllowlist(env.SUPERVISOR_AGENT_ALLOWLIST),
    docsRootOverride: String(env.SUPERVISOR_DOCS_ROOT || '').trim() || null,
    metaRoot: path.resolve(env.SUPERVISOR_META_ROOT || path.join(runtimeRoot, 'data', 'agents')),
    serverSshPath: path.resolve(env.SUPERVISOR_SERVER_SSH_PATH || path.join(runtimeRoot, 'data', 'server-ssh.json')),
    promptPath: path.resolve(env.SUPERVISOR_PROMPT_PATH || path.join(REPO_ROOT, 'supervisor', 'prompts', 'focus-check.txt')),
    logFile: path.resolve(env.SUPERVISOR_LOG_FILE || path.join(runtimeRoot, 'logs', 'supervisor.jsonl')),
    stateFile: path.resolve(env.SUPERVISOR_STATE_FILE || path.join(runtimeRoot, 'data', 'supervisor_state.json')),
    eventHistoryLimit: parseIntStrict(env.SUPERVISOR_EVENT_HISTORY_LIMIT || '5000', 5000, 100),
    llm: {
      provider,
      endpoint,
      keyEnv,
      model,
      profileSource,
      apiKey,
      timeoutMs: parseMs(env.SUPERVISOR_LLM_TIMEOUT_MS || '12000', 12000),
      maxTokens: parseIntStrict(env.SUPERVISOR_LLM_MAX_TOKENS || '220', 220, 32),
      temperature: Number.isFinite(Number.parseFloat(env.SUPERVISOR_LLM_TEMPERATURE))
        ? Number.parseFloat(env.SUPERVISOR_LLM_TEMPERATURE)
        : 0.1,
    },
  };
}
