import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');

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

function listenAsync(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeAsync(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('5.6.3 reconciliation: disk task with newer updated_at wins', () => {
  let context;
  const AGENT_NAME = 'reconcile-test';
  const OLD_TASK = {
    id: 'task-old',
    owner: AGENT_NAME,
    status: 'active',
    updated_at: '2026-03-10T00:00:00.000Z',
    heartbeat_at: '2026-03-10T00:00:00.000Z',
    waiting_reason: null,
    waiting_until: null,
  };
  const NEWER_DISK_TASK = {
    id: 'task-new-from-disk',
    owner: AGENT_NAME,
    status: 'active',
    updated_at: '2026-03-12T12:00:00.000Z',
    heartbeat_at: '2026-03-12T12:00:00.000Z',
    waiting_reason: null,
    waiting_until: null,
  };

  beforeAll(async () => {
    // Create a temp home dir for the agent with a newer task in agent.json
    const homeBase = mkdtempSync(path.join(os.tmpdir(), 'reconcile-home-'));
    const homeDir = path.join(homeBase, `agent_${AGENT_NAME}`);
    const workdir = path.join(homeDir, 'workdir');
    const stateDir = path.join(homeDir, 'state');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(homeDir, 'agent.json'),
      JSON.stringify({
        name: AGENT_NAME,
        id: `agent_${AGENT_NAME}`,
        homeDir,
        stateDir,
        workdir,
        type: 'claude',
        agentModelVersion: '1.0',
        layoutVersion: 1,
        task: NEWER_DISK_TASK,
      }, null, 2)
    );

    context = await createBackendTestContext('sot-reconcile-', {
      agents: {
        [AGENT_NAME]: {
          name: AGENT_NAME,
          type: 'agent',
          kind: 'agent',
          server: 'local',
          online: false,
          manualDown: false,
          offlineReason: 'inactive',
          tmux: null,
          homeDir,
          task: OLD_TASK,
        },
      },
    });
    context._homeBase = homeBase;
  });

  afterAll(() => {
    if (context) {
      context.cleanup();
      rmSync(context._homeBase, { recursive: true, force: true });
    }
  });

  test('agent task was reconciled from disk (newer updated_at wins)', async () => {
    const res = await request(context.app)
      .get(`/api/agents/${AGENT_NAME}`)
      .expect(200);
    // The backend should have picked up the newer disk task at startup
    expect(res.body.task).toBeDefined();
    expect(res.body.task.id).toBe('task-new-from-disk');
    expect(res.body.task.updated_at).toBe('2026-03-12T12:00:00.000Z');
  });
});

describe('5.6.3 task-writer: defaultApiBaseUrl ignores AGENT_CHAT_WEB_URL', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tw-url-'));
    const homeDir = path.join(tmpDir, 'agent_urltest');
    const workdir = path.join(homeDir, 'workdir');
    const stateDir = path.join(homeDir, 'state');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(homeDir, 'agent.json'),
      JSON.stringify({
        name: 'urltest',
        id: 'agent_urltest',
        homeDir,
        stateDir,
        workdir,
        type: 'claude',
        agentModelVersion: '1.0',
        layoutVersion: 1,
        task: {
          id: 'existing-task',
          owner: 'urltest',
          status: 'active',
          updated_at: '2026-03-12T00:00:00.000Z',
          heartbeat_at: '2026-03-12T00:00:00.000Z',
        },
      }, null, 2)
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses backend port not AGENT_CHAT_WEB_URL for task writes', async () => {
    const script = path.join(REPO_ROOT, 'scripts', 'write-v1-agent-task.js');
    const workdir = path.join(tmpDir, 'agent_urltest', 'workdir');
    const requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        const body = bodyText ? JSON.parse(bodyText) : null;
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: { task: body?.task || null } }));
      });
    });
    await listenAsync(server);
    const address = server.address();
    const backendPort = address && typeof address === 'object' ? String(address.port) : '';
    try {
      const result = await execFileAsync(process.execPath, [script, 'heartbeat', '--workdir', workdir], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          AGENT_CHAT_WEB_URL: 'http://web-should-not-be-used.example.com:9999',
          AGENT_CHAT_API: '',
          AGENT_CHAT_BACKEND_PORT: backendPort,
        },
        timeout: 5000,
      });
      expect(result.stderr).toContain(`127.0.0.1:${backendPort}`);
      expect(result.stderr).not.toContain('web-should-not-be-used');
    } finally {
      await closeAsync(server);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/agents/urltest',
      body: {
        task: {
          id: 'existing-task',
          owner: 'urltest',
          status: 'active',
        },
      },
    });
  });
});
