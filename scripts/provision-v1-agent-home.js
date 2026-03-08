#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildV1AgentPaths,
  defaultAgentchatHomeDir,
  readV1AgentManifest,
  v1AgentIdFromName,
} from '../lib/agent-home-v1.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIGURE_SUBCONSCIOUS_SCRIPT = path.join(__dirname, 'configure-v1-subconscious.js');
const WORKSPACE_CLAUDE_TEMPLATE_PATH = path.join(__dirname, '..', 'docs', 'workspace-claude-md-template.md');
const WORKSPACE_AGENTS_TEMPLATE_PATH = path.join(__dirname, '..', 'docs', 'workspace-agents-md-template.md');
const WORKSPACE_CLAUDE_TEMPLATE_VERSION = 'v1';
const WORKSPACE_AGENTS_TEMPLATE_VERSION = 'v1';

function parseArgs(argv) {
  const args = {
    name: '',
    type: 'claude',
    homeDir: '',
    projectPath: '',
    projectMode: 'copy',
    projectName: '',
    agentId: '',
    subconsciousEnabled: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--name' && argv[i + 1]) {
      args.name = argv[++i];
      continue;
    }
    if (token === '--type' && argv[i + 1]) {
      args.type = argv[++i];
      continue;
    }
    if (token === '--home' && argv[i + 1]) {
      args.homeDir = argv[++i];
      continue;
    }
    if (token === '--project' && argv[i + 1]) {
      args.projectPath = argv[++i];
      continue;
    }
    if (token === '--project-mode' && argv[i + 1]) {
      args.projectMode = argv[++i];
      continue;
    }
    if (token === '--project-name' && argv[i + 1]) {
      args.projectName = argv[++i];
      continue;
    }
    if (token === '--agent-id' && argv[i + 1]) {
      args.agentId = argv[++i];
      continue;
    }
    if (token === '--subconscious-enabled' && argv[i + 1]) {
      args.subconsciousEnabled = argv[++i];
      continue;
    }
    if ((token === '-h') || (token === '--help')) {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: provision-v1-agent-home --name <agent> [options]

Options:
  --type <claude|codex>       Agent client type (default: claude)
  --home <path>               AGENTCHAT_HOMEDIR override
  --project <path>            Source project directory to materialize under workdir/projects/
  --project-mode <mode>       copy (default) | symlink
  --project-name <name>       Override project directory name in workdir/projects/
  --agent-id <id>             Explicit internal id (default: agent_<normalized-name>)
  --subconscious-enabled <b>  Override subconscious default (true/false)
`);
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return name;
}

function resolveAbsDir(value, label) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const abs = path.resolve(raw);
  if (!existsSync(abs)) throw new Error(`${label} does not exist: ${abs}`);
  const st = lstatSync(abs);
  if (!st.isDirectory()) throw new Error(`${label} is not a directory: ${abs}`);
  return abs;
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseOptionalBool(value, fallback = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function defaultBackendBaseUrl(env = process.env) {
  const explicit = String(env.AGENT_CHAT_API || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parsePositiveInt(env.AGENT_CHAT_BACKEND_PORT, 8090);
  return `http://127.0.0.1:${port}`;
}

function defaultSubconsciousEventUrl(env = process.env) {
  return `${defaultBackendBaseUrl(env)}/api/subconscious/events`;
}

function writeIfMissing(filePath, content) {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, content, 'utf-8');
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function workspaceTemplateMarker(version = WORKSPACE_CLAUDE_TEMPLATE_VERSION) {
  return `agentchat-workspace-template: ${version}`;
}

function isManagedWorkspaceClaudeContent(content) {
  return String(content || '').includes(workspaceTemplateMarker());
}

function workspaceAgentsTemplateMarker(version = WORKSPACE_AGENTS_TEMPLATE_VERSION) {
  return `agentchat-workspace-agents-template: ${version}`;
}

function isManagedWorkspaceAgentsContent(content) {
  return String(content || '').includes(workspaceAgentsTemplateMarker());
}

function isLegacyWorkspaceClaudeStub(content) {
  const text = String(content || '');
  return text.includes('This is a v1 agent home workdir.')
    && text.includes('`docs/`: self-management docs and workflow notes')
    && text.includes('`projects/`: project material owned by this agent');
}

function isLegacyWorkspaceAgentsStub(content) {
  const text = String(content || '');
  return text.includes('and I own work inside this v1 agent home workdir.')
    && text.includes('Keep agent-managed docs in this `docs/` directory.')
    && text.includes('Keep project material under `../projects/`.');
}

function loadWorkspaceClaudeTemplate() {
  if (!existsSync(WORKSPACE_CLAUDE_TEMPLATE_PATH)) {
    throw new Error(`missing workspace template: ${WORKSPACE_CLAUDE_TEMPLATE_PATH}`);
  }
  const raw = readFileSync(WORKSPACE_CLAUDE_TEMPLATE_PATH, 'utf-8');
  if (!isManagedWorkspaceClaudeContent(raw)) {
    throw new Error(`workspace template missing managed marker/version: ${WORKSPACE_CLAUDE_TEMPLATE_PATH}`);
  }
  return raw;
}

function loadWorkspaceAgentsTemplate() {
  if (!existsSync(WORKSPACE_AGENTS_TEMPLATE_PATH)) {
    throw new Error(`missing workspace agents template: ${WORKSPACE_AGENTS_TEMPLATE_PATH}`);
  }
  const raw = readFileSync(WORKSPACE_AGENTS_TEMPLATE_PATH, 'utf-8');
  if (!isManagedWorkspaceAgentsContent(raw)) {
    throw new Error(`workspace agents template missing managed marker/version: ${WORKSPACE_AGENTS_TEMPLATE_PATH}`);
  }
  return raw;
}

function renderWorkspaceClaudeTemplate(template, manifest) {
  return template
    .replaceAll('{{AGENT_NAME}}', manifest.name)
    .replaceAll('{{AGENT_ID}}', manifest.id)
    .replaceAll('{{LAYOUT_VERSION}}', String(manifest.layoutVersion || 1));
}

function renderWorkspaceAgentsTemplate(template, manifest) {
  return template
    .replaceAll('{{AGENT_NAME}}', manifest.name)
    .replaceAll('{{AGENT_ID}}', manifest.id)
    .replaceAll('{{LAYOUT_VERSION}}', String(manifest.layoutVersion || 1));
}

function writeManagedWorkspaceClaude(filePath, content) {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf-8');
    if (!isManagedWorkspaceClaudeContent(current) && !isLegacyWorkspaceClaudeStub(current)) {
      return 'preserved-manual';
    }
    if (current === content) return 'unchanged';
  }
  writeFileSync(filePath, content, 'utf-8');
  return 'written';
}

