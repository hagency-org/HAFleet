#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { resolveAgentDocsPaths, resolveV1ManifestForAgent } from '../lib/agent-home-v1.js';

const ROOT = process.cwd();
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.AGENT_CHAT_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : ROOT;
})();
const DATA_AGENTS_DIR = path.join(RUNTIME_ROOT, 'data', 'agents');
const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const DEFAULT_BACKEND_URL = (process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`).trim().replace(/\/$/, '');
const BACKEND_URL = (process.env.AGENT_AUDIT_BACKEND_URL || DEFAULT_BACKEND_URL).trim().replace(/\/$/, '');

function parseArgs(argv) {
  const args = { activeOnly: false, json: false, limit: null };
  for (const arg of argv) {
    if (arg === '--active') args.activeOnly = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    }
  }
  return args;
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 4096) return null;
  if (!path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

function sectionExists(markdown, heading) {
  const escaped = escapeRegExp(heading);
  const re = new RegExp(`^#{1,6}\\s+${escaped}(?:\\s*$|\\s*[:()\\[\\]{}-]|\\s+[—–-])`, 'im');
  return re.test(String(markdown || ''));
}

function currentBlock(markdown) {
  const src = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  let start = -1;
  let headingLevel = 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/\s+#+\s*$/, '');
    if (/^#{1,6}\s+Current(?:\s*$|\s*[:()\[\]{}-]|\s+[—–-])/i.test(line)) {
      start = i + 1;
      const match = line.match(/^(#{1,6})\s+/);
      headingLevel = match ? match[1].length : 2;
      break;
    }
  }
  if (start < 0) return '';
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(#{1,6})\s+/);
    if (match && match[1].length <= headingLevel) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

function loadMeta(agentName, apiAgent = null) {
  const metaPath = path.join(DATA_AGENTS_DIR, agentName, 'meta.json');
  const workspaceFromApi = normalizeWorkspacePath(apiAgent?.workspacePath);
  let meta = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
      meta = null;
    }
  }
  const v1Manifest = resolveV1ManifestForAgent(agentName, meta, process.env);
  if (!existsSync(metaPath)) {
    return {
      metaPath,
      workspacePath: (v1Manifest?.workdir && normalizeWorkspacePath(v1Manifest.workdir)) || workspaceFromApi,
      v1Manifest,
    };
  }
  try {
    const workspacePath = (typeof meta?.path === 'string' && meta.path.trim())
      ? normalizeWorkspacePath(meta.path.trim())
      : ((v1Manifest?.workdir && normalizeWorkspacePath(v1Manifest.workdir)) || workspaceFromApi);
    return { metaPath, workspacePath, v1Manifest };
  } catch {
    return {
      metaPath,
      workspacePath: (v1Manifest?.workdir && normalizeWorkspacePath(v1Manifest.workdir)) || workspaceFromApi,
      v1Manifest,
    };
  }
}

async function fetchAgentsSnapshot() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/agents`);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function collectAllAgentNames() {
  if (!existsSync(DATA_AGENTS_DIR)) return [];
  return readdirSync(DATA_AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function collectActiveApiAgentNames(apiRows) {
  if (!Array.isArray(apiRows)) return null;
  return apiRows
    .filter(r => r && r.healthy === true)
    .filter(r => typeof r.tmux === 'string' && r.tmux.trim())
    .filter(r => r.blocked !== true)
    .filter(r => r.activeNow === true)
    .map(r => String(r.name || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function auditOne(agentName, apiAgent = null) {
  const { workspacePath, metaPath, v1Manifest } = loadMeta(agentName, apiAgent);
  const docs = resolveAgentDocsPaths(agentName, workspacePath, { cwd: ROOT, v1Manifest });
  const agentsMd = readText(docs.agentsPath);
  const planMd = readText(docs.planPath);

  const hasRoleSection = sectionExists(agentsMd, 'Role');
  const hasBoundariesSection = sectionExists(agentsMd, 'Boundaries');
  const current = currentBlock(planMd);
  const hasCurrent = !!current;

  const missing = [];
  if (!hasRoleSection) missing.push('agents.md:##Role');
  if (!hasBoundariesSection) missing.push('agents.md:##Boundaries');
  if (!hasCurrent) missing.push('plan.md:##Current');

  return {
    agent: agentName,
    workspacePath,
    metaPath,
    v1ManifestPath: v1Manifest?.agentJsonPath || null,
    docsRoot: docs.docsRoot,
    agentsPath: docs.agentsPath,
    planPath: docs.planPath,
    hasRoleSection,
    hasBoundariesSection,
    hasCurrent,
    missing,
    currentPreview: hasCurrent
      ? current.replace(/\s+/g, ' ').trim().slice(0, 120)
      : '',
  };
}

function printTable(rows) {
  const width = {
    agent: Math.max(5, ...rows.map(r => r.agent.length)),
    role: 4,
    boundaries: 10,
    current: 7,
  };

  const pad = (v, n) => String(v).padEnd(n);
  console.log(`${pad('AGENT', width.agent)}  ROLE  BOUNDARIES  CURRENT  MISSING`);
  for (const r of rows) {
    const missing = r.missing.length ? r.missing.join(',') : '-';
    console.log(
      `${pad(r.agent, width.agent)}  ${pad(r.hasRoleSection ? 'yes' : 'no', width.role)}  ${pad(r.hasBoundariesSection ? 'yes' : 'no', width.boundaries)}  ${pad(r.hasCurrent ? 'yes' : 'no', width.current)}  ${missing}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let names = collectAllAgentNames();
  const apiRows = await fetchAgentsSnapshot();
  const apiByName = new Map();
  if (Array.isArray(apiRows)) {
    for (const row of apiRows) {
      if (!row || typeof row.name !== 'string') continue;
      apiByName.set(row.name, row);
    }
  }
  if (args.activeOnly) {
    const active = collectActiveApiAgentNames(apiRows);
    if (Array.isArray(active)) names = active;
  }
  if (args.limit) names = names.slice(0, args.limit);

  const rows = names.map(name => auditOne(name, apiByName.get(name) || null));
  const summary = {
    total: rows.length,
    pass: rows.filter(r => r.missing.length === 0).length,
    fail: rows.filter(r => r.missing.length > 0).length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
  } else {
    printTable(rows);
    console.log('');
    console.log(`total=${summary.total} pass=${summary.pass} fail=${summary.fail}`);
  }

  process.exit(summary.fail > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
