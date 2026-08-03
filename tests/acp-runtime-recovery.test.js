import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';

import { createAcpRuntime } from '../lib/runtime/acp.js';
import { getFramework } from '../lib/frameworks/index.js';

// Two bugs found by running hermes for the first time, within a minute of launch.
//
// 1. The runtime appended `--cwd <dir>` to every agent's argv. octos accepts it;
//    hermes-acp answers "unrecognized arguments: --cwd" and dies before the
//    handshake. ACP already carries cwd in session/new, so the flag is only a
//    fallback and belongs to whichever adapter actually takes one.
//
// 2. A start() that failed left its entry in the session map with no sessionId,
//    and the next call returned it from cache. The mcpServers fallback therefore
//    handed back a dead session: the host logged "acp session open: null" and
//    then "acp session ended", restarting five times.

/** A child process stand-in that records argv and speaks just enough ACP. */
function fakeSpawn({ failOn = null, loadSession = true } = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    const child = new EventEmitter();
    child.stdin = { write: () => true, end: () => {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('exit', 0); };
    child.pid = 4242;
    calls.push({ command, args });
    child.stdin.write = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const req = JSON.parse(line);
        queueMicrotask(() => {
          const reply = req.method === failOn
            ? { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `rejected ${req.method}` } }
            : { jsonrpc: '2.0', id: req.id, result: req.method === 'session/new'
                ? { sessionId: 'sess-1' }
                : req.method === 'session/load'
                  // hermes returns success here even for a session it cannot find,
                  // logging only a warning. That is exactly why the id is checked
                  // before it goes out rather than after.
                  ? {}
                  : { protocolVersion: 1, agentCapabilities: { loadSession } } };
          child.stdout.emit('data', `${JSON.stringify(reply)}\n`);
        });
      }
      return true;
    };
    return child;
  };
  return { spawnFn, calls };
}

describe('the working directory flag is declared per adapter, not assumed', () => {
  test('an adapter that declares no flag gets a clean argv', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const rt = createAcpRuntime({ command: 'hermes-acp', args: ['--x'], spawnFn });
    await rt.startSession('a', { cwd: '/ws' });
    expect(calls[0].args).toEqual(['--x']);
    expect(calls[0].args).not.toContain('--cwd');
  });

  test('an adapter that declares one still gets it', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const rt = createAcpRuntime({ command: 'octos', args: ['acp'], cwdFlag: '--cwd', spawnFn });
    await rt.startSession('a', { cwd: '/ws' });
    expect(calls[0].args).toEqual(['acp', '--cwd', '/ws']);
  });

  test('cwd reaches the agent through the protocol either way', async () => {
    // The flag is a fallback; session/new is the real channel. An adapter with no
    // flag must not silently lose the working directory.
    const seen = [];
    const { spawnFn } = fakeSpawn();
    const wrapped = (cmd, args) => {
      const child = spawnFn(cmd, args);
      const write = child.stdin.write;
      child.stdin.write = (chunk) => {
        for (const l of String(chunk).split('\n').filter(Boolean)) seen.push(JSON.parse(l));
        return write(chunk);
      };
      return child;
    };
    const rt = createAcpRuntime({ command: 'hermes-acp', args: [], spawnFn: wrapped });
    await rt.startSession('a', { cwd: '/ws' });
    expect(seen.find((m) => m.method === 'session/new').params.cwd).toBe('/ws');
  });

  test('the shipped adapters declare what their binaries accept', () => {
    expect(getFramework('octos').launch.acpCwdFlag).toBe('--cwd');
    expect(getFramework('hermes').launch.acpCwdFlag ?? null).toBeNull();
  });

  test('the host reads the flag from the adapter rather than hardcoding it', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toMatch(/cwdFlag: framework\.launch\.acpCwdFlag/);
    expect(readFileSync('lib/runtime/acp.js', 'utf-8')).not.toMatch(/'--cwd'/);
  });
});

