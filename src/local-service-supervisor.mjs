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
    return command.includes(service.command[1]);
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

async function probeOwnHealth(service, record, env) {
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
    startedAt: null,
    startedAtMs: 0,
    lastExit: null,
  };
}

async function buildStatus(profile, records, env, { supervisorHealthy = true } = {}) {
  const services = [];
  const byName = new Map();
  const ownResults = await Promise.all(profile.services.map(async (service) => {
    const record = records.get(service.name) || emptyRecord(service.name);
    const own = supervisorHealthy
      ? await probeOwnHealth(service, record, env)
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

function statePaths(runtimeRoot) {
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
    { supervisorHealthy },
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
    dependencyTimeoutMs = 15000,
  }) {
    this.profile = profile;
    this.repoRoot = path.resolve(repoRoot);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.env = { ...env };
    this.restartDelayMs = Math.max(10, Number(restartDelayMs) || 500);
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
      this._writeState();
      if (!this.running || record.desired !== 'running') return;
      record.restartTimer = setTimeout(() => {
        record.restartTimer = null;
        if (!this.running || record.desired !== 'running') return;
        record.restarts += 1;
        this._spawnService(service);
      }, this.restartDelayMs);
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
    return buildStatus(this.profile, this.records, this.env);
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
