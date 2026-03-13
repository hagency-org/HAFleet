import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { runParityChecks } from '../scripts/supervisor-parity-check.js';

const SUPERVISOR_TOKEN = 'parity-test-token';

describe('supervisor parity check', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('all parity checks pass against test backend with provisioned supervisor', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'parity-check-home-'));
    const stateDir = path.join(homeDir, 'agents', 'agent_supervisor-ac-topleader', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'agent-token'), SUPERVISOR_TOKEN + '\n');

    context = await createBackendTestContext('supervisor-parity-check-test-', {
      agents: {
        'ac-topleader': { name: 'ac-topleader', type: 'agent', kind: 'agent', online: true },
        'supervisor-ac-topleader': { name: 'supervisor-ac-topleader', type: 'agent', kind: 'agent', online: true },
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: true },
      },
      groups: {},
      env: { AGENTCHAT_HOMEDIR: homeDir },
    });

    const { baseUrl } = await context.listen();
    const result = await runParityChecks(baseUrl, 'ac-topleader', SUPERVISOR_TOKEN);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.passed).toBe(8);
  });

  test('read-only mode: no failures, write checks skipped', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'parity-check-home-'));
    context = await createBackendTestContext('supervisor-parity-check-test-', {
      agents: {
        'ac-topleader': { name: 'ac-topleader', type: 'agent', kind: 'agent', online: true },
        'supervisor-ac-topleader': { name: 'supervisor-ac-topleader', type: 'agent', kind: 'agent', online: true },
      },
      groups: {},
      env: { AGENTCHAT_HOMEDIR: homeDir },
    });

    const { baseUrl } = await context.listen();
    const result = await runParityChecks(baseUrl, 'ac-topleader', '');
    // Zero failures — skipped checks must NOT count as failures
    expect(result.failed).toBe(0);
    // Write checks are skipped
    expect(result.skipped).toBe(4);
    // Read-only checks pass
    expect(result.passed).toBe(4);
    // All GET checks pass (not skipped)
    const getChecks = result.results.filter(r => r.name.startsWith('GET'));
    expect(getChecks.every(r => r.ok && !r.skipped)).toBe(true);
  });
});
