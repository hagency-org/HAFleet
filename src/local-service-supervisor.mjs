import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';

import { healthPaths } from './health-record.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  getProcessStartIdentity,
  pidAlive,
  processIdentityMatches,
} from './process-identity.mjs';

const STATE_SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);
const childWrapperPath = fileURLToPath(new URL('./supervised-service-child.mjs', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pidMatchesService(pid, service) {
  try {
    const { stdout: command } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: Math.min(service.health.timeoutMs, 1000),
    });
    if (!command.includes(service.command[1])) return false;
    // Every supervised ACP agent runs the same script, so the script path alone
    // cannot tell two of them apart — each would happily match the other's
    // process and report itself healthy while its own child was dead. Anything
    // sharing a script must also match its distinguishing arguments.
    const discriminators = service.command.slice(2);
    return discriminators.every((argument) => command.includes(argument));
  } catch {
    return false;
  }
}

function resolvePort(health, env) {
  const candidate = health.portEnv ? Number(env[health.portEnv]) : NaN;
  return Number.isInteger(candidate) && candidate > 0 && candidate <= 65535
    ? candidate
    : health.defaultPort;
}

async function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function probeHttp(health, env) {
  const port = resolvePort(health, env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), health.timeoutMs);
  try {
    const response = await fetch(`http://${health.host}:${port}${health.path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Freshness probe against a component's own health record.
 *
 * The bridge and relay expose no port, so a 'process' probe can only assert that
 * the PID is alive — which reported a crash-looping bridge as healthy on a real
 * fleet host, because it died between the check and the next one. Both components
 * already write records via src/health-record.mjs, and standalone-doctor.mjs
 * already reads them; this reuses that signal in the supervisor's own probe.
 *
 * Absent or unparseable is unhealthy, not an error: a component that has never
 * written a record has not come up.
 */
async function probeHealthRecord(health, runtimeRoot) {
  if (!runtimeRoot) return { ok: false, reason: 'health record probe has no runtime root' };
  const paths = healthPaths(runtimeRoot);
  const filePath = health.component === 'bridge' ? paths.bridgePath : paths.relayPath;

  let record;
  try {
    record = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT'
        ? 'health record has not been written yet'
        : 'health record is unreadable',
    };
  }

  const generatedAt = Date.parse(record?.generatedAt ?? '');
  if (!Number.isFinite(generatedAt)) {
    return { ok: false, reason: 'health record has no usable generatedAt' };
  }
  const ageMs = Date.now() - generatedAt;
  if (ageMs > health.maxAgeMs) {
    return { ok: false, reason: `health record is stale by ${Math.round((ageMs - health.maxAgeMs) / 1000)}s` };
  }
  // A clock that has jumped backwards should not read as healthy either.
  if (ageMs < -health.maxAgeMs) {
    return { ok: false, reason: 'health record is timestamped in the future' };
  }
  return { ok: true, reason: null };
}

async function probeOwnHealth(service, record, env, runtimeRoot) {
  if (record.desired !== 'running') return { healthy: false, reason: 'service explicitly stopped' };
  if (!pidAlive(record.pid)) return { healthy: false, reason: 'service process is not running' };
  if (!processIdentityMatches(record)) {
    return { healthy: false, reason: 'service process start identity does not match the recorded identity' };
  }
  if (!await pidMatchesService(record.pid, service)) {
    return { healthy: false, reason: 'service PID command does not match the configured script' };
  }
  if (service.health.type === 'process') {
    const stableForMs = Date.now() - Number(record.startedAtMs || 0);
    return stableForMs >= 25
      ? { healthy: true, reason: null }
      : { healthy: false, reason: 'service process is still starting' };
  }
  if (service.health.type === 'record') {
    const result = await probeHealthRecord(service.health, runtimeRoot);
    return result.ok ? { healthy: true, reason: null } : { healthy: false, reason: result.reason };
  }
  const port = resolvePort(service.health, env);
  const ok = service.health.type === 'tcp'
    ? await probeTcp(service.health.host, port, service.health.timeoutMs)
    : await probeHttp(service.health, env);
  return ok
    ? { healthy: true, reason: null }
    : { healthy: false, reason: `${service.health.type} health probe failed` };
}

function emptyRecord(name) {
  return {
    name,
    pid: null,
    processStartIdentity: null,
    desired: 'stopped',
    restarts: 0,
    restartStreak: 0,
    nextRestartDelayMs: 0,
    startedAt: null,
    startedAtMs: 0,
    lastExit: null,
  };
}

async function buildStatus(profile, records, env, { supervisorHealthy = true, runtimeRoot = null } = {}) {
  const services = [];
  const byName = new Map();
  const ownResults = await Promise.all(profile.services.map(async (service) => {
    const record = records.get(service.name) || emptyRecord(service.name);
    const own = supervisorHealthy
      ? await probeOwnHealth(service, record, env, runtimeRoot)
      : { healthy: false, reason: 'supervisor process is not running or identity changed' };
    return { service, record, own };
  }));
  for (const { service, record, own } of ownResults) {
    const dependency = service.dependsOn.find((name) => !byName.get(name)?.healthy);
    const result = {
      name: service.name,
      pid: Number.isInteger(record.pid) ? record.pid : null,
      desired: record.desired === 'running' ? 'running' : 'stopped',
      state: own.healthy && !dependency ? 'healthy' : 'not-healthy',
      healthy: own.healthy && !dependency,
      reason: dependency ? `dependency ${dependency} is not healthy` : own.reason,
      restarts: Number.isInteger(record.restarts) ? record.restarts : 0,
      restartStreak: Number.isInteger(record.restartStreak) ? record.restartStreak : 0,
      nextRestartDelayMs: Number.isInteger(record.nextRestartDelayMs) ? record.nextRestartDelayMs : 0,
      startedAt: record.startedAt || null,
      lastExit: record.lastExit || null,
    };
    services.push(result);
    byName.set(service.name, result);
  }
  return {
    ok: services.every((service) => service.healthy),
    profile: profile.name,
    checkedAt: new Date().toISOString(),
    services,
  };
}

// Exported so callers cannot keep a second copy. The services CLI derived its
// own set and simply had no logDir, which is why nothing ever told an operator
// where a service's stdout actually goes.
export function statePaths(runtimeRoot) {
  const stateDir = path.join(path.resolve(runtimeRoot), 'data', 'services-local');
  return {
    stateDir,
    statePath: path.join(stateDir, 'state.json'),
    logDir: path.join(stateDir, 'logs'),
  };
}

function recordsFromSnapshot(profile, snapshot) {
  const source = Array.isArray(snapshot?.services) ? snapshot.services : [];
  const byName = new Map(source.map((service) => [service.name, service]));
  return new Map(profile.services.map((service) => [
    service.name,
    { ...emptyRecord(service.name), ...(byName.get(service.name) || {}) },
  ]));
}

export async function readServiceStatus({ profile, runtimeRoot, env = process.env }) {
  const { statePath } = statePaths(runtimeRoot);
  let snapshot = null;
  try {
    snapshot = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    snapshot = null;
  }
  const supervisorHealthy = Boolean(snapshot?.supervisor)
    && getProcessStartIdentity(Number(snapshot.supervisor.pid)) === snapshot.supervisor.processStartIdentity;
  const status = await buildStatus(
    profile,
    recordsFromSnapshot(profile, snapshot),
    env,
    { supervisorHealthy, runtimeRoot },
  );
  return {
    ...status,
    supervisor: snapshot?.supervisor || null,
    stateAvailable: snapshot !== null,
  };
}

export async function diagnoseServices(options) {
  const status = await readServiceStatus(options);
  return {
    ...status,
    failures: status.services
      .filter((service) => !service.healthy)
      .map((service) => ({ name: service.name, cause: service.reason || 'unknown health failure' })),
  };
}

export class LocalServiceSupervisor {
  constructor({
    profile,
    repoRoot,
    runtimeRoot,
    env = process.env,
    restartDelayMs = 500,
    // A service that cannot start was restarted every 500ms forever. That is how
    // the Matrix bridge "crash-looped and took the profile's health with it" (see
    // src/service-profile.mjs). Backing off gives a broken service room to look
    // broken instead of drowning the host, and matters more as supervised things
    // multiply: an agent fails for ordinary reasons a core service does not —
    // a model name its API rejects, a missing binary, expired credentials.
    maxRestartDelayMs = 60000,
    // Once a service has stayed up this long, treat it as recovered and start the
    // backoff from scratch. Without this a service that restarts rarely but for
    // years would eventually inherit the maximum delay from history.
    restartBackoffResetMs = 120000,
    dependencyTimeoutMs = 15000,
  }) {
    this.profile = profile;
    this.repoRoot = path.resolve(repoRoot);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.env = { ...env };
    this.restartDelayMs = Math.max(10, Number(restartDelayMs) || 500);
    this.maxRestartDelayMs = Math.max(this.restartDelayMs, Number(maxRestartDelayMs) || 60000);
    this.restartBackoffResetMs = Math.max(1000, Number(restartBackoffResetMs) || 120000);
    this.dependencyTimeoutMs = Math.max(100, Number(dependencyTimeoutMs) || 15000);
    this.running = false;
    this.token = randomUUID();
    this.startedAt = new Date().toISOString();
    this.processStartIdentity = getProcessStartIdentity(process.pid);
    this.records = new Map(profile.services.map((service) => [service.name, {
      ...emptyRecord(service.name),
      child: null,
      restartTimer: null,
    }]));
    const paths = statePaths(this.runtimeRoot);
    this.stateDir = paths.stateDir;
    this.statePath = paths.statePath;
    this.logDir = paths.logDir;
    this.leasePath = path.join(this.stateDir, 'supervisor.lease.json');
    this.leaseTimer = null;
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
  }

  _snapshot() {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      profile: this.profile.name,
      updatedAt: new Date().toISOString(),
      supervisor: {
        pid: process.pid,
        token: this.token,
        startedAt: this.startedAt,
        processStartIdentity: this.processStartIdentity,
      },
      services: this.profile.services.map(({ name }) => {
        const record = this.records.get(name);
        return {
          name,
          pid: record.pid,
          processStartIdentity: record.processStartIdentity,
          desired: record.desired,
          restarts: record.restarts,
          startedAt: record.startedAt,
          startedAtMs: record.startedAtMs,
          lastExit: record.lastExit,
        };
      }),
    };
  }

  _writeState() {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this._snapshot(), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  _writeLease() {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.leasePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ token: this.token, updatedAtMs: Date.now() })}\n`, { mode: 0o600 });
    renameSync(temporary, this.leasePath);
  }

  _startLease() {
    this._writeLease();
    this.leaseTimer = setInterval(() => this._writeLease(), 250);
    this.leaseTimer.unref();
  }

  _stopLease() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
  }

  _spawnService(service) {
    const record = this.records.get(service.name);
    if (record.child && pidAlive(record.pid)) return;
    const logPath = path.join(this.logDir, `${service.name}.log`);
    const logFd = openSync(logPath, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [
        childWrapperPath,
        '--lease', this.leasePath,
        '--token', this.token,
        '--',
        ...service.command,
      ], {
        cwd: this.repoRoot,
        env: { ...this.env, ...service.env },
        detached: process.platform !== 'win32',
        stdio: ['ignore', logFd, logFd],
        shell: false,
      });
    } finally {
      closeSync(logFd);
    }
    record.child = child;
    record.pid = child.pid;
    record.processStartIdentity = getProcessStartIdentity(child.pid);
    record.desired = 'running';
    record.startedAt = new Date().toISOString();
    record.startedAtMs = Date.now();
    record.lastExit = null;
    child.once('exit', (code, signal) => {
      if (record.child !== child) return;
      if (signal && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      record.child = null;
      record.pid = null;
      record.processStartIdentity = null;
      record.lastExit = { code, signal, at: new Date().toISOString() };

      // Exponential backoff, so a service that cannot start stops hammering the
      // host. `restarts` stays a lifetime count for reporting; the streak is what
      // drives the delay, and a service that stayed up past restartBackoffResetMs
      // is treated as recovered rather than carrying its history forward.
      const upForMs = record.startedAtMs ? Date.now() - record.startedAtMs : 0;
      if (upForMs >= this.restartBackoffResetMs) record.restartStreak = 0;
      const streak = Number.isInteger(record.restartStreak) ? record.restartStreak : 0;
      const delay = Math.min(this.restartDelayMs * (2 ** streak), this.maxRestartDelayMs);
      record.restartStreak = streak + 1;
      record.nextRestartDelayMs = delay;

      this._writeState();
      if (!this.running || record.desired !== 'running') return;
      record.restartTimer = setTimeout(() => {
        record.restartTimer = null;
        if (!this.running || record.desired !== 'running') return;
        record.restarts += 1;
        this._spawnService(service);
      }, delay);
    });
    this._writeState();
  }

  async _waitServiceHealthy(name, timeoutMs = this.dependencyTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status();
      const service = status.services.find((item) => item.name === name);
      if (service?.healthy) return service;
      await sleep(25);
    }
    throw new Error(`service ${name} did not become healthy within ${timeoutMs}ms`);
  }

  async start() {
    if (this.running) return this.status();
    this.running = true;
    this._startLease();
    for (const service of this.profile.services) {
      this._spawnService(service);
      await this._waitServiceHealthy(service.name);
    }
    this._writeState();
    return this.status();
  }

  async status() {
    return buildStatus(this.profile, this.records, this.env, { runtimeRoot: this.runtimeRoot });
  }

  async waitForHealthy(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.ok) return status;
      await sleep(25);
    }
    return this.status();
  }

  getServicePid(name) {
    return this.records.get(name)?.pid || null;
  }

  async stopService(name, { restart = false } = {}) {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown service ${name}`);
    record.desired = restart ? 'running' : 'stopped';
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = null;
    }
    const child = record.child;
    if (child && pidAlive(record.pid)) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          if (pidAlive(record.pid)) child.kill('SIGKILL');
          done();
        }, 1500);
        child.once('exit', done);
        child.kill('SIGTERM');
      });
    }
    if (!restart) {
      record.child = null;
      record.pid = null;
      record.processStartIdentity = null;
    }
    this._writeState();
  }

  async stop() {
    this.running = false;
    this._stopLease();
    for (const service of [...this.profile.services].reverse()) {
      await this.stopService(service.name, { restart: false });
    }
    this._writeState();
    rmSync(this.leasePath, { force: true });
    return this.status();
  }
}
