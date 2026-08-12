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
//
// That variable no longer exists (ADR-014 decision 3 deleted derived agent
// passwords), so the canary below reads back a variable that does. The trap it
// documents is unchanged, and the second test is what actually guards against a
// new unquoted placeholder reintroducing it.
describe('.env.example', () => {
  test('can be sourced by a shell', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-env-'));
    try {
      const copy = path.join(dir, '.env');
      copyFileSync('.env.example', copy);
      // Read a value back out so a silent partial parse cannot pass. This one is
      // near the END of the file, which is what makes it a canary: a parse that
      // died anywhere earlier leaves it unset.
      const out = execFileSync('bash', [
        '-c', `set -a; . "${copy}"; set +a; printf '%s' "\${HAFLEET_MEMORY_EXPORT_ALLOW_LOCAL:-unset}"`,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out.trim()).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no assignment carries unquoted shell metacharacters', () => {
    /*
     * grep exits 1 when it matches NOTHING, and execFileSync turns a non-zero exit into a throw —
     * so this test used to depend on at least one line matching, and the clean case (the one it
     * exists to confirm) would have failed as an error rather than passing. Exposed the moment the
     * last matching line left the file. Exit 1 is the success case here; only >1 is a real error.
     */
    let raw = '';
    try {
      raw = execFileSync('grep', ['-nE', '^[A-Z_]+=.*[<>|&;()]', '.env.example'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = no matches; 2+ = grep itself failed
    }
    const lines = raw.trim().split('\n').filter(Boolean);

    // Quoted placeholders are fine; bare ones are not.
    const unquoted = lines.filter((line) => {
      const value = line.slice(line.indexOf('=') + 1).trim();
      return !(/^'.*'$/.test(value) || /^".*"$/.test(value));
    });
    expect(unquoted, `unquoted metacharacters:\n${unquoted.join('\n')}`).toEqual([]);
  });
});