function writeManagedWorkspaceAgents(filePath, content) {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf-8');
    if (!isManagedWorkspaceAgentsContent(current) && !isLegacyWorkspaceAgentsStub(current)) {
      return 'preserved-manual';
    }
    if (current === content) return 'unchanged';
  }
  writeFileSync(filePath, content, 'utf-8');
  return 'written';
}

function ensureDocsClaudeCompatibilityLink(paths) {
  const docsClaudePath = path.join(paths.docsDir, 'CLAUDE.md');
  const relativeTarget = '../CLAUDE.md';
  if (existsSync(docsClaudePath)) {
    const stat = lstatSync(docsClaudePath);
    if (stat.isSymbolicLink()) {
      if (sameRealPath(path.join(paths.docsDir, relativeTarget), docsClaudePath)) return 'unchanged';
      unlinkSync(docsClaudePath);
    } else {
      const current = readFileSync(docsClaudePath, 'utf-8');
      if (!isManagedWorkspaceClaudeContent(current) && !isLegacyWorkspaceClaudeStub(current)) {
        return 'preserved-manual';
      }
      unlinkSync(docsClaudePath);
    }
  }
  symlinkSync(relativeTarget, docsClaudePath);
  return 'linked';
}

function ensureDocsAgentsCompatibilityLink(paths) {
  const docsAgentsPath = path.join(paths.docsDir, 'AGENTS.md');
  const relativeTarget = '../AGENTS.md';
  if (existsSync(docsAgentsPath)) {
    const stat = lstatSync(docsAgentsPath);
    if (stat.isSymbolicLink()) {
      if (sameRealPath(path.join(paths.docsDir, relativeTarget), docsAgentsPath)) return 'unchanged';
      unlinkSync(docsAgentsPath);
    } else {
      const current = readFileSync(docsAgentsPath, 'utf-8');
      if (!isManagedWorkspaceAgentsContent(current) && !isLegacyWorkspaceAgentsStub(current)) {
        return 'preserved-manual';
      }
      unlinkSync(docsAgentsPath);
    }
  }
  symlinkSync(relativeTarget, docsAgentsPath);
  return 'linked';
}

