import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// install-macos.sh warned about pre-existing tmux sessions; install-full.sh did
// not look at all, so a Linux install silently claimed every session on the host.
// These tests drive the Linux guard against a fake tmux, so they need no real
// tmux server and cannot leave a stray session behind for other tests to trip on.

const ROOT = path.resolve('.');

/** A tmux stand-in whose `ls` prints the given session names. */
function fakeTmuxDir(sessions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-faketmux-'));
  const body = sessions.length
    ? sessions.map((s) => `echo '${s}: 1 windows (created Mon Jan  1 00:00:00 2026)'`).join('\n')
    : 'exit 0';
  writeFileSync(path.join(dir, 'tmux'), `#!/usr/bin/env bash\ncase "$1" in\n  ls) ${sessions.length ? '' : 'exit 1'}\n${body}\n    ;;\n  -V) echo 'tmux 3.4' ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
  return dir;
}

function runInstaller(args, { sessions = [], envSeed = null } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hafleet-guard-'));
  const home = path.join(tmp, 'home');
  const systemdDir = path.join(tmp, 'systemd');
  const envFile = path.join(tmp, '.env');
  mkdirSync(home, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  const fakeNode = path.join(tmp, 'fake-node');
  writeFileSync(fakeNode, '#!/usr/bin/env bash\n', { mode: 0o755 });
  if (envSeed !== null) writeFileSync(envFile, envSeed);

  const tmuxDir = fakeTmuxDir(sessions);
  let stdout = '';
  let stderr = '';
  let failed = false;
  try {
    stdout = execFileSync('bash', [
      path.join(ROOT, 'install-full.sh'),
      '--skip-prereq-check', '--skip-npm', '--skip-mcp', '--no-start',
      '--service-user', 'guard-user',
      '--systemd-dir', systemdDir,
      '--bin-dir', path.join(tmp, 'bin'),
      '--env-file', envFile,
      ...args,
    ], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        API_TOKEN: 'guard-token',
        NODE_BIN: fakeNode,
        PATH: `${tmuxDir}${path.delimiter}${process.env.PATH}`,
      },
    });
  } catch (error) {
    failed = true;
    stdout = error.stdout || '';
    stderr = error.stderr || '';
  }
  let env = '';
  try { env = readFileSync(envFile, 'utf-8'); } catch { env = ''; }
  return { stdout, stderr, failed, env };
}

const denylistOf = (env) => {
  const line = env.split('\n').filter((l) => l.startsWith('HAFLEET_SESSION_DENYLIST='));
  return { count: line.length, value: line[0]?.slice('HAFLEET_SESSION_DENYLIST='.length) };
};

describe('install-full.sh tmux session guard', () => {
  test('refuses non-interactively when sessions exist and no flag is given', () => {
    const r = runInstaller([], { sessions: ['alpha', 'beta'] });
    expect(r.failed).toBe(true);
    // Both escape hatches must be named, safe one first.
    expect(r.stderr).toContain('--deny-existing-tmux');
    expect(r.stderr).toContain('--allow-existing-tmux');
    expect(r.stdout).toContain('alpha');
    expect(r.stdout).toMatch(/typing into their panes/);
  });

  test('--deny-existing-tmux writes exactly the discovered sessions', () => {
    const r = runInstaller(['--deny-existing-tmux'], { sessions: ['alpha', 'beta'] });
    expect(denylistOf(r.env)).toEqual({ count: 1, value: 'alpha,beta' });
  });

  test('--deny-existing-tmux merges with an existing denylist', () => {
    const r = runInstaller(['--deny-existing-tmux'], {
      sessions: ['alpha'],
      envSeed: 'API_TOKEN=guard-token\nHAFLEET_SESSION_DENYLIST=already-here\n',
    });
    // Overwriting would silently un-protect whatever the operator had listed.
    expect(denylistOf(r.env)).toEqual({ count: 1, value: 'already-here,alpha' });
  });

  test('--allow-existing-tmux proceeds and writes no denylist', () => {
    const r = runInstaller(['--allow-existing-tmux'], { sessions: ['alpha'] });
    expect(r.stdout).toContain('--allow-existing-tmux set');
    expect(denylistOf(r.env).count).toBe(0);
  });

  test('a host with no sessions is untouched and says so', () => {
    const r = runInstaller([], { sessions: [] });
    expect(r.stdout).toContain('No pre-existing tmux sessions');
    expect(denylistOf(r.env).count).toBe(0);
  });

  test('--dry-run writes nothing even with the flag set', () => {
    const r = runInstaller(['--dry-run', '--deny-existing-tmux'], { sessions: ['alpha'] });
    expect(r.stdout).toMatch(/\[dry-run\] would set HAFLEET_SESSION_DENYLIST=alpha/);
    expect(denylistOf(r.env).count).toBe(0);
  });

  test('the written value is sourceable by a shell', () => {
    // .env is sourced by the launchd/systemd wrappers; an unquoted glob or a
    // stray character here breaks startup rather than this test.
    const r = runInstaller(['--deny-existing-tmux'], { sessions: ['alpha', 'beta'] });
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'hafleet-source-'));
    const envPath = path.join(tmp, 'env');
    writeFileSync(envPath, r.env);
    const out = execFileSync('bash', ['-c', `set -a; . "${envPath}"; printf '%s' "$HAFLEET_SESSION_DENYLIST"`], { encoding: 'utf-8' });
    expect(out).toBe('alpha,beta');
  });
});

describe('both installers offer the same protection', () => {
  const linux = readFileSync('install-full.sh', 'utf-8');
  const macos = readFileSync('install/install-macos.sh', 'utf-8');

  test.each([
    'check_existing_tmux',
    'apply_session_denylist',
    '--deny-existing-tmux',
    '--allow-existing-tmux',
    'HAFLEET_SESSION_DENYLIST',
    'no TTY to confirm',
    'registers tmux sessions as agents',
  ])('%s is present in both', (needle) => {
    expect(linux, 'install-full.sh').toContain(needle);
    expect(macos, 'install/install-macos.sh').toContain(needle);
  });

  test.each([['install-full.sh', 'install-full.sh'], ['install/install-macos.sh', 'install-macos.sh']])(
    '%s applies the denylist after the env file exists',
    (file) => {
      const source = readFileSync(file, 'utf-8');
      const main = source.slice(source.indexOf('main() {'));
      expect(main.indexOf('prepare_env')).toBeGreaterThan(-1);
      expect(main.indexOf('prepare_env')).toBeLessThan(main.indexOf('apply_session_denylist'));
    },
  );

  test.each(['install-full.sh', 'install/install-macos.sh'])('%s guards the write behind --dry-run', (file) => {
    const source = readFileSync(file, 'utf-8');
    const fn = source.slice(source.indexOf('apply_session_denylist() {'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('DRY_RUN')).toBeGreaterThan(-1);
    expect(body.indexOf('DRY_RUN')).toBeLessThan(body.indexOf('set_env_value'));
  });
});
