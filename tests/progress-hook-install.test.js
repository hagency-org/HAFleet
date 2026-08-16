/*
 * The installer that gives `bin/hafleet-progress` a caller, and the four ways it could destroy an
 * agent's configuration instead.
 *
 * This tool exists because the reporter had no caller and no mechanism could give it one: HAFleet has
 * never written the `hooks` key of `.claude/settings.json`. On the host that noticed, no directory had
 * hooks HAFleet put there; two had written their own, for their own purposes — and those two are the
 * reason every test below is about NOT losing something. A hooks writer that assumed an empty key
 * would delete working automation, and the agent would keep running with its own automation quietly
 * gone, which is the kind of failure nobody notices until something that should have fired didn't.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const installer = path.resolve('bin/hafleet-install-progress-hooks');
const temps = [];
const httpServers = [];

afterEach(async () => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
  await Promise.all(httpServers.splice(0).map((s) => new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

/** An agent home, optionally with settings.json already in it. */
function makeHome(settings) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-hook-'));
  temps.push(dir);
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# home\n');
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(path.join(dir, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  return dir;
}

function run(...args) {
  // A trailing object is extra environment, so the backend-resolution tests can point at a fake.
  const extraEnv = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
    ? args.pop()
    : {};
  const env = { ...process.env, API_TOKEN: 'test-token', NO_PROXY: '*', ...extraEnv };
  try {
    return { code: 0, out: execFileSync(process.execPath, [installer, ...args], { encoding: 'utf8', env }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

/**
 * The same thing asynchronously, and it is not a style choice.
 *
 * `execFileSync` BLOCKS THIS PROCESS'S EVENT LOOP, so an in-process fake backend cannot answer the
 * child's fetch — the request sits unserved until the installer's 5s timeout fires and the test fails
 * for a reason that has nothing to do with the installer. Three tests failed exactly that way before
 * this existed. Any test that needs the parent to serve a request while the child runs must use this.
 */
function runAsync(...args) {
  const extraEnv = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
    ? args.pop()
    : {};
  const env = { ...process.env, API_TOKEN: 'test-token', NO_PROXY: '*', ...extraEnv };
  return new Promise((resolve) => {
    execFile(process.execPath, [installer, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

function readSettings(home) {
  return JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}

const ours = (entries) => (entries || []).filter((e) => (e.hooks || [])
  .some((h) => (h.command || '').includes('hafleet-progress'))).length;

describe('installing the progress hooks', () => {
  test('a home with no settings at all gets both events', () => {
    const home = makeHome();
    expect(run(home).code).toBe(0);
    const hooks = readSettings(home).hooks;
    expect(ours(hooks.PostToolUse)).toBe(1);
    expect(ours(hooks.Stop)).toBe(1);
  });

  test('existing hooks on the same events survive, and ours runs alongside', () => {
    // The shape a real directory on this host actually has: its own command on the same two events.
    const home = makeHome({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/post.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'gt nudge deacon done' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/pre.sh' }] }],
      },
      permissions: { allow: ['Bash'] },
    });
    expect(run(home).code).toBe(0);
    const after = readSettings(home);

    const commands = (list) => (list || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
    expect(commands(after.hooks.PostToolUse)).toContain('bash .claude/hooks/post.sh');
    expect(commands(after.hooks.Stop)).toContain('gt nudge deacon done');
    // An event we do not touch is not rewritten at all.
    expect(commands(after.hooks.PreToolUse)).toEqual(['bash .claude/hooks/pre.sh']);
    // And unrelated top-level settings are still there.
    expect(after.permissions).toEqual({ allow: ['Bash'] });
    expect(ours(after.hooks.PostToolUse)).toBe(1);
  });

  test('running twice does not install a second copy', () => {
    const home = makeHome();
    run(home);
    const first = readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const second = run(home);
    expect(second.out).toMatch(/already installed/);
    expect(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(first);
  });

  test('the first run backs up the original and a later run keeps that backup', () => {
    // The backup must hold the PRE-installation state. Refreshing it on a second run would replace the
    // operator's original with a copy that already contains our edit — the one version nobody needs.
    const home = makeHome({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo original' }] }] } });
    run(home);
    const backup = path.join(home, '.claude', 'settings.json.pre-hafleet-progress.bak');
    expect(existsSync(backup)).toBe(true);
    const saved = JSON.parse(readFileSync(backup, 'utf8'));
    expect(ours(saved.hooks.Stop)).toBe(0);

    // A hand edit, then another run: the backup must still be the ORIGINAL, not this edit.
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    run(home);
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual(saved);
  });

  test('unparseable settings are refused and left untouched', () => {
    const raw = '{ "hooks": { /* mid-edit */ } }';
    const home = makeHome(raw);
    const result = run(home);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/not valid JSON/);
    expect(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(raw);
  });

  test('settings that are not an object are refused rather than replaced', () => {
    const home = makeHome('[]');
    expect(run(home).code).toBe(1);
    expect(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('[]');
  });

  test('--dry-run writes nothing', () => {
    const home = makeHome();
    const result = run(home, '--dry-run');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/nothing written/);
    expect(existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('what it refuses to do', () => {
  test('it will not guess a target', () => {
    const result = run();
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/is required/);
  });

  test('a directory with .claude but no CLAUDE.md is not somewhere Claude Code runs', () => {
    // `.claude/` alone is not evidence — ordinary repositories all over a developer's host have one,
    // and writing hooks into the wrong tree makes an agent report into another customer's room. One
    // directory on the host that prompted this had hooks, no CLAUDE.md, and was not an agent workspace.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-nothome-'));
    temps.push(dir);
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const result = run(dir);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/not being run from it/);
  });

  test('a missing directory is refused', () => {
    expect(run(path.join(os.tmpdir(), 'hafleet-definitely-absent-dir')).code).toBe(2);
  });

  test('a path and --agent together are refused rather than one silently winning', () => {
    const home = makeHome();
    const result = run(home, '--agent', 'someone');
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/not both/);
  });
});

describe('resolving the target from the fleet', () => {
  /**
   * A backend that answers one agent record, so the resolution path is tested without the fleet. The
   * installer reads `workdir`, falling back to `homeDir` — on the deployment that prompted this, every
   * agent had `homeDir: null` and one had a `workdir`, which is why the fallback order is that way.
   */
  function withBackend(record, status = 200) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(record ?? {}));
      });
      server.listen(0, '127.0.0.1', () => {
        httpServers.push(server);
        server.unref?.();
        resolve(`http://127.0.0.1:${server.address().port}`);
      });
    });
  }

  test('--agent installs into the workdir the backend reports', async () => {
    const home = makeHome();
    const base = await withBackend({ name: 'alpha', workdir: home, workspaceMode: 'shared' });
    const result = await runAsync('--agent', 'alpha', { HAFLEET_BACKEND_URL: base });
    expect(result.code).toBe(0);
    expect(result.out).toContain(home);
    expect(ours(readSettings(home).hooks.PostToolUse)).toBe(1);
  });

  test('an agent with no workspace recorded is refused, not defaulted to the repo', async () => {
    // The failure the required-path rule was really about: writing hooks for an agent whose workspace
    // nobody has decided on. Four of five agents in the fleet that prompted this were in that state.
    const base = await withBackend({ name: 'alpha', workdir: null, homeDir: null });
    const result = await runAsync('--agent', 'alpha', { HAFLEET_BACKEND_URL: base });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/no workdir or homeDir/);
  });

  test('an unknown agent is reported as the backend answered, not as a missing directory', async () => {
    const base = await withBackend({ error: 'not found' }, 404);
    const result = await runAsync('--agent', 'ghost', { HAFLEET_BACKEND_URL: base });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/HTTP 404/);
  });

  test('an unreachable backend says so and installs nothing', () => {
    // Port 1 is not listening. The message must name the backend, because "could not install" with no
    // reason sends an operator looking at the agent's directory instead of at the service.
    const result = run('--agent', 'alpha', { HAFLEET_BACKEND_URL: 'http://127.0.0.1:1' });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/could not reach the backend/);
  });
});
