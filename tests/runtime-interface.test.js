import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'fs';

import {
  RUNTIME_CAPABILITIES,
  assertRuntimeContract,
  createNullRuntime,
  emptyPaneListing,
} from '../lib/runtime/index.js';
import { createTmuxRuntime, isTmuxEmptyServerError } from '../lib/runtime/tmux.js';

// HAFleet reached its agents through 43 raw tmux invocations, 34 of them in
// backend-v2.js with no abstraction. That coupling is what pins the project to
// Linux and macOS, since tmux has no native Windows build. lib/runtime/ is the
// seam that lets another runtime be added without touching the backend.

/** Fake exec that records calls and replays scripted results. */
function fakeExec(handler) {
  const calls = [];
  const exec = vi.fn(async (bin, args, options) => {
    calls.push({ bin, args, options });
    return handler({ bin, args, options });
  });
  return { exec, calls };
}

const tmuxError = (message, { code = 1, stderr = '' } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.stderr = stderr;
  return error;
};

describe('runtime contract', () => {
  test('declares every capability as a boolean', () => {
    for (const key of Object.keys(RUNTIME_CAPABILITIES)) {
      expect(typeof RUNTIME_CAPABILITIES[key]).toBe('boolean');
    }
  });

  test('accepts a conforming runtime', () => {
    expect(() => assertRuntimeContract(createTmuxRuntime(), 'tmux')).not.toThrow();
    expect(() => assertRuntimeContract(createNullRuntime(), 'null')).not.toThrow();
  });

  test('rejects a partial implementation with an actionable message', () => {
    // A half-written runtime must fail at construction, not at the first health
    // sweep in production.
    expect(() => assertRuntimeContract({}, 'broken')).toThrow(/broken\.name/);
    expect(() => assertRuntimeContract({ name: 'x' }, 'broken')).toThrow(/capabilities/);
    expect(() => assertRuntimeContract({
      name: 'x', capabilities: { keys: true, capture: true, sessions: true },
    }, 'broken')).toThrow(/broken\.isAvailable must be a function/);
  });

  test('emptyPaneListing distinguishes idle from failed', () => {
    expect(emptyPaneListing(null)).toEqual({
      ok: true, panes: [], error: null, serverUnavailable: false,
    });
    const err = new Error('boom');
    expect(emptyPaneListing(err)).toEqual({
      ok: false, panes: [], error: err, serverUnavailable: false,
    });
  });

  test('emptyPaneListing distinguishes an unreachable server from an idle one', () => {
    // Both are ok-with-no-panes, because neither is a fault. But they mean
    // opposite things to a caller deciding whether an agent has gone away, and
    // collapsing them made a transient tmux failure look like an idle host — the
    // backend then marked the whole fleet offline for one sweep and restored it
    // on the next, flapping 153 times in a single boot on a real host.
    const idle = emptyPaneListing(null);
    const unreachable = emptyPaneListing(null, { serverUnavailable: true });
    expect(idle.ok).toBe(true);
    expect(unreachable.ok).toBe(true);
    expect(idle.serverUnavailable).toBe(false);
    expect(unreachable.serverUnavailable).toBe(true);
  });
});

describe('null runtime', () => {
  test('answers "nothing here" without throwing', async () => {
    const runtime = createNullRuntime({ reason: 'windows host' });
    expect(runtime.capabilities).toEqual(RUNTIME_CAPABILITIES);
    await expect(runtime.isAvailable()).resolves.toBe(false);
    await expect(runtime.sessionExists('a')).resolves.toBe(false);
    await expect(runtime.capturePane('a:0.0')).resolves.toBeNull();
    await expect(runtime.sendKeys('a:0.0', ['Enter'])).resolves.toBe(false);
    const listing = await runtime.listPanes();
    expect(listing.panes).toEqual([]);
    expect(listing.ok).toBe(false);
    expect(listing.error).toBe('windows host');
  });
});

