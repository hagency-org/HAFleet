import { afterEach, describe, expect, test } from 'vitest';
import {
  buildNotification,
  detectBlockedReason,
  evaluateAgentRouting,
  handleMessage,
  resetRelayState,
  seedRelayState,
  setPushToTmuxForTest,
} from '../lib/push-relay-core.js';
import {
  buildNotification as buildRemoteNotification,
  detectBlockedReason as detectRemoteBlockedReason,
  handleMessage as handleRemoteMessage,
  resetRelayState as resetRemoteRelayState,
  seedRelayState as seedRemoteRelayState,
  setPushToTmuxForTest as setRemotePushToTmuxForTest,
} from '../remote/lib/push-relay-core.js';

describe('push relay dispatch', () => {
  afterEach(() => {
    resetRelayState();
    resetRemoteRelayState();
  });

  test('formats MCP notifications for actionable human messages', () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'human-op', tmux: 'human-op:0.0' }],
      mcpSessions: ['alpha'],
    });

    const text = buildNotification('alpha', {
      from: 'human-op',
      type: 'human',
      summary: 'Please check status',
    });

    expect(text).toContain('This is your human operator.');
    expect(text).toContain('FIRST ACTION: call check_inbox() now.');
    expect(text).toContain('send_message(to="human-op"');
  });

  test('routes to local panes and deduplicates repeated deliveries', () => {
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

    handleMessage(raw);
    handleMessage(raw);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe('alpha:0.0');
    expect(delivered[0].payload).toContain('Need help');
    expect(delivered[0].payload).toContain('agent-send beta:0.0');
  });

  test('skips delivery when the local pane is missing', () => {
    const delivered = [];
    seedRelayState({
      localAgentNames: [],
      agents: [{ name: 'alpha', server: null, tmux: 'alpha:0.0' }],
    });
    setPushToTmuxForTest((target, payload) => {
      delivered.push({ target, payload });
      return true;
    });

    handleMessage(JSON.stringify({
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

  test('delivers one group message to each mentioned local recipient', () => {
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

    handleMessage(JSON.stringify({
      id: 'msg_3',
      from: 'sender',
      group: 'dev',
      type: 'inform',
      summary: '@alpha @bravo heads up',
      mentions: ['alpha', 'bravo', 'alpha'],
    }));

    expect(delivered.map((row) => row.target).sort()).toEqual(['alpha:0.0', 'bravo:0.0']);
  });

  test('keeps remote notification formatting and blocked detection in parity with the local relay', () => {
    const localDelivered = [];
    const remoteDelivered = [];
    const state = {
      localAgentNames: ['alpha'],
      agents: [{ name: 'beta', server: null, tmux: 'beta:0.0' }],
      mcpSessions: ['alpha'],
    };
    seedRelayState(state);
    seedRemoteRelayState(state);
    setPushToTmuxForTest((target, payload) => {
      localDelivered.push({ target, payload });
      return true;
    });
    setRemotePushToTmuxForTest((target, payload) => {
      remoteDelivered.push({ target, payload });
      return true;
    });

    const msg = {
      id: 'msg_4',
      from: 'beta',
      to: 'alpha',
      type: 'request',
      summary: 'Check inbox',
      mentions: [],
    };
    const raw = JSON.stringify(msg);

    expect(buildRemoteNotification('alpha', msg)).toBe(buildNotification('alpha', msg));
    expect(detectRemoteBlockedReason('Press enter to continue', 'claude')).toBe(
      detectBlockedReason('Press enter to continue', 'claude')
    );

    handleMessage(raw);
    handleRemoteMessage(raw);

    expect(remoteDelivered).toEqual(localDelivered);
  });
});
