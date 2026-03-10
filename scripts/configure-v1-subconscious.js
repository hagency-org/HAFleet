#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { buildUpstreamClaudeSubconsciousPaths } from '../lib/upstream-claude-subconscious.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'subconscious', 'claude-agentchat');
const HOOK_MARKER = 'hook-entry.mjs';

function parseArgs(argv) {
  const out = {
    agentName: '',
    agentId: '',
    workdir: '',
    stateDir: '',
    enabled: 'true',
    eventUrl: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--agent-name' && argv[i + 1]) {
      out.agentName = argv[++i];
      continue;
    }
    if (token === '--agent-id' && argv[i + 1]) {
      out.agentId = argv[++i];
      continue;
    }
    if (token === '--workdir' && argv[i + 1]) {
      out.workdir = argv[++i];
      continue;
    }
    if (token === '--state-dir' && argv[i + 1]) {
      out.stateDir = argv[++i];
      continue;
    }
    if (token === '--enabled' && argv[i + 1]) {
      out.enabled = argv[++i];
      continue;
    }
    if (token === '--event-url' && argv[i + 1]) {
      out.eventUrl = argv[++i];
      continue;
    }
    if (token === '-h' || token === '--help') {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return out;
}

function usage() {
  console.log(`Usage: configure-v1-subconscious --agent-name <name> --agent-id <id> --workdir <path> --state-dir <path> [--enabled true|false] [--event-url <url>]`);
}

function normalizeText(value, maxLen = 4096) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeAbsPath(value, label) {
  const raw = normalizeText(value);
  if (!raw) throw new Error(`${label} is required`);
  return path.resolve(raw);
}

function parseBool(value, fallback = true) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultBackendBaseUrl() {
  const explicit = normalizeText(process.env.AGENT_CHAT_API, 2048);
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parsePositiveInt(process.env.AGENT_CHAT_BACKEND_PORT, 8090);
  return `http://127.0.0.1:${port}`;
}

function defaultSubconsciousEventUrl() {
  return `${defaultBackendBaseUrl()}/api/subconscious/events`;
}

function defaultSubconsciousInvokeUrl() {
  return `${defaultBackendBaseUrl()}/api/subconscious/runtime/invoke`;
}

function deriveInvokeUrl(eventUrl) {
  const raw = normalizeText(eventUrl, 2048);
  if (!raw) return null;
  return raw.replace(/\/api\/subconscious\/events\/?$/i, '/api/subconscious/runtime/invoke');
}

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(raw)) return raw;
  return 'deepseek';
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

