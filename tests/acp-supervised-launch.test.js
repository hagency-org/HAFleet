import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = 'bin/hafleet-acp-up';
const source = readFileSync(SCRIPT, 'utf-8');
const HELPER = 'scripts/hafleet-supervise-agent.mjs';

// A tmux agent survives its launcher exiting, because tmux owns the pane. An ACP
// agent dies with its host process and cannot be resumed — octos's ACP v1 reports
// loadSession:false — so without supervision a crash is permanent and a reboot
// loses the agent entirely.

describe('hafleet acp-up --supervised', () => {
  test('is valid bash and documents itself', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    const help = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf-8' });
    expect(help).toContain('--supervised');
    expect(help).toContain('--profile');
  });

  test('the supervised path returns instead of also launching detached', () => {
    // Two hosts holding sessions for one agent would both poll the inbox and both
    // answer. The supervised branch must exit before the nohup below it.
    const branch = source.indexOf('if [ "$SUPERVISED" = true ]; then');
    const detached = source.indexOf('nohup node "$BASE_DIR/scripts/hafleet-acp-agent.mjs"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(detached);
    const body = source.slice(branch, detached);
    expect(body).toContain('exit 0');
  });

  test('it stops an existing unsupervised host before handing over', () => {
    const branch = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]; then'));
    expect(branch).toMatch(/kill "\$\(cat "\$PID_FILE"\)"/);
  });

  test('it handles both init systems and never assumes one', () => {
    // install-full.sh is systemd, install-macos.sh is launchd. A launcher that
    // knew only one would silently fail to start the agent on the other.
    expect(source).toContain('launchctl kickstart');
    expect(source).toContain('systemctl');
    expect(source).toMatch(/case "\$\(uname -s\)" in/);
  });

  test('when it cannot reload, it prints the command rather than claiming success', () => {
    const branch = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]; then'));
    expect(branch).toMatch(/Registered\. Reload the supervisor to start it/);
  });

  test('it resolves the framework binary directory into the supervised PATH', () => {
    // The supervisor inherits its unit's PATH, which on mini5 omits ~/.local/bin
    // where octos lives. Without this the host exits instantly and the entry
    // restarts forever — the crash loop, on the first attempt.
    expect(source).toContain('SUPERVISED_PATH=');
    expect(source).toMatch(/command -v "\$FRAMEWORK_CMD"/);
    expect(source).toMatch(/is not on PATH here/);
  });

  test('it refuses rather than guessing when no profile exists', () => {
    expect(source).toMatch(/no service profile found; pass --profile/);
  });
});

describe('the registration helper', () => {
  const makeProfile = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-sup-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({
      name: 'test', services: [{ name: 'backend', command: ['node', 'backend-v2.js'], dependsOn: [] }],
    }, null, 2));
    return file;
  };

  const run = (args) => execFileSync('node', [HELPER, ...args], { encoding: 'utf-8' });

  test('adds an agent entry with the arguments it was given', () => {
    const file = makeProfile();
    run(['add', '--name', 'octos-agent', '--profile', file,
      '--workspace', os.tmpdir(), '--framework', 'octos', '--model', 'deepseek-v4-flash']);
    const entry = JSON.parse(readFileSync(file, 'utf-8')).services.find((s) => s.name === 'agent:octos-agent');
    expect(entry).toBeTruthy();
    expect(entry.command).toContain('--name');
    expect(entry.command).toContain('octos-agent');
    expect(entry.command).toContain('deepseek-v4-flash');
    expect(entry.dependsOn).toEqual(['backend']);
    expect(entry.health.type).toBe('process');
  });

  test('adding twice updates rather than duplicating', () => {
    // A duplicate name is rejected by the profile loader, so a second --supervised
    // launch would break the whole profile rather than just itself.
    const file = makeProfile();
    const args = ['add', '--name', 'a1', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos'];
    run(args);
    run(args);
    const names = JSON.parse(readFileSync(file, 'utf-8')).services.map((s) => s.name);
    expect(names.filter((n) => n === 'agent:a1')).toHaveLength(1);
  });

  test('remove takes it back out and is safe to repeat', () => {
    const file = makeProfile();
    run(['add', '--name', 'a2', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos']);
    run(['remove', '--name', 'a2', '--profile', file]);
    run(['remove', '--name', 'a2', '--profile', file]);
    const names = JSON.parse(readFileSync(file, 'utf-8')).services.map((s) => s.name);
    expect(names).toEqual(['backend']);
  });

  test('--dry-run changes nothing', () => {
    const file = makeProfile();
    const before = readFileSync(file, 'utf-8');
    const out = run(['add', '--name', 'a3', '--profile', file,
      '--workspace', os.tmpdir(), '--framework', 'octos', '--dry-run']);
    expect(out).toContain('[dry-run]');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  test('a name that cannot be a service is refused', () => {
    const file = makeProfile();
    let failed = false;
    try {
      run(['add', '--name', 'has spaces', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos']);
    } catch { failed = true; }
    expect(failed).toBe(true);
  });
});
