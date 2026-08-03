#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRuntimeDir } from '../lib/runtime-dir-guard.js';
import {
  LocalServiceSupervisor,
  diagnoseServices,
  readServiceStatus,
  statePaths,
} from '../src/local-service-supervisor.mjs';
import { loadServiceProfile } from '../src/service-profile.mjs';
import {
  getProcessStartIdentity,
  pidAlive,
  processIdentityMatches,
} from '../src/process-identity.mjs';

const cliPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(cliPath));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  if (argv.length === 0) throw new Error('command is required: start|run|status|doctor|stop');
  const command = argv[0];
  if (!['start', 'run', 'status', 'doctor', 'stop'].includes(command)) {
    throw new Error(`unknown command ${command}`);
  }
  let profilePath = path.join(repoRoot, 'services', 'services-local.json');
  let runtimeRoot = process.env.HAFLEET_RUNTIME_DIR
    ? path.resolve(process.env.HAFLEET_RUNTIME_DIR)
    : repoRoot;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--profile' || arg === '--runtime') {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[index + 1];
      index += 1;
      if (arg === '--profile') profilePath = path.resolve(value);
      else runtimeRoot = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  assertRuntimeDir(runtimeRoot);
  return { command, profilePath, runtimeRoot, json };
}

function runtimePaths(runtimeRoot) {
  // stateDir/statePath/logDir come from the supervisor so the two cannot drift.
  const { stateDir: dir, statePath, logDir } = statePaths(runtimeRoot);
  return {
    dir,
    statePath,
    logDir,
    pidPath: path.join(dir, 'supervisor.pid.json'),
    logPath: path.join(dir, 'supervisor.log'),
    startLockPath: path.join(dir, 'start.lock.json'),
  };
}

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filename);
}

function supervisorCommandMatches(pid, runtimeRoot) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    // The supervisor is started as `node services/hafleet-services.mjs run ...`
    // from the runtime root, so ps reports a RELATIVE script path while cliPath is
    // absolute. Testing only the absolute form meant this never matched and `stop`
    // refused with "supervisor PID belongs to an unexpected process" — the fleet
    // could not be stopped through its own CLI. Observed on a fleet host, where
    // the command line was exactly:
    //   node services/hafleet-services.mjs run --profile ... --runtime <runtime-root>
    const relativeCli = path.relative(runtimeRoot, cliPath);
    const namesThisCli = command.includes(cliPath)
      || (Boolean(relativeCli) && !relativeCli.startsWith('..') && command.includes(relativeCli));
    return namesThisCli && command.includes(' run ') && command.includes(runtimeRoot);
  } catch {
    return false;
  }
}

async function withStartLock(paths, operation) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const deadline = Date.now() + 12000;
  while (true) {
    let fd = null;
    try {
      fd = openSync(paths.startLockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({
        pid: process.pid,
        token,
        processStartIdentity: getProcessStartIdentity(process.pid),
      })}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (error?.code !== 'EEXIST') throw error;
      const owner = readJson(paths.startLockPath);
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(paths.startLockPath).mtimeMs; } catch {}
      if (ageMs > 1000 && !processIdentityMatches(owner)) {
        rmSync(paths.startLockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for concurrent start operation');
      await sleep(50);
    }
  }
  try {
    return await operation();
  } finally {
    const owner = readJson(paths.startLockPath);
    if (owner?.token === token) rmSync(paths.startLockPath, { force: true });
  }
}

function serviceCommandMatches(pid, service) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: Math.min(service.health.timeoutMs, 1000),
    });
    return command.includes('supervised-service-child.mjs') && command.includes(service.command[1]);
  } catch {
    return false;
  }
}