describe('tmux runtime', () => {
  test('advertises the capabilities an interactive multiplexer has', () => {
    expect(createTmuxRuntime().capabilities).toEqual({
      keys: true, capture: true, sessions: true,
    });
  });

  test('parses list-panes output into structured panes', async () => {
    const { exec, calls } = fakeExec(() => ({
      stdout: [
        '/dev/ttys004\talpha\t4242\tnode\t/Users/me/projects/alpha',
        '/dev/ttys005\tbravo\t4243\tclaude\t/Users/me/projects/bravo',
      ].join('\n'),
    }));
    const listing = await createTmuxRuntime({ exec }).listPanes();

    expect(listing.ok).toBe(true);
    expect(listing.panes).toEqual([
      { tty: 'ttys004', session: 'alpha', pid: 4242, command: 'node', path: '/Users/me/projects/alpha' },
      { tty: 'ttys005', session: 'bravo', pid: 4243, command: 'claude', path: '/Users/me/projects/bravo' },
    ]);
    // One call for the whole host, not one per agent.
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 3)).toEqual(['list-panes', '-a', '-F']);
  });

  test('keeps tabs inside a path rather than truncating it', async () => {
    const { exec } = fakeExec(() => ({ stdout: '/dev/ttys001\ta\t9\tnode\t/tmp/we\tird\n' }));
    const { panes } = await createTmuxRuntime({ exec }).listPanes();
    expect(panes[0].path).toBe('/tmp/we\tird');
  });

  test('parses the sentinel-delimited format the runtime actually requests', () => {
    // The delimiter was a tab until a real host delivered every pane line with the
    // tabs replaced by underscores, which made the parser discard all six lines and
    // report an idle host. The format now uses a sentinel that is not whitespace.
    const source = readFileSync('lib/runtime/tmux.js', 'utf-8');
    expect(source).toContain("const PANE_FIELD_SEP = '::|::'");
    expect(source).toContain('].join(PANE_FIELD_SEP)');
  });

  test('parses sentinel-delimited output, including a path containing a tab', async () => {
    const SEP = '::|::';
    const row = ['/dev/ttys001', 'alpha', '42', 'node', '/tmp/we\tird'].join(SEP);
    const { exec } = fakeExec(() => ({ stdout: `${row}\n` }));
    const { ok, panes } = await createTmuxRuntime({ exec }).listPanes();
    expect(ok).toBe(true);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toEqual({
      tty: 'ttys001', session: 'alpha', pid: 42, command: 'node', path: '/tmp/we\tird',
    });
  });

  test('a path containing the sentinel itself survives the round trip', async () => {
    // parts.slice(4).join(sep) must use the separator that split the line, or the
    // other one gets rewritten into the path.
    const SEP = '::|::';
    const row = ['/dev/ttys002', 'beta', '7', 'zsh', `/tmp/a${SEP}b`].join(SEP);
    const { exec } = fakeExec(() => ({ stdout: `${row}\n` }));
    const { panes } = await createTmuxRuntime({ exec }).listPanes();
    expect(panes[0].path).toBe(`/tmp/a${SEP}b`);
  });

  test('skips malformed rows without failing the whole listing', async () => {
    const { exec } = fakeExec(() => ({
      stdout: ['too\tfew\tfields', '/dev/ttys001\tgood\t7\tnode\t/tmp', '\t\t\t\t'].join('\n'),
    }));
    const { ok, panes } = await createTmuxRuntime({ exec }).listPanes();
    expect(ok).toBe(true);
    expect(panes.map((p) => p.session)).toEqual(['good']);
  });

  test('reports an idle host with no server as ok, not failed', async () => {
    // Otherwise every sweep on a host with no agents raises a spurious alert.
    for (const message of [
      'no server running on /tmp/tmux-501/default',
      'error connecting to /tmp/tmux-501/default (No such file or directory)',
      'no sessions',
    ]) {
      const { exec } = fakeExec(() => { throw tmuxError(message); });
      const listing = await createTmuxRuntime({ exec }).listPanes();
      // ok, because an idle host is not a fault — but flagged, so the caller can
      // tell it apart from a reachable server that genuinely has no panes.
      expect(listing, message).toEqual({
        ok: true, panes: [], error: null, serverUnavailable: true,
      });
    }
  });

  test('a reachable server with no panes is NOT flagged unavailable', async () => {
    // This is the case where marking agents missing is correct: tmux answered,
    // and it has nothing running.
    const { exec } = fakeExec(() => ({ stdout: '' }));
    const listing = await createTmuxRuntime({ exec }).listPanes();
    expect(listing).toEqual({
      ok: true, panes: [], error: null, serverUnavailable: false,
    });
  });

  test('reports a genuine failure as failed', async () => {
    const { exec } = fakeExec(() => { throw tmuxError('permission denied', { code: 2 }); });
    const listing = await createTmuxRuntime({ exec }).listPanes();
    expect(listing.ok).toBe(false);
    expect(listing.error).toBeInstanceOf(Error);
  });

  test('capturePane returns raw text and never throws', async () => {
    const ok = fakeExec(() => ({ stdout: 'line one\nline two\n' }));
    await expect(createTmuxRuntime({ exec: ok.exec }).capturePane('a:0.0'))
      .resolves.toBe('line one\nline two\n');

    const dead = fakeExec(() => { throw tmuxError("can't find pane"); });
    await expect(createTmuxRuntime({ exec: dead.exec }).capturePane('a:0.0')).resolves.toBeNull();

    // No target is not an error condition worth a subprocess.
    const unused = fakeExec(() => ({ stdout: '' }));
    await expect(createTmuxRuntime({ exec: unused.exec }).capturePane('')).resolves.toBeNull();
    expect(unused.calls).toHaveLength(0);
  });

  test('sendKeys distinguishes key names from literal text', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    const runtime = createTmuxRuntime({ exec });

    await runtime.sendKeys('a:0.0', ['C-c']);
    expect(calls[0].args).toEqual(['send-keys', '-t', 'a:0.0', 'C-c']);

    // -l stops tmux interpreting "/clear" as key names.
    await runtime.sendKeys('a:0.0', ['/clear'], { literal: true });
    expect(calls[1].args).toEqual(['send-keys', '-l', '-t', 'a:0.0', '/clear']);
  });

  test('sendKeys honours a timeout override', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    await createTmuxRuntime({ exec }).sendKeys('a:0.0', ['Enter'], { timeoutMs: 5000 });
    expect(calls[0].options.timeout).toBe(5000);
  });

  test('sendKeys propagates failure so callers can tell delivery apart', async () => {
    const { exec } = fakeExec(() => { throw tmuxError("can't find pane: gone"); });
    await expect(createTmuxRuntime({ exec }).sendKeys('gone:0.0', ['Enter'])).rejects.toThrow(/find pane/);
  });

  test('sessionExists maps exit status to a boolean', async () => {
    const yes = fakeExec(() => ({ stdout: '' }));
    await expect(createTmuxRuntime({ exec: yes.exec }).sessionExists('alpha')).resolves.toBe(true);
    expect(yes.calls[0].args).toEqual(['has-session', '-t', 'alpha']);

    const no = fakeExec(() => { throw tmuxError('session not found'); });
    await expect(createTmuxRuntime({ exec: no.exec }).sessionExists('nope')).resolves.toBe(false);

    const unused = fakeExec(() => ({ stdout: '' }));
    await expect(createTmuxRuntime({ exec: unused.exec }).sessionExists('  ')).resolves.toBe(false);
    expect(unused.calls).toHaveLength(0);
  });

  test('isAvailable probes the binary', async () => {
    const present = fakeExec(() => ({ stdout: 'tmux 3.7b\n' }));
    await expect(createTmuxRuntime({ exec: present.exec }).isAvailable()).resolves.toBe(true);
    expect(present.calls[0].args).toEqual(['-V']);

    const absent = fakeExec(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    await expect(createTmuxRuntime({ exec: absent.exec }).isAvailable()).resolves.toBe(false);
  });

  test('honours a custom binary path', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    await createTmuxRuntime({ exec, bin: '/opt/homebrew/bin/tmux' }).sessionExists('a');
    expect(calls[0].bin).toBe('/opt/homebrew/bin/tmux');
  });
});

