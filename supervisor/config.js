import path from 'path';

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
      return 'qwen-plus';
    case 'openai':
      return 'gpt-4.1-mini';
    default:
      return 'deepseek-chat';
  }
}

export function loadSupervisorConfig(env = process.env) {
  const providerRaw = String(env.SUPERVISOR_LLM_PROVIDER || 'deepseek').trim().toLowerCase();
  const provider = ['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(providerRaw)
    ? providerRaw
    : 'deepseek';

  const keyEnv = String(env.SUPERVISOR_LLM_KEY_ENV || 'SUPERVISOR_LLM_KEY').trim() || 'SUPERVISOR_LLM_KEY';
  const apiKey = String(env[keyEnv] || '').trim();
  const endpoint = normalizeEndpoint(
    env.SUPERVISOR_LLM_ENDPOINT || env.SUPERVISOR_LLM_BASE_URL,
    defaultProviderEndpoint(provider)
  );
  const model = String(env.SUPERVISOR_LLM_MODEL || defaultModel(provider)).trim();

  const enabledBySwitch = parseBool(env.SUPERVISOR_ENABLED, true);
  const enabled = enabledBySwitch && !!apiKey;

  return {
    enabled,
    disabledReason: enabledBySwitch ? (!apiKey ? `missing API key env ${keyEnv}` : null) : 'SUPERVISOR_ENABLED=false',
    intervalMs: parseMs(env.SUPERVISOR_INTERVAL_MS || '30000', 30000),
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
    docsRootOverride: String(env.SUPERVISOR_DOCS_ROOT || '').trim() || null,
    metaRoot: path.resolve(env.SUPERVISOR_META_ROOT || 'data/agents'),
    serverSshPath: path.resolve(env.SUPERVISOR_SERVER_SSH_PATH || 'data/server-ssh.json'),
    promptPath: path.resolve(env.SUPERVISOR_PROMPT_PATH || 'supervisor/prompts/focus-check.txt'),
    logFile: path.resolve(env.SUPERVISOR_LOG_FILE || 'logs/supervisor.jsonl'),
    stateFile: path.resolve(env.SUPERVISOR_STATE_FILE || 'data/supervisor_state.json'),
    eventHistoryLimit: parseIntStrict(env.SUPERVISOR_EVENT_HISTORY_LIMIT || '5000', 5000, 100),
    llm: {
      provider,
      endpoint,
      model,
      apiKey,
      timeoutMs: parseMs(env.SUPERVISOR_LLM_TIMEOUT_MS || '12000', 12000),
      maxTokens: parseIntStrict(env.SUPERVISOR_LLM_MAX_TOKENS || '220', 220, 32),
      temperature: Number.isFinite(Number.parseFloat(env.SUPERVISOR_LLM_TEMPERATURE))
        ? Number.parseFloat(env.SUPERVISOR_LLM_TEMPERATURE)
        : 0.1,
    },
  };
}
