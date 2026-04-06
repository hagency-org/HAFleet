#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import path from 'path';

function usage() {
  console.log(`Usage:
  agentchat graph create <json-file>
  agentchat graph list [--status active]
  agentchat graph show <id>
  agentchat graph cancel <id>`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function normalizeText(value, maxLength = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultApiBaseUrl(env = process.env) {
  const explicit = String(env.AGENT_CHAT_API || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parsePositiveInt(env.AGENT_CHAT_BACKEND_PORT, 8090);
  return `http://127.0.0.1:${port}`;
}

function authHeaders() {
  const token = (process.env.API_TOKEN || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data || { error: 'invalid response' })}`);
  }
  return data;
}

function statusGlyph(status) {
  switch (String(status || '').trim().toLowerCase()) {
    case 'complete': return 'OK';
    case 'failed': return 'ERR';
    case 'skipped': return 'SKIP';
    case 'cancelled': return 'CANCEL';
    case 'active': return 'RUN';
    case 'dispatched': return 'SEND';
    case 'pending': return 'WAIT';
    default: return 'UNK';
  }
}

function formatGraphLine(graph) {
  const nodes = graph?.nodes && typeof graph.nodes === 'object' ? Object.values(graph.nodes) : [];
  return [
    String(graph?.id || ''),
    String(graph?.status || ''),
    String(graph?.owner || ''),
    `${nodes.length} nodes`,
    String(graph?.label || ''),
  ].join('\t');
}

function formatNodeLine(node) {
  const deps = Array.isArray(node?.depends_on) ? node.depends_on.join(',') : '';
  return `${statusGlyph(node?.status)} ${node?.id} -> ${node?.assignee} | deps=[${deps}] | ${node?.description || ''}`;
}

async function commandCreate(argv) {
  const filePath = path.resolve(String(argv[0] || '').trim());
  if (!filePath) fail('graph create requires <json-file>');
  if (!existsSync(filePath)) fail(`graph definition not found: ${filePath}`);
  const payload = JSON.parse(readFileSync(filePath, 'utf-8'));
  const apiBase = defaultApiBaseUrl(process.env);
  const data = await fetchJson(`${apiBase}/api/task-graphs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  console.log(`Created graph ${data.graph.id}`);
  console.log(`${data.graph.status}\t${data.graph.owner}\t${data.graph.label}`);
}

async function commandList(argv) {
  let status = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--status' && argv[i + 1]) {
      status = normalizeText(argv[i + 1], 32);
      i += 1;
      continue;
    }
    fail(`unknown argument for list: ${token}`);
  }
  const apiBase = defaultApiBaseUrl(process.env);
  const url = new URL(`${apiBase}/api/task-graphs`);
  if (status) url.searchParams.set('status', status);
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('No task graphs found.');
    return;
  }
  for (const graph of rows) {
    console.log(formatGraphLine(graph));
  }
}

async function commandShow(argv) {
  const graphId = normalizeText(argv[0], 255);
  if (!graphId) fail('graph show requires <id>');
  const apiBase = defaultApiBaseUrl(process.env);
  const graph = await fetchJson(`${apiBase}/api/task-graphs/${encodeURIComponent(graphId)}`);
  console.log(`${graph.id}\t${graph.status}\t${graph.owner}\t${graph.label}`);
  const nodes = Object.values(graph?.nodes || {});
  nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const node of nodes) {
    console.log(formatNodeLine(node));
  }
}

async function commandCancel(argv) {
  const graphId = normalizeText(argv[0], 255);
  if (!graphId) fail('graph cancel requires <id>');
  const apiBase = defaultApiBaseUrl(process.env);
  const data = await fetchJson(`${apiBase}/api/task-graphs/${encodeURIComponent(graphId)}`, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  console.log(`Cancelled graph ${data.graph.id}`);
  console.log(`${data.graph.status}\t${data.graph.owner}\t${data.graph.label}`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    return;
  }
  if (command === 'create') return commandCreate(rest);
  if (command === 'list') return commandList(rest);
  if (command === 'show') return commandShow(rest);
  if (command === 'cancel') return commandCancel(rest);
  fail(`unknown graph command: ${command}`);
}

main(process.argv.slice(2))
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    fail(error?.message || String(error));
  });
