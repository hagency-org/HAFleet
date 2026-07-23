#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  APPROVAL_CHANNEL_FAILURE_MESSAGE,
  failClosedRuntimeApproval,
  resolveAndConsumeRuntimeApproval,
} from './runtime-approval-client.js';

const HOOK_DIGEST_ARGUMENT = '--agentchat-hook-sha256=';

function resolveAgentToken(agentName, env = process.env) {
  const explicit = typeof env.AGENTCHAT_AGENT_TOKEN === 'string' ? env.AGENTCHAT_AGENT_TOKEN.trim() : '';
  if (explicit) return explicit;
  const stateDir = typeof env.AGENTCHAT_AGENT_STATE_DIR === 'string' ? env.AGENTCHAT_AGENT_STATE_DIR.trim() : '';
  const home = typeof env.AGENTCHAT_HOMEDIR === 'string' && env.AGENTCHAT_HOMEDIR.trim()
    ? path.resolve(env.AGENTCHAT_HOMEDIR.trim())
    : path.join(os.homedir(), '.agentchat');
  const tokenPath = stateDir
    ? path.join(stateDir, 'agent-token')
    : path.join(home, 'agents', `agent_${agentName}`, 'state', 'agent-token');
  try { return readFileSync(tokenPath, 'utf8').trim(); } catch { return ''; }
}

function stableJson(value) {
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

export function buildCodexApprovalRequest(input, agentName, project = '') {
  const toolName = typeof input?.tool_name === 'string' && input.tool_name.trim()
    ? input.tool_name.trim()
    : 'unknown';
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const serialized = stableJson(toolInput);
  const turnId = typeof input?.turn_id === 'string' && input.turn_id.trim() ? input.turn_id.trim() : 'turn';
  const callDigest = createHash('sha256').update(serialized).digest('hex').slice(0, 24);
  const description = typeof toolInput.description === 'string' && toolInput.description.trim()
    ? toolInput.description.trim()
    : `${toolName} permission request`;
  return {
    agent: agentName,
    runtime: 'codex',
    ...(project ? { project } : {}),
    upstream_request_id: `${turnId}:${toolName}:${callDigest}`.slice(0, 255),
    tool_name: toolName,
    description: description.slice(0, 4096),
    input_preview: serialized.slice(0, 8192),
  };
}

export function buildCodexHookDecision(behavior, message = 'Denied by the agent owner.') {
  const decision = behavior === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', message };
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };
}

export function expectedHookDigest(argv = process.argv) {
  const argument = argv.find(value => typeof value === 'string' && value.startsWith(HOOK_DIGEST_ARGUMENT));
  const digest = argument?.slice(HOOK_DIGEST_ARGUMENT.length) || '';
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('missing or invalid content-bound hook digest');
  }
  return digest;
}

export function verifyHookScriptDigest({
  argv = process.argv,
  scriptPath = fileURLToPath(import.meta.url),
  readFile = readFileSync,
} = {}) {
  const expected = expectedHookDigest(argv);
  const actual = createHash('sha256').update(readFile(scriptPath)).digest('hex');
  if (actual !== expected) throw new Error('permission hook contents changed after trust verification');
  return actual;
}

async function readStdin(input = process.stdin) {
  let raw = '';
  for await (const chunk of input) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('hook input exceeds 1 MiB');
  }
  return JSON.parse(raw || '{}');
}

async function decideCodexPermission({
  input,
  env,
  argv,
  scriptPath,
  api: providedApi,
  pollIntervalMs,
}) {
  verifyHookScriptDigest({ argv, scriptPath });
  if (input?.hook_event_name && input.hook_event_name !== 'PermissionRequest') {
    throw new Error(`unexpected hook event ${input.hook_event_name}`);
  }
  const agentName = typeof env.AGENT_NAME === 'string' ? env.AGENT_NAME.trim() : '';
  const token = resolveAgentToken(agentName, env);
  if (!agentName || !token) {
    throw new Error('missing agent identity/token');
  }
  const apiBase = (env.AGENT_CHAT_API || 'http://127.0.0.1:8090').trim().replace(/\/$/, '');
  const api = providedApi || (async (method, apiPath, body) => {
    const options = {
      method,
      headers: { 'X-Agent-Token': token },
      signal: AbortSignal.timeout(15_000),
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${apiBase}${apiPath}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `approval API HTTP ${response.status}`);
    return data;
  });

  const created = await api('POST', '/api/approvals', buildCodexApprovalRequest(
    input,
    agentName,
    (env.AGENTCHAT_PROJECT_ID || '').trim(),
  ));
  const approval = created?.approval;
  if (!approval) throw new Error('approval API returned no request');
  const outcome = await resolveAndConsumeRuntimeApproval({
    api,
    approval,
    agent: agentName,
    pollIntervalMs,
  });
  return outcome;
}

export async function runCodexPermissionHook({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  argv = process.argv,
  scriptPath = fileURLToPath(import.meta.url),
  api,
  pollIntervalMs = 1000,
} = {}) {
  const outcome = await failClosedRuntimeApproval(async () => {
    const input = await readStdin(stdin);
    return decideCodexPermission({
      input,
      env,
      argv,
      scriptPath,
      api,
      pollIntervalMs,
    });
  }, {
    onError: error => {
      stderr.write(`[approval-hook] ${error.message}; denying unattended permission request\n`);
    },
  });
  const decision = buildCodexHookDecision(
    outcome.behavior,
    outcome.approval?.denial_reason || (
      outcome.behavior === 'deny' && !outcome.approval
        ? APPROVAL_CHANNEL_FAILURE_MESSAGE
        : 'Denied by the agent owner.'
    ),
  );
  stdout.write(`${JSON.stringify(decision)}\n`);
  return decision;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCodexPermissionHook().catch((error) => {
    // If stdout itself is unavailable, no adapter can deliver a verdict. Keep
    // the process non-zero and make the failure visible to the managed launcher.
    process.stderr.write(`[approval-hook] failed to emit fail-closed decision: ${error.message}\n`);
    process.exitCode = 1;
  });
}
