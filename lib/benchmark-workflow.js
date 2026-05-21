import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildV1AgentPaths } from './agent-home-v1.js';

export const BENCHMARK_RUNTIME_SCHEMA = 'agentchat.benchmark.runtime-root/v1';
export const BENCHMARK_PROFILE_SCHEMA = 'agentchat.benchmark.profile-version/v1';
export const BENCHMARK_RUN_SCHEMA = 'agentchat.benchmark.run/v1';
export const BENCHMARK_TRIAL_SCHEMA = 'agentchat.benchmark.trial/v1';

function normalizeText(value, maxLen = 256) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

export function normalizeProfileId(value) {
  const raw = normalizeText(value, 128);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return normalized || null;
}

export function normalizeProfileVersion(value) {
  const raw = normalizeText(value, 64);
  if (!raw) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) return null;
  return raw;
}

export function normalizeTaskId(value) {
  const raw = normalizeText(value, 128);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return normalized || null;
}

export function normalizeAgentType(value, fallback = 'claude-code') {
  const raw = normalizeText(value, 64);
  if (!raw) return fallback;
  const lowered = raw.toLowerCase();
  if (['claude', 'claude-code', 'codex'].includes(lowered)) return lowered === 'claude' ? 'claude-code' : lowered;
  return null;
}

export function defaultBenchmarkRuntimeRoot(env = process.env) {
  const explicit = normalizeText(env?.AGENT_CHAT_BENCH_RUNTIME_DIR, 4096);
  if (explicit) return path.resolve(explicit);
  return path.resolve(os.homedir(), '.agentchat', 'bench-runtime');
}

export function benchmarkRuntimeLayout(rootPath) {
  const root = path.resolve(rootPath);
  return {
    root,
    profilesDir: path.join(root, 'profiles'),
    runsDir: path.join(root, 'runs'),
    homesRoot: path.join(root, 'homes'),
    markerPath: path.join(root, 'benchmark-runtime.json'),
  };
}

export function ensureBenchmarkRuntimeRoot(rootPath, env = process.env) {
  const layout = benchmarkRuntimeLayout(rootPath || defaultBenchmarkRuntimeRoot(env));
  mkdirSync(layout.root, { recursive: true });
  mkdirSync(layout.profilesDir, { recursive: true });
  mkdirSync(layout.runsDir, { recursive: true });
  mkdirSync(layout.homesRoot, { recursive: true });
  if (!existsSync(layout.markerPath)) {
    writeJson(layout.markerPath, {
      schema: BENCHMARK_RUNTIME_SCHEMA,
      createdAt: new Date().toISOString(),
      root: layout.root,
      profilesDir: layout.profilesDir,
      runsDir: layout.runsDir,
      homesRoot: layout.homesRoot,
      mode: 'dev-only-host-runtime',
      notes: 'Benchmark runtime root isolated from AGENT_CHAT_RUNTIME_DIR and live/human-operated agents.',
    });
  }
  return layout;
}

export function buildBenchmarkProfilePaths(rootPath, profileId, version) {
  const layout = ensureBenchmarkRuntimeRoot(rootPath);
  const profileRoot = path.join(layout.profilesDir, profileId, version);
  return {
    ...layout,
    profileRoot,
    docsDir: path.join(profileRoot, 'docs'),
    configDir: path.join(profileRoot, 'config'),
    profileJsonPath: path.join(profileRoot, 'profile.json'),
  };
}

export function buildBenchmarkRunPaths(rootPath, runId) {
  const layout = ensureBenchmarkRuntimeRoot(rootPath);
  const runRoot = path.join(layout.runsDir, runId);
  return {
    ...layout,
    runRoot,
    runJsonPath: path.join(runRoot, 'run.json'),
    trialsDir: path.join(runRoot, 'trials'),
  };
}

