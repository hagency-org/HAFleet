import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

// install-full.sh is Linux-only (it renders systemd units), so installing on a
// Mac previously meant doing it by hand. That matters because HAFleet fleets are
// commonly Mac minis.
const SCRIPT = 'install/install-macos.sh';
const source = readFileSync(SCRIPT, 'utf-8');

const runScript = (args) => execFileSync('bash', [SCRIPT, ...args], {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
});

describe('install/install-macos.sh', () => {
  test('is valid bash and executable', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    const mode = execFileSync('stat', ['-f', '%Lp', SCRIPT], { encoding: 'utf-8' }).trim();
    expect(Number.parseInt(mode, 8) & 0o111).toBeGreaterThan(0);
  });

  test('refuses to run anywhere but macOS', () => {
    expect(source).toMatch(/uname -s.*Darwin/);
    expect(source).toMatch(/on Linux use \.\/install-full\.sh/);
  });

  test('uses launchd and the supervisor, never systemd', () => {
    expect(source).toContain('LaunchAgents');
    expect(source).toContain('launchctl bootstrap');
    expect(source).toContain('services/agentchat-services.mjs run');

    // systemd does not exist on macOS, so no systemd command may be *invoked*.
    // Prose mentions in comments are fine and in fact expected — the header
    // explains why this script exists at all.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bsystemctl\b/);
    expect(code).not.toMatch(/\.service\b/);
  });

  test('leaves the Matrix bridge out by default', () => {
    expect(source).toContain('WITH_BRIDGE=false');
    expect(source).toMatch(/filter\(\(s\) => s\.name !== "bridge"\)/);
  });

  test('refuses --with-bridge without a bot password it cannot generate', () => {
    // Mirrors install-full.sh: the shared secret is mintable, the bot password
    // authenticates against a real homeserver account and is not.
    expect(source).toContain('MATRIX_BRIDGE_SECRET');
    expect(source).toMatch(/--with-bridge needs MATRIX_BOT_PASSWORD/);
  });

  test('sources .env in the launchd runner, since the supervisor does not', () => {
    expect(source).toMatch(/set -a; \. "\$ENV_FILE"; set \+a/);
    // launchd jobs start with a minimal PATH and would not find brew's node.
    expect(source).toMatch(/export PATH="\/opt\/homebrew\/bin/);
  });

  test('writes .env at mode 0600', () => {
    expect(source).toMatch(/chmod 0600 "\$ENV_FILE"/);
  });

  describe('pre-existing tmux sessions', () => {
    // Observed on a real fleet host: a fresh install claimed five unrelated
    // tmux sessions as agents. The relay then delivers by typing into their
    // panes, so this must be a deliberate opt-in rather than a surprise.
    test('warns and explains the consequence', () => {
      expect(source).toContain('check_existing_tmux');
      expect(source).toMatch(/registers tmux sessions as agents/);
      expect(source).toContain('--allow-existing-tmux');
    });

    test('refuses under --yes rather than silently accepting the risk', () => {
      expect(source).toMatch(/refusing to continue with existing tmux sessions under --yes/);
    });

    test('refuses when non-interactive with no way to confirm', () => {
      expect(source).toMatch(/no TTY to confirm/);
    });
  });

  describe('dry run', () => {
    test('changes nothing and reports what it would do', () => {
      const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
      const out = runScript(['--dry-run', '--no-start', '--skip-mcp', '--allow-existing-tmux']);
      const after = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });

      expect(out).toContain('[dry-run]');
      expect(out).toMatch(/would write .*services-macos\.json/);
      expect(after).toBe(before);
    });

    test('routes every mutation through the run wrapper', () => {
      // A mutation invoked directly would execute under --dry-run.
      expect(source).toMatch(/run cp "\$INSTALL_DIR\/\.env\.example"/);
      expect(source).toMatch(/run ln -snf/);
      expect(source).toMatch(/run npm install/);
    });
  });

  test('verification waits for real backend health, not just process liveness', () => {
    expect(source).toMatch(/curl -sf --noproxy .* "http:\/\/127\.0\.0\.1:\$\{port\}\/health"/);
    // A weak process-only check is what made the bridge look healthy while it
    // was crash-looping.
    expect(source).toMatch(/verification failed/);
  });

  test('tells the operator how to inspect and stop the install', () => {
    for (const hint of ['status:', 'doctor:', 'stop:', 'logs:']) {
      expect(source, `missing hint ${hint}`).toContain(hint);
    }
  });
});

describe('generated service profile is not committed', () => {
  test('services-macos.json is ignored', () => {
    const ignore = readFileSync('.gitignore', 'utf-8');
    expect(ignore).toMatch(/services-macos\.json/);
  });
});
