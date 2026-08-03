import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { getFramework } from '../lib/frameworks/index.js';

// Three onboarding gaps, all found by reviewing the path after using it:
//
// 1. --supervised printed "is supervised as agent:X" unconditionally. hermes
//    reported success and then crash-looped 35 times on a missing credential.
//    The UNSUPERVISED path had always verified; the recommended one had not.
// 2. --model was pushed into the ACP binary using launch.modelFlag, which
//    describes the framework's CLI, not its ACP entry point. Verified against the
//    real binaries: `octos acp` takes --model, `hermes-acp` dies on it
//    ("unrecognized arguments: --model x", no handshake), and `codex-acp` accepts
//    it and ignores it. One adapter was fatal, another silently lied.
// 3. acp.pid is written only by the unsupervised path, and the host has no
//    single-instance guard, so an unsupervised acp-up on an already-supervised
//    agent started a SECOND host. Both poll one inbox and both reply. The reverse
//    direction was already guarded.

const ROOT = path.resolve('.');

function runAcpUp(args, { env = {} } = {}) {
  try {
    const stdout = execFileSync('bash', [path.join(ROOT, 'bin/hafleet-acp-up'), ...args], {
      cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env }, timeout: 30000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

describe('the ACP model flag is declared per adapter, not borrowed from the CLI', () => {
  test.each([
    ['octos', '--model'],
    ['hermes', null],
    ['codex-acp', null],
  ])('%s declares acpModelFlag=%s', (id, expected) => {
    expect(getFramework(id).launch.acpModelFlag ?? null).toBe(expected);
  });

  test('every ACP adapter states its ACP model flag explicitly', () => {
    // Absent and "not applicable" must be distinguishable, or the next adapter
    // silently inherits the CLI flag again.
    for (const id of ['octos', 'hermes', 'codex-acp']) {
      const launch = getFramework(id).launch;
      expect(Object.prototype.hasOwnProperty.call(launch, 'acpModelFlag'),
        `${id} does not declare acpModelFlag`).toBe(true);
      expect(launch.acpModelFlagNote, `${id} does not say why`).toBeTruthy();
    }
  });

  test('the CLI flag and the ACP flag are allowed to disagree', () => {
    // The whole point: hermes's CLI takes --model, its ACP entry point does not.
    const hermes = getFramework('hermes').launch;
    expect(hermes.modelFlag).toBe('--model');
    expect(hermes.acpModelFlag).toBeNull();
  });

  test.each(['hermes', 'codex-acp'])('acp-up refuses --model for %s before doing anything', (id) => {
    const r = runAcpUp(['probe-agent', os.tmpdir(), id, '--model', 'some-model']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/takes no model flag over ACP/);
    // Refused up front: nothing registered, nothing spawned.
    expect(r.stdout).not.toMatch(/Provisioned agent token/);
    expect(r.stdout).not.toMatch(/supervised as/);
  });

  test('the host also refuses, so the CLI is not the only gate', () => {
    const r = (() => {
      try {
        execFileSync('node', ['scripts/hafleet-acp-agent.mjs', '--name', 'probe',
          '--workspace', os.tmpdir(), '--framework', 'hermes', '--model', 'x'], {
          cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
        });
        return { code: 0, stderr: '' };
      } catch (error) { return { code: error.status ?? 1, stderr: error.stderr || '' }; }
    })();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/takes no model flag over ACP/);
  });
});

describe('the supervised path verifies the agent came up', () => {
  const source = execFileSync('cat', [path.join(ROOT, 'bin/hafleet-acp-up')], { encoding: 'utf-8' });

  test('success is no longer printed unconditionally', () => {
    const supervised = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]'));
    // Match the echo, not a comment that quotes it. The first attempt at this test
    // failed because the comment explaining the fix contains the same string.
    const claim = supervised.search(/echo "Agent '\$NAME'.*is supervised as/);
    const check = supervised.indexOf('did not stay healthy');
    expect(claim, 'could not find the success echo').toBeGreaterThan(-1);
    expect(check, 'no health check on the supervised path').toBeGreaterThan(-1);
    expect(check, 'the success message is printed before the check').toBeLessThan(claim);
  });

  test('a failure names the log and the undo command', () => {
    expect(source).toMatch(/did not stay healthy/);
    expect(source).toMatch(/hafleet acp-down \$NAME/);
  });

  test('it does not claim health it never measured', () => {
    // The check only runs when a supervisor was actually signalled; if there was
    // none, there is nothing to be healthy yet and the fallback message says so.
    const supervised = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]'));
    expect(supervised).toMatch(/if \[ "\$RELOADED" = true \]; then/);
  });

  test('one healthy sample is not accepted as success', () => {
    // The first version of this check broke exactly here. An agent's health type is
    // `process`, so it reads healthy as soon as the process exists — and hermes
    // spends ~10s loading plugins before dying. The first poll passed and acp-up
    // reported success for an agent that never served a request. Verified live: the
    // weak check printed "is supervised as 'agent:hermes-agent'" for an agent with
    // no model provider.
    const supervised = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]'));
    expect(supervised, 'no consecutive-sample requirement').toMatch(/"\$STABLE" -ge 3/);
    expect(supervised, 'the restart count is not consulted').toMatch(/\brestarts\b/);
    expect(supervised).toMatch(/BASELINE/);
  });

  test('a restart during the window resets the streak rather than passing', () => {
    // A crash loop shows as a rising restart count while each individual sample
    // still reads healthy. That is the signal, so it must reset the streak.
    const supervised = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]'));
    const loop = supervised.slice(supervised.indexOf('while [ "$(date +%s)"'));
    const body = loop.slice(0, loop.indexOf('\n    done'));
    expect(body).toMatch(/STABLE=0/);
    expect(body).toMatch(/RESTARTS" = "\$BASELINE"/);
  });

  test('the success message tells the operator how to remove the agent', () => {
    // acp-down existed and was undiscoverable from the command that creates the
    // thing it removes.
    expect(source).toMatch(/remove:\s+hafleet acp-down/);
  });
});

