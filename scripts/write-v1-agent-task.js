#!/usr/bin/env node
import path from 'path';
import { readV1AgentManifest } from '../lib/agent-home-v1.js';

function parseArgs(argv) {
  const args = {
    command: '',
    workdir: '',
    id: '',
    owner: '',
    reason: '',
    until: '',
    webUrl: '',
    graphId: '',
    nodeId: '',
    result: '',
    error: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!args.command && !token.startsWith('-')) {
      args.command = token;
      continue;
    }
    if (token === '--workdir' && argv[i + 1]) {
      args.workdir = argv[++i];
      continue;
    }
    if (token === '--id' && argv[i + 1]) {
      args.id = argv[++i];
      continue;
    }
    if (token === '--owner' && argv[i + 1]) {
      args.owner = argv[++i];
      continue;
    }
    if (token === '--reason' && argv[i + 1]) {
      args.reason = argv[++i];
      continue;
    }
    if (token === '--until' && argv[i + 1]) {
      args.until = argv[++i];
      continue;
    }
    if (token === '--web-url' && argv[i + 1]) {
      args.webUrl = argv[++i];
      continue;
    }
    if (token === '--graph' && argv[i + 1]) {
      args.graphId = argv[++i];
      continue;
    }
    if (token === '--node' && argv[i + 1]) {
      args.nodeId = argv[++i];
      continue;
    }
    if (token === '--result' && argv[i + 1]) {
      args.result = argv[++i];
      continue;
    }
    if (token === '--error' && argv[i + 1]) {
      args.error = argv[++i];
      continue;
    }
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: write-v1-agent-task <start|heartbeat|wait|resume|done|fail> [options]

Options:
  --workdir <path>   Agent workdir (default: cwd)
  --id <task-id>     Required for start; optional otherwise when a task already exists
  --owner <name>     Override task owner (default: manifest/current owner)
  --reason <text>    Required for wait
  --until <iso8601>  Required for wait
  --web-url <url>    Override AGENT_CHAT_WEB_URL / AGENT_CHAT_WEB_PORT resolution
  --graph <id>       Report a task graph node result/failure instead of home metadata
  --node <id>        Task graph node id (required with --graph)
  --result <json>    JSON payload for graph completion
  --error <text>     Error text for graph failure
`);
}

function normalizeText(value, maxLen = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeTaskStatus(value) {
  const raw = normalizeText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['active', 'waiting', 'blocked', 'done'].includes(lower)) return lower;
  return null;
}

function normalizeIso(value) {
  const raw = normalizeText(value, 128);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTask(value, fallbackOwner = null) {
  if (!value || typeof value !== 'object') return null;
  const status = normalizeTaskStatus(value.status);
  const id = normalizeText(value.id, 256);
  const owner = normalizeText(value.owner, 128) || normalizeText(fallbackOwner, 128);
  const updatedAt = normalizeIso(value.updated_at);
  const heartbeatAt = normalizeIso(value.heartbeat_at);
  const waitingReason = normalizeText(value.waiting_reason, 2000);
  const waitingUntil = normalizeIso(value.waiting_until);
  if (!status || !id || !owner || !updatedAt || !heartbeatAt) return null;
  if (status === 'waiting' && (!waitingReason || !waitingUntil)) return null;
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

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultWebBaseUrl(env = process.env) {
  const explicit = String(env.AGENT_CHAT_WEB_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const api = String(env.AGENT_CHAT_API || '').trim();
  if (api) return api.replace(/\/$/, '');
  const port = parsePositiveInt(env.AGENT_CHAT_WEB_PORT, 8084);
  return `http://127.0.0.1:${port}`;
}