describe('a failed start leaves nothing behind for the next attempt', () => {
  test('a rejected session/new is not cached and retried into', async () => {
    // What actually happened: session/new rejected the mcpServers we sent, the host
    // retried without them, and got the dead entry back instead of a new session.
    let mode = 'session/new';
    const calls = [];
    const spawnFn = (cmd, args) => {
      const f = fakeSpawn({ failOn: mode });
      calls.push({ cmd, args });
      return f.spawnFn(cmd, args);
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn });
    await expect(rt.startSession('a', { cwd: '/ws', mcpServers: [{ name: 'h' }] })).rejects.toThrow();
    expect(calls.length).toBe(1);

    // The same runtime, retried without mcpServers. It must spawn again rather
    // than return the entry the failed attempt left in the map.
    mode = null;
    const id = await rt.startSession('a', { cwd: '/ws' });
    expect(calls.length, 'retry reused the dead session instead of spawning').toBe(2);
    expect(id).toBe('sess-1');
  });

  test('a session whose agent has since died is replaced, not handed back', async () => {
    // The other half of the guard, and the one teardown-on-failure cannot cover:
    // this session started cleanly and the agent exited later. hermes did exactly
    // that — "acp session ended" five seconds after a successful open. Returning
    // the corpse would make every subsequent prompt write to a closed pipe.
    let spawned = 0;
    const children = [];
    const { spawnFn } = fakeSpawn();
    const dying = (cmd, args) => {
      spawned += 1;
      const child = spawnFn(cmd, args);
      children.push(child);
      return child;
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn: dying });
    expect(await rt.startSession('a', { cwd: '/ws' })).toBe('sess-1');
    expect(spawned).toBe(1);

    // A healthy session is reused rather than respawned.
    expect(await rt.startSession('a', { cwd: '/ws' })).toBe('sess-1');
    expect(spawned, 'a live session should be reused').toBe(1);

    children[0].emit('exit', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(await rt.startSession('a', { cwd: '/ws' })).toBe('sess-1');
    expect(spawned, 'a dead session was reused instead of respawned').toBe(2);
  });

  test('the retry gets a live session, not a null one', async () => {
    let attempt = 0;
    const { spawnFn } = fakeSpawn();
    // First call rejects mcpServers, second succeeds — the real hermes sequence.
    const flaky = (cmd, args) => {
      attempt += 1;
      const child = spawnFn(cmd, args);
      if (attempt === 1) queueMicrotask(() => child.emit('exit', 2));
      return child;
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn: flaky });
    try { await rt.startSession('a', { cwd: '/ws', mcpServers: [{ name: 'h' }] }); } catch { /* expected */ }
    const id = await rt.startSession('a', { cwd: '/ws' });
    expect(id).toBe('sess-1');
    expect(id).not.toBeNull();
  });
});

describe('a session id that is not one never reaches the wire', () => {
  // `${null}` is "null" — six truthy characters. It was written to disk, read
  // back as an id, and sent to session/load. hermes logged
  // "load_session: session null not found" as a WARNING and returned success, so
  // the runtime's existing error path never fired and the agent came up with
  // sessionId "null". The stored file literally contained: null
  test.each(['null', 'undefined', 'NaN', '', '  '])('%j is not resumed', async (poison) => {
    const seen = [];
    const { spawnFn } = fakeSpawn();
    const watch = (cmd, args) => {
      const child = spawnFn(cmd, args);
      const write = child.stdin.write;
      child.stdin.write = (chunk) => {
        for (const l of String(chunk).split('\n').filter(Boolean)) seen.push(JSON.parse(l));
        return write(chunk);
      };
      return child;
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn: watch });
    const id = await rt.startSession('a', { cwd: '/ws', resumeSessionId: poison });
    expect(seen.some((m) => m.method === 'session/load'), `${poison} was sent to session/load`).toBe(false);
    expect(seen.some((m) => m.method === 'session/new')).toBe(true);
    expect(id).toBe('sess-1');
  });

  test('a real id is still resumed', async () => {
    // The guard must not cost us the feature it protects.
    const seen = [];
    const { spawnFn } = fakeSpawn();
    const watch = (cmd, args) => {
      const child = spawnFn(cmd, args);
      const write = child.stdin.write;
      child.stdin.write = (chunk) => {
        for (const l of String(chunk).split('\n').filter(Boolean)) seen.push(JSON.parse(l));
        return write(chunk);
      };
      return child;
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn: watch });
    const id = await rt.startSession('a', { cwd: '/ws', resumeSessionId: 'octos-3c27' });
    const load = seen.find((m) => m.method === 'session/load');
    expect(load, 'a valid id should have been resumed').toBeTruthy();
    expect(load.params.sessionId).toBe('octos-3c27');
    expect(id).toBe('octos-3c27');
  });

  test('the host refuses to store one', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toMatch(/if \(!isUsableSessionId\(id\)\) \{/);
    // Both directions: never write one, never trust one already written.
    expect(host).toMatch(/ignoring a stored session id that is not one/);
    expect(host).toMatch(/not storing an unusable session id/);
  });

  test('a failed start does not erase a good id from an earlier one', () => {
    // Clearing on failure would turn one bad boot into permanent memory loss.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    const fn = host.slice(host.indexOf('function rememberSessionId'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/unlinkSync|rmSync|writeFileSync\(SESSION_ID_FILE, ''/);
  });
});
