import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve('.');
const coreFiles = [
  'lib/mcp-server-core.js',
  'remote/lib/mcp-server-core.js',
];
const children = new Set();
const servers = new Set();
const tempDirs = new Set();

function listen(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.add(server);
      if (typeof server.unref === 'function') server.unref();
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server || !servers.has(server)) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close((error) => {
      servers.delete(server);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, detail = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${detail}${lastError ? `: ${lastError.message}` : ''}`);
}

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function createBackendHandler(calls, { heartbeatStatuses = [] } = {}) {
  return async (req, res) => {
    const body = await collectBody(req);
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/api/agents/alpha') {
      res.end(JSON.stringify({ name: 'alpha', groups: [] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/agents/alpha/heartbeat') {
      const status = heartbeatStatuses.length > 0 ? heartbeatStatuses.shift() : 200;
      res.statusCode = status;
      res.end(JSON.stringify(status >= 500 ? { error: 'temporary backend failure' } : { ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  };
}

function heartbeatCalls(calls) {
  return calls.filter(call => call.method === 'POST' && call.url === '/api/agents/alpha/heartbeat');
}

function spawnMcpServer(apiBase, extraEnv = {}, coreFile = 'lib/mcp-server-core.js') {
  const stderr = [];
  const env = {
    ...process.env,
    AGENT_NAME: 'alpha',
    HAFLEET_API: apiBase,
    HAFLEET_SERVER: 'local',
    API_TOKEN: 'test-token',
    MCP_HEARTBEAT_INTERVAL_MS: '100',
    MCP_FETCH_TIMEOUT_MS: '100',
    MCP_FETCH_RETRIES: '1',
    MCP_FETCH_BACKOFF_MS: '5',
    NO_PROXY: '*',
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [path.join(repoRoot, coreFile)], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.once('exit', () => children.delete(child));
  return { child, stderr: () => stderr.join('') };
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all([...servers].map(closeServer));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('MCP backend heartbeat', () => {
  test('writes pid file under derived agent state dir when explicit state dir is missing', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-mcp-pid-'));
    tempDirs.add(tempRoot);
    for (const coreFile of coreFiles) {
      const homeRoot = path.join(tempRoot, coreFile.replaceAll('/', '-'), 'hafleet-home');
      const calls = [];
      const running = await listen(createBackendHandler(calls));
      const mcp = spawnMcpServer(`http://127.0.0.1:${running.port}`, {
        HAFLEET_AGENT_STATE_DIR: undefined,
        HAFLEET_HOMEDIR: homeRoot,
        HOME: path.join(tempRoot, 'os-home'),
      }, coreFile);
      const pidFile = path.join(homeRoot, 'agents', 'agent_alpha', 'state', 'mcp-server.pid');

      await waitFor(() => (
        existsSync(pidFile)
        && readFileSync(pidFile, 'utf-8').trim() === String(mcp.child.pid)
      ), { detail: `derived mcp pid file for ${coreFile}` });

      expect(() => process.kill(mcp.child.pid, 0)).not.toThrow();

      await stopChild(mcp.child);
      await waitFor(() => !existsSync(pidFile), { detail: `mcp pid file cleanup for ${coreFile}` });
      await closeServer(running.server);
    }
  }, 10000);

  test('defaults heartbeat server to hostname when HAFLEET_SERVER is unset', async () => {
    const calls = [];
    const running = await listen(createBackendHandler(calls));
    const mcp = spawnMcpServer(`http://127.0.0.1:${running.port}`, {
      HAFLEET_SERVER: undefined,
    });

    await waitFor(() => heartbeatCalls(calls).length > 0, { detail: 'hostname-default heartbeat' });

    expect(heartbeatCalls(calls)[0].body.server).toBe(os.hostname());

    await stopChild(mcp.child);
    await closeServer(running.server);
  }, 10000);

  test('writes pid file under explicit agent state dir when provided', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-mcp-pid-'));
    tempDirs.add(tempRoot);
    for (const coreFile of coreFiles) {
      const stateDir = path.join(tempRoot, coreFile.replaceAll('/', '-'), 'custom-state');
      const calls = [];
      const running = await listen(createBackendHandler(calls));
      const mcp = spawnMcpServer(`http://127.0.0.1:${running.port}`, {
        HAFLEET_AGENT_STATE_DIR: stateDir,
        HAFLEET_HOMEDIR: path.join(tempRoot, 'ignored-home'),
        HOME: path.join(tempRoot, 'os-home'),
      }, coreFile);
      const pidFile = path.join(stateDir, 'mcp-server.pid');

      await waitFor(() => (
        existsSync(pidFile)
        && readFileSync(pidFile, 'utf-8').trim() === String(mcp.child.pid)
      ), { detail: `explicit mcp pid file for ${coreFile}` });

      await stopChild(mcp.child);
      await waitFor(() => !existsSync(pidFile), { detail: `explicit mcp pid cleanup for ${coreFile}` });
      await closeServer(running.server);
    }
  }, 10000);

  test('periodic heartbeat reconnects after backend restart', async () => {
    const calls = [];
    let running = await listen(createBackendHandler(calls));
    const apiBase = `http://127.0.0.1:${running.port}`;
    const mcp = spawnMcpServer(apiBase);

    await waitFor(() => heartbeatCalls(calls).length >= 1, { detail: 'initial heartbeat' });

    await closeServer(running.server);
    await waitFor(() => mcp.stderr().includes('backend disconnected'), {
      timeoutMs: 3000,
      detail: 'backend disconnect log',
    });

    running = await listen(createBackendHandler(calls), running.port);
    await waitFor(() => heartbeatCalls(calls).length >= 2 && mcp.stderr().includes('backend reconnected'), {
      timeoutMs: 5000,
      detail: 'heartbeat after backend restart',
    });

    const latest = heartbeatCalls(calls).at(-1);
    expect(latest.body).toMatchObject({
      server: 'local',
      mcpPresent: true,
    });
    expect(latest.body.pid).toBeGreaterThan(0);
  }, 10000);

  test('heartbeat requests retry transient backend failures', async () => {
    const calls = [];
    const running = await listen(createBackendHandler(calls, { heartbeatStatuses: [503, 200] }));
    const mcp = spawnMcpServer(`http://127.0.0.1:${running.port}`, {
      MCP_FETCH_RETRIES: '2',
    });

    await waitFor(() => heartbeatCalls(calls).length >= 2, {
      timeoutMs: 5000,
      detail: 'retried heartbeat',
    });

    expect(mcp.stderr()).toContain('API POST /api/agents/alpha/heartbeat HTTP 503 (attempt 1/2)');
  }, 10000);
});
