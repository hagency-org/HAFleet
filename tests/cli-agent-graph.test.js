import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');
const HAFLEET_BIN = path.join(REPO_ROOT, 'bin', 'hafleet');
const execFileAsync = promisify(execFile);
const cleanupPaths = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(dir);
  return dir;
}

async function runCli(args, env = {}) {
  const { stdout } = await execFileAsync(HAFLEET_BIN, args, {
    cwd: REPO_ROOT,
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

describe('hafleet graph cli', () => {
  test('hafleet graph create/list/show/cancel manages graphs from JSON files', async () => {
    const context = await createBackendTestContext('hafleet-graph-cli-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });
    const listener = await context.listen();
    cleanupPaths.add(context.runtimeDir);

    try {
      const graphFile = path.join(trackTempDir('hafleet-graph-def-'), 'graph.json');
      writeFileSync(graphFile, JSON.stringify({
        owner: 'orchestrator',
        label: 'cli graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
          b: {
            assignee: 'beta',
            description: 'Do B',
            depends_on: ['a'],
          },
        },
      }, null, 2));

      const cliEnv = { HAFLEET_API: listener.baseUrl };
      const createOutput = await runCli(['graph', 'create', graphFile], cliEnv);
      expect(createOutput).toContain('Created graph');

      const listOutput = await runCli(['graph', 'list', '--status', 'active'], cliEnv);
      expect(listOutput).toContain('active');
      const graphId = String(listOutput).split('\t')[0].trim();
      expect(graphId).toMatch(/^graph_/);

      const showOutput = await runCli(['graph', 'show', graphId], cliEnv);
      expect(showOutput).toContain(`${graphId}\tactive\torchestrator\tcli graph`);
      expect(showOutput).toContain('SEND a -> alpha');
      expect(showOutput).toContain('WAIT b -> beta');

      const cancelOutput = await runCli(['graph', 'cancel', graphId], cliEnv);
      expect(cancelOutput).toContain(`Cancelled graph ${graphId}`);
      expect(cancelOutput).toContain('cancelled\torchestrator\tcli graph');
    } finally {
      await listener.close();
      context.cleanup();
    }
  });
});