function sameRealPath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function materializeProject(projectSource, projectTarget, mode) {
  if (!projectSource) return null;
  if (existsSync(projectTarget)) {
    if (mode === 'symlink') {
      if (sameRealPath(projectSource, projectTarget)) return 'unchanged';
      throw new Error(`project target already exists and differs: ${projectTarget}`);
    }
    if (mode === 'copy') {
      if (sameRealPath(projectSource, projectTarget)) return 'unchanged';
      throw new Error(`project target already exists and differs: ${projectTarget}`);
    }
    throw new Error(`unsupported project mode: ${mode}`);
  }

  if (mode === 'symlink') {
    symlinkSync(projectSource, projectTarget, 'dir');
    return 'linked';
  }
  if (mode === 'copy') {
    cpSync(projectSource, projectTarget, { recursive: true, force: false, errorOnExist: true, dereference: false });
    return 'copied';
  }
  throw new Error(`unsupported project mode: ${mode}`);
}

function loadExistingManifest(paths) {
  if (!existsSync(paths.agentJsonPath)) return null;
  return readV1AgentManifest(paths.agentJsonPath);
}

function ensureDocs(paths, manifest) {
  writeIfMissing(path.join(paths.docsDir, 'plan.md'), `## Current
Initialize this v1 agent workspace and define the first executable task.

## Queue
1. Add project-specific task backlog.
`);
  writeIfMissing(path.join(paths.docsDir, 'progress.md'), '');
  writeIfMissing(path.join(paths.docsDir, 'projects.md'), `# Projects

Track agent-owned project material under \`../projects/\`.
`);

  const template = loadWorkspaceClaudeTemplate();
  const renderedClaude = renderWorkspaceClaudeTemplate(template, manifest);
  const agentsTemplate = loadWorkspaceAgentsTemplate();
  const renderedAgents = renderWorkspaceAgentsTemplate(agentsTemplate, manifest);
  const claudeRootStatus = writeManagedWorkspaceClaude(path.join(paths.workdir, 'CLAUDE.md'), renderedClaude);
  const agentsRootStatus = writeManagedWorkspaceAgents(path.join(paths.workdir, 'AGENTS.md'), renderedAgents);
  const docsClaudeStatus = ensureDocsClaudeCompatibilityLink(paths);
  const docsAgentsStatus = ensureDocsAgentsCompatibilityLink(paths);
  return {
    claudeRootStatus,
    agentsRootStatus,
    docsClaudeStatus,
    docsAgentsStatus,
  };
}

function resolveLegacyMetaPath(homeRoot, agentName) {
  const agentsDir = path.resolve(homeRoot, '..', 'data', 'agents');
  const desired = path.join(agentsDir, agentName, 'meta.json');
  if (!existsSync(agentsDir)) return desired;
  try {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() !== String(agentName || '').toLowerCase()) continue;
      return path.join(agentsDir, entry.name, 'meta.json');
    }
  } catch {
    return desired;
  }
  return desired;
}

