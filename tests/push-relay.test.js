import { afterEach, describe, expect, test } from 'vitest';
import {
  buildNotification,
  detectBlockedReason,
  evaluateAgentRouting,
  handleMessage,
  resetRelayState,
  scanBlockedStates,
  seedRelayState,
  setPushRelayTestHooks,
  setPushToTmuxForTest,
} from '../lib/push-relay-core.js';

describe('push relay dispatch', () => {
  afterEach(() => {
    resetRelayState();
    setPushRelayTestHooks();
  });

  test('formats MCP notifications for actionable human messages', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'human-op', tmux: 'human-op:0.0' }],
      mcpSessions: ['alpha'],
    });

    const text = await buildNotification('alpha', {
      from: 'human-op',
      type: 'human',
      summary: 'Please check status',
    });

    expect(text).toContain('This is your human operator.');
    expect(text).toContain('FIRST ACTION: call check_inbox() now.');
    expect(text).toContain('send_message(to="human-op"');
  });

  test('Matrix external human message uses "(via Matrix)" without operator claim', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'human-op', tmux: 'human-op:0.0' }],
      mcpSessions: ['alpha'],
    });

    const text = await buildNotification('alpha', {
      from: 'human-op',
      type: 'human',
      summary: 'hello from matrix',
      source: 'matrix',
      trustLevel: 'external',
    });

    expect(text).toContain('(via Matrix)');
    expect(text).not.toContain('human operator');
    expect(text).not.toContain('(human)');
  });

  test('Matrix operator human message uses "(human)" with operator claim', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'human-op', tmux: 'human-op:0.0' }],
      mcpSessions: ['alpha'],
    });

    const text = await buildNotification('alpha', {
      from: 'human-op',
      type: 'human',
      summary: 'hello from operator',
      source: 'matrix',
      trustLevel: 'operator',
    });

    expect(text).toContain('(human)');
    expect(text).toContain('human operator');
    expect(text).not.toContain('(via Matrix)');
  });

  test('API human message retains operator claim', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'human-op', tmux: 'human-op:0.0' }],
      mcpSessions: [],
    });

    const text = await buildNotification('alpha', {
      from: 'human-op',
      type: 'human',
      summary: 'hello from api',
    });

    expect(text).toContain('(human)');
    expect(text).toContain('human operator');
    expect(text).not.toContain('(via Matrix)');
  });

  test('routes to local panes and deduplicates repeated deliveries', async () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'beta', server: null, tmux: 'beta:0.0' },
      ],
      mcpSessions: [],
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    const raw = JSON.stringify({
      id: 'msg_1',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      summary: 'Need help',
      mentions: [],
    });

    await handleMessage(raw);
    await handleMessage(raw);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Need help');
    expect(delivered[0].payload).toContain('agent-send beta:0.0');
  });

  test('skips delivery when the local pane is missing', async () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: [],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await handleMessage(JSON.stringify({
      id: 'msg_2',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'FYI',
      mentions: [],
    }));

    expect(evaluateAgentRouting('alpha')).toMatchObject({ ok: false, reason: 'local-session-missing' });
    expect(delivered).toEqual([]);
  });

  test('delivers one group message to each mentioned local recipient', async () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha', 'bravo'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'bravo', server: null, tmux: 'bravo:0.0' },
        { name: 'sender', server: null, tmux: 'sender:0.0' },
      ],
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await handleMessage(JSON.stringify({
      id: 'msg_3',
      from: 'sender',
      group: 'dev',
      type: 'inform',
      summary: '@alpha @bravo heads up',
      mentions: ['alpha', 'bravo', 'alpha'],
    }));

    expect(delivered.map((row) => row.target).sort()).toEqual(['alpha:0.0', 'bravo:0.0']);
  });

  test('MCP debounce suppresses false negatives during grace period', async () => {
    const runtimeReports = [];
    // Seed with agent that has MCP, then simulate scans without MCP
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [], // MCP not present from the start
    });
    // Mock tmux/backend calls so debounce behavior is independent of the host environment.
    setPushRelayTestHooks({
      execFileAsync: async () => ({ stdout: '', stderr: '' }),
      execFileSync: () => '',
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async (url, options = {}) => {
        runtimeReports.push({
          url: String(url),
          body: JSON.parse(String(options.body || '{}')),
        });
        return { ok: true, text: async () => '' };
      },
    });

    // Run 5 scans — should still report mcpPresent=true (under threshold of 6)
    for (let i = 0; i < 5; i++) {
      await scanBlockedStates();
    }

    // After 5 misses, agent should still be in grace period
    // Run scan 6 — now it should flip to mcpPresent=false
    await scanBlockedStates();

    expect(runtimeReports.map((report) => report.body.mcpPresent)).toEqual([true, false]);
  });

  test('detects MCP session from Linux proc cmdline', async () => {
    const killCalls = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'sender', server: null, tmux: 'sender:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      readFileSync: (file) => {
        const path = String(file);
        if (path.endsWith('/agent_alpha/state/mcp-server.pid')) return '123\n';
        if (path === '/proc/123/cmdline') return 'node\0/repo/mcp-server.js\0';
        throw Object.assign(new Error(`unexpected read ${path}`), { code: 'ENOENT' });
      },
      killProcess: (pid, signal) => {
        killCalls.push({ pid, signal });
      },
    });

    const text = await buildNotification('alpha', {
      from: 'sender',
      type: 'request',
      summary: 'Need inbox',
    });

    expect(text).toContain('check_inbox()');
    expect(killCalls).toEqual([{ pid: 123, signal: 0 }]);
  });

  test('detects MCP session with ps fallback when proc is unavailable', async () => {
    const psCalls = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'sender', server: null, tmux: 'sender:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      readFileSync: (file) => {
        const path = String(file);
        if (path.endsWith('/agent_alpha/state/mcp-server.pid')) return '456\n';
        if (path === '/proc/456/cmdline') {
          throw Object.assign(new Error('no proc'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error(`unexpected read ${path}`), { code: 'ENOENT' });
      },
      execFileSync: (cmd, args) => {
        psCalls.push({ cmd, args });
        return 'node /repo/mcp-server.js\n';
      },
      killProcess: () => {},
    });

    const text = await buildNotification('alpha', {
      from: 'sender',
      type: 'request',
      summary: 'Need inbox',
    });

    expect(text).toContain('check_inbox()');
    expect(psCalls).toEqual([{ cmd: 'ps', args: ['-p', '456', '-o', 'command='] }]);
  });

  test('rejects live pid file when process command is not MCP', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'sender', server: null, tmux: 'sender:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      readFileSync: (file) => {
        const path = String(file);
        if (path.endsWith('/agent_alpha/state/mcp-server.pid')) return '789\n';
        if (path === '/proc/789/cmdline') return 'node\0/repo/backend-v2.js\0';
        throw Object.assign(new Error(`unexpected read ${path}`), { code: 'ENOENT' });
      },
      killProcess: () => {},
    });

    const text = await buildNotification('alpha', {
      from: 'sender',
      type: 'request',
      summary: 'Need inbox',
    });

    expect(text).not.toContain('check_inbox()');
    expect(text).toContain('agent-send sender:0.0');
  });

  test('rejects missing process from MCP pid file', async () => {
    let readProc = false;
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'sender', server: null, tmux: 'sender:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      readFileSync: (file) => {
        const path = String(file);
        if (path.endsWith('/agent_alpha/state/mcp-server.pid')) return '321\n';
        readProc = true;
        throw Object.assign(new Error(`unexpected read ${path}`), { code: 'ENOENT' });
      },
      killProcess: () => {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      },
    });

    const text = await buildNotification('alpha', {
      from: 'sender',
      type: 'request',
      summary: 'Need inbox',
    });

    expect(text).not.toContain('check_inbox()');
    expect(readProc).toBe(false);
  });

  test('notification formatting and blocked detection work correctly', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'beta', server: null, tmux: 'beta:0.0' }],
      mcpSessions: ['alpha'],
    });

    const msg = {
      from: 'beta',
      type: 'request',
      summary: 'Check inbox',
    };

    const text = await buildNotification('alpha', msg);
    expect(text).toContain('FIRST ACTION: call check_inbox() now.');
    expect(detectBlockedReason('Press enter to continue', 'claude')).toBeTruthy();
  });
});
