import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');
const PROVISION_SCRIPT = path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js');
const execFileAsync = promisify(execFile);
const cleanupPaths = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(dir);
  return dir;
}

function runNode(scriptPath, args, env = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function runTaskWriter(taskWriterPath, args, cwd, env = {}) {
  const { stdout } = await execFileAsync(taskWriterPath, args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
  return stdout;
}

afterEach(() => {
  for (const target of cleanupPaths) {
    rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('task-writer graph integration', () => {
  test('task-writer graph done/fail flags update graph nodes over HTTP', async () => {
    const context = await createBackendTestContext('hafleet-task-writer-graph-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });
    const listener = await context.listen();
    cleanupPaths.add(context.runtimeDir);

    try {
      const homeRoot = trackTempDir('hafleet-home-');
      runNode(PROVISION_SCRIPT, [
        '--name', 'alpha',
        '--type', 'claude',
        '--home', homeRoot,
        '--subconscious-enabled', 'false',
      ]);
      const manifestRoot = path.join(homeRoot, 'agents', 'agent_alpha');
      const workdir = path.join(manifestRoot, 'workdir');
      const taskWriterPath = path.join(workdir, 'task-writer');

      const createResponse = await request(context.app)
        .post('/api/task-graphs')
        .send({
          owner: 'orchestrator',
          label: 'writer graph',
          nodes: {
            first: {
              assignee: 'alpha',
              description: 'finish first',
            },
            second: {
              assignee: 'beta',
              description: 'finish second',
            },
          },
        });
      expect(createResponse.status).toBe(200);
      const graphId = createResponse.body.graph.id;

      const doneOutput = await runTaskWriter(taskWriterPath, [
        'done',
        '--graph', graphId,
        '--node', 'first',
        '--result', '{"ok":true,"step":1}',
      ], workdir, { HAFLEET_API: listener.baseUrl });
      const doneJson = JSON.parse(doneOutput);
      expect(doneJson.ok).toBe(true);
      expect(doneJson.node.status).toBe('complete');

      const failOutput = await runTaskWriter(taskWriterPath, [
        'fail',
        '--graph', graphId,
        '--node', 'second',
        '--error', 'boom',
      ], workdir, { HAFLEET_API: listener.baseUrl });
      const failJson = JSON.parse(failOutput);
      expect(failJson.ok).toBe(true);
      expect(failJson.node.status).toBe('failed');

      const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
      expect(graphResponse.status).toBe(200);
      expect(graphResponse.body.nodes.first.result).toEqual({ ok: true, step: 1 });
      expect(graphResponse.body.nodes.second.error).toBe('boom');
    } finally {
      await listener.close();
      context.cleanup();
    }
  });
});