function syncLegacyMeta(homeRoot, manifest) {
  const metaPath = resolveLegacyMetaPath(homeRoot, manifest?.name || '');
  const existing = safeReadJson(metaPath, {});
  const merged = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    name: manifest?.name || null,
    type: manifest?.type || null,
    path: manifest?.workdir || null,
    agentModelVersion: manifest?.agentModelVersion || '1.0',
    layoutVersion: Number(manifest?.layoutVersion) || 1,
    agentId: manifest?.id || null,
    homeDir: manifest?.homeDir || null,
    workdir: manifest?.workdir || null,
    stateDir: manifest?.stateDir || null,
    agentJsonPath: manifest?.agentJsonPath || null,
    v1HomeManaged: true,
    subconsciousEnabled: manifest?.subconsciousEnabled === true,
    managedProjects: Array.isArray(manifest?.managedProjects) ? manifest.managedProjects : [],
    human: (manifest?.human && typeof manifest.human === 'object') ? manifest.human : {},
  };
  ensureDir(path.dirname(metaPath));
  writeFileSync(metaPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  return metaPath;
}

function deterministicLettaAgentId(seed) {
  const hex = createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 32).padEnd(32, '0');
  return `agent-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function ensureLettaState(paths, enabled, seed, agentName = null) {
  const lettaPath = path.join(paths.stateDir, 'letta.json');
  if (!enabled) return lettaPath;
  const now = new Date().toISOString();
  const existing = safeReadJson(lettaPath, {});
  const envAgentId = String(process.env.LETTA_AGENT_ID || '').trim();
  const existingAgentId = (existing && typeof existing.agentId === 'string')
    ? String(existing.agentId).trim()
    : '';
  const resolvedAgentId = envAgentId || existingAgentId || deterministicLettaAgentId(seed);
  const next = {
    provider: 'letta',
    mode: 'claude-subconscious',
    enabled: true,
    agentName: String(agentName || '').trim() || (typeof existing?.agentName === 'string' ? existing.agentName : null),
    agentId: resolvedAgentId,
    resolutionSource: envAgentId ? 'env' : (existingAgentId ? 'state' : 'generated'),
    guidance: (existing && typeof existing.guidance === 'string') ? existing.guidance : '',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeFileSync(lettaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return lettaPath;
}

function configureSubconscious(paths, manifest) {
  if (manifest.type !== 'claude') return null;
  if (!existsSync(CONFIGURE_SUBCONSCIOUS_SCRIPT)) {
    throw new Error(`missing subconscious config script: ${CONFIGURE_SUBCONSCIOUS_SCRIPT}`);
  }
  const eventUrl = String(process.env.AGENTCHAT_SUBCONSCIOUS_EVENT_URL || '').trim()
    || defaultSubconsciousEventUrl(process.env);
  const output = execFileSync('node', [
    CONFIGURE_SUBCONSCIOUS_SCRIPT,
    '--agent-name', manifest.name,
    '--agent-id', manifest.id,
    '--workdir', paths.workdir,
    '--state-dir', paths.stateDir,
    '--enabled', manifest.subconsciousEnabled ? 'true' : 'false',
    '--event-url', eventUrl,
  ], {
    encoding: 'utf-8',
    env: { ...process.env, AGENTCHAT_SUBCONSCIOUS_EVENT_URL: eventUrl },
  }).trim();
  if (!output) return null;
  return JSON.parse(output);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const name = normalizeName(args.name);
  if (!name) throw new Error('invalid --name (allowed: letters, digits, dot, underscore, hyphen)');
  const type = String(args.type || 'claude').trim().toLowerCase();
  if (type !== 'claude' && type !== 'codex') throw new Error(`invalid --type: ${type}`);

  const projectMode = String(args.projectMode || 'copy').trim().toLowerCase();
  if (projectMode !== 'symlink' && projectMode !== 'copy') {
    throw new Error(`invalid --project-mode: ${projectMode}`);
  }

  const homeRoot = args.homeDir
    ? path.resolve(String(args.homeDir).trim())
    : defaultAgentchatHomeDir(process.env);
  const agentId = String(args.agentId || '').trim() || v1AgentIdFromName(name);
  const paths = buildV1AgentPaths(name, { ...process.env, AGENTCHAT_HOMEDIR: homeRoot }, agentId);
  if (!paths) throw new Error('failed to build v1 agent paths');

  ensureDir(paths.homeRoot);
  ensureDir(path.join(paths.homeRoot, 'agents'));
  ensureDir(paths.homeDir);
  ensureDir(paths.stateDir);
  ensureDir(path.join(paths.stateDir, 'locks'));
  ensureDir(path.join(paths.stateDir, 'history'));
  ensureDir(path.join(paths.stateDir, 'tmp'));
  ensureDir(paths.workdir);
  ensureDir(paths.docsDir);
  ensureDir(paths.projectsDir);
  ensureDir(path.join(paths.workdir, 'scratch'));
  ensureDir(path.join(paths.workdir, 'inbox'));
  ensureDir(path.join(paths.workdir, 'outputs'));

  const sourceProject = resolveAbsDir(args.projectPath, 'project path');
  const projectName = String(args.projectName || '').trim()
    || (sourceProject ? path.basename(sourceProject) : '');
  let materialization = null;
  let managedProjects = [];

  const existing = loadExistingManifest(paths);
  if (existing && String(existing.name || '').toLowerCase() !== name.toLowerCase()) {
    throw new Error(`existing manifest belongs to another agent: ${existing.name}`);
  }
  if (existing?.managedProjects && Array.isArray(existing.managedProjects)) {
    managedProjects = existing.managedProjects.map((row) => ({ ...row }));
  }

  if (sourceProject) {
    const normalizedProjectName = projectName.replace(/[\\/]+/g, '-').trim();
    if (!normalizedProjectName) throw new Error('project name resolved to empty string');
    const target = path.join(paths.projectsDir, normalizedProjectName);
    materialization = materializeProject(sourceProject, target, projectMode);
    const projectEntry = {
      name: normalizedProjectName,
      path: target,
      source: projectMode,
      originPath: sourceProject,
    };
    managedProjects = managedProjects.filter((row) => String(row.name || '') !== normalizedProjectName);
    managedProjects.push(projectEntry);
  }

  const now = new Date().toISOString();
  const subconsciousEnabled = parseOptionalBool(args.subconsciousEnabled, type === 'claude');
  const manifest = {
    id: paths.agentId,
    name,
    type,
    agentModelVersion: '1.0',
    layoutVersion: 1,
    homeDir: paths.homeDir,
    workdir: paths.workdir,
    stateDir: paths.stateDir,
    subconsciousEnabled,
    managedProjects,
    human: {
      owner: existing?.human?.owner ?? null,
      notes: existing?.human?.notes ?? '',
      projectScope: existing?.human?.projectScope ?? '',
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const workspaceSync = ensureDocs(paths, manifest);

  writeFileSync(paths.agentJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  const legacyMetaPath = syncLegacyMeta(homeRoot, {
    ...manifest,
    agentJsonPath: paths.agentJsonPath,
  });
  const lettaPath = ensureLettaState(paths, subconsciousEnabled, `${paths.agentId}:${name}`, name);
  const subconsciousRuntime = configureSubconscious(paths, manifest);

  console.log(JSON.stringify({
    ok: true,
    name,
    type,
    homeRoot,
    paths,
    manifestPath: paths.agentJsonPath,
    subconsciousEnabled,
    workspaceSync,
    legacyMetaPath,
    lettaPath,
    subconsciousRuntime,
    materialization,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
