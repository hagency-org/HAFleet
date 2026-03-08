import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT = (
  process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT
  || '/home/shisui/laplace/claude-subconscious'
).trim();

function safeReadJson(filePath, fallback = null) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function withCacheBust(filePath) {
  const href = pathToFileURL(filePath).href;
  const url = new URL(href);
  url.searchParams.set('ts', String(Date.now()));
  return url.href;
}

export function upstreamClaudeSubconsciousAvailable() {
  return Boolean(
    UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT
    && existsSync(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT)
    && existsSync(path.join(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT, 'Subconscious.af'))
    && existsSync(path.join(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT, 'scripts', 'agent_config.ts'))
  );
}

export function buildUpstreamClaudeSubconsciousPaths(stateDir) {
  const root = UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT || null;
  const durableHome = stateDir ? path.join(stateDir, 'subconscious', 'upstream-home') : null;
  const durableStateDir = durableHome ? path.join(durableHome, '.letta', 'claude') : null;
  const configDir = durableHome ? path.join(durableHome, '.letta', 'claude-subconscious') : null;
  return {
    available: upstreamClaudeSubconsciousAvailable(),
    root,
    promptFile: root ? path.join(root, 'Subconscious.af') : null,
    packageJson: root ? path.join(root, 'package.json') : null,
    scripts: {
      agentConfig: root ? path.join(root, 'scripts', 'agent_config.ts') : null,
      conversationUtils: root ? path.join(root, 'scripts', 'conversation_utils.ts') : null,
      transcriptUtils: root ? path.join(root, 'scripts', 'transcript_utils.ts') : null,
      sessionStart: root ? path.join(root, 'scripts', 'session_start.ts') : null,
      syncMemory: root ? path.join(root, 'scripts', 'sync_letta_memory.ts') : null,
      planCheckpoint: root ? path.join(root, 'scripts', 'plan_checkpoint.ts') : null,
      pretoolSync: root ? path.join(root, 'scripts', 'pretool_sync.ts') : null,
      stopSend: root ? path.join(root, 'scripts', 'send_messages_to_letta.ts') : null,
    },
    durableHome,
    durableStateDir,
    conversationsFile: durableStateDir ? path.join(durableStateDir, 'conversations.json') : null,
    configDir,
    configPath: configDir ? path.join(configDir, 'config.json') : null,
  };
}

export function readUpstreamClaudeSubconsciousState(stateDir) {
  const paths = buildUpstreamClaudeSubconsciousPaths(stateDir);
  return {
    paths,
    config: safeReadJson(paths.configPath, {}),
    conversations: safeReadJson(paths.conversationsFile, {}),
  };
}

function buildSessionStartMessage(sessionId, cwd) {
  const projectName = path.basename(String(cwd || '').trim() || '.');
  const timestamp = new Date().toISOString();
  return `<claude_code_session_start>
<project>${projectName}</project>
<path>${cwd}</path>
<session_id>${sessionId}</session_id>
<timestamp>${timestamp}</timestamp>

<context>
A new Claude Code session has begun. I'll be sending you updates as the session progresses.
You may update your memory blocks with any relevant context for this project.
</context>
</claude_code_session_start>`;
}

async function consumeResponseBody(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) return;
  try {
    await reader.read();
  } finally {
    try {
      reader.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
  }
}

async function runWithUpstreamEnv(envOverrides, fn) {
  const keys = [
    'HOME',
    'LETTA_HOME',
    'LETTA_PROJECT',
    'LETTA_BASE_URL',
    'LETTA_API_KEY',
    'LETTA_AGENT_ID',
    'LETTA_MODEL',
    'LETTA_CONTEXT_WINDOW',
  ];
  const previous = new Map();
  for (const key of keys) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
  }
  try {
    for (const [key, value] of Object.entries(envOverrides || {})) {
      if (value === undefined || value === null || value === '') delete process.env[key];
      else process.env[key] = String(value);
    }
    const agentConfig = await import(withCacheBust(path.join(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT, 'scripts', 'agent_config.ts')));
    const conversationUtils = await import(withCacheBust(path.join(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT, 'scripts', 'conversation_utils.ts')));
    return await fn({ agentConfig, conversationUtils });
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function bootstrapUpstreamClaudeSubconsciousAgent({
  stateDir,
  workdir,
  apiKey,
  lettaBaseUrl,
  lettaAgentId,
  lettaModel,
  lettaContextWindow,
  log = () => {},
}) {
  const paths = buildUpstreamClaudeSubconsciousPaths(stateDir);
  if (!paths.available) {
    return {
      ok: false,
      blocked: true,
      blocker: `missing upstream claude-subconscious root at ${UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT}`,
      paths,
      logs: [],
    };
  }
  if (!stateDir || !workdir) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing agent state/workdir for upstream claude-subconscious bootstrap',
      paths,
      logs: [],
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing LETTA_API_KEY',
      paths,
      logs: [],
    };
  }

  mkdirSync(paths.durableHome, { recursive: true });
  const logs = [];
  const pushLog = (message) => {
    const text = String(message || '').trim();
    if (!text) return;
    logs.push(text);
    log(text);
  };

  const result = await runWithUpstreamEnv({
    HOME: paths.durableHome,
    LETTA_HOME: paths.durableHome,
    LETTA_PROJECT: workdir,
    LETTA_BASE_URL: lettaBaseUrl || process.env.LETTA_BASE_URL || '',
    LETTA_API_KEY: apiKey,
    LETTA_AGENT_ID: lettaAgentId || '',
    LETTA_MODEL: lettaModel || process.env.LETTA_MODEL || '',
    LETTA_CONTEXT_WINDOW: lettaContextWindow || process.env.LETTA_CONTEXT_WINDOW || '',
  }, async ({ agentConfig, conversationUtils }) => {
    const agentId = await agentConfig.getAgentId(apiKey, pushLog);
    const config = safeReadJson(paths.configPath, {});
    let agent = null;
    try {
      agent = await conversationUtils.fetchAgent(apiKey, agentId);
    } catch (err) {
      pushLog(`fetchAgent warning: ${err?.message || String(err)}`);
    }
    return {
      agentId,
      configPath: paths.configPath,
      config,
      agent,
      lettaBaseUrl: (lettaBaseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com').trim(),
    };
  });

  return {
    ok: true,
    blocked: false,
    blocker: null,
    paths,
    logs,
    ...result,
  };
}