describe('empty-server classification', () => {
  test('requires exit code 1, so unrelated failures are not swallowed', () => {
    expect(isTmuxEmptyServerError(tmuxError('no server running on /tmp/x'))).toBe(true);
    // Same text, different exit code: not the idle case.
    expect(isTmuxEmptyServerError(tmuxError('no server running on /tmp/x', { code: 2 }))).toBe(false);
    expect(isTmuxEmptyServerError(tmuxError('something else'))).toBe(false);
    expect(isTmuxEmptyServerError(null)).toBe(false);
  });

  test('reads stderr as well as the message', () => {
    expect(isTmuxEmptyServerError(tmuxError('exited', { stderr: 'no server running on /tmp/x' })))
      .toBe(true);
  });
});

describe('killSession', () => {
  /*
   * Added because deleting an agent used to leave its tmux session and coding-CLI process running:
   * an orphan spending the contributor's tokens, its MCP server still calling a backend that no
   * longer knew the agent, while the console reported it gone. The backend's first attempt shelled
   * out to tmux itself and the invariant below rejected it — so the capability lives here, and the
   * arguments are asserted here rather than in a backend test that cannot see them.
   */
  test('ends the named session', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    const ok = await createTmuxRuntime({ exec }).killSession('ops-agent');
    expect(ok).toBe(true);
    // The SESSION name, not the `name:0.0` pane address — tmux rejects a pane target here.
    expect(calls[0].args).toEqual(['kill-session', '-t', 'ops-agent']);
  });

  test('an absent session is false, not an error', async () => {
    /*
     * For an agent that was never started this is the ordinary case, and a caller has to tell
     * "stopped something" from "there was nothing to stop" without treating the second as a failure
     * — that distinction is what lets the delete response warn honestly.
     */
    const { exec } = fakeExec(() => { throw tmuxError("can't find session: nope"); });
    await expect(createTmuxRuntime({ exec }).killSession('nope')).resolves.toBe(false);
  });

  test('an idle host with no tmux server is false, not an error', async () => {
    const { exec } = fakeExec(() => { throw tmuxError('no server running on /tmp/x'); });
    await expect(createTmuxRuntime({ exec }).killSession('anything')).resolves.toBe(false);
  });

  test('a blank name does not reach tmux at all', async () => {
    // Otherwise `kill-session -t ''` is sent, and an empty target is not a name tmux ignores.
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    await expect(createTmuxRuntime({ exec }).killSession('  ')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('backend no longer shells out to tmux directly', () => {
  const backend = readFileSync('backend-v2.js', 'utf-8');

  test('has zero raw tmux invocations', () => {
    // 34 before this extraction. Any new one is a regression that re-couples the
    // backend to a single platform.
    expect(backend).not.toMatch(/execFile(Async|Sync)?\(\s*'tmux'/);
    expect(backend).not.toMatch(/\bexec(Sync)?\(\s*[`'"]tmux /);
  });

  test('goes through the runtime instead', () => {
    expect(backend).toContain("import { createTmuxRuntime } from './lib/runtime/tmux.js'");
    expect(backend).toMatch(/const hostRuntime = createTmuxRuntime\(\)/);
  });

  test('gates terminal-only operations on the capability', () => {
    // A headless runtime has no prompt to interrupt, so auto-clear must check
    // rather than assume tmux semantics.
    expect(backend).toMatch(/if \(!hostRuntime\.capabilities\.keys\)/);
    expect(backend).toMatch(/if \(!hostRuntime\.capabilities\.capture\)/);
    expect(backend).toMatch(/if \(!hostRuntime\.capabilities\.sessions\)/);
  });
});
