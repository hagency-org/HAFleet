#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DATA_AGENTS_DIR = path.resolve(ROOT, 'data/agents');
const BACKEND_URL = process.env.AGENT_AUDIT_BACKEND_URL || 'http://127.0.0.1:8090';

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

function sectionExists(markdown, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  return re.test(String(markdown || ''));
}

function currentBlock(markdown) {
  const src = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Current\s*$/i.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

function loadMeta(agentName) {
  const metaPath = path.join(DATA_AGENTS_DIR, agentName, 'meta.json');
  if (!existsSync(metaPath)) return { metaPath, workspacePath: null };
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const workspacePath = (typeof meta.path === 'string' && meta.path.trim()) ? meta.path.trim() : null;
    return { metaPath, workspacePath };
  } catch {
    return { metaPath, workspacePath: null };
  }
}

function resolveDocs(agentName, workspacePath) {
  const candidates = [];
  if (workspacePath) candidates.push(path.join(workspacePath, 'docs', agentName));
  candidates.push(path.join(ROOT, 'docs', agentName));

  for (const root of candidates) {
    const agentsPath = path.join(root, 'agents.md');
    const planPath = path.join(root, 'plan.md');
    if (existsSync(agentsPath) || existsSync(planPath)) {
      return { docsRoot: root, agentsPath, planPath };
    }
  }

  const fallback = candidates[0] || path.join(ROOT, 'docs', agentName);
  return {
    docsRoot: fallback,
    agentsPath: path.join(fallback, 'agents.md'),
    planPath: path.join(fallback, 'plan.md'),
  };
}

async function fetchActiveAgents() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/agents`);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.filter(r => r && r.online === true).map(r => r.name) : null;
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

function auditOne(agentName) {
  const { workspacePath, metaPath } = loadMeta(agentName);
  const docs = resolveDocs(agentName, workspacePath);
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
  if (args.activeOnly) {
    const active = await fetchActiveAgents();
    if (Array.isArray(active) && active.length > 0) {
      const keep = new Set(active);
      names = names.filter(name => keep.has(name));
    }
  }
  if (args.limit) names = names.slice(0, args.limit);

  const rows = names.map(auditOne);
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
