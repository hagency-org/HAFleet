import { existsSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

function normalizeAbsolutePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  return path.isAbsolute(resolved) ? resolved : null;
}

function normalizeAgentId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return normalized || null;
}

function normalizeAgentName(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

export function defaultAgentchatHomeDir(env = process.env) {
  // Explicit AGENTCHAT_HOMEDIR always wins.
  const explicit = String(env?.AGENTCHAT_HOMEDIR || '').trim();
  if (explicit) return path.resolve(explicit);
  // v1.1: when AGENT_CHAT_RUNTIME_DIR is set, place homes under it for dev/live isolation.
  const runtimeDir = String(env?.AGENT_CHAT_RUNTIME_DIR || '').trim();
  if (runtimeDir) return path.resolve(runtimeDir, 'homes');
  return path.resolve(os.homedir(), '.agentchat');
}

// Returns deduped list of all agent home roots to search (new default + legacy fallback).
// Used for token loading, manifest lookup, and orphan discovery to maintain v1.0 compat.
export function allAgentHomeRoots(env = process.env) {
  const primary = defaultAgentchatHomeDir(env);
  const legacy = path.resolve(os.homedir(), '.agentchat');
  const roots = [primary];
  if (legacy !== primary) roots.push(legacy);
  return roots;
}

export function v1AgentIdFromName(name) {
  const normalized = normalizeAgentId(name);
  return normalized ? `agent_${normalized}` : null;
}

export function buildV1AgentPaths(agentName, env = process.env, explicitAgentId = null) {
  const name = normalizeAgentName(agentName);
  if (!name) return null;
  const agentId = normalizeAgentId(explicitAgentId) || v1AgentIdFromName(name);
  if (!agentId) return null;
  const homeRoot = defaultAgentchatHomeDir(env);
  const homeDir = path.join(homeRoot, 'agents', agentId);
  const stateDir = path.join(homeDir, 'state');
  const workdir = path.join(homeDir, 'workdir');
  return {
    homeRoot,
    agentId,
    homeDir,
    stateDir,
    workdir,
    docsDir: path.join(workdir, 'docs'),
    projectsDir: path.join(workdir, 'projects'),
    supervisorDir: path.join(homeDir, 'supervisor'),
    supervisorDocsDir: path.join(homeDir, 'supervisor', 'docs'),
    taskWriterPath: path.join(workdir, 'task-writer'),
    agentJsonPath: path.join(homeDir, 'agent.json'),
  };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeManagedProjects(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name || '').trim();
    const projectPath = normalizeAbsolutePath(row.path);
    if (!name || !projectPath) continue;
    const key = `${name}\n${projectPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      path: projectPath,
      source: String(row.source || '').trim() || 'unknown',
      originPath: normalizeAbsolutePath(row.originPath) || null,
    });
  }
  return out;
}

function normalizeOptionalText(raw, maxLen = 4000) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeIsoTimestamp(raw) {
  const text = normalizeOptionalText(raw, 128);
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTaskStatus(raw) {
  const text = normalizeOptionalText(raw, 32);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (['active', 'waiting', 'blocked', 'done'].includes(lower)) return lower;
  return null;
}

function normalizeTask(raw, fallbackOwner = null) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return null;
  const status = normalizeTaskStatus(raw.status);
  if (!status) return null;
  const id = normalizeOptionalText(raw.id, 256);
  const owner = normalizeAgentName(raw.owner) || normalizeAgentName(fallbackOwner) || normalizeOptionalText(raw.owner, 128);
  const updatedAt = normalizeIsoTimestamp(raw.updated_at);
  const heartbeatAt = normalizeIsoTimestamp(raw.heartbeat_at);
  const waitingReason = normalizeOptionalText(raw.waiting_reason, 2000);
  const waitingUntil = normalizeIsoTimestamp(raw.waiting_until);
  if (!id || !owner || !updatedAt || !heartbeatAt) return null;
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

function normalizeRuntimeProfileRole(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return null;
  const framework = normalizeOptionalText(raw.framework, 32);
  const provider = normalizeOptionalText(raw.provider, 64);
  const model = normalizeOptionalText(raw.model, 256);
  const reasoning = normalizeOptionalText(raw.reasoning, 64);
  const extraArgs = normalizeOptionalText(raw.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
  };
}

function normalizeRuntimeProfile(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return null;
  const primary = normalizeRuntimeProfileRole(raw.primary);
  const supervisor = normalizeRuntimeProfileRole(raw.supervisor);
  if (!primary && !supervisor) return null;
  return {
    primary: primary || null,
    supervisor: supervisor || null,
  };
}

function normalizeManifest(raw, manifestPath = null) {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeAgentName(raw.name);
  const id = normalizeAgentId(raw.id) || v1AgentIdFromName(name || '');
  const homeDir = normalizeAbsolutePath(raw.homeDir);
  const stateDir = normalizeAbsolutePath(raw.stateDir);
  const workdir = normalizeAbsolutePath(raw.workdir);
  if (!name || !id || !homeDir || !stateDir || !workdir) return null;

  const agentModelVersion = String(raw.agentModelVersion || '').trim() || '1.0';
  const layoutVersionRaw = Number.parseInt(raw.layoutVersion, 10);
  const layoutVersion = Number.isFinite(layoutVersionRaw) && layoutVersionRaw > 0 ? layoutVersionRaw : 1;
  const type = String(raw.type || '').trim() || 'claude';
  const subconsciousEnabled = raw.subconsciousEnabled === true;

  return {
    ...raw,
    id,
    name,
    type,
    agentModelVersion,
    layoutVersion,
    homeDir,
    stateDir,
    workdir,
    subconsciousEnabled,
    managedProjects: normalizeManagedProjects(raw.managedProjects),
    human: (raw.human && typeof raw.human === 'object') ? raw.human : {},
    task: normalizeTask(raw.task, name),
    runtimeProfile: normalizeRuntimeProfile(raw.runtimeProfile),
    agentJsonPath: manifestPath || null,
  };
}

export function readV1AgentManifest(manifestPath) {
  const abs = normalizeAbsolutePath(manifestPath);
  if (!abs || !existsSync(abs)) return null;
  const raw = safeReadJson(abs);
  return normalizeManifest(raw, abs);
}

export function findV1ManifestByName(agentName, env = process.env) {
  const needle = normalizeAgentName(agentName);
  if (!needle) return null;
  const lower = needle.toLowerCase();
  for (const homeRoot of allAgentHomeRoots(env)) {
    const agentsRoot = path.join(homeRoot, 'agents');
    if (!existsSync(agentsRoot)) continue;
    let entries = [];
    try {
      entries = readdirSync(agentsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(agentsRoot, entry.name, 'agent.json');
      const manifest = readV1AgentManifest(manifestPath);
      if (!manifest) continue;
      if (manifest.name.toLowerCase() === lower) return manifest;
    }
  }
  return null;
}

export function resolveV1ManifestForAgent(agentName, meta = null, env = process.env) {
  const manifestByName = findV1ManifestByName(agentName, env);
  if (manifestByName) return manifestByName;
  if (meta && typeof meta === 'object') {
    const homeDir = normalizeAbsolutePath(meta.homeDir);
    if (homeDir) {
      const manifestPath = path.join(homeDir, 'agent.json');
      const manifest = readV1AgentManifest(manifestPath);
      if (manifest && String(manifest.name || '').trim().toLowerCase() === String(agentName || '').trim().toLowerCase()) {
        return manifest;
      }
    }
  }
  return null;
}

function pickAgentsFile(root, preferredUpper = false) {
  const upper = path.join(root, 'AGENTS.md');
  const lower = path.join(root, 'agents.md');
  if (preferredUpper) {
    if (existsSync(upper)) return upper;
    if (existsSync(lower)) return lower;
    return upper;
  }
  if (existsSync(lower)) return lower;
  if (existsSync(upper)) return upper;
  return lower;
}

function pushCandidate(candidates, seen, root, preferredUpper = false) {
  const abs = normalizeAbsolutePath(root);
  if (!abs) return;
  if (seen.has(abs)) return;
  seen.add(abs);
  candidates.push({ root: abs, preferredUpper: preferredUpper === true });
}

export function resolveAgentDocsPaths(agentName, workspacePath, options = {}) {
  const cwd = normalizeAbsolutePath(options.cwd || process.cwd()) || process.cwd();
  const v1Manifest = options.v1Manifest || null;
  const docsRootOverride = normalizeAbsolutePath(options.docsRootOverride);
  const includeWorkspaceFlatDocs = options.includeWorkspaceFlatDocs === true;

  const seen = new Set();
  const candidates = [];
  if (docsRootOverride) pushCandidate(candidates, seen, path.join(docsRootOverride, agentName), false);
  if (v1Manifest?.workdir) pushCandidate(candidates, seen, path.join(v1Manifest.workdir, 'docs'), true);
  if (workspacePath) pushCandidate(candidates, seen, path.join(workspacePath, 'docs', agentName), false);
  if (workspacePath && includeWorkspaceFlatDocs) {
    pushCandidate(candidates, seen, path.join(workspacePath, 'docs'), true);
  }
  pushCandidate(candidates, seen, path.join(cwd, 'docs', agentName), false);

  for (const candidate of candidates) {
    const agentsPath = pickAgentsFile(candidate.root, candidate.preferredUpper);
    const planPath = path.join(candidate.root, 'plan.md');
    if (existsSync(agentsPath) || existsSync(planPath)) {
      return { docsRoot: candidate.root, agentsPath, planPath };
    }
  }

  const fallback = candidates[0] || { root: path.join(cwd, 'docs', agentName), preferredUpper: false };
  return {
    docsRoot: fallback.root,
    agentsPath: pickAgentsFile(fallback.root, fallback.preferredUpper),
    planPath: path.join(fallback.root, 'plan.md'),
  };
}
