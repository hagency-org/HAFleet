#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BENCHMARK_PROFILE_SCHEMA,
  BENCHMARK_RUN_SCHEMA,
  BENCHMARK_TRIAL_SCHEMA,
  buildBenchmarkProfilePaths,
  buildBenchmarkRunPaths,
  buildBenchmarkTrialPaths,
  defaultBenchmarkRuntimeRoot,
  ensureBenchmarkRuntimeRoot,
  makeRunId,
  makeTrialAgentId,
  makeTrialAgentName,
  normalizeAgentType,
  normalizeProfileId,
  normalizeProfileVersion,
  normalizeTaskId,
  readJson,
  validateBenchmarkProfile,
  validateBenchmarkRun,
  validateBenchmarkTrial,
  writeJson,
} from '../lib/benchmark-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.dirname(__dirname);
const PROVISION_SCRIPT = path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js');

function usage() {
  console.log(`Usage: benchmark-workflow <command> [options]

Commands:
  init-profile   Create a versioned benchmark profile bundle
  create-run     Create a benchmark run record
  prepare-trial  Materialize an isolated benchmark trial home/output scaffold
  run-longcli-trial  Prepare, launch, execute, and evaluate one real LongCLI task trial

Common option:
  --runtime-root <path>   Override benchmark runtime root

init-profile options:
  --profile-id <id>
  --version <version>
  --docs-dir <path>
  --claude-settings <path>
  [--mcp-config <path>]
  [--description <text>]
  [--agent-type <claude-code|codex>]
  [--subconscious-enabled <true|false>]
  [--notes <text>]
  [--created-by <name>]

create-run options:
  --profile-id <id>
  --version <version>
  --task-set <id>
  --task-id <id>            Repeatable
  [--run-id <id>]
  [--created-by <name>]
  [--agent-type <claude-code|codex>]
  [--model-override <model>]
  [--subconscious-mode <mode>]
  [--attempts <n>]

prepare-trial options:
  --run-id <id>
  --task-id <id>
  [--attempt <n>]
  [--created-by <name>]

run-longcli-trial options:
  --run-id <id>
  --task-id <id>
  --task-dir <path>
  [--attempt <n>]
  [--created-by <name>]
  [--longcli-root <path>]
  [--agent-timeout-sec <n>]
  [--poll-interval-sec <n>]
`);
}

function normalizeText(value, maxLen = 4096) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function parseBool(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`invalid boolean: ${value}`);
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultBenchmarkBackendPort(env = process.env) {
  return parsePositiveInt(
    env.HAFLEET_BENCH_BACKEND_PORT || env.HAFLEET_BACKEND_PORT,
    18190
  );
}

