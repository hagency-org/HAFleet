import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve('.');
const coreFiles = ['lib/mcp-server-core.js'];
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
  return new Promise((resolve) => server.close(resolve));
}

function spawnCore(env, onExit) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'mcp-server.js')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  if (onExit) child.on('exit', (code, signal) => onExit(code, signal, stderr));
  return { child, getStderr: () => stderr };
}

afterEach(async () => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  children.clear();
  for (const s of servers) await closeServer(s);
  servers.clear();
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  tempDirs.clear();
});

describe('B11: the MCP server authenticates every backend call with the agent token', () => {
  test.for(coreFiles)('%s: a present token file becomes X-Agent-Token on every request', async (coreFile) => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-b11-'));
    tempDirs.add(stateDir);
    writeFileSync(path.join(stateDir, 'agent-token'), 'tok-b11-secret\n');
    const seen = [];
    const { server, port } = await listen((req, res) => {
      seen.push({ url: req.url, agentToken: req.headers['x-agent-token'] || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const { child } = spawnCore({
      AGENT_NAME: 'e2e-claude',
      HAFLEET_API: `http://127.0.0.1:${port}`,
      HAFLEET_AGENT_STATE_DIR: stateDir,
      AGENT_TOKEN: '',        // force the file path
      API_TOKEN: '',
      HAFLEET_APPROVAL_POLL_INTERVAL_MS: '250',
    });
    await new Promise((r) => setTimeout(r, 1200));
    child.kill();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBeGreaterThan(0);               // it actually talked to the backend
    for (const call of seen) {
      expect(call.agentToken).toBe('tok-b11-secret');     // EVERY call carried the token
    }
  });

  test.for(coreFiles)('%s: a missing token file REFUSES TO START (fail-closed, exit non-zero)', async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-b11-missing-'));
    tempDirs.add(stateDir);
    const { port } = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    const exit = new Promise((resolve) => {
      const proc = spawnCore({
        AGENT_NAME: 'e2e-claude',
        HAFLEET_API: `http://127.0.0.1:${port}`,
        HAFLEET_AGENT_STATE_DIR: stateDir,   // dir exists, token file does NOT
        AGENT_TOKEN: '',
        API_TOKEN: '',
        HAFLEET_APPROVAL_POLL_INTERVAL_MS: '250',
      });
      proc.child.on('exit', (code) => resolve({ code, err: proc.getStderr() }));
    });
    const { code, err } = await exit;
    expect(code).not.toBe(0);                                   // refused to start
    expect(err).toMatch(/agent-token file missing.*agent-token/); // names the file
  });

  test.for(coreFiles)('%s: an EMPTY token file also refuses to start', async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-b11-empty-'));
    tempDirs.add(stateDir);
    writeFileSync(path.join(stateDir, 'agent-token'), '   \n');
    const { port } = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    const exit = new Promise((resolve) => {
      const proc = spawnCore({
        AGENT_NAME: 'e2e-claude',
        HAFLEET_API: `http://127.0.0.1:${port}`,
        HAFLEET_AGENT_STATE_DIR: stateDir,
        AGENT_TOKEN: '',
        API_TOKEN: '',
        HAFLEET_APPROVAL_POLL_INTERVAL_MS: '250',
      });
      proc.child.on('exit', (c) => resolve({ code: c, err: proc.getStderr() }));
    });
    const { code, err } = await exit;
    expect(code).not.toBe(0);
    expect(err).toMatch(/agent-token file is empty.*agent-token/);
  });
});
