import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  drainRelayQueue,
  getRelayHealthSnapshot,
  handleMessage,
  main,
  relayQueue,
  resetRelayState,
  seedRelayState,
  setPushRelayTestHooks,
  setPushToTmuxForTest,
  stopPushRelayRuntime,
} from '../lib/push-relay-core.js';

// Task 8: standalone cross-component doctor. The relay self-reports a small,
// non-secret business-health snapshot (module state here; services/standalone-doctor.mjs
// consumes the on-disk record written by push-relay.js from this same snapshot) so the
// doctor can check "is the relay actually talking to the backend and delivering" without
// re-implementing any of this logic itself.

function responseJson(data = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function createFakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url, options = {}) {
      this.url = url;
      this.options = options;
      this.handlers = {};
      this.closed = false;
      instances.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    close() {
      this.closed = true;
    }

    emitMessage(raw) {
      this.handlers.message?.(raw);
    }

    emitError(message = 'stream down') {
      this.handlers.error?.(new Error(message));
    }
  }
  return { FakeEventSource, instances };
}

function fakeTmux(_cmd, args) {
  if (args[0] === 'list-sessions') return 'alpha\n';
  if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
  if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return '/tmp\n';
  if (args[0] === 'capture-pane') return 'same pane content\n';
  return '';
}

describe('push-relay business-health snapshot', () => {
  afterEach(async () => {
    await stopPushRelayRuntime({ sendOffline: false });
    resetRelayState();
    setPushRelayTestHooks();
    vi.useRealTimers();
  });

  test('getRelayHealthSnapshot starts all-null after a reset', () => {
    expect(getRelayHealthSnapshot()).toEqual({
      lastSuccessfulBackendContactAtMs: null,
      lastSuccessfulOutboundDeliveryAtMs: null,
      lastErrorCode: null,
    });
  });

  test('a successful heartbeat records a recent backend-contact timestamp', async () => {
    const { FakeEventSource } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastSuccessfulBackendContactAtMs).not.toBeNull();
    expect(Date.now() - snapshot.lastSuccessfulBackendContactAtMs).toBeLessThan(5000);
    expect(snapshot.lastErrorCode).toBeNull();
  });

  test('a 409 lease-rejected heartbeat records lastErrorCode without a success timestamp', async () => {
    const { FakeEventSource } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        if (parsed.pathname === '/api/servers/heartbeat') return responseJson({ error: 'lease rejected' }, 409);
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastErrorCode).toBe('heartbeat_lease_rejected');
    expect(snapshot.lastSuccessfulBackendContactAtMs).toBeNull();
  });

  test('a non-409 heartbeat HTTP failure records a status-specific error code', async () => {
    const { FakeEventSource } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        if (parsed.pathname === '/api/servers/heartbeat') return responseJson({ error: 'boom' }, 502);
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();

    expect(getRelayHealthSnapshot().lastErrorCode).toBe('heartbeat_http_502');
  });

  test('a network-level heartbeat failure records a generic heartbeat error code', async () => {
    const { FakeEventSource } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        if (parsed.pathname === '/api/servers/heartbeat') throw new Error('ECONNREFUSED');
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();

    expect(getRelayHealthSnapshot().lastErrorCode).toBe('heartbeat_error');
  });

  test('an SSE message updates the backend-contact timestamp', async () => {
    const { FakeEventSource, instances } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();
    instances[0].emitMessage(JSON.stringify({ id: 'not-a-real-message-just-a-ping' }));
    await Promise.resolve();

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastSuccessfulBackendContactAtMs).not.toBeNull();
    expect(Date.now() - snapshot.lastSuccessfulBackendContactAtMs).toBeLessThan(5000);
  });

  test('an SSE error records lastErrorCode', async () => {
    const { FakeEventSource, instances } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') return responseJson([]);
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    await main();
    instances[0].emitError('stream down');

    expect(getRelayHealthSnapshot().lastErrorCode).toBe('sse_error');
  });

  test('a successful direct (urgent, idle-gate-bypassing) tmux delivery records a recent outbound-delivery timestamp', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', tmux: 'alpha:0.0' }],
    });
    setPushToTmuxForTest(() => true);

    await handleMessage(JSON.stringify({
      id: 'msg_direct_ok', from: 'human-op', to: 'alpha', type: 'human', summary: 'hi', priority: 'urgent',
    }));

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastSuccessfulOutboundDeliveryAtMs).not.toBeNull();
    expect(Date.now() - snapshot.lastSuccessfulOutboundDeliveryAtMs).toBeLessThan(5000);
    expect(snapshot.lastErrorCode).toBeNull();
  });

  test('a failed direct tmux delivery records lastErrorCode without leaking the message body into the code', async () => {
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', tmux: 'alpha:0.0' }],
    });
    setPushToTmuxForTest(() => false);

    await handleMessage(JSON.stringify({
      id: 'msg_direct_fail', from: 'human-op', to: 'alpha', type: 'human', summary: 'top secret payload', priority: 'urgent',
    }));

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastErrorCode).toBe('tmux_inject_failed');
    expect(snapshot.lastSuccessfulOutboundDeliveryAtMs).toBeNull();
  });

  test('a queued delivery flushed by drainRelayQueue also records a recent outbound-delivery timestamp', async () => {
    vi.useFakeTimers();
    seedRelayState({
      localAgentNames: ['alpha'],
      agents: [{ name: 'alpha', tmux: 'alpha:0.0' }],
    });
    setPushRelayTestHooks({ execFileSync: fakeTmux, tmuxBin: 'tmux' });
    setPushToTmuxForTest(() => true);

    // Non-urgent: goes through the idle gate and is queued rather than delivered directly.
    await handleMessage(JSON.stringify({
      id: 'msg_queued_ok', from: 'human-op', to: 'alpha', type: 'human', summary: 'hi',
    }));
    expect(relayQueue.get('alpha')?.length).toBe(1);
    expect(getRelayHealthSnapshot().lastSuccessfulOutboundDeliveryAtMs).toBeNull();

    // Advance past the idle threshold with unchanged pane content so the agent reads as idle.
    await vi.advanceTimersByTimeAsync(25000);
    drainRelayQueue();

    const snapshot = getRelayHealthSnapshot();
    expect(snapshot.lastSuccessfulOutboundDeliveryAtMs).not.toBeNull();
    expect(Date.now() - snapshot.lastSuccessfulOutboundDeliveryAtMs).toBeLessThan(5000);
  });

  test('resetRelayState clears the health snapshot back to all-null', async () => {
    seedRelayState({ localAgentNames: ['alpha'], agents: [{ name: 'alpha', tmux: 'alpha:0.0' }] });
    setPushToTmuxForTest(() => true);
    await handleMessage(JSON.stringify({ id: 'msg_reset', from: 'human-op', to: 'alpha', type: 'human', summary: 'hi', priority: 'urgent' }));
    expect(getRelayHealthSnapshot().lastSuccessfulOutboundDeliveryAtMs).not.toBeNull();

    resetRelayState();

    expect(getRelayHealthSnapshot()).toEqual({
      lastSuccessfulBackendContactAtMs: null,
      lastSuccessfulOutboundDeliveryAtMs: null,
      lastErrorCode: null,
    });
  });
});
