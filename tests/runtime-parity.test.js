import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
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

  test('remote MCP auto-registration defaults server to os.hostname()', () => {
    const source = readFileSync(path.resolve('remote/lib/mcp-server-core.js'), 'utf-8');
    expect(source).toMatch(/const AGENT_SERVER = \(process\.env\.AGENT_CHAT_SERVER \|\| ''\)\.trim\(\) \|\| os\.hostname\(\);/);
  });

  test('local and remote push-relay check_inbox hints stay in sync', () => {
    const localSource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const remoteSource = readFileSync(path.resolve('remote/lib/push-relay-core.js'), 'utf-8');
    const hintPattern = /const checkHint = '([^']+)';/;
    const localHint = localSource.match(hintPattern)?.[1] || null;
    const remoteHint = remoteSource.match(hintPattern)?.[1] || null;
    expect(remoteHint).toBe(localHint);
    expect(localHint).toBe('FIRST ACTION: call check_inbox() now. Use check_inbox() in agent-chat MCP for full context before acting.');
  });

  test('backend and local push-relay import blocked patterns from the shared module', () => {
    const backendSource = readFileSync(path.resolve('backend-v2.js'), 'utf-8');
    const relaySource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const sharedSource = readFileSync(path.resolve('lib/blocked-patterns.js'), 'utf-8');

    expect(backendSource).toMatch(/from '\.\/lib\/blocked-patterns\.js';/);
    expect(relaySource).toMatch(/from '\.\/blocked-patterns\.js';/);
    expect(sharedSource).toMatch(/reason: 'approval-mode-toggle'/);
    expect(sharedSource).toMatch(/reason: 'interactive-confirm'/);
    expect(sharedSource).toMatch(/reason: 'update-required'/);
  });
});
