#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findV1ManifestByName, readV1AgentManifest } from '../lib/agent-home-v1.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');
const PROVISION_SCRIPT = path.join(__dirname, 'provision-v1-agent-home.js');

function usage() {
  console.log(`Usage:
  agentchat project add <agent> <path> [--mode copy|symlink]
  agentchat project remove <agent> <project>
  agentchat project list <agent>`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
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
    task: manifest?.task || null,
    runtimeProfile: manifest?.runtimeProfile || null,
  };
  ensureDir(path.dirname(metaPath));
  writeFileSync(metaPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  return metaPath;
}

function isSubpathOf(parentDir, candidatePath) {
  const parent = path.resolve(String(parentDir || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  if (!parent || !candidate) return false;
  const rel = path.relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function removeManagedProjectPath(projectPath) {
  if (!existsSync(projectPath)) return 'already-missing';
  const stat = lstatSync(projectPath);
  if (stat.isSymbolicLink()) {
    unlinkSync(projectPath);
    return 'unlinked';
  }
  if (stat.isDirectory()) {
    rmSync(projectPath, { recursive: true, force: false });
    return 'removed-directory';
  }
  unlinkSync(projectPath);
  return 'removed-file';
}

function loadManifest(agentName) {
  const manifest = findV1ManifestByName(agentName, process.env);
  if (!manifest?.homeDir || !manifest?.workdir || !manifest?.agentJsonPath) {
    fail(`v1 agent manifest not found for '${agentName}'`);
  }
  return manifest;
}

function homeRootFromManifest(manifest) {
  return path.dirname(path.dirname(manifest.homeDir));
}

function runProvisionForManifest(manifest, options = {}) {
  const homeRoot = homeRootFromManifest(manifest);
  const args = [
    PROVISION_SCRIPT,
    '--name', manifest.name,
    '--type', manifest.type || 'claude',
    '--agent-id', manifest.id,
    '--home', homeRoot,
    '--subconscious-enabled', manifest.subconsciousEnabled === true ? 'true' : 'false',
    '--project', options.projectPath,
    '--project-mode', options.projectMode,
  ];
  if (options.projectName) {
    args.push('--project-name', options.projectName);
  }
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        AGENTCHAT_HOMEDIR: homeRoot,
      },
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    fail(stderr || stdout || error?.message || 'project add failed');
  }
}

function formatProject(project) {
  const bits = [
    String(project?.name || '').trim(),
    String(project?.source || 'unknown').trim() || 'unknown',
    String(project?.path || '').trim(),
  ];
  const origin = String(project?.originPath || '').trim();
  if (origin) bits.push(origin);
  return bits.join('\t');
}

function parseMode(raw) {
  const mode = String(raw || 'copy').trim().toLowerCase();
  if (mode !== 'copy' && mode !== 'symlink') {
    fail('mode must be copy or symlink');
  }
  return mode;
}

function writeManifest(manifestPath, manifest) {
  ensureDir(path.dirname(manifestPath));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function commandAdd(argv) {
  const agentName = String(argv[0] || '').trim();
  const sourcePath = String(argv[1] || '').trim();
  if (!agentName || !sourcePath) {
    usage();
    process.exit(1);
  }
  let mode = 'copy';
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mode' && argv[i + 1]) {
      mode = parseMode(argv[i + 1]);
      i += 1;
      continue;
    }
    fail(`unknown argument for add: ${token}`);
  }

  const manifest = loadManifest(agentName);
  const sourceAbs = path.resolve(sourcePath);
  const provisionPayload = runProvisionForManifest(manifest, {
    projectPath: sourceAbs,
    projectMode: mode,
  });
  const next = readV1AgentManifest(manifest.agentJsonPath);
  if (!next) fail('project add completed but manifest reload failed');
  const added = Array.isArray(next.managedProjects) ? next.managedProjects[next.managedProjects.length - 1] : null;
  if (!added) fail('project add completed but managedProjects is empty');

  console.log(`Added project ${added.name} to ${next.name}`);
  console.log(formatProject(added));
  if (provisionPayload?.materialization) {
    console.log(`materialization\t${provisionPayload.materialization}`);
  }
}

function commandList(argv) {
  const agentName = String(argv[0] || '').trim();
  if (!agentName) {
    usage();
    process.exit(1);
  }
  const manifest = loadManifest(agentName);
  const projects = Array.isArray(manifest.managedProjects) ? manifest.managedProjects : [];
  if (projects.length === 0) {
    console.log(`No managed projects for ${manifest.name}.`);
    return;
  }
  for (const project of projects) {
    console.log(formatProject(project));
  }
}

function commandRemove(argv) {
  const agentName = String(argv[0] || '').trim();
  const projectName = String(argv[1] || '').trim();
  if (!agentName || !projectName) {
    usage();
    process.exit(1);
  }

  const manifest = loadManifest(agentName);
  const projects = Array.isArray(manifest.managedProjects) ? manifest.managedProjects : [];
  const target = projects.find((row) => String(row?.name || '') === projectName);
  if (!target) {
    fail(`managed project '${projectName}' not found for '${agentName}'`);
  }

  const projectRoot = path.join(manifest.workdir, 'projects');
  const fileAction = isSubpathOf(projectRoot, target.path)
    ? removeManagedProjectPath(target.path)
    : 'untracked-only';
  const next = {
    ...manifest,
    managedProjects: projects.filter((row) => String(row?.name || '') !== projectName),
    updatedAt: new Date().toISOString(),
  };
  writeManifest(manifest.agentJsonPath, next);
  syncLegacyMeta(homeRootFromManifest(manifest), next);

  console.log(`Removed project ${projectName} from ${manifest.name}`);
  console.log(`fileAction\t${fileAction}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    return;
  }
  if (command === 'add') {
    commandAdd(rest);
    return;
  }
  if (command === 'list') {
    commandList(rest);
    return;
  }
  if (command === 'remove') {
    commandRemove(rest);
    return;
  }
  fail(`unknown project command: ${command}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  fail(error?.message || String(error));
}
