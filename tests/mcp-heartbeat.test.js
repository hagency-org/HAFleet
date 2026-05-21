import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';

const repoRoot = path.resolve('.');
const children = new Set();
const servers = new Set();

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

function spawnMcpServer(apiBase, extraEnv = {}) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(repoRoot, 'lib/mcp-server-core.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_NAME: 'alpha',
      AGENT_CHAT_API: apiBase,
      AGENT_CHAT_SERVER: 'local',
      API_TOKEN: 'test-token',
      MCP_HEARTBEAT_INTERVAL_MS: '100',
      MCP_FETCH_TIMEOUT_MS: '100',
      MCP_FETCH_RETRIES: '1',
      MCP_FETCH_BACKOFF_MS: '5',
      NO_PROXY: '*',
      ...extraEnv,
    },
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
});

describe('MCP backend heartbeat', () => {
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
