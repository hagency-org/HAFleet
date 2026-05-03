import { afterEach, describe, expect, test, vi } from 'vitest';
import { execFile } from 'child_process';
import { createServer } from 'net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createRuntimeDir(prefix) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(runtimeDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(dataDir, 'agents.json'), {});
  writeJson(path.join(dataDir, 'groups.json'), {});
  writeJson(path.join(dataDir, 'messages.json'), []);
  writeJson(path.join(dataDir, 'cursors.json'), {});
  writeJson(path.join(dataDir, 'servers.json'), {});
  writeJson(path.join(dataDir, 'agent_runtime.json'), {});
  writeJson(path.join(dataDir, 'supervisor_state.json'), { agents: {}, selectionCursor: 0 });
  writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });
  return runtimeDir;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function rememberEnv(keys) {
  const saved = new Map();
  for (const key of keys) saved.set(key, process.env[key]);
  return () => {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function importBackend(runtimeDir) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';
  delete process.env.API_TOKEN;
  const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return import(`${backendUrl}?backend-lifecycle-test=${cacheBust}`);
}

function waitForServerEvent(server, eventName) {
  return new Promise((resolve, reject) => {
    server.once(eventName, resolve);
    if (eventName !== 'error') server.once('error', reject);
  });
}

describe('backend-v2 lifecycle', () => {
  let runtimeDir = null;
  let backendModule = null;
  let restoreEnv = null;
  const blockers = new Set();

  afterEach(async () => {
    try {
      if (backendModule?.stopServer) await backendModule.stopServer();
      for (const blocker of blockers) {
        await new Promise((resolve) => blocker.close(resolve));
      }
      blockers.clear();
    } finally {
      backendModule = null;
      vi.useRealTimers();
      if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
      runtimeDir = null;
      if (restoreEnv) restoreEnv();
      restoreEnv = null;
    }
  });

  test('backend-v2 import and stop do not leave runtime handles active', async () => {
    const probeRuntimeDir = createRuntimeDir('agent-chat-backend-lifecycle-probe-');
    const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
    const probe = `
      const mod = await import(${JSON.stringify(`${backendUrl}?lifecycle-probe=${Date.now()}`)});
      await mod.stopServer();
      console.log('stopped');
    `;

    try {
      const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          AGENT_CHAT_RUNTIME_DIR: probeRuntimeDir,
          SUPERVISOR_ENABLED: 'false',
          AGENT_SCOPE_MONITOR_ENABLED: 'false',
          AGENT_JSON_WRITE_BATCH_MS: '0',
        },
        timeout: 3000,
      });
      expect(result.stdout).toContain('stopped');
    } finally {
      rmSync(probeRuntimeDir, { recursive: true, force: true });
    }
  });

  test('stopServer clears timers and signal listeners started by startServer', async () => {
    restoreEnv = rememberEnv([
      'AGENT_CHAT_RUNTIME_DIR',
      'SUPERVISOR_ENABLED',
      'AGENT_SCOPE_MONITOR_ENABLED',
      'AGENT_JSON_WRITE_BATCH_MS',
      'API_TOKEN',
    ]);
    runtimeDir = createRuntimeDir('agent-chat-backend-lifecycle-test-');
    backendModule = await importBackend(runtimeDir);
    vi.useFakeTimers();
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const server = backendModule.startServer({ port: 0 });
    await waitForServerEvent(server, 'listening');

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await backendModule.stopServer();

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stopServer cancels pending EADDRINUSE listen retry', async () => {
    restoreEnv = rememberEnv([
      'AGENT_CHAT_RUNTIME_DIR',
      'SUPERVISOR_ENABLED',
      'AGENT_SCOPE_MONITOR_ENABLED',
      'AGENT_JSON_WRITE_BATCH_MS',
      'API_TOKEN',
    ]);
    runtimeDir = createRuntimeDir('agent-chat-backend-lifecycle-test-');
    backendModule = await importBackend(runtimeDir);
    const blocker = createServer();
    blockers.add(blocker);
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const port = blocker.address().port;

    vi.useFakeTimers();
    const server = backendModule.startServer({ port, host: '127.0.0.1' });
    const error = await waitForServerEvent(server, 'error');

    expect(error.code).toBe('EADDRINUSE');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await backendModule.stopServer();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.getTimerCount()).toBe(0);
    await new Promise((resolve) => blocker.close(resolve));
    blockers.delete(blocker);
  });
});
