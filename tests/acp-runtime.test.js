import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { createAcpRuntime } from '../lib/runtime/acp.js';
import { assertRuntimeContract } from '../lib/runtime/index.js';
import { getFramework } from '../lib/frameworks/index.js';
import { validateLaunchExtraArgs } from '../lib/agent-launch-policy.js';

// Why this runtime exists: the tmux runtime drives an agent by typing into a pane
// and reading the rendered screen back, and every fragile thing about that has the
// same root — the screen is a picture, not data. A tab silently became an
// underscore on a real host and the whole fleet went offline; a framework's prompt
// symbol turned out to be a themeable setting; a readiness check fired on a blank
// pane. ACP replaces the picture with JSON-RPC.

/** A fake ACP agent: answers initialize/session/new, echoes prompts as updates. */
function fakeAgent({ failNewSession = false, promptError = null } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const sent = [];
  child.stdin = {
    write(line) {
      sent.push(JSON.parse(line));
      const msg = JSON.parse(line);
      queueMicrotask(() => {
        if (msg.method === 'initialize') {
          reply({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          if (failNewSession) reply({ id: msg.id, result: {} });
          else reply({ id: msg.id, result: { sessionId: 'octos-test-session' } });
        } else if (msg.method === 'session/prompt') {
          emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
          if (promptError) reply({ id: msg.id, error: { message: 'Internal error', data: promptError } });
          else reply({ id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      return true;
    },
  };
  const emit = (o) => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`));
  const reply = (o) => emit(o);
  return { child, sent };
}

const runtimeWith = (opts) => {
  const agent = fakeAgent(opts);
  const rt = createAcpRuntime({ command: 'octos', spawnFn: () => agent.child });
  return { rt, agent };
};

describe('the ACP runtime satisfies the shared runtime contract', () => {
  test('it passes the contract check', () => {
    const { rt } = runtimeWith();
    expect(() => assertRuntimeContract(rt, 'acp')).not.toThrow();
    expect(rt.name).toBe('acp');
  });

  test('it declares honestly what it cannot do', () => {
    // sendKeys was made a declared capability rather than an assumed method for
    // exactly this runtime. A caller that ignores the flags gets a refusal, not
    // a silently wrong result.
    const { rt } = runtimeWith();
    expect(rt.capabilities).toEqual({ keys: false, capture: false, sessions: true });
  });

  test('the unsupported methods refuse rather than pretend', async () => {
    const { rt } = runtimeWith();
    expect(await rt.capturePane('anything')).toBeNull();
    expect(await rt.sendKeys('anything', ['C-c'])).toBe(false);
  });

  test('no error can mean "server not running", because there is no shared server', () => {
    const { rt } = runtimeWith();
    expect(rt.isEmptyServerError(Object.assign(new Error('x'), { code: 1 }))).toBe(false);
  });
});

describe('sessions', () => {
  test('opening a session performs the ACP handshake in order', async () => {
    const { rt, agent } = runtimeWith();
    const sessionId = await rt.startSession('alpha', { cwd: '/tmp/ws' });
    expect(sessionId).toBe('octos-test-session');
    expect(agent.sent.map((m) => m.method)).toEqual(['initialize', 'session/new']);
    expect(agent.sent[1].params).toMatchObject({ cwd: '/tmp/ws' });
  });

  test('a session with no sessionId is a failure, not a silent success', async () => {
    const { rt } = runtimeWith({ failNewSession: true });
    await expect(rt.startSession('beta', { cwd: '/tmp/ws' })).rejects.toThrow(/no sessionId/);
    expect(await rt.sessionExists('beta')).toBe(false);
  });

  test('listPanes reports processes in the tmux shape, with tty null', async () => {
    // Shaped like the tmux listing so the sweep needs no special case — but an
    // ACP agent has no tty and no pane path, and says so rather than inventing one.
    const { rt } = runtimeWith();
    await rt.startSession('gamma', { cwd: '/tmp/ws' });
    const listing = await rt.listPanes();
    expect(listing.ok).toBe(true);
    expect(listing.serverUnavailable).toBe(false);
    expect(listing.panes).toEqual([
      { tty: null, session: 'gamma', pid: 4242, command: 'octos', path: null },
    ]);
  });

  test('sessionExists tracks the live child', async () => {
    const { rt, agent } = runtimeWith();
    await rt.startSession('delta', { cwd: '/tmp/ws' });
    expect(await rt.sessionExists('delta')).toBe(true);
    agent.child.emit('exit', 0);
    expect(await rt.sessionExists('delta')).toBe(false);
  });
});

describe('turns', () => {
  test('a prompt returns the ACP stopReason and collects updates', async () => {
    const { rt } = runtimeWith();
    await rt.startSession('eps', { cwd: '/tmp/ws' });
    expect(await rt.prompt('eps', 'hello')).toBe('end_turn');
    const updates = rt.recentUpdates('eps');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1).update.sessionUpdate).toBe('agent_message_chunk');
  });

  test('an agent-side error surfaces with its data, not just "Internal error"', async () => {
    // The real failure on a live host was a model-config problem, and the useful
    // detail was in error.data. Dropping it leaves an operator with nothing.
    const { rt } = runtimeWith({ promptError: 'prompt turn failed: API error (bad model)' });
    await rt.startSession('zeta', { cwd: '/tmp/ws' });
    await expect(rt.prompt('zeta', 'hi')).rejects.toMatchObject({
      data: expect.stringContaining('bad model'),
    });
  });

  test('cancel is sent as a notification, which is what makes it interruptible mid-turn', async () => {
    const { rt, agent } = runtimeWith();
    await rt.startSession('eta', { cwd: '/tmp/ws' });
    expect(await rt.cancel('eta')).toBe(true);
    const cancel = agent.sent.find((m) => m.method === 'session/cancel');
    expect(cancel).toBeTruthy();
    expect(cancel.id).toBeUndefined();
  });

  test('a prompt to an unknown session fails loudly', async () => {
    const { rt } = runtimeWith();
    await expect(rt.prompt('nope', 'hi')).rejects.toThrow(/no acp session/);
  });

  test('a child exit rejects everything in flight instead of hanging', async () => {
    const { rt, agent } = runtimeWith();
    await rt.startSession('theta', { cwd: '/tmp/ws' });
    agent.child.stdin.write = () => true;           // swallow, so no reply arrives
    const pending = rt.prompt('theta', 'hi');
    agent.child.stderr.emit('data', Buffer.from('boom'));
    agent.child.emit('exit', 2);
    await expect(pending).rejects.toThrow(/exited with code 2/);
  });
});

describe('the octos adapter', () => {
  const octos = getFramework('octos');

  test('is declared as an ACP transport', () => {
    expect(octos.transport).toBe('acp');
    expect(getFramework('claude').transport).toBe('tmux');
  });

  test('declares no pane signals, because it has no pane', () => {
    expect(octos.signals.blocked).toEqual([]);
    expect(octos.signals.compact).toEqual([]);
    expect(octos.signals.ready).toEqual([]);
  });

  test.each(['--danger-full-access', '--yolo', '--sandbox=danger-full-access'])(
    'refuses %s so an agent cannot widen its own sandbox',
    (flag) => {
      // octos itself will not even persist full access — its config layer calls it
      // "a per-run opt-in, not a saved default that would silently disable the
      // sandbox". A hafleet agent runs detached with nobody watching, so it must
      // not be able to ask for it either.
      const result = validateLaunchExtraArgs('octos', flag);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/Octos sandbox flag is managed by hafleet/);
    },
  );

  test('still allows ordinary flags', () => {
    expect(validateLaunchExtraArgs('octos', '--model deepseek-v4-flash').ok).toBe(true);
  });

  test('is not launchable yet, and says why', () => {
    // hafleet-up creates a tmux session; an ACP agent is paneless. Declaring it
    // launchable before the backend understands that shape would fail obscurely.
    expect(octos.launchable).toBe(false);
    expect(octos.notLaunchableReason).toMatch(/hafleet acp-up/);
  });

  test('records that octos does not block on ACP permission requests', () => {
    // Load-bearing: it means hafleet can observe permission activity but not
    // answer it, so the sandbox chosen at launch is the real control.
    expect(octos.raw.acp.blocksOnPermissionRequest).toBe(false);
  });
});

describe('mcp servers are handed to the agent at session/new', () => {
  // Without this an ACP agent can be prompted but cannot read its own inbox or
  // reply, which makes it a spectator — the tmux agents reach the same tools
  // through .mcp.json. Delivery is only half the wiring; this is the other half.
  test('the configured servers reach session/new', async () => {
    const { rt, agent } = runtimeWith();
    const mcpServers = [{
      name: 'hafleet',
      command: '/usr/bin/node',
      args: ['/repo/mcp-server.js'],
      env: [{ name: 'AGENT_NAME', value: 'octos-agent' }],
    }];
    await rt.startSession('with-mcp', { cwd: '/tmp/ws', mcpServers });
    const newSession = agent.sent.find((m) => m.method === 'session/new');
    expect(newSession.params.mcpServers).toEqual(mcpServers);
  });

  test('omitting them sends an empty list, not undefined', async () => {
    // session/new requires the field; sending undefined drops it from the JSON
    // and some agents reject the request outright.
    const { rt, agent } = runtimeWith();
    await rt.startSession('no-mcp', { cwd: '/tmp/ws' });
    const newSession = agent.sent.find((m) => m.method === 'session/new');
    expect(newSession.params.mcpServers).toEqual([]);
  });
});

describe('one turn\'s updates can be read without the previous turn\'s', () => {
  // recentUpdates(name, N) returns the last N notifications whatever produced
  // them. A caller reconstructing the agent's answer from that silently prepends
  // the previous one. On mini5 a reply was posted into HAFleet reading
  // "TokyoThe command exited with code 7…" — "Tokyo" answered the question before.
  test('updatesSince returns only what arrived after the cursor', async () => {
    const { rt } = runtimeWith();
    await rt.startSession('cursor', { cwd: '/tmp/ws' });
    await rt.prompt('cursor', 'first');          // fake agent emits one update
    const cursor = rt.updateCursor('cursor');
    expect(cursor).toBeGreaterThan(0);
    await rt.prompt('cursor', 'second');
    const since = rt.updatesSince('cursor', cursor);
    expect(since.length).toBe(1);
    expect(rt.recentUpdates('cursor').length).toBe(2); // both still in the buffer
  });

  test('a cursor of 0 returns everything', async () => {
    const { rt } = runtimeWith();
    await rt.startSession('c0', { cwd: '/tmp/ws' });
    await rt.prompt('c0', 'x');
    expect(rt.updatesSince('c0', 0).length).toBe(1);
  });

  test('a cursor older than the bounded buffer does not return nonsense', async () => {
    // The buffer keeps 200 and drops oldest-first, so a cursor can point at
    // something already gone. It must clamp, not produce negative slices.
    const { rt } = runtimeWith();
    await rt.startSession('drop', { cwd: '/tmp/ws' });
    await rt.prompt('drop', 'x');
    const all = rt.updatesSince('drop', 0);
    expect(Array.isArray(all)).toBe(true);
    expect(rt.updatesSince('drop', -5).length).toBeGreaterThanOrEqual(all.length);
  });

  test('an unknown session yields an empty list, not a throw', () => {
    const { rt } = runtimeWith();
    expect(rt.updateCursor('nope')).toBe(0);
    expect(rt.updatesSince('nope', 0)).toEqual([]);
  });

  test('the host reads from a cursor rather than the whole buffer', () => {
    // The bug was in the caller, so the caller is what must not regress.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toContain('runtime.updateCursor(name)');
    expect(host).toContain('runtime.updatesSince(name, cursor)');
    expect(host, 'reading the whole buffer is what welded two turns together')
      .not.toContain('recentUpdates(name, 400)');
  });
});