function defaultBenchmarkBackendUrl(env = process.env) {
  const explicit = normalizeText(env.HAFLEET_BENCH_API || env.HAFLEET_API, 2048);
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${defaultBenchmarkBackendPort(env)}`;
}

function benchmarkSubconsciousEventUrl(env = process.env) {
  return `${defaultBenchmarkBackendUrl(env)}/api/subconscious/events`;
}

function benchmarkSubconsciousInvokeUrl(env = process.env) {
  return `${defaultBenchmarkBackendUrl(env)}/api/subconscious/runtime/invoke`;
}

function resolveAbsFile(value, label, required = true) {
  const raw = normalizeText(value);
  if (!raw) {
    if (required) throw new Error(`${label} required`);
    return null;
  }
  const abs = path.resolve(raw);
  if (!existsSync(abs)) throw new Error(`${label} not found: ${abs}`);
  return abs;
}

function resolveAbsDir(value, label) {
  const abs = resolveAbsFile(value, label, true);
  return abs;
}

function writeText(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf-8');
}

function copyDirEntries(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    cpSync(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      { recursive: true, force: true, dereference: false }
    );
  }
}

function removePathIfPresent(targetPath) {
  rmSync(targetPath, { recursive: true, force: true });
}

function resetLongcliProjectState(workdir, projectHint, taskDir) {
  if (!projectHint) return;
  const projectRoot = path.join(workdir, projectHint);
  if (!existsSync(projectRoot)) return;
  removePathIfPresent(path.join(projectRoot, 'build'));
  removePathIfPresent(path.join(projectRoot, 'test_output'));
  if (existsSync(path.join(taskDir, 'tests', 'test'))) {
    removePathIfPresent(path.join(projectRoot, 'test'));
  }
}

function copyLongcliTestPayload(containerName, testsDir) {
  ensureCommandOk(runCommand('docker', ['exec', containerName, 'bash', '-lc', 'mkdir -p /tests']), 'docker mkdir /tests');
  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    const sourcePath = path.join(testsDir, entry.name);
    const destinationPath = `${containerName}:/tests/${entry.name}`;
    ensureCommandOk(runCommand('docker', ['cp', sourcePath, destinationPath]), `docker cp tests/${entry.name}`);
  }
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sanitizeHandle(value, fallback = 'bench') {
  const normalized = normalizeTaskId(value) || fallback;
  return normalized.replace(/[^a-z0-9._-]+/g, '-').slice(0, 96);
}

function commandResultText(result) {
  const chunks = [];
  if (result?.stdout) chunks.push(result.stdout.trimEnd());
  if (result?.stderr) chunks.push(result.stderr.trimEnd());
  if (result?.error?.message) chunks.push(result.error.message);
  return chunks.filter(Boolean).join('\n').trim();
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function ensureCommandOk(result, label) {
  if (result.status === 0) return;
  const detail = commandResultText(result);
  throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
}

function parseScalar(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return null;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith('\'') && raw.endsWith('\''))
  ) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseTaskYaml(taskYamlPath) {
  const text = readFileSync(taskYamlPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\s*- /.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    const value = rawValue.trim();
    if (value === '|' || value === '|-') {
      const block = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.startsWith('  ')) {
          block.push(next.slice(2));
          i = j;
          continue;
        }
        if (!next.trim()) {
          block.push('');
          i = j;
          continue;
        }
        break;
      }
      data[key] = block.join('\n').replace(/\n+$/g, '');
      continue;
    }
    data[key] = parseScalar(value);
  }
  return data;
}

function inferLongcliRoot(taskDir) {
  let current = path.resolve(taskDir);
  while (true) {
    const makePytestDockerfile = path.join(current, 'longcli_dockerImage', 'Dockerfile.make-pytest-base');
    const cEnvDockerfile = path.join(current, 'longcli_dockerImage', 'Dockerfile.c-env-base');
    if (existsSync(makePytestDockerfile) || existsSync(cEnvDockerfile)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function extractDockerBaseImage(dockerfilePath) {
  const content = readFileSync(dockerfilePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*FROM\s+([^\s#]+)/i);
    if (match) return match[1];
  }
  return null;
}

function ensureLongcliBaseImage(baseImage, longcliRoot, logPath) {
  if (!baseImage) return;
  const inspect = runCommand('docker', ['image', 'inspect', baseImage]);
  if (inspect.status === 0) return;
  const dockerfileMap = {
    'tb/make-pytest:v0': 'Dockerfile.make-pytest-base',
    'tb/c-env:v0': 'Dockerfile.c-env-base',
  };
  const dockerfileName = dockerfileMap[baseImage];
  if (!dockerfileName) {
    throw new Error(`missing Docker base image ${baseImage} and no known builder mapping`);
  }
  if (!longcliRoot) {
    throw new Error(`missing Docker base image ${baseImage}; pass --longcli-root so it can be built`);
  }
  const dockerfilePath = path.join(longcliRoot, 'longcli_dockerImage', dockerfileName);
  if (!existsSync(dockerfilePath)) {
    throw new Error(`required base image Dockerfile not found: ${dockerfilePath}`);
  }
  const build = runCommand('docker', ['build', '-f', dockerfilePath, '-t', baseImage, longcliRoot]);
  writeText(logPath, commandResultText(build));
  ensureCommandOk(build, `docker build ${baseImage}`);
}

function urlEncode(value) {
  return encodeURIComponent(value);
}

function fetchBackendAgentStatus(backendUrl, agentName) {
  const url = `${backendUrl}/api/agents/${urlEncode(agentName)}`;
  const result = runCommand('curl', ['--noproxy', '*', '-s', url]);
  ensureCommandOk(result, `curl ${url}`);
  return JSON.parse(result.stdout || '{}');
}

function markBackendAgentOffline(backendUrl, agentName, reason = 'benchmark-force-stop') {
  const url = `${backendUrl}/api/agents/${urlEncode(agentName)}/offline`;
  const payload = JSON.stringify({
    reason,
    clearTmux: true,
    manualDown: true,
  });
  const result = runCommand('curl', [
    '--noproxy', '*',
    '-s',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    url,
  ]);
  ensureCommandOk(result, `curl POST ${url}`);
  return JSON.parse(result.stdout || '{}');
}

function captureTmuxPane(target, lines = 4000) {
  const result = runCommand('tmux', ['capture-pane', '-p', '-S', `-${lines}`, '-t', target]);
  if (result.status !== 0) return null;
  return result.stdout || '';
}

function waitForSentinel(target, sentinel, timeoutSec, pollIntervalSec) {
  const deadline = Date.now() + (timeoutSec * 1000);
  let lastPane = '';
  while (Date.now() < deadline) {
    const pane = captureTmuxPane(target, 12000);
    if (pane) {
      lastPane = pane;
      if (pane.includes(sentinel)) {
        return { found: true, pane };
      }
    }
    sleepMs(Math.max(1, pollIntervalSec) * 1000);
  }
  return { found: false, pane: lastPane };
}

function forceStopBenchmarkAgent(agentName, backendUrl, reason = 'benchmark-force-stop') {
  const target = `=${agentName}`;
  const hasSession = runCommand('tmux', ['has-session', '-t', target]);
  if (hasSession.status === 0) {
    const killResult = runCommand('tmux', ['kill-session', '-t', target]);
    ensureCommandOk(killResult, `tmux kill-session ${agentName}`);
  }
  return markBackendAgentOffline(backendUrl, agentName, reason);
}

function parsePytestSummary(content) {
  if (!content || !/short test summary info/i.test(content)) {
    return { isPass: 0, stepScore: 0, results: {} };
  }
  const parts = content.split(/=+\s*short test summary info\s*=+/i);
  const summary = parts.slice(1).join('\n');
  const results = {};
  for (const rawLine of summary.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cleaned = line.startsWith('FAILED') ? line.split(' - ').slice(0, -1).join(' - ') || line : line;
    const match = cleaned.match(/^(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\s+(.+)$/);
    if (!match) continue;
    const status = match[1];
    const testName = match[2].trim().split('::').slice(-1)[0];
    if (!testName) continue;
    results[testName] = ['PASSED', 'SKIPPED', 'XFAIL'].includes(status) ? 1 : 0;
  }
  const names = Object.keys(results);
  if (!names.length) return { isPass: 0, stepScore: 0, results: {} };
  const passed = names.reduce((sum, name) => sum + results[name], 0);
  const total = names.length;
  return {
    isPass: passed === total ? 1 : 0,
    stepScore: Number((passed / total).toFixed(3)),
    results,
  };
}

function readScoreJson(scorePath) {
  const payload = readJson(scorePath, null);
  if (!payload || typeof payload !== 'object') {
    return { isPass: 0, stepScore: 0 };
  }
  return {
    isPass: Number(payload.is_pass) === 1 ? 1 : 0,
    stepScore: Number.isFinite(Number(payload.step_score))
      ? Number(Number(payload.step_score).toFixed(3))
      : 0,
  };
}

function computeLongcliMetrics(task, testOutputDir) {
  const metrics = {
    parserName: task.parser_name || null,
    f2pMode: task.parser_results_f2p || null,
    p2pMode: task.parser_results_p2p || null,
  };
  const readTextIfPresent = (filePath) => {
    if (!existsSync(filePath)) return '';
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  };

  if ((task.parser_results_f2p || '').toLowerCase() === 'pytest') {
    Object.assign(metrics, {
      f2p_is_pass: 0,
      f2p_step_score: 0,
      f2p_pytest_results: {},
      ...(() => {
        const parsed = parsePytestSummary(readTextIfPresent(path.join(testOutputDir, 'f2p_output.txt')));
        return {
          f2p_is_pass: parsed.isPass,
          f2p_step_score: parsed.stepScore,
          f2p_pytest_results: parsed.results,
        };
      })(),
    });
  } else if ((task.parser_results_f2p || '').toLowerCase() === 'text') {
    const score = readScoreJson(path.join(testOutputDir, 'f2p_score.json'));
    metrics.f2p_is_pass = score.isPass;
    metrics.f2p_step_score = score.stepScore;
  }

  if ((task.parser_results_p2p || '').toLowerCase() === 'pytest') {
    Object.assign(metrics, {
      p2p_is_pass: 0,
      p2p_step_score: 0,
      p2p_pytest_results: {},
      ...(() => {
        const parsed = parsePytestSummary(readTextIfPresent(path.join(testOutputDir, 'p2p_output.txt')));
        return {
          p2p_is_pass: parsed.isPass,
          p2p_step_score: parsed.stepScore,
          p2p_pytest_results: parsed.results,
        };
      })(),
    });
  } else if ((task.parser_results_p2p || '').toLowerCase() === 'text') {
    const score = readScoreJson(path.join(testOutputDir, 'p2p_score.json'));
    metrics.p2p_is_pass = score.isPass;
    metrics.p2p_step_score = score.stepScore;
  }

  const requireF2p = ['pytest', 'text'].includes(String(task.parser_results_f2p || '').toLowerCase());
  const requireP2p = ['pytest', 'text'].includes(String(task.parser_results_p2p || '').toLowerCase());
  const okF2p = !requireF2p || Number(metrics.f2p_is_pass) === 1;
  const okP2p = !requireP2p || Number(metrics.p2p_is_pass) === 1;
  metrics.pass = (requireF2p || requireP2p) ? (okF2p && okP2p) : false;
  const stepScores = [];
  if (requireF2p && Number.isFinite(Number(metrics.f2p_step_score))) stepScores.push(Number(metrics.f2p_step_score));
  if (requireP2p && Number.isFinite(Number(metrics.p2p_step_score))) stepScores.push(Number(metrics.p2p_step_score));
  metrics.score = stepScores.length
    ? Number((stepScores.reduce((sum, value) => sum + value, 0) / stepScores.length).toFixed(3))
    : 0;
  return metrics;
}

function refreshRunSummary(runtimeRoot, runId) {
  const runPaths = buildBenchmarkRunPaths(runtimeRoot, runId);
  const run = readJson(runPaths.runJsonPath, null);
  if (!run) throw new Error(`run not found while refreshing summary: ${runPaths.runJsonPath}`);
  const trials = [];
  for (const entry of readdirSync(runPaths.trialsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const trialJsonPath = path.join(runPaths.trialsDir, entry.name, 'trial.json');
    const trial = readJson(trialJsonPath, null);
    if (trial) trials.push(trial);
  }
  const completedTrials = trials.filter((trial) => trial?.runtimeStatus === 'completed');
  const passedTrials = completedTrials.filter((trial) => trial?.result?.pass === true);
  const failedTrials = completedTrials.filter((trial) => trial?.result?.pass === false);
  const scores = completedTrials
    .map((trial) => Number(trial?.result?.score))
    .filter((value) => Number.isFinite(value));
  run.summaryMetrics = {
    totalTrials: Array.isArray(run?.taskSet?.tasks) ? (run.taskSet.tasks.length * parsePositiveInt(run.attempts, 1)) : trials.length,
    completedTrials: completedTrials.length,
    passedTrials: passedTrials.length,
    failedTrials: failedTrials.length,
    score: scores.length
      ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(3))
      : null,
  };
  run.status = run.summaryMetrics.completedTrials >= run.summaryMetrics.totalTrials ? 'completed' : 'running';
  if (run.status === 'completed') run.completedAt = new Date().toISOString();
  writeJson(runPaths.runJsonPath, run);
  return run;
}

function buildLongcliPrompt({ taskId, task, workdirPath, projectHint, timeoutSec }) {
  const lines = [
    `Benchmark task ${taskId}.`,
    `Use the real LongCLI task bundle already copied into your current workdir: ${workdirPath}`,
    `Task instruction from task.yaml:`,
    task.instruction || '(missing instruction)',
    '',
    `Read and follow ${path.join(workdirPath, 'INSTRUCTION.md')} before editing anything.`,
  ];
  if (projectHint) {
    lines.push(`Implement the task inside ${path.join(workdirPath, projectHint)} unless the task spec says otherwise.`);
  }
  lines.push(
    `Work for up to ${timeoutSec} seconds or until you believe the attempt is complete.`,
    `When you stop this attempt, reply with exactly one line: BENCHMARK_LONGCLI_DONE ${taskId}`,
    'Do not create synthetic benchmark output files; the evaluator will score the task from the real task tests.'
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'task-id') {
      const next = argv[i + 1];
      if (!next) throw new Error('--task-id requires a value');
      if (!Array.isArray(args.taskId)) args.taskId = [];
      args.taskId.push(next);
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next) throw new Error(`${token} requires a value`);
    args[key] = next;
    i += 1;
  }
  return args;
}

function copyDirContents(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true, dereference: false });
}

function copyFileIfPresent(sourcePath, targetPath) {
  if (!sourcePath || !existsSync(sourcePath)) return false;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, { force: true, dereference: false });
  return true;
}

function ensureCleanPath(targetPath) {
  if (!existsSync(targetPath)) return;
  throw new Error(`target already exists: ${targetPath}`);
}

function buildProfilePayload({ profileId, version, description, agentType, docsFiles, claudeSettingsPath, mcpTemplatePath, subconsciousEnabled, notes, createdBy, paths }) {
  return {
    schema: BENCHMARK_PROFILE_SCHEMA,
    profileId,
    version,
    createdAt: new Date().toISOString(),
    description: description || '',
    agentRuntime: {
      agentType,
      modelFamilyDefaults: {
        provider: null,
        model: null,
      },
    },
    docsBundle: {
      root: 'docs',
      files: docsFiles,
    },
    configBundle: {
      claudeSettingsTemplate: claudeSettingsPath ? 'config/claude-settings.json' : null,
      mcpTemplate: mcpTemplatePath ? 'config/mcp.json' : null,
      hooksRuntimeDefaults: {
        executionModel: 'host-v1-home',
        launcher: 'hafleet-up',
        scaffoldOnly: true,
      },
    },
    subconsciousDefaults: {
      enabled: subconsciousEnabled,
      runtimeContractDefaults: {
        configFamily: 'SUBCONSCIOUS_LLM_*',
        guidanceMode: 'runtime-or-manual-fallback',
        allowedHooks: ['UserPromptSubmit', 'PreToolUse'],
      },
      memoryMode: {
        kind: 'local-episodic-journal',
        path: 'state/subconscious/memory.json',
      },
    },
    metadata: {
      createdBy: createdBy || 'unknown',
      notes: notes || '',
      storageLayout: {
        profileRoot: paths.profileRoot,
        docsDir: paths.docsDir,
        configDir: paths.configDir,
      },
    },
  };
}

function initProfile(args) {
  const runtimeRoot = args['runtime-root'] || defaultBenchmarkRuntimeRoot(process.env);
  const profileId = normalizeProfileId(args['profile-id']);
  const version = normalizeProfileVersion(args.version);
  const docsDir = resolveAbsDir(args['docs-dir'], '--docs-dir');
  const claudeSettingsPath = resolveAbsFile(args['claude-settings'], '--claude-settings');
  const mcpConfigPath = resolveAbsFile(args['mcp-config'], '--mcp-config', false);
  const description = normalizeText(args.description, 2000) || '';
  const notes = normalizeText(args.notes, 4000) || '';
  const createdBy = normalizeText(args['created-by'], 128) || process.env.USER || 'unknown';
  const agentType = normalizeAgentType(args['agent-type'] || 'claude-code');
  const subconsciousEnabled = parseBool(args['subconscious-enabled'], false);
  if (!profileId) throw new Error('invalid --profile-id');
  if (!version) throw new Error('invalid --version');
  if (!agentType) throw new Error('invalid --agent-type');

  const paths = buildBenchmarkProfilePaths(runtimeRoot, profileId, version);
  ensureCleanPath(paths.profileRoot);
  mkdirSync(paths.profileRoot, { recursive: true });
  mkdirSync(paths.docsDir, { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });
  copyDirContents(docsDir, paths.docsDir);
  copyFileIfPresent(claudeSettingsPath, path.join(paths.configDir, 'claude-settings.json'));
  copyFileIfPresent(mcpConfigPath, path.join(paths.configDir, 'mcp.json'));

  const docsFiles = [];
  const walk = (root, relBase = '') => {
    for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(root, entry.name), rel);
      } else {
        docsFiles.push(rel);
      }
    }
  };
  walk(paths.docsDir);

  writeJson(path.join(paths.configDir, 'subconscious.json'), {
    enabled: subconsciousEnabled,
    runtimeContractDefaults: {
      configFamily: 'SUBCONSCIOUS_LLM_*',
      guidanceMode: 'runtime-or-manual-fallback',
      allowedHooks: ['UserPromptSubmit', 'PreToolUse'],
    },
    memoryMode: {
      kind: 'local-episodic-journal',
      path: 'state/subconscious/memory.json',
    },
  });

  const profile = buildProfilePayload({
    profileId,
    version,
    description,
    agentType,
    docsFiles: docsFiles.sort(),
    claudeSettingsPath,
    mcpTemplatePath: mcpConfigPath,
    subconsciousEnabled,
    notes,
    createdBy,
    paths,
  });
  const errors = validateBenchmarkProfile(profile);
  if (errors.length) throw new Error(`profile validation failed: ${errors.join('; ')}`);
  writeJson(paths.profileJsonPath, profile);

  return {
    ok: true,
    command: 'init-profile',
    runtimeRoot: path.resolve(runtimeRoot),
    profilePath: paths.profileJsonPath,
    profile,
  };
}

function createRun(args) {
  const runtimeRoot = args['runtime-root'] || defaultBenchmarkRuntimeRoot(process.env);
  const profileId = normalizeProfileId(args['profile-id']);
  const version = normalizeProfileVersion(args.version);
  const taskSetId = normalizeTaskId(args['task-set']);
  const taskIds = Array.isArray(args['taskId']) ? args['taskId'].map((item) => normalizeTaskId(item)).filter(Boolean) : [];
  const createdBy = normalizeText(args['created-by'], 128) || process.env.USER || 'unknown';
  const agentType = normalizeAgentType(args['agent-type'] || 'claude-code');
  const modelOverride = normalizeText(args['model-override'], 128);
  const subconsciousMode = normalizeText(args['subconscious-mode'], 128) || 'profile-default';
  const attempts = parsePositiveInt(args.attempts, 1);
  if (!profileId) throw new Error('invalid --profile-id');
  if (!version) throw new Error('invalid --version');
  if (!taskSetId) throw new Error('invalid --task-set');
  if (!taskIds.length) throw new Error('at least one --task-id is required');
  if (!agentType) throw new Error('invalid --agent-type');

  const profilePaths = buildBenchmarkProfilePaths(runtimeRoot, profileId, version);
  if (!existsSync(profilePaths.profileJsonPath)) throw new Error(`profile version not found: ${profilePaths.profileJsonPath}`);
  const profile = readJson(profilePaths.profileJsonPath, null);
  const profileErrors = validateBenchmarkProfile(profile);
  if (profileErrors.length) throw new Error(`profile validation failed: ${profileErrors.join('; ')}`);

  const runId = normalizeTaskId(args['run-id']) || makeRunId(new Date());
  const runPaths = buildBenchmarkRunPaths(runtimeRoot, runId);
  ensureCleanPath(runPaths.runRoot);
  mkdirSync(runPaths.runRoot, { recursive: true });
  mkdirSync(runPaths.trialsDir, { recursive: true });

  const run = {
    schema: BENCHMARK_RUN_SCHEMA,
    runId,
    createdAt: new Date().toISOString(),
    createdBy,
    profile: { profileId, version },
    agentType,
    modelOverride: modelOverride || null,
    subconsciousMode,
    taskSet: {
      id: taskSetId,
      tasks: taskIds.map((taskId) => ({ taskId })),
    },
    attempts,
    status: 'queued',
    outputRoot: runPaths.runRoot,
    summaryMetrics: {
      totalTrials: taskIds.length * attempts,
      completedTrials: 0,
      passedTrials: 0,
      failedTrials: 0,
      score: null,
    },
  };
  const errors = validateBenchmarkRun(run);
  if (errors.length) throw new Error(`run validation failed: ${errors.join('; ')}`);
  writeJson(runPaths.runJsonPath, run);

  return {
    ok: true,
    command: 'create-run',
    runtimeRoot: path.resolve(runtimeRoot),
    runPath: runPaths.runJsonPath,
    run,
  };
}

function prepareTrial(args) {
  const runtimeRoot = args['runtime-root'] || defaultBenchmarkRuntimeRoot(process.env);
  const runId = normalizeTaskId(args['run-id']);
  const taskId = normalizeTaskId(args['task-id'] || (Array.isArray(args.taskId) ? args.taskId[0] : null));
  const attemptIndex = parsePositiveInt(args.attempt, 1);
  const createdBy = normalizeText(args['created-by'], 128) || process.env.USER || 'unknown';
  if (!runId) throw new Error('invalid --run-id');
  if (!taskId) throw new Error('invalid --task-id');

  const runPaths = buildBenchmarkRunPaths(runtimeRoot, runId);
  const run = readJson(runPaths.runJsonPath, null);
  if (!run) throw new Error(`run not found: ${runPaths.runJsonPath}`);
  const runErrors = validateBenchmarkRun(run);
  if (runErrors.length) throw new Error(`run validation failed: ${runErrors.join('; ')}`);
  if (!run.taskSet.tasks.some((row) => normalizeTaskId(row?.taskId) === taskId)) {
    throw new Error(`task ${taskId} not found in run ${runId}`);
  }

  const profilePaths = buildBenchmarkProfilePaths(runtimeRoot, run.profile.profileId, run.profile.version);
  const profile = readJson(profilePaths.profileJsonPath, null);
  if (!profile) throw new Error(`profile not found: ${profilePaths.profileJsonPath}`);
  const profileErrors = validateBenchmarkProfile(profile);
  if (profileErrors.length) throw new Error(`profile validation failed: ${profileErrors.join('; ')}`);

  const trialId = `${taskId}-a${attemptIndex}`;
  const trialAgentName = makeTrialAgentName(runId, taskId, attemptIndex);
  const trialAgentId = makeTrialAgentId(runId, taskId, attemptIndex);
  const trialPaths = buildBenchmarkTrialPaths(runtimeRoot, runId, trialId, trialAgentName, trialAgentId);
  const benchmarkBackendUrl = defaultBenchmarkBackendUrl(process.env);
  const benchmarkBackendPort = defaultBenchmarkBackendPort(process.env);
  const subconsciousEventUrl = benchmarkSubconsciousEventUrl(process.env);
  const subconsciousInvokeUrl = benchmarkSubconsciousInvokeUrl(process.env);
  ensureCleanPath(trialPaths.trialRoot);
  ensureCleanPath(trialPaths.v1Paths.homeDir);
  mkdirSync(trialPaths.trialRoot, { recursive: true });
  mkdirSync(trialPaths.artifactsDir, { recursive: true });
  mkdirSync(trialPaths.logsDir, { recursive: true });
  mkdirSync(trialPaths.taskOutputDir, { recursive: true });

  const provisionJson = execFileSync('node', [
    PROVISION_SCRIPT,
    '--name', trialAgentName,
    '--type', run.agentType === 'codex' ? 'codex' : 'claude',
    '--home', trialPaths.homesRoot,
    '--agent-id', trialAgentId,
    '--subconscious-enabled', profile.subconsciousDefaults.enabled ? 'true' : 'false',
  ], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HAFLEET_API: benchmarkBackendUrl,
      HAFLEET_BACKEND_PORT: String(benchmarkBackendPort),
      HAFLEET_SUBCONSCIOUS_EVENT_URL: subconsciousEventUrl,
      HAFLEET_SUBCONSCIOUS_INVOKE_URL: subconsciousInvokeUrl,
    },
  }).trim();
  const provision = JSON.parse(provisionJson);

  copyDirContents(profilePaths.docsDir, trialPaths.v1Paths.docsDir);
  copyFileIfPresent(path.join(profilePaths.configDir, 'claude-settings.json'), path.join(trialPaths.v1Paths.workdir, '.claude', 'settings.json'));
  copyFileIfPresent(path.join(profilePaths.configDir, 'mcp.json'), path.join(trialPaths.v1Paths.workdir, '.mcp.json'));

  rmSync(trialPaths.profileSnapshotDir, { recursive: true, force: true });
  cpSync(profilePaths.profileRoot, trialPaths.profileSnapshotDir, { recursive: true, force: true, dereference: false });
  copyFileIfPresent(trialPaths.v1Paths.agentJsonPath, path.join(trialPaths.artifactsDir, 'agent-manifest.json'));

  const trial = {
    schema: BENCHMARK_TRIAL_SCHEMA,
    runId,
    trialId,
    taskId,
    attemptIndex,
    createdBy,
    createdAt: new Date().toISOString(),
    profile: {
      profileId: run.profile.profileId,
      version: run.profile.version,
    },
    agentType: run.agentType,
    modelOverride: run.modelOverride || null,
    subconsciousMode: run.subconsciousMode || 'profile-default',
    agentName: trialAgentName,
    agentId: trialAgentId,
    agentHomePath: trialPaths.v1Paths.homeDir,
    workdirPath: trialPaths.v1Paths.workdir,
    outputPath: trialPaths.trialRoot,
    runtimeStatus: 'materialized',
    timestamps: {
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    },
    result: {
      status: 'pending',
      pass: null,
      score: null,
    },
    artifactPaths: {
      runRoot: runPaths.runRoot,
      trialRoot: trialPaths.trialRoot,
      profileSnapshotDir: trialPaths.profileSnapshotDir,
      agentManifestSnapshot: path.join(trialPaths.artifactsDir, 'agent-manifest.json'),
      logsDir: trialPaths.logsDir,
      taskOutputDir: trialPaths.taskOutputDir,
      lettaStatePath: path.join(trialPaths.v1Paths.stateDir, 'letta.json'),
      subconsciousRuntimePath: path.join(trialPaths.v1Paths.stateDir, 'subconscious', 'runtime.json'),
      subconsciousMemoryPath: path.join(trialPaths.v1Paths.stateDir, 'subconscious', 'memory.json'),
    },
    execution: {
      mode: 'host-v1-home-scaffold',
      launcher: 'hafleet-up',
      preparedOnly: true,
      launchPlan: {
        command: ['hafleet', 'up', trialAgentName, trialPaths.v1Paths.workdir, run.agentType === 'codex' ? 'codex' : 'claude', '--fresh'],
        env: {
          HAFLEET_HOMEDIR: trialPaths.homesRoot,
          HAFLEET_BENCH_RUNTIME_DIR: path.resolve(runtimeRoot),
          HAFLEET_RUNTIME_DIR: path.resolve(runtimeRoot),
          HAFLEET_API: benchmarkBackendUrl,
          HAFLEET_BACKEND_PORT: String(benchmarkBackendPort),
          HAFLEET_SUBCONSCIOUS_EVENT_URL: subconsciousEventUrl,
          HAFLEET_SUBCONSCIOUS_INVOKE_URL: subconsciousInvokeUrl,
        },
      },
      notes: 'Batch 1 scaffold only. No live agent launch or benchmark task execution performed.',
    },
    provision: {
      manifestPath: provision.manifestPath,
      lettaPath: provision.lettaPath,
      subconsciousRuntime: provision.subconsciousRuntime || null,
    },
  };
  const errors = validateBenchmarkTrial(trial);
  if (errors.length) throw new Error(`trial validation failed: ${errors.join('; ')}`);
  writeJson(trialPaths.trialJsonPath, trial);

  return {
    ok: true,
    command: 'prepare-trial',
    runtimeRoot: path.resolve(runtimeRoot),
    trialPath: trialPaths.trialJsonPath,
    trial,
  };
}

function runLongcliTrial(args) {
  const runtimeRoot = args['runtime-root'] || defaultBenchmarkRuntimeRoot(process.env);
  const taskDir = resolveAbsDir(args['task-dir'], '--task-dir');
  const longcliRoot = args['longcli-root']
    ? resolveAbsDir(args['longcli-root'], '--longcli-root')
    : inferLongcliRoot(taskDir);
  const agentTimeoutSec = parsePositiveInt(args['agent-timeout-sec'], 480);
  const pollIntervalSec = parsePositiveInt(args['poll-interval-sec'], 10);

  const prepared = prepareTrial(args);
  const trial = prepared.trial;
  const trialPaths = buildBenchmarkTrialPaths(runtimeRoot, trial.runId, trial.trialId, trial.agentName, trial.agentId);
  const taskYamlPath = path.join(taskDir, 'task.yaml');
  const instructionPath = path.join(taskDir, 'INSTRUCTION.md');
  const dockerfilePath = path.join(taskDir, 'Dockerfile');
  const runTestsPath = path.join(taskDir, 'run-tests.sh');
  const testsDir = path.join(taskDir, 'tests');
  if (!existsSync(taskYamlPath)) throw new Error(`LongCLI task missing task.yaml: ${taskYamlPath}`);
  if (!existsSync(instructionPath)) throw new Error(`LongCLI task missing INSTRUCTION.md: ${instructionPath}`);
  if (!existsSync(dockerfilePath)) throw new Error(`LongCLI task missing Dockerfile: ${dockerfilePath}`);
  if (!existsSync(runTestsPath)) throw new Error(`LongCLI task missing run-tests.sh: ${runTestsPath}`);
  if (!existsSync(testsDir)) throw new Error(`LongCLI task missing tests directory: ${testsDir}`);

  const task = parseTaskYaml(taskYamlPath);
  const taskSourceSnapshotDir = path.join(trialPaths.trialRoot, 'longcli-task-source');
  const testOutputDir = path.join(trialPaths.taskOutputDir, 'test_output');
  const promptPath = path.join(trialPaths.artifactsDir, 'longcli-task-prompt.txt');
  const onlineStatusPath = path.join(trialPaths.artifactsDir, 'agent-status-online.json');
  const offlineStatusPath = path.join(trialPaths.artifactsDir, 'agent-status-offline.json');
  const taskYamlSnapshotPath = path.join(trialPaths.artifactsDir, 'longcli-task.yaml');
  const instructionSnapshotPath = path.join(trialPaths.artifactsDir, 'longcli-INSTRUCTION.md');
  const baseBuildLogPath = path.join(trialPaths.logsDir, 'docker-base-build.log');
  const imageBuildLogPath = path.join(trialPaths.logsDir, 'docker-task-build.log');
  const dockerRunLogPath = path.join(trialPaths.logsDir, 'docker-run-tests.log');
  const dockerContainerLogPath = path.join(trialPaths.logsDir, 'docker-container.log');
  const dockerCleanupLogPath = path.join(trialPaths.logsDir, 'docker-cleanup.log');
  const projectHint = (() => {
    const dirs = readdirSync(taskDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['tests'].includes(entry.name))
      .map((entry) => entry.name);
    return dirs.length === 1 ? dirs[0] : null;
  })();

  rmSync(taskSourceSnapshotDir, { recursive: true, force: true });
  cpSync(taskDir, taskSourceSnapshotDir, { recursive: true, force: true, dereference: false });
  copyDirEntries(taskDir, trialPaths.v1Paths.workdir);
  writeText(taskYamlSnapshotPath, readFileSync(taskYamlPath, 'utf-8'));
  writeText(instructionSnapshotPath, readFileSync(instructionPath, 'utf-8'));

  const prompt = buildLongcliPrompt({
    taskId: trial.taskId,
    task,
    workdirPath: trialPaths.v1Paths.workdir,
    projectHint,
    timeoutSec: agentTimeoutSec,
  });
  writeText(promptPath, `${prompt}\n`);

  const launchEnv = {
    ...process.env,
    ...(trial.execution?.launchPlan?.env || {}),
  };
  const launchStartedAt = new Date().toISOString();
  const upResult = runCommand(
    path.join(REPO_ROOT, 'bin', 'hafleet'),
    ['up', trial.agentName, trialPaths.v1Paths.workdir, trial.agentType === 'codex' ? 'codex' : 'claude', '--fresh'],
    { env: launchEnv }
  );
  ensureCommandOk(upResult, `hafleet up ${trial.agentName}`);

  const backendUrl = launchEnv.HAFLEET_API || defaultBenchmarkBackendUrl(launchEnv);
  writeJson(onlineStatusPath, fetchBackendAgentStatus(backendUrl, trial.agentName));

  const sendEnv = {
    ...launchEnv,
    HAFLEET_WEB_PORT: process.env.HAFLEET_WEB_PORT || '18184',
    HAFLEET_WEB_URL: process.env.HAFLEET_WEB_URL || 'http://127.0.0.1:18184',
  };
  const sendResult = runCommand(
    path.join(REPO_ROOT, 'bin', 'hafleet'),
    ['send', '--force', trial.agentName, prompt],
    { env: sendEnv }
  );
  ensureCommandOk(sendResult, `hafleet send ${trial.agentName}`);

  const sentinel = `BENCHMARK_LONGCLI_DONE ${trial.taskId}`;
  const waitResult = waitForSentinel(`${trial.agentName}:0.0`, sentinel, agentTimeoutSec, pollIntervalSec);
  const transcriptPath = path.join(trialPaths.logsDir, 'tmux-transcript.txt');
  writeText(transcriptPath, waitResult.pane || '');
  let forcedStopBeforeEvaluation = false;
  if (!waitResult.found) {
    forceStopBenchmarkAgent(trial.agentName, backendUrl, 'benchmark-timeout-force-stop');
    forcedStopBeforeEvaluation = true;
  }

  resetLongcliProjectState(trialPaths.v1Paths.workdir, projectHint, taskDir);

  const baseImage = extractDockerBaseImage(path.join(trialPaths.v1Paths.workdir, 'Dockerfile'));
  ensureLongcliBaseImage(baseImage, longcliRoot, baseBuildLogPath);

  const dockerImageName = `hafleet-bench-${sanitizeHandle(`${trial.runId}-${trial.trialId}`)}`;
  const dockerContainerName = `hafleet-bench-${sanitizeHandle(`${trial.runId}-${trial.trialId}`)}`;
  let testStatus = null;
  let metrics = {
    parserName: task.parser_name || null,
    f2pMode: task.parser_results_f2p || null,
    p2pMode: task.parser_results_p2p || null,
    pass: false,
    score: 0,
  };
  try {
    const buildResult = runCommand('docker', ['build', '-f', path.join(trialPaths.v1Paths.workdir, 'Dockerfile'), '-t', dockerImageName, trialPaths.v1Paths.workdir]);
    writeText(imageBuildLogPath, commandResultText(buildResult));
    ensureCommandOk(buildResult, `docker build ${dockerImageName}`);

    const runResult = runCommand(
      'docker',
      ['run', '-d', '--name', dockerContainerName, '-e', 'TEST_DIR=/tests', dockerImageName, 'sh', '-c', 'sleep infinity']
    );
    writeText(dockerRunLogPath, commandResultText(runResult));
    ensureCommandOk(runResult, `docker run ${dockerContainerName}`);

    try {
      const resetContainerState = runCommand(
        'docker',
        [
          'exec',
          dockerContainerName,
          'bash',
          '-lc',
          `rm -rf /app/test_output${projectHint ? ` /app/${projectHint}/build /app/${projectHint}/test` : ''} && mkdir -p /tests`,
        ]
      );
      ensureCommandOk(resetContainerState, 'docker reset project state');
      ensureCommandOk(runCommand('docker', ['cp', runTestsPath, `${dockerContainerName}:/tests/run-tests.sh`]), 'docker cp run-tests.sh');
      copyLongcliTestPayload(dockerContainerName, testsDir);
      const chmodResult = runCommand('docker', ['exec', dockerContainerName, 'bash', '-lc', 'chmod +x /tests/run-tests.sh']);
      ensureCommandOk(chmodResult, 'docker chmod run-tests');
      testStatus = runCommand('docker', ['exec', '-e', 'TEST_DIR=/tests', dockerContainerName, 'bash', '-lc', 'bash /tests/run-tests.sh']);
      writeText(dockerRunLogPath, `${commandResultText(runResult)}\n\n${commandResultText(testStatus)}`.trim());
      mkdirSync(testOutputDir, { recursive: true });
      const copyResult = runCommand('docker', ['cp', `${dockerContainerName}:/app/test_output/.`, testOutputDir]);
      if (copyResult.status !== 0) {
        writeText(dockerRunLogPath, `${readFileSync(dockerRunLogPath, 'utf-8')}\n\n[docker cp test_output failed]\n${commandResultText(copyResult)}`);
      }
      const containerLogs = runCommand('docker', ['logs', dockerContainerName]);
      writeText(dockerContainerLogPath, commandResultText(containerLogs));
    } finally {
      const cleanupLogs = [];
      const rmContainer = runCommand('docker', ['rm', '-f', dockerContainerName]);
      cleanupLogs.push(`[docker rm -f]\n${commandResultText(rmContainer)}`);
      const rmImage = runCommand('docker', ['image', 'rm', '-f', dockerImageName]);
      cleanupLogs.push(`[docker image rm -f]\n${commandResultText(rmImage)}`);
      writeText(dockerCleanupLogPath, cleanupLogs.join('\n\n'));
    }

    metrics = computeLongcliMetrics(task, testOutputDir);
  } finally {
    if (!forcedStopBeforeEvaluation) {
      const downResult = runCommand(
        path.join(REPO_ROOT, 'bin', 'hafleet'),
        ['down', trial.agentName],
        { env: launchEnv }
      );
      if (downResult.status !== 0) {
        const killResult = runCommand(
          path.join(REPO_ROOT, 'bin', 'hafleet'),
          ['down', trial.agentName, '--kill'],
          { env: launchEnv }
        );
        if (killResult.status !== 0) {
          forceStopBenchmarkAgent(trial.agentName, backendUrl, 'benchmark-active-force-stop');
        }
      }
    } else {
      markBackendAgentOffline(backendUrl, trial.agentName, 'benchmark-timeout-force-stop');
    }
    writeJson(offlineStatusPath, fetchBackendAgentStatus(backendUrl, trial.agentName));
  }

  const endedAt = new Date().toISOString();
  const summary = `LongCLI task ${trial.taskId}: f2p=${metrics.f2p_is_pass ?? 'n/a'} (${metrics.f2p_step_score ?? 'n/a'}), p2p=${metrics.p2p_is_pass ?? 'n/a'} (${metrics.p2p_step_score ?? 'n/a'})`;
  const harnessResult = {
    schema: 'hafleet.benchmark.harness-result/v1',
    runId: trial.runId,
    trialId: trial.trialId,
    taskId: trial.taskId,
    status: metrics.pass ? 'passed' : 'failed',
    pass: metrics.pass,
    score: metrics.score,
    startedAt: launchStartedAt,
    endedAt,
    taskSource: {
      kind: 'longcli',
      taskDir: taskDir,
      taskSourceSnapshotDir,
      parserName: task.parser_name || null,
      parserResultsF2p: task.parser_results_f2p || null,
      parserResultsP2p: task.parser_results_p2p || null,
      dockerBaseImage: baseImage,
    },
    agent: {
      name: trial.agentName,
      promptPath,
      sentinel,
      sentinelFound: waitResult.found,
      forcedStopBeforeEvaluation,
      timeoutSec: agentTimeoutSec,
      pollIntervalSec,
    },
    evaluation: {
      dockerImageName,
      dockerContainerName,
      dockerBuildLogPath: imageBuildLogPath,
      dockerRunLogPath,
      dockerContainerLogPath,
      dockerCleanupLogPath,
      testExitCode: testStatus?.status ?? null,
      metrics,
    },
    outputs: {
      testOutputDir,
      f2pOutputPath: path.join(testOutputDir, 'f2p_output.txt'),
      f2pScorePath: path.join(testOutputDir, 'f2p_score.json'),
      p2pOutputPath: path.join(testOutputDir, 'p2p_output.txt'),
      p2pScorePath: path.join(testOutputDir, 'p2p_score.json'),
    },
  };
  const taskSummary = {
    schema: 'hafleet.benchmark.task-result-summary/v1',
    taskId: trial.taskId,
    agent: trial.agentName,
    status: metrics.pass ? 'passed' : 'failed',
    summary,
    result: {
      completedAt: endedAt,
      sentinelFound: waitResult.found,
      taskDir,
      parserName: task.parser_name || null,
      f2p: {
        mode: task.parser_results_f2p || null,
        isPass: metrics.f2p_is_pass ?? null,
        stepScore: metrics.f2p_step_score ?? null,
      },
      p2p: {
        mode: task.parser_results_p2p || null,
        isPass: metrics.p2p_is_pass ?? null,
        stepScore: metrics.p2p_step_score ?? null,
      },
    },
  };
  writeJson(path.join(trialPaths.trialRoot, 'benchmark-harness-result.json'), harnessResult);
  writeJson(path.join(trialPaths.trialRoot, 'task-result-summary.json'), taskSummary);

  trial.runtimeStatus = 'completed';
  trial.timestamps = {
    ...(trial.timestamps || {}),
    startedAt: launchStartedAt,
    endedAt,
  };
  trial.result = {
    status: metrics.pass ? 'passed' : 'failed',
    pass: metrics.pass,
    score: metrics.score,
    summary,
  };
  trial.execution = {
    ...(trial.execution || {}),
    preparedOnly: false,
    executed: true,
    mode: 'host-v1-home-longcli-task',
    notes: `Batch 3 LongCLI task ${trial.taskId} executed through benchmark trial flow in dev.`,
  };
  trial.artifactPaths = {
    ...(trial.artifactPaths || {}),
    longcliTaskSourceDir: taskSourceSnapshotDir,
    longcliPromptPath: promptPath,
    longcliTaskYamlPath: taskYamlSnapshotPath,
    longcliInstructionPath: instructionSnapshotPath,
    onlineStatusPath,
    offlineStatusPath,
    tmuxTranscriptPath: transcriptPath,
    dockerBaseBuildLogPath: baseBuildLogPath,
    dockerTaskBuildLogPath: imageBuildLogPath,
    dockerRunLogPath,
    dockerContainerLogPath,
    dockerCleanupLogPath,
    harnessResultPath: path.join(trialPaths.trialRoot, 'benchmark-harness-result.json'),
    taskResultSummaryPath: path.join(trialPaths.trialRoot, 'task-result-summary.json'),
  };
  writeJson(trialPaths.trialJsonPath, trial);

  const run = refreshRunSummary(runtimeRoot, trial.runId);
  return {
    ok: true,
    command: 'run-longcli-trial',
    runtimeRoot: path.resolve(runtimeRoot),
    runPath: buildBenchmarkRunPaths(runtimeRoot, trial.runId).runJsonPath,
    trialPath: trialPaths.trialJsonPath,
    run,
    trial,
    harnessResult,
    taskSummary,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    usage();
    process.exit(0);
  }
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  ensureBenchmarkRuntimeRoot(args['runtime-root'] || defaultBenchmarkRuntimeRoot(process.env));

  let result;
  if (command === 'init-profile') result = initProfile(args);
  else if (command === 'create-run') result = createRun(args);
  else if (command === 'prepare-trial') result = prepareTrial(args);
  else if (command === 'run-longcli-trial') result = runLongcliTrial(args);
  else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