export async function startUpstreamClaudeSubconsciousSession({
  stateDir,
  workdir,
  apiKey,
  lettaBaseUrl,
  lettaAgentId,
  lettaModel,
  lettaContextWindow,
  sessionId,
  cwd,
  sendSessionStartMessage = true,
  log = () => {},
}) {
  const paths = buildUpstreamClaudeSubconsciousPaths(stateDir);
  if (!paths.available) {
    return {
      ok: false,
      blocked: true,
      blocker: `missing upstream claude-subconscious root at ${UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT}`,
      paths,
      logs: [],
    };
  }
  const effectiveWorkdir = String(workdir || '').trim();
  const effectiveCwd = String(cwd || workdir || '').trim();
  const effectiveSessionId = String(sessionId || '').trim();
  if (!stateDir || !effectiveWorkdir || !effectiveCwd) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing agent state/workdir for upstream session lifecycle',
      paths,
      logs: [],
    };
  }
  if (!effectiveSessionId) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing sessionId',
      paths,
      logs: [],
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing LETTA_API_KEY',
      paths,
      logs: [],
    };
  }

  mkdirSync(paths.durableHome, { recursive: true });
  const logs = [];
  const pushLog = (message) => {
    const text = String(message || '').trim();
    if (!text) return;
    logs.push(text);
    log(text);
  };

  const result = await runWithUpstreamEnv({
    HOME: paths.durableHome,
    LETTA_HOME: paths.durableHome,
    LETTA_PROJECT: effectiveWorkdir,
    LETTA_BASE_URL: lettaBaseUrl || process.env.LETTA_BASE_URL || '',
    LETTA_API_KEY: apiKey,
    LETTA_AGENT_ID: lettaAgentId || '',
    LETTA_MODEL: lettaModel || process.env.LETTA_MODEL || '',
    LETTA_CONTEXT_WINDOW: lettaContextWindow || process.env.LETTA_CONTEXT_WINDOW || '',
  }, async ({ agentConfig, conversationUtils }) => {
    const agentId = await agentConfig.getAgentId(apiKey, pushLog);
    const syncState = conversationUtils.loadSyncState(effectiveCwd, effectiveSessionId, pushLog);
    const priorConversationId = syncState?.conversationId
      || (typeof conversationUtils.lookupConversation === 'function'
        ? conversationUtils.lookupConversation(effectiveCwd, effectiveSessionId)
        : null);
    const conversationId = await conversationUtils.getOrCreateConversation(
      apiKey,
      agentId,
      effectiveSessionId,
      effectiveCwd,
      syncState,
      pushLog,
    );
    conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
    let agent = null;
    try {
      agent = await conversationUtils.fetchAgent(apiKey, agentId);
    } catch (err) {
      pushLog(`fetchAgent warning: ${err?.message || String(err)}`);
    }
    const sessionStateFile = paths.durableStateDir
      ? path.join(paths.durableStateDir, `session-${effectiveSessionId}.json`)
      : null;
    const sessionState = safeReadJson(sessionStateFile, {});
    const conversationMap = safeReadJson(paths.conversationsFile, {});
    const conversationCreated = !priorConversationId || priorConversationId !== conversationId;
    let messageSent = false;
    let blocker = null;
    if (sendSessionStartMessage) {
      try {
        const response = await conversationUtils.sendMessageToConversation(
          apiKey,
          conversationId,
          'user',
          buildSessionStartMessage(effectiveSessionId, effectiveCwd),
          pushLog,
        );
        if (!response.ok) {
          const errorText = await response.text();
          blocker = `upstream session start message failed: ${response.status} ${errorText}`.slice(0, 1200);
          pushLog(blocker);
        } else {
          await consumeResponseBody(response);
          messageSent = true;
        }
      } catch (err) {
        blocker = `upstream session start message failed: ${err?.message || String(err)}`.slice(0, 1200);
        pushLog(blocker);
      }
    }
    return {
      agentId,
      agent,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      conversationId,
      conversationStatus: conversationCreated ? 'created' : 'reused',
      sessionStateFile,
      sessionState,
      conversationMap,
      conversationCount: Object.keys(conversationMap).length,
      messageSent,
      blocker,
      lettaBaseUrl: (lettaBaseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com').trim(),
    };
  });

  return {
    ok: !result.blocker,
    blocked: Boolean(result.blocker),
    blocker: result.blocker || null,
    paths,
    logs,
    ...result,
  };
}