function normalizeEndpoint(baseOrEndpoint, defaultEndpoint) {
  const raw = normalizeText(baseOrEndpoint, 2048);
  if (!raw) return defaultEndpoint;
  if (raw.endsWith('/chat/completions')) return raw;
  if (raw.endsWith('/')) return `${raw}chat/completions`;
  return `${raw}/chat/completions`;
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

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function shaHex(text) {
  return createHash('sha1').update(String(text || '')).digest('hex');
}

function deterministicLettaAgentId(seed) {
  const hex = shaHex(seed).slice(0, 32).padEnd(32, '0');
  return `agent-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildRuntimeDefaults(existing = {}) {
  const runtime = (existing.runtime && typeof existing.runtime === 'object') ? existing.runtime : {};
  const provider = normalizeProvider(runtime.provider || process.env.SUBCONSCIOUS_LLM_PROVIDER || 'deepseek');
  const timeoutMs = parsePositiveInt(runtime.timeoutMs || process.env.SUBCONSCIOUS_LLM_TIMEOUT_MS, 8000);
  const maxTokens = parsePositiveInt(runtime.maxTokens || process.env.SUBCONSCIOUS_LLM_MAX_TOKENS, 220);
  const temperatureRaw = Number.parseFloat(String(runtime.temperature ?? process.env.SUBCONSCIOUS_LLM_TEMPERATURE ?? '0.2').trim());
  const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : 0.2;
  return {
    enabled: runtime.enabled !== false,
    provider,
    model: normalizeText(runtime.model, 256)
      || normalizeText(process.env.SUBCONSCIOUS_LLM_MODEL, 256)
      || defaultModel(provider),
    endpoint: normalizeEndpoint(
      runtime.endpoint || process.env.SUBCONSCIOUS_LLM_ENDPOINT,
      defaultProviderEndpoint(provider)
    ),
    keyEnv: normalizeText(runtime.keyEnv, 128)
      || normalizeText(process.env.SUBCONSCIOUS_LLM_KEY_ENV, 128)
      || 'SUBCONSCIOUS_LLM_KEY',
    timeoutMs,
    maxTokens,
    temperature,
    allowedHooks: Array.isArray(runtime.allowedHooks) && runtime.allowedHooks.length
      ? runtime.allowedHooks
      : ['UserPromptSubmit', 'PreToolUse'],
  };
}

function ensureLettaState(lettaPath, { agentName, agentId, enabled }) {
  const existing = safeReadJson(lettaPath, {});
  const envLetta = normalizeText(process.env.LETTA_AGENT_ID, 256);
  const stateLetta = normalizeText(existing.agentId, 256) || normalizeText(existing.lettaAgentId, 256);

  let resolutionSource = 'generated';
  let resolvedAgentId = envLetta;
  if (resolvedAgentId) {
    resolutionSource = 'env';
  } else if (stateLetta) {
    resolvedAgentId = stateLetta;
    resolutionSource = 'state';
  } else {
    resolvedAgentId = deterministicLettaAgentId(`${agentId}:${agentName}`);
  }

  const now = new Date().toISOString();
  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    provider: normalizeText(existing.provider, 128) || 'letta',
    mode: normalizeText(existing.mode, 128) || 'claude-subconscious',
    enabled,
    agentName,
    agentId: resolvedAgentId,
    resolutionSource,
    guidance: normalizeText(existing.guidance, 6000) || '',
    runtime: buildRuntimeDefaults(existing),
    createdAt: normalizeText(existing.createdAt, 128) || now,
    updatedAt: now,
  };

  writeJson(lettaPath, next);
  return {
    lettaPath,
    lettaAgentId: resolvedAgentId,
    resolutionSource,
  };
}

function buildHookCommand(pluginRoot, hookName) {
  const nodeExec = process.execPath;
  const scriptPath = path.join(pluginRoot, 'scripts', 'hook-entry.mjs');
  return `\"${nodeExec}\" \"${scriptPath}\" ${hookName}`;
}

function buildManagedHooks(pluginRoot) {
  const mk = (hookName, timeout = 10) => ({
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: buildHookCommand(pluginRoot, hookName),
        timeout,
      },
    ],
  });

  return {
    SessionStart: [mk('SessionStart', 10)],
    UserPromptSubmit: [mk('UserPromptSubmit', 10)],
    PreToolUse: [mk('PreToolUse', 10)],
    Stop: [mk('Stop', 15)],
  };
}

function sameEntry(a, b) {
  const ax = JSON.stringify(a || {});
  const bx = JSON.stringify(b || {});
  return ax === bx;
}

function mergeHookEntries(existingList, managedList) {
  const out = Array.isArray(existingList) ? existingList.map((row) => ({ ...row })) : [];
  for (const row of managedList) {
    const hit = out.some((existing) => sameEntry(existing, row));
    if (!hit) out.push(row);
  }
  return out;
}

function stripManagedHookEntries(existingList) {
  if (!Array.isArray(existingList)) return [];
  return existingList.filter((entry) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    const commands = hooks
      .map((row) => (row && typeof row.command === 'string') ? row.command : '')
      .filter(Boolean)
      .join('\n');
    return !commands.includes(HOOK_MARKER);
  });
}