async function reclaimRecordedServices(profile, snapshot) {
  const records = new Map((snapshot?.services || []).map((record) => [record.name, record]));
  const targets = [];
  for (const service of [...profile.services].reverse()) {
    const record = records.get(service.name);
    if (!record || !processIdentityMatches(record) || !serviceCommandMatches(record.pid, service)) continue;
    try {
      process.kill(record.pid, 'SIGTERM');
      targets.push(record.pid);
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (targets.some(pidAlive) && Date.now() < deadline) await sleep(50);
  for (const pid of targets.filter(pidAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function output(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value.services)) {
    for (const service of value.services) {
      process.stdout.write(`${service.healthy ? 'healthy' : 'not-healthy'}\t${service.name}\tpid=${service.pid || '-'}${service.reason ? `\t${service.reason}` : ''}\n`);
    }
  }
  if (Array.isArray(value.failures)) {
    for (const failure of value.failures) process.stdout.write(`failure\t${failure.name}\t${failure.cause}\n`);
  }
  // Each service's stdout and stderr go to its own file under the runtime state
  // directory, NOT to the launchd/systemd log the installer prints. Nothing used
  // to say so, which meant the one place a diagnosis lives was undiscoverable
  // without reading _spawnService in src/local-service-supervisor.mjs.
  if (value.logDir) {
    process.stdout.write(`\nservice logs: ${value.logDir}/<service>.log\n`);
    if (Array.isArray(value.services) && value.services.length) {
      const unhealthy = value.services.filter((s) => !s.healthy).map((s) => s.name);
      const suggest = unhealthy.length ? unhealthy : value.services.map((s) => s.name);
      process.stdout.write(`  tail -50 ${value.logDir}/${suggest[0]}.log\n`);
    }
  }
}

async function runSupervisor({ profile, profilePath, runtimeRoot, paths }) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const supervisor = new LocalServiceSupervisor({
    profile,
    repoRoot,
    runtimeRoot,
    env: process.env,
  });
  writeJsonAtomic(paths.pidPath, {
    pid: process.pid,
    token: supervisor.token,
    processStartIdentity: supervisor.processStartIdentity,
    runtimeRoot,
    profile: profile.name,
    startedAt: new Date().toISOString(),
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop().catch(() => {});
    const current = readJson(paths.pidPath);
    if (current?.pid === process.pid && current?.token === supervisor.token) {
      rmSync(paths.pidPath, { force: true });
    }
    process.exitCode = signal ? 0 : process.exitCode;
  };
  process.once('SIGTERM', () => { stop('SIGTERM').finally(() => process.exit(0)); });
  process.once('SIGINT', () => { stop('SIGINT').finally(() => process.exit(0)); });

  // SIGHUP re-reads the profile and applies additions and removals in place.
  // Without it, dropping one supervised agent meant restarting the whole fleet,
  // which is how a single crash-looping agent turned into a backend outage.
  // `once` is wrong here: a reload must be repeatable.
  let reloading = false;
  process.on('SIGHUP', () => {
    if (reloading || stopping) return;
    reloading = true;
    (async () => {
      try {
        const next = loadServiceProfile({ profilePath, repoRoot });
        const { added, removed, changed } = await supervisor.reconcile(next);
        const summary = [
          removed.length ? `removed ${removed.join(', ')}` : null,
          added.length ? `added ${added.join(', ')}` : null,
          // Named, not applied — see reconcile().
          changed.length ? `${changed.join(', ')} changed but left running (restart to apply)` : null,
        ].filter(Boolean).join('; ') || 'no changes';
        process.stdout.write(`[hafleet-services] reload: ${summary}\n`);
      } catch (error) {
        // A reload that fails must leave the running fleet exactly as it was.
        process.stderr.write(`[hafleet-services] reload failed, keeping the running profile: ${error.message}\n`);
      } finally {
        reloading = false;
      }
    })();
  });

  try {
    await supervisor.start();
    await new Promise(() => {});
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startDetached({ profile, profilePath, runtimeRoot, paths }) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const existing = readJson(paths.pidPath);
  if (existing && pidAlive(existing.pid)) {
    if (processIdentityMatches(existing) && supervisorCommandMatches(existing.pid, runtimeRoot)) {
      return readServiceStatus({ profile, runtimeRoot, env: process.env });
    }
    throw new Error('existing supervisor PID belongs to an unexpected process identity');
  }
  if (existing) {
    await reclaimRecordedServices(profile, readJson(paths.statePath));
    rmSync(paths.pidPath, { force: true });
  }

  const logFd = openSync(paths.logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [
      cliPath, 'run', '--profile', profilePath, '--runtime', runtimeRoot,
    ], {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: false,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const pidRecord = readJson(paths.pidPath);
    if (pidRecord && !pidAlive(pidRecord.pid)) break;
    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    if (status.ok) return status;
    await sleep(50);
  }
  const diagnosis = await diagnoseServices({ profile, runtimeRoot, env: process.env });
  throw new Error(`services did not become healthy: ${diagnosis.failures.map((item) => `${item.name}: ${item.cause}`).join('; ')}`);
}

async function stopDetached({ profile, runtimeRoot, paths }) {
  const pidRecord = readJson(paths.pidPath);
  const snapshot = readJson(paths.statePath);
  if (!pidRecord) return { ok: true, stopped: false, reason: 'supervisor not running', services: [] };
  if (!snapshot?.supervisor
      || snapshot.supervisor.pid !== pidRecord.pid
      || snapshot.supervisor.token !== pidRecord.token) {
    throw new Error('supervisor PID record token does not match state');
  }
  if (!pidAlive(pidRecord.pid)) {
    await reclaimRecordedServices(profile, snapshot);
    rmSync(paths.pidPath, { force: true });
    const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
    return { ok: true, stopped: true, reason: 'stale supervisor and services recovered', services: status.services };
  }
  if (!processIdentityMatches(pidRecord)) {
    throw new Error('supervisor PID start identity does not match the recorded process');
  }
  if (!supervisorCommandMatches(pidRecord.pid, runtimeRoot)) {
    throw new Error('supervisor PID belongs to an unexpected process');
  }
  process.kill(pidRecord.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(pidRecord.pid)) await sleep(50);
  if (pidAlive(pidRecord.pid)) throw new Error('supervisor did not stop within 5000ms');
  rmSync(paths.pidPath, { force: true });
  const status = await readServiceStatus({ profile, runtimeRoot, env: process.env });
  return { ok: true, stopped: true, services: status.services };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = loadServiceProfile({ profilePath: options.profilePath, repoRoot });
  const paths = runtimePaths(options.runtimeRoot);
  let result;
  if (options.command === 'run') {
    await runSupervisor({ profile, profilePath: options.profilePath, runtimeRoot: options.runtimeRoot, paths });
    return;
  }
  if (options.command === 'start') {
    result = await withStartLock(paths, () => startDetached({ ...options, profile, paths }));
  } else if (options.command === 'status') {
    result = await readServiceStatus({ profile, runtimeRoot: options.runtimeRoot, env: process.env });
  } else if (options.command === 'doctor') {
    result = await diagnoseServices({ profile, runtimeRoot: options.runtimeRoot, env: process.env });
  } else {
    result = await stopDetached({ profile, runtimeRoot: options.runtimeRoot, paths });
  }
  if (result && typeof result === 'object' && !result.logDir) result.logDir = paths.logDir;
  output(result, options.json);
  if ((options.command === 'status' || options.command === 'doctor') && !result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`[hafleet-services] ${error.message}\n`);
  process.exitCode = 1;
});
