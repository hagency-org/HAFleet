#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const HOOK_NAME = String(process.argv[2] || 'Unknown').trim() || 'Unknown';
const AGENTCHAT_SOURCE = 'claude-subconscious-v1';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maxLen = 4096) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizePath(value) {
  const text = normalizeText(value, 4096);
  if (!text) return null;
  return path.resolve(text);
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function hashHex(input) {
  return createHash('sha1').update(String(input || '')).digest('hex');
}

function deterministicLettaAgentId(seed) {
  const hex = hashHex(seed || 'agentchat-subconscious').slice(0, 32).padEnd(32, '0');
  return `agent-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function appendLog(line) {
  const stateDir = normalizePath(process.env.AGENTCHAT_AGENT_STATE_DIR);
  if (!stateDir) return;
  const logPath = path.join(stateDir, 'subconscious', 'hook.log');
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `[${nowIso()}] ${line}\n`);
  } catch {
    // Best effort only.
  }
}

function escapeXml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function readHookInput() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ _raw: raw.slice(0, 4096) });
      }
    });
    process.stdin.on('error', () => resolve({}));
    setTimeout(() => {
      if (!raw) resolve({});
    }, 250);
  });
}

function resolveAgentName(input) {
  return (
    normalizeText(process.env.AGENT_NAME, 128)
    || normalizeText(process.env.AGENTCHAT_AGENT_ID, 128)
    || normalizeText(input?.agent, 128)
    || 'unknown-agent'
  );
}

function resolveLettaState(agentName) {
  const stateDir = normalizePath(process.env.AGENTCHAT_AGENT_STATE_DIR);
  const resolvedPath = normalizePath(process.env.AGENTCHAT_LETTA_STATE_FILE)
    || (stateDir ? path.join(stateDir, 'letta.json') : null);

  if (!resolvedPath) {
    return {
      stateFile: null,
      lettaAgentId: deterministicLettaAgentId(agentName),
      source: 'generated',
      guidance: null,
      enabled: process.env.AGENTCHAT_SUBCONSCIOUS_ENABLED !== '0',
    };
  }

  const existing = safeReadJson(resolvedPath, {});
  const envLettaId = normalizeText(process.env.LETTA_AGENT_ID, 256);
  const existingLettaId = normalizeText(existing.agentId, 256) || normalizeText(existing.lettaAgentId, 256);

  let source = 'generated';
  let lettaAgentId = envLettaId;
  if (lettaAgentId) {
    source = 'env';
  } else if (existingLettaId) {
    lettaAgentId = existingLettaId;
    source = 'state';
  } else {
    const stableSeed = `${normalizeText(process.env.AGENTCHAT_AGENT_ID, 256) || agentName}:${agentName}`;
    lettaAgentId = deterministicLettaAgentId(stableSeed);
  }

  const enabled = process.env.AGENTCHAT_SUBCONSCIOUS_ENABLED !== '0';
  const guidance = normalizeText(existing.guidance, 6000);
  const runtime = (existing.runtime && typeof existing.runtime === 'object') ? existing.runtime : {};
  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    provider: normalizeText(existing.provider, 128) || 'letta',
    mode: normalizeText(existing.mode, 128) || 'claude-subconscious',
    enabled,
    agentName,
    agentId: lettaAgentId,
    resolutionSource: source,
    guidance: guidance || '',
    runtime,
    createdAt: normalizeText(existing.createdAt, 128) || nowIso(),
    updatedAt: nowIso(),
  };

  safeWriteJson(resolvedPath, next);

  return {
    stateFile: resolvedPath,
    lettaAgentId,
    source,
    guidance,
    guidanceSource: guidance ? 'manual-state-file' : 'none',
    runtime,
    backendMode: runtime.enabled === true ? 'runtime-configured' : 'scaffold',
    enabled,
  };
}

function makeSummary(hookName, input) {
  const toolName = normalizeText(input?.tool_name, 120);
  if (hookName === 'SessionStart') return 'Subconscious hook session start';
  if (hookName === 'UserPromptSubmit') return 'Subconscious hook user prompt';
  if (hookName === 'Stop') return 'Subconscious hook stop';
  if (hookName === 'PreToolUse') {
    return toolName ? `Subconscious hook pre-tool: ${toolName}` : 'Subconscious hook pre-tool';
  }
  return `Subconscious hook ${hookName}`;
}

async function postSubconsciousEvent(payload) {
  const url = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_URL, 2048);
  if (!url) return;

  const headers = { 'Content-Type': 'application/json' };
  const token = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      appendLog(`event-post-failed status=${resp.status}`);
    }
  } catch (err) {
    appendLog(`event-post-error ${String(err?.message || err)}`);
  }
}

function resolveInvokeUrl() {
  return normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_INVOKE_URL, 2048);
}

function resolveStopUrl() {
  const explicit = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_STOP_URL, 2048);
  if (explicit) return explicit;
  const eventUrl = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_URL, 2048);
  if (!eventUrl) return null;
  return eventUrl.replace(/\/api\/subconscious\/events\/?$/i, '/api/subconscious/upstream/stop');
}

function resolveUserPromptUrl() {
  const explicit = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_USER_PROMPT_URL, 2048);
  if (explicit) return explicit;
  const eventUrl = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_URL, 2048);
  if (!eventUrl) return null;
  return eventUrl.replace(/\/api\/subconscious\/events\/?$/i, '/api/subconscious/upstream/user-prompt');
}

async function invokeRuntimeGuidance(agentName, input) {
  const url = resolveInvokeUrl();
  if (!url) return { invoked: false, guidance: null, source: 'none' };

  const headers = { 'Content-Type': 'application/json' };
  const token = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = {
    hook: HOOK_NAME,
    hookEventName: normalizeText(input?.hook_event_name, 120) || HOOK_NAME,
    sessionId: normalizeText(input?.session_id, 200),
    transcriptPath: normalizeText(input?.transcript_path, 4096),
    toolName: normalizeText(input?.tool_name, 120),
    promptPreview: normalizeText(input?.prompt, 320),
    summary: makeSummary(HOOK_NAME, input),
  };

  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload || payload.ok !== true) {
      appendLog(`runtime-invoke-failed status=${resp.status} error=${String(payload?.error || payload?.detail || 'unknown').slice(0, 200)}`);
      return { invoked: false, guidance: null, source: 'none', error: payload?.error || payload?.detail || `http-${resp.status}` };
    }
    return {
      invoked: payload.invoked === true,
      guidance: normalizeText(payload.guidance, 2000),
      source: normalizeText(payload.guidanceSource, 64) || 'none',
      provider: normalizeText(payload.provider, 64),
      model: normalizeText(payload.model, 128),
      latencyMs: Number(payload.latencyMs) || null,
      disabledReason: normalizeText(payload.disabledReason, 256),
      error: normalizeText(payload.error, 256),
    };
  } catch (err) {
    appendLog(`runtime-invoke-error ${String(err?.message || err)}`);
    return { invoked: false, guidance: null, source: 'none', error: String(err?.message || err) };
  }
}

async function invokeUpstreamStop(agentName, input) {
  if (HOOK_NAME !== 'Stop') {
    return { attempted: false, status: 'not-run', messageSent: false, blockedReason: null };
  }
  const url = resolveStopUrl();
  const sessionId = normalizeText(input?.session_id, 200);
  const transcriptPath = normalizeText(input?.transcript_path, 4096);
  const cwd = normalizeText(input?.cwd, 4096);
  if (!url || !sessionId || !transcriptPath) {
    return {
      attempted: false,
      status: 'blocked',
      messageSent: false,
      blockedReason: !url
        ? 'missing upstream stop url'
        : (!sessionId ? 'missing session_id' : 'missing transcript_path'),
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        transcriptPath,
        cwd,
      }),
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload) {
      return {
        attempted: true,
        status: 'blocked',
        messageSent: false,
        blockedReason: String(payload?.error || payload?.blocker || `http-${resp.status}`).slice(0, 400),
      };
    }
    return {
      attempted: payload?.stop?.attempted === true,
      status: normalizeText(payload?.stop?.status, 64) || (payload?.blocked === true ? 'blocked' : 'not-run'),
      messageSent: payload?.stop?.messageSent === true,
      blockedReason: normalizeText(payload?.stop?.blockedReason, 400) || normalizeText(payload?.blocker, 400),
      conversationId: normalizeText(payload?.stop?.conversationId, 256),
      transcriptPath: normalizeText(payload?.stop?.transcriptPath, 4096),
      syncStateFile: normalizeText(payload?.stop?.syncStateFile, 4096),
      scriptPath: normalizeText(payload?.stop?.scriptPath, 4096),
      transcriptMessageCount: Number(payload?.stop?.transcriptMessageCount) || 0,
      newMessageCount: Number(payload?.stop?.newMessageCount) || 0,
    };
  } catch (err) {
    return {
      attempted: true,
      status: 'blocked',
      messageSent: false,
      blockedReason: String(err?.message || err).slice(0, 400),
    };
  }
}

async function invokeUpstreamUserPrompt(agentName, input) {
  if (HOOK_NAME !== 'UserPromptSubmit') {
    return { attempted: false, status: 'not-run', messageSent: false, blockedReason: null };
  }
  const url = resolveUserPromptUrl();
  const sessionId = normalizeText(input?.session_id, 200);
  const prompt = normalizeText(input?.prompt, 8000);
  const transcriptPath = normalizeText(input?.transcript_path, 4096);
  const cwd = normalizeText(input?.cwd, 4096);
  if (!url || !sessionId || !prompt) {
    return {
      attempted: false,
      status: 'blocked',
      messageSent: false,
      blockedReason: !url
        ? 'missing upstream user prompt url'
        : (!sessionId ? 'missing session_id' : 'missing prompt'),
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = normalizeText(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        prompt,
        transcriptPath,
        cwd,
      }),
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload) {
      return {
        attempted: true,
        status: 'blocked',
        messageSent: false,
        blockedReason: String(payload?.error || payload?.blocker || `http-${resp.status}`).slice(0, 400),
      };
    }
    return {
      attempted: payload?.userPrompt?.attempted === true,
      status: normalizeText(payload?.userPrompt?.status, 64) || (payload?.blocked === true ? 'blocked' : 'not-run'),
      messageSent: payload?.userPrompt?.messageSent === true,
      blockedReason: normalizeText(payload?.userPrompt?.blockedReason, 400) || normalizeText(payload?.blocker, 400),
      conversationId: normalizeText(payload?.userPrompt?.conversationId, 256),
      transcriptPath: normalizeText(payload?.userPrompt?.transcriptPath, 4096),
      syncStateFile: normalizeText(payload?.userPrompt?.syncStateFile, 4096),
      scriptPath: normalizeText(payload?.userPrompt?.scriptPath, 4096),
      transcriptLineCount: Number(payload?.userPrompt?.transcriptLineCount) || 0,
      lastProcessedIndexBefore: Number.isFinite(Number(payload?.userPrompt?.lastProcessedIndexBefore))
        ? Number(payload.userPrompt.lastProcessedIndexBefore)
        : null,
      lastProcessedIndexAfter: Number.isFinite(Number(payload?.userPrompt?.lastProcessedIndexAfter))
        ? Number(payload.userPrompt.lastProcessedIndexAfter)
        : null,
    };
  } catch (err) {
    return {
      attempted: true,
      status: 'blocked',
      messageSent: false,
      blockedReason: String(err?.message || err).slice(0, 400),
    };
  }
}

function emitAdditionalContext(hookName, agentName, guidance) {
  const clean = normalizeText(guidance, 2000);
  if (!clean) return;
  if (hookName !== 'UserPromptSubmit' && hookName !== 'PreToolUse') return;

  const context = `<agentchat_subconscious agent="${escapeXml(agentName)}">${escapeXml(clean)}</agentchat_subconscious>`;
  const payload = {
    hookSpecificOutput: {
      hookEventName: hookName,
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

async function main() {
  const input = await readHookInput();
  const agentName = resolveAgentName(input);
  const state = resolveLettaState(agentName);
  const upstreamUserPromptResult = await invokeUpstreamUserPrompt(agentName, input);
  const runtimeResult = await invokeRuntimeGuidance(agentName, input);
  const upstreamStopResult = await invokeUpstreamStop(agentName, input);
  const effectiveGuidance = runtimeResult.guidance || state.guidance || null;
  const manualGuidanceConfigured = Boolean(state.guidance);
  const guidanceInjected = Boolean(effectiveGuidance) && (HOOK_NAME === 'UserPromptSubmit' || HOOK_NAME === 'PreToolUse');

  const promptPreview = normalizeText(input?.prompt, 320);
  const event = {
    ts: Date.now(),
    source: AGENTCHAT_SOURCE,
    agent: agentName,
    hook: HOOK_NAME,
    hookEventName: normalizeText(input?.hook_event_name, 120) || HOOK_NAME,
    sessionId: normalizeText(input?.session_id, 200),
    transcriptPath: normalizeText(input?.transcript_path, 4096),
    toolName: normalizeText(input?.tool_name, 120),
    promptPreview,
    summary: makeSummary(HOOK_NAME, input),
    lettaAgentId: state.lettaAgentId,
    lettaStateFile: state.stateFile,
    resolutionSource: state.source,
    backendMode: runtimeResult.invoked === true ? 'runtime-llm' : state.backendMode,
    subconsciousEnabled: state.enabled,
    guidancePresent: Boolean(effectiveGuidance),
    guidanceConfigured: manualGuidanceConfigured,
    guidanceInjected,
    guidanceSource: runtimeResult.guidance ? 'runtime-llm' : state.guidanceSource,
    guidancePreview: effectiveGuidance ? effectiveGuidance.slice(0, 320) : null,
    runtimeInvoked: runtimeResult.invoked === true,
    runtimeProvider: runtimeResult.provider || null,
    runtimeModel: runtimeResult.model || null,
    runtimeLatencyMs: runtimeResult.latencyMs,
    runtimeError: runtimeResult.error || runtimeResult.disabledReason || null,
    upstreamUserPromptAttempted: upstreamUserPromptResult.attempted === true,
    upstreamUserPromptStatus: upstreamUserPromptResult.status || null,
    upstreamUserPromptBlockedReason: upstreamUserPromptResult.blockedReason || null,
    upstreamUserPromptMessageSent: upstreamUserPromptResult.messageSent === true,
    upstreamUserPromptConversationId: upstreamUserPromptResult.conversationId || null,
    upstreamUserPromptTranscriptPath: upstreamUserPromptResult.transcriptPath || null,
    upstreamUserPromptSyncStateFile: upstreamUserPromptResult.syncStateFile || null,
    upstreamUserPromptScriptPath: upstreamUserPromptResult.scriptPath || null,
    upstreamUserPromptTranscriptLineCount: upstreamUserPromptResult.transcriptLineCount || null,
    upstreamUserPromptLastProcessedIndexBefore: upstreamUserPromptResult.lastProcessedIndexBefore,
    upstreamUserPromptLastProcessedIndexAfter: upstreamUserPromptResult.lastProcessedIndexAfter,
    upstreamStopAttempted: upstreamStopResult.attempted === true,
    upstreamStopStatus: upstreamStopResult.status || null,
    upstreamStopBlockedReason: upstreamStopResult.blockedReason || null,
    upstreamStopMessageSent: upstreamStopResult.messageSent === true,
    upstreamStopConversationId: upstreamStopResult.conversationId || null,
    upstreamStopTranscriptPath: upstreamStopResult.transcriptPath || null,
    upstreamStopSyncStateFile: upstreamStopResult.syncStateFile || null,
    upstreamStopScriptPath: upstreamStopResult.scriptPath || null,
    upstreamStopTranscriptMessageCount: upstreamStopResult.transcriptMessageCount || null,
    upstreamStopNewMessageCount: upstreamStopResult.newMessageCount || null,
  };

  appendLog(`${HOOK_NAME} session=${event.sessionId || '-'} tool=${event.toolName || '-'} letta=${state.lettaAgentId}`);
  await postSubconsciousEvent(event);
  emitAdditionalContext(HOOK_NAME, agentName, effectiveGuidance);
}

main().catch((err) => {
  appendLog(`hook-error ${String(err?.message || err)}`);
  // Hooks must stay non-blocking.
  process.exit(0);
});
