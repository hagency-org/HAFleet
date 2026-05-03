import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { promisify } from 'util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  drainRelayQueue,
  main,
  resetRelayState,
  seedRelayState,
  setPushRelayTestHooks,
  setPushToTmuxForTest,
  stopPushRelayRuntime,
} from '../lib/push-relay-core.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const CORE_URL = pathToFileURL(path.join(REPO_ROOT, 'lib', 'push-relay-core.js')).href;

function responseJson(data = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeFetchRecorder(posts = []) {
  return async (url, options = {}) => {
    const parsed = new URL(String(url));
    if ((options.method || 'GET').toUpperCase() === 'POST') {
      posts.push({
        path: parsed.pathname,
        body: options.body ? JSON.parse(options.body) : null,
      });
    }
    if (parsed.pathname === '/api/agents') {
      return responseJson([{ name: 'alpha', server: null, tmux: 'alpha:0.0' }]);
    }
    return responseJson({ ok: true });
  };
}

function fakeTmux(_cmd, args) {
  if (args[0] === 'list-sessions') return 'alpha\n';
  if (args[0] === 'list-panes' && args.includes('#{pane_current_command}')) return 'codex\n';
  if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) return `${os.tmpdir()}\n`;
  if (args[0] === 'capture-pane') return '';
  return '';
}

function createFakeEventSource({ errorOnClose = false } = {}) {
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
      if (errorOnClose) this.handlers.error?.(new Error('closed'));
    }

    emitError(message = 'stream down') {
      this.handlers.error?.(new Error(message));
    }
  }
  return { FakeEventSource, instances };
}

describe('push relay lifecycle', () => {
  afterEach(async () => {
    await stopPushRelayRuntime({ sendOffline: false });
    resetRelayState();
    vi.useRealTimers();
  });

  test('importing the core does not install process handlers', async () => {
    const script = `
      const events = ['SIGTERM', 'SIGINT', 'unhandledRejection'];
      const before = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));
      await import(${JSON.stringify(CORE_URL)});
      const after = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));
      console.log(JSON.stringify({ before, after }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, PUSH_RELAY_MODE: 'local' },
    });
    const counts = JSON.parse(stdout.trim().split('\n').at(-1));
    expect(counts.after).toEqual(counts.before);
  });

  test('main is idempotent and stop closes the SSE without reconnecting', async () => {
    vi.useFakeTimers();
    const { FakeEventSource, instances } = createFakeEventSource({ errorOnClose: true });
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: makeFetchRecorder(),
      tmuxBin: 'tmux',
    });

    await main();
    await main();
    expect(instances).toHaveLength(1);

    await stopPushRelayRuntime({ sendOffline: false });
    expect(instances[0].closed).toBe(true);

    await vi.advanceTimersByTimeAsync(10000);
    expect(instances).toHaveLength(1);
  });

  test('heartbeat lease rejection keeps stale relays off SSE', async () => {
    vi.useFakeTimers();
    const posts = [];
    const { FakeEventSource, instances } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url, options = {}) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/api/agents') {
          return responseJson([{ name: 'alpha', server: 'alpha-host', tmux: 'alpha:0.0' }]);
        }
        if (parsed.pathname === '/api/servers/heartbeat') {
          posts.push(JSON.parse(String(options.body || '{}')));
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: 'lease rejected' }),
            text: async () => 'lease rejected',
          };
        }
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });

    const result = await main();

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'heartbeat-lease-rejected',
    }));
    expect(posts).toHaveLength(1);
    expect(instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(instances).toHaveLength(0);
  });

  test('startup and reconnect backfill unread inbox notices without replaying message bodies', async () => {
    vi.useFakeTimers();
    const { FakeEventSource, instances } = createFakeEventSource();
    const deliveries = [];
    const unreadSnapshots = [
      {
        agent: 'alpha',
        unread_total: 1,
        unread_returned: 1,
        unread_omitted: 0,
        messages: [{ id: 'msg_1', ts: 1000, from: 'human-op', summary: 'secret body' }],
      },
      {
        agent: 'alpha',
        unread_total: 2,
        unread_returned: 1,
        unread_omitted: 1,
        messages: [{ id: 'msg_2', ts: 2000, from: 'salt', summary: 'another secret' }],
      },
    ];
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: async (url, options = {}) => {
        const parsed = new URL(String(url));
        if ((options.method || 'GET').toUpperCase() === 'POST') return responseJson({ ok: true });
        if (parsed.pathname === '/api/agents') {
          return responseJson([{ name: 'alpha', server: null, tmux: 'alpha:0.0' }]);
        }
        if (parsed.pathname === '/api/inbox/alpha/unread-list') {
          return responseJson(unreadSnapshots.shift() || {
            agent: 'alpha',
            unread_total: 2,
            unread_returned: 1,
            unread_omitted: 1,
            messages: [{ id: 'msg_2', ts: 2000, from: 'salt', summary: 'another secret' }],
          });
        }
        return responseJson({ ok: true });
      },
      tmuxBin: 'tmux',
    });
    seedRelayState({ mcpSessions: ['alpha'] });
    setPushToTmuxForTest((target, payload) => {
      deliveries.push({ target, payload });
      return true;
    });

    await main();

    expect(instances).toHaveLength(1);
    expect(deliveries).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(25000);
    drainRelayQueue();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].target).toBe('alpha:0.0');
    expect(deliveries[0].payload).toContain('You have 1 unread inbox message(s)');
    expect(deliveries[0].payload).toContain('FIRST ACTION: call check_inbox() now.');
    expect(deliveries[0].payload).not.toContain('secret body');

    instances[0].emitError();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(instances).toHaveLength(2);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].payload).toContain('You have 2 unread inbox message(s)');
    expect(deliveries[1].payload).not.toContain('another secret');
  });

  test('stop clears pending reconnect timers and sends the offline notice when requested', async () => {
    vi.useFakeTimers();
    const posts = [];
    const { FakeEventSource, instances } = createFakeEventSource();
    setPushRelayTestHooks({
      EventSource: FakeEventSource,
      execFileSync: fakeTmux,
      fetch: makeFetchRecorder(posts),
      tmuxBin: 'tmux',
    });

    await main();
    instances[0].emitError();
    await stopPushRelayRuntime({ offlineReason: 'test-stop', sendOffline: true });
    await vi.advanceTimersByTimeAsync(10000);

    expect(instances).toHaveLength(1);
    expect(posts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(/\/api\/servers\/.+\/offline$/),
        body: expect.objectContaining({ reason: 'test-stop' }),
      }),
    ]));
  });
});
