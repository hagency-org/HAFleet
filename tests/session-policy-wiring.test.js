import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

// The policy module itself is covered exhaustively in session-policy.test.js.
// This file proves it is actually wired into the two places that enumerate
// sessions, and that removing either gate breaks a test rather than silently
// restoring the old claim-everything behaviour.

const contexts = [];
afterEach(() => {
  while (contexts.length) contexts.pop().cleanup();
});

async function backendWith(env) {
  const ctx = await createBackendTestContext('session-policy-', { agents: {}, env });
  contexts.push(ctx);
  return ctx;
}

/**
 * tmux list-panes output shaped the way lib/runtime/tmux.js parses it:
 * tty, session, pid, command, path — tab separated, tty first.
 */
function fakePaneLister(rows) {
  return async (bin, args) => {
    if (args.includes('list-panes')) return { stdout: rows.join('\n') };
    return { stdout: '' };
  };
}

describe('backend pane snapshot honours the policy', () => {
  const PANES = [
    '/dev/ttys001\tps2\t101\tzsh\t/tmp/octos-ps2',
    '/dev/ttys002\tclaude-a\t102\tnode\t/home/me/proj',
  ];

  test('a denylisted session is absent from the snapshot', async () => {
    const ctx = await backendWith({ HAFLEET_SESSION_DENYLIST: 'ps2' });
    const snap = await ctx.internals.buildLocalPaneMetadataSnapshotForTest(fakePaneLister(PANES));
    expect(snap.ok).toBe(true);
    expect([...snap.sessions.keys()]).toEqual(['claude-a']);
    // The tty index must not leak it either: that map is how a pane is traced
    // back to a session elsewhere in the sweep.
    expect([...snap.ttyToSession.values()]).not.toContain('ps2');
  });

  test('without a policy both sessions are present, as before', async () => {
    const ctx = await backendWith({});
    const snap = await ctx.internals.buildLocalPaneMetadataSnapshotForTest(fakePaneLister(PANES));
    expect([...snap.sessions.keys()].sort()).toEqual(['claude-a', 'ps2']);
  });

  test('an allowlist excludes everything unnamed', async () => {
    const ctx = await backendWith({ HAFLEET_SESSION_ALLOWLIST: 'claude-*' });
    const snap = await ctx.internals.buildLocalPaneMetadataSnapshotForTest(fakePaneLister(PANES));
    expect([...snap.sessions.keys()]).toEqual(['claude-a']);
  });
});

describe('auto-clear refuses sessions outside the policy', () => {
  // injectSlashClear sends C-c, C-u, /clear, Enter. Aimed at someone else's
  // pane that interrupts their process and wipes their prompt, which is the
  // concrete damage this policy exists to prevent.
  test('refused for a denylisted session', async () => {
    const ctx = await backendWith({ HAFLEET_SESSION_DENYLIST: 'ps2' });
    await expect(ctx.internals.injectSlashClearForTest('ps2:0.0')).resolves.toBe(false);
  });

  test('refused when the target is outside an allowlist', async () => {
    const ctx = await backendWith({ HAFLEET_SESSION_ALLOWLIST: 'claude-*' });
    await expect(ctx.internals.injectSlashClearForTest('ps2:0.0')).resolves.toBe(false);
  });

  test('the policy object is the one the backend actually loaded', async () => {
    const ctx = await backendWith({ HAFLEET_SESSION_DENYLIST: 'ps2,ps3,psf,test,uq' });
    const policy = ctx.internals.sessionPolicyForTest;
    for (const name of ['ps2', 'ps3', 'psf', 'test', 'uq']) {
      expect(policy.allows(name), name).toBe(false);
    }
    expect(policy.allows('claude-a')).toBe(true);
  });
});

describe('the relay gate is present', () => {
  const relay = readFileSync('lib/push-relay-core.js', 'utf-8');

  test('listLocalTmuxSessions filters through the policy', () => {
    // Structural, because the relay reads env at module scope and every
    // behavioural variant would cost another retained module copy — see
    // docs/TESTING.md on the harness leak.
    const fn = relay.slice(relay.indexOf('function listLocalTmuxSessions'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('sessionPolicy.filter');
    expect(body).toContain('sessionPolicy.unrestricted');
    // It must return the filtered set, never the raw list.
    expect(body).toContain('new Set(kept)');
  });

  test('the relay warns when the policy is unreadable', () => {
    expect(relay).toContain('sessionPolicy.warnings');
  });

  test('the remote package ships the policy module', () => {
    // lib/session-policy.js is a new import of push-relay-core.js. Missing it
    // from MANAGED_SPECS would leave every remote relay crashing on startup
    // with an unresolved import, and nothing else would catch that.
    const build = readFileSync('scripts/build-remote-package.sh', 'utf-8');
    expect(build).toContain('lib/session-policy.js:lib/session-policy.js');
    expect(() => statSync('remote/lib/session-policy.js')).not.toThrow();
    expect(readFileSync('remote/lib/session-policy.js', 'utf-8'))
      .toBe(readFileSync('lib/session-policy.js', 'utf-8'));
  });
});

describe('source files contain no NUL bytes', () => {
  // Two files were written this session with a stray NUL in a string literal.
  // A NUL makes file(1) report "data" and makes grep treat the file as binary,
  // so it silently reports zero matches — which defeats every grep-based check
  // in this repo, including the architecture-boundary gate.
  const EXTS = ['.js', '.mjs', '.json', '.sh', '.yml', '.md', '.plist', '.service'];
  const SKIP = new Set(['.git', 'node_modules', 'data', 'logs', 'coverage', 'remote-dist', 'data.stale']);

  function* sourceFiles(dir = '.') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(full);
      else if (EXTS.includes(path.extname(entry.name))) yield full;
    }
  }

  test('no tracked source file contains a NUL byte', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      if (readFileSync(file).includes(0x00)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