export function buildBenchmarkTrialPaths(rootPath, runId, trialId, trialAgentName, trialAgentId) {
  const runPaths = buildBenchmarkRunPaths(rootPath, runId);
  const trialRoot = path.join(runPaths.trialsDir, trialId);
  const v1Paths = buildV1AgentPaths(trialAgentName, { ...process.env, AGENTCHAT_HOMEDIR: runPaths.homesRoot }, trialAgentId);
  return {
    ...runPaths,
    trialRoot,
    trialJsonPath: path.join(trialRoot, 'trial.json'),
    artifactsDir: path.join(trialRoot, 'artifacts'),
    logsDir: path.join(trialRoot, 'logs'),
    taskOutputDir: path.join(trialRoot, 'task-output'),
    profileSnapshotDir: path.join(trialRoot, 'profile-snapshot'),
    v1Paths,
  };
}

export function makeRunId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14).toLowerCase();
  return `run-${iso}`;
}

export function makeTrialAgentName(runId, taskId, attemptIndex) {
  const raw = `${runId}-${taskId}-a${attemptIndex}`.toLowerCase();
  return raw.replace(/[^a-z0-9._-]+/g, '-').slice(0, 96);
}

export function makeTrialAgentId(runId, taskId, attemptIndex) {
  const raw = `bench_${runId}_${taskId}_a${attemptIndex}`.toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, '_').slice(0, 96);
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

export function validateBenchmarkProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') errors.push('profile must be an object');
  if (profile?.schema !== BENCHMARK_PROFILE_SCHEMA) errors.push(`profile.schema must equal ${BENCHMARK_PROFILE_SCHEMA}`);
  if (!normalizeProfileId(profile?.profileId)) errors.push('profileId required');
  if (!normalizeProfileVersion(profile?.version)) errors.push('version required');
  if (!normalizeAgentType(profile?.agentRuntime?.agentType)) errors.push('agentRuntime.agentType invalid');
  if (!Array.isArray(profile?.docsBundle?.files)) errors.push('docsBundle.files must be an array');
  if (typeof profile?.subconsciousDefaults?.enabled !== 'boolean') errors.push('subconsciousDefaults.enabled must be boolean');
  return errors;
}

export function validateBenchmarkRun(run) {
  const errors = [];
  if (!run || typeof run !== 'object') errors.push('run must be an object');
  if (run?.schema !== BENCHMARK_RUN_SCHEMA) errors.push(`run.schema must equal ${BENCHMARK_RUN_SCHEMA}`);
  if (!normalizeText(run?.runId, 128)) errors.push('runId required');
  if (!normalizeProfileId(run?.profile?.profileId)) errors.push('profile.profileId required');
  if (!normalizeProfileVersion(run?.profile?.version)) errors.push('profile.version required');
  if (!normalizeAgentType(run?.agentType)) errors.push('agentType invalid');
  if (!Array.isArray(run?.taskSet?.tasks)) errors.push('taskSet.tasks must be an array');
  return errors;
}

export function validateBenchmarkTrial(trial) {
  const errors = [];
  if (!trial || typeof trial !== 'object') errors.push('trial must be an object');
  if (trial?.schema !== BENCHMARK_TRIAL_SCHEMA) errors.push(`trial.schema must equal ${BENCHMARK_TRIAL_SCHEMA}`);
  if (!normalizeText(trial?.runId, 128)) errors.push('runId required');
  if (!normalizeText(trial?.trialId, 128)) errors.push('trialId required');
  if (!normalizeTaskId(trial?.taskId)) errors.push('taskId required');
  const attemptIndex = Number.parseInt(trial?.attemptIndex, 10);
  if (!Number.isFinite(attemptIndex) || attemptIndex <= 0) errors.push('attemptIndex must be positive');
  if (!normalizeText(trial?.agentHomePath, 4096)) errors.push('agentHomePath required');
  if (!normalizeText(trial?.workdirPath, 4096)) errors.push('workdirPath required');
  if (!normalizeText(trial?.outputPath, 4096)) errors.push('outputPath required');
  return errors;
}