function defaultApiBaseUrl(env = process.env) {
  const explicit = String(env.AGENT_CHAT_API || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const web = String(env.AGENT_CHAT_WEB_URL || '').trim();
  if (web) return web.replace(/\/$/, '');
  const port = parsePositiveInt(env.AGENT_CHAT_BACKEND_PORT, 8090);
  return `http://127.0.0.1:${port}`;
}

function parseJsonArg(value, label) {
  const raw = normalizeText(value, 20000);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error?.message || error}`);
  }
}

function resolveWorkdir(raw) {
  const target = raw ? path.resolve(raw) : process.cwd();
  return target;
}

function buildNextTask(command, manifest, args) {
  const now = new Date().toISOString();
  const existing = manifest?.task || null;
  const owner = normalizeText(args.owner, 128)
    || normalizeText(existing?.owner, 128)
    || normalizeText(manifest?.name, 128);
  const explicitId = normalizeText(args.id, 256);
  const resolvedId = explicitId || normalizeText(existing?.id, 256);
  if (!owner) throw new Error('unable to resolve task owner from arguments or manifest');
  if (command === 'start') {
    if (!explicitId) throw new Error('start requires --id');
    return normalizeTask({
      id: explicitId,
      owner,
      status: 'active',
      updated_at: now,
      heartbeat_at: now,
      waiting_reason: null,
      waiting_until: null,
    }, manifest?.name);
  }
  if (!resolvedId) {
    throw new Error(`${command} requires an existing task or an explicit --id`);
  }
  if (command === 'heartbeat') {
    const status = normalizeTaskStatus(existing?.status) || 'active';
    return normalizeTask({
      id: resolvedId,
      owner,
      status,
      updated_at: now,
      heartbeat_at: now,
      waiting_reason: status === 'waiting' ? existing?.waiting_reason : null,
      waiting_until: status === 'waiting' ? existing?.waiting_until : null,
    }, manifest?.name);
  }
  if (command === 'wait') {
    const reason = normalizeText(args.reason, 2000);
    const until = normalizeIso(args.until);
    if (!reason || !until) throw new Error('wait requires --reason and --until <ISO8601>');
    return normalizeTask({
      id: resolvedId,
      owner,
      status: 'waiting',
      updated_at: now,
      heartbeat_at: now,
      waiting_reason: reason,
      waiting_until: until,
    }, manifest?.name);
  }
  if (command === 'resume') {
    return normalizeTask({
      id: resolvedId,
      owner,
      status: 'active',
      updated_at: now,
      heartbeat_at: now,
      waiting_reason: null,
      waiting_until: null,
    }, manifest?.name);
  }
  if (command === 'done') {
    return normalizeTask({
      id: resolvedId,
      owner,
      status: 'done',
      updated_at: now,
      heartbeat_at: now,
      waiting_reason: null,
      waiting_until: null,
    }, manifest?.name);
  }
  throw new Error(`unsupported command: ${command}`);
}

function buildGraphPayload(command, args) {
  const graphId = normalizeText(args.graphId, 255);
  const nodeId = normalizeText(args.nodeId, 255);
  if (!graphId || !nodeId) {
    throw new Error('graph reporting requires --graph <graphId> and --node <nodeId>');
  }
  if (command === 'done') {
    return {
      graphId,
      nodeId,
      body: {
        status: 'complete',
        result: parseJsonArg(args.result, '--result'),
      },
    };
  }
  if (command === 'fail') {
    const error = normalizeText(args.error, 4000);
    if (!error) throw new Error('fail with --graph requires --error');
    return {
      graphId,
      nodeId,
      body: {
        status: 'failed',
        error,
      },
    };
  }
  throw new Error(`graph reporting only supports done/fail (received: ${command})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const command = String(args.command || '').trim().toLowerCase();
  if (!['start', 'heartbeat', 'wait', 'resume', 'done', 'fail'].includes(command)) {
    throw new Error(`unsupported command: ${command}`);
  }
  const workdir = resolveWorkdir(args.workdir);
  const manifestPath = path.join(workdir, '..', 'agent.json');
  const manifest = readV1AgentManifest(manifestPath);
  if (!manifest) {
    throw new Error(`v1 agent manifest not found: ${manifestPath}`);
  }
  const explicitBaseUrl = String(args.webUrl || '').trim().replace(/\/$/, '');

  if (normalizeText(args.graphId, 255) || normalizeText(args.nodeId, 255)) {
    const graphUpdate = buildGraphPayload(command, args);
    const apiBaseUrl = explicitBaseUrl || defaultApiBaseUrl(process.env);
    const response = await fetch(
      `${apiBaseUrl}/api/task-graphs/${encodeURIComponent(graphUpdate.graphId)}/nodes/${encodeURIComponent(graphUpdate.nodeId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graphUpdate.body),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(`graph task write failed: ${response.status} ${JSON.stringify(data || { error: 'invalid response' })}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      agent: manifest.name,
      manifestPath,
      workdir,
      apiUrl: apiBaseUrl,
      graphId: graphUpdate.graphId,
      nodeId: graphUpdate.nodeId,
      node: data?.node || null,
      graph: data?.graph || null,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'fail') {
    throw new Error('fail requires --graph <graphId> --node <nodeId>');
  }

  const task = buildNextTask(command, manifest, args);
  if (!task) throw new Error('failed to build task payload');

  const webUrl = explicitBaseUrl || defaultWebBaseUrl(process.env);
  const apiUrl = explicitBaseUrl || defaultApiBaseUrl(process.env);
  const usesDirectApi = !String(process.env.AGENT_CHAT_WEB_URL || '').trim() && Boolean(String(process.env.AGENT_CHAT_API || '').trim()) && !explicitBaseUrl;
  const targetUrl = usesDirectApi
    ? `${apiUrl}/api/agents/${encodeURIComponent(manifest.name)}`
    : `${webUrl}/api/agents/${encodeURIComponent(manifest.name)}/home-metadata`;
  const body = usesDirectApi ? { task } : { task };
  const response = await fetch(targetUrl, {
    method: usesDirectApi ? 'PATCH' : 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`task write failed: ${response.status} ${JSON.stringify(data || { error: 'invalid response' })}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command,
    agent: manifest.name,
    manifestPath,
    workdir,
    webUrl: usesDirectApi ? apiUrl : webUrl,
    task: data?.metadata?.task || data?.agent?.task || task,
  }, null, 2)}\n`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
