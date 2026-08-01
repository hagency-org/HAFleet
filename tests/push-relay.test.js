import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildNotification,
  detectBlockedReason,
  drainRelayQueue,
  evaluateAgentRouting,
  handleMessage,
  relayQueue,
  resetRelayState,
  scanBlockedStates,
  seedRelayState,
  setPushRelayTestHooks,
  setPushToTmuxForTest,
} from '../lib/push-relay-core.js';

describe('push relay dispatch', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    const eventPosts = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'beta', server: null, tmux: 'beta:0.0' },
      ],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/api/delivery-events')) {
          eventPosts.push(JSON.parse(options.body));
        }
        return { ok: true, text: async () => '' };
      },
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
      priority: 'urgent',
      summary: 'Need help',
      mentions: [],
    });

    await handleMessage(raw);
    await handleMessage(raw);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Need help');
    expect(delivered[0].payload).toContain('hafleet-send beta:0.0');
    expect(eventPosts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'relay.delivered',
        messageId: 'msg_1',
        agent: 'alpha',
        target: 'alpha:0.0',
      }),
    ]));
  });

  test('deduplicates concurrent duplicate direct deliveries', async () => {
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
      id: 'msg_concurrent_dup',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      priority: 'urgent',
      summary: 'Only inject once',
      mentions: [],
    });

    await Promise.all([
      handleMessage(raw),
      handleMessage(raw),
    ]);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Only inject once');
  });

  test('does not fallback or retry after partial tmux payload injection', async () => {
    const sendCalls = [];
    const eventPosts = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'beta', server: null, tmux: 'beta:0.0' },
      ],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] !== 'send-keys') throw new Error(`unexpected tmux ${args.join(' ')}`);
        sendCalls.push([...args]);
        if (args.includes('-l')) return '';
        throw new Error('post-payload key failed');
      },
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/api/delivery-events')) {
          eventPosts.push(JSON.parse(options.body));
        }
        return { ok: true, text: async () => '' };
      },
    });

    const raw = JSON.stringify({
      id: 'msg_partial_tmux',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      priority: 'urgent',
      summary: 'Inject once even on partial tmux failure',
      mentions: [],
    });

    await handleMessage(raw);
    await handleMessage(raw);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls.map((args) => args[args.indexOf('-t') + 1])).toEqual(['alpha:0.0', 'alpha:0.0']);
    expect(sendCalls[0]).toContain('-l');
    expect(sendCalls[1]).toContain('Tab');
    expect(eventPosts).toEqual([
      expect.objectContaining({
        type: 'relay.delivery_partial',
        messageId: 'msg_partial_tmux',
        agent: 'alpha',
        target: 'alpha:0.0',
        reason: 'tmux-inject-partial',
      }),
    ]);
  });

  test('fails exact pane delivery without falling back to tmux session', async () => {
    const sendCalls = [];
    const eventPosts = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'beta', server: null, tmux: 'beta:0.0' },
      ],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] !== 'send-keys') throw new Error(`unexpected tmux ${args.join(' ')}`);
        sendCalls.push([...args]);
        if (args.includes('-l') && args.includes('alpha:0.0')) {
          throw new Error('exact pane missing');
        }
        throw new Error(`unexpected fallback target ${args.join(' ')}`);
      },
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/api/delivery-events')) {
          eventPosts.push(JSON.parse(options.body));
        }
        return { ok: true, text: async () => '' };
      },
    });

    await handleMessage(JSON.stringify({
      id: 'msg_exact_pane_missing',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      priority: 'urgent',
      summary: 'Do not fallback to session',
      mentions: [],
    }));

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls.map((args) => args[args.indexOf('-t') + 1])).toEqual(['alpha:0.0']);
    expect(sendCalls.some((args) => args[args.indexOf('-t') + 1] === 'alpha')).toBe(false);
    expect(eventPosts).toEqual([
      expect.objectContaining({
        type: 'relay.delivery_failed',
        messageId: 'msg_exact_pane_missing',
        agent: 'alpha',
        target: 'alpha:0.0',
        reason: 'tmux-inject-failed',
      }),
    ]);
    expect(eventPosts.some((event) => event.type === 'relay.delivered')).toBe(false);
    expect(eventPosts.some((event) => event.context?.fallbackTarget)).toBe(false);
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

  test('local relay routes legacy local agent records to the current host', async () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: 'local', tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    expect(evaluateAgentRouting('alpha')).toMatchObject({ ok: true, reason: 'ok' });

    await handleMessage(JSON.stringify({
      id: 'msg_local_alias',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      priority: 'urgent',
      summary: 'legacy local alias should still route',
      mentions: [],
    }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
  });

  test('local_relay_ignores_dashboard_owned_backend_sse', async () => {
    const delivered = [];
    const eventPosts = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: 'local', tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/api/delivery-events')) {
          eventPosts.push(JSON.parse(options.body));
        }
        return { ok: true, text: async () => '' };
      },
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await handleMessage(JSON.stringify({
      id: 'msg_backend_sse',
      from: 'operator',
      to: 'alpha',
      type: 'human',
      priority: 'urgent',
      source: 'matrix',
      deliveryOwner: 'dashboard-queue',
      summary: 'backend queue should own this',
      mentions: [],
    }));

    expect(delivered).toEqual([]);
    expect(eventPosts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'relay.local_message_ignored',
        messageId: 'msg_backend_sse',
        agent: 'alpha',
        reason: 'local-dashboard-queue-owns-delivery',
      }),
    ]));
  });

  test('local relay deduplicates duplicate held backfill notifications before drain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    let paneText = 'active pane output';
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: 'local', tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return paneText;
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    const raw = JSON.stringify({
      id: 'relay_unread_dup',
      from: 'hafleet',
      to: 'alpha',
      type: 'inform',
      source: 'push-relay',
      kind: 'unread_backfill',
      summary: 'Unread inbox pending: 1 message(s)',
      unreadCount: 1,
      mentions: [],
    });

    await handleMessage(raw);
    await handleMessage(raw);

    expect(relayQueue.get('alpha')).toHaveLength(1);

    paneText = '› ready for the next task';
    vi.setSystemTime(new Date('2026-01-01T00:00:21Z'));
    drainRelayQueue();
    vi.setSystemTime(new Date('2026-01-01T00:00:42Z'));
    drainRelayQueue();

    expect(delivered).toHaveLength(1);
    expect(relayQueue.get('alpha')).toBeUndefined();
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
      priority: 'urgent',
      summary: '@alpha @bravo heads up',
      mentions: ['alpha', 'bravo', 'alpha'],
    }));

    expect(delivered.map((row) => row.target).sort()).toEqual(['alpha:0.0', 'bravo:0.0']);
  });

  test('holds normal-priority messages until pane content is idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    let paneText = 'thinking about next step';
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return paneText;
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    await handleMessage(JSON.stringify({
      id: 'msg_idle_1',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      summary: 'Need help after idle',
      mentions: [],
    }));

    expect(delivered).toEqual([]);
    expect(relayQueue.get('alpha')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:00:21Z'));
    drainRelayQueue();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Need help after idle');

    paneText = 'new output appeared';
    await handleMessage(JSON.stringify({
      id: 'msg_idle_2',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'Hold while active again',
      mentions: [],
    }));
    expect(delivered).toHaveLength(1);
    expect(relayQueue.get('alpha')).toHaveLength(1);
  });

  test('high-priority messages wait for idle when pane is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return 'active pane output';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    await handleMessage(JSON.stringify({
      id: 'msg_high_bypass',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      priority: 'high',
      summary: 'Urgent operator interrupt',
      mentions: [],
    }));

    expect(delivered).toEqual([]);
    expect(relayQueue.get('alpha')).toHaveLength(1);
  });

  test('urgent-priority messages bypass the idle gate by explicit policy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return 'active pane output';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    await handleMessage(JSON.stringify({
      id: 'msg_urgent_bypass',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      priority: 'urgent',
      summary: 'Explicit emergency interrupt',
      mentions: [],
    }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(relayQueue.get('alpha')).toBeUndefined();
  });

  test('queued normal-priority messages stay held while pane shows active work beyond max age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    let paneText = [
      '› Run /review on my current changes',
      '',
      '• Working (12m 04s • esc to interrupt)',
    ].join('\n');
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return paneText;
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    await handleMessage(JSON.stringify({
      id: 'msg_normal_max_hold',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'Eventually force delivered',
      mentions: [],
    }));
    expect(delivered).toEqual([]);
    expect(relayQueue.get('alpha')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    drainRelayQueue();

    expect(delivered).toEqual([]);
    expect(relayQueue.get('alpha')).toHaveLength(1);

    paneText = '› ready for the next task';
    drainRelayQueue();
    expect(delivered).toEqual([]);

    vi.setSystemTime(new Date('2026-01-01T00:05:22Z'));
    drainRelayQueue();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toContain('Eventually force delivered');
    expect(relayQueue.get('alpha')).toBeUndefined();
  });

  test('relay queue delivers only one message per idle sample', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delivered = [];
    let paneText = 'active pane output';
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return paneText;
        if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
        if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async () => ({ ok: true, text: async () => '' }),
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      paneText += `\n${payload}`;
      return true;
    });

    await scanBlockedStates();
    await handleMessage(JSON.stringify({
      id: 'msg_batch_1',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'First queued message',
      mentions: [],
    }));
    await handleMessage(JSON.stringify({
      id: 'msg_batch_2',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'Second queued message',
      mentions: [],
    }));
    expect(relayQueue.get('alpha')).toHaveLength(2);

    paneText = '› ready for the next task';
    vi.setSystemTime(new Date('2026-01-01T00:00:21Z'));
    drainRelayQueue();
    expect(delivered).toEqual([]);

    vi.setSystemTime(new Date('2026-01-01T00:00:42Z'));
    drainRelayQueue();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toContain('First queued message');
    expect(relayQueue.get('alpha')).toHaveLength(1);

    drainRelayQueue();
    expect(delivered).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:01:03Z'));
    drainRelayQueue();

    expect(delivered).toHaveLength(2);
    expect(delivered[1].payload).toContain('Second queued message');
    expect(relayQueue.get('alpha')).toBeUndefined();
  });

  test('queues normal-priority messages when idle metrics are unavailable', async () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: () => {
        throw new Error('tmux unavailable');
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await handleMessage(JSON.stringify({
      id: 'msg_unknown_idle',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'Do not interrupt on unknown idle',
      mentions: [],
    }));

    expect(delivered).toEqual([]);
    expect(relayQueue.get('alpha')).toHaveLength(1);
  });

  test('local scan warms idle gate without reporting runtime observation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchCalls = [];
    const delivered = [];
    const paneText = 'stable idle pane';
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [
        { name: 'alpha', server: null, tmux: 'alpha:0.0' },
        { name: 'beta', server: null, tmux: 'beta:0.0' },
      ],
      mcpSessions: [],
    });
    setPushRelayTestHooks({
      tmuxBin: 'tmux',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'capture-pane') return paneText;
        throw new Error(`unexpected exec ${args.join(' ')}`);
      },
      readFileSync: () => {
        throw Object.assign(new Error('missing pid file'), { code: 'ENOENT' });
      },
      fetch: async (url, options = {}) => {
        fetchCalls.push({
          url: String(url),
          body: JSON.parse(String(options.body || '{}')),
        });
        return { ok: true, text: async () => '' };
      },
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    await scanBlockedStates();
    expect(fetchCalls).toEqual([]);

    vi.setSystemTime(new Date('2026-01-01T00:00:21Z'));
    await handleMessage(JSON.stringify({
      id: 'msg_idle_after_scan',
      from: 'beta',
      to: 'alpha',
      type: 'inform',
      summary: 'Deliver after idle scan',
      mentions: [],
    }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Deliver after idle scan');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/delivery-events');
    expect(fetchCalls[0].body.type).toBe('relay.delivered');
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
    expect(text).toContain('hafleet-send sender:0.0');
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
