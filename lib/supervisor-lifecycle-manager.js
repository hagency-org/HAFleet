// SupervisorLifecycleManager — wake-on-main lifecycle for per-agent supervisor agents.
//
// Manages WHEN supervisor agents run (tmux sessions), not WHAT they do.
// Target agent active → start supervisor. Target idles → trailing window → kill supervisor.

import { execFileSync } from 'child_process';
import { existsSync, accessSync, constants as fsConstants } from 'fs';
import path from 'path';
import { resolveV1ManifestForAgent } from './agent-home-v1.js';
import { assertSafeLaunchExtraArgs, defaultLaunchArgs } from './agent-launch-policy.js';

const DEFAULT_TRAILING_PERIODS = 3;
const DEFAULT_HEARTBEAT_TTL_MS = 120_000;
const SUPERVISOR_INIT_PROMPT = 'Read your AGENTS.md and begin your assessment cycle now.';

// --- tmux helpers ---

function tmuxSessionExists(sessionName) {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${sessionName}`], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function tmuxPanePath(sessionName) {
  try {
    return execFileSync('tmux', ['display-message', '-p', '-t', `=${sessionName}:0.0`, '#{pane_current_path}'], {
      timeout: 2000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function killTmuxSession(sessionName) {
  try {
    execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function listTmuxSessions() {
  try {
    const raw = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

function startTmuxSession(sessionName, workspaceDir, command) {
  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', workspaceDir], {
    timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('tmux', ['send-keys', '-t', `${sessionName}:0.0`, command, 'C-m'], {
    timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
  });
}

// --- framework helpers ---

function normalizeOptionalText(value, maxLen = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? (trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed) : null;
}

function normalizeFramework(value) {
  const raw = normalizeOptionalText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return (lower === 'claude' || lower === 'codex') ? lower : null;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function frameworkBinaryName(framework) {
  if (framework === 'claude') return 'claude';
  if (framework === 'codex') return 'codex';
  return null;
}

function binaryExistsOnPath(binaryName) {
  const name = normalizeOptionalText(binaryName, 128);
  if (!name) return false;
  const pathEnv = process.env.PATH || '';
  for (const entry of pathEnv.split(path.delimiter)) {
    const dir = String(entry || '').trim();
    if (!dir) continue;
    const fullPath = path.join(dir, name);
    try {
      if (existsSync(fullPath)) { accessSync(fullPath, fsConstants.X_OK); return true; }
    } catch { /* not executable */ }
  }
  return false;
}

function buildLaunchSelection(runtimeProfile) {
  const supervisor = runtimeProfile?.supervisor || null;
  const primary = runtimeProfile?.primary || null;
  const selected = supervisor || primary || null;
  const profileSource = supervisor ? 'runtimeProfile.supervisor'
    : (primary ? 'runtimeProfile.primary-fallback' : 'env/default');
  const selectedFrameworkRaw = normalizeOptionalText(selected?.framework, 32);
  const envFramework = normalizeFramework(process.env.HAFLEET_SUPERVISOR_FRAMEWORK);
  const framework = selectedFrameworkRaw
    ? (normalizeFramework(selectedFrameworkRaw) || selectedFrameworkRaw.toLowerCase())
    : (envFramework || 'claude');
  const provider = normalizeOptionalText(selected?.provider, 64)
    || normalizeOptionalText(process.env.SUPERVISOR_LLM_PROVIDER, 64)
    || 'anthropic';
  const model = normalizeOptionalText(selected?.model, 256)
    || normalizeOptionalText(process.env.SUPERVISOR_LLM_MODEL, 256)
    || null;
  const reasoning = normalizeOptionalText(selected?.reasoning, 64)
    || normalizeOptionalText(process.env.HAFLEET_SUPERVISOR_REASONING_PROFILE, 64)
    || null;
  const extraArgs = normalizeOptionalText(selected?.extraArgs, 4000)
    || normalizeOptionalText(process.env.HAFLEET_SUPERVISOR_EXTRA_ARGS, 4000)
    || null;
  return { profileSource, framework, provider, model, reasoning, extraArgs };
}

function buildLaunchCommand(targetAgent, workspaceDir, selection, runtimeProfile) {
  const extraArgTokens = assertSafeLaunchExtraArgs(selection.framework, selection.extraArgs);
  const permissionMetadata = selection.framework === 'claude'
    ? [`HAFLEET_AGENT_PERMISSION_MODE=${shellQuote('auto')}`]
    : (selection.framework === 'codex' ? [
      `HAFLEET_AGENT_PERMISSION_LEVEL=${shellQuote('2')}`,
      `HAFLEET_AGENT_SANDBOX_MODE=${shellQuote('workspace-write')}`,
      `HAFLEET_AGENT_APPROVAL_POLICY=${shellQuote('on-request')}`,
    ] : []);
  const envPrefix = [
    `PATH=${shellQuote(process.env.PATH || '')}`,
    `HAFLEET_AGENT_SANDBOX=${shellQuote('1')}`,
    ...permissionMetadata,
    `HAFLEET_API=${shellQuote(process.env.HAFLEET_API || '')}`,
    `HAFLEET_BACKEND_PORT=${shellQuote(process.env.HAFLEET_BACKEND_PORT || '')}`,
    `HAFLEET_SUPERVISED_AGENT_NAME=${shellQuote(targetAgent)}`,
    `HAFLEET_SUPERVISOR_WORKSPACE=${shellQuote(workspaceDir)}`,
    `HAFLEET_SUPERVISOR_PROFILE_SOURCE=${shellQuote(selection.profileSource)}`,
    `HAFLEET_SUPERVISOR_FRAMEWORK=${shellQuote(selection.framework)}`,
    `SUPERVISOR_LLM_PROVIDER=${shellQuote(selection.provider || '')}`,
    `SUPERVISOR_LLM_MODEL=${shellQuote(selection.model || '')}`,
    `HAFLEET_SUPERVISOR_REASONING_PROFILE=${shellQuote(selection.reasoning || '')}`,
    `HAFLEET_SUPERVISOR_EXTRA_ARGS=${shellQuote(selection.extraArgs || '')}`,
    `HAFLEET_RUNTIME_PROFILE_PRIMARY_JSON=${shellQuote(JSON.stringify(runtimeProfile?.primary || null))}`,
    `HAFLEET_RUNTIME_PROFILE_SUPERVISOR_JSON=${shellQuote(JSON.stringify(runtimeProfile?.supervisor || null))}`,
  ].join(' ');
  if (selection.framework === 'claude') {
    const parts = ['claude', ...defaultLaunchArgs('claude')];
    if (selection.model) parts.push('--model', shellQuote(selection.model));
    if (extraArgTokens.length > 0) parts.push(...extraArgTokens.map(shellQuote));
    parts.push('--', shellQuote(SUPERVISOR_INIT_PROMPT));
    return `${envPrefix} ${parts.join(' ')}`;
  }
  if (selection.framework === 'codex') {
    const parts = ['codex', ...defaultLaunchArgs('codex')];
    if (selection.model) parts.push('--model', shellQuote(selection.model));
    if (extraArgTokens.length > 0) parts.push(...extraArgTokens.map(shellQuote));
    parts.push('-C', shellQuote(workspaceDir));
    parts.push('--', shellQuote(SUPERVISOR_INIT_PROMPT));
    return `${envPrefix} ${parts.join(' ')}`;
  }
  return null;
}

function requiredCredentialEnvName(selection) {
  const provider = normalizeOptionalText(selection?.provider, 64);
  if (!provider) return null;
  const normalized = provider.toLowerCase();
  if (!['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(normalized)) return null;
  return 'SUPERVISOR_LLM_KEY';
}

function normalizeRuntimeProfileRole(value) {
  if (!value || typeof value !== 'object') return null;
  const framework = normalizeOptionalText(value.framework, 32);
  const provider = normalizeOptionalText(value.provider, 64);
  const model = normalizeOptionalText(value.model, 256);
  const reasoning = normalizeOptionalText(value.reasoning, 64);
  const extraArgs = normalizeOptionalText(value.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return { framework: framework || null, provider: provider || null, model: model || null, reasoning: reasoning || null, ...(extraArgs ? { extraArgs } : {}) };
}

function normalizeRuntimeProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const primary = normalizeRuntimeProfileRole(value.primary);
  const supervisor = normalizeRuntimeProfileRole(value.supervisor);
  if (!primary && !supervisor) return null;
  return { primary: primary || null, supervisor: supervisor || null };
}

// --- Lifecycle Manager ---

export function createSupervisorLifecycleManager({
  getAgents,
  getRuntime,
  snapshotStore,
  isAgentRecord,
  broadcastSSE,
}) {
  const trailingPeriods = parseInt(process.env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS || String(DEFAULT_TRAILING_PERIODS), 10);
  const heartbeatTtlMs = parseInt(process.env.SUPERVISOR_HEARTBEAT_TTL_MS || String(DEFAULT_HEARTBEAT_TTL_MS), 10);
  const trailingWindowMs = heartbeatTtlMs * trailingPeriods;

  // Track when each target agent last went idle (for trailing window)
  const idleSince = {}; // targetAgent → timestamp

  function isTargetActive(targetAgent) {
    const runtime = getRuntime(targetAgent);
    if (!runtime) return false;
    return runtime.activeNow === true;
  }

  /**
   * Reconcile a single supervisor agent's lifecycle.
   * Returns a result object describing the action taken.
   */
  function reconcile(targetAgent, now = Date.now()) {
    const supervisorName = `supervisor-${targetAgent}`;
    const agents = getAgents();

    // Only manage agents that have a registered supervisor
    if (!isAgentRecord(agents[supervisorName])) {
      return { target: targetAgent, action: 'skip', reason: 'no-supervisor-registered' };
    }

    // Kill switch
    if (!snapshotStore.isEnabled()) {
      const sessionExists = tmuxSessionExists(supervisorName);
      if (sessionExists) {
        killTmuxSession(supervisorName);
        snapshotStore.clearLease(targetAgent);
        return { target: targetAgent, action: 'stopped', reason: 'kill-switch-disabled' };
      }
      return { target: targetAgent, action: 'idle', reason: 'kill-switch-disabled' };
    }

    const targetActive = isTargetActive(targetAgent);
    const sessionExists = tmuxSessionExists(supervisorName);

    // Wake-on-main: target active → supervisor should be running
    if (targetActive) {
      delete idleSince[targetAgent];
    } else {
      // Target is idle — start or continue trailing window
      if (!idleSince[targetAgent]) {
        idleSince[targetAgent] = now;
      }
      const idleDuration = now - idleSince[targetAgent];
      if (idleDuration > trailingWindowMs) {
        // Trailing expired → kill supervisor
        if (sessionExists) {
          killTmuxSession(supervisorName);
          snapshotStore.clearLease(targetAgent);
          if (broadcastSSE) {
            broadcastSSE('supervisor_lifecycle', { type: 'stopped', target: targetAgent, supervisor: supervisorName, reason: 'trailing-expired', ts: now });
          }
          return { target: targetAgent, action: 'stopped', reason: 'trailing-expired' };
        }
        return { target: targetAgent, action: 'idle', reason: 'trailing-expired' };
      }
      // Still in trailing window — keep supervisor running if it exists
      if (sessionExists) {
        return { target: targetAgent, action: 'trailing', reason: 'target-idle-trailing', remainingMs: trailingWindowMs - idleDuration };
      }
      // Supervisor not running during trailing — don't start one now
      return { target: targetAgent, action: 'idle', reason: 'target-idle-no-session' };
    }

    // Target is active — ensure supervisor is running

    // === RUNTIME CHECKS (§12) ===

    // 1. Workspace exists?
    const targetAgentRecord = agents[targetAgent] || null;
    const manifest = resolveV1ManifestForAgent(supervisorName, agents[supervisorName] || null);
    const workdir = manifest?.workdir;
    if (!manifest || !workdir || !existsSync(workdir)) {
      return { target: targetAgent, action: 'failed', reason: 'missing-workspace', error: `missing v1 workspace for ${supervisorName}` };
    }

    // 2. Build launch selection from target agent's runtimeProfile
    const runtimeProfile = normalizeRuntimeProfile(targetAgentRecord?.runtimeProfile);
    const selection = buildLaunchSelection(runtimeProfile);

    // 3. Framework binary on PATH?
    const binaryName = frameworkBinaryName(selection.framework);
    if (!binaryExistsOnPath(binaryName)) {
      return { target: targetAgent, action: 'failed', reason: 'missing-binary', error: `missing binary: ${binaryName}` };
    }

    // 4. Required credentials present?
    const credEnv = requiredCredentialEnvName(selection);
    if (credEnv && !process.env[credEnv]) {
      return { target: targetAgent, action: 'failed', reason: 'missing-credential-env', error: `missing env: ${credEnv}` };
    }

    // 5. Build launch command (validates framework is supported)
    let command;
    try {
      command = buildLaunchCommand(targetAgent, workdir, selection, runtimeProfile);
    } catch (error) {
      if (error?.code === 'unsafe_launch_extra_args') {
        return { target: targetAgent, action: 'failed', reason: 'unsafe-extra-args', error: error.message };
      }
      throw error;
    }
    if (!command) {
      return { target: targetAgent, action: 'failed', reason: 'unsupported-framework', error: `unsupported: ${selection.framework}` };
    }

    // 6. Path mismatch detection
    const currentPath = sessionExists ? tmuxPanePath(supervisorName) : null;
    const pathMismatch = sessionExists && workdir && currentPath
      && path.resolve(currentPath) !== path.resolve(workdir);

    // === LAUNCH / KEEP / RESTART ===

    try {
      if (sessionExists && !pathMismatch) {
        return { target: targetAgent, action: 'kept', reason: 'session-exists' };
      }
      if (sessionExists && pathMismatch) {
        killTmuxSession(supervisorName);
      }
      startTmuxSession(supervisorName, workdir, command);
      snapshotStore.renewLease(targetAgent, supervisorName);
      const action = pathMismatch ? 'restarted' : 'started';
      if (broadcastSSE) {
        broadcastSSE('supervisor_lifecycle', { type: action, target: targetAgent, supervisor: supervisorName, ts: now });
      }
      return { target: targetAgent, action, reason: pathMismatch ? 'path-mismatch' : 'target-active' };
    } catch (e) {
      return { target: targetAgent, action: 'failed', reason: 'tmux-launch-failed', error: String(e?.message || e) };
    }
  }

  /**
   * Sweep all agents that have a registered supervisor.
   * Called from backend's sweep loop.
   */
  function sweepAll(now = Date.now()) {
    const agents = getAgents();
    const results = [];
    for (const name of Object.keys(agents)) {
      // Only target agents (not supervisors themselves)
      if (name.startsWith('supervisor-')) continue;
      if (!isAgentRecord(agents[name])) continue;
      // Check if this agent has a supervisor
      const supervisorName = `supervisor-${name}`;
      if (!isAgentRecord(agents[supervisorName])) continue;
      results.push(reconcile(name, now));
    }
    return results;
  }

  /**
   * Kill orphan supervisor-* tmux sessions that have no registered target agent.
   * Called once at startup.
   */
  function cleanOrphanSessions() {
    const agents = getAgents();
    const sessions = listTmuxSessions();
    const killed = [];
    for (const session of sessions) {
      if (!session.startsWith('supervisor-')) continue;
      const targetAgent = session.slice('supervisor-'.length);
      // Keep if target agent exists AND supervisor agent is registered
      if (isAgentRecord(agents[targetAgent]) && isAgentRecord(agents[session])) continue;
      killTmuxSession(session);
      killed.push(session);
    }
    return killed;
  }

  return { reconcile, sweepAll, cleanOrphanSessions };
}

// Re-export tmux helpers for testing
export {
  buildLaunchCommand,
  buildLaunchSelection,
  tmuxSessionExists,
  killTmuxSession,
  startTmuxSession,
  tmuxPanePath,
  listTmuxSessions,
};
