import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// services/README.md documents starting the supervised services with:
//   set -a; . ./.env; set +a
// and install-full.sh creates .env by copying .env.example. So a fresh
// .env.example MUST be sourceable by a POSIX shell.
//
// It was not: MATRIX_AGENT_PASSWORD_TEMPLATE=<your-bot-password> made the shell
// read `<` as an input redirection, so sourcing died with a parse error before
// any variable was set. Found while bringing the stack up on a real host.
describe('.env.example', () => {
  test('can be sourced by a shell', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-env-'));
    try {
      const copy = path.join(dir, '.env');
      copyFileSync('.env.example', copy);
      // Read a value back out so a silent partial parse cannot pass. API_TOKEN
      // is one of the few variables .env.example leaves uncommented, and it is
      // declared after the line that used to break parsing.
      const out = execFileSync('bash', [
        '-c', `set -a; . "${copy}"; set +a; printf '%s' "\${MATRIX_AGENT_PASSWORD_TEMPLATE:-unset}"`,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out.trim()).toBe('<your-bot-password>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no assignment carries unquoted shell metacharacters', () => {
    const lines = execFileSync('grep', ['-nE', '^[A-Z_]+=.*[<>|&;()]', '.env.example'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    // Quoted placeholders are fine; bare ones are not.
    const unquoted = lines.filter((line) => {
      const value = line.slice(line.indexOf('=') + 1).trim();
      return !(/^'.*'$/.test(value) || /^".*"$/.test(value));
    });
    expect(unquoted, `unquoted metacharacters:\n${unquoted.join('\n')}`).toEqual([]);
  });
});
