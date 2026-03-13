// Supervisor agent provisioning — creates supervisor agent home for a target agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildV1AgentPaths, defaultAgentchatHomeDir } from './agent-home-v1.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUPERVISOR_AGENT_AGENTS_TEMPLATE_PATH = path.join(__dirname, '..', 'docs', 'workspace-supervisor-agent-agents-template.md');

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function renderSupervisorAgentTemplate(template, vars) {
  return template
    .replaceAll('{{SUPERVISOR_NAME}}', vars.supervisorName)
    .replaceAll('{{TARGET_AGENT}}', vars.targetAgent)
    .replaceAll('{{TARGET_TMUX_SESSION}}', vars.targetTmuxSession)
    .replaceAll('{{TARGET_WORKSPACE_PATH}}', vars.targetWorkspacePath);
}

/**
 * Provision a supervisor agent home for a target agent.
 * Creates directory structure, AGENTS.md from template, agent-token, and agent.json manifest.
 *
 * @param {string} targetAgent - The target agent name (e.g. 'ac-topleader')
 * @param {object} opts
 * @param {string} [opts.targetTmux] - Target agent's tmux session name
 * @param {string} [opts.targetWorkdir] - Target agent's workdir path
 * @returns {{ supervisorName, paths, tokenGenerated, agentsWritten }} result
 */
export function provisionSupervisorAgent(targetAgent, opts = {}) {
  const supervisorName = `supervisor-${targetAgent}`;
  const paths = buildV1AgentPaths(supervisorName);
  if (!paths) {
    throw new Error(`cannot build paths for supervisor agent: ${supervisorName}`);
  }

  // Create directory structure
  ensureDir(paths.homeDir);
  ensureDir(paths.stateDir);
  ensureDir(path.join(paths.stateDir, 'locks'));
  ensureDir(paths.workdir);
  ensureDir(paths.docsDir);

  // Generate agent-token if missing
  const agentTokenPath = path.join(paths.stateDir, 'agent-token');
  let tokenGenerated = false;
  if (!existsSync(agentTokenPath)) {
    writeFileSync(agentTokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    tokenGenerated = true;
  }

  // Write AGENTS.md from supervisor agent template
  const targetTmuxSession = opts.targetTmux || targetAgent;
  const targetWorkspacePath = opts.targetWorkdir || '';
  let agentsWritten = false;
  if (existsSync(SUPERVISOR_AGENT_AGENTS_TEMPLATE_PATH)) {
    const template = readFileSync(SUPERVISOR_AGENT_AGENTS_TEMPLATE_PATH, 'utf-8');
    const rendered = renderSupervisorAgentTemplate(template, {
      supervisorName,
      targetAgent,
      targetTmuxSession,
      targetWorkspacePath,
    });
    const agentsPath = path.join(paths.workdir, 'AGENTS.md');
    // Only write if not already customized
    if (!existsSync(agentsPath)) {
      writeFileSync(agentsPath, rendered, 'utf-8');
      agentsWritten = true;
    }
  }

  // Write agent.json manifest
  const now = new Date().toISOString();
  const manifestPath = paths.agentJsonPath;
  let existing = null;
  if (existsSync(manifestPath)) {
    try { existing = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* ignore */ }
  }
  const manifest = {
    id: paths.agentId,
    name: supervisorName,
    type: 'claude',
    agentModelVersion: '1.0',
    layoutVersion: 1,
    homeDir: paths.homeDir,
    workdir: paths.workdir,
    stateDir: paths.stateDir,
    subconsciousEnabled: false,
    supervisorFor: targetAgent,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  // Copy supervisor-writer script link
  const supervisorWriterSrc = path.join(__dirname, '..', 'scripts', 'write-supervisor-state.js');
  const supervisorWriterDst = path.join(paths.workdir, 'supervisor-writer');
  if (!existsSync(supervisorWriterDst) && existsSync(supervisorWriterSrc)) {
    const wrapperContent = `#!/usr/bin/env bash\nexec node "${supervisorWriterSrc}" "$@"\n`;
    writeFileSync(supervisorWriterDst, wrapperContent, { mode: 0o755 });
  }

  return {
    supervisorName,
    paths,
    tokenGenerated,
    agentsWritten,
  };
}

/**
 * Read the generated agent-token for a supervisor agent.
 */
export function readSupervisorToken(supervisorName) {
  const paths = buildV1AgentPaths(supervisorName);
  if (!paths) return null;
  const tokenPath = path.join(paths.stateDir, 'agent-token');
  try {
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Build the agent registry record for a provisioned supervisor agent.
 */
export function buildSupervisorAgentRecord(supervisorName, targetAgent) {
  const paths = buildV1AgentPaths(supervisorName);
  if (!paths) return null;
  return {
    name: supervisorName,
    type: 'agent',
    kind: 'agent',
    online: false,
    role: `Focus and task-alignment supervisor for ${targetAgent}`,
    identity: `Supervisor agent monitoring ${targetAgent}`,
    homeDir: paths.homeDir,
    workdir: paths.workdir,
    stateDir: paths.stateDir,
    registeredAt: Date.now(),
  };
}
