import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { SupervisorService } from '../supervisor/index.js';

describe('runtime parity regressions', () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('supervisor resolveCandidates excludes remote agents', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-supervisor-test-'));
    process.env.AGENT_CHAT_SERVER = 'devbox';

    const service = new SupervisorService({
      config: {
        enabled: false,
        disabledReason: 'test',
        agentAllowlist: null,
        stateFile: path.join(tempDir, 'supervisor-state.json'),
        logFile: path.join(tempDir, 'supervisor-log.jsonl'),
        warnAfter: 2,
        warnCooldownMs: 1000,
        eventHistoryLimit: 20,
      },
      getAgents: () => [
        { name: 'alpha', kind: 'agent', server: null },
        { name: 'bravo', kind: 'agent', server: 'local' },
        { name: 'charlie', kind: 'agent', server: 'devbox' },
        { name: 'delta', kind: 'agent', server: 'remote-host' },
        { name: 'human-op', kind: 'human', server: 'local' },
      ],
      getRuntime: (name) => ({ agent: name }),
    });

    const rows = service.resolveCandidates();
    expect(rows.map(row => row.agent.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });
});