describe('one agent cannot get two hosts', () => {
  /** A profile containing one supervised agent entry. */
  function profileWith(name) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-onboard-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, `${JSON.stringify({
      name: 'services-local',
      services: [{ name: 'backend', command: ['true'], dependsOn: [], health: { type: 'process' } },
        { name: `agent:${name}`, command: ['true'], dependsOn: ['backend'], health: { type: 'process' } }],
    }, null, 2)}\n`);
    return file;
  }

  test('an unsupervised start is refused when the supervisor already owns it', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'hafleet-ws-'));
    const r = runAcpUp(['already-supervised', workspace, 'codex-acp',
      '--profile', profileWith('already-supervised')]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already registered with the supervisor/);
    expect(r.stderr).toMatch(/both would reply/);
    expect(r.stderr).toMatch(/hafleet acp-down already-supervised/);
  });

  test('an agent absent from the profile is not blocked by the guard', async () => {
    // The guard must not stop a genuinely new unsupervised agent. Getting past it
    // means the script goes on to spawn a host, so HAFLEET_HOMEDIR is redirected to
    // keep the token and state out of the developer's real home, and the framework
    // binary is absent here so the host exits at once rather than leaving an agent
    // running after the test.
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'hafleet-ws-'));
    const home = mkdtempSync(path.join(os.tmpdir(), 'hafleet-home-'));
    const r = runAcpUp(['a-different-name', workspace, 'codex-acp',
      '--profile', profileWith('already-supervised')], { env: { HAFLEET_HOMEDIR: home } });
    expect(r.stderr).not.toMatch(/already registered with the supervisor/);
    // Positive evidence that it got past the guard rather than failing earlier.
    expect(`${r.stdout}${r.stderr}`).toMatch(/Provisioned agent token|exited immediately/);
  }, 40000);

  test('the reverse direction is still guarded too', () => {
    // Going supervised kills a running unsupervised host. Both directions now.
    const source = execFileSync('cat', [path.join(ROOT, 'bin/hafleet-acp-up')], { encoding: 'utf-8' });
    expect(source).toMatch(/Stopped the unsupervised host/);
    expect(source).toMatch(/already registered with the supervisor/);
  });
});
