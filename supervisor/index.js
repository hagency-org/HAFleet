import { accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { loadSupervisorConfig } from './config.js';
import { SupervisorStateStore } from './state.js';
import { collectAgentContext } from './collector.js';
import { LLMJudge } from './judge.js';
import { resolveV1ManifestForAgent } from '../lib/agent-home-v1.js';

function readJsonl(filePath, limit = 2000) {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return [];
    const rows = raw.trim().split('\n');
    const tail = rows.slice(-Math.max(1, limit));
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch (e) {
        console.debug(`[supervisor] jsonl parse skipped for ${filePath}: ${e.message}`);
      }
    }
    return parsed;
  } catch (e) {
    console.debug(`[supervisor] jsonl read skipped for ${filePath}: ${e.message}`);
    return [];
  }
}

function safeAppendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function hashInput(input) {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

function isNegative(status) {
  return status === 'stalled_wait' || status === 'suspected_eos';
}

function normalizeAgentAllowlist(input) {
  if (input === null) return null;
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function normalizeOptionalText(value, maxLen = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeIsoTimestamp(value) {
  const raw = normalizeOptionalText(value, 128);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTaskStatus(value) {
  const raw = normalizeOptionalText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['active', 'waiting', 'blocked', 'done'].includes(lower)) return lower;
  return null;
}

function normalizeTask(value, fallbackOwner = null) {
  if (!value || typeof value !== 'object') return null;
  const status = normalizeTaskStatus(value.status);
  if (!status) return null;
  const id = normalizeOptionalText(value.id, 256);
  const owner = normalizeOptionalText(value.owner, 128) || normalizeOptionalText(fallbackOwner, 128);
  const updatedAt = normalizeIsoTimestamp(value.updated_at);
  const heartbeatAt = normalizeIsoTimestamp(value.heartbeat_at);
  const waitingReason = normalizeOptionalText(value.waiting_reason, 2000);
  const waitingUntil = normalizeIsoTimestamp(value.waiting_until);
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

function normalizeRuntimeProfileRole(value) {
  if (!value || typeof value !== 'object') return null;
  const framework = normalizeOptionalText(value.framework, 32);
  const provider = normalizeOptionalText(value.provider, 64);
  const model = normalizeOptionalText(value.model, 256);
  const reasoning = normalizeOptionalText(value.reasoning, 64);
  const extraArgs = normalizeOptionalText(value.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
  };
}

function normalizeRuntimeProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const primary = normalizeRuntimeProfileRole(value.primary);
  const supervisor = normalizeRuntimeProfileRole(value.supervisor);
  if (!primary && !supervisor) return null;
  return {
    primary: primary || null,
    supervisor: supervisor || null,
  };
}

function isLocalAgentServer(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const localServerId = String(process.env.AGENT_CHAT_SERVER || 'local').trim() || 'local';
  return !raw || raw === 'local' || raw === localServerId;
}

function isoToMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function isRuntimeIdleObserved(runtime) {
  if (!runtime || typeof runtime !== 'object') return false;
  if (runtime.activeNow === true) return false;
  const idleDurationSec = Math.max(0, Number(runtime.idleDurationSec) || 0);
  return runtime.activeNow === false || idleDurationSec > 0;
}

function summarizeTaskLabel(task) {
  if (!task) return null;
  return `${task.id} (${task.status})`;
}

function normalizeFramework(value) {
  const raw = normalizeOptionalText(value, 32);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'claude' || lower === 'codex') return lower;
  return null;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function buildSupervisorSessionName(agentName) {
  const normalized = String(agentName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return `supervisor-${normalized || 'unknown'}`;
}

function tmuxSessionExists(sessionName) {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${sessionName}`], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch (e) {
    console.debug(`[supervisor] tmux session check skipped for ${sessionName}: ${e.message}`);
    return false;
  }
}

function tmuxPanePath(sessionName) {
  try {
    return execFileSync('tmux', ['display-message', '-p', '-t', `=${sessionName}:0.0`, '#{pane_current_path}'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (e) {
    console.debug(`[supervisor] tmux pane path lookup skipped for ${sessionName}: ${e.message}`);
    return null;
  }
}

function killTmuxSession(sessionName) {
  try {
    execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch (e) {
    console.debug(`[supervisor] tmux kill skipped for ${sessionName}: ${e.message}`);
    return false;
  }
}

function listTmuxSessions() {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (e) {
    console.debug(`[supervisor] tmux list skipped: ${e.message}`);
    return [];
  }
}

function buildLaunchSelection(runtimeProfile, config) {
  const supervisor = runtimeProfile?.supervisor || null;
  const primary = runtimeProfile?.primary || null;
  const selected = supervisor || primary || null;
  const profileSource = supervisor
    ? 'runtimeProfile.supervisor'
    : (primary ? 'runtimeProfile.primary-fallback' : 'env/default');
  const selectedFrameworkRaw = normalizeOptionalText(selected?.framework, 32);
  const envFramework = normalizeFramework(process.env.AGENTCHAT_SUPERVISOR_FRAMEWORK);
  const framework = selectedFrameworkRaw
    ? (normalizeFramework(selectedFrameworkRaw) || selectedFrameworkRaw.toLowerCase())
    : (envFramework || 'claude');
  const provider = normalizeOptionalText(selected?.provider, 64)
    || normalizeOptionalText(process.env.SUPERVISOR_LLM_PROVIDER, 64)
    || config.llm.provider
    || 'deepseek';
  const model = normalizeOptionalText(selected?.model, 256)
    || normalizeOptionalText(process.env.SUPERVISOR_LLM_MODEL, 256)
    || config.llm.model
    || null;
  const reasoning = normalizeOptionalText(selected?.reasoning, 64)
    || normalizeOptionalText(process.env.AGENTCHAT_SUPERVISOR_REASONING_PROFILE, 64)
    || null;
  const extraArgs = normalizeOptionalText(selected?.extraArgs, 4000)
    || normalizeOptionalText(process.env.AGENTCHAT_SUPERVISOR_EXTRA_ARGS, 4000)
    || null;
  return {
    profileSource,
    framework,
    provider,
    model,
    reasoning,
    extraArgs,
  };
}

function buildSupervisorLaunchCommand(agentName, workspaceDir, selection, runtimeProfile) {
  const envPrefix = [
    `PATH=${shellQuote(process.env.PATH || '')}`,
    `AGENTCHAT_SUPERVISED_AGENT_NAME=${shellQuote(agentName)}`,
    `AGENTCHAT_SUPERVISOR_WORKSPACE=${shellQuote(workspaceDir)}`,
    `AGENTCHAT_SUPERVISOR_PROFILE_SOURCE=${shellQuote(selection.profileSource)}`,
    `AGENTCHAT_SUPERVISOR_FRAMEWORK=${shellQuote(selection.framework)}`,
    `SUPERVISOR_LLM_PROVIDER=${shellQuote(selection.provider || '')}`,
    `SUPERVISOR_LLM_MODEL=${shellQuote(selection.model || '')}`,
    `AGENTCHAT_SUPERVISOR_REASONING_PROFILE=${shellQuote(selection.reasoning || '')}`,
    `AGENTCHAT_SUPERVISOR_EXTRA_ARGS=${shellQuote(selection.extraArgs || '')}`,
    `AGENTCHAT_RUNTIME_PROFILE_PRIMARY_JSON=${shellQuote(JSON.stringify(runtimeProfile?.primary || null))}`,
    `AGENTCHAT_RUNTIME_PROFILE_SUPERVISOR_JSON=${shellQuote(JSON.stringify(runtimeProfile?.supervisor || null))}`,
  ].join(' ');
  if (selection.framework === 'claude') {
    const parts = ['claude', '--dangerously-skip-permissions'];
    if (selection.model) parts.push('--model', selection.model);
    if (selection.extraArgs) parts.push(selection.extraArgs);
    return `${envPrefix} ${parts.join(' ')}`;
  }
  if (selection.framework === 'codex') {
    const parts = ['codex', '--yolo'];
    if (selection.model) parts.push('--model', selection.model);
    if (selection.extraArgs) parts.push(selection.extraArgs);
    parts.push('-C', shellQuote(workspaceDir));
    return `${envPrefix} ${parts.join(' ')}`;
  }
  return null;
}

function frameworkBinaryName(framework) {
  if (framework === 'claude') return 'claude';
  if (framework === 'codex') return 'codex';
  return null;
}

function isExecutableFile(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch (e) {
    console.debug(`[supervisor] executable check skipped for ${filePath}: ${e.message}`);
    return false;
  }
}

function binaryExistsOnPath(binaryName, pathValue = process.env.PATH || '') {
  const name = normalizeOptionalText(binaryName, 128);
  if (!name) return false;
  const pathEnv = typeof pathValue === 'string' ? pathValue : '';
  for (const entry of pathEnv.split(path.delimiter)) {
    const dir = String(entry || '').trim();
    if (!dir) continue;
    const fullPath = path.join(dir, name);
    if (existsSync(fullPath) && isExecutableFile(fullPath)) return true;
  }
  return false;
}

function requiredCredentialEnvName(selection, config) {
  const provider = normalizeOptionalText(selection?.provider, 64);
  if (!provider) return null;
  const normalized = provider.toLowerCase();
  if (!['deepseek', 'qwen', 'openai', 'openai-compatible'].includes(normalized)) return null;
  return normalizeOptionalText(config?.llm?.keyEnv, 128) || 'SUPERVISOR_LLM_KEY';
}

function runtimeLaunchFailure(base, failureType, error, patch = {}) {
  return {
    ...base,
    running: false,
    action: 'failed',
    status: 'launch-failed',
    failureType,
    error: error || null,
    ...patch,
  };
}

function startSupervisorTmuxSession(sessionName, workspaceDir, command) {
  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', workspaceDir], {
    timeout: 5000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('tmux', ['send-keys', '-t', `${sessionName}:0.0`, command, 'C-m'], {
    timeout: 5000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function deriveLifecycle(task, classification, trailingUntilAt, now) {
  if (!task) {
    return {
      state: 'idle',
      reason: 'Supervisor is idle because there is no canonical task and no unresolved negative supervision state to monitor.',
    };
  }
  if (task.status === 'done') {
    if (trailingUntilAt > now) {
      return {
        state: 'active',
        reason: 'Supervisor remains active during the bounded completion tail after task completion.',
      };
    }
    return {
      state: 'idle',
      reason: 'Supervisor is idle because the task is done and the bounded completion tail has elapsed.',
    };
  }
  if (task.status === 'waiting' && classification === 'normal_wait') {
    return {
      state: 'idle',
      reason: 'Supervisor is idle because the primary task is in a valid maintained normal_wait state.',
    };
  }
  if (task.status === 'blocked') {
    return {
      state: 'active',
      reason: 'Supervisor remains active because blocked work still requires attention.',
    };
  }
  if (classification === 'stalled_wait' || classification === 'suspected_eos') {
    return {
      state: 'active',
      reason: 'Supervisor remains active because an unresolved negative supervision state still needs attention.',
    };
  }
  if (task.status === 'active') {
    return {
      state: 'active',
      reason: trailingUntilAt > now
        ? 'Supervisor remains active while the primary task is live or inside the bounded trailing supervision window.'
        : 'Supervisor remains active because the primary task is active.',
    };
  }
  return {
    state: 'idle',
    reason: 'Supervisor is idle because there is no active supervision work remaining.',
  };
}

function buildSupervisorWarning(agentName, observation) {
  const task = observation.task || null;
  const lines = [
    `Agent: ${agentName}`,
    `Classification: ${observation.classification}`,
    `Reason: ${observation.reason}`,
    `Task id: ${task?.id || 'none'}`,
    `Task status: ${task?.status || 'none'}`,
    `Heartbeat at: ${task?.heartbeat_at || 'none'}`,
    `Waiting reason: ${task?.waiting_reason || 'none'}`,
    `Waiting until: ${task?.waiting_until || 'none'}`,
    `Trailing until: ${observation.trailingUntilAt ? new Date(observation.trailingUntilAt).toISOString() : 'n/a'}`,
  ];
  return {
    summary: `Supervisor warning: ${agentName} ${observation.classification}`,
    full: lines.join('\n'),
  };
}

function buildSupervisorNudge(agentName, observation, consecutiveNegative) {
  const task = observation.task || null;
  return {
    to: agentName,
    summary: 'Supervisor: you appear stalled. Check your task and resume work.',
    full: [
      `Supervisor detected repeated negative state for ${agentName}.`,
      `Classification: ${observation.classification}`,
      `Reason: ${observation.reason}`,
      `Consecutive negative checks: ${consecutiveNegative}`,
      `Task id: ${task?.id || 'none'}`,
      `Task status: ${task?.status || 'none'}`,
      `Heartbeat at: ${task?.heartbeat_at || 'none'}`,
      `Waiting reason: ${task?.waiting_reason || 'none'}`,
      `Waiting until: ${task?.waiting_until || 'none'}`,
      'Review the current task, refresh heartbeat or declare waiting explicitly, then resume work.',
    ].join('\n'),
    type: 'inform',
    priority: 'high',
    schema: {
      kind: 'escalation',
      version: 1,
      payload: {
        level: 'nudge',
        reason: observation.classification,
        count: consecutiveNegative,
        agent: agentName,
      },
    },
  };
}

function buildSupervisorEscalation(agentName, observation, consecutiveNegative) {
  const task = observation.task || null;
  return {
    to: 'ac-topleader',
    summary: `Supervisor escalation: ${agentName} appears EOS after ${consecutiveNegative} checks`,
    full: [
      `Supervisor escalation for ${agentName}.`,
      `Classification: ${observation.classification}`,
      `Reason: ${observation.reason}`,
      `Consecutive negative checks: ${consecutiveNegative}`,
      `Task id: ${task?.id || 'none'}`,
      `Task status: ${task?.status || 'none'}`,
      `Heartbeat at: ${task?.heartbeat_at || 'none'}`,
      `Waiting reason: ${task?.waiting_reason || 'none'}`,
      `Waiting until: ${task?.waiting_until || 'none'}`,
      'Supervisor already issued a nudge and the negative state persisted.',
    ].join('\n'),
    type: 'request',
    priority: 'urgent',
    schema: {
      kind: 'escalation',
      version: 1,
      payload: {
        level: 'escalate',
        reason: observation.classification,
        count: consecutiveNegative,
        agent: agentName,
      },
    },
  };
}

export class SupervisorService {
  constructor(deps = {}) {
    this.config = deps.config || loadSupervisorConfig(process.env);
    this.getAgents = deps.getAgents;
    this.getRuntime = deps.getRuntime;
    this.emitSystemInfo = deps.emitSystemInfo;
    this.broadcastSSE = deps.broadcastSSE;
    this.sendMessage = deps.sendMessage;
    this.listTmuxSessions = typeof deps.listTmuxSessions === 'function' ? deps.listTmuxSessions : listTmuxSessions;
    this.killTmuxSession = typeof deps.killTmuxSession === 'function' ? deps.killTmuxSession : killTmuxSession;
    this.tmuxSessionExists = typeof deps.tmuxSessionExists === 'function' ? deps.tmuxSessionExists : tmuxSessionExists;
    this.tmuxPanePath = typeof deps.tmuxPanePath === 'function' ? deps.tmuxPanePath : tmuxPanePath;
    this.startSupervisorTmuxSession = typeof deps.startSupervisorTmuxSession === 'function'
      ? deps.startSupervisorTmuxSession
      : startSupervisorTmuxSession;

    this.enabledRequested = this.config.enabled === true;
    this.disabledReason = this.config.disabledReason || null;
    this.agentAllowlist = normalizeAgentAllowlist(this.config.agentAllowlist) || null;
    this.stateStore = new SupervisorStateStore(this.config.stateFile, this.config.warnAfter, this.config.warnCooldownMs);
    this.events = readJsonl(this.config.logFile, this.config.eventHistoryLimit);
    this.latestByAgent = new Map();

    this._llmJudge = null; // lazy-init on first suspected_eos
    this._lastPaneResult = new Map(); // agent -> { hash, verdict } (dedup + cache LLM calls)

    this.running = false;
    this.timer = null;
    this.lastSweepAt = 0;
    this.lastSweepDurationMs = 0;
    this.lastSweepError = null;
    this.lastSweepEvaluated = 0;
    this.lastSweepActive = 0;

    for (const ev of this.events) {
      if (ev && ev.agent) this.latestByAgent.set(ev.agent, ev);
    }
  }

  isEnabled() {
    return this.enabledRequested === true && this.timer !== null;
  }

  cleanupOrphanSupervisorSessions() {
    const knownSessions = new Set();
    for (const row of Object.values(this.stateStore.agents || {})) {
      const sessionName = normalizeOptionalText(row?.runtimeLaunch?.sessionName, 256);
      if (sessionName) knownSessions.add(sessionName);
    }
    const listedSessions = typeof this.listTmuxSessions === 'function' ? this.listTmuxSessions() : [];
    const tmuxSessions = Array.isArray(listedSessions) ? listedSessions : [];
    for (const sessionName of tmuxSessions) {
      if (!String(sessionName).startsWith('supervisor-')) continue;
      if (knownSessions.has(sessionName)) continue;
      if (this.killTmuxSession(sessionName)) {
        console.log(`[supervisor] cleaned orphan tmux session ${sessionName}`);
      } else {
        console.warn(`[supervisor] failed to clean orphan tmux session ${sessionName}`);
      }
    }
  }

  start() {
    if (!this.enabledRequested) {
      console.log(`[supervisor] disabled: ${this.disabledReason || 'unknown reason'}`);
      return;
    }
    if (this.timer) return;
    // Reset accumulated state from disabled periods to prevent stale false positives
    for (const [name, row] of Object.entries(this.stateStore.agents || {})) {
      if (row && row.consecutiveNegative > 0) {
        row.consecutiveNegative = 0;
        row.lastNudgeAt = 0;
        row.lastNudgeCount = 0;
        row.lastEscalationAt = 0;
        row.lastEscalationCount = 0;
      }
    }
    this.stateStore.save();
    this.cleanupOrphanSupervisorSessions();
    this.runSweep().catch(() => {});
    this.timer = setInterval(() => {
      this.runSweep().catch(() => {});
    }, this.config.intervalMs);
    console.log(`[supervisor] started interval=${this.config.intervalMs}ms heartbeatTtl=${this.config.heartbeatTtlMs}ms trailing=${this.config.trailingWindowMs}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopAllSupervisorRuntimes('runtime-disabled');
  }

  appendEvent(event) {
    this.events.push(event);
    if (this.events.length > this.config.eventHistoryLimit) {
      this.events = this.events.slice(this.events.length - this.config.eventHistoryLimit);
    }
    this.latestByAgent.set(event.agent, event);
    safeAppendJsonl(this.config.logFile, event);
    if (typeof this.broadcastSSE === 'function') {
      this.broadcastSSE('supervisor_audit', event);
    }
  }

  resolveCandidates() {
    const all = (typeof this.getAgents === 'function' ? this.getAgents() : []) || [];
    const rows = [];
    const allowSet = Array.isArray(this.agentAllowlist) ? new Set(this.agentAllowlist) : null;
    for (const agent of all) {
      if (!agent || !agent.name) continue;
      if (agent.kind === 'human') continue;
      if (!isLocalAgentServer(agent.server)) continue;
      if (allowSet && !allowSet.has(agent.name)) continue;
      const runtime = typeof this.getRuntime === 'function' ? (this.getRuntime(agent.name) || {}) : {};
      rows.push({ agent, runtime });
    }
    rows.sort((a, b) => String(a.agent.name).localeCompare(String(b.agent.name)));
    return rows;
  }

  resolveSweepCandidates(allRows = this.resolveCandidates()) {
    const rows = Array.isArray(allRows) ? allRows : [];
    const limit = Math.max(1, Number(this.config.maxAgentsPerSweep) || 1);
    if (rows.length <= limit) {
      this.stateStore.setSelectionCursor(0);
      return rows;
    }
    const start = this.stateStore.getSelectionCursor() % rows.length;
    const selected = [];
    for (let offset = 0; offset < Math.min(limit, rows.length); offset++) {
      selected.push(rows[(start + offset) % rows.length]);
    }
    this.stateStore.setSelectionCursor((start + selected.length) % rows.length);
    return selected;
  }

  deriveObservation(candidate, now = Date.now()) {
    const agentName = String(candidate?.agent?.name || '').trim();
    const agent = candidate?.agent || {};
    const runtime = candidate?.runtime || {};
    const rawTask = (agent && typeof agent.task === 'object') ? agent.task : null;
    const rawTaskStatus = normalizeTaskStatus(rawTask?.status);
    const task = normalizeTask(agent.task, agentName);
    const runtimeProfile = normalizeRuntimeProfile(agent.runtimeProfile);
    const heartbeatTtlMs = Math.max(1, Number(this.config.heartbeatTtlMs) || Number(this.config.intervalMs) || 30_000);
    const trailingWindowMs = Math.max(heartbeatTtlMs, Number(this.config.trailingWindowMs) || (heartbeatTtlMs * 5));

    let classification = rawTaskStatus === 'waiting' ? 'suspected_eos' : null;
    let reason = rawTaskStatus === 'waiting'
      ? 'Waiting task is missing a valid waiting_reason or waiting_until declaration.'
      : 'No declared task in the agent control-plane state.';
    let trailingUntilAt = 0;
    let heartbeatFresh = false;
    let waitingDeclared = false;
    let runtimeIdleObserved = isRuntimeIdleObserved(runtime);
    let waitingHeartbeatFresh = false;

    if (task) {
      const heartbeatAtMs = isoToMs(task.heartbeat_at);
      const updatedAtMs = isoToMs(task.updated_at) || heartbeatAtMs || now;
      const waitingUntilMs = isoToMs(task.waiting_until);
      heartbeatFresh = heartbeatAtMs > 0 && (now - heartbeatAtMs) <= heartbeatTtlMs;
      waitingDeclared = task.status === 'waiting' && Boolean(task.waiting_reason) && waitingUntilMs > 0;
      waitingHeartbeatFresh = task.status === 'waiting' && heartbeatFresh;

      if (task.status === 'active') {
        trailingUntilAt = heartbeatAtMs > 0 ? (heartbeatAtMs + heartbeatTtlMs + trailingWindowMs) : 0;
        if (heartbeatFresh && !runtimeIdleObserved) {
          classification = 'active';
          reason = 'Active heartbeat is fresh.';
        } else if (trailingUntilAt > now) {
          classification = 'active';
          reason = runtimeIdleObserved
            ? 'Primary runtime is idle, but the supervisor is still inside the bounded trailing-heartbeat window.'
            : 'Active heartbeat expired, but the supervisor is still inside the trailing-heartbeat window.';
        } else {
          classification = 'suspected_eos';
          reason = 'Active heartbeat expired without a valid waiting declaration.';
        }
      } else if (task.status === 'waiting') {
        if (!waitingDeclared) {
          classification = 'suspected_eos';
          reason = 'Waiting task is missing a valid waiting_reason or waiting_until declaration.';
        } else if (waitingUntilMs <= now) {
          classification = 'stalled_wait';
          reason = `Waiting expired: ${task.waiting_reason}`;
        } else if (!waitingHeartbeatFresh) {
          classification = 'stalled_wait';
          reason = `Waiting heartbeat expired: ${task.waiting_reason}`;
        } else if (waitingUntilMs > now) {
          classification = 'normal_wait';
          reason = `Waiting on: ${task.waiting_reason}`;
        }
      } else if (task.status === 'blocked') {
        classification = 'stalled_wait';
        reason = task.waiting_reason
          ? `Task is blocked: ${task.waiting_reason}`
          : 'Task is blocked and requires external intervention.';
      } else if (task.status === 'done') {
        trailingUntilAt = updatedAtMs + trailingWindowMs;
        if (trailingUntilAt > now) {
          classification = 'active';
          reason = 'Task is marked done and still within the bounded supervisor trailing window.';
        } else {
          classification = 'done';
          reason = 'Task is done and the supervisor trailing window has elapsed.';
        }
      }
    }

    const lifecycle = deriveLifecycle(task, classification, trailingUntilAt, now);

    return {
      agent: agentName,
      task,
      runtimeProfile,
      classification,
      reason,
      trailingUntilAt,
      heartbeatFresh,
      waitingDeclared,
      waitingHeartbeatFresh,
      runtimeIdleObserved,
      lifecycle,
      inputHash: hashInput({
        task,
        runtimeProfile,
        classification,
        reason,
        lifecycle,
        activeNow: runtime.activeNow === true,
        blocked: runtime.blocked === true,
      }),
      runtime: {
        blocked: runtime.blocked === true,
        blockedReason: runtime.blockedReason || null,
        activeNow: runtime.activeNow === true,
        activeDurationSec: Number(runtime.activeDurationSec) || 0,
        idleDurationSec: Number(runtime.idleDurationSec) || 0,
      },
      docs: {
        currentTask: summarizeTaskLabel(task),
      },
    };
  }

  resolveRuntimeLaunchContext(candidate, observation) {
    const agentName = String(candidate?.agent?.name || '').trim();
    const manifest = resolveV1ManifestForAgent(agentName, candidate?.agent || null) || null;
    const runtimeProfile = observation.runtimeProfile || normalizeRuntimeProfile(candidate?.agent?.runtimeProfile) || null;
    const selection = buildLaunchSelection(runtimeProfile, this.config);
    const supervisorDir = manifest?.homeDir ? path.join(manifest.homeDir, 'supervisor') : null;
    return {
      agentName,
      manifest,
      runtimeProfile,
      selection,
      supervisorDir: supervisorDir && existsSync(supervisorDir) ? supervisorDir : null,
      sessionName: buildSupervisorSessionName(agentName),
    };
  }

  buildRuntimeLaunchState(base, patch = {}) {
    return {
      desiredState: base.desiredState || 'idle',
      running: base.running === true,
      sessionName: base.sessionName || null,
      tmuxTarget: base.tmuxTarget || null,
      workspaceDir: base.workspaceDir || null,
      framework: base.framework || null,
      provider: base.provider || null,
      model: base.model || null,
      reasoning: base.reasoning || null,
      extraArgs: base.extraArgs || null,
      profileSource: base.profileSource || null,
      action: base.action || null,
      status: base.status || null,
      failureType: base.failureType || null,
      error: base.error || null,
      binaryName: base.binaryName || null,
      requiredCredentialEnv: base.requiredCredentialEnv || null,
      startedAt: base.startedAt || null,
      stoppedAt: base.stoppedAt || null,
      ...patch,
    };
  }

  stopAllSupervisorRuntimes(reason = 'runtime-disabled') {
    const names = new Set();
    for (const [agentName, row] of Object.entries(this.stateStore.agents || {})) {
      const sessionName = row?.runtimeLaunch?.sessionName || buildSupervisorSessionName(agentName);
      if (sessionName) names.add(`${agentName}\n${sessionName}`);
    }
    for (const entry of names) {
      const [agentName, sessionName] = entry.split('\n');
      const existed = this.tmuxSessionExists(sessionName);
      if (existed) this.killTmuxSession(sessionName);
      const previous = this.stateStore.snapshot(agentName);
      this.stateStore.agents[agentName] = {
        ...this.stateStore.agents[agentName],
        runtimeLaunch: this.buildRuntimeLaunchState(previous.runtimeLaunch || {}, {
          desiredState: 'idle',
          running: false,
          sessionName,
          tmuxTarget: `${sessionName}:0.0`,
          action: existed ? 'stopped' : 'idle',
          status: existed ? 'stopped' : 'idle',
          failureType: null,
          error: null,
          requiredCredentialEnv: null,
          stoppedAt: Date.now(),
        }),
      };
    }
    this.stateStore.save();
  }

  reconcileSupervisorRuntime(candidate, observation, now = Date.now()) {
    const context = this.resolveRuntimeLaunchContext(candidate, observation);
    const previous = this.stateStore.snapshot(context.agentName).runtimeLaunch || null;
    const base = this.buildRuntimeLaunchState(previous || {}, {
      desiredState: observation.lifecycle.state,
      sessionName: context.sessionName,
      tmuxTarget: `${context.sessionName}:0.0`,
      workspaceDir: context.supervisorDir,
      framework: context.selection.framework,
      provider: context.selection.provider,
      model: context.selection.model,
      reasoning: context.selection.reasoning,
      extraArgs: context.selection.extraArgs,
      profileSource: context.selection.profileSource,
      binaryName: frameworkBinaryName(context.selection.framework),
      requiredCredentialEnv: requiredCredentialEnvName(context.selection, this.config),
      failureType: null,
      error: null,
    });
    const sessionExists = this.tmuxSessionExists(context.sessionName);
    const currentPath = sessionExists ? this.tmuxPanePath(context.sessionName) : null;
    const pathMismatch = sessionExists && context.supervisorDir && currentPath && path.resolve(currentPath) !== path.resolve(context.supervisorDir);

    if (!this.enabledRequested || observation.lifecycle.state === 'idle') {
      if (sessionExists) {
        this.killTmuxSession(context.sessionName);
        return this.buildRuntimeLaunchState(base, {
          running: false,
          action: 'stopped',
          status: 'stopped',
          stoppedAt: new Date(now).toISOString(),
        });
      }
      return this.buildRuntimeLaunchState(base, {
        running: false,
        action: 'idle',
        status: 'idle',
        failureType: null,
        requiredCredentialEnv: null,
      });
    }

    if (!context.manifest || !context.supervisorDir || !existsSync(context.supervisorDir)) {
      return runtimeLaunchFailure(base, 'missing-workspace', 'missing v1 supervisor workspace');
    }

    const command = buildSupervisorLaunchCommand(
      context.agentName,
      context.supervisorDir,
      context.selection,
      context.runtimeProfile,
    );
    if (!command) {
      return runtimeLaunchFailure(
        base,
        'unsupported-framework',
        `unsupported supervisor framework: ${context.selection.framework || 'unknown'}`
      );
    }

    if (!binaryExistsOnPath(base.binaryName, process.env.PATH || '')) {
      return runtimeLaunchFailure(
        base,
        'missing-binary',
        `missing supervisor runtime binary on PATH: ${base.binaryName || 'unknown'}`
      );
    }

    if (base.requiredCredentialEnv && !normalizeOptionalText(process.env[base.requiredCredentialEnv], 8192)) {
      return runtimeLaunchFailure(
        base,
        'missing-credential-env',
        `missing supervisor credential env: ${base.requiredCredentialEnv}`
      );
    }

    try {
      if (sessionExists && !pathMismatch) {
        return this.buildRuntimeLaunchState(base, {
          running: true,
          action: 'kept',
          status: 'running',
          failureType: null,
          error: null,
          startedAt: previous?.startedAt || new Date(now).toISOString(),
        });
      }
      if (sessionExists && pathMismatch) {
        this.killTmuxSession(context.sessionName);
      }
      this.startSupervisorTmuxSession(context.sessionName, context.supervisorDir, command);
      return this.buildRuntimeLaunchState(base, {
        running: true,
        action: pathMismatch ? 'restarted' : 'started',
        status: 'running',
        failureType: null,
        error: null,
        startedAt: new Date(now).toISOString(),
      });
    } catch (e) {
      return runtimeLaunchFailure(
        base,
        'tmux-launch-failed',
        String(e?.message || e),
        { running: this.tmuxSessionExists(context.sessionName) }
      );
    }
  }

  async evaluateOne(candidate, now = Date.now()) {
    const agentName = candidate.agent.name;
    const observation = this.deriveObservation(candidate, now);

    // Fix 2: If suspected_eos, check if agent's tmux session actually exists
    if (observation.classification === 'suspected_eos' && candidate.agent.tmux) {
      const agentSession = String(candidate.agent.tmux).split(':')[0];
      if (agentSession && !this.tmuxSessionExists(agentSession)) {
        observation.classification = 'abandoned';
        observation.reason = 'Agent tmux session no longer exists.';
      }
    }

    // Fix 3: Wire LLM judge behind suspected_eos — only escalate if LLM concurs
    if (observation.classification === 'suspected_eos') {
      try {
        const context = await collectAgentContext(this.config, agentName, candidate.agent, candidate.runtime);
        const cached = this._lastPaneResult.get(agentName);
        if (cached && context.pane.hash === cached.hash) {
          // Reuse cached verdict — pane unchanged since last LLM call
          if (!cached.negative) {
            observation.classification = 'active';
            observation.reason = `LLM judge cached override: ${cached.status} — ${cached.reason || 'on track'}`;
          }
        } else {
          if (!this._llmJudge) {
            this._llmJudge = new LLMJudge(this.config);
          }
          const llmResult = await this._llmJudge.evaluate(context);
          observation._llm = llmResult;
          const llmNeg = llmResult.status === 'DRIFTING' || llmResult.status === 'LOST' || llmResult.status === 'STUCK';
          this._lastPaneResult.set(agentName, { hash: context.pane.hash, negative: llmNeg, status: llmResult.status, reason: llmResult.reason });
          if (!llmNeg) {
            observation.classification = 'active';
            observation.reason = `LLM judge override: ${llmResult.status} — ${llmResult.reason || 'on track'}`;
          }
        }
      } catch (e) {
        console.warn(`[supervisor] LLM judge failed for ${agentName}: ${e.message}`);
        // Proceed with suspected_eos classification on judge failure
      }
    }

    const runtimeLaunch = this.reconcileSupervisorRuntime(candidate, observation, now);
    const eventInputHash = hashInput({
      task: observation.task,
      runtimeProfile: observation.runtimeProfile,
      classification: observation.classification,
      reason: observation.reason,
      lifecycle: observation.lifecycle,
      runtimeLaunch,
      activeNow: observation.runtime.activeNow === true,
      blocked: observation.runtime.blocked === true,
    });
    const previous = this.stateStore.snapshot(agentName);
    const changed = previous.lastInputHash !== eventInputHash || previous.lastStatus !== observation.classification;

    const event = {
      id: `supervisor_${now}_${agentName}_${Math.random().toString(36).slice(2, 8)}`,
      ts: now,
      agent: agentName,
      sweepAt: this.lastSweepAt || now,
      status: observation.classification,
      domain: 'task-state',
      reason: observation.reason,
      pattern: observation.task?.status || null,
      suggestion: isNegative(observation.classification)
        ? 'Renew the active heartbeat or declare waiting explicitly with waiting_reason and waiting_until.'
        : null,
      negative: isNegative(observation.classification),
      skipped: null,
      error: null,
      inputHash: eventInputHash,
      docs: {
        hasRole: true,
        hasBoundaries: true,
        hasCurrentTask: Boolean(observation.task),
        currentTask: observation.docs.currentTask,
      },
      runtime: observation.runtime,
      task: observation.task,
      runtimeProfile: observation.runtimeProfile,
      supervisor: {
        classification: observation.classification,
        lifecycleState: observation.lifecycle.state,
        lifecycleReason: observation.lifecycle.reason,
        heartbeatTtlMs: this.config.heartbeatTtlMs,
        trailingHeartbeatPeriods: this.config.trailingHeartbeatPeriods,
        trailingWindowMs: this.config.trailingWindowMs,
        trailingUntilAt: observation.trailingUntilAt || null,
        heartbeatFresh: observation.heartbeatFresh,
        waitingDeclared: observation.waitingDeclared,
        waitingHeartbeatFresh: observation.waitingHeartbeatFresh,
        runtimeIdleObserved: observation.runtimeIdleObserved,
        runtimeLaunch,
      },
      llm: observation._llm || null,
      action: null,
    };

    const apply = this.stateStore.applyJudgment(
      agentName,
      {
        status: event.status,
        domain: event.domain,
        reason: event.reason,
        pattern: event.pattern,
        suggestion: event.suggestion,
        inputHash: event.inputHash,
        task: observation.task,
        classification: observation.classification,
        trailingUntilAt: observation.trailingUntilAt,
        lifecycleState: observation.lifecycle.state,
        lifecycleReason: observation.lifecycle.reason,
        runtimeLaunch,
      },
      now,
      changed ? event.id : (previous.lastEventId || event.id)
    );

    event.state = {
      consecutiveNegative: apply.current.consecutiveNegative,
      lastWarningAt: apply.current.lastWarningAt,
      lastNudgeAt: apply.current.lastNudgeAt || 0,
      lastNudgeCount: apply.current.lastNudgeCount || 0,
      lastEscalationAt: apply.current.lastEscalationAt || 0,
      lastEscalationCount: apply.current.lastEscalationCount || 0,
      lastStatus: apply.current.lastStatus,
      lifecycleState: apply.current.lifecycleState || null,
    };

    if (changed) {
      this.appendEvent(event);
    }

    if (apply.shouldWarn && typeof this.emitSystemInfo === 'function') {
      const warning = buildSupervisorWarning(agentName, observation);
      this.emitSystemInfo(warning.summary, warning.full);
    }

    if (typeof this.sendMessage === 'function' && apply.negative) {
      if (apply.current.consecutiveNegative >= 2 && apply.current.lastNudgeCount < 2) {
        const intervention = buildSupervisorNudge(agentName, observation, apply.current.consecutiveNegative);
        try {
          this.sendMessage(intervention);
          const marked = this.stateStore.markIntervention(agentName, {
            lastNudgeAt: now,
            lastNudgeCount: apply.current.consecutiveNegative,
          }, now);
          event.action = {
            kind: 'supervisor_nudge',
            to: intervention.to,
            priority: intervention.priority,
            consecutiveNegative: apply.current.consecutiveNegative,
          };
          event.state.lastNudgeAt = marked.lastNudgeAt || 0;
          event.state.lastNudgeCount = marked.lastNudgeCount || 0;
        } catch (e) {
          event.action = {
            kind: 'supervisor_nudge_failed',
            error: String(e?.message || e),
            consecutiveNegative: apply.current.consecutiveNegative,
          };
        }
      }
      if (apply.current.consecutiveNegative >= 3 && apply.current.lastEscalationCount < 3) {
        const intervention = buildSupervisorEscalation(agentName, observation, apply.current.consecutiveNegative);
        try {
          this.sendMessage(intervention);
          const marked = this.stateStore.markIntervention(agentName, {
            lastEscalationAt: now,
            lastEscalationCount: apply.current.consecutiveNegative,
          }, now);
          event.action = {
            kind: 'supervisor_escalation',
            to: intervention.to,
            priority: intervention.priority,
            consecutiveNegative: apply.current.consecutiveNegative,
          };
          event.state.lastEscalationAt = marked.lastEscalationAt || 0;
          event.state.lastEscalationCount = marked.lastEscalationCount || 0;
        } catch (e) {
          event.action = {
            kind: 'supervisor_escalation_failed',
            error: String(e?.message || e),
            consecutiveNegative: apply.current.consecutiveNegative,
          };
        }
      }
    }

    return event;
  }

  async runSweep() {
    if (!this.enabledRequested) return;
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    this.lastSweepAt = started;
    this.lastSweepError = null;

    try {
      const allCandidates = this.resolveCandidates();
      const candidates = this.resolveSweepCandidates(allCandidates);
      this.lastSweepActive = allCandidates.length;
      this.stateStore.clearMissingAgents(allCandidates.map(row => row.agent.name));
      let evaluated = 0;
      for (const row of candidates) {
        await this.evaluateOne(row, started);
        evaluated++;
      }
      this.lastSweepEvaluated = evaluated;
      this.stateStore.save();
    } catch (e) {
      this.lastSweepError = String(e?.message || e);
      console.error(`[supervisor] sweep failed: ${this.lastSweepError}`);
    } finally {
      this.lastSweepDurationMs = Date.now() - started;
      this.running = false;
    }
  }

  getStatus() {
    const allowlist = Array.isArray(this.agentAllowlist) ? [...this.agentAllowlist] : null;
    const snapshots = Object.values(this.stateStore.agents || {});
    const classifications = snapshots.map(row => row.classification || row.lastStatus || null).filter(Boolean);
    const lifecycleStates = snapshots.map(row => row.lifecycleState || null).filter(Boolean);
    let supervisorMode = 'idle';
    if (classifications.includes('active')) supervisorMode = 'active';
    else if (classifications.includes('normal_wait')) supervisorMode = 'normal_wait';
    else if (classifications.includes('stalled_wait') || classifications.includes('suspected_eos')) supervisorMode = 'attention';
    const lifecycleState = lifecycleStates.includes('active') ? 'active' : 'idle';
    return {
      enabled: this.isEnabled(),
      disabledReason: this.disabledReason,
      intervalMs: this.config.intervalMs,
      warnAfter: this.config.warnAfter,
      warnCooldownMs: this.config.warnCooldownMs,
      heartbeatTtlMs: this.config.heartbeatTtlMs,
      trailingHeartbeatPeriods: this.config.trailingHeartbeatPeriods,
      trailingWindowMs: this.config.trailingWindowMs,
      matrixInfoGroup: this.config.matrixInfoGroup,
      matrixMentions: this.config.matrixMentions,
      allowedAgents: allowlist,
      allowlistMode: allowlist === null ? 'all' : (allowlist.length ? 'subset' : 'none'),
      llm: {
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        endpoint: this.config.llm.endpoint,
        profileSource: this.config.llm.profileSource || null,
      },
      runtime: {
        running: this.running,
        lastSweepAt: this.lastSweepAt || null,
        lastSweepDurationMs: this.lastSweepDurationMs,
        lastSweepError: this.lastSweepError,
        lastSweepActive: this.lastSweepActive,
        lastSweepEvaluated: this.lastSweepEvaluated,
      },
      supervisorState: {
        mode: supervisorMode,
        lifecycleState,
      },
      eventCount: this.events.length,
    };
  }

  getControl() {
    return {
      enabled: this.isEnabled(),
      disabledReason: this.disabledReason,
      allowedAgents: Array.isArray(this.agentAllowlist) ? [...this.agentAllowlist] : null,
      allowlistMode: Array.isArray(this.agentAllowlist)
        ? (this.agentAllowlist.length ? 'subset' : 'none')
        : 'all',
    };
  }

  updateControl(patch = {}) {
    const hasEnabled = Object.prototype.hasOwnProperty.call(patch, 'enabled');
    const hasAllow = Object.prototype.hasOwnProperty.call(patch, 'allowedAgents');

    if (!hasEnabled && !hasAllow) {
      return { ok: false, error: 'no control fields provided' };
    }

    if (hasEnabled) {
      if (typeof patch.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be boolean' };
      }
      if (patch.enabled) {
        this.enabledRequested = true;
        this.disabledReason = null;
        this.start();
      } else {
        this.enabledRequested = false;
        this.disabledReason = 'runtime-disabled';
        this.stop();
      }
    }

    if (hasAllow) {
      if (patch.allowedAgents !== null && !Array.isArray(patch.allowedAgents)) {
        return { ok: false, error: 'allowedAgents must be array or null' };
      }
      this.agentAllowlist = normalizeAgentAllowlist(patch.allowedAgents);
    }

    if (this.enabledRequested) this.runSweep().catch(() => {});

    return {
      ok: true,
      control: this.getControl(),
      status: this.getStatus(),
    };
  }

  getAgentSummaries() {
    const rows = [];
    for (const candidate of this.resolveCandidates()) {
      const agentName = candidate.agent.name;
      const snapshot = this.stateStore.snapshot(agentName);
      const latest = this.latestByAgent.get(agentName) || null;
      rows.push({
        agent: agentName,
        lastStatus: snapshot.lastStatus || null,
        classification: snapshot.classification || snapshot.lastStatus || null,
        consecutiveNegative: Number(snapshot.consecutiveNegative) || 0,
        lastReason: snapshot.lastReason || null,
        lastDomain: snapshot.lastDomain || null,
        lastPattern: snapshot.lastPattern || null,
        lastJudgedAt: Number(snapshot.lastJudgedAt) || null,
        lastWarningAt: Number(snapshot.lastWarningAt) || null,
        latestEventId: snapshot.lastEventId || null,
        lifecycleState: snapshot.lifecycleState || null,
        lifecycleReason: snapshot.lifecycleReason || null,
        runtimeLaunch: snapshot.runtimeLaunch || null,
        task: snapshot.task || normalizeTask(candidate.agent.task, agentName),
        runtimeProfile: normalizeRuntimeProfile(candidate.agent.runtimeProfile),
        latest,
      });
    }
    rows.sort((a, b) => (b.lastJudgedAt || 0) - (a.lastJudgedAt || 0));
    return rows;
  }

  getAgentDetail(agentName, limit = 120) {
    const key = String(agentName || '').trim();
    const snapshot = this.stateStore.snapshot(key);
    const events = this.events.filter(ev => ev.agent === key).slice(-Math.max(1, Math.min(limit, 500)));
    const latest = events.length ? events[events.length - 1] : (this.latestByAgent.get(key) || null);
    let runtimeProfile = null;
    let task = snapshot.task || null;
    const candidate = this.resolveCandidates().find(row => row.agent.name === key) || null;
    if (candidate) {
      runtimeProfile = normalizeRuntimeProfile(candidate.agent.runtimeProfile);
      task = task || normalizeTask(candidate.agent.task, key);
    }
    return {
      agent: key,
      state: snapshot,
      task,
      runtimeProfile,
      lifecycle: {
        state: snapshot.lifecycleState || null,
        reason: snapshot.lifecycleReason || null,
      },
      runtimeLaunch: snapshot.runtimeLaunch || null,
      latest,
      events,
    };
  }

  removeAgentState(agentName) {
    const key = normalizeOptionalText(agentName, 256);
    if (!key) return { removed: false, sessionKilled: false };
    const hadState = Object.prototype.hasOwnProperty.call(this.stateStore.agents || {}, key);
    const sessionName = this.stateStore.snapshot(key)?.runtimeLaunch?.sessionName || buildSupervisorSessionName(key);
    const sessionExists = sessionName ? this.tmuxSessionExists(sessionName) : false;
    if (sessionExists) this.killTmuxSession(sessionName);
    if (hadState) delete this.stateStore.agents[key];
    this.latestByAgent.delete(key);
    if (hadState || sessionExists) this.stateStore.save();
    return { removed: hadState, sessionKilled: sessionExists };
  }
}

export function createSupervisorService(deps) {
  return new SupervisorService(deps);
}