function configureClaudeSettings(settingsPath, managedHooks, enabled) {
  const existing = safeReadJson(settingsPath, {});
  const next = (existing && typeof existing === 'object') ? { ...existing } : {};
  const hooksRoot = (next.hooks && typeof next.hooks === 'object') ? { ...next.hooks } : {};

  const hookNames = Object.keys(managedHooks);
  if (enabled) {
    for (const hookName of hookNames) {
      hooksRoot[hookName] = mergeHookEntries(hooksRoot[hookName], managedHooks[hookName]);
    }
  } else {
    for (const hookName of hookNames) {
      const cleaned = stripManagedHookEntries(hooksRoot[hookName]);
      if (cleaned.length > 0) hooksRoot[hookName] = cleaned;
      else delete hooksRoot[hookName];
    }
  }

  if (Object.keys(hooksRoot).length > 0) next.hooks = hooksRoot;
  else delete next.hooks;

  writeJson(settingsPath, next);
  return settingsPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const agentName = normalizeText(args.agentName, 128);
  if (!agentName) throw new Error('invalid --agent-name');
  const agentId = normalizeText(args.agentId, 256) || `agent_${agentName.toLowerCase()}`;
  const workdir = normalizeAbsPath(args.workdir, '--workdir');
  const stateDir = normalizeAbsPath(args.stateDir, '--state-dir');
  const enabled = parseBool(args.enabled, true);
  const eventUrl = normalizeText(args.eventUrl, 2048)
    || normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_URL, 2048)
    || defaultSubconsciousEventUrl();
  const invokeUrl = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_INVOKE_URL, 2048)
    || deriveInvokeUrl(eventUrl)
    || defaultSubconsciousInvokeUrl();

  if (!existsSync(TEMPLATE_ROOT)) {
    throw new Error(`missing subconscious template root: ${TEMPLATE_ROOT}`);
  }

  const pluginRoot = path.join(stateDir, 'subconscious', 'claude-agentchat');
  const claudeDir = path.join(workdir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const lettaPath = path.join(stateDir, 'letta.json');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(path.dirname(pluginRoot), { recursive: true });

  cpSync(TEMPLATE_ROOT, pluginRoot, { recursive: true, force: true, dereference: false });

  const letta = ensureLettaState(lettaPath, { agentName, agentId, enabled });
  const managedHooks = buildManagedHooks(pluginRoot);
  configureClaudeSettings(settingsPath, managedHooks, enabled);
  const upstream = buildUpstreamClaudeSubconsciousPaths(stateDir);

  const runtimeMetaPath = path.join(stateDir, 'subconscious', 'runtime.json');
  const memoryStorePath = path.join(stateDir, 'subconscious', 'memory.json');
  const conversationStorePath = path.join(stateDir, 'subconscious', 'conversations.json');
  writeJson(memoryStorePath, safeReadJson(memoryStorePath, {
    schemaVersion: 1,
    kind: 'local-episodic-journal',
    retrievalStrategy: 'keyword-overlap-recency',
    agent: agentName,
    entryLimit: 80,
    retrievalLimit: 4,
    episodes: [],
    lastStoredAt: null,
    lastRetrievedAt: null,
    lastRetrievedQuery: null,
    lastRetrievedIds: [],
    updatedAt: new Date().toISOString(),
  }));
  writeJson(conversationStorePath, safeReadJson(conversationStorePath, {
    schemaVersion: 1,
    kind: 'claude-jsonl-session-journal',
    agent: agentName,
    sessionLimit: 24,
    currentSessionId: null,
    currentTranscriptPath: null,
    currentConversationUpdatedAt: null,
    lastSyncedAt: null,
    sessions: [],
    updatedAt: new Date().toISOString(),
  }));
  writeJson(runtimeMetaPath, {
    source: 'agentchat-v1',
    backendMode: 'runtime-contract',
    reasoningRuntime: 'llm-compatible',
    memoryStore: {
      kind: 'local-episodic-journal',
      path: memoryStorePath,
      retrievalStrategy: 'keyword-overlap-recency',
    },
    conversationStore: {
      kind: 'claude-jsonl-session-journal',
      path: conversationStorePath,
      syncSource: 'claude-jsonl-transcript',
    },
    guidanceMode: 'runtime-or-manual-fallback',
    upstream: {
      available: upstream.available,
      root: upstream.root,
      promptFile: upstream.promptFile,
      scripts: upstream.scripts,
      durableHome: upstream.durableHome,
      durableStateDir: upstream.durableStateDir,
      conversationsFile: upstream.conversationsFile,
      configPath: upstream.configPath,
      directReuse: [
        'Subconscious.af prompt source',
        'agent_config.ts Letta bootstrap/config',
        'conversation_utils.ts durable conversation bookkeeping',
        'sync_letta_memory.ts UserPromptSubmit prompt-send source',
        'pretool_sync.ts PreToolUse mid-workflow sync',
        'transcript_utils.ts transcript formatting/parser source',
      ],
      bootstrapStatus: 'not-run',
    },
    enabled,
    pluginRoot,
    settingsPath,
    lettaPath,
    lettaAgentId: letta.lettaAgentId,
    resolutionSource: letta.resolutionSource,
    eventUrl,
    invokeUrl,
    updatedAt: new Date().toISOString(),
  });

  console.log(JSON.stringify({
    ok: true,
    enabled,
    pluginRoot,
    settingsPath,
    runtimeMetaPath,
    lettaPath,
    lettaAgentId: letta.lettaAgentId,
    resolutionSource: letta.resolutionSource,
    upstream,
    eventUrl,
    invokeUrl,
    memoryStorePath,
    conversationStorePath,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
