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

function buildStopBatchMessage(sessionId, messages) {
  const transcriptEntries = (Array.isArray(messages) ? messages : []).map((row) => {
    const role = row?.role === 'user' ? 'user' : (row?.role === 'assistant' ? 'claude_code' : 'system');
    const escaped = String(row?.text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return `<message role="${role}">\n${escaped}\n</message>`;
  }).join('\n');

  return `<claude_code_session_update>
<session_id>${sessionId}</session_id>

<transcript>
${transcriptEntries}
</transcript>

<instructions>
You may provide commentary or guidance for Claude Code. Your response will be added to Claude's context window on the next prompt. Use this to:
- Offer observations about the user's work
- Provide reminders or context from your memory
- Suggest approaches or flag potential issues
- Send async messages/guidance to Claude Code

Write your response as if speaking directly to Claude Code.
</instructions>
</claude_code_session_update>`;
}

function buildUserPromptMessage(sessionId, prompt) {
  const escapedPrompt = String(prompt || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<claude_code_user_prompt>
<session_id>${sessionId}</session_id>
<prompt>${escapedPrompt}</prompt>
<note>Early notification - Claude Code is processing this now. Full transcript with response will follow.</note>
</claude_code_user_prompt>`;
}

function escapeXmlContent(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function rowDateMs(row) {
  const value = typeof row?.date === 'string' ? Date.parse(row.date) : 0;
  return Number.isFinite(value) ? value : 0;
}

function normalizeApiBase(value) {
  return String(value || 'https://api.letta.com/v1').trim().replace(/\/$/, '');
}

async function fetchUpstreamAssistantMessages(apiKey, conversationUtils, conversationId, lastSeenMessageId) {
  if (!conversationId) {
    return { messages: [], lastMessageId: lastSeenMessageId || null };
  }
  const apiBase = normalizeApiBase(conversationUtils?.LETTA_API_BASE || `${process.env.LETTA_BASE_URL || 'https://api.letta.com'}/v1`);
  const url = `${apiBase}/conversations/${conversationId}/messages?limit=300`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    return { messages: [], lastMessageId: lastSeenMessageId || null };
  }
  const allMessages = await response.json().catch(() => []);
  const assistantMessages = (Array.isArray(allMessages) ? allMessages : [])
    .filter((row) => row?.message_type === 'assistant_message')
    .sort((a, b) => rowDateMs(b) - rowDateMs(a));
  let endIndex = assistantMessages.length;
  if (lastSeenMessageId) {
    const lastSeenIndex = assistantMessages.findIndex((row) => String(row?.id || '') === String(lastSeenMessageId));
    if (lastSeenIndex !== -1) endIndex = lastSeenIndex;
  }
  const messages = [];
  for (let i = 0; i < endIndex; i += 1) {
    const row = assistantMessages[i];
    const text = typeof row?.content === 'string' ? row.content : row?.text;
    if (!text || typeof text !== 'string') continue;
    messages.push({
      id: String(row.id || '').trim() || null,
      text,
      date: typeof row?.date === 'string' ? row.date : null,
    });
  }
  return {
    messages,
    lastMessageId: assistantMessages.length > 0
      ? (String(assistantMessages[0]?.id || '').trim() || lastSeenMessageId || null)
      : (lastSeenMessageId || null),
  };
}

function snapshotBlockValues(blocks) {
  const out = {};
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const label = String(block?.label || '').trim();
    if (!label) continue;
    out[label] = String(block?.value || '');
  }
  return out;
}

function detectChangedBlocks(currentBlocks, lastBlockValues) {
  if (!lastBlockValues || typeof lastBlockValues !== 'object') return [];
  return (Array.isArray(currentBlocks) ? currentBlocks : []).filter((block) => {
    const label = String(block?.label || '').trim();
    if (!label) return false;
    return !Object.prototype.hasOwnProperty.call(lastBlockValues, label)
      || lastBlockValues[label] !== String(block?.value || '');
  });
}

function formatUpstreamPreToolOutput(agentName, messages, changedBlocks, lastBlockValues) {
  const parts = [];
  for (const msg of (Array.isArray(messages) ? messages : [])) {
    const timestamp = msg?.date || 'unknown';
    parts.push(`<letta_message from="${escapeXmlContent(agentName)}" timestamp="${escapeXmlContent(timestamp)}">\n${escapeXmlContent(msg?.text || '')}\n</letta_message>`);
  }
  if (Array.isArray(changedBlocks) && changedBlocks.length > 0) {
    const blockParts = changedBlocks.map((block) => {
      const label = String(block?.label || '').trim();
      const value = String(block?.value || '');
      const previousValue = lastBlockValues && typeof lastBlockValues === 'object'
        ? String(lastBlockValues[label] || '')
        : null;
      if (previousValue === null || previousValue === '') {
        return `<${label} status="new">\n${escapeXmlContent(value)}\n</${label}>`;
      }
      const oldLines = new Set(previousValue.split('\n').map((line) => line.trim()).filter(Boolean));
      const newLines = value.split('\n').map((line) => line.trim()).filter(Boolean);
      const added = newLines.filter((line) => !oldLines.has(line));
      const removed = [...oldLines].filter((line) => !newLines.includes(line));
      if (added.length === 0 && removed.length === 0) {
        return `<${label} status="modified">\n${escapeXmlContent(value)}\n</${label}>`;
      }
      const diffLines = [];
      for (const line of removed) diffLines.push(`- ${escapeXmlContent(line)}`);
      for (const line of added) diffLines.push(`+ ${escapeXmlContent(line)}`);
      return `<${label} status="modified">\n${diffLines.join('\n')}\n</${label}>`;
    });
    parts.push(`<letta_memory_update>\n${blockParts.join('\n')}\n</letta_memory_update>`);
  }
  if (parts.length === 0) return null;
  let additionalContext = `<letta_update>\n${parts.join('\n\n')}\n</letta_update>`;
  if (Array.isArray(messages) && messages.length > 0) {
    additionalContext += `\n\n<instruction>Your Subconscious (${escapeXmlContent(agentName)}) just sent a message mid-workflow. Briefly acknowledge what ${escapeXmlContent(agentName)} said in your next response - just a short note like "Sub notes: [key point]" so the user knows.</instruction>`;
  }
  return additionalContext;
}

function blockSnapshotsEqual(expected, actual) {
  const a = expected && typeof expected === 'object' ? expected : {};
  const b = actual && typeof actual === 'object' ? actual : {};
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (String(a[aKeys[i]] || '') !== String(b[bKeys[i]] || '')) return false;
  }
  return true;
}

function countTranscriptLines(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  try {
    return readFileSync(transcriptPath, 'utf-8').split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function readConversationMapEntry(conversationsFile, sessionId) {
  if (!conversationsFile || !sessionId) return null;
  const map = safeReadJson(conversationsFile, {});
  const raw = map && typeof map === 'object' ? map[sessionId] : null;
  if (typeof raw === 'string') {
    return { conversationId: raw, agentId: null };
  }
  if (raw && typeof raw === 'object') {
    return {
      conversationId: String(raw.conversationId || '').trim() || null,
      agentId: String(raw.agentId || '').trim() || null,
    };
  }
  return null;
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
    const transcriptUtils = await import(withCacheBust(path.join(UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT, 'scripts', 'transcript_utils.ts')));
    return await fn({ agentConfig, conversationUtils, transcriptUtils });
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
    const requestedAgentId = String(lettaAgentId || '').trim();
    const agentId = requestedAgentId || await agentConfig.getAgentId(apiKey, pushLog);
    if (requestedAgentId) {
      pushLog(`Using bound agent ID for session start: ${requestedAgentId}`);
    }
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

export async function syncUpstreamClaudeSubconsciousStop({
  stateDir,
  workdir,
  apiKey,
  lettaBaseUrl,
  lettaAgentId,
  lettaModel,
  lettaContextWindow,
  sessionId,
  cwd,
  transcriptPath,
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
  const effectiveTranscriptPath = String(transcriptPath || '').trim();
  if (!stateDir || !effectiveWorkdir || !effectiveCwd) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing agent state/workdir for upstream stop lifecycle',
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
  if (!effectiveTranscriptPath) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing transcriptPath',
      paths,
      logs: [],
    };
  }
  if (!existsSync(effectiveTranscriptPath)) {
    return {
      ok: false,
      blocked: true,
      blocker: `transcript file not found: ${effectiveTranscriptPath}`,
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
  }, async ({ agentConfig, conversationUtils, transcriptUtils }) => {
    const requestedAgentId = String(lettaAgentId || '').trim();
    const agentId = requestedAgentId || await agentConfig.getAgentId(apiKey, pushLog);
    if (requestedAgentId) {
      pushLog(`Using bound agent ID for stop sync: ${requestedAgentId}`);
    }

    const transcriptMessages = await transcriptUtils.readTranscript(effectiveTranscriptPath, pushLog);
    const syncState = conversationUtils.loadSyncState(effectiveCwd, effectiveSessionId, pushLog);
    const lookupConversationId = typeof conversationUtils.lookupConversation === 'function'
      ? conversationUtils.lookupConversation(effectiveCwd, effectiveSessionId)
      : null;
    const syncStateFile = typeof conversationUtils.getSyncStateFile === 'function'
      ? conversationUtils.getSyncStateFile(effectiveCwd, effectiveSessionId)
      : (paths.durableStateDir ? path.join(paths.durableStateDir, `session-${effectiveSessionId}.json`) : null);
    const lastProcessedIndexBefore = Number.isFinite(syncState?.lastProcessedIndex)
      ? syncState.lastProcessedIndex
      : -1;
    const newMessages = transcriptUtils.formatMessagesForLetta(transcriptMessages, lastProcessedIndexBefore, pushLog);
    if (!newMessages.length) {
      return {
        agentId,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        transcriptPath: effectiveTranscriptPath,
        syncStateFile,
        syncState: safeReadJson(syncStateFile, {}),
        conversationId: syncState?.conversationId || lookupConversationId || null,
        transcriptMessageCount: transcriptMessages.length,
        newMessageCount: 0,
        lastProcessedIndexBefore,
        lastProcessedIndexAfter: lastProcessedIndexBefore,
        sendAttempted: false,
        messageSent: false,
        sendStatus: 'no-new-messages',
        blocker: null,
        lettaBaseUrl: (lettaBaseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com').trim(),
      };
    }

    const conversationId = await conversationUtils.getOrCreateConversation(
      apiKey,
      agentId,
      effectiveSessionId,
      effectiveCwd,
      syncState,
      pushLog,
    );
    conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);

    const response = await conversationUtils.sendMessageToConversation(
      apiKey,
      conversationId,
      'user',
      buildStopBatchMessage(effectiveSessionId, newMessages),
      pushLog,
    );
    let messageSent = false;
    let blocker = null;
    let sendStatus = 'attempted';
    if (response.status === 409) {
      blocker = 'upstream stop send deferred: 409 conversation busy';
      sendStatus = 'blocked';
      pushLog(blocker);
    } else if (!response.ok) {
      const errorText = await response.text();
      blocker = `upstream stop send failed: ${response.status} ${errorText}`.slice(0, 1200);
      sendStatus = 'blocked';
      pushLog(blocker);
    } else {
      await consumeResponseBody(response);
      messageSent = true;
      sendStatus = 'sent';
      syncState.lastProcessedIndex = transcriptMessages.length - 1;
      conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
    }

    return {
      agentId,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      transcriptPath: effectiveTranscriptPath,
      syncStateFile,
      syncState: safeReadJson(syncStateFile, {}),
      conversationId,
      transcriptMessageCount: transcriptMessages.length,
      newMessageCount: newMessages.length,
      lastProcessedIndexBefore,
      lastProcessedIndexAfter: Number.isFinite(syncState?.lastProcessedIndex)
        ? syncState.lastProcessedIndex
        : lastProcessedIndexBefore,
      sendAttempted: true,
      messageSent,
      sendStatus,
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

export async function syncUpstreamClaudeSubconsciousUserPrompt({
  stateDir,
  workdir,
  apiKey,
  lettaBaseUrl,
  lettaAgentId,
  lettaModel,
  lettaContextWindow,
  sessionId,
  cwd,
  prompt,
  transcriptPath,
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
  const effectivePrompt = String(prompt || '').trim();
  const effectiveTranscriptPath = String(transcriptPath || '').trim();
  if (!stateDir || !effectiveWorkdir || !effectiveCwd) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing agent state/workdir for upstream user prompt lifecycle',
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
  if (!effectivePrompt) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing prompt',
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
    const requestedAgentId = String(lettaAgentId || '').trim();
    const agentId = requestedAgentId || await agentConfig.getAgentId(apiKey, pushLog);
    if (requestedAgentId) {
      pushLog(`Using bound agent ID for user prompt sync: ${requestedAgentId}`);
    }
    const syncState = conversationUtils.loadSyncState(effectiveCwd, effectiveSessionId, pushLog) || {
      sessionId: effectiveSessionId,
      conversationId: null,
      lastProcessedIndex: -1,
      startedAt: new Date().toISOString(),
    };
    const syncStateFile = typeof conversationUtils.getSyncStateFile === 'function'
      ? conversationUtils.getSyncStateFile(effectiveCwd, effectiveSessionId)
      : (paths.durableStateDir ? path.join(paths.durableStateDir, `session-${effectiveSessionId}.json`) : null);
    const conversationId = await conversationUtils.getOrCreateConversation(
      apiKey,
      agentId,
      effectiveSessionId,
      effectiveCwd,
      syncState,
      pushLog,
    );
    conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
    const persistedBefore = safeReadJson(syncStateFile, {});
    const persistedConversationEntryBefore = readConversationMapEntry(paths.conversationsFile, effectiveSessionId);
    const durableConversationIdBefore = String(
      persistedBefore?.conversationId
      || persistedConversationEntryBefore?.conversationId
      || ''
    ).trim() || null;
    if (durableConversationIdBefore !== conversationId) {
      const blocker = `upstream user prompt durable conversation divergence before send: session file/map=${durableConversationIdBefore || '-'} runtime=${conversationId || '-'}`.slice(0, 1200);
      pushLog(blocker);
      return {
        agentId,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        promptPreview: effectivePrompt.slice(0, 320),
        transcriptPath: effectiveTranscriptPath || null,
        transcriptExists: Boolean(effectiveTranscriptPath && existsSync(effectiveTranscriptPath)),
        transcriptLineCount: countTranscriptLines(effectiveTranscriptPath),
        syncStateFile,
        syncState: persistedBefore,
        conversationId: durableConversationIdBefore,
        lastProcessedIndexBefore: Number.isFinite(persistedBefore?.lastProcessedIndex) ? persistedBefore.lastProcessedIndex : -1,
        lastProcessedIndexAfter: Number.isFinite(persistedBefore?.lastProcessedIndex) ? persistedBefore.lastProcessedIndex : -1,
        sendAttempted: false,
        messageSent: false,
        sendStatus: 'blocked',
        blocker,
        lettaBaseUrl: (lettaBaseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com').trim(),
      };
    }
    const transcriptLineCount = countTranscriptLines(effectiveTranscriptPath);
    const lastProcessedIndexBefore = Number.isFinite(syncState?.lastProcessedIndex)
      ? syncState.lastProcessedIndex
      : -1;

    const response = await conversationUtils.sendMessageToConversation(
      apiKey,
      conversationId,
      'user',
      buildUserPromptMessage(effectiveSessionId, effectivePrompt),
      pushLog,
    );
    let messageSent = false;
    let blocker = null;
    let sendStatus = 'attempted';
    if (response.status === 409) {
      blocker = 'upstream user prompt send deferred: 409 conversation busy';
      sendStatus = 'blocked';
      pushLog(blocker);
    } else if (!response.ok) {
      const errorText = await response.text();
      blocker = `upstream user prompt send failed: ${response.status} ${errorText}`.slice(0, 1200);
      sendStatus = 'blocked';
      pushLog(blocker);
    } else {
      await consumeResponseBody(response);
      messageSent = true;
      sendStatus = 'sent';
      syncState.lastProcessedIndex = transcriptLineCount > 0 ? (transcriptLineCount - 1) : 0;
      conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
    }
    try {
      const baselineState = safeReadJson(syncStateFile, syncState) || syncState;
      const baselineConversationId = String(
        baselineState?.conversationId
        || readConversationMapEntry(paths.conversationsFile, effectiveSessionId)?.conversationId
        || conversationId
        || ''
      ).trim() || null;
      if (baselineConversationId) {
        const [baselineAgent, baselineMessagesResult] = await Promise.all([
          conversationUtils.fetchAgent(apiKey, agentId),
          fetchUpstreamAssistantMessages(
            apiKey,
            conversationUtils,
            baselineConversationId,
            baselineState?.lastSeenMessageId || null,
          ),
        ]);
        baselineState.lastBlockValues = snapshotBlockValues(baselineAgent?.blocks);
        if (baselineMessagesResult.lastMessageId) {
          baselineState.lastSeenMessageId = baselineMessagesResult.lastMessageId;
        }
        conversationUtils.saveSyncState(effectiveCwd, baselineState, pushLog);
      }
    } catch (err) {
      pushLog(`user prompt baseline refresh warning: ${err?.message || String(err)}`);
    }
    const persistedAfter = safeReadJson(syncStateFile, {});
    const persistedConversationEntryAfter = readConversationMapEntry(paths.conversationsFile, effectiveSessionId);
    const durableConversationIdAfter = String(
      persistedAfter?.conversationId
      || persistedConversationEntryAfter?.conversationId
      || ''
    ).trim() || null;
    const durableLastProcessedIndexAfter = Number.isFinite(persistedAfter?.lastProcessedIndex)
      ? persistedAfter.lastProcessedIndex
      : lastProcessedIndexBefore;
    const expectedLastProcessedIndexAfter = messageSent
      ? (transcriptLineCount > 0 ? (transcriptLineCount - 1) : 0)
      : lastProcessedIndexBefore;
    if (messageSent && (
      durableConversationIdAfter !== conversationId
      || durableLastProcessedIndexAfter !== expectedLastProcessedIndexAfter
    )) {
      blocker = [
        'upstream user prompt durable state divergence after send',
        `conversation=${durableConversationIdAfter || '-'} expected=${conversationId || '-'}`,
        `lastProcessedIndex=${durableLastProcessedIndexAfter} expected=${expectedLastProcessedIndexAfter}`,
      ].join(': ').slice(0, 1200);
      sendStatus = 'blocked';
      pushLog(blocker);
    }

    return {
      agentId,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      promptPreview: effectivePrompt.slice(0, 320),
      transcriptPath: effectiveTranscriptPath || null,
      transcriptExists: Boolean(effectiveTranscriptPath && existsSync(effectiveTranscriptPath)),
      transcriptLineCount,
      syncStateFile,
      syncState: persistedAfter,
      conversationId: durableConversationIdAfter || conversationId,
      lastProcessedIndexBefore,
      lastProcessedIndexAfter: durableLastProcessedIndexAfter,
      sendAttempted: true,
      messageSent,
      sendStatus,
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

export async function syncUpstreamClaudeSubconsciousPreTool({
  stateDir,
  workdir,
  apiKey,
  lettaBaseUrl,
  lettaAgentId,
  lettaModel,
  lettaContextWindow,
  sessionId,
  cwd,
  toolName,
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
  const effectiveToolName = String(toolName || '').trim() || null;
  if (!stateDir || !effectiveWorkdir || !effectiveCwd) {
    return {
      ok: false,
      blocked: true,
      blocker: 'missing agent state/workdir for upstream pretool lifecycle',
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
    const requestedAgentId = String(lettaAgentId || '').trim();
    const agentId = requestedAgentId || await agentConfig.getAgentId(apiKey, pushLog);
    if (requestedAgentId) {
      pushLog(`Using bound agent ID for pretool sync: ${requestedAgentId}`);
    }
    const syncState = conversationUtils.loadSyncState(effectiveCwd, effectiveSessionId, pushLog) || {
      sessionId: effectiveSessionId,
      conversationId: null,
      lastProcessedIndex: -1,
    };
    const syncStateFile = typeof conversationUtils.getSyncStateFile === 'function'
      ? conversationUtils.getSyncStateFile(effectiveCwd, effectiveSessionId)
      : (paths.durableStateDir ? path.join(paths.durableStateDir, `session-${effectiveSessionId}.json`) : null);
    const persistedBefore = safeReadJson(syncStateFile, {});
    const persistedConversationEntryBefore = readConversationMapEntry(paths.conversationsFile, effectiveSessionId);
    const sessionConversationId = String(persistedBefore?.conversationId || syncState?.conversationId || '').trim() || null;
    const mappedConversationId = String(persistedConversationEntryBefore?.conversationId || '').trim() || null;
    if (sessionConversationId && mappedConversationId && sessionConversationId !== mappedConversationId) {
      const blocker = `upstream pretool durable conversation divergence before read: session file=${sessionConversationId} map=${mappedConversationId}`.slice(0, 1200);
      pushLog(blocker);
      return {
        agentId,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        toolName: effectiveToolName,
        syncStateFile,
        conversationId: sessionConversationId,
        sendAttempted: false,
        injected: false,
        sendStatus: 'blocked',
        blocker,
      };
    }
    const conversationId = sessionConversationId || mappedConversationId;
    if (!conversationId) {
      const blocker = 'missing durable conversationId for upstream pretool sync';
      pushLog(blocker);
      return {
        agentId,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        toolName: effectiveToolName,
        syncStateFile,
        conversationId: null,
        sendAttempted: false,
        injected: false,
        sendStatus: 'blocked',
        blocker,
      };
    }

    const lastSeenMessageIdBefore = String(persistedBefore?.lastSeenMessageId || syncState?.lastSeenMessageId || '').trim() || null;
    const lastBlockValuesBefore = (persistedBefore?.lastBlockValues && typeof persistedBefore.lastBlockValues === 'object')
      ? persistedBefore.lastBlockValues
      : ((syncState?.lastBlockValues && typeof syncState.lastBlockValues === 'object') ? syncState.lastBlockValues : null);
    const [agent, messagesResult] = await Promise.all([
      conversationUtils.fetchAgent(apiKey, agentId),
      fetchUpstreamAssistantMessages(apiKey, conversationUtils, conversationId, lastSeenMessageIdBefore),
    ]);
    const currentBlockValues = snapshotBlockValues(agent?.blocks);
    const changedBlocks = detectChangedBlocks(agent?.blocks, lastBlockValuesBefore);
    const newMessages = Array.isArray(messagesResult.messages) ? messagesResult.messages : [];
    const nextLastSeenMessageId = messagesResult.lastMessageId || lastSeenMessageIdBefore;

    if (!lastBlockValuesBefore && !lastSeenMessageIdBefore) {
      syncState.conversationId = conversationId;
      syncState.lastBlockValues = currentBlockValues;
      if (nextLastSeenMessageId) syncState.lastSeenMessageId = nextLastSeenMessageId;
      conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
      const persistedAfterSeed = safeReadJson(syncStateFile, {});
      if (
        !blockSnapshotsEqual(currentBlockValues, persistedAfterSeed?.lastBlockValues)
        || String(persistedAfterSeed?.lastSeenMessageId || '').trim() !== String(nextLastSeenMessageId || '').trim()
      ) {
        const blocker = 'upstream pretool durable baseline divergence after seed';
        pushLog(blocker);
        return {
          agentId,
          agentName: agent?.name || 'Subconscious',
          sessionId: effectiveSessionId,
          cwd: effectiveCwd,
          toolName: effectiveToolName,
          syncStateFile,
          conversationId,
          sendAttempted: true,
          injected: false,
          sendStatus: 'blocked',
          blocker,
          newMessageCount: newMessages.length,
          changedBlockCount: changedBlocks.length,
          lastSeenMessageIdBefore,
          lastSeenMessageIdAfter: String(persistedAfterSeed?.lastSeenMessageId || '').trim() || null,
          blockLabelCount: Object.keys(currentBlockValues).length,
        };
      }
      return {
        agentId,
        agentName: agent?.name || 'Subconscious',
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        toolName: effectiveToolName,
        syncStateFile,
        conversationId,
        sendAttempted: true,
        injected: false,
        sendStatus: 'seeded-baseline',
        blocker: null,
        newMessageCount: newMessages.length,
        changedBlockCount: changedBlocks.length,
        lastSeenMessageIdBefore,
        lastSeenMessageIdAfter: String(persistedAfterSeed?.lastSeenMessageId || '').trim() || null,
        blockLabelCount: Object.keys(currentBlockValues).length,
      };
    }

    if (newMessages.length === 0 && changedBlocks.length === 0) {
      return {
        agentId,
        agentName: agent?.name || 'Subconscious',
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        toolName: effectiveToolName,
        syncStateFile,
        conversationId,
        sendAttempted: true,
        injected: false,
        sendStatus: 'no-updates',
        blocker: null,
        newMessageCount: 0,
        changedBlockCount: 0,
        lastSeenMessageIdBefore,
        lastSeenMessageIdAfter: lastSeenMessageIdBefore,
        blockLabelCount: Object.keys(currentBlockValues).length,
      };
    }

    const additionalContext = formatUpstreamPreToolOutput(agent?.name || 'Subconscious', newMessages, changedBlocks, lastBlockValuesBefore);
    syncState.conversationId = conversationId;
    syncState.lastBlockValues = currentBlockValues;
    if (nextLastSeenMessageId) syncState.lastSeenMessageId = nextLastSeenMessageId;
    conversationUtils.saveSyncState(effectiveCwd, syncState, pushLog);
    const persistedAfter = safeReadJson(syncStateFile, {});
    const durableLastSeenMessageIdAfter = String(persistedAfter?.lastSeenMessageId || '').trim() || null;
    const durableBlockValuesAfter = persistedAfter?.lastBlockValues;
    if (
      !blockSnapshotsEqual(currentBlockValues, durableBlockValuesAfter)
      || String(durableLastSeenMessageIdAfter || '') !== String(nextLastSeenMessageId || '').trim()
    ) {
      const blocker = [
        'upstream pretool durable state divergence after save',
        `lastSeenMessageId=${durableLastSeenMessageIdAfter || '-'} expected=${nextLastSeenMessageId || '-'}`,
        `blockCount=${Object.keys(durableBlockValuesAfter || {}).length} expected=${Object.keys(currentBlockValues).length}`,
      ].join(': ').slice(0, 1200);
      pushLog(blocker);
      return {
        agentId,
        agentName: agent?.name || 'Subconscious',
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        toolName: effectiveToolName,
        syncStateFile,
        conversationId,
        sendAttempted: true,
        injected: false,
        sendStatus: 'blocked',
        blocker,
        newMessageCount: newMessages.length,
        changedBlockCount: changedBlocks.length,
        lastSeenMessageIdBefore,
        lastSeenMessageIdAfter: durableLastSeenMessageIdAfter,
        blockLabelCount: Object.keys(currentBlockValues).length,
      };
    }

    return {
      agentId,
      agentName: agent?.name || 'Subconscious',
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      toolName: effectiveToolName,
      syncStateFile,
      conversationId,
      sendAttempted: true,
      injected: Boolean(additionalContext),
      sendStatus: additionalContext ? 'injected' : 'no-updates',
      blocker: null,
      additionalContext,
      newMessageCount: newMessages.length,
      changedBlockCount: changedBlocks.length,
      lastSeenMessageIdBefore,
      lastSeenMessageIdAfter: durableLastSeenMessageIdAfter,
      blockLabelCount: Object.keys(currentBlockValues).length,
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
