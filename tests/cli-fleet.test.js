import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, test } from 'vitest';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');
const AGENTCHAT_BIN = path.join(REPO_ROOT, 'bin', 'agentchat');
const execFileAsync = promisify(execFile);

async function runCli(args, env = {}) {
  const { stdout } = await execFileAsync(AGENTCHAT_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
  return stdout;
}

function seedFleet() {
  const now = Date.now();
  return {
    agents: {},
    groups: {},
    servers: {
      current: { id: 'current', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'cur1234', agentCount: 2, sourceIp: '127.0.0.1' },
      outdated: { id: 'outdated', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'old9999', agentCount: 1 },
      unknown: { id: 'unknown', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'unknown-legacy', agentCount: 0 },
      offline: { id: 'offline', online: false, heartbeatAt: 0, lastSeen: now - 1000, version: 'cur1234', agentCount: 1 },
      maintenance: { id: 'maintenance', online: false, maintenance: true, heartbeatAt: 0, lastSeen: now - 1000, version: 'old9999', agentCount: 1 },
    },
    env: {
      AGENT_HEARTBEAT_TTL_MS: '5000',
      AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
      AGENT_SERVER_MAINTENANCE_IDS: '',
    },
  };
}

describe('agentchat fleet cli', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('prints fleet inventory as json without failing on non-current rows', async () => {
    context = await createBackendTestContext('agent-chat-cli-fleet-test-', seedFleet());
    const listener = await context.listen();

    try {
      const output = await runCli(['cli', 'fleet', '--expect-version', 'cur1234', '--json'], {
        AGENT_CHAT_API: listener.baseUrl,
      });
      const inventory = JSON.parse(output);

      expect(inventory).toMatchObject({
        ok: true,
        expectedVersion: 'cur1234',
        summary: {
          total: 5,
          current: 1,
          outdated: 1,
          unknown: 1,
          offline: 1,
          maintenance: 1,
        },
      });
      expect(inventory.servers.map((row) => row.versionStatus).sort()).toEqual([
        'current',
        'maintenance',
        'offline',
        'outdated',
        'unknown',
      ]);
    } finally {
      await listener.close();
    }
  });

  test('prints fleet inventory table', async () => {
    context = await createBackendTestContext('agent-chat-cli-fleet-test-', seedFleet());
    const listener = await context.listen();

    try {
      const output = await runCli(['cli', 'fleet', '--expect-version', 'cur1234'], {
        AGENT_CHAT_API: listener.baseUrl,
      });

      expect(output).toContain('FLEET expected=cur1234');
      expect(output).toContain('SUMMARY total=5 current=1 outdated=1 unknown=1 offline=1 maintenance=1');
      expect(output).toContain('current');
      expect(output).toContain('outdated');
      expect(output).toContain('maintenance');
    } finally {
      await listener.close();
    }
  });
});
