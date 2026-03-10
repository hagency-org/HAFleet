import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { createHash } from 'crypto';
import { resolveAgentDocsPaths, resolveV1ManifestForAgent } from '../lib/agent-home-v1.js';

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function trimBlock(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractHeadingSection(markdown, heading) {
  const src = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const escaped = escapeRegExp(heading);
  const headingRe = new RegExp(`^#{1,6}\\s+${escaped}(?:\\s*$|\\s*[:()\\[\\]{}-]|\\s+[—–-])`, 'i');
  let start = -1;
  let headingLevel = 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/\s+#+\s*$/, '');
    if (headingRe.test(line)) {
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
  return trimBlock(body.join('\n'));
}

function loadMetaWorkspace(metaRoot, agentName) {
  const metaPath = path.join(metaRoot, agentName, 'meta.json');
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
      workspacePath: v1Manifest?.workdir || null,
      v1Manifest,
    };
  }
  try {
    const workspacePath = (typeof meta?.path === 'string' && meta.path.trim())
      ? meta.path.trim()
      : (v1Manifest?.workdir || null);
    return { metaPath, workspacePath, v1Manifest };
  } catch {
    return { metaPath, workspacePath: v1Manifest?.workdir || null, v1Manifest };
  }
}

function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

function loadServerSsh(pathValue) {
  try {
    if (!existsSync(pathValue)) return {};
    const parsed = JSON.parse(readFileSync(pathValue, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function capturePaneLocal(tmuxTarget, lines) {
  return execFileSync('tmux', ['capture-pane', '-t', tmuxTarget, '-p', '-S', `-${lines}`], {
    encoding: 'utf-8',
    timeout: 5000,
  });
}

function capturePaneRemote(host, tmuxTarget, lines) {
  const cmd = `tmux capture-pane -t ${tmuxTarget} -p -S -${lines}`;
  return execFileSync('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', host, cmd], {
    encoding: 'utf-8',
    timeout: 9000,
  });
}

function safeTmuxTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!/^[\w:.-]+$/.test(value)) return null;
  return value;
}

export function collectAgentContext(config, agentName, agentRecord, runtimeRecord) {
  const now = Date.now();
  const { workspacePath: rawMetaWorkspacePath, metaPath, v1Manifest } = loadMetaWorkspace(config.metaRoot, agentName);
  const metaWorkspacePath = normalizeWorkspacePath(rawMetaWorkspacePath);
  const runtimeWorkspacePath = normalizeWorkspacePath(runtimeRecord?.workspacePath);
  const effectiveWorkspacePath = metaWorkspacePath || runtimeWorkspacePath;
  const workspacePathMismatch = Boolean(metaWorkspacePath && runtimeWorkspacePath && metaWorkspacePath !== runtimeWorkspacePath);
  const workspacePathSource = metaWorkspacePath
    ? 'meta'
    : (runtimeWorkspacePath ? 'runtime-fallback' : 'none');
  const docsPaths = resolveAgentDocsPaths(agentName, effectiveWorkspacePath, {
    cwd: config.repoRoot || process.cwd(),
    docsRootOverride: config.docsRootOverride || null,
    v1Manifest,
  });

  const agentsDocRaw = readText(docsPaths.agentsPath);
  const planDocRaw = readText(docsPaths.planPath);
  const roleText = extractHeadingSection(agentsDocRaw, 'Role');
  const boundariesText = extractHeadingSection(agentsDocRaw, 'Boundaries');
  const currentTask = extractHeadingSection(planDocRaw, 'Current');

  const sshConfig = loadServerSsh(config.serverSshPath);
  const tmuxTarget = safeTmuxTarget(agentRecord?.tmux || `${agentName}:0.0`);

  let paneText = '';
  let paneError = null;
  let paneSource = 'local';

  if (!tmuxTarget) {
    paneError = 'invalid-tmux-target';
  } else {
    try {
      const server = String(agentRecord?.server || 'local').trim() || 'local';
      if (server !== 'local') {
        const ssh = sshConfig[server];
        if (ssh && typeof ssh.host === 'string' && ssh.host.trim()) {
          paneText = capturePaneRemote(ssh.host.trim(), tmuxTarget, config.paneLines);
          paneSource = `remote:${server}`;
        } else {
          paneError = `missing-ssh-config:${server}`;
        }
      } else {
        paneText = capturePaneLocal(tmuxTarget, config.paneLines);
      }
    } catch (e) {
      paneError = `capture-failed:${e.message}`;
    }
  }

  const paneNormalized = trimBlock(paneText);
  const paneHash = createHash('sha1').update(paneNormalized).digest('hex');

  return {
    ts: now,
    agent: agentName,
    workspacePath: effectiveWorkspacePath,
    workspacePathSource,
    workspacePathMeta: metaWorkspacePath,
    workspacePathRuntime: runtimeWorkspacePath,
    workspacePathMismatch,
    metaPath,
    docs: {
      docsRoot: docsPaths.docsRoot,
      agentsPath: docsPaths.agentsPath,
      planPath: docsPaths.planPath,
      roleText,
      boundariesText,
      currentTask,
      hasRole: !!roleText,
      hasBoundaries: !!boundariesText,
      hasCurrentTask: !!currentTask,
    },
    runtime: {
      blocked: runtimeRecord?.blocked === true,
      blockedReason: runtimeRecord?.blockedReason || null,
      activeNow: runtimeRecord?.activeNow === true,
      activeDurationSec: Number(runtimeRecord?.activeDurationSec) || 0,
      idleDurationSec: Number(runtimeRecord?.idleDurationSec) || 0,
    },
    pane: {
      target: tmuxTarget,
      source: paneSource,
      hash: paneHash,
      text: paneNormalized,
      error: paneError,
    },
  };
}
