/*
 * `check_inbox` must record what the agent was asked, because a progress hook cannot ask.
 *
 * `bin/hafleet-progress` refuses to post without an anchor — it will not put a step feed into a shared
 * room's main timeline — so without this write the reporter is correct and permanently silent. The
 * inbox read is the one moment where "the message I am about to work on" is known.
 *
 * DRIVEN OVER STDIO, not by exporting the function. No other test in this repo calls an MCP tool for
 * real, and the reason to start here is a bug fixed earlier the same day: `normalizeSender` rejected
 * the exact object `agentSenderFor` produced, and it shipped because both halves had passing tests and
 * nothing carried a value through both. The anchor has the same shape of risk — a writer in the MCP
 * server and a reader in a separate executable — so the test speaks the protocol the agent speaks.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve('.');
const children = new Set();
const servers = new Set();
const temps = new Set();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  children.clear();
  await Promise.all([...servers].map((s) => new Promise((resolve) => {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    s.close(() => resolve());
  })));
  servers.clear();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.clear();
});

/** A backend that serves one inbox payload and records what was asked of it. */
function fakeBackend(inbox) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/inbox/')) return res.end(JSON.stringify(inbox));
      if (req.url === '/api/agents/alpha') return res.end(JSON.stringify({ name: 'alpha', groups: [] }));
      res.end(JSON.stringify({}));
    });
    server.listen(0, '127.0.0.1', () => {
      servers.add(server);
      server.unref?.();
      resolve({ port: server.address().port, seen });
    });
  });
}

/**
 * Speak MCP over stdio: initialize, then call one tool. Newline-delimited JSON-RPC, which is what the
 * agent's framework does — no SDK client, so the test cannot pass by agreeing with itself.
 */
function mcpClient(tmpdir, port) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'lib/mcp-server-core.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_NAME: 'alpha',
      HAFLEET_API: `http://127.0.0.1:${port}`,
      HAFLEET_SERVER: 'local',
      API_TOKEN: 'test-token',
      TMPDIR: tmpdir,
      MCP_HEARTBEAT_INTERVAL_MS: '600000',
      MCP_FETCH_TIMEOUT_MS: '4000',
      NO_PROXY: '*',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* the server also logs; non-JSON lines are not responses */ }
    }
  });

  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    async start() {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'anchor-test', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call: (name, args = {}) => send('tools/call', { name, arguments: args }),
  };
}

function anchorPath(tmpdir) {
  return path.join(tmpdir, 'hafleet-progress', 'alpha.json');
}

async function readInboxAndAnchor(inbox) {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-anchor-'));
  temps.add(tmpdir);
  const { port } = await fakeBackend(inbox);
  const client = mcpClient(tmpdir, port);
  await client.start();
  const result = await client.call('check_inbox');
  return { tmpdir, result, anchor: () => JSON.parse(readFileSync(anchorPath(tmpdir), 'utf8')) };
}

describe('check_inbox records a progress anchor', () => {
  test('a group message is remembered with its group', async () => {
    const { anchor } = await readInboxAndAnchor({
      dm: [],
      group: [{ id: 'msg_100', ts: 1000, group: 'hafleet', from: 'yuechen', summary: 'question' }],
    });
    expect(anchor()).toMatchObject({ replyTo: 'msg_100', group: 'hafleet' });
  });

  test('a direct message is remembered as a DM back to its sender', async () => {
    // Progress must reach the same audience the answer would, and no wider. A DM's answer goes back to
    // one person, so its progress does too — recording a group here would broadcast it.
    const { anchor } = await readInboxAndAnchor({
      dm: [{ id: 'msg_200', ts: 2000, from: 'yuechen', summary: 'privately' }],
      group: [],
    });
    expect(anchor()).toMatchObject({ replyTo: 'msg_200', to: 'yuechen', group: null });
  });

  test('the newest message wins across both buckets', async () => {
    const { anchor } = await readInboxAndAnchor({
      dm: [{ id: 'msg_old', ts: 500, from: 'a' }],
      group: [{ id: 'msg_new', ts: 900, group: 'g', from: 'b' }],
    });
    expect(anchor().replyTo).toBe('msg_new');
  });

  test('an empty inbox leaves no anchor rather than an empty one', async () => {
    // And specifically must not write `replyTo: null`: the reporter treats a falsy anchor as "refuse",
    // so a null would work by accident today and break the moment that check is loosened.
    const { tmpdir } = await readInboxAndAnchor({ dm: [], group: [] });
    expect(existsSync(anchorPath(tmpdir))).toBe(false);
  });

  test('a later empty read does not erase the anchor a real question set', async () => {
    /*
     * The case that would silence progress on exactly the long tasks it exists for: an agent polls its
     * inbox while working, the polls come back empty, and a writer that cleared on empty would drop the
     * anchor mid-task.
     */
    const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-anchor-'));
    temps.add(tmpdir);
    let payload = { dm: [], group: [{ id: 'msg_300', ts: 3000, group: 'hafleet', from: 'yuechen' }] };
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/inbox/')) return res.end(JSON.stringify(payload));
      res.end(JSON.stringify({ name: 'alpha', groups: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { servers.add(server); server.unref?.(); resolve(); }));

    const client = mcpClient(tmpdir, server.address().port);
    await client.start();
    await client.call('check_inbox');
    expect(JSON.parse(readFileSync(anchorPath(tmpdir), 'utf8')).replyTo).toBe('msg_300');

    payload = { dm: [], group: [] };
    await client.call('check_inbox');
    expect(JSON.parse(readFileSync(anchorPath(tmpdir), 'utf8')).replyTo).toBe('msg_300');
  });

  test('a new question resets the throttle so its first report is not swallowed', async () => {
    // Carrying `lastSentAt` across questions would let the previous task's window eat the new task's
    // "started" — the one line that tells a borrower the room heard them.
    const { anchor } = await readInboxAndAnchor({
      dm: [],
      group: [{ id: 'msg_400', ts: 4000, group: 'hafleet', from: 'yuechen' }],
    });
    expect(anchor()).toMatchObject({ lastSentAt: 0, counts: {} });
  });
});
